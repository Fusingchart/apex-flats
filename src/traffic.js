/*
 * AI traffic.
 *
 * Cars live in a fixed pool and are only active near the player: they spawn out of sight 130-460 m away,
 * in proportion to how busy each kind of road is (dense downtown and on the freeway, sparse in the suburbs),
 * and are recycled once they are more than ~520 m away.
 *
 * Each car is a full vehicle: a dynamic bicycle model with load transfer, a Pacejka-style tyre curve, a
 * front-wheel-drive powertrain and its own soft-body crash structure. The driver:
 *   route     - Dijkstra over directed links to a random destination, extended before it runs out
 *   steering  - pure pursuit on the lane centre with speed-scaled look-ahead and a little human wander
 *   speed     - Intelligent Driver Model for following; free-road speed capped by the limit and by
 *               comfortable lateral g in curves, anticipated with a comfortable braking envelope
 *   junctions - stop signs (first-come first-served at all-way stops, HCM critical gaps at two-way stops),
 *               signals with a yellow dilemma-zone decision, left turns that yield, and geometric conflict
 *               checks so nobody enters a box someone else is crossing
 *   freeway   - keeps right, overtakes slower cars, merges off the acceleration lane when there is a safe gap,
 *               and moves right well before its exit
 *   pedals    - desired acceleration becomes throttle/brake through a force feed-forward, rate-limited
 */
(function () {
'use strict';
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const sat = a => Math.sin(1.65 * Math.atan(9 * a));

/**
 * Rigid contact between a car's passenger-cell circle and an obstacle (circle or box). If `Bd` is a body,
 * the impulse is shared; otherwise the obstacle is fixed. Bodies are {x, z, h, vx, vz, w, m, I}.
 * Returns the closing speed (m/s) if there was an impact.
 */
function coreContact(A, off, cr, o, Bd) {
  const s = Math.sin(A.h), c = Math.cos(A.h);
  const px = A.x + s * off, pz = A.z + c * off;
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
  const share = Bd ? Bd.m / (A.m + Bd.m) : 1;
  A.x += nx * pen * share; A.z += nz * pen * share;
  if (Bd) { Bd.x -= nx * pen * (1 - share); Bd.z -= nz * pen * (1 - share); }
  const cx = px - nx * cr, cz = pz - nz * cr;
  const rax = cx - A.x, raz = cz - A.z;
  let vrx = A.vx + A.w * raz, vrz = A.vz - A.w * rax, rbx = 0, rbz = 0;
  if (Bd) { rbx = cx - Bd.x; rbz = cz - Bd.z; vrx -= Bd.vx + Bd.w * rbz; vrz -= Bd.vz - Bd.w * rbx; }
  const vn = vrx * nx + vrz * nz;
  if (vn >= 0) return 0;
  const rnA = nx * raz - nz * rax, rnB = nx * rbz - nz * rbx;
  const k = 1 / A.m + rnA * rnA / A.I + (Bd ? 1 / Bd.m + rnB * rnB / Bd.I : 0);
  const j = -(1 + 0.05) * vn / k;
  A.vx += j * nx / A.m; A.vz += j * nz / A.m; A.w += j * rnA / A.I;
  if (Bd) { Bd.vx -= j * nx / Bd.m; Bd.vz -= j * nz / Bd.m; Bd.w -= j * rnB / Bd.I; Bd.hitDv = (Bd.hitDv || 0) + j / Bd.m; }
  A.hitDv = (A.hitDv || 0) + j / A.m;
  const tx = -nz, tz = nx, vt = vrx * tx + vrz * tz;
  const jt = -clamp(vt / k * 0.5, -o.mu * j, o.mu * j);
  A.vx += jt * tx / A.m; A.vz += jt * tz / A.m;
  if (Bd) { Bd.vx -= jt * tx / Bd.m; Bd.vz -= jt * tz / Bd.m; }
  return -vn;
}

/** Could obstacle `o` touch a car-sized box at (x, y, z, heading h) within `margin`? (height-aware broad phase) */
function nearCar(x, z, h, o, margin, y = 0) {
  const y0 = o.y0 || 0;
  if (y0 > y + 1.6 || y0 + o.h < y + 0.1) return false;
  const s = Math.sin(h), c = Math.cos(h), dx = o.x - x, dz = o.z - z;
  const lx = Math.abs(dx * c - dz * s), lz = Math.abs(dx * s + dz * c);
  const r = o.type === 'circle' ? o.r : Math.hypot(o.hx, o.hz);
  return lx < 0.95 + r + margin && lz < 2.3 + r + margin;
}

window.createTraffic = function (ctx) {
  const { scene, city, rand, nearSolids, localObstacle, player, softConfig, camera, max = 44, carModels = [] } = ctx;
  const LW = city.LW;

  const COLORS = [[0.72, 0.73, 0.74], [0.88, 0.88, 0.86], [0.05, 0.05, 0.06], [0.33, 0.34, 0.36], [0.09, 0.15, 0.3],
    [0.55, 0.06, 0.06], [0.62, 0.57, 0.48], [0.14, 0.26, 0.18], [0.33, 0.07, 0.09], [0.38, 0.52, 0.66], [0.8, 0.8, 0.82], [0.2, 0.2, 0.22]];
  const STYLE_SPECS = {
    sedan: { mass: 1450, I: 2200, cg: 0.52, power: 125e3 },
    hatch: { mass: 1250, I: 1800, cg: 0.5, power: 95e3 },
    suv: { mass: 1850, I: 3000, cg: 0.66, power: 160e3 },
    police: { mass: 1700, I: 2500, cg: 0.5, power: 290e3 },
  };
  // One draw call per wheel: tyre and rim merged, coloured per vertex
  const wheelGeo = (() => {
    const t = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 18).rotateZ(Math.PI / 2).toNonIndexed();
    const r = new THREE.CylinderGeometry(0.2, 0.2, 0.25, 12).rotateZ(Math.PI / 2).toNonIndexed();
    const pos = [...t.attributes.position.array, ...r.attributes.position.array], col = [];
    for (let i = 0; i < t.attributes.position.count; i++) col.push(0.06, 0.06, 0.07);
    for (let i = 0; i < r.attributes.position.count; i++) col.push(0.55, 0.54, 0.52);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  })();
  const wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 });
  const vehicles = [];
  const playerBox = { type: 'box', hx: 0.95, hz: 2.26, h: 1.5, mu: 0.5, isPlayer: true, body: player };
  let now = 0;

  /* ---------------- Pool ---------------- */
  function makeVehicle(id, police = false) {
    const r = rand(), style = police ? 'sedan' : r < 0.4 ? 'sedan' : r < 0.65 ? 'hatch' : 'suv', spec = police ? STYLE_SPECS.police : STYLE_SPECS[style];
    const paint = police ? [0.012, 0.013, 0.016] : COLORS[(rand() * COLORS.length) | 0];
    // the real car model when it's loaded (shared geometry until the car is first dented), else a built body
    const accent = police ? [0.85, 0.85, 0.85] : rand() < 0.6 ? [0.012, 0.012, 0.014] : paint.map(c => c * 0.35);
    const carModel = carModels.length ? carModels[(rand() * carModels.length) | 0] : null;
    const kit = carModel ? buildModelCar(carModel, { paint, paint2: accent }) : buildCarBody({ style, paint, lite: true });
    const group = new THREE.Group(), body = new THREE.Group(); group.add(body); scene.add(group);
    group.rotation.order = 'YXZ'; group.visible = false;
    const soft = new SoftBody(softConfig(kit.top));
    const bindings = new Map(), lazy = [];
    for (const { mesh, opts } of kit.meshes) { body.add(mesh); if (kit.model) lazy.push([mesh, opts]); else bindings.set(mesh, soft.bind(mesh.geometry, opts || { wrinkle: 0 })); }
    const wheels = kit.model && kit.makeWheel ? [0, 1, 2, 3].map(i => {
      const w = kit.makeWheel(i), steer = new THREE.Group(); steer.position.copy(w.center); steer.add(w.spin, w.fixed); group.add(steer);
      return { steer, spin: w.spin, x: w.center.x, z: w.center.z, y: w.center.y, dx: 0, dz: 0 };
    }) : [[0.8, 1.25], [-0.8, 1.25], [0.8, -1.35], [-0.8, -1.35]].map(([x, z]) => {
      const steer = new THREE.Group(), spin = new THREE.Mesh(wheelGeo, wheelMat);
      spin.castShadow = true; steer.position.set(x, 0.33, z); steer.add(spin); group.add(steer);
      return { steer, spin, x, z, dx: 0, dz: 0 };
    });
    const calm = rand();
    const drv = {
      vf: lerp(0.92, 1.12, rand()), T: lerp(1.0, 1.9, calm), a: lerp(2.2, 1.3, calm), b: lerp(2.6, 1.8, calm),
      s0: lerp(1.6, 2.6, rand()), lat: lerp(2.6, 1.9, calm), stopWait: lerp(0.6, 1.6, rand()), gap: lerp(0.85, 1.15, calm),
      bias: (rand() - 0.5) * 0.3, wander: rand() * TAU, wanderRate: lerp(0.4, 0.8, rand()), overtake: lerp(1.5, 4, calm),
    };
    const v = {
      id, style, kit, group, body, soft, bindings, lazy: lazy.length ? lazy : null, dented: false, wheels, drv, paint,
      m: spec.mass, I: spec.I, cg: spec.cg, power: spec.power, a: 1.25, b: 1.35,
      x: 1e6, y: 0, z: 1e6, h: 0, vx: 0, vz: 0, w: 0, px: 1e6, pz: 1e6, ph: 0, steer: 0, ax: 0, ay: 0, slope: 0,
      throttle: 0, brake: 0, aDes: 0, gear: 1, rpm: 800, frontRot: 0, pitch: 0, pitchV: 0, roll: 0, rollV: 0,
      state: 'idle', hitDv: 0, crashDv: 0, crashT: 0, signal: 0, hazard: false, horn: 0, stillT: 0,
      box: { type: 'box', hx: 0.95, hz: 2.26, h: kit.top, mu: 0.5, y0: 0, x: 1e6, z: 1e6, ux: 1, uz: 0 }, pool: [],
    };
    v.box.body = v;
    if (police) dressPolice(v);
    return v;
  }
  // Police livery: white doors lettered POLICE, a push bar, and a roof light bar with red and blue lenses
  const policeTex = (() => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#f4f4f2'; g.fillRect(0, 0, 512, 128);
    g.fillStyle = '#10131c'; g.font = '700 78px "Chakra Petch", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('POLICE', 256, 70);
    g.fillStyle = '#1d3f8f'; g.fillRect(0, 0, 512, 14); g.fillRect(0, 114, 512, 14);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 8; return t;
  })();
  const doorMat = new THREE.MeshStandardMaterial({ map: policeTex, roughness: 0.35, metalness: 0.1 });
  const barMat = new THREE.MeshStandardMaterial({ color: '#16171a', roughness: 0.5, metalness: 0.4 });
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
  })();
  function dressPolice(v) {
    v.police = true;
    const top = v.kit.top;
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.34, 1.5), doorMat);
      m.position.set(sx * ((v.kit.bodyHalfW || 0.9) - 0.03), v.kit.model ? 0.62 : 0.78, -0.15); v.body.add(m);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.09, 0.3), barMat); bar.position.set(0, top + 0.03, -0.35); v.body.add(bar);
    const push = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.32, 0.12), barMat); push.position.set(0, 0.5, 2.28); v.body.add(push);
    v.lights = [['#ff2a2a', -0.3], ['#2a5bff', 0.3]].map(([col, x]) => {
      const mat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.2, roughness: 0.3 });
      const lens = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.26), mat); lens.position.set(x, top + 0.1, -0.35); v.body.add(lens);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
      glow.scale.set(2.4, 2.4, 1); glow.position.set(x, top + 0.16, -0.35); v.body.add(glow);
      return { mat, glow };
    });
  }
  for (let i = 0; i < max; i++) vehicles.push(makeVehicle(i));
  const N_POLICE = 14;
  for (let i = 0; i < N_POLICE; i++) vehicles.push(makeVehicle(max + i, true));

  /* ---------------- Paths ---------------- */
  // A path is a flat list of points with arc length s. Route entries are {link, k (lane index)}; events mark
  // stop lines and lane ends along the path.
  const laneOf = (L, k) => k === -1 ? L.accel : L.lanes[k];
  function pushPts(v, pts, from, piece, siBase) {
    const P = v.path;
    for (let i = from; i < pts.length; i++) {
      const p = pts[i], last = P[P.length - 1];
      const si = siBase === undefined ? i : siBase + (i - from);
      const lim = piece.speed || piece.link.speed;
      if (last) {
        const d = Math.hypot(p.x - last.x, p.z - last.z);
        if (d < 0.3) continue;
        P.push({ x: p.x, y: p.y || 0, z: p.z, s: last.s + d, lim, piece, si });
      } else P.push({ x: p.x, y: p.y || 0, z: p.z, s: 0, lim, piece, si });
    }
  }
  function addEntry(v, L, k, fromSi = 0) {
    const entry = { link: L, k }, lane = laneOf(L, k);
    entry.s0 = v.path.length ? v.path[v.path.length - 1].s : 0;
    v.route.push(entry);
    pushPts(v, lane.pts, fromSi, { kind: 'lane', link: L, k, entry });
    entry.s1 = v.path[v.path.length - 1].s;
    if (k === -1) v.events.push({ s: entry.s1, control: 'laneEnd', entry });
    else if (k === 1 && L.kind === 'fwy' && L.to.type !== 'fwy') v.events.push({ s: entry.s1 - 130, control: 'laneEnd', entry }); // the freeway ends: the left lane stops before the taper
    else if (L.to.type !== 'fwy') v.events.push({ s: entry.s1, node: L.to, control: lane.control, axis: lane.axis, dir: lane.dir, turn: 'straight', conn: null, connEnd: 0, entry });
  }
  function appendLinks(v, list) {
    for (const L of list) {
      const prev = v.route[v.route.length - 1], n = prev.link.to;
      if (n.type === 'fwy') {
        addEntry(v, L, L.kind === 'fwy' ? (prev.link.kind === 'ramp' ? -1 : Math.max(0, prev.k)) : 0);
      } else {
        const conn = city.conns.get(prev.link.id + '>' + L.id);
        if (!conn) return false;
        const ev = v.events[v.events.length - 1];
        if (ev && ev.node === n) { ev.turn = conn.turn; ev.conn = conn; }
        pushPts(v, conn.pts, 0, conn);
        if (ev && ev.node === n) ev.connEnd = v.path[v.path.length - 1].s;
        addEntry(v, L, 0);
      }
    }
    return true;
  }
  function extend(v) {
    const last = v.route[v.route.length - 1].link;
    const r = city.route(last, city.randomDestination(last.to));
    if (r) appendLinks(v, r);
  }
  function startOn(v, L, k, si) {
    v.path = []; v.events = []; v.route = []; v.pi = 0;
    addEntry(v, L, k, si);
    extend(v);
  }
  // Lane change: keep the path up to here, blend across over ~3 s of travel, then follow the new lane and
  // re-append the rest of the route with the lane rules applied again.
  function changeLane(v, k2) {
    const pt = v.path[v.pi], pc = pt.piece;
    if (pc.kind !== 'lane') return false;
    const entry = pc.entry, L = entry.link, k1 = entry.k, target = laneOf(L, k2);
    if (!target) return false;
    const A = laneOf(L, k1).pts, Bp = target.pts, si = pt.si;
    const M = clamp(Math.round(Math.max(speedOf(v), 6) * 3 / 4), 6, 22);
    if (si + M + 3 >= Bp.length) return false;
    const ri = v.route.indexOf(entry), rest = v.route.slice(ri + 1).map(e => e.link);
    v.path.length = v.pi + 1;
    const sCut = v.path[v.pi].s;
    v.events = v.events.filter(e => e.s <= sCut && e.entry !== entry);
    v.route.length = ri + 1; entry.k = k2;
    const piece = { kind: 'lane', link: L, k: k2, entry }, blend = [];
    for (let j = si + 1; j <= si + M; j++) {
      const t = smooth((j - si) / M), a = A[Math.min(j, A.length - 1)], b = Bp[j];
      blend.push({ x: lerp(a.x, b.x, t), y: lerp(a.y || 0, b.y || 0, t), z: lerp(a.z, b.z, t) });
    }
    pushPts(v, blend, 0, piece, si + 1);
    pushPts(v, Bp, si + M + 1, piece);
    entry.s1 = v.path[v.path.length - 1].s;
    if (L.to.type !== 'fwy') { v.events.push({ s: entry.s1, node: L.to, control: target.control, axis: target.axis, dir: target.dir, turn: 'straight', conn: null, connEnd: 0, entry }); }
    appendLinks(v, rest);
    v.lcEnd = v.path[Math.min(v.path.length - 1, v.pi + M)].s;
    v.lcCool = now + 6;
    v.signal = k2 > k1 ? 1 : -1; v.signalUntil = now + 4;
    return true;
  }
  // Couldn't get across to an exit in time: stay on the freeway and plan again from the next link
  function skipExit(v, entry) {
    const L = entry.link, ri = v.route.indexOf(entry);
    const cont = L.to.out.find(o => o.kind === 'fwy');
    if (!cont || ri < 0) return;
    v.route.length = ri + 1;
    const keep = v.path.findIndex(p => p.s > entry.s1);
    if (keep > 0) v.path.length = keep;
    v.events = v.events.filter(e => e.s <= entry.s1);
    appendLinks(v, [cont]);
    extend(v);
  }

  /* ---------------- Spawning around the player ---------------- */
  const SPAWN_MIN = 130, SPAWN_MAX = 460, DESPAWN = 520;
  const cellsTmp = [], camDir = new THREE.Vector3();
  function inView(x, y, z) {
    camera.getWorldDirection(camDir);
    const dx = x - camera.position.x, dy = y - camera.position.y, dz = z - camera.position.z, d = Math.hypot(dx, dy, dz) || 1;
    return (dx * camDir.x + dy * camDir.y + dz * camDir.z) / d > 0.6;
  }
  function activate(v, c) {
    repair(v);
    const L = c.link, pts = laneOf(L, c.lane).pts, a = pts[c.si], b = pts[c.si + 1];
    Object.assign(v, { state: 'drive', x: a.x, y: a.y || 0, z: a.z, h: Math.atan2(b.x - a.x, b.z - a.z), w: 0, steer: 0, ax: 0, ay: 0,
      hitDv: 0, crashDv: 0, hazard: false, signal: 0, cleared: null, waiting: null, commit: null, leader: null, leaderGap: Infinity,
      stillT: 0, lcEnd: 0, lcCool: now + 2, throttle: 0.2, brake: 0, ignore: null, blockedBy: null, slope: 0 });
    v.px = v.x; v.pz = v.z; v.ph = v.h;
    const sp = L.speed * 0.85;
    v.vx = Math.sin(v.h) * sp; v.vz = Math.cos(v.h) * sp;
    startOn(v, L, c.lane, c.si);
    refreshBox(v); refreshBox(v);
    v.group.visible = true;
  }
  function deactivate(v) {
    v.state = 'idle'; v.group.visible = false; v.path = null; v.commit = null; v.waiting = null; v.next = null; v.leader = null;
    v.x = v.px = 1e6 + v.id * 50; v.z = v.pz = 1e6; v.box.x = v.box.px = v.x; v.box.z = v.box.pz = v.z;
  }
  function manage(initial) {
    const px = player.x, pz = player.z;
    for (const v of vehicles) {
      if (v.state === 'idle') continue;
      const d = Math.hypot(v.x - px, v.z - pz);
      if (v.state === 'pursue' || v.state === 'block') { if (d > (v.state === 'block' ? 500 : 900)) deactivate(v); continue; }
      if (d > DESPAWN || (v.state === 'wreck' && now - v.crashT > 20 && d > 110) || (v.stillT > 40 && d > 90) || (v.state === 'halt' && ((v.stillT > 8 && d > 60) || !inView(v.x, v.y, v.z)))) deactivate(v);
    }
    city.cellsNear(px, pz, SPAWN_MAX, cellsTmp);
    let expected = 0;
    const cand = [], cum = [];
    for (const c of cellsTmp) {
      expected += c.w;
      if (Math.hypot(c.x - px, c.z - pz) < (initial ? 25 : SPAWN_MIN)) continue;
      cand.push(c); cum.push((cum.length ? cum[cum.length - 1] : 0) + c.w);
    }
    let count = vehicles.filter(v => v.state !== 'idle' && !v.police).length;
    // a couple of patrol cars on the beat, as long as nobody is being chased
    const patrols = vehicles.filter(v => v.police && v.state !== 'idle').length;
    if (!pol.active && patrols < 2 && cand.length) {
      const c = cand[(rand() * cand.length) | 0], v = vehicles.find(u => u.police && u.state === 'idle');
      if (v && (initial || !inView(c.x, c.y, c.z)) && Math.hypot(player.x - c.x, player.z - c.z) > 60) activate(v, c);
    }
    const target = Math.min(max, Math.round(expected));
    for (let tries = 0; tries < (initial ? 400 : 10) && count < target && cand.length; tries++) {
      const pick = rand() * cum[cum.length - 1];
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < pick) lo = mid + 1; else hi = mid; }
      const c = cand[lo], d = Math.hypot(c.x - px, c.z - pz);
      if (!initial && d < 300 && inView(c.x, c.y, c.z)) continue;
      if (vehicles.some(u => u.state !== 'idle' && (u.x - c.x) ** 2 + (u.z - c.z) ** 2 < 28 * 28 && Math.abs(u.y - c.y) < 3)) continue;
      if (Math.hypot(player.x - c.x, player.z - c.z) < 20) continue;
      const v = vehicles.find(u => u.state === 'idle' && !u.police);
      if (!v) break;
      activate(v, c); count++;
    }
  }

  /* ---------------- Tracking ---------------- */
  function track(v) {
    const P = v.path;
    let i = v.pi;
    const d2 = k => (P[k].x - v.x) ** 2 + (P[k].z - v.z) ** 2;
    for (let n = 0; n < 60 && i < P.length - 2 && d2(i + 1) <= d2(i); n++) i++;
    v.pi = i;
    const a = P[i], b = P[i + 1], tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz) || 1;
    v.s = a.s + ((v.x - a.x) * tx + (v.z - a.z) * tz) / l;
    v.lat = ((v.x - a.x) * -tz + (v.z - a.z) * tx) / l;
    v.pathYaw = Math.atan2(tx, tz);
  }
  function pointAtS(v, s) {
    const P = v.path;
    let i = v.pi;
    while (i < P.length - 2 && P[i + 1].s < s) i++;
    const a = P[i], b = P[i + 1], ds = (b.s - a.s) || 1, t = clamp((s - a.s) / ds, 0, 1);
    return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), tx: (b.x - a.x) / ds, tz: (b.z - a.z) / ds };
  }
  function curvature(P, i) {
    const a = P[Math.max(0, i - 3)], b = P[i], c = P[Math.min(P.length - 1, i + 3)];
    const abx = b.x - a.x, abz = b.z - a.z, bcx = c.x - b.x, bcz = c.z - b.z;
    const d = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(c.x - a.x, c.z - a.z);
    return d > 1e-6 ? 2 * (abx * bcz - abz * bcx) / d : 0;
  }

  /* ---------------- Perception ---------------- */
  const speedOf = u => Math.hypot(u.vx, u.vz);
  const bodies = () => { const out = [player]; for (const v of vehicles) if (v.state !== 'idle') out.push(v); return out; };
  function inNode(n, except) {
    for (const u of vehicles) {
      if (u === except || u.state === 'idle' || Math.abs(u.y - n.y) > 2) continue;
      if (Math.hypot(u.x - n.x, u.z - n.z) < 9.5) return true;
      if (u.commit && u.commit.node === n && u.state === 'drive') return true;
    }
    return Math.abs(player.y - n.y) < 2 && Math.hypot(player.x - n.x, player.z - n.z) < 10;
  }
  function approaching(n, secs, filter) {
    for (const u of vehicles) {
      if (u.state !== 'drive' || !u.next || u.next.node !== n) continue;
      if (filter && !filter(u.next)) continue;
      const dist = u.next.s - u.s, sp = Math.max(speedOf(u), 0.5);
      if (dist < 130 && dist / sp < secs && !(u.waiting && u.waiting.node === n)) return true;
    }
    if (Math.abs(player.y - n.y) > 2) return false;
    const dx = n.x - player.x, dz = n.z - player.z, d = Math.hypot(dx, dz);
    if (d < 130 && d > 9) {
      const vr = (player.vx * dx + player.vz * dz) / d;
      if (vr > 1.5 && (d - 11) / vr < secs) {
        const sp = speedOf(player);
        if (!filter || filter({ dir: { x: player.vx / sp, z: player.vz / sp }, control: 'none', player: true })) return true;
      }
    }
    return false;
  }
  function movementAt(u, n) {
    if (u.commit && u.commit.node === n) return u.commit.conn;
    const pc = u.path && u.path[u.pi].piece;
    if (pc && pc.kind === 'conn' && pc.node === n) return pc;
    if (u.next && u.next.node === n && u.next.s - u.s - 2.3 < 3 && speedOf(u) > 0.5) return u.next.conn;
    return null;
  }
  function boxConflict(n, ev, self) {
    for (const u of vehicles) {
      if (u === self || u.state === 'idle') continue;
      const m = movementAt(u, n);
      if (m && city.conflicts(ev.conn, m)) return true;
      if (u.state === 'wreck' && Math.hypot(u.x - n.x, u.z - n.z) < 11) return true;
    }
    return Math.abs(player.y - n.y) < 2 && Math.hypot(player.x - n.x, player.z - n.z) < 10.5 && speedOf(player) > 0.5;
  }
  function commit(v, ev) { v.cleared = ev; v.commit = { node: ev.node, until: ev.connEnd || ev.s + 20, conn: ev.conn }; }
  function oncomingInside(n, ev, self) {
    for (const u of vehicles) {
      if (u === self || u.state === 'idle' || Math.hypot(u.x - n.x, u.z - n.z) > 10) continue;
      if (u.vx * ev.dir.x + u.vz * ev.dir.z < -1.5) return true;
    }
    return false;
  }
  // Is the adjacent lane (side +1 = left, -1 = right) clear enough to move into?
  function gapSafe(v, side) {
    const fx = Math.sin(v.h), fz = Math.cos(v.h), sx = Math.cos(v.h), sz = -Math.sin(v.h), vv = speedOf(v);
    for (const u of bodies()) {
      if (u === v || Math.abs((u.y || 0) - v.y) > 2) continue;
      const dx = u.x - v.x, dz = u.z - v.z, lon = dx * fx + dz * fz, lat = dx * sx + dz * sz;
      if (Math.abs(lon) > 100 || Math.abs(lat - side * LW) > 2.2) continue;
      const vu = u.vx * fx + u.vz * fz;
      if (lon > 0) { if (lon - 4.6 < 5 + Math.max(0, vv - vu) * 1.6) return false; }
      else if (-lon - 4.6 < 6 + Math.max(0, vu - vv) * 2.4 + vu * 0.35) return false;
    }
    return true;
  }
  // Slowest car ahead in the adjacent lane within `range` metres (Infinity if none)
  function laneSpeedAhead(v, side, range) {
    const fx = Math.sin(v.h), fz = Math.cos(v.h), sx = Math.cos(v.h), sz = -Math.sin(v.h);
    let m = Infinity;
    for (const u of bodies()) {
      if (u === v || Math.abs((u.y || 0) - v.y) > 2) continue;
      const dx = u.x - v.x, dz = u.z - v.z, lon = dx * fx + dz * fz, lat = dx * sx + dz * sz;
      if (lon > 0 && lon < range && Math.abs(lat - side * LW) < 2) m = Math.min(m, u.vx * fx + u.vz * fz);
    }
    return m;
  }

  /* ---------------- Driver ---------------- */
  function drive(v, dt) {
    const D = v.drv, P = v.path;
    track(v);
    const sp = speedOf(v), fx = Math.sin(v.h), fz = Math.cos(v.h);
    const vv = Math.max(0, v.vx * fx + v.vz * fz);

    if (P[P.length - 1].s - v.s < 700) extend(v);
    if (v.pi > 400) {
      const cut = 300, s0 = P[cut].s;
      P.splice(0, cut); v.pi -= cut;
      v.events = v.events.filter(e => e.s >= s0 - 5);
      while (v.route.length > 1 && v.route[1].s0 < s0 - 50) v.route.shift();
    }
    let he = v.h - v.pathYaw; he = Math.atan2(Math.sin(he), Math.cos(he));
    // lost: well off the lane, or pointing the wrong way at walking pace for a couple of seconds
    v.lostT = Math.abs(he) > 1.1 && sp < 6 ? (v.lostT || 0) + dt : 0;
    if (Math.abs(v.lat) > 4.5 || v.lostT > 2) { wreck(v, Math.abs(v.lat) > 4.5 ? 'off lane' : 'heading'); return; }

    // slope, for gravity and pitch
    const yf = city.heightAt(v.x + fx * 1.6, v.z + fz * 1.6, v.y), yr = city.heightAt(v.x - fx * 1.6, v.z - fz * 1.6, v.y);
    v.slope = (yf - yr) / 3.2;

    // --- Steering: pure pursuit from the rear axle
    D.wander += dt * D.wanderRate;
    const Ld = clamp(4 + 0.42 * vv, 5, 22), tgt = pointAtS(v, v.s + Ld);
    let off = D.bias + Math.sin(D.wander) * 0.08;
    // Sirens behind: ease over to the kerb and slow right down until they're past
    let yieldTo = false;
    if (pol.active) for (const u of vehicles) {
      if (!u.police || u.state !== 'pursue') continue;
      const qx = u.x - v.x, qz = u.z - v.z, dd = Math.hypot(qx, qz);
      if (dd < 70 && qx * fx + qz * fz < 8 && Math.abs(u.y - v.y) < 3) { yieldTo = true; break; }
    }
    if (yieldTo) { D.yieldT = 2.5; }
    D.yieldT = Math.max(0, (D.yieldT || 0) - dt);
    if (D.yieldT > 0 && P[v.pi].piece.kind === 'lane' && P[v.pi].piece.link.kind !== 'fwy') off += 1.9 * Math.min(1, D.yieldT);
    // You, coming at them fast: brake hard, swerve towards the kerb, lean on the horn
    {
      const qx = player.x - v.x, qz = player.z - v.z, dd = Math.hypot(qx, qz);
      const close = -((qx * (player.vx - v.vx) + qz * (player.vz - v.vz)) / Math.max(dd, 1));
      if (dd < 45 && close > 8 && Math.abs(player.y - v.y) < 3) {
        const ttc = dd / close, lat = Math.abs(qx * fz - qz * fx);
        if (ttc < 1.8 && lat < 4) { D.panicT = 1.2; v.horn = 1; }
      }
      D.panicT = Math.max(0, (D.panicT || 0) - dt);
      if (D.panicT > 0) off += 1.6;
    }
    const tx = tgt.x - tgt.tz * off, tz = tgt.z + tgt.tx * off;
    const rx = v.x - fx * v.b, rz = v.z - fz * v.b;
    let alpha = Math.atan2(tx - rx, tz - rz) - v.h; alpha = Math.atan2(Math.sin(alpha), Math.cos(alpha));
    D.steerCmd = clamp(Math.atan2(2 * (v.a + v.b) * Math.sin(alpha), Math.hypot(tx - rx, tz - rz)), -0.6, 0.6);

    // --- Speed: limits and curves, with a comfortable braking envelope
    let vTarget = P[v.pi].lim * D.vf;
    const look = 25 + vv * vv / (2 * D.b) + 15;
    for (let i = v.pi; i < P.length && P[i].s - v.s < look; i += 2) {
      const lim = Math.min(P[i].lim * D.vf, Math.sqrt(D.lat / Math.max(Math.abs(curvature(P, i)), 1e-4)));
      vTarget = Math.min(vTarget, Math.sqrt(lim * lim + 2 * D.b * Math.max(0, P[i].s - v.s - 4)));
    }
    const v0 = Math.max(vTarget, 0.1);
    let aDes = vv <= v0 ? D.a * (1 - (vv / v0) ** 4) : -Math.min(D.b * 1.6, (vv - v0) * 1.2 + 0.3);
    const idm = (gap, vl) => {
      const sStar = D.s0 + Math.max(0, vv * D.T + vv * (vv - vl) / (2 * Math.sqrt(D.a * D.b)));
      return D.a * (1 - (vv / v0) ** 4) - D.a * (sStar / Math.max(gap, 0.2)) ** 2;
    };

    // --- Leaders: anything (AI or the player) on the path ahead
    v.leaderGap = Infinity; v.leader = null;
    for (const u of vehicles) if (u !== v && u.state !== 'idle' && u.leader === v && u.leaderGap < 6 && v.blockedBy === u && u.id > v.id) { v.ignore = u; v.ignoreUntil = now + 4; }
    let creeping = false;
    const range = Math.max(75, vv * 4.5);
    for (const u of bodies()) {
      if (u === v || Math.abs((u.y || 0) - v.y) > 2.5) continue;
      if (u === v.ignore && now < v.ignoreUntil) { creeping = true; continue; }
      const dx = u.x - v.x, dz = u.z - v.z;
      if (dx * dx + dz * dz > range * range || dx * fx + dz * fz < -3) continue;
      const us = Math.sin(u.h), uc = Math.cos(u.h);
      const inside = (x, z) => { const qx = x - u.x, qz = z - u.z; return Math.abs(qx * uc - qz * us) < 0.95 + 1.1 && Math.abs(qx * us + qz * uc) < 2.26 + 0.4; };
      for (let i = v.pi; i < P.length && P[i].s - v.s < range; i += 2) {
        if (!inside(P[i].x, P[i].z)) continue;
        let lo = Math.max(v.s, P[Math.max(v.pi, i - 2)].s), hi = P[i].s;
        for (let k = 0; k < 10; k++) { const mid = (lo + hi) / 2, q = pointAtS(v, mid); if (inside(q.x, q.z)) hi = mid; else lo = mid; }
        const gap = hi - v.s - 2.26;
        const a = P[i], b = P[Math.min(P.length - 1, i + 1)], l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const vl = (u.vx * (b.x - a.x) + u.vz * (b.z - a.z)) / l;
        aDes = Math.min(aDes, idm(gap, Math.max(0, vl)));
        if (gap < v.leaderGap) { v.leaderGap = gap; v.leader = u; }
        break;
      }
    }
    v.blockedBy = v.leader && v.leaderGap < 6 ? v.leader : null;
    if (creeping) aDes = Math.min(aDes, 1.2 * (2.5 - vv));

    // --- Freeway lane choice
    const pc = P[v.pi].piece;
    if (pc.kind === 'lane' && pc.link.kind === 'fwy' && !(v.lcEnd > v.s)) {
      const entry = pc.entry, k = entry.k;
      let toExit = Infinity, exitIdx = -1;
      for (let i = 0; i < v.route.length; i++) {
        const e = v.route[i];
        if (e.link.kind === 'ramp' && e.link.from.type === 'fwy' && e.s0 > v.s) { toExit = e.s0 - v.s; exitIdx = i; break; }
        if (e.link.kind === 'fwy' && e.link.to.type !== 'fwy' && e.s1 > v.s) { toExit = Math.max(1, e.s1 - 160 - v.s); break; } // the freeway ends: the left lane merges
      }
      const free = P[v.pi].lim * D.vf;
      let want = k;
      if (k === -1) want = 0;
      else if (toExit < 1100) want = 0;
      else if (k === 0 && v.leader && v.leaderGap < 70 && speedOf(v.leader) < free - D.overtake) want = 1;
      else if (k === 1 && now > v.lcCool && laneSpeedAhead(v, -1, 120) > free - 2) want = 0;
      const urgent = k === -1 || toExit < 1100;
      if (want !== k && (now > v.lcCool || urgent) && gapSafe(v, want > k ? 1 : -1)) changeLane(v, want);
      else if (want !== k && (k === -1 || toExit < 600)) aDes = Math.min(aDes, -0.6); // ease off to find a gap
      if (k === 1 && exitIdx > 0 && toExit < 220) skipExit(v, v.route[exitIdx - 1]);
    }

    // --- Junctions and lane ends
    if (v.commit && v.s > v.commit.until) v.commit = null;
    let ev = null;
    for (const e of v.events) if (e.s > v.s - 2.5) { ev = e; break; }
    v.next = ev && ev.node ? ev : null;
    if (!(v.signalUntil > now)) v.signal = 0;
    if (ev) {
      const toLine = ev.s - v.s - 2.3, n = ev.node;
      let mustStop = false;
      if (ev.control === 'laneEnd') mustStop = true;
      else if (v.cleared === ev) mustStop = false;
      else if (ev.control === 'signal') {
        const st = city.signalState(n, ev.axis);
        if (st === 'R') mustStop = toLine > -0.5;
        else if (st === 'Y') mustStop = toLine > vv * vv / (2 * 3.4) + 1;
        if (!mustStop && toLine < 8 && boxConflict(n, ev, v)) mustStop = toLine > -0.5;
        if (!mustStop && toLine < 30) {
          if (ev.turn === 'left' && (approaching(n, 4.5, e => e.dir.x * ev.dir.x + e.dir.z * ev.dir.z < -0.7) || oncomingInside(n, ev, v))) mustStop = toLine > -0.5;
          else if (st !== 'R' && toLine < 6) commit(v, ev);
        }
      } else if (ev.control === 'stop') {
        mustStop = true;
        if (vv < 0.3 && toLine < 3) {
          if (!v.waiting || v.waiting.ev !== ev) v.waiting = { ev, node: n, t: now };
          if (now - v.waiting.t > D.stopWait && !inNode(n, v) && !boxConflict(n, ev, v)) {
            let go;
            if (n.type === 'allway') go = !vehicles.some(u => u !== v && u.waiting && u.waiting.node === n && u.waiting.t < v.waiting.t && u.state === 'drive');
            else go = !approaching(n, (ev.turn === 'left' ? 7.1 : ev.turn === 'right' ? 6.2 : 6.5) * D.gap, e => e.control === 'none');
            if (go) { commit(v, ev); v.waiting = null; mustStop = false; }
          }
        }
      } else if (ev.conn && n.type !== 'none' && toLine < Math.max(10, vv * vv / (2 * D.b) + 6)) {
        if (boxConflict(n, ev, v)) mustStop = toLine > -0.5;
        else if (ev.turn === 'left' && n.type === 'twoway' && approaching(n, 5, e => e.dir.x * ev.dir.x + e.dir.z * ev.dir.z < -0.7)) mustStop = toLine > -0.5;
        else if (toLine < 4) commit(v, ev);
      }
      if (mustStop) aDes = Math.min(aDes, idm(toLine + D.s0 - 0.25, 0));
      if (ev.node && ev.turn !== 'straight' && toLine < 60) v.signal = ev.turn === 'left' ? 1 : -1;
    }
    const inTurn = v.events.find(e => e.connEnd && v.s > e.s - 2.5 && v.s < e.connEnd);
    if (inTurn && inTurn.turn !== 'straight') v.signal = inTurn.turn === 'left' ? 1 : -1;

    if (vv < 0.3 && v.leader === player && v.leaderGap < 12) { v.blockedT = (v.blockedT || 0) + dt; if (v.blockedT > 6) { v.horn = 1; v.blockedT = -8; } }
    else v.blockedT = 0;
    if (D.yieldT > 0) aDes = Math.min(aDes, vv > 3 ? -3 : -0.5);
    if (D.panicT > 0) aDes = Math.min(aDes, -7.5);
    v.aDes = clamp(aDes, -9, D.a * 1.2);
  }
  /* ---------------- Police pursuit ---------------- */
  // pol.target is where the police think you are (your car while they can see you, the last sighting after)
  const pol = { active: false, target: null };
  const sightTmp = [];
  /** Is the line between two points clear of buildings? (sampled every 5 m against tall solids) */
  function sightClear(ax, az, bx, bz, y) {
    const d = Math.hypot(bx - ax, bz - az), n = Math.ceil(d / 5);
    for (let i = 1; i < n; i++) {
      const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      nearSolids(x, z, 1, sightTmp);
      for (const o of sightTmp) {
        if (o.type !== 'box' || o.h < 3 || (o.y0 || 0) + o.h < y + 1) continue;
        const dx = x - o.x, dz = z - o.z, lx = dx * o.ux + dz * o.uz, lz = -dx * o.uz + dz * o.ux;
        if (Math.abs(lx) < o.hx && Math.abs(lz) < o.hz) return false;
      }
    }
    return true;
  }
  // nearest lane cell, preferring lanes that point the way the car is facing
  function laneCell(x, z, y, h, r = 70) {
    city.cellsNear(x, z, r, cellsTmp);
    let best = null, bd = Infinity;
    for (const c of cellsTmp) {
      if (Math.abs(c.y - y) > 4) continue;
      const pts = laneOf(c.link, c.lane).pts, a = pts[c.si], b = pts[c.si + 1];
      const al = h === undefined ? 1 : Math.cos(Math.atan2(b.x - a.x, b.z - a.z) - h);
      const d = (c.x - x) ** 2 + (c.z - z) ** 2 + (1 - al) * 900;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  // Plan a route through the street network from here to the goal's road
  function plan(v, goal) {
    const from = laneCell(v.x, v.z, v.y, v.h), to = laneCell(goal.x, goal.z, goal.y, undefined, 120);
    v.replanT = 2.5;
    if (!from || !to) { v.path = null; return; }
    v.path = []; v.events = []; v.route = []; v.pi = 0;
    addEntry(v, from.link, from.lane, from.si);
    if (from.link !== to.link) {
      // finish on the target's own link (arriving from its start), so the route actually passes the target;
      // if that turn isn't allowed, settle for its end node
      const r = from.link.to === to.link.from ? [] : to.link.from ? city.route(from.link, to.link.from) : null;
      const ok = r && city.conns.get((r.length ? r[r.length - 1] : from.link).id + '>' + to.link.id);
      if (ok) appendLinks(v, [...r, to.link]);
      else { const r2 = city.route(from.link, to.link.to); if (r2) appendLinks(v, r2); }
    }
    if (v.path.length < 3) v.path = null;
  }
  // How far ahead (up to len) is clear in a direction off the nose? (walls, trees, posts; not kerbs)
  function probe(v, ang, len) {
    const h = v.h + ang, s = Math.sin(h), c = Math.cos(h);
    for (let k = 2.5; k <= len; k += 2.5) {
      const x = v.x + s * k, z = v.z + c * k;
      nearSolids(x, z, 1.2, sightTmp);
      for (const o of sightTmp) {
        if (o.h < 0.8 || (o.y0 || 0) > v.y + 1.5 || (o.y0 || 0) + o.h < v.y + 0.3) continue;
        if (o.type === 'box') {
          const dx = x - o.x, dz = z - o.z, lx = dx * o.ux + dz * o.uz, lz = -dx * o.uz + dz * o.ux;
          if (Math.abs(lx) < o.hx + 1 && Math.abs(lz) < o.hz + 1) return k;
        } else if (o.r > 0.2 && Math.hypot(x - o.x, z - o.z) < o.r + 1) return k;
      }
    }
    return len;
  }
  // Each unit has a job: 'chase' sits on your tail and goes for the PIT, 'flank' pulls alongside and shoves,
  // 'intercept' drives to where you're going to be
  const ROLES = ['chase', 'flank', 'intercept', 'chase', 'flank', 'intercept', 'chase', 'flank'];
  function pursue(v, dt) {
    const T = pol.target;
    if (!T) { v.state = 'halt'; return; }
    const fx = Math.sin(v.h), fz = Math.cos(v.h), vv = v.vx * fx + v.vz * fz, sp = speedOf(v);
    const dx = T.x - v.x, dz = T.z - v.z, d = Math.hypot(dx, dz), Tsp = Math.hypot(T.vx, T.vz);
    const ts = Math.sin(T.h), tc = Math.cos(T.h);           // your heading
    v.chaseT += dt; v.replanT -= dt;
    const yf = city.heightAt(v.x + fx * 1.6, v.z + fz * 1.6, v.y), yr = city.heightAt(v.x - fx * 1.6, v.z - fz * 1.6, v.y);
    v.slope = (yf - yr) / 3.2;
    v.hazard = false; v.signal = 0;
    // catch up when left behind (the radio says floor it), ease off when right on top of you
    v.boost = d > 150 ? 1.3 : d > 70 ? 1.12 : 1;
    // reversing out of a jam
    if (v.rev > 0) {
      v.rev -= dt;
      let a = Math.atan2(dx, dz) - v.h; a = Math.atan2(Math.sin(a), Math.cos(a));
      // back away swinging the nose towards the open side (or towards the target)
      v.drv.steerCmd = -(v.revSide || Math.sign(a)) * 0.6; v.aDes = 0;
      if (v.rev <= 0) v.revSide = 0;
      return;
    }
    // out of your sight and making no headway (wedged, off the road): quietly recycle it; dispatch sends a fresh one
    const lost = sp < 2.5 || (v.path && Math.abs(v.lat || 0) > 5);
    v.badT = lost ? (v.badT || 0) + dt : 0;
    if (v.badT > 4 && d > 50 && !inView(v.x, v.y + 1, v.z)) { deactivate(v); return; }
    // stuck: under power but hardly getting anywhere for a couple of seconds (pinned on a wall, wedged in traffic)
    v.progT = (v.progT || 0) + dt;
    if (v.progT > 1.8) {
      const moved = v.progPos ? Math.hypot(v.x - v.progPos.x, v.z - v.progPos.z) : 99;
      v.progPos = { x: v.x, z: v.z }; v.progT = 0;
      if (moved < 4 && d > 10 && v.chaseT > 3 && v.aDes > 0.5) { v.rev = 2.2; v.path = null; v.revSide = probe(v, 0.6, 12) > probe(v, -0.6, 12) ? 1 : -1; return; }
    }

    let tx, tz, vTarget, direct = false;
    const close = d < 70 && Math.abs(T.y - v.y) < 3 && sightClear(v.x, v.z, T.x, T.z, v.y);
    if (close) {
      direct = true; v.path = null;
      // where you are relative to me, and me relative to you
      const lzMe = (v.x - T.x) * ts + (v.z - T.z) * tc, lxMe = (v.x - T.x) * tc - (v.z - T.z) * ts; // + = ahead of you / to your right
      const lead = clamp(d / 20, 0, 1.4);
      tx = T.x + T.vx * lead; tz = T.z + T.vz * lead;
      vTarget = Tsp + (d > 30 ? 14 : d > 12 ? 7 : 2.5);
      if (v.role === 'flank') {
        // pull level with your door, then turn in
        const side = v.side, gx = T.x + tc * side * 2.6 + ts * 1.5, gz = T.z - ts * side * 2.6 + tc * 1.5;
        if (d < 25 && Math.abs(lzMe) < 3 && Math.abs(lxMe) < 4.5 && Tsp > 5) { tx = T.x + T.vx * 0.6; tz = T.z + T.vz * 0.6; vTarget = Tsp + 2; }
        else { tx = gx + T.vx * lead * 0.8; tz = gz + T.vz * lead * 0.8; }
      } else if (v.role === 'intercept' && lzMe > 0) {
        // ahead of you: turn across your path and stop dead
        tx = T.x + T.vx * 1.2; tz = T.z + T.vz * 1.2; vTarget = d < 20 ? 0 : Tsp * 0.5 + 6;
      } else if (d < 14 && Tsp > 4) {
        // PIT: aim just behind your rear axle on the side I'm already on
        const side = Math.sign(lxMe) || 1;
        tx = T.x - ts * 1.7 + tc * side * 0.8; tz = T.z - tc * 1.7 - ts * side * 0.8;
        vTarget = Tsp + 3;
      }
      if (Tsp < 2 && d < 11) vTarget = 0;                   // you've stopped: box you in
    } else {
      // out of sight: drive the streets to you, or (interceptors) to where you'll be in a few seconds
      const goal = v.role === 'intercept' && Tsp > 6 && d > 90
        ? { x: T.x + T.vx * Math.min(6, 160 / Tsp), z: T.z + T.vz * Math.min(6, 160 / Tsp), y: T.y } : T;
      // re-plan only when the goal has moved on (or the path has run out): constant re-routing makes them weave
      if (!v.path || (v.replanT <= 0 && (!v.goal || Math.hypot(goal.x - v.goal.x, goal.z - v.goal.z) > 35 || v.replanT < -6))) { plan(v, goal); v.goal = { x: goal.x, z: goal.z }; }
      if (!v.path) { tx = T.x; tz = T.z; vTarget = 12; direct = true; }
      else {
        const P = v.path;
        track(v);
        if (Math.abs(v.lat) > 7 || P[P.length - 1].s - v.s < 15) { v.replanT = 0; v.goal = null; }
        const Ld = clamp(4 + 0.32 * Math.max(vv, 0), 5, 15), tgt = pointAtS(v, v.s + Ld); // short look-ahead: no corner cutting
        tx = tgt.x; tz = tgt.z;
        vTarget = P[v.pi].lim * 1.35 + 6;
        const look = 30 + vv * vv / 14;
        for (let i = v.pi; i < P.length && P[i].s - v.s < look; i += 2) {
          const lim = Math.sqrt(8.5 / Math.max(Math.abs(curvature(P, i)), 1e-4));
          vTarget = Math.min(vTarget, Math.sqrt(lim * lim + 2 * 7 * Math.max(0, P[i].s - v.s - 4)));
        }
      }
    }
    // Traffic: follow the car ahead, or overtake on whichever side stays clear for the next couple of seconds
    let leadGap = Infinity, leadV = 0;
    const near = [];
    for (const u of vehicles) {
      if (u === v || u.state === 'idle' || Math.abs(u.y - v.y) > 3) continue;
      const qx = u.x - v.x, qz = u.z - v.z;
      if (qx * qx + qz * qz > 120 * 120) continue;
      const lz = qx * fx + qz * fz, lx = qx * fz - qz * fx, uv = u.vx * fx + u.vz * fz;
      near.push([lz, lx, uv]);
      if (lz > 0 && lz < 14 + vv * vv / 9 && Math.abs(lx) < 1.55 && lz < leadGap) { leadGap = lz; leadV = uv; }
    }
    if (leadGap < Infinity && !(direct && d < leadGap)) {
      const clear = sg => !near.some(([lz, lx, uv]) => {
        if (sg * lx < 1.6 || sg * lx > 6) return false;
        for (const t of [0, 1, 2, 3]) { const z = lz + (uv - vv) * t; if (z > -7 && z < leadGap + 12) return true; }
        return false;
      }) && probe(v, sg * 0.35, 14) >= 14;
      let sg = clear(1) ? 1 : 0;                         // out to the left, into the oncoming lane (never up the kerb)
      // stuck in a queue: nose out into the oncoming lane slowly, lights and siren doing the talking
      v.waitT = !sg && vv < 3 ? (v.waitT || 0) + dt : 0;
      if (v.waitT > 2.5 && probe(v, 0.35, 10) >= 10) { sg = 1; vTarget = Math.min(vTarget, 7); }
      if (sg && vv > leadV - 1) {
        // offset across the road (not across my nose, which would keep turning me further out), and never past the
        // far lane: in path mode, aim at the oncoming lane's centre and no further
        let ox = fz, oz = -fx;
        if (!direct && v.path) { const py = v.pathYaw; ox = Math.cos(py); oz = -Math.sin(py); }
        const room = !direct && v.path ? clamp(3.6 + (v.lat || 0), 0, 3.6) : 3.4; // lat < 0 is already out to the left
        tx += ox * sg * room; tz += oz * sg * room;
      }
      else vTarget = Math.min(vTarget, Math.sqrt(Math.max(0, leadV) ** 2 + 2 * 6 * Math.max(0, leadGap - 7)));
    }
    // Cross traffic (junctions, cars pulling out): predict closest approach over the next two seconds and brake
    // for anything we'd hit that isn't you
    for (const u of vehicles) {
      if (u === v || u.state === 'idle' || Math.abs(u.y - v.y) > 3) continue;
      const qx = u.x - v.x, qz = u.z - v.z;
      if (qx * qx + qz * qz > 70 * 70 || qx * fx + qz * fz < -1) continue;
      const wx = u.vx - v.vx, wz = u.vz - v.vz, w2 = wx * wx + wz * wz;
      if (w2 < 1) continue;
      const tc = clamp(-(qx * wx + qz * wz) / w2, 0, 2.2), mx = qx + wx * tc, mz = qz + wz * tc;
      if (tc > 0 && Math.hypot(mx, mz) < 3.2) vTarget = Math.min(vTarget, Math.max(0, vv - (2.6 - tc) * 9));
    }
    // off the road network, look before leaping: steer for the clearer side of a wall and brake for it
    if (direct) {
      const look = clamp(6 + vv * 0.7, 8, 26), ahead = probe(v, 0, look);
      if (ahead < look) {
        const l = probe(v, 0.55, look), r = probe(v, -0.55, look), ang = l >= r ? 0.55 : -0.55;
        tx = v.x + Math.sin(v.h + ang) * 10; tz = v.z + Math.cos(v.h + ang) * 10;
        vTarget = Math.min(vTarget, Math.max(4, ahead * 0.8));
      }
    }
    const rx = v.x - fx * v.b, rz = v.z - fz * v.b;
    let alpha = Math.atan2(tx - rx, tz - rz) - v.h; alpha = Math.atan2(Math.sin(alpha), Math.cos(alpha));
    if (Math.abs(alpha) > 2.2 && d < 30 && sp < 6) { v.rev = 1.2; return; } // target behind: back up and turn
    v.drv.steerCmd = clamp(Math.atan2(2 * (v.a + v.b) * Math.sin(alpha), Math.hypot(tx - rx, tz - rz)), -0.62, 0.62);
    // hard turns want lower speed (but they'll carry more than the civilians would)
    const turnCap = Math.sqrt(9.5 / Math.max(Math.abs(Math.tan(v.drv.steerCmd)) / (v.a + v.b), 1e-3));
    vTarget = Math.min(vTarget * (d > 70 ? v.boost : 1), turnCap);
    v.aDes = clamp((vTarget - vv) * 1.5, -9, 6);
  }
  let roleN = 0;
  function startPursuit(v) {
    if (v.state === 'idle' || v.state === 'wreck') return;
    v.state = 'pursue'; v.chaseT = 0; v.replanT = 0; v.path = null; v.rev = 0; v.stuckT = 0; v.waiting = null; v.commit = null;
    v.role = ROLES[roleN++ % ROLES.length]; v.side = rand() < 0.5 ? -1 : 1;
  }
  function spawnChaser() {
    const v = vehicles.find(u => u.police && u.state === 'idle');
    if (!v || !pol.target) return false;
    const T = pol.target;
    city.cellsNear(T.x, T.z, 230, cellsTmp);
    const cand = cellsTmp.filter(c => {
      const d = Math.hypot(c.x - T.x, c.z - T.z);
      if (d < 90 || Math.abs(c.y - T.y) > 15 || inView(c.x, c.y, c.z) || c.link.kind === 'fwy') return false;
      const pts = laneOf(c.link, c.lane).pts, a = pts[c.si], b = pts[c.si + 1], l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return ((b.x - a.x) * (T.x - c.x) + (b.z - a.z) * (T.z - c.z)) / (l * d) > 0.3; // already heading your way
    });
    for (let t = 0; t < 12 && cand.length; t++) {
      const c = cand[(rand() * cand.length) | 0];
      if (vehicles.some(u => u.state !== 'idle' && (u.x - c.x) ** 2 + (u.z - c.z) ** 2 < 15 * 15)) continue;
      activate(v, c); startPursuit(v);
      return true;
    }
    return false;
  }
  // Roadblock: two cruisers parked across the road ahead of you, lights going
  function spawnRoadblock() {
    const T = pol.target, sp = Math.hypot(T.vx, T.vz);
    if (sp < 8) return false;
    const ux = T.vx / sp, uz = T.vz / sp;
    city.cellsNear(T.x + ux * 210, T.z + uz * 210, 90, cellsTmp);
    const cand = cellsTmp.filter(c => {
      if (c.link.kind === 'fwy' || c.link.kind === 'ramp' || Math.abs(c.y - T.y) > 12 || inView(c.x, c.y, c.z) && Math.hypot(c.x - T.x, c.z - T.z) < 160) return false;
      const pts = laneOf(c.link, c.lane).pts, a = pts[c.si], b = pts[c.si + 1], l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return Math.abs(((b.x - a.x) * ux + (b.z - a.z) * uz) / l) > 0.8 && (c.x - T.x) * ux + (c.z - T.z) * uz > 140;
    });
    if (!cand.length) return false;
    const c = cand[(rand() * cand.length) | 0], pts = laneOf(c.link, c.lane).pts, a = pts[c.si], b = pts[c.si + 1];
    const h = Math.atan2(b.x - a.x, b.z - a.z), rxv = -Math.cos(h), rzv = Math.sin(h); // (rxv, rzv): towards the kerb
    const units = vehicles.filter(u => u.police && u.state === 'idle').slice(0, 2);
    if (units.length < 2) return false;
    units.forEach((v, i) => {
      activate(v, c);
      const off = i ? -3.4 : 0.4; // one at the kerb, one across the other lane
      Object.assign(v, { state: 'block', x: c.x + rxv * off, z: c.z + rzv * off, h: h + (i ? -1 : 1) * Math.PI / 2 + (rand() - 0.5) * 0.3, vx: 0, vz: 0, w: 0 });
      v.px = v.x; v.pz = v.z; v.ph = v.h; refreshBox(v); refreshBox(v);
    });
    return true;
  }
  function wreck(v, why) {
    if (v.state === 'wreck') return;
    v.why = why; v.state = 'wreck'; v.crashT = now; v.hazard = true; v.aDes = -6; v.signal = 0; v.waiting = null; v.commit = null;
  }

  /* ---------------- Vehicle dynamics (front-wheel drive) ---------------- */
  function dynamics(v, dt) {
    v.px = v.x; v.pz = v.z; v.ph = v.h;
    const s = Math.sin(v.h), c = Math.cos(v.h), fx = s, fz = c, sx = c, sz = -s;
    let vLong = v.vx * fx + v.vz * fz, vLat = v.vx * sx + v.vz * sz;
    const speed = Math.hypot(v.vx, v.vz), grass = city.surfaceAt(v.x, v.z, v.y) !== 'asphalt', mu = grass ? 0.7 : 1.0, g = 9.81;
    const Fdrive = Math.min(mu * v.m * g * 0.55, v.power * (v.state === 'pursue' ? v.boost || 1 : 1) / Math.max(Math.abs(vLong), 2.5));
    const Fres = 0.38 * vLong * Math.abs(vLong) + 13 * vLong * (grass ? 2.5 : 1) + v.m * g * v.slope;
    const F = v.m * v.aDes + Fres;
    let tThr = 0, tBrk = 0;
    if (v.state === 'wreck') tBrk = 1;
    else if (v.state === 'halt') tBrk = 0.6;
    else if (v.state === 'block') tBrk = 1;
    else if (v.rev > 0) { tThr = 0.75; tBrk = vLong > 0.5 ? 1 : 0; }
    else if (F > 0) tThr = clamp(F / Fdrive, 0, 1);
    else tBrk = clamp(-F / (v.m * 9), 0, 1);
    if (v.state === 'drive' && vLong < 0.15 && v.aDes < 0.3) { tThr = 0; tBrk = Math.max(tBrk, 0.35); }
    const up = (cur, t, r1, r2) => cur + clamp(t - cur, -r2 * dt, r1 * dt);
    v.throttle = up(v.throttle, tThr, 2.5, 5);
    v.brake = up(v.brake, tBrk, v.aDes < -5 ? 14 : 4, 6);
    const sr = v.state === 'pursue' ? 2.6 : 1.1;
    v.steer += clamp((v.state === 'wreck' ? v.steer : v.drv.steerCmd || 0) - v.steer, -sr * dt, sr * dt);

    const Wt = v.m * g, L = v.a + v.b;
    const Nf = Math.max(0.15 * Wt, Wt * v.b / L - v.m * v.ax * v.cg / L), Nr = Math.max(0.15 * Wt, Wt * v.a / L + v.m * v.ax * v.cg / L);
    const lowK = clamp(speed / 2, 0, 1), brakeF = -clamp(vLong * 4, -1, 1) * v.brake * v.m * 9;
    const d = v.steer, cd = Math.cos(d), sd = Math.sin(d);
    const vLatF = vLat + v.w * v.a, vwx = vLong * cd + vLatF * sd, vwy = -vLong * sd + vLatF * cd;
    const maxF = mu * Nf;
    let Ffx = v.throttle * Fdrive * (v.rev > 0 ? -0.55 : 1) + brakeF * 0.65;
    if (Math.abs(Ffx) > maxF) Ffx = Math.sign(Ffx) * maxF * 0.9;
    const capF = Math.sqrt(Math.max(0, maxF * maxF - Ffx * Ffx * 0.8));
    const Ffy = clamp(-maxF * sat(Math.atan2(vwy, Math.max(Math.abs(vwx), 1))), -capF, capF) * lowK;
    const maxR = mu * Nr;
    let Frx = brakeF * 0.35;
    if (Math.abs(Frx) > maxR) Frx = Math.sign(Frx) * maxR * 0.9;
    const capR = Math.sqrt(Math.max(0, maxR * maxR - Frx * Frx * 0.8)), vLatR = vLat - v.w * v.b;
    const Fry = clamp(-maxR * sat(Math.atan2(vLatR, Math.max(Math.abs(vLong), 1))), -capR, capR) * lowK;
    const Flong = Ffx * cd - Ffy * sd + Frx - Fres;
    const FlatF = Ffx * sd + Ffy * cd, Flat = FlatF + Fry - 0.6 * vLat * Math.abs(vLat);
    const axL = Flong / v.m, ayL = Flat / v.m;
    v.ax = lerp(v.ax, axL, Math.min(1, dt * 8)); v.ay = lerp(v.ay, ayL, Math.min(1, dt * 8));
    v.vx += (fx * axL + sx * ayL) * dt; v.vz += (fz * axL + sz * ayL) * dt;
    v.w += (v.a * FlatF - v.b * Fry) / v.I * dt;
    vLong = v.vx * fx + v.vz * fz; vLat = v.vx * sx + v.vz * sz;
    const k = clamp(1 - Math.hypot(vLong, vLat) / 4, 0, 1);
    if (k > 0) {
      v.w = lerp(v.w, vLong * Math.tan(d) / L, k);
      vLat *= 1 - k * 0.3;
      if (Math.abs(vLong) < 0.05 && v.throttle < 0.02) vLong = 0;
      v.vx = fx * vLong + sx * vLat; v.vz = fz * vLong + sz * vLat;
    }
    v.w *= 1 - 0.4 * dt;
    v.h += v.w * dt; v.x += v.vx * dt; v.z += v.vz * dt;
    v.y = city.heightAt(v.x, v.z, v.y);
    v.frontRot += vLong / 0.33 * dt;
    const ratios = [3.4, 2.0, 1.35, 1.0, 0.8, 0.66], rpmIn = gr => Math.abs(vLong) / 0.33 * ratios[gr - 1] * 3.9 * 60 / TAU;
    if (v.gear < 6 && rpmIn(v.gear) > 2600 + v.throttle * 1800) v.gear++;
    else if (v.gear > 1 && rpmIn(v.gear - 1) < 2300 + v.throttle * 1200) v.gear--;
    v.rpm = lerp(v.rpm, Math.max(750 + v.throttle * 900, rpmIn(v.gear)), Math.min(1, dt * 6));
  }

  /* ---------------- Collisions ---------------- */
  const near = [], solidsTmp = [];
  function refreshBox(v) {
    const b = v.box;
    b.pux = b.ux; b.puz = b.uz; b.px = b.x; b.pz = b.z;
    b.x = v.x; b.z = v.z; b.y0 = v.y; b.ux = Math.cos(v.h); b.uz = -Math.sin(v.h);
  }
  function refreshPlayerBox() {
    const b = playerBox;
    b.x = player.x; b.z = player.z; b.y0 = player.y; b.ux = Math.cos(player.h); b.uz = -Math.sin(player.h);
    b.px = player.px; b.pz = player.pz; b.pux = Math.cos(player.ph); b.puz = -Math.sin(player.ph);
  }
  function collideAI(v, dt) {
    // a settled wreck away from you stops simulating its crumple structure (others still collide with its box)
    if (v.state === 'wreck' && now - v.crashT > 2.5 && Math.hypot(v.x - player.x, v.z - player.z) > 25) { v.vx *= 0.9; v.vz *= 0.9; v.w *= 0.9; return; }
    const s = Math.sin(v.h), c = Math.cos(v.h), s0 = Math.sin(v.ph), c0 = Math.cos(v.ph);
    near.length = 0;
    // A car driving its lane never touches the scenery; only check once something has gone wrong
    const checkStatics = v.state !== 'drive' || Math.abs(v.lat || 0) > 1.3 || v.crashDv > 0.3;
    if (checkStatics) {
      nearSolids(v.x, v.z, 5, solidsTmp);
      for (const o of solidsTmp) if (nearCar(v.x, v.z, v.h, o, 0.4, v.y)) near.push(localObstacle(near.length, o, v.px, v.pz, s0, c0, v.x, v.z, s, c, v.pool, v.y));
    } else solidsTmp.length = 0;
    for (const u of vehicles) if (u !== v && u.state !== 'idle' && Math.abs(u.x - v.x) < 6 && Math.abs(u.z - v.z) < 6 && nearCar(v.x, v.z, v.h, u.box, 0.4, v.y)) near.push(localObstacle(near.length, u.box, v.px, v.pz, s0, c0, v.x, v.z, s, c, v.pool, v.y));
    if (Math.abs(player.x - v.x) < 6 && Math.abs(player.z - v.z) < 6 && nearCar(v.x, v.z, v.h, playerBox, 0.4, v.y)) near.push(localObstacle(near.length, playerBox, v.px, v.pz, s0, c0, v.x, v.z, s, c, v.pool, v.y));
    if (!near.length && v.soft.sleeping) return;
    const res = v.soft.step(dt, near);
    if (res.contacts) v.dented = true;
    if (res.contacts) v.hitSrc = near.filter(L => L.cw > 0).map(L => L.src.isPlayer ? 'player' : L.src.body ? 'car' : 'static ' + L.src.type + ' h' + L.src.h.toFixed(1) + ' y0 ' + (L.src.y0 || 0).toFixed(1) + ' vy ' + v.y.toFixed(1)).join(',');
    let ix = 0, iz = 0, it = 0;
    for (const L of near) { if (L.src.isPlayer) continue; ix += L.ix; iz += L.iz; it += L.it; }
    if (ix || iz || it) {
      const Fx = c * ix + s * iz, Fz = -s * ix + c * iz, back = Fx * v.vx + Fz * v.vz > 0 ? 0.12 : 1;
      v.vx += Fx * back / v.m; v.vz += Fz * back / v.m; v.w += it * back / v.I;
      v.hitDv += Math.hypot(Fx, Fz) * back / v.m;
    }
    for (const o of solidsTmp) if (nearCar(v.x, v.z, v.h, o, 0.1, v.y)) { coreContact(v, 0.55, 0.72, o, null); coreContact(v, -0.55, 0.72, o, null); }
    for (const u of vehicles) if (u !== v && u.state !== 'idle' && Math.abs(u.x - v.x) < 6 && Math.abs(u.z - v.z) < 6 && Math.abs(u.y - v.y) < 2) { coreContact(v, 0.55, 0.72, u.box, u); coreContact(v, -0.55, 0.72, u.box, u); }
  }

  /* ---------------- Visuals ---------------- */
  const SAMPLE = new Float32Array(5);
  function sync(v, dt, blinkOn) {
    v.group.position.set(v.x, v.y, v.z);
    const pT = clamp(-v.ax * 0.008, -0.05, 0.05), rT = clamp(v.ay * 0.011, -0.06, 0.06);
    v.pitchV += ((pT - v.pitch) * 110 - v.pitchV * 13) * dt; v.pitch += v.pitchV * dt;
    v.rollV += ((rT - v.roll) * 110 - v.rollV * 13) * dt; v.roll += v.rollV * dt;
    v.group.rotation.set(-Math.atan(v.slope), v.h, 0);
    v.body.rotation.set(v.pitch, 0, v.roll);
    if (v.lazy && v.dented) { // first dent: give this car its own copy of the body to crumple
      for (const [mesh, opts] of v.lazy) { mesh.geometry = mesh.geometry.clone(); v.bindings.set(mesh, v.soft.bind(mesh.geometry, opts || { wrinkle: 0 })); }
      v.lazy = null; v.soft.refreshed = -1;
    }
    if (v.soft.refresh() && !v.lazy) {
      for (const [, bd] of v.bindings) v.soft.deform(bd);
      for (const w of v.wheels) { v.soft.sample(w.x, 0.38, w.z, SAMPLE); w.dx = SAMPLE[0]; w.dz = SAMPLE[2]; }
      for (const pt of v.kit.parts) if (pt.kind === 'light' && !pt.broken && v.soft.sample(...pt.anchor, SAMPLE)[3] > pt.limit) {
        pt.broken = true; pt.saved = { e: pt.mesh.material.emissiveIntensity, c: pt.mesh.material.color.getHex() };
        pt.mesh.material.emissiveIntensity = 0; pt.mesh.material.color.set('#2a2626');
      }
    }
    v.wheels.forEach((w, i) => {
      w.steer.position.set(w.x + w.dx, w.y ?? 0.33, w.z + w.dz);
      w.steer.rotation.set(0, i < 2 ? v.steer : 0, clamp(-w.dx * 1.4, -0.35, 0.35));
      w.spin.rotation.x = v.frontRot;
    });
    if (v.police) {
      const on = v.state === 'pursue' || v.state === 'halt' || v.state === 'block', ph = (now * 2.6) % 1, k = ph < 0.5 ? 0 : 1, strobe = (now * 14) % 1 < 0.55;
      v.lights.forEach((L, i) => { const lit = on && i === k && strobe; L.mat.emissiveIntensity = lit ? 6 : 0.15; L.glow.material.opacity = lit ? 0.9 : 0; });
    }
    const tail = v.kit.parts.find(p => p.name === 'Taillight');
    v.kit.mats.tail.emissiveIntensity = tail && tail.broken ? 0 : (v.brake > 0.08 ? 3.5 : 0.7);
    const left = v.hazard || v.signal === 1, right = v.hazard || v.signal === -1;
    v.kit.indicators.left.emissiveIntensity = left && blinkOn ? 3 : 0;
    v.kit.indicators.right.emissiveIntensity = right && blinkOn ? 3 : 0;
  }
  function repair(v) {
    for (const pt of v.kit.parts) if (pt.broken) { pt.mesh.material.emissiveIntensity = pt.saved.e; pt.mesh.material.color.setHex(pt.saved.c); pt.broken = false; }
    v.soft.reset(); v.soft.refreshed = -1;
    for (const w of v.wheels) { w.dx = 0; w.dz = 0; }
  }

  // Far cars: one instanced, vertex-coloured stand-in (body in the paint colour, dark glasshouse, wheels)
  // instead of ~10 draw calls each
  const PROXY_DIST = 140;
  const proxy = (() => {
    const parts = [], cols = [];
    const add = (g, c) => { const n = g.toNonIndexed(); parts.push(n); for (let i = 0; i < n.attributes.position.count; i++) cols.push(c, c, c); };
    add(new THREE.BoxGeometry(1.8, 0.62, 4.4).translate(0, 0.62, 0), 1);
    add(new THREE.BoxGeometry(1.5, 0.5, 2.2).translate(0, 1.18, -0.25), 0.07);
    for (const [x, z] of [[0.8, 1.3], [-0.8, 1.3], [0.8, -1.35], [-0.8, -1.35]]) add(new THREE.CylinderGeometry(0.33, 0.33, 0.24, 8).rotateZ(Math.PI / 2).translate(x, 0.33, z), 0.05);
    const pos = [], nrm = [];
    for (const g of parts) { pos.push(...g.attributes.position.array); nrm.push(...g.attributes.normal.array); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const m = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.4 }), vehicles.length);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(vehicles.length * 3), 3);
    m.frustumCulled = false; m.castShadow = false; m.count = 0; scene.add(m);
    return m;
  })();
  const PM = new THREE.Matrix4(), PQ = new THREE.Quaternion(), PE = new THREE.Euler(0, 0, 0, 'YXZ'), PV = new THREE.Vector3(), PS = new THREE.Vector3(1, 1, 1);

  let driverAcc = 0, manageAcc = 0, blinkT = 0, primed = false;
  return {
    vehicles, coreContact, nearCar,
    step(dt) {
      now += dt;
      if (!primed) { manage(true); primed = true; }
      manageAcc += dt;
      if (manageAcc > 0.25) { manage(false); manageAcc = 0; }
      driverAcc += dt;
      if (driverAcc >= 0.05) { for (const v of vehicles) { if (v.state === 'drive') drive(v, driverAcc); else if (v.state === 'pursue') pursue(v, driverAcc); } driverAcc = 0; }
      refreshPlayerBox();
      for (const v of vehicles) { if (v.state === 'idle') continue; dynamics(v, dt); refreshBox(v); }
      for (const v of vehicles) if (v.state !== 'idle') collideAI(v, dt);
      for (const v of vehicles) {
        if (v.state === 'idle') continue;
        v.crashDv = v.crashDv * Math.exp(-dt * 2) + v.hitDv; v.hitDv = 0;
        if ((v.state === 'drive' || v.state === 'pursue') && v.crashDv > (v.police ? 12 : 2.8)) wreck(v, 'crash');
        v.stillT = speedOf(v) < 0.3 ? v.stillT + dt : 0;
      }
    },
    /** Active cars near a point and at about the same height, for the player's collision step. */
    boxesNear(x, z, r, out, y = 0) {
      for (const v of vehicles) if (v.state !== 'idle' && Math.abs(v.x - x) < r && Math.abs(v.z - z) < r && Math.abs(v.y - y) < 2.5) out.push(v.box);
      return out;
    },
    activeCount: () => vehicles.filter(v => v.state !== 'idle').length,
    police: {
      state: pol, sightClear, spawnChaser, spawnRoadblock, startPursuit,
      units: () => vehicles.filter(v => v.police && v.state !== 'idle'),
      /** End the chase: units out of sight leave at once, the rest pull over and are recycled once you're gone */
      standDown() {
        pol.active = false;
        for (const v of vehicles) if (v.police && (v.state === 'pursue' || v.state === 'block')) { if (inView(v.x, v.y, v.z) && Math.hypot(v.x - player.x, v.z - player.z) < 200) { v.state = 'halt'; v.rev = 0; } else deactivate(v); }
      },
    },
    reset() { for (const v of vehicles) if (v.state !== 'idle') deactivate(v); primed = false; },
    update(dt) {
      blinkT += dt;
      const blinkOn = (blinkT % 0.7) < 0.38;
      let n = 0;
      const cx = camera.position.x, cz = camera.position.z;
      for (const v of vehicles) {
        if (v.state === 'idle') continue;
        const far = (v.x - cx) ** 2 + (v.z - cz) ** 2 > PROXY_DIST * PROXY_DIST;
        if (far) {
          v.group.visible = false;
          PQ.setFromEuler(PE.set(-Math.atan(v.slope), v.h, 0)); PV.set(v.x, v.y, v.z);
          proxy.setMatrixAt(n, PM.compose(PV, PQ, PS));
          proxy.instanceColor.setXYZ(n, v.paint[0], v.paint[1], v.paint[2]);
          n++;
        } else { v.group.visible = true; sync(v, dt, blinkOn); }
      }
      proxy.count = n; proxy.instanceMatrix.needsUpdate = true; proxy.instanceColor.needsUpdate = true;
    },
  };
};
})();
