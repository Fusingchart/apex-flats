/*
 * Car body built as lofted cross-sections, dense enough to crumple convincingly under free-form deformation.
 * All geometry is returned in car-local coordinates (x left, y up, z forward, origin at the centre of mass
 * on the ground plane), with transforms baked in so the soft body can move every vertex directly.
 */
(function () {
'use strict';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function keys(table, z) { // cosine interpolation through (z, value) pairs
  if (z <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) if (z <= table[i][0]) {
    const [z0, v0] = table[i - 1], [z1, v1] = table[i];
    const t = (1 - Math.cos(Math.PI * (z - z0) / (z1 - z0))) / 2;
    return lerp(v0, v1, t);
  }
  return table[table.length - 1][1];
}

const FRONT_AXLE = 1.25, REAR_AXLE = -1.35, ARCH_R = 0.43, WHEEL_R = 0.33, END = 2.2, CAP = 0.06;
const BELT = [[-2.2, 0.80], [-2.12, 0.93], [-1.7, 0.98], [-1.0, 0.95], [0.9, 0.9], [1.6, 0.8], [2.0, 0.72], [2.2, 0.55]];
const BOTTOM = [[-2.2, 0.45], [-2.05, 0.3], [1.95, 0.28], [2.2, 0.42]];
// The body shape in use: the default profiles, or a style's own (set at the start of each build)
let SHAPE = null;
const belt = z => keys(SHAPE.belt, z);
const bottom = z => keys(SHAPE.bottom, z);
const halfW = z => SHAPE.halfW(z);
function halfWDefault(z) {
  let w = 0.93;
  if (z > 1.6) w -= 0.28 * ((z - 1.6) / 0.6) ** 2;
  if (z < -1.75) w -= 0.18 * ((-1.75 - z) / 0.45) ** 2;
  w += 0.028 * Math.exp(-(((z - FRONT_AXLE) / 0.35) ** 2)) + 0.035 * Math.exp(-(((z - REAR_AXLE) / 0.35) ** 2));
  return w;
}
const DEFAULT_SHAPE = { belt: BELT, bottom: BOTTOM, halfW: halfWDefault, dip: () => 0 };
// The GT: low and wide, front wings standing proud of a dipped bonnet, broad rear haunches, a long fastback
const GT_SHAPE = {
  belt: [[-2.26, 0.84], [-2.18, 0.93], [-1.95, 0.97], [-1.45, 0.98], [-0.95, 0.93], [0.0, 0.88], [0.85, 0.85], [1.3, 0.8], [1.72, 0.77], [2.02, 0.66], [2.22, 0.5]],
  bottom: [[-2.26, 0.42], [-2.1, 0.22], [1.95, 0.2], [2.22, 0.36]],
  halfW: z => {
    let w = 0.9 + 0.09 * Math.exp(-(((z + 1.3) / 0.7) ** 2)) + 0.03 * Math.exp(-(((z - 1.25) / 0.35) ** 2));
    if (z > 1.75) w -= 0.3 * ((z - 1.75) / 0.5) ** 2;
    if (z < -1.95) w -= 0.22 * ((-1.95 - z) / 0.3) ** 2;
    return w;
  },
  dip: z => -0.075 * smoothstep(0.85, 1.15, z) * (1 - smoothstep(1.85, 2.15, z)), // the bonnet sits between the wings
};
// Greenhouse shapes. `roof` is the roofline (z, height) between `start` and `end`; `panel` is the painted roof span.
const STYLES = {
  coupe: { start: -1.85, end: 0.85, roof: [[-1.0, 1.33], [-0.4, 1.36], [0.0, 1.33]], panel: [-1.05, 0.0], top: 1.42 },
  sedan: { start: -1.8, end: 1.0, roof: [[-1.15, 1.41], [-0.55, 1.47], [0.12, 1.44]], panel: [-1.2, 0.15], top: 1.52 },
  hatch: { start: -2.13, end: 0.95, roof: [[-2.0, 1.34], [-1.65, 1.46], [-0.4, 1.49], [0.12, 1.45]], panel: [-1.7, 0.15], top: 1.55 },
  suv: { start: -2.13, end: 0.98, roof: [[-2.02, 1.58], [-1.7, 1.73], [-0.4, 1.76], [0.18, 1.71]], panel: [-1.75, 0.2], top: 1.82 },
  gt: { start: -1.9, end: 0.88, roof: [[-1.55, 1.04], [-1.05, 1.18], [-0.5, 1.26], [0.0, 1.27], [0.42, 1.19]], panel: [-0.8, 0.2], top: 1.3, shape: GT_SHAPE },
};
function roofOf(st) {
  const table = [[st.start, belt(st.start) - 0.03], ...st.roof, [st.end, belt(st.end) - 0.03]];
  return z => keys(table, z);
}

function archTop(z) {
  for (const zc of [FRONT_AXLE, REAR_AXLE]) {
    const dz = z - zc;
    if (Math.abs(dz) < ARCH_R) return WHEEL_R + Math.sqrt(ARCH_R * ARCH_R - dz * dz);
  }
  return -1;
}

// Mirror a right-half polyline (top centre -> bottom centre) into a closed loop.
function mirrorLoop(right) {
  const loop = right.slice();
  for (let i = right.length - 2; i >= 1; i--) loop.push({ ...right[i], x: -right[i].x });
  return loop;
}

function bodyLoop(z) {
  const zc = clamp(z, -END, END);
  const w = halfW(zc), b = belt(zc), bot = bottom(zc);
  const rc = Math.min(0.12, (b - bot) * 0.35);
  const ay = archTop(zc);
  let ybot = Math.max(bot + 0.06, ay);
  ybot = Math.min(ybot, b - rc - 0.05);
  const archT = smoothstep(0, 0.06, ay - bot);
  const archX = lerp(w - 0.06, 0.6, archT);
  // Smooth section: a crowned top, a rounded shoulder, a gently curved flank (tumblehome), the wheel arch, the sill
  const R = [];
  const dip = SHAPE.dip(zc);
  for (const t of [0, 0.3, 0.55, 0.75]) R.push({ x: (w - rc) * t, y: b + 0.04 * (1 - t * t) + dip * (1 - smoothstep(0.4, 0.78, t)), tag: 'top' });
  for (let k = 1; k <= 4; k++) { const a = (k / 4) * Math.PI / 2; R.push({ x: w - rc + Math.sin(a) * rc, y: b - rc + Math.cos(a) * rc * 0.9 + 0.004, tag: k < 4 ? 'corner' : 'side' }); }
  for (const t of [0.3, 0.62]) { const y = lerp(b - rc, ybot, t); R.push({ x: w + 0.018 * Math.sin(t * Math.PI) - 0.01 * t, y, tag: 'side' }); }
  R.push({ x: w - 0.03, y: ybot, tag: 'side' });
  R.push({ x: archX, y: ybot, tag: 'arch' }, { x: archX, y: bot + 0.02, tag: 'arch' });
  R.push({ x: archX * 0.5, y: bot, tag: 'under' }, { x: 0, y: bot, tag: 'under' });
  const loop = mirrorLoop(R);
  if (Math.abs(z) > END) { // round off the nose and tail
    const sf = Math.sqrt(Math.max(0, 1 - ((Math.abs(z) - END) / CAP) ** 2)), yc = (b + bot) / 2;
    for (const p of loop) { p.x *= sf; p.y = yc + (p.y - yc) * sf; }
  }
  return loop;
}

const cabinLoopFor = roofLine => z => {
  const base = belt(z) - 0.03, roof = Math.max(base, roofLine(z));
  const h = roof - base;
  const wb = halfW(z) - 0.1, wt = Math.min(0.64, wb - 0.06);
  const R = [];
  for (const t of [0, 0.35, 0.7]) R.push({ x: (wt - 0.1) * t, y: roof + 0.015 * Math.min(1, h * 6) * (1 - t * t), tag: 'top' });
  const cr = Math.min(0.08, h * 0.4);
  for (let k = 0; k <= 3; k++) { const a = (k / 3) * Math.PI / 2; R.push({ x: wt - 0.1 + Math.sin(a) * 0.1, y: roof - (1 - Math.cos(a)) * cr, tag: k === 0 ? 'top' : 'corner' }); }
  R.push({ x: lerp(wt, wb, 0.5) + 0.012, y: lerp(roof - cr, base, 0.5), tag: 'side' });
  R.push({ x: wb, y: base, tag: 'side' });
  R.push({ x: wb * 0.5, y: base - 0.02, tag: 'under' }, { x: 0, y: base - 0.02, tag: 'under' });
  return mirrorLoop(R);
};

/** Loft loops along z; keep only faces that pass `keep(segTagA, segTagB, xMid, zMid)`; compact unused vertices. */
function loft(zs, loopFn, keep) {
  const loops = zs.map(loopFn), Lp = loops[0].length;
  const pos = [], idx = [], remap = new Map();
  const vert = (i, j) => {
    const key = i * Lp + j;
    if (!remap.has(key)) { const p = loops[i][j]; remap.set(key, pos.length / 3); pos.push(p.x, p.y, zs[i]); }
    return remap.get(key);
  };
  for (let i = 0; i < zs.length - 1; i++) for (let j = 0; j < Lp; j++) {
    const jn = (j + 1) % Lp, A = loops[i][j], B = loops[i][jn];
    const xm = (A.x + B.x) / 2, zm = (zs[i] + zs[i + 1]) / 2;
    if (!keep(A.tag, B.tag, xm, zm)) continue;
    const a = vert(i, j), b = vert(i, jn), c = vert(i + 1, j), d = vert(i + 1, jn);
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const isTop = (a, b) => (a === 'top' || a === 'corner') && (b === 'top' || b === 'corner');

function mergeIndexed(geos) {
  const pos = [], idx = [];
  for (const g of geos) {
    const base = pos.length / 3, p = g.attributes.position.array;
    for (let i = 0; i < p.length; i++) pos.push(p[i]);
    if (g.index) for (const i of g.index.array) idx.push(base + i); else for (let i = 0; i < p.length / 3; i++) idx.push(base + i);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setIndex(idx);
  return out;
}

function mergeBoxes(geos) { // minimal merge for non-indexed copies of simple geometries
  const pos = [], nrm = [];
  for (const g of geos) { const n = g.toNonIndexed(); pos.push(...n.attributes.position.array); nrm.push(...n.attributes.normal.array); }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return out;
}

function bake(mesh) {
  mesh.updateMatrix();
  mesh.geometry = mesh.geometry.clone().applyMatrix4(mesh.matrix);
  mesh.position.set(0, 0, 0); mesh.rotation.set(0, 0, 0); mesh.scale.set(1, 1, 1);
  mesh.updateMatrix();
  return mesh;
}

/**
 * opts: { style: 'coupe'|'sedan'|'hatch'|'suv', paint: [r,g,b] (linear), stripe: bool, lite: bool (fewer slices,
 *         no aero parts, adds turn indicators) }
 */
window.buildCarBody = function (opts = {}) {
  const style = STYLES[opts.style || 'coupe'];
  SHAPE = style.shape || DEFAULT_SHAPE;
  const gt = opts.style === 'gt';
  const roofLine = roofOf(style), cabinLoop = cabinLoopFor(roofLine);
  const ROOF_START = style.start, ROOF_END = style.end;
  const onHoodOrDeck = z => z > ROOF_END + 0.05 || z < ROOF_START - 0.02;
  const ROOF_PANEL = z => z > style.panel[0] && z < style.panel[1];
  const lite = !!opts.lite, striped = opts.stripe ?? !lite;
  const shadow = m => { m.castShadow = true; m.receiveShadow = true; return m; };
  // Clear-coated paint over a metallic base, glossy glass and trim: reflections come from the sky environment map
  const mats = {
    paint: new THREE.MeshPhysicalMaterial({ color: '#ffffff', vertexColors: true, metalness: 0.45, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.05 }),
    glass: new THREE.MeshPhysicalMaterial({ color: '#ffffff', vertexColors: true, metalness: 0.15, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 }),
    trim: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.55, metalness: 0.1 }),
    head: new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff4dc', emissiveIntensity: 3 }),
    tail: new THREE.MeshStandardMaterial({ color: '#4a0d0d', emissive: '#ff2a1a', emissiveIntensity: 0.8 }),
    chrome: new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, metalness: 1, roughness: 0.15 }),
  };
  // Panel detail from the undeformed position (so it rides along with any dent): shut lines for the doors, bonnet
  // and boot, a dark grille and lower intake, black plastic sills
  mats.paint.onBeforeCompile = sh => {
    sh.vertexShader = 'attribute vec3 rest;\nvarying vec3 vRest;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vRest = rest;');
    sh.fragmentShader = 'varying vec3 vRest;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float ax = abs(vRest.x), y = vRest.y, z = vRest.z, seam = 0.0;
      float dz = min(min(abs(z - ${(style.end - 0.05).toFixed(2)}), abs(z - ${(style.panel[0] + 0.55).toFixed(2)})), abs(z - ${(style.start + 0.35).toFixed(2)}));
      if (ax > 0.55 && y > 0.36 && y < 0.98) seam = max(seam, 1.0 - smoothstep(0.003, 0.008, dz));
      float hood = abs(z - ${(style.end + 0.12).toFixed(2)}), boot = abs(z - ${(style.start - 0.12).toFixed(2)});
      if (y > 0.7 && ax < 0.82) seam = max(seam, 1.0 - smoothstep(0.003, 0.008, min(hood, boot)));
      diffuseColor.rgb *= 1.0 - 0.8 * seam;
      if (z > 2.0 && y > 0.32 && y < 0.6 && ax < 0.62) diffuseColor.rgb = vec3(0.02) + 0.03 * step(0.5, fract(y * 40.0));   // grille
      if (y < 0.4 && ax > 0.05) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035), smoothstep(0.42, 0.36, y));            // sills, valances
      `);
  };
  mats.paint.customProgramCacheKey = () => 'paint-' + (opts.style || 'coupe');
  const COL = {
    paint: opts.paint || [0.184, 0.435, 0.659], stripe: opts.stripeColor || [0.953, 0.604, 0.173], glass: [0.05, 0.066, 0.094],
    trim: [0.086, 0.082, 0.102], metal: [0.2, 0.2, 0.21], crack: [0.62, 0.66, 0.7], chrome: [0.36, 0.35, 0.38],
  };

  const bodyZ = [];
  const NS = lite ? 28 : 46; // enough slices for smooth panels and smooth dents
  for (let i = 0; i < NS; i++) bodyZ.push((END + CAP) * Math.sin(Math.PI / 2 * (-1 + 2 * i / (NS - 1))));
  const cabZ = [];
  const NC = lite ? 9 : 16;
  for (let i = 0; i < NC; i++) cabZ.push(lerp(ROOF_START, ROOF_END, i / (NC - 1)));

  const inStripe = x => gt ? Math.abs(x) > 0.05 && Math.abs(x) < 0.19 : Math.abs(x) < 0.17; // the GT wears twin stripes
  const stripeBody = (a, b, x, z) => striped && isTop(a, b) && inStripe(x) && onHoodOrDeck(z);
  const roofFace = (a, b, x, z) => isTop(a, b) && ROOF_PANEL(z);

  const meshes = [];
  const add = (geo, mat, opts, name) => { const m = shadow(new THREE.Mesh(geo, mat)); m.name = name; meshes.push({ mesh: m, opts }); return m; };
  const parts = [];
  const box = (x, y, z, s = [1, 1, 1]) => new THREE.BoxGeometry(x, y, z, s[0], s[1], s[2]);
  // Bake a transform into a geometry so everything lives in car-local coordinates
  const placed = (geo, pos, rot) => { const m = new THREE.Mesh(geo); m.position.set(...pos); if (rot) m.rotation.set(...rot); m.updateMatrix(); return geo.clone().applyMatrix4(m.matrix); };

  if (lite) {
    // Traffic cars: as few draw calls as possible (body+roof, glass, headlights, taillight, two indicator sides)
    add(mergeIndexed([loft(bodyZ, bodyLoop, () => true), loft(cabZ, cabinLoop, roofFace)]), mats.paint, { color: COL.paint, scrape: COL.metal }, 'body');
    add(loft(cabZ, cabinLoop, (a, b, x, z) => !roofFace(a, b, x, z)), mats.glass, { color: COL.glass, crack: COL.crack, wrinkle: 0.03 }, 'glass');
    const head = add(mergeIndexed([1, -1].map(sx => placed(box(0.36, 0.09, 0.1), [sx * 0.5, 0.62, 2.07], [-0.55, sx * 0.18, 0]))), mats.head, null, 'heads');
    parts.push({ mesh: head, kind: 'light', name: 'Headlight', anchor: [0, 0.6, 2.1], limit: 0.12 });
    const tail = add(placed(box(1.2, 0.08, 0.05, [3, 1, 1]), [0, 0.72, -2.25]), mats.tail, null, 'tail');
    parts.push({ mesh: tail, kind: 'light', name: 'Taillight', anchor: [0, 0.74, -2.15], limit: 0.12 });
    const amber = () => new THREE.MeshStandardMaterial({ color: '#7a4a10', emissive: '#ffa31a', emissiveIntensity: 0 });
    const indicators = { left: amber(), right: amber() };
    for (const sx of [1, -1]) {
      add(mergeIndexed([placed(box(0.14, 0.06, 0.06), [sx * 0.66, 0.5, 2.12], [0, sx * 0.5, 0]), placed(box(0.12, 0.08, 0.05), [sx * 0.66, 0.72, -2.24])]),
        sx > 0 ? indicators.left : indicators.right, null, 'indicator');
    }
    return { meshes, parts, mats, heads: [head], tail, COL, indicators, top: style.top };
  }

  add(loft(bodyZ, bodyLoop, (a, b, x, z) => !stripeBody(a, b, x, z)), mats.paint, { color: COL.paint, scrape: COL.metal }, 'body');
  if (striped) add(loft(bodyZ, bodyLoop, stripeBody), mats.paint, { color: COL.stripe, scrape: COL.metal }, 'stripe');
  add(loft(cabZ, cabinLoop, (a, b, x, z) => !roofFace(a, b, x, z)), mats.glass, { color: COL.glass, crack: COL.crack, wrinkle: 0.03 }, 'glass');
  add(loft(cabZ, cabinLoop, (a, b, x, z) => roofFace(a, b, x, z) && (!striped || !inStripe(x))), mats.paint, { color: COL.paint, scrape: COL.metal }, 'roof');
  if (striped) add(loft(cabZ, cabinLoop, (a, b, x, z) => roofFace(a, b, x, z) && inStripe(x)), mats.paint, { color: COL.stripe, scrape: COL.metal }, 'roofStripe');

  // Bolt-on parts. Each can break off or go dark once the structure around its anchor moves too far.
  const part = (geo, mat, pos, rot, opts, brk) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(...pos); if (rot) m.rotation.set(...rot);
    bake(shadow(m));
    meshes.push({ mesh: m, opts });
    if (brk) parts.push({ mesh: m, ...brk });
    return m;
  };
  if (gt) {
    // swan-neck wing: the struts hang it from above, with end plates; a front splitter; a ribbed diffuser
    part(box(1.5, 0.04, 0.34, [3, 1, 1]), mats.trim, [0, 0.24, 2.08], null, { color: COL.trim, wrinkle: 0.02 }, { kind: 'detach', name: 'Splitter', anchor: [0, 0.3, 2.15], limit: 0.32 });
    part(box(1.84, 0.035, 0.4, [4, 1, 1]), mats.trim, [0, 1.31, -2.02], [-0.12, 0, 0], { color: COL.trim, wrinkle: 0.02 }, { kind: 'detach', name: 'Rear wing', anchor: [0, 1.0, -2.0], limit: 0.25 });
    for (const sx of [-1, 1]) {
      part(box(0.03, 0.2, 0.46), mats.trim, [sx * 0.92, 1.3, -2.02], null, { color: COL.trim, wrinkle: 0 }, { kind: 'detach', name: 'Wing endplate', anchor: [sx * 0.6, 1.0, -2.0], limit: 0.25 });
      part(box(0.035, 0.36, 0.12), mats.trim, [sx * 0.42, 1.15, -1.93], [0.35, 0, 0], { color: COL.trim, wrinkle: 0 }, { kind: 'detach', name: 'Wing mount', anchor: [sx * 0.42, 1.0, -2.0], limit: 0.25 });
    }
  } else if (opts.wing !== false) {
    part(box(1.5, 0.05, 0.32, [3, 1, 1]), mats.trim, [0, 0.3, 2.06], null, { color: COL.trim, wrinkle: 0.02 }, { kind: 'detach', name: 'Splitter', anchor: [0, 0.32, 2.15], limit: 0.32 });
    part(box(1.76, 0.05, 0.34, [3, 1, 1]), mats.trim, [0, (opts.style === 'suv' ? 1.88 : 1.19), -1.98], [-0.1, 0, 0], { color: COL.trim, wrinkle: 0.02 }, { kind: 'detach', name: 'Rear wing', anchor: [0, 1.0, -2.05], limit: 0.25 });
    for (const sx of [-0.55, 0.55]) part(box(0.05, 0.22, 0.18), mats.trim, [sx, 1.07, -1.95], null, { color: COL.trim, wrinkle: 0 }, { kind: 'detach', name: 'Wing mount', anchor: [sx, 1.0, -2.05], limit: 0.25 });
  }
  for (const sx of [-1, 1]) {
    // housing plus a short arm into the door, merged so the mirror breaks off as one piece
    const geo = mergeBoxes([box(0.2, 0.11, 0.07).translate(sx * 0.1, 0.02, 0), box(0.12, 0.03, 0.04).translate(sx * -0.02, -0.03, 0.01)]);
    part(geo, mats.paint, [sx * 0.9, 1.0, 0.74], [0, sx * 0.2, 0], { color: COL.paint, scrape: COL.metal, wrinkle: 0 }, { kind: 'detach', name: 'Mirror', anchor: [sx * 0.9, 0.95, 0.7], limit: 0.14 });
  }
  const heads = [];
  let tail;
  if (gt) {
    // round headlights set into the tops of the wings, a full-width light bar across the tail, twin central exhausts
    for (const sx of [1, -1]) {
      heads.push(part(new THREE.SphereGeometry(1, 20, 12).scale(0.15, 0.1, 0.13), mats.head.clone(), [sx * 0.62, 0.74, 1.84], [-0.35, sx * 0.25, 0], null,
        { kind: 'light', name: 'Headlight', anchor: [sx * 0.62, 0.72, 1.9], limit: 0.1, side: sx }));
    }
    tail = part(box(1.78, 0.03, 0.03, [6, 1, 1]), mats.tail, [0, 0.9, -2.235], null, null, { kind: 'light', name: 'Taillight', anchor: [0, 0.86, -2.15], limit: 0.12 });
    for (const sx of [-1, 1]) part(box(0.36, 0.05, 0.04), mats.tail, [sx * 0.72, 0.86, -2.2], [0, sx * 0.25, 0], null, null);
    for (const sx of [-0.09, 0.09]) part(new THREE.CylinderGeometry(0.055, 0.055, 0.2, 16, 1, true).rotateX(Math.PI / 2), mats.chrome, [sx, 0.4, -2.22], null, { color: COL.chrome, wrinkle: 0 },
      { kind: 'detach', name: 'Exhaust tip', anchor: [sx, 0.42, -2.1], limit: 0.3 });
  } else {
    for (const sx of [1, -1]) {
      heads.push(part(box(0.36, 0.09, 0.1), mats.head.clone(), [sx * 0.5, 0.62, 2.07], [-0.55, sx * 0.18, 0], null,
        { kind: 'light', name: 'Headlight', anchor: [sx * 0.5, 0.6, 2.1], limit: 0.1, side: sx }));
    }
    tail = part(box(1.2, 0.08, 0.05, [3, 1, 1]), mats.tail, [0, 0.72, -2.25], null, null,
      { kind: 'light', name: 'Taillight', anchor: [0, 0.74, -2.15], limit: 0.12 });
    part(new THREE.CylinderGeometry(0.06, 0.06, 0.22, 6).rotateX(Math.PI / 2), mats.chrome, [0.5, 0.36, -2.2], null, { color: COL.chrome, wrinkle: 0 },
      { kind: 'detach', name: 'Exhaust tip', anchor: [0.5, 0.4, -2.1], limit: 0.3 });
  }
  const indicators = null;

  return { meshes, parts, mats, heads, tail, COL, indicators, top: style.top };
};
})();
