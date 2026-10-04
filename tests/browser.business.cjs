const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{const b=await chromium.launch({channel:'chrome',headless:true});const p=await b.newPage({viewport:{width:1440,height:900}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
await p.goto(process.env.APEX_URL||'http://127.0.0.1:8085');await p.waitForFunction(()=>window.apex?.empire,{timeout:120000});await p.locator('#start-cards [data-car=sedan]').click();await p.waitForFunction(()=>document.getElementById('start').hidden);
await p.evaluate(()=>{apex.career.state.cash=200000;apex.career.state.xp=350*16;apex.career.save();});
await p.keyboard.press('b');await p.waitForSelector('#empire:not([hidden])');
await p.locator('[data-act=buy][data-id=courier]').click();
assert.equal(await p.evaluate(()=>!!apex.empire.empire.state.owned.courier),true);
// the sell button only appears at the property
assert.equal(await p.locator('[data-act=sell][data-id=courier]').count(),0);
await p.evaluate(()=>{apex.empire.empire.state.owned.courier.stock=20;});
await p.locator('[data-act=taxi][data-id=courier]').click();await p.waitForSelector('#empire',{state:'hidden'});
await p.keyboard.press('b');await p.locator('[data-act=sell][data-id=courier]').click();
const sale=await p.evaluate(()=>{const a=apex.missions.engine.active;return {drops:a.job.points.length,stock:apex.empire.empire.state.owned.courier.stock,cash:apex.career.state.cash};});
assert.ok(sale.drops>=1);assert.equal(sale.stock,0);
// drive the samples along the drop chain (menus paused so physics stays out of it)
const after=await p.evaluate(()=>{const a=apex.missions.engine.active,j=a.job;apex.missions.toggle(true);let x=apex.car.x,z=apex.car.z;
  for(const q of j.points){while(Math.hypot(q.x-x,q.z-z)>1){const d=Math.hypot(q.x-x,q.z-z),s=Math.min(2,d);x+=(q.x-x)*s/d;z+=(q.z-z)*s/d;apex.missions.engine.update(.1,{x,z,y:q.y,speed:20,slip:0,surface:'asphalt',damage:0,wanted:0});}
    for(let t=0;t<25&&apex.missions.engine.active;t++)apex.missions.engine.update(.1,{x,z,y:q.y,speed:0,slip:0,surface:'asphalt',damage:0,wanted:0});}
  return {active:!!apex.missions.engine.active,cash:apex.career.state.cash,sales:apex.empire.empire.state.stats.sales};});
assert.equal(after.active,false);assert.ok(after.cash>sale.cash+20000,JSON.stringify(after));assert.ok(after.sales>=20000);
await p.keyboard.press('Escape');
// a failed sale returns three quarters of the stock
await p.evaluate(()=>{apex.empire.empire.state.owned.courier.stock=20;});await p.keyboard.press('b');await p.locator('[data-act=sell][data-id=courier]').click();
await p.evaluate(()=>apex.missions.engine.cancel());assert.equal(await p.evaluate(()=>apex.empire.empire.state.owned.courier.stock),15);
await p.reload();await p.waitForFunction(()=>window.apex?.empire,{timeout:120000});
const saved=await p.evaluate(()=>({own:!!apex.empire.empire.state.owned.courier,stock:apex.empire.empire.state.owned.courier.stock,sales:apex.empire.empire.state.stats.sales}));
assert.equal(saved.own,true);assert.equal(saved.stock,15);assert.equal(saved.sales,after.sales);
assert.deepEqual(errors,[]);console.log('Business purchase, taxi, sale, failure refund and reload passed');await b.close();})();
