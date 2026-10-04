// Street life: Marlowe's first job (steal a car, deliver it), Apex Customs (repair, respray, sell), exploits closed.
const { chromium } = require('playwright'), assert = require('node:assert/strict');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(process.env.APEX_URL || 'http://127.0.0.1:8085');
  await p.waitForFunction(() => window.apex && apex.street, { timeout: 120000 });
  await p.evaluate(() => { localStorage.clear(); });
  await p.reload(); await p.waitForFunction(() => window.apex && apex.street, { timeout: 120000 });
  await p.locator('#start-foot').click();
  await p.waitForTimeout(800);
  const S = () => p.evaluate(() => ({ job: apex.street.active?.name || null, stage: apex.street.stage, cash: apex.career.state.cash, done: apex.career.state.story?.done, onFoot: apex.crime.onFoot, brief: apex.street.briefOpen }));
  // walk into the garage marker: the first job starts with a briefing
  await p.evaluate(() => { const g = apex.street.places.GARAGE; apex.police.clear(); apex.crime.setFootPosition({ x: g.x, z: g.z, y: g.y, h: 0 }); });
  await p.waitForFunction(() => apex.street.active);
  let s = await S(); console.log('started', s);
  assert.equal(s.job, 'Wheels'); assert.ok(s.brief, 'briefing shown');
  await p.locator('#story-ok').click();
  // steal a car: any parked civilian car
  await p.waitForFunction(() => apex.crime.parked.some(r => r.npc), { timeout: 20000 });
  await p.evaluate(async () => { for (const u of apex.traffic.police.units()) { u.x += 6000; } const r = apex.crime.parked.find(q => q.npc); r.locked = false; const h = r.pose.h; apex.crime.setFootPosition({ x: r.pose.x + Math.cos(h) * 2.2, z: r.pose.z - Math.sin(h) * 2.2, y: r.pose.y, h }); await new Promise(res => setTimeout(res, 200)); await apex.crime.interact(); });
  await p.waitForFunction(() => !apex.crime.onFoot && apex.street.stage === 1, { timeout: 10000 });
  // deliver it
  await p.evaluate(() => { apex.police.clear(); const g = apex.street.places.GARAGE; apex.resetCar({ x: g.x, z: g.z, y: g.y, h: g.h }); });
  await p.waitForFunction(() => !apex.street.active, { timeout: 10000 });
  s = await S(); console.log('done', s);
  assert.ok(s.done === 1 && s.onFoot && s.cash >= 4500, 'job pays, car handed over');
  await p.keyboard.press('Escape');
  // Apex Customs: in a stolen, dented car: repair, then sell it
  await p.evaluate(async () => { const r = apex.crime.parked.find(q => q.npc) ; if (r) { r.locked = false; apex.crime.setFootPosition({ x: r.pose.x + Math.cos(r.pose.h) * 2.2, z: r.pose.z - Math.sin(r.pose.h) * 2.2, y: r.pose.y, h: r.pose.h }); await new Promise(res => setTimeout(res, 200)); await apex.crime.interact(); } });
  await p.waitForFunction(() => !apex.crime.onFoot, { timeout: 15000 });
  await p.evaluate(() => { const s = apex.soft(); for (let i = 0; i < s.p.length; i += 3) if (s.rest[i + 2] > 1.4) s.p[i + 2] -= 0.3; s.version++; s.refresh(); apex.applyDamage(); const sh = apex.street.places.SHOPS[0]; apex.resetCar({ x: sh.x, z: sh.z, y: sh.y, h: sh.h }); });
  await p.waitForTimeout(400);
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => apex.street.shopOpen);
  const items = await p.locator('#shop-body button').allTextContents(); console.log('shop', items);
  const c0 = await p.evaluate(() => apex.career.state.cash), d0 = await p.evaluate(() => apex.soft().damage);
  await p.locator('#shop-body button', { hasText: 'Repair' }).click();
  const after = await p.evaluate(() => ({ cash: apex.career.state.cash, dmg: apex.soft().damage }));
  console.log('repair', d0.toFixed(3), '->', after);
  assert.ok(after.cash < c0 && after.dmg < 0.01, 'repair costs and fixes');
  await p.locator('#shop-body button', { hasText: 'Sell this car' }).click();
  const sold = await p.evaluate(() => ({ cash: apex.career.state.cash, onFoot: apex.crime.onFoot }));
  console.log('sold', sold);
  assert.ok(sold.onFoot && sold.cash > after.cash, 'selling pays and takes the car');
  // respray: wanted, out of sight, in a car → clears the stars
  await p.evaluate(async () => { const r = apex.crime.parked.find(q => q.npc); r.locked = false; apex.crime.setFootPosition({ x: r.pose.x + Math.cos(r.pose.h) * 2.2, z: r.pose.z - Math.sin(r.pose.h) * 2.2, y: r.pose.y, h: r.pose.h }); await new Promise(res => setTimeout(res, 200)); await apex.crime.interact(); });
  await p.waitForFunction(() => !apex.crime.onFoot, { timeout: 15000 });
  await p.evaluate(() => { const sh = apex.street.places.SHOPS[0]; apex.resetCar({ x: sh.x, z: sh.z, y: sh.y, h: sh.h }); apex.police.raise(2, 'Test', 100); });
  await p.waitForTimeout(300);
  await p.evaluate(() => { for (const u of apex.traffic.police.units()) apex.traffic.police.recycle(u) || (u.x += 6000); apex.police.state.seen = false; apex.police.state.seenBy = []; apex.street.openShop(); });
  const btn = p.locator('#shop-body button', { hasText: 'Respray' });
  console.log('respray button', await btn.textContent());
  if (await btn.isEnabled()) { await btn.click(); assert.equal(await p.evaluate(() => apex.police.state.level), 0, 'respray loses the police'); }
  // exploits: no free repair on R and no garage swap while wanted
  await p.keyboard.press('Escape');
  const ex = await p.evaluate(async () => { apex.police.raise(2, 'Test', 100); apex.harmState().tyres = 0.4; apex.respawn(false); const t = apex.harmState().tyres; const ok = await apex.chooseCar(apex.PRESETS.find(q => q.id === 'sedan')); return { tyres: t, swapped: ok }; });
  console.log('exploits', ex);
  assert.ok(ex.tyres < 1 && !ex.swapped, 'R and garage do not wipe a chase');
  console.log('ERRORS', errors); assert.deepEqual(errors, []);
  console.log('Street: job, delivery, shop repair/sell, exploit guards passed');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
