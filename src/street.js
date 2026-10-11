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

  window.createStreet = function ({ scene, city, car, career, crime, police, missions, traffic, getRide, dropCar, repairCar, onPause, onResult, ui }) {
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
    // Each job: a short call from Marlowe when it starts, then stages. `obj` is the objective line, GTA-style, with
    // the key words in {braces} highlighted; `talk` is what's said when the stage begins; `wreck` fails the job if
    // the car you're bringing in gets past that much damage.
    const M = 'MARLOWE', L = 'LENA', D = 'DEBTOR';
    const JOBS = [
      { name: 'Wheels', pay: 2000, brief: 'Steal any car and bring it to the garage. No heat.',
        talk: [[M, 'You the driver Lena told me about? Good. I need wheels for tonight.'], [M, 'Nothing flashy. Take something off the street and bring it to my garage.'], [M, 'And keep the cops out of it.']],
        stages: [{ kind: 'steal', obj: 'Steal a {car}.', test: anyStolen },
          { kind: 'deliver', to: GARAGE, obj: 'Take the car to {Marlowe\'s garage}.', clean: true, wreck: 0.7, talk: [[M, 'That\'ll do. Bring it round the back.']] }] },
      { name: 'Joyride', pay: 5000, brief: 'Deliver a car worth $25,000+ with under 25% damage.',
        talk: [[M, 'Got a client with taste. He wants something worth twenty-five grand or more.'], [M, 'Not a scratch on it, you hear me? Under a quarter damage or he walks.']],
        stages: [{ kind: 'steal', obj: 'Steal a car worth {$25,000} or more.', test: r => anyStolen(r) && (r.preset.price || 0) >= 25000 },
          { kind: 'deliver', to: GARAGE, obj: 'Deliver it to the {garage} in one piece.', maxDamage: 0.25, clean: true, talk: [[M, 'Nice. Easy on the corners.']] }] },
      { name: 'Hot Pickup', pay: 8000, brief: 'Collect a package, lose the police, bring it back.',
        talk: [[M, 'There\'s a package at a drop across town. Walk in, pick it up, walk out.'], [L, 'Word is somebody tipped off the cops. Be ready to run.']],
        stages: [{ kind: 'goto', to: DROP, foot: true, obj: 'Go to the {drop} and collect the package on foot.' },
          { kind: 'heat', level: 2, text: 'The police were waiting', talk: [[L, 'Told you. Get out of there!']] },
          { kind: 'lose', obj: 'Lose the {cops}.' },
          { kind: 'goto', to: GARAGE, obj: 'Bring the package to the {garage}.', talk: [[M, 'You still got it? Good. Come home.']] }] },
      { name: 'Debt Collection', pay: 11000, brief: 'Find the debtor on the west side and take him out.',
        talk: [[M, 'Man on the west side owes me. Thirty grand, eight months.'], [M, 'He\'s not going to pay. Make sure the rest of them know what that costs.'], [L, 'He\'s jumpy. If he sees you coming, he\'ll run.']],
        stages: [{ kind: 'kill', at: HOUSE, obj: 'Find the {debtor} and take him out.', escape: 190 },
          { kind: 'lose', obj: 'Lose the {cops}.', talk: [[M, 'It\'s done? Then get clear.']] },
          { kind: 'goto', to: GARAGE, obj: 'Report back to the {garage}.' }] },
      { name: 'Black and White', pay: 16000, brief: 'Steal a police cruiser and bring it in.',
        talk: [[M, 'Next job needs a uniform look. I want a police cruiser.'], [M, 'Pull an officer out of one, lose his friends, bring it to me.']],
        stages: [{ kind: 'steal', obj: 'Steal a {police car}.', test: r => anyStolen(r) && r.preset.id === 'interceptor' },
          { kind: 'lose', obj: 'Lose the {cops}.', talk: [[L, 'Every cop in the city just heard about that.']] },
          { kind: 'deliver', to: GARAGE, obj: 'Deliver the cruiser to the {garage}.', clean: true, wreck: 0.75 }] },
      { name: 'Getaway', pay: 26000, brief: 'Drive the crew from the bank, lose four stars, drop them at the safehouse.',
        talk: [[L, 'This is the big one. The crew\'s inside the bank. You\'re the wheels.'], [L, 'Be outside, engine running. When we come out, you drive like you mean it.']],
        stages: [{ kind: 'deliver', to: BANK, obj: 'Wait outside the {bank} in a car.', wait: 6 },
          { kind: 'heat', level: 4, text: 'The alarm\'s gone off', talk: [[L, 'Go, go, go!'], [L, 'Lose them. All of them.']] },
          { kind: 'lose', obj: 'Lose the {cops}.' },
          { kind: 'deliver', to: SAFE, obj: 'Drop the crew at the {safehouse}.', talk: [[L, 'We\'re clear. Safehouse. Now.']] }] },
      { name: 'Export', pay: 42000, brief: 'Deliver two cars worth $40,000+ to the docks, no heat.',
        talk: [[M, 'Buyer at the docks wants two cars. Forty grand or better, each.'], [M, 'One at a time. Don\'t bring the cops to my buyer.']],
        stages: [{ kind: 'steal', obj: 'Steal a car worth {$40,000} or more ({1} of 2).', test: r => anyStolen(r) && (r.preset.price || 0) >= 40000 },
          { kind: 'deliver', to: DOCKS, obj: 'Take it to the {docks}.', clean: true, wreck: 0.6 },
          { kind: 'steal', obj: 'Steal another car worth {$40,000} or more ({2} of 2).', test: r => anyStolen(r) && (r.preset.price || 0) >= 40000, talk: [[M, 'He liked it. One more.']] },
          { kind: 'deliver', to: DOCKS, obj: 'Take it to the {docks}.', clean: true, wreck: 0.6 }] },
      { name: 'Last Run', pay: 100000, brief: 'Get the stash from the yard to the safehouse with five stars on you.',
        talk: [[M, 'Last one, kid. The stash at the yard is everything I\'ve got.'], [M, 'Every cop in the valley will be on it the second you touch it.'], [L, 'Get it to the safehouse and we all walk away rich.']],
        stages: [{ kind: 'goto', to: YARD, foot: true, obj: 'Get the {stash} from the yard on foot.' },
          { kind: 'heat', level: 5, text: 'Every unit is coming', talk: [[L, 'That\'s the whole department. Move!']] },
          { kind: 'lose', obj: 'Lose the {cops}.' },
          { kind: 'goto', to: SAFE, obj: 'Get the stash to the {safehouse}.', talk: [[M, 'You did it. Bring it home.']] }] },
    ];
    const S = career.state.story || (career.state.story = { done: 0 });
    S.medals = S.medals || {}; S.events = S.events || 0;
    const H = S.heist || (S.heist = { phase: 0, approach: 'loud', crew: [1, 1, 1], setups: 0, done: 0 });
    let job = null, stage = 0, hold = 0, target = null, hudT = 0, sellCool = 0, shopOpen = false, coolT = 0, armed = true;
    let stats = null, stageT = 0, heistArmed = true;
    const panel = $('story-job'), title = $('story-name'), step = $('story-step'), arrowEl = $('story-arrow'), dist = $('story-dist');
    const brief = $('story-brief'), bars = $('timerbars');

    function nextJob() { return JOBS[S.done] || null; }
    const plain = o => (o || '').replace(/[{}]/g, '');
    const lit = o => (o || '').replace(/\{(.*?)\}/g, '<b>$1</b>');
    const clock = s => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

    /* ---------------- Medals ---------------- */
    // Every job has a couple of gold objectives, GTA V-style: all of them for gold, half for silver, and bronze for
    // just getting it done. Gold pays 25% more, silver 10% (10% and 5% on the heist itself); the best medal on each
    // job is kept.
    const TIERS = ['bronze', 'silver', 'gold'];
    const under = secs => [`Finish inside ${clock(secs)}`, s => s.t <= secs], gentle = pct => [`Car damage under ${pct}%`, s => s.dmg * 100 <= pct], shake = secs => [`Lose the police inside ${clock(secs)}`, s => s.loseT <= secs];
    // The time to beat comes from the job itself: the road distance from where it starts through every place it
    // sends you (about a third longer than the straight lines) at a brisk 50 km/h, plus an allowance for each thing
    // you have to do on the way: find a car to steal, shake the police, wait, walk.
    // How far it is by road, from the same planner the GPS uses (the docks are 1.1 km from the garage as the crow
    // flies and 2.8 km to drive). Where the planner has no answer, a typical detour.
    const roadMemo = new Map();
    function roadDist(a, b) {
      const straight = Math.hypot(b.x - a.x, b.z - a.z), key = [a.x, a.z, b.x, b.z].map(Math.round).join();
      if (roadMemo.has(key)) return roadMemo.get(key);
      let d = straight * 1.5;
      try {
        const len = L => { const P = L.lanes[0].pts; let n = 0; for (let i = 1; i < P.length; i++) n += Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z); return n; };
        const cells = []; city.cellsNear(a.x, a.z, 70, cells);
        cells.sort((p, q) => (p.x - a.x) ** 2 + (p.z - a.z) ** 2 - (q.x - a.x) ** 2 - (q.z - a.z) ** 2);
        const starts = []; for (const c of cells) if (c.link.kind !== 'ramp' && !starts.some(q => q.link === c.link) && starts.length < 4) starts.push(c);
        let goal = null, gd = Infinity; for (const n of city.nodes) { if (!n.out.length || !n.in.length) continue; const q = (n.x - b.x) ** 2 + (n.z - b.z) ** 2; if (q < gd) { gd = q; goal = n; } }
        let best = Infinity;
        for (const c of starts) { const links = c.link.to === goal ? [] : city.route(c.link, goal); if (!links) continue; let n = Math.hypot(c.x - a.x, c.z - a.z) + len(c.link) / 2 + Math.sqrt(gd); for (const L of links) n += len(L); best = Math.min(best, n); }
        if (best < Infinity) d = Math.max(straight, best);
      } catch (e) {}
      roadMemo.set(key, d); return d;
    }
    // Par: what a quick driver needs. Play-tested with a keyboard bot that keeps to 60 km/h and waits at every light:
    // it averages 10 to 13 m/s over the road distance, so gold (15 m/s plus 10 s a leg) means driving harder than that.
    function parOf(stages, from) {
      let t = 20, p = from;
      for (const st of stages) {
        const to = st.to ? (st.foot ? st.to.foot || st.to : st.to) : st.at || null;
        if (to) { t += roadDist(p, to) / 15 + 10; p = to; }
        t += st.kind === 'steal' ? 75 : st.kind === 'lose' ? 30 + 22 * (st.stars || 3) : st.kind === 'hold' ? st.secs : st.kind === 'kill' ? 40 : st.kind === 'stop' ? 60 : (st.wait || 0) + (st.foot ? 15 : 0);
      }
      return Math.ceil(t / 15) * 15;
    }
    const GOLD = { 'Wheels': [gentle(10)], 'Joyride': [gentle(8)], 'Hot Pickup': [shake(90)], 'Debt Collection': [shake(75)], 'Black and White': [gentle(25)], 'Getaway': [gentle(30)], 'Export': [gentle(20)], 'Last Run': [shake(240)] };
    for (const j of JOBS) { j.par = parOf(j.stages, GARAGE); j.gold = [under(j.par), ...(GOLD[j.name] || [])]; }
    function grade(j, st) {
      const list = (j.gold || []).map(([label, test]) => ({ label, ok: !!test(st) })), n = list.filter(o => o.ok).length;
      return { list, medal: n === list.length ? 'gold' : n * 2 >= list.length ? 'silver' : 'bronze' };
    }

    let objT = 0;
    function startJob(j) {
      job = j; stage = 0; hold = 0; target = null; ui?.clear?.(); // anything still being said belongs to the last job
      stats = { t: 0, dmg: 0, peak: 0, loseT: 0, last: null, car: null, take0: 0, take: 0, bag: 0 };
      if (ui) { ui.title(j.name, j.card || `Marlowe · job ${JOBS.indexOf(j) + 1} of ${JOBS.length} · ${money(j.pay)}`); ui.talk(j.talk); }
      else showBrief(`MARLOWE · JOB ${JOBS.indexOf(j) + 1} OF ${JOBS.length}`, j.name, j.brief + `\n\nPays ${money(j.pay)}. Busted or wasted fails the job.`);
      enterStage();
    }
    function enterStage() {
      const st = job.stages[stage]; hold = 0; objT = 0; stageT = 0;
      if (ui && st.talk) ui.talk(st.talk);
      if (ui && st.obj) ui.objective(lit(st.obj));
      st.onEnter?.();
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
      const j = job, st = stats, kind = j.kind || 'story';
      ui?.clear?.(); // nothing left over from the job stays on screen
      job = null; goalMark.visible = false; dropTarget(); armed = false; heistArmed = false; setBars(null); // walk out and back in for the next one
      if (ok) {
        const g = grade(j, st), scored = !!j.gold?.length, mult = !scored ? 1 : kind === 'finale' ? (g.medal === 'gold' ? 1.1 : g.medal === 'silver' ? 1.05 : 1) : g.medal === 'gold' ? 1.25 : g.medal === 'silver' ? 1.1 : 1; // (a tenth of a heist is plenty)
        if (scored) S.medals[j.name] = TIERS[Math.max(TIERS.indexOf(S.medals[j.name]), TIERS.indexOf(g.medal))];
        if (kind === 'story') S.done = Math.max(S.done, JOBS.indexOf(j) + 1);
        const base = typeof j.pay === 'function' ? j.pay(st) : j.pay, pay = Math.round(base * mult);
        const r = career.earn(pay, j.xp ?? (250 + Math.max(0, JOBS.indexOf(j)) * 120));
        career.state.story = S; j.after?.(true, st, { pay, base, medal: g.medal }); career.save();
        const sub = `${pay ? money(r.cash) + ' · ' : ''}+${r.xp} XP${r.rankUp ? ' · RANK UP' : ''}`;
        const next = j.next ? j.next() : nextJob() ? 'Marlowe has another job: the yellow M on the map.' : 'That\'s the lot. Marlowe has retired, and yours is the name in Ashby Valley now.';
        if (onResult) { onResult(true, j.name, sub, scored ? g : null); if (next) crime.say(next, 6); } else showBrief('JOB COMPLETE', j.name, sub + '\n\n' + next);
      } else {
        coolT = 8; j.after?.(false, st);
        const back = kind === 'story' ? 'Back to the garage to try again.' : kind === 'event' || kind === 'replay' ? '' : 'Back to the planning room to try again.';
        if (onResult) { onResult(false, j.name, why || 'It went wrong.'); if (back) crime.say(back, 5); }
        else showBrief('JOB FAILED', j.name, (why || 'It went wrong.') + (back ? '\n\n' + back : ''));
      }
      missions.refresh?.();
    }
    // Mission timers and counts, bottom right, GTA-style: [[label, value], ...] or null
    function setBars(rows) {
      if (!bars) return;
      const html = rows && rows.length ? rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('') : '';
      if (bars.dataset.h !== html) { bars.dataset.h = html; bars.innerHTML = html; bars.hidden = !html; }
    }

    /* ---------------- The Ashby Score: one heist, planned the GTA V way ---------------- */
    // Once you've done three jobs for Marlowe, Lena has a score of her own: the vault at the bank. At her planning
    // room (the green H) you pick an approach and a crew. Better people take a bigger cut, and earn it: the hacker
    // decides how much of the vault there's time to empty (and, going in smart, how long before the alarm), the
    // gunman how long you hold the street and what gets left on the floor, the driver how hot it gets and how much
    // of the take survives your driving. Two setup jobs, then the score. Your share is what's left.
    const CREW = [
      { role: 'Driver', who: [['Dee Okafor', 0.05, 'Green and cheap. Brings every cop in the valley, and the bags roll around in the back.'], ['Sal Brandt', 0.09, 'Twenty years of airport runs. Steady hands.'], ['Mika Tanaka', 0.14, 'Ex-rally. Straps the bags down and knows which streets are quiet.']] },
      { role: 'Gunman', who: [['Norm Pike', 0.06, 'Keen. Nervous. Slow in the vault, and he drops things.'], ['Hugo Vance', 0.1, 'Does what he says he will, about when he says.'], ['Ines Calder', 0.15, 'In and out fast, and nothing gets left behind.']] },
      { role: 'Hacker', who: [['Pip Raines', 0.04, 'Learned it online. The time lock beats him to most of it.'], ['Yusuf Adeyemi', 0.08, 'Solid. Buys you most of the time you need.'], ['Noor Castell', 0.14, 'The vault opens when she says so, and stays quiet.']] },
    ];
    const GROSS = 1200000, LENA_CUT = 0.12;
    function plan(h = H) {
      const [d, g, k] = h.crew, loud = h.approach !== 'smart';
      return { loud, driver: CREW[0].who[d], gunman: CREW[1].who[g], hacker: CREW[2].who[k],
        vault: [0.7, 0.85, 1][k],                                  // how much of the vault there's time to empty
        dropped: loud ? [0.15, 0.05, 0][g] : [0.08, 0.03, 0][g],   // what a nervous gunman leaves on the floor
        heat: loud ? [5, 4, 4][d] : [3, 2, 1][k],                  // stars when the alarm goes
        holdT: loud ? [20, 14, 9][g] : [36, 26, 17][k],            // seconds at the bank: a smash and grab is quick
        spill: [0.8, 0.55, 0.3][d],                                // share of the take lost per 100% of damage on the way home
        cuts: CREW[0].who[d][1] + CREW[1].who[g][1] + CREW[2].who[k][1] + LENA_CUT };
    }
    const bagged = p => p.vault * (1 - p.dropped) * GROSS;
    function payout(st, p = plan()) {
      const inVault = GROSS * p.vault, onFloor = inVault * p.dropped, take = st.take0 ? st.take : bagged(p);
      const lines = [['In the vault', GROSS], [`No time for the rest (${p.hacker[0]})`, inVault - GROSS], [`Left on the floor (${p.gunman[0]})`, -onFloor], ['Lost on the road', take - bagged(p)], ['THE TAKE', take],
        [`${p.driver[0]} · driver · ${Math.round(p.driver[1] * 100)}%`, -take * p.driver[1]], [`${p.gunman[0]} · gunman · ${Math.round(p.gunman[1] * 100)}%`, -take * p.gunman[1]], [`${p.hacker[0]} · hacker · ${Math.round(p.hacker[1] * 100)}%`, -take * p.hacker[1]], [`Lena · the plan · ${Math.round(LENA_CUT * 100)}%`, -take * LENA_CUT]];
      return { take, mine: Math.round(take * (1 - p.cuts)), lines: lines.filter(l => Math.abs(l[1]) >= 1) };
    }
    function heistJobs() {
      const p = plan(), first = n => n[0].split(' ')[0].toUpperCase(), DN = first(p.driver), GN = first(p.gunman), HN = first(p.hacker), card = 'The Ashby Score · setup';
      const more = () => 'Back to the planning room: the green H.';
      const setup = ok => { if (ok) { H.setups = Math.min(2, H.setups + 1); if (H.setups >= 2) H.phase = 2; } };
      const wheels = { name: 'Setup: Getaway Car', kind: 'setup', pay: 0, xp: 150, card, after: setup, next: more, gold: [gentle(8)],
        talk: [[L, 'First thing: wheels nobody can trace. Something quick, thirty grand or better.'], [L, 'Leave it at the yard and walk away. No police.']],
        stages: [{ kind: 'steal', obj: 'Steal a car worth {$30,000} or more.', test: r => anyStolen(r) && (r.preset.price || 0) >= 30000 },
          { kind: 'deliver', to: YARD, obj: 'Leave it at the {yard}, with no police on you.', clean: true, maxDamage: 0.3, drop: true, talk: [[DN, 'That\'ll do. I\'ll have it fuelled and facing the right way.']] }] };
      const kit = p.loud ? { name: 'Setup: Heavy Kit', kind: 'setup', pay: 0, xp: 200, card, after: setup, next: more, gold: [shake(100)],
        talk: [[L, 'Going in loud means going in heavy. There\'s a crate waiting at the docks.'], [GN, 'Don\'t scratch it.']],
        stages: [{ kind: 'goto', to: DOCKS, foot: true, obj: 'Collect the {gear} at the docks on foot.' },
          { kind: 'heat', level: 3, text: 'Someone talked', talk: [[GN, 'Those aren\'t our people. Go!']] }, { kind: 'lose', obj: 'Lose the {cops}.' },
          { kind: 'goto', to: SAFE, obj: 'Bring the gear to the {planning room}.', talk: [[L, 'Clear? Bring it in.']] }] }
        : { name: 'Setup: Inside Line', kind: 'setup', pay: 0, xp: 200, card, after: setup, next: more, gold: [shake(80)],
          talk: [[L, 'Going in smart means knowing the room. Walk in like a customer and count the cameras.'], [HN, 'Then get me the access cards. A courier leaves them at the drop.']],
          stages: [{ kind: 'goto', to: BANK, foot: true, obj: 'Walk into the {bank} and count the cameras.' },
            { kind: 'goto', to: DROP, foot: true, obj: 'Pick up the {access cards} at the drop.', talk: [[HN, 'Six cameras. I can work with six. Now the cards.']] },
            { kind: 'heat', level: 2, text: 'The courier made you', talk: [[L, 'He\'s on the phone. Move.']] }, { kind: 'lose', obj: 'Lose the {cops}.' },
            { kind: 'goto', to: SAFE, obj: 'Bring the cards to the {planning room}.' }] };
      const bag = () => { stats.take0 = stats.take = bagged(p); stats.bag = stats.dmg; };
      const finale = { name: 'The Ashby Score', kind: 'finale', xp: 2500, card: `Heist · ${p.loud ? 'loud' : 'smart'} · ${p.driver[0]}, ${p.gunman[0]}, ${p.hacker[0]}`, pay: st => payout(st, p).mine,
        gold: [['Bring home 85% of what you bagged', st => st.take0 > 0 && st.take >= st.take0 * 0.85]],
        talk: [[L, 'This is it. Everyone knows their part.'], [L, p.loud ? 'Front door, masks on. Be outside when they come out.' : 'In as customers. Nobody hears a thing until we\'re gone.']],
        next: () => 'The Ashby Score is done. Lena says to lie low and spend it slowly.',
        after: (ok, st, r) => {
          if (!ok) return;
          H.phase = 3; H.done = (H.done || 0) + 1;
          const o = payout(st, p), row = ([k, v]) => `${k}  ${v < 0 ? '−' : ''}${money(Math.abs(v))}`;
          showBrief('THE ASHBY SCORE · THE SPLIT', `Your cut: ${money(r.pay)}`, o.lines.map(row).join('\n') + `\nYOUR CUT  ${money(o.mine)}` + (r.pay !== o.mine ? `\n${r.medal === 'gold' ? 'Gold' : 'Silver'} medal bonus  ${money(r.pay - o.mine)}` : ''));
        },
        stages: p.loud ? [
          { kind: 'deliver', to: BANK, obj: 'Pull up outside the {bank}.', wait: 3 },
          { kind: 'hold', to: BANK, secs: p.holdT, r: 60, bar: 'VAULT', obj: 'Stay by the {bank} while the crew empties the vault.', talk: [[GN, 'Everybody on the floor!'], [L, 'Engine running. They\'ll be seconds.']] },
          { kind: 'heat', level: p.heat, text: 'The alarm\'s gone off', onEnter: bag, talk: [[DN, 'Bags are in! Drive!']] },
          { kind: 'lose', obj: 'They\'re out. Lose the {cops}.' },
          { kind: 'deliver', to: SAFE, obj: 'Get the take to the {planning room}.', talk: [[L, 'You\'re clear. Bring it home.']] }]
        : [
          { kind: 'goto', to: BANK, foot: true, obj: 'Walk into the {bank} with the crew.' },
          { kind: 'hold', to: BANK, secs: p.holdT, r: 40, bar: 'VAULT', obj: `Stay close while {${p.hacker[0]}} opens the vault.`, talk: [[HN, 'I\'m in the panel. Look bored.']] },
          { kind: 'heat', level: p.heat, text: 'Silent alarm', onEnter: bag, talk: [[HN, 'That\'s the timer. Somebody knows.'], [DN, 'Car\'s outside. Walk, don\'t run.']] },
          { kind: 'lose', obj: 'Lose the {cops}.' },
          { kind: 'deliver', to: SAFE, obj: 'Get the take to the {planning room}.', talk: [[L, 'Nobody followed? Bring it home.']] }] };
      for (const j of [wheels, kit, finale]) { j.par = parOf(j.stages, SAFE); j.gold = [under(j.par), ...j.gold]; }
      return [wheels, kit, finale];
    }
    const heistReady = () => S.done >= 3 && H.phase < 3;
    // the planning board
    const boardEl = $('heist'), boardBody = $('heist-body');
    let boardOpen = false, draft = null;
    function renderBoard() {
      if (!boardBody) return;
      const p = plan(draft), est = bagged(p), opt = (cls, attrs, name, tag, text) => `<button class="heist-opt${cls ? ' sel' : ''}" ${attrs}><b>${name}</b><em>${tag}</em><small>${text}</small></button>`;
      let h = '<h3>THE APPROACH</h3><div class="heist-row">'
        + opt(draft.approach === 'loud', 'data-approach="loud"', 'Loud', 'IN AND OUT IN SECONDS · FOUR OR FIVE STARS', 'Front door, masks on. The gunman decides how fast the vault is emptied; then every unit in the valley is on you, and the driver decides how many.')
        + opt(draft.approach === 'smart', 'data-approach="smart"', 'Smart', 'QUIET VAULT · ONE TO THREE STARS', 'In as customers. The hacker opens the vault while you wait, and how good the hacker is decides how long before anyone notices.') + '</div>';
      CREW.forEach((c, i) => {
        h += `<h3>${c.role.toUpperCase()}</h3><div class="heist-row">` + c.who.map(([name, cut, note], k) => opt(draft.crew[i] === k, `data-role="${i}" data-pick="${k}"`, name, `${Math.round(cut * 100)}% OF THE TAKE`, note)).join('') + '</div>';
      });
      h += `<div id="heist-sum">In the vault  ${money(GROSS)}\nYou should walk out with about  ${money(est)}\nCrew and Lena take  ${Math.round(p.cuts * 100)}%\nYour cut, if you bring it all home  ${money(est * (1 - p.cuts))}\nAt the bank  ${p.holdT} s · ${p.heat} star${p.heat > 1 ? 's' : ''} when the alarm goes</div>`
        + '<div class="result-actions"><button id="heist-go" class="action primary">Lock the plan in</button></div>';
      boardBody.innerHTML = h;
    }
    function toggleBoard(open) {
      boardOpen = !!open && !!boardEl; if (!boardEl) return;
      if (boardOpen) { draft = { approach: H.approach, crew: H.crew.slice() }; renderBoard(); }
      boardEl.hidden = !boardOpen; onPause();
    }
    function lockPlan(approach, crew) {
      H.approach = approach === 'smart' ? 'smart' : 'loud'; H.crew = [0, 1, 2].map(i => clamp(Math.round(crew?.[i] ?? 1), 0, 2)); H.phase = 1; H.setups = 0;
      career.state.story = S; career.save();
    }
    boardBody?.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.approach) draft.approach = b.dataset.approach;
      else if (b.dataset.role) draft.crew[+b.dataset.role] = +b.dataset.pick;
      else if (b.id === 'heist-go') { lockPlan(draft.approach, draft.crew); toggleBoard(false); heistArmed = true; crime.say('The plan is set. Two setups, then the score: stop at the green H to start each one.', 7); return; }
      renderBoard();
    });
    $('heist-close')?.addEventListener('click', () => toggleBoard(false));
    const heistMark = marker('#7fe39a', 7); heistMark.position.set(SAFE.x, SAFE.y, SAFE.z);

    /* ---------------- Random events: a blue dot on the radar ---------------- */
    // Every few minutes of driving around with nothing on, somebody nearby needs a driver: robbers running from a
    // job, someone late and stranded, a buyer who wants a car right now. Stop at the blue marker to take it on;
    // drive past and it's gone.
    let ev = null, evT = 75;
    const evMark = marker('#4f9dff', 5);
    function placeAt(tx, tz) {
      for (let k = 0; k < 12; k++) {
        const a = k * 2.4, r = k * 14, x = tx + Math.sin(a) * r, z = tz + Math.cos(a) * r;
        if (Math.abs(x) > city.EXT * 0.9 || Math.abs(z) > city.EXT * 0.9) continue;
        const l = city.nearestLanePose(x, z, city.groundAt(x, z));
        if (l && l.kind !== 'fwy' && l.kind !== 'ramp' && l.d < 50) return { x: l.x, y: l.y || 0, z: l.z, h: l.h || 0, foot: crime.pavementNear(l.x, l.z, l.y) || { x: l.x, z: l.z, y: l.y } };
      }
      return null;
    }
    function destFrom(p, min, max) {
      for (let k = 0; k < 16; k++) { const a = Math.random() * 6.2832, d = min + Math.random() * (max - min), q = placeAt(p.x + Math.sin(a) * d, p.z + Math.cos(a) * d); if (q && Math.hypot(q.x - p.x, q.z - p.z) > min * 0.6) return q; }
      return null;
    }
    const EVENTS = [
      dest => ({ name: 'Getaway Driver', kind: 'event', pay: 3000 + Math.round(Math.random() * 20) * 100, xp: 220, card: 'Random event', next: () => '', after: ok => { if (ok) S.events++; },
        talk: [['ROBBER', 'You! You\'re driving. Go, go, go!'], ['ROBBER', 'Lose them and there\'s a cut in it for you.']],
        stages: [{ kind: 'heat', level: 3, text: 'Armed robbery reported' }, { kind: 'lose', obj: 'Lose the {cops}.' },
          { kind: 'deliver', to: dest, obj: 'Drop them at the {lock-up}.', wreck: 0.8, talk: [['ROBBER', 'Ha! Nice. Take us to the lock-up.']] }] }),
      (dest, from) => { const d = Math.hypot(dest.x - from.x, dest.z - from.z), T = Math.round(30 + roadDist(from, dest) / 9); // by road, at a pace a careful driver who waits at every light beats with a third to spare (play-tested)
        return { name: 'Hitch Lift', kind: 'event', pay: 800 + Math.round(d / 100) * 100, xp: 150, card: 'Random event', next: () => '', after: ok => { if (ok) S.events++; },
          talk: [['STRANGER', 'Oh, thank you. My car died and I\'m so late.'], ['STRANGER', 'Fast is fine. In one piece is better.']],
          stages: [{ kind: 'deliver', to: dest, obj: 'Give her a lift to {where she\'s going} before she\'s late.', limit: T, late: 'Too late. She walked the rest.', wreck: 0.35, bar: 'TIME' }] }; },
      dest => ({ name: 'Buyer in a Hurry', kind: 'event', pay: st => 4500, xp: 200, card: 'Random event', next: () => '', after: ok => { if (ok) S.events++; },
        talk: [['BUYER', 'You look like you can find a car. I need one worth twenty grand, and I need it now.'], ['BUYER', 'Clean, and not a scratch on it. I\'ll wait four minutes.']],
        stages: [{ kind: 'steal', obj: 'Steal a car worth {$20,000} or more.', test: r => anyStolen(r) && (r.preset.price || 0) >= 20000, limit: 240, late: 'The buyer got tired of waiting.', bar: 'TIME' },
          { kind: 'deliver', to: dest, obj: 'Get it to the {buyer}, clean and unmarked.', clean: true, maxDamage: 0.2, drop: true }] }),
    ];
    // the fourth kind is a moving one: a courier's car carrying a day's takings (GTA V's security van)
    const courier = v => ({ name: 'Cash Courier', kind: 'event', pay: 4000 + Math.round(Math.random() * 30) * 100, xp: 240, card: 'Random event', next: () => '', after: ok => { if (ok) S.events++; },
      talk: [['RADIO', 'All units: cash courier on the move, single vehicle, no escort.']],
      stages: [{ kind: 'stop', v, dyn: () => ({ x: v.x, y: v.y, z: v.z }), obj: 'Stop the {courier}: run it off the road.', limit: 200, late: 'The courier got away.', bar: 'TIME' },
        { kind: 'goto', foot: true, r: 4.2, dyn: () => ({ x: v.x, y: v.y, z: v.z }), obj: 'Get out and take the {case} from the car.' },
        { kind: 'heat', level: 2, text: 'Robbery reported' }, { kind: 'lose', obj: 'Lose the {cops}.', stars: 2 }] });
    function clearEvent() { ev = null; evMark.visible = false; }

    /* ---------------- Hidden packages ---------------- */
    // Thirty glowing cases left at the valley's landmarks (the sign, the mast, the end of the pier, under the water
    // towers, by the ponds, at the foot of the wind turbines). Walk or drive over one to take it: cash for each, a
    // bonus for the lot. Nothing on the map says where they are.
    const packs = [], found = new Set(Array.isArray(S.packs) ? S.packs : []), PACK_PAY = 2500, PACK_ALL = 50000;
    {
      const spots = [], add = (x, z) => { if (Math.abs(x) < city.EXT - 20 && Math.abs(z) < city.EXT - 20) spots.push({ x, z }); };
      for (const q of city.sights || []) { // clear of the letters, the mast's hut and the wheel's legs
        const d = Math.hypot(city.start.x - q.x, city.start.z - q.z) || 1;
        if (q.name.includes('Sign')) add(q.x + (city.start.x - q.x) / d * 9, q.z + (city.start.z - q.z) / d * 9); else if (q.name.includes('Mast')) add(q.x - 7, q.z - 4); else add(q.x, q.z);
      }
      for (const q of city.sights?.towers || []) add(q.x + 9.5, q.z);
      for (const q of city.country?.ponds || []) add(q.x + q.R * 1.25, q.z);
      for (const q of (city.country?.turbines || []).slice(0, 7)) add(q.x, q.z + 6);
      const geo = new THREE.BoxGeometry(0.75, 0.55, 0.26), mat = new THREE.MeshStandardMaterial({ color: '#2a2218', emissive: '#ffb547', emissiveIntensity: 6, roughness: 0.4 });
      spots.slice(0, 30).forEach((p, i) => { const y = city.heightAt(p.x, p.z, 200) + 0.9, m = new THREE.Mesh(geo, mat); m.position.set(p.x, y, p.z); m.visible = !found.has(i); scene.add(m); packs.push({ x: p.x, y, z: p.z, m }); });
    }
    let packT = 0;
    function updatePacks(dt) {
      packT += dt;
      for (let i = 0; i < packs.length; i++) {
        const p = packs[i]; if (!p.m.visible) continue;
        const dx = p.x - car.x, dz = p.z - car.z;
        if (Math.abs(dx) > 120 || Math.abs(dz) > 120) continue;
        p.m.rotation.y = packT * 1.6 + i; p.m.position.y = p.y + Math.sin(packT * 2.2 + i) * 0.12;
        if (dx * dx + dz * dz < 7.5 && Math.abs(car.y - p.y) < 5) {
          p.m.visible = false; found.add(i); S.packs = [...found]; career.state.story = S;
          const all = found.size === packs.length; career.earn(PACK_PAY + (all ? PACK_ALL : 0), 60);
          if (ui) ui.title(all ? 'Every package found' : 'Hidden package', `${found.size} of ${packs.length} · ${money(PACK_PAY)}${all ? ' · bonus ' + money(PACK_ALL) : ''}`);
          missions.refresh?.();
        }
      }
    }
    function spawnEvent(i) {
      i = i ?? (Math.random() * (EVENTS.length + 1) | 0);
      if (i === EVENTS.length) { // the courier: any ordinary car on the move, a block or two away
        const v = (traffic?.vehicles || []).filter(v => v.state === 'drive' && !v.police).map(v => [Math.hypot(v.x - car.x, v.z - car.z), v]).filter(q => q[0] > 50 && q[0] < 260).sort((a, b) => a[0] - b[0])[0]?.[1];
        if (!v) return false;
        ev = { i, v, p: v, t: 120 }; evMark.visible = true;
        if (ui) ui.objective('A cash courier is passing: the <b>blue dot</b> on the radar.');
        return true;
      }
      const a = car.h + (Math.random() - 0.5) * 1.3, d = 170 + Math.random() * 130, p = placeAt(car.x + Math.sin(a) * d, car.z + Math.cos(a) * d);
      if (!p || [GARAGE, SAFE, ...SHOPS].some(q => Math.hypot(q.x - p.x, q.z - p.z) < 60)) return false;
      ev = { i, p, t: 110 };
      evMark.position.set(p.x, p.y, p.z); evMark.visible = true;
      if (ui) ui.objective('Somebody\'s flagging you down: the <b>blue dot</b> on the radar.');
      return true;
    }
    function updateEvents(dt, ride, speed) {
      const free = !job && !missions.engine.active;
      if (ev) {
        ev.t -= dt;
        if (!free || ev.t <= 0 || Math.hypot(ev.p.x - car.x, ev.p.z - car.z) > 650) return clearEvent();
        if (ev.v) { // a moving mark: the marker rides with it, and getting close is taking it on
          if (ev.v.state !== 'drive') return clearEvent();
          evMark.position.set(ev.v.x, ev.v.y, ev.v.z);
          if (ride && Math.hypot(ev.v.x - car.x, ev.v.z - car.z) < 28 && police.state.level === 0) { const v = ev.v; clearEvent(); startJob(courier(v)); }
          return;
        }
        if (ride && at(ev.p, 9) && speed < 3 && police.state.level === 0) {
          const from = ev.p, dest = destFrom(from, 550, 950), def = dest && EVENTS[ev.i](dest, from);
          clearEvent(); if (def) startJob(def);
        }
      } else if (free && ride && speed > 6 && police.state.level === 0) {
        if ((evT -= dt) <= 0) evT = spawnEvent() ? 170 + Math.random() * 130 : 20;
      }
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
      if (st.dyn) return st.dyn();
      if (st.kind === 'kill') return target && target.alive ? { x: target.x, y: target.y, z: target.z } : st.at.foot;
      if (st.to) return st.foot ? st.to.foot : st.to;
      return null;
    }
    function updateJob(dt) {
      const st = job.stages[stage], ride = getRide();
      // what the medals are judged on: the clock, time spent shaking the police, and damage done while you're driving
      stats.t += dt; stageT += dt; stats.peak = Math.max(stats.peak, police.state.level); if (st.kind === 'lose') stats.loseT += dt;
      if (ride) { if (stats.car === ride.preset.id && stats.last !== null && ride.damage > stats.last) stats.dmg += ride.damage - stats.last; stats.car = ride.preset.id; stats.last = ride.damage; } else stats.last = null;
      if (stats.take0) stats.take = stats.take0 * (1 - Math.min(0.6, (stats.dmg - stats.bag) * plan().spill)); // the bags don't like crashes
      if (st.limit && stageT > st.limit) return finish(false, st.late || 'Too slow.');
      if (st.kind === 'steal') { if (st.test(ride)) advance(); }
      else if (st.kind === 'hold') { if (at(st.to, st.r || 45)) { hold += dt; if (hold >= st.secs) advance(); } }
      else if (st.kind === 'stop') { // a car to run down: wrecked, or stopped with you on top of it
        const v = st.v, d = Math.hypot(v.x - car.x, v.z - car.z);
        if (v.state === 'idle' || d > 450) return finish(false, st.late || 'It got away.');
        if (v.state === 'wreck') return advance();
        hold = Math.hypot(v.vx, v.vz) < 1.5 && d < 16 ? hold + dt : 0;
        if (hold > 2.5) advance();
      }
      else if (st.kind === 'deliver') {
        if (ride && st.wreck && ride.damage > st.wreck) return finish(false, 'You wrecked the car.');
        if (ride && at(st.to, 9) && Math.hypot(car.vx, car.vz) < 2) {
          if (st.clean && police.state.level > 0) { hold = 0; return; }
          if (st.maxDamage && ride.damage > st.maxDamage) return finish(false, `The car is ${Math.round(ride.damage * 100)}% damaged. The client won't take it.`);
          hold += dt;
          if (hold >= (st.wait || 1.2)) { if (st.to === GARAGE || st.to === DOCKS || st.drop) dropCar(); advance(); }
        } else hold = 0;
      } else if (st.kind === 'goto') {
        const g = goalOf(st);
        if (at(g, st.r || (st.foot ? 2.5 : 9)) && (!st.foot || crime.onFoot) && (st.foot || Math.hypot(car.vx, car.vz) < 3)) advance();
      } else if (st.kind === 'lose') { if (police.state.level === 0) advance(); }
      else if (st.kind === 'kill') {
        if (!target) { if (Math.hypot(st.at.x - car.x, st.at.z - car.z) < 180) spawnTarget(st); }
        else if (!target.alive) { dropTarget(); advance(); }
        else if (!crime.peds.includes(target)) { if (target.fled) return finish(false, 'The debtor got away.'); dropTarget(); } // out of range before he saw you: he's back when you return
        else {
          target.tag.position.set(target.x, target.y + 2.4 + Math.sin(performance.now() / 200) * 0.1, target.z);
          // he runs once he sees you coming
          const d = Math.hypot(target.x - car.x, target.z - car.z) || 1;
          if (d < 22 && !target.flee) { target.flee = true; target.fled = true; target.t = -6; target.vx = (target.x - car.x) / d * 4.6; target.vz = (target.z - car.z) / d * 4.6; if (ui) ui.talk([[D, 'No, no, no!']]); }
          if (target.fled && st.escape && d > st.escape) return finish(false, 'The debtor got away.');
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
      // Lena's planning room: the board the first time, then each setup and the score itself
      const hj = !job && heistReady(), ride0 = getRide(), speed0 = Math.hypot(car.vx, car.vz);
      heistMark.visible = !!hj && !missions.engine.active;
      if (!heistArmed && !at(SAFE, 25)) heistArmed = true;
      if (boardOpen && !at(SAFE, 30)) toggleBoard(false);
      if (hj && heistArmed && !boardOpen && !missions.engine.active && coolT <= 0 && at(SAFE, 7) && speed0 < 4) {
        if (H.phase === 0) { heistArmed = false; toggleBoard(true); } else startJob(heistJobs()[H.phase === 1 ? H.setups : 2]);
      }
      updateEvents(dt, ride0, speed0); updatePacks(dt);
      if (job) updateJob(dt);
      // the objective again if you seem to have lost the thread
      if (job && ui && (objT += dt) > 45) { objT = 0; const o = job.stages[stage]?.obj; if (o) ui.objective(lit(o)); }
      const g = job ? goalOf(job.stages[stage]) : null;
      goalMark.visible = !!g; if (g) goalMark.position.set(g.x, g.y || 0, g.z);
      // HUD
      if ((hudT += dt) < 0.1) return; hudT = 0;
      const prompt = $('shop-prompt');
      if (prompt) { prompt.hidden = !shopAt || shopOpen; if (shopAt) prompt.innerHTML = `<b>${shopAt.name}</b> Press <kbd>Enter</kbd> to shop`; }
      if (!panel) return;
      panel.hidden = !job;
      if (job) {
        const st = job.stages[stage], ride = getRide(), rows = [];
        if (st.kind === 'hold') rows.push([st.bar || 'HOLD', clock(st.secs - hold)]);
        if (st.limit) rows.push([st.bar || 'TIME', clock(st.limit - stageT)]);
        if (stats.take0) rows.push(['TAKE', money(stats.take)]);
        setBars(rows);
        const meta = panel.querySelector('.job-meta'); if (meta?.firstChild) meta.firstChild.textContent = ({ setup: 'HEIST SETUP ', finale: 'THE HEIST ', event: 'RANDOM EVENT ', replay: 'REPLAY ' })[job.kind] || "MARLOWE'S JOB ";
        title.textContent = job.name;
        let t = plain(st.obj || st.text);
        if (st.kind === 'deliver' && !ride) t += ' (you need a car)';
        else if (st.kind === 'deliver' && st.clean && police.state.level > 0 && at(st.to, 30)) t = 'Lose the police first';
        else if (st.kind === 'deliver' && hold > 0) t = `${st.wait ? 'Waiting' : 'Unloading'}… ${Math.ceil((st.wait || 1.2) - hold)} s`;
        else if (st.kind === 'hold' && !at(st.to, st.r || 45)) t = 'Get back to the bank';
        if (st.kind === 'deliver' && st.maxDamage && ride) t += ` · damage ${Math.round(ride.damage * 100)}% / ${Math.round(st.maxDamage * 100)}%`;
        step.textContent = t;
        if (g) { dist.textContent = Math.round(Math.hypot(g.x - car.x, g.z - car.z)) + ' m'; arrowEl.style.transform = `rotate(${Math.atan2(g.x - car.x, g.z - car.z) - car.h}rad)`; arrowEl.hidden = false; }
        else { dist.textContent = ''; arrowEl.hidden = true; }
      }
    }
    function drawMap(g, X, Y) {
      const dot = (p, col, r, label) => {
        const x = X(p.x, p.z), y = Y(p.x, p.z);
        g.fillStyle = col; g.strokeStyle = '#16151a'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
        if (label) { g.fillStyle = '#16151a'; g.font = `700 ${Math.round(r * 1.5)}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, x, y + 0.5); }
      };
      g.save();
      for (const s of SHOPS) dot(s, '#4fa3ff', 7, '$');
      if (!job && nextJob()) dot(GARAGE, '#ffcf3a', 8, 'M');
      if (!job && heistReady()) dot(SAFE, '#7fe39a', 8, 'H');
      if (ev && (performance.now() / 350 | 0) % 4) dot(ev.p, '#4f9dff', 6);
      const p = job && goalOf(job.stages[stage]); if (p) dot(p, '#53e4c1', 7, '!');
      if (target && target.alive) dot(target, '#ff4a3d', 5);
      g.restore();
    }
    return {
      update, drawMap, jobs: JOBS, places: { GARAGE, SHOPS, DOCKS, BANK, SAFE, DROP, HOUSE, YARD },
      get active() { return job; }, get goal() { return job ? goalOf(job.stages[stage]) : null; }, get stage() { return stage; }, get shopOpen() { return shopOpen; }, get shopAt() { return shopAt; },
      get briefOpen() { return (!!brief && !brief.hidden) || boardOpen; },
      openShop() { if (shopAt) toggleShop(!shopOpen); },
      closeAll() { if (shopOpen) toggleShop(false); if (boardOpen) toggleBoard(false); if (brief && !brief.hidden) { brief.hidden = true; onPause(); } },
      fail(why) { if (job) finish(false, why); },
      start(i = S.done) { if (!job && JOBS[i]) startJob(JOBS[i]); },
      // the heist, random events and the medal sheet, for the map and for tests
      heist: { get state() { return H; }, crew: CREW, gross: GROSS, plan, payout, jobs: heistJobs, lock: lockPlan, board: toggleBoard, get ready() { return heistReady(); }, get boardOpen() { return boardOpen; },
        start(i) { if (!job && H.phase > 0) startJob(heistJobs()[i ?? (H.phase === 1 ? H.setups : 2)]); } },
      replay(i) { if (!job && !missions.engine.active && i < S.done && JOBS[i]) startJob({ ...JOBS[i], kind: 'replay', pay: 0, xp: 60, card: `Replay · beat ${clock(JOBS[i].par)}`, next: () => '' }); },
      get done() { return S.done; }, get heistDone() { return H.phase >= 3; }, get eventsDone() { return S.events; },
      events: { list: EVENTS, spawn: spawnEvent, clear: clearEvent, get now() { return ev; }, get done() { return S.events; } },
      get stats() { return stats; }, get medals() { return S.medals; }, grade, packs: { list: packs, get found() { return found.size; } },
      skip() { if (job) advance(); },
    };
  };
})();
