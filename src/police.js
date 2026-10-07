// Police: patrol cars watch the traffic around them. Speeding, driving on the pavement, the wrong way or into
// other cars where a patrol can see it gets you a wanted level (1-5 stars) and a bounty. While you're wanted,
// more units are sent after you; out of sight long enough and you lose them (the bounty stays on your head and
// any cop who gets a good look at you will remember). Stop with a cruiser alongside and you're busted.
(function () {
'use strict';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

window.createPolice = function ({ traffic, city, player, audio, scene, onBusted, onEscaped = () => {}, onShot = () => {}, onSpikes = () => {} }) {
  const P = traffic.police, pol = P.state;
  const CHASERS = [0, 2, 3, 5, 7, 9];           // units after you at each wanted level
  const SEE = [70, 110, 130, 150, 170, 190];     // how far a cop can make you out, by level
  const S = { level: 0, bounty: 0, heat: 0, evadeT: 0, bustT: 0, speedT: 0, walkT: 0, wrongT: 0, knowT: 0,
    spawnT: 0, laneT: 0, lane: null, seen: false, seenBy: null, wrecked: new Set(), downed: 0, busted: 0, t: 0,
    lastSeen: null, inZone: true, reports: [], spikes: [], blockT: 6 };
  // Once they lose sight of you they search round where you were last seen: the zone grows with the stars, and
  // the evade clock barely moves while you're still inside it
  const zoneR = () => 55 + 28 * S.level;
  let eyes = null; // officers on foot (from the crime layer): (range) => how many of them can see you
  const el = id => document.getElementById(id);
  const starsEl = el('stars'), bountyEl = el('bounty'), msgEl = el('copmsg'), wantedEl = el('wanted');
  let msgT = 0, shotT = 0;
  function say(title, sub, ms = 2600, cls = '') {
    msgEl.innerHTML = `<b>${title}</b>${sub ? `<span>${sub}</span>` : ''}`;
    msgEl.className = 'show ' + cls; msgT = ms / 1000;
  }
  const money = n => '$' + Math.round(n).toLocaleString('en-US');

  // Which police units can see you right now (within range and with no building in the way)
  function witnesses(range) {
    const out = [];
    for (const v of P.units()) {
      if (v.state === 'wreck') continue;
      const d = Math.hypot(v.x - player.x, v.z - player.z);
      if (d < range && Math.abs(v.y - player.y) < 8 && P.sightClear(v.x, v.z, player.x, player.z, Math.min(v.y, player.y))) out.push(v);
    }
    return out;
  }
  // the same offence again within a few seconds (a magazine into one cruiser) is one offence, not thirty
  const lastCash = new Map();
  const PAYOUT = [0, 1500, 4000, 9000, 16000, 30000]; // most an escape can bank, by the highest stars of the chase
  function raise(level, why, cash) {
    const was = S.level;
    if (S.t - (lastCash.get(why) ?? -99) > 4) { S.bounty += cash; lastCash.set(why, S.t); }
    S.level = clamp(Math.max(S.level, level), 0, 5);
    S.maxLevel = Math.max(S.maxLevel || 0, S.level);
    pol.target = pol.target || { x: player.x, y: player.y, z: player.z, vx: 0, vz: 0, h: 0 };
    if (!was && S.level) { S.heat = 0; S.lastSeen = { x: player.x, z: player.z }; Object.assign(pol.target, { x: player.x, y: player.y, z: player.z, vx: player.vx, vz: player.vz, h: player.h }); say(why, `Wanted · ${money(cash)} bounty`, 2600, 'red'); }
    else if (S.level > was) say(why, `Wanted level ${S.level}`, 2200, 'red');
    if (S.level) {
      pol.active = true; S.evadeT = 0;
      for (const v of witnesses(SEE[S.level])) P.startPursuit(v);
      if (!was) { P.spawnChaser(); S.spawnT = 1; } // the nearest unit is dispatched at once
    }
  }
  // a crime only counts if a cop saw it (hitting a cop always counts)
  function crime(level, why, cash, always = false) {
    if (S.graceT > 0 && !always) return false; // just out of hospital or the cells: give them a moment
    if (always || witnesses(SEE[S.level]).length || (eyes && eyes(60) > 0)) { raise(level, why, cash); return true; }
    return false;
  }
  // a civilian saw it and called it in: after a short delay the police know roughly where you were
  function report(level, why, cash, delay = 6) {
    if (S.graceT > 0) return;
    if (S.reports.length < 4) S.reports.push({ level, why, cash, t: delay, x: player.x, y: player.y, z: player.z });
  }

  // Helicopter (4+ stars): circles overhead with a searchlight; it sees you unless something is over your head
  const heli = (() => {
    const g = new THREE.Group(), dark = new THREE.MeshStandardMaterial({ color: '#141a2a', roughness: 0.4, metalness: 0.5 });
    const white = new THREE.MeshStandardMaterial({ color: '#e8e8e4', roughness: 0.4 }), glass = new THREE.MeshStandardMaterial({ color: '#0d1218', roughness: 0.05, metalness: 0.8 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), dark); body.scale.set(1.25, 1.15, 2.4); g.add(body);
    const band = new THREE.Mesh(new THREE.SphereGeometry(1.01, 16, 10, 0, Math.PI * 2, 1.45, 0.35), white); band.scale.copy(body.scale); g.add(band);
    const cab = new THREE.Mesh(new THREE.SphereGeometry(0.95, 14, 8, 0, Math.PI * 2, 0, 1.3), glass); cab.scale.set(1.15, 1, 1.4); cab.position.set(0, 0.1, 1.2); g.add(cab);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.38, 5.2, 8).rotateX(Math.PI / 2), dark); boom.position.set(0, 0.35, -4.4); g.add(boom);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.4, 0.9), dark); fin.position.set(0, 1, -6.8); g.add(fin);
    for (const sx of [-1, 1]) { const skid = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 3.6), dark); skid.position.set(sx * 1.05, -1.35, 0.2); g.add(skid); }
    const rotor = new THREE.Group(); rotor.position.y = 1.35; g.add(rotor);
    for (let k = 0; k < 4; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 10.5), dark); b.rotation.y = k * Math.PI / 4; rotor.add(b); }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(5.3, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#202530', transparent: true, opacity: 0.18, depthWrite: false }));
    rotor.add(disc);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.5, 0.12), dark); tail.position.set(0.15, 1, -6.8); g.add(tail);
    // searchlight: a soft cone from the nose to the ground
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 24, 1, true).translate(0, -0.5, 0),
      new THREE.MeshBasicMaterial({ color: '#fff4d8', transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    scene.add(cone);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: '#ff3030' })); beacon.position.set(0, -1.2, -1); g.add(beacon);
    g.visible = false; cone.visible = false; scene.add(g);
    return { g, rotor, tail, cone, beacon, on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ang: 0, sees: false };
  })();
  function heliUpdate(dt) {
    const H = heli, want = S.level >= 4;
    if (want && !H.on) { // arrives from a few hundred metres out
      H.on = true; const a = Math.random() * Math.PI * 2;
      Object.assign(H, { x: player.x + Math.sin(a) * 450, z: player.z + Math.cos(a) * 450, y: player.y + 90, vx: 0, vy: 0, vz: 0 });
      say('Air support', 'Get under cover', 2200, 'red');
    }
    if (!H.on) return;
    const T = pol.target;
    H.ang += dt * 0.25;
    // orbit the target (or fly off and climb once it's over)
    let gx = T.x + Math.sin(H.ang) * 35, gz = T.z + Math.cos(H.ang) * 35, gy = city.groundAt(T.x, T.z) + 55;
    if (!want) { gx = H.x + (H.x - player.x) * 2; gz = H.z + (H.z - player.z) * 2; gy = H.y + 40; }
    const k = 0.9, c = 2 * Math.sqrt(k);
    H.vx += ((gx - H.x) * k - H.vx * c) * dt; H.vz += ((gz - H.z) * k - H.vz * c) * dt; H.vy += ((gy - H.y) * k - H.vy * c) * dt;
    const sp = Math.hypot(H.vx, H.vz); if (sp > 45) { H.vx *= 45 / sp; H.vz *= 45 / sp; }
    H.x += H.vx * dt; H.y += H.vy * dt; H.z += H.vz * dt;
    const g = H.g; g.visible = true;
    g.position.set(H.x, H.y, H.z);
    g.rotation.set(clamp(sp * 0.008, 0, 0.3), Math.atan2(H.vx, H.vz) || g.rotation.y, 0, 'YXZ');
    H.rotor.rotation.y += dt * 38; H.tail.rotation.x += dt * 60;
    H.beacon.visible = (S.t * 1.5) % 1 < 0.15;
    // searchlight onto you, and are you under something (a bridge or a deck)?
    const covered = city.heightAt(player.x, player.z, player.y + 12) > player.y + 3;
    const hd = Math.hypot(H.x - player.x, H.z - player.z);
    H.sees = want && hd < 170 && !covered && P.sightClear(H.x, H.z, player.x, player.z, player.y + 25);
    const cone = H.cone, dx = player.x - H.x, dy = player.y - H.y, dz = player.z - H.z, L = Math.hypot(dx, dy, dz);
    cone.visible = want && H.sees;
    if (cone.visible) {
      cone.position.set(H.x, H.y - 1.2, H.z);
      cone.scale.set(4.5, L, 4.5);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(dx / L, dy / L, dz / L));
    }
    if (!want && hd > 600) { H.on = false; g.visible = false; cone.visible = false; }
    H.gunT = (H.gunT ?? 3) - dt;
    if (S.level >= 5 && H.sees && hd < 120 && H.gunT <= 0) { H.gunT = 1.4 + Math.random(); onShot({ x: H.x, y: H.y - 2.5, z: H.z, heli: true }, S.level); }
  }

  // Siren: a two-tone wail that turns to a yelp up close, louder the nearer the nearest unit
  let siren = null;
  function sirenInit() {
    const ctx = audio.ctx;
    if (!ctx || siren) return;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const o2 = ctx.createOscillator(); o2.type = 'square';
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.value = 0;
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    o.connect(bp); o2.connect(g2); g2.connect(bp); bp.connect(g); g.connect(audio.master);
    o.start(); o2.start();
    siren = { o, o2, g };
  }

  function update(dt, inp) {
    S.t += dt;
    if (msgT > 0) { msgT -= dt; if (msgT <= 0) msgEl.className = ''; }
    const sp = Math.hypot(player.vx, player.vz);
    pol.target = pol.target || { x: player.x, y: player.y, z: player.z, vx: 0, vz: 0, h: 0 };

    // where am I? (lane limit and direction, a few times a second)
    S.laneT -= dt;
    if (S.laneT <= 0) { S.laneT = 0.2; S.lane = city.nearestLanePose(player.x, player.z, player.y); }
    const L = S.lane;

    // --- Offences
    if (L && L.d < 30) {
      const limit = L.speed, over = sp > limit * 1.3 + 4;
      S.speedT = over ? S.speedT + dt : Math.max(0, S.speedT - dt);
      if (S.speedT > 1 && S.level < 1) { S.speedT = 0; crime(1, 'Speeding', 200 + Math.round((sp - limit) * 3.6) * 5); }
      const wrong = L.d < 3 && sp > 9 && L.kind !== 'fwy' && Math.cos(Math.atan2(player.vx, player.vz) - L.h) < -0.6;
      const fwyWrong = L.kind === 'fwy' && L.d < 4 && sp > 9 && Math.cos(Math.atan2(player.vx, player.vz) - L.h) < -0.6;
      S.wrongT = wrong || fwyWrong ? S.wrongT + dt : 0;
      if (S.wrongT > 1.5 && S.level < (fwyWrong ? 2 : 1)) { S.wrongT = 0; crime(fwyWrong ? 2 : 1, 'Wrong-way driving', fwyWrong ? 900 : 300); }
    }
    const onWalk = city.walkAt(player.x, player.z) || player.surface === 'grass';
    S.walkT = onWalk && sp > 11 ? S.walkT + dt : 0;
    if (S.walkT > 0.8 && S.level < 1) { S.walkT = 0; crime(1, 'Reckless driving', 300); }
    for (const v of traffic.vehicles) {
      if (!v.playerDv) continue;
      const dv = v.playerDv; v.playerDv = 0;
      // one offence per collision: contact within a second of the last counts as the same one
      if (S.t - (v.lastHitT ?? -99) > 1) { v.hitAcc = 0; v.hitFired = false; }
      v.lastHitT = S.t; v.hitAcc += dv;
      if (v.hitFired || v.hitAcc < 1.2) continue;
      v.hitFired = true;
      if (v.state === 'pursue' && sp < Math.hypot(v.vx, v.vz) + 3) continue; // they rammed you
      v.struckT = S.t; // you hit them
      if (v.police) raise(Math.max(2, S.level), 'Assaulting an officer', 1500, true);
      else crime(Math.max(1, S.level), 'Hit and run', 400 + Math.round(v.hitAcc * 60));
    }
    // a pursuit car you've wrecked
    for (const v of P.units()) if (v.state === 'wreck' && !S.wrecked.has(v) && S.level && S.t - (v.struckT ?? -99) < 3) { // you did that
      S.wrecked.add(v); S.downed++; S.bounty += 1000;
      if (S.downed % 2 === 0) raise(S.level + 1, 'Officer down', 0);
    }
    for (const v of S.wrecked) if (v.state !== 'wreck') S.wrecked.delete(v);

    // a known face: with a big enough bounty, any cop who gets a good look at you starts a chase
    // recently got away: any cop who gets a good look at you in the next minute or two picks the chase back up
    S.knownT = Math.max(0, (S.knownT || 0) - dt); S.graceT = Math.max(0, (S.graceT || 0) - dt);
    if (!S.level && S.knownT > 0) {
      const close = witnesses(60);
      S.knowT = close.length || (eyes && eyes(30)) ? S.knowT + dt : 0;
      if (S.knowT > 1.5) { S.knowT = 0; raise(1, 'Recognised', 0); }
    }
    // calls from witnesses
    for (let i = S.reports.length - 1; i >= 0; i--) {
      const r = S.reports[i];
      if ((r.t -= dt) > 0) continue;
      S.reports.splice(i, 1);
      if (r.level <= S.level) { S.bounty += r.cash; continue; }
      raise(r.level, r.why + ' · reported by a witness', r.cash);
      S.lastSeen = { x: r.x, z: r.z }; S.seenOnce = false;
      Object.assign(pol.target, { x: r.x, y: r.y, z: r.z, vx: 0, vz: 0 });
    }

    // --- The chase
    // line-of-sight checks ten times a second
    S.lookT = (S.lookT || 0) - dt;
    if (S.lookT <= 0) { S.lookT = 0.1; S.seenBy = S.level ? witnesses(SEE[S.level]) : []; }
    const seenBy = S.seenBy || [];
    heliUpdate(dt);
    const closeUnit = S.level && P.units().some(v => v.state === 'pursue' && Math.hypot(v.x - player.x, v.z - player.z) < 35);
    S.seen = seenBy.length > 0 || heli.sees || closeUnit || (S.level > 0 && !!eyes && eyes(SEE[S.level] * 0.6) > 0);
    // officers in the cruisers shoot from two stars (one, if you're armed): the more units in range, the more lead
    shotT -= dt;
    if (S.level >= 2 || (S.level === 1 && player.armed)) {
      if (shotT <= 0) {
        const shooters = [];
        for (const v of P.units()) {
          if (v.state !== 'pursue' && v.state !== 'block') continue;
          const d = Math.hypot(v.x - player.x, v.z - player.z);
          if (d < 48 && d > 3 && P.sightClear(v.x, v.z, player.x, player.z, Math.min(v.y, player.y))) shooters.push([d, v]);
        }
        if (shooters.length) {
          shooters.sort((a, b) => a[0] - b[0]);
          onShot(shooters[(Math.random() * Math.min(3, shooters.length)) | 0][1], S.level);
          shotT = Math.max(0.3, 1.5 - 0.17 * S.level) / Math.sqrt(Math.min(3, shooters.length)) * (0.75 + Math.random() * 0.5);
        }
      }
    }
    // roadblock units join in once you're through (or round) them
    for (const v of P.units()) if (v.state === 'block') {
      const qx = v.x - player.x, qz = v.z - player.z, dd = Math.hypot(qx, qz);
      if (dd < 18 || (dd < 90 && qx * player.vx + qz * player.vz < 0)) P.startPursuit(v);
    }
    if (S.level) {
      if (S.seen) {
        S.evadeT = Math.max(0, S.evadeT - dt * 4); S.inZone = true; S.seenOnce = true;
        S.lastSeen = { x: player.x, z: player.z };
        Object.assign(pol.target, { x: player.x, y: player.y, z: player.z, vx: player.vx, vz: player.vz, h: player.h });
        for (const v of seenBy) if (v.state === 'drive') P.startPursuit(v);
        const nearUnits = P.units().filter(v => v.state === 'pursue' && Math.hypot(v.x - player.x, v.z - player.z) < 70).length;
        S.heat += dt * (1 + 0.15 * nearUnits);
        if (S.heat > 50 && S.level < 5) { S.heat = 0; raise(S.level + 1, 'Pursuit escalating', 500 * S.level); }
        S.bounty += 8 * S.level * dt;
      } else {
        // they head for where you were last seen, and search the streets round it
        pol.target.vx *= 0.9; pol.target.vz *= 0.9;
        const ls = S.lastSeen || { x: player.x, z: player.z };
        const out = Math.hypot(player.x - ls.x, player.z - ls.z) > zoneR();
        S.inZone = !out;
        S.searchT = (S.searchT || 0) - dt;
        if (S.evadeT < 2.5) Object.assign(pol.target, { x: ls.x, z: ls.z }); // first: straight to where you were
        else if (S.searchT <= 0) { // each sweep sends them to a different street inside the zone
          S.searchT = 6;
          const a = Math.random() * Math.PI * 2, r = Math.random() * zoneR();
          Object.assign(pol.target, { x: ls.x + Math.cos(a) * r, z: ls.z + Math.sin(a) * r });
        }
        S.evadeT += dt * (out ? 1.6 : 0.4);
        if (S.evadeT > 6 + 3.5 * S.level) {
          const earned = Math.round(Math.min(S.bounty, PAYOUT[S.maxLevel || S.level])), earnedStars = S.maxLevel || S.level;
          onEscaped(earned, earnedStars); S.maxLevel = 0;
          say('Evaded', earned ? `${money(earned)} banked` : 'Lay low for a while', 3000, 'blue');
          S.knownT = 60 + 30 * earnedStars; // your face is fresh in their minds for a while
          S.level = 0; S.bounty = 0; S.heat = 0; S.downed = 0; S.evadeT = 0; S.lastSeen = null; S.reports.length = 0; P.standDown();
        }
      }
      // three stars and up: roadblocks on the road ahead
      S.blockT -= dt;
      if (S.level >= 3 && S.blockT <= 0) { const rb = P.spawnRoadblock(); S.blockT = rb ? 22 : 3; if (rb) { addSpikes(rb); say('Roadblock ahead', 'Spike strip on the road', 2000, 'red'); } }
      // units that are wedged or hopelessly far behind are quietly swapped for fresh ones closer in
      for (const v of P.units()) {
        if (v.state !== 'pursue') continue;
        const d = Math.hypot(v.x - player.x, v.z - player.z), vs = Math.hypot(v.vx, v.vz);
        // progress: seconds since this unit last got 5 m closer to where it's going
        const gd = Math.hypot(v.x - pol.target.x, v.z - pol.target.z);
        if (!v.prog || gd < v.prog - 5 || gd < 25) { v.prog = gd; v.progAt = S.t; }
        v.slowT = S.t - v.progAt;
        v.farT = d > 170 ? (v.farT || 0) + dt : 0;
        if ((v.slowT > 5 || v.farT > 10) && P.recycle(v)) { v.slowT = v.farT = 0; v.prog = null; S.spawnT = Math.min(S.spawnT, 0.5); }
      }
      // reinforcements, out of sight
      S.spawnT -= dt;
      const chasing = P.units().filter(v => v.state === 'pursue' || v.state === 'block').length;
      if (S.level && chasing < CHASERS[S.level] && S.spawnT <= 0) { P.spawnChaser(); S.spawnT = 2.2; }
      // busted: stopped with a cruiser alongside (or an officer's hand on your collar)
      const boxed = sp < 1.5 && P.units().some(v => (v.state === 'pursue' || v.state === 'halt') && Math.hypot(v.x - player.x, v.z - player.z) < 8 && Math.hypot(v.vx, v.vz) < 4);
      const cuffed = (S.cuffT || 0) > 0; S.cuffT = Math.max(0, (S.cuffT || 0) - dt);
      S.bustT = boxed || cuffed ? S.bustT + dt * (player.onFoot ? 1 : 0.8) : Math.max(0, S.bustT - dt * 2);
      if (S.bustT > 2.2) bust();
    } else if (S.bounty > 0) S.bounty = Math.max(0, S.bounty - 3 * dt); // fades slowly while you keep your nose clean
    spikesUpdate(dt);

    // --- HUD
    let html = '';
    const blink = S.level && !S.seen && (S.t * 2.5) % 1 < 0.5;
    for (let i = 1; i <= 5; i++) html += `<i class="${i <= S.level ? (blink ? 'on dim' : 'on') : ''}">★</i>`;
    starsEl.innerHTML = html;
    bountyEl.textContent = S.bounty >= 1 ? 'Bounty ' + money(S.bounty) : '';
    wantedEl.classList.toggle('active', S.level > 0 || S.bounty >= 1);
    wantedEl.classList.toggle('bust', S.bustT > 0.5);

    // --- Siren
    if (audio.ctx && !siren) sirenInit();
    if (siren) {
      let dmin = Infinity;
      for (const v of P.units()) if (v.state === 'pursue') dmin = Math.min(dmin, Math.hypot(v.x - player.x, v.z - player.z));
      const t = audio.ctx.currentTime, near = dmin < 45;
      const f = near ? 700 + 650 * ((t * 3.2) % 1 < 0.5 ? (t * 6.4) % 1 : 1 - (t * 6.4) % 1) : 650 + 600 * (0.5 - 0.5 * Math.cos(t * Math.PI / 2.2));
      siren.o.frequency.setTargetAtTime(f, t, 0.01); siren.o2.frequency.setTargetAtTime(f * 1.006, t, 0.01);
      const gain = audio.on && !audio.muted && isFinite(dmin) ? 0.09 * clamp(1 - dmin / 320, 0, 1) ** 1.5 : 0;
      siren.g.gain.setTargetAtTime(gain, t, 0.08);
    }
  }
  function bust() {
    const fine = Math.max(250 * (S.maxLevel || S.level || 1), Math.min(S.bounty, PAYOUT[S.maxLevel || S.level || 1] * 1.5)); S.maxLevel = 0;
    S.busted++; S.bounty = 0; S.level = 0; S.heat = 0; S.bustT = 0; S.downed = 0; S.evadeT = 0; S.lastSeen = null; S.reports.length = 0;
    P.standDown();
    onBusted(fine); // the game shows the BUSTED screen
    msgEl.className = '';
  }

  // Spike strips: laid across the road on the approach to a roadblock; cross one and the tyres go
  const spikeMat = new THREE.MeshStandardMaterial({ color: '#2a2b2e', roughness: 0.5, metalness: 0.6 });
  const spikeGeo = (() => {
    const g = [new THREE.BoxGeometry(0.4, 0.05, 9)];
    for (let z = -4.3; z <= 4.3; z += 0.45) g.push(new THREE.ConeGeometry(0.05, 0.14, 4).translate(0, 0.09, z));
    const pos = [], nrm = [];
    for (const p of g) { const n = p.index ? p.toNonIndexed() : p; pos.push(...n.attributes.position.array); nrm.push(...n.attributes.normal.array); }
    const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); return out;
  })();
  function addSpikes(rb) {
    const dx = rb.x - player.x, dz = rb.z - player.z, along = Math.sign(dx * Math.sin(rb.h) + dz * Math.cos(rb.h)) || 1;
    const x = rb.x - Math.sin(rb.h) * 20 * along, z = rb.z - Math.cos(rb.h) * 20 * along;
    const m = new THREE.Mesh(spikeGeo, spikeMat);
    m.position.set(x, city.heightAt(x, z, rb.y) + 0.02, z); m.rotation.y = rb.h + Math.PI / 2; m.castShadow = true; scene.add(m);
    S.spikes.push({ m, x, z, h: rb.h, t: 0 });
  }
  function spikesUpdate(dt) {
    for (let i = S.spikes.length - 1; i >= 0; i--) {
      const k = S.spikes[i]; k.t += dt;
      const d = Math.hypot(player.x - k.x, player.z - k.z);
      if (k.t > 70 || d > 400) { scene.remove(k.m); S.spikes.splice(i, 1); continue; }
      if (player.onFoot || d > 6) continue;
      // in the strip's frame: along the road (s) and across it (q)
      const s = (player.x - k.x) * Math.sin(k.h) + (player.z - k.z) * Math.cos(k.h), q = (player.x - k.x) * Math.cos(k.h) - (player.z - k.z) * Math.sin(k.h);
      if (Math.abs(s) < 2.4 && Math.abs(q) < 4.8 && Math.hypot(player.vx, player.vz) > 2) { onSpikes(); say('Spike strip', 'Tyres shredded', 2200, 'red'); scene.remove(k.m); S.spikes.splice(i, 1); }
    }
  }
  function clear() { S.maxLevel = 0; S.level = 0; S.bounty = 0; S.heat = 0; S.evadeT = 0; S.bustT = 0; S.downed = 0; S.lastSeen = null; S.reports.length = 0; P.standDown(); }
  return { update, state: S, raise, crime, clear, report, bust, zoneR, grace(t) { S.graceT = t; S.knownT = 0; S.reports.length = 0; }, setEyes(fn) { eyes = fn; }, arrest(dt = 0.05) { S.cuffT = Math.max(S.cuffT || 0, dt + 0.05); } };
};
})();
