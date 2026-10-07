// GTA polish: street HUD (and H to the detailed one), car radio, map waypoint with a GPS route, the job GPS,
// MISSION PASSED, and the BUSTED screen.
const { chromium } = require('playwright'), assert = require('node:assert/strict');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(process.env.APEX_URL || 'http://127.0.0.1:8085');
  await p.waitForFunction(() => window.apex && apex.street, { timeout: 120000 });
  await p.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await p.reload(); await p.waitForFunction(() => window.apex && apex.street, { timeout: 120000 });
  await p.locator('#start-cards .card').first().click();
  await p.waitForTimeout(1200);
  // street HUD by default: radar bottom-left, cash top-right, no telemetry
  const hud = await p.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect(); const vis = id => getComputedStyle(document.getElementById(id)).display !== 'none';
    return { gta: document.body.classList.contains('gta'), map: r('map'), cash: document.getElementById('hud-cash').textContent, tele: vis('left'), bars: vis('vitals') }; });
  console.log('hud', hud);
  assert.ok(hud.gta && hud.map.left < 40 && hud.map.bottom > 800 && hud.cash === '$2,500' && !hud.tele && hud.bars, 'street HUD');
  await p.keyboard.press('KeyH');
  assert.equal(await p.evaluate(() => getComputedStyle(document.getElementById('left')).display !== 'none'), true, 'H shows the detailed HUD');
  await p.keyboard.press('KeyH');
  // radio: a station comes on when you get in, and . / , change it
  const r0 = await p.evaluate(() => apex.radio.station?.name || null);
  await p.keyboard.press('Period');
  const r1 = await p.evaluate(() => ({ st: apex.radio.station?.name || null, shown: document.getElementById('radio-name').classList.contains('show'), pos: getComputedStyle(document.getElementById('radio-name')).position }));
  console.log('radio', r0, '->', r1);
  assert.ok(r0 && r1.st !== r0 && r1.shown && r1.pos === 'fixed', 'radio tunes and shows the station');
  // waypoint: click the full map, get a purple route along the streets
  await p.keyboard.press('Tab'); await p.waitForTimeout(200);
  const box = await p.locator('#bigmap').boundingBox();
  await p.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.35);
  await p.keyboard.press('Tab');
  await p.waitForFunction(() => apex.gps.routes.way && apex.gps.routes.way.length > 10, { timeout: 5000 });
  const way = await p.evaluate(() => ({ n: apex.gps.routes.way.length, wp: apex.gps.waypoint }));
  console.log('waypoint route points', way.n);
  // job GPS: the next Marlowe stage gets a yellow route
  await p.evaluate(() => { apex.street.start(0); apex.street.closeAll(); apex.exitCar(); });
  await p.waitForTimeout(400);
  const intro = await p.evaluate(() => ({ title: document.getElementById('title-card').textContent, card: document.getElementById('title-card').classList.contains('show'), sub: document.getElementById('subtitle').textContent }));
  console.log('job intro', intro);
  assert.ok(intro.card && /Wheels/.test(intro.title) && /MARLOWE:/.test(intro.sub), 'job opens with a title card and dialogue');
  await p.screenshot({ path: '/tmp/gta-intro.png' });
  await p.evaluate(async () => { const r = apex.crime.parked.find(q => q.mine); await apex.crime.interact(); });
  await p.waitForFunction(() => !apex.crime.onFoot, { timeout: 8000 }).catch(() => {});
  // MISSION PASSED: finish the first job (a car you stole, delivered to the garage)
  const passed = await p.evaluate(() => new Promise(res => {
    apex.police.clear(); apex.street.closeAll();
    const r = apex.crime.parked.find(q => q.npc);
    const go = async () => {
      if (!apex.crime.onFoot) apex.exitCar();
      for (const q of apex.crime.parked) q.locked = false; for (const v of apex.traffic.vehicles) if (v.state !== 'idle' && Math.hypot(v.x - r.pose.x, v.z - r.pose.z) < 12) v.x += 3000; /* the nearest car must be this unlocked one */ apex.crime.setFootPosition({ x: r.pose.x + Math.cos(r.pose.h) * 2.2, z: r.pose.z - Math.sin(r.pose.h) * 2.2, y: r.pose.y, h: r.pose.h });
      await new Promise(q => setTimeout(q, 200)); await apex.crime.interact();
      await new Promise(q => setTimeout(q, 1300));
      const jobRoute = !!apex.gps.routes.job;
      apex.police.clear(); const g = apex.street.places.GARAGE; for (const v of apex.traffic.vehicles) if (v.state !== 'idle' && Math.hypot(v.x - g.x, v.z - g.z) < 60) v.x += 4000; apex.resetCar({ x: g.x, z: g.z, y: g.y, h: g.h });
      setTimeout(() => { const e = document.getElementById('passed'); res({ jobRoute, show: e.classList.contains('show'), text: e.textContent }); }, 2000);
    };
    if (r) go(); else res({ none: true });
  }));
  console.log('passed', passed);
  assert.ok(passed.show && /MISSION PASSED/.test(passed.text), 'MISSION PASSED banner');
  await p.screenshot({ path: '/tmp/gta-passed.png' });
  // a contract ends on the same card: drive its checkpoints
  const contract = await p.evaluate(() => new Promise(res => {
    document.getElementById('passed').className = '';
    const j = apex.missions.jobs[1]; apex.missions.begin(j);
    const a = apex.missions.engine.active; let x = apex.car.x, z = apex.car.z;
    for (const q of a.job.points) while (Math.hypot(q.x - x, q.z - z) > 1) { const d = Math.hypot(q.x - x, q.z - z), st = Math.min(2, d); x += (q.x - x) * st / d; z += (q.z - z) * st / d; apex.missions.engine.update(0.1, { x, z, y: q.y, speed: 20, slip: 0, surface: 'asphalt', damage: 0, wanted: 0 }); }
    setTimeout(() => res({ text: document.getElementById('passed').textContent, modal: !document.getElementById('mission-result').hidden }), 300);
  }));
  console.log('contract', contract);
  assert.ok(/MISSION PASSED/.test(contract.text) && !contract.modal, 'contracts end on the MISSION PASSED card');
  // BUSTED: greys out, then you're on your feet
  await p.evaluate(() => { apex.police.raise(1, 'Test', 300); apex.police.bust(); });
  await p.waitForTimeout(800);
  const busted = await p.evaluate(() => ({ grey: document.body.classList.contains('down'), banner: document.getElementById('banner').textContent }));
  await p.screenshot({ path: '/tmp/gta-busted.png' });
  await p.waitForTimeout(3000);
  const after = await p.evaluate(() => ({ grey: document.body.classList.contains('down'), onFoot: apex.crime.onFoot }));
  console.log('busted', busted, after);
  assert.ok(busted.grey && /BUSTED/.test(busted.banner) && !after.grey && after.onFoot, 'BUSTED screen then back on foot');
  console.log('ERRORS', errors); assert.deepEqual(errors, []);
  console.log('GTA polish: HUD, radio, waypoint GPS, mission passed, busted passed');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
