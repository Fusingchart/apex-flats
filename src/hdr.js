// Radiance .hdr (RGBE) loader for the sky. Returns
//   rgbe:     the full-resolution image as RGBE bytes, rows bottom-up (three.js equirect convention), for the
//             visible sky (decoded in the shader: 4 bytes a pixel instead of 16)
//   envTex:   a 1024x512 float copy with the sun clipped, for the prefiltered environment (ambient + reflections)
//   sunDir, sunColor: where the sun is in the photo and its colour, so the directional light matches it
//   horizon:  the sky colour just above the horizon in 64 directions, for the haze
(function () {
'use strict';

function parse(buf) {
  const bytes = new Uint8Array(buf);
  let p = 0;
  const line = () => { let s = ''; while (p < bytes.length && bytes[p] !== 10) s += String.fromCharCode(bytes[p++]); p++; return s; };
  if (!line().startsWith('#?')) throw new Error('not a Radiance HDR file');
  for (;;) { const l = line(); if (l === '') break; }
  const dims = line().match(/-Y (\d+) \+X (\d+)/);
  if (!dims) throw new Error('unsupported HDR orientation');
  const H = +dims[1], W = +dims[2];
  const out = new Uint8Array(W * H * 4), scan = new Uint8Array(W * 4);
  for (let y = 0; y < H; y++) {
    // new-style run-length encoding: 2 2 hi lo, then four channel planes
    if (bytes[p] !== 2 || bytes[p + 1] !== 2 || ((bytes[p + 2] << 8) | bytes[p + 3]) !== W) throw new Error('unsupported HDR encoding');
    p += 4;
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < W) {
        let n = bytes[p++];
        if (n > 128) { n -= 128; const v = bytes[p++]; while (n--) scan[(x++) * 4 + c] = v; }
        else while (n--) scan[(x++) * 4 + c] = bytes[p++];
      }
    }
    out.set(scan, (H - 1 - y) * W * 4); // store bottom-up
  }
  return { W, H, rgbe: out };
}

const decode = (rgbe, i, o, k) => { const e = rgbe[i + 3]; if (!e) { o[k] = o[k + 1] = o[k + 2] = 0; return; } const f = Math.pow(2, e - 136); o[k] = rgbe[i] * f; o[k + 1] = rgbe[i + 1] * f; o[k + 2] = rgbe[i + 2] * f; };
// three.js equirect convention: u = atan(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5 (v = 0 at the bottom row)
const dirOf = (u, v) => { const phi = (u - 0.5) * Math.PI * 2, lat = (v - 0.5) * Math.PI; return new THREE.Vector3(Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat)); };

window.loadHDR = async function (url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('could not load ' + url);
  const { W, H, rgbe } = parse(await res.arrayBuffer());
  // the sun: the brightest pixel above the horizon
  let best = -1, bi = 0;
  const px = new Float32Array(3);
  for (let y = H >> 1; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4; if (rgbe[i + 3] < best) continue;
    decode(rgbe, i, px, 0); const l = px[0] + px[1] + px[2];
    if (l > best) { best = l; bi = y * W + x; }
  }
  const sx = bi % W, sy = (bi / W) | 0;
  const sunDir = dirOf((sx + 0.5) / W, (sy + 0.5) / H).normalize();
  // the sun's colour: average a small patch round it and normalise
  const sc = [0, 0, 0];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const x = (sx + dx + W) % W, y = Math.min(H - 1, Math.max(0, sy + dy)); decode(rgbe, (y * W + x) * 4, px, 0); sc[0] += px[0]; sc[1] += px[1]; sc[2] += px[2];
  }
  const m = Math.max(...sc); const sunColor = sc.map(v => v / m);
  // environment copy: 1024 x 512 box-filtered floats, sun and very bright cloud edges clipped (the sun itself is
  // the directional light; leaving it in would light everything twice)
  const EW = 1024, EH = 512, sxF = W / EW, syF = H / EH, env = new Float32Array(EW * EH * 4);
  for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let j = 0; j < syF; j += 2) for (let i = 0; i < sxF; i += 2) {
      decode(rgbe, ((Math.floor(y * syF + j)) * W + Math.floor(x * sxF + i)) * 4, px, 0);
      r += Math.min(px[0], 12); g += Math.min(px[1], 12); b += Math.min(px[2], 12); n++;
    }
    const k = (y * EW + x) * 4; env[k] = r / n; env[k + 1] = g / n; env[k + 2] = b / n; env[k + 3] = 1;
  }
  // normalise: the upper hemisphere averages `target` (photos come at whatever exposure they were shot at)
  let sum = 0, cnt = 0;
  for (let y = EH >> 1; y < EH; y++) for (let x = 0; x < EW; x++) { const k = (y * EW + x) * 4; sum += 0.2126 * env[k] + 0.7152 * env[k + 1] + 0.0722 * env[k + 2]; cnt++; }
  const gain = 0.3 / (sum / cnt);
  for (let i = 0; i < env.length; i += 4) { env[i] *= gain; env[i + 1] *= gain; env[i + 2] *= gain; }
  const envTex = new THREE.DataTexture(env, EW, EH, THREE.RGBAFormat, THREE.FloatType);
  envTex.mapping = THREE.EquirectangularReflectionMapping; envTex.magFilter = THREE.LinearFilter; envTex.needsUpdate = true;
  // horizon colours (2-4 degrees up), 64 azimuths
  const horizon = new Float32Array(64 * 3);
  for (let a = 0; a < 64; a++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let v = 0.512; v < 0.525; v += 0.004) for (let du = -0.006; du <= 0.006; du += 0.003) {
      const u = ((a + 0.5) / 64 + du + 1) % 1, x = Math.floor(u * W), y = Math.floor(v * H);
      decode(rgbe, (y * W + x) * 4, px, 0); r += Math.min(px[0], 8); g += Math.min(px[1], 8); b += Math.min(px[2], 8); n++;
    }
    horizon[a * 3] = r / n * gain; horizon[a * 3 + 1] = g / n * gain; horizon[a * 3 + 2] = b / n * gain;
  }
  const skyTex = new THREE.DataTexture(rgbe, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  skyTex.magFilter = THREE.LinearFilter; skyTex.minFilter = THREE.LinearFilter; skyTex.generateMipmaps = false;
  skyTex.wrapS = THREE.RepeatWrapping; skyTex.needsUpdate = true;
  return { W, H, skyTex, envTex, sunDir, sunColor, horizon, gain };
};
})();
