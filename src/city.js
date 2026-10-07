/*
 * The world: Ashby Valley, 6.4 km across.
 *
 *   Terrain     A height field (4 m cells) from layered noise: a river winding west to east, the bench the city
 *               sits on, farmland to the south-west, hills to the south-east and mountains to the north.
 *   Districts   Each district is a street grid with its own block size, orientation and amount of curve,
 *               clipped to an irregular outline: a downtown of towers inside a midtown of apartments, an
 *               industrial south bank, three suburbs with curving streets and three villages.
 *   Roads       Districts are joined by highways and country roads routed over the terrain with A* (steep
 *               ground, the river and built-up land cost more), so they follow valleys and switch back up the
 *               mountains. Where two of them cross they meet at a junction.
 *   Grading     Every road gets a smoothed, grade-limited profile, and the terrain is cut and filled to meet it
 *               with embankments. Where a road would need more than a few metres of fill, or crosses the river
 *               or another road, it goes onto a bridge.
 *   Freeway     I-9 crosses the valley south of the river: two lanes each way at 110 km/h, diamond interchanges
 *               where the highways cross it, and at each end it narrows into a highway.
 *
 * Traffic drives on the right. Roads are physical `roads`; traffic uses directed `links`, each with one or
 * more `lanes` (index 0 is the rightmost; freeway links after an on-ramp also carry an `accel` lane).
 * Coordinates: x points west, z north (so the map, drawn east-right and north-up, mirrors x).
 */
(function () {
'use strict';

window.buildWorld = function (ctx) {
  const { scene, solids, rand } = ctx;
  const T0 = performance.now(), timing = {};
  const lap = k => { timing[k] = Math.round(performance.now() - T0); };
  const TAU = Math.PI * 2;
  const R_INT = 11, PATCH = 10, HALF = 4, LANE = 1.8, LW = 3.7, FW = 12.4;
  const EXT = 3200, VIEW = 4608, WATER = 4, RIVER_W = 58;
  // Winter: snow on the ground, the roofs and the trees, frosted pavements, salted roads
  const WINTER = ctx.winter ?? false;
  let pondHeight = () => -Infinity, countryTurbines = [], countryStats = { ponds: [], turbines: [], homes: 0 }; // filled in once the countryside is laid out
  const KMH = { res: 40, ind: 40, dt: 40, art: 50, rural: 70, hwy: 80, ramp: 60, fwy: 110 };
  const SPEED = {}; for (const k in KMH) SPEED[k] = KMH[k] / 3.6;
  const RANK = { res: 1, ind: 1, rural: 2, art: 3, dt: 3, hwy: 3, ramp: 3, fwy: 4 };
  // expected cars per lane-kilometre, used to decide how much traffic to spawn around the player
  const DENSITY = { res: 0.8, ind: 1.0, rural: 0.7, art: 2.6, dt: 3.2, hwy: 1.8, ramp: 1.6, fwy: 6.5 };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const norm = (x, z) => { const l = Math.hypot(x, z) || 1; return { x: x / l, z: z / l }; };
  const P = (E, N) => ({ x: -E, z: N }); // plan coordinates (metres east, metres north) to world

  /* ================= Noise ================= */
  const perm = new Uint8Array(512);
  {
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) { const j = (rand() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  }
  const GX = [1, -1, 1, -1, 1, -1, 0, 0], GZ = [1, 1, -1, -1, 0, 0, 1, -1];
  function noise(x, z) { // gradient noise, roughly -1..1
    const X = Math.floor(x), Z = Math.floor(z), fx = x - X, fz = z - Z, xi = X & 255, zi = Z & 255;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    let h = perm[perm[xi] + zi] & 7; const a = GX[h] * fx + GZ[h] * fz;
    h = perm[perm[xi + 1] + zi] & 7; const b = GX[h] * (fx - 1) + GZ[h] * fz;
    h = perm[perm[xi] + zi + 1] & 7; const c = GX[h] * fx + GZ[h] * (fz - 1);
    h = perm[perm[xi + 1] + zi + 1] & 7; const d = GX[h] * (fx - 1) + GZ[h] * (fz - 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }
  function fbm(x, z, oct) {
    let s = 0, a = 1, n = 0;
    for (let i = 0; i < oct; i++) { s += a * noise(x, z); n += a; a *= 0.5; x = x * 2.03 + 17.1; z = z * 2.03 - 9.7; }
    return s / n;
  }

  /* ================= River ================= */
  // The Ash River runs west to east; its centre line is a function of the east coordinate
  const riverN = E => -380 + 230 * Math.sin(E / 950 + 0.4) + 100 * Math.sin(E / 390 + 1.9);
  const riverSlope = E => 230 / 950 * Math.cos(E / 950 + 0.4) + 100 / 390 * Math.cos(E / 390 + 1.9);
  /** Signed distance to the river's centre line, positive on the north bank (good to a few metres). */
  const riverSide = (x, z) => (z - riverN(-x)) / Math.sqrt(1 + riverSlope(-x) ** 2);
  function channel(h, rd) { // rd = |distance| to the centre line
    if (rd > 70) return h;
    return Math.min(h, lerp(WATER - 3.2, Math.max(h, WATER + 2), smoothstep(14, 70, rd)));
  }

  /* ================= Natural terrain ================= */
  function hBase(x, z) {
    const E = -x, N = z;
    let h = 30 + 40 * fbm(x / 1800 + 11.3, z / 1800 - 4.2, 4) + 10 * fbm(x / 430 - 3.3, z / 430 + 8.1, 3);
    // mountains to the north (highest in the north-east), hills to the south-east
    const north = smoothstep(700, 2900, N + 0.18 * E);
    const ridge = Math.max(0, 1 - Math.abs(fbm(x / 1150 + 5.5, z / 1150 + 1.9, 4)) * 1.7);
    h += north * (45 + 210 * ridge * ridge);
    h += smoothstep(1300, 3100, E - 0.5 * N) * 28 * (1 + fbm(x / 600 - 7, z / 600 + 2, 2));
    const rd = Math.abs(riverSide(x, z));
    // open country: rolling hills, knolls and gullies, strongest away from the river and downtown
    const away = smoothstep(350, 1100, rd) * smoothstep(500, 1300, Math.hypot(x - 150, z - 430));
    h += away * (18 * fbm(x / 310 + 2.2, z / 310 - 6.1, 3) + 10 * Math.max(0, fbm(x / 150 - 1.3, z / 150 + 4.4, 2)) - 6 * Math.max(0, -fbm(x / 210 + 7.7, z / 210 - 2.6, 2)));
    // Mount Ashby: a lone snow-capped peak in the empty north-west
    const pk = Math.hypot(x - 2350, z - 2350) / 640;
    h += 240 * Math.exp(-1.6 * pk * pk) * (1 + 0.18 * fbm(x / 260 + 4, z / 260 - 4, 3));
    // a flat-bottomed valley along the river
    h = lerp(h, 9 + rd * 0.012 + 2.5 * fbm(x / 350 + 1, z / 350 - 1, 2), 1 - smoothstep(120, 950, rd));
    h = Math.max(h, 7);
    // the valley is closed in by high ground beyond the map edge
    const edge = Math.max(Math.abs(x), Math.abs(z));
    h += smoothstep(EXT - 300, EXT + 900, edge) * (150 + 100 * fbm(x / 700, z / 700, 3));
    return h;
  }

  /* ================= Districts ================= */
  // (E, N): centre; rot: grid angle; bu x bv: block size; nu x nv: blocks; warp: how much the streets wander;
  // art: every n-th street is an arterial; ru x rv: outline radii; bank: which side of the river;
  // relief: how much of the natural relief survives inside; drop: share of minor streets removed (T-junctions)
  const DISTRICTS = [
    { name: 'Port Ashby', E: -150, N: 430, rot: 0.28, bu: 125, bv: 112, nu: 15, nv: 13, warp: 7, warpEdge: true, art: 4, ru: 960, rv: 840, bank: 1, relief: 0.3, drop: 0.05,
      zone: r => r < 0.36 ? 'dt' : r < 0.72 ? 'mid' : 'sub' },
    { name: 'Southbank', E: 300, N: -700, rot: -0.12, bu: 170, bv: 125, nu: 8, nv: 6, warp: 10, art: 3, ru: 680, rv: 420, bank: -1, relief: 0.15, drop: 0.08,
      zone: r => r < 0.8 ? 'ind' : 'sub' },
    { name: 'Westfield', E: -2050, N: 180, rot: 0.55, bu: 190, bv: 96, nu: 8, nv: 14, warp: 28, swirl: 0.55, art: 4, ru: 640, rv: 700, bank: 1, relief: 0.5, drop: 0.14, zone: () => 'sub' },
    { name: 'Oakridge Heights', E: 1600, N: 900, rot: -0.4, bu: 180, bv: 100, nu: 8, nv: 11, warp: 34, swirl: -0.6, art: 4, ru: 600, rv: 560, bank: 1, relief: 0.55, drop: 0.16, zone: () => 'sub' },
    { name: 'Southgate', E: -800, N: -1950, rot: 0.12, bu: 200, bv: 100, nu: 8, nv: 9, warp: 30, swirl: 0.5, art: 4, ru: 720, rv: 470, bank: -1, relief: 0.5, drop: 0.12, zone: () => 'sub' },
    { name: 'Lakeview', E: -1350, N: 1520, rot: -0.2, bu: 175, bv: 95, nu: 7, nv: 7, warp: 30, swirl: 0.5, art: 3, ru: 540, rv: 380, bank: 1, relief: 0.45, drop: 0.12, zone: () => 'sub' },
    { name: 'Cedar Park', E: 700, N: -2080, rot: -0.3, bu: 185, bv: 95, nu: 7, nv: 8, warp: 30, swirl: -0.5, art: 3, ru: 560, rv: 420, bank: -1, relief: 0.45, drop: 0.12, zone: () => 'sub' },
    { name: 'Millbrook', E: -2450, N: -2350, rot: 0.7, bu: 120, bv: 110, nu: 4, nv: 4, warp: 10, art: 2, ru: 270, rv: 250, bank: -1, relief: 0.4, drop: 0, zone: () => 'vil' },
    { name: 'Eastvale', E: 2350, N: -1850, rot: -0.3, bu: 130, bv: 110, nu: 5, nv: 4, warp: 10, art: 2, ru: 340, rv: 270, bank: -1, relief: 0.4, drop: 0, zone: () => 'vil' },
    { name: 'Pine Hollow', E: 1650, N: 2250, rot: 0.2, bu: 115, bv: 100, nu: 4, nv: 3, warp: 10, art: 2, ru: 240, rv: 180, bank: 1, relief: 0.12, drop: 0, zone: () => 'vil' },
  ];
  for (const d of DISTRICTS) { d.c = Math.cos(d.rot); d.s = Math.sin(d.rot); d.seed = rand() * 50; d.ctr = P(d.E, d.N); }
  const toLocal = (d, x, z) => { const e = -x - d.E, n = z - d.N; return { u: e * d.c + n * d.s, v: -e * d.s + n * d.c }; };
  const toWorld = (d, u, v) => P(d.E + u * d.c - v * d.s, d.N + u * d.s + v * d.c);
  /** Normalised outline radius: below 1 is inside the district. */
  const maskR = (d, x, z) => { const q = toLocal(d, x, z); return Math.hypot(q.u / d.ru, q.v / d.rv) * (1 + 0.16 * noise(x / 380 + d.seed, z / 380 - d.seed)); };

  /* ================= Height grids ================= */
  // Natural terrain on a 4 m grid (evaluated at 8 m and interpolated), flattened inside districts, with the
  // river channel cut in at full resolution
  const CELL = 4, GN = 2 * EXT / CELL + 1, CN = (GN - 1) / 2 + 1;
  const Hc = new Float32Array(CN * CN);
  for (let j = 0; j < CN; j++) for (let i = 0; i < CN; i++) Hc[j * CN + i] = hBase(-EXT + i * 8, -EXT + j * 8);
  for (const d of DISTRICTS) {
    let hc = 0;
    for (let k = 0; k < 9; k++) { const q = toWorld(d, ((k % 3) - 1) * d.ru * 0.3, (((k / 3) | 0) - 1) * d.rv * 0.3); hc += hBase(q.x, q.z); }
    d.h = hc /= 9;
    const R = Math.max(d.ru, d.rv) * 1.45;
    const i0 = Math.max(0, Math.floor((d.ctr.x - R + EXT) / 8)), i1 = Math.min(CN - 1, Math.ceil((d.ctr.x + R + EXT) / 8));
    const j0 = Math.max(0, Math.floor((d.ctr.z - R + EXT) / 8)), j1 = Math.min(CN - 1, Math.ceil((d.ctr.z + R + EXT) / 8));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = -EXT + i * 8, z = -EXT + j * 8, w = 1 - smoothstep(0.9, 1.35, maskR(d, x, z));
      if (w <= 0) continue;
      const c = j * CN + i; Hc[c] = lerp(Hc[c], hc + (Hc[c] - hc) * d.relief, w);
    }
  }
  const Hn = new Float32Array(GN * GN);
  for (let i = 0; i < GN; i++) {
    const x = -EXT + i * CELL, E = -x, rn = riverN(E), rk = 1 / Math.sqrt(1 + riverSlope(E) ** 2);
    const ci = Math.min(CN - 2, i >> 1), ti = (i - ci * 2) / 2;
    for (let j = 0; j < GN; j++) {
      const z = -EXT + j * CELL, cj = Math.min(CN - 2, j >> 1), tj = (j - cj * 2) / 2, c = cj * CN + ci;
      const h = lerp(lerp(Hc[c], Hc[c + 1], ti), lerp(Hc[c + CN], Hc[c + CN + 1], ti), tj);
      Hn[j * GN + i] = channel(h, Math.abs(z - rn) * rk);
    }
  }
  function sampleGrid(A, x, z) {
    const fx = (x + EXT) / CELL, fz = (z + EXT) / CELL;
    if (!(fx >= 0 && fz >= 0 && fx < GN - 1 && fz < GN - 1)) return null;
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, c = j * GN + i;
    return lerp(lerp(A[c], A[c + 1], tx), lerp(A[c + GN], A[c + GN + 1], tx), tz);
  }
  const natAt = (x, z) => sampleGrid(Hn, x, z) ?? channel(hBase(x, z), Math.abs(riverSide(x, z)));
  const avgNat = (x, z, r) => (natAt(x, z) * 2 + natAt(x + r, z) + natAt(x - r, z) + natAt(x, z + r) + natAt(x, z - r)) / 6;
  lap('terrain');

  /* ================= Geometry helpers ================= */
  function crInto(out, p0, p1, p2, p3, step) { // uniform Catmull-Rom from p1 to p2
    const n = Math.max(2, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / step));
    for (let k = out.length ? 1 : 0; k <= n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (p2.x - p0.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (3 * p1.x - p0.x - 3 * p2.x + p3.x) * t3),
        z: 0.5 * (2 * p1.z + (p2.z - p0.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (3 * p1.z - p0.z - 3 * p2.z + p3.z) * t3), y: 0,
      });
    }
  }
  function cubicInto(out, p0, p1, p2, p3, step) {
    const L = Math.hypot(p3.x - p0.x, p3.z - p0.z), n = Math.max(2, Math.ceil(L / step));
    for (let i = out.length ? 1 : 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      out.push({ x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
                 z: u * u * u * p0.z + 3 * u * u * t * p1.z + 3 * u * t * t * p2.z + t * t * t * p3.z, y: 0 });
    }
  }
  function resample(pts, step) {
    const out = [{ x: pts[0].x, z: pts[0].z, y: 0 }];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      let ax = pts[i - 1].x, az = pts[i - 1].z;
      const bx = pts[i].x, bz = pts[i].z;
      let seg = Math.hypot(bx - ax, bz - az);
      while (acc + seg >= step) {
        const t = (step - acc) / seg;
        ax += (bx - ax) * t; az += (bz - az) * t;
        out.push({ x: ax, z: az, y: 0 });
        seg = Math.hypot(bx - ax, bz - az); acc = 0;
      }
      acc += seg;
    }
    const last = pts[pts.length - 1], tail = out[out.length - 1];
    if (Math.hypot(last.x - tail.x, last.z - tail.z) > step * 0.4) out.push({ x: last.x, z: last.z, y: 0 });
    else { tail.x = last.x; tail.z = last.z; }
    return out;
  }
  function relax(pts, iters, fixA, fixB) {
    for (let it = 0; it < iters; it++) for (let i = fixA; i < pts.length - fixB; i++) {
      const a = pts[i - 1], b = pts[i + 1], p = pts[i];
      p.x += ((a.x + b.x) / 2 - p.x) * 0.5; p.z += ((a.z + b.z) / 2 - p.z) * 0.5;
    }
  }
  const arcLengths = pts => { const s = new Float32Array(pts.length); for (let i = 1; i < pts.length; i++) s[i] = s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); return s; };
  const linkLen = pts => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); return s; };
  function frames(pts) {
    return pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], t = norm(b.x - a.x, b.z - a.z);
      return { x: p.x, z: p.z, y: p.y || 0, tx: t.x, tz: t.z, rx: -t.z, rz: t.x };
    });
  }
  function segHit(a, b, c, d) {
    const rx = b.x - a.x, rz = b.z - a.z, sx = d.x - c.x, sz = d.z - c.z, den = rx * sz - rz * sx;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / den, u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
  }

  /* ================= Freeway alignment ================= */
  // A spline through surveyed waypoints, relaxed into long, gentle curves
  const FWY_WP = [[-2640, -1800], [-2570, -1430], [-2200, -1200], [-1500, -1150], [-650, -1300], [250, -1330], [1150, -1180], [1950, -1000], [2480, -1130], [2700, -1480]].map(([E, N]) => P(E, N));
  let fpts = [];
  for (let k = 0; k < FWY_WP.length - 1; k++) crInto(fpts, FWY_WP[Math.max(0, k - 1)], FWY_WP[k], FWY_WP[k + 1], FWY_WP[Math.min(FWY_WP.length - 1, k + 2)], 3);
  fpts = resample(fpts, 8); relax(fpts, 60, 2, 2); fpts = resample(fpts, 4);
  const NF = fpts.length;
  fpts.forEach((p, i) => { const a = fpts[Math.max(0, i - 1)], b = fpts[Math.min(NF - 1, i + 1)], t = norm(b.x - a.x, b.z - a.z); p.tx = t.x; p.tz = t.z; });
  const FH = 64, fHash = new Map(), fk = (i, j) => (i + 512) * 1024 + (j + 512);
  fpts.forEach((p, i) => { const k = fk(Math.floor(p.x / FH), Math.floor(p.z / FH)); if (!fHash.has(k)) fHash.set(k, []); fHash.get(k).push(i); });
  function fwyDist(x, z) {
    let best = Infinity;
    const ci = Math.floor(x / FH), cj = Math.floor(z / FH);
    for (let i = ci - 3; i <= ci + 3; i++) for (let j = cj - 3; j <= cj + 3; j++) {
      const l = fHash.get(fk(i, j)); if (l) for (const k of l) best = Math.min(best, Math.hypot(fpts[k].x - x, fpts[k].z - z));
    }
    return best;
  }

  /* ================= Road graph ================= */
  const nodes = [], roads = [], links = [];
  const addNode = (x, z, type = null) => { const n = { id: nodes.length, x, z, y: 0, type, in: [], out: [], roads: [] }; nodes.push(n); return n; };
  const addRoad = (a, b, kind, pts = null, oneway = false) => { const r = { id: roads.length, a, b, kind, pts, oneway, zone: null }; roads.push(r); a.roads.push(r); b.roads.push(r); return r; };
  const other = (r, n) => r.a === n ? r.b : r.a;
  const detach = r => { r.a.roads.splice(r.a.roads.indexOf(r), 1); r.b.roads.splice(r.b.roads.indexOf(r), 1); };
  const attach = r => { r.a.roads.push(r); r.b.roads.push(r); };

  /* ---------- District street grids ---------- */
  for (const d of DISTRICTS) {
    d.nodes = []; d.grid = new Map();
    const key = (i, j) => i * 1000 + j;
    for (let i = 0; i <= d.nu; i++) for (let j = 0; j <= d.nv; j++) {
      const u0 = (i - d.nu / 2) * d.bu, v0 = (j - d.nv / 2) * d.bv, p0 = toWorld(d, u0, v0);
      const r = maskR(d, p0.x, p0.z);
      if (r > 1 || d.bank * riverSide(p0.x, p0.z) < 120 + d.warp || fwyDist(p0.x, p0.z) < 180) continue;
      if (Math.max(Math.abs(p0.x), Math.abs(p0.z)) > EXT - 280) continue;
      // coherent warp, so whole streets bend rather than every corner jittering
      const k = d.warp * (d.warpEdge ? lerp(0.3, 2.2, r * r) : 1);
      let u = u0 + k * 2 * fbm(p0.x / 430 + d.seed, p0.z / 430, 2), v = v0 + k * 2 * fbm(p0.x / 430, p0.z / 430 + d.seed, 2);
      if (d.swirl) { const a = d.swirl * (1 - Math.min(1, r)) ** 2, ca = Math.cos(a), sa = Math.sin(a); [u, v] = [u * ca - v * sa * d.ru / d.rv, u * sa * d.rv / d.ru + v * ca]; } // streets curl around the centre
      const p = toWorld(d, u, v);
      const n = addNode(p.x, p.z);
      Object.assign(n, { d, i, j, r, zone: d.zone(r) });
      d.grid.set(key(i, j), n); d.nodes.push(n);
    }
    const mi = Math.round(d.nu / 2) % d.art, mj = Math.round(d.nv / 2) % d.art;
    for (const n of d.nodes) for (const [di, dj] of [[1, 0], [0, 1]]) {
      const m = d.grid.get(key(n.i + di, n.j + dj)); if (!m) continue;
      const art = di ? n.j % d.art === mj : n.i % d.art === mi; // a u-street runs along a line of constant j
      const zone = n.r < m.r ? n.zone : m.zone;
      const r = addRoad(n, m, art ? 'art' : zone === 'dt' ? 'dt' : zone === 'ind' ? 'ind' : 'res');
      Object.assign(r, { zone, d, di, dj });
    }
    const alive = () => d.nodes.filter(n => !n.dead);
    const connected = () => {
      const all = alive(); if (!all.length) return true;
      const seen = new Set([all[0]]), stack = [all[0]];
      while (stack.length) { const n = stack.pop(); for (const r of n.roads) { const o = other(r, n); if (!seen.has(o)) { seen.add(o); stack.push(o); } } }
      return seen.size === all.length;
    };
    // T-junctions: drop some minor streets, keeping everything connected and every node on two streets
    const minor = roads.filter(r => r.d === d && (r.kind === 'res' || r.kind === 'ind'));
    for (let t = 0, k = 0; t < minor.length * 3 && k < minor.length * d.drop; t++) {
      const r = minor[(rand() * minor.length) | 0];
      if (r.dead || r.a.roads.length <= 2 || r.b.roads.length <= 2) continue;
      detach(r); if (connected()) { r.dead = true; k++; } else attach(r);
    }
    // no dead ends where the outline clips the grid
    for (let changed = true; changed;) {
      changed = false;
      for (const n of alive()) if (n.roads.length < 2) { for (const r of [...n.roads]) { detach(r); r.dead = true; } n.dead = true; changed = true; }
    }
    // keep the largest connected piece
    const comps = [], seen = new Set();
    for (const s of alive()) {
      if (seen.has(s)) continue;
      const comp = [s], stack = [s]; seen.add(s);
      while (stack.length) { const n = stack.pop(); for (const r of n.roads) { const o = other(r, n); if (!seen.has(o)) { seen.add(o); comp.push(o); stack.push(o); } } }
      comps.push(comp);
    }
    comps.sort((a, b) => b.length - a.length);
    for (const comp of comps.slice(1)) for (const n of comp) { for (const r of [...n.roads]) { detach(r); r.dead = true; } n.dead = true; }
    d.nodes = alive();
  }
  // street centre lines: Catmull-Rom along each grid line, so streets flow through junctions
  for (const r of roads) {
    if (r.dead) continue;
    const d = r.d, a = r.a, b = r.b, g = (i, j) => d.grid.get(i * 1000 + j);
    const p0 = g(a.i - r.di, a.j - r.dj) || { x: 2 * a.x - b.x, z: 2 * a.z - b.z };
    const p3 = g(b.i + r.di, b.j + r.dj) || { x: 2 * b.x - a.x, z: 2 * b.z - a.z };
    r.pts = []; crInto(r.pts, p0, a, b, p3, 2);
  }
  lap('districts');

  /* ---------- Highways and country roads, routed with A* ---------- */
  const AG = 16, AN = 2 * EXT / AG + 1;
  const aH = new Float32Array(AN * AN), aPenD = new Float32Array(AN * AN), aPen = new Float32Array(AN * AN);
  for (let j = 0; j < AN; j++) for (let i = 0; i < AN; i++) {
    const x = -EXT + i * AG, z = -EXT + j * AG, c = j * AN + i;
    aH[c] = Hn[(j * 4) * GN + i * 4];
    let pd = 0;
    for (const d of DISTRICTS) {
      if (Math.abs(x - d.ctr.x) > d.ru * 1.6 + d.rv && Math.abs(z - d.ctr.z) > d.ru * 1.6 + d.rv) continue;
      const r = maskR(d, x, z); pd = Math.max(pd, r < 1.12 ? 14 : r < 1.3 ? 3 : 0);
    }
    aPenD[c] = pd;
    if (Math.abs(riverSide(x, z)) < 75) aPen[c] += 9;
    if (Math.max(Math.abs(x), Math.abs(z)) > EXT - 280) aPen[c] += 40;
  }
  const aIdx = p => clamp(Math.round((p.z + EXT) / AG), 0, AN - 1) * AN + clamp(Math.round((p.x + EXT) / AG), 0, AN - 1);
  function penaliseNear(pts, rad, add, skipEnds = 0) {
    const mark = new Set(), s = arcLengths(pts), L = s[s.length - 1];
    pts.forEach((p, k) => {
      if (s[k] < skipEnds || L - s[k] < skipEnds) return;
      const ci = Math.round((p.x + EXT) / AG), cj = Math.round((p.z + EXT) / AG);
      for (let i = ci - rad; i <= ci + rad; i++) for (let j = cj - rad; j <= cj + rad; j++) if (i >= 0 && j >= 0 && i < AN && j < AN) mark.add(j * AN + i);
    });
    for (const c of mark) aPen[c] += add;
  }
  penaliseNear(fpts, 2, 5);
  const MOVES = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];
  const gS = new Float64Array(AN * AN), came = new Int32Array(AN * AN), shut = new Uint8Array(AN * AN);
  const heapF = new Float64Array(AN * AN * 4), heapI = new Int32Array(AN * AN * 4);
  function astar(a, b, o) {
    gS.fill(Infinity); came.fill(-1); shut.fill(0);
    const s0 = aIdx(a), goal = aIdx(b), ai = s0 % AN, aj = (s0 / AN) | 0, bi = goal % AN, bj = (goal / AN) | 0;
    let size = 0;
    const push = (f, i) => {
      let k = size++;
      while (k > 0) { const p = (k - 1) >> 1; if (heapF[p] <= f) break; heapF[k] = heapF[p]; heapI[k] = heapI[p]; k = p; }
      heapF[k] = f; heapI[k] = i;
    };
    const pop = () => {
      const top = heapI[0], f = heapF[--size], i = heapI[size];
      let k = 0;
      for (;;) { let c = 2 * k + 1; if (c >= size) break; if (c + 1 < size && heapF[c + 1] < heapF[c]) c++; if (heapF[c] >= f) break; heapF[k] = heapF[c]; heapI[k] = heapI[c]; k = c; }
      heapF[k] = f; heapI[k] = i;
      return top;
    };
    gS[s0] = 0; push(0, s0);
    while (size) {
      const c = pop();
      if (shut[c]) continue;
      shut[c] = 1;
      if (c === goal) break;
      const ci = c % AN, cj = (c / AN) | 0;
      for (const [di, dj] of MOVES) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= AN || nj >= AN) continue;
        const n = nj * AN + ni;
        if (shut[n]) continue;
        const d = AG * Math.hypot(di, dj), g = Math.abs(aH[n] - aH[c]) / d;
        let k = 1 + (aPen[c] + aPen[n]) * 0.5 + (g / o.grade) ** 2 * o.gk + (g > o.max ? 25 : 0);
        // built-up land costs extra, except right where the road leaves or joins its districts
        if ((ni - ai) ** 2 + (nj - aj) ** 2 > 100 && (ni - bi) ** 2 + (nj - bj) ** 2 > 100) k += (aPenD[c] + aPenD[n]) * 0.5;
        const ng = gS[c] + d * k;
        if (ng < gS[n]) { gS[n] = ng; came[n] = c; push(ng + Math.hypot(ni - bi, nj - bj) * AG * 1.15, n); }
      }
    }
    const out = [];
    for (let c = goal; c >= 0; c = came[c]) out.push({ x: -EXT + (c % AN) * AG, z: -EXT + ((c / AN) | 0) * AG });
    return out.reverse();
  }
  const ROUTE_OPT = { hwy: { grade: 0.05, gk: 1.5, max: 0.08 }, art: { grade: 0.05, gk: 1.5, max: 0.08 }, rural: { grade: 0.065, gk: 1.0, max: 0.12 } };
  const byName = Object.fromEntries(DISTRICTS.map(d => [d.name, d]));
  const ENDS = {
    FW: { x: fpts[0].x, z: fpts[0].z, out: norm(fpts[0].x - fpts[1].x, fpts[0].z - fpts[1].z) },
    FE: { x: fpts[NF - 1].x, z: fpts[NF - 1].z, out: norm(fpts[NF - 1].x - fpts[NF - 2].x, fpts[NF - 1].z - fpts[NF - 2].z) },
  };
  function pickGate(d, aim) {
    const dir = norm(aim.x - d.ctr.x, aim.z - d.ctr.z);
    let best = null, bs = -Infinity;
    for (const n of d.nodes) {
      if (n.gate || n.roads.length >= 4) continue;
      const s = (n.x - d.ctr.x) * dir.x + (n.z - d.ctr.z) * dir.z + (n.roads.some(r => r.kind === 'art') ? 90 : 0) - n.roads.length * 12;
      if (s > bs) { bs = s; best = n; }
    }
    best.gate = true;
    return best;
  }
  // [from, to, kind, aim from (E, N), aim to]
  const PLAN = [
    ['Port Ashby', 'Westfield', 'hwy'],
    ['Port Ashby', 'Oakridge Heights', 'hwy'],
    ['Port Ashby', 'Southbank', 'art', [-450, -600], [-250, 0]],
    ['Port Ashby', 'Southbank', 'art', [800, -450], [700, 0]],
    ['Southbank', 'Southgate', 'hwy'],
    ['Southbank', 'Eastvale', 'hwy'],
    ['Westfield', 'Southgate', 'hwy'],
    ['FW', 'Millbrook', 'hwy'],
    ['FE', 'Eastvale', 'hwy'],
    ['Westfield', 'Millbrook', 'rural'],
    ['Southgate', 'Millbrook', 'rural'],
    ['Oakridge Heights', 'Eastvale', 'rural'],
    ['Oakridge Heights', 'Pine Hollow', 'rural'],
    ['Port Ashby', 'Pine Hollow', 'rural', [-200, 2000], [0, 2300]],
    ['Westfield', 'Pine Hollow', 'rural', [-2000, 1600], [0, 2700]],
    ['Lakeview', 'Port Ashby', 'hwy'],
    ['Lakeview', 'Westfield', 'rural'],
    ['Cedar Park', 'Southbank', 'hwy'],
    ['Cedar Park', 'Southgate', 'rural'],
    ['Cedar Park', 'Eastvale', 'rural'],
  ];
  const NAMES = { hwy: ['Harbor Road', 'Ridge Parkway', 'Mill Road', 'Valley Road', 'Westfield Road', 'County Road 9', 'Eastvale Road', 'Lakeview Drive', 'Cedar Parkway'], art: ['Ashby Bridge', 'Iron Bridge'],
    rural: ['Old Mill Lane', 'Quarry Road', 'Orchard Road', 'Pine Hollow Road', 'Highline Road', 'Creek Road', 'Lake Road', 'Cedar Lane', 'Fox Hollow Road', 'Brook Lane'] };
  const connectors = [];
  for (const [A, Bn, kind, aimA, aimB] of PLAN) {
    const ends = [[A, aimA, Bn], [Bn, aimB, A]].map(([name, aim, otherName]) => {
      if (ENDS[name]) {
        const f = ENDS[name];
        if (!f.node) { f.node = addNode(f.x, f.z, 'none'); f.node.fwyEnd = true; }
        return { node: f.node, dir: f.out, len: 110 }; // carry straight on, then curve away
      }
      const d = byName[name], o = ENDS[otherName] || byName[otherName].ctr;
      const target = aim ? P(aim[0], aim[1]) : o;
      const n = pickGate(d, target);
      // leave along the street the gate sits on, bent a little towards the destination
      let inward = null, bd = Infinity;
      for (const r of n.roads) { const m = other(r, n), dd = Math.hypot(m.x - d.ctr.x, m.z - d.ctr.z); if (dd < bd) { bd = dd; inward = m; } }
      const out = inward ? norm(n.x - inward.x, n.z - inward.z) : norm(n.x - d.ctr.x, n.z - d.ctr.z), aimDir = norm(target.x - n.x, target.z - n.z);
      return { node: n, dir: norm(out.x * 1.6 + aimDir.x, out.z * 1.6 + aimDir.z) };
    });
    const stub = e => ({ x: e.node.x + e.dir.x * (e.len || 72), z: e.node.z + e.dir.z * (e.len || 72) });
    const s1 = stub(ends[0]), s2 = stub(ends[1]);
    const mid = astar(s1, s2, ROUTE_OPT[kind]);
    let pts = [ends[0].node, ...resample([ends[0].node, s1], 8).slice(1, -1), s1, ...mid.slice(1, -1), s2, ...resample([s2, ends[1].node], 8).slice(1)].map(p => ({ x: p.x, z: p.z }));
    // smooth the corners; gently on country roads, or the switchbacks A* found on the hills straighten out
    pts = resample(pts, 8); relax(pts, kind === 'rural' ? 10 : 45, 6, 6);
    // then open up any curve tighter than the road's minimum radius, locally
    const RMIN = { rural: 26, hwy: 70, art: 45 }[kind];
    for (let pass = 0; pass < 40; pass++) {
      let tight = 0;
      for (let i = 6; i < pts.length - 6; i++) {
        const a = pts[i - 2], b = pts[i], c = pts[i + 2];
        const abx = b.x - a.x, abz = b.z - a.z, bcx = c.x - b.x, bcz = c.z - b.z;
        const d = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(c.x - a.x, c.z - a.z);
        if (d < 1e-6 || Math.abs(2 * (abx * bcz - abz * bcx) / d) < 1 / RMIN) continue;
        tight++;
        for (let k = Math.max(1, i - 3); k <= Math.min(pts.length - 2, i + 3); k++) { const p = pts[k], q0 = pts[k - 1], q1 = pts[k + 1]; p.x += ((q0.x + q1.x) / 2 - p.x) * 0.5; p.z += ((q0.z + q1.z) / 2 - p.z) * 0.5; }
      }
      if (!tight) break;
      pts = resample(pts, 8);
    }
    pts = resample(pts, 2);
    const list = NAMES[kind] || [];
    connectors.push({ kind, pts, a: ends[0].node, b: ends[1].node, name: list.length ? list.shift() : null, splits: [] });
    penaliseNear(pts, 2, 3, 160);
  }
  for (const c of connectors) c.s = arcLengths(c.pts);
  lap('routing');

  /* ---------- Crossings: junctions between highways, interchanges and bridges with the freeway ---------- */
  const SH = 40, segHash = new Map(), sk = (i, j) => (i + 512) * 1024 + (j + 512);
  connectors.forEach((c, ci) => {
    for (let i = 0; i < c.pts.length - 1; i++) {
      const a = c.pts[i], b = c.pts[i + 1];
      for (let x = Math.floor(Math.min(a.x, b.x) / SH); x <= Math.floor(Math.max(a.x, b.x) / SH); x++)
        for (let z = Math.floor(Math.min(a.z, b.z) / SH); z <= Math.floor(Math.max(a.z, b.z) / SH); z++) {
          const k = sk(x, z); if (!segHash.has(k)) segHash.set(k, []); segHash.get(k).push([ci, i]);
        }
    }
  });
  const polyAt = (c, s) => {
    let lo = 0, hi = c.s.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (c.s[m] <= s) lo = m; else hi = m; }
    const t = clamp((s - c.s[lo]) / ((c.s[hi] - c.s[lo]) || 1), 0, 1), a = c.pts[lo], b = c.pts[hi];
    return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), i: lo, tx: (b.x - a.x) / ((c.s[hi] - c.s[lo]) || 1), tz: (b.z - a.z) / ((c.s[hi] - c.s[lo]) || 1) };
  };
  const clearOfSplits = (c, s, gap) => s > gap && c.s[c.s.length - 1] - s > gap && c.splits.every(q => Math.abs(q.s - s) > gap);
  const stats = { junctions: 0, skipped: 0, interchanges: 0, overpasses: 0 };
  const seenX = new Set();
  connectors.forEach((c, ci) => {
    for (let i = 0; i < c.pts.length - 1; i++) {
      const a = c.pts[i], b = c.pts[i + 1], l = segHash.get(sk(Math.floor(a.x / SH), Math.floor(a.z / SH)));
      if (l) for (const [cj, j] of l) {
        if (cj <= ci) continue;
        const e = connectors[cj], h = segHit(a, b, e.pts[j], e.pts[j + 1]);
        if (!h) continue;
        const key = ci + ':' + cj + ':' + Math.round(a.x / 30) + ':' + Math.round(a.z / 30);
        if (seenX.has(key)) continue;
        seenX.add(key);
        const sa = c.s[i] + h[0] * (c.s[i + 1] - c.s[i]), sb = e.s[j] + h[1] * (e.s[j + 1] - e.s[j]);
        if (!clearOfSplits(c, sa, 45) || !clearOfSplits(e, sb, 45)) { stats.skipped++; continue; }
        const n = addNode(lerp(a.x, b.x, h[0]), lerp(a.z, b.z, h[0]));
        c.splits.push({ s: sa, node: n }); e.splits.push({ s: sb, node: n });
        stats.junctions++;
      }
    }
  });
  // where highways cross the freeway: an interchange if there's room, otherwise just a bridge
  const DIV = 88, MRG = 65, TERM = 70, TAPER = 30;
  const fCross = [];
  connectors.forEach(c => {
    for (let i = 0; i < c.pts.length - 1; i++) {
      const a = c.pts[i], b = c.pts[i + 1], l = fHash.get(fk(Math.floor(a.x / FH), Math.floor(a.z / FH)));
      if (!l) continue;
      for (const j0 of l) for (const j of [j0 - 1, j0]) {
        if (j < 0 || j >= NF - 1) continue;
        const h = segHit(a, b, fpts[j], fpts[j + 1]);
        if (!h || fCross.some(f => f.c === c && Math.abs(f.jc - j) < 6)) continue;
        if ((c.a.fwyEnd || c.b.fwyEnd) && (j < TAPER + 10 || j > NF - TAPER - 10)) continue; // where the highway leaves the freeway's end
        const s = c.s[i] + h[0] * (c.s[i + 1] - c.s[i]), t = norm(b.x - a.x, b.z - a.z);
        fCross.push({ c, s, jc: j + h[1], x: lerp(a.x, b.x, h[0]), z: lerp(a.z, b.z, h[0]), sin: Math.abs(t.x * fpts[j].tz - t.z * fpts[j].tx) });
      }
    }
  });
  fCross.sort((p, q) => p.jc - q.jc);
  const interchanges = [];
  for (const f of fCross) {
    const jc = Math.round(f.jc);
    const ok = f.sin > 0.8 && jc > TAPER + DIV + 20 && jc < NF - 1 - TAPER - DIV - 20
      && interchanges.every(o => Math.abs(o.jc - jc) * 4 > 800) && clearOfSplits(f.c, f.s, TERM + 30);
    if (!ok) { stats.overpasses++; continue; }
    const name = f.c.name || 'Exit';
    const Tin = addNode(polyAt(f.c, f.s - TERM).x, polyAt(f.c, f.s - TERM).z, 'signal'), Tout = addNode(polyAt(f.c, f.s + TERM).x, polyAt(f.c, f.s + TERM).z, 'signal');
    f.c.splits.push({ s: f.s - TERM, node: Tin }, { s: f.s + TERM, node: Tout });
    interchanges.push({ jc, x: f.x, z: f.z, T: [Tin, Tout], name });
    f.ic = true;
    stats.interchanges++;
  }
  stats.fx = fCross.map(f => [f.c.kind, f.c.name, Math.round(f.sin * 100) / 100, Math.round(f.jc), !!f.ic]);
  // split the highways into roads between their junctions
  for (const c of connectors) {
    const cuts = [{ s: 0, node: c.a }, ...c.splits.sort((p, q) => p.s - q.s), { s: c.s[c.s.length - 1], node: c.b }];
    for (let k = 0; k < cuts.length - 1; k++) {
      const A = cuts[k], B = cuts[k + 1], pts = [{ x: A.node.x, z: A.node.z, y: 0 }];
      for (let i = 0; i < c.pts.length; i++) if (c.s[i] > A.s + 1 && c.s[i] < B.s - 1) pts.push({ x: c.pts[i].x, z: c.pts[i].z, y: 0 });
      pts.push({ x: B.node.x, z: B.node.z, y: 0 });
      const r = addRoad(A.node, B.node, c.kind, pts);
      r.conn = c; r.s0 = A.s;
    }
  }
  // drop dead district nodes and roads; renumber
  for (let i = roads.length - 1; i >= 0; i--) if (roads[i].dead) roads.splice(i, 1);
  for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].dead || !nodes[i].roads.length && nodes[i].type !== 'fwy') nodes.splice(i, 1);
  nodes.forEach((n, i) => { n.id = i; }); roads.forEach((r, i) => { r.id = i; });
  lap('junctions');

  /* ================= Grading: road profiles and bridges ================= */
  for (const n of nodes) n.y = avgNat(n.x, n.z, 8);
  // junction heights are nudged (cut or filled) until no road between two of them is steeper than its kind allows
  const MAXG = { res: 0.09, ind: 0.08, dt: 0.08, art: 0.08, hwy: 0.07, rural: 0.11 };
  for (const r of roads) r.len = linkLen(r.pts);
  for (let it = 0; it < 60; it++) {
    let worst = 0;
    for (const r of roads) {
      const allowed = MAXG[r.kind] * Math.max(5, r.len - 26), diff = r.b.y - r.a.y, excess = Math.abs(diff) - allowed;
      if (excess <= 0) continue;
      worst = Math.max(worst, excess);
      const sg = Math.sign(diff) * excess * 0.5;
      if (!r.a.fwyEnd) r.a.y += sg * (r.b.fwyEnd ? 2 : 1);
      if (!r.b.fwyEnd) r.b.y -= sg * (r.a.fwyEnd ? 2 : 1);
    }
    if (worst < 0.05) break;
  }
  /**
   * Fit a vertical profile to a centre line: follow the terrain smoothed over `win` metres, ease into the
   * end heights, respect minimum heights (bridges), and limit the grade. Writes p.y; returns deck flags.
   */
  function gradeRoad(pts, ya, yb, win, maxG, opt = {}) {
    const n = pts.length, s = arcLengths(pts), L = s[n - 1], nat = new Float32Array(n);
    const flat = opt.flat ?? Math.min(13, L / 8); // level ground at each junction
    maxG = Math.max(maxG, Math.abs(yb - ya) / Math.max(1, L - 2 * flat - 6) * 1.1); // if the ends demand it, climb evenly
    const y = new Float32Array(n), cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) nat[i] = natAt(pts[i].x, pts[i].z);
    const box = (src, w) => {
      cs[0] = 0; for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + src[i];
      const out = new Float32Array(n);
      for (let i = 0, lo = 0, hi = 0; i < n; i++) {
        while (s[i] - s[lo] > w / 2) lo++;
        while (hi < n - 1 && s[hi + 1] - s[i] <= w / 2) hi++;
        out[i] = (cs[hi + 1] - cs[lo]) / (hi - lo + 1);
      }
      return out;
    };
    y.set(box(nat, win));
    const pin = () => { for (let i = 0; i < n; i++) { if (s[i] <= flat) y[i] = ya; else if (L - s[i] <= flat) y[i] = yb; } };
    // limit the grade with both ends held: first to what is reachable from either end, then neighbour by neighbour
    pin();
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < n; i++) {
        const da = Math.max(0, s[i] - flat), db = Math.max(0, L - flat - s[i]);
        const lo = Math.max(ya - maxG * da, yb - maxG * db), hi = Math.min(ya + maxG * da, yb + maxG * db);
        if (lo <= hi) y[i] = clamp(y[i], lo, hi);
      }
      for (let i = 1; i < n; i++) { const g = maxG * (s[i] - s[i - 1]); y[i] = clamp(y[i], y[i - 1] - g, y[i - 1] + g); }
      for (let i = n - 2; i >= 0; i--) { const g = maxG * (s[i + 1] - s[i]); y[i] = clamp(y[i], y[i + 1] - g, y[i + 1] + g); }
      pin();
    }
    // then lift it over whatever it must clear, ramping up to each bridge at the same grade
    const lift = () => {
      if (!opt.minY) return;
      for (let i = 0; i < n; i++) y[i] = Math.max(y[i], opt.minY[i]);
      for (let i = 1; i < n; i++) y[i] = Math.max(y[i], y[i - 1] - maxG * (s[i] - s[i - 1]));
      for (let i = n - 2; i >= 0; i--) y[i] = Math.max(y[i], y[i + 1] - maxG * (s[i + 1] - s[i]));
    };
    pin(); lift();
    y.set(box(y, 14)); pin(); lift();
    const deck = new Uint8Array(n), lim = opt.deckAt ?? 3;
    for (let i = 0; i < n; i++) deck[i] = (opt.forced && opt.forced[i]) || y[i] - nat[i] > lim ? 1 : 0;
    // ignore tiny bits of bridge, then widen every bridge by a point at each end for the abutments
    for (let i = 0; i < n;) {
      if (!deck[i]) { i++; continue; }
      let j = i; while (j < n && deck[j]) j++;
      if (j - i < 4 && !(opt.forced && opt.forced.slice(i, j).some(Boolean))) deck.fill(0, i, j);
      i = j;
    }
    const wide = deck.slice();
    for (let i = 0; i < n; i++) if (deck[i]) { if (i > 0) wide[i - 1] = 1; if (i < n - 1) wide[i + 1] = 1; }
    for (let i = 0; i < n; i++) { pts[i].y = y[i]; if (i > 2) { const g = Math.abs(y[i] - y[i - 3]) / Math.max(1, s[i] - s[i - 3]); if (g > (stats.maxGrade || 0)) { stats.maxGrade = g; stats.maxGradeAt = [Math.round(pts[i].x), Math.round(pts[i].z), i, n, Math.round(ya), Math.round(yb), Math.round(L), maxG.toFixed(3)]; } } }
    return wide;
  }
  const PROFILE = { res: [36, 0.09], ind: [36, 0.08], dt: [36, 0.08], art: [44, 0.08], hwy: [90, 0.07], rural: [56, 0.11] };
  for (const r of roads) {
    const [win, g] = PROFILE[r.kind], opt = {};
    if (r.conn) { // bridges over the river
      const n = r.pts.length, minY = new Float32Array(n), forced = new Uint8Array(n);
      let any = false;
      r.pts.forEach((p, i) => { const rd = Math.abs(riverSide(p.x, p.z)); if (rd < RIVER_W + 6) { minY[i] = WATER + 7.5; any = true; } if (rd < RIVER_W) forced[i] = 1; });
      if (any) { opt.minY = minY; opt.forced = forced; }
    }
    r.deck = gradeRoad(r.pts, r.a.y, r.b.y, win, g, opt);
  }
  // Freeway: long, gentle profile; it bridges every road it crosses
  {
    const minY = new Float32Array(NF), forced = new Uint8Array(NF);
    for (const f of fCross) {
      const piece = roads.find(r => r.conn === f.c && r.s0 <= f.s && (r.s0 + linkLen(r.pts)) >= f.s - 1);
      let yc = natAt(f.x, f.z);
      if (piece) { let bd = Infinity; for (const p of piece.pts) { const d = (p.x - f.x) ** 2 + (p.z - f.z) ** 2; if (d < bd) { bd = d; yc = p.y; } } }
      const span = Math.ceil((HALF + 15) / Math.max(0.45, f.sin) / 4);
      for (let j = Math.round(f.jc) - span; j <= Math.round(f.jc) + span; j++) if (j >= 0 && j < NF) { minY[j] = Math.max(minY[j], yc + 8.5); forced[j] = 1; }
    }
    ENDS.FW.node.y = natAt(fpts[0].x, fpts[0].z); ENDS.FE.node.y = natAt(fpts[NF - 1].x, fpts[NF - 1].z);
    fpts.deck = gradeRoad(fpts, ENDS.FW.node.y, ENDS.FE.node.y, 320, 0.045, { minY, forced, deckAt: 3.5 });
  }
  lap('grading');

  /* ================= Freeway links and ramps ================= */
  const laneOff = k => 2 + LW / 2 + (1 - k) * LW; // lane 1 (left) 3.85 m, lane 0 (right) 7.55 m, accel (-1) 11.25 m
  const offAt = (j, k) => lerp(LANE, laneOff(k), smoothstep(2, TAPER, Math.min(j, NF - 1 - j))); // narrows at the ends
  const makeLane = (link, index, pts) => {
    const n = pts.length, a = pts[n - 2], b = pts[n - 1];
    return { link, index, pts, control: 'none', axis: 'NS', dir: norm(b.x - a.x, b.z - a.z) };
  };
  const fwyRoad = { kind: 'fwy' }; // shared, so a freeway end never offers a U-turn onto the other carriageway
  const fwyLinks = [], ramps = [];
  for (const dir of [1, -1]) {
    const idx = j => dir > 0 ? j : NF - 1 - j;
    const at = (j, off) => { const p = fpts[idx(clamp(j, 0, NF - 1))], tx = p.tx * dir, tz = p.tz * dir; return { x: p.x - tz * off, z: p.z + tx * off, y: p.y, tx, tz }; };
    const lanePts = (j0, j1, k) => { const out = []; for (let j = j0; j <= j1; j++) { const q = at(j, offAt(j, k)); out.push({ x: q.x, z: q.z, y: q.y }); } return out; };
    const cs = interchanges.map(ic => ({ ic, jc: dir > 0 ? ic.jc : NF - 1 - ic.jc })).sort((p, q) => p.jc - q.jc);
    for (const o of cs) {
      const pd = at(o.jc - DIV, 0), pm = at(o.jc + MRG, 0);
      o.D = addNode(pd.x, pd.z, 'fwy'); o.M = addNode(pm.x, pm.z, 'fwy'); o.D.y = pd.y; o.M.y = pm.y;
    }
    const fwyLink = (from, to, j0, j1, withAccel) => {
      const L = { id: links.length, from, to, kind: 'fwy', speed: SPEED.fwy, road: fwyRoad };
      L.lanes = [makeLane(L, 0, lanePts(j0, j1, 0)), makeLane(L, 1, lanePts(j0, j1, 1))];
      L.accel = withAccel ? makeLane(L, -1, lanePts(j0, j0 + Math.min(45, j1 - j0 - 12), -1)) : null;
      L.len = linkLen(L.lanes[0].pts);
      links.push(L); from.out.push(L); to.in.push(L); fwyLinks.push(L);
      return L;
    };
    let prev = dir > 0 ? ENDS.FW.node : ENDS.FE.node, pj = 0, accel = false;
    cs.forEach((o, m) => {
      fwyLink(prev, o.D, pj, o.jc - DIV, accel);
      fwyLink(o.D, o.M, o.jc - DIV, o.jc + MRG, false);
      prev = o.M; pj = o.jc + MRG; accel = true;
      // ramps to and from the terminal on this carriageway's right
      const C = at(o.jc, 0), rx = -C.tz, rz = C.tx;
      const T = o.ic.T.find(t => (t.x - o.ic.x) * rx + (t.z - o.ic.z) * rz > 0) || o.ic.T[0];
      const off = [];
      for (let j = o.jc - DIV; j <= o.jc - DIV + 30; j++) { const q = at(j, lerp(laneOff(0), 14, smoothstep(0, 1, (j - o.jc + DIV) / 30))); off.push({ x: q.x, z: q.z, y: q.y }); }
      const nd = off.length, P0 = off[nd - 1], t0 = at(o.jc - DIV + 30, 0), k1 = Math.hypot(T.x - P0.x, T.z - P0.z) * 0.42;
      cubicInto(off, P0, { x: P0.x + t0.tx * k1, z: P0.z + t0.tz * k1 }, { x: T.x - C.tx * k1, z: T.z - C.tz * k1 }, { x: T.x, z: T.z }, 2);
      off.forEach((p, i) => { if (i >= nd) p.y = lerp(P0.y, T.y, smoothstep(0, 0.82, (i - nd + 1) / (off.length - nd))); });
      ramps.push(addRoad(o.D, T, 'ramp', off, true));
      const A0 = at(o.jc + MRG, laneOff(-1)), k2 = Math.hypot(A0.x - T.x, A0.z - T.z) * 0.42, on = [];
      cubicInto(on, { x: T.x, z: T.z }, { x: T.x + C.tx * k2, z: T.z + C.tz * k2 }, { x: A0.x - A0.tx * k2, z: A0.z - A0.tz * k2 }, { x: A0.x, z: A0.z }, 2);
      on.forEach((p, i) => { p.y = lerp(T.y, A0.y, smoothstep(0.18, 1, i / (on.length - 1))); });
      ramps.push(addRoad(T, o.M, 'ramp', on, true));
      o.D.exit = { no: m + 1 + (dir > 0 ? 0 : 10), name: o.ic.name, j: o.jc - DIV, at };
    });
    fwyLink(prev, dir > 0 ? ENDS.FE.node : ENDS.FW.node, pj, NF - 1, accel);
  }
  for (const r of ramps) {
    const nat = r.pts.map(p => natAt(p.x, p.z));
    r.deck = Uint8Array.from(r.pts, (p, i) => p.y - nat[i] > 3 ? 1 : 0);
  }
  lap('freeway');

  /* ================= Terrain carving and the ground raster ================= */
  // Each 4 m cell remembers the nearest road surface (distance beyond the road's core, its height, and how
  // wide an embankment it wants); the final terrain blends from the road height to the natural ground.
  const cDist = new Float32Array(GN * GN).fill(1e9), cY = new Float32Array(GN * GN), cEmb = new Float32Array(GN * GN);
  const cIn = new Float32Array(GN * GN).fill(1e9); // distance beyond the paved edge (road, pavement or junction pad)
  function carve(x, z, y, core, emb, hw = 0) {
    const R = core + emb;
    const i0 = Math.max(0, Math.floor((x - R + EXT) / CELL)), i1 = Math.min(GN - 1, Math.ceil((x + R + EXT) / CELL));
    const j0 = Math.max(0, Math.floor((z - R + EXT) / CELL)), j1 = Math.min(GN - 1, Math.ceil((z + R + EXT) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = -EXT + i * CELL - x, dz = -EXT + j * CELL - z, dd = Math.sqrt(dx * dx + dz * dz), d = dd - core;
      if (d > emb) continue;
      const c = j * GN + i;
      if (hw && dd - hw < cIn[c]) cIn[c] = dd - hw;
      if (d < cDist[c]) { cDist[c] = d; cY[c] = y; cEmb[c] = emb; }
    }
  }
  const embOf = (y, x, z) => clamp(Math.abs(y - natAt(x, z)) * 2.2 + 5, 6, 36);
  const CORE = { res: 9, dt: 9, art: 9, ind: 7, rural: 6.5, hwy: 7, ramp: 5 };
  for (const r of roads) {
    const core = r.zone && r.zone !== 'ind' ? 9 : CORE[r.kind];
    // paved half-width: kerb-to-kerb plus pavements where the street has them
    const hw = r.zone === 'dt' || r.zone === 'mid' ? 10.8 : r.zone && r.zone !== 'ind' && (r.zone !== 'vil' || r.kind === 'art') ? 8.3 : HALF + 0.5;
    r.pts.forEach((p, i) => { if (!r.deck[i]) carve(p.x, p.z, p.y, core, embOf(p.y, p.x, p.z), hw); });
  }
  fpts.forEach((p, i) => { if (!fpts.deck[i]) carve(p.x, p.z, p.y, FW + 3, embOf(p.y, p.x, p.z), FW + 1); });
  for (const n of nodes) if (n.type !== 'fwy') carve(n.x, n.z, n.y, PATCH + 5, 8, PATCH + 2);
  const H = new Float32Array(GN * GN);
  for (let c = 0; c < GN * GN; c++) {
    const d = cDist[c];
    H[c] = d >= cEmb[c] ? Hn[c] : d <= 0 ? cY[c] : lerp(cY[c], Hn[c], smoothstep(0, cEmb[c], d));
  }
  const groundAt = (x, z) => sampleGrid(H, x, z) ?? channel(hBase(x, z), Math.abs(riverSide(x, z)));
  // the terrain you see sits 40 cm below anything paved, so the 4 m grid can't poke up through a road on a slope
  // or a curve (physics still uses H, which matches the road surface)
  const Hvis = new Float32Array(GN * GN);
  for (let c = 0; c < GN * GN; c++) Hvis[c] = H[c] - 0.4 * (1 - smoothstep(-0.2, 1.6, cIn[c]));

  // What covers the ground, 2 m cells: bit 1 road surface, bit 2 sidewalk or driveway, bit 4 keep clear
  const RC = 2, RW = 2 * EXT / RC, raster = new Uint8Array(RW * RW);
  const PAVED = 1, WALK = 2, CLEAR = 4;
  function stamp(x, z, r, bits) {
    const i0 = Math.max(0, Math.floor((x - r + EXT) / RC)), i1 = Math.min(RW - 1, Math.floor((x + r + EXT) / RC));
    const j0 = Math.max(0, Math.floor((z - r + EXT) / RC)), j1 = Math.min(RW - 1, Math.floor((z + r + EXT) / RC));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cx = (i + 0.5) * RC - EXT, cz = (j + 0.5) * RC - EXT;
      if ((cx - x) ** 2 + (cz - z) ** 2 <= r * r) raster[j * RW + i] |= bits;
    }
  }
  const bitsAt = (x, z) => { const i = Math.floor((x + EXT) / RC), j = Math.floor((z + EXT) / RC); return i < 0 || j < 0 || i >= RW || j >= RW ? CLEAR : raster[j * RW + i]; };
  function stampLine(pts, r, bits, step = 1.5) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
      for (let k = 0; k <= n; k++) stamp(a.x + (b.x - a.x) * k / n, a.z + (b.z - a.z) * k / n, r, bits);
    }
  }
  const hwOf = kind => kind === 'ramp' ? 2.6 : HALF;
  const hasWalk = r => r.zone && r.zone !== 'ind' && (r.zone !== 'vil' || r.kind === 'art');
  const fullWalk = r => r.zone === 'dt' || r.zone === 'mid'; // paved right up to the kerb
  for (const r of roads) {
    const hw = hwOf(r.kind), fr = frames(r.pts);
    fr.forEach((f, i) => {
      if (r.deck[i]) { stamp(f.x, f.z, hw + 3, CLEAR); return; }
      if (i % 2 === 0) stamp(f.x, f.z, hw + 0.6, PAVED);
      if (hasWalk(r) && i % 2 === 0) for (const sg of [1, -1]) { const c = fullWalk(r) ? 7.3 : 7.1; stamp(f.x + f.rx * sg * c, f.z + f.rz * sg * c, fullWalk(r) ? 3.1 : 1.2, WALK); }
    });
  }
  fpts.forEach((p, i) => stamp(p.x, p.z, fpts.deck[i] ? FW + 4 : FW + 1.5, fpts.deck[i] ? CLEAR : PAVED));
  for (const n of nodes) if (n.type !== 'fwy') stamp(n.x, n.z, PATCH + 2, PAVED);
  lap('carving');

  /* ================= Bridge decks for height queries ================= */
  const HG = 32, deckHash = new Map(), hkey = (i, j) => (i + 512) * 1024 + (j + 512);
  function addDecks(pts, deck, hw) {
    for (let i = 0; i < pts.length - 1; i++) {
      if (!deck[i] && !deck[i + 1]) continue;
      const a = pts[i], b = pts[i + 1], seg = { ax: a.x, az: a.z, bx: b.x, bz: b.z, ya: a.y, yb: b.y, hw };
      for (let x = Math.floor((Math.min(a.x, b.x) - hw) / HG); x <= Math.floor((Math.max(a.x, b.x) + hw) / HG); x++)
        for (let z = Math.floor((Math.min(a.z, b.z) - hw) / HG); z <= Math.floor((Math.max(a.z, b.z) + hw) / HG); z++) {
          const k = hkey(x, z); if (!deckHash.has(k)) deckHash.set(k, []); deckHash.get(k).push(seg);
        }
    }
  }
  for (const r of roads) addDecks(r.pts, r.deck, hwOf(r.kind) + 0.6);
  addDecks(fpts, fpts.deck, FW + 0.6);
  /** Surface height under (x, z) for something at height `yHint`: the highest bridge deck within a step of it, else the ground. */
  function heightAt(x, z, yHint = -Infinity) {
    let best = Math.max(groundAt(x, z) + 0.05, pondHeight(x, z), WINTER ? WATER + 0.03 : -Infinity); // in winter the river and the ponds are ice you can stand on
    const list = deckHash.get(hkey(Math.floor(x / HG), Math.floor(z / HG)));
    if (list) for (const s of list) {
      const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz;
      const t = ((x - s.ax) * dx + (z - s.az) * dz) / l2;
      // the segment we're over, overlapping its neighbours a little so the outside of a curve has no gaps
      if (t < -0.3 || t > 1.3) continue;
      if ((x - s.ax - dx * t) ** 2 + (z - s.az - dz * t) ** 2 > s.hw * s.hw) continue;
      const y = lerp(s.ya, s.yb, t) + 0.05;
      if (y <= yHint + 1.2 && y > best) best = y;
    }
    return best;
  }

  /* ================= Node control, lanes, connectors ================= */
  const isJunction = n => n.type !== 'fwy';
  const trimPts = (pts, a, b, ra, rb) => pts.filter(p => Math.hypot(p.x - a.x, p.z - a.z) >= ra && Math.hypot(p.x - b.x, p.z - b.z) >= rb);
  for (const n of nodes) {
    if (n.type) continue;
    if (n.roads.length <= 2) { n.type = 'none'; continue; }
    const ranks = n.roads.map(r => RANK[r.kind]), hi = Math.max(...ranks), lo = Math.min(...ranks);
    if (n.roads.some(r => r.kind === 'dt')) n.type = 'signal';
    else if (hi === lo) n.type = hi >= 3 ? 'signal' : 'allway';
    else n.type = 'twoway';
  }
  nodes.forEach(n => { n.signalOffset = rand() * 42; n.maxRank = Math.max(0, ...n.roads.map(r => RANK[r.kind])); });
  for (const r of roads) {
    const dirs = r.oneway ? [[r.a, r.b, r.pts]] : [[r.a, r.b, r.pts], [r.b, r.a, r.pts.slice().reverse()]];
    for (const [from, to, pts] of dirs) {
      const L = { id: links.length, from, to, kind: r.kind, speed: SPEED[r.kind], road: r, accel: null };
      const off = r.kind === 'ramp' ? 0 : LANE;
      const lp = frames(pts).map(f => ({ x: f.x + f.rx * off, z: f.z + f.rz * off, y: f.y }));
      let lanePts = trimPts(lp, from, to, isJunction(from) ? R_INT : 0, isJunction(to) ? R_INT : 0);
      if (lanePts.length < 3) { const m = lp.length >> 1; lanePts = lp.slice(Math.max(0, m - 1), m + 2); }
      L.lanes = [makeLane(L, 0, lanePts)];
      L.len = linkLen(lanePts);
      const lane = L.lanes[0];
      if (to.type === 'signal') lane.control = 'signal';
      else if (to.type === 'allway') lane.control = 'stop';
      else if (to.type === 'twoway' && RANK[r.kind] < to.maxRank) lane.control = 'stop';
      links.push(L); from.out.push(L); to.in.push(L);
    }
  }
  // Signal phases: approaches roughly parallel to the first one share its phase
  for (const n of nodes) {
    if (n.type !== 'signal' || !n.in.length) continue;
    const ref = n.in[0].lanes[0].dir;
    for (const L of n.in) { const d = L.lanes[0].dir; L.lanes[0].axis = Math.abs(d.x * ref.x + d.z * ref.z) > 0.5 ? 'NS' : 'EW'; }
  }
  const conns = new Map();
  for (const n of nodes) {
    if (!isJunction(n)) continue;
    for (const Li of n.in) for (const Lo of n.out) {
      if (Li.road && Li.road === Lo.road) continue; // no U-turns
      const lin = Li.lanes[0], lout = Lo.lanes[0];
      const P0 = lin.pts[lin.pts.length - 1], P3 = lout.pts[0], d1 = lout.pts[1];
      const di = lin.dir, dout = norm(d1.x - P3.x, d1.z - P3.z);
      const dot = di.x * dout.x + di.z * dout.z, cross = di.x * dout.z - di.z * dout.x;
      const turn = dot > 0.7 ? 'straight' : cross < 0 ? 'left' : 'right';
      const D = Math.hypot(P3.x - P0.x, P3.z - P0.z), k = D * (turn === 'straight' ? 0.33 : 0.5);
      const pts = [];
      cubicInto(pts, P0, { x: P0.x + di.x * k, z: P0.z + di.z * k }, { x: P3.x - dout.x * k, z: P3.z - dout.z * k }, P3, 1);
      pts.forEach((p, i) => { p.y = lerp(P0.y, P3.y, i / (pts.length - 1)); });
      conns.set(Li.id + '>' + Lo.id, { kind: 'conn', id: conns.size, node: n, from: Li, to: Lo, pts, turn, speed: Math.min(Li.speed, Lo.speed) });
    }
  }
  const conflictCache = new Map();
  function conflicts(c1, c2) {
    if (!c1 || !c2 || c1.node !== c2.node || c1.from === c2.from) return false;
    const key = c1.id < c2.id ? c1.id + ':' + c2.id : c2.id + ':' + c1.id;
    if (conflictCache.has(key)) return conflictCache.get(key);
    let hit = false;
    outer: for (const p of c1.pts) for (const q of c2.pts) if ((p.x - q.x) ** 2 + (p.z - q.z) ** 2 < 2.4 * 2.4) { hit = true; break outer; }
    conflictCache.set(key, hit);
    return hit;
  }

  /* ================= Routing (link-based Dijkstra with a binary heap) ================= */
  function route(startLink, goal) {
    const dist = new Map([[startLink.id, 0]]), prev = new Map(), heap = [[0, startLink]], done = new Set();
    const push = e => { heap.push(e); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    let found = null;
    while (heap.length) {
      const [c, L] = pop();
      if (done.has(L.id)) continue;
      done.add(L.id);
      if (L !== startLink && L.to === goal) { found = L; break; }
      const n = L.to;
      for (const Lo of n.out) {
        if (isJunction(n) && L.road && L.road === Lo.road) continue;
        const pen = isJunction(n) && n.type !== 'none' ? 5 + rand() * 5 : 0;
        const nc = c + Lo.len / Lo.speed + pen;
        if (nc < (dist.get(Lo.id) ?? Infinity)) { dist.set(Lo.id, nc); prev.set(Lo.id, L); push([nc, Lo]); }
      }
    }
    if (!found) return null;
    const out = [found];
    while (prev.get(out[0].id) !== startLink) { const p = prev.get(out[0].id); if (!p) return null; out.unshift(p); }
    return out;
  }
  const destinations = nodes.filter(n => isJunction(n) && n.out.length && n.in.length);
  // Mostly somewhere within a couple of kilometres: traffic only exists near the player anyway
  function randomDestination(from) {
    let n;
    for (let t = 0; t < 30; t++) {
      n = destinations[(rand() * destinations.length) | 0];
      if (n !== from && (!from || Math.hypot(n.x - from.x, n.z - from.z) < 2200)) return n;
    }
    return n === from ? destinations[0] : n;
  }

  /* ================= Signals ================= */
  const PLAN_SIG = [['NS', 'G', 16], ['NS', 'Y', 3.5], ['-', 'R', 1.5], ['EW', 'G', 16], ['EW', 'Y', 3.5], ['-', 'R', 1.5]];
  const CYCLE = PLAN_SIG.reduce((s, p) => s + p[2], 0);
  let clock = 0;
  function signalState(n, axis) {
    let t = (clock + n.signalOffset) % CYCLE;
    for (const [ax, st, dur] of PLAN_SIG) { if (t < dur) return ax === axis ? st : 'R'; t -= dur; }
    return 'R';
  }
  lap('network');

  /* ================= Materials ================= */
  const canvasTex = (w, h, draw, repeat) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 8;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  };
  // Tileable value noise in a canvas: R fine grain, G medium blotches, B large stains (all 0..255 around 128)
  const dataTex = (w, h, fill, srgb = false) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), img = g.createImageData(w, h);
    fill(img.data, w, h);
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    if (srgb) t.encoding = THREE.sRGBEncoding;
    return t;
  };
  function tileNoise(N, period, oct) { // periodic fbm on an N x N grid, 0..1
    const out = new Float32Array(N * N), lat = new Float32Array(period * period * 8);
    for (let i = 0; i < lat.length; i++) lat[i] = rand();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let v = 0, amp = 0.5, tot = 0;
      for (let o = 0; o < oct; o++) {
        const P2 = period << o, fx = x / N * P2, fy = y / N * P2, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
        const L = (i, j) => lat[((((j % P2) + P2) % P2) * P2 + (((i % P2) + P2) % P2)) % lat.length];
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        v += amp * lerp(lerp(L(ix, iy), L(ix + 1, iy), sx), lerp(L(ix, iy + 1), L(ix + 1, iy + 1), sx), sy);
        tot += amp; amp *= 0.5;
      }
      out[y * N + x] = v / tot;
    }
    return out;
  }
  const DN = 256, nFine = tileNoise(DN, 32, 3), nMid = tileNoise(DN, 8, 4), nBig = tileNoise(DN, 4, 4);
  const detailTex = dataTex(DN, DN, d => { for (let i = 0; i < DN * DN; i++) { d[i * 4] = nFine[i] * 255; d[i * 4 + 1] = nMid[i] * 255; d[i * 4 + 2] = nBig[i] * 255; d[i * 4 + 3] = 255; } });
  // World-space detail: multiplies the albedo by grain and by large stains sampled in metres, so nothing tiles
  function worldDetail(mat, { fine = 1 / 3, mid = 1 / 23, big = 1 / 140, aFine = 0.1, aMid = 0.14, aBig = 0.12, extra = '' } = {}) {
    mat.onBeforeCompile = sh => {
      sh.uniforms.tDetail = { value: detailTex };
      sh.vertexShader = 'varying vec3 vWPos;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 wpD = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wpD = instanceMatrix * wpD;
        #endif
        vWPos = (modelMatrix * wpD).xyz;`);
      sh.fragmentShader = 'varying vec3 vWPos;\nuniform sampler2D tDetail;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        float dF = texture2D(tDetail, vWPos.xz * ${fine.toFixed(5)}).r, dM = texture2D(tDetail, vWPos.xz * ${mid.toFixed(5)}).g, dB = texture2D(tDetail, vWPos.xz * ${big.toFixed(5)}).b;
        diffuseColor.rgb *= 1.0 + ${aFine.toFixed(3)} * (dF - 0.5) * 2.0 + ${aMid.toFixed(3)} * (dM - 0.5) * 2.0 + ${aBig.toFixed(3)} * (dB - 0.5) * 2.0;
        ${extra}`);
    };
    mat.customProgramCacheKey = () => 'detail' + fine + mid + big + aFine + aMid + aBig + extra;
    return mat;
  }
  // Photo materials (Poly Haven, CC0): colour, normal and roughness maps sampled in world space (metres) on
  // horizontal surfaces, layered on top of each material's own colour. `lum` keeps the base colour and takes only
  // the photo's light and shade; otherwise the photo's colour comes through by `tint`.
  const NO_ROUGH = new Set(['red_brick_03', 'beige_wall_001', 'exterior_wall_cladding_03', 'concrete_wall_008', 'corrugated_iron_02', 'grey_roof_01', 'gravel']);
  // GLSL: bend a normal by a tangent-space normal map using screen-space derivatives (no tangents needed)
  const PERTURB = `
    vec3 pnPerturb(vec3 eye, vec3 n, vec3 mapN, vec2 uv) {
      vec3 q0 = dFdx(eye), q1 = dFdy(eye); vec2 st0 = dFdx(uv), st1 = dFdy(uv);
      vec3 q1p = cross(q1, n), q0p = cross(n, q0);
      vec3 T = q1p * st0.x + q0p * st1.x, B = q1p * st0.y + q0p * st1.y;
      float det = max(dot(T, T), dot(B, B)), sc = det == 0.0 ? 0.0 : inversesqrt(det);
      return normalize(T * (mapN.x * sc) + B * (mapN.y * sc) + n * mapN.z);
    }
`;
  const photo = (() => {
    const loader = new THREE.TextureLoader(), cache = {};
    return name => {
      if (cache[name]) return cache[name];
      const set = { avg: new THREE.Vector3(0.5, 0.5, 0.5), avgR: { value: 0.6 } };
      const ld = (suf, srgb) => loader.load(`assets/tex/${name}_${suf}.jpg`, t => {
        if (suf === 'diff' || suf === 'rough') { // average colour, so the photo only redistributes light and shade
          const c = document.createElement('canvas'); c.width = c.height = 16; const g = c.getContext('2d'); g.drawImage(t.image, 0, 0, 16, 16);
          const d = g.getImageData(0, 0, 16, 16).data; let r = 0, gg = 0, b = 0;
          for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
          const toLin = v => Math.pow(v / 256 / 255, 2.2);
          if (suf === 'diff') set.avg.set(toLin(r), toLin(gg), toLin(b)); else set.avgR.value = gg / 256 / 255;
        }
      });
      for (const [k, suf, srgb] of [['diff', 'diff', true], ['nor', 'nor', false], ['rough', 'rough', false]].filter(m => !NO_ROUGH.has(name) || m[0] !== 'rough')) {
        const t = ld(suf, srgb); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.encoding = THREE.sRGBEncoding; set[k] = t;
      }
      return (cache[name] = set);
    };
  })();
  function photoDetail(mat, name, { scale = 4, tint = 0.5, lum = false, normal = 1, key = '' } = {}) {
    const P = photo(name), prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
    mat.onBeforeCompile = (sh, r) => {
      if (prev) prev.call(mat, sh, r);
      Object.assign(sh.uniforms, { pDiff: { value: P.diff }, pNor: { value: P.nor }, pRough: { value: P.rough }, pAvg: { value: P.avg }, pAvgR: P.avgR });
      if (!sh.vertexShader.includes('varying vec3 vWPos;')) sh.vertexShader = 'varying vec3 vWPos;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 wpD = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wpD = instanceMatrix * wpD;
        #endif
        vWPos = (modelMatrix * wpD).xyz;`);
      if (!sh.fragmentShader.includes('varying vec3 vWPos;')) sh.fragmentShader = 'varying vec3 vWPos;\n' + sh.fragmentShader;
      sh.fragmentShader = 'uniform sampler2D pDiff; uniform sampler2D pNor; uniform sampler2D pRough; uniform vec3 pAvg; uniform float pAvgR;\n' + sh.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec2 pUV = vWPos.xz / ${scale.toFixed(2)};
          vec3 pCol = texture2D(pDiff, pUV).rgb, pRel = pCol / max(pAvg, vec3(1e-3));
          ${lum ? 'diffuseColor.rgb *= dot(pRel, vec3(0.2126, 0.7152, 0.0722));' : `diffuseColor.rgb *= mix(vec3(dot(pRel, vec3(0.2126, 0.7152, 0.0722))), pRel, ${tint.toFixed(2)});`}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = clamp(roughnessFactor * texture2D(pRough, vWPos.xz / ${scale.toFixed(2)}).g / max(pAvgR, 0.05), 0.04, 1.0);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          { vec3 tn = texture2D(pNor, vWPos.xz / ${scale.toFixed(2)}).xyz * 2.0 - 1.0;
            vec3 wn = normalize(vec3(tn.x * ${normal.toFixed(2)}, 1.0, -tn.y * ${normal.toFixed(2)}));   // a flat, upward surface: tangent space = world xz
            vec3 vn = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
            normal = normalize(mix(normal, vn, smoothstep(0.6, 0.9, abs(dot(normal, (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz))))); }`);
    };
    mat.customProgramCacheKey = () => prevKey + '|photo:' + name + scale + tint + lum + normal + key;
    return mat;
  }

  // Asphalt: dark aggregate with lighter stones, a polished, darker band where the wheels run, worn paint
  const asphalt = (g, w, h, tracks = []) => {
    g.fillStyle = '#4c4c4f'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < w * h * 0.12; i++) { const v = 62 + rand() * 26 | 0; g.fillStyle = `rgb(${v},${v},${v + 2})`; g.fillRect(rand() * w, rand() * h, 1, 1); }
    for (const [u, half] of tracks) { const gr = g.createLinearGradient(u - half, 0, u + half, 0); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.5, 'rgba(15,15,18,0.22)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(u - half, 0, half * 2, h); }
  };
  const line = (g, x, y, w, h, color) => {
    g.fillStyle = color; g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(60,60,63,0.35)'; // wear
    for (let i = 0; i < w * h * 0.08; i++) g.fillRect(x + rand() * w, y + rand() * h, 1, 1 + rand() * 2);
  };
  const WHITEL = '#dcdad3', YELLOWL = '#d6a530';
  // u spans the road from -HALF to +HALF; v repeats every 8 m
  const roadTex = style => canvasTex(256, 256, (g, w, h) => {
    const px = m => (m + HALF) / (HALF * 2) * w, lw = Math.max(2, w * 0.12 / (HALF * 2));
    asphalt(g, w, h, [[px(-2.4), w * 0.06], [px(-4.4), w * 0.05], [px(2.4), w * 0.06], [px(4.4), w * 0.05]]);
    if (style === 'art' || style === 'hwy') {
      line(g, px(-3.75), 0, lw, h, WHITEL); line(g, px(3.75) - lw, 0, lw, h, WHITEL);
      line(g, px(-0.14) - lw / 2, 0, lw, h, YELLOWL); line(g, px(0.14) - lw / 2, 0, lw, h, YELLOWL);
    } else if (style === 'rural') {
      line(g, px(-3.7), 0, lw, h, WHITEL); line(g, px(3.7) - lw, 0, lw, h, WHITEL);
      line(g, px(0) - lw / 2, 0, lw, h * 0.4, YELLOWL);
    } else {
      // gutter: a lighter concrete edge strip along each kerb
      g.fillStyle = 'rgba(120,118,112,0.55)'; g.fillRect(0, 0, w * 0.04, h); g.fillRect(w * 0.96, 0, w * 0.04, h);
    }
  }, true);
  // Freeway: u spans 24.8 m across both carriageways, v repeats every 12 m (3 m dashes)
  const fwyTex = canvasTex(512, 256, (g, w, h) => {
    const px = m => (m + FW) / (2 * FW) * w, lw = 3;
    asphalt(g, w, h, [-7.6, -3.9, 3.9, 7.6].map(m => [px(m), w * 0.025]));
    g.fillStyle = '#6f6d69'; g.fillRect(px(-2), 0, px(2) - px(-2), h);
    line(g, px(-2.1) - lw / 2, 0, lw, h, YELLOWL); line(g, px(2.1) - lw / 2, 0, lw, h, YELLOWL);
    for (const sg of [-1, 1]) { line(g, px(sg * 9.45) - lw / 2, 0, lw, h, WHITEL); line(g, px(sg * 5.75) - lw / 2, 0, lw, h * 0.25, WHITEL); }
  }, true);
  const rampTex = canvasTex(128, 128, (g, w, h) => {
    asphalt(g, w, h, [[w * 0.35, w * 0.08], [w * 0.65, w * 0.08]]);
    line(g, w * 0.12, 0, 2, h, YELLOWL); line(g, w * 0.88 - 2, 0, 2, h, WHITEL);
  }, true);
  const roadMat = map => photoDetail(worldDetail(new THREE.MeshStandardMaterial({ map, color: WINTER ? '#cfd4d9' : '#ffffff', roughness: WINTER ? 0.7 : 0.88, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    { fine: 1 / 1.7, mid: 1 / 19, big: 1 / 90, aFine: 0.03, aMid: 0.12, aBig: 0.12 }), 'aerial_asphalt_01', { scale: 7, lum: true, normal: 0.8 });
  // Pavement slabs: 2 m along the street (v), joints darker, each slab a slightly different shade
  const slabTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#8f8b84'; g.fillRect(0, 0, w, h);
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const v = 136 + rand() * 22 | 0; g.fillStyle = `rgb(${v},${v - 3},${v - 9})`; g.fillRect(i * w / 2, j * h / 2, w / 2, h / 2); }
    for (let i = 0; i < w * h * 0.08; i++) { const v = 130 + rand() * 70 | 0; g.fillStyle = `rgba(${v},${v},${v - 6},0.5)`; g.fillRect(rand() * w, rand() * h, 1, 1); }
    g.fillStyle = '#77736c'; g.fillRect(0, 0, w, 2); g.fillRect(0, h / 2, w, 2); g.fillRect(0, 0, 2, h); g.fillRect(w / 2, 0, 2, h);
  }, true);
  slabTex.repeat.set(2, 1);
  const mats = {
    art: roadMat(roadTex('art')), res: roadMat(roadTex('res')), rural: roadMat(roadTex('rural')), hwy: roadMat(roadTex('hwy')),
    fwy: roadMat(fwyTex), ramp: roadMat(rampTex),
    patch: roadMat(canvasTex(256, 256, (g, w, h) => asphalt(g, w, h), true)),
    paint: new THREE.MeshStandardMaterial({ color: '#d8d6cf', roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -4 }),
    concrete: photoDetail(worldDetail(new THREE.MeshStandardMaterial({ color: WINTER ? '#e1e6ea' : '#b9b4ab', roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -3 }),
      { fine: 1 / 1.3, mid: 1 / 11, big: 1 / 70, aFine: 0.02, aMid: 0.08, aBig: 0.1 }), 'concrete_pavement', { scale: 3.2, tint: 0.6, normal: 1 }),
    // the paving under town junctions: drawn with no depth pull, so the asphalt pad and road ends always cover it
    concreteBase: photoDetail(worldDetail(new THREE.MeshStandardMaterial({ color: WINTER ? '#e1e6ea' : '#b9b4ab', roughness: 0.9 }),
      { fine: 1 / 1.3, mid: 1 / 11, big: 1 / 70, aFine: 0.02, aMid: 0.08, aBig: 0.1 }), 'concrete_pavement', { scale: 3.2, tint: 0.6, normal: 1, key: 'base' }),
    wall: worldDetail(new THREE.MeshStandardMaterial({ color: '#a8a199', roughness: 0.9, side: THREE.DoubleSide }), { aMid: 0.1, aBig: 0.15 }),
  };
  mats.patch.map.repeat.set(0.25, 0.25);

  /* ================= Terrain mesh ================= */
  // Colour comes from the vertices (grass, fields, forest floor, rock, snow, river banks, cut slopes);
  // a grey detail texture breaks it up up close.
  const C3 = hex => new THREE.Color(hex);
  const TC = {
    grassA: C3('#4b6a33'), grassB: C3('#5e7d3c'), dry: C3('#7d7f4a'), forest: C3('#33482a'), rock: C3('#77706a'), rockDark: C3('#59524c'),
    snow: C3('#e6eaee'), snowGround: C3('#e3e9ee'), ice: C3('#b9c9d4'), sand: C3('#a8977a'), cut: C3('#8a765c'), town: C3('#5f7c40'),
    fields: ['#9c9150', '#6f8c3c', '#7a6446', '#86a04c', '#a8a060', '#5f7d36', '#738f40'].map(C3),
  };
  const penDAt = (x, z) => aPenD[aIdx({ x, z })];
  function forestAt(x, z, h) {
    if (penDAt(x, z) > 3) return 0;
    const n = fbm(x / 640 + 3.7, z / 640 - 8.2, 3);
    let f = smoothstep(-0.02, 0.22, n) * (0.25 + 0.75 * smoothstep(28, 70, h)) + 0.55 * smoothstep(110, 150, h) * smoothstep(-0.3, -0.02, n);
    f *= 1 - smoothstep(205, 245, h); // tree line
    if (Math.abs(riverSide(x, z)) < 130) f = Math.max(f, 0.45 * smoothstep(130, 70, Math.abs(riverSide(x, z))) * smoothstep(-0.2, 0.2, n + 0.3));
    return clamp(f * (penDAt(x, z) > 0 ? 0.3 : 1), 0, 1);
  }
  function farmAt(x, z, h) {
    if (penDAt(x, z) > 0 || h > 75) return 0;
    return smoothstep(-0.05, 0.15, fbm(x / 900 - 5, z / 900 + 3, 2) + 0.1);
  }
  const fieldColor = (x, z) => {
    const u = x * 0.906 + z * 0.423, v = -x * 0.423 + z * 0.906, i = Math.floor(u / 170), j = Math.floor(v / 115);
    return TC.fields[(perm[(perm[i & 255] + j) & 255]) % TC.fields.length];
  };
  const tmpC = new THREE.Color();
  function terrainColor(x, z, h, ny, nat, carved) {
    const c = tmpC.copy(TC.grassA).lerp(TC.grassB, 0.5 + 0.5 * noise(x / 90, z / 90));
    c.lerp(TC.dry, 0.18 * smoothstep(0.1, 0.5, noise(x / 400 + 9, z / 400)));
    if (penDAt(x, z) > 3) c.lerp(TC.town, 0.4);
    const farm = farmAt(x, z, h);
    if (farm > 0 && ny > 0.97) c.lerp(fieldColor(x, z), farm * 0.7);
    const f = forestAt(x, z, h);
    if (f > 0) c.lerp(TC.forest, smoothstep(0.05, 0.6, f) * 0.85);
    const slope = 1 - ny;
    const rk = carved ? 0.15 : 1; // road cuttings and embankments are seeded grass, not bare rock
    c.lerp(TC.rock, smoothstep(0.18, 0.42, slope) * rk).lerp(TC.rockDark, smoothstep(0.45, 0.7, slope) * 0.7 * rk);
    if (h > 240) c.lerp(TC.snow, smoothstep(265, 310, h + 30 * noise(x / 120, z / 120)) * smoothstep(0.55, 0.25, slope));
    const rd = Math.abs(riverSide(x, z));
    if (rd < 75 && h < WATER + 4) c.lerp(TC.sand, smoothstep(75, 40, rd) * smoothstep(WATER + 4, WATER + 1, h));
    if (carved) c.lerp(TC.cut, 0.3 * smoothstep(1.5, 6, Math.abs(h - nat))); // embankments are mostly grassed over
    if (WINTER) {
      // snow lies on anything flat enough to hold it; woods and windswept patches show through a little
      const cover = smoothstep(0.5, 0.2, slope) * (0.86 + 0.14 * noise(x / 23, z / 23)) * (1 - 0.3 * smoothstep(0.2, 0.8, f)) * (0.9 + 0.1 * smoothstep(-0.3, 0.3, noise(x / 160 + 3, z / 160)));
      c.lerp(TC.snowGround, clamp(cover, 0, 1));
      if (rd < 75 && h < WATER + 1.5) c.lerp(TC.ice, 0.5);
    }
    return c;
  }
  // Grass: blades and clumps in grey (the vertex colour supplies the hue), tiled every 5 m, plus world-space
  // blotches so lawns and fields never show a repeat
  const grassTex = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#c8c8c8'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26000; i++) {
      const x = rand() * w, y = rand() * h, v = 150 + rand() * 105 | 0, t = rand() * 0.5 - 0.25;
      g.strokeStyle = `rgba(${v},${v + (rand() * 16 - 8 | 0)},${v - 20},0.55)`; g.lineWidth = 1 + rand();
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + t * 6, y - 3 - rand() * 5); g.stroke();
    }
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(${90 + rand() * 40 | 0},${80 + rand() * 30 | 0},50,0.18)`; g.beginPath(); g.arc(rand() * w, rand() * h, 1 + rand() * 3, 0, TAU); g.fill(); }
  }, true);
  grassTex.repeat.set(24 / 5, 24 / 5);
  const terrMat = photoDetail(worldDetail(new THREE.MeshStandardMaterial({ vertexColors: true, color: new THREE.Color(0.62, 0.7, 0.55), roughness: 1 }),
    { fine: 1 / 1.9, mid: 1 / 17, big: 1 / 160, aFine: 0.03, aMid: 0.14, aBig: 0.16 }), 'aerial_grass_rock', { scale: 6, tint: 0.35, normal: 1.2 });
  // Distant terrain: coarse tiles, pushed underground wherever the fine chunks are drawn
  const focus = { value: new THREE.Vector2(1e9, 1e9) }, HI_R = 560;
  const loMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
  loMat.onBeforeCompile = sh => {
    sh.uniforms.uFocus = focus;
    sh.vertexShader = 'uniform vec2 uFocus;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      `#include <begin_vertex>\n transformed.y -= 40.0 * (1.0 - smoothstep(${HI_R.toFixed(1)}, ${(HI_R + 80).toFixed(1)}, distance(position.xz, uFocus)));`);
  };
  function terrainMesh(x0, z0, size, res, fine) {
    const n = Math.round(size / res) + 1, m = n + 2, hs = new Float32Array(m * m);
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      const x = x0 + (i - 1) * res, z = z0 + (j - 1) * res;
      hs[j * m + i] = fine ? Hvis[clamp(Math.round((z + EXT) / CELL), 0, GN - 1) * GN + clamp(Math.round((x + EXT) / CELL), 0, GN - 1)] : groundAt(x, z);
    }
    const pos = new Float32Array(n * n * 3), nrm = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const v = j * n + i, x = x0 + i * res, z = z0 + j * res, h = hs[(j + 1) * m + i + 1];
      const gx = hs[(j + 1) * m + i + 2] - hs[(j + 1) * m + i], gz = hs[(j + 2) * m + i + 1] - hs[j * m + i + 1];
      const l = Math.hypot(gx, 2 * res, gz), ny = 2 * res / l;
      pos[v * 3] = x; pos[v * 3 + 1] = h; pos[v * 3 + 2] = z;
      nrm[v * 3] = -gx / l; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = -gz / l;
      uv[v * 2] = x / 24; uv[v * 2 + 1] = z / 24;
      let nat = h, carved = false;
      if (fine) { const c = clamp(Math.round((z + EXT) / CELL), 0, GN - 1) * GN + clamp(Math.round((x + EXT) / CELL), 0, GN - 1); nat = Hn[c]; carved = cDist[c] < cEmb[c]; }
      const c = terrainColor(x, z, h, ny, nat, carved);
      col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
    }
    const idx = new (n * n > 65535 ? Uint32Array : Uint16Array)((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1)); g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, fine ? terrMat : loMat); mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    return mesh;
  }
  const LO = 1024; // big tiles: few draw calls for the far terrain
  for (let x0 = -VIEW; x0 < VIEW; x0 += LO) for (let z0 = -VIEW; z0 < VIEW; z0 += LO) terrainMesh(x0, z0, LO, 16, false);
  const TCH = 256, NCH = 2 * EXT / TCH, hiChunks = new Map();
  function updateTerrain(cx, cz, budget) {
    const R = HI_R + 120, need = [];
    for (let i = 0; i < NCH; i++) for (let j = 0; j < NCH; j++) {
      const x0 = -EXT + i * TCH, z0 = -EXT + j * TCH;
      const dx = Math.max(x0 - cx, 0, cx - x0 - TCH), dz = Math.max(z0 - cz, 0, cz - z0 - TCH);
      if (dx * dx + dz * dz < R * R) need.push([i, j]);
    }
    let missing = 0;
    for (const [i, j] of need) {
      const k = i * 100 + j;
      if (hiChunks.has(k)) continue;
      if (budget-- > 0) hiChunks.set(k, terrainMesh(-EXT + i * TCH, -EXT + j * TCH, TCH, CELL, true)); else missing++;
    }
    if (!missing) focus.value.set(cx, cz);
    for (const [k, m] of hiChunks) {
      const x0 = -EXT + Math.floor(k / 100) * TCH + TCH / 2, z0 = -EXT + (k % 100) * TCH + TCH / 2;
      if (Math.hypot(x0 - cx, z0 - cz) > HI_R + 900) { scene.remove(m); m.geometry.dispose(); hiChunks.delete(k); }
    }
  }
  // Water: a dark, glossy surface; two scrolling ripple normal maps catch the sky
  const ripple = (() => {
    const N = 256, hgt = tileNoise(N, 16, 3);
    return dataTex(N, N, d => {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const hx = hgt[y * N + (x + 1) % N] - hgt[y * N + (x + N - 1) % N], hy = hgt[((y + 1) % N) * N + x] - hgt[((y + N - 1) % N) * N + x];
        const nx = -hx * 6, ny = -hy * 6, l = Math.hypot(nx, ny, 1), i = (y * N + x) * 4;
        d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
      }
    });
  })();
  ripple.repeat.set(2 * VIEW / 22, 2 * VIEW / 22);
  const waterMat = new THREE.MeshStandardMaterial({ color: '#16303a', roughness: 0.06, metalness: 0.1, normalMap: ripple, normalScale: new THREE.Vector2(0.35, 0.35), transparent: true, opacity: 0.94 });
  if (WINTER) { // frozen over: pale, matte, faintly crazed
    Object.assign(waterMat, { transparent: false, opacity: 1, roughness: 0.22, metalness: 0.02 }); waterMat.color.set('#a9c4d3'); waterMat.normalScale.set(0.08, 0.08);
  }
  const water = new THREE.Mesh(new THREE.PlaneGeometry(2 * VIEW, 2 * VIEW), waterMat);
  water.rotation.x = -Math.PI / 2; water.position.y = WATER; scene.add(water);
  lap('terrain mesh');

  /* ================= Geometry buckets ================= */
  const bucket = () => ({ pos: [], uv: [], nrm: [], idx: [], base: 0 });
  // Strip between two offsets (numbers or per-point functions) along framed points; y follows the points plus `dy`
  function strip(fr, o0, o1, dy, vLen, out, flip = false) {
    let s = 0;
    for (let i = 0; i < fr.length; i++) {
      if (i) s += Math.hypot(fr[i].x - fr[i - 1].x, fr[i].z - fr[i - 1].z);
      const f = fr[i], y = (f.y || 0) + dy, a = typeof o0 === 'function' ? o0(i) : o0, b = typeof o1 === 'function' ? o1(i) : o1;
      out.pos.push(f.x + f.rx * a, y, f.z + f.rz * a, f.x + f.rx * b, y, f.z + f.rz * b);
      out.uv.push(0, s / vLen, 1, s / vLen);
      const ny = flip ? -1 : 1; out.nrm.push(0, ny, 0, 0, ny, 0);
      if (i) { const k = out.base + (i - 1) * 2; if (flip) out.idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); else out.idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    out.base += fr.length * 2;
  }
  // Vertical face along an offset, from y + top down to y + bottom
  function skirt(fr, off, top, bottom, out, nSign) {
    for (let i = 0; i < fr.length - 1; i++) {
      const a = fr[i], b = fr[i + 1];
      const ax = a.x + a.rx * off, az = a.z + a.rz * off, bx = b.x + b.rx * off, bz = b.z + b.rz * off, k = out.base;
      out.pos.push(ax, a.y + top, az, bx, b.y + top, bz, ax, a.y + bottom, az, bx, b.y + bottom, bz);
      for (let q = 0; q < 4; q++) out.nrm.push(a.rx * nSign, 0, a.rz * nSign);
      out.uv.push(0, 0, 1, 0, 0, 1, 1, 1);
      out.idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
      out.base += 4;
    }
  }
  function meshFrom(bk, mat, shadow = false) {
    if (!bk.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(bk.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(bk.uv, 2));
    g.setIndex(bk.idx); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat); m.receiveShadow = true; m.castShadow = shadow; scene.add(m); return m;
  }
  function addGeo(bk, geo, matrix) {
    const g = geo.clone().applyMatrix4(matrix);
    const p = g.attributes.position.array, n = g.attributes.normal.array, uv = g.attributes.uv ? g.attributes.uv.array : null, count = p.length / 3;
    for (let i = 0; i < count; i++) { bk.pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]); bk.nrm.push(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]); bk.uv.push(uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0); }
    if (g.index) for (const i of g.index.array) bk.idx.push(bk.base + i); else for (let i = 0; i < count; i++) bk.idx.push(bk.base + i);
    bk.base += count;
  }
  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), E = new THREE.Euler();
  const yawTo = (dx, dz) => Math.atan2(dx, dz);

  /* ================= Instanced scenery in culled chunks ================= */
  // Everything static and repeated is queued, then built per chunk with a real bounding sphere, so the
  // renderer (and the shadow pass) can skip whole chunks; each type also has a view distance.
  const CH = 400, batches = new Map(), chunkMeshes = [];
  const FAR = { mailPost: 200, mailBox: 200, bin: 200, signFace: 260, signBack: 220, signPost: 220, slab: 300, hedge: 280, chimney: 340,
    lamp: 600, pole: 600, arm: 450, sigPole: 450, sigArm: 450, sigHead: 450, jersey: 500, pier: 1400, trunk: 380, crown: 1700, fir: 1900, barn: 1100, ware: 1600 };
  const NEAR = {}, CHUNK = {};
  const farOf = name => FAR[name] ?? (name.startsWith('tower') ? 6000 : name.startsWith('apt') ? 1700 : 900);
  function defType(name, geo, mat, { colored = false, shadow = true, receive = true } = {}) { batches.set(name, { name, geo, mat, colored, shadow, receive, items: [] }); }
  const DECOR = {}; // per-type hooks that add 3D detail (window frames, ledges) to what was just placed
  const SNOWY = new Set(['cap', 'roof', 'hip', 'hedge']), SNOWTOP = new THREE.Color('#eef2f4');
  function put(name, x, y, z, yaw, sx, sy, sz, color) { if (WINTER && color && SNOWY.has(name)) color = color.clone().lerp(SNOWTOP, 0.65); const it = { x, y, z, yaw, sx, sy, sz, color, seed: rand() }; batches.get(name).items.push(it); if (DECOR[name]) DECOR[name](it, name); return it; }
  function flush() {
    for (const [, b] of batches) {
      const byChunk = new Map();
      const ch = CHUNK[b.name] || CH;
      for (const it of b.items) { const k = Math.floor(it.x / ch) + ',' + Math.floor(it.z / ch); if (!byChunk.has(k)) byChunk.set(k, []); byChunk.get(k).push(it); }
      if (!b.geo.boundingSphere) b.geo.computeBoundingSphere();
      const gr = b.geo.boundingSphere.radius + b.geo.boundingSphere.center.length();
      for (const [key, items] of byChunk) {
        let cx = 0, cy = 0, cz = 0;
        for (const it of items) { cx += it.x; cy += it.y; cz += it.z; }
        cx /= items.length; cy /= items.length; cz /= items.length;
        let r = 0;
        for (const it of items) r = Math.max(r, Math.hypot(it.x - cx, it.y - cy, it.z - cz) + gr * Math.max(it.sx, it.sy, it.sz));
        const g = new THREE.BufferGeometry();
        for (const name in b.geo.attributes) g.setAttribute(name, b.geo.attributes[name]);
        if (b.geo.index) g.setIndex(b.geo.index);
        for (const grp of b.geo.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), r);
        const m = new THREE.InstancedMesh(g, b.mat, items.length);
        m.castShadow = b.shadow; m.receiveShadow = b.receive;
        if (b.depthMat) m.customDepthMaterial = b.depthMat;
        m.userData.far = farOf(b.name); m.userData.near = NEAR[b.name] ?? -Infinity; m.userData.sphere = g.boundingSphere;
        m.matrixAutoUpdate = false; // static: skip the per-frame matrix work
        m.userData.cs = b.shadow; m.userData.tall = HL_TYPES(b.name); m.userData.tree = b.name === 'crown' || b.name === 'fir';
        if (HL_TYPES(b.name)) { m.userData.hl = hlChunk(key); m.userData.hl.detail.push(m); }
        else if (TREE_TYPES(b.name)) { m.userData.hl = hlChunk('t' + key, TREE_DIST); m.userData.hl.detail.push(m); }
        chunkMeshes.push(m);
        if (b.colored) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(items.length * 3), 3);
        if (b.seeded) g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(Float32Array.from(items, it => it.seed), 1)); // where its window pattern starts
        items.forEach((it, i) => {
          Q.setFromEuler(E.set(0, it.yaw, 0)); V.set(it.x, it.y, it.z); S.set(it.sx, it.sy, it.sz);
          m.setMatrixAt(i, M4.compose(V, Q, S));
          if (b.colored && it.color) m.instanceColor.setXYZ(i, it.color.r, it.color.g, it.color.b);
          it.mesh = m; it.index = i;
        });
        scene.add(m);
      }
    }
  }
  const C3s = hex => new THREE.Color(hex); // instance colours, as authored

  // Building LOD: beyond HL_DIST a chunk's buildings (facades, ledges, roofs, plant) are drawn as one merged,
  // vertex-coloured mesh, with storeys and windows sketched in by the shader, instead of ~20 instanced draws
  const HL_DIST = 620;
  const FAR_TONE = { glass: 0.78, office: 0.66, ribbon: 0.62, brick: 0.8, render: 0.84, shop: 0.4, house: 0.86, ware: 0.92 };
  const FAR_WIN = { glass: 0.55, office: 0.55, ribbon: 0.65, brick: 0.4, render: 0.4, shop: 0.2, house: 0.3, ware: 0.05 };
  const HL_TYPES = name => /^(glass|office|ribbon|brick|render|shop|house|ware)[01]$/.test(name) || ['cap', 'part', 'tank', 'roof', 'hip', 'chimney'].includes(name);
  // Trees get the same treatment nearer in: past TREE_DIST a chunk's crowns and firs are one merged, indexed,
  // low-poly mesh (trunks are dropped)
  const TREE_DIST = 300, TREE_TYPES = name => name === 'crown' || name === 'fir' || name === 'trunk';
  const hlChunks = new Map();
  const hlChunk = (key, dist = HL_DIST) => { if (!hlChunks.has(key)) hlChunks.set(key, { key, dist, detail: [], mesh: null, near: true }); return hlChunks.get(key); };
  const hlMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05 });
  hlMat.onBeforeCompile = sh => {
    sh.vertexShader = 'attribute float win;\nvarying float vWin;\nvarying vec3 vWP;\nvarying vec3 vN;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vWin = win; vN = normal; vWP = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = 'varying float vWin;\nvarying vec3 vWP;\nvarying vec3 vN;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      if (vWin > 0.0 && abs(vN.y) < 0.5) {
        float along = abs(vN.x) > 0.5 ? vWP.z : vWP.x;
        float fl = step(0.3, fract(vWP.y / 3.6)) * step(0.22, fract(along / 3.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.07, 0.09), fl * vWin);
      }`);
  };
  hlMat.customProgramCacheKey = () => 'hlod';
  function buildHLOD() {
    const geoCache = new Map();
    const baseOf = b => {
      if (geoCache.has(b.name)) return geoCache.get(b.name);
      const g = b.geo.index ? b.geo.toNonIndexed() : b.geo, out = { p: g.attributes.position.array, n: g.attributes.normal.array };
      geoCache.set(b.name, out); return out;
    };
    const per = new Map(); // key -> list of [batch, item]
    for (const [, b] of batches) {
      if (!HL_TYPES(b.name)) continue;
      for (const it of b.items) {
        if (b.name === 'part' && Math.max(it.sx, it.sz) < 3 && it.sy < 3) continue; // small clutter isn't missed at 600 m
        if (!Number.isFinite(it.x + it.y + it.z + it.sx + it.sy + it.sz + it.yaw)) continue;
        const k = it.mesh.userData.hl.key; if (!per.has(k)) per.set(k, []); per.get(k).push([b, it]);
      }
    }
    const nm = new THREE.Matrix3(), pv = new THREE.Vector3(), nv = new THREE.Vector3(), col = new THREE.Color();
    for (const [k, list] of per) {
      let nv0 = 0; for (const [b] of list) nv0 += baseOf(b).p.length / 3;
      const P = new Float32Array(nv0 * 3), N = new Float32Array(nv0 * 3), C = new Float32Array(nv0 * 3), W = new Float32Array(nv0);
      let o = 0, minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const [b, it] of list) {
        const g = baseOf(b), style = b.name.replace(/[01]$/, ''), fac = FAR_TONE[style];
        Q.setFromEuler(E.set(0, it.yaw, 0)); V.set(it.x, it.y, it.z); S.set(it.sx, it.sy, it.sz); M4.compose(V, Q, S); nm.getNormalMatrix(M4);
        if (it.color) col.copy(it.color); else col.setRGB(0.6, 0.6, 0.6);
        for (let i = 0; i < g.p.length; i += 3, o++) {
          pv.set(g.p[i], g.p[i + 1], g.p[i + 2]).applyMatrix4(M4); nv.set(g.n[i], g.n[i + 1], g.n[i + 2]).applyMatrix3(nm).normalize();
          P[o * 3] = pv.x; P[o * 3 + 1] = pv.y; P[o * 3 + 2] = pv.z; N[o * 3] = nv.x; N[o * 3 + 1] = nv.y; N[o * 3 + 2] = nv.z;
          minX = Math.min(minX, pv.x); maxX = Math.max(maxX, pv.x); minY = Math.min(minY, pv.y); maxY = Math.max(maxY, pv.y); minZ = Math.min(minZ, pv.z); maxZ = Math.max(maxZ, pv.z);
          const up = nv.y > 0.5;
          let r = col.r, gg = col.g, bb = col.b, w = 0;
          if (fac !== undefined) { if (up) { r = 0.16; gg = 0.158; bb = 0.152; } else { r *= fac; gg *= fac; bb *= fac; w = FAR_WIN[style]; } }
          else if (up) { r *= 0.45; gg *= 0.45; bb *= 0.45; }
          C[o * 3] = r; C[o * 3 + 1] = gg; C[o * 3 + 2] = bb; W[o] = w;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
      g.setAttribute('color', new THREE.BufferAttribute(C, 3)); g.setAttribute('win', new THREE.BufferAttribute(W, 1));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, hlMat); m.matrixAutoUpdate = false; m.castShadow = false; m.receiveShadow = false; m.visible = false;
      scene.add(m);
      const c = hlChunks.get(k); c.mesh = m;
      c.center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
      c.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
    }
    // trees: indexed low-poly stand-ins, coloured per tree, darker underneath
    const ico = (() => { // 12-vertex icosahedron
      const t = (1 + Math.sqrt(5)) / 2, v = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
      const l = Math.hypot(1, t); for (let i = 0; i < v.length; i++) v[i] /= l;
      return { p: v, n: v.slice(), idx: [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1] };
    })();
    const cone = (() => { const g = new THREE.ConeGeometry(1, 1, 6, 1).translate(0, 0.5, 0); return { p: Array.from(g.attributes.position.array), n: Array.from(g.attributes.normal.array), idx: Array.from(g.index.array) }; })();
    const treesPer = new Map();
    for (const name of ['crown', 'fir']) {
      const b = batches.get(name), tpl = name === 'crown' ? ico : cone;
      for (const it of b.items) { const k = it.mesh.userData.hl.key; if (!treesPer.has(k)) treesPer.set(k, []); treesPer.get(k).push([tpl, it]); }
    }
    for (const [k, list] of treesPer) {
      let nv0 = 0, ni0 = 0; for (const [t] of list) { nv0 += t.p.length / 3; ni0 += t.idx.length; }
      const P = new Float32Array(nv0 * 3), N = new Float32Array(nv0 * 3), C = new Float32Array(nv0 * 3), I = new Uint32Array(ni0), W = new Float32Array(nv0);
      let o = 0, oi = 0, minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const [t, it] of list) {
        const base = o, c = (it.color ? col.copy(it.color) : col.setRGB(1, 1, 1)).multiply(t === ico ? LEAF_AVG : FIR_AVG), cs = Math.cos(it.yaw), sn = Math.sin(it.yaw);
        for (let i = 0; i < t.p.length; i += 3, o++) {
          const lx = t.p[i] * it.sx, ly = t.p[i + 1] * it.sy, lz = t.p[i + 2] * it.sz;
          const x = it.x + lx * cs + lz * sn, y = it.y + ly, z = it.z - lx * sn + lz * cs;
          P[o * 3] = x; P[o * 3 + 1] = y; P[o * 3 + 2] = z;
          N[o * 3] = t.n[i] * cs + t.n[i + 2] * sn; N[o * 3 + 1] = t.n[i + 1]; N[o * 3 + 2] = -t.n[i] * sn + t.n[i + 2] * cs;
          const ao = 0.55 + 0.35 * clamp(t.p[i + 1] * 0.5 + 0.5, 0, 1);
          C[o * 3] = c.r * ao; C[o * 3 + 1] = c.g * ao; C[o * 3 + 2] = c.b * ao;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        }
        for (const j of t.idx) I[oi++] = base + j;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
      g.setAttribute('color', new THREE.BufferAttribute(C, 3)); g.setAttribute('win', new THREE.BufferAttribute(W, 1));
      g.setIndex(new THREE.BufferAttribute(I, 1)); g.computeBoundingSphere();
      const m = new THREE.Mesh(g, hlMat); m.matrixAutoUpdate = false; m.visible = false; scene.add(m);
      const c = hlChunks.get(k); c.mesh = m;
      c.center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
      c.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
    }
    for (const c of hlChunks.values()) if (!c.center) { c.center = c.detail[0].userData.sphere.center; c.radius = c.detail[0].userData.sphere.radius; }
  }

  /* ================= Roads ================= */
  const B = { art: bucket(), res: bucket(), rural: bucket(), hwy: bucket(), ramp: bucket(), walk: bucket(), walkBase: bucket(), patch: bucket(), paint: bucket(), fwy: bucket(), wall: bucket() };
  const ROAD_BUCKET = { art: 'art', dt: 'art', res: 'res', ind: 'res', rural: 'rural', hwy: 'hwy', ramp: 'ramp' };
  const legDir = (r, n) => { const p = r.pts, a = r.a === n ? p[0] : p[p.length - 1], b = r.a === n ? p[Math.min(3, p.length - 1)] : p[Math.max(0, p.length - 4)]; return norm(b.x - a.x, b.z - a.z); };
  // Trim a framed line to the part outside radius ra of a and rb of b, with an exact point on each cut
  function trimExact(fr, a, b, ra, rb) {
    const ok = f => Math.hypot(f.x - a.x, f.z - a.z) >= ra && Math.hypot(f.x - b.x, f.z - b.z) >= rb;
    const mix = (p, q, t) => ({ ...q, x: lerp(p.x, q.x, t), z: lerp(p.z, q.z, t), y: lerp(p.y, q.y, t) });
    const out = [];
    for (let i = 0; i < fr.length; i++) {
      const f = fr[i], inside = ok(f);
      if (i > 0 && inside !== ok(fr[i - 1])) {
        let lo = 0, hi = 1;
        for (let k = 0; k < 18; k++) { const m = (lo + hi) / 2; if (ok(mix(fr[i - 1], f, m)) === inside) hi = m; else lo = m; }
        out.push(mix(fr[i - 1], f, inside ? hi : lo));
      }
      if (inside) out.push(f);
    }
    return out;
  }
  for (const r of roads) {
    const fr = frames(r.pts), hw = hwOf(r.kind);
    const tA = isJunction(r.a) ? PATCH - 1 : 0, tB = isJunction(r.b) ? PATCH - 1 : 0; // a metre into the pad
    const keep = trimExact(fr, r.a, r.b, tA, tB);
    if (keep.length > 1) strip(keep, -hw, hw, 0.05, 8, B[ROAD_BUCKET[r.kind]]);
    if (hasWalk(r)) for (const sg of [1, -1]) {
      const side = trimExact(fr, r.a, r.b, PATCH - 0.5, PATCH - 0.5), inner = fullWalk(r) ? hw : 6.2;
      const outer = fullWalk(r) ? 10.6 : 8;
      if (side.length > 1) { strip(side, sg > 0 ? inner : -outer, sg > 0 ? outer : -inner, 0.15, 2, B.walk); skirt(side, sg * inner, 0.15, 0, B.walk, -sg); }
    }
  }
  // Junction pads for any number of legs at any angles: each leg's mouth, joined corner to corner by a curb curve
  for (const n of nodes) {
    if (!isJunction(n) || !n.roads.length) continue;
    const legs = n.roads.map(r => { const d = legDir(r, n); return { d, hw: hwOf(r.kind) + 0.2, a: Math.atan2(d.z, d.x) }; });
    if (n.fwyEnd) for (const L of n.out.concat(n.in)) if (L.kind === 'fwy') {
      const p = L.lanes[0].pts, q = L.from === n ? p[Math.min(3, p.length - 1)] : p[Math.max(0, p.length - 4)], d = norm(q.x - n.x, q.z - n.z);
      if (!legs.some(l => l.d.x * d.x + l.d.z * d.z > 0.95)) legs.push({ d, hw: HALF + 0.3, a: Math.atan2(d.z, d.x) });
    }
    legs.sort((p, q) => p.a - q.a);
    const pts = [], at = (l, sd) => ({ x: l.d.x * PATCH - l.d.z * l.hw * sd, z: l.d.z * PATCH + l.d.x * l.hw * sd });
    for (let i = 0; i < legs.length; i++) {
      const L1 = legs[i], L2 = legs[(i + 1) % legs.length], A = at(L1, -1), Bp = at(L1, 1), C = at(L2, -1);
      pts.push(A, Bp);
      // corner from this leg's left kerb to the next leg's right kerb
      const den = L1.d.x * L2.d.z - L1.d.z * L2.d.x;
      if (legs.length > 1 && Math.abs(den) > 0.15) {
        const t = ((C.x - Bp.x) * L2.d.z - (C.z - Bp.z) * L2.d.x) / den, Qx = Bp.x + L1.d.x * t, Qz = Bp.z + L1.d.z * t;
        if (t < 0 && t > -PATCH * 1.6) for (let k = 1; k < 6; k++) { const u = k / 6, w = 1 - u; pts.push({ x: w * w * Bp.x + 2 * w * u * Qx + u * u * C.x, z: w * w * Bp.z + 2 * w * u * Qz + u * u * C.z }); }
      }
    }
    if (pts.length < 3) continue;
    const shape = new THREE.Shape(); pts.forEach((p, i) => i ? shape.lineTo(p.x, -p.z) : shape.moveTo(p.x, -p.z));
    addGeo(B.patch, new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2), M4.makeTranslation(n.x, n.y + 0.055, n.z));
    if (n.roads.some(hasWalk)) { // pavement round the corners, out to the back of the sidewalks
      if (!n.roads.some(fullWalk)) continue; // only town junctions are paved corner to corner; suburban corners stay verge
      // a disc that follows the ground (and so the road heights) 3 cm under the asphalt, never a flat slab that a
      // sloping street could dip below
      const R = PATCH + 10.6, NR = 11, NA = 32, pos = [], uv = [], nrm = [], idx = [];
      for (let ri = 0; ri <= NR; ri++) for (let ai = 0; ai < NA; ai++) {
        const rr = R * ri / NR, a = ai / NA * TAU, x = n.x + Math.cos(a) * rr, z = n.z + Math.sin(a) * rr;
        pos.push(x, groundAt(x, z) - 0.03, z); uv.push(x, z); nrm.push(0, 1, 0);
      }
      for (let ri = 0; ri < NR; ri++) for (let ai = 0; ai < NA; ai++) {
        const a = ri * NA + ai, b = ri * NA + (ai + 1) % NA, c = a + NA, d = b + NA;
        idx.push(a, b, c, b, d, c);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); g.setIndex(idx);
      addGeo(B.walkBase, g, M4.identity());
    }
  }
  // Stop lines and crosswalks
  for (const L of links) {
    const lane = L.lanes[0];
    if (lane.control === 'none' || L.kind === 'fwy') continue;
    const e = lane.pts[lane.pts.length - 1], d = lane.dir;
    addGeo(B.paint, new THREE.PlaneGeometry(3.4, 0.45).rotateX(-Math.PI / 2).rotateY(yawTo(d.x, d.z)), M4.makeTranslation(e.x + d.x * 0.3, e.y + 0.07, e.z + d.z * 0.3));
    if (lane.control === 'signal' && L.kind !== 'ramp' && L.road.zone) {
      const r = { x: -d.z, z: d.x }, cx = e.x + d.x * 2.4 - r.x * LANE, cz = e.z + d.z * 2.4 - r.z * LANE;
      for (let k = -3.5; k <= 3.5; k += 1) addGeo(B.paint, new THREE.PlaneGeometry(0.5, 2.6).rotateX(-Math.PI / 2).rotateY(yawTo(d.x, d.z)), M4.makeTranslation(cx + r.x * k, e.y + 0.07, cz + r.z * k));
    }
  }
  // Freeway: full width between the tapers, narrowing to a two-lane road at each end
  const fFr = fpts.map(p => ({ x: p.x, z: p.z, y: p.y, tx: p.tx, tz: p.tz, rx: -p.tz, rz: p.tx }));
  strip(fFr.slice(TAPER, NF - TAPER), -FW, FW, 0.05, 12, B.fwy);
  for (const [a, b] of [[0, TAPER + 1], [NF - TAPER - 1, NF]]) {
    const part = fFr.slice(a, b), hw = i => -lerp(HALF + 0.3, FW, smoothstep(0, TAPER, Math.min(a + i, NF - 1 - a - i)));
    strip(part, hw, i => -hw(i), 0.05, 8, B.ramp);
  }
  for (const L of fwyLinks) if (L.accel) strip(frames(L.accel.pts), -LW / 2 - 0.2, LW / 2 + 0.2, 0.06, 8, B.ramp);

  /* ================= Scenery types ================= */
  const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const box1 = (() => { const g = boxGeo.clone(); g.clearGroups(); return g; })();
  // Facades: textures tiled in metres (bay width x storey height). Each face is fitted with a whole number of
  // bays and storeys, and each building starts somewhere different in the tile so neighbours don't match.
  // Two textures per style: colour, and a mask whose R says "take the building's tint", G roughness, B metalness.
  // Tops are drawn as a gravel/membrane roof; the bottom metre of every wall is darkened (ambient occlusion).
  // walls take a photographed material (tiled in metres along each face), flat tops are gravel
  const WALL_PHOTO = { brick: ['red_brick_03', 1.5, 0.55, 1.0], render: ['beige_wall_001', 2.6, 0.0, 0.8], house: ['exterior_wall_cladding_03', 2.2, 0.0, 1.0],
    office: ['concrete_wall_008', 3.0, 0.15, 0.8], ribbon: ['concrete_wall_008', 3.0, 0.15, 0.8], ware: ['corrugated_iron_02', 2.4, 0.3, 1.0], shop: ['concrete_wall_008', 3.0, 0.1, 0.6] };
  function facadeType(name, { bay, floor, bays = 8, floors = 8, C = 64, far, cell }) {
    for (const variant of [0, 1]) {
      const W = bays * C, Hh = floors * C;
      const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = Hh; return c; };
      const cA = mk(), cM = mk(), gA = cA.getContext('2d'), gM = cM.getContext('2d');
      // painter: rect in albedo and mask at once. tint 0..1, rough 0..1, metal 0..1
      const P = (x, y, w, h, color, tint, rough, metal) => {
        gA.fillStyle = color; gA.fillRect(x, y, w, h);
        gM.fillStyle = `rgb(${tint * 255 | 0},${rough * 255 | 0},${metal * 255 | 0})`; gM.fillRect(x, y, w, h);
      };
      P(0, 0, W, Hh, '#ffffff', 1, 0.9, 0);
      for (let b = 0; b < bays; b++) for (let f = 0; f < floors; f++) cell(P, gA, b * C, (floors - 1 - f) * C, C, b, f, variant);
      const tA = new THREE.CanvasTexture(cA), tM = new THREE.CanvasTexture(cM);
      tA.encoding = THREE.sRGBEncoding;
      for (const t of [tA, tM]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; }
      const m = new THREE.MeshStandardMaterial({ map: tA, roughnessMap: tM, metalnessMap: tM, roughness: 1, metalness: 1 });
      const wp = WALL_PHOTO[name], WP = wp ? photo(wp[0]) : null, GR = photo('gravel');
      m.onBeforeCompile = sh => {
        Object.assign(sh.uniforms, { gDiff: { value: GR.diff }, gNor: { value: GR.nor }, gAvg: { value: GR.avg } });
        if (WP) Object.assign(sh.uniforms, { wDiff: { value: WP.diff }, wNor: { value: WP.nor }, wAvg: { value: WP.avg } });
        sh.vertexShader = 'attribute float iSeed;\nvarying float vTop; varying float vH; varying vec2 vFace; varying vec3 vWP; varying vec3 vViewT; varying float vInst;\n' + sh.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
          vTop = 0.0; vH = 10.0; vFace = uv; vWP = position; vViewT = vec3(0.0, 0.0, 1.0); vInst = 0.0;
          #ifdef USE_INSTANCING
            vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
            float fw = abs(normal.x) > 0.5 ? sc.z : sc.x;
            float nb = max(1.0, floor(fw / ${bay.toFixed(2)} + 0.5)), nf = max(1.0, floor(sc.y / ${floor.toFixed(2)} + 0.5));
            float hh = iSeed;
            vec2 start = floor(vec2(hh, fract(hh * 7.13)) * vec2(${bays}.0, ${floors}.0));
            vUv = (uv * vec2(nb, nf) + start) / vec2(${bays}.0, ${floors}.0);
            vTop = abs(normal.y) > 0.5 ? 1.0 : 0.0;
            vH = position.y * sc.y;
            vFace = uv * vec2(fw, sc.y) + vec2(hh * 13.0, fract(hh * 3.7) * 5.0);   // metres along the face, shifted per building
            vWP = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
            vInst = hh;
            if (vTop < 0.5) { // the view direction in the face's own frame: x along the face (as u runs), y up, z out
              mat3 im3 = mat3(modelMatrix) * mat3(instanceMatrix);
              vec3 wN = normalize(im3 * normal), wT = normalize(im3 * cross(vec3(0.0, 1.0, 0.0), normal)), V = cameraPosition - vWP;
              vViewT = vec3(dot(V, wT), V.y, dot(V, wN));
            }
          #endif`);
        const TILE = `vec2(${(bay * bays).toFixed(3)}, ${(floor * floors).toFixed(3)})`, CELLS = `vec2(${bays}.0, ${floors}.0)`;
        sh.fragmentShader = 'varying float vTop; varying float vH; varying vec2 vFace; varying vec3 vWP; varying vec3 vViewT; varying float vInst;\nuniform sampler2D gDiff; uniform sampler2D gNor; uniform vec3 gAvg;\n'
          + (WP ? 'uniform sampler2D wDiff; uniform sampler2D wNor; uniform vec3 wAvg;\n' : '') + PERTURB + sh.fragmentShader
          // Windows sit 18 cm back in the wall: looking through the glass at an angle shows the reveal (the wall's
          // edge, in shade) and shifts the glass with parallax
          .replace('#include <map_fragment>', `
            vec2 pUv = vUv; float revealAmt = 0.0, glassAmt = 0.0;
            vec3 vt = normalize(vViewT);
            if (vTop < 0.5) {
              glassAmt = 1.0 - smoothstep(0.1, 0.14, texture2D(roughnessMap, vUv).g);
              if (glassAmt > 0.5) {
                vec2 s2 = vUv - vt.xy / max(vt.z, 0.2) * 0.1 / ${TILE};
                if (texture2D(roughnessMap, s2).r > 0.5) revealAmt = 1.0; else pUv = s2;
              }
            }
            vec4 sampledDiffuseColor = texture2D(map, revealAmt > 0.5 ? vUv : pUv);
            if (revealAmt > 0.5) sampledDiffuseColor.rgb = vec3(0.62);
            diffuseColor *= sampledDiffuseColor;`)
          .replace('#include <color_fragment>', `
            float tintMask = revealAmt > 0.5 ? 1.0 : texture2D(roughnessMap, pUv).r;
            if (revealAmt > 0.5) glassAmt = 0.0;
            #if defined( USE_COLOR_ALPHA ) || defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
              diffuseColor.rgb *= mix(vec3(1.0), vColor, tintMask);
            #endif
            vec2 fuv = vec2(0.0); float wallAmt = 0.0;
            ${WP ? `if (vTop < 0.5) {
              fuv = vFace / ${wp[1].toFixed(2)}; wallAmt = smoothstep(0.5, 0.9, tintMask);
              vec3 pc = texture2D(wDiff, fuv).rgb / max(wAvg, vec3(1e-3)); float pl = dot(pc, vec3(0.2126, 0.7152, 0.0722));
              diffuseColor.rgb *= mix(vec3(1.0), mix(vec3(pl), pc, ${wp[2].toFixed(2)}), wallAmt);
            }` : ''}
            if (vTop > 0.5) { fuv = vWP.xz / 2.5; wallAmt = 1.0; diffuseColor.rgb = vec3(0.17, 0.165, 0.158) * texture2D(gDiff, fuv).rgb / max(gAvg, vec3(1e-3)); }
            diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(0.0, 1.4, vH));`)
          .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
            if (wallAmt > 0.0) {
              vec3 mn = (vTop > 0.5 ? texture2D(gNor, fuv).xyz : ${WP ? 'texture2D(wNor, fuv).xyz' : 'vec3(0.5, 0.5, 1.0)'}) * 2.0 - 1.0;
              normal = normalize(mix(normal, pnPerturb(-vViewPosition, normal, mn, fuv), wallAmt * ${WP ? wp[3].toFixed(2) : '1.0'}));
            }`)
          .replace('#include <roughnessmap_fragment>', `
            float roughnessFactor = roughness * texture2D(roughnessMap, pUv).g;
            if (vTop > 0.5 || revealAmt > 0.5) roughnessFactor = 0.95;`)
          .replace('#include <metalnessmap_fragment>', `
            float metalnessFactor = metalness * texture2D(metalnessMap, pUv).b;
            if (vTop > 0.5 || revealAmt > 0.5) metalnessFactor = 0.0;`)
          // Rooms behind the glass ("interior mapping"): each window cell is a room one bay wide, one storey high
          // and a bay and a half deep; the view ray is traced into it and lands on the back wall, floor, ceiling or a
          // side wall. Rooms vary in colour, some have the lights on; seen less as the glass turns into a mirror
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
            if (glassAmt > 0.5) {
              vec2 cells = pUv * ${CELLS}, cid = floor(cells), cuv = fract(cells);
              vec2 room = ${TILE} / ${CELLS}; float D = room.x * 1.5;
              vec3 rp = vec3(cuv * room, 0.0), dd = normalize(-vt);
              float tx = dd.x > 0.0 ? (room.x - rp.x) / dd.x : -rp.x / min(dd.x, -1e-4);
              float ty = dd.y > 0.0 ? (room.y - rp.y) / dd.y : -rp.y / min(dd.y, -1e-4);
              float tz = D / max(-dd.z, 1e-4), t = min(min(tx, ty), tz);
              vec3 hp = rp + dd * t;
              float rr = fract(sin(dot(cid, vec2(12.9898, 78.233)) + vInst * 917.0) * 43758.5453);
              vec3 wallC = mix(vec3(0.78, 0.74, 0.66), vec3(0.62, 0.68, 0.74), fract(rr * 7.3));
              vec3 ic = t == tz ? wallC : t == ty ? (dd.y < 0.0 ? vec3(0.32, 0.26, 0.2) : vec3(0.9, 0.9, 0.88)) : wallC * 0.72;
              ic *= 1.0 - 0.5 * (-hp.z / D);                                            // deeper is darker
              ic *= rr > 0.45 ? vec3(1.0, 0.92, 0.78) : vec3(0.28);                    // lights on, or not
              float fres = pow(1.0 - clamp(vt.z, 0.0, 1.0), 3.0);
              totalEmissiveRadiance += ic * 0.32 * (1.0 - fres);
            }`);
      };
      m.customProgramCacheKey = () => 'facade4-' + name + variant;
      m.extensions = { derivatives: true };
      defType(name + variant, box1, m, { colored: true });
      batches.get(name + variant).seeded = true;
      if (far) FAR[name + variant] = far;
    }
  }
  const pick = a => a[(rand() * a.length) | 0];
  const shade = (hex, k) => { const c = new THREE.Color(hex); c.multiplyScalar(k); return '#' + c.getHexString(); };
  // glass seen from outside: dark, with what's behind it: blinds, ceilings, the odd lit office
  const glassPane = (P, g, x, y, w, h, base, rough, metal, interior = 0.7) => {
    P(x, y, w, h, base, 0, rough, metal);
    if (rand() < interior) { // blinds part-way down
      const bh = h * (0.15 + rand() * 0.6); P(x, y, w, bh, shade(pick(['#d9d4c8', '#cfd3d6', '#bfb39b', '#9aa0a6']), 0.55), 0, 0.3, metal * 0.6);
      g.fillStyle = 'rgba(0,0,0,0.12)'; for (let k = y + 2; k < y + bh; k += 3) g.fillRect(x, k, w, 1);
    }
    if (rand() < 0.12) { g.fillStyle = 'rgba(255,240,210,0.18)'; g.fillRect(x, y, w, h); }
  };
  // Curtain wall: tinted reflective glass, thin mullions every bay, opaque spandrel at each slab
  facadeType('glass', { bay: 1.6, floor: 3.8, bays: 10, floors: 10, C: 48, far: 6000, cell: (P, g, x, y, C, b, f, v) => {
    const sp = C * 0.24;
    P(x, y, C, C, '#c9d2da', 1, 0.07, 0.85);                                   // vision glass, tinted per building
    if (rand() < 0.55) { const bh = C * (0.1 + rand() * 0.5); P(x, y + sp, C, bh, '#b9bfc4', 1, 0.12, 0.7); }
    P(x, y + C - sp, C, sp, v ? '#8e969c' : '#a4abb0', 1, 0.15, 0.9);         // spandrel
    P(x, y + C - sp - 1, C, 2, '#3e4348', 0, 0.4, 0.8); P(x, y, C, 2, '#3e4348', 0, 0.4, 0.8);
    P(x, y, 2, C, '#3e4348', 0, 0.4, 0.8);                                     // mullion
  } });
  // Concrete frame and recessed dark glass, two lights per bay
  facadeType('office', { bay: 3, floor: 3.7, bays: 8, floors: 8, far: 6000, cell: (P, g, x, y, C, b, f, v) => {
    const wx = x + C * 0.1, wy = y + C * 0.12, ww = C * 0.8, wh = C * 0.6;
    P(x, y, C, C, '#e4e2dc', 1, 0.85, 0);
    g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(x, y + C - 3, C, 3);
    glassPane(P, g, wx, wy, ww, wh, v ? '#26313b' : '#2b3540', 0.08, 0.55);
    P(wx, wy, ww, 3, '#bdbab2', 1, 0.8, 0);                                    // reveal shadow line
    P(wx + ww / 2 - 1.5, wy, 3, wh, '#6b6e72', 0, 0.4, 0.7);
    P(wx - 2, wy + wh, ww + 4, 3, '#cfccc4', 1, 0.8, 0);                       // sill
  } });
  // Ribbon windows: continuous glass bands between solid panel bands
  facadeType('ribbon', { bay: 6, floor: 3.7, bays: 4, floors: 8, far: 6000, cell: (P, g, x, y, C, b, f, v) => {
    P(x, y, C, C, '#dddad3', 1, 0.75, 0.1);
    g.fillStyle = 'rgba(0,0,0,0.05)'; for (let k = 0; k < 4; k++) g.fillRect(x + k * C / 4, y, 1, C);
    glassPane(P, g, x, y + C * 0.22, C, C * 0.46, '#28343e', 0.06, 0.65);
    for (let k = 0; k < 4; k++) P(x + k * C / 4, y + C * 0.22, 2, C * 0.46, '#4a4e53', 0, 0.4, 0.8);
    P(x, y + C * 0.68, C, 2, '#8d8b86', 0, 0.6, 0.5);
  } });
  // Brick: running bond with mortar, punched windows with stone lintels and sills, two-over-two sash
  const brickWall = (P, g, x, y, C) => {
    P(x, y, C, C, '#ffffff', 1, 0.92, 0);
    const bh = C / 16;
    for (let r = 0; r < 16; r++) for (let k = -1; k < 6; k++) {
      const bx = x + k * C / 5 + (r % 2) * C / 10, v = 205 + rand() * 50 | 0;
      g.fillStyle = `rgb(${v},${v - (rand() * 20 | 0)},${v - (rand() * 25 | 0)})`;
      g.fillRect(Math.max(x, bx), y + r * bh, Math.min(C / 5 - 1, x + C - bx), bh - 1);
    }
    g.fillStyle = 'rgba(220,214,204,0.5)'; for (let r = 0; r < 16; r++) g.fillRect(x, y + r * bh + bh - 1, C, 1);
  };
  const sash = (P, g, wx, wy, ww, wh, frame) => {
    P(wx - 2, wy - 2, ww + 4, wh + 4, frame, 0, 0.6, 0);
    glassPane(P, g, wx + 1, wy + 1, ww - 2, wh - 2, '#1e262e', 0.1, 0.35, 0.8);
    P(wx, wy + wh * 0.48, ww, 2, frame, 0, 0.6, 0); P(wx + ww / 2 - 1, wy, 2, wh, frame, 0, 0.6, 0);
  };
  facadeType('brick', { bay: 3.2, floor: 3.1, bays: 8, floors: 8, far: 1800, cell: (P, g, x, y, C, b, f, v) => {
    P(x, y, C, C, '#ffffff', 1, 0.92, 0);
    const wx = x + C * 0.3, wy = y + C * 0.2, ww = C * 0.4, wh = C * 0.52;
    P(wx - 4, wy - 6, ww + 8, 5, '#cfc8ba', 0, 0.85, 0);                       // lintel
    P(wx - 3, wy + wh + 1, ww + 6, 4, '#cfc8ba', 0, 0.85, 0);                  // sill
    sash(P, g, wx, wy, ww, wh, v ? '#ece8df' : '#3b3f44');
    if (f === 0 && b % 4 === 1) P(x, y + C - 6, C, 6, '#d9d2c2', 0, 0.85, 0); // string course
  } });
  // Render (stucco): taller windows with surrounds, some with shutters or a little balcony rail
  facadeType('render', { bay: 3.4, floor: 3.1, bays: 8, floors: 8, far: 1800, cell: (P, g, x, y, C, b, f, v) => {
    P(x, y, C, C, '#ffffff', 1, 0.95, 0);
    g.fillStyle = 'rgba(0,0,0,0.04)'; for (let i = 0; i < 40; i++) g.fillRect(x + rand() * C, y + rand() * C, 2 + rand() * 4, 1);
    const wx = x + C * 0.32, wy = y + C * 0.12, ww = C * 0.36, wh = C * 0.64;
    P(wx - 4, wy - 4, ww + 8, wh + 8, '#f4f1ea', 0, 0.85, 0);
    sash(P, g, wx, wy, ww, wh, '#ffffff');
    if (rand() < 0.25) { const sc = pick(['#3e5a48', '#5a3f34', '#3b4a5e', '#6a6a5e']); P(wx - 4 - ww * 0.48, wy, ww * 0.46, wh, sc, 0, 0.7, 0); P(wx + ww + 4, wy, ww * 0.46, wh, sc, 0, 0.7, 0); }
    else if (rand() < 0.2) { P(wx - 6, wy + wh * 0.62, ww + 12, 2, '#2c2f33', 0, 0.4, 0.8); for (let k = 0; k <= 6; k++) P(wx - 6 + k * (ww + 12) / 6, wy + wh * 0.62, 1, wh * 0.38, '#2c2f33', 0, 0.4, 0.8); }
  } });
  // Storefront: fascia with a sign, big display windows on a stall riser, a door
  const SIGNS = ['#8e2f25', '#1f4f7a', '#2f5d3a', '#c8a24a', '#222428', '#6b2d5e', '#d9d4c7', '#b2502a', '#24636b'];
  facadeType('shop', { bay: 7, floor: 4.5, bays: 6, floors: 1, C: 96, far: 900, cell: (P, g, x, y, C, b, f, v) => {
    const sc = pick(SIGNS);
    P(x, y, C, C * 0.22, sc, 0, 0.5, 0.1);                                     // fascia
    g.fillStyle = pick(['#f2efe6', '#f4d27a', '#ffffff', '#1d1d1d']);          // lettering
    const lx = x + C * (0.12 + rand() * 0.1), n = 4 + (rand() * 6 | 0);
    for (let k = 0; k < n; k++) g.fillRect(lx + k * C * 0.075, y + C * 0.07, C * 0.055, C * 0.09);
    P(x, y + C * 0.22, C, C * 0.78, '#3a3c40', 0, 0.5, 0.6);                    // frame
    glassPane(P, g, x + 4, y + C * 0.27, C - 8, C * 0.55, '#2a3a46', 0.05, 0.5, 0.4);
    g.fillStyle = 'rgba(255,236,200,0.22)'; g.fillRect(x + 4, y + C * 0.55, C - 8, C * 0.27); // lit display
    P(x, y + C * 0.82, C, C * 0.18, '#5c5852', 0, 0.8, 0);                     // stall riser
    P(x + C / 2 - 1, y + C * 0.27, 3, C * 0.55, '#3a3c40', 0, 0.5, 0.6);
    if (b % 2 === 1) { P(x + C * 0.66, y + C * 0.32, C * 0.2, C * 0.68, '#2f3134', 0, 0.5, 0.6); glassPane(P, g, x + C * 0.68, y + C * 0.35, C * 0.16, C * 0.5, '#2a3a46', 0.05, 0.5, 0); }
  } });
  // Houses: horizontal lap siding, white-framed windows with a muntin cross, the odd pair of shutters
  facadeType('house', { bay: 3.6, floor: 2.9, bays: 6, floors: 2, C: 64, far: 1000, cell: (P, g, x, y, C, b, f, v) => {
    P(x, y, C, C, '#ffffff', 1, 0.85, 0);
    if ((b + f + v) % 3 === 1) return; // blank wall
    const wx = x + C * 0.27, wy = y + C * 0.22, ww = C * 0.46, wh = C * 0.48;
    P(wx - 4, wy - 4, ww + 8, wh + 8, '#f6f4ef', 0, 0.7, 0);
    glassPane(P, g, wx, wy, ww, wh, '#1c232b', 0.08, 0.3, 0.85);
    P(wx, wy + wh / 2 - 1, ww, 2, '#f6f4ef', 0, 0.7, 0); P(wx + ww / 2 - 1, wy, 2, wh, '#f6f4ef', 0, 0.7, 0);
    if (rand() < 0.4) { const sc = pick(['#2b3a2f', '#2f3a4f', '#3a2a24', '#1d1f22']); P(wx - 4 - ww * 0.36, wy - 4, ww * 0.32, wh + 8, sc, 0, 0.7, 0); P(wx + ww + 8, wy - 4, ww * 0.32, wh + 8, sc, 0, 0.7, 0); }
  } });
  // Warehouse: vertical ribbed cladding, a strip of clerestory glazing, rust and grime near the ground
  facadeType('ware', { bay: 8, floor: 9, bays: 4, floors: 1, C: 128, far: 1600, cell: (P, g, x, y, C, b, f, v) => {
    P(x, y, C, C, '#ffffff', 1, 0.6, 0.35);
    for (let k = 0; k < C; k += 5) { g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(x + k, y, 1, C); g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(x + k + 2, y, 1, C); }
    const gr = g.createLinearGradient(0, y + C * 0.7, 0, y + C); gr.addColorStop(0, 'rgba(90,70,50,0)'); gr.addColorStop(1, 'rgba(90,70,50,0.35)'); g.fillStyle = gr; g.fillRect(x, y + C * 0.7, C, C * 0.3);
    P(x + 4, y + 8, C - 8, 10, '#3a4650', 0, 0.1, 0.6);
    for (let k = 0; k < 6; k++) P(x + 4 + k * (C - 8) / 6, y + 8, 1, 10, '#6a6e72', 0, 0.4, 0.6);
  } });
  // Plain flat-coloured parts: tower crowns and cornices (seen from afar), building details, and small things
  // ---- Facade relief: real 3D window frames, sills and headers standing out from brick, plaster and siding
  // walls, and projecting floor ledges on office towers, placed exactly where each building's painted windows are
  // (the same bay/storey fitting and per-building pattern offset as the facade shader) ----
  const winTrimGeo = (() => {
    const parts = [
      new THREE.BoxGeometry(0.08, 1.06, 0.09).translate(-0.53, 0, 0.045), new THREE.BoxGeometry(0.08, 1.06, 0.09).translate(0.53, 0, 0.045), // jambs
      new THREE.BoxGeometry(1.2, 0.1, 0.13).translate(0, 0.56, 0.065),            // header
      new THREE.BoxGeometry(1.26, 0.07, 0.18).translate(0, -0.545, 0.09),        // sill
      new THREE.BoxGeometry(0.04, 1.0, 0.035).translate(0, 0, 0.0175), new THREE.BoxGeometry(1.0, 0.04, 0.035).translate(0, 0.04, 0.0175), // glazing bars
    ];
    const pos = [], nrm = [];
    for (const g of parts) { const n = g.toNonIndexed(); pos.push(...n.attributes.position.array); nrm.push(...n.attributes.normal.array); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    return g;
  })();
  defType('winTrim', winTrimGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6 }), { colored: true, shadow: false }); FAR.winTrim = 320;
  defType('ledge', box1, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8 }), { colored: true }); FAR.ledge = 640;
  const WIN = {
    brick: { bay: 3.2, floor: 3.1, bays: 8, floors: 8, u0: 0.3, u1: 0.7, v0: 0.28, v1: 0.8, color: C3s('#ddd5c4') },
    render: { bay: 3.4, floor: 3.1, bays: 8, floors: 8, u0: 0.32, u1: 0.68, v0: 0.24, v1: 0.88, color: C3s('#f4f1ea') },
    house: { bay: 3.6, floor: 2.9, bays: 6, floors: 2, u0: 0.27, u1: 0.73, v0: 0.3, v1: 0.78, color: C3s('#f6f4ef'), skip: (b, f, v) => (b + f + v) % 3 === 1 },
  };
  const LEDGE = { office: { floor: 3.7, color: C3s('#cfcac0') }, ribbon: { floor: 3.7, color: C3s('#bdb9b2') } };
  const FACES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  function decorate(it, name) {
    const style = name.slice(0, -1), variant = +name.slice(-1), c = Math.cos(it.yaw), s = Math.sin(it.yaw);
    const W = WIN[style], LG = LEDGE[style];
    for (const [nx, nz] of FACES) {
      const fw = nx ? it.sz : it.sx, half = nx ? it.sx / 2 : it.sz / 2, tx = nz, tz = -nx; // t: the way u runs along this face
      const nwx = nx * c + nz * s, nwz = -nx * s + nz * c, yaw = Math.atan2(nwx, nwz);
      const at = (u, out) => { const lx = nx * (half + out) + tx * u, lz = nz * (half + out) + tz * u; return [it.x + lx * c + lz * s, it.z - lx * s + lz * c]; };
      if (W) {
        const nf = Math.max(1, Math.floor(it.sy / W.floor + 0.5)), fh = it.sy / nf, nb = Math.max(1, Math.floor(fw / W.bay + 0.5)), cw = fw / nb;
        const sx0 = Math.floor(it.seed * W.bays), sy0 = Math.floor(((it.seed * 7.13) % 1) * W.floors);
        for (let i = 0; i < nb; i++) for (let j = 0; j < nf; j++) {
          const b = (i + sx0) % W.bays, f = (j + sy0) % W.floors;
          if (W.skip && W.skip(b, f, variant)) continue;
          const [x, z] = at((i + (W.u0 + W.u1) / 2) * cw - fw / 2, 0);
          put('winTrim', x, it.y + (j + (W.v0 + W.v1) / 2) * fh, z, yaw, (W.u1 - W.u0) * cw, (W.v1 - W.v0) * fh, 1, W.color);
        }
      }
      if (LG) {
        const nf = Math.max(1, Math.floor(it.sy / LG.floor + 0.5)), fh = it.sy / nf, [x, z] = at(0, 0.11);
        for (let j = 1; j < nf; j++) put('ledge', x, it.y + j * fh - 0.08, z, yaw, fw + 0.24, 0.16, 0.22, LG.color);
      }
    }
  }
  for (const st of ['brick', 'render', 'house', 'office', 'ribbon']) for (const v of [0, 1]) DECOR[st + v] = decorate;

  // plain parts: upward faces (roofs of plant rooms, ledges) weather darker than the walls
  const plainMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8 });
  // Triplanar photo material: world-space projection from all three axes, blended by the surface normal, with
  // its normal map; `lum` keeps the instance colour and takes the photo's light and shade
  function triplanar(mat, name, { scale = 3, tint = 0, normal = 1, up = 1, key = '' } = {}) {
    const T = photo(name);
    mat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, { tDiff: { value: T.diff }, tNor: { value: T.nor }, tAvg: { value: T.avg } });
      sh.vertexShader = 'varying vec3 vTW; varying vec3 vTN;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        mat4 tm = modelMatrix;
        #ifdef USE_INSTANCING
          tm = modelMatrix * instanceMatrix;
        #endif
        vTW = (tm * vec4(transformed, 1.0)).xyz; vTN = normalize(mat3(tm) * normal);`);
      sh.fragmentShader = 'varying vec3 vTW; varying vec3 vTN;\nuniform sampler2D tDiff; uniform sampler2D tNor; uniform vec3 tAvg;\n' + PERTURB + sh.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec3 tw = pow(abs(vTN), vec3(4.0)); tw /= tw.x + tw.y + tw.z;
          vec2 ux = vTW.zy / ${scale.toFixed(2)}, uy = vTW.xz / ${scale.toFixed(2)}, uz = vTW.xy / ${scale.toFixed(2)};
          vec3 pc = (texture2D(tDiff, ux).rgb * tw.x + texture2D(tDiff, uy).rgb * tw.y + texture2D(tDiff, uz).rgb * tw.z) / max(tAvg, vec3(1e-3));
          diffuseColor.rgb *= mix(vec3(dot(pc, vec3(0.2126, 0.7152, 0.0722))), pc, ${tint.toFixed(2)});
          diffuseColor.rgb *= mix(1.0, ${up.toFixed(2)}, step(0.5, vTN.y));`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          { vec2 tuv = tw.y > max(tw.x, tw.z) ? uy : (tw.x > tw.z ? ux : uz);
            vec3 mn = texture2D(tNor, tuv).xyz * 2.0 - 1.0;
            normal = normalize(mix(normal, pnPerturb(-vViewPosition, normal, mn, tuv), ${normal.toFixed(2)})); }`);
    };
    mat.customProgramCacheKey = () => 'tri:' + name + scale + tint + normal + up + key;
    mat.extensions = { derivatives: true };
    return mat;
  }
  triplanar(plainMat, 'concrete_wall_008', { scale: 3, tint: 0.1, normal: 0.7, up: 0.5 });
  defType('cap', box1, plainMat, { colored: true }); FAR.cap = 6000;
  defType('part', box1, plainMat, { colored: true }); FAR.part = 900;
  defType('bit', box1, plainMat, { colored: true, shadow: false }); FAR.bit = 380;
  defType('tank', new THREE.CylinderGeometry(0.5, 0.5, 1, 12).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8 }), { colored: true }); FAR.tank = 900;
  const roofG = (() => { // gable: ridge along x
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0, -0.5, 0, 0.5, -0.5, 1, 0, 0.5, 1, 0, 0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 1, 0, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0], 3));
    g.setIndex([0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6, 8, 10, 9, 11, 13, 12]);
    const f = g.toNonIndexed(); f.computeVertexNormals(); return f;
  })();
  const hipG = (() => { // hip: short ridge, four sloped faces
    const r = 0.22, v = [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5], [-r, 1, 0], [r, 1, 0]];
    const tri = [[0, 4, 5], [0, 5, 1], [1, 5, 2], [2, 5, 4], [2, 4, 3], [3, 4, 0]], pos = [];
    for (const t of tri) for (const k of t) pos.push(...v[k]);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
  })();
  // Roofs: shingle courses every 28 cm of height, each course's tabs offset, weathered with world-space noise
  const roofMat = triplanar(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, side: THREE.DoubleSide }), 'grey_roof_01', { scale: 2.2, tint: 0.0, normal: 1.0 });
  defType('roof', roofG, roofMat, { colored: true });
  defType('hip', hipG, roofMat, { colored: true });
  defType('chimney', box1, new THREE.MeshStandardMaterial({ color: '#8a4b3a', roughness: 0.9 }), { shadow: false });
  defType('slab', box1, mats.concrete, { shadow: false });
  // ---- Trees: alpha-cut cards with photographed foliage (Poly Haven, CC0) ----
  const texLoader = new THREE.TextureLoader();
  const foliage = (file, srgb = true) => { const t = texLoader.load('assets/foliage/' + file); if (srgb) t.encoding = THREE.sRGBEncoding; t.anisotropy = 4; return t; };
  const leafTex = foliage('leaf.png'), barkTex = foliage('bark.jpg');
  barkTex.wrapS = barkTex.wrapT = THREE.RepeatWrapping; barkTex.repeat.set(2, 3);
  // conifer branch: a drawn twig with rows of needles, transparent background
  const firTex = canvasTex(256, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const twig = (x0, y0, x1, y1, len, width) => {
      g.strokeStyle = '#3b2e22'; g.lineWidth = width; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      const n = Math.hypot(x1 - x0, y1 - y0) / 2.2;
      for (let i = 0; i < n; i++) {
        const t = i / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t, ang = Math.atan2(y1 - y0, x1 - x0), l = len * (1 - 0.6 * t) * (0.7 + rand() * 0.5);
        for (const sg of [-1, 1]) {
          const v = 40 + rand() * 50 | 0;
          g.strokeStyle = `rgba(${v * 0.55 | 0},${v + 30},${v * 0.5 | 0},0.95)`; g.lineWidth = 1.4;
          g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(ang + sg * 1.0) * l, y + Math.sin(ang + sg * 1.0) * l); g.stroke();
        }
      }
    };
    twig(4, h / 2, w - 6, h / 2, 26, 3);
    for (let k = 0; k < 7; k++) { const x = 30 + k * 30, sg = k % 2 ? 1 : -1; twig(x, h / 2, x + 34, h / 2 + sg * 42, 14, 1.5); }
  });
  const windTime = { value: 0 };
  // wind: sway grows with height in the tree; phase from the tree's position so a stand of trees doesn't move as one
  // distance detail: every card is drawn close up; further away cards drop out in a fixed random order and the
  // survivors grow to keep the crown full (dropped cards collapse to a point, so they cost no pixels)
  const windy = (mat, amp, key, lod = [35, 150, 0.25], frost = 0) => {
    mat.onBeforeCompile = sh => {
      sh.uniforms.uWind = windTime;
      // winter: the foliage drained of green and dusted with snow (more on the upward-facing leaves)
      if (frost > 0) sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        { float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum) * vec3(0.95, 1.0, 1.06) * 1.25 + vec3(0.32, 0.34, 0.36), ${frost.toFixed(2)}); }`);
      sh.vertexShader = 'uniform float uWind;\nattribute vec3 cardC;\nattribute float rank;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          { vec3 wc = (modelMatrix * instanceMatrix * vec4(cardC, 1.0)).xyz;
            float keep = mix(1.0, ${lod[2].toFixed(2)}, smoothstep(${lod[0].toFixed(1)}, ${lod[1].toFixed(1)}, distance(wc, cameraPosition)));
            transformed = rank > keep ? cardC : cardC + (transformed - cardC) * inversesqrt(keep); }
        #endif
        #ifdef USE_INSTANCING
          vec3 tp = instanceMatrix[3].xyz; float ph = tp.x * 0.13 + tp.z * 0.11, hh = max(position.y + 0.5, 0.0);
          transformed.x += (sin(uWind * 1.3 + ph) * 0.7 + sin(uWind * 2.9 + ph * 3.0) * 0.3) * ${amp.toFixed(3)} * hh * hh;
          transformed.z += sin(uWind * 1.1 + ph * 1.7) * ${(amp * 0.6).toFixed(3)} * hh * hh;
        #endif`);
    };
    mat.customProgramCacheKey = () => key + 'lod';
    return mat;
  };
  const cardDepth = map => new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.5, side: THREE.DoubleSide });
  defType('trunk', new THREE.CylinderGeometry(0.12, 0.26, 1, 9).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ map: barkTex, roughness: 0.95, color: '#c9b8a8' }), { shadow: true });
  // broadleaf crown: ~70 frond cards scattered through an ellipsoid, normals bent outwards (soft, leafy light),
  // darker underneath and in the middle
  const FRONDS = [[0.16, 0.54, 1.0, 0.98], [0.0, 0.31, 0.42, 0.68], [0.25, 0.07, 1.0, 0.41]]; // atlas rects: u0 v0 u1 v1
  function cardCrown(n, seed) {
    const pos = [], nrm = [], uv = [], col = [], idx = [], cen = [], rank = [];
    let sd = seed; const rnd = () => { sd = (sd * 16807) % 2147483647; return (sd - 1) / 2147483646; };
    for (let k = 0; k < n; k++) {
      // a point in the crown, biased to the outer shell
      const th = rnd() * Math.PI * 2, ph = Math.acos(rnd() * 1.6 - 0.6), rr = Math.pow(rnd(), 0.35);
      const cx = Math.sin(ph) * Math.cos(th) * rr, cy = Math.cos(ph) * rr * 0.85, cz = Math.sin(ph) * Math.sin(th) * rr;
      const out = new THREE.Vector3(cx, cy * 0.6 + 0.25, cz).normalize();
      const [u0, v0, u1, v1] = FRONDS[(rnd() * 3) | 0];
      const w = 0.75 + rnd() * 0.35, hgt = w * (v1 - v0) / (u1 - u0);
      // card plane: along a random tangent of the shell, tilted down a little like a hanging frond
      const t1 = new THREE.Vector3(-out.z, rnd() * 0.6 - 0.4, out.x).normalize(), t2 = new THREE.Vector3().crossVectors(out, t1).normalize();
      const b = pos.length / 3, rk = rnd();
      for (const [a, c] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
        const px = cx + t1.x * a * w + t2.x * c * hgt, py = cy + t1.y * a * w + t2.y * c * hgt, pz = cz + t1.z * a * w + t2.z * c * hgt;
        pos.push(px, py, pz); cen.push(cx, cy, cz); rank.push(rk);
        const nn = new THREE.Vector3(px, py * 0.7 + 0.2, pz).normalize(); nrm.push(nn.x, nn.y, nn.z);
        uv.push(a < 0 ? u0 : u1, c < 0 ? v0 : v1);
        const ao = clamp(0.5 + 0.35 * rr + 0.25 * (py + 0.6), 0.35, 1.1); col.push(ao, ao, ao);
      }
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
    g.setAttribute('cardC', new THREE.Float32BufferAttribute(cen, 3)); g.setAttribute('rank', new THREE.Float32BufferAttribute(rank, 1));
    return g;
  }
  const leafMat = windy(new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true, roughness: 0.75, color: new THREE.Color(0.78, 0.85, 0.7) }), 0.035, 'leafCards', undefined, WINTER ? 0.72 : 0);
  defType('crown', cardCrown(170, 4242), leafMat, { colored: true }); FAR.crown = 2000;
  batches.get('crown').depthMat = cardDepth(leafTex);
  // conifer: whorls of drooping branch cards round the stem, narrowing to the top
  const firGeo = (() => {
    const pos = [], nrm = [], uv = [], col = [], idx = [], cen = [], rank = [];
    const WH = 15;
    for (let lv = 0; lv < WH; lv++) {
      const t = lv / WH, y = 0.08 + t * 0.86, r = Math.pow(1 - t, 0.85) * 1.0 + 0.06, nb = Math.max(6, Math.round(13 - t * 5));
      for (let k = 0; k < nb; k++) {
        const a = (k + lv * 0.37) / nb * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), wd = 0.22 + r * 0.25, droop = 0.12 + r * 0.1;
        const b = pos.length / 3, rk = ((lv * 7919 + k * 104729) % 1000) / 1000;
        // root at the stem, tip out at radius r and drooping; the card's width lies horizontal
        const P0 = [0, y + 0.02, 0], P1 = [ca * r, y - droop, sa * r], side = [-sa * wd / 2, 0, ca * wd / 2];
        for (const [p, s2, u, v] of [[P0, -1, 0, 0], [P1, -1, 1, 0], [P1, 1, 1, 1], [P0, 1, 0, 1]]) {
          pos.push(p[0] + side[0] * s2, p[1] + 0.03 * s2, p[2] + side[2] * s2);
          cen.push(ca * r * 0.5, y - droop * 0.5, sa * r * 0.5); rank.push(rk);
          const nn = new THREE.Vector3(ca, 0.7, sa).normalize(); nrm.push(nn.x, nn.y, nn.z);
          uv.push(u, v);
          const ao = 0.55 + 0.45 * t + (u ? 0.15 : 0); col.push(ao, ao, ao);
        }
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
    g.setAttribute('cardC', new THREE.Float32BufferAttribute(cen, 3)); g.setAttribute('rank', new THREE.Float32BufferAttribute(rank, 1));
    return g;
  })();
  const firMat = windy(new THREE.MeshStandardMaterial({ map: firTex, alphaTest: 0.4, side: THREE.DoubleSide, vertexColors: true, roughness: 0.85, color: new THREE.Color(1.5, 1.6, 1.5) }), 0.02, 'firCards', undefined, WINTER ? 0.38 : 0);
  defType('fir', firGeo, firMat, { colored: true });
  // a boulder: a lumpy, flattened icosahedron
  const rockGeo = (() => {
    let rs = 4711; const rr = () => (rs = (rs * 16807) % 2147483647) / 2147483647;
    const g = new THREE.IcosahedronGeometry(1, 1), p = g.attributes.position, seen = new Map();
    for (let i = 0; i < p.count; i++) { const key = p.getX(i).toFixed(3) + p.getY(i).toFixed(3) + p.getZ(i).toFixed(3); if (!seen.has(key)) seen.set(key, 0.78 + rr() * 0.4); const k = seen.get(key); p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * (p.getY(i) < 0 ? 0.6 : 1), p.getZ(i) * k); }
    g.computeVertexNormals(); return g;
  })();
  defType('rock', rockGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, flatShading: true }), { colored: true }); FAR.rock = 700;
  batches.get('fir').depthMat = cardDepth(firTex);
  // the far stand-ins use the average foliage colour
  const LEAF_AVG = new THREE.Color(0.045, 0.085, 0.022), FIR_AVG = new THREE.Color(0.025, 0.05, 0.02);

  // Parked cars: a lofted low body with bonnet and boot, a glasshouse, four wheels
  const carGeo = (() => {
    const side = new THREE.Shape();
    side.moveTo(-2.2, 0.32); side.lineTo(2.1, 0.32); side.quadraticCurveTo(2.25, 0.4, 2.22, 0.72); side.lineTo(1.3, 0.86);
    side.lineTo(-1.9, 0.9); side.quadraticCurveTo(-2.22, 0.86, -2.22, 0.6); side.lineTo(-2.2, 0.32);
    const body = new THREE.ExtrudeGeometry(side, { depth: 1.76, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2, curveSegments: 4 }).translate(0, 0, -0.88).rotateY(-Math.PI / 2);
    return body;
  })();
  const cabinGeo = (() => {
    const s2 = new THREE.Shape();
    s2.moveTo(-1.55, 0.86); s2.lineTo(1.15, 0.86); s2.lineTo(0.45, 1.36); s2.lineTo(-1.05, 1.38); s2.lineTo(-1.55, 0.88);
    return new THREE.ExtrudeGeometry(s2, { depth: 1.5, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 1 }).translate(0, 0, -0.75).rotateY(-Math.PI / 2);
  })();
  const wheelsGeo = (() => {
    const pos = [], nrm = [], idx = [];
    for (const [x, z] of [[-0.8, 1.35], [0.8, 1.35], [-0.8, -1.35], [0.8, -1.35]]) {
      const g = new THREE.CylinderGeometry(0.33, 0.33, 0.22, 12).rotateZ(Math.PI / 2).translate(x, 0.33, z), b = pos.length / 3;
      pos.push(...g.attributes.position.array); nrm.push(...g.attributes.normal.array); for (const i of g.index.array) idx.push(b + i);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); g.setIndex(idx); return g;
  })();
  defType('carBody', carGeo, new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.38, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08 }), { colored: true }); FAR.carBody = 600;
  defType('carCabin', cabinGeo, new THREE.MeshStandardMaterial({ color: '#141a20', roughness: 0.05, metalness: 0.6 }), { shadow: false }); FAR.carCabin = 600;
  defType('carWheels', wheelsGeo, new THREE.MeshStandardMaterial({ color: '#18181a', roughness: 0.85 }), { shadow: false }); FAR.carWheels = 300;
  const hedgeTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#2a3d1c'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 3000; i++) { const v = 60 + rand() * 90 | 0; g.fillStyle = `rgb(${v * 0.6 | 0},${v},${v * 0.35 | 0})`; g.beginPath(); g.ellipse(rand() * w, rand() * h, 2 + rand() * 4, 1 + rand() * 2.5, rand() * TAU, 0, TAU); g.fill(); }
  }, true);
  defType('hedge', box1, new THREE.MeshStandardMaterial({ map: hedgeTex, roughness: 0.95 }), { shadow: true });
  const poleMat = new THREE.MeshStandardMaterial({ color: '#5b5763', roughness: 0.5, metalness: 0.6 });
  const lampHead = new THREE.MeshStandardMaterial({ color: '#fff3d6', emissive: '#ffd79a', emissiveIntensity: 2.2 });
  defType('pole', new THREE.CylinderGeometry(0.09, 0.14, 1, 6).translate(0, 0.5, 0), poleMat, { shadow: false });
  defType('arm', new THREE.BoxGeometry(0.08, 0.08, 1).translate(0, 0, 0.5), poleMat, { shadow: false });
  defType('lamp', new THREE.BoxGeometry(0.4, 0.14, 0.7), lampHead, { shadow: false });
  const jerseyGeo = (() => { const s = new THREE.Shape(); s.moveTo(-0.3, 0); s.lineTo(0.3, 0); s.lineTo(0.3, 0.08); s.lineTo(0.18, 0.3); s.lineTo(0.1, 0.82); s.lineTo(-0.1, 0.82); s.lineTo(-0.18, 0.3); s.lineTo(-0.3, 0.08); return new THREE.ExtrudeGeometry(s, { depth: 4.05, bevelEnabled: false }).translate(0, 0, -2.02); })();
  const barrierMat = new THREE.MeshStandardMaterial({ map: mats.concrete.map, roughness: 0.85 });
  defType('jersey', jerseyGeo, barrierMat);
  defType('pier', new THREE.CylinderGeometry(0.8, 0.9, 1, 8).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ map: mats.concrete.map, roughness: 0.85 }));

  /* ================= Knockable street furniture (instanced until hit) ================= */
  const mailMat = new THREE.MeshStandardMaterial({ color: '#2b2d33', metalness: 0.4, roughness: 0.5 });
  const postMat = new THREE.MeshStandardMaterial({ color: '#d9d2c4', roughness: 0.8 });
  const binMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.7 });
  const PROP_GEO = {
    mailPost: new THREE.BoxGeometry(0.1, 1.05, 0.1).translate(0, 0.52, 0),
    mailBox: new THREE.BoxGeometry(0.26, 0.24, 0.45).translate(0, 1.15, 0),
    bin: new THREE.BoxGeometry(0.6, 1.05, 0.7).translate(0, 0.52, 0),
  };
  defType('mailPost', PROP_GEO.mailPost, postMat, { shadow: false }); defType('mailBox', PROP_GEO.mailBox, mailMat, { shadow: false }); defType('bin', PROP_GEO.bin, binMat, { colored: true, shadow: false });
  const props = [], PG = 16, propHash = new Map(), pkey = (i, j) => (i + 512) * 1024 + (j + 512);
  const BINC = ['#2f5d3a', '#2d3e63', '#3a3a3e'].map(C3s);
  function addProp(kind, x, z, yaw) {
    const y = groundAt(x, z), p = { kind, x, y, z, yaw, r: kind === 'bin' ? 0.5 : 0.45, items: [] };
    if (kind === 'mail') p.items.push(put('mailPost', x, y, z, yaw, 1, 1, 1), put('mailBox', x, y, z, yaw, 1, 1, 1));
    else { p.color = BINC[(rand() * BINC.length) | 0]; p.items.push(put('bin', x, y, z, yaw, 1, 1, 1, p.color)); }
    props.push(p);
    const k = pkey(Math.floor(x / PG), Math.floor(z / PG)); if (!propHash.has(k)) propHash.set(k, []); propHash.get(k).push(p);
  }

  /* ================= Bridges: decks, parapets and piers ================= */
  const solidBox = (x, z, hx, hz, y0, h, ux, uz, mu = 0.5) => { const o = { type: 'box', x, z, hx, hz, h, y0, ux, uz, mu }; solids.push(o); return o; };
  // `rails(i, side)` says whether to put a parapet at point i on that side (+1 right, -1 left)
  function dressDeck(fr, deck, hw, piers, rails) {
    let run = [];
    const flushRun = () => {
      if (run.length > 1) {
        const pr = run.map(i => fr[i]);
        strip(pr, -hw - 0.4, hw + 0.4, -1.0, 12, B.wall, true);
        skirt(pr, hw + 0.4, 0.05, -1.0, B.wall, 1); skirt(pr, -hw - 0.4, 0.05, -1.0, B.wall, -1);
        let acc = 14;
        for (let k = 1; k < run.length; k++) {
          const f = fr[run[k]], prev = fr[run[k - 1]];
          acc += Math.hypot(f.x - prev.x, f.z - prev.z);
          if (acc >= 30 && k < run.length - 2) {
            acc = 0;
            for (const lat of piers) {
              const x = f.x + f.rx * lat, z = f.z + f.rz * lat, g = groundAt(x, z), top = f.y - 1.0;
              if (top - g < 1.5 || bitsAt(x, z) & PAVED) continue;
              put('pier', x, g - 0.5, z, 0, 1, top - g + 0.5, 1);
              solids.push({ type: 'circle', x, z, r: 0.9, h: top - g + 0.5, y0: g - 0.5, mu: 0.5 });
            }
          }
        }
      }
      run = [];
    };
    for (let i = 0; i < fr.length; i++) { if (deck[i]) run.push(i); else flushRun(); }
    flushRun();
    // parapets: jersey barriers along the deck edges
    let since = 99;
    for (let i = 0; i < fr.length; i++) {
      since++;
      if (!deck[i] || since < 2) continue;
      since = 0;
      const f = fr[i], yaw = yawTo(f.tx, f.tz);
      for (const sg of [1, -1]) {
        if (!rails(i, sg)) continue;
        const x = f.x + f.rx * sg * (hw + 0.1), z = f.z + f.rz * sg * (hw + 0.1);
        put('jersey', x, f.y, z, yaw, 1, 1, 1);
        solidBox(x, z, 0.3, 2.05, f.y, 0.82, -f.tz, f.tx, 0.45);
      }
    }
  }
  for (const r of roads) {
    if (!r.deck.some(Boolean)) continue;
    const fr = frames(r.pts), n = fr.length, s = arcLengths(r.pts), L = s[n - 1];
    dressDeck(fr, r.deck, hwOf(r.kind), [0], r.kind === 'ramp' ? i => s[i] > 30 && L - s[i] > 30 : () => true);
  }
  {
    // the freeway's right-hand parapet stops where ramps and acceleration lanes leave or join
    const open = [];
    for (const ic of interchanges) {
      const acc = 45;
      open.push([1, ic.jc - DIV - 4, ic.jc - DIV + 34], [1, ic.jc + MRG - 50, ic.jc + MRG + acc + 4]);
      open.push([-1, ic.jc + DIV - 34, ic.jc + DIV + 4], [-1, ic.jc - MRG - acc - 4, ic.jc - MRG + 50]);
    }
    dressDeck(fFr, fpts.deck, FW, [-8, 0, 8], (i, sg) => i > TAPER && i < NF - 1 - TAPER && !open.some(([s, a, b]) => s === sg && i >= a && i <= b));
  }
  for (const r of ramps) dressDeck(frames(r.pts), r.deck, 2.6, [0], () => true);

  /* ================= Footprints and lots ================= */
  const FPG = 24, fpHash = new Map(), fkey = (i, j) => (i + 512) * 1024 + (j + 512);
  const addFootprint = (x, z, r, building) => { const f = { x, z, r, building }; for (let i = Math.floor((x - r) / FPG); i <= Math.floor((x + r) / FPG); i++) for (let j = Math.floor((z - r) / FPG); j <= Math.floor((z + r) / FPG); j++) { const k = fkey(i, j); if (!fpHash.has(k)) fpHash.set(k, []); fpHash.get(k).push(f); } };
  // Buildings keep oriented rectangles (centre, unit axis u along the street, half extents); trees keep circles
  const addRect = (x, z, ux, uz, hx, hz) => {
    const r = Math.hypot(hx, hz), f = { x, z, r, building: true, rect: true, ux, uz, hx, hz };
    for (let i = Math.floor((x - r) / FPG); i <= Math.floor((x + r) / FPG); i++) for (let j = Math.floor((z - r) / FPG); j <= Math.floor((z + r) / FPG); j++) { const k = fkey(i, j); if (!fpHash.has(k)) fpHash.set(k, []); fpHash.get(k).push(f); }
  };
  const rectGap = (f, x, z) => { // distance from a point to a footprint
    const dx = x - f.x, dz = z - f.z;
    if (!f.rect) return Math.hypot(dx, dz) - f.r;
    const lx = dx * f.ux + dz * f.uz, lz = -dx * f.uz + dz * f.ux;
    return Math.hypot(Math.max(Math.abs(lx) - f.hx, 0), Math.max(Math.abs(lz) - f.hz, 0));
  };
  const blocked = (x, z, pad, buildingsOnly) => {
    for (let i = Math.floor((x - pad) / FPG); i <= Math.floor((x + pad) / FPG); i++) for (let j = Math.floor((z - pad) / FPG); j <= Math.floor((z + pad) / FPG); j++) {
      const l = fpHash.get(fkey(i, j)); if (l) for (const f of l) if ((!buildingsOnly || f.building) && rectGap(f, x, z) < pad) return true;
    }
    return false;
  };
  // Does a rectangle overlap any building footprint? (separating axes; circles are treated as their squares)
  const rectBlocked = (x, z, ux, uz, hx, hz) => {
    const r = Math.hypot(hx, hz), seen = new Set();
    const proj = (ax, az, cx, cz, vx, vz, ex, ez) => { // half-width of a box (axes v, v-perp, extents ex, ez) on axis a
      return Math.abs(ex * (vx * ax + vz * az)) + Math.abs(ez * (-vz * ax + vx * az));
    };
    for (let i = Math.floor((x - r) / FPG); i <= Math.floor((x + r) / FPG); i++) for (let j = Math.floor((z - r) / FPG); j <= Math.floor((z + r) / FPG); j++) {
      const l = fpHash.get(fkey(i, j)); if (!l) continue;
      for (const f of l) {
        if (!f.building || seen.has(f)) continue; seen.add(f);
        if (Math.hypot(f.x - x, f.z - z) > r + f.r) continue;
        const fux = f.rect ? f.ux : 1, fuz = f.rect ? f.uz : 0, fhx = f.rect ? f.hx : f.r, fhz = f.rect ? f.hz : f.r;
        const dx = f.x - x, dz = f.z - z;
        let sep = false;
        for (const [ax, az] of [[ux, uz], [-uz, ux], [fux, fuz], [-fuz, fux]]) {
          const d = Math.abs(dx * ax + dz * az);
          if (d > proj(ax, az, 0, 0, ux, uz, hx, hz) + proj(ax, az, 0, 0, fux, fuz, fhx, fhz)) { sep = true; break; }
        }
        if (!sep) return true;
      }
    }
    return false;
  };
  const parkAt = (x, z) => fbm(x / 260 + 40, z / 260 - 13, 2) > 0.36;
  function pointAt(fr, s) {
    let acc = 0;
    for (let i = 1; i < fr.length; i++) {
      const l = Math.hypot(fr[i].x - fr[i - 1].x, fr[i].z - fr[i - 1].z);
      if (acc + l >= s) { const t = (s - acc) / l, a = fr[i - 1], b = fr[i]; return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: lerp(a.y, b.y, t), tx: b.tx, tz: b.tz, rx: b.rx, rz: b.rz }; }
      acc += l;
    }
    return fr[fr.length - 1];
  }
  const lotXZ = (p, n, along, out) => ({ x: p.x + p.tx * along + n.x * out, z: p.z + p.tz * along + n.z * out });
  // Is the lot clear (no roads, parks or other buildings) and flat enough? Returns its ground height range.
  const why = {};
  function lotFree(p, n, a0, a1, o0, o1, maxDrop, park = true) {
    let lo = Infinity, hi = -Infinity;
    for (let a = a0; a <= a1; a += 2) for (let o = o0; o <= o1; o += 2) {
      const q = lotXZ(p, n, a, o);
      const b = bitsAt(q.x, q.z);
      if (b) { why['bits' + b] = (why['bits' + b] || 0) + 1; return null; }
      if (park && parkAt(q.x, q.z)) { why.park = (why.park || 0) + 1; return null; }
      const h = groundAt(q.x, q.z); lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (hi - lo > maxDrop) { why.slope = (why.slope || 0) + 1; return null; }
    return { lo, hi };
  }

  /* ================= Trees ================= */
  const SIDING = ['#f1ece2', '#e6dcc8', '#c9d3d6', '#b9c6b0', '#d8c3a5', '#a9b4c2', '#ece4d9', '#cfc6b8', '#9fa9a0'].map(C3s);
  const ROOFC = (WINTER ? ['#eef1f3', '#e4e9ec', '#f4f6f7', '#dde3e7', '#e8ecee', '#d8dfe3'] : ['#3b3a3d', '#4a3f38', '#5b5f66', '#6b3d33', '#2f3236', '#55504a']).map(C3s); // snow on every roof
  const LEAF = (WINTER ? ['#f2f5f6', '#e8eef0', '#fbfcfc', '#dfe6e8', '#eef2f2', '#e2e9ea'] : ['#e2ead2', '#f0f2d8', '#d4e2c4', '#f4ecc8', '#e8e0b8', '#c8d8b8']).map(C3s); // tints over the photo foliage (frosted in winter)
  const FIR = (WINTER ? ['#c9d4cf', '#d8e0dc', '#bfcbc6'] : ['#c0d0b8', '#b0c4a8', '#d0d8c0']).map(C3s);
  let treeCount = 0;
  function addTree(x, z, kind = rand() < 0.75 ? 'leaf' : 'fir', scale = 1, onWalk = false) {
    if (Math.abs(x) > EXT - 4 || Math.abs(z) > EXT - 4 || (!onWalk && bitsAt(x, z)) || blocked(x, z, onWalk ? 0.8 : 1.8)) return;
    const y = groundAt(x, z) - 0.1;
    if (y < WATER + 0.3) return;
    if (kind === 'leaf') {
      const h = (2.4 + rand() * 1.8) * scale, r = (2.2 + rand() * 1.6) * scale;
      put('trunk', x, y, z, 0, 1 + scale * 0.4, h + r * 0.5, 1 + scale * 0.4);
      const cy = y + h + r * 0.55, yaw = rand() * TAU, ry = r * (0.8 + rand() * 0.3), col = LEAF[(rand() * LEAF.length) | 0];
      put('crown', x, cy, z, yaw, r, ry, r, col);
    } else {
      const h = (7 + rand() * 6) * scale, r = (1.8 + rand() * 1.2) * scale;
      put('trunk', x, y, z, 0, 1, 1.4, 1);
      put('fir', x, y + 1, z, rand() * TAU, r, h, r, FIR[(rand() * FIR.length) | 0]);
    }
    solids.push({ type: 'circle', x, z, r: 0.28 * scale, h: 6, y0: y, mu: 0.6 });
    addFootprint(x, z, 1.2, false);
    treeCount++;
  }

  /* ================= Buildings along the streets ================= */
  // Each street's frontage is filled with lots suited to its district. Buildings are assembled from parts:
  // a plinth that takes up the slope, then storefronts, storeys, setbacks, cornices, crowns and rooftop plant.
  let houses = 0, buildings = 0, parked = 0;
  const cityCtr = byName['Port Ashby'].ctr;
  const pickOf = a => a[(rand() * a.length) | 0];
  const GLASS = ['#7f9bb3', '#6f8e8a', '#9a8f7c', '#8a96a6', '#5f7891', '#a7b3bd', '#7a8794'].map(C3s);
  const CONCRETE = ['#d6d2c8', '#c3c7cc', '#e2ddd2', '#b9b4aa', '#cfc8bb', '#aeb6bd', '#d8cfc0'].map(C3s);
  const BRICK = ['#a0563f', '#8c4a3a', '#b07a5a', '#9a5a46', '#c49a78', '#7e5144'].map(C3s);
  const RENDER = ['#e9e1cf', '#d9cbb0', '#c8d2cf', '#e3d2c0', '#d6c2ad', '#bfc7b5', '#e6dccb'].map(C3s);
  const TRIM = ['#4a4f57', '#5d6168', '#3c3f45', '#6b6e74', '#7d776c'].map(C3s), STONE = C3s('#8f8b84'), PLANT = C3s('#8d8f93'), WHITE = C3s('#ffffff');
  const AWNING = ['#8e2f25', '#2f5d3a', '#2d3e63', '#a57a2a', '#5a3a5e'].map(C3s), DOOR = C3s('#3a2c22'), GDOOR = C3s('#e8e4dc');
  const WAREC = ['#b8bcc0', '#9aa6ad', '#c9c0a8', '#a3a9a0', '#8e98a6', '#b5a58c'].map(C3s);
  const CARC = ['#b8bbbf', '#e4e4e2', '#1d1e22', '#55585e', '#1f2f55', '#8c1b1b', '#9e9178', '#2a4632', '#6a8bab'].map(C3s), CABIN = C3s('#2c333c');
  const FENCE = [C3s('#f2efe8'), C3s('#8a6a4a'), C3s('#6e5a44')];
  // A lot: p on the street, n pointing away from it; `a` runs along the street, `o` away from it
  const Lot = (p, n) => ({ p, n, yaw: yawTo(-n.x, -n.z), at: (a, o) => lotXZ(p, n, a, o) });
  const piece = (L, type, a, o, y, w, h, d, color, turn = 0) => { const q = L.at(a, o); return put(type, q.x, y, q.z, L.yaw + turn, w, h, d, color); };
  const solidAt = (L, a, o, w, d, y0, h, foot = true) => {
    const q = L.at(a, o); solidBox(q.x, q.z, w / 2, d / 2, y0, h, Math.cos(L.yaw), -Math.sin(L.yaw), 0.6);
    if (foot) addRect(q.x, q.z, L.p.tx, L.p.tz, w / 2, d / 2);
  };
  // Parked cars are instanced stand-ins; near the player the crime layer swaps them for real cars you can break into
  const parkedSpots = [];
  function parkedCar(x, z, yaw, drive = false) {
    const y = groundAt(x, z), s = Math.sin(yaw), c = Math.cos(yaw), color = pickOf(CARC);
    const items = [put('carBody', x, y, z, yaw, 1, 1, 1, color), put('carCabin', x, y, z, yaw, 1, 1, 1), put('carWheels', x, y, z, yaw, 1, 1, 1)];
    const solid = solidBox(x, z, 0.9, 2.2, y, 1.5, c, -s, 0.5);
    parkedSpots.push({ x, y, z, yaw, color, items, solid, drive, home: { x, z, h: 1.5 }, swapped: false, taken: false });
    parked++;
  }
  // rooftop plant: a few boxes scattered over a roof of w x d centred at (a, o)
  function plant(L, a, o, w, d, y, n) {
    for (let k = 0; k < n; k++) {
      const sx = 1.4 + rand() * 2.4, sz = 1.4 + rand() * 2.4;
      piece(L, 'part', a + (rand() - 0.5) * Math.max(0, w - sx - 2), o + (rand() - 0.5) * Math.max(0, d - sz - 2), y, sx, 1 + rand() * 1.6, sz, PLANT);
    }
  }
  function tower(L, range, w, d, set, dCity) {
    const y0 = range.lo - 0.6, base = range.hi + 0.3, o = set + d / 2, lit = rand() < 0.75 ? 1 : 0;
    const r = rand(), style = r < 0.38 ? 'glass' : r < 0.66 ? 'office' : r < 0.84 ? 'ribbon' : 'brick';
    // a skyline that peaks in the middle: the tallest towers cluster within ~200 m of the centre
    const core = smoothstep(380, 60, dCity), H = (18 + rand() * 22) + core * core * (50 + rand() * 120) + (style === 'glass' ? core * 25 : 0);
    const wall = style === 'glass' ? pickOf(GLASS) : style === 'brick' ? pickOf(BRICK) : pickOf(CONCRETE), trim = pickOf(TRIM);
    piece(L, 'part', 0, o, y0, w, base - y0, d, STONE);
    piece(L, 'shop' + lit, 0, o, base, w, 4.5, d, WHITE);
    let y = base + 4.5;
    // a wider base of a few storeys, then the shaft set back from it
    if (rand() < 0.45) { const ph = 3.7 * (1 + (rand() * 2 | 0)); piece(L, (style === 'glass' ? 'office' : style) + lit, 0, o, y, w, ph, d, style === 'glass' ? pickOf(CONCRETE) : wall); y += ph; piece(L, 'cap', 0, o, y, w + 0.4, 0.6, d + 0.4, trim); y += 0.6; }
    let sw = Math.max(12, w - 2 - rand() * 6), sd = Math.max(12, d - 2 - rand() * 6);
    const tiers = H > 45 && style !== 'glass' && rand() < 0.55 ? [0.55, 0.28, 0.17] : [1];
    const shaftH = Math.max(8, base + H - y);
    for (const f of tiers) {
      const th = shaftH * f;
      piece(L, style + lit, 0, o, y, sw, th, sd, wall); y += th;
      piece(L, 'cap', 0, o, y, sw + 0.5, 0.7, sd + 0.5, trim); y += 0.7;
      sw = Math.max(8, sw * 0.78); sd = Math.max(8, sd * 0.78);
    }
    // crown: a plant room, sometimes a spire, and the usual clutter
    const cw = sw * (0.6 + rand() * 0.25), cd = sd * (0.6 + rand() * 0.25), ch = 3 + rand() * 3;
    piece(L, 'cap', 0, o, y, cw, ch, cd, trim);
    if (H > 70 && rand() < 0.35) piece(L, 'cap', 0, o, y + ch, 0.5, 8 + rand() * 14, 0.5, PLANT);
    plant(L, 0, o, sw / 0.78, sd / 0.78, y, 2 + (rand() * 3 | 0));
    solidAt(L, 0, o, w, d, y0, y + ch - y0);
    buildings++;
  }
  function apartment(L, range, w, d, set, shops, dCity) {
    const y0 = range.lo - 0.5, base = range.hi + 0.3, o = set + d / 2, lit = rand() < 0.6 ? 1 : 0;
    const style = rand() < 0.55 ? 'brick' : 'render', wall = style === 'brick' ? pickOf(BRICK) : pickOf(RENDER), trim = pickOf(TRIM);
    const floors = dCity < 600 ? 4 + (rand() * 4 | 0) : 3 + (rand() * 3 | 0);
    piece(L, 'part', 0, o, y0, w, base - y0, d, STONE);
    let y = base;
    if (shops) { piece(L, 'shop' + lit, 0, o, y, w, 4.5, d, WHITE); y += 4.5; piece(L, 'part', 0, o, y, w + 0.3, 0.35, d + 0.3, trim); y += 0.35; }
    const bodyH = (floors - (shops ? 1 : 0)) * 3.1;
    piece(L, style + lit, 0, o, y, w, bodyH, d, wall);
    // balconies on the street side
    if (rand() < 0.35) for (let f = 1; f < floors - (shops ? 1 : 0); f++) {
      piece(L, 'part', 0, set - 0.6, y + f * 3.1 - 0.1, w * 0.72, 0.16, 1.2, trim);
      piece(L, 'bit', 0, set - 1.15, y + f * 3.1, w * 0.72, 0.9, 0.06, trim);
    }
    y += bodyH;
    piece(L, 'part', 0, o, y, w + 0.6, 0.6, d + 0.6, trim);
    if (rand() < 0.4) { const ta = (rand() - 0.5) * (w - 5); piece(L, 'part', ta, o, y + 0.6, 2.4, 1.3, 2.4, PLANT); piece(L, 'tank', ta, o, y + 1.9, 2.6, 2.6, 2.6, C3s('#7a5a40')); }
    plant(L, 0, o, w, d, y + 0.6, 1 + (rand() * 3 | 0));
    solidAt(L, 0, o, w, d, y0, y + 1 - y0);
    buildings++;
  }
  function shopRow(L, range, w, d, set) {
    const y0 = range.lo - 0.5, base = range.hi + 0.3, o = set + d / 2, lit = rand() < 0.7 ? 1 : 0;
    piece(L, 'part', 0, o, y0, w, base - y0, d, STONE);
    piece(L, 'shop' + lit, 0, o, base, w, 4.5, d, WHITE);
    let y = base + 4.5;
    if (rand() < 0.6) { piece(L, 'render' + lit, 0, o, y, w, 3.1, d, pickOf(RENDER)); y += 3.1; }
    piece(L, 'part', 0, o, y, w + 0.3, 0.9, d + 0.3, pickOf(TRIM));   // parapet
    piece(L, 'part', 0, set - 0.8, base + 3.2, w * 0.9, 0.14, 1.6, pickOf(AWNING));
    solidAt(L, 0, o, w, d, y0, y + 0.9 - y0);
    buildings++;
  }
  function warehouse(L, range, w, d, set) {
    const y0 = range.lo - 0.4, base = range.hi + 0.2, o = set + d / 2, h = 7 + rand() * 6;
    piece(L, 'part', 0, o, y0, w, base - y0, d, STONE);
    piece(L, 'ware' + 0, 0, o, base, w, h, d, pickOf(WAREC));
    piece(L, 'part', 0, o, base + h, w + 0.3, 0.5, d + 0.3, pickOf(TRIM));
    for (let k = 0, n = Math.max(1, Math.floor(w / 13)); k < n; k++) piece(L, 'part', (k - (n - 1) / 2) * 11, set - 0.1, base, 3.6, 4.2, 0.25, C3s('#59606a'));
    plant(L, 0, o, w, d, base + h + 0.5, 2 + (rand() * 3 | 0));
    solidAt(L, 0, o, w, d, y0, base + h + 1 - y0);
    // yard with a few cars
    const yard = L.at(0, set - 5);
    put('slab', yard.x, groundAt(yard.x, yard.z) - 0.25, yard.z, L.yaw, w, 0.32, 9, null);
    for (let o2 = HALF + 1; o2 < set; o2 += 2) { const q = L.at(0, o2); stamp(q.x, q.z, 3, WALK); }
    for (let k = 0; k < 1 + (rand() * 3 | 0); k++) { const q = L.at(-w / 2 + 4 + k * 3, set - 5); parkedCar(q.x, q.z, L.yaw + Math.PI / 2); }
    buildings++;
  }
  // Houses: ranch (one storey, hipped roof), colonial (two storeys, gable, porch) or split-level (a main block
  // and a one-storey wing); attached garage, driveway, path, fences round the back yard, often a car outside
  function house(p, n, sg, lotW, rural) {
    const L = Lot(p, n), kind = rand(), ranch = kind < 0.4, colonial = !ranch && kind < 0.75;
    const w = ranch ? 13 + rand() * 4 : 10 + rand() * 4, d = 9 + rand() * 3, front = rural ? 26 + rand() * 10 : 15 + rand() * 4, gSide = rand() < 0.5 ? -1 : 1, gW = 6.4;
    const aMin = (gSide < 0 ? -w / 2 - gW : -w / 2) - 2, aMax = (gSide > 0 ? w / 2 + gW : w / 2) + 2;
    const range = lotFree(p, n, aMin, aMax, front - 3, front + d + 2, 3.2);
    if (!range) return false;
    const hc = L.at(0, front + d / 2);
    if (blocked(hc.x, hc.z, 11, true)) return false;
    const siding = pickOf(SIDING), roofC = pickOf(ROOFC), trim = pickOf(TRIM), lit = rand() < 0.55 ? 1 : 0;
    const y0 = range.lo - 0.4, base = range.hi + 0.25, storeys = ranch ? 1 : 2, h = storeys * 2.9, oc = front + d / 2;
    piece(L, 'part', 0, oc, y0, w + 0.2, base - y0, d + 0.2, STONE);
    piece(L, 'house' + lit, 0, oc, base, w, h, d, siding);
    piece(L, ranch ? 'hip' : 'roof', 0, oc, base + h, w + 0.9, ranch ? 2 + rand() * 0.8 : 2.2 + rand() * 1.4, d + 0.9, roofC);
    piece(L, 'bit', gSide * -1.4, front - 0.06, base, 1.0, 2.1, 0.14, DOOR);
    if (colonial) {
      piece(L, 'part', gSide * -1.4, front - 1.2, base - 0.05, w * 0.5, 0.3, 2.4, STONE);
      piece(L, 'part', gSide * -1.4, front - 1.3, base + 2.6, w * 0.55, 0.18, 2.6, trim);
      for (const k of [-1, 1]) piece(L, 'bit', gSide * -1.4 + k * w * 0.24, front - 2.3, base, 0.2, 2.6, 0.2, WHITE);
    } else if (!ranch) { // split-level: a one-storey wing reaching towards the street
      const ww = w * 0.45, wa = -gSide * (w / 2 - ww / 2);
      piece(L, 'house' + lit, wa, front - 2.2, base, ww, 2.9, 4.6, siding);
      piece(L, 'roof', wa, front - 2.2, base + 2.9, 5, 1.6, ww + 0.6, roofC, Math.PI / 2);
    }
    if (rand() < 0.4) piece(L, 'chimney', (rand() - 0.5) * w * 0.6, front + d * 0.65, y0, 0.8, base + h + 2.6 - y0, 0.8);
    solidAt(L, 0, oc, w, d, y0, base + h + 2 - y0);
    // garage
    const ga = gSide * (w / 2 + gW / 2), go = front + 1 + 3.2;
    piece(L, 'part', ga, go, y0, gW, base + 2.9 - y0, 6.4, siding);
    piece(L, 'bit', ga, front + 0.95, base, gW - 1.2, 2.3, 0.1, GDOOR);
    piece(L, 'roof', ga, go, base + 2.9, gW + 0.5, 1.2, 6.9, roofC);
    solidAt(L, ga, go, gW, 6.4, y0, base + 4.1 - y0);
    // driveway and path
    for (let o = HALF + 1; o <= front + 1; o += 2) { const q = L.at(ga, o); put('slab', q.x, groundAt(q.x, q.z) - 0.25, q.z, L.yaw, 5, 0.32, 2.1); stamp(q.x, q.z, 2.6, WALK); }
    if (!rural) {
      for (let o = 9; o <= front - 1; o += 2) { const q = L.at(gSide * -1.4, o); put('slab', q.x, groundAt(q.x, q.z) - 0.25, q.z, L.yaw, 1.2, 0.31, 2.1); stamp(q.x, q.z, 1.0, WALK); }
      if (rand() < 0.4) { const q = L.at(-gSide * (w / 2 - 1), front - 1.2); put('hedge', q.x, groundAt(q.x, q.z) - 0.2, q.z, L.yaw, w * 0.4, 1.1, 0.9); }
    }
    if (rand() < 0.55) { const q = L.at(ga, HALF + 6.5); parkedCar(q.x, q.z, L.yaw, true); }
    // back-yard fence
    if (!rural && rand() < 0.8) {
      const fc = pickOf(FENCE), back = front + d + 13, half = Math.min(lotW, w + gW + 6) / 2;
      const q = L.at(0, back);
      if (!bitsAt(q.x, q.z)) {
        const fy = groundAt(q.x, q.z) - 0.1;
        piece(L, 'bit', gSide * gW / 2, back, fy, half * 2, 1.2, 0.08, fc);
        solidAt(L, gSide * gW / 2, back, half * 2, 0.2, fy, 1.2, false);
        for (const k of [-1, 1]) {
          const a = gSide * gW / 2 + k * half, mid = (front + d + back) / 2, q2 = L.at(a, mid);
          piece(L, 'bit', a, mid, groundAt(q2.x, q2.z) - 0.1, 0.08, 1.2, back - front - d, fc);
          solidAt(L, a, mid, 0.2, back - front - d, groundAt(q2.x, q2.z) - 0.1, 1.2, false);
        }
      }
    }
    const mb = L.at(ga - gSide * 3.4, rural ? 5.6 : 5.3);
    addProp('mail', mb.x, mb.z, L.yaw + Math.PI);
    if (!rural && rand() < 0.35) for (const k of [0, 1]) { const b = L.at(ga + gSide * (3.4 + k * 0.8), 5.0); addProp('bin', b.x, b.z, L.yaw); }
    if (rand() < 0.6) { const t = L.at(-gSide * (w / 2 + 2 + rand() * 3), front - 4 - rand() * 3); addTree(t.x, t.z); }
    for (let k = 0; k < 1 + (rand() * 3 | 0); k++) { const t = L.at((rand() - 0.5) * lotW * 0.8, front + d + 3 + rand() * 8); addTree(t.x, t.z); }
    houses++;
    return true;
  }
  function frontage(r) {
    const fr = frames(r.pts), Lr = linkLen(r.pts), zone = r.zone;
    for (const sg of [1, -1]) {
      const town = zone === 'dt' || zone === 'mid';
      let s = town ? 11.5 : PATCH + 14;
      const sEnd = Lr - (town ? 11.5 : PATCH + 14);
      while (s < sEnd - 8) {
        const n0 = pointAt(fr, s), dCity = Math.hypot(n0.x - cityCtr.x, n0.z - cityCtr.z);
        let w, kind = zone;
        if (zone === 'mid' && rand() < 0.12) kind = 'sub';
        if (zone === 'vil' && r.kind === 'art' && rand() < 0.75) kind = 'shop';
        if (kind === 'dt') w = 24 + rand() * 22;
        else if (kind === 'mid') w = 14 + rand() * 14;
        else if (kind === 'shop') w = 12 + rand() * 10;
        else if (kind === 'ind') w = 50 + rand() * 36;
        else w = kind === 'vil' ? 30 + rand() * 10 : 24 + rand() * 8;
        if (town) w = Math.min(w, sEnd - s);
        if (kind === 'sub' || kind === 'vil') {
          const p = pointAt(fr, s + w / 2), n = { x: p.rx * sg, z: p.rz * sg };
          s += w + 1; house(p, n, sg, w, false); continue;
        }
        const set = kind === 'ind' ? 15 : 10.5, maxDrop = kind === 'ind' ? 3 : 4.5;
        const dWant = kind === 'dt' ? 28 + rand() * 16 : kind === 'mid' ? 16 + rand() * 14 : kind === 'shop' ? 12 + rand() * 4 : 34 + rand() * 26;
        // try the full lot, then shallower and narrower ones, before giving up on this spot
        let fit = null;
        for (const [kw, kd] of [[1, 1], [1, 0.75], [1, 0.55], [0.65, 1], [0.65, 0.6]]) {
          const bw = w * kw - (kind === 'ind' ? 8 : kind === 'dt' ? 0.6 : 0.2), d = dWant * kd;
          if (bw < 9 || d < 10) continue;
          const p = pointAt(fr, s + w * kw / 2), n = { x: p.rx * sg, z: p.rz * sg };
          const range = lotFree(p, n, -bw / 2, bw / 2, set + 2, set + d, maxDrop, kind !== 'dt' && kind !== 'mid');
          if (!range) continue;
          const c = lotXZ(p, n, 0, set + d / 2);
          if (rectBlocked(c.x, c.z, p.tx, p.tz, bw / 2, d / 2)) continue;
          fit = { p, n, bw, d, range, c, used: w * kw }; break;
        }
        if (!fit) { s += town ? 4 : w; continue; }
        s += fit.used + (kind === 'ind' ? 8 : kind === 'dt' ? rand() * 1.2 : kind === 'mid' ? rand() * 0.8 : 1);
        const { p, n, bw, d, range, c } = fit, L = Lot(p, n);
        if (kind === 'dt') {
          if (rand() < 0.05) { // a plaza
            put('slab', c.x, range.lo - 0.3, c.z, L.yaw, bw, range.hi - range.lo + 0.38, d);
            for (let k = 0; k < 5; k++) { const t = L.at((rand() - 0.5) * (bw - 8), set + 4 + rand() * (d - 8)); addTree(t.x, t.z, 'leaf'); }
            addRect(c.x, c.z, p.tx, p.tz, bw / 2, d / 2); continue;
          }
          tower(L, range, bw, d, set, dCity);
        } else if (kind === 'mid') apartment(L, range, bw, d, set, r.kind === 'art' || rand() < 0.3, dCity);
        else if (kind === 'shop') shopRow(L, range, bw, d, set);
        else if (kind === 'ind') warehouse(L, range, bw, d, set);
      }
      // town streets: trees in pits along the kerb side of the pavement
      if (town) for (let s2 = 16; s2 < Lr - 16; s2 += 11 + rand() * 5) {
        const p = pointAt(fr, s2), q = { x: p.x + p.rx * sg * 6, z: p.z + p.rz * sg * 6 };
        const lp = (s2 - PATCH - 12) % 42; if ((bitsAt(q.x, q.z) & PAVED) || lp < 3 || lp > 39 || rand() < 0.25) continue;
        addTree(q.x, q.z, 'leaf', 0.75 + rand() * 0.2, true);
      }
      // street trees on residential streets
      if (r.kind === 'res' && (zone === 'sub' || zone === 'mid' || zone === 'vil')) for (let s2 = PATCH + 8; s2 < Lr - PATCH - 8; s2 += 13 + rand() * 6) {
        const p = pointAt(fr, s2), q = { x: p.x + p.rx * sg * 5.1, z: p.z + p.rz * sg * 5.1 };
        if (!bitsAt(q.x, q.z) && rand() < 0.7) addTree(q.x, q.z, 'leaf', 0.85);
      }
    }
  }
  // Downtown first so towers claim their corners, then outwards
  const ORDER = { dt: 0, mid: 1, ind: 2, sub: 3, vil: 4 };
  roads.filter(r => r.zone).sort((a, b) => ORDER[a.zone] - ORDER[b.zone]).forEach(frontage);
  // Farmsteads along country roads: a house and a barn
  for (const r of roads) {
    if (r.kind !== 'rural' && r.kind !== 'hwy') continue;
    const fr = frames(r.pts), Lr = linkLen(r.pts);
    for (let s = 120; s < Lr - 120; s += 320 + rand() * 420) {
      const p = pointAt(fr, s), sg = rand() < 0.5 ? 1 : -1, n = { x: p.rx * sg, z: p.rz * sg };
      if (penDAt(p.x, p.z) > 0 || forestAt(p.x, p.z, p.y) > 0.4 || rand() < 0.35) continue;
      if (!house(p, n, sg, 40, true)) continue;
      const L = Lot(p, n), a = (rand() - 0.5) * 30, o = 62 + rand() * 12, c = { ...L.at(a, o), tx: p.tx, tz: p.tz }, range = lotFree(c, n, -10, 10, -8, 8, 3.5, false);
      if (!range || blocked(c.x, c.z, 12, true)) continue;
      const y0 = range.lo - 0.4, top = range.hi + 6.5;
      piece(L, 'part', a, o, y0, 14, top - y0, 20, C3s(rand() < 0.6 ? '#8e2f25' : '#7a6a58'));
      piece(L, 'part', a, o - 10.05, range.hi, 5, 4.5, 0.12, C3s('#5a4636'));
      piece(L, 'roof', a, o, top, 21, 4.5, 15, pickOf(ROOFC), Math.PI / 2);
      solidAt(L, a, o, 14, 20, y0, top + 4 - y0);
      buildings++;
    }
  }
  lap('buildings');
  /* ================= The country: what lies between the towns ================= */
  // Frozen ponds with ice-fishing huts, homesteads and log cabins off the country roads, a wind farm on the high
  // ground, and woodland belts that ease each town out into the wild. Its own random stream, so nothing else moves.
  let cs = 7771; const cr = () => (cs = (cs * 16807) % 2147483647) / 2147483647;
  const inTown = (x, z, k = 1.06) => DISTRICTS.some(d => maskR(d, x, z) < k);
  const roadGap = (x, z) => sampleGrid(cIn, x, z) ?? 1e9;
  const openAt = (x, z, clear) => Math.abs(x) < EXT - 60 && Math.abs(z) < EXT - 60 && !bitsAt(x, z) && roadGap(x, z) > clear && !blocked(x, z, clear * 0.5) && groundAt(x, z) > WATER + 2;
  const span = (x, z, r) => { let lo = 1e9, hi = -1e9; for (let k = 0; k < 10; k++) { const a = k / 10 * TAU, h = groundAt(x + Math.cos(a) * r * (k % 2 ? 0.55 : 1), z + Math.sin(a) * r * (k % 2 ? 0.55 : 1)); lo = Math.min(lo, h); hi = Math.max(hi, h); } const c = groundAt(x, z); return { lo: Math.min(lo, c), hi: Math.max(hi, c) }; };
  // --- frozen ponds
  const ponds = [];
  const iceMat = new THREE.MeshStandardMaterial({ color: '#9fbccd', roughness: 0.07, metalness: 0.12 }); // clear blue-grey ice, glossy against the matte snow
  for (let t = 0; t < 4000 && ponds.length < 10; t++) {
    const x = (cr() * 2 - 1) * (EXT - 300), z = (cr() * 2 - 1) * (EXT - 300);
    if (inTown(x, z, 1.5) || !openAt(x, z, 70) || ponds.some(p => Math.hypot(p.x - x, p.z - z) < 650)) continue;
    const R = 22 + cr() * 22, S = span(x, z, R + 4);
    if (S.hi - S.lo > 1.6 || S.lo < WATER + 3) continue;
    const n = 28, ph = cr() * 9, rad = [];
    for (let k = 0; k < n; k++) { const a = k / n * TAU; rad.push(R * (0.8 + 0.22 * Math.sin(a * 2 + ph) + 0.12 * Math.sin(a * 3 - ph * 1.7))); }
    const shape = new THREE.Shape(); rad.forEach((r, k) => { const a = k / n * TAU; k ? shape.lineTo(Math.cos(a) * r, Math.sin(a) * r) : shape.moveTo(Math.cos(a) * r, Math.sin(a) * r); });
    const y = S.hi + 0.06, m = new THREE.Mesh(new THREE.ShapeGeometry(shape, 2).rotateX(-Math.PI / 2), iceMat);
    m.position.set(x, y, z); m.receiveShadow = true; scene.add(m);
    const pond = { x, z, y, R, rad, n }; ponds.push(pond);
    addFootprint(x, z, R * 1.05, false);
    // a couple of ice-fishing huts out on the ice, a bench by the shore
    for (let h = 0; h < (cr() < 0.7 ? 2 : 1); h++) {
      const a = cr() * TAU, d = R * (0.2 + cr() * 0.35), hx = x + Math.cos(a) * d, hz = z + Math.sin(a) * d, yaw = cr() * TAU;
      put('part', hx, y, hz, yaw, 2.2, 2.1, 2.6, C3s(pickOf(['#9c3a2e', '#3a5a7a', '#c9a23a', '#4a6a3a', '#7a7a74'])));
      put('roof', hx, y + 2.1, hz, yaw, 2.6, 0.7, 3.0, C3s('#5a4a40'));
      solidBox(hx, hz, 1.1, 1.3, y, 2.8, Math.cos(yaw), -Math.sin(yaw), 0.5);
    }
  }
  /** Ice you can stand on: the height of a frozen pond's surface at (x, z), or -Infinity */
  function pondAt(x, z) {
    for (const p of ponds) {
      const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
      if (d > p.R * 1.4) continue;
      const f = ((Math.atan2(dz, dx) / TAU) % 1 + 1) % 1 * p.n, k = Math.floor(f) % p.n, r = lerp(p.rad[k], p.rad[(k + 1) % p.n], f - Math.floor(f));
      if (d < r) return p.y;
    }
    return -Infinity;
  }
  pondHeight = pondAt;
  // --- homesteads and cabins along the country roads
  const LOGC = ['#6b4a32', '#5a3d28', '#7a5638'].map(C3s), FARMC = ['#e8e2d6', '#d8d0c0', '#9c3a2e', '#e4dcc8', '#c8c0b0'].map(C3s), BARNC = ['#7a2e24', '#8a3a2a', '#6a3a2e'].map(C3s);
  let homes = 0;
  const homestead = (x, z, yaw, kind) => {
    const S = span(x, z, kind === 'farm' ? 26 : 10); if (S.hi - S.lo > (kind === 'farm' ? 4 : 2.5)) return false;
    const y0 = S.lo - 0.4, c = Math.cos(yaw), s = Math.sin(yaw), at = (a, o) => ({ x: x + c * a + s * o, z: z - s * a + c * o });
    const house = (q, w, d, h, wall, roofC) => {
      put('part', q.x, y0, q.z, yaw, w, h + (S.hi - S.lo) + 0.4, d, wall);
      put('roof', q.x, y0 + h + (S.hi - S.lo) + 0.4, q.z, yaw, w + 0.9, h * 0.55, d + 0.9, roofC);
      put('chimney', q.x + c * w * 0.3, y0 + h + (S.hi - S.lo), q.z - s * w * 0.3, yaw, 0.7, h * 0.75, 0.7);
      solidBox(q.x, q.z, w / 2, d / 2, y0, h * 1.6 + (S.hi - S.lo), c, -s, 0.5); addFootprint(q.x, q.z, Math.hypot(w, d) / 2 + 2, true);
    };
    if (kind === 'cabin') {
      house({ x, z }, 7, 6, 3.2, pickOf(LOGC), C3s('#4a3a30'));
      const pq = at(0, 4.2); put('part', pq.x, y0, pq.z, yaw, 7, 0.5 + (S.hi - S.lo), 2, C3s('#5a4030')); // the porch
    } else {
      house({ x, z }, 9, 8, 5.6, pickOf(FARMC), C3s('#3a3a3a'));
      const b = at(-17, 6); put('part', b.x, y0 - 0.2, b.z, yaw, 11, 6.5 + (S.hi - S.lo), 16, pickOf(BARNC));
      put('roof', b.x, y0 + 6.3 + (S.hi - S.lo), b.z, yaw + Math.PI / 2, 17, 4.2, 12, C3s('#4a4a4a'));
      solidBox(b.x, b.z, 5.5, 8, y0, 11, c, -s, 0.5); addFootprint(b.x, b.z, 11, true);
      const t = at(-26, -3); put('tank', t.x, y0, t.z, 0, 5, 13 + (S.hi - S.lo), 5, C3s('#b9bcc0')); put('hip', t.x, y0 + 13 + (S.hi - S.lo), t.z, 0, 5.2, 2, 5.2, C3s('#8a8e94'));
      solids.push({ type: 'circle', x: t.x, z: t.z, r: 2.5, h: 15, y0, mu: 0.5 }); addFootprint(t.x, t.z, 4, true);
      // a paddock fence behind the barn
      const fx = -22, fz = 22, FW = 34, FD = 22;
      for (const [a0, o0, a1, o1] of [[fx - FW / 2, fz, fx + FW / 2, fz], [fx - FW / 2, fz + FD, fx + FW / 2, fz + FD], [fx - FW / 2, fz, fx - FW / 2, fz + FD], [fx + FW / 2, fz, fx + FW / 2, fz + FD]]) {
        const L = Math.hypot(a1 - a0, o1 - o0), m = at((a0 + a1) / 2, (o0 + o1) / 2), fy = yaw + Math.atan2(a1 - a0, o1 - o0);
        for (const hh of [0.55, 1.05]) put('part', m.x, groundAt(m.x, m.z) + hh, m.z, fy, 0.08, 0.12, L, C3s('#6a5038'));
        for (let k = 0; k <= L; k += 3) { const pq = at(a0 + (a1 - a0) * k / L, o0 + (o1 - o0) * k / L); put('part', pq.x, groundAt(pq.x, pq.z) - 0.2, pq.z, fy, 0.14, 1.45, 0.14, C3s('#5a4030')); }
      }
    }
    // a truck in the yard (a real one: you can break into it) and the drive down to the road
    const pk = at(kind === 'farm' ? 8 : 6, -2); parkedCar(pk.x, pk.z, yaw + Math.PI / 2, true);
    for (let o = -6; o > -34; o -= 2.2) { const q = at(1, o); if (roadGap(q.x, q.z) < 1.5) break; put('slab', q.x, groundAt(q.x, q.z) - 0.25, q.z, yaw, 3.2, 0.32, 2.3); }
    homes++; return true;
  };
  for (const L of links) {
    if (!(L.kind === 'rural' || L.kind === 'hwy')) continue;
    const pts = L.lanes[0].pts;
    for (let i = 20; i < pts.length - 20; i += 24 + (cr() * 18 | 0)) {
      if (cr() > 0.42) continue;
      const a = pts[i], b = pts[i + 1], h = Math.atan2(b.x - a.x, b.z - a.z), side = cr() < 0.5 ? 1 : -1, set = 30 + cr() * 14;
      const x = a.x + Math.cos(h) * side * set, z = a.z - Math.sin(h) * side * set;
      if (inTown(x, z, 1.15) || !openAt(x, z, 12) || pondAt(x, z) > -Infinity) continue;
      homestead(x, z, h + (side > 0 ? -Math.PI / 2 : Math.PI / 2), cr() < 0.45 ? 'farm' : 'cabin');
    }
  }
  // --- a wind farm along the high ground (blades turn in update())
  const turbines = [];
  {
    const towerG = new THREE.CylinderGeometry(1.1, 2.1, 1, 14).translate(0, 0.5, 0), white = new THREE.MeshStandardMaterial({ color: '#eef1f3', roughness: 0.5 });
    const bladeG = new THREE.BoxGeometry(1.4, 26, 0.35).translate(0, 13, 0), hubG = new THREE.SphereGeometry(1.4, 12, 8), nacG = new THREE.BoxGeometry(3, 3.2, 8);
    const redLamp = new THREE.MeshBasicMaterial({ color: '#ff2a1a' }), lampG = new THREE.SphereGeometry(0.4, 8, 6);
    for (let t = 0; t < 6000 && turbines.length < 14; t++) {
      const x = (cr() * 2 - 1) * (EXT - 250), z = (cr() * 2 - 1) * (EXT - 250), h = groundAt(x, z);
      if (h < 75 || h > 200 || inTown(x, z, 1.6) || !openAt(x, z, 45) || turbines.some(q => Math.hypot(q.x - x, q.z - z) < 200)) continue;
      if (turbines.length && !turbines.some(q => Math.hypot(q.x - x, q.z - z) < 520)) continue; // keep them together as a farm
      const g = new THREE.Group(); g.position.set(x, h - 1, z);
      const tw = new THREE.Mesh(towerG, white); tw.scale.y = 64; tw.castShadow = true; g.add(tw);
      const head = new THREE.Group(); head.position.y = 65; head.rotation.y = -0.6; g.add(head);
      const nac = new THREE.Mesh(nacG, white); nac.castShadow = true; head.add(nac);
      const rot = new THREE.Group(); rot.position.z = 4.4; head.add(rot);
      rot.add(new THREE.Mesh(hubG, white));
      for (let k = 0; k < 3; k++) { const bl = new THREE.Mesh(bladeG, white); bl.rotation.z = k * TAU / 3; bl.castShadow = true; rot.add(bl); }
      rot.rotation.z = cr() * TAU;
      const lamp = new THREE.Mesh(lampG, redLamp); lamp.position.set(0, 1.9, -1); head.add(lamp);
      scene.add(g); turbines.push({ x, z, rot, lamp, sp: 0.5 + cr() * 0.25 });
      solids.push({ type: 'circle', x, z, r: 2.2, h: 64, y0: h - 1, mu: 0.5 }); addFootprint(x, z, 8, true);
    }
  }
  countryTurbines = turbines; countryStats = { ponds: ponds.map(p => ({ x: p.x, z: p.z, R: p.R, rad: p.rad, n: p.n })), turbines: turbines.map(t => ({ x: t.x, z: t.z })), homes };

  // Parks and plazas in town fill with trees; forests and woods cover the hills; trees line the river
  for (const d of DISTRICTS) {
    const R = Math.max(d.ru, d.rv);
    for (let k = 0; k < (R * R) / 260; k++) {
      const q = toWorld(d, (rand() * 2 - 1) * d.ru, (rand() * 2 - 1) * d.rv);
      if (maskR(d, q.x, q.z) < 0.95 && parkAt(q.x, q.z)) addTree(q.x, q.z);
    }
  }
  for (let x = -EXT + 6; x < EXT - 6; x += 12) for (let z = -EXT + 6; z < EXT - 6; z += 12) {
    const px = x + (rand() - 0.5) * 10, pz = z + (rand() - 0.5) * 10, h = natAt(px, pz), f = forestAt(px, pz, h);
    if (f > 0.05 && rand() < f * 0.8) addTree(px, pz, h > 95 || rand() < 0.3 ? 'fir' : 'leaf', 0.9 + rand() * 0.5);
  }
  // woodland belts round each town: the streets give way to trees, then to open country
  for (const d of DISTRICTS) {
    const R = Math.max(d.ru, d.rv);
    for (let k = 0; k < (R * R) / 90; k++) {
      const q = toWorld(d, (cr() * 2 - 1) * d.ru * 1.7, (cr() * 2 - 1) * d.rv * 1.7), m = maskR(d, q.x, q.z);
      if (m < 1.03 || m > 1.7 || cr() > 0.75 * (1 - (m - 1.03) / 0.67)) continue;
      const n = 2 + (cr() * 4 | 0);
      for (let j = 0; j < n; j++) addTree(q.x + (cr() - 0.5) * 14, q.z + (cr() - 0.5) * 14, cr() < 0.55 ? 'fir' : 'leaf', 0.85 + cr() * 0.6);
    }
  }
  // Rock outcrops: boulders on the steeper open ground and scattered over the hills (own random stream, so the
  // rest of the valley is laid out exactly as before)
  {
    let rs = 90210; const rr = () => (rs = (rs * 16807) % 2147483647) / 2147483647;
    const ROCKC = ['#5e5a55', '#6b665f', '#77716a', '#54504c', '#807a70', '#6a6258'].map(C3s);
    for (let x = -EXT + 10; x < EXT - 10; x += 22) for (let z = -EXT + 10; z < EXT - 10; z += 22) {
      const px = x + (rr() - 0.5) * 18, pz = z + (rr() - 0.5) * 18, h = natAt(px, pz);
      if (h < WATER + 2 || bitsAt(px, pz)) continue;
      const sl = Math.hypot(natAt(px + 3, pz) - natAt(px - 3, pz), natAt(px, pz + 3) - natAt(px, pz - 3)) / 6;
      const want = smoothstep(0.18, 0.5, sl) * 0.75 + smoothstep(60, 160, h) * 0.12 + 0.015;
      if (rr() > want) continue;
      const n = 1 + (rr() * (sl > 0.3 ? 4 : 2) | 0);
      for (let k = 0; k < n; k++) {
        const bx = px + (rr() - 0.5) * 7, bz = pz + (rr() - 0.5) * 7, s = (0.9 + rr() * 1.8) * (k ? 0.7 : 1) * (sl > 0.3 ? 1.6 : 1);
        if (bitsAt(bx, bz) || blocked(bx, bz, s + 0.5)) continue;
        if ((sampleGrid(cIn, bx, bz) ?? 1e9) < s + 4) continue; // keep the roads (and their verges) clear
        const by = groundAt(bx, bz);
        put('rock', bx, by - s * 0.12, bz, rr() * TAU, s * (0.9 + rr() * 0.5), s * (0.75 + rr() * 0.45), s * (0.9 + rr() * 0.5), ROCKC[(rr() * ROCKC.length) | 0]);
        if (s > 0.9) solids.push({ type: 'circle', x: bx, z: bz, r: s * 0.75, h: s, y0: by - 0.2, mu: 0.7 });
      }
    }
  }
  lap('trees');

  /* ================= Street lights ================= */
  for (const r of roads) {
    if (!(r.kind === 'art' || r.kind === 'dt' || fullWalk(r)) || !r.zone) continue;
    const fr = frames(r.pts), L = linkLen(r.pts);
    let side = 1;
    for (let s = PATCH + 12; s < L - PATCH - 8; s += 42) {
      const lo = fullWalk(r) ? 4.6 : 5.2, p = pointAt(fr, s), q = { x: p.x + p.rx * side * lo, z: p.z + p.rz * side * lo }, toward = { x: -p.rx * side, z: -p.rz * side };
      side = -side;
      if ((bitsAt(q.x, q.z) & WALK) && !fullWalk(r)) continue;
      const yaw = yawTo(toward.x, toward.z), y = p.y;
      put('pole', q.x, y, q.z, 0, 1, 8, 1); put('arm', q.x, y + 7.9, q.z, yaw, 1, 1, 2.2);
      put('lamp', q.x + toward.x * 2.2, y + 7.8, q.z + toward.z * 2.2, yaw, 1, 1, 1);
      solids.push({ type: 'circle', x: q.x, z: q.z, r: 0.14, h: 8, y0: y, mu: 0.4 });
    }
  }

  /* ================= Freeway furniture ================= */
  for (let j = TAPER + 2; j < NF - TAPER - 2; j++) {
    const p = fpts[j], yaw = yawTo(p.tx, p.tz), rx = -p.tz, rz = p.tx;
    put('jersey', p.x, p.y, p.z, yaw, 1, 1, 1);
    solidBox(p.x, p.z, 0.3, 2.05, p.y, 0.82, rx, rz, 0.45);
    if (j % 20 === 0) {
      put('pole', p.x, p.y + 0.8, p.z, 0, 1.3, 10, 1.3);
      for (const sg of [1, -1]) { const ay = yawTo(rx * sg, rz * sg); put('arm', p.x, p.y + 10.6, p.z, ay, 1, 1, 2.6); put('lamp', p.x + rx * sg * 2.6, p.y + 10.5, p.z + rz * sg * 2.6, ay, 1, 1, 1); }
    }
  }
  // Exit signs on the right shoulder 400 m before each off-ramp, and "freeway ends" warnings
  const signPost = new THREE.CylinderGeometry(0.12, 0.12, 6.4, 8).translate(0, 3.2, 0);
  function bigSign(q, lines, color = '#0f6b3d') {
    const tex = canvasTex(512, 256, g => {
      g.fillStyle = color; g.fillRect(0, 0, 512, 256); g.strokeStyle = '#f2f2ee'; g.lineWidth = 8; g.strokeRect(10, 10, 492, 236);
      g.fillStyle = '#f2f2ee'; g.textAlign = 'center';
      lines.forEach(([txt, size, y]) => { g.font = `700 ${size}px "Chakra Petch", Arial, sans-serif`; g.fillText(txt, 256, y); });
    });
    const yaw = yawTo(-q.tx, -q.tz);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 2.6), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
    board.position.set(q.x, q.y + 5.6, q.z); board.rotation.y = yaw; scene.add(board);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 2.6), poleMat); back.position.copy(board.position); back.rotation.y = yaw + Math.PI; scene.add(back);
    for (const sg of [-1.8, 1.8]) {
      const px = q.x - q.tz * sg, pz = q.z + q.tx * sg, gy = heightAt(px, pz, q.y);
      const post = new THREE.Mesh(signPost, poleMat); post.position.set(px, gy, pz); post.castShadow = true; scene.add(post);
      solids.push({ type: 'circle', x: px, z: pz, r: 0.14, h: 6.4, y0: gy, mu: 0.4 });
    }
  }
  for (const n of nodes) if (n.exit) bigSign(n.exit.at(n.exit.j - 100, laneOff(0) + 6.6), [['EXIT ' + n.exit.no, 46, 78], [n.exit.name, n.exit.name.length > 12 ? 50 : 62, 160], ['400 m', 40, 222]]);
  for (const dir of [1, -1]) {
    const j = dir > 0 ? NF - 1 - TAPER - 120 : TAPER + 120, p = fpts[j], tx = p.tx * dir, tz = p.tz * dir, off = laneOff(0) + 6.6;
    bigSign({ x: p.x - tz * off, z: p.z + tx * off, y: p.y, tx, tz }, [['FREEWAY', 52, 92], ['ENDS', 52, 152], ['500 m', 40, 216]], '#1d4f8f');
  }

  /* ================= Stop signs and traffic lights ================= */
  const stopTex = canvasTex(128, 128, g => {
    for (const [rad, col] of [[64, '#ffffff'], [58, '#b8191c']]) { g.fillStyle = col; g.beginPath(); for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + i * Math.PI / 4; g.lineTo(64 + Math.cos(a) * rad, 64 + Math.sin(a) * rad); } g.fill(); }
    g.fillStyle = '#ffffff'; g.font = '700 38px "Chakra Petch", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('STOP', 64, 66);
  });
  defType('signFace', new THREE.PlaneGeometry(0.78, 0.78), new THREE.MeshStandardMaterial({ map: stopTex, transparent: true, alphaTest: 0.5, roughness: 0.6 }), { shadow: false });
  defType('signBack', new THREE.CircleGeometry(0.39, 8, Math.PI / 8).rotateY(Math.PI), new THREE.MeshStandardMaterial({ color: '#8d8f94', roughness: 0.6 }), { shadow: false });
  defType('signPost', new THREE.BoxGeometry(0.07, 1, 0.07).translate(0, 0.5, 0), poleMat, { shadow: false });
  defType('sigPole', new THREE.CylinderGeometry(0.12, 0.16, 6, 8).translate(0, 3, 0), poleMat, { shadow: false });
  defType('sigArm', new THREE.BoxGeometry(0.1, 0.1, 1).translate(0, 0, 0.5), poleMat, { shadow: false });
  defType('sigHead', new THREE.BoxGeometry(0.42, 1.1, 0.3).translate(0, 0.55, 0), new THREE.MeshStandardMaterial({ color: '#25262b', roughness: 0.6 }), { shadow: false });
  const lampList = [];
  for (const L of links) {
    const lane = L.lanes[0];
    if (L.kind === 'fwy' || lane.control === 'none') continue;
    const e = lane.pts[lane.pts.length - 1], d = lane.dir, r = { x: -d.z, z: d.x }, yaw = yawTo(-d.x, -d.z);
    const rOff = L.kind === 'ramp' ? 3.4 : 3.6;
    if (lane.control === 'stop') {
      const q = { x: e.x + r.x * rOff - d.x * 0.5, z: e.z + r.z * rOff - d.z * 0.5 }, y = groundAt(q.x, q.z);
      put('signPost', q.x, y, q.z, yaw, 1, 2.2, 1); put('signFace', q.x - d.x * 0.05, y + 2.4, q.z - d.z * 0.05, yaw, 1, 1, 1); put('signBack', q.x, y + 2.4, q.z, yaw, 1, 1, 1);
      solids.push({ type: 'circle', x: q.x, z: q.z, r: 0.06, h: 2.8, y0: y, mu: 0.4 });
    } else {
      const pole = { x: e.x + d.x * 1.5 + r.x * rOff, z: e.z + d.z * 1.5 + r.z * rOff }, y = e.y;
      put('sigPole', pole.x, y - 0.3, pole.z, 0, 1, 1, 1);
      put('sigArm', pole.x, y + 5.6, pole.z, yawTo(-r.x, -r.z), 1, 1, rOff + 0.4);
      solids.push({ type: 'circle', x: pole.x, z: pole.z, r: 0.16, h: 6, y0: y - 0.3, mu: 0.4 });
      for (const [hx, hz, hy] of [[pole.x - r.x * rOff, pole.z - r.z * rOff, y + 4.9], [pole.x, pole.z, y + 2.6]]) {
        put('sigHead', hx, hy - 0.55, hz, yaw, 1, 1, 1);
        ['R', 'Y', 'G'].forEach((k, i) => lampList.push({ node: L.to, axis: lane.axis, k, x: hx - d.x * 0.16, y: hy + 0.34 - i * 0.34, z: hz - d.z * 0.16, yaw }));
      }
    }
  }
  // All signal lamps share one instanced mesh whose colours are rewritten every frame
  const lampMesh = new THREE.InstancedMesh(new THREE.CircleGeometry(0.13, 12), new THREE.MeshBasicMaterial({ toneMapped: false }), Math.max(1, lampList.length));
  lampMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, lampList.length) * 3), 3);
  lampMesh.frustumCulled = false;
  lampList.forEach((l, i) => { Q.setFromEuler(E.set(0, l.yaw, 0)); lampMesh.setMatrixAt(i, M4.compose(V.set(l.x, l.y, l.z), Q, S.set(1, 1, 1))); });
  scene.add(lampMesh);
  const LAMP_ON = { R: [1, 0.12, 0.05], Y: [1, 0.66, 0.08], G: [0.2, 1, 0.55] }, LAMP_OFF = [0.07, 0.06, 0.06];

  meshFrom(B.art, mats.art); meshFrom(B.res, mats.res); meshFrom(B.rural, mats.rural); meshFrom(B.hwy, mats.hwy); meshFrom(B.ramp, mats.ramp);
  meshFrom(B.walk, mats.concrete); meshFrom(B.walkBase, mats.concreteBase); meshFrom(B.patch, mats.patch); meshFrom(B.paint, mats.paint); meshFrom(B.fwy, mats.fwy); meshFrom(B.wall, mats.wall, true);
  flush();
  buildHLOD();
  lap('scenery');

  /* ================= Spawn cells for traffic ================= */
  const cells = [], CG = 100, cellHash = new Map(), ckey = (i, j) => (i + 512) * 1024 + (j + 512);
  for (const L of links) for (const lane of L.lanes) {
    const pts = lane.pts, step = L.kind === 'fwy' ? 5 : 10;
    const last = L.kind === 'fwy' && L.to.type !== 'fwy' && lane.index === 1 ? pts.length - 60 : pts.length - 8; // not where the left lane is about to end
    for (let si = 4; si < last; si += step) {
      const p = pts[si], c = { link: L, lane: lane.index, si, x: p.x, y: p.y || 0, z: p.z, w: DENSITY[L.kind] * step * (L.kind === 'fwy' ? 4 : 2) / 1000 };
      cells.push(c);
      const k = ckey(Math.floor(p.x / CG), Math.floor(p.z / CG)); if (!cellHash.has(k)) cellHash.set(k, []); cellHash.get(k).push(c);
    }
  }
  function cellsNear(x, z, r, out) {
    out.length = 0;
    for (let i = Math.floor((x - r) / CG); i <= Math.floor((x + r) / CG); i++) for (let j = Math.floor((z - r) / CG); j <= Math.floor((z + r) / CG); j++) {
      const l = cellHash.get(ckey(i, j)); if (l) for (const c of l) if ((c.x - x) ** 2 + (c.z - z) ** 2 < r * r) out.push(c);
    }
    return out;
  }
  const tmpCells = [];
  function nearestLanePose(x, z, y = 0) {
    for (const R of [300, 900]) {
      cellsNear(x, z, R, tmpCells);
      let best = null, bd = Infinity;
      for (const c of tmpCells) { if (c.link.kind === 'ramp') continue; const d = (c.x - x) ** 2 + (c.z - z) ** 2 + ((c.y - y) * 3) ** 2; if (d < bd) { bd = d; best = c; } }
      if (!best) continue;
      const pts = best.link.lanes[best.lane].pts, a = pts[best.si], b = pts[best.si + 1];
      return { x: a.x, z: a.z, y: a.y || 0, h: Math.atan2(b.x - a.x, b.z - a.z), speed: best.link.speed, kind: best.link.kind, d: Math.sqrt(bd) };
    }
    return null;
  }

  /* ================= Map data ================= */
  const riverLine = [];
  for (let E = -VIEW; E <= VIEW; E += 20) riverLine.push(P(E, riverN(E)));
  const mapLines = [{ pts: riverLine, kind: 'river' }].concat(roads.map(r => ({ pts: r.pts, kind: r.kind })), [{ pts: fpts, kind: 'fwy' }]);
  const labels = DISTRICTS.map(d => ({ name: d.name, x: d.ctr.x, z: d.ctr.z, kind: d.zone(0) === 'vil' ? 'village' : 'town' }))
    .concat([{ name: 'Ash River', ...P(-1300, riverN(-1300) - 70), kind: 'river' }, { name: 'I-9', ...fpts[Math.round(NF * 0.62)], kind: 'road' }]);
  // Start downtown, on the street nearest the centre
  let startLink = null, sd = Infinity;
  const dtc = byName['Port Ashby'].ctr;
  for (const L of links) {
    if (L.kind !== 'dt' && L.kind !== 'art') continue;
    const m = L.lanes[0].pts[L.lanes[0].pts.length >> 1], d = Math.hypot(m.x - dtc.x, m.z - dtc.z);
    if (L.lanes[0].pts.length > 20 && d < sd) { sd = d; startLink = L; }
  }
  const sp = startLink.lanes[0].pts, s0 = sp[Math.floor(sp.length / 2)], s1 = sp[Math.floor(sp.length / 2) + 1];

  updateTerrain(s0.x, s0.z, 1e9);
  lap('done');

  return {
    nodes, links, roads, conns, R_INT, EXT, LW, WATER, mapLines, labels, props,
    start: { x: s0.x, z: s0.z, y: s0.y, h: Math.atan2(s1.x - s0.x, s1.z - s0.z) },
    route, randomDestination, signalState, conflicts, heightAt, groundAt, cellsNear, nearestLanePose,
    /** On a pavement or driveway (not the road itself)? */
    walkAt(x, z) { const b = bitsAt(x, z); return !!(b & WALK) && !(b & PAVED); },
    /** Bare ground that would grow grass: not road, pavement or driveway, not water, not under a building. 0 (none) to 1 (lush) */
    grassAt(x, z) {
      if (Math.abs(x) > EXT - 2 || Math.abs(z) > EXT - 2 || bitsAt(x, z)) return 0;
      // keep a margin off every paved edge (the raster is 2 m)
      if (bitsAt(x + 1.2, z) || bitsAt(x - 1.2, z) || bitsAt(x, z + 1.2) || bitsAt(x, z - 1.2)) return 0;
      const g = groundAt(x, z); if (g < WATER + 0.4) return 0;
      if (blocked(x, z, 0.4, true)) return 0;
      return 1 - 0.6 * forestAt(x, z, g);
    },
    surfaceAt(x, z, y = -Infinity) {
      const g = groundAt(x, z);
      if (y > g + 0.8 && heightAt(x, z, y) > g + 0.5) return 'asphalt'; // on a bridge
      if (bitsAt(x, z) & (PAVED | WALK)) return 'asphalt';
      if (pondHeight(x, z) > -Infinity) return 'ice';
      return g < WATER - 0.3 ? (WINTER ? 'ice' : 'water') : 'grass';
    },
    WINTER, get country() { return countryStats; }, parkedSpots, forestAt: (x, z) => forestAt(x, z, groundAt(x, z)), WATER_LEVEL: WATER,
    /** Hide a parked stand-in (its instances and its solid) while a real car stands in its place, or bring it back */
    swapParked(spot, hide) {
      spot.swapped = hide;
      for (const it of spot.items) {
        if (!it.mesh) continue;
        if (hide) it.mesh.setMatrixAt(it.index, M4.makeScale(0, 0, 0));
        else { Q.setFromEuler(E.set(0, it.yaw, 0)); it.mesh.setMatrixAt(it.index, M4.compose(V.set(it.x, it.y, it.z), Q, S.set(it.sx, it.sy, it.sz))); }
        it.mesh.instanceMatrix.needsUpdate = true;
      }
      const o = spot.solid;
      if (hide) { o.x = o.z = 1e7; o.h = 0; } else { o.x = spot.home.x; o.z = spot.home.z; o.h = spot.home.h; }
    },
    propsNear(x, z, r, out) {
      out.length = 0;
      for (let i = Math.floor((x - r) / PG); i <= Math.floor((x + r) / PG); i++) for (let j = Math.floor((z - r) / PG); j <= Math.floor((z + r) / PG); j++) {
        const l = propHash.get(pkey(i, j)); if (l) for (const p of l) if (!p.down) out.push(p);
      }
      return out;
    },
    // Swap an instanced prop for a loose mesh the physics can throw around
    knockProp(p) {
      p.down = true;
      for (const it of p.items) { it.mesh.setMatrixAt(it.index, M4.makeScale(0, 0, 0)); it.mesh.instanceMatrix.needsUpdate = true; }
      const g = new THREE.Group();
      if (p.kind === 'mail') g.add(new THREE.Mesh(PROP_GEO.mailPost, postMat), new THREE.Mesh(PROP_GEO.mailBox, mailMat));
      else { const m = new THREE.Mesh(PROP_GEO.bin, binMat.clone()); m.material.color.copy(p.color); g.add(m); }
      g.children.forEach(m => { m.castShadow = true; });
      g.position.set(p.x, p.y, p.z); g.rotation.y = p.yaw;
      scene.add(g);
      return g;
    },
    restoreProp(p, g) {
      p.down = false; scene.remove(g);
      for (const it of p.items) { Q.setFromEuler(E.set(0, it.yaw, 0)); it.mesh.setMatrixAt(it.index, M4.compose(V.set(it.x, it.y, it.z), Q, S.set(1, 1, 1))); it.mesh.instanceMatrix.needsUpdate = true; }
    },
    // Hide chunks beyond their type's view distance, and keep fine terrain around the camera
    cull(cam) {
      for (const c of hlChunks.values()) {
        const d = cam.distanceTo(c.center) - c.radius;
        c.near = d < c.dist;
        if (c.mesh) c.mesh.visible = !c.near && d < 6000;
      }
      for (const m of chunkMeshes) {
        const s = m.userData.sphere, d = cam.distanceTo(s.center) - s.radius;
        m.visible = d < m.userData.far && d >= m.userData.near && (!m.userData.hl || m.userData.hl.near || !m.userData.hl.mesh);
        if (m.userData.cs) m.castShadow = d < (m.userData.tall ? 320 : m.userData.tree ? 170 : 170); // the shadow map only covers ~100 m round the car
      }
      updateTerrain(cam.x, cam.z, 3);
    },
    update(dt) {
      for (const t of countryTurbines) { t.rot.rotation.z += dt * t.sp; t.lamp.visible = (clock + t.sp * 3) % 2 < 0.3; }
      clock += dt; windTime.value = clock;
      ripple.offset.set(clock * 0.004, clock * 0.0025);
      const col = lampMesh.instanceColor;
      for (let i = 0; i < lampList.length; i++) { const l = lampList[i], c = signalState(l.node, l.axis) === l.k ? LAMP_ON[l.k] : LAMP_OFF; col.setXYZ(i, c[0], c[1], c[2]); }
      col.needsUpdate = true;
    },
    stats: { ...stats, why, houses, buildings, parked, trees: treeCount, nodes: nodes.length, links: links.length, roads: roads.length, solids: solids.length, props: props.length, lamps: lampList.length, timing,
      km: Math.round((roads.reduce((s, r) => s + linkLen(r.pts), 0) + linkLen(fpts)) / 100) / 10 },
  };
};
})();
