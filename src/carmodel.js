// Real car model: "Car Concept" by Eric Chadwick / Darmstadt Graphics Group (CC-BY 4.0), a physically based glTF
// sports car (clear-coat paint, glass, interior, separate wheels). Loaded once and turned into a template in this
// game's car frame (x left, y up, z forward, wheels on y = 0, about 4.45 m long); every car (yours and the traffic)
// is built from the template with its own paint and its own crumple-able copy of the body when it needs one.
(function () {
'use strict';

const vec = () => new THREE.Vector3();
// gather every mesh's geometry into one indexed geometry: position, normal, uv (+uv2 for AO maps), color = 1
function mergeGeos(geos) {
  let nv = 0, ni = 0;
  for (const g of geos) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), U = new Float32Array(nv * 2), C = new Float32Array(nv * 3).fill(1), I = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv, c = p.count;
    for (let i = 0; i < c; i++) {
      P[(ov + i) * 3] = p.getX(i); P[(ov + i) * 3 + 1] = p.getY(i); P[(ov + i) * 3 + 2] = p.getZ(i);
      if (n) { N[(ov + i) * 3] = n.getX(i); N[(ov + i) * 3 + 1] = n.getY(i); N[(ov + i) * 3 + 2] = n.getZ(i); }
      if (u) { U[(ov + i) * 2] = u.getX(i); U[(ov + i) * 2 + 1] = u.getY(i); }
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) I[oi++] = g.index.getX(i) + ov;
    else for (let i = 0; i < c; i++) I[oi++] = i + ov;
    ov += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3)); out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(U, 2)); out.setAttribute('uv2', new THREE.BufferAttribute(U, 2));
  out.setAttribute('color', new THREE.BufferAttribute(C, 3)); out.setIndex(new THREE.BufferAttribute(I, 1));
  out.computeBoundingSphere();
  return out;
}

window.loadCarModel = async function (url, cfg = {}) {
  const gltf = await new THREE.GLTFLoader().loadAsync(url);
  const root = gltf.scene; root.updateMatrixWorld(true);
  const meshes = []; root.traverse(o => { if (o.isMesh) meshes.push(o); });
  const findBy = re => { let f = null; root.traverse(o => { if (!f && o.name && re.test(o.name) && !/interior|steering/i.test(o.name)) f = o; }); return f; };
  const boxOf = objs => { const b = new THREE.Box3(); for (const o of objs) b.expandByObject(o); return b; };
  // which way is up and which way is forward? Found from the headlights and the roof when the model names them,
  // else from the config, else the glTF convention (+Y up, nose towards +Z)
  const all = boxOf([root]), size = all.getSize(vec()), ctr = all.getCenter(vec());
  const axes = [size.x, size.y, size.z];
  const AX = { x: 0, y: 1, z: 2 };
  let upAx = cfg.up ? AX[cfg.up[1]] : axes.indexOf(Math.min(...axes)), lenAx = cfg.forward ? AX[cfg.forward[1]] : axes.indexOf(Math.max(...axes));
  if (upAx === lenAx) lenAx = (upAx + 2) % 3;
  const sideAx = 3 - upAx - lenAx;
  const headObj = findBy(/head.?(light|lamp)/i), roofObj = findBy(/roof/i);
  let fwdSign = cfg.forward ? (cfg.forward[0] === '-' ? -1 : 1) : 1, upSign = cfg.up ? (cfg.up[0] === '-' ? -1 : 1) : 1;
  if (!cfg.forward && headObj) fwdSign = Math.sign(boxOf([headObj]).getCenter(vec()).getComponent(lenAx) - ctr.getComponent(lenAx)) || 1;
  if (!cfg.up && roofObj) upSign = Math.sign(boxOf([roofObj]).getCenter(vec()).getComponent(upAx) - ctr.getComponent(upAx)) || 1;
  // rotation into the game frame: x = side, y = up, z = forward; keep it a proper rotation (det +1)
  const rows = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  rows[1][upAx] = upSign; rows[2][lenAx] = fwdSign; rows[0][sideAx] = 1;
  const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (det(rows) < 0) rows[0][sideAx] = -1;
  const R = new THREE.Matrix4().set(rows[0][0], rows[0][1], rows[0][2], 0, rows[1][0], rows[1][1], rows[1][2], 0, rows[2][0], rows[2][1], rows[2][2], 0, 0, 0, 0, 1);
  // scale to its real length (config, default 4.45 m), centre it
  const k = (cfg.length || 4.45) / size.getComponent(lenAx);
  const T = new THREE.Matrix4().makeScale(k, k, k).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-ctr.x, -ctr.y, -ctr.z));
  const baked = o => o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(T, o.matrixWorld));
  // wheels: the outermost objects named like a wheel/tyre/rim, sorted into the four corners
  const WHEEL = /wheel|tire|tyre|rim\b|rim_|rims/i;
  const roots = [];
  root.traverse(o => {
    if (o === root || !o.name || !WHEEL.test(o.name) || /steering|spare/i.test(o.name)) return;
    for (let p = o.parent; p && p !== root; p = p.parent) if (p.name && WHEEL.test(p.name) && !/steering|spare/i.test(p.name)) return;
    roots.push(o);
  });
  const corner = [null, null, null, null], cornerObjs = [[], [], [], []];
  for (const o of roots) {
    const c = boxOf([o]).getCenter(vec()).applyMatrix4(T);
    const i = (c.z > 0 ? 0 : 2) + (c.x > 0 ? 0 : 1);
    cornerObjs[i].push(o);
  }
  const haveWheels = cornerObjs.every(l => l.length > 0);
  const wheelOf = o => { if (!haveWheels) return -1; for (let p = o; p; p = p.parent) { for (let i = 0; i < 4; i++) if (cornerObjs[i].includes(p)) return i; if (p.name && /axle/i.test(p.name)) return -2; } return -1; };
  let minY = Infinity;
  for (const o of meshes) if (wheelOf(o) >= 0 || !haveWheels) { const g = baked(o); g.computeBoundingBox(); minY = Math.min(minY, g.boundingBox.min.y); }
  const lift = new THREE.Matrix4().makeTranslation(0, -minY, 0);
  const place = o => baked(o).applyMatrix4(lift);

  // materials: glass without the (expensive) transmission pass; everything shows scrapes through vertex colours
  const isGlass = m => m.transmission > 0 || /glass|window|windshield|windscreen/i.test(m.name) || (m.transparent && m.opacity < 0.9);
  const fixMat = m => {
    if (isGlass(m)) {
      return new THREE.MeshPhysicalMaterial({ name: m.name, color: new THREE.Color(0.06, 0.07, 0.08), roughness: 0.03, metalness: 0.1, clearcoat: 1,
        transparent: true, opacity: 0.45, envMapIntensity: 1.5, vertexColors: true, side: THREE.DoubleSide, depthWrite: false });
    }
    m.vertexColors = true;
    if (/paint|body|exterior/i.test(m.name)) { m.clearcoat = Math.max(m.clearcoat || 0, 1); m.clearcoatRoughness = 0.03; }
    return m;
  };
  const PAINT = cfg.paint ? new RegExp(cfg.paint, 'i') : /paint|car_?paint|body_?col|exterior|carrosserie/i;
  // which body parts are special: lights that go dark, mirrors that break off, needless detail
  const specialOf = o => {
    const nm = (o.name || '') + ' ' + (o.parent ? o.parent.name || '' : '');
    if (/interior/i.test(nm)) return '';
    if (/head.?(light|lamp)/i.test(nm)) return 'head';
    if (/tail.?(light|lamp)|brake.?light|rear.?light|stop.?light/i.test(nm) && !/panel|housing|frame/i.test(o.name || '')) return 'tail';
    if (/mirror/i.test(nm)) { const c = boxOf([o]).getCenter(vec()).applyMatrix4(T); return c.x > 0 ? 'mirrorL' : 'mirrorR'; }
    if (/wiper/i.test(nm) && o.geometry.attributes.position.count > 5000) return 'skip';
    return '';
  };
  const groups = new Map();
  for (const o of meshes) {
    if (wheelOf(o) !== -1) continue;
    const special = specialOf(o);
    if (special === 'skip') continue;
    const key = special + '|' + o.material.uuid;
    if (!groups.has(key)) groups.set(key, { special, mat: fixMat(o.material), geos: [] });
    groups.get(key).geos.push(place(o));
  }
  const body = [];
  for (const [, g] of groups) {
    const nm = g.mat.name || '';
    body.push({ special: g.special, mat: g.mat, geo: mergeGeos(g.geos), glass: !!g.mat.transparent,
      paint: !PAINT.test(nm) || g.mat.transparent ? 0 : /2|accent|second/i.test(nm) ? 2 : 1 });
  }
  // no material named like paint: the biggest opaque part is the paint
  if (!body.some(b => b.paint)) {
    let best = null, bv = 0;
    for (const b of body) { if (b.glass || b.special) continue; b.geo.computeBoundingBox(); const s3 = b.geo.boundingBox.getSize(vec()); const v = s3.x * s3.y * s3.z; if (v > bv) { bv = v; best = b; } }
    if (best) best.paint = 1;
  }
  // wheels: each centred on its own axle; tyre, rim and disc turn, the calliper doesn't
  const wheels = haveWheels ? [0, 1, 2, 3].map(i => {
    const parts = meshes.filter(o => wheelOf(o) === i);
    const tyre = parts.filter(o => /tire|tyre|rubber/i.test((o.material.name || '') + (o.name || '')));
    const tb = new THREE.Box3(); for (const o of (tyre.length ? tyre : parts)) { const g = place(o); g.computeBoundingBox(); tb.union(g.boundingBox); }
    const c = tb.getCenter(vec()), r = tb.getSize(vec()).y / 2;
    const spin = [], fixed = [];
    for (const o of parts) {
      const g = place(o).translate(-c.x, -c.y, -c.z), nm = (o.material.name || '') + ' ' + (o.name || '');
      (/caliper|calliper|brake.?pad|brakepad/i.test(nm) || (/brake/i.test(nm) && !/disc|disk|rotor/i.test(nm)) ? fixed : spin).push({ geo: g, mat: fixMat(o.material) });
    }
    return { center: c, radius: r, spin, fixed };
  }) : null;
  const bb = new THREE.Box3(), bbNoMirror = new THREE.Box3();
  for (const b of body) { b.geo.computeBoundingBox(); bb.union(b.geo.boundingBox); if (!/mirror/.test(b.special)) bbNoMirror.union(b.geo.boundingBox); }
  const top = bb.max.y;
  const axles = wheels ? { front: (wheels[0].center.z + wheels[1].center.z) / 2, rear: (wheels[2].center.z + wheels[3].center.z) / 2 } : null;
  return { name: cfg.name || url, body, wheels, top, bodyHalfW: Math.max(-bbNoMirror.min.x, bbNoMirror.max.x), halfW: Math.max(-bb.min.x, bb.max.x), length: bb.max.z - bb.min.z, axles };
};

/**
 * A car kit from the template (same shape as buildCarBody's): meshes to bind to the soft body, breakable parts,
 * materials for the brake lights and indicators. opts: { paint: [r,g,b] linear, paint2: [r,g,b], ownGeometry }
 */
window.buildModelCar = function (T, opts = {}) {
  const meshes = [], parts = [];
  const paint1 = opts.paint || [0.5, 0.02, 0.02], paint2 = opts.paint2 || [0.015, 0.015, 0.018];
  const matCache = new Map();
  const matFor = b => {
    if (matCache.has(b.mat)) return matCache.get(b.mat);
    let m = b.mat;
    if (b.paint) { m = m.clone(); m.color.setRGB(...(b.paint === 1 ? paint1 : paint2)); if (m.map) { m.map = null; m.needsUpdate = true; } }
    else if (b.special === 'head' || b.special === 'tail') { m = m.clone(); if (b.special === 'tail') { m.emissive = new THREE.Color('#ff1a0f'); m.emissiveIntensity = 0.8; } else { m.emissive = new THREE.Color('#fff4dc'); m.emissiveIntensity = 2.5; } }
    matCache.set(b.mat, m);
    return m;
  };
  let tail = null; const heads = [];
  for (const b of T.body) {
    const mesh = new THREE.Mesh(opts.ownGeometry ? b.geo.clone() : b.geo, matFor(b));
    mesh.castShadow = !b.glass; mesh.receiveShadow = true; mesh.name = b.special || 'body';
    meshes.push({ mesh, opts: { color: [1, 1, 1], scrape: b.glass ? null : [0.3, 0.3, 0.32], crack: b.glass ? [0.55, 0.58, 0.6] : null, wrinkle: b.glass ? 0.005 : 0.018 } });
    const bb = (b.geo.computeBoundingBox(), b.geo.boundingBox), c = bb.getCenter(vec());
    if (b.special === 'head') { heads.push(mesh); parts.push({ mesh, kind: 'light', name: 'Headlight', anchor: [c.x, c.y, c.z], limit: 0.1 }); }
    if (b.special === 'tail') { tail = mesh; parts.push({ mesh, kind: 'light', name: 'Taillight', anchor: [c.x, c.y, c.z], limit: 0.12 }); }
    if (b.special === 'mirrorL' || b.special === 'mirrorR') parts.push({ mesh, kind: 'detach', name: 'Mirror', anchor: [c.x, c.y, c.z], limit: 0.14 });
  }
  // indicators: small amber lenses tucked into the outer edge of the head and tail light clusters, dark when off
  const amber = () => new THREE.MeshStandardMaterial({ color: '#1a1208', emissive: '#ffa31a', emissiveIntensity: 0 });
  const indicators = { left: amber(), right: amber() };
  const boxOfMesh = m => { m.geometry.computeBoundingBox(); return m.geometry.boundingBox; };
  const hb = heads[0] ? boxOfMesh(heads[0]) : null, tb = tail ? boxOfMesh(tail) : null;
  for (const sx of [1, -1]) {
    const geos = [];
    if (hb) geos.push(new THREE.BoxGeometry(0.07, 0.035, 0.02).translate(sx * (Math.max(Math.abs(hb.min.x), Math.abs(hb.max.x)) - 0.04), (hb.min.y + hb.max.y) / 2, hb.max.z - 0.01));
    if (tb) geos.push(new THREE.BoxGeometry(0.07, 0.035, 0.02).translate(sx * (Math.max(Math.abs(tb.min.x), Math.abs(tb.max.x)) - 0.04), (tb.min.y + tb.max.y) / 2, tb.min.z + 0.01));
    if (!geos.length) continue;
    meshes.push({ mesh: new THREE.Mesh(mergeGeos(geos), sx > 0 ? indicators.left : indicators.right), opts: null });
  }
  const mats = { tail: tail ? tail.material : amber(), head: heads[0] ? heads[0].material : amber() };
  // wheels: shared geometry, built per car
  const makeWheel = T.wheels && (i => {
    const w = T.wheels[i], spin = new THREE.Group(), fixed = new THREE.Group();
    for (const p of w.spin) { const m = new THREE.Mesh(p.geo, p.mat); m.castShadow = true; m.receiveShadow = true; spin.add(m); }
    for (const p of w.fixed) fixed.add(new THREE.Mesh(p.geo, p.mat));
    return { spin, fixed, center: w.center, radius: w.radius };
  });
  return { meshes, parts, mats, heads, tail, indicators, top: T.top, model: true, makeWheel, axles: T.axles, halfW: T.halfW, bodyHalfW: T.bodyHalfW, length: T.length };
};
})();
