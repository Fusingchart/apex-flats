async function boot() {
'use strict';
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
let seed = 1337;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

/* ---------------- Renderer & scene ---------------- */
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// Resolution adapts to keep the frame rate up (see the loop); start at up to 1.5x on high-DPI screens
let pixelRatio = Math.min(devicePixelRatio, 1.5);
renderer.setPixelRatio(pixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;

// A sunny afternoon, lit by a real sky: a photographed HDR panorama (Poly Haven, CC0) is the visible sky, the
// prefiltered environment for ambient light and reflections, and the source of the sun's direction and colour
const scene = new THREE.Scene();
const HAZE = new THREE.Color('#c9b9a4');
scene.fog = new THREE.FogExp2(HAZE.clone(), 0.00018);
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
let missions = null, empire = null, crime = null, street = null, selectingCar = false, collisionTotal = 0, rideOwned = true;
// if the photo's sun sits very low, lift it a few degrees for gameplay so streets aren't all in shadow
const sunDir = SKY.sunDir.clone();
{ const el = Math.asin(sunDir.y), lift = Math.max(el, 0.2), hz = Math.cos(lift) / Math.hypot(sunDir.x, sunDir.z); sunDir.set(sunDir.x * hz, Math.sin(lift), sunDir.z * hz).normalize(); }

const SKY_GAIN = SKY.gain; // same normalisation as the environment
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { sky: { value: SKY.skyTex }, gain: { value: SKY_GAIN }, haze: { value: scene.fog.color } },
  vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
  fragmentShader: `
    varying vec3 vDir; uniform sampler2D sky; uniform float gain; uniform vec3 haze;
    vec3 rgbe(vec4 t){ float e = t.a * 255.0; return e < 1.0 ? vec3(0.0) : t.rgb * 255.0 * exp2(e - 136.0); }
    void main(){
      vec3 d = normalize(vDir);
      vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
      vec3 c = rgbe(texture2D(sky, uv)) * gain;
      c = mix(c, haze, smoothstep(0.03, -0.04, d.y)); // below the horizon: the haze the land fades into
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
  const H = SKY.horizon; return [0, 1, 2].map(k => (H[i * 3 + k] * (1 - t) + H[j * 3 + k] * t) * 0.92);
};

scene.add(new THREE.HemisphereLight('#c9d4e0', '#6b5a42', 0.12));
const sun = new THREE.DirectionalLight(new THREE.Color().setRGB(...SKY.sunColor.map(v => 0.6 + 0.4 * Math.sqrt(v))).lerp(new THREE.Color(1, 0.93, 0.82), 0.4), 2.6); // preserve detail on sunlit paint and concrete
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
const city = buildWorld({ scene, solids, rand });
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
  for (let i = Math.floor((x - r) / GRID); i <= Math.floor((x + r) / GRID); i++)
    for (let j = Math.floor((z - r) / GRID); j <= Math.floor((z + r) / GRID); j++) {
      const list = solidGrid.get(cellKey(i, j));
      if (list) for (const o of list) if (o._q !== queryId) { o._q = queryId; out.push(o); }
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
  car.px = car.x; car.pz = car.z; car.ph = car.h;
  const s = Math.sin(car.h), c = Math.cos(car.h);
  const fx = s, fz = c, sx = c, sz = -s; // forward and side (local +x) unit vectors
  let vLong = car.vx * fx + car.vz * fz;
  let vLat = car.vx * sx + car.vz * sz;
  const speed = Math.hypot(car.vx, car.vz);
  car.surface = city.surfaceAt(car.x, car.z, car.y);
  car.onSand = car.surface !== 'asphalt';
  const wet = car.surface === 'water';
  const mu = car.surface === 'asphalt' ? P.grip : (wet ? 0.35 : 0.72) * P.grip / 1.08;
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
function collide(dt) {
  const s = Math.sin(car.h), c = Math.cos(car.h);
  const s0 = Math.sin(car.ph), c0 = Math.cos(car.ph);
  const vx0 = car.vx, vz0 = car.vz;

  // Soft shell against everything within reach: walls, trees, houses, and other cars
  near.length = 0;
  nearSolids(car.x, car.z, 6, nearTmp);
  traffic.boxesNear(car.x, car.z, 7, nearTmp, car.y);
  for (const o of nearTmp) if (traffic.nearCar(car.x, car.z, car.h, o, 0.5, car.y)) near.push(localObstacle(near.length, o, car.px, car.pz, s0, c0, car.x, car.z, s, c, obsPool, car.y));
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
  if (e.code === 'KeyV') toggleGarage();
  if (e.code === 'KeyJ') { empire?.toggle(false); missions?.toggle(); }
  if (e.code === 'KeyB' && started) empire?.toggle();
  if (e.code === 'Tab') { e.preventDefault(); bigMap.open = !bigMap.open; el('bigmap').hidden = !bigMap.open; }
  if (e.code === 'KeyZ' && !missions?.engine.active && !street?.active && !police.state.level) timeScale = timeScale === 1 ? 0.25 : 1;
  // Enter opens the shop, but never steals Enter from a focused button or another open menu
  if (e.code === 'Enter' && started && street?.shopAt && !e.target.closest?.('button, a, select, input') && (street.shopOpen || !menuOpen)) { e.preventDefault(); street.openShop(); }
  if (e.code === 'KeyM') audio.muted = !audio.muted;
  if (e.code === 'KeyH') document.getElementById('keys').classList.toggle('off');
  if (e.code === 'KeyE') shift(1);
  if (e.code === 'KeyQ') shift(-1);
  if (e.code === 'KeyT') car.auto = true;
  if (!started && !/^Digit/.test(e.code)) start();
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('mousedown', e => {
  if (crime && crime.onFoot && !e.target.closest?.('button, a, select, input, .overlay')) {
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
for (const m of city.mapLines) { // bounding boxes, so the minimap only draws what's near
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of m.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  m.box = [x0, x1, z0, z1];
}
function drawMap() {
  const g = mapCtx, W2 = 340, R = W2 / 2, range = 280, scale = R / range;
  const sh = Math.sin(car.h), ch = Math.cos(car.h);
  const X = (x, z) => R - ((x - car.x) * ch - (z - car.z) * sh) * scale;
  const Y = (x, z) => R - ((x - car.x) * sh + (z - car.z) * ch) * scale;
  g.clearRect(0, 0, W2, W2);
  g.save(); g.beginPath(); g.arc(R, R, R - 2, 0, TAU); g.clip();
  g.fillStyle = 'rgba(18,16,24,0.72)'; g.fillRect(0, 0, W2, W2);
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const kind of MAP_ORDER) {
    const [col, w] = ROAD_STYLE[kind];
    g.strokeStyle = col; g.lineWidth = Math.max(2, w * scale + 1.5);
    g.beginPath();
    for (const m of city.mapLines) {
      if (m.kind !== kind) continue;
      const [x0, x1, z0, z1] = m.box;
      if (x1 < car.x - range * 1.5 || x0 > car.x + range * 1.5 || z1 < car.z - range * 1.5 || z0 > car.z + range * 1.5) continue;
      const step = m.pts.length > 400 ? 3 : 2;
      for (let i = 0; i < m.pts.length; i += step) { const q = m.pts[i]; i ? g.lineTo(X(q.x, q.z), Y(q.x, q.z)) : g.moveTo(X(q.x, q.z), Y(q.x, q.z)); }
      const l = m.pts[m.pts.length - 1]; g.lineTo(X(l.x, l.z), Y(l.x, l.z));
    }
    g.stroke();
  }
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
    if (x < -10 || y < -10 || x > W2 + 10 || y > W2 + 10) continue;
    g.save(); g.translate(x, y); g.rotate(car.h - v.h);
    g.fillStyle = v.police ? (v.state === 'pursue' ? ((performance.now() / 250 | 0) % 2 ? '#ff3b3b' : '#3b6bff') : '#5b7cff') : v.state === 'wreck' ? '#ff5a4e' : 'rgba(243,236,228,0.92)';
    g.fillRect(-2.5, -5, 5, 10); g.restore();
  }
  g.fillStyle = '#ffb547'; g.beginPath(); g.moveTo(R, R - 9); g.lineTo(R + 6, R + 7); g.lineTo(R - 6, R + 7); g.closePath(); g.fill();
  g.restore();
  g.strokeStyle = 'rgba(243,236,228,0.16)'; g.lineWidth = 2; g.beginPath(); g.arc(R, R, R - 2, 0, TAU); g.stroke();
}
// Full map (Tab): shaded relief, the river, every road and the place names, drawn once; you and the
// traffic on top
const bigMap = { open: false, base: null };
function drawBigMap() {
  const cv = el('bigmap'), g = cv.getContext('2d'), S = cv.width, ext = city.EXT + 60, sc = S / (2 * ext);
  const X = x => S / 2 - x * sc, Y = z => S / 2 - z * sc; // east (-x) to the right, north (+z) up
  if (!bigMap.base) {
    const off = document.createElement('canvas'); off.width = off.height = S;
    const o = off.getContext('2d');
    // hillshade at half resolution, lit from the north-west
    const R = S / 2, img = o.createImageData(R, R), px = 2 * ext / R;
    const hAt = (i, j) => city.groundAt(ext - i * px, ext - j * px);
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      const h = hAt(i, j), dx = hAt(i + 1, j) - h, dz = hAt(i, j + 1) - h;
      const shade = clamp(0.62 + (dx + dz) * 0.09 / px * 4, 0.25, 1), lift = clamp(h / 260, 0, 1);
      const k = (j * R + i) * 4, water = h < city.WATER - 0.3;
      img.data[k] = water ? 34 : (30 + 26 * lift) * shade + 8; img.data[k + 1] = water ? 58 : (34 + 22 * lift) * shade + 8; img.data[k + 2] = water ? 78 : (40 + 20 * lift) * shade + 10; img.data[k + 3] = 255;
    }
    const tmp = document.createElement('canvas'); tmp.width = tmp.height = R; tmp.getContext('2d').putImageData(img, 0, 0);
    o.imageSmoothingEnabled = true; o.drawImage(tmp, 0, 0, S, S);
    o.lineCap = 'round'; o.lineJoin = 'round';
    for (const kind of MAP_ORDER) {
      if (kind === 'river') continue;
      const [col, w] = ROAD_STYLE[kind];
      o.strokeStyle = col; o.lineWidth = Math.max(1.1, w * sc * 1.5);
      o.beginPath();
      for (const m of city.mapLines) { if (m.kind !== kind) continue; m.pts.forEach((q, i) => i ? o.lineTo(X(q.x), Y(q.z)) : o.moveTo(X(q.x), Y(q.z))); }
      o.stroke();
    }
    o.textAlign = 'center'; o.textBaseline = 'middle';
    for (const l of city.labels) {
      o.font = l.kind === 'town' ? '700 19px "Chakra Petch", sans-serif' : l.kind === 'village' ? '600 15px "Chakra Petch", sans-serif' : 'italic 500 14px "IBM Plex Mono", monospace';
      o.lineWidth = 4; o.strokeStyle = 'rgba(18,16,24,0.8)'; o.strokeText(l.name.toUpperCase(), X(l.x), Y(l.z));
      o.fillStyle = l.kind === 'river' ? '#8ec3dd' : l.kind === 'road' ? '#ffb547' : '#f3ece4'; o.fillText(l.name.toUpperCase(), X(l.x), Y(l.z));
    }
    bigMap.base = off;
  }
  g.drawImage(bigMap.base, 0, 0);
  missions?.drawMap(g, x => X(x), (x,z) => Y(z)); empire?.drawMap(g, x => X(x), (x,z) => Y(z)); street?.drawMap(g, x => X(x), (x,z) => Y(z));
  g.fillStyle = 'rgba(243,236,228,0.85)';
  for (const v of traffic.vehicles) if (v.state !== 'idle') { g.fillStyle = v.police ? '#4f7bff' : 'rgba(243,236,228,0.85)'; g.fillRect(X(v.x) - 1.5, Y(v.z) - 1.5, 3, 3); }
  g.save(); g.translate(X(car.x), Y(car.z)); g.rotate(Math.PI - car.h + Math.PI);
  g.fillStyle = '#ffb547'; g.strokeStyle = '#16151a'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, -14); g.lineTo(9, 10); g.lineTo(-9, 10); g.closePath(); g.fill(); g.stroke();
  g.restore();
}
function updateHud() {
  drawMap();
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
  tailMat.emissiveIntensity = tailOk ? (braking || car.hb > 0.5 ? 4 : 0.8) : 0;
  tailGlow.intensity = tailOk ? (braking ? 3 : 0.4) : 0;
  headSpot.intensity = 2 * kit.parts.filter(pt => pt.name === 'Headlight' && !pt.broken).length;
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
  { const hz = hazeAt(Math.atan2(camLook.x - camera.position.x, camLook.z - camera.position.z)); scene.fog.color.setRGB(hz[0], hz[1], hz[2]); }
}

/* ---------------- Loop ---------------- */
const post = createPost(renderer, scene, camera);
// Graphics quality (G cycles; drops automatically if the frame rate can't be held): resolution cap, shadow map
// size, ambient occlusion, bloom
const QUALITY = [
  { name: 'Low', dpr: 1.0, shadow: 1024, ao: false, bloom: 0, grass: false },
  { name: 'Medium', dpr: 1.25, shadow: 2048, ao: true, bloom: 0.05, grass: true },
  { name: 'High', dpr: 1.5, shadow: 4096, ao: true, bloom: 0.05, grass: true },
];
let quality = 2, qualityPinned = false;
function setQuality(q, auto = false) {
  quality = q; const Q = QUALITY[q];
  post.ao = Q.ao; post.finalMat.uniforms.bloom.value = Q.bloom; grass.enabled = Q.grass;
  if (sun.shadow.mapSize.x !== Q.shadow) { sun.shadow.mapSize.set(Q.shadow, Q.shadow); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
  if (pixelRatio > Q.dpr) { pixelRatio = Math.min(devicePixelRatio, Q.dpr); renderer.setPixelRatio(pixelRatio); resize(); }
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

let started = false;
const startEl = el('start');
// Car picker: the same cards serve the start screen and the in-game garage (V)
function clearDrivingInput() { for (const k in keys) keys[k] = false; for (const k in touch) touch[k] = 0; }
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
      <b>${pr.name}</b><i>${pr.kind}</i><span class="spec">${hp} hp · ${pr.mass} kg · ${pr.drive.toUpperCase()}</span><em>${pr.blurb}</em><strong class="car-price">${owned ? (pr === preset ? 'CURRENT · DRIVE' : 'OWNED · DRIVE') : locked ? 'RANK ' + pr.level + ' · $' + pr.price.toLocaleString() : 'BUY · $' + pr.price.toLocaleString()}</strong>`;
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
  career.select(pr.id); selectingCar = false; missions?.refresh(); return true;
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
  if (e.code === 'Escape') { street?.closeAll(); toggleGarage(false); missions?.toggle(false); if (empire?.open) empire.toggle(false); el('mission-result').hidden = true; clearDrivingInput(); }
  if (e.code === 'KeyG' && started && !missions?.paused && el('garage').hidden && !crime?.onFoot) { qualityPinned = true; setQuality((quality + 2) % 3); }
});
function start() {
  if (started) return;
  started = true; startEl.hidden = true;
  initAudio();
  if (audio.ctx) { audio.ctx.resume(); audio.on = true; }
}

/* ---------------- Boot ---------------- */
const savedCar = PRESETS.find(p => p.id === career.state.selected) || PRESETS[1];
await ensureModel(savedCar.id);
buildPlayer(savedCar);
resetCar();
// AI traffic: a pool of cars that spawn around you, out of sight, in proportion to how busy each road is
const traffic = createTraffic({ scene, city, rand, nearSolids, localObstacle, player: car, softConfig, camera, max: 44, carModels: CARMODELS,
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
  career, presets: PRESETS, pickPreset,
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
    crime.setDriving();
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
function afterDown(title, sub) {
  missions?.engine.cancel(title === 'WASTED' ? 'You were wasted' : 'You were busted');
  street?.fail(title === 'WASTED' ? 'You were wasted.' : 'You were busted.');
  police.clear();
  const pose = crime.pavementNear(car.x, car.z, car.y) || { x: city.start.x, z: city.start.z, y: city.start.y, h: city.start.h };
  car.vx = car.vz = car.w = 0;
  repairCar();
  crime.startAt(pose); crime.heal();
  carGroup.visible = false; camSnap = true;
  showBanner(title, sub);
  missions?.refresh();
}
function showBanner(title, sub) {
  const b = el('banner'); if (!b) return;
  b.innerHTML = `<b>${title}</b>${sub ? `<span>${sub}</span>` : ''}`;
  b.className = 'show'; clearTimeout(showBanner.t); showBanner.t = setTimeout(() => { b.className = ''; }, 3600);
}
el('start-foot').onclick = () => {
  started = true;
  startEl.hidden = true;
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
street = createStreet({ scene, city, car, career, crime, police, missions, onPause: clearDrivingInput,
  getRide: () => crime.onFoot ? null : { preset, owned: rideOwned && career.state.owned.includes(preset.id), damage: soft.damage || 0, bullet: harm.bullet, tyres: harm.tyres },
  // hand the car over: you're left standing beside where it was, and it's gone
  dropCar: () => {
    if (crime.onFoot) return;
    const pose = crime.pavementNear(car.x + Math.cos(car.h) * 2.5, car.z - Math.sin(car.h) * 2.5, car.y) || { x: car.x + Math.cos(car.h) * 2.5, z: car.z - Math.sin(car.h) * 2.5, y: car.y, h: car.h };
    car.vx = car.vz = car.w = 0; repairCar(); applyDamage();
    crime.startAt(pose); carGroup.visible = false; camSnap = true;
  },
  repairCar: () => { repairCar(); soft.refresh(); applyDamage(); } });
missions.blocked = () => !!street.active; missions.onAbandon = () => street.fail('You walked away from the job.');
renderCards(el('start-cards'), async pr => { if(await chooseCar(pr)) start(); });

const STEP = 1 / 240;
let acc = 0, last = performance.now(), frameAvg = 16, dprTimer = 0, cullTick = 0;
function frame(now) {
  const real = Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
  // Adaptive resolution: hold ~60 fps by trading pixels, never simulation time
  frameAvg = lerp(frameAvg, real * 1000, 0.05); dprTimer += real;
  if (dprTimer > 1.5) {
    dprTimer = 0;
    const maxDpr = Math.min(devicePixelRatio, QUALITY[quality].dpr);
    const next = frameAvg > 20 ? Math.max(0.6, pixelRatio - 0.15) : frameAvg < 14 ? Math.min(maxDpr, pixelRatio + 0.1) : pixelRatio;
    if (Math.abs(next - pixelRatio) > 0.01) { pixelRatio = next; renderer.setPixelRatio(pixelRatio); resize(); }
    // already at the lowest resolution and still slow: step the quality down once
    if (pixelRatio <= 0.61 && frameAvg > 24 && quality > 0 && !qualityPinned) setQuality(quality - 1, true);
  }
  const paused = !started || !el('garage').hidden || missions.paused || empire.open || street.shopOpen || street.briefOpen || selectingCar || document.hidden;
  const dt = paused ? 0 : real * timeScale;
  const inp = !paused ? readInput(dt) : { gas: 0, brake: 0, steer: 0, hb: 0 };
  acc += dt;
  let steps = 0;
  while (acc >= STEP && steps < 30) { if (!crime?.onFoot) stepCar(STEP, inp); traffic.step(STEP); acc -= STEP; steps++; }
  if (steps === 30) acc = 0;
  city.update(dt); traffic.update(dt); grass.update(dt);
  if (started) {
    police.update(dt);
    if (crime && crime.onFoot) crime.updateFixed(dt, keys);
    if (crime && dt > 0) crime.updateWorld(dt, !crime.onFoot, Math.hypot(car.vx || 0, car.vz || 0));
  }
  missions.update(dt); if (started && !document.hidden) empire.update(real, dt); if (started) street.update(dt);
  updateLoose(dt); updateSmoke(dt); updateDebris(dt); updateSparks(dt); syncCar(dt);
  if (crime && crime.onFoot) crime.updateCamera(dt); else updateCamera(dt);
  updateAudio(); updateHud();
  if (++cullTick % 6 === 0) city.cull(camera.position);
  post.render(dt);
  requestAnimationFrame(frame);
}
camSnap = true;
updateCamera(0);
requestAnimationFrame(frame);
applyDamage();
window.apex = { career, missions, get empire() { return empire; }, get street() { return street; }, harmState: () => harm, get crime() { return crime; }, exitCar, makeCarMesh, ensureModel, carModels: CARMODELS, grass, SKY, sun, setQuality, post, police, nearSolids, renderer, scene, camera, syncCar, updateCamera, car, stepCar, resetCar, soft: () => soft, crash, harm, repairCar, applyDamage, traffic, city, PRESETS, chooseCar, respawn, // console access for tuning
  addSolid, view(mode, angle, radius = 11) { camMode = camModes.indexOf(mode); camSnap = true; orbitR = radius; if (angle !== undefined) { orbitA = angle; orbitHold = true; } } };
el('loading').hidden = true;
}
// Building the valley takes a moment: let the loading message paint first
setTimeout(() => {
  boot().catch(e => { console.error(e); document.getElementById('loading').textContent = 'Something went wrong building the world: ' + e.message; });
}, 30);
