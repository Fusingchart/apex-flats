// Grass: real blades (a photographed grass-blade atlas from Poly Haven, CC0, alpha-cut) on crossed cards,
// thousands of clumps instanced around the camera on every bit of open ground. The field is laid out on a fixed
// world grid (so clumps don't swim as you move) and rebuilt when you've moved a few metres; clumps thin out and
// shrink towards the edge so there's no visible boundary. A vertex shader sways the tips in the wind.
(function () {
'use strict';

window.createGrass = function ({ scene, city, camera, sunDir }) {
  const near = grassLayer({ scene, city, camera, sunDir, R: 52, CELL: 0.34, MAX: 100000, REBUILD: 5, fadeIn: 0, fadeOut: 36, size: 1, seed: 0 });
  // a second, coarser layer of bigger clumps carries the grass out to ~160 m, fading in where the near layer ends
  const far = grassLayer({ scene, city, camera, sunDir, R: 165, CELL: 0.95, MAX: 110000, REBUILD: 14, fadeIn: 34, fadeOut: 120, size: 2.0, seed: 7 });
  return {
    update(dt) { near.update(dt); far.update(dt); },
    set enabled(v) { near.mesh.visible = v; far.mesh.visible = v; },
  };
};
function grassLayer({ scene, city, camera, sunDir, R, CELL, MAX, REBUILD, fadeIn, fadeOut, size, seed }) {
  // one clump: three crossed cards, the full atlas on each (it holds about nine blades)
  const geo = (() => {
    const pos = [], uv = [], nrm = [], idx = [];
    for (let k = 0; k < 3; k++) {
      const a = k * Math.PI / 3, c = Math.cos(a) * 0.5, s = Math.sin(a) * 0.5, b = pos.length / 3;
      pos.push(-c, 0, -s, c, 0, s, c, 1, s, -c, 1, -s);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      for (let i = 0; i < 4; i++) nrm.push(0, 1, 0); // up-facing normals: lit like the ground, no dark backsides
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); g.setIndex(idx);
    return g;
  })();
  const tex = new THREE.TextureLoader().load('assets/foliage/grass.png');
  tex.encoding = THREE.sRGBEncoding; tex.anisotropy = 4;
  const time = { value: 0 }, camPos = { value: new THREE.Vector3() };
  const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85, color: new THREE.Color(1.15, 1.5, 0.55) });
  mat.onBeforeCompile = sh => {
    sh.uniforms.uTime = time; sh.uniforms.uSun = { value: sunDir }; sh.uniforms.uCam = camPos;
    sh.vertexShader = 'uniform float uTime;\nuniform vec3 uCam;\nvarying float vH;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vH = position.y;
      #ifdef USE_INSTANCING
        vec3 ip = instanceMatrix[3].xyz;
        float gd = distance(ip.xz, uCam.xz);
        transformed *= ${fadeIn > 0 ? `smoothstep(${fadeIn.toFixed(1)}, ${(fadeIn + 14).toFixed(1)}, gd) * ` : ''}(1.0 - smoothstep(${fadeOut.toFixed(1)}, ${R.toFixed(1)}, gd)); // fade in/out by distance
        float w = sin(uTime * 1.7 + ip.x * 0.21 + ip.z * 0.17) * 0.6 + sin(uTime * 3.1 + ip.x * 0.7) * 0.25;
        transformed.x += w * 0.12 * position.y * position.y;
        transformed.z += w * 0.07 * position.y * position.y;
      #endif`);
    // darker at the roots (the blades shade each other), and sunlit tips glow a little when looking into the sun
    sh.fragmentShader = 'varying float vH;\nuniform vec3 uSun;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      diffuseColor.rgb *= mix(0.7, 1.1, smoothstep(0.0, 0.8, vH));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      vec3 vdir = normalize(vViewPosition);
      float back = pow(max(0.0, dot(vdir, normalize((viewMatrix * vec4(uSun, 0.0)).xyz))), 10.0);
      totalEmissiveRadiance += diffuseColor.rgb * back * 0.25 * vH;`);
  };
  mat.customProgramCacheKey = () => 'grass' + R;
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false; mesh.count = 0;
  scene.add(mesh);

  const hash = (i, j, k) => { let h = (i * 374761393 + j * 668265263 + k * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), E = new THREE.Euler();
  // 8 m tiles, each worked out once and cached (matrices + colours); a rebuild just stitches nearby tiles together
  const TILE = 8, tiles = new Map(), tkey = (i, j) => i * 100000 + j;
  function makeTile(ti, tj) {
    const mats = [], cols = [];
    const n0 = Math.round(TILE / CELL);
    for (let a = 0; a < n0; a++) for (let b = 0; b < n0; b++) {
      const i = ti * n0 + a, j = tj * n0 + b;
      const x = (i + hash(i + seed, j, 1)) * CELL, z = (j + hash(i, j + seed, 2)) * CELL;
      const lush = city.grassAt(x, z);
      if (lush <= 0 || hash(i, j, 4) > lush) continue;
      const y = city.groundAt(x, z) - 0.02, hgt = (0.2 + 0.32 * hash(i, j, 5) * hash(i, j, 12)) * (size > 1 ? 1.25 : 1), wid = (0.55 + 0.35 * hash(i, j, 6)) * size;
      Q.setFromEuler(E.set((hash(i, j, 8) - 0.5) * 0.25, hash(i, j, 7) * Math.PI, (hash(i, j, 9) - 0.5) * 0.25));
      M.compose(V.set(x, y, z), Q, S.set(wid, hgt, wid));
      mats.push(...M.elements);
      const t = hash(i, j, 10), dry = hash(Math.floor(i / 9), Math.floor(j / 9), 11);
      cols.push(0.75 + 0.25 * t + 0.45 * dry, 0.9 + 0.2 * t + 0.1 * dry, 0.75 + 0.25 * t - 0.25 * dry);
    }
    return { m: new Float32Array(mats), c: new Float32Array(cols), used: 0 };
  }
  let cx = 1e9, cz = 1e9, pending = false, stamp = 0;
  function rebuild(px, pz, budget) {
    stamp++;
    const t0 = Math.floor((px - R) / TILE), t1 = Math.floor((px + R) / TILE), u0 = Math.floor((pz - R) / TILE), u1 = Math.floor((pz + R) / TILE);
    const want = [];
    for (let i = t0; i <= t1; i++) for (let j = u0; j <= u1; j++) {
      const dx = Math.max(i * TILE - px, 0, px - (i + 1) * TILE), dz = Math.max(j * TILE - pz, 0, pz - (j + 1) * TILE);
      if (dx * dx + dz * dz < R * R) want.push([i, j, Math.hypot((i + 0.5) * TILE - px, (j + 0.5) * TILE - pz)]);
    }
    want.sort((a, b) => a[2] - b[2]); // nearest tiles first
    let n = 0, missing = false;
    const im = mesh.instanceMatrix.array, ic = mesh.instanceColor.array;
    for (const [i, j] of want) {
      const k = tkey(i, j);
      let t = tiles.get(k);
      if (!t) { if (budget-- <= 0) { missing = true; continue; } t = makeTile(i, j); tiles.set(k, t); }
      t.used = stamp;
      const cnt = t.c.length / 3;
      if (n + cnt > MAX) break;
      im.set(t.m, n * 16); ic.set(t.c, n * 3); n += cnt;
    }
    mesh.count = n; mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
    if (!missing) { cx = px; cz = pz; }
    pending = missing;
    if (tiles.size > 600) for (const [k, t] of tiles) if (stamp - t.used > 40) tiles.delete(k); // forget old tiles
  }
  return {
    mesh,
    update(dt) {
      time.value += dt; camPos.value.copy(camera.position);
      const p = camera.position;
      if (pending || Math.hypot(p.x - cx, p.z - cz) > REBUILD) rebuild(p.x, p.z, cx > 1e8 ? 2000 : 10);
    },
  };
}
})();
