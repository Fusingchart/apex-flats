// Police: patrol cars watch the traffic around them. Speeding, driving on the pavement, the wrong way or into
// other cars where a patrol can see it gets you a wanted level (1-5 stars) and a bounty. While you're wanted,
// more units are sent after you; out of sight long enough and you lose them (the bounty stays on your head and
// any cop who gets a good look at you will remember). Stop with a cruiser alongside and you're busted.
(function () {
'use strict';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

window.createPolice = function ({ traffic, city, player, audio, scene, onBusted }) {
  const P = traffic.police, pol = P.state;
  const CHASERS = [0, 2, 3, 4, 6, 8];           // units after you at each wanted level
  const SEE = [70, 110, 130, 150, 170, 190];     // how far a cop can make you out, by level
  const S = { level: 0, bounty: 0, heat: 0, evadeT: 0, bustT: 0, speedT: 0, walkT: 0, wrongT: 0, knowT: 0,
    spawnT: 0, laneT: 0, lane: null, seen: false, seenBy: null, wrecked: new Set(), downed: 0, busted: 0, t: 0 };
  const el = id => document.getElementById(id);
  const starsEl = el('stars'), bountyEl = el('bounty'), msgEl = el('copmsg'), wantedEl = el('wanted');
  let msgT = 0;
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
  function raise(level, why, cash) {
    const was = S.level;
    S.bounty += cash;
    S.level = clamp(Math.max(S.level, level), 0, 5);
    if (!was && S.level) { S.heat = 0; say(why, `Wanted · ${money(cash)} bounty`, 2600, 'red'); }
    else if (S.level > was) say(why, `Wanted level ${S.level}`, 2200, 'red');
    if (S.level) {
      pol.active = true; S.evadeT = 0;
      for (const v of witnesses(SEE[S.level])) P.startPursuit(v);
    }
  }
  // a crime only counts if a cop saw it (hitting a cop always counts)
  function crime(level, why, cash, always = false) {
    if (always || witnesses(SEE[S.level]).length) raise(level, why, cash);
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
      if (v.police) raise(Math.max(2, S.level), 'Assaulting an officer', 1500, true);
      else crime(Math.max(1, S.level), 'Hit and run', 400 + Math.round(v.hitAcc * 60));
    }
    // a pursuit car you've wrecked
    for (const v of P.units()) if (v.state === 'wreck' && !S.wrecked.has(v) && S.level && S.t - (v.lastHitT ?? -99) < 3) { // you did that
      S.wrecked.add(v); S.downed++; S.bounty += 1000;
      if (S.downed % 2 === 0) raise(S.level + 1, 'Officer down', 0);
    }
    for (const v of S.wrecked) if (v.state !== 'wreck') S.wrecked.delete(v);

    // a known face: with a big enough bounty, any cop who gets a good look at you starts a chase
    if (!S.level && S.bounty >= 1500) {
      const close = witnesses(45);
      S.knowT = close.length ? S.knowT + dt : 0;
      if (S.knowT > 2) { S.knowT = 0; raise(1, 'Recognised', 0); }
    }

    // --- The chase
    // line-of-sight checks ten times a second
    S.lookT = (S.lookT || 0) - dt;
    if (S.lookT <= 0) { S.lookT = 0.1; S.seenBy = S.level ? witnesses(SEE[S.level]) : []; }
    const seenBy = S.seenBy || [];
    heliUpdate(dt);
    S.seen = seenBy.length > 0 || heli.sees;
    // roadblock units join in once you're through (or round) them
    for (const v of P.units()) if (v.state === 'block') {
      const qx = v.x - player.x, qz = v.z - player.z, dd = Math.hypot(qx, qz);
      if (dd < 18 || (dd < 90 && qx * player.vx + qz * player.vz < 0)) P.startPursuit(v);
    }
    if (S.level) {
      if (S.seen) {
        S.evadeT = 0;
        Object.assign(pol.target, { x: player.x, y: player.y, z: player.z, vx: player.vx, vz: player.vz, h: player.h });
        for (const v of seenBy) if (v.state === 'drive') P.startPursuit(v);
        S.heat += dt;
        if (S.heat > 40 && S.level < 5) { S.heat = 0; raise(S.level + 1, 'Pursuit escalating', 500 * S.level); }
        S.bounty += 8 * S.level * dt;
      } else {
        // they head for where you were last seen
        pol.target.vx *= 0.9; pol.target.vz *= 0.9;
        // the clock only runs while no unit is close by: sitting still round the corner won't do
        const near = P.units().some(v => v.state === 'pursue' && Math.hypot(v.x - player.x, v.z - player.z) < 60);
        if (!near) S.evadeT += dt;
        if (S.evadeT > 9 + 4 * S.level) {
          say('Evaded', S.bounty >= 1500 ? `${money(S.bounty)} still on your head` : 'Lay low for a while', 3000, 'blue');
          S.level = 0; S.heat = 0; S.downed = 0; P.standDown();
        }
      }
      // three stars and up: roadblocks on the road ahead
      S.blockT = (S.blockT ?? 8) - dt;
      if (S.level >= 3 && S.blockT <= 0) { S.blockT = P.spawnRoadblock() ? 28 : 3; }
      // reinforcements, out of sight
      S.spawnT -= dt;
      const chasing = P.units().filter(v => v.state === 'pursue' || v.state === 'block').length;
      if (S.level && chasing < CHASERS[S.level] && S.spawnT <= 0) { P.spawnChaser(); S.spawnT = 2.5; }
      // busted: stopped with a cruiser alongside for a few seconds
      const boxed = sp < 1.5 && P.units().some(v => v.state === 'pursue' && Math.hypot(v.x - player.x, v.z - player.z) < 8 && Math.hypot(v.vx, v.vz) < 4);
      S.bustT = boxed ? S.bustT + dt : Math.max(0, S.bustT - dt * 2);
      if (S.bustT > 3) {
        const fine = S.bounty;
        const paid = onBusted(fine);
        say('Busted', `Paid ${money(paid ?? fine)} in fines`, 3500, 'red big');
        S.busted++; S.bounty = 0; S.level = 0; S.heat = 0; S.bustT = 0; S.downed = 0;
        P.standDown();
      }
    } else if (S.bounty > 0) S.bounty = Math.max(0, S.bounty - 3 * dt); // fades slowly while you keep your nose clean

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
  return { update, state: S, raise };
};
})();
