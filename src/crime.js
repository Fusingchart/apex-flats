/* On-foot crime layer for Apex Flats. Loaded by index.html before main.js; main.js calls createCrimeMode with Apex's scene, traffic, police and career objects. */
(function () {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const WEAPONS = ['FISTS', 'PISTOL', 'SMG', 'SHOTGUN'];

  // People. Each figure is a small rig of grouped parts (pelvis > spine > chest > neck > head; shoulder > elbow >
  // hand; hip > knee > foot) built from shared, smoothly profiled geometry, dressed for an Ashby winter: puffer
  // jackets, parkas and hoodies, jeans, boots, beanies and scarves, faces with eyes, brows, nose and mouth. Officers
  // wear navy with a peaked cap, badge and duty belt. animateFigure() drives walk, run, idle, aim and jump.
  let GEO = null;
  const MATS = new Map();
  const mat = (color, extra) => {
    const key = color + (extra ? JSON.stringify(extra) : '');
    if (!MATS.has(key)) MATS.set(key, new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.85 }, extra || {})));
    return MATS.get(key);
  };
  const PUFF = new Map();
  const pufferMat = c => { if (!PUFF.has(c)) PUFF.set(c, new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, bumpMap: quilt(), bumpScale: 0.18 })); return PUFF.get(c); };
  // a solid of revolution from (radius, height) pairs: smooth limbs and torsos instead of capsules
  const lathe = (pts, seg = 14) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  // quilted puffer fabric: soft horizontal ribs (a tiny canvas bump/colour texture shared by every jacket)
  let quiltTex = null;
  function quilt() {
    if (quiltTex) return quiltTex;
    const c = document.createElement('canvas'); c.width = 8; c.height = 64; const g = c.getContext('2d');
    for (let y = 0; y < 64; y++) { const v = 228 + 27 * Math.sin((y / 64) * Math.PI * 2 * 4) ** 2; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, y, 8, 1); }
    quiltTex = new THREE.CanvasTexture(c); quiltTex.wrapS = quiltTex.wrapT = THREE.RepeatWrapping; return quiltTex;
  }
  function geos() {
    if (GEO) return GEO;
    GEO = {
      // torso from the waist up to the shoulders (y 0..0.58), flattened front to back
      chest: lathe([[0.001, 0], [0.165, 0.0], [0.155, 0.12], [0.17, 0.3], [0.2, 0.42], [0.205, 0.5], [0.17, 0.56], [0.08, 0.6], [0.001, 0.6]], 16),
      puffer: lathe([[0.001, -0.06], [0.19, -0.06], [0.185, 0.1], [0.2, 0.3], [0.23, 0.44], [0.225, 0.52], [0.18, 0.59], [0.09, 0.63], [0.001, 0.63]], 16),
      pelvis: lathe([[0.001, -0.14], [0.15, -0.14], [0.175, -0.05], [0.17, 0.04], [0.16, 0.08], [0.001, 0.08]], 14),
      thigh: lathe([[0.001, -0.46], [0.065, -0.46], [0.075, -0.4], [0.09, -0.2], [0.098, -0.05], [0.09, 0.02], [0.001, 0.02]], 12),
      shin: lathe([[0.001, -0.44], [0.05, -0.44], [0.056, -0.36], [0.068, -0.18], [0.06, -0.04], [0.06, 0.01], [0.001, 0.01]], 12),
      upper: lathe([[0.001, -0.3], [0.05, -0.3], [0.056, -0.24], [0.062, -0.12], [0.066, -0.02], [0.05, 0.03], [0.001, 0.035]], 10),
      upperPuff: lathe([[0.001, -0.31], [0.062, -0.31], [0.07, -0.24], [0.078, -0.12], [0.084, -0.02], [0.065, 0.035], [0.001, 0.04]], 10),
      fore: lathe([[0.001, -0.27], [0.036, -0.27], [0.04, -0.2], [0.048, -0.08], [0.05, 0.0], [0.001, 0.01]], 10),
      hand: (() => { const g = new THREE.SphereGeometry(0.048, 10, 8); g.scale(0.85, 1.25, 0.55); g.translate(0, -0.05, 0); return g; })(),
      boot: (() => { const g = new THREE.SphereGeometry(0.07, 12, 8); g.scale(0.85, 0.62, 1.75); g.translate(0, 0.02, 0.05); return g; })(),
      neck: lathe([[0.001, 0], [0.055, 0], [0.05, 0.1], [0.001, 0.1]], 10),
      head: (() => { const g = new THREE.SphereGeometry(0.105, 20, 16); g.scale(0.92, 1.12, 1.0); return g; })(),
      jaw: (() => { const g = new THREE.SphereGeometry(0.075, 14, 10); g.scale(1.05, 0.7, 1.0); return g; })(),
      eye: new THREE.SphereGeometry(0.014, 8, 6), iris: new THREE.SphereGeometry(0.008, 6, 5),
      brow: new THREE.BoxGeometry(0.034, 0.007, 0.012), nose: (() => { const g = new THREE.ConeGeometry(0.016, 0.042, 6); g.rotateX(Math.PI / 2.4); return g; })(),
      mouth: new THREE.BoxGeometry(0.038, 0.006, 0.01), ear: (() => { const g = new THREE.SphereGeometry(0.022, 8, 6); g.scale(0.45, 1, 0.8); return g; })(),
      hairShort: (() => { const g = new THREE.SphereGeometry(0.109, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.6); g.rotateX(-0.32); return g; })(),
      hairLong: (() => { const g = new THREE.SphereGeometry(0.118, 16, 12, Math.PI * 0.15, Math.PI * 1.7, 0, Math.PI * 0.78); g.scale(1, 1.25, 1); return g; })(),
      beanie: lathe([[0.001, 0.13], [0.06, 0.125], [0.1, 0.09], [0.118, 0.03], [0.12, -0.01], [0.122, -0.03], [0.001, -0.03]], 16),
      scarf: new THREE.TorusGeometry(0.075, 0.032, 8, 16),
      capCrown: lathe([[0.001, 0.07], [0.1, 0.07], [0.118, 0.0], [0.001, 0.0]], 16), capPeak: (() => { const g = new THREE.CylinderGeometry(0.09, 0.09, 0.01, 12, 1, false, -Math.PI / 2, Math.PI); g.scale(1, 1, 0.7); return g; })(),
      belt: new THREE.TorusGeometry(0.165, 0.025, 6, 20), badge: new THREE.BoxGeometry(0.05, 0.06, 0.012), hood: (() => { const g = new THREE.TorusGeometry(0.1, 0.045, 8, 16, Math.PI); g.rotateX(Math.PI / 2); return g; })(),
      // guns: held in the right hand, pointing along the forearm
      pistol: [[0.03, 0.035, 0.17, 0, 0.0, 0.07, '#18191b'], [0.026, 0.09, 0.04, 0, -0.045, 0.0, '#2a2522']],
      smg: [[0.04, 0.06, 0.34, 0, 0.0, 0.1, '#1d1f22'], [0.03, 0.12, 0.04, 0, -0.07, 0.04, '#121314'], [0.026, 0.08, 0.04, 0, -0.05, -0.05, '#2a2522'], [0.03, 0.04, 0.14, 0, 0.0, -0.13, '#1d1f22']],
      shotgun: [[0.035, 0.04, 0.7, 0, 0.01, 0.2, '#26282b'], [0.04, 0.05, 0.18, 0, -0.01, 0.14, '#5a3a22'], [0.04, 0.08, 0.26, 0, -0.03, -0.14, '#5a3a22']],
    };
    for (const k of ['pistol', 'smg', 'shotgun']) GEO[k] = GEO[k].map(([w, h, d, x, y, z, c]) => ({ g: new THREE.BoxGeometry(w, h, d).translate(x, y, z), c }));
    return GEO;
  }
  const SKIN = ['#f0c8a8', '#dcae8a', '#c08a64', '#9c6a46', '#7a4e32', '#5a3826'];
  const HAIR = ['#1c1714', '#2e2219', '#4a3424', '#6b4a2e', '#8a6a44', '#b89a6a', '#2a2a2a', '#5e5850'];
  const JACKET = ['#1f2a36', '#3a2428', '#2c3a2e', '#4a4038', '#1b1d22', '#6b2d2a', '#2f4a5e', '#5a5f66', '#7a6a4a', '#3d3550', '#8a8a86', '#1e3a34'];
  const TROUSERS = ['#22324a', '#2a3550', '#1f2124', '#3b3a36', '#4a4438', '#28303a'];
  const HAT = ['#b0302a', '#2a4a7a', '#d8d2c4', '#3a3a3a', '#5e7a3a', '#c9a23a', '#6a3a6a'];
  // person: { cop, player, seed } -> a Group with userData.rig
  function figure(scene, cop = false, scale = 1, seed = 0, player = false) {
    const G = geos();
    let rs = Math.floor((seed || 0.5) * 2147483646) || 1; const r = () => (rs = (rs * 16807) % 2147483647) / 2147483647;
    const pick = a => a[Math.floor(r() * a.length)];
    const female = !cop && !player && r() < 0.45;
    const style = player ? 'leather' : cop ? 'uniform' : pick(['puffer', 'puffer', 'parka', 'hoodie', 'coat']);
    const skinC = player ? '#d6a986' : pick(SKIN), hairC = player ? '#1e1814' : pick(HAIR);
    const jacketC = player ? '#2a1d17' : cop ? '#16223a' : pick(JACKET), trouserC = player ? '#2b3a55' : cop ? '#141c2e' : pick(TROUSERS);
    const skin = mat(skinC, { roughness: 0.62 }), hairM = mat(hairC, { roughness: 0.9 });
    const jacket = style === 'puffer' ? pufferMat(jacketC) : mat(jacketC, { roughness: style === 'leather' ? 0.42 : 0.82, metalness: style === 'leather' ? 0.05 : 0 });
    const trousers = mat(trouserC, { roughness: 0.9 }), boots = mat(player ? '#3a2618' : cop ? '#0b0b0c' : pick(['#2a1e16', '#111214', '#4a3a2a', '#d8d4cc']), { roughness: 0.6 });
    const white = mat('#f4f1ec', { roughness: 0.3 }), dark = mat('#1a1410', { roughness: 0.5 }), lip = mat('#8a4a44', { roughness: 0.5 });
    const root = new THREE.Group(), rig = { root };
    const add = (parent, geo, m, x = 0, y = 0, z = 0, shadow = true) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = shadow; parent.add(o); return o; };
    const grp = (parent, x, y, z) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };
    const hipH = 0.94, w = female ? 0.92 : 1;
    rig.pelvis = grp(root, 0, hipH, 0);
    add(rig.pelvis, G.pelvis, trousers).scale.set(w * (female ? 1.05 : 1), 1, 0.78);
    rig.spine = grp(rig.pelvis, 0, 0.07, 0);
    const puffy = style === 'puffer' || style === 'parka';
    const torso = add(rig.spine, puffy ? G.puffer : G.chest, jacket); torso.scale.set(w, 1, 0.68);
    if (style === 'parka' || style === 'coat') add(rig.spine, G.pelvis, jacket, 0, -0.06, 0).scale.set(1.08 * w, 1.6, 0.85); // the skirt of a long coat
    if (style === 'hoodie') add(rig.spine, G.hood, jacket, 0, 0.6, -0.06);
    if (cop) { add(rig.pelvis, G.belt, mat('#0e0e10', { roughness: 0.5 }), 0, 0.02, 0).rotation.x = Math.PI / 2; add(rig.spine, G.badge, mat('#d7ba65', { metalness: 0.6, roughness: 0.35 }), 0.085, 0.43, 0.135); }
    rig.neck = grp(rig.spine, 0, 0.58, 0.0);
    add(rig.neck, G.neck, skin);
    if (!cop && r() < 0.45) add(rig.neck, G.scarf, mat(pick(HAT), { roughness: 0.95 }), 0, 0.03, 0.01).rotation.x = Math.PI / 2;
    rig.head = grp(rig.neck, 0, 0.19, 0.01);
    add(rig.head, G.head, skin);
    add(rig.head, G.jaw, skin, 0, -0.06, 0.018);
    // the face (hidden past ~30 m)
    const face = grp(rig.head, 0, 0, 0); rig.face = face;
    for (const sx of [-1, 1]) {
      add(face, G.eye, white, sx * 0.034, 0.018, 0.088, false);
      add(face, G.iris, dark, sx * 0.034, 0.018, 0.1, false);
      add(face, G.brow, hairM, sx * 0.035, 0.045, 0.094, false).rotation.z = sx * -0.12;
      add(rig.head, G.ear, skin, sx * 0.1, 0.0, 0.0, false);
    }
    add(face, G.nose, skin, 0, -0.008, 0.11, false);
    add(face, G.mouth, lip, 0, -0.052, 0.088, false);
    // hair or a hat
    const hat = cop ? 'cap' : player ? 'short' : pick(female ? ['long', 'long', 'beanie', 'beanie'] : ['short', 'short', 'beanie', 'beanie', 'bald']);
    if (hat === 'short') add(rig.head, G.hairShort, hairM, 0, 0.012, -0.006).scale.set(0.96, 1.08, 1.02);
    if (hat === 'long') { add(rig.head, G.hairShort, hairM, 0, 0.022, -0.008).scale.set(1.02, 0.92, 1.08); add(rig.head, G.hairLong, hairM, 0, -0.06, -0.02); }
    if (hat === 'beanie') add(rig.head, G.beanie, mat(pick(HAT), { roughness: 0.95 }), 0, 0.03, -0.004);
    if (hat === 'cap') { const cm = mat('#101828', { roughness: 0.6 }); add(rig.head, G.capCrown, cm, 0, 0.055, -0.01); add(rig.head, G.capPeak, mat('#0a0a0a', { roughness: 0.3 }), 0, 0.06, 0.1); add(rig.head, G.badge, mat('#d7ba65', { metalness: 0.6 }), 0, 0.1, 0.1).scale.set(0.6, 0.6, 1); }
    // arms: shoulder > upper arm > elbow > forearm > hand
    rig.arms = []; rig.elbows = []; rig.hands = [];
    for (const sx of [-1, 1]) {
      const sh = grp(rig.spine, sx * (puffy ? 0.215 : 0.2) * w, 0.5, 0);
      add(sh, puffy ? G.upperPuff : G.upper, jacket);
      const el = grp(sh, 0, -0.29, 0);
      add(el, puffy ? G.upperPuff : G.fore, jacket).scale.set(puffy ? 0.85 : 1, puffy ? 0.88 : 1, puffy ? 0.85 : 1);
      const hd = grp(el, 0, -0.27, 0);
      add(hd, G.hand, cop || puffy ? mat('#141416', { roughness: 0.8 }) : skin); // gloves in the cold
      sh.rotation.z = sx * 0.06;
      rig.arms.push(sh); rig.elbows.push(el); rig.hands.push(hd);
    }
    // legs: hip > thigh > knee > shin > boot
    rig.legs = []; rig.knees = [];
    for (const sx of [-1, 1]) {
      const hp = grp(rig.pelvis, sx * 0.09 * w, -0.06, 0);
      add(hp, G.thigh, trousers);
      const kn = grp(hp, 0, -0.44, 0);
      add(kn, G.shin, trousers);
      add(kn, G.boot, boots, 0, -0.44, 0.02);
      rig.legs.push(hp); rig.knees.push(kn);
    }
    // a gun for each weapon, in the right hand (shown by animateFigure)
    rig.guns = [null];
    for (const k of ['pistol', 'smg', 'shotgun']) {
      const g = new THREE.Group(); for (const p of G[k]) add(g, p.g, mat(p.c, { roughness: 0.45, metalness: 0.4 }), 0, 0, 0, false);
      g.position.set(0, -0.08, 0.02); g.rotation.x = Math.PI / 2; // barrel out past the fingers g.visible = false; rig.hands[0].add(g); rig.guns.push(g); // [0] is the right hand
    }
    root.scale.setScalar(scale * (female ? 0.95 : 1));
    root.userData = { rig, legs: rig.legs, arms: rig.arms, cop };
    scene.add(root);
    return root;
  }
  // Pose a figure. o: { phase, gait 0..1 (walk) to 2 (sprint), aim 0..1, weapon, air, t }
  function animateFigure(fig, o) {
    const R = fig.userData.rig; if (!R) return;
    const ph = o.phase || 0, g = Math.min(1, o.gait || 0), run = clamp((o.gait || 0) - 1, 0, 1), aim = o.aim || 0;
    const sw = Math.sin(ph), cw = Math.cos(ph);
    // legs: thighs swing, knees fold on the swing-through, more when running
    for (let i = 0; i < 2; i++) {
      const s = i ? -sw : sw, c = i ? -cw : cw;
      R.legs[i].rotation.x = o.air ? (i ? 0.5 : -0.9) : -s * (0.5 + 0.25 * run) * g;
      R.knees[i].rotation.x = o.air ? (i ? 0.6 : 1.1) : (0.08 + Math.max(0, c) * (0.75 + 0.6 * run)) * g + 0.04;
    }
    // hips bob twice a stride; the body leans into a run and twists against the legs
    R.pelvis.position.y = 0.94 + (Math.abs(cw) * 0.035 - 0.02) * g - 0.03 * run;
    R.spine.rotation.x = 0.06 * g + 0.16 * run - 0.02 * aim;
    R.spine.rotation.y = sw * 0.09 * g * (1 - aim);
    R.head.rotation.y = -sw * 0.05 * g;
    // breathing when still
    const breathe = Math.sin((o.t || 0) * 1.6) * 0.012 * (1 - g);
    R.spine.scale.set(1, 1 + breathe, 1 + breathe * 2);
    // arms: swing opposite the legs, elbows bent; aiming raises both towards the target
    for (let i = 0; i < 2; i++) {
      const s = i ? sw : -sw;
      const swingX = s * (0.4 + 0.45 * run) * g, elbow = -(0.25 + 0.9 * run * g);
      // aiming: the gun arm (right, [0]) straight out, the other hand comes across to steady it
      const aimX = i ? -1.25 : -1.52, aimZ = i ? -0.42 : 0.08, aimEl = i ? -0.3 : 0;
      R.arms[i].rotation.x = swingX * (1 - aim) + aimX * aim;
      R.arms[i].rotation.z = (i ? 0.06 : -0.06) * (1 - aim) + aimZ * aim * (o.weapon ? 1 : 0);
      R.elbows[i].rotation.x = elbow * (1 - aim) + aimEl * aim;
    }
    for (let k = 1; k < R.guns.length; k++) R.guns[k].visible = o.weapon === k;
    if (R.face) R.face.visible = o.near !== false;
  }

  // Gunfire you can see: tracer streaks, muzzle flashes, and what the bullet hit (sparks off metal, dust, blood)
  function createFX(scene) {
    const tex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
    })();
    const tGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
    const tracers = Array.from({ length: 40 }, () => {
      const m = new THREE.Mesh(tGeo, new THREE.MeshBasicMaterial({ color: '#ffd98a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      m.visible = false; m.frustumCulled = false; m.renderOrder = 5; scene.add(m); return { m, life: 0, max: 1 };
    });
    const sprites = Array.from({ length: 90 }, () => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      sp.visible = false; scene.add(sp); return { sp, life: 0, max: 1, vx: 0, vy: 0, vz: 0, grow: 0, a: 1 };
    });
    let ti = 0, si = 0;
    const hurtEl = document.getElementById('hurt');
    function sprite(x, y, z, color, size, life, add, vx = 0, vy = 0, vz = 0, grow = 0, a = 1) {
      const p = sprites[si]; si = (si + 1) % sprites.length;
      p.sp.material.color.set(color); p.sp.material.blending = add ? THREE.AdditiveBlending : THREE.NormalBlending;
      p.sp.position.set(x, y, z); p.sp.scale.set(size, size, 1); p.sp.visible = true;
      Object.assign(p, { life, max: life, vx, vy, vz, grow, a, size });
    }
    return {
      tracer(ax, ay, az, bx, by, bz) {
        const t = tracers[ti]; ti = (ti + 1) % tracers.length;
        const len = Math.hypot(bx - ax, by - ay, bz - az); if (len < 0.5) return;
        t.m.position.set(ax, ay, az); t.m.lookAt(bx, by, bz);
        const w = 0.022 + Math.min(0.05, len * 0.0006); t.m.scale.set(w, w, len);
        t.m.visible = true; t.life = t.max = 0.09; t.m.material.opacity = 1;
      },
      flash(x, y, z) { sprite(x, y, z, '#ffcf70', 0.75, 0.06, true); sprite(x, y, z, '#fff6e0', 0.35, 0.04, true); },
      impact(x, y, z, kind) {
        if (kind === 'blood') for (let i = 0; i < 4; i++) sprite(x, y, z, '#6e0b0b', 0.25 + Math.random() * 0.2, 0.45, false, (Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2, 0.6, 0.9);
        else if (kind === 'spark') for (let i = 0; i < 5; i++) sprite(x, y, z, '#ffb347', 0.12 + Math.random() * 0.1, 0.18, true, (Math.random() - 0.5) * 6, Math.random() * 4, (Math.random() - 0.5) * 6);
        else sprite(x, y, z, '#b9a68c', 0.35, 0.6, false, 0, 0.6, 0, 1.6, 0.6);
      },
      flashDamage() { if (!hurtEl) return; hurtEl.style.transition = 'none'; hurtEl.style.opacity = 0.55; requestAnimationFrame(() => { hurtEl.style.transition = 'opacity 0.6s'; hurtEl.style.opacity = 0; }); },
      update(dt) {
        for (const t of tracers) { if (t.life <= 0) continue; t.life -= dt; if (t.life <= 0) t.m.visible = false; else t.m.material.opacity = t.life / t.max; }
        for (const p of sprites) {
          if (p.life <= 0) continue;
          p.life -= dt; if (p.life <= 0) { p.sp.visible = false; continue; }
          p.vy -= (p.grow ? 0 : 9.8) * dt;
          p.sp.position.x += p.vx * dt; p.sp.position.y += p.vy * dt; p.sp.position.z += p.vz * dt;
          const k = p.life / p.max, sc = p.size * (1 + p.grow * (1 - k)); p.sp.scale.set(sc, sc, 1); p.sp.material.opacity = p.a * k;
        }
      },
    };
  }

  window.createCrimeMode = function ({ scene, camera, city, traffic, police, player, solidsNear, addSolid, career, presets, pickPreset, makeCarMesh, onGunFx, onCrime, onEnterCar, onPlayerWasted, snapshotVehicle, onCopShoot }) {
    const fx = createFX(scene);
    const foot = { x: city.start.x, y: city.start.y || 0, z: city.start.z, h: city.start.h, vx: 0, vz: 0, hp: 100, armor: 0, alive: true, jy: 0, vy: 0 };
    const avatar = figure(scene, false, 1, 0.37, true);
    avatar.visible = false;
    const peds = [], parked = [];
    const raycaster = new THREE.Raycaster(), center = new THREE.Vector2(0, 0), targets = [];
    const tmp = new THREE.Vector3();
    let active = false, aiming = false, fireHeld = false, weapon = 1, fireT = 0, reloadT = 0, yaw = foot.h, pitch = 0.06, walkPhase = 0, message = '', messageT = 0, pedAcc = 0, uiAcc = 0;
    let recoil = 0, shake = 0;
    let lookYaw = yaw, pick = null, hurtT = 99, spawnT = 0, entering = false, jumpHeld = false, aimBlend = 0;
    const gaitOf = sp => sp < 2 ? sp / 1.4 : 1 + (sp - 2) / 4; // 1: a walk, 2+: running
    const ammo = [{ mag: Infinity, res: Infinity }, { mag: 12, res: 72 }, { mag: 30, res: 180 }, { mag: 8, res: 32 }];
    const status = document.getElementById('crime-status');
    const prompt = document.getElementById('crime-prompt');

    function say(text, time = 2.5) { message = text; messageT = time; }
    function statusText() { return `HEALTH ${Math.round(foot.hp)}${foot.armor > 0 ? ' · ARMOUR ' + Math.round(foot.armor) : ''} · ${WEAPONS[weapon]} · ${ammo[weapon].mag === Infinity ? '∞' : ammo[weapon].mag + ' / ' + ammo[weapon].res}`; }
    function currentTarget() {
      let best = null, bd = 4.2;
      for (const p of parked) {
        if (p.removed) continue;
        const d = Math.hypot(foot.x - p.pose.x, foot.z - p.pose.z);
        if (d < bd) { best = { type: 'parked', record: p, preset: p.preset, pose: p.pose, distance: d }; bd = d; }
      }
      for (const v of traffic.vehicles) {
        if (!v || v.state === 'idle' || v.crimeTaken || v.sunk) continue;
        const d = Math.hypot(foot.x - v.x, foot.z - v.z);
        if (d < bd && Math.abs((v.y || 0) - foot.y) < 3) { best = { type: 'traffic', vehicle: v, distance: d }; bd = d; }
      }
      return best;
    }
    function blocked(x, z, y, r) {
      const nearby = [];
      solidsNear(x, z, r + 0.2, nearby);
      for (const o of nearby) {
        if (o.parkedCar && o.parkedCar.removed) continue;
        if (o.y0 !== undefined && (o.y0 > y + 1.8 || o.y0 + o.h < y + 0.1)) continue;
        if (o.type === 'circle') { if (Math.hypot(x - o.x, z - o.z) < o.r + r) return true; }
        else {
          const ux = o.ux ?? 1, uz = o.uz ?? 0, dx = x - o.x, dz = z - o.z;
          const qx = dx * ux + dz * uz, qz = -dx * uz + dz * ux;
          if (Math.abs(qx) < o.hx + r && Math.abs(qz) < o.hz + r) return true;
        }
      }
      return false;
    }
    function legalFoot(x, z, lift = 0) {
      const y = city.heightAt(x, z, foot.y);
      if (!Number.isFinite(y) || city.surfaceAt(x, z, y) === 'water') return false;
      return !blocked(x, z, y + lift, 0.32); // mid-jump you clear low walls, hedges and car bonnets
    }
    // knocked down by traffic while on foot
    player.onHitByCar = (v, sp) => {
      if (!active) return;
      const dx = foot.x - v.x, dz = foot.z - v.z, d = Math.hypot(dx, dz) || 1;
      const push = Math.min(3.5, 0.6 + sp * 0.15);
      if (legalFoot(foot.x + (dx / d) * push, foot.z + (dz / d) * push)) { foot.x += (dx / d) * push; foot.z += (dz / d) * push; }
      foot.vx = foot.vz = 0;
      say(sp > 8 ? 'Hit by a car' : 'Watch the traffic', 1.5);
      api.hurt(Math.min(95, (sp - 2) * 7));
    };
    function syncProxy() {
      player.px = player.x; player.pz = player.z; player.ph = player.h;
      player.x = foot.x; player.y = foot.y; player.z = foot.z; player.h = foot.h;
      player.vx = foot.vx; player.vz = foot.vz; player.w = 0; player.speed = Math.hypot(foot.vx, foot.vz);
      player.onFoot = true; player.armed = weapon > 0; player.crimeHealth = foot.hp;
    }
    function enterFoot(pose) {
      active = true; entering = false; pick = null;
      foot.x = pose.x; foot.z = pose.z; foot.y = city.heightAt(pose.x, pose.z, pose.y || 0); foot.h = pose.h || yaw; foot.vx = foot.vz = 0; foot.alive = true; foot.jy = foot.vy = 0;
      if (foot.hp <= 0) foot.hp = 100;
      yaw = lookYaw = foot.h; pitch = 0.06; avatar.visible = true; avatar.rotation.x = 0; syncProxy(); updateMarker();
      document.body.classList.add('on-foot');
      if (status) { status.hidden = false; status.textContent = statusText(); }
      if (prompt) prompt.hidden = false;
    }
    function enterCar() {
      active = false; entering = false; avatar.visible = false; aiming = false; fireHeld = false; pick = null; player.onFoot = false;
      document.body.classList.remove('on-foot');
      if (prompt) prompt.hidden = true;
      if (status) { status.hidden = false; status.textContent = `HEALTH ${Math.round(foot.hp)}`; }
    }
    // parked cars: your own (left where you got out) and civilian ones you can break into
    function addParked(mesh, preset, pose, owned = false, npc = false, solid = null) {
      const y = pose.y ?? city.heightAt(pose.x, pose.z);
      mesh.position.set(pose.x, y, pose.z); mesh.rotation.set(0, pose.h || 0, 0, 'YXZ');
      mesh.visible = true; scene.add(mesh);
      const rec = { mesh, preset, pose: { x: pose.x, y, z: pose.z, h: pose.h || 0 }, owned, npc, locked: npc, removed: false, solid: null };
      if (solid) { // a city parked spot: its own solid comes back into play
        rec.solid = solid; solid.parkedCar = rec; solid.x = pose.x; solid.z = pose.z; solid.h = 1.5;
      } else if (addSolid) {
        const h = pose.h || 0;
        rec.solid = { type: 'box', x: pose.x, z: pose.z, hx: 0.95, hz: 2.3, ux: Math.cos(h), uz: -Math.sin(h), h: 1.5, y0: y, mu: 0.5, parkedCar: rec };
        addSolid(rec.solid);
      }
      parked.push(rec);
      return rec;
    }
    function removeParked(rec) {
      if (!rec || rec.removed) return;
      rec.removed = true; scene.remove(rec.mesh); rec.mesh.userData.dispose?.();
      if (rec.solid) { rec.solid.x = rec.solid.z = 1e7; rec.solid.h = 0; rec.solid.parkedCar = null; } // inert; the static grid keeps the reference
      const i = parked.indexOf(rec); if (i >= 0) parked.splice(i, 1);
      if (rec.spot && !rec.spot.taken) city.swapParked(rec.spot, false); // back to the stand-in
    }
    // Driveway and kerbside cars built into the city: the nearest few become real cars you can break into
    function swapSpots() {
      const spots = city.parkedSpots; if (!spots || !makeCarMesh) return;
      const P = player;
      let live = 0;
      for (const r of parked.slice()) if (r.spot) { if (Math.hypot(r.pose.x - P.x, r.pose.z - P.z) > 110) removeParked(r); else live++; }
      if (live >= 8) return;
      const near = [];
      for (const sp of spots) {
        if (sp.swapped || sp.taken || Math.abs(sp.x - P.x) > 70 || Math.abs(sp.z - P.z) > 70) continue;
        const d = Math.hypot(sp.x - P.x, sp.z - P.z); if (d < 70) near.push([d, sp]);
      }
      near.sort((a, b) => a[0] - b[0]);
      for (const [, sp] of near.slice(0, 8 - live)) {
        let mesh = null, pr = null;
        for (let t = 0; t < 4 && !mesh; t++) {
          const base = pickPreset ? pickPreset() : presets[(Math.random() * presets.length) | 0];
          pr = Object.assign({}, base, { paint: [sp.color.r, sp.color.g, sp.color.b] });
          mesh = makeCarMesh(pr, false); // only models already loaded: no download hitch mid-drive
        }
        if (!mesh) continue;
        city.swapParked(sp, true);
        const rec = addParked(mesh, pr, { x: sp.x, y: sp.y, z: sp.z, h: sp.yaw }, false, true, sp.solid);
        rec.spot = sp;
      }
    }
    // the nearest bit of pavement to a point: where you step out after being busted or wasted, or off a taxi
    function pavementNear(x, z, y = 0) {
      const lane = city.nearestLanePose(x, z, y);
      if (lane) for (const off of [5.4, 6.6, 4.4, 8]) for (const sg of [1, -1]) {
        const px = lane.x + Math.cos(lane.h) * sg * off, pz = lane.z - Math.sin(lane.h) * sg * off;
        if (city.walkAt(px, pz) && legalFoot(px, pz)) return { x: px, z: pz, y: city.heightAt(px, pz, lane.y), h: lane.h };
      }
      return legalFoot(x, z) ? { x, z, y: city.heightAt(x, z, y), h: 0 } : null;
    }
    function spawnParked() {
      if (!makeCarMesh) return;
      const P = player;
      let npcCount = 0;
      swapSpots();
      // cars you've left about: the two most recent stay put, older ones far away are towed
      const mine = parked.filter(r => r.mine);
      for (const r of mine.slice(0, -2)) if (Math.hypot(r.pose.x - P.x, r.pose.z - P.z) > 300) removeParked(r);
      for (const r of parked.slice()) {
        if (!r.npc || r.spot) continue;
        if (Math.hypot(r.pose.x - P.x, r.pose.z - P.z) > 240) removeParked(r); else npcCount++;
      }
      for (let tries = 0; tries < 6 && npcCount < 10; tries++) {
        const a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 120;
        const lane = city.nearestLanePose(P.x + Math.cos(a) * d, P.z + Math.sin(a) * d, P.y || 0);
        if (!lane || lane.kind === 'fwy' || lane.kind === 'ramp' || lane.d > 40) continue;
        const px = Math.cos(lane.h), pz = -Math.sin(lane.h);
        let spot = null;
        for (const s of [1, -1]) {
          const x = lane.x + px * s * 2.9, z = lane.z + pz * s * 2.9;
          const curbX = lane.x + px * s * 5.2, curbZ = lane.z + pz * s * 5.2;
          if (!city.walkAt(curbX, curbZ)) continue;
          const y = city.heightAt(x, z, lane.y);
          if (!Number.isFinite(y) || Math.abs(y - lane.y) > 0.6 || city.surfaceAt(x, z, y) === 'water' || blocked(x, z, y, 1.3)) continue;
          if (parked.some(r => !r.removed && Math.hypot(r.pose.x - x, r.pose.z - z) < 13)) continue;
          if (Math.hypot(x - P.x, z - P.z) < 35) continue;
          spot = { x, y, z, h: lane.h };
          break;
        }
        if (!spot) continue;
        const pr = pickPreset ? pickPreset() : presets[(Math.random() * presets.length) | 0];
        const mesh = makeCarMesh(pr);
        if (!mesh) continue;
        addParked(mesh, pr, spot, false, true);
        npcCount++;
      }
    }
    function pedSpawn() {
      const P = player;
      for (let i = peds.length - 1; i >= 0; i--) {
        const p = peds[i];
        if (Math.hypot(p.x - P.x, p.z - P.z) > 210) { scene.remove(p.mesh); peds.splice(i, 1); }
      }
      let alive = peds.filter(p => p.alive).length;
      for (let tries = 0; tries < 8 && alive < 16; tries++) {
        const a = Math.random() * Math.PI * 2, r = 40 + Math.random() * 120, x = P.x + Math.cos(a) * r, z = P.z + Math.sin(a) * r;
        if (city.walkAt(x, z) && city.surfaceAt(x, z) !== 'water') { addPed(x, z, false); alive++; }
      }
    }
    function mark(dt) {
      if (messageT > 0) { messageT -= dt; if (messageT <= 0) message = ''; }
      if (!prompt) return;
      if (!active) { prompt.hidden = !message; if (message) prompt.textContent = message; return; } // at the wheel: messages only
      const t = currentTarget();
      prompt.hidden = false;
      if (pick) { prompt.textContent = `Picking the lock · ${Math.round((pick.t / pick.need) * 100)}% · keep holding F`; return; }
      if (message) { prompt.textContent = message; return; }
      if (!t) { prompt.textContent = 'Find a car · F to get in · G to smash a window'; return; }
      if (t.type === 'traffic') { prompt.textContent = (t.vehicle.police ? 'F  Pull the officer out (3 stars)' : 'F  Pull the driver out'); return; }
      const name = t.preset ? t.preset.name : 'car';
      if (t.record.owned || !t.record.locked) prompt.textContent = `F  Get in · ${name}`;
      else prompt.textContent = `Hold F to pick the lock · G to smash the window · ${name} · $${(t.preset.price || 0).toLocaleString()}`;
    }
    function updateMarker() { avatar.position.set(foot.x, foot.y + (foot.jy || 0), foot.z); avatar.rotation.y = foot.h; }
    function fleeDriver(v) {
      if (!v || v.driverMesh?.visible === false) return;
      if (v.driverMesh) v.driverMesh.visible = false;
      const side = v.x + Math.cos(v.h) * 1.35, z = v.z - Math.sin(v.h) * 1.35;
      const g = figure(scene, !!v.police, 0.95, Math.random() + 0.01);
      const ped = { mesh: g, x: side, z, y: city.heightAt(side, z, v.y), vx: Math.cos(v.h) * 3.5, vz: -Math.sin(v.h) * 3.5, hp: v.police ? 100 : 45, alive: true, flee: !v.police, t: 0, phase: Math.random() * 6.28, cop: !!v.police, gunT: 1.5 };
      g.userData.ped = ped;
      peds.push(ped);
      return ped;
    }
    async function enter(preset, pose, info) {
      entering = true;
      try { await onEnterCar(preset, pose, info); } finally { entering = false; }
    }
    async function interact() {
      if (!active || entering) return;
      const t = currentTarget();
      if (!t) { say('No vehicle close enough'); return; }
      if (t.type === 'traffic') {
        const v = t.vehicle, speed = Math.hypot(v.vx || 0, v.vz || 0);
        if (speed > 2.2) { say('Too fast. Wait for it to stop'); return; }
        const preset = v.police ? presets.find(p => p.id === 'interceptor') : presets.find(p => p.id === v.modelId) || presets.find(p => p.style === v.style);
        if (!preset) { say('That model is unavailable'); return; }
        const pose = { x: v.x, y: v.y, z: v.z, h: v.h };
        const damage = snapshotVehicle?.(v) || null; // its dents come with it
        fleeDriver(v); traffic.takeover(v);
        onCrime(v.police ? 'policeCarTheft' : 'carjack', { vehicle: v, preset });
        await enter(preset, pose, { owned: false, traffic: v, damage });
        return;
      }
      const r = t.record;
      if (r.locked && !r.owned) { pick = { rec: r, t: 0, need: clamp(1.4 + (r.preset.price || 0) / 45000, 1.4, 4.5) }; return; }
      if (r.spot) r.spot.taken = true;
      removeParked(r);
      await enter(r.preset, r.pose, { owned: r.owned, parked: r });
    }
    async function finishSteal(r, how) {
      pick = null;
      r.locked = false;
      onCrime(how === 'smash' ? 'alarm' : 'theft', { preset: r.preset, parked: r });
      if (r.spot) r.spot.taken = true;
      removeParked(r);
      await enter(r.preset, r.pose, { owned: false, parked: r, stolen: true });
    }
    function fire() {
      if (!active || fireT > 0 || entering) return;
      const a = ammo[weapon];
      if (weapon === 0) {
        fireT = 0.55;
        let hit = null, hd = 1.6;
        for (const p of peds) { if (!p.alive) continue; const d = Math.hypot(p.x - foot.x, p.z - foot.z); if (d < hd) { hd = d; hit = p; } }
        if (hit) { hit.hp -= 18; hit.flee = true; hit.vx = (hit.x - foot.x) * 3; hit.vz = (hit.z - foot.z) * 3; if (hit.hp <= 0) killPed(hit, 'player'); else onCrime(hit.cop ? 'hurtCop' : 'assault', { ped: hit }); return; }
        const t = currentTarget();
        if (t?.type === 'traffic' && t.distance < 2) { fleeDriver(t.vehicle); onCrime('assault', { vehicle: t.vehicle }); }
        return;
      }
      if (reloadT > 0) return;
      if (a.mag <= 0) { if (a.res > 0) { reloadT = weapon === 3 ? 1.6 : 1.25; say('Reloading'); } else say('Out of ammo'); return; }
      a.mag--; fireT = weapon === 3 ? 0.72 : weapon === 2 ? 0.09 : 0.3;
      if (!a.mag && a.res > 0) { reloadT = weapon === 3 ? 1.6 : 1.25; say('Reloading', 1); } // empty: reload straight away
      targets.length = 0;
      for (const p of peds) if (p.alive && p.mesh.visible) targets.push(p.mesh);
      for (const v of traffic.vehicles) if (v.state !== 'idle' && v.group.visible) targets.push(v.group);
      onCrime('gunfire', { weapon });
      for (const p of peds) if (p.alive && !p.cop && Math.hypot(p.x - foot.x, p.z - foot.z) < 45) { p.flee = true; p.t = 0; const d = Math.hypot(p.x - foot.x, p.z - foot.z) || 1; p.vx = ((p.x - foot.x) / d) * 4.5; p.vz = ((p.z - foot.z) / d) * 4.5; }
      // the shot leaves the gun in your right hand
      const fx0 = Math.sin(yaw), fz0 = Math.cos(yaw), mx = foot.x + fx0 * 0.55 - Math.cos(yaw) * 0.22, my = foot.y + 1.42, mz = foot.z + fz0 * 0.55 + Math.sin(yaw) * 0.22;
      fx.flash(mx, my, mz);
      // the kick: the view jumps up and settles, harder for the shotgun; the gun sounds and the pad rumbles
      recoil += weapon === 3 ? 0.085 : weapon === 2 ? 0.022 : 0.045; shake = Math.max(shake, weapon === 3 ? 0.5 : 0.2);
      onGunFx?.(weapon, 0);
      const pellets = weapon === 3 ? 6 : 1, spread = weapon === 3 ? 0.05 : weapon === 2 ? 0.018 : 0.006;
      const hitPeds = new Set();
      for (let k = 0; k < pellets; k++) {
        raycaster.setFromCamera(center, camera); raycaster.far = 130;
        const dir = raycaster.ray.direction;
        dir.x += (Math.random() - 0.5) * spread * 2; dir.y += (Math.random() - 0.5) * spread * 2; dir.z += (Math.random() - 0.5) * spread * 2; dir.normalize();
        const o = raycaster.ray.origin, wall = worldHit(o, dir, 130);
        const hits = raycaster.intersectObjects(targets, true).filter(h => h.distance < wall && h.distance > 2);
        const hit = hits[0], end = hit ? hit.point : tmp.copy(dir).multiplyScalar(wall).add(o);
        fx.tracer(mx, my, mz, end.x, end.y, end.z);
        if (!hit) { if (wall < 130) fx.impact(end.x, end.y, end.z, 'dust'); continue; }
        let n = hit.object;
        while (n && !n.userData.ped && !n.userData.vehicle) n = n.parent;
        if (n?.userData.ped) {
          const p = n.userData.ped; fx.impact(end.x, end.y, end.z, 'blood');
          p.hp -= weapon === 3 ? 20 : weapon === 2 ? 20 : 34; hitMark();
          if (p.hp <= 0) killPed(p, 'player'); else if (!hitPeds.has(p)) { hitPeds.add(p); onCrime(p.cop ? 'hurtCop' : 'assault', { ped: p }); }
        } else if (n?.userData.vehicle) {
          const v = n.userData.vehicle; fx.impact(end.x, end.y, end.z, 'spark');
          if (k) continue;
          if (v.police) onCrime('hurtCop', { vehicle: v });
          else { traffic.threaten(v, 8); onCrime('assault', { vehicle: v }); }
        }
      }
    }
    // how far a shot travels before it meets a building, a wall, a parked car or the ground
    function worldHit(o, d, far) {
      for (let t = 3; t < far; t += 0.8) {
        const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
        if (y < city.heightAt(x, z, y + 0.5) - 0.02) return t;
        if (blocked(x, z, y - 1, 0.02)) return t;
      }
      return far;
    }
    const drops = [], dropGeo = new THREE.BoxGeometry(0.34, 0.2, 0.22), dropMat = new THREE.MeshStandardMaterial({ color: '#3d5a2a', emissive: '#2a4a10', emissiveIntensity: 0.6, roughness: 0.6 });
    function killPed(p, by) {
      if (!p.alive) return;
      if (p.cop && drops.length < 12) { const m = new THREE.Mesh(dropGeo, dropMat); m.position.set(p.x + 0.5, p.y + 0.2, p.z); scene.add(m); drops.push({ m, x: p.x + 0.5, z: p.z, t: 0 }); }
      p.alive = false; p.flee = false; p.deadT = 0;
      p.mesh.rotation.x = -Math.PI / 2; p.mesh.position.y = p.y + 0.15;
      if (by === 'player' || by === 'car') onCrime(p.cop ? 'killCop' : 'kill', { ped: p });
    }
    function updateFixed(dt, keys) {
      if (!active) return;
      if (!foot.alive) { avatar.rotation.x = -Math.PI / 2; avatar.position.y = foot.y + 0.25; return; } // down
      if (fireT > 0) fireT -= dt;
      if (reloadT > 0) { reloadT -= dt; if (reloadT <= 0 && weapon > 0) { const a = ammo[weapon], cap = weapon === 3 ? 8 : weapon === 2 ? 30 : 12, take = Math.min(cap - a.mag, a.res); a.mag += take; a.res -= take; } }
      if (pick) {
        const r = pick.rec;
        if (!keys.KeyF || r.removed || Math.hypot(foot.x - r.pose.x, foot.z - r.pose.z) > 4.5) { pick = null; say('Lock pick abandoned', 1.2); }
        else { pick.t += dt; if (pick.t >= pick.need) finishSteal(r, 'pick'); }
      }
      const fwd = pick || entering ? 0 : (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
      const side = pick || entering ? 0 : (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
      // movement is relative to where the camera looks
      const fx = Math.sin(lookYaw), fz = Math.cos(lookYaw), rx = -Math.cos(lookYaw), rz = Math.sin(lookYaw);
      let mx = fx * fwd + rx * side, mz = fz * fwd + rz * side;
      const ml = Math.hypot(mx, mz);
      if (ml > 0) { mx /= ml; mz /= ml; }
      // jog by default, sprint with Shift, walk while aiming; in the air you keep your momentum
      const speed = aiming ? 3.2 : keys.ShiftLeft || keys.ShiftRight ? 8.4 : 5.6, grip = foot.jy > 0 ? 1.5 : 12;
      foot.vx = mix(foot.vx, mx * speed, Math.min(1, dt * grip)); foot.vz = mix(foot.vz, mz * speed, Math.min(1, dt * grip));
      // jump (Space): a separate height above the ground, so foot.y always stays the ground you're over
      if (keys.Space && !foot.jy && !foot.vy && !pick && !entering) { foot.vy = 5.4; if (!jumpHeld) jumpHeld = true; }
      if (!keys.Space) jumpHeld = false;
      if (foot.vy || foot.jy) { foot.vy -= 15 * dt; foot.jy = Math.max(0, foot.jy + foot.vy * dt); if (!foot.jy && foot.vy < 0) foot.vy = 0; }
      const nx = foot.x + foot.vx * dt, nz = foot.z + foot.vz * dt;
      if (legalFoot(nx, foot.z, foot.jy)) foot.x = nx; else foot.vx = 0;
      if (legalFoot(foot.x, nz, foot.jy)) foot.z = nz; else foot.vz = 0;
      foot.y = city.heightAt(foot.x, foot.z, foot.y);
      if (aiming || fireHeld) yaw = lookYaw;
      else if (Math.hypot(foot.vx, foot.vz) > 0.15) yaw = Math.atan2(foot.vx, foot.vz);
      foot.h = yaw;
      const fsp = Math.hypot(foot.vx, foot.vz);
      walkPhase += dt * fsp * Math.PI * 2 / (1.4 + 0.12 * fsp);
      aimBlend = mix(aimBlend, aiming || fireHeld ? 1 : 0, Math.min(1, dt * 12));
      animateFigure(avatar, { phase: walkPhase, gait: gaitOf(fsp), aim: weapon ? aimBlend : 0, weapon, air: foot.jy > 0.05, t: performance.now() / 1000 });
      uiAcc += dt; syncProxy(); updateMarker();
      if (uiAcc >= 0.1) { mark(uiAcc); uiAcc = 0; if (status) status.textContent = statusText(); }
      if (dt > 0) aimAssist(dt);
      if (fireHeld && dt > 0) fire(); // never from a paused frame (menus)
    }
    // runs every frame whether you're on foot or driving: pedestrians, run-overs, parked cars
    // Officers on foot: out of a stopped cruiser, they run you down, shoot from two stars (or if you're armed) and
    // put the cuffs on if they get a hand on you. When the chase is over they walk back to the car.
    function deploy(v) {
      v.deployed = true;
      if (peds.filter(p => p.cop && p.alive).length >= 10) return;
      for (const sg of [1, -1]) {
        const x = v.x + Math.cos(v.h) * sg * 1.6, z = v.z - Math.sin(v.h) * sg * 1.6;
        if (!legalFoot(x, z) || city.surfaceAt(x, z) === 'water') continue;
        const c = addPed(x, z, true); c.car = v; c.y = city.heightAt(x, z, v.y); c.gunT = 0.8 + Math.random();
      }
      if (v.driverMesh) v.driverMesh.visible = false;
      if (v.state === 'pursue') v.state = 'halt';
      v.staged = true; // traffic keeps a staged cruiser while you're near, so its crew has something to go back to
    }
    function copStep(p, i, step, driving) {
      const L = police.state.level, dx = player.x - p.x, dz = player.z - p.z, d = Math.hypot(dx, dz) || 1;
      const arms = p.mesh.userData.arms;
      if (!L) { // stand down: back to the car, then gone
        const v = p.car, home = v && v.state !== 'idle' ? v : null;
        const tx = home ? home.x : p.x + p.vx, tz = home ? home.z : p.z + p.vz, hd = Math.hypot(tx - p.x, tz - p.z);
        if (!home || hd < 2.2 || d > 90) { scene.remove(p.mesh); peds.splice(i, 1); if (home && home.driverMesh) home.driverMesh.visible = true; if (home) home.deployed = false; return; }
        p.vx = (tx - p.x) / hd * 2.2; p.vz = (tz - p.z) / hd * 2.2;

      } else {
        const los = d < 70 && Math.abs(player.y - p.y) < 4 && traffic.police.sightClear(p.x, p.z, player.x, player.z, p.y);
        const shoot = (L >= 2 || player.armed) && los && d < 42;
        p.gunT -= step;
        if (shoot && p.gunT <= 0 && d > 2) { p.gunT = 0.8 + Math.random() * 0.8 - L * 0.06; onCopShoot?.({ x: p.x, y: p.y, z: p.z, ped: p }, L); p.aimT = 0.5; }
        p.aimT = (p.aimT || 0) - step;
        // sat still (or strolling) at one or two stars: they come and get you; higher up they hold back and shoot
        const pinned = Math.hypot(player.vx, player.vz) < (driving ? 1.5 : 2.5) && L <= 2;
        const run = !los || d > (shoot && !pinned ? 16 : 1.1);
        const sp = p.aimT > 0 ? 1.2 : 5.6;
        p.vx = run ? dx / d * sp : 0; p.vz = run ? dz / d * sp : 0;

        if (p.aimT > 0) p.mesh.rotation.y = Math.atan2(dx, dz);
        // hands on: on foot (and not sprinting clear) or sat in a stopped car with the door open
        if (d < 1.9 && ((!driving && Math.hypot(foot.vx, foot.vz) < 5) || (driving && Math.hypot(player.vx, player.vz) < 1.5))) police.arrest(step);
      }
      const nx = p.x + p.vx * step, nz = p.z + p.vz * step;
      if (!blocked(nx, nz, p.y, 0.3)) { p.x = nx; p.z = nz; }
      else { // step round whatever is in the way
        const a = Math.atan2(p.vx, p.vz) + (p.side || (p.side = Math.random() < 0.5 ? 1 : -1)) * 1.1, sp = Math.hypot(p.vx, p.vz);
        const ax = p.x + Math.sin(a) * sp * step, az = p.z + Math.cos(a) * sp * step;
        if (!blocked(ax, az, p.y, 0.3)) { p.x = ax; p.z = az; } else p.side = -p.side;
      }
    }
    // everyone near enough to see moves every frame (the AI itself thinks at 20 Hz)
    function animatePeds(dt) {
      const now = performance.now() / 1000, L = police.state.level;
      for (const p of peds) {
        if (!p.alive) continue;
        const d = Math.hypot(p.x - camera.position.x, p.z - camera.position.z);
        if (d > 110) continue;
        const sp = Math.hypot(p.vx, p.vz);
        p.walk = (p.walk || p.phase) + dt * sp * Math.PI * 2 / (1.4 + 0.12 * sp);
        p.aimB = mix(p.aimB || 0, p.cop && p.aimT > 0 ? 1 : 0, Math.min(1, dt * 10));
        animateFigure(p.mesh, { phase: p.walk, gait: gaitOf(sp), aim: p.aimB, weapon: p.cop && L > 0 ? 1 : 0, t: now + p.phase, near: d < 32 });
      }
    }
    function updateWorld(dt, driving, carSpeed) {
      pedAcc += dt; spawnT -= dt;
      if (dt > 0) animatePeds(dt);
      fx.update(dt);
      if (spawnT <= 0) { spawnT = 1; pedSpawn(); spawnParked(); }
      hurtT += dt;
      if (hurtT > 6 && foot.hp < 100) foot.hp = Math.min(100, foot.hp + dt * 4);
      if (!active && status && (uiAcc += dt) > 0.25) { mark(uiAcc); uiAcc = 0; status.textContent = `HEALTH ${Math.round(foot.hp)}` + (foot.armor > 0 ? ` · ARMOUR ${Math.round(foot.armor)}` : ''); }
      // ammo dropped by fallen officers: walk over it
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i]; d.t += dt; d.m.rotation.y += dt * 2;
        if (active && Math.hypot(d.x - foot.x, d.z - foot.z) < 1.4) { ammo[1].res += 24; ammo[2].res += 60; ammo[3].res += 8; say('Picked up ammo', 1.4); }
        else if (d.t < 60) continue;
        scene.remove(d.m); drops.splice(i, 1);
      }
      if (pedAcc < 0.05) return;
      const step = pedAcc; pedAcc = 0;
      // you've driven off: the crew close to their cruiser jump back in and it rejoins the chase
      if (police.state.level > 0 && driving && carSpeed > 6) for (const v of traffic.police.units()) {
        if (!v.deployed || v.state !== 'halt' || Math.hypot(v.x - player.x, v.z - player.z) < 40) continue;
        for (let i = peds.length - 1; i >= 0; i--) { const q = peds[i]; if (q.car === v && q.alive && Math.hypot(q.x - v.x, q.z - v.z) < 25) { scene.remove(q.mesh); peds.splice(i, 1); } }
        v.deployed = false; v.staged = false; if (v.driverMesh) v.driverMesh.visible = true;
        traffic.police.startPursuit(v);
      }
      if (police.state.level > 0) for (const v of traffic.police.units()) {
        if (v.deployed || (v.state !== 'pursue' && v.state !== 'block')) continue;
        const d = Math.hypot(v.x - player.x, v.z - player.z);
        if ((Math.hypot(v.vx, v.vz) < 2.5 && d < 30 && (!driving || carSpeed < 4)) || (v.state === 'block' && d < 55)) deploy(v);
      }
      for (let i = peds.length - 1; i >= 0; i--) {
        const p = peds[i];
        if (!p.alive) {
          p.deadT += step;
          if (p.deadT > 25) { scene.remove(p.mesh); peds.splice(i, 1); }
          continue;
        }
        if (p.cop && (p.car || police.state.level > 0)) {
          copStep(p, i, step, driving);
          if (peds[i] !== p) continue;
        } else if (p.flee) {
          p.t += step;
          const nx = p.x + p.vx * step, nz = p.z + p.vz * step;
          if (blocked(nx, nz, p.y, 0.3)) { const t = p.vx; p.vx = -p.vz; p.vz = t; } else { p.x = nx; p.z = nz; }
          if (p.t > 8) { p.flee = false; p.t = 0; }
        } else {
          p.phase += step * 0.35;
          const vx = Math.sin(p.phase) * 1.3, vz = Math.cos(p.phase * 0.7) * 1.3;
          const nx = p.x + vx * step, nz = p.z + vz * step;
          if (city.walkAt(nx, nz) && !blocked(nx, nz, p.y, 0.3)) { p.x = nx; p.z = nz; p.vx = vx; p.vz = vz; } else p.phase += 1.3;
        }
        p.y = city.heightAt(p.x, p.z, p.y);
        p.mesh.position.set(p.x, p.y, p.z);
        const sp = Math.hypot(p.vx, p.vz);
        if (sp > 0.1) p.mesh.rotation.y = Math.atan2(p.vx, p.vz);
        const ud = p.mesh.userData;

        // getting hit by your car
        if (driving && carSpeed > 4.5 && Math.hypot(p.x - player.x, p.z - player.z) < 1.9 && Math.abs(p.y - player.y) < 2) {
          killPed(p, 'car');
        } else if (driving && carSpeed > 6 && !p.flee && Math.hypot(p.x - player.x, p.z - player.z) < 9) {
          const d = Math.hypot(p.x - player.x, p.z - player.z) || 1; p.flee = true; p.t = 3; p.vx = ((p.x - player.x) / d) * 4; p.vz = ((p.z - player.z) / d) * 4;
        }
      }
    }
    function setWeapon(n) { weapon = clamp(n | 0, 0, 3); player.armed = weapon > 0; reloadT = 0; if (status) status.textContent = statusText(); }
    // Aim assist (GTA's soft lock): while aiming, the view eases onto the nearest person close to the crosshair.
    // The crosshair goes red over someone; a white flash marks a hit.
    const cross = document.getElementById('crosshair'), camDir = new THREE.Vector3();
    let lockT = 0, lockOn = null;
    function hitMark() { if (!cross) return; cross.classList.add('hit'); clearTimeout(hitMark.t); hitMark.t = setTimeout(() => cross.classList.remove('hit'), 140); }
    function aimAssist(dt) {
      if ((lockT -= dt) <= 0) {
        lockT = 0.1; lockOn = null;
        if (aiming && weapon > 0) {
          camera.getWorldDirection(camDir);
          const cy0 = Math.atan2(camDir.x, camDir.z);
          let best = 0.22;
          for (const p of peds) {
            if (!p.alive || p.mesh.visible === false) continue;
            const dx = p.x - camera.position.x, dz = p.z - camera.position.z, d = Math.hypot(dx, dz);
            if (d > 55 || d < 2) continue;
            let a = Math.atan2(dx, dz) - cy0; a = Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) - (p.cop && police.state.level ? 0.06 : 0);
            if (a < best && traffic.police.sightClear(foot.x, foot.z, p.x, p.z, foot.y)) { best = a; lockOn = p; }
          }
        }
        cross?.classList.toggle('target', !!lockOn);
      }
      if (!lockOn || !aiming) return;
      camera.getWorldDirection(camDir);
      const tx = lockOn.x - camera.position.x, ty = lockOn.y + 1.25 - camera.position.y, tz = lockOn.z - camera.position.z, th = Math.hypot(tx, tz);
      let dy = Math.atan2(tx, tz) - Math.atan2(camDir.x, camDir.z); dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const de = Math.atan2(ty, th) - Math.asin(clamp(camDir.y, -1, 1));
      const k = Math.min(1, dt * 9);
      lookYaw += dy * k; pitch = clamp(pitch - de * k, -0.55, 0.7);
    }
    function mouseMove(dx, dy) { if (!active) return; lookYaw -= dx * 0.0026; pitch = clamp(pitch + dy * 0.0022, -0.55, 0.7); }
    function mouseButton(button, down) { if (!active) return; if (button === 0) fireHeld = down; if (button === 2) aiming = down; }
    function updateCamera(dt) {
      if (!active) return false;
      recoil *= Math.exp(-dt * 9); shake *= Math.exp(-dt * 14);
      const pt = pitch - recoil, cp = Math.cos(pt), sp = Math.sin(pt), bx = Math.sin(lookYaw) * cp, bz = Math.cos(lookYaw) * cp;
      const rx = -Math.cos(lookYaw), rz = Math.sin(lookYaw), shoulder = aiming ? 0.55 : 0.35;
      const targetX = foot.x + rx * shoulder, targetY = foot.y + 1.55 + (foot.jy || 0) * 0.6, targetZ = foot.z + rz * shoulder;
      const dist = aiming ? 2.4 : 4.4, height = aiming ? 0.15 : 0.55;
      tmp.set(targetX - bx * dist, targetY + height + sp * dist, targetZ - bz * dist);
      const gy = city.heightAt(tmp.x, tmp.z, foot.y); if (tmp.y < gy + 0.5) tmp.y = gy + 0.5;
      camera.position.lerp(tmp, 1 - Math.exp(-dt * (aiming ? 14 : 8)));
      if (shake > 0.01) camera.position.add(tmp.set((Math.random() - 0.5) * shake * 0.12, (Math.random() - 0.5) * shake * 0.12, (Math.random() - 0.5) * shake * 0.12));
      camera.lookAt(targetX + bx * 30, targetY - sp * 20, targetZ + bz * 30);
      camera.fov = mix(camera.fov, aiming ? 50 : 65, 1 - Math.exp(-dt * 7)); camera.updateProjectionMatrix();
      return true;
    }
    function breakWindow() {
      if (!active || entering) return false;
      const t = currentTarget();
      if (!t) { say('No vehicle close enough'); return false; }
      if (t.type === 'parked' && t.record.npc && t.record.locked) { say('Window smashed · alarm going off'); finishSteal(t.record, 'smash'); return true; }
      if (t.type === 'traffic') { traffic.threaten(t.vehicle, 4); onCrime('assault', { vehicle: t.vehicle }); say('Window smashed · the driver panics'); return true; }
      say('That one is unlocked. Press F'); return false;
    }
    function addPed(x, z, cop = false) {
      const mesh = figure(scene, cop, 0.92 + Math.random() * 0.12, Math.random() + 0.01);
      const p = { mesh, x, z, y: city.heightAt(x, z), vx: 0, vz: 0, hp: cop ? 100 : 45, alive: true, cop, flee: false, t: 0, phase: Math.random() * 6.28 };
      mesh.position.set(x, p.y, z); mesh.userData.ped = p; peds.push(p); return p;
    }

    police.setEyes?.(range => {
      let n = 0;
      for (const p of peds) if (p.cop && p.alive && Math.hypot(p.x - player.x, p.z - player.z) < range && traffic.police.sightClear(p.x, p.z, player.x, player.z, p.y)) n++;
      return n;
    });
    const api = {
      get onFoot() { return active; }, get armed() { return weapon > 0; }, get position() { return foot; }, get health() { return foot.hp; }, get weapon() { return weapon; },
      get peds() { return peds; }, get parked() { return parked; }, get picking() { return pick; },
      startAt: enterFoot, setDriving: enterCar, updateFixed, updateWorld, updateCamera, mouseMove, mouseButton, fire, setWeapon, interact, breakWindow,
      addParked, removeParked, currentTarget, addPed, pavementNear, fx, say,
      heal() { foot.hp = 100; foot.alive = true; },
      clearCops() { for (let i = peds.length - 1; i >= 0; i--) if (peds[i].cop) { scene.remove(peds[i].mesh); peds.splice(i, 1); } },
      reload() { const a = ammo[weapon]; if (weapon > 0 && !reloadT && a.res > 0 && a.mag < (weapon === 3 ? 8 : weapon === 2 ? 30 : 12)) { reloadT = weapon === 3 ? 1.6 : 1.25; say('Reloading', 1); } },
      get armor() { return foot.armor; },
      addArmor(n) { foot.armor = Math.min(100, foot.armor + n); },
      refillAmmo() { ammo[1].res = Math.max(ammo[1].res, 120); ammo[2].res = Math.max(ammo[2].res, 300); ammo[3].res = Math.max(ammo[3].res, 48); if (status && active) status.textContent = statusText(); },
      get ammo() { return ammo; },
      /** Shot (or hurt) at the wheel */
      hurtDriver(amount) {
        if (active) return api.hurt(amount);
        hurtT = 0;
        if (foot.armor > 0) { const soak = Math.min(foot.armor, amount * 0.7); foot.armor -= soak; amount -= soak; }
        foot.hp = Math.max(0, foot.hp - amount);
        if (status) status.textContent = `HEALTH ${Math.round(foot.hp)}` + (foot.armor > 0 ? ` · ARMOUR ${Math.round(foot.armor)}` : '');
        if (foot.hp <= 0 && foot.alive) { foot.alive = false; onPlayerWasted?.(foot); }
        return true;
      },
      /** A police bullet at you on foot (from a cruiser, an officer or the helicopter) */
      copFire(sh, L) {
        const d = Math.hypot(sh.x - foot.x, sh.z - foot.z), sp = Math.hypot(foot.vx, foot.vz);
        const hit = Math.random() < clamp(0.62 - d * 0.009 - sp * 0.045 + L * 0.03, 0.08, 0.8);
        const sy = (sh.y || 0) + 1.35, miss = hit ? 0.2 : 1.6;
        const ax = foot.x + (Math.random() - 0.5) * miss, az = foot.z + (Math.random() - 0.5) * miss, ay = foot.y + (hit ? 1.2 : Math.random() * 1.6);
        fx.flash(sh.x, sy, sh.z); fx.tracer(sh.x, sy, sh.z, ax, ay, az); onGunFx?.(-1, d);
        if (hit) { fx.impact(ax, ay, az, 'blood'); fx.flashDamage(); api.hurt(6 + L * 2); }
        else fx.impact(ax, city.heightAt(ax, az, foot.y) + 0.05, az, 'dust');
      },
      /** Civilians close enough to see what you just did */
      civWitnesses(r = 40) { let n = 0; for (const p of peds) if (p.alive && !p.cop && Math.hypot(p.x - player.x, p.z - player.z) < r) n++; return n; },
      hurt(amount) {
        if (!active) return false;
        hurtT = 0;
        if (foot.armor > 0) { const soak = Math.min(foot.armor, amount * 0.7); foot.armor -= soak; amount -= soak; }
        foot.hp = Math.max(0, foot.hp - amount);
        if (status) status.textContent = statusText();
        if (foot.hp <= 0 && foot.alive) { foot.alive = false; onPlayerWasted?.(foot); }
        return true;
      },
      setFootPosition(pose) { foot.x = pose.x; foot.z = pose.z; foot.y = city.heightAt(pose.x, pose.z, pose.y || foot.y); foot.h = pose.h || yaw; foot.vx = foot.vz = 0; yaw = lookYaw = foot.h; updateMarker(); syncProxy(); },
      getPrompt() { return prompt ? prompt.textContent : ''; },
      cleanup() { scene.remove(avatar); for (const p of peds) scene.remove(p.mesh); for (const r of parked) if (!r.removed) scene.remove(r.mesh); },
    };
    return api;
  };
})();
