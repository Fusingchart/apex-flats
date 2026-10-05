/* Street life: what the stealing and the chases are for.
 *  - Marlowe's jobs: a run of story missions from a fixer's garage, each a chain of objectives (steal this, lose
 *    the cops, collect that, take him out, bring it here). Big money, and they unlock one after another.
 *  - Apex Customs: drive in to repair the car, respray it to shake off the police (only if they've lost sight of
 *    you), sell a car you stole, or (on foot or not) buy ammo and armour.
 * Loaded after crime.js; main.js calls createStreet once the world, police and crime layer exist. */
(function () {
  'use strict';
  const money = n => '$' + Math.round(n).toLocaleString('en-US');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  window.createStreet = function ({ scene, city, car, career, crime, police, missions, getRide, dropCar, repairCar, onPause }) {
    const $ = id => document.getElementById(id);
    // A place on a street at a bearing and distance from downtown (deterministic, like the businesses)
    function place(angle, dist) {
      const lim = city.EXT * 0.8, tx = clamp(city.start.x + Math.sin(angle) * dist, -lim, lim), tz = clamp(city.start.z + Math.cos(angle) * dist, -lim, lim);
      let lane = null;
      for (let k = 0; k < 24 && !lane; k++) { // a town street near the spot: never the freeway, never a ramp
        const a = k * 2.4, r = k * 18, x = tx + Math.sin(a) * r, z = tz + Math.cos(a) * r;
        const l = city.nearestLanePose(x, z, city.groundAt(x, z));
        if (l && l.kind !== 'fwy' && l.kind !== 'ramp' && l.d < 60) lane = l;
      }
      lane = lane || city.start;
      const foot = crime.pavementNear(lane.x, lane.z, lane.y) || { x: lane.x, z: lane.z, y: lane.y };
      return { x: lane.x, y: lane.y || 0, z: lane.z, h: lane.h || 0, foot };
    }
    function marker(color, radius = 6) {
      const g = new THREE.Group();
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.18, radius * 0.18, 40, 14, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false }));
      beam.position.y = 20; g.add(beam);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.16, 8, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.2; g.add(ring);
      g.visible = false; scene.add(g); return g;
    }
    const at = (p, r) => Math.hypot(p.x - car.x, p.z - car.z) < r && Math.abs((p.y || 0) - car.y) < 8;

    /* ---------------- Places ---------------- */
    const GARAGE = place(0.9, 260);            // Marlowe's garage: where jobs start and stolen goods go
    const DOCKS = place(2.7, 900), BANK = place(-0.6, 420), SAFE = place(-2.2, 760), DROP = place(1.9, 520), HOUSE = place(-1.3, 640), YARD = place(3.6, 380);
    const SHOPS = [
      { name: 'Apex Customs Downtown', ...place(-2.6, 180) },
      { name: 'Apex Customs Northside', ...place(0.2, 1100) },
      { name: 'Apex Customs Riverside', ...place(4.4, 1250) },
    ];
    for (const s of SHOPS) { s.m = marker('#4fa3ff', 7); s.m.position.set(s.x, s.y, s.z); s.m.visible = true; }
    const garageMark = marker('#ffcf3a', 7); garageMark.position.set(GARAGE.x, GARAGE.y, GARAGE.z);
    const goalMark = marker('#53e4c1', 6);

    /* ---------------- Marlowe's jobs ---------------- */
    // stage kinds: steal (get in a car that passes test), deliver (stop at a place in that car), goto (reach a
    // place, on foot if foot), lose (no stars), heat (police tipped off), kill (a marked target near a place)
    const anyStolen = r => r && !r.owned;
    const JOBS = [
      { name: 'Wheels', pay: 2000, brief: 'Marlowe needs a car for a job. Any car. Steal one and bring it to the garage. Keep the cops out of it.',
        stages: [{ kind: 'steal', text: 'Steal a car', test: anyStolen }, { kind: 'deliver', to: GARAGE, text: 'Bring it to the garage', clean: true }] },
      { name: 'Joyride', pay: 5000, brief: 'A client wants something quick. Find a car worth $25,000 or more and deliver it in one piece (under 25% damage).',
        stages: [{ kind: 'steal', text: 'Steal a car worth $25,000+', test: r => anyStolen(r) && (r.preset.price || 0) >= 25000 }, { kind: 'deliver', to: GARAGE, text: 'Deliver it to the garage', maxDamage: 0.25, clean: true }] },
      { name: 'Hot Pickup', pay: 8000, brief: 'A package is waiting at a drop across town. Somebody tipped off the police. Grab it, lose them, bring it back.',
        stages: [{ kind: 'goto', to: DROP, foot: true, text: 'Collect the package on foot' }, { kind: 'heat', level: 2, text: 'The police were waiting' }, { kind: 'lose', text: 'Lose the police' }, { kind: 'goto', to: GARAGE, text: 'Bring the package to the garage' }] },
      { name: 'Debt Collection', pay: 11000, brief: 'A man owes Marlowe and has stopped answering. He lives on the west side. He won\'t pay. Make sure nobody else tries that.',
        stages: [{ kind: 'kill', at: HOUSE, text: 'Find the debtor and take him out' }, { kind: 'lose', text: 'Lose any heat' }, { kind: 'goto', to: GARAGE, text: 'Report back to the garage' }] },
      { name: 'Black and White', pay: 16000, brief: 'For the next job we need a police cruiser. Take one off the street and bring it in.',
        stages: [{ kind: 'steal', text: 'Steal a police car', test: r => anyStolen(r) && r.preset.id === 'interceptor' }, { kind: 'lose', text: 'Lose the police' }, { kind: 'deliver', to: GARAGE, text: 'Deliver the cruiser to the garage', clean: true }] },
      { name: 'Getaway', pay: 26000, brief: 'The crew is hitting a bank. Be outside in a fast car, take them away, lose four stars of police and drop them at the safehouse.',
        stages: [{ kind: 'deliver', to: BANK, text: 'Wait outside the bank in a car', wait: 6 }, { kind: 'heat', level: 4, text: 'The alarm\'s gone off' }, { kind: 'lose', text: 'Lose the police' }, { kind: 'deliver', to: SAFE, text: 'Drop the crew at the safehouse' }] },
      { name: 'Export', pay: 42000, brief: 'A buyer at the docks wants two cars worth $40,000 or more. Deliver them one at a time, no heat.',
        stages: [{ kind: 'steal', text: 'Steal a car worth $40,000+ (1 of 2)', test: r => anyStolen(r) && (r.preset.price || 0) >= 40000 }, { kind: 'deliver', to: DOCKS, text: 'Deliver it to the docks', clean: true },
          { kind: 'steal', text: 'Steal another car worth $40,000+ (2 of 2)', test: r => anyStolen(r) && (r.preset.price || 0) >= 40000 }, { kind: 'deliver', to: DOCKS, text: 'Deliver it to the docks', clean: true }] },
      { name: 'Last Run', pay: 100000, brief: 'One more and we\'re done. The stash at the yard. Every cop in the valley will come for it. Get it to the safehouse.',
        stages: [{ kind: 'goto', to: YARD, foot: true, text: 'Get the stash from the yard on foot' }, { kind: 'heat', level: 5, text: 'Every unit is coming' }, { kind: 'lose', text: 'Lose the police' }, { kind: 'goto', to: SAFE, text: 'Get the stash to the safehouse' }] },
    ];
    const S = career.state.story || (career.state.story = { done: 0 });
    let job = null, stage = 0, hold = 0, target = null, ui = 0, sellCool = 0, shopOpen = false, coolT = 0, armed = true;
    const panel = $('story-job'), title = $('story-name'), step = $('story-step'), arrowEl = $('story-arrow'), dist = $('story-dist');
    const brief = $('story-brief');

    function nextJob() { return JOBS[S.done] || null; }
    function startJob(j) {
      job = j; stage = 0; hold = 0; target = null;
      showBrief(`MARLOWE · JOB ${JOBS.indexOf(j) + 1} OF ${JOBS.length}`, j.name, j.brief + `\n\nPays ${money(j.pay)}. Busted or wasted fails the job.`);
      enterStage();
    }
    function enterStage() {
      const st = job.stages[stage]; hold = 0;
      if (st.kind === 'heat') { police.raise(st.level, st.text, 600 * st.level); return advance(); }
      if (st.kind === 'kill') spawnTarget(st);
    }
    function advance() {
      stage++;
      if (stage >= job.stages.length) return finish(true);
      enterStage();
    }
    function dropTarget() { if (!target) return; target.target = false; if (target.tag) scene.remove(target.tag); target = null; }
    function finish(ok, why) {
      const j = job; job = null; goalMark.visible = false; dropTarget(); armed = false; // walk out and back in for the next one
      if (ok) {
        S.done = Math.max(S.done, JOBS.indexOf(j) + 1); career.state.story = S;
        const r = career.earn(j.pay, 250 + JOBS.indexOf(j) * 120);
        showBrief('JOB COMPLETE', j.name, `${money(r.cash)} · +${r.xp} XP${r.rankUp ? ' · RANK UP' : ''}` + (nextJob() ? `\n\nMarlowe has another job. Come by the garage (yellow M on the map).` : `\n\nThat's the lot. Marlowe has retired, and yours is the name in Ashby Valley now.`));
      } else { coolT = 8; showBrief('JOB FAILED', j.name, (why || 'It went wrong.') + '\n\nCome back to the garage to try again.'); }
      missions.refresh?.();
    }
    function spawnTarget(st) {
      const p = st.at.foot;
      target = crime.addPed(p.x, p.z, false);
      target.hp = 90; target.target = true;
      const tag = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.5, 8).rotateX(Math.PI), new THREE.MeshBasicMaterial({ color: '#ff4a3d' }));
      scene.add(tag); target.tag = tag;
    }
    function goalOf(st) {
      if (!st) return null;
      if (st.kind === 'kill') return target && target.alive ? { x: target.x, y: target.y, z: target.z } : st.at.foot;
      if (st.to) return st.foot ? st.to.foot : st.to;
      return null;
    }
    function updateJob(dt) {
      const st = job.stages[stage], ride = getRide();
      if (st.kind === 'steal') { if (st.test(ride)) advance(); }
      else if (st.kind === 'deliver') {
        if (ride && at(st.to, 9) && Math.hypot(car.vx, car.vz) < 2) {
          if (st.clean && police.state.level > 0) { hold = 0; return; }
          if (st.maxDamage && ride.damage > st.maxDamage) return finish(false, `The car is ${Math.round(ride.damage * 100)}% damaged. The client won't take it.`);
          hold += dt;
          if (hold >= (st.wait || 1.2)) { if (st.to === GARAGE || st.to === DOCKS) dropCar(); advance(); }
        } else hold = 0;
      } else if (st.kind === 'goto') {
        const g = goalOf(st);
        if (at(g, st.foot ? 2.5 : 9) && (!st.foot || crime.onFoot) && (st.foot || Math.hypot(car.vx, car.vz) < 3)) advance();
      } else if (st.kind === 'lose') { if (police.state.level === 0) advance(); }
      else if (st.kind === 'kill') {
        if (!target) { if (Math.hypot(st.at.x - car.x, st.at.z - car.z) < 180) spawnTarget(st); }
        else if (!target.alive) { dropTarget(); advance(); }
        else if (!crime.peds.includes(target)) dropTarget(); // walked out of range: he's back when you return
        else {
          target.tag.position.set(target.x, target.y + 2.4 + Math.sin(performance.now() / 200) * 0.1, target.z);
          // he runs once he sees you coming
          const d = Math.hypot(target.x - car.x, target.z - car.z) || 1;
          if (d < 22 && !target.flee) { target.flee = true; target.t = -6; target.vx = (target.x - car.x) / d * 4.6; target.vz = (target.z - car.z) / d * 4.6; }
        }
      }
    }

    /* ---------------- UI: the job panel, the briefing card ---------------- */
    function showBrief(eyebrow, name, text) {
      if (!brief) return;
      brief.querySelector('.eyebrow').textContent = eyebrow; brief.querySelector('h2').textContent = name;
      brief.querySelector('p').textContent = text; brief.hidden = false; onPause();
      $('story-ok')?.focus();
    }
    $('story-ok')?.addEventListener('click', () => { brief.hidden = true; onPause(); });

    /* ---------------- Apex Customs ---------------- */
    const shopEl = $('shop'), shopBody = $('shop-body');
    let shopAt = null;
    function shopNear() { return SHOPS.find(s => at(s, 9)) || null; }
    // a stolen car fetches a tenth of its value, less for damage, capped so stealing doesn't out-earn the jobs
    function sellValue(r) { return clamp(Math.round((r.preset.price || 0) * 0.1 * (1 - r.damage) / 50) * 50, 300, 10000); }
    function renderShop() {
      const r = getRide(), L = police.state.level, seen = police.state.seen;
      const items = [];
      if (r) {
        const cost = Math.round(150 + r.damage * 2400 + r.bullet * 2000 + (r.tyres < 1 ? 250 : 0));
        items.push(['repair', `Repair · ${money(cost)}`, r.damage < 0.005 && r.bullet < 0.01 && r.tyres >= 1 ? 'nothing to fix' : '', cost]);
        const rc = 400 + 350 * L;
        items.push(['respray', `Respray and new plates (lose the police) · ${money(rc)}`, !L ? 'you\'re not wanted' : seen ? 'not with the police watching' : '', rc]);
        const v = sellValue(r);
        items.push(['sell', `Sell this car · ${money(v)}`, r.owned ? 'it\'s yours' : L ? 'too hot: lose the police first' : sellCool > 0 ? `the buyer is busy · ${Math.ceil(sellCool)} s` : '', -v]);
      }
      items.push(['ammo', 'Ammo for every gun · $400', '', 400]);
      items.push(['armor', 'Body armour · $900', crime.armor >= 99 ? 'already wearing it' : '', 900]);
      shopBody.replaceChildren();
      for (const [id, label, why, cost] of items) {
        const b = document.createElement('button'); b.className = 'action'; b.textContent = label + (why ? ` — ${why}` : '');
        b.disabled = !!why || (cost > 0 && career.state.cash < cost); b.onclick = () => buy(id, cost); shopBody.append(b);
      }
      $('shop-name').textContent = shopAt.name; $('shop-cash').textContent = money(career.state.cash);
    }
    function buy(id, cost) {
      if (id === 'sell') { career.earn(-cost, 0); sellCool = 90; dropCar(); toggleShop(false); crime.say(`Sold for ${money(-cost)}`, 2.5); missions.refresh?.(); return; }
      if (career.state.cash < cost) return;
      career.fine(cost);
      if (id === 'repair') repairCar();
      if (id === 'respray') { police.clear(); police.state.bounty = 0; }
      if (id === 'ammo') crime.refillAmmo();
      if (id === 'armor') crime.addArmor(100);
      missions.refresh?.(); renderShop();
    }
    function toggleShop(open) { shopOpen = !!open && !!shopAt; shopEl.hidden = !shopOpen; if (shopOpen) renderShop(); onPause(); }
    $('shop-close')?.addEventListener('click', () => toggleShop(false));

    /* ---------------- Per frame ---------------- */
    function update(dt) {
      sellCool = Math.max(0, sellCool - dt); coolT = Math.max(0, coolT - dt);
      shopAt = shopNear();
      if (shopOpen && !shopAt) toggleShop(false);
      // the next job starts when you turn up at the garage (and no contract is running)
      const nj = !job && nextJob();
      garageMark.visible = !!nj && !missions.engine.active;
      if (!armed && !at(GARAGE, 25)) armed = true;
      if (nj && armed && !missions.engine.active && coolT <= 0 && at(GARAGE, 7) && Math.hypot(car.vx, car.vz) < 4) startJob(nj);
      if (job) updateJob(dt);
      const g = job ? goalOf(job.stages[stage]) : null;
      goalMark.visible = !!g; if (g) goalMark.position.set(g.x, g.y || 0, g.z);
      // HUD
      if ((ui += dt) < 0.1) return; ui = 0;
      const prompt = $('shop-prompt');
      if (prompt) { prompt.hidden = !shopAt || shopOpen; if (shopAt) prompt.innerHTML = `<b>${shopAt.name}</b> Press <kbd>Enter</kbd> to shop`; }
      if (!panel) return;
      panel.hidden = !job;
      if (job) {
        const st = job.stages[stage], ride = getRide();
        title.textContent = job.name;
        let t = st.text;
        if (st.kind === 'deliver' && !ride) t += ' (you need a car)';
        else if (st.kind === 'deliver' && st.clean && police.state.level > 0 && at(st.to, 30)) t = 'Lose the police first';
        else if (st.kind === 'deliver' && hold > 0) t = `${st.wait ? 'Waiting' : 'Unloading'}… ${Math.ceil((st.wait || 1.2) - hold)} s`;
        if (st.kind === 'deliver' && st.maxDamage && ride) t += ` · damage ${Math.round(ride.damage * 100)}% / ${Math.round(st.maxDamage * 100)}%`;
        step.textContent = t;
        if (g) { dist.textContent = Math.round(Math.hypot(g.x - car.x, g.z - car.z)) + ' m'; arrowEl.style.transform = `rotate(${Math.atan2(g.x - car.x, g.z - car.z) - car.h}rad)`; arrowEl.hidden = false; }
        else { dist.textContent = ''; arrowEl.hidden = true; }
      }
    }
    function drawMap(g, X, Y) {
      const dot = (p, col, r, label) => {
        const x = X(p.x, p.z), y = Y(p.x, p.z);
        g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
        if (label) { g.fillStyle = '#16151a'; g.font = `700 ${Math.round(r * 1.5)}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, x, y + 0.5); }
      };
      g.save();
      for (const s of SHOPS) dot(s, '#4fa3ff', 7, '$');
      if (!job && nextJob()) dot(GARAGE, '#ffcf3a', 8, 'M');
      const p = job && goalOf(job.stages[stage]); if (p) dot(p, '#53e4c1', 7, '!');
      if (target && target.alive) dot(target, '#ff4a3d', 5);
      g.restore();
    }
    return {
      update, drawMap, jobs: JOBS, places: { GARAGE, SHOPS, DOCKS, BANK, SAFE, DROP, HOUSE, YARD },
      get active() { return job; }, get stage() { return stage; }, get shopOpen() { return shopOpen; }, get shopAt() { return shopAt; },
      get briefOpen() { return !!brief && !brief.hidden; },
      openShop() { if (shopAt) toggleShop(!shopOpen); },
      closeAll() { if (shopOpen) toggleShop(false); if (brief && !brief.hidden) { brief.hidden = true; onPause(); } },
      fail(why) { if (job) finish(false, why); },
      start(i = S.done) { if (!job && JOBS[i]) startJob(JOBS[i]); },
    };
  };
})();
