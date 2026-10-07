const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('favicon.ico'))errors.push(r.status()+': '+r.url())});page.on('console',m=>{if(m.type()==='error'&&/THREE|WebGL|shader/i.test(m.text()))errors.push(m.text())});
 const url=process.env.APEX_URL||'http://127.0.0.1:8085';await page.goto(url);await page.waitForFunction(()=>window.apex,{timeout:120000});await page.locator('#start-cards [data-car=sedan]').click();await page.waitForFunction(()=>document.getElementById('start').hidden);
 // Test harness owns all cars; player-facing purchases are tested separately.
 await page.evaluate(()=>{apex.career.state.owned=apex.PRESETS.map(p=>p.id);apex.setQuality(0);});
 for(let i=0;i<24;i++){
  const state=await page.evaluate(async i=>{const pr=apex.PRESETS[i];const selected=await apex.chooseCar(pr);const model=apex.carModels.find(m=>m.id===pr.id);const kit=buildModelCar(model);return {selected,id:model.id,wheels:model.wheels.length,axles:model.axles,lamps:kit.mats.head!==kit.mats.tail,finite:model.body.every(b=>Array.from(b.geo.attributes.position.array).every(Number.isFinite))};},i);
  assert.ok(state.selected&&state.finite&&state.lamps);assert.equal(state.wheels,4);assert.ok(state.axles.front>0&&state.axles.rear<0);console.log('MODEL',state.id);
 }
 for(let q=0;q<3;q++){await page.evaluate(q=>apex.setQuality(q),q);assert.equal(await page.evaluate(()=>apex.sun.shadow.mapSize.x),[1024,2048,3072][q]);}
 const before=await page.evaluate(()=>[apex.car.x,apex.car.z]);await page.keyboard.down('w');await page.waitForTimeout(1300);await page.keyboard.up('w');const after=await page.evaluate(()=>[apex.car.x,apex.car.z]);assert.ok(Math.hypot(after[0]-before[0],after[1]-before[1])>.05);
 await page.goto(url+'/car-studio.html');await page.waitForFunction(()=>window.carStudio,{timeout:120000});assert.equal(await page.locator('#cars button').count(),24);for(const i of [6,15,23]){await page.locator('#cars button').nth(i).click();await page.waitForFunction(i=>carStudio.current===i,i);}
 await page.locator('#wire').click();assert.ok(await page.evaluate(()=>{let valid=true;carStudio.group.traverse(o=>{if(o.isMesh&&!o.material.wireframe)valid=false});return valid}));await page.locator('#wire').click();await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
 assert.deepEqual(errors,[]);console.log('24 models, graphics qualities, driving and studio passed');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
