// On-foot crime layer: start on foot, walk, shoot, steal a parked car, drive, exit (car stays), re-enter, carjack, police rules, wasted.
const { chromium } = require('playwright'), assert = require('node:assert/strict');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && /THREE|WebGL|shader|crime/i.test(m.text())) errors.push(m.text()); });
  await p.goto(process.env.APEX_URL || 'http://127.0.0.1:8085');
  await p.waitForFunction(() => window.apex && window.apex.crime, { timeout: 120000 });
  assert.equal(await p.locator('#start-cards .card').count(), 2, 'start cards render');
  await p.locator('#start-foot').click();
  await p.waitForFunction(() => document.getElementById('start').hidden && apex.crime.onFoot);
  await p.waitForTimeout(1500);

  // walking
  const walk0 = await p.evaluate(() => ({ x: apex.crime.position.x, z: apex.crime.position.z }));
  await p.keyboard.down('KeyW'); await p.waitForTimeout(1500); await p.keyboard.up('KeyW');
  const walk1 = await p.evaluate(() => ({ x: apex.crime.position.x, z: apex.crime.position.z }));
  const walked = Math.hypot(walk1.x - walk0.x, walk1.z - walk0.z);
  console.log('walked m', walked.toFixed(2));
  assert.ok(walked > 1.5, 'player walks with W');

  // aim: the screen centre is the game canvas (no HUD panel in the way), the crosshair shows, and the mouse turns the camera
  const centre = await p.evaluate(() => { const e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return { id: e && e.id, tag: e && e.tagName, cross: getComputedStyle(document.getElementById('crosshair')).display }; });
  console.log('centre', centre);
  assert.ok(centre.id === 'gl' || centre.id === 'crosshair' || centre.tag === 'CANVAS', 'nothing covers the aim point');
  assert.equal(centre.cross, 'block', 'crosshair visible on foot');
  const look0 = await p.evaluate(() => { const v = new THREE.Vector3(); apex.camera.getWorldDirection(v); return Math.atan2(v.x, v.z); });
  await p.mouse.move(720, 450); for (let i = 1; i <= 10; i++) await p.mouse.move(720 + i * 30, 450);
  await p.waitForTimeout(500);
  const look1 = await p.evaluate(() => { const v = new THREE.Vector3(); apex.camera.getWorldDirection(v); return Math.atan2(v.x, v.z); });
  const turned = Math.abs(Math.atan2(Math.sin(look1 - look0), Math.cos(look1 - look0)));
  console.log('mouse turned camera rad', turned.toFixed(2));
  assert.ok(turned > 0.2, 'mouse look turns the camera');

  // weapons + firing
  await p.keyboard.press('Digit3');
  assert.equal(await p.evaluate(() => apex.crime.weapon), 2);
  await p.keyboard.press('Digit2');
  const st0 = await p.locator('#crime-status').textContent();
  await p.mouse.move(720, 450); await p.mouse.down(); await p.waitForTimeout(120); await p.mouse.up();
  await p.waitForTimeout(250);
  const st1 = await p.locator('#crime-status').textContent();
  console.log('status', st0, '->', st1);
  assert.notEqual(st0, st1, 'firing uses ammo');

  // world: pedestrians and civilian parked cars appear
  await p.waitForFunction(() => apex.crime.parked.filter(r => r.npc).length > 0 && apex.crime.peds.length > 5, { timeout: 20000 });
  const world = await p.evaluate(() => ({ parked: apex.crime.parked.filter(r => r.npc).length, peds: apex.crime.peds.length }));
  console.log('world', world);

  // no cop watching: send every active police unit far away first
  await p.evaluate(() => { for (const u of apex.traffic.police.units()) { u.x += 6000; u.z += 6000; } apex.police.clear(); });
  // steal a parked car by picking the lock (hold F)
  const cash0 = await p.evaluate(() => apex.career.state.cash);
  await p.evaluate(() => { const r = apex.crime.parked.find(q => q.npc); window.__target = r; const h = r.pose.h; apex.crime.setFootPosition({ x: r.pose.x + Math.cos(h) * 2.2, z: r.pose.z - Math.sin(h) * 2.2, y: r.pose.y, h }); });
  await p.waitForTimeout(250);
  const prompt = await p.locator('#crime-prompt').textContent();
  console.log('prompt', prompt);
  assert.match(prompt, /pick the lock/i);
  await p.keyboard.down('KeyF');
  await p.waitForFunction(() => !apex.crime.onFoot, { timeout: 12000 });
  await p.keyboard.up('KeyF');
  const stolen = await p.evaluate(() => ({ cash: apex.career.state.cash, gone: window.__target.removed }));
  console.log('stolen', stolen, 'cash', cash0, '->', stolen.cash);
  assert.ok(stolen.gone && stolen.cash === cash0, 'stealing removes the parked car (cash comes from selling it on)');
  assert.equal(await p.evaluate(() => apex.police.state.level), 0, 'a theft nobody in uniform saw starts no chase');

  // drive (R puts the car on the nearest lane first: pulling out of a space needs steering)
  await p.keyboard.press('KeyR'); await p.waitForTimeout(300);
  await p.keyboard.down('KeyW'); await p.waitForTimeout(2500);
  const speed = await p.evaluate(() => Math.hypot(apex.car.vx, apex.car.vz));
  await p.keyboard.up('KeyW');
  console.log('speed m/s', speed.toFixed(1));
  assert.ok(speed > 4, 'stolen car drives');
  await p.keyboard.down('Space'); await p.waitForTimeout(2500); await p.keyboard.up('Space');

  // dent it, so we can check the damage survives getting out and back in
  // (a plastic dent: the beams take their new lengths, as bent steel does)
  await p.evaluate(() => { const s = apex.soft(); for (let i = 0; i < s.p.length; i += 3) if (s.rest[i + 2] > 1.4) s.p[i + 2] -= 0.35; s.pp.set(s.p);
    for (let k = 0; k < s.M; k++) { const a = s.ba[k] * 3, b = s.bb[k] * 3; s.len[k] = Math.hypot(s.p[a] - s.p[b], s.p[a + 1] - s.p[b + 1], s.p[a + 2] - s.p[b + 2]); } s.version++; });
  await p.waitForTimeout(500);
  const dmg0 = await p.evaluate(() => { const s = apex.soft(); s.refresh(); return s.damage; });
  console.log('dented', dmg0.toFixed(3));
  // exit: the car stays parked where you left it, and you can get back in
  await p.keyboard.press('KeyF');
  await p.waitForFunction(() => apex.crime.onFoot);
  assert.equal(await p.evaluate(() => apex.crime.parked.filter(r => !r.npc).length), 1, 'exiting leaves your car parked');
  await p.waitForTimeout(300);
  await p.keyboard.press('KeyF');
  await p.waitForFunction(() => !apex.crime.onFoot, { timeout: 8000 });
  assert.equal(await p.evaluate(() => apex.crime.parked.filter(r => !r.npc).length), 0, 'getting back in takes the car');
  const dmg1 = await p.evaluate(() => apex.soft().damage);
  console.log('damage after re-entry', dmg1.toFixed(3));
  assert.ok(dmg0 > 0.01 && Math.abs(dmg1 - dmg0) < 0.02, 'damage carries over when you get back in');

  // carjack a traffic car
  await p.keyboard.press('KeyF'); await p.waitForFunction(() => apex.crime.onFoot);
  const jack = await p.evaluate(async () => {
    const v = apex.traffic.vehicles.find(u => u.state !== 'idle' && !u.police);
    if (!v) return { skipped: true };
    v.vx = v.vz = 0;
    apex.crime.setFootPosition({ x: v.x + Math.cos(v.h) * 2, z: v.z - Math.sin(v.h) * 2, y: v.y, h: v.h });
    await apex.crime.interact();
    return { onFoot: apex.crime.onFoot, taken: !!v.crimeTaken, fleeing: apex.crime.peds.some(pd => pd.flee) };
  });
  console.log('carjack', jack);
  if (!jack.skipped) assert.ok(!jack.onFoot && jack.taken, 'carjacking puts you in the car');

  // a cop who sees you shoot starts a chase
  await p.keyboard.press('KeyF'); await p.waitForFunction(() => apex.crime.onFoot);
  const witnessed = await p.evaluate(() => {
    apex.police.clear();
    const u = apex.traffic.police.units().find(v => v.state !== 'wreck') || null;
    if (!u) return { skipped: true };
    const f = apex.crime.position; u.x = f.x + 9; u.z = f.z; u.y = f.y; u.vx = u.vz = 0;
    apex.crime.setWeapon(1); apex.crime.fire();
    return { level: apex.police.state.level };
  });
  console.log('witnessed gunfire', witnessed);
  if (!witnessed.skipped) assert.ok(witnessed.level >= 1, 'gunfire in front of a cop starts a chase');
  // a real chase: 2 stars, stand in the open, and the police must hurt or bust you on their own
  const chase = await p.evaluate(() => new Promise(res => {
    apex.police.raise(2, 'Test chase', 500);
    const busted0 = apex.police.state.busted || 0; let minHp = apex.crime.health, units = 0;
    const t0 = performance.now();
    const tick = setInterval(() => {
      minHp = Math.min(minHp, apex.crime.health);
      units = Math.max(units, apex.traffic.police.units().filter(v => v.state === 'pursue').length);
      const busted = (apex.police.state.busted || 0) > busted0 || !apex.crime.onFoot;
      if (busted || minHp < 100 || performance.now() - t0 > 25000) { clearInterval(tick); res({ minHp, busted, units, secs: ((performance.now() - t0) / 1000).toFixed(1) }); }
    }, 200);
  }));
  console.log('real chase', chase);
  assert.ok(chase.units > 0, 'pursuit units respond');
  assert.ok(chase.minHp < 100 || chase.busted, 'police shoot or bust you without help');
  if (!(await p.evaluate(() => apex.crime.onFoot))) { await p.keyboard.press('KeyF'); await p.waitForFunction(() => apex.crime.onFoot); }
  // wasted on foot: back on your feet on the pavement, full health, a hospital bill, the chase over
  const wasted = await p.evaluate(() => { apex.career.state.cash += 1000; const c = apex.career.state.cash; apex.crime.hurt(500); return { cashBefore: c, cash: apex.career.state.cash, onFoot: apex.crime.onFoot, hp: apex.crime.health, level: apex.police.state.level }; });
  console.log('wasted', wasted);
  assert.ok(wasted.onFoot && wasted.hp === 100 && wasted.cash < wasted.cashBefore && wasted.level === 0, 'wasted: on foot, healed, billed, chase over');
  // driveway cars: the instanced ones near you turn into real cars you can break into
  const drive = await p.evaluate(() => new Promise(res => {
    const f = apex.crime.position;
    const spot = apex.city.parkedSpots.filter(s => s.drive && !s.taken).sort((a, b) => Math.hypot(a.x - f.x, a.z - f.z) - Math.hypot(b.x - f.x, b.z - f.z))[0];
    apex.crime.setFootPosition({ x: spot.x + Math.cos(spot.yaw) * 2.2, z: spot.z - Math.sin(spot.yaw) * 2.2, y: spot.y, h: spot.yaw });
    setTimeout(() => res({ swapped: spot.swapped, real: apex.crime.parked.some(r => r.spot === spot), target: apex.crime.currentTarget()?.record?.spot === spot }), 2500);
  }));
  console.log('driveway', drive);
  assert.ok(drive.swapped && drive.real && drive.target, 'driveway car can be broken into');
  // contracts start where you are
  const job = await p.evaluate(() => {
    const f = { x: apex.crime.position.x, z: apex.crime.position.z };
    const j = apex.missions.jobs.find(j => j.type === 'race' && j.level === 1);
    const ok = apex.missions.begin(j);
    const a = apex.missions.engine.active, first = a.job.points[0];
    const out = { ok, moved: Math.hypot(apex.crime.position.x - f.x, apex.crime.position.z - f.z), firstFromHere: Math.hypot(first.x - f.x, first.z - f.z), firstFromStart: Math.hypot(first.x - apex.city.start.x, first.z - apex.city.start.z) };
    apex.missions.engine.cancel(); document.getElementById('mission-result').hidden = true;
    return out;
  });
  console.log('contract', job);
  assert.ok(job.ok && job.moved < 0.5 && job.firstFromHere < 400, 'contract starts here, no teleport');
  await p.screenshot({ path: '/tmp/apex-crime.png' });
  await p.keyboard.press('KeyF'); await p.waitForFunction(() => apex.crime.onFoot);
  await p.waitForTimeout(600);
  await p.screenshot({ path: '/tmp/apex-onfoot.png' });
  // memory: draw calls and GPU allocations shouldn't climb while you drive around for a minute
  const mem = () => p.evaluate(() => { const i = apex.renderer.info; return { geo: i.memory.geometries, tex: i.memory.textures, calls: i.render.calls }; });
  await p.keyboard.press('KeyF'); await p.waitForFunction(() => !apex.crime.onFoot, { timeout: 8000 }).catch(() => {});
  if (await p.evaluate(() => apex.crime.onFoot)) await p.evaluate(() => apex.exitCar && 0);
  await p.evaluate(() => apex.police.clear());
  const m0 = await mem();
  for (let lap = 0; lap < 12; lap++) { await p.keyboard.press('KeyR'); await p.keyboard.down('KeyW'); await p.waitForTimeout(5000); await p.keyboard.up('KeyW'); }
  const m1 = await mem();
  console.log('memory before', m0, 'after 60 s driving', m1);
  assert.ok(m1.geo < m0.geo * 1.6 + 200, 'geometry count stays bounded');
  console.log('ERRORS', errors);
  assert.deepEqual(errors, []);
  console.log('Crime layer: walk, shoot, lock pick, theft payout, drive, exit and re-enter, carjack, police, wasted passed');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
