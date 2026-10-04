/*
 * Soft-body crash structure.
 *
 * A regular lattice of nodes in the car's local frame, joined by beams (every node to its 26 neighbours).
 * Beams are solved with XPBD, yield plastically past a strain limit (permanent deformation),
 * bottom out when crushed flat, and tear when overstretched. A few chassis nodes are pinned to the
 * rigid body. The force obstacles exert on the contacting nodes is handed back to the rigid body, so the car
 * decelerates exactly as hard as its structure resists being crushed.
 *
 * The visible meshes are not simulated directly: each vertex is bound to its lattice cell and moved by
 * trilinear interpolation of the node displacements (free-form deformation), plus a wrinkle term that
 * grows with local damage so crushed panels look folded rather than smoothly dented.
 */
(function () {
'use strict';

const OFFSETS = [];
for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
  if (dk > 0 || (dk === 0 && dj > 0) || (dk === 0 && dj === 0 && di > 0)) OFFSETS.push([di, dj, dk]);
}
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

class SoftBody {
  /**
   * cfg: { min: [x,y,z], max: [x,y,z], dims: [nx,ny,nz], nodeMass, axial, yieldForce,
   *        pinned(i,j,k) -> bool, strength(ax,ay,az,bx,by,bz) -> multiplier,
   *        minRatio, tearStrain, nodeRadius, iterations }
   */
  constructor(cfg) {
    this.cfg = cfg;
    const [nx, ny, nz] = cfg.dims;
    Object.assign(this, { nx, ny, nz });
    this.min = cfg.min; this.max = cfg.max;
    this.step3 = [0, 1, 2].map(a => (cfg.max[a] - cfg.min[a]) / (cfg.dims[a] - 1));
    const N = this.N = nx * ny * nz;
    this.rest = new Float32Array(N * 3);
    this.p = new Float32Array(N * 3);
    this.pp = new Float32Array(N * 3);
    this.u = new Float32Array(N * 3);
    this.w = new Float32Array(N);
    this.dmg = new Float32Array(N);        // |displacement| per node, metres
    // Stack-up limits: crushed structure piles up against the passenger cell instead of passing through it
    this.lim = new Float32Array(N * 3).fill(0);
    this.disp = new Float32Array(N * 3);
    this.scuff = new Float32Array(N);      // 0..1 paint worn off by sliding contact
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const n = this.idx(i, j, k);
      this.rest[n * 3] = cfg.min[0] + i * this.step3[0];
      this.rest[n * 3 + 1] = cfg.min[1] + j * this.step3[1];
      this.rest[n * 3 + 2] = cfg.min[2] + k * this.step3[2];
      this.w[n] = cfg.pinned(i, j, k) ? 0 : 1 / cfg.nodeMass;
      const b = cfg.bounds ? cfg.bounds(this.rest[n * 3], this.rest[n * 3 + 1], this.rest[n * 3 + 2]) : [-1e9, 1e9, 0];
      this.lim[n * 3] = b[0]; this.lim[n * 3 + 1] = b[1]; this.lim[n * 3 + 2] = b[2];
    }
    const A = [], B = [], S = [];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      for (const [di, dj, dk] of OFFSETS) {
        const i2 = i + di, j2 = j + dj, k2 = k + dk;
        if (i2 < 0 || j2 < 0 || k2 < 0 || i2 >= nx || j2 >= ny || k2 >= nz) continue;
        const a = this.idx(i, j, k), b = this.idx(i2, j2, k2);
        if (this.w[a] === 0 && this.w[b] === 0) continue;
        const r = this.rest;
        A.push(a); B.push(b);
        S.push(cfg.strength(r[a * 3], r[a * 3 + 1], r[a * 3 + 2], r[b * 3], r[b * 3 + 1], r[b * 3 + 2]));
      }
    }
    const M = this.M = A.length;
    this.ba = Int32Array.from(A); this.bb = Int32Array.from(B);
    this.len0 = new Float32Array(M); this.len = new Float32Array(M);
    this.k = new Float32Array(M); this.fy = new Float32Array(M); this.ey = new Float32Array(M);
    this.torn = new Uint8Array(M); this.lambda = new Float32Array(M);
    for (let m = 0; m < M; m++) {
      const a = A[m] * 3, b = B[m] * 3, r = this.rest;
      const L = Math.hypot(r[b] - r[a], r[b + 1] - r[a + 1], r[b + 2] - r[a + 2]);
      this.len0[m] = L;
      this.k[m] = cfg.axial * S[m] / L;          // axial stiffness EA/L
      this.fy[m] = cfg.yieldForce * S[m];        // force at which the beam starts to yield
      this.ey[m] = this.fy[m] / (this.k[m] * L); // matching yield strain
    }
    this.out = { fx: 0, fz: 0, tq: 0, contacts: 0, work: 0, slip: 0, depth: 0, points: [] };
    this.reset();
  }

  idx(i, j, k) { return (k * this.ny + j) * this.nx + i; }

  reset() {
    this.p.set(this.rest); this.pp.set(this.rest); this.u.fill(0);
    this.len.set(this.len0); this.torn.fill(0);
    this.dmg.fill(0); this.disp.fill(0); this.scuff.fill(0);
    this.sleeping = true; this.version = (this.version || 0) + 1;
    this.tornCount = 0;
  }

  /**
   * Advance one rigid-body step. `obs` holds nearby obstacles already expressed in the car's frame at the
   * start (c0x/c0z, a0x/a0z) and end (c1x/c1z, a1x/a1z) of the step, so the substeps can sweep them.
   */
  step(dt, obs) {
    const out = this.out;
    out.fx = out.fz = out.tq = 0; out.contacts = 0; out.work = 0; out.slip = 0; out.depth = 0; out.points.length = 0;
    if (!obs.length && this.sleeping) return out;

    const { p, pp, u, w, ba, bb, len, len0, k, fy, ey, torn, lambda, rest } = this;
    const cfg = this.cfg, N = this.N, M = this.M, nr = cfg.nodeRadius;
    // more substeps when obstacles sweep a long way through the lattice in one step
    let sweep = 0;
    for (const o of obs) sweep = Math.max(sweep, Math.hypot(o.c1x - o.c0x, o.c1z - o.c0z));
    const nsub = Math.min(10, Math.max(2, Math.ceil(sweep / 0.025)));
    const h = dt / nsub, ih = 1 / h;
    const damp = Math.exp(-6 * h);
    let fx = 0, fz = 0, tq = 0, work = 0, contacts = 0, slip = 0, depth = 0;
    for (const o of obs) { o.ix = o.iz = o.it = o.cw = o.cpx = o.cpz = 0; } // per-obstacle impulse and contact centroid

    for (let s = 0; s < nsub; s++) {
      const t0 = s / nsub, t1 = (s + 1) / nsub;
      for (const o of obs) {
        o.pcx = o.c0x + (o.c1x - o.c0x) * t0; o.pcz = o.c0z + (o.c1z - o.c0z) * t0;
        o.cx = o.c0x + (o.c1x - o.c0x) * t1; o.cz = o.c0z + (o.c1z - o.c0z) * t1;
        if (o.type === 'box') {
          let ax = o.a0x + (o.a1x - o.a0x) * t1, az = o.a0z + (o.a1z - o.a0z) * t1;
          const l = Math.hypot(ax, az); ax /= l; az /= l;
          o.ax = ax; o.az = az; o.bx = -az; o.bz = ax;
        }
      }
      // predict
      for (let n = 0; n < N; n++) {
        if (w[n] === 0) continue;
        const i = n * 3;
        pp[i] = p[i]; pp[i + 1] = p[i + 1]; pp[i + 2] = p[i + 2];
        p[i] += u[i] * h; p[i + 1] += u[i + 1] * h; p[i + 2] += u[i + 2] * h;
      }
      lambda.fill(0);
      for (let it = 0; it < cfg.iterations; it++) {
        // beams (XPBD distance constraints)
        for (let m = 0; m < M; m++) {
          if (torn[m]) continue;
          const a = ba[m], b = bb[m], wa = w[a], wb = w[b];
          const ia = a * 3, ib = b * 3;
          const dx = p[ib] - p[ia], dy = p[ib + 1] - p[ia + 1], dz = p[ib + 2] - p[ia + 2];
          const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (L < 1e-6) continue;
          const at = 1 / (k[m] * h * h);
          const dl = (-(L - len[m]) - at * lambda[m]) / (wa + wb + at);
          lambda[m] += dl;
          const sx = dx / L * dl, sy = dy / L * dl, sz = dz / L * dl;
          if (wa) { p[ia] -= wa * sx; p[ia + 1] -= wa * sy; p[ia + 2] -= wa * sz; }
          if (wb) { p[ib] += wb * sx; p[ib + 1] += wb * sy; p[ib + 2] += wb * sz; }
        }
        // contacts (hard, with Coulomb friction on the last pass)
        const last = it === cfg.iterations - 1;
        for (const o of obs) {
          for (let n = 0; n < N; n++) {
            if (w[n] === 0) continue;
            const i = n * 3;
            if (p[i + 1] > o.h || p[i + 1] < o.y0) continue;
            const dx = p[i] - o.cx, dz = p[i + 2] - o.cz;
            let nx, nz, d;
            if (o.type === 'circle') {
              const R = o.r + nr, dd = dx * dx + dz * dz;
              if (dd >= R * R) continue;
              const dist = Math.sqrt(dd) || 1e-6;
              nx = dx / dist; nz = dz / dist; d = R - dist;
            } else {
              const qx = dx * o.ax + dz * o.az, qz = dx * o.bx + dz * o.bz;
              const ex = o.hx + nr - Math.abs(qx), ez = o.hz + nr - Math.abs(qz);
              if (ex <= 0 || ez <= 0) continue;
              if (ex < ez) { const sg = Math.sign(qx) || 1; nx = o.ax * sg; nz = o.az * sg; d = ex; }
              else { const sg = Math.sign(qz) || 1; nx = o.bx * sg; nz = o.bz * sg; d = ez; }
            }
            p[i] += nx * d; p[i + 2] += nz * d;
            const mN = 1 / w[n], jn = d * mN * ih;
            fx += nx * jn; fz += nz * jn; tq += (nx * p[i + 2] - nz * p[i]) * jn;
            o.ix += nx * jn; o.iz += nz * jn; o.it += (nx * p[i + 2] - nz * p[i]) * jn;
            o.cw += d; o.cpx += p[i] * d; o.cpz += p[i + 2] * d;
            if (!last) continue;
            // friction: cancel tangential slip relative to the obstacle, limited by mu * normal correction
            const rx = (p[i] - pp[i]) - (o.cx - o.pcx), rz = (p[i + 2] - pp[i + 2]) - (o.cz - o.pcz);
            const rn = rx * nx + rz * nz;
            const tx = rx - rn * nx, tz = rz - rn * nz, tl = Math.hypot(tx, tz);
            if (tl > 1e-7) {
              const lim = o.mu * d, f = tl <= lim ? 1 : lim / tl;
              p[i] -= tx * f; p[i + 2] -= tz * f;
              const jt = f * mN * ih;
              fx -= tx * jt; fz -= tz * jt; tq -= (tx * p[i + 2] - tz * p[i]) * jt;
              o.ix -= tx * jt; o.iz -= tz * jt; o.it -= (tx * p[i + 2] - tz * p[i]) * jt;
            }
            contacts++;
            const sl = tl * ih;
            this.scuff[n] = Math.min(1, this.scuff[n] + tl * 0.6); slip = Math.max(slip, sl); depth = Math.max(depth, d);
            if (s === nsub - 1 && out.points.length < 24) out.points.push({ x: p[i], y: p[i + 1], z: p[i + 2], nx, nz, slip: sl, d });
          }
        }
      }
      // stack-up limits
      const lim = this.lim;
      for (let n = 0; n < N; n++) {
        if (w[n] === 0) continue;
        const i = n * 3;
        if (p[i + 2] < lim[i]) p[i + 2] = lim[i];
        else if (p[i + 2] > lim[i + 1]) p[i + 2] = lim[i + 1];
        if (lim[i + 2] > 0 && Math.abs(p[i]) < lim[i + 2]) p[i] = Math.sign(rest[i]) * lim[i + 2];
      }
      // velocities
      for (let n = 0; n < N; n++) {
        if (w[n] === 0) continue;
        const i = n * 3;
        u[i] = (p[i] - pp[i]) * ih * damp; u[i + 1] = (p[i + 1] - pp[i + 1]) * ih * damp; u[i + 2] = (p[i + 2] - pp[i + 2]) * ih * damp;
      }
      // plasticity and tearing
      for (let m = 0; m < M; m++) {
        if (torn[m]) continue;
        const a = ba[m], b = bb[m], ia = a * 3, ib = b * 3;
        const dx = p[ib] - p[ia], dy = p[ib + 1] - p[ia + 1], dz = p[ib + 2] - p[ia + 2];
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const L0 = len0[m];
        if (L > L0 * (1 + cfg.tearStrain)) { torn[m] = 1; this.tornCount++; continue; }
        const lim = ey[m] * L0;
        let e = L - len[m];
        const floor = L0 * cfg.minRatio;
        if (e > lim) { const d = e - lim; len[m] += d; work += fy[m] * d; e = lim; }
        else if (e < -lim && len[m] > floor) {
          const nl = Math.max(floor, L + lim), d = len[m] - nl;
          len[m] = nl; work += fy[m] * d; e = L - nl;
        }
      }
    }

    // fx/fz/tq hold impulses; report the average force over the step
    out.fx = fx / dt; out.fz = fz / dt; out.tq = tq / dt;
    out.contacts = contacts; out.work = work; out.slip = slip; out.depth = depth;

    let vmax = 0;
    for (let i = 0; i < N * 3; i++) vmax = Math.max(vmax, Math.abs(u[i]));
    this.sleeping = !obs.length && vmax < 2e-3;
    if (!this.sleeping || work > 0) this.version++;
    return out;
  }

  /** Refresh per-node displacement and damage; call once per rendered frame. */
  refresh() {
    if (this.refreshed === this.version) return false;
    this.refreshed = this.version;
    const { p, rest, disp, dmg } = this;
    let total = 0;
    for (let n = 0; n < this.N; n++) {
      const i = n * 3;
      disp[i] = p[i] - rest[i]; disp[i + 1] = p[i + 1] - rest[i + 1]; disp[i + 2] = p[i + 2] - rest[i + 2];
      dmg[n] = Math.hypot(disp[i], disp[i + 1], disp[i + 2]);
      total += dmg[n];
    }
    this.damage = Math.min(1, total / (this.N * 0.25));
    return true;
  }

  cell(x, y, z, outArr, o) {
    const { nx, ny, nz, min, step3 } = this;
    let fx = (x - min[0]) / step3[0], fy = (y - min[1]) / step3[1], fz = (z - min[2]) / step3[2];
    fx = Math.min(nx - 1.0001, Math.max(0, fx)); fy = Math.min(ny - 1.0001, Math.max(0, fy)); fz = Math.min(nz - 1.0001, Math.max(0, fz));
    const i = fx | 0, j = fy | 0, k = fz | 0;
    outArr[o] = fx - i; outArr[o + 1] = fy - j; outArr[o + 2] = fz - k;
    return this.idx(i, j, k);
  }

  /** Displacement, damage [3] and scuff [4] at a local point; `res` is a length-5 array. */
  sample(x, y, z, res) {
    const f = this._f || (this._f = new Float32Array(3));
    const base = this.cell(x, y, z, f, 0);
    this._tri(base, f[0], f[1], f[2], res);
    return res;
  }

  _tri(base, tx, ty, tz, res) {
    const { disp, dmg, scuff, nx } = this, sy = nx, sz = nx * this.ny;
    let rx = 0, ry = 0, rz = 0, rd = 0, rs = 0;
    for (let c = 0; c < 8; c++) {
      const ci = c & 1, cj = (c >> 1) & 1, ck = c >> 2;
      const wgt = (ci ? tx : 1 - tx) * (cj ? ty : 1 - ty) * (ck ? tz : 1 - tz);
      if (wgt === 0) continue;
      const n = base + ci + cj * sy + ck * sz, i = n * 3;
      rx += disp[i] * wgt; ry += disp[i + 1] * wgt; rz += disp[i + 2] * wgt; rd += dmg[n] * wgt; rs += scuff[n] * wgt;
    }
    res[0] = rx; res[1] = ry; res[2] = rz; res[3] = rd; res[4] = rs;
  }

  /**
   * Bind a geometry whose vertices are in car-local coordinates.
   * opts: { color: [r,g,b], scrape: [r,g,b] | null, crack: [r,g,b] | null, wrinkle: metres }
   */
  bind(geometry, opts = {}) {
    const pos = geometry.attributes.position, n = pos.count;
    const restP = Float32Array.from(pos.array);
    const base = new Int32Array(n), fr = new Float32Array(n * 3), noise = new Float32Array(n), dir = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) {
      const x = restP[v * 3], y = restP[v * 3 + 1], z = restP[v * 3 + 2];
      base[v] = this.cell(x, y, z, fr, v * 3);
      // smooth, irregular field: decides where panels buckle in or out
      noise[v] = 0.55 * Math.sin(23.1 * x + 17.3 * z + 1.3) * Math.sin(19.7 * y - 13.1 * z + 0.7)
               + 0.45 * Math.sin(29.3 * z + 11.7 * y + 2.1 * Math.sin(13 * x));
      // wrinkle direction depends on position only, so separate meshes stay stitched together
      const dx = x, dy = (y - 0.8) * 1.6, dz = z * 0.35, l = Math.hypot(dx, dy, dz) || 1;
      dir[v * 3] = dx / l; dir[v * 3 + 1] = dy / l; dir[v * 3 + 2] = dz / l;
    }
    const col = opts.color || [1, 1, 1];
    const colors = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) colors.set(col, v * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('rest', new THREE.BufferAttribute(Float32Array.from(restP), 3)); // undeformed position, for panel details
    pos.setUsage(THREE.DynamicDrawUsage);
    geometry.computeVertexNormals();
    return { geometry, restP, base, fr, noise, dir, colors, col, scrape: opts.scrape || null, crack: opts.crack || null, wrinkle: opts.wrinkle ?? 0.03, live: true };
  }

  deform(bd) {
    const { restP, base, fr, noise, dir, colors, col, scrape, crack, wrinkle } = bd;
    const arr = bd.geometry.attributes.position.array, n = restP.length / 3;
    const r = this._r || (this._r = new Float32Array(5));
    for (let v = 0; v < n; v++) {
      const i = v * 3;
      this._tri(base[v], fr[i], fr[i + 1], fr[i + 2], r);
      const d = r[3];
      const wr = wrinkle * smoothstep(0.02, 0.28, d) * noise[v];
      arr[i] = restP[i] + r[0] + dir[i] * wr;
      arr[i + 1] = restP[i + 1] + r[1] + dir[i + 1] * wr;
      arr[i + 2] = restP[i + 2] + r[2] + dir[i + 2] * wr;
      let c0 = col[0], c1 = col[1], c2 = col[2];
      if (scrape) {
        const t = Math.max(smoothstep(0.06, 0.4, d) * smoothstep(-0.3, 0.7, noise[v]) * 0.85, // paint flakes off the folds
                           r[4] * smoothstep(-0.6, 0.4, noise[v]) * 0.8);                     // and scuffs where it slid
        c0 += (scrape[0] - c0) * t; c1 += (scrape[1] - c1) * t; c2 += (scrape[2] - c2) * t;
      }
      if (crack) {
        const t = smoothstep(0.05, 0.16, d) * (0.6 + 0.4 * Math.abs(noise[v]));
        c0 += (crack[0] - c0) * t; c1 += (crack[1] - c1) * t; c2 += (crack[2] - c2) * t;
      }
      colors[i] = c0; colors[i + 1] = c1; colors[i + 2] = c2;
    }
    bd.geometry.attributes.position.needsUpdate = true;
    bd.geometry.attributes.color.needsUpdate = true;
    bd.geometry.computeVertexNormals();
    bd.geometry.computeBoundingSphere();
  }
}

window.SoftBody = SoftBody;
})();
