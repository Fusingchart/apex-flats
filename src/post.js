// Post-processing: the scene renders into an HDR (half-float, 4x MSAA) target, then
//   1. ambient occlusion from the depth buffer (half resolution, 12 samples, depth-aware blur)
//   2. bloom from a mip chain of the bright parts (sun glints, lamps, brake lights, sirens)
//   3. light shafts: the bright sky round the sun smeared outwards at quarter resolution, when the sun is in view
//   4. eye adaptation: the frame's average brightness, eased over time, nudges the exposure (dark streets open
//      up, a face full of sky stops down)
//   5. a final pass: a little colour fringing and speed blur towards the corners, AO, bloom, shafts, exposure,
//      ACES filmic tone mapping, a warm-highlight / cool-shadow grade with more contrast and colour, vignette,
//      grain, sRGB out
// Everything is a full-screen triangle; the AO and bloom passes run at reduced resolution, so the whole chain
// costs a few milliseconds.
(function () {
'use strict';

// How far into the night it is (n: 0 day .. 1 night) and how much every lamp, window and tail light is turned up to
// stay bright as the exposure comes down (k). The weather module sets it; the world, the traffic and the car read it.
window.GLOW = window.GLOW || { n: 0, k: 1 };

window.createPost = function (renderer, scene, camera) {
  const isGL2 = renderer.capabilities.isWebGL2;
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(tri); quad.frustumCulled = false;
  const quadScene = new THREE.Scene(); quadScene.add(quad);
  const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
  const pass = (mat, target) => { quad.material = mat; renderer.setRenderTarget(target); renderer.render(quadScene, quadCam); };
  const shader = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...extra });

  const hdrOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false };
  // Scene target: HDR colour + a depth texture (resolved from the multisampled buffer)
  const sceneRT = new THREE.WebGLRenderTarget(4, 4, { ...hdrOpts, depthBuffer: true, samples: isGL2 ? 4 : 0 });
  sceneRT.depthTexture = new THREE.DepthTexture(4, 4, THREE.UnsignedIntType);
  const aoRT = [0, 1].map(() => new THREE.WebGLRenderTarget(4, 4, { ...hdrOpts, type: THREE.UnsignedByteType }));
  const MIPS = 5, bloomRT = [];
  for (let i = 0; i < MIPS; i++) bloomRT.push(new THREE.WebGLRenderTarget(4, 4, hdrOpts));

  // --- Ambient occlusion (scalable AO on a view-space position rebuilt from depth)
  const projInv = new THREE.Matrix4();
  const aoMat = shader(`
    varying vec2 vUv;
    uniform sampler2D tDepth; uniform mat4 projInv; uniform mat4 proj; uniform vec2 res; uniform float radius; uniform float near; uniform float far;
    vec3 viewPos(vec2 uv){
      float d = texture2D(tDepth, uv).x;
      vec4 c = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      vec4 v = projInv * c; return v.xyz / v.w;
    }
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      float d0 = texture2D(tDepth, vUv).x;
      if (d0 >= 1.0) { gl_FragColor = vec4(1.0); return; }
      vec3 P = viewPos(vUv);
      vec3 N = normalize(cross(dFdx(P), dFdy(P)));
      // screen-space radius of a world-space sphere
      float rs = radius * proj[1][1] * 0.5 / max(-P.z, 0.1);
      rs = clamp(rs, 3.0 / res.y, 0.12);
      float ang = hash(gl_FragCoord.xy) * 6.2831, occ = 0.0;
      const int S = 12;
      for (int i = 0; i < S; i++) {
        float t = (float(i) + 0.5) / float(S);
        float a = ang + t * 6.2831 * 3.0;
        vec2 off = vec2(cos(a), sin(a)) * rs * t;
        vec3 Q = viewPos(vUv + off * vec2(res.y / res.x, 1.0));
        vec3 v = Q - P; float vv = dot(v, v), vn = dot(v, N);
        float fall = max(0.0, 1.0 - vv / (radius * radius * 4.0));
        occ += max(0.0, vn / sqrt(vv + 0.01) - 0.03) * fall;
      }
      occ = clamp(1.0 - 2.8 * occ / float(S), 0.0, 1.0);
      occ = occ * occ;
      // fade out with distance (fog takes over)
      occ = mix(occ, 1.0, smoothstep(250.0, 700.0, -P.z));
      gl_FragColor = vec4(occ, occ, occ, 1.0);
    }`, { tDepth: { value: null }, projInv: { value: projInv }, proj: { value: new THREE.Matrix4() }, res: { value: new THREE.Vector2() }, radius: { value: 2.2 }, near: { value: 0.3 }, far: { value: 7000 } },
    { extensions: { derivatives: true } });
  // depth-aware blur, run horizontally then vertically
  const blurMat = shader(`
    varying vec2 vUv; uniform sampler2D tAO; uniform sampler2D tDepth; uniform vec2 dir; uniform float near; uniform float far;
    float lin(float d){ float z = d * 2.0 - 1.0; return 2.0 * near * far / (far + near - z * (far - near)); }
    void main(){
      float c = lin(texture2D(tDepth, vUv).x), sum = 0.0, wsum = 0.0;
      for (int i = -3; i <= 3; i++) {
        vec2 uv = vUv + dir * float(i);
        float d = lin(texture2D(tDepth, uv).x), w = exp(-float(i * i) * 0.18) * max(0.0, 1.0 - abs(d - c) / (0.04 * c + 0.2));
        sum += texture2D(tAO, uv).x * w; wsum += w;
      }
      float o = sum / max(wsum, 1e-4);
      gl_FragColor = vec4(o, o, o, 1.0);
    }`, { tAO: { value: null }, tDepth: { value: null }, dir: { value: new THREE.Vector2() }, near: { value: 0.3 }, far: { value: 7000 } });

  // --- Bloom: bright pass into mip 0, 4-tap downsamples, tent upsamples added back up the chain
  const brightMat = shader(`
    varying vec2 vUv; uniform sampler2D tColor; uniform vec2 texel; uniform float threshold;
    void main(){
      vec3 c = (texture2D(tColor, vUv + texel * vec2(-1.0,-1.0)).rgb + texture2D(tColor, vUv + texel * vec2(1.0,-1.0)).rgb
              + texture2D(tColor, vUv + texel * vec2(-1.0, 1.0)).rgb + texture2D(tColor, vUv + texel * vec2(1.0, 1.0)).rgb) * 0.25;
      float l = max(c.r, max(c.g, c.b));
      float k = max(0.0, l - threshold) / max(l, 1e-4);
      gl_FragColor = vec4(min(c * k, vec3(40.0)), 1.0);
    }`, { tColor: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 4.0 } });
  const downMat = shader(`
    varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 texel;
    void main(){
      vec3 c = texture2D(tSrc, vUv).rgb * 0.5
        + (texture2D(tSrc, vUv + texel * vec2(-1.0,-1.0)).rgb + texture2D(tSrc, vUv + texel * vec2(1.0,-1.0)).rgb
         + texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + texel * vec2(1.0, 1.0)).rgb) * 0.125;
      gl_FragColor = vec4(c, 1.0);
    }`, { tSrc: { value: null }, texel: { value: new THREE.Vector2() } });
  const upMat = shader(`
    varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 texel;
    void main(){
      vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
      c += (texture2D(tSrc, vUv + vec2(texel.x, 0.0)).rgb + texture2D(tSrc, vUv - vec2(texel.x, 0.0)).rgb
          + texture2D(tSrc, vUv + vec2(0.0, texel.y)).rgb + texture2D(tSrc, vUv - vec2(0.0, texel.y)).rgb) * 2.0;
      c += texture2D(tSrc, vUv + texel).rgb + texture2D(tSrc, vUv - texel).rgb + texture2D(tSrc, vUv + vec2(texel.x, -texel.y)).rgb + texture2D(tSrc, vUv + vec2(-texel.x, texel.y)).rgb;
      gl_FragColor = vec4(c / 16.0, 1.0);
    }`, { tSrc: { value: null }, texel: { value: new THREE.Vector2() } }, { blending: THREE.AdditiveBlending, transparent: true });

  // --- Light shafts: sky near the sun, marched towards it
  const shaftRT = new THREE.WebGLRenderTarget(4, 4, hdrOpts);
  const shaftMat = shader(`
    varying vec2 vUv; uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 sun; uniform float aspect;
    void main(){
      vec2 d = sun - vUv; float len = length(d * vec2(aspect, 1.0));
      vec2 stp = d / 20.0 * min(1.0, 1.3 / max(len, 1e-3));
      vec3 acc = vec3(0.0); vec2 uv = vUv; float w = 1.0;
      for (int i = 0; i < 20; i++) {
        uv += stp;
        float sky = step(0.99999, texture2D(tDepth, uv).x);
        vec3 c = min(texture2D(tColor, uv).rgb, vec3(10.0));
        acc += c * sky * w * smoothstep(1.25, 0.0, length((uv - sun) * vec2(aspect, 1.0)));
        w *= 0.94;
      }
      gl_FragColor = vec4(acc / 20.0, 1.0);
    }`, { tColor: { value: null }, tDepth: { value: null }, sun: { value: new THREE.Vector2() }, aspect: { value: 1 } });

  // --- Eye adaptation: log-average luminance on a 16 x 16 grid, eased into a 1 x 1 target
  const lumRT = new THREE.WebGLRenderTarget(16, 16, hdrOpts), adaptRT = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, hdrOpts));
  const lumMat = shader(`
    varying vec2 vUv; uniform sampler2D tColor;
    void main(){ gl_FragColor = vec4(vec3(log(clamp(dot(texture2D(tColor, vUv).rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-3, 30.0))), 1.0); }`, { tColor: { value: null } });
  const adaptMat = shader(`
    varying vec2 vUv; uniform sampler2D tLum; uniform sampler2D tPrev; uniform float rate;
    void main(){
      float s = 0.0;
      for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) s += texture2D(tLum, (vec2(float(i), float(j)) + 0.5) / 8.0).x;
      float cur = exp(s / 64.0), prev = texture2D(tPrev, vec2(0.5)).x;
      gl_FragColor = vec4(vec3(prev > 0.0 ? mix(prev, cur, rate) : cur), 1.0);
    }`, { tLum: { value: null }, tPrev: { value: null }, rate: { value: 0.05 } });

  // --- Final composite
  const finalMat = shader(`
    varying vec2 vUv;
    uniform sampler2D tColor; uniform sampler2D tAO; uniform sampler2D tBloom; uniform sampler2D tShaft; uniform sampler2D tAdapt;
    uniform float exposure; uniform float bloom; uniform float aoAmt; uniform float time; uniform vec2 res;
    uniform float shaft; uniform float adaptAmt; uniform float key; uniform float chroma; uniform float blur; uniform float focus;
    uniform vec3 shadowTint; uniform vec3 highTint; uniform float sat; uniform float contrast; uniform float vig; uniform float grain; uniform float debugLum;
    vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
    vec3 aces(vec3 c){
      const mat3 i = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 o = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      c = i * c; c = RRTAndODTFit(c); c = o * c; return clamp(c, 0.0, 1.0);
    }
    vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    void main(){
      vec2 q = vUv - 0.5; float r2 = dot(q, q);
      // the lens: colours split a little towards the corners, and speed smears the edges of the frame outwards
      vec2 ca = q * r2 * chroma;
      vec3 c = vec3(texture2D(tColor, vUv + ca).r, texture2D(tColor, vUv).g, texture2D(tColor, vUv - ca).b);
      if (blur > 0.002) { for (int i = 1; i <= 4; i++) c += texture2D(tColor, vUv - q * r2 * blur * float(i) * 0.25).rgb; c *= 0.2; }
      float ao = texture2D(tAO, vUv).x;
      c *= mix(1.0, ao, aoAmt);
      c += texture2D(tBloom, vUv).rgb * bloom;
      c += texture2D(tShaft, vUv).rgb * shaft;
      float avg = texture2D(tAdapt, vec2(0.5)).x;
      c *= exposure * mix(1.0, clamp(sqrt(key / max(avg, 1e-3)), 0.78, 1.3), adaptAmt);
      c = aces(c / 0.6);
      // grade (in display space, where contrast behaves): cool shadows, warm highlights, more contrast and colour
      c = toSRGB(max(c, 0.0));
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c *= mix(shadowTint, vec3(1.0), smoothstep(0.0, 0.5, l));
      c *= mix(vec3(1.0), highTint, smoothstep(0.45, 1.0, l));
      c = max(mix(vec3(l), c, sat), 0.0);
      c = clamp(mix(c, c * c * (3.0 - 2.0 * c), contrast), 0.0, 1.0);
      // the special ability: the colour drains a little and cools while time is slowed
      c = mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))) * vec3(0.86, 1.0, 1.1), focus * 0.5);
      // vignette
      c *= 1.0 - (vig + 0.22 * focus) * smoothstep(0.25, 0.85, r2 * 2.2);
      // grain, and dither against banding in the sky
      float n = fract(sin(dot(gl_FragCoord.xy + time, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      c += n * (grain * (1.0 - 0.6 * l) + 1.0 / 255.0);
      if (debugLum > 0.5) c = vec3(avg * 0.25);
      gl_FragColor = vec4(c, 1.0);
    }`, { tColor: { value: null }, tAO: { value: null }, tBloom: { value: null }, tShaft: { value: null }, tAdapt: { value: null }, exposure: { value: 1.0 }, bloom: { value: 0.05 }, aoAmt: { value: 0.65 }, time: { value: 0 }, res: { value: new THREE.Vector2() },
      shaft: { value: 0 }, adaptAmt: { value: 0.65 }, key: { value: 0.14 }, chroma: { value: 0.007 }, blur: { value: 0 }, focus: { value: 0 },
      shadowTint: { value: new THREE.Vector3(0.95, 0.99, 1.05) }, highTint: { value: new THREE.Vector3(1.05, 1.012, 0.935) }, sat: { value: 1.08 }, contrast: { value: 0.2 }, vig: { value: 0.2 }, grain: { value: 0.014 }, debugLum: { value: 0 } });
  // What the game sets each frame: where the sun is, how fast we're going, whether time is slowed
  const fx = { sunDir: null, shafts: true, shaftAmt: 0.3, blur: 0, focus: 0 };
  const sunP = new THREE.Vector3(), fwd = new THREE.Vector3();
  let adaptI = 0, lastT = performance.now();

  let W = 4, H = 4, enabled = true, aoOn = true;
  // MSAA sample count for the scene target (the quality presets trade it for speed)
  function setSamples(n) { if (!isGL2 || sceneRT.samples === n) return; sceneRT.samples = n; sceneRT.dispose(); }
  function setSize(w, h) {
    W = Math.max(4, Math.floor(w)); H = Math.max(4, Math.floor(h));
    sceneRT.setSize(W, H);
    const aw = Math.max(4, W >> 1), ah = Math.max(4, H >> 1);
    for (const r of aoRT) r.setSize(aw, ah);
    for (let i = 0; i < MIPS; i++) bloomRT[i].setSize(Math.max(2, W >> (i + 1)), Math.max(2, H >> (i + 1)));
    shaftRT.setSize(Math.max(4, W >> 2), Math.max(4, H >> 2));
  }
  function render(dt) {
    if (!enabled) { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);
    const depth = sceneRT.depthTexture;
    // AO
    if (aoOn) {
      projInv.copy(camera.projectionMatrixInverse);
      const aw = aoRT[0].width, ah = aoRT[0].height;
      Object.assign(aoMat.uniforms, {}); aoMat.uniforms.tDepth.value = depth; aoMat.uniforms.proj.value.copy(camera.projectionMatrix);
      aoMat.uniforms.res.value.set(aw, ah); aoMat.uniforms.near.value = camera.near; aoMat.uniforms.far.value = camera.far;
      pass(aoMat, aoRT[0]);
      blurMat.uniforms.tDepth.value = depth; blurMat.uniforms.near.value = camera.near; blurMat.uniforms.far.value = camera.far;
      blurMat.uniforms.tAO.value = aoRT[0].texture; blurMat.uniforms.dir.value.set(1.5 / aw, 0); pass(blurMat, aoRT[1]);
      blurMat.uniforms.tAO.value = aoRT[1].texture; blurMat.uniforms.dir.value.set(0, 1.5 / ah); pass(blurMat, aoRT[0]);
    }
    // bloom
    brightMat.uniforms.tColor.value = sceneRT.texture; brightMat.uniforms.texel.value.set(0.5 / W, 0.5 / H);
    pass(brightMat, bloomRT[0]);
    for (let i = 1; i < MIPS; i++) {
      downMat.uniforms.tSrc.value = bloomRT[i - 1].texture; downMat.uniforms.texel.value.set(1 / bloomRT[i - 1].width, 1 / bloomRT[i - 1].height);
      pass(downMat, bloomRT[i]);
    }
    for (let i = MIPS - 1; i > 0; i--) {
      upMat.uniforms.tSrc.value = bloomRT[i].texture; upMat.uniforms.texel.value.set(1 / bloomRT[i].width, 1 / bloomRT[i].height);
      renderer.autoClear = false; pass(upMat, bloomRT[i - 1]); renderer.autoClear = true;
    }
    // light shafts
    let sunVis = 0;
    if (fx.shafts && fx.sunDir) {
      const front = camera.getWorldDirection(fwd).dot(fx.sunDir);
      if (front > 0.15) {
        sunP.copy(fx.sunDir).multiplyScalar(4000).add(camera.position).project(camera);
        const edge = Math.max(Math.abs(sunP.x), Math.abs(sunP.y));
        sunVis = Math.min(1, (front - 0.15) / 0.25) * Math.max(0, Math.min(1, (2.7 - edge) / 1.0)); // a sun just above the frame still throws rays down into it
        if (sunVis > 0.01) {
          shaftMat.uniforms.tColor.value = sceneRT.texture; shaftMat.uniforms.tDepth.value = depth;
          shaftMat.uniforms.sun.value.set(sunP.x * 0.5 + 0.5, sunP.y * 0.5 + 0.5); shaftMat.uniforms.aspect.value = W / H;
          pass(shaftMat, shaftRT);
        }
      }
    }
    // eye adaptation (quicker to stop down for brightness than to open up for the dark)
    const nowT = performance.now(), real = Math.min(0.1, (nowT - lastT) / 1000); lastT = nowT;
    lumMat.uniforms.tColor.value = sceneRT.texture; pass(lumMat, lumRT);
    adaptMat.uniforms.tLum.value = lumRT.texture; adaptMat.uniforms.tPrev.value = adaptRT[adaptI].texture; adaptMat.uniforms.rate.value = Math.min(1, real * 1.6);
    pass(adaptMat, adaptRT[1 - adaptI]); adaptI = 1 - adaptI;
    // composite to the screen
    finalMat.uniforms.tShaft.value = shaftRT.texture; finalMat.uniforms.shaft.value = sunVis > 0.01 ? sunVis * fx.shaftAmt : 0;
    finalMat.uniforms.tAdapt.value = adaptRT[adaptI].texture; finalMat.uniforms.blur.value = fx.blur; finalMat.uniforms.focus.value = fx.focus;
    finalMat.uniforms.tColor.value = sceneRT.texture; finalMat.uniforms.tAO.value = aoOn ? aoRT[0].texture : null; finalMat.uniforms.aoAmt.value = aoOn ? 0.65 : 0;
    finalMat.uniforms.tBloom.value = bloomRT[0].texture; finalMat.uniforms.exposure.value = renderer.toneMappingExposure;
    finalMat.uniforms.time.value = (finalMat.uniforms.time.value + 1) % 1000;
    pass(finalMat, null);
  }
  return { render, setSize, setSamples, get enabled() { return enabled; }, set enabled(v) { enabled = v; }, set ao(v) { aoOn = v; }, get ao() { return aoOn; }, sceneRT, aoRT, finalMat, fx };
};
})();
