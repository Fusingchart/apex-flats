// Run after building GLBs, with the HTTP server running. Requires the Playwright dev dependency.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),catalog=require('../assets/cars/cars.json');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:600,height:360}});
  await page.goto((process.env.APEX_URL||'http://127.0.0.1:8085')+'/car-studio.html');
  await page.waitForFunction(()=>window.carStudio,{timeout:120000});
  await page.addStyleTag({content:'header,main,footer{display:none!important}'});
  await page.evaluate(()=>{carStudio.camera.zoom=1;carStudio.camera.updateProjectionMatrix();});
  fs.mkdirSync(path.join(root,'assets/cars/previews'),{recursive:true});
  for(let i=0;i<catalog.length;i++) {
   const deadline=Date.now()+20*60*1000;
   while(!fs.existsSync(path.join(root,'assets/cars',catalog[i].file))){if(Date.now()>deadline)throw Error('Missing '+catalog[i].id);await new Promise(r=>setTimeout(r,1000));}
   await page.evaluate(i=>carStudio.select(i),i);
   await page.waitForFunction(i=>carStudio.current===i,i);
   const valid=await page.evaluate(i=>{const t=carStudio.cache.get(i);return t.wheels.length===4&&t.body.every(p=>Array.from(p.geo?.attributes.position.array||p.geometry?.attributes.position.array||[]).every(Number.isFinite));},i);
   if(!valid)throw Error('Invalid model '+catalog[i].id);
   await page.waitForTimeout(150);
   await page.screenshot({path:path.join(root,'assets/cars/previews',catalog[i].id+'.jpg'),type:'jpeg',quality:85});
   console.log('Rendered',catalog[i].id);
  }
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
