async function boot() {
'use strict';
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
// Summer in Ashby Valley by default. Add ?winter to the address for the snowed-in valley: snow on the ground, roofs
// and trees, an overcast sky, snow falling, the river and ponds frozen over
const WINTER = new URLSearchParams(location.search).has('winter');
let seed = 1337;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

/* ---------------- Renderer & scene ---------------- */
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// Resolution adapts to keep the frame rate up (see the loop); start at up to 1.5x on high-DPI screens
let pixelRatio = Math.min(devicePixelRatio, 1.25);
renderer.setPixelRatio(pixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = WINTER ? 1.02 : 0.95;

// A sunny afternoon, lit by a real sky: a photographed HDR panorama (Poly Haven, CC0) is the visible sky, the
// prefiltered environment for ambient light and reflections, and the source of the sun's direction and colour
const scene = new THREE.Scene();
const HAZE = new THREE.Color('#c9b9a4');
scene.fog = new THREE.FogExp2(HAZE.clone(), WINTER ? 0.00055 : 0.00018); // winter air: thicker, colder haze
const camera = new THREE.PerspectiveCamera(60, 1, 0.3, 7000);

const SKY = await loadHDR('assets/sky/sky_4k.hdr');
// the car model (glTF); if it can't be loaded the procedural bodies are used instead
// the car models (glTF), listed in assets/cars/cars.json; any that fail to load are skipped, and with none at all
// the procedural bodies are used instead
const CARMODELS = [];
const catalog = await fetch('assets/cars/cars.json').then(r => r.json());
const pendingModels = new Map();
async function ensureModel(id) {
  if (CARMODELS.some(m => m.id === id)) return true;
  if (pendingModels.has(id)) return pendingModels.get(id);
  const entry = catalog.find(c => c.id === id);
  const promise = loadCarModel('assets/cars/' + entry.file, entry).then(m => { CARMODELS.push(m); return true; }).catch(e => { console.warn('Car model unavailable:', id, e); return false; }).finally(() => pendingModels.delete(id));
  pendingModels.set(id, promise); return promise;
}
await Promise.all(catalog.slice(0, 6).map(c => ensureModel(c.id)));
let storage; try { storage = localStorage; } catch(e) {}
const career = createCareer(catalog, storage);
let missions = null, empire = null, crime = null, street = null, selectingCar = false, collisionTotal = 0, rideOwned = true, downing = false;
// if the photo's sun sits very low, lift it a few degrees for gameplay so streets aren't all in shadow
const sunDir = SKY.sunDir.clone();
{ const el = Math.asin(sunDir.y), lift = Math.max(el, 0.2), hz = Math.cos(lift) / Math.hypot(sunDir.x, sunDir.z); sunDir.set(sunDir.x * hz, Math.sin(lift), sunDir.z * hz).normalize(); }

const SKY_GAIN = SKY.gain; // same normalisation as the environment
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { sky: { value: SKY.skyTex }, gain: { value: SKY_GAIN }, haze: { value: scene.fog.color }, winter: { value: WINTER ? 0.85 : 0 }, night: { value: 0 }, dusk: { value: 0 }, starK: { value: 5 } },
  vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
  fragmentShader: `
    varying vec3 vDir; uniform sampler2D sky; uniform float gain; uniform vec3 haze; uniform float winter; uniform float night; uniform float dusk; uniform float starK;
    vec3 rgbe(vec4 t){ float e = t.a * 255.0; return e < 1.0 ? vec3(0.0) : t.rgb * 255.0 * exp2(e - 136.0); }
    void main(){
      vec3 d = normalize(vDir);
      vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
      vec3 c = rgbe(texture2D(sky, uv)) * gain;
      // winter: a pale, overcast sky (the photo's blue drained to a cold grey-white, the clouds kept)
      float l = dot(c, vec3(0.3, 0.59, 0.11));
      c = mix(c, vec3(l) * vec3(0.93, 0.97, 1.04) * 1.08 + vec3(0.05, 0.055, 0.065), winter);
      // dusk and dawn: the low sky goes amber; night: the sky sinks to deep blue and the stars come out
      c *= mix(vec3(1.0), vec3(1.5, 0.92, 0.6), dusk * smoothstep(0.55, 0.0, d.y));
      c = mix(c, vec3(dot(c, vec3(0.3, 0.59, 0.11))) * vec3(0.42, 0.6, 1.0) * 0.3, night * 0.9);
      if (night > 0.02 && d.y > 0.0) {
        vec3 sq = floor(d * 520.0); float sh = fract(sin(dot(sq, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        c += vec3(0.92, 0.95, 1.0) * step(0.9988, sh) * (0.4 + 0.6 * fract(sh * 91.7)) * night * starK * smoothstep(0.0, 0.2, d.y);
      }
      c = mix(c, haze, smoothstep(0.03, -0.04, d.y) + winter * 0.25 * smoothstep(0.35, 0.0, d.y)); // the haze the land fades into
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }`
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), skyMat);
sky.frustumCulled = false; sky.renderOrder = -1; sky.scale.setScalar(6500);
scene.add(sky);
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(SKY.envTex).texture;
  pmrem.dispose();
}
// haze takes the colour of the sky's horizon in whichever direction you look (warm towards the sun)
const hazeAt = h => { // h: camera yaw
  const u = ((Math.atan2(Math.cos(h), Math.sin(h)) / (Math.PI * 2) + 0.5) % 1 + 1) % 1, f = u * 64, i = Math.floor(f) % 64, j = (i + 1) % 64, t = f - Math.floor(f);
  const H = SKY.horizon, c = [0, 1, 2].map(k => (H[i * 3 + k] * (1 - t) + H[j * 3 + k] * t) * 0.92);
  if (!WINTER) return c;
  const l = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11; // cold, pale, nearly colourless
  return [0.82, 0.86, 0.9].map((w, k) => (l * 0.35 + 0.65 * w) * 0.75 + c[k] * 0.1);
};

const hemi = WINTER ? new THREE.HemisphereLight('#dbe5ee', '#e6ecf0', 0.42) : new THREE.HemisphereLight('#c9d4e0', '#6b5a42', 0.12);
scene.add(hemi); // snow bounces light back up
const sun = new THREE.DirectionalLight(WINTER ? new THREE.Color('#e9eef6') : new THREE.Color().setRGB(...SKY.sunColor.map(v => 0.6 + 0.4 * Math.sqrt(v))).lerp(new THREE.Color(1, 0.93, 0.82), 0.4), WINTER ? 1.55 : 2.6); // winter: a weak, cold sun through cloud
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -95, right: 95, top: 95, bottom: -95, near: 1, far: 600 });
sun.shadow.bias = -0.00008;
sun.shadow.normalBias = 0.025;
sun.shadow.radius = 2.5;
scene.add(sun, sun.target);
// Snap in the light's own image plane, using the active quality preset's texel size.
const shadowRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize();
const shadowUp = new THREE.Vector3().crossVectors(sunDir, shadowRight).normalize();
const shadowFocus = new THREE.Vector3();

function shadowed(m) { m.castShadow = true; m.receiveShadow = true; return m; }
const solids = []; // {type: 'circle', x, z, r, h, y0?, mu} | {type: 'box', x, z, hx, hz, h, y0?, ux, uz, mu}

/* ---------------- World ---------------- */
const city = buildWorld({ scene, solids, rand, winter: WINTER });
console.log('world', city.stats);
const grass = createGrass({ scene, city, camera, sunDir });
// Spatial hash for static obstacles (16 m cells)
const GRID = 16, solidGrid = new Map();
const cellKey = (i, j) => (i + 4096) * 8192 + (j + 4096);
for (const o of solids) {
  const r = o.type === 'box' ? Math.hypot(o.hx, o.hz) : o.r;
  for (let i = Math.floor((o.x - r) / GRID); i <= Math.floor((o.x + r) / GRID); i++)
    for (let j = Math.floor((o.z - r) / GRID); j <= Math.floor((o.z + r) / GRID); j++) {
      const k = cellKey(i, j);
      if (!solidGrid.has(k)) solidGrid.set(k, []);
      solidGrid.get(k).push(o);
    }
}
function addSolid(o) { // for tests and tools: register an obstacle after boot
  solids.push(o);
  const r = o.type === 'box' ? Math.hypot(o.hx, o.hz) : o.r;
  for (let i = Math.floor((o.x - r) / GRID); i <= Math.floor((o.x + r) / GRID); i++)
    for (let j = Math.floor((o.z - r) / GRID); j <= Math.floor((o.z + r) / GRID); j++) {
      const k = cellKey(i, j); if (!solidGrid.has(k)) solidGrid.set(k, []); solidGrid.get(k).push(o);
    }
}
let queryId = 0;
function nearSolids(x, z, r, out) {
  out.length = 0; queryId++;
  if (!Number.isFinite(x) || !Number.isFinite(z) || !(r < 1e4)) return out; // a bad position must never mean an endless scan
  for (let i = Math.floor((x - r) / GRID); i <= Math.floor((x + r) / GRID); i++)
    for (let j = Math.floor((z - r) / GRID); j <= Math.floor((z + r) / GRID); j++) {
      const list = solidGrid.get(cellKey(i, j));
      if (list) for (const o of list) if (o._q !== queryId && !o.off) { o._q = queryId; out.push(o); }
    }
  return out;
}

/* ---------------- Cars you can drive ---------------- */
// Torque curves share one shape, scaled to each engine's peak torque and rev range
const TORQUE_SHAPE = [[0, 0.42], [0.13, 0.54], [0.33, 0.78], [0.53, 0.94], [0.68, 1], [0.86, 0.93], [1, 0.8], [1.18, 0.47]];
const BASE_PRESETS = [
  { name: 'Apex GT', model: 'gt', kind: 'Rear-drive GT', blurb: 'Low, wide, winged. Balanced and playful; steps out if you ask.', style: 'gt', paint: [0.018, 0.16, 0.28], paint2: [0.75, 0.75, 0.74], stripe: true, stripeColor: [0.82, 0.82, 0.8], wing: true,
    drive: 'rwd', mass: 1250, inertia: 1850, cg: 0.5, peak: 425, redline: 7600, idle: 900, gears: [3.45, 2.35, 1.72, 1.33, 1.07, 0.86], diff: 3.9, grip: 1.08, brake: 13000, drag: 0.43, steer: 0.6, assist: 0.4 },
  { name: 'Commuter', model: 'sedan', kind: 'Front-drive sedan', blurb: 'Soft, safe, understeers when pushed.', style: 'sedan', paint: [0.66, 0.67, 0.68], stripe: false, wing: false,
    drive: 'fwd', mass: 1400, inertia: 2150, cg: 0.53, peak: 260, redline: 6500, idle: 800, gears: [3.6, 2.1, 1.4, 1.03, 0.8, 0.66], diff: 3.8, grip: 1.0, brake: 12000, drag: 0.36, steer: 0.62, assist: 0.65 },
  { name: 'Hot Hatch', model: 'hatchback', kind: 'Front-drive hatchback', blurb: 'Light, eager, lifts a rear wheel in corners.', style: 'hatch', paint: [0.62, 0.06, 0.05], stripe: true, wing: false,
    drive: 'fwd', mass: 1290, inertia: 1750, cg: 0.5, peak: 380, redline: 7000, idle: 850, gears: [3.4, 2.2, 1.6, 1.25, 1.0, 0.82], diff: 4.1, grip: 1.12, brake: 13500, drag: 0.4, steer: 0.62, assist: 0.55 },
  { name: 'Summit', model: 'suv', kind: 'All-wheel-drive SUV', blurb: 'Heavy and tall. Grips everywhere, leans a lot.', style: 'suv', paint: [0.16, 0.24, 0.18], stripe: false, wing: false,
    drive: 'awd', mass: 1950, inertia: 3200, cg: 0.7, peak: 540, redline: 6200, idle: 750, gears: [3.8, 2.3, 1.55, 1.15, 0.9, 0.72], diff: 3.7, grip: 1.0, brake: 15000, drag: 0.5, steer: 0.58, wheel: 0.36, assist: 0.65 },
  { name: 'Torque V8', model: 'coupe', kind: 'Rear-drive muscle', blurb: 'Huge low-down shove. Smoke on demand.', style: 'coupe', paint: [0.55, 0.16, 0.025], stripe: true, wing: false,
    drive: 'rwd', mass: 1720, inertia: 2600, cg: 0.52, peak: 680, redline: 6400, idle: 700, gears: [2.9, 1.95, 1.45, 1.12, 0.9, 0.72], diff: 3.6, grip: 1.05, brake: 15000, drag: 0.44, steer: 0.58, assist: 0.32 },
  { name: 'Vortex', model: 'supercar', kind: 'All-wheel-drive supercar', blurb: 'Brutal launch, huge grip, 300+ km/h.', style: 'coupe', paint: [0.9, 0.22, 0.025], stripe: true, wing: true,
    drive: 'awd', mass: 1480, inertia: 2000, cg: 0.45, peak: 760, redline: 8600, idle: 1000, gears: [3.3, 2.35, 1.8, 1.42, 1.15, 0.94], diff: 3.6, grip: 1.25, brake: 17000, drag: 0.36, steer: 0.6, assist: 0.55 },
];
const PRESETS = catalog.map(c => {
  const base = BASE_PRESETS.find(p => p.model === c.base);
  return {...base, ...c, model:c.id, blurb:c.description, mass:Math.round(base.mass*c.massScale), inertia:base.inertia*c.massScale,
    peak:Math.round(base.peak*c.power), grip:base.grip*(c.id==='rally'?1.08:1), drive:c.id==='rally'?'awd':base.drive};
});
const SPLIT = { rwd: [0, 1], fwd: [1, 0], awd: [0.42, 0.58] };
// How good a car is, GTA-style: top speed, acceleration, braking and traction as 0..1 bars, each relative to the
// whole garage (so the slowest car isn't empty and the fastest fills the bar)
const STATS = (() => {
  const raw = PRESETS.map(pr => {
    const pw = pr.peak * pr.redline * 0.8 * TAU / 60;
    return { id: pr.id, top: Math.cbrt(pw / pr.drag), acc: pw / pr.mass * (pr.drive === 'awd' ? 1.1 : 1), brk: pr.brake / pr.mass, trc: pr.grip * (pr.drive === 'awd' ? 1.1 : 1) };
  });
  const out = {};
  for (const k of ['top', 'acc', 'brk', 'trc']) {
    const v = raw.map(r => r[k]), lo = Math.min(...v), hi = Math.max(...v);
    for (const r of raw) (out[r.id] ||= {})[k] = 0.15 + 0.85 * (r[k] - lo) / (hi - lo || 1);
  }
  for (const r of raw) out[r.id].kmh = Math.round(r.top * 3.6 * 0.62 / 5) * 5; // a rough top speed for the label
  return out;
})();
const statBars = id => { const S = STATS[id]; if (!S) return ''; return `<div class="stats">${[['Top speed', S.top], ['Acceleration', S.acc], ['Braking', S.brk], ['Traction', S.trc]].map(([n, v]) => `<span>${n}</span><i><b style="width:${Math.round(v * 100)}%"></b></i>`).join('')}</div>`; };
function physicsOf(pr) {
  return {
    mass: pr.mass, inertia: pr.inertia, a: 1.25, b: 1.35, h: pr.cg, R: pr.wheel || 0.33,
    maxSteer: pr.steer, assist: Math.max(0.82, pr.assist ?? 0.5), rollFront: pr.rollFront ?? (pr.drive === 'fwd' ? 0.6 : pr.drive === 'rwd' ? 0.5 : 0.55), brake: pr.brake, handbrake: 7000, drag: pr.drag, roll: 14, grip: pr.grip * 1.08,
    gears: [-3.3, 0, ...pr.gears], diff: pr.diff, eff: 0.88, idle: pr.idle, redline: pr.redline, shiftUp: pr.redline - 500,
    front: SPLIT[pr.drive][0], rear: SPLIT[pr.drive][1],
  };
}
// How common each car is on the street: runabouts everywhere, supercars once in a blue moon
const rarity = pr => { const v = pr.price || 0; return v <= 15000 ? 6 : v <= 30000 ? 3 : v <= 60000 ? 1.2 : v <= 100000 ? 0.35 : 0.12; };
function pickPreset(list = PRESETS, r = Math.random) {
  let sum = 0; for (const pr of list) sum += rarity(pr);
  let x = r() * sum; for (const pr of list) { x -= rarity(pr); if (x <= 0) return pr; }
  return list[list.length - 1];
}
let P = physicsOf(PRESETS[0]), L = P.a + P.b, TORQUE = [];
function torqueAt(rpm) {
  for (let i = 1; i < TORQUE.length; i++) if (rpm <= TORQUE[i][0]) {
    const [r0, t0] = TORQUE[i - 1], [r1, t1] = TORQUE[i];
    return lerp(t0, t1, (rpm - r0) / (r1 - r0));
  }
  return TORQUE[TORQUE.length - 1][1];
}

const carGroup = new THREE.Group();
carGroup.rotation.order = 'YXZ'; // heading, then pitch and roll in the car's own frame
const body = new THREE.Group(); carGroup.add(body);
scene.add(carGroup);

/* ---------------- Soft-body structure ---------------- */
// Lattice: 5 across x 4 high x 10 long. The bottom-middle nodes under the cabin are the rigid chassis.
// Beams through the passenger cell are ~3x stronger than the crumple zones; floor rails are stiffer still.
const softConfig = (top, halfW = 0.9, length = 4.44) => ({
  min: [-halfW, 0.2, -length / 2], max: [halfW, top, length / 2], dims: [5, 4, 10],
  nodeMass: 4, axial: 2.6e5, yieldForce: 18000, minRatio: 0.3, tearStrain: 0.6, nodeRadius: 0.07, iterations: 3, ...(window.TUNE || {}),
  pinned: (i, j, k) => j === 0 && i >= 1 && i <= 3 && k >= 3 && k <= 6,
  // [min z, max z, min |x|]: the engine bay and boot fold up against the cell, doors stop at the seats
  bounds: (x, y, z) => [
    z > 0.9 ? 0.9 + (z - 0.9) * 0.12 : -1e9,
    z < -1.0 ? -1.0 + (z + 1.0) * 0.12 : 1e9,
    Math.abs(x) > 0.5 ? 0.5 + (Math.abs(x) - 0.5) * 0.15 : 0,
  ],
  strength: (ax, ay, az, bx, by, bz) => {
    const x = (ax + bx) / 2, y = (ay + by) / 2, z = (az + bz) / 2;
    const ex = Math.abs(bx - ax), lateral = ex > 0.5 * Math.hypot(ex, by - ay, bz - az);
    const door = lateral && Math.max(Math.abs(ax), Math.abs(bx)) > 0.7;
    const T = window.TUNE || {};
    let s = 1;
    if (z > -1.05 && z < 0.95) s *= door ? (T.door ?? 2) : 3.2; // passenger cell: pillars and sills strong, door skins less so
    if (y < 0.6 && Math.abs(x) < 0.5) s *= 1.7;    // frame rails
    if (y > 1.0 && (z > 0.95 || z < -1.05)) s *= 0.6; // nothing above the hood or boot but air and sheet metal
    if (lateral && y < 0.9 && (z > 1.7 || z < -1.75)) s *= T.bumper ?? 4; // bumper beams spread a point load across both rails
    return s;
  },
});
let soft, kit, tailMat, bindingOf, bindings, W = {}, preset = PRESETS[0];
const headSpot = new THREE.SpotLight('#ffe9c8', 4, 40, 0.45, 0.5, 1.6); // daytime: just a hint on the tarmac
headSpot.position.set(0, 0.7, 2.0); headSpot.target.position.set(0, 0, 14);
body.add(headSpot, headSpot.target);
const tailGlow = new THREE.PointLight('#ff3020', 0, 6, 2); tailGlow.position.set(0, 0.8, -2.6); body.add(tailGlow);

// Wheels
// Wheels: a tyre with rounded shoulders and tread grooves (lathe), a five-spoke alloy, a brake disc and calliper
const tyreTex = (() => {
  const c = document.createElement('canvas'); c.width = 256; c.height = 32;
  const g = c.getContext('2d'); g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, 256, 32);
  g.fillStyle = '#5a5a5a'; for (let i = 0; i < 256; i += 8) { g.fillRect(i, 0, 3, 32); }
  for (const y of [7, 16, 25]) g.fillRect(0, y, 256, 2);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
})();
const tyreMat = new THREE.MeshStandardMaterial({ color: '#1b1b1e', roughness: 0.92, map: tyreTex });
const rimMat = new THREE.MeshStandardMaterial({ color: '#c8c8cc', metalness: 1, roughness: 0.22 });
const discMat = new THREE.MeshStandardMaterial({ color: '#77777c', metalness: 0.8, roughness: 0.45 });
const caliperMat = new THREE.MeshStandardMaterial({ color: '#b3261e', roughness: 0.4, metalness: 0.2 });
function tyreGeo(R, W) {
  const r0 = R * 0.68, pts = [];
  for (let k = 0; k <= 8; k++) { const a = -Math.PI / 2 + Math.PI * k / 8; pts.push(new THREE.Vector2(R - 0.035 + Math.cos(a) * 0.035, Math.sin(a) * (W / 2 - 0.02) * (k === 0 || k === 8 ? 1 : 1.0))); }
  pts.unshift(new THREE.Vector2(r0, -W / 2 + 0.01)); pts.push(new THREE.Vector2(r0, W / 2 - 0.01));
  const g = new THREE.LatheGeometry(pts, 32).rotateZ(Math.PI / 2);
  const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 6, uv.getY(i)); // tread repeats round the tyre
  return g;
}
function rimGeo(R) {
  const parts = [new THREE.CylinderGeometry(R * 0.66, R * 0.66, 0.2, 32, 1, true).rotateZ(Math.PI / 2), // barrel
    new THREE.CylinderGeometry(0.06, 0.07, 0.06, 16).rotateZ(Math.PI / 2).translate(0.1, 0, 0)];      // hub
  for (let k = 0; k < 5; k++) { const sp = new THREE.BoxGeometry(0.04, R * 0.56, 0.055).translate(0.11, R * 0.32, 0); sp.rotateX(k / 5 * Math.PI * 2); parts.push(sp); }
  const pos = [], nrm = [];
  for (const p of parts) { const n = p.index ? p.toNonIndexed() : p; pos.push(...n.attributes.position.array); nrm.push(...n.attributes.normal.array); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); return g;
}
function makeWheel(x, z) {
  const side = Math.sign(x);
  const steer = new THREE.Group(); steer.position.set(x, P.R, z);
  const spin = new THREE.Group(); steer.add(spin);
  spin.add(shadowed(new THREE.Mesh(tyreGeo(P.R, 0.27), tyreMat)));
  const rim = new THREE.Mesh(rimGeo(P.R), rimMat); rim.scale.x = side; spin.add(rim);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(P.R * 0.58, P.R * 0.58, 0.03, 24).rotateZ(Math.PI / 2), discMat); disc.position.x = -side * 0.02; spin.add(disc);
  const cal = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.1), caliperMat); cal.position.set(side * 0.03, P.R * 0.4, z > 0 ? -0.08 : 0.08); steer.add(cal); // doesn't turn with the wheel
  carGroup.add(steer);
  return { steer, spin, x, z, side };
}
// Build (or rebuild) the player's car from a preset: body, crash structure, wheels and physics
function buildPlayer(pr) {
  preset = pr;
  for (const m of [...body.children]) if (m !== headSpot && m !== headSpot.target && m !== tailGlow) { body.remove(m); if (m.geometry) m.geometry.dispose(); }
  for (const w of Object.values(W)) carGroup.remove(w.steer);
  if (typeof flying !== 'undefined') { for (const f of flying) scene.remove(f.m); flying.length = 0; }
  P = physicsOf(pr); L = P.a + P.b;
  TORQUE = TORQUE_SHAPE.map(([r, t]) => [r * pr.redline, t * pr.peak]);
  const model = CARMODELS.find(m => m.id === pr.model) || null;
  kit = model ? buildModelCar(model, { paint: pr.paint, paint2: pr.paint2, ownGeometry: true })
    : buildCarBody({ style: pr.style, paint: pr.paint, stripe: pr.stripe, stripeColor: pr.stripeColor, wing: pr.wing });
  if (model && model.wheels) P.R = model.wheels.reduce((sum, w) => sum + w.radius, 0) / 4;
  if (kit.axles) { P.a = kit.axles.front; P.b = -kit.axles.rear; L = P.a + P.b; } // the model's own wheelbase
  soft = new SoftBody(softConfig(kit.top, kit.bodyHalfW, kit.length));
  tailMat = kit.mats.tail; bindingOf = new Map();
  bindings = kit.meshes.map(({ mesh, opts }) => { body.add(mesh); const bd = soft.bind(mesh.geometry, opts || { wrinkle: 0 }); bindingOf.set(mesh, bd); return bd; });
  if (kit.model && kit.makeWheel) {
    // the model's own wheels (tyre, rim, disc spin; the calliper stays put), at its own axle positions
    const mk = (i, side) => {
      const w = kit.makeWheel(i), steer = new THREE.Group(); steer.position.copy(w.center);
      steer.add(w.spin, w.fixed); carGroup.add(steer);
      return { steer, spin: w.spin, x: w.center.x, z: w.center.z, y: w.center.y, side };
    };
    W = { fl: mk(0, 1), fr: mk(1, -1), rl: mk(2, 1), rr: mk(3, -1) };
  } else W = { fl: makeWheel(0.82, P.a), fr: makeWheel(-0.82, P.a), rl: makeWheel(0.82, -P.b), rr: makeWheel(-0.82, -P.b) };
  car.m = P.mass; car.I = P.inertia;
}

/* ---------------- Car state & physics ---------------- */
const car = {};
function resetCar(pose = city.start) {
  Object.assign(car, {
    x: pose.x, z: pose.z, h: pose.h, y: pose.y ?? city.heightAt(pose.x, pose.z), vy: 0, air: false, slope: 0, bank: 0, vx: 0, vz: 0, w: 0,
    steer: 0, ax: 0, ay: 0, gear: 2, auto: true, shiftT: 0, rpm: P.idle,
    throttle: 0, brake: 0, hb: 0, spin: 0, skidR: 0, skidF: 0, frontRot: 0, rearRot: 0,
    pitch: 0, pitchV: 0, rollA: 0, rollV: 0, power: 0, slipDeg: 0, onSand: false, limiter: false,
    px: pose.x, pz: pose.z, ph: pose.h, m: P.mass, I: P.inertia, surface: 'asphalt', onFoot: false, armed: false
  });
}

const sat = a => Math.sin(1.65 * Math.atan(9 * a)); // Pacejka-ish tyre curve

// Damage that feeds back into the driving model (updated from the lattice once per frame)
const harm = { toe: 0, frontGrip: 1, rearGrip: 1, drag: 0, engine: 0, power: 1, bullet: 0, tyres: 1 };

function stepCar(dt, inp) {
  // if a crash solve ever blows up (NaN or infinity), put the car back where it last was, at rest
  if (![car.x, car.z, car.y, car.vx, car.vz, car.w, car.h].every(Number.isFinite)) { Object.assign(car, { x: car.px, z: car.pz, h: car.ph, vx: 0, vz: 0, w: 0, vy: 0 }); if (!Number.isFinite(car.y)) car.y = city.heightAt(car.x, car.z); }
  car.px = car.x; car.pz = car.z; car.ph = car.h;
  const s = Math.sin(car.h), c = Math.cos(car.h);
  { const v = Math.hypot(car.vx, car.vz); if (v > 120) { car.vx *= 120 / v; car.vz *= 120 / v; } if (Math.abs(car.w) > 12) car.w = Math.sign(car.w) * 12; } // no car goes 430 km/h or spins 2 turns a second

  const fx = s, fz = c, sx = c, sz = -s; // forward and side (local +x) unit vectors
  let vLong = car.vx * fx + car.vz * fz;
  let vLat = car.vx * sx + car.vz * sz;
  const speed = Math.hypot(car.vx, car.vz);
  car.surface = city.surfaceAt(car.x, car.z, car.y);
  const ice = car.surface === 'ice';
  car.onSand = car.surface !== 'asphalt' && !ice;
  const wet = car.surface === 'water';
  const mu = car.surface === 'asphalt' ? P.grip * (1 - 0.2 * weather.wet) : ice ? 0.3 * P.grip : (wet ? 0.35 : 0.72) * P.grip / 1.08; // frozen river and ponds: slick
  const gnd = car.air ? 0 : 1; // no tyre forces in the air

  // Gear selection
  const inR = car.gear === 0;
  if (car.auto) {
    if (!inR && inp.brake > 0.1 && inp.gas < 0.1 && vLong < 0.4) car.gear = 0;
    else if (inR && inp.gas > 0.1 && vLong > -0.4) car.gear = 2;
  }
  const reverse = car.gear === 0;
  const gasIn = (reverse && car.auto ? inp.brake : inp.gas) * (reverse ? 0.55 : 1);
  const brakeIn = reverse && car.auto ? inp.gas : inp.brake;
  car.throttle = lerp(car.throttle, gasIn, Math.min(1, dt * 22));
  car.brake = brakeIn; car.hb = inp.hb;

  // Steering: a speed-sensitive rack. The lock shrinks with speed to roughly what the front tyres can use
  // (the angle for a limit-g turn plus peak slip), the wheels turn at a finite rate, and with hands off they
  // castor towards the direction of travel, which catches slides the way a real car does.
  const useful = Math.atan(L * mu * 9.81 / Math.max(speed * speed, 1)) * 1.2 + 0.12;
  const align = speed > 3 && vLong > 0 ? Math.atan2(vLat + car.w * P.a, vLong) : 0;
  let lock = Math.min(P.maxSteer, useful);
  // steering into a slide (counter-steer) always gets enough lock to catch it
  const counter = Math.abs(align) > 0.08 && Math.sign(inp.steer) === Math.sign(align);
  if (counter) lock = Math.max(lock, Math.min(P.maxSteer, Math.abs(align) + 0.18));
  const steerTarget = clamp(inp.steer * lock + align * 0.6 * (1 - 0.5 * Math.abs(inp.steer)), -P.maxSteer, P.maxSteer);
  const rate = lerp(4.6, 2.4, clamp(speed / 40, 0, 1));
  car.steer += clamp(steerTarget - car.steer, -rate * dt, rate * dt);

  // Engine & driveline
  car.shiftT = Math.max(0, car.shiftT - dt);
  const ratio = P.gears[car.gear] * P.diff;
  const wheelSurf = vLong + car.spin * 9 * Math.sign(ratio || 1);
  const rpmWheel = Math.abs(wheelSurf / P.R * ratio) * 60 / TAU;
  let target;
  if (car.gear === 1 || car.shiftT > 0) target = car.gear === 1 ? P.idle + car.throttle * (P.redline - P.idle) : rpmWheel;
  else target = Math.max(rpmWheel, P.idle + car.throttle * 2400 * (rpmWheel < 2600 ? 1 : 0)); // clutch slip at launch
  car.rpm = clamp(lerp(car.rpm, target, Math.min(1, dt * 14)), P.idle * 0.85, P.redline + 150);
  car.limiter = car.rpm >= P.redline;
  let torque = car.limiter || car.shiftT > 0 ? 0 : torqueAt(car.rpm) * car.throttle * harm.power * (1 - harm.bullet);
  if (car.throttle < 0.05 && car.gear !== 1 && rpmWheel > P.idle) torque = -30 - car.rpm * 0.012; // engine braking
  let drive = torque * ratio * P.eff / P.R;
  if (car.spin > 0.35 && !(car.hbT > 0) && speed < 18 && drive > 0) drive *= 0.72; // traction control on launch
  car.power = Math.max(0, torque) * car.rpm * TAU / 60 / 1000;

  // Automatic shifts
  if (car.auto && car.gear >= 2 && car.shiftT <= 0) {
    if (car.rpm > P.shiftUp && car.gear < 7) { car.gear++; car.shiftT = 0.22; }
    else if (car.gear > 2 && car.rpm < 3000) {
      const lower = Math.abs(vLong / P.R * P.gears[car.gear - 1] * P.diff) * 60 / TAU;
      if (lower < 6200) { car.gear--; car.shiftT = 0.18; }
    }
  }

  // ---- Four-wheel tyre model ----
  // Loads: static split by axle, plus longitudinal transfer (braking/accelerating) and lateral transfer (cornering)
  // shared front/rear by roll stiffness; a little downforce at speed. Tyres lose efficiency as load rises (load
  // sensitivity), which is what makes body roll cost grip and gives each car its balance.
  const Wt = P.mass * 9.81, TRACK = 1.62, RS_F = P.rollFront;
  const aero = 1 + 0.00014 * speed * speed;
  const dLong = P.mass * car.ax * P.h / L, dLat = P.mass * car.ay * P.h / TRACK;
  const axleF = (Wt * P.b / L - dLong) * aero, axleR = (Wt * P.a / L + dLong) * aero;
  // wheel order: FL, FR, RL, RR; x = +0.81 is the car's left
  const WX = [0.81, -0.81, 0.81, -0.81], WZ = [P.a, P.a, -P.b, -P.b];
  const Fz = [axleF / 2 - dLat * RS_F / 2, axleF / 2 + dLat * RS_F / 2, axleR / 2 - dLat * (1 - RS_F) / 2, axleR / 2 + dLat * (1 - RS_F) / 2]
    .map(f => Math.max(f, 0.03 * Wt));
  const Fz0 = Wt / 4;
  car.loads = Fz;

  const lowK = clamp(speed / 2, 0, 1); // fades tyre lateral forces in near standstill
  // Brakes (smoothed sign so the car doesn't chatter at rest), split 64/36 front/rear, handbrake on the rears
  const brakeDir = -clamp(vLong * 4, -1, 1);
  const Fbrake = brakeDir * car.brake * P.brake;
  const Fhb = -clamp(vLong * 3, -1, 1) * car.hb * P.handbrake;
  const d = car.steer + harm.toe;
  const cd = Math.cos(d), sd = Math.sin(d);
  car.alpha = car.alpha || [0, 0, 0, 0];
  let Flong = 0, Flat = 0, torqueZ = 0, lockF = 0, spinF = 0, spinR = 0, vwy = 0, vLatR = 0, FlatF = 0;
  for (let i = 0; i < 4; i++) {
    const front = i < 2, x = WX[i], z = WZ[i];
    // velocity of this contact patch in the car frame, then in the wheel frame (fronts are steered)
    const vlx = vLat + car.w * z, vlz = vLong - car.w * x;
    const c_ = front ? cd : 1, s_ = front ? sd : 0;
    const wx = vlz * c_ + vlx * s_, wy = -vlz * s_ + vlx * c_;
    if (front) vwy += wy / 2; else vLatR += wy / 2;
    // tyre relaxation: the slip angle builds over ~0.35 m of rolling rather than instantly
    const aT = Math.atan2(wy, Math.max(Math.abs(wx), 1.0));
    car.alpha[i] += (aT - car.alpha[i]) * Math.min(1, (Math.abs(wx) + 2) * dt / 0.35);
    const sens = 1 - 0.1 * (Fz[i] / Fz0 - 1);                          // load sensitivity
    const muW = mu * sens * harm.tyres * (front ? harm.frontGrip : harm.rearGrip * (car.hb > 0.5 ? 0.6 : 1));
    const maxW = muW * Fz[i];
    // longitudinal: drive (open differential splits the axle's torque evenly), brakes, handbrake
    let Fx = drive * (front ? P.front : P.rear) / 2 + Fbrake * (front ? 0.32 : 0.18) + (front ? 0 : Fhb / 2);
    if (Math.abs(Fx) > maxW) {
      const over = (Math.abs(Fx) - maxW) / maxW;
      if (front) { if (Fbrake * Fx > 0 || P.front === 0) lockF = Math.max(lockF, over); else spinF = Math.max(spinF, over); }
      else if (P.rear) spinR = Math.max(spinR, over);
      Fx = Math.sign(Fx) * maxW * 0.9;
    }
    const latCap = Math.max(Math.sqrt(Math.max(0, maxW * maxW - Fx * Fx * 0.8)), front ? 0 : 0.3 * maxW);
    const Fy = clamp(-maxW * sat(car.alpha[i]), -latCap, latCap) * lowK;
    // back into the car frame
    const fxC = (Fx * c_ - Fy * s_) * gnd, fyC = (Fx * s_ + Fy * c_) * gnd;
    Flong += fxC; Flat += fyC; if (front) FlatF += fyC;
    torqueZ += z * fyC - x * fxC;
  }
  const Ffx = Flong; // for the skid/lock bookkeeping below
  car.spin = lerp(car.spin, clamp(Math.max(spinR, spinF), 0, 1.5), Math.min(1, dt * 10));
  Flong += -P.drag * vLong * Math.abs(vLong) - P.roll * vLong * ((car.onSand ? 3 : 1) + harm.drag + (1 - harm.tyres) * 14) * gnd - (wet ? P.mass * 1.6 * vLong : 0)
    - P.mass * 9.81 * car.slope * gnd; // gravity along a ramp
  Flat += -0.6 * vLat * Math.abs(vLat) - P.mass * 9.81 * car.bank * gnd; // and across a side slope

  const axL = Flong / P.mass, ayL = Flat / P.mass;
  car.ax = lerp(car.ax, axL, Math.min(1, dt * 8));
  car.ay = lerp(car.ay, ayL, Math.min(1, dt * 8));

  car.vx += (fx * axL + sx * ayL) * dt;
  car.vz += (fz * axL + sz * ayL) * dt;
  car.w += torqueZ / P.inertia * dt;

  // Stability assist: nudges the yaw rate towards what the steering asks for (capped by the grip available), so
  // slides recover and the car goes where it's pointed. It mostly steps aside for a drift: just after the
  // handbrake, or with the throttle pinned and the wheel wound into the slide.
  car.hbT = car.hb > 0.5 ? 1.0 : Math.max(0, (car.hbT || 0) - dt);
  const drifting = car.hbT > 0 || (car.throttle > 0.75 && counter && P.rear > 0.3);
  const wMax = mu * 9.81 * 1.15 / Math.max(speed, 3);
  const wWant = clamp(vLong * Math.tan(d) / L, -wMax, wMax);
  const assist = P.assist * (drifting ? 0.2 : 1) * clamp((speed - 3) / 6, 0, 1) * gnd;
  car.w += (wWant - car.w) * clamp(assist * 5 * dt, 0, 1);

  // Blend towards kinematic steering at crawling speed (stable parking-lot handling)
  vLong = car.vx * fx + car.vz * fz; vLat = car.vx * sx + car.vz * sz;
  const k = car.air ? 0 : clamp(1 - Math.hypot(vLong, vLat) / 4, 0, 1);
  if (k > 0) {
    car.w = lerp(car.w, vLong * Math.tan(d) / L, k);
    vLat *= 1 - k * 0.3;
    if (Math.abs(vLong) < 0.05 && car.throttle < 0.02) vLong = 0;
    car.vx = fx * vLong + sx * vLat; car.vz = fz * vLong + sz * vLat;
  }
  car.w *= 1 - 0.4 * dt;
  car.h += car.w * dt;
  car.x += car.vx * dt; car.z += car.vz * dt;

  // Height: follow the road surface (ground, ramps, bridge decks); fall if it drops away
  const gy = city.heightAt(car.x, car.z, car.y);
  if (car.y > gy + 0.06) {
    car.air = true; car.vy -= 9.81 * dt; car.y += car.vy * dt;
    if (car.y <= gy) { if (car.vy < -6) crash.hard = Math.max(crash.hard, -car.vy * 0.4); car.y = gy; car.vy = 0; car.air = false; }
  } else { car.vy = (gy - car.y) / dt; car.y = gy; car.air = false; }
  const yF = city.heightAt(car.x + fx * 1.6, car.z + fz * 1.6, car.y), yR = city.heightAt(car.x - fx * 1.6, car.z - fz * 1.6, car.y);
  car.slope = lerp(car.slope, (yF - yR) / 3.2, Math.min(1, dt * 12));
  const yL = city.heightAt(car.x + sx * 0.9, car.z + sz * 0.9, car.y), yRt = city.heightAt(car.x - sx * 0.9, car.z - sz * 0.9, car.y);
  car.bank = lerp(car.bank, clamp((yL - yRt) / 1.8, -0.8, 0.8), Math.min(1, dt * 12));

  // Effects bookkeeping
  car.slipDeg = speed > 4 ? Math.atan2(vLat, Math.abs(vLong)) * 180 / Math.PI : 0;
  car.skidR = clamp((Math.abs(vLatR) - 1.6) / 5, 0, 1) + clamp(car.spin, 0, 1) + (car.hb > 0.5 && speed > 3 ? 0.6 : 0);
  car.skidF = clamp((Math.abs(vwy) - 2.2) / 5, 0, 1) + (lockF > 0 && speed > 3 ? 0.8 : 0);
  car.frontRot += vLong / P.R * dt * (lockF > 0 ? 0.2 : 1);
  car.rearRot += (car.hb > 0.5 ? 0 : wheelSurf / P.R) * dt;

  collide(dt);
}

/* ---------------- Collisions ---------------- */
// Crash bookkeeping shared with audio, HUD and effects
const crash = { active: false, quiet: 0, speed: 0, peakG: 0, g: 0, work: 0, fxWork: 0, slip: 0, scrape: 0, glass: 0, shown: 0, hard: 0, points: [], shake: 0 };
const obsPool = [];
// Express an obstacle in a car's frame at the start and end of the step. Moving obstacles (other cars) carry
// their previous pose in px/pz/pux/puz so the solver can sweep them too.
function localObstacle(n, o, x0, z0, s0, c0, x1, z1, s1, c1, pool = obsPool, cy = 0) {
  const L = pool[n] || (pool[n] = {});
  // heights relative to the car: the lattice only touches what overlaps it vertically
  L.src = o; L.type = o.type; L.r = o.r; L.hx = o.hx; L.hz = o.hz; L.mu = o.mu;
  L.y0 = (o.y0 || 0) - cy; L.h = (o.y0 || 0) + o.h - cy;
  let dx = (o.px ?? o.x) - x0, dz = (o.pz ?? o.z) - z0;
  L.c0x = dx * c0 - dz * s0; L.c0z = dx * s0 + dz * c0;
  dx = o.x - x1; dz = o.z - z1;
  L.c1x = dx * c1 - dz * s1; L.c1z = dx * s1 + dz * c1;
  if (o.type === 'box') {
    const ux0 = o.pux ?? o.ux, uz0 = o.puz ?? o.uz;
    L.a0x = ux0 * c0 - uz0 * s0; L.a0z = ux0 * s0 + uz0 * c0;
    L.a1x = o.ux * c1 - o.uz * s1; L.a1z = o.ux * s1 + o.uz * c1;
  }
  return L;
}

// The passenger cell is rigid: two circles that stop the car once the crumple zones are used up.
function coreHit(off, cr, o, s, c) {
  const px = car.x + s * off, pz = car.z + c * off;
  let nx, nz, pen;
  if (o.type === 'circle') {
    const dx = px - o.x, dz = pz - o.z, dist = Math.hypot(dx, dz);
    if (dist >= cr + o.r || dist < 1e-5) return 0;
    nx = dx / dist; nz = dz / dist; pen = cr + o.r - dist;
  } else {
    const dx = px - o.x, dz = pz - o.z;
    const qx = dx * o.ux + dz * o.uz, qz = -dx * o.uz + dz * o.ux;
    const ddx = qx - clamp(qx, -o.hx, o.hx), ddz = qz - clamp(qz, -o.hz, o.hz), dist = Math.hypot(ddx, ddz);
    let nqx, nqz;
    if (dist > 1e-5) { if (dist >= cr) return 0; pen = cr - dist; nqx = ddx / dist; nqz = ddz / dist; }
    else {
      const ex = o.hx - Math.abs(qx), ez = o.hz - Math.abs(qz);
      if (ex < ez) { nqx = Math.sign(qx) || 1; nqz = 0; pen = ex + cr; } else { nqx = 0; nqz = Math.sign(qz) || 1; pen = ez + cr; }
    }
    nx = nqx * o.ux - nqz * o.uz; nz = nqx * o.uz + nqz * o.ux;
  }
  car.x += nx * pen; car.z += nz * pen;
  const rx = s * off - nx * cr, rz = c * off - nz * cr; // contact point relative to the centre of mass
  const vpx = car.vx + car.w * rz, vpz = car.vz - car.w * rx;
  const vn = vpx * nx + vpz * nz;
  if (vn >= 0) return 0;
  const rn = nx * rz - nz * rx;
  const j = -(1 + 0.05) * vn / (1 / P.mass + rn * rn / P.inertia);
  car.vx += j * nx / P.mass; car.vz += j * nz / P.mass; car.w += j * rn / P.inertia;
  // sliding friction along the face
  const tx = -nz, tz = nx, vt = vpx * tx + vpz * tz;
  const jt = -clamp(vt * P.mass * 0.5, -o.mu * j, o.mu * j);
  car.vx += jt * tx / P.mass; car.vz += jt * tz / P.mass;
  return -vn;
}

const near = [], nearTmp = [];
let felledCount = 0, snapLoss = 1; // street furniture knocked over this session; the speed the last one cost
// Is this obstacle actually within reach of the car's body this step (box or post against the car's rectangle,
// plus how far the two can close in a step)? Lamp posts and kerbside furniture a metre away are not, and keeping
// them out lets the crash structure sleep instead of solving 240 times a second.
function inReach(o, s, c, dt) {
  const hx = (kit?.bodyHalfW || 0.95), hz = (kit?.length || 4.5) / 2;
  const rel = Math.hypot(car.vx - (o.body?.vx || 0), car.vz - (o.body?.vz || 0)) * dt * 3 + 0.25;
  const ax = c, az = -s; // the car's local x axis in the world
  const dx = o.x - car.x, dz = o.z - car.z;
  if (o.type === 'circle') {
    const lx = dx * ax + dz * az, lz = dx * s + dz * c;
    const ex = Math.max(0, Math.abs(lx) - hx), ez = Math.max(0, Math.abs(lz) - hz);
    return Math.hypot(ex, ez) < o.r + rel;
  }
  for (const [nx, nz] of [[ax, az], [s, c], [o.ux, o.uz], [-o.uz, o.ux]]) {
    const ra = (hx + rel) * Math.abs(ax * nx + az * nz) + (hz + rel) * Math.abs(s * nx + c * nz);
    const rb = o.hx * Math.abs(o.ux * nx + o.uz * nz) + o.hz * Math.abs(-o.uz * nx + o.ux * nz);
    if (Math.abs(dx * nx + dz * nz) > ra + rb) return false;
  }
  return true;
}
function collide(dt) {
  const s = Math.sin(car.h), c = Math.cos(car.h);
  const s0 = Math.sin(car.ph), c0 = Math.cos(car.ph);
  if (snapLoss < 1) { car.vx *= snapLoss; car.vz *= snapLoss; snapLoss = 1; } // taken here so the crash sensor doesn't read it as a wall
  const vx0 = car.vx, vz0 = car.vz;

  // Soft shell against everything within reach: walls, trees, houses, and other cars
  near.length = 0;
  nearSolids(car.x, car.z, 6, nearTmp);
  // lamp posts, signals and stop signs break away above a crawl: it costs some speed, it doesn't stop the car
  if (Math.hypot(car.vx, car.vz) > 4) for (let i = nearTmp.length - 1; i >= 0; i--) {
    const o = nearTmp[i];
    if (!o.snap || !traffic.nearCar(car.x, car.z, car.h, o, 0.5, car.y) || !inReach(o, s, c, 0) || !city.knock(o, car.vx, car.vz)) continue;
    nearTmp.splice(i, 1);
    snapLoss = Math.min(snapLoss, o.r > 0.1 ? 0.88 : 0.96); crash.shake = Math.max(crash.shake, 0.3); felledCount++;
  }
  traffic.boxesNear(car.x, car.z, 7, nearTmp, car.y);
  for (const o of nearTmp) if (traffic.nearCar(car.x, car.z, car.h, o, 0.5, car.y) && inReach(o, s, c, dt)) near.push(localObstacle(near.length, o, car.px, car.pz, s0, c0, car.x, car.z, s, c, obsPool, car.y));
  const res = soft.step(dt, near);
  if (res.fx || res.fz || res.tq) {
    const Fx = c * res.fx + s * res.fz, Fz = -s * res.fx + c * res.fz;
    // Crush force resists motion in full; springback (force along the direction of travel) returns only a
    // small share of the stored energy, as bent steel does
    const back = Fx * car.vx + Fz * car.vz > 0 ? 0.12 : 1;
    car.vx += Fx * back / P.mass * dt;
    car.vz += Fz * back / P.mass * dt;
    car.w += res.tq * back / P.inertia * dt;
    // Newton's third law: whatever pushed us, we pushed back
    for (const Lo of near) {
      const u = Lo.src.body;
      if (!u || !(Lo.ix || Lo.iz)) continue;
      const Ix = (c * Lo.ix + s * Lo.iz) * back, Iz = (-s * Lo.ix + c * Lo.iz) * back;
      u.vx -= Ix / u.m; u.vz -= Iz / u.m;
      if (Lo.cw > 0) {
        const lx = Lo.cpx / Lo.cw, lz = Lo.cpz / Lo.cw;
        const rx = car.x + c * lx + s * lz - u.x, rz = car.z - s * lx + c * lz - u.z;
        u.w += (-Ix * rz + Iz * rx) / u.I;
      }
      u.hitDv = (u.hitDv || 0) + Math.hypot(Ix, Iz) / u.m;
      u.playerDv = (u.playerDv || 0) + Math.hypot(Ix, Iz) / u.m; // for the police: you hit them
    }
  }
  collisionTotal += Math.max(0, res.work); crash.work += res.work; crash.fxWork += res.work;
  if (res.contacts) {
    crash.slip = Math.max(crash.slip, res.slip);
    for (const p of res.points) crash.points.push(p);
    if (crash.points.length > 48) crash.points.splice(0, crash.points.length - 48);
  }

  // Rigid passenger cell
  let hard = 0;
  for (const o of nearTmp) {
    if (!traffic.nearCar(car.x, car.z, car.h, o, 0.2, car.y)) continue;
    if (o.body) hard = Math.max(hard, traffic.coreContact(car, 0.55, 0.72, o, o.body), traffic.coreContact(car, -0.55, 0.72, o, o.body));
    else hard = Math.max(hard, coreHit(0.55, 0.72, o, s, c), coreHit(-0.55, 0.72, o, s, c));
  }
  if (hard > 0.5) crash.hard = Math.max(crash.hard, hard);

  const lim = city.EXT + 150;
  if (Math.abs(car.x) > lim) { car.x = Math.sign(car.x) * lim; car.vx *= -0.3; }
  if (Math.abs(car.z) > lim) { car.z = Math.sign(car.z) * lim; car.vz *= -0.3; }

  // Crash measurement: deceleration from collision forces only, filtered over ~15 ms like a crash sensor
  const g = Math.hypot(car.vx - vx0, car.vz - vz0) / dt / 9.81;
  crash.g += (g - crash.g) * Math.min(1, dt / 0.015);
  const touching = res.contacts > 0 || hard > 0;
  if (touching) {
    if (!crash.active) { crash.active = true; crash.speed = Math.hypot(vx0, vz0); crash.peakG = 0; crash.v0x = vx0; crash.v0z = vz0; crash.dv = 0; }
    crash.quiet = 0;
  } else if (crash.active && (crash.quiet += dt) > 0.3) crash.active = false;
  if (crash.active) {
    crash.peakG = Math.max(crash.peakG, crash.g);
    crash.dv = Math.max(crash.dv, Math.hypot(car.vx - crash.v0x, car.vz - crash.v0z)); // delta-v: crash severity
  }

  // Mailboxes and bins: knocked loose (from instanced scenery into a real body) and punted
  {
    city.propsNear(car.x, car.z, 4, propsTmp);
    for (const p of propsTmp) for (const off of [1.3, 0, -1.3]) {
      if (Math.abs(p.y - car.y) > 1.2) break;
      if (Math.hypot(p.x - car.x - s * off, p.z - car.z - c * off) < 0.95 + p.r) { loose.push(newLoose(p)); break; }
    }
    for (const cn of loose) {
      if (Math.abs(cn.x - car.x) > 4 || Math.abs(cn.z - car.z) > 4 || cn.y > 0.3 || Math.abs(city.groundAt(cn.x, cn.z) - car.y) > 1.2) continue;
      for (const off of [1.3, 0, -1.3]) {
        const px = car.x + s * off, pz = car.z + c * off;
        const dx = cn.x - px, dz = cn.z - pz, dd = Math.hypot(dx, dz);
        if (dd < 0.95 + cn.r && dd > 1e-4) {
          const nx = dx / dd, nz = dz / dd, sp = Math.hypot(car.vx, car.vz);
          cn.vx = car.vx * 1.1 + nx * (2 + sp * 0.25); cn.vz = car.vz * 1.1 + nz * (2 + sp * 0.25);
          cn.vy = 1.5 + sp * 0.18 + rand() * 1.5;
          cn.tipV = 6 + rand() * 6; cn.spin = (rand() - 0.5) * 10;
          const vm = Math.hypot(cn.vx, cn.vz) || 1; cn.ax = cn.vz / vm; cn.az = -cn.vx / vm;
          cn.x += nx * (0.96 + cn.r - dd); cn.z += nz * (0.96 + cn.r - dd);
          car.vx *= 0.985; car.vz *= 0.985;
          thud = Math.max(thud, 0.4);
          break;
        }
      }
    }
  }
}
let thud = 0;
const loose = [], propsTmp = [];
function newLoose(p) {
  const g = city.knockProp(p);
  return { p, g, x: p.x, z: p.z, y: 0, vx: 0, vz: 0, vy: 0, tip: 0, tipV: 0, ax: 1, az: 0, spin: 0, yaw: p.yaw, r: p.r };
}
function resetLoose() { for (const cn of loose) city.restoreProp(cn.p, cn.g); loose.length = 0; }
const tipAxis = new THREE.Vector3();
function updateLoose(dt) {
  for (const cn of loose) {
    if (cn.vx === 0 && cn.vz === 0 && cn.vy === 0 && cn.y === 0) continue;
    cn.vy -= 9.81 * dt; cn.y += cn.vy * dt;
    if (cn.y <= 0) { cn.y = 0; cn.vy = Math.abs(cn.vy) > 1.2 ? -cn.vy * 0.3 : 0; const f = Math.exp(-3.5 * dt); cn.vx *= f; cn.vz *= f; cn.tipV *= 0.6; }
    cn.x += cn.vx * dt; cn.z += cn.vz * dt;
    cn.tip = Math.min(Math.PI / 2, cn.tip + cn.tipV * dt);
    if (Math.hypot(cn.vx, cn.vz) < 0.05 && cn.y === 0) { cn.vx = cn.vz = 0; }
    cn.g.position.set(cn.x, city.groundAt(cn.x, cn.z) + cn.y + (cn.tip > 1 ? 0.18 : 0), cn.z); // y is height above the ground
    cn.g.quaternion.setFromAxisAngle(tipAxis.set(cn.ax, 0, cn.az), cn.tip);
    cn.g.rotateY(cn.yaw + cn.spin * cn.tip * 0.2);
  }
}

/* ---------------- Skid marks & smoke ---------------- */
const SKIDS = 4000;
const skidPos = new Float32Array(SKIDS * 4 * 3);
const skidAlpha = new Float32Array(SKIDS * 4);
const skidIdx = [];
for (let i = 0; i < SKIDS; i++) { const b = i * 4; skidIdx.push(b, b + 1, b + 2, b, b + 2, b + 3); }
const skidGeo = new THREE.BufferGeometry();
skidGeo.setAttribute('position', new THREE.BufferAttribute(skidPos, 3).setUsage(THREE.DynamicDrawUsage));
skidGeo.setAttribute('alpha', new THREE.BufferAttribute(skidAlpha, 1).setUsage(THREE.DynamicDrawUsage));
skidGeo.setIndex(skidIdx);
const skidMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
  vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(0.05,0.045,0.05, vA); }`
});
const skidMesh = new THREE.Mesh(skidGeo, skidMat); skidMesh.frustumCulled = false; scene.add(skidMesh);
let skidHead = 0;
const lastMark = { rl: null, rr: null, fl: null, fr: null };
function addSkid(key, x, z, intensity, hx, hz) {
  const prev = lastMark[key];
  lastMark[key] = { x, z };
  if (!prev) return;
  const dx = x - prev.x, dz = z - prev.z, len = Math.hypot(dx, dz);
  if (len < 0.05 || len > 3) return;
  const w = 0.13, px = -dz / len * w, pz = dx / len * w;
  const i = skidHead; skidHead = (skidHead + 1) % SKIDS;
  const b = i * 12, y = car.y + 0.015;
  skidPos.set([prev.x + px, y, prev.z + pz, prev.x - px, y, prev.z - pz, x - px, y, z - pz, x + px, y, z + pz], b);
  const a = clamp(intensity, 0, 1) * (car.onSand ? 0.25 : 0.55);
  skidAlpha.set([a, a, a, a], i * 4);
  skidGeo.attributes.position.needsUpdate = true; skidGeo.attributes.alpha.needsUpdate = true;
}

const smokeTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
})();
const smoke = [];
for (let i = 0; i < 140; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false, opacity: 0, color: '#d9cfc8' }));
  sp.visible = false; scene.add(sp); smoke.push({ sp, life: 0, max: 1, vx: 0, vy: 0, vz: 0 });
}
let smokeHead = 0;
function puff(x, z, amt, sandy, y = 0.35, color = null) {
  const p = smoke[smokeHead]; smokeHead = (smokeHead + 1) % smoke.length;
  p.life = p.max = 1.2 + rand() * 1.4;
  p.sp.position.set(x, y, z); p.sp.visible = true;
  p.sp.material.color.set(color || (sandy ? '#c29470' : '#ddd5cf'));
  p.vx = car.vx * 0.25 + (rand() - 0.5) * 1.5; p.vz = car.vz * 0.25 + (rand() - 0.5) * 1.5; p.vy = 0.6 + rand() * 0.8;
  p.base = 0.25 + amt * 0.35;
}
function updateSmoke(dt) {
  for (const p of smoke) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.sp.visible = false; continue; }
    const t = 1 - p.life / p.max;
    p.sp.position.x += p.vx * dt; p.sp.position.y += p.vy * dt; p.sp.position.z += p.vz * dt;
    p.vx *= 0.97; p.vz *= 0.97;
    const sc = 0.8 + t * 5; p.sp.scale.set(sc, sc, 1);
    p.sp.material.opacity = p.base * (1 - t) * Math.min(1, t * 6);
  }
}

/* ---------------- Damage effects ---------------- */
const SAMPLE = new Float32Array(5);
const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
const lost = [];
let glassBroken = false;
const CABIN_PROBES = [[0.62, 1.2, 0.35], [-0.62, 1.2, 0.35], [0.62, 1.2, -0.7], [-0.62, 1.2, -0.7], [0, 1.4, 0.4], [0, 1.4, -1.1]];
const BAY_PROBES = [[0, 0.65, 1.8], [0.35, 0.65, 1.45], [-0.35, 0.65, 1.45], [0, 0.65, 1.2]];
const toWorld = (x, y, z, v = tmpV) => body.localToWorld(v.set(x, y, z));

// Shards and torn-off parts
const shardGeo = new THREE.BoxGeometry(1, 1, 1);
const shardMats = {
  paint: new THREE.MeshStandardMaterial({ color: '#2f6fa8', metalness: 0.5, roughness: 0.4 }),
  glass: new THREE.MeshStandardMaterial({ color: '#b9c6d2', metalness: 0.9, roughness: 0.08 }),
  trim: new THREE.MeshStandardMaterial({ color: '#1a191e', roughness: 0.7 }),
  lens: new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.2 }),
  red: new THREE.MeshStandardMaterial({ color: '#a8140f', roughness: 0.3 }),
};
const shards = [];
for (let i = 0; i < 160; i++) {
  const m = new THREE.Mesh(shardGeo, shardMats.paint); m.castShadow = true; m.visible = false; scene.add(m);
  shards.push({ m, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, rest: true, half: 0.01 });
}
let shardHead = 0;
function spawnShard(pos, kind, kick = 3) {
  const sh = shards[shardHead]; shardHead = (shardHead + 1) % shards.length;
  const glassy = kind === 'glass' || kind === 'lens';
  const sx = glassy ? 0.02 + rand() * 0.05 : 0.04 + rand() * 0.1, sz = glassy ? 0.02 + rand() * 0.05 : 0.03 + rand() * 0.08, sy = 0.006 + rand() * 0.01;
  sh.m.material = shardMats[kind]; sh.m.scale.set(sx, sy, sz); sh.half = sy / 2;
  sh.m.position.copy(pos); sh.m.rotation.set(rand() * TAU, rand() * TAU, rand() * TAU); sh.m.visible = true;
  sh.vx = car.vx * 0.6 + (rand() - 0.5) * kick * 2; sh.vz = car.vz * 0.6 + (rand() - 0.5) * kick * 2; sh.vy = 1 + rand() * kick;
  sh.ax = (rand() - 0.5) * 30; sh.ay = (rand() - 0.5) * 30; sh.az = (rand() - 0.5) * 30; sh.rest = false;
}
const flying = [];
function updateDebris(dt) {
  const step = (o, half) => {
    o.vy -= 9.81 * dt;
    o.m.position.x += o.vx * dt; o.m.position.y += o.vy * dt; o.m.position.z += o.vz * dt;
    o.m.rotation.x += o.ax * dt; o.m.rotation.y += o.ay * dt; o.m.rotation.z += o.az * dt;
    const floor = city.heightAt(o.m.position.x, o.m.position.z, o.m.position.y) + half;
    if (o.m.position.y < floor) {
      o.m.position.y = floor; o.vy = Math.abs(o.vy) > 1 ? -o.vy * 0.3 : 0;
      o.vx *= 0.6; o.vz *= 0.6; o.ax *= 0.5; o.ay *= 0.5; o.az *= 0.5;
      if (Math.hypot(o.vx, o.vy, o.vz) < 0.25) { o.rest = true; o.m.rotation.x = Math.round(o.m.rotation.x / Math.PI) * Math.PI; o.m.rotation.z = Math.round(o.m.rotation.z / Math.PI) * Math.PI; }
    }
  };
  for (const sh of shards) if (!sh.rest) step(sh, sh.half);
  for (const f of flying) if (!f.rest) step(f, f.half);
}

// Sparks from metal grinding on concrete
const sparkTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,250,220,1)'); gr.addColorStop(0.3, 'rgba(255,190,90,0.9)'); gr.addColorStop(1, 'rgba(255,120,30,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(c);
})();
const sparks = [];
for (let i = 0; i < 120; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: sparkTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  sp.visible = false; scene.add(sp); sparks.push({ sp, life: 0, vx: 0, vy: 0, vz: 0 });
}
let sparkHead = 0;
function spark(x, y, z, nx, nz, speed) {
  const s = sparks[sparkHead]; sparkHead = (sparkHead + 1) % sparks.length;
  s.life = 0.2 + rand() * 0.35; s.sp.visible = true; s.sp.position.set(x, y, z); s.floor = car.y + 0.02;
  const sz = 0.05 + rand() * 0.08; s.sp.scale.set(sz, sz, 1);
  s.vx = car.vx * 0.5 + nx * 2 + (rand() - 0.5) * speed * 0.4; s.vz = car.vz * 0.5 + nz * 2 + (rand() - 0.5) * speed * 0.4; s.vy = 0.5 + rand() * 3;
}
function updateSparks(dt) {
  for (const s of sparks) {
    if (s.life <= 0) continue;
    s.life -= dt; if (s.life <= 0) { s.sp.visible = false; continue; }
    s.vy -= 9.81 * dt; s.sp.position.x += s.vx * dt; s.sp.position.y = Math.max(s.floor, s.sp.position.y + s.vy * dt); s.sp.position.z += s.vz * dt;
    s.sp.material.opacity = Math.min(1, s.life * 4);
  }
}

function breakPart(pt) {
  pt.broken = true;
  lost.push(pt.name);
  const m = pt.mesh;
  toWorld(...pt.anchor);
  const at = tmpV.clone();
  if (pt.kind === 'light') {
    pt.saved = { emissive: m.material.emissiveIntensity, color: m.material.color.getHex() };
    m.material.emissiveIntensity = 0; m.material.color.set('#2a2626');
    for (let i = 0; i < 10; i++) spawnShard(at, pt.name === 'Taillight' ? 'red' : 'lens', 2.5);
    crash.glass = Math.max(crash.glass || 0, 0.35);
    return;
  }
  // Tear the part off: recentre its (already deformed) geometry and let it fly
  bindingOf.get(m).live = false;
  body.updateMatrixWorld(true);
  const geo = m.geometry; geo.computeBoundingBox();
  const ctr = geo.boundingBox.getCenter(new THREE.Vector3()), size = geo.boundingBox.getSize(new THREE.Vector3());
  geo.translate(-ctr.x, -ctr.y, -ctr.z);
  const wp = ctr.applyMatrix4(m.matrixWorld);
  m.getWorldQuaternion(tmpQ);
  body.remove(m); scene.add(m);
  m.position.copy(wp); m.quaternion.copy(tmpQ);
  flying.push({ m, pt, half: Math.min(size.x, size.y, size.z) / 2 + 0.01, rest: false,
    vx: car.vx * 0.8 + (rand() - 0.5) * 4, vy: 1.5 + rand() * 3, vz: car.vz * 0.8 + (rand() - 0.5) * 4,
    ax: (rand() - 0.5) * 14, ay: (rand() - 0.5) * 14, az: (rand() - 0.5) * 14 });
}
function restorePart(pt) {
  const m = pt.mesh;
  if (pt.kind === 'light') { m.material.emissiveIntensity = pt.saved.emissive; m.material.color.setHex(pt.saved.color); }
  else {
    scene.remove(m); body.add(m);
    m.position.set(0, 0, 0); m.quaternion.identity(); m.rotation.set(0, 0, 0);
    bindingOf.get(m).live = true;
    const i = flying.findIndex(f => f.pt === pt); if (i >= 0) flying.splice(i, 1);
  }
  pt.broken = false;
}
function repairCar() {
  for (const pt of kit.parts) if (pt.broken) restorePart(pt);
  soft.reset(); soft.refreshed = -1;
  lost.length = 0; glassBroken = false;
  Object.assign(harm, { toe: 0, frontGrip: 1, rearGrip: 1, drag: 0, engine: 0, power: 1, bullet: 0, tyres: 1 });
  for (const sh of shards) { sh.m.visible = false; sh.rest = true; }
  Object.assign(crash, { active: false, peakG: 0, g: 0, work: 0, fxWork: 0, hard: 0, slip: 0, glass: 0, shown: 0, points: [] });
}

// Read the deformed lattice back into the meshes, wheels and the driving model
function applyDamage() {
  for (const bd of bindings) if (bd.live) soft.deform(bd);
  let fMax = 0, rMax = 0, total = 0;
  for (const key of ['fl', 'fr', 'rl', 'rr']) {
    const w = W[key];
    soft.sample(w.x, P.R + 0.05, w.z, SAMPLE);
    w.dx = SAMPLE[0]; w.dy = SAMPLE[1]; w.dz = SAMPLE[2];
    const hurt = Math.hypot(SAMPLE[0], SAMPLE[2]);
    total += hurt;
    if (key[0] === 'f') fMax = Math.max(fMax, hurt); else rMax = Math.max(rMax, hurt);
  }
  harm.toe = clamp(-(W.fl.dz - W.fr.dz) * 0.3, -0.1, 0.1);
  harm.frontGrip = 1 - clamp((fMax - 0.1) * 1.6, 0, 0.5);
  harm.rearGrip = 1 - clamp((rMax - 0.1) * 1.6, 0, 0.5);
  harm.drag = clamp((total - 0.15) * 6, 0, 5);
  let bay = 0;
  for (const pr of BAY_PROBES) bay = Math.max(bay, soft.sample(pr[0], pr[1], pr[2], SAMPLE)[3]);
  harm.engine = clamp((bay - 0.1) / 0.45, 0, 1);
  harm.power = 1 - 0.75 * harm.engine;

  body.updateMatrixWorld(true);
  for (const pt of kit.parts) {
    if (pt.broken) continue;
    if (soft.sample(...pt.anchor, SAMPLE)[3] > pt.limit) breakPart(pt);
  }
  if (!glassBroken) for (const pr of CABIN_PROBES) {
    if (soft.sample(pr[0], pr[1], pr[2], SAMPLE)[3] > 0.14) {
      glassBroken = true; lost.push('Glass');
      crash.glass = 1;
      const at = toWorld(pr[0], pr[1], pr[2]).clone();
      for (let i = 0; i < 24; i++) spawnShard(at, 'glass', 3);
      break;
    }
  }
  drawDamage();
}

// Per-frame crash effects driven by what the physics recorded since the last frame
function crashEffects(dt) {
  const s = Math.sin(car.h), c = Math.cos(car.h);
  const world = p => tmpV.set(car.x + c * p.x + s * p.z, car.y + p.y, car.z - s * p.x + c * p.z);
  if (crash.fxWork > 1500 && crash.points.length) {
    const n = Math.min(8, crash.fxWork / 2500 | 0);
    for (let i = 0; i < n; i++) {
      const p = crash.points[(rand() * crash.points.length) | 0];
      spawnShard(world(p), rand() < 0.75 ? 'paint' : 'trim', 2 + Math.min(4, crash.fxWork / 20000));
    }
  }
  crash.fxWork = 0;
  if (crash.slip > 3 && crash.points.length) {
    const n = Math.min(6, crash.slip / 3 | 0);
    for (let i = 0; i < n; i++) {
      const p = crash.points[(rand() * crash.points.length) | 0];
      if (p.y > 0.9) continue;
      const w = world(p);
      const wnx = c * p.nx + s * p.nz, wnz = -s * p.nx + c * p.nz;
      spark(w.x, Math.max(car.y + 0.05, w.y), w.z, wnx, wnz, crash.slip);
    }
  }
  crash.scrape = crash.points.length ? crash.slip : 0;
  crash.points.length = 0; crash.slip = 0;
  if (crash.g > 4) crash.shake = Math.max(crash.shake, Math.min(1, crash.g / 30));
  crash.shake *= Math.exp(-dt * 6);
  // a cracked radiator steams, a wrecked engine smokes
  const smokeK = Math.max(harm.engine, harm.bullet);
  if (smokeK > 0.12 && rand() < 0.25 + smokeK * 0.5) {
    const w = toWorld((rand() - 0.5) * 0.6, 0.95, 1.5 + rand() * 0.4);
    puff(w.x, w.z, 0.2 + smokeK * 0.5, false, w.y, smokeK > 0.55 ? '#45403f' : '#e9e6e2');
  }
}

/* ---------------- Audio ---------------- */
const audio = { on: false, muted: false };
function initAudio() {
  if (audio.ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
  const ctx = new AC(); audio.ctx = ctx;
  const master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination); audio.master = master;
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 2.6); }
  shaper.curve = curve;
  const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.Q.value = 3;
  const eg = ctx.createGain(); eg.gain.value = 0;
  const mix = ctx.createGain(); mix.gain.value = 0.5;
  mix.connect(shaper); shaper.connect(filt); filt.connect(eg); eg.connect(master);
  const mk = (type, mult, gain) => { const o = ctx.createOscillator(); o.type = type; const g = ctx.createGain(); g.gain.value = gain; o.connect(g); g.connect(mix); o.start(); return { o, mult }; };
  audio.oscs = [mk('sawtooth', 1, 0.6), mk('square', 0.5, 0.45), mk('sawtooth', 2.01, 0.18), mk('triangle', 0.25, 0.5)];
  audio.filt = filt; audio.eg = eg;
  // noise source shared by tyres, wind and pops
  const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  audio.noiseBuf = nb;
  const n = ctx.createBufferSource(); n.buffer = nb; n.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 9; bp.frequency.value = 1100;
  const sq = ctx.createGain(); sq.gain.value = 0; n.connect(bp); bp.connect(sq); sq.connect(master);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
  const wind = ctx.createGain(); wind.gain.value = 0; n.connect(lp); lp.connect(wind); wind.connect(master);
  const sbp = ctx.createBiquadFilter(); sbp.type = 'bandpass'; sbp.Q.value = 1.6; sbp.frequency.value = 1800;
  const scrape = ctx.createGain(); scrape.gain.value = 0; n.connect(sbp); sbp.connect(scrape); scrape.connect(master);
  n.start();
  audio.squeal = sq; audio.squealF = bp; audio.wind = wind; audio.scrape = scrape; audio.scrapeF = sbp;
  audio.nextCrunch = 0;
  audio.voices = [0, 1, 2].map(() => {
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(); o1.type = 'sawtooth'; o2.type = 'square';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 1.5;
    const g = ctx.createGain(); g.gain.value = 0;
    const g2 = ctx.createGain(); g2.gain.value = 0.5;
    o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.connect(master); o1.start(); o2.start();
    return { o1, o2, lp, g };
  });
}
// Gunshots: a sharp crack of filtered noise over a low thump, shaped per weapon; others' shots fall off with
// distance. Your own shots also rumble a gamepad (or a phone).
function gunshot(w, dist = 0) {
  if (!audio.ctx || audio.muted || !audio.noiseBuf) return;
  const t = audio.ctx.currentTime, far = 1 / (1 + dist * dist / 900), v = (w === -1 ? 0.55 : 1) * far;
  const big = w === 3 ? 1.6 : w === 2 ? 0.75 : 1;
  grain(t, w === 3 ? 900 : 1800, 0.7, 0.5 * v * big, 0.09 * big, 'lowpass');            // the blast
  grain(t, 3800, 1.2, 0.28 * v, 0.05, 'highpass');                                       // the crack
  const o = audio.ctx.createOscillator(), g = audio.ctx.createGain();                    // the thump in your chest
  o.frequency.setValueAtTime(w === 3 ? 90 : 120, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
  g.gain.setValueAtTime(0.5 * v * big, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16 * big);
  o.connect(g); g.connect(audio.master); o.start(t); o.stop(t + 0.2 * big);
  if (dist < 60) grain(t + 0.08 + dist / 340, 600, 0.5, 0.08 * v, 0.35, 'lowpass');      // the street echoes it back
  if (w >= 0) {
    for (const gp of navigator.getGamepads ? navigator.getGamepads() : []) gp?.vibrationActuator?.playEffect?.('dual-rumble', { duration: w === 3 ? 140 : 60, strongMagnitude: w === 3 ? 0.9 : 0.45, weakMagnitude: 0.6 }).catch?.(() => {});
    try { navigator.vibrate?.(w === 3 ? 60 : 25); } catch (e) { /* not on desktop */ }
  }
}
function horn(vol) {
  const ctx = audio.ctx, t = ctx.currentTime;
  for (const f of [415, 494]) {
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.02); g.gain.setValueAtTime(vol, t + 0.45); g.gain.linearRampToValueAtTime(0, t + 0.5);
    o.connect(lp); lp.connect(g); g.connect(audio.master); o.start(t); o.stop(t + 0.55);
  }
}
function trafficAudio(t) {
  const byDist = traffic.vehicles.filter(v => v.state !== 'idle').map(v => [Math.hypot(v.x - car.x, v.z - car.z), v]).sort((a, b) => a[0] - b[0]);
  audio.voices.forEach((voice, i) => {
    const [d, v] = byDist[i] || [1e9, null];
    if (!v || d > 90 || audio.muted) { voice.g.gain.setTargetAtTime(0, t, 0.1); return; }
    // Doppler: pitch rises as a car closes on you and drops as it passes
    const rx = (v.x - car.x) / (d || 1), rz = (v.z - car.z) / (d || 1);
    const vr = (v.vx - car.vx) * rx + (v.vz - car.vz) * rz;
    const f = v.rpm / 60 * 2 * 343 / (343 + vr);
    voice.o1.frequency.setTargetAtTime(f, t, 0.05); voice.o2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    voice.lp.frequency.setTargetAtTime(400 + v.throttle * 1400 + v.rpm * 0.15, t, 0.05);
    voice.g.gain.setTargetAtTime((0.05 + v.throttle * 0.09) / (1 + d * d / 120), t, 0.08);
  });
  for (const v of traffic.vehicles) if (v.horn) {
    v.horn = 0;
    const d = Math.hypot(v.x - car.x, v.z - car.z);
    if (!audio.muted && d < 120) horn(0.35 / (1 + d * d / 400));
  }
}
function grain(when, freq, q, vol, len, type = 'bandpass') {
  const ctx = audio.ctx, s = ctx.createBufferSource(); s.buffer = audio.noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain(); g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(vol, when + 0.002); g.gain.exponentialRampToValueAtTime(0.001, when + len);
  s.connect(f); f.connect(g); g.connect(audio.master); s.start(when, Math.random() * 1.5); s.stop(when + len + 0.02);
}
// Sheet metal folding: a body thump plus a cluster of resonant noise grains
function crunch(vol) {
  const ctx = audio.ctx, t = ctx.currentTime;
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(36, t + 0.3);
  const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  o.connect(g); g.connect(audio.master); o.start(t); o.stop(t + 0.45);
  const n = 3 + (vol * 9 | 0);
  for (let i = 0; i < n; i++) grain(t + Math.random() * 0.16 * (0.5 + vol), 250 + Math.random() * 2600, 2 + Math.random() * 7, vol * (0.25 + Math.random() * 0.5), 0.03 + Math.random() * 0.09);
}
function shatter(vol) {
  const t = audio.ctx.currentTime;
  for (let i = 0; i < 18; i++) grain(t + Math.pow(Math.random(), 1.6) * 0.55, 3500 + Math.random() * 5500, 1 + Math.random() * 4, vol * (0.15 + Math.random() * 0.3) * (1 - i / 22), 0.015 + Math.random() * 0.05, i % 3 ? 'bandpass' : 'highpass');
}
function pop(when, vol) {
  const ctx = audio.ctx; const s = ctx.createBufferSource(); s.buffer = audio.noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
  const g = ctx.createGain(); g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(vol, when + 0.004); g.gain.exponentialRampToValueAtTime(0.001, when + 0.07);
  s.connect(f); f.connect(g); g.connect(audio.master); s.start(when, Math.random()); s.stop(when + 0.1);
}
let lastThrottle = 0;
function updateAudio() {
  if (!audio.ctx || !audio.on) return;
  const t = audio.ctx.currentTime;
  const rpm = car.rpm + (car.limiter ? Math.sin(t * 90) * 180 : 0);
  const f = rpm / 60 * 2; // 4-cylinder firing frequency
  for (const { o, mult } of audio.oscs) o.frequency.setTargetAtTime(f * mult, t, 0.015);
  audio.filt.frequency.setTargetAtTime(250 + car.throttle * 2200 + rpm * 0.25, t, 0.03);
  // a damaged engine runs rough and misfires
  const rough = harm.engine > 0.25 && Math.random() < harm.engine * 0.35 ? 1 - harm.engine * 0.8 : 1;
  audio.eg.gain.setTargetAtTime(audio.muted ? 0 : (0.16 + car.throttle * 0.22 + rpm / P.redline * 0.08) * rough, t, 0.012);
  const sk = clamp(Math.max(car.skidR, car.skidF) * (car.onSand ? 0.25 : 1), 0, 1);
  audio.squeal.gain.setTargetAtTime(audio.muted ? 0 : sk * 0.22, t, 0.05);
  audio.squealF.frequency.setTargetAtTime(900 + sk * 500 + Math.sin(t * 13) * 60, t, 0.05);
  const sp = Math.hypot(car.vx, car.vz);
  audio.wind.gain.setTargetAtTime(audio.muted ? 0 : clamp(sp / 70, 0, 1) * 0.12 + (car.onSand ? clamp(sp / 30, 0, 1) * 0.12 : 0), t, 0.1);
  // Overrun pops when lifting at high rpm
  if (!audio.muted && lastThrottle > 0.6 && car.throttle < 0.3 && car.rpm > 4500) {
    const n = 2 + (Math.random() * 3 | 0);
    for (let i = 0; i < n; i++) pop(t + 0.05 + i * (0.06 + Math.random() * 0.08), 0.35 + Math.random() * 0.3);
  }
  if (!audio.muted && thud > 0.05) { pop(t, thud * 0.6); thud = 0; }
  if (!audio.muted) {
    if (crash.work > 120 && t > audio.nextCrunch) { crunch(clamp(Math.log10(crash.work) / 4.6, 0.12, 1)); audio.nextCrunch = t + 0.06 + Math.random() * 0.05; crash.work = 0; }
    if (crash.hard > 0.5) { crunch(clamp(crash.hard / 8, 0.3, 1)); pop(t, clamp(crash.hard / 10, 0.2, 1)); }
    if (crash.glass > 0) shatter(crash.glass);
  }
  crash.work *= 0.85; crash.hard = 0; crash.glass = 0;
  audio.scrape.gain.setTargetAtTime(audio.muted ? 0 : clamp(crash.scrape / 14, 0, 1) * 0.35, t, 0.03);
  audio.scrapeF.frequency.setTargetAtTime(1200 + clamp(crash.scrape, 0, 30) * 60, t, 0.05);
  lastThrottle = car.throttle;
  trafficAudio(t);
}

/* ---------------- Input ---------------- */
const keys = {};
const touch = { l: 0, r: 0, g: 0, b: 0, h: 0 };
const camModes = ['Chase', 'Far', 'Bumper', 'Orbit'];
let camMode = 0;
addEventListener('keydown', e => {
  if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
  if (downing) { if (['Space', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.code)) e.preventDefault(); return; } // WASTED / BUSTED: hands off
  const menuOpen = !started || !el('garage').hidden || missions?.paused || empire?.open || street?.shopOpen || street?.briefOpen;
  if (menuOpen && !['Escape','KeyJ','KeyV','KeyB','Enter'].includes(e.code)) return;
  if (e.repeat) { if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault(); return; }
  keys[e.code] = true;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (crime && crime.onFoot) {
    if (e.code === 'KeyF') { e.preventDefault(); crime.interact(); }
    if (e.code === 'KeyG') { e.preventDefault(); crime.breakWindow(); }
    if (/^Digit[1-4]$/.test(e.code)) crime.setWeapon(parseInt(e.code.slice(5)) - 1);
  }
  if (e.code === 'KeyF' && started && !missions?.paused && el('garage').hidden && !crime?.onFoot) exitCar();
  if (e.code === 'KeyC') camMode = (camMode + 1) % camModes.length;
  if (e.code === 'KeyR' && started && !missions?.paused && el('garage').hidden && !crime?.onFoot) respawn(e.shiftKey);
  if (e.code === 'KeyR' && crime?.onFoot) crime.reload();
  if (e.code === 'KeyV') toggleGarage();
  if (e.code === 'KeyJ') { empire?.toggle(false); missions?.toggle(); }
  if (e.code === 'KeyB' && started) empire?.toggle();
  if (e.code === 'Tab') { e.preventDefault(); bigMap.open = !bigMap.open; el('bigmap').hidden = !bigMap.open; if (bigMap.open && document.pointerLockElement) document.exitPointerLock?.(); }
  if (e.code === 'KeyZ') toggleAbility();
  if (e.code === 'KeyP') togglePhone();
  if (e.code === 'KeyX') switchChar((who.cur + 1) % CHARS.length);
  // Enter opens the shop, but never steals Enter from a focused button or another open menu
  if (e.code === 'Enter' && started && street?.shopAt && !e.target.closest?.('button, a, select, input') && (street.shopOpen || !menuOpen)) { e.preventDefault(); street.openShop(); }
  if (e.code === 'KeyM') audio.muted = !audio.muted;
  if (e.code === 'KeyH') setHudMode(!document.body.classList.contains('gta'));
  if ((e.code === 'Period' || e.code === 'Comma') && started && !crime?.onFoot) { const st = e.code === 'Period' ? radio.next() : radio.prev(); radioUserOff = !st; showRadio(); }
  if (e.code === 'KeyE') shift(1);
  if (e.code === 'KeyQ') { if (crime?.onFoot) openWheel(true); else shift(-1); }
  if (e.code === 'KeyT') car.auto = true;
  if (!started && !/^Digit/.test(e.code)) start();
});
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'KeyQ') openWheel(false); });
addEventListener('blur', () => openWheel(false));
addEventListener('mousedown', e => {
  const menuOpen = !el('garage').hidden || missions?.paused || empire?.open || street?.shopOpen || street?.briefOpen || bigMap.open || downing || wheel.open || phone.open;
  if (crime && crime.onFoot && !menuOpen && !e.target.closest?.('button, a, select, input, .overlay, #bigmap, #phone')) {
    crime.mouseButton(e.button, true);
    if (document.pointerLockElement !== canvas) { try { const r = canvas.requestPointerLock?.(); if (r?.catch) r.catch(() => {}); } catch (err) { /* lock unavailable: look still follows the mouse */ } }
    e.preventDefault();
  }
});
addEventListener('mouseup', e => {
  if (crime && crime.onFoot) crime.mouseButton(e.button, false);
});
addEventListener('mousemove', e => {
  if (!crime || !crime.onFoot) return;
  if (wheel.open) return wheelMove(e.movementX || 0, e.movementY || 0); // the mouse picks a weapon, the view holds still
  // locked: full mouse look; unlocked (lock refused or not yet granted): the camera still follows the mouse
  const k = document.pointerLockElement === canvas ? 1 : 0.6;
  crime.mouseMove((e.movementX || 0) * k, (e.movementY || 0) * k);
});
addEventListener('contextmenu', e => { if (crime?.onFoot) e.preventDefault(); });
function exitCar() {
  if (!started || crime?.onFoot) return;
  const carPose = { x: car.x, y: car.y, z: car.z, h: car.h };
  // leave the car as it is: a copy of the (dented) body, with its crash structure saved for when you get back in
  const rec = crime.addParked(parkedCopy(), preset, carPose, rideOwned && career.state.owned.includes(preset.id), false);
  rec.damage = damageSnapshot(); rec.mine = true;
  let pose = { x: car.x + Math.cos(car.h) * 2, z: car.z - Math.sin(car.h) * 2, y: car.y, h: car.h };
  if (!city.walkAt(pose.x, pose.z) && city.walkAt(car.x - Math.cos(car.h) * 2, car.z + Math.sin(car.h) * 2)) pose = { x: car.x - Math.cos(car.h) * 2, z: car.z + Math.sin(car.h) * 2, y: car.y, h: car.h };
  car.vx = car.vz = car.w = 0;
  crime.startAt(pose);
  carGroup.visible = false;
}
// The car you just got out of, frozen as it is: dents, missing parts and all (geometry copied, lights left out)
function parkedCopy() {
  const g = carGroup.clone(true), own = [], drop = [];
  g.traverse(o => { if (o.isLight) drop.push(o); else if (o.isMesh && o.parent && o.parent.parent === g) { o.geometry = o.geometry.clone(); own.push(o.geometry); } });
  for (const o of drop) o.parent.remove(o);
  g.rotation.set(0, 0, 0); g.children[0].rotation.set(0, 0, 0); g.children[0].position.y = 0.02;
  g.visible = true;
  g.userData.dispose = () => { for (const x of own) x.dispose(); };
  return g;
}
// The crash structure (lattice nodes and beams) of the car you drive, or of a traffic car, to carry over
function damageSnapshot(src = soft) {
  src.refresh?.();
  return { rest: src.rest, p: src.p.slice(), len: src.len.slice(), torn: src.torn.slice(), scuff: src.scuff.slice(), tornCount: src.tornCount || 0,
    bullet: src === soft ? harm.bullet : 0, tyres: src === soft ? harm.tyres : 1, total: src === soft ? collisionTotal : 0 };
}
function restoreDamage(snap) {
  if (!snap || snap.p.length !== soft.p.length || snap.len.length !== soft.len.length) return false;
  for (let i = 0; i < soft.rest.length; i++) if (Math.abs(soft.rest[i] - snap.rest[i]) > 1e-3) return false;
  soft.p.set(snap.p); soft.pp.set(snap.p); soft.u.fill(0); soft.len.set(snap.len); soft.torn.set(snap.torn); soft.scuff.set(snap.scuff);
  soft.tornCount = snap.tornCount; soft.version = (soft.version || 0) + 1; soft.refreshed = -1; soft.sleeping = true;
  soft.refresh(); applyDamage();
  // parts that were already gone: drop them quietly instead of throwing them off again
  for (const f of flying) scene.remove(f.m);
  flying.length = 0;
  for (const sh of shards) { sh.m.visible = false; sh.rest = true; }
  harm.bullet = snap.bullet || 0; harm.tyres = snap.tyres ?? 1;
  Object.assign(crash, { active: false, peakG: 0, g: 0, work: 0, fxWork: 0, hard: 0, slip: 0, glass: 0, shown: 0, points: [] });
  return true;
}
// a static copy of a car (no physics): civilian parked cars
function makeCarMesh(pr, load = true) {
  const model = CARMODELS.find(m => m.id === pr.model);
  if (!model) { if (load) ensureModel(pr.model); return null; }
  const kit = buildModelCar(model, { paint: pr.paint, paint2: pr.paint2 });
  const g = new THREE.Group(), b = new THREE.Group(); b.position.y = 0.02; g.add(b);
  const sharedGeo = new Set(model.body.map(x => x.geo)), sharedMat = new Set(model.body.map(x => x.mat));
  const ownGeo = new Set(), ownMat = new Set();
  for (const { mesh } of kit.meshes) {
    mesh.castShadow = true; b.add(mesh);
    if (!sharedGeo.has(mesh.geometry)) ownGeo.add(mesh.geometry);
    if (!sharedMat.has(mesh.material)) ownMat.add(mesh.material);
  }
  if (kit.makeWheel) for (let i = 0; i < 4; i++) { const w = kit.makeWheel(i), s = new THREE.Group(); s.position.copy(w.center); s.add(w.spin, w.fixed); g.add(s); }
  // free only what this copy created (paint/light materials, indicator lenses); model geometry is shared
  g.userData.dispose = () => { for (const x of ownGeo) x.dispose(); for (const x of ownMat) x.dispose(); };
  return g;
}

let timeScale = 1;
// The weapon wheel (hold Q on foot), as in GTA V: time all but stops, push the mouse towards a slot, let go to draw it
const wheel = { open: false, x: 0, y: 0, sel: 0 };
function drawWheel() {
  const box = el('wheel'), a = crime.ammo?.[wheel.sel];
  for (const d of box.querySelectorAll('.w')) d.classList.toggle('sel', +d.dataset.w === wheel.sel);
  box.querySelector('b').textContent = ['FISTS', 'PISTOL', 'SMG', 'SHOTGUN'][wheel.sel];
  box.querySelector('span').textContent = wheel.sel && a ? `${a.mag} / ${a.res}` : '';
}
function openWheel(on) {
  if (on === wheel.open || (on && (!started || !crime?.onFoot || downing))) return;
  wheel.open = on; el('wheel').hidden = !on;
  if (on) { wheel.x = wheel.y = 0; wheel.sel = crime.weapon; drawWheel(); } else if (crime?.onFoot) crime.setWeapon(wheel.sel);
}
function wheelMove(dx, dy) {
  wheel.x += dx; wheel.y += dy;
  const l = Math.hypot(wheel.x, wheel.y); if (l > 120) { wheel.x *= 120 / l; wheel.y *= 120 / l; }
  if (l > 28) { const s = ((Math.round(Math.atan2(wheel.x, -wheel.y) / (Math.PI / 2)) % 4) + 4) % 4; if (s !== wheel.sel) { wheel.sel = s; drawWheel(); } } // up, right, down, left
}
// The special ability (Z), as in GTA V: time slows while the yellow bar under the radar drains (the
// wheel and the trigger stay as quick as ever, which is the point), on the road or on foot, in a chase or a job.
// The bar refills slowly by itself, faster for driving hard: speed, slides, air.
const ability = { v: 1, on: false, fx: 0 };
function toggleAbility() {
  if (!started || downing) return;
  if (ability.on) ability.on = false; else if (ability.v > 0.12) ability.on = true;
}
function updateAbility(real, paused) {
  if (paused || downing) { if (downing) ability.on = false; return; }
  if (ability.on) { ability.v -= real / 14; if (ability.v <= 0) { ability.v = 0; ability.on = false; } }
  else {
    const sp = Math.hypot(car.vx || 0, car.vz || 0);
    let gain = 1 / 150;
    if (!crime?.onFoot) gain += clamp((sp - 22) / 30, 0, 1) / 45 + (Math.abs(car.slipDeg || 0) > 14 && sp > 10 ? 1 / 30 : 0) + (car.air ? 1 / 20 : 0);
    ability.v = Math.min(1, ability.v + gain * real);
  }
  const kind = CHARS[who.cur].ability, foot = !!crime?.onFoot, slow = kind === 'drive' ? (foot ? 0.65 : 0.35) : kind === 'aim' ? (foot ? 0.25 : 0.65) : 1;
  if (ability.on && kind === 'rage') crime.addArmor(real * 28); // the bruiser: the armour comes back as fast as it goes
  const want = wheel.open ? 0.12 : ability.on ? slow : 1;
  if (wheel.open && !crime?.onFoot) openWheel(false);
  timeScale = Math.abs(timeScale - want) < 0.01 ? want : lerp(timeScale, want, 1 - Math.exp(-real * 9));
  ability.fx = lerp(ability.fx, ability.on ? 1 : 0, 1 - Math.exp(-real * 6));
}
// Back on the road: repair and drop onto the nearest lane (Shift: also tidy up knocked-over props)
function respawn(tidy) {
  missions?.engine.cancel('Recovery ended the contract');
  const pose = city.nearestLanePose(car.x, car.z, car.y) || city.start;
  // back on the road, dents and all: repairs are Apex Customs' business
  const keep = { ...harm }; resetCar(pose); Object.assign(harm, keep);
  for (const k in lastMark) lastMark[k] = null;
  if (tidy) resetLoose();
  camSnap = true;
}
function shift(dir) {
  car.auto = false;
  const g = clamp(car.gear + dir, 0, 7);
  if (g !== car.gear) { car.gear = g; car.shiftT = 0.15; }
}
function bindTouch(id, k) {
  const el = document.getElementById(id);
  const on = e => { e.preventDefault(); touch[k] = 1; el.classList.add('on'); if (!started) start(); };
  const off = e => { e.preventDefault(); touch[k] = 0; el.classList.remove('on'); };
  el.addEventListener('pointerdown', on); el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('pointerleave', off);
}
bindTouch('tl', 'l'); bindTouch('tr', 'r'); bindTouch('tg', 'g'); bindTouch('tb', 'b'); bindTouch('th', 'h');
if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');

let smoothSteer = 0;
function readInput(dt) {
  let gas = (keys.KeyW || keys.ArrowUp || touch.g) ? 1 : 0;
  let brake = (keys.KeyS || keys.ArrowDown || touch.b) ? 1 : 0;
  let steerRaw = ((keys.KeyD || keys.ArrowRight || touch.r) ? 1 : 0) - ((keys.KeyA || keys.ArrowLeft || touch.l) ? 1 : 0);
  let hb = (keys.Space || touch.h) ? 1 : 0;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    const ax = gp.axes[0] || 0; if (Math.abs(ax) > 0.08) steerRaw = Math.sign(ax) * Math.abs(ax) ** 1.5;
    gas = Math.max(gas, gp.buttons[7] ? gp.buttons[7].value : 0);
    brake = Math.max(brake, gp.buttons[6] ? gp.buttons[6].value : 0);
    if (gp.buttons[0] && gp.buttons[0].pressed) hb = 1;
  }
  // keyboard steering ramps in so taps are progressive (screen +x is car's left, so flip)
  smoothSteer = lerp(smoothSteer, -steerRaw, Math.min(1, dt * (steerRaw === 0 ? 10 : 6)));
  return { gas, brake, steer: smoothSteer, hb };
}

/* ---------------- Camera ---------------- */
const camPos = new THREE.Vector3(0, 4, -32), camLook = new THREE.Vector3();
let orbitA = 0, orbitHold = false, camSnap = false, orbitR = 11;
function updateCamera(dt) {
  const s = Math.sin(car.h), c = Math.cos(car.h);
  const sp = Math.hypot(car.vx, car.vz);
  // Chase cams follow the velocity direction a little so drifts read on screen
  const vh = sp > 3 ? Math.atan2(car.vx, car.vz) : car.h;
  let dh = vh - car.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  const ch = car.h + dh * 0.45;
  const cs = Math.sin(ch), cc = Math.cos(ch);
  const target = new THREE.Vector3(), look = new THREE.Vector3();
  let k = 7, fov = 62 + clamp(sp * 0.26, 0, 24);
  const mode = camModes[camMode], y = car.y, tall = kit ? kit.top - 1.5 : 0;
  if (mode === 'Chase') { target.set(car.x - cs * (6.4 + tall), 2.3 + y + tall, car.z - cc * (6.4 + tall)); look.set(car.x + s * 3, 1.0 + y + tall * 0.5, car.z + c * 3); }
  else if (mode === 'Far') { target.set(car.x - cs * 12, 5.2 + y, car.z - cc * 12); look.set(car.x + s * 4, 0.8 + y, car.z + c * 4); k = 5; }
  else if (mode === 'Bumper') { target.set(car.x + s * 0.4, 1.25 + y + tall * 0.6, car.z + c * 0.4); look.set(car.x + s * 20, 0.9 + y, car.z + c * 20); k = 60; fov += 6; }
  else { if (!orbitHold) orbitA += dt * 0.25; target.set(car.x + Math.sin(orbitA) * orbitR, 1 + y + orbitR * 0.2, car.z + Math.cos(orbitA) * orbitR); look.set(car.x, 0.8 + y, car.z); k = 3; }
  target.y = Math.max(target.y, city.heightAt(target.x, target.z, y + 2) + 0.9);
  const t = camSnap ? 1 : 1 - Math.exp(-dt * k);
  camPos.lerp(target, t);
  camLook.lerp(look, mode === 'Bumper' || camSnap ? 1 : 1 - Math.exp(-dt * 12));
  camSnap = false;
  camera.position.copy(camPos);
  if (sp > 30 && mode !== 'Orbit') camera.position.y += (Math.random() - 0.5) * 0.012 * (sp - 30) / 20;
  if (crash.shake > 0.01) camera.position.add(tmpV.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(crash.shake * 0.35));
  camera.lookAt(camLook);
  camera.fov = lerp(camera.fov, fov, 1 - Math.exp(-dt * 3));
  camera.updateProjectionMatrix();
}

/* ---------------- HUD ---------------- */
const tach = document.getElementById('tach').getContext('2d');
const el = id => document.getElementById(id);
const hud = { speed: el('speed'), gear: el('gear'), mode: el('gearmode'), rpm: el('t-rpm'), kw: el('t-kw'), g: el('t-g'), slip: el('t-slip'), surf: el('t-surf'), cam: el('t-cam'), drift: el('drift'),
  impact: el('impact'), body: el('t-body'), engine: el('t-engine'), lost: el('lost'), traffic: el('t-traffic') };
const dmgCtx = el('dmg').getContext('2d');
// Top-down view of the lattice as it is now: each cell drawn at its deformed position, coloured by damage
function drawDamage() {
  const g = dmgCtx, Wc = 180, Hc = 260, sc = 52, cx = Wc / 2, cy = Hc / 2;
  g.clearRect(0, 0, Wc, Hc);
  const { nx, ny, nz, p, dmg } = soft;
  const X = n => cx - p[n * 3] * sc, Y = n => cy - p[n * 3 + 2] * sc;
  for (let k = 0; k < nz - 1; k++) for (let i = 0; i < nx - 1; i++) {
    let d = 0;
    for (let j = 0; j < ny; j++) d += dmg[soft.idx(i, j, k)] + dmg[soft.idx(i + 1, j, k)] + dmg[soft.idx(i, j, k + 1)] + dmg[soft.idx(i + 1, j, k + 1)];
    d /= ny * 4;
    const t = clamp(d / 0.3, 0, 1);
    g.fillStyle = t < 0.05 ? 'rgba(243,236,228,0.2)' : t < 0.5 ? `rgba(255,181,71,${0.35 + t})` : `rgba(255,90,78,${0.5 + t * 0.5})`;
    const a = soft.idx(i, 1, k), b = soft.idx(i + 1, 1, k), c = soft.idx(i + 1, 1, k + 1), e = soft.idx(i, 1, k + 1);
    g.beginPath(); g.moveTo(X(a), Y(a)); g.lineTo(X(b), Y(b)); g.lineTo(X(c), Y(c)); g.lineTo(X(e), Y(e)); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(18,16,24,0.55)'; g.lineWidth = 1; g.stroke();
  }
  g.fillStyle = '#16151a'; g.strokeStyle = 'rgba(243,236,228,0.7)'; g.lineWidth = 1.5;
  for (const key of ['fl', 'fr', 'rl', 'rr']) {
    const w = W[key], x = cx - (w.x + (w.dx || 0)) * sc, y = cy - (w.z + (w.dz || 0)) * sc;
    g.beginPath(); g.rect(x - 6, y - 15, 12, 30); g.fill(); g.stroke();
  }
  g.fillStyle = 'rgba(185,174,166,0.9)'; g.font = '500 15px "IBM Plex Mono", monospace'; g.textAlign = 'center';
  g.fillText('FRONT', cx, 14);
}
let needle = P.idle;
function drawTach() {
  const g = tach, W2 = 480, cx = 240, cy = 240, R = 210;
  g.clearRect(0, 0, W2, W2);
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, max = 8000;
  const ang = r => a0 + (a1 - a0) * (r / max);
  g.fillStyle = 'rgba(18,16,24,0.62)'; g.beginPath(); g.arc(cx, cy, R + 18, 0, TAU); g.fill();
  g.lineWidth = 14; g.lineCap = 'butt';
  g.strokeStyle = 'rgba(243,236,228,0.12)'; g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();
  g.strokeStyle = 'rgba(255,90,78,0.75)'; g.beginPath(); g.arc(cx, cy, R, ang(P.redline - 400), a1); g.stroke();
  needle = lerp(needle, car.rpm, 0.35);
  const hot = needle > P.shiftUp - 300;
  g.strokeStyle = hot ? '#ff5a4e' : '#ffb547'; g.beginPath(); g.arc(cx, cy, R, a0, ang(needle)); g.stroke();
  g.fillStyle = '#b9aea6'; g.font = '500 24px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let r = 0; r <= max; r += 1000) {
    const a = ang(r), ca = Math.cos(a), sa = Math.sin(a);
    g.strokeStyle = 'rgba(243,236,228,0.6)'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(cx + ca * (R - 22), cy + sa * (R - 22)); g.lineTo(cx + ca * (R - 38), cy + sa * (R - 38)); g.stroke();
    g.fillText(String(r / 1000), cx + ca * (R - 62), cy + sa * (R - 62));
  }
  g.fillStyle = 'rgba(185,174,166,0.8)'; g.font = '500 16px "IBM Plex Mono", monospace'; g.fillText('×1000 rpm', cx, cy + R - 40);
  // shift light
  if (hot) { g.fillStyle = car.limiter && (performance.now() / 60 | 0) % 2 ? 'rgba(255,90,78,0.3)' : '#ff5a4e'; g.beginPath(); g.arc(cx, cy - R + 46, 9, 0, TAU); g.fill(); }
}
// Heading-up minimap: roads, signals, traffic, and you in the middle
const mapCtx = el('map').getContext('2d');
const ROAD_STYLE = {
  river: ['rgba(70,120,150,0.55)', 60], fwy: ['rgba(255,181,71,0.8)', 24], ramp: ['rgba(255,181,71,0.55)', 6], hwy: ['rgba(255,214,140,0.62)', 9], art: ['rgba(255,214,140,0.5)', 8],
  dt: ['rgba(243,236,228,0.42)', 8], rural: ['rgba(243,236,228,0.4)', 8], res: ['rgba(243,236,228,0.26)', 8], ind: ['rgba(243,236,228,0.26)', 8],
};
const MAP_ORDER = ['river', 'res', 'ind', 'rural', 'dt', 'art', 'hwy', 'ramp', 'fwy'];
/* ---------------- The world map ---------------- */
// One detailed top-down picture of the whole valley, painted once (in slices, so boot isn't held up) in the
// colours of a road atlas rather than of the season: blue water with sandy banks, green meadows, darker woods,
// the patchwork of the farms, rock and snow on the high ground with contour lines, grey town blocks with green
// parks, every building footprint (shaded by height, casting a shadow) and every road at its real width:
// orange freeway, yellow highways, white streets. The radar and the full map both draw from it.
const WORLD = { S: 3072, ext: city.EXT + 60, canvas: null, ready: false };
WORLD.sc = WORLD.S / (2 * WORLD.ext);
const ATLAS = {
  fields: [[186, 172, 100], [140, 170, 88], [164, 140, 96], [158, 186, 100], [198, 186, 118], [124, 156, 82], [150, 176, 92]],
  town: { dt: [150, 148, 146], mid: [160, 157, 150], ind: [156, 146, 130], sub: [174, 171, 154], vil: [176, 170, 150] },
  lawn: { dt: [160, 162, 142], mid: [160, 167, 138], ind: [162, 157, 134], sub: [158, 176, 128], vil: [156, 176, 124] }, park: [92, 160, 90],
  road: { fwy: '#f59e36', ramp: '#f7b458', hwy: '#f8d568', art: '#fff2c4', dt: '#ffffff', rural: '#f1ecdf', res: '#f8f6f0', ind: '#efece5' },
  casing: { fwy: '#7c4410', ramp: '#8a5518', hwy: '#86661c', art: '#6b6658', dt: '#5c5a56', rural: '#6a665c', res: '#6c6a66', ind: '#66625a' },
};
async function buildWorldMap() {
  WORLD.building = true;
  const t0 = performance.now();
  const { S, ext, sc } = WORLD, R = 2048, px = 2 * ext / R, EDGE = city.EXT - 2, WL = city.WATER;
  const relief = document.createElement('canvas'); relief.width = relief.height = R;
  const rg = relief.getContext('2d'), img = rg.createImageData(R, R), D = img.data;
  const hRow = new Float32Array(R + 1), hNext = new Float32Array(R + 1);
  const rowH = (j, out) => { for (let i = 0; i <= R; i++) out[i] = city.groundAt(ext - i * px, ext - j * px); };
  const step = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  rowH(0, hRow);
  let slice = performance.now();
  for (let j = 0; j < R; j++) {
    rowH(j + 1, hNext);
    for (let i = 0; i < R; i++) {
      const x = ext - i * px, z = ext - j * px, h = hRow[i];
      const k = (j * R + i) * 4;
      D[k + 3] = 255;
      if (h < WL - 0.3) { const deep = clamp((WL - h) / 3.2, 0, 1); D[k] = 86 - 44 * deep; D[k + 1] = 150 - 52 * deep; D[k + 2] = 190 - 48 * deep; continue; } // water, darker in the channel
      // lit from the north-west, so hills read at a glance
      const de = hRow[i + 1] - h, ds = hNext[i] - h, slope = Math.hypot(de, ds) / px;
      const shade = clamp(0.94 + (de + ds) * 0.5 / px, 0.58, 1.2);
      const wild = Math.abs(x) < EDGE && Math.abs(z) < EDGE ? city.grassAt(x, z) : 1, zone = h < 140 ? city.zoneAt(x, z) : null;
      let r, gch, b;
      if (wild === 0 && !zone) { r = 168; gch = 162; b = 144; }                       // a country road's verge, a farmyard
      else {
        const lift = clamp((h - 10) / 150, 0, 1);
        r = 118 + 46 * lift; gch = 152 + 2 * lift; b = 86 + 26 * lift;                // meadow, drying out with height
        const forest = wild > 0 ? city.forestAt(x, z) : 0;
        const field = wild > 0 && forest < 0.3 ? city.fieldAt(x, z, h) : -1;
        if (field >= 0) { const f = ATLAS.fields[field]; r += (f[0] - r) * 0.8; gch += (f[1] - gch) * 0.8; b += (f[2] - b) * 0.8; }
        if (forest > 0.1) { // woods, a little stippled
          let t = Math.imul(i * 374761393 + j * 668265263 | 0, 1274126177); t = ((t ^ (t >>> 13)) & 7) - 3;
          const f = step(0.1, 0.55, forest) * 0.92; r += (54 + t * 2 - r) * f; gch += (102 + t * 3 - gch) * f; b += (62 + t * 2 - b) * f;
        }
        const rock = Math.max(step(0.34, 0.8, slope), step(185, 235, h));
        if (rock > 0) { r += (140 - r) * rock; gch += (130 - gch) * rock; b += (118 - b) * rock; }
        if (h > 250) { const s = step(250, 295, h); r += (244 - r) * s; gch += (247 - gch) * s; b += (250 - b) * s; } // snow on the tops
        // contour lines every 20 m, heavier every 100
        const c = Math.floor(h / 20), ce = Math.floor(hRow[i + 1] / 20), cs = Math.floor(hNext[i] / 20);
        if (c !== ce || c !== cs) { const major = Math.floor(c / 5) !== Math.floor(ce / 5) || Math.floor(c / 5) !== Math.floor(cs / 5), m = major ? 0.74 : 0.88; r *= m; gch *= m; b *= m; }
      }
      if (zone) { // in town: paved ground, gardens and greens, and the parks; the colour eases out into the country at the edge
        const t = wild === 0 ? ATLAS.town[zone] : city.parkAt(x, z) ? ATLAS.park : ATLAS.lawn[zone], w = 1 - step(0.8, 1, city.zoneR);
        if (t) { r += (t[0] - r) * w; gch += (t[1] - gch) * w; b += (t[2] - b) * w; }
      }
      if (h < WL + 1.7) { const s = step(WL + 1.7, WL + 0.1, h) * (zone ? 0.5 : 0.85); r += (212 - r) * s; gch += (198 - gch) * s; b += (154 - b) * s; } // sand at the water's edge
      D[k] = r * shade; D[k + 1] = gch * shade; D[k + 2] = b * shade;
    }
    hRow.set(hNext);
    if (performance.now() - slice > 9) { await new Promise(r => setTimeout(r, 0)); slice = performance.now(); }
  }
  rg.putImageData(img, 0, 0);
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const o = cv.getContext('2d'), X = x => S / 2 - x * sc, Y = z => S / 2 - z * sc;
  o.imageSmoothingEnabled = true; o.imageSmoothingQuality = 'high'; o.drawImage(relief, 0, 0, S, S);
  // ponds: a map shows the water, frozen or not
  for (const pd of city.country.ponds) {
    o.beginPath(); pd.rad.forEach((r, k) => { const a = k / pd.n * TAU, x = X(pd.x + Math.cos(a) * r), y = Y(pd.z + Math.sin(a) * r); k ? o.lineTo(x, y) : o.moveTo(x, y); }); o.closePath();
    o.strokeStyle = 'rgba(212,198,154,0.9)'; o.lineWidth = 3; o.stroke(); o.fillStyle = '#4f8fb8'; o.fill(); o.strokeStyle = 'rgba(30,60,90,0.45)'; o.lineWidth = 0.8; o.stroke();
  }
  // buildings: shadows first (thrown south-east, longer for taller ones), then the footprints
  const boxes = solids.filter(s => s.type === 'box' && s.h >= 3 && s.hx <= 90 && s.hz <= 90 && !s.parkedCar);
  let n = 0;
  o.fillStyle = 'rgba(24,24,34,0.3)';
  for (const s of boxes) {
    const d = clamp(s.h * 0.055, 0.5, 4.5);
    o.setTransform(1, 0, 0, 1, X(s.x) + d, Y(s.z) + d); o.rotate(-Math.atan2(-s.uz, s.ux));
    o.fillRect(-s.hx * sc, -s.hz * sc, 2 * s.hx * sc, 2 * s.hz * sc);
    if (++n % 1500 === 0) { o.setTransform(1, 0, 0, 1, 0, 0); await new Promise(r => setTimeout(r, 0)); o.fillStyle = 'rgba(24,24,34,0.3)'; }
  }
  o.lineWidth = 0.7;
  for (const s of boxes) {
    const tall = s.h >= 45, w = 2 * s.hx * sc, d = 2 * s.hz * sc;
    o.setTransform(1, 0, 0, 1, X(s.x), Y(s.z)); o.rotate(-Math.atan2(-s.uz, s.ux));
    o.fillStyle = s.h < 7 ? '#eadfc8' : s.h < 20 ? '#d6cfc2' : tall ? '#8c93a4' : '#b6b6bc';
    o.strokeStyle = tall ? 'rgba(24,28,40,0.8)' : 'rgba(58,50,40,0.6)';
    o.fillRect(-w / 2, -d / 2, w, d); o.strokeRect(-w / 2, -d / 2, w, d);
    if (s.h >= 20 && w > 5 && d > 5) { o.fillStyle = tall ? 'rgba(214,222,238,0.34)' : 'rgba(255,255,255,0.22)'; o.fillRect(-w / 2 + 1.4, -d / 2 + 1.4, w - 2.8, d - 2.8); } // a roof line on the bigger blocks
    if (++n % 1500 === 0) { o.setTransform(1, 0, 0, 1, 0, 0); await new Promise(r => setTimeout(r, 0)); o.lineWidth = 0.7; }
  }
  o.setTransform(1, 0, 0, 1, 0, 0);
  // roads: a dark casing, then the surface, at their real widths
  o.lineCap = 'round'; o.lineJoin = 'round';
  const trace = kind => { o.beginPath(); for (const m of city.mapLines) { if (m.kind !== kind) continue; m.pts.forEach((q, i) => i ? o.lineTo(X(q.x), Y(q.z)) : o.moveTo(X(q.x), Y(q.z))); } };
  for (const pass of [0, 1]) for (const kind of MAP_ORDER) {
    if (kind === 'river') continue;
    const w = ROAD_STYLE[kind][1] * sc;
    o.strokeStyle = pass ? ATLAS.road[kind] : ATLAS.casing[kind]; o.lineWidth = Math.max(pass ? 1.7 : 3, w + (pass ? 0 : 1.7));
    trace(kind); o.stroke();
  }
  o.strokeStyle = 'rgba(124,68,16,0.75)'; o.lineWidth = 1.1; trace('fwy'); o.stroke(); // the central reservation
  // the wind farm
  for (const t of city.country.turbines) {
    const x = X(t.x), y = Y(t.z);
    o.strokeStyle = '#2a2e36'; o.lineWidth = 3.2; o.beginPath(); for (let k = 0; k < 3; k++) { const a = k / 3 * TAU - 0.5; o.moveTo(x, y); o.lineTo(x + Math.cos(a) * 9, y + Math.sin(a) * 9); } o.stroke();
    o.strokeStyle = '#f6f8fa'; o.lineWidth = 1.6; o.stroke();
    o.fillStyle = '#f6f8fa'; o.beginPath(); o.arc(x, y, 2.4, 0, TAU); o.fill();
  }
  WORLD.canvas = cv; WORLD.ready = true; WORLD.building = false; WORLD.ms = Math.round(performance.now() - t0);
}
for (const m of city.mapLines) { // bounding boxes, so the minimap only draws what's near
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of m.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  m.box = [x0, x1, z0, z1];
}
// GTA-style radar: a rounded rectangle, heading-up, you a little below centre so you see more of what's ahead; it
// zooms out with speed. Roads, the GPS routes (purple to your waypoint, yellow to the job), blips, police and the
// search circle, and the name of the part of the valley you're in along the bottom.
const MAP_W = 360, MAP_H = 232;
let mapRange = 230;
const mapArea = { name: '', t: 0 };
function drawMap() {
  const g = mapCtx, W2 = MAP_W, H2 = MAP_H, cx = W2 / 2, cy = H2 * 0.62;
  mapRange = lerp(mapRange, 210 + clamp(Math.hypot(car.vx, car.vz) * 5, 0, 260), 0.04);
  const scale = (H2 * 0.62) / mapRange;
  const sh = Math.sin(car.h), ch = Math.cos(car.h);
  const X = (x, z) => cx - ((x - car.x) * ch - (z - car.z) * sh) * scale;
  const Y = (x, z) => cy - ((x - car.x) * sh + (z - car.z) * ch) * scale;
  const reach = mapRange * 2;
  g.clearRect(0, 0, W2, H2);
  g.save(); g.beginPath(); g.roundRect(1, 1, W2 - 2, H2 - 2, 14); g.clip();
  g.fillStyle = '#1b222b'; g.fillRect(0, 0, W2, H2);
  g.lineCap = 'round'; g.lineJoin = 'round';
  if (WORLD.ready) {
    // the painted world map, turned and scaled under the radar (map pixel u,v -> world x = (S/2-u)/sc, z = (S/2-v)/sc)
    const k = scale / WORLD.sc, dx0 = WORLD.S / 2 / WORLD.sc - car.x, dz0 = WORLD.S / 2 / WORLD.sc - car.z;
    g.setTransform(ch * k, sh * k, -sh * k, ch * k, cx - (dx0 * ch - dz0 * sh) * scale, cy - (dx0 * sh + dz0 * ch) * scale);
    g.drawImage(WORLD.canvas, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = 'rgba(12,16,24,0.3)'; g.fillRect(0, 0, W2, H2); // dimmed, so blips pop
  } else for (const kind of MAP_ORDER) {
    const [col, w] = ROAD_STYLE[kind];
    g.strokeStyle = col; g.lineWidth = Math.max(2, w * scale + 1.5);
    g.beginPath();
    for (const m of city.mapLines) {
      if (m.kind !== kind) continue;
      const [x0, x1, z0, z1] = m.box;
      if (x1 < car.x - reach || x0 > car.x + reach || z1 < car.z - reach || z0 > car.z + reach) continue;
      const step = m.pts.length > 400 ? 3 : 2;
      for (let i = 0; i < m.pts.length; i += step) { const q = m.pts[i]; i ? g.lineTo(X(q.x, q.z), Y(q.x, q.z)) : g.moveTo(X(q.x, q.z), Y(q.x, q.z)); }
      const l = m.pts[m.pts.length - 1]; g.lineTo(X(l.x, l.z), Y(l.x, l.z));
    }
    g.stroke();
  }
  gps.draw(g, X, Y, Math.max(3, 9 * scale));
  missions?.drawMap(g, X, Y); empire?.drawMap(g, X, Y); street?.drawMap(g, X, Y);
  // where the police are searching for you: get outside the circle to lose them
  const PS = police.state;
  if (PS.level && !PS.seen && PS.lastSeen) {
    g.strokeStyle = (performance.now() / 400 | 0) % 2 ? 'rgba(255,70,70,0.75)' : 'rgba(80,120,255,0.75)'; g.fillStyle = 'rgba(255,70,70,0.08)'; g.lineWidth = 2;
    g.beginPath(); g.arc(X(PS.lastSeen.x, PS.lastSeen.z), Y(PS.lastSeen.x, PS.lastSeen.z), police.zoneR() * scale, 0, TAU); g.fill(); g.stroke();
  }
  for (const v of traffic.vehicles) {
    if (v.state === 'idle') continue;
    const x = X(v.x, v.z), y = Y(v.x, v.z);
    if (x < -10 || y < -10 || x > W2 + 10 || y > H2 + 10) continue;
    g.save(); g.translate(x, y); g.rotate(car.h - v.h);
    if (v.police && v.state !== 'wreck') { // how far this unit can make you out (walls still hide you): stay outside it
      g.fillStyle = v.state === 'pursue' ? 'rgba(255,90,80,0.05)' : 'rgba(90,140,255,0.06)'; g.strokeStyle = v.state === 'pursue' ? 'rgba(255,110,100,0.4)' : 'rgba(120,160,255,0.4)'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(0, 0, police.seeR() * scale, 0, TAU); g.fill(); g.stroke();
    }
    g.fillStyle = v.police ? (v.state === 'pursue' ? ((performance.now() / 250 | 0) % 2 ? '#ff3b3b' : '#3b6bff') : '#5b7cff') : v.state === 'wreck' ? '#ff5a4e' : 'rgba(243,236,228,0.92)';
    g.strokeStyle = 'rgba(16,18,24,0.7)'; g.lineWidth = 1.2; g.strokeRect(-2.5, -5, 5, 10);
    g.fillRect(-2.5, -5, 5, 10); g.restore();
  }
  gps.drawPin(g, X, Y, W2, H2);
  // the edges fall away into shadow, and the name of where you are sits along the bottom
  const vg = g.createRadialGradient(cx, H2 / 2, H2 * 0.42, cx, H2 / 2, W2 * 0.66);
  vg.addColorStop(0, 'rgba(8,10,16,0)'); vg.addColorStop(1, 'rgba(8,10,16,0.5)');
  g.fillStyle = vg; g.fillRect(0, 0, W2, H2);
  if (performance.now() > mapArea.t) {
    mapArea.t = performance.now() + 500;
    const name = city.zoneAt(car.x, car.z, true) || 'Ashby Valley';
    if (name.toUpperCase() !== mapArea.name && mapArea.name && started && hudEl.area) { // just crossed into somewhere new: say so, bottom right
      hudEl.area.innerHTML = `${name}<small>${name === 'Ashby Valley' ? 'OPEN COUNTRY' : 'ASHBY VALLEY'}</small>`; hudEl.area.classList.add('show');
      clearTimeout(mapArea.pop); mapArea.pop = setTimeout(() => hudEl.area.classList.remove('show'), 4200);
    }
    mapArea.name = name.toUpperCase();
  }
  const band = g.createLinearGradient(0, H2 - 34, 0, H2);
  band.addColorStop(0, 'rgba(8,10,16,0)'); band.addColorStop(1, 'rgba(8,10,16,0.78)');
  g.fillStyle = band; g.fillRect(0, H2 - 34, W2, 34);
  g.fillStyle = 'rgba(244,241,234,0.92)'; g.font = '600 15px "Chakra Petch", sans-serif'; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
  g.fillText(mapArea.name, W2 - 14, H2 - 10);
  if (!WINTER) { g.textAlign = 'left'; g.font = '600 14px "IBM Plex Mono", monospace'; g.fillStyle = 'rgba(244,241,234,0.8)'; g.fillText(`${String(Math.floor(weather.hour)).padStart(2, '0')}:${String(Math.floor(weather.hour % 1 * 60)).padStart(2, '0')}`, 14, H2 - 10); }
  // you: a white arrowhead with a dark edge, in a faint ring
  g.strokeStyle = 'rgba(244,241,234,0.28)'; g.lineWidth = 1.5; g.beginPath(); g.arc(cx, cy, 17, 0, TAU); g.stroke();
  g.fillStyle = '#f4f1ea'; g.strokeStyle = '#16151a'; g.lineWidth = 2.5; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(cx, cy - 11); g.lineTo(cx + 8, cy + 9); g.lineTo(cx, cy + 4); g.lineTo(cx - 8, cy + 9); g.closePath(); g.stroke(); g.fill();
  g.restore();
  // north (+z), on the rim
  const dirX = sh, dirY = -ch, tx = Math.abs(dirX) > 1e-6 ? (dirX > 0 ? (W2 - 14 - cx) / dirX : (14 - cx) / dirX) : Infinity, ty = Math.abs(dirY) > 1e-6 ? (dirY > 0 ? (H2 - 14 - cy) / dirY : (14 - cy) / dirY) : Infinity;
  const tt = Math.min(tx, ty), Nx = cx + dirX * tt, Ny = cy + dirY * tt;
  g.fillStyle = 'rgba(18,16,24,0.9)'; g.beginPath(); g.arc(Nx, Ny, 10, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(244,241,234,0.5)'; g.lineWidth = 1; g.stroke();
  g.fillStyle = '#f4f1ea'; g.font = '700 12px "Chakra Petch", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('N', Nx, Ny + 1);
  g.strokeStyle = 'rgba(8,10,16,0.9)'; g.lineWidth = 3; g.beginPath(); g.roundRect(1.5, 1.5, W2 - 3, H2 - 3, 14); g.stroke();
  g.strokeStyle = 'rgba(243,236,228,0.3)'; g.lineWidth = 1; g.beginPath(); g.roundRect(3.5, 3.5, W2 - 7, H2 - 7, 12); g.stroke();
}

/* ---------------- GPS: a waypoint you set on the map (Tab, click), and the route to the job ---------------- */
// Routes follow the street network (the same Dijkstra the traffic uses), recomputed about once a second.
const gps = (() => {
  const cells = [];
  const goals = city.nodes.filter(n => n.out.length && n.in.length);
  const G = { waypoint: null, routes: { way: null, job: null }, t: 0, flip: 0, jobKey: '' };
  function startLink() {
    city.cellsNear(car.x, car.z, 45, cells);
    let best = null, bd = Infinity;
    const moving = Math.hypot(car.vx, car.vz) > 3, hv = Math.atan2(car.vx, car.vz);
    for (const c of cells) {
      if (Math.abs(c.y - car.y) > 4 || c.link.kind === 'ramp') continue;
      const pts = c.link.lanes[c.lane].pts, a = pts[c.si], b = pts[c.si + 1];
      const al = Math.cos(Math.atan2(b.x - a.x, b.z - a.z) - (moving ? hv : car.h));
      const d = (c.x - car.x) ** 2 + (c.z - car.z) ** 2 + (1 - al) * 600;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  function plan(target) {
    const from = startLink();
    let goal = null, gd = Infinity;
    for (const n of goals) { const d = (n.x - target.x) ** 2 + (n.z - target.z) ** 2; if (d < gd) { gd = d; goal = n; } }
    if (!from || !goal) return null;
    const links = from.link.to === goal ? [] : city.route(from.link, goal);
    if (!links) return null;
    const pts = [{ x: car.x, z: car.z }];
    const add = (L, i0 = 0) => { const P = L.lanes[0].pts; for (let i = i0; i < P.length; i += 2) pts.push(P[i]); pts.push(P[P.length - 1]); };
    add(from.link, from.si);
    for (const L of links) add(L);
    pts.push({ x: target.x, z: target.z });
    // the lane points begin a little behind the car: drop those, so the line leaves the car going forwards
    let k = 0, kd = Infinity; for (let i = 1; i < Math.min(pts.length - 1, 14); i++) { const d = (pts[i].x - car.x) ** 2 + (pts[i].z - car.z) ** 2; if (d < kd) { kd = d; k = i; } }
    if (k && pts.length - k > 2) pts.splice(1, k);
    return pts;
  }
  function jobTarget() { return street?.goal || missions?.target || null; }
  G.update = dt => {
    const W = G.waypoint;
    if (W && Math.hypot(W.x - car.x, W.z - car.z) < 25) { G.waypoint = null; G.routes.way = null; }
    if ((G.t -= dt) > 0) return;
    G.t = 0.6; G.flip ^= 1;
    if (G.flip) G.routes.way = G.waypoint ? plan(G.waypoint) : null;
    else { const j = jobTarget(); G.routes.job = j && Math.hypot(j.x - car.x, j.z - car.z) > 40 ? plan(j) : null; }
  };
  function line(g, pts, X, Y, col, w) {
    if (!pts) return;
    g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = w + 3; g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(X(p.x, p.z), Y(p.x, p.z)) : g.moveTo(X(p.x, p.z), Y(p.x, p.z))); g.stroke();
    g.strokeStyle = col; g.lineWidth = w; g.stroke();
  }
  G.draw = (g, X, Y, w) => { g.save(); g.lineCap = g.lineJoin = 'round'; line(g, G.routes.job, X, Y, '#f2c12e', w); line(g, G.routes.way, X, Y, '#b46cff', w); g.restore(); };
  // the waypoint pin; off the edge of the radar it sits on the rim pointing the way
  G.drawPin = (g, X, Y, W2, H2) => {
    const W = G.waypoint; if (!W) return;
    let x = X(W.x, W.z), y = Y(W.x, W.z);
    if (W2) { x = clamp(x, 10, W2 - 10); y = clamp(y, 10, H2 - 10); }
    g.fillStyle = '#b46cff'; g.strokeStyle = '#16151a'; g.lineWidth = 2;
    g.beginPath(); g.arc(x, y - 6, 6, Math.PI, 0); g.lineTo(x, y + 4); g.closePath(); g.fill(); g.stroke();
  };
  G.set = (x, z) => {
    if (G.waypoint && Math.hypot(G.waypoint.x - x, G.waypoint.z - z) < 60) { G.waypoint = null; G.routes.way = null; return false; }
    G.waypoint = { x, z }; G.t = 0; G.flip = 0; return true;
  };
  return G;
})();
// Full map (Tab): the painted valley filling the screen, GTA-style. Scroll to zoom (towards the cursor), drag to
// pan, click to drop a waypoint (click the pin to clear it). Place names, road names and the freeway's shields are
// drawn fresh each frame, so they stay sharp at any zoom; the routes, blips, traffic and you sit on top, with a
// legend, a scale bar, a compass and the name of whatever is under the cursor.
const bigMap = { open: false, base: null, z: 0, cx: 0, cz: 0, zMin: 0.05, zMax: 1.5, last: -1e9, mx: -1, my: -1, drag: null, hover: null };
// What the map names besides the towns: the summit, the wind farm, the named roads (each once, on its longest
// stretch, turned to lie along it) and where the freeway's shields go
const MAP_FEATURES = (() => {
  let peak = { x: 2350, z: 2350, h: 0 };
  for (let x = 1900; x <= 2800; x += 30) for (let z = 1900; z <= 2800; z += 30) { const h = city.groundAt(x, z); if (h > peak.h) peak = { x, z, h }; }
  const T = city.country.turbines, wind = T.length ? { x: T.reduce((s, t) => s + t.x, 0) / T.length, z: T.reduce((s, t) => s + t.z, 0) / T.length } : null;
  const longest = new Map();
  for (const m of city.mapLines) { if (!m.name) continue; const b = longest.get(m.name); if (!b || m.pts.length > b.pts.length) longest.set(m.name, m); }
  const roadNames = [...longest].map(([name, m]) => {
    const i = m.pts.length >> 1, a = m.pts[Math.max(0, i - 15)], b = m.pts[Math.min(m.pts.length - 1, i + 15)];
    let ang = Math.atan2(-(b.z - a.z), -(b.x - a.x)); if (Math.cos(ang) < 0) ang += Math.PI; // never upside down
    return { name, x: m.pts[i].x, z: m.pts[i].z, a: ang, kind: m.kind };
  });
  const fw = city.mapLines.filter(m => m.kind === 'fwy').sort((a, b) => b.pts.length - a.pts.length)[0];
  const shields = fw ? [0.14, 0.38, 0.62, 0.86].map(t => fw.pts[Math.round(t * (fw.pts.length - 1))]) : [];
  return { peak, wind, roadNames, shields };
})();
// Everywhere with a blip and a name, for the tooltip
function mapPlaces() {
  const out = [], pl = street?.places;
  if (pl) { out.push({ x: pl.GARAGE.x, z: pl.GARAGE.z, name: "Marlowe's Garage", sub: 'Jobs' }); for (const s of pl.SHOPS) out.push({ x: s.x, z: s.z, name: s.name, sub: 'Customs shop' }); }
  if (empire) for (const id in empire.sites) {
    const p = empire.sites[id].point, b = empire.empire.biz(id);
    out.push({ x: p.x, z: p.z, name: b.name, sub: empire.empire.state.owned[id] ? 'Yours' : 'For sale · $' + b.price.toLocaleString('en-US') });
  }
  return out;
}
function mapLabel(g, text, x, y, font, fill, spacing = 0) {
  g.font = font; if ('letterSpacing' in g) g.letterSpacing = spacing + 'px';
  g.lineJoin = 'round'; g.lineWidth = 4; g.strokeStyle = 'rgba(12,14,20,0.88)'; g.strokeText(text, x, y);
  g.fillStyle = fill; g.fillText(text, x, y);
  if ('letterSpacing' in g) g.letterSpacing = '0px';
}
function mapArrow(g, x, y, h, s = 1) { // you: a white arrowhead with a dark edge
  g.save(); g.translate(x, y); g.rotate(-h); g.scale(s, s);
  g.fillStyle = '#f4f1ea'; g.strokeStyle = '#16151a'; g.lineWidth = 2.5; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(0, -13); g.lineTo(9, 10); g.lineTo(0, 5); g.lineTo(-9, 10); g.closePath(); g.stroke(); g.fill();
  g.restore();
}
const MAP_LEGEND = [['you', 'You'], ['pin', 'Waypoint'], ['way', 'Route to the waypoint'], ['job', 'Route to the job'], ['garage', "Marlowe's Garage"], ['shop', 'Apex Customs'], ['goal', 'Objective'], ['sale', 'Business for sale'], ['mine', 'Your business'], ['cop', 'Police']];
function mapLegendIcon(g, kind, x, y) {
  const disc = (col, label) => { g.fillStyle = col; g.strokeStyle = '#16151a'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 7, 0, TAU); g.fill(); g.stroke(); g.fillStyle = '#16151a'; g.font = '700 10px sans-serif'; g.textAlign = 'center'; g.fillText(label, x, y + 0.5); };
  const square = col => { g.fillStyle = col; g.strokeStyle = '#16151a'; g.lineWidth = 1.5; g.beginPath(); g.rect(x - 6, y - 6, 12, 12); g.fill(); g.stroke(); g.fillStyle = '#16151a'; g.font = 'bold 9px sans-serif'; g.textAlign = 'center'; g.fillText('$', x, y + 0.5); };
  const line = col => { g.lineCap = 'round'; g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = 7; g.beginPath(); g.moveTo(x - 8, y); g.lineTo(x + 8, y); g.stroke(); g.strokeStyle = col; g.lineWidth = 4; g.stroke(); };
  if (kind === 'you') mapArrow(g, x, y + 1, 0, 0.6);
  else if (kind === 'pin') { g.fillStyle = '#b46cff'; g.strokeStyle = '#16151a'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y - 3, 5, Math.PI, 0); g.lineTo(x, y + 6); g.closePath(); g.fill(); g.stroke(); }
  else if (kind === 'way') line('#b46cff');
  else if (kind === 'job') line('#f2c12e');
  else if (kind === 'garage') disc('#ffcf3a', 'M');
  else if (kind === 'shop') disc('#4fa3ff', '$');
  else if (kind === 'goal') disc('#53e4c1', '!');
  else if (kind === 'sale') square('rgba(216,230,255,.9)');
  else if (kind === 'mine') square('#ffb547');
  else if (kind === 'cop') { g.fillStyle = '#4f7bff'; g.strokeStyle = '#16151a'; g.lineWidth = 1.5; g.beginPath(); g.rect(x - 4, y - 4, 8, 8); g.fill(); g.stroke(); }
}
function drawBigMap() {
  const cv = el('bigmap'), W = innerWidth, H = innerHeight, dpr = Math.min(devicePixelRatio || 1, 2), now = performance.now(), ext = WORLD.ext;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d'), B = bigMap, F = MAP_FEATURES;
  B.zMin = Math.min(W, H) / (2 * ext) * 0.94; B.zMax = WORLD.sc * 2.3;
  if (now - B.last > 400) { B.z = B.zMin * 2.6; B.cx = car.x; B.cz = car.z; B.drag = null; } // just opened: on you, close enough to read the streets
  B.last = now;
  B.z = clamp(B.z, B.zMin, B.zMax); B.cx = clamp(B.cx, -ext, ext); B.cz = clamp(B.cz, -ext, ext);
  const Z = B.z, zt = clamp(Math.log(Z / B.zMin) / Math.log(B.zMax / B.zMin), 0, 1); // 0: the whole valley .. 1: right in
  const SX = x => W / 2 - (x - B.cx) * Z, SY = z => H / 2 - (z - B.cz) * Z; // east (-x) to the right, north (+z) up
  const X = (x, z) => SX(x), Y = (x, z) => SY(z);
  const on = (x, y, m = 40) => x > -m && y > -m && x < W + m && y < H + m;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#0d131b'; g.fillRect(0, 0, W, H);
  g.lineCap = 'round'; g.lineJoin = 'round';
  if (WORLD.ready) {
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(WORLD.canvas, SX(ext), SY(ext), WORLD.S * Z / WORLD.sc, WORLD.S * Z / WORLD.sc);
  } else { // the painting isn't finished yet: the bare road network will do
    g.fillStyle = '#1b222b'; g.fillRect(SX(ext), SY(ext), 2 * ext * Z, 2 * ext * Z);
    for (const kind of MAP_ORDER) {
      const [col, w] = ROAD_STYLE[kind];
      g.strokeStyle = col; g.lineWidth = Math.max(1.1, w * Z);
      g.beginPath();
      for (const m of city.mapLines) {
        if (m.kind !== kind) continue;
        const st = m.pts.length > 40 ? 4 : 1;
        for (let i = 0; i < m.pts.length; i += st) { const q = m.pts[i]; i ? g.lineTo(SX(q.x), SY(q.z)) : g.moveTo(SX(q.x), SY(q.z)); }
        const l = m.pts[m.pts.length - 1]; g.lineTo(SX(l.x), SY(l.z));
      }
      g.stroke();
    }
  }
  // a 500 m grid, and the edge of the sheet
  g.strokeStyle = 'rgba(10,14,22,0.1)'; g.lineWidth = 1; g.beginPath();
  for (let v = -3000; v <= 3000; v += 500) { g.moveTo(SX(v), SY(ext)); g.lineTo(SX(v), SY(-ext)); g.moveTo(SX(ext), SY(v)); g.lineTo(SX(-ext), SY(v)); }
  g.stroke();
  g.strokeStyle = 'rgba(243,236,228,0.4)'; g.lineWidth = 1.5; g.strokeRect(SX(ext), SY(ext), 2 * ext * Z, 2 * ext * Z);

  /* names */
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (Z > B.zMin * 1.6) for (const r of F.roadNames) { // along the road, just clear of it
    const x = SX(r.x), y = SY(r.z); if (!on(x, y, 100)) continue;
    g.save(); g.translate(x, y); g.rotate(r.a);
    mapLabel(g, r.name, 0, -(8 + 5 * Z), `600 ${Math.round(11 + 3 * zt)}px "IBM Plex Mono", monospace`, r.kind === 'hwy' ? '#ffe7a0' : '#f3ece4', 0.5);
    g.restore();
  }
  for (const p of F.shields) { // I-9
    const x = SX(p.x), y = SY(p.z); if (!on(x, y)) continue;
    g.beginPath(); g.moveTo(x - 10, y - 10); g.lineTo(x + 10, y - 10); g.quadraticCurveTo(x + 11, y + 4, x, y + 12); g.quadraticCurveTo(x - 11, y + 4, x - 10, y - 10); g.closePath();
    g.fillStyle = '#24509c'; g.fill(); g.strokeStyle = '#f4f1ea'; g.lineWidth = 1.6; g.stroke();
    g.fillStyle = '#c8322c'; g.fillRect(x - 8.6, y - 8.8, 17.2, 4.4);
    g.fillStyle = '#ffffff'; g.font = '700 11px "Chakra Petch", sans-serif'; g.fillText('9', x, y + 2.5);
  }
  if (F.wind) { const x = SX(F.wind.x), y = SY(F.wind.z); if (on(x, y, 120)) mapLabel(g, 'Wind farm', x, y + 18 + 40 * Z, `italic 500 ${Math.round(12 + 3 * zt)}px "IBM Plex Mono", monospace`, '#e9eef2', 1); }
  { // the summit: a spot height
    const x = SX(F.peak.x), y = SY(F.peak.z);
    if (on(x, y, 120)) {
      g.fillStyle = '#16151a'; g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x + 6, y + 5); g.lineTo(x - 6, y + 5); g.closePath(); g.fill();
      mapLabel(g, 'MOUNT ASHBY', x, y - 20, `700 ${Math.round(13 + 5 * zt)}px "Chakra Petch", sans-serif`, '#ffffff', 2.5);
      mapLabel(g, Math.round(F.peak.h) + ' m', x, y + 17, `500 ${Math.round(11 + 2 * zt)}px "IBM Plex Mono", monospace`, '#e9eef2', 0);
    }
  }
  for (const l of city.labels) {
    if (l.kind === 'road') continue; // the freeway wears its shields instead
    const x = SX(l.x), y = SY(l.z); if (!on(x, y, 160)) continue;
    if (l.kind === 'river') mapLabel(g, l.name, x, y, `italic 500 ${Math.round(13 + 4 * zt)}px "IBM Plex Mono", monospace`, '#c4e6f7', 2);
    else {
      const size = (l === city.labels[0] ? 20 : l.kind === 'town' ? 15 : 12) + 7 * zt; // the city, the towns, the villages
      mapLabel(g, l.name.toUpperCase(), x, y, `700 ${Math.round(size)}px "Chakra Petch", sans-serif`, l.kind === 'town' ? '#ffffff' : '#f2ead8', l.kind === 'town' ? 3 : 2);
    }
  }

  /* routes, blips, the police, traffic and you */
  gps.draw(g, X, Y, clamp(10 * Z, 3.5, 7));
  missions?.drawMap(g, X, Y); empire?.drawMap(g, X, Y); street?.drawMap(g, X, Y);
  const PS = police.state;
  if (PS.level && !PS.seen && PS.lastSeen) {
    g.strokeStyle = (now / 400 | 0) % 2 ? 'rgba(255,70,70,0.8)' : 'rgba(80,120,255,0.8)'; g.fillStyle = 'rgba(255,70,70,0.1)'; g.lineWidth = 2;
    g.beginPath(); g.arc(SX(PS.lastSeen.x), SY(PS.lastSeen.z), police.zoneR() * Z, 0, TAU); g.fill(); g.stroke();
  }
  g.strokeStyle = 'rgba(16,18,24,0.75)'; g.lineWidth = 1;
  for (const v of traffic.vehicles) {
    if (v.state === 'idle' || (!v.police && Z < B.zMin * 1.5)) continue;
    const x = SX(v.x), y = SY(v.z), s = v.police ? 4 : 2.5;
    g.fillStyle = v.police ? (v.state === 'pursue' && (now / 250 | 0) % 2 ? '#ff3b3b' : '#4f7bff') : 'rgba(243,236,228,0.92)';
    g.fillRect(x - s, y - s, 2 * s, 2 * s); g.strokeRect(x - s, y - s, 2 * s, 2 * s);
  }
  gps.drawPin(g, X, Y);
  { // you, with a ring that pulses outwards; out of view, a smaller arrow at the edge points the way back to you
    const x = SX(car.x), y = SY(car.z), pulse = (now % 1600) / 1600;
    if (on(x, y, 0)) {
      g.strokeStyle = `rgba(244,241,234,${0.6 * (1 - pulse)})`; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 12 + 24 * pulse, 0, TAU); g.stroke();
      mapArrow(g, x, y, car.h);
    } else {
      const dx = x - W / 2, dy = y - H / 2, k = Math.min((W / 2 - 40) / Math.abs(dx || 1e-6), (H / 2 - 110) / Math.abs(dy || 1e-6));
      mapArrow(g, W / 2 + dx * k, H / 2 + dy * k, -Math.atan2(dx, -dy), 0.8);
    }
  }

  /* what's under the cursor */
  B.hover = null;
  const inside = B.mx >= 0 && B.my >= 0 && B.mx <= W && B.my <= H;
  if (inside && !B.drag?.moved) { let bd = 16; for (const p of mapPlaces()) { const d = Math.hypot(SX(p.x) - B.mx, SY(p.z) - B.my); if (d < bd) { bd = d; B.hover = p; } } }
  if (B.hover) {
    const p = B.hover, x = SX(p.x), y = SY(p.z);
    g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 12, 0, TAU); g.stroke();
    g.font = '700 14px "Chakra Petch", sans-serif'; const w1 = g.measureText(p.name).width;
    g.font = '500 11px "IBM Plex Mono", monospace'; const w = Math.max(w1, g.measureText(p.sub).width) + 22;
    const bx = clamp(x + 18, 8, W - w - 8), by = clamp(y - 22, 8, H - 52);
    g.fillStyle = 'rgba(14,16,24,0.92)'; g.strokeStyle = 'rgba(243,236,228,0.3)'; g.lineWidth = 1; g.beginPath(); g.roundRect(bx, by, w, 44, 8); g.fill(); g.stroke();
    g.textAlign = 'left'; g.fillStyle = '#f4f1ea'; g.font = '700 14px "Chakra Petch", sans-serif'; g.fillText(p.name, bx + 11, by + 15);
    g.fillStyle = '#ffb547'; g.font = '500 11px "IBM Plex Mono", monospace'; g.fillText(p.sub, bx + 11, by + 32);
  }

  /* the frame: title and where you are, the legend, a scale bar, a compass and the controls */
  const top = g.createLinearGradient(0, 0, 0, 96); top.addColorStop(0, 'rgba(8,10,16,0.82)'); top.addColorStop(1, 'rgba(8,10,16,0)');
  g.fillStyle = top; g.fillRect(0, 0, W, 96);
  const bot = g.createLinearGradient(0, H - 90, 0, H); bot.addColorStop(0, 'rgba(8,10,16,0)'); bot.addColorStop(1, 'rgba(8,10,16,0.82)');
  g.fillStyle = bot; g.fillRect(0, H - 90, W, 90);
  const km = m => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m / 10) * 10 + ' m';
  let line = 'YOU · ' + (city.zoneAt(car.x, car.z, true) || 'Open country').toUpperCase();
  const way = gps.routes.way;
  if (gps.waypoint) { let d = 0; if (way) for (let i = 1; i < way.length; i++) d += Math.hypot(way[i].x - way[i - 1].x, way[i].z - way[i - 1].z); else d = Math.hypot(gps.waypoint.x - car.x, gps.waypoint.z - car.z); line += '   ·   WAYPOINT · ' + km(d) + (way ? ' by road' : ''); }
  if (inside && !B.hover) { const wx = B.cx - (B.mx - W / 2) / Z, wz = B.cz - (B.my - H / 2) / Z; if (Math.abs(wx) < ext && Math.abs(wz) < ext) line += '   ·   CURSOR · ' + (city.zoneAt(wx, wz, true) || 'Open country').toUpperCase() + ' · ' + km(Math.hypot(wx - car.x, wz - car.z)); }
  g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = '500 13px "IBM Plex Mono", monospace';
  g.fillStyle = 'rgba(14,16,24,0.9)'; g.strokeStyle = 'rgba(243,236,228,0.22)'; g.lineWidth = 1; g.beginPath(); g.roundRect(12, 12, Math.max(300, g.measureText(line).width + 28), WORLD.ready ? 66 : 88, 12); g.fill(); g.stroke();
  g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillStyle = '#f4f1ea'; g.font = '700 26px "Chakra Petch", sans-serif'; if ('letterSpacing' in g) g.letterSpacing = '5px';
  g.fillText('ASHBY VALLEY', 24, 34); if ('letterSpacing' in g) g.letterSpacing = '0px';
  g.fillStyle = 'rgba(243,236,228,0.82)'; g.font = '500 13px "IBM Plex Mono", monospace'; g.fillText(line, 25, 62);
  if (!WORLD.ready) { g.fillStyle = '#ffb547'; g.fillText('Surveying the valley…', 25, 84); }
  if (W >= 760 && H >= 480) {
    const lw = 222, lx = W - lw - 12, ly = 12, lh = 44 + MAP_LEGEND.length * 23;
    g.fillStyle = 'rgba(14,16,24,0.9)'; g.strokeStyle = 'rgba(243,236,228,0.22)'; g.lineWidth = 1; g.beginPath(); g.roundRect(lx, ly, lw, lh, 12); g.fill(); g.stroke();
    g.fillStyle = 'rgba(243,236,228,0.6)'; g.font = '600 11px "IBM Plex Mono", monospace'; g.textAlign = 'left'; g.fillText('LEGEND', lx + 16, ly + 20);
    MAP_LEGEND.forEach(([kind, name], i) => {
      const y = ly + 46 + i * 23;
      g.textBaseline = 'middle'; mapLegendIcon(g, kind, lx + 26, y);
      g.textAlign = 'left'; g.fillStyle = '#f4f1ea'; g.font = '500 13px "Chakra Petch", sans-serif'; g.fillText(name, lx + 48, y + 0.5);
    });
  }
  { // scale bar: a round number of metres about 130 px long
    const want = 130 / Z, pow = 10 ** Math.floor(Math.log10(want)), nice = [1, 2, 5, 10].map(m => m * pow).filter(v => v <= want).pop(), len = nice * Z, x = 24, y = H - 52;
    g.fillStyle = '#16151a'; g.fillRect(x - 1, y - 1, len + 2, 7);
    g.fillStyle = '#f4f1ea'; g.fillRect(x, y, len / 2, 5); g.fillStyle = '#8b8f98'; g.fillRect(x + len / 2, y, len / 2, 5);
    g.fillStyle = '#f4f1ea'; g.font = '500 12px "IBM Plex Mono", monospace'; g.textAlign = 'left'; g.fillText(nice >= 1000 ? nice / 1000 + ' km' : nice + ' m', x + len + 10, y + 3);
  }
  g.fillStyle = 'rgba(243,236,228,0.78)'; g.font = '500 13px "IBM Plex Mono", monospace'; g.textAlign = 'left';
  g.fillText(`Scroll to zoom · Drag to pan · ${gps.waypoint ? 'Click the pin to clear it' : 'Click to set a waypoint'} · Tab to close`, 24, H - 22);
  { // north is up
    const x = W - 50, y = H - 54;
    g.fillStyle = 'rgba(14,16,24,0.84)'; g.strokeStyle = 'rgba(243,236,228,0.3)'; g.lineWidth = 1; g.beginPath(); g.arc(x, y, 26, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = '#ff5a4e'; g.beginPath(); g.moveTo(x, y - 20); g.lineTo(x + 6, y + 2); g.lineTo(x - 6, y + 2); g.closePath(); g.fill();
    g.fillStyle = 'rgba(243,236,228,0.55)'; g.beginPath(); g.moveTo(x, y + 20); g.lineTo(x + 6, y + 2); g.lineTo(x - 6, y + 2); g.closePath(); g.fill();
    g.fillStyle = '#f4f1ea'; g.font = '700 11px "Chakra Petch", sans-serif'; g.textAlign = 'center'; g.fillText('N', x, y + 9);
  }
}
// The full map's mouse: the wheel zooms about the cursor, a drag pans, and a click that didn't turn into a drag
// drops (or picks up) the waypoint, on the place under the cursor if there is one
{
  const cv = el('bigmap'), B = bigMap;
  const at = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * innerWidth / r.width, y: (e.clientY - r.top) * innerHeight / r.height }; };
  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const p = at(e); B.drag = { x: p.x, y: p.y, cx: B.cx, cz: B.cz, moved: false };
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* no capture: the drag just ends at the edge */ }
  });
  cv.addEventListener('pointermove', e => {
    const p = at(e), d = B.drag; B.mx = p.x; B.my = p.y;
    if (!d || (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) < 5)) return;
    d.moved = true; B.cx = d.cx + (p.x - d.x) / B.z; B.cz = d.cz + (p.y - d.y) / B.z;
  });
  cv.addEventListener('pointerup', e => {
    const d = B.drag; B.drag = null;
    if (!d || d.moved || e.button !== 0) return;
    // on the pin (as it looks on screen, whatever the zoom) picks it up; anywhere else moves it there
    const p = at(e), wp = gps.waypoint, t = B.hover || { x: B.cx - (p.x - innerWidth / 2) / B.z, z: B.cz - (p.y - innerHeight / 2) / B.z };
    const onPin = wp && (B.hover ? Math.hypot(wp.x - t.x, wp.z - t.z) < 1 : Math.hypot(innerWidth / 2 - (wp.x - B.cx) * B.z - p.x, innerHeight / 2 - (wp.z - B.cz) * B.z - 4 - p.y) < 14);
    gps.waypoint = null; gps.routes.way = null;
    if (!onPin) gps.set(t.x, t.z);
  });
  cv.addEventListener('pointercancel', () => { B.drag = null; });
  cv.addEventListener('pointerleave', () => { B.mx = B.my = -1; });
  cv.addEventListener('mousemove', e => e.stopPropagation()); // panning the map isn't looking around
  cv.addEventListener('wheel', e => {
    e.preventDefault(); e.stopPropagation();
    const p = at(e), wx = B.cx - (p.x - innerWidth / 2) / B.z, wz = B.cz - (p.y - innerHeight / 2) / B.z;
    B.z = clamp(B.z * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0016)), B.zMin, B.zMax);
    B.cx = wx + (p.x - innerWidth / 2) / B.z; B.cz = wz + (p.y - innerHeight / 2) / B.z; // the point under the cursor stays put
  }, { passive: false });
}
// GTA-style HUD: the radar bottom-left with health and armour under it, stars and cash top-right, the weapon
// under the cash. H switches to the detailed driving HUD (telemetry, damage map, rev counter, controls).
const hudEl = { hpNum: el('hud-hp'), cash: el('hud-cash'), delta: el('hud-delta'), weapon: el('hud-weapon'), hp: el('hp-bar'), ar: el('ar-bar'), sp: el('sp-bar'), area: el('area-pop'), radio: el('radio-name') };
let shownCash = null, deltaUntil = 0;
function setHudMode(gta) {
  document.body.classList.toggle('gta', gta);
  try { localStorage.setItem('apex.hud', gta ? 'gta' : 'detailed'); } catch (e) { /* storage blocked: the mode just isn't remembered */ }
}
{ let m = null; try { m = localStorage.getItem('apex.hud'); } catch (e) {} setHudMode(m !== 'detailed'); }
function updateGtaHud() {
  const cash = career.state.cash;
  if (shownCash === null) shownCash = cash;
  if (cash !== shownCash) {
    const d = cash - shownCash; shownCash = cash; deltaUntil = performance.now() + 2500;
    hudEl.delta.textContent = (d > 0 ? '+' : '-') + '$' + Math.abs(d).toLocaleString('en-US');
    hudEl.delta.className = d > 0 ? 'up show' : 'down show';
  }
  hudEl.cash.textContent = '$' + cash.toLocaleString('en-US');
  if (deltaUntil && performance.now() > deltaUntil) { deltaUntil = 0; hudEl.delta.className = ''; }
  hudEl.hp.style.width = clamp(crime.health, 0, 100) + '%';
  hudEl.hpNum.innerHTML = `<i class="heart">♥</i>${Math.round(crime.health)}${crime.armor > 0 ? ` <i class="shield">◆</i>${Math.round(crime.armor)}` : ''}`;
  document.body.classList.toggle('lowhp', crime.health < 30 && started);
  hudEl.hp.classList.toggle('low', crime.health < 30);
  hudEl.ar.style.width = clamp(crime.armor, 0, 100) + '%';
  hudEl.sp.style.width = clamp(ability.v, 0, 1) * 100 + '%'; hudEl.sp.className = ability.on ? 'on' : ability.v <= 0.12 ? 'empty' : ''; hudEl.sp.style.background = ability.v <= 0.12 ? '' : CHARS[who.cur].color;
  if (phone.open) el('phone-time').textContent = `${String(Math.floor(weather.hour)).padStart(2, '0')}:${String(Math.floor(weather.hour % 1 * 60)).padStart(2, '0')}`;
  const w = crime.weapon, a = crime.ammo?.[w];
  hudEl.weapon.textContent = crime.onFoot && w > 0 && a ? `${['', 'PISTOL', 'SMG', 'SHOTGUN'][w]}  ${a.mag} / ${a.res}` : crime.onFoot && w === 0 ? 'FISTS' : '';
}
function updateHud() {
  drawMap(); updateGtaHud();
  if (bigMap.open) drawBigMap();
  const sp = Math.hypot(car.vx, car.vz) * 3.6;
  hud.speed.textContent = Math.round(sp);
  hud.gear.textContent = car.gear === 0 ? 'R' : car.gear === 1 ? 'N' : String(car.gear - 1);
  hud.mode.textContent = car.auto ? 'AUTO' : 'MANUAL';
  hud.rpm.textContent = `${Math.round(car.rpm / 10) * 10} rpm`;
  hud.kw.textContent = `${Math.round(car.power)} kW`;
  hud.g.textContent = (Math.abs(car.ay) / 9.81).toFixed(2);
  hud.slip.textContent = `${Math.abs(car.slipDeg).toFixed(1)}°`;
  hud.surf.textContent = car.surface[0].toUpperCase() + car.surface.slice(1);
  hud.cam.textContent = camModes[camMode] + (timeScale < 1 ? ' · ¼ speed' : '');
  hud.traffic.textContent = `${traffic.activeCount()} cars nearby`;
  hud.body.textContent = `${Math.round((soft.damage || 0) * 100)}% damage`;
  hud.engine.textContent = `${Math.round(harm.power * 100)}% power`;
  hud.engine.style.color = harm.engine > 0.4 ? 'var(--red)' : harm.engine > 0.05 ? 'var(--amber)' : '';
  hud.lost.textContent = lost.length ? lost.join(' · ') : 'No parts lost';
  if (crash.active && crash.dv > 1.5) crash.shown = performance.now() + 2600;
  if (crash.shown > performance.now()) {
    hud.impact.style.opacity = 1;
    hud.impact.innerHTML = `<b>IMPACT</b> ${Math.round(crash.speed * 3.6)} km/h <span>·</span> Δv ${Math.round(crash.dv * 3.6)} km/h <span>·</span> ${Math.round(crash.peakG)} g peak`;
  } else hud.impact.style.opacity = 0;
  const drifting = Math.abs(car.slipDeg) > 12 && Math.hypot(car.vx, car.vz) > 8;
  hud.drift.style.opacity = drifting ? 1 : 0;
  if (drifting) hud.drift.textContent = `DRIFT ${Math.round(Math.abs(car.slipDeg))}°`;
  drawTach();
}

/* ---------------- Visual sync ---------------- */
function syncCar(dt) {
  carGroup.position.set(car.x, car.y, car.z);
  carGroup.rotation.set(-Math.atan(car.slope), car.h, Math.atan(car.bank));
  // body pitch/roll on springs
  const pT = clamp(-car.ax * 0.007, -0.06, 0.06), rT = clamp(car.ay * 0.0085, -0.07, 0.07);
  car.pitchV += ((pT - car.pitch) * 120 - car.pitchV * 14) * dt; car.pitch += car.pitchV * dt;
  car.rollV += ((rT - car.rollA) * 120 - car.rollV * 14) * dt; car.rollA += car.rollV * dt;
  body.rotation.set(car.pitch, 0, car.rollA);
  body.position.y = 0.02 + Math.abs(car.rollA) * 0.2;
  if (soft.refresh()) applyDamage();
  // wheels ride on the deformed structure: pushed-back wheels toe out, pushed-in wheels lean
  for (const key of ['fl', 'fr', 'rl', 'rr']) {
    const w = W[key], dx = w.dx || 0, dz = w.dz || 0;
    w.steer.position.set(w.x + dx, w.y ?? P.R, w.z + dz);
    const camber = clamp(-dx * 1.4, -0.35, 0.35);
    const yaw = key[0] === 'f' ? car.steer + harm.toe : clamp(-dz * 0.6 * w.side, -0.2, 0.2);
    w.steer.rotation.set(0, yaw, camber);
    w.spin.rotation.x = key[0] === 'f' ? car.frontRot : car.rearRot;
  }
  const braking = car.brake > 0.1 && car.gear !== 0 || (car.gear === 0 && car.auto && car.throttle < 0.1 && car.brake > 0.1);
  const tailPart = kit.parts.find(pt => pt.name === 'Taillight'), tailOk = !tailPart || !tailPart.broken;
  tailMat.emissiveIntensity = (tailOk ? (braking || car.hb > 0.5 ? 4 : 0.8) : 0) * GLOW.k;
  tailGlow.intensity = tailOk ? (braking ? 3 : 0.4) : 0;
  headSpot.intensity = 2 * kit.parts.filter(pt => pt.name === 'Headlight' && !pt.broken).length * (1 + 6 * GLOW.n); headSpot.distance = 40 + 45 * GLOW.n; // by day a hint on the tarmac; by night what you drive by
  if (kit.heads) for (const hm of kit.heads) if (hm.material && hm.material.emissiveIntensity > 0) hm.material.emissiveIntensity = 3 * GLOW.k;
  crashEffects(dt);

  // skid marks & smoke from each wheel contact
  const s = Math.sin(car.h), c = Math.cos(car.h);
  const wheelPos = (lx, lz) => [car.x + c * lx + s * lz, car.z - s * lx + c * lz];
  const marks = [['rl', 0.82, -P.b, car.skidR], ['rr', -0.82, -P.b, car.skidR], ['fl', 0.82, P.a, car.skidF], ['fr', -0.82, P.a, car.skidF]];
  for (const [key, lx, lz, amt] of marks) {
    const [x, z] = wheelPos(lx, lz);
    if (amt > 0.15) {
      addSkid(key, x, z, amt);
      if (key[0] === 'r' && rand() < amt * 0.9) puff(x, z, amt, car.onSand, car.y + 0.35);
    } else lastMark[key] = null;
  }
  if (car.onSand && Math.hypot(car.vx, car.vz) > 6 && rand() < 0.5) { const [x, z] = wheelPos(rand() < 0.5 ? 0.82 : -0.82, -P.b); puff(x, z, 0.3, true, car.y + 0.35, car.surface === 'water' ? '#e8eef2' : '#8c7a5c'); }

  // the shadow box follows the view: centred a little ahead of the car, snapped to texels so edges don't crawl
  const ahead = 40, tex = (sun.shadow.camera.right - sun.shadow.camera.left) / sun.shadow.mapSize.x;
  shadowFocus.set(car.x + Math.sin(car.h) * ahead, car.y, car.z + Math.cos(car.h) * ahead);
  const lightX = shadowFocus.dot(shadowRight), lightY = shadowFocus.dot(shadowUp);
  shadowFocus.addScaledVector(shadowRight, Math.round(lightX / tex) * tex - lightX);
  shadowFocus.addScaledVector(shadowUp, Math.round(lightY / tex) * tex - lightY);
  sun.target.position.copy(shadowFocus);
  sun.position.copy(shadowFocus).addScaledVector(sunDir, 300);
  sky.position.copy(camera.position);
  { const hz = hazeAt(Math.atan2(camLook.x - camera.position.x, camLook.z - camera.position.z)), o = weather.cloud, l = (hz[0] * 0.3 + hz[1] * 0.59 + hz[2] * 0.11) * 0.8;
    scene.fog.color.setRGB(lerp(hz[0], l * 0.95, o), lerp(hz[1], l, o), lerp(hz[2], l * 1.07, o)); } // under cloud the haze goes grey
}

/* ---------------- Falling snow ---------------- */
// 9000 flakes in a 140 m box that travels with the camera; the falling, the drift and the wrap all happen on the GPU
const snow = (() => {
  if (!WINTER) return { update() {} };
  const N = 9000, BOX = 140, H = 60, pos = new Float32Array(N * 3), seedA = new Float32Array(N);
  for (let i = 0; i < N; i++) { pos[i * 3] = rand() * BOX; pos[i * 3 + 1] = rand() * H; pos[i * 3 + 2] = rand() * BOX; seedA[i] = rand(); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('seed', new THREE.BufferAttribute(seedA, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { t: { value: 0 }, cam: { value: new THREE.Vector3() }, scale: { value: 300 } },
    vertexShader: `attribute float seed; uniform float t; uniform vec3 cam; uniform float scale; varying float vA;
      void main(){
        vec3 p = position;
        p.y -= t * (1.1 + seed * 0.9);
        p.x += sin(t * (0.6 + seed) + seed * 40.0) * 0.8 + t * 0.4;
        p.z += cos(t * (0.5 + seed * 0.7) + seed * 17.0) * 0.8;
        vec3 o = cam - vec3(${BOX / 2}.0, ${H / 2}.0, ${BOX / 2}.0);
        p = mod(p - o, vec3(${BOX}.0, ${H}.0, ${BOX}.0)) + o;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        gl_PointSize = clamp(scale * (0.05 + seed * 0.05) / d, 1.0, 9.0);
        vA = smoothstep(${BOX / 2}.0, 20.0, d) * smoothstep(0.5, 2.0, d);
      }`,
    fragmentShader: `varying float vA; void main(){ vec2 q = gl_PointCoord - 0.5; float r = dot(q, q); if (r > 0.25) discard; gl_FragColor = vec4(vec3(0.97, 0.98, 1.0), vA * (1.0 - r * 4.0) * 0.9); }`,
  });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = 4; scene.add(pts);
  return { update(dt) { mat.uniforms.t.value += dt; mat.uniforms.cam.value.copy(camera.position); mat.uniforms.scale.value = innerHeight * 0.9; } };
})();

/* ---------------- Weather ---------------- */
// As in GTA V, a day is forty-eight minutes long (two real minutes to the game hour) and it starts at two in the
// afternoon. Towards seven the light goes amber, then blue; by half past eight it's night: the exposure comes down,
// the sky sinks to deep blue with stars, and every street lamp, lit window, headlight and sign is turned up to
// stand out against it. (The sun's place in the sky is the photograph's, so the moon rises exactly where it set.)
// And the weather turns: long clear spells, then cloud rolls in (the photographed sky drained to grey,
// the sun weak, the haze thick), then rain: streaks falling round the camera, the roads darkening and turning to
// mirrors, a fifth less grip on tarmac, the odd flash of lightning. Then it clears and the roads dry.
// Summer only: the winter valley has its snow.
const weather = (() => {
  const W = { cloud: 0, rain: 0, wet: 0, flash: 0, phase: 'clear', t: 240 + Math.random() * 180, hour: 14, night: 0, dusk: 0, update() {}, set() {}, setHour() {} };
  if (WINTER) return W;
  const N = 7000, BOX = 90, H = 44, pos = new Float32Array(N * 3), seedA = new Float32Array(N);
  for (let i = 0; i < N; i++) { pos[i * 3] = Math.random() * BOX; pos[i * 3 + 1] = Math.random() * H; pos[i * 3 + 2] = Math.random() * BOX; seedA[i] = Math.random(); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('seed', new THREE.BufferAttribute(seedA, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { t: { value: 0 }, cam: { value: new THREE.Vector3() }, scale: { value: 300 }, amt: { value: 0 } },
    vertexShader: `attribute float seed; uniform float t; uniform vec3 cam; uniform float scale; uniform float amt; varying float vA;
      void main(){
        vec3 p = position;
        p.y -= t * (21.0 + seed * 9.0); p.x += t * 2.4;
        vec3 o = cam - vec3(${BOX / 2}.0, ${H / 2}.0, ${BOX / 2}.0);
        p = mod(p - o, vec3(${BOX}.0, ${H}.0, ${BOX}.0)) + o;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        gl_PointSize = clamp(scale * (0.55 + seed * 0.5) / d, 3.0, 40.0);
        vA = step(seed, amt * 1.05) * smoothstep(${BOX / 2}.0, 12.0, d) * smoothstep(0.4, 1.5, d);
      }`,
    fragmentShader: `varying float vA; void main(){ vec2 q = gl_PointCoord - 0.5; if (vA < 0.01 || abs(q.x + q.y * 0.1) > 0.035) discard; gl_FragColor = vec4(vec3(0.78, 0.83, 0.9), vA * (1.0 - abs(q.y) * 2.0) * 0.42); }`,
  });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = 4; pts.visible = false; scene.add(pts);
  const sunCol = sun.color.clone(), sunI = sun.intensity, hemiI = hemi.intensity, fog0 = scene.fog.density, expo0 = renderer.toneMappingExposure, grey = new THREE.Color('#aab4c2');
  const NEXT = { clear: ['cloud', 50, 80], cloud: ['rain', 110, 170], rain: ['clearing', 45, 70], clearing: ['clear', 280, 480] };
  const WANT = { clear: [0, 0], cloud: [0.8, 0], rain: [1, 1], clearing: [0.45, 0] };
  let flashT = 6;
  const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const nightAt = h => h >= 12 ? sm(18.6, 20.6, h) : 1 - sm(4.4, 6.4, h), duskAt = h => Math.max(0, 1 - Math.abs(h - 19.1) / 1.4, 1 - Math.abs(h - 5.9) / 1.4);
  const amber = new THREE.Color('#ff9a55'), moon = new THREE.Color('#9fb6ff'), DAY_SECS = 48 * 60;
  W.setHour = h => { W.hour = ((h % 24) + 24) % 24; };
  W.set = (phase, secs) => { if (WANT[phase]) { W.phase = phase; W.t = secs ?? 120; } };
  W.jump = phase => { W.set(phase, 600); [W.cloud, W.rain] = WANT[W.phase]; W.wet = W.rain; }; // for tests and screenshots: straight there
  W.update = (dt, real) => {
    if ((W.t -= dt) <= 0) { const [p, a, b] = NEXT[W.phase]; W.phase = p; W.t = a + Math.random() * (b - a); }
    const [c, r] = WANT[W.phase], k = 1 - Math.exp(-dt / 9);
    W.cloud += (c - W.cloud) * k; W.rain += (r - W.rain) * k;
    W.wet = clamp(W.wet + (W.rain > 0.3 ? dt / 14 : -dt / 75), 0, 1); // soaked in a quarter of a minute, a good minute to dry
    // lightning: a white flicker now and then when it's really coming down
    if (W.rain > 0.8 && (flashT -= dt) <= 0) { flashT = 9 + Math.random() * 22; W.flash = 1; }
    W.flash = Math.max(0, W.flash - real * 5);
    W.hour = (W.hour + dt * 24 / DAY_SECS) % 24;
    const o = W.cloud, n = W.night = nightAt(W.hour), dk = W.dusk = duskAt(W.hour) * (1 - 0.7 * o), gk = 1 + 2.6 * n;
    GLOW.n = n; GLOW.k = gk; city.setNight(n, gk);
    skyMat.uniforms.winter.value = 0.82 * o; skyMat.uniforms.night.value = n; skyMat.uniforms.dusk.value = dk; skyMat.uniforms.starK.value = 2.4 * (1 - o) * n;
    sun.intensity = sunI * (1 - 0.66 * o) * (1 - 0.76 * n) + W.flash * 2 * gk; sun.color.copy(sunCol).lerp(grey, o * 0.8).lerp(amber, dk * 0.75).lerp(moon, n * 0.85);
    hemi.intensity = (hemiI + 0.24 * o) * (1 - 0.35 * n) + W.flash * 1.5 * gk;
    scene.fog.density = fog0 + 0.00042 * o + 0.0005 * W.rain;
    renderer.toneMappingExposure = expo0 * (1 - 0.1 * o) * (1 - 0.55 * n);
    const u = post.finalMat.uniforms; u.sat.value = (1.08 - 0.16 * o) * (1 - 0.2 * n) + 0.08 * dk;
    u.highTint.value.set(lerp(1.05 - 0.05 * o, 0.88, n) + 0.05 * dk, lerp(1.012 - 0.008 * o, 0.97, n), lerp(0.935 + 0.075 * o, 1.12, n) - 0.06 * dk);
    u.shadowTint.value.set(lerp(0.95, 0.72, n) + 0.03 * dk, lerp(0.99, 0.88, n), lerp(1.05, 1.26, n));
    post.fx.shaftAmt = 0.3 * (1 - o) * (1 - n);
    city.setWet(W.wet);
    pts.visible = W.rain > 0.02;
    if (pts.visible) { mat.uniforms.t.value += dt; mat.uniforms.amt.value = W.rain; mat.uniforms.cam.value.copy(camera.position); mat.uniforms.scale.value = innerHeight * 0.9; }
  };
  return W;
})();

/* ---------------- Loop ---------------- */
const post = createPost(renderer, scene, camera);
post.fx.sunDir = sunDir;
if (WINTER) { const u = post.finalMat.uniforms; u.sat.value = 1.02; u.highTint.value.set(1.01, 1.0, 0.99); u.contrast.value = 0.12; } // the snowed-in valley keeps its cold, flat light
// Graphics quality (G cycles; drops automatically if the frame rate can't be held): resolution cap, shadow map
// size, ambient occlusion, bloom
const QUALITY = [
  { name: 'Low', dpr: 1.0, shadow: 1024, ao: false, bloom: 0, grass: false, msaa: 0 },
  { name: 'Medium', dpr: 1.25, shadow: 2048, ao: true, bloom: 0.05, grass: true, msaa: 2 },
  { name: 'High', dpr: 1.5, shadow: 3072, ao: true, bloom: 0.05, grass: true, msaa: 4 },
];
// start at Medium; the frame-rate watcher steps up to High when there's room, down when there isn't
let quality = 1, qualityPinned = false, upT = 0;
function setQuality(q, auto = false, silent = false) {
  quality = q; const Q = QUALITY[q];
  post.ao = Q.ao; post.finalMat.uniforms.bloom.value = Q.bloom; post.fx.shafts = q > 0; grass.enabled = Q.grass && !WINTER; // under snow, no grass post.setSamples(Q.msaa);
  if (sun.shadow.mapSize.x !== Q.shadow) { sun.shadow.mapSize.set(Q.shadow, Q.shadow); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
  if (pixelRatio > Q.dpr) { pixelRatio = Math.min(devicePixelRatio, Q.dpr); renderer.setPixelRatio(pixelRatio); resize(); }
  if (silent) return;
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  { t.innerHTML = `<b>GRAPHICS</b> ${Q.name}${auto ? ' <span>(auto)</span>' : ''}`; t.style.opacity = 1; clearTimeout(setQuality.t); setQuality.t = setTimeout(() => { t.style.opacity = 0; }, 1600); }
}
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  post.setSize(w * pixelRatio, h * pixelRatio);
}
addEventListener('resize', resize); resize();
setQuality(quality, false, true);

let started = false;
const startEl = el('start');
// Car picker: the same cards serve the start screen and the in-game garage (V)
function clearDrivingInput() {
  for (const k in keys) keys[k] = false; for (const k in touch) touch[k] = 0;
  // a menu opening also lets go of the trigger and hands the pointer back so its buttons can be clicked
  crime?.mouseButton(0, false); crime?.mouseButton(2, false);
  if (document.pointerLockElement) document.exitPointerLock?.();
}
function renderCards(container, onPick) {
  container.innerHTML = '';
  const starting = container.id === 'start-cards';
  const filter = el('garage-filter').value;
  const cars = PRESETS.filter(pr => starting ? career.state.owned.includes(pr.id) : filter === 'all' || (filter === 'owned' ? career.state.owned.includes(pr.id) : pr.kind === filter));
  cars.forEach(pr => {
    const owned = career.state.owned.includes(pr.id), locked = career.level < pr.level;
    const hp = Math.round(pr.peak * pr.redline * 0.8 * TAU / 60 / 1000 * 1.341);
    const b = document.createElement('button');
    b.className = 'card' + (pr === preset ? ' on' : ''); b.dataset.car = pr.id;
    b.disabled = selectingCar || (!owned && (locked || career.state.cash < pr.price)) || (!starting && !!missions?.engine.active);
    b.innerHTML = `<img class="car-preview" src="assets/cars/previews/${pr.id}.jpg" alt="" loading="lazy"><span class="sw" style="background:rgb(${pr.paint.map(c => Math.round(Math.pow(c, 1 / 2.2) * 255)).join(',')})"></span>
      <b>${pr.name}</b><i>${pr.kind}</i><span class="spec">${hp} hp · ${pr.mass} kg · ${pr.drive.toUpperCase()}</span><em>${pr.blurb}</em>${statBars(pr.id)}<strong class="car-price">${owned ? (pr === preset ? 'CURRENT · DRIVE' : 'OWNED · DRIVE') : locked ? 'RANK ' + pr.level + ' · $' + pr.price.toLocaleString() : 'BUY · $' + pr.price.toLocaleString()}</strong>`;
    b.addEventListener('click', async e => { e.stopPropagation(); await onPick(pr); }); container.appendChild(b);
  });
  el('garage-balance').textContent = '$' + career.state.cash.toLocaleString() + ' · Rank ' + career.level + ' · ' + career.state.owned.length + '/24 owned';
  el('garage-message').textContent = missions?.engine.active ? 'Finish or abandon your contract before changing cars.' : 'Buying a car unlocks it permanently. Repairs and recovery are free.';
}
async function chooseCar(pr) {
  if (selectingCar || (started && missions?.engine.active) || !career.state.owned.includes(pr.id)) return false; // a contract resumed from a save still lets you pick a car to start
  if (started && police?.state.level > 0) { el('garage-message').textContent = 'Lose the police before you call a car.'; return false; }
  selectingCar = true; clearDrivingInput();
  if (!started) { el('loading').hidden = false; el('loading').textContent = 'Loading ' + pr.name + '…'; }
  el('garage-message').textContent = 'Loading ' + pr.name + '…';
  const loaded = await ensureModel(pr.model);
  if (!loaded) { selectingCar = false; el('garage-message').textContent = 'Model could not load. Please try again.'; if (!started) el('loading').textContent = 'Model unavailable. Choose another car or press J to enter with the fallback car.'; return false; }
  el('loading').hidden = true;
  const keep = { x: car.x, z: car.z, h: car.h, y: car.y };
  buildPlayer(pr); resetCar(keep); repairCar(); applyDamage(); rideOwned = true;
  crime?.setDriving(); carGroup.visible = true;
  for (const k in lastMark) lastMark[k] = null;
  career.select(pr.id); selectingCar = false; missions?.refresh(); if (started) onDrive(); return true;
}
async function pickGarage(pr) {
  if (selectingCar || missions?.engine.active) return;
  // Load successfully before spending cash; a broken download never charges the player.
  if (!career.state.owned.includes(pr.id)) {
    selectingCar = true; el('garage-message').textContent = 'Loading ' + pr.name + '…';
    const loaded = await ensureModel(pr.id); selectingCar = false;
    if (!loaded) { el('garage-message').textContent = 'Download failed. No cash spent. Try again.'; return; }
    const result = career.purchase(pr.id);
    if (!result.ok) { el('garage-message').textContent = result.reason; return; }
  }
  if (await chooseCar(pr)) toggleGarage(false);
}
function toggleGarage(force) {
  const g = el('garage'), open = force ?? g.hidden;
  g.hidden = !open; clearDrivingInput();
  if (open) { missions?.toggle(false); if (empire?.open) empire.toggle(false); renderCards(el('garage-cards'), pickGarage); el('close-garage').focus(); }
}
el('close-garage').onclick = () => toggleGarage(false);
el('open-garage').onclick = () => { start(); toggleGarage(); };
el('garage-filter').onchange = () => renderCards(el('garage-cards'), pickGarage);
addEventListener('blur', clearDrivingInput);
addEventListener('keydown', e => {
  if (e.code === 'Escape') { togglePhone(false); street?.closeAll(); toggleGarage(false); missions?.toggle(false); if (empire?.open) empire.toggle(false); el('mission-result').hidden = true; clearDrivingInput(); }
  if (e.code === 'KeyG' && started && !missions?.paused && el('garage').hidden && !crime?.onFoot) { qualityPinned = true; setQuality((quality + 2) % 3); }
});
// First time in: the controls panel stays up for a while even on the street HUD (H brings it back any time)
function firstRunHint() {
  let seen = false; try { seen = !!localStorage.getItem('apex.hinted'); localStorage.setItem('apex.hinted', '1'); } catch (e) {}
  if (seen) return;
  document.body.classList.add('show-keys'); setTimeout(() => document.body.classList.remove('show-keys'), 14000);
}
function start() {
  if (started) return;
  started = true; startEl.hidden = true;
  initAudio();
  if (audio.ctx) { audio.ctx.resume(); audio.on = true; }
  if (!crime?.onFoot) setTimeout(onDrive, 600);
  firstRunHint();
}

/* ---------------- Boot ---------------- */
const savedCar = PRESETS.find(p => p.id === career.state.selected) || PRESETS[1];
await ensureModel(savedCar.id);
buildPlayer(savedCar);
resetCar();
// AI traffic: a pool of cars that spawn around you, out of sight, in proportion to how busy each road is
const traffic = createTraffic({ scene, city, rand, nearSolids, localObstacle, player: car, softConfig, camera, max: 60, carModels: CARMODELS,
  pickModel: r => { const pr = pickPreset(PRESETS.filter(q => CARMODELS.some(m => m.id === q.model)), r); return CARMODELS.find(m => m.id === pr?.model) || null; } });
// A police bullet at you: on foot it's the crime layer's business; in a car it can hit the body, the engine, a
// tyre or you through the glass. Every shot shows a tracer.
function carShot(shooter, level) {
  if (!crime) return;
  if (crime.onFoot) { crime.copFire(shooter, level); return; }
  const d = Math.hypot(shooter.x - car.x, shooter.z - car.z), sp = Math.hypot(car.vx, car.vz);
  const hit = rand() < clamp(0.7 - d * 0.009 - sp * 0.006 + level * 0.04, 0.12, 0.8);
  const aim = { x: car.x + (rand() - 0.5) * (hit ? 1.4 : 7), y: car.y + 0.6 + rand() * 0.8, z: car.z + (rand() - 0.5) * (hit ? 1.4 : 7) };
  crime.fx.tracer(shooter.x, (shooter.y || 0) + 1.3, shooter.z, aim.x, aim.y, aim.z);
  crime.fx.flash(shooter.x, (shooter.y || 0) + 1.3, shooter.z);
  if (!hit) { crime.fx.impact(aim.x, city.heightAt(aim.x, aim.z, car.y) + 0.05, aim.z, 'dust'); return; }
  crime.fx.impact(aim.x, aim.y, aim.z, 'spark');
  harm.bullet = Math.min(0.9, harm.bullet + 0.025);
  if (harm.bullet > 0.6 && rand() < 0.1 && harm.tyres > 0.6) { harm.tyres = 0.6; crime.say('Tyre shot out', 1.6); }
  if (rand() < 0.25) { crime.hurtDriver(4 + level); crime.fx.flashDamage(); } // the body and the engine soak most of it
  if (audio.ctx && !audio.muted) pop(audio.ctx.currentTime, 0.35);
}
// Police: patrols, wanted levels, pursuits and bounties (src/police.js)
const police = createPolice({ traffic, city, player: car, audio, scene,
  onBusted: fine => {
    const paid = career.fine(fine);
    if (missions) missions.holdResult = true; // the contract card waits until you come round
    missions?.engine.cancel('You were busted');
    setTimeout(() => afterDown('BUSTED', `Paid ${'$' + paid.toLocaleString()} in fines`), 0);
    return paid;
  },
  onEscaped: (earned, stars) => { career.earn(earned, stars * 20); missions?.refresh(); },
  onShot: (shooter, level) => carShot(shooter, level),
  onSpikes: () => { harm.tyres = Math.min(harm.tyres, 0.42); }
});
crime = createCrimeMode({
  scene, camera, city, traffic, police, player: car,
  solidsNear: nearSolids, addSolid, makeCarMesh,
  career, presets: PRESETS, pickPreset, onGunFx: (w, d) => gunshot(w, d),
  // a crime only starts a chase if a cop sees it (police.crime checks witnesses); attacking police always counts
  onCrime: (event, payload) => {
    const pr = payload?.preset;
    const take = pr ? Math.round(((pr.price || 8000) * 0.12) / 10) * 10 : 0;
    const hot = pr && (pr.price || 0) >= 40000 ? 2 : 1;
    // [stars, what, bounty, always counts, a civilian would call it in]
    const C = {
      carjack: [hot, 'Carjacking', 500 + take, false, true], theft: [hot, 'Vehicle theft', 300 + take, false, false],
      alarm: [hot, 'Car alarm', 300 + take, false, true], policeCarTheft: [3, 'Stolen police car', 5000, true],
      gunfire: [1, 'Shots fired', 200, false, true], assault: [1, 'Assault', 300, false, true], kill: [2, 'Homicide', 2000, false, true],
      hitrun: [1, 'Hit and run', 400, false, true], hurtCop: [3, 'Assaulting an officer', 1500, true], killCop: [4, 'Officer down', 5000, true],
    }[event];
    if (!C) return;
    let seen = police.crime(C[0], C[1], C[2], C[3]);
    // gunfire carries: any unit within earshot comes running
    if (!seen && event === 'gunfire' && police.state.level < 1 && traffic.police.units().some(v => Math.hypot(v.x - car.x, v.z - car.z) < 90)) { police.raise(1, 'Police heard the shots', 200); seen = true; }
    if (!seen && C[4] && crime.civWitnesses(event === 'gunfire' ? 60 : 40) > 0) police.report(C[0], C[1], C[2], 5 + rand() * 5);
    missions?.refresh();
  },
  onEnterCar: async (preset, pose, info) => {
    car.x = pose.x; car.z = pose.z; car.y = pose.y ?? city.heightAt(pose.x, pose.z); car.h = pose.h;
    car.vx = car.vz = car.w = 0; car.onFoot = false; car.armed = false;
    if (info.owned) career.select(preset.id);
    rideOwned = !!info.owned;
    const loaded = await ensureModel(preset.model);
    if (loaded) {
      buildPlayer(preset); resetCar(pose); repairCar(); applyDamage();
      const snap = info.parked?.damage || info.damage;
      if (snap) { restoreDamage(snap); collisionTotal = Math.max(collisionTotal, snap.total || 0); }
    }
    carGroup.visible = true; camSnap = true;
    crime.setDriving(); onDrive();
  },
  snapshotVehicle: v => (v && !v.lazy && v.soft ? damageSnapshot(v.soft) : null),
  onCopShoot: (shooter, level) => carShot(shooter, level),
  onPlayerWasted: () => {
    const bill = Math.min(career.state.cash, 500 + Math.round(career.state.cash * 0.1));
    career.fine(bill);
    afterDown('WASTED', `Hospital bill ${'$' + bill.toLocaleString()}`);
  }
});
// Busted or wasted: the car is gone, you walk out on the nearest pavement, the chase and any contract are over
// WASTED / BUSTED: the world slows and drains of colour for a couple of seconds, then fades and you're back on
// your feet on the nearest pavement. The chase stops at once; the job fails when you come round.
function afterDown(title, sub) {
  if (downing) return;
  downing = true; police.clear(); clearDrivingInput();
  timeScale = 0.3; document.body.classList.add('down');
  el('passed').className = ''; el('copmsg').className = '';
  showBanner(title, sub); radio.sting(title === 'WASTED' ? 'wasted' : 'busted');
  setTimeout(() => {
    document.body.classList.add('fade');
    setTimeout(() => {
      missions?.engine.cancel(title === 'WASTED' ? 'You were wasted' : 'You were busted');
      street?.fail(title === 'WASTED' ? 'You were wasted.' : 'You were busted.', true);
      police.clear();
      // you come round at the hospital (wasted) or the police station (busted) in the nearest town that isn't where
      // it all happened, the officers who were on you gone, with a short grace before anyone looks for you again
      const towns = city.labels.filter(l => l.kind === 'town' || l.kind === 'village').map(l => ({ ...l, d: Math.hypot(l.x - car.x, l.z - car.z) }));
      const town = towns.filter(l => l.d > 350).sort((a, b) => a.d - b.d)[0] || towns[0];
      const off = title === 'WASTED' ? 60 : -60, lane = city.nearestLanePose(town.x + off, town.z, city.groundAt(town.x + off, town.z));
      const pose = (lane && crime.pavementNear(lane.x, lane.z, lane.y)) || { x: city.start.x, z: city.start.z, y: city.start.y, h: city.start.h };
      traffic.police.dismiss(); crime.clearCops(); police.grace(20);
      car.vx = car.vz = car.w = 0;
      repairCar();
      ui.title(title === 'WASTED' ? 'Ashby General Hospital' : 'Ashby Police Department', town.name);
      crime.startAt(pose); crime.heal();
      carGroup.visible = false; camSnap = true; timeScale = 1;
      document.body.classList.remove('down', 'fade');
      downing = false;
      if (missions) { missions.holdResult = false; missions.flushResult(); }
      missions?.refresh();
    }, 450);
  }, 2600);
}
function showBanner(title, sub) {
  const b = el('banner'); if (!b) return;
  b.innerHTML = `<b>${title}</b>${sub ? `<span>${sub}</span>` : ''}`;
  b.className = 'show'; clearTimeout(showBanner.t); showBanner.t = setTimeout(() => { b.className = ''; }, 3000);
}
// MISSION PASSED / MISSION FAILED across the middle of the screen (doesn't stop play)
function showPassed(ok, title, sub, g) {
  const b = el('passed'); if (!b) return;
  b.querySelector('b').textContent = ok ? 'MISSION PASSED' : 'MISSION FAILED';
  b.querySelector('em').textContent = title || '';
  b.querySelector('span').textContent = sub || '';
  // the medal and the gold objectives, where the job has them
  const ul = b.querySelector('ul');
  if (ul) { ul.replaceChildren(); if (ok && g) { const add = (cls, text) => { const li = document.createElement('li'); li.className = cls; li.textContent = text; ul.append(li); }; add('medal ' + g.medal, g.medal.toUpperCase() + ' MEDAL'); for (const o of g.list) add(o.ok ? 'ok' : 'no', o.label); } }
  b.className = ok ? 'show ok' : 'show fail';
  radio.sting(ok ? 'passed' : 'failed');
  clearTimeout(showPassed.t); showPassed.t = setTimeout(() => { b.className = ''; }, g ? 7500 : 5200);
}
// Mission text, GTA-style: a title card when a job starts, then lines of dialogue and the objective as subtitles
// along the bottom of the screen, one after another, key words highlighted.
const ui = (() => {
  const box = el('subtitle'), card = el('title-card'), q = [];
  let cur = null, t = 0;
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  function next() {
    cur = q.shift() || null;
    if (cur) { box.innerHTML = cur.html; box.classList.add('show'); t = cur.dur; } else box.classList.remove('show');
  }
  return {
    talk(lines) { for (const [who, text] of lines || []) q.push({ html: `<b class="who">${esc(who)}:</b> ${esc(text)}`, dur: 1.6 + text.length * 0.055 }); if (!cur) next(); },
    objective(html) { q.push({ html: `<span class="obj">${html}</span>`, dur: 6 }); if (!cur) next(); },
    title(name, sub) {
      card.querySelector('b').textContent = name; card.querySelector('span').textContent = sub || '';
      card.classList.add('show'); clearTimeout(card.t); card.t = setTimeout(() => card.classList.remove('show'), 4200);
    },
    update(dt) { if (cur && (t -= dt) <= 0) next(); },
    clear() { q.length = 0; cur = null; box.classList.remove('show'); },
  };
})();
/* ---------------- Three protagonists (X) ---------------- */
// As in GTA V you play three people, each wherever you last left them: press X (or pick one on the phone) and the
// camera lifts into the sky, crosses the valley and comes down on the next. They share the money and the garage;
// what differs is the special ability: the wheelman slows time best at the wheel, the shooter on foot, and the
// bruiser doesn't slow time at all: while his bar drains his armour comes back as fast as it's shot off.
const CHARS = [
  { name: 'Cole', role: 'The wheelman', color: '#7fe39a', ability: 'drive', home: null },
  { name: 'Vince', role: 'The shooter', color: '#6fb2ff', ability: 'aim', home: 'Westfield' },
  { name: 'Ray', role: 'The bruiser', color: '#ffa94d', ability: 'rage', home: 'Pine Hollow' },
];
const who = { cur: 0, poses: [null, null, null], sw: null };
function charHome(i) {
  const l = city.labels.find(l => l.name === CHARS[i].home) || { x: city.start.x, z: city.start.z };
  const lane = city.nearestLanePose(l.x + 30, l.z, city.groundAt(l.x + 30, l.z)) || city.start;
  const foot = crime.pavementNear(lane.x, lane.z, lane.y) || lane;
  return { x: foot.x, z: foot.z, y: foot.y ?? city.heightAt(foot.x, foot.z), h: lane.h || 0 };
}
function saveChars() { const st = career.state.story || (career.state.story = { done: 0 }); st.chars = { cur: who.cur, poses: who.poses.map(p => p ? [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10, Math.round((p.h || 0) * 100) / 100] : null) }; career.save(); }
{ const c = career.state.story?.chars; if (c) { who.cur = c.cur || 0; who.poses = [0, 1, 2].map(i => c.poses?.[i] ? { x: c.poses[i][0], z: c.poses[i][1], h: c.poses[i][2] || 0 } : null); } }
function switchChar(to) {
  if (!started || downing || who.sw || to === who.cur || !CHARS[to]) return false;
  if (street?.active || missions?.engine.active || police.state.level > 0) { crime.say('Not in the middle of this.', 2.5); return false; }
  if (!crime.onFoot) exitCar();
  who.poses[who.cur] = { x: car.x, z: car.z, y: car.y, h: car.h };
  who.sw = { to, t: 0, done: false }; ability.on = false; if (phone.open) togglePhone(false);
  return true;
}
// the switch itself: up into the sky over one, across, and down onto the other (called after the camera has been set)
function updateSwitch(real) {
  const s = who.sw; if (!s) return;
  const T = 2.8, half = T / 2; s.t += real;
  if (!s.done && s.t >= half) {
    s.done = true; who.cur = s.to;
    const p = who.poses[s.to] || charHome(s.to);
    crime.startAt({ x: p.x, z: p.z, y: p.y ?? city.heightAt(p.x, p.z), h: p.h || 0 }); camSnap = true; carGroup.visible = false;
    saveChars(); ui.title(CHARS[s.to].name, CHARS[s.to].role);
  }
  const u = clamp(s.t < half ? s.t / half : (T - s.t) / half, 0, 1), k = u * u * (3 - 2 * u);
  camera.position.y += 340 * k; camera.lookAt(car.x, car.y + 1, car.z);
  if (s.t >= T) who.sw = null;
}

/* ---------------- The phone (P) ---------------- */
// Missions (every Marlowe job you've done, its medal and the time to beat, and a replay), contacts (who to see
// next, with a waypoint), your characters, your numbers, and a quick save. The valley carries on while you look.
const phone = { open: false, page: 'home' };
function phoneRender() {
  const body = el('phone-body'), e = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const mm = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`, back = '<button data-go="home">‹ Back</button>';
  let h = '';
  if (phone.page === 'home') h = `<div class="apps"><button data-go="missions"><i>★</i>Missions</button><button data-go="contacts"><i>☎</i>Contacts</button><button data-go="chars"><i>⇄</i>Switch</button><button data-go="stats"><i>≡</i>Stats</button></div><button data-act="save">Quick save<small>Everything is also saved as you go</small></button>`;
  else if (phone.page === 'missions') {
    h = '<h4>Missions</h4>' + street.jobs.map((j, i) => { const done = i < street.done, m = street.medals[j.name];
      return `<button data-replay="${i}" ${done ? '' : 'disabled'}>${e(j.name)}<small>${done ? `<span class="${m || 'bronze'}">${(m || 'bronze').toUpperCase()}</span> · beat ${mm(j.par)} · tap to replay` : i === street.done ? 'Next: see Marlowe (yellow M)' : 'Locked'}</small></button>`; }).join('')
      + `<button disabled>The Ashby Score<small>${street.heistDone ? `<span class="${street.medals['The Ashby Score'] || 'bronze'}">${(street.medals['The Ashby Score'] || 'bronze').toUpperCase()}</span> · done` : street.heist.ready ? 'Lena is waiting: the green H' : 'Do three jobs for Marlowe first'}</small></button>` + back;
  } else if (phone.page === 'contacts') {
    const hs = street.heist.state;
    h = `<h4>Contacts</h4><button data-call="marlowe">Marlowe<small>${street.done < street.jobs.length ? 'Has a job for you' : 'Retired'}</small></button><button data-call="lena">Lena<small>${street.heistDone ? 'Lying low' : street.heist.ready ? (hs.phase === 0 ? 'Wants to plan a score' : hs.phase === 1 ? `Setup ${hs.setups + 1} of 2` : 'Ready when you are') : 'Not yet'}</small></button><button data-call="customs">Apex Customs<small>Repairs, resprays, ammo, armour</small></button>` + back;
  } else if (phone.page === 'chars') h = '<h4>Switch</h4>' + CHARS.map((c, i) => `<button data-char="${i}" ${i === who.cur ? 'disabled' : ''}><span style="color:${c.color}">${c.name}</span><small>${c.role}${i === who.cur ? ' · you are here' : ''}</small></button>`).join('') + back;
  else if (phone.page === 'stats') {
    const m = Object.values(street.medals), n = t => m.filter(x => x === t).length;
    h = `<h4>Stats</h4><p>Cash  $${career.state.cash.toLocaleString('en-US')}\nRank  ${career.level}\nJobs for Marlowe  ${street.done} of ${street.jobs.length}\nMedals  ${n('gold')} gold · ${n('silver')} silver · ${n('bronze')} bronze\nThe Ashby Score  ${street.heistDone ? 'done' : 'not yet'}\nRandom events  ${street.eventsDone}\nHidden packages  ${street.packs.found} of ${street.packs.list.length}\nPlaying as  ${CHARS[who.cur].name}</p>` + back;
  }
  body.innerHTML = h;
}
function togglePhone(on = !phone.open) {
  if (on && (!started || downing || who.sw)) return;
  phone.open = on; el('phone').hidden = !on; phone.page = 'home';
  if (on) { document.exitPointerLock?.(); phoneRender(); }
}
function phoneWaypoint(p, who2, line) { gps.waypoint = { x: p.x, z: p.z }; gps.t = 0; ui.talk([[who2, line]]); togglePhone(false); }
el('phone-body').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  if (b.dataset.go) { phone.page = b.dataset.go; phoneRender(); }
  else if (b.dataset.act === 'save') { career.save(); crime.say(career.saveError ? 'Could not save here.' : 'Saved.', 2); togglePhone(false); }
  else if (b.dataset.replay) { togglePhone(false); street.replay(+b.dataset.replay); }
  else if (b.dataset.char) switchChar(+b.dataset.char);
  else if (b.dataset.call === 'marlowe') { if (street.done < street.jobs.length) phoneWaypoint(street.places.GARAGE, 'MARLOWE', 'Come by the garage. I marked it for you.'); else { ui.talk([['MARLOWE', 'I\'m retired, kid. Go and spend it.']]); togglePhone(false); } }
  else if (b.dataset.call === 'lena') { if (street.heist.ready) phoneWaypoint(street.places.SAFE, 'LENA', 'Planning room. You know where. I\'ve put it on your map.'); else { ui.talk([['LENA', street.heistDone ? 'We did it. Don\'t call this number for a while.' : 'Not yet. Earn Marlowe\'s trust first.']]); togglePhone(false); } }
  else if (b.dataset.call === 'customs') { const sh = street.places.SHOPS.slice().sort((a, b2) => Math.hypot(a.x - car.x, a.z - car.z) - Math.hypot(b2.x - car.x, b2.z - car.z))[0]; phoneWaypoint(sh, 'APEX CUSTOMS', `${sh.name.replace('Apex Customs ', '')} is your nearest. It\'s on your map.`); }
});

// Radio: a station comes on when you get in (as you left it, or a random one); , and . change station
const radio = createRadio(audio);
let radioUserOff = false;
function showRadio() {
  const st = radio.station, r = hudEl.radio; if (!r) return;
  r.innerHTML = st ? `<b>${st.name}</b><span>${st.genre}</span>` : '<b>Radio off</b>';
  r.classList.add('show'); clearTimeout(showRadio.t); showRadio.t = setTimeout(() => { r.classList.remove('show'); }, 2600);
}
// GTA shows what you just got into: the name, the class and its stats, for a few seconds
function showCarCard() {
  const c = el('car-card'); if (!c || !preset) return;
  c.innerHTML = `<b>${preset.name}</b><small>${preset.kind} · ${(STATS[preset.id]?.kmh || 0)} km/h · value $${(preset.price || 0).toLocaleString('en-US')}</small>${statBars(preset.id)}`;
  c.classList.add('show'); clearTimeout(showCarCard.t); showCarCard.t = setTimeout(() => c.classList.remove('show'), 4500);
}
function onDrive() {
  showCarCard();
  if (!radio.ensure()) return;
  if (!radioUserOff && radio.idx < 0) radio.tune(1 + Math.floor(Math.random() * radio.stations.length));
  showRadio();
}
el('start-foot').onclick = () => {
  started = true;
  startEl.hidden = true; firstRunHint();
  initAudio();
  if (audio.ctx) { audio.ctx.resume(); audio.on = true; }
  const pose = { x: city.start.x, z: city.start.z, y: city.heightAt(city.start.x, city.start.z), h: city.start.h };
  crime.startAt(pose);
  carGroup.visible = false;
};
missions = createMissionSystem({city,scene,car,career,getDamage:()=>collisionTotal/10000,getWanted:()=>police.state.level,getCrime:()=>crime,onPause:clearDrivingInput});
missions.onPursuit = (level, job) => police.raise(level, job?.biz ? 'Police tip-off' : 'Escape contract', 500 * level);
// taxi rides: on foot you're dropped off on foot; in a car, the car comes with you
const travelTo = pose => { start(); timeScale = 1; clearDrivingInput(); camSnap = true;
  if (crime?.onFoot) crime.setFootPosition(crime.pavementNear(pose.x, pose.z, pose.y) || pose); else resetCar(pose); };
empire = createEmpireSystem({city,scene,car,career,missions,catalog,travel:travelTo,onPause:clearDrivingInput});
// Street life: Marlowe's jobs and Apex Customs (src/street.js)
street = createStreet({ scene, city, car, career, crime, police, missions, traffic, onPause: clearDrivingInput,
  getRide: () => crime.onFoot ? null : { preset, owned: rideOwned && career.state.owned.includes(preset.id), damage: soft.damage || 0, bullet: harm.bullet, tyres: harm.tyres },
  // hand the car over: you're left standing beside where it was, and it's gone
  dropCar: () => {
    if (crime.onFoot) return;
    const pose = crime.pavementNear(car.x + Math.cos(car.h) * 2.5, car.z - Math.sin(car.h) * 2.5, car.y) || { x: car.x + Math.cos(car.h) * 2.5, z: car.z - Math.sin(car.h) * 2.5, y: car.y, h: car.h };
    car.vx = car.vz = car.w = 0; repairCar(); applyDamage();
    crime.startAt(pose); carGroup.visible = false; camSnap = true;
  },
  repairCar: () => { repairCar(); soft.refresh(); applyDamage(); },
  onResult: (ok, title, sub, g) => showPassed(ok, title, sub, g), ui });
missions.blocked = () => !!street.active;
const TYPE_NAME = { delivery: 'Delivery', race: 'Checkpoint race', clean: 'Clean driving', drift: 'Drift', escape: 'Police escape' };
missions.onStart = (job, rules) => { if (job.biz) return; ui.clear(); ui.title(job.name, `${TYPE_NAME[job.type] || 'Contract'} · $${job.cash.toLocaleString('en-US')}`); ui.objective(rules); };
missions.onResult = r => {
  const w = r.reward;
  showPassed(r.ok, r.job.name, r.ok ? (w.label || `${w.medal.toUpperCase()} · $${w.cash.toLocaleString('en-US')} · +${w.xp} XP${w.first ? ' · first clear' : ''}${w.rankUp ? ' · RANK UP' : ''}`) : r.reason);
  if (!r.ok && !r.job.biz) ui.objective('Press <b>J</b> to try it again.');
}; missions.onAbandon = () => street.fail('You walked away from the job.');
renderCards(el('start-cards'), async pr => { if(await chooseCar(pr)) start(); });

const STEP = 1 / 240;
let acc = 0, last = performance.now(), frameAvg = 16, dprTimer = 0, cullTick = 0;
function frame(now) {
  const real = Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
  // Adaptive resolution: hold ~60 fps by trading pixels, never simulation time
  frameAvg = lerp(frameAvg, real * 1000, 0.05); dprTimer += real;
  if (WORLD.building) dprTimer = 0; // the map is being painted in slices: those frames say nothing about the GPU
  if (dprTimer > 1.5) {
    dprTimer = 0;
    const maxDpr = Math.min(devicePixelRatio, QUALITY[quality].dpr);
    const next = frameAvg > 20 ? Math.max(0.6, pixelRatio - 0.15) : frameAvg < 14 ? Math.min(maxDpr, pixelRatio + 0.1) : pixelRatio;
    if (Math.abs(next - pixelRatio) > 0.01) { pixelRatio = next; renderer.setPixelRatio(pixelRatio); resize(); }
    // already at the lowest resolution and still slow: step the quality down once
    if (pixelRatio <= 0.61 && frameAvg > 24 && quality > 0 && !qualityPinned) setQuality(quality - 1, true);
    // comfortably fast at full resolution for a while: step quality back up
    upT = frameAvg < 12.5 && pixelRatio >= maxDpr - 0.01 ? upT + 1 : 0;
    if (upT >= 4 && quality < 2 && !qualityPinned) { upT = 0; setQuality(quality + 1, true); }
  }
  const paused = !started || !el('garage').hidden || missions.paused || empire.open || street.shopOpen || street.briefOpen || selectingCar || document.hidden;
  updateAbility(real, paused);
  const dt = paused ? 0 : real * timeScale;
  post.fx.focus = ability.fx; post.fx.blur = crime?.onFoot || camModes[camMode] === 'Orbit' ? 0 : clamp((Math.hypot(car.vx || 0, car.vz || 0) - 30) / 45, 0, 1) * 0.55;
  const inp = !paused && !downing ? readInput(dt) : { gas: 0, brake: 0, steer: 0, hb: 0 };
  acc += dt;
  let steps = 0;
  while (acc >= STEP && steps < 30) { if (!crime?.onFoot) stepCar(STEP, inp); traffic.step(STEP); acc -= STEP; steps++; }
  if (steps === 30) acc = 0;
  city.update(dt, car.x, car.z); traffic.update(dt); grass.update(dt);
  if (started) {
    police.update(dt);
    if (crime && crime.onFoot) crime.updateFixed(dt, downing ? {} : keys);
    if (crime && dt > 0) crime.updateWorld(dt, !crime.onFoot, Math.hypot(car.vx || 0, car.vz || 0));
  }
  missions.update(dt); if (started && !document.hidden) empire.update(real, dt); if (started) street.update(dt);
  updateLoose(dt); updateSmoke(dt); updateDebris(dt); updateSparks(dt); syncCar(dt);
  if (crime && crime.onFoot) crime.updateCamera(dt); else updateCamera(dt);
  updateSwitch(real);
  snow.update(real); weather.update(dt, real);
  updateAudio(); updateHud(); gps.update(real); if (!paused) ui.update(real);
  radio.update(started && !crime.onFoot && !downing && carGroup.visible, paused ? 1 : police.state.level > 0 ? 0.45 : 0);
  if (++cullTick % 6 === 0) city.cull(camera.position);
  post.render(dt);
  requestAnimationFrame(frame);
}
camSnap = true;
updateCamera(0);
requestAnimationFrame(frame);
setTimeout(() => buildWorldMap().catch(e => console.warn('World map unavailable:', e)), 1200);
applyDamage();
window.apex = { get felled() { return felledCount; }, career, missions, gps, radio, WORLD, city, sunDir, phone, togglePhone, phoneRender, who, CHARS, switchChar, weather, wheel, openWheel, wheelMove, ability, toggleAbility, get timeScale() { return timeScale; }, get empire() { return empire; }, get street() { return street; }, harmState: () => harm, get crime() { return crime; }, exitCar, makeCarMesh, ensureModel, carModels: CARMODELS, grass, SKY, sun, setQuality, post, police, nearSolids, renderer, scene, camera, syncCar, updateCamera, car, stepCar, resetCar, soft: () => soft, crash, harm, repairCar, applyDamage, traffic, city, PRESETS, chooseCar, respawn, // console access for tuning
  addSolid, view(mode, angle, radius = 11) { camMode = camModes.indexOf(mode); camSnap = true; orbitR = radius; if (angle !== undefined) { orbitA = angle; orbitHold = true; } } };
el('loading').hidden = true;
}
// Building the valley takes a moment: let the loading message paint first
setTimeout(() => {
  boot().catch(e => { console.error(e); document.getElementById('loading').textContent = 'Something went wrong building the world: ' + e.message; });
}, 30);
