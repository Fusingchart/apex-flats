const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCareer,createMissionEngine,KEY}=require('../src/career.js');
const catalog=require('../assets/cars/cars.json');
const store=()=>{const data={};return {getItem:k=>data[k],setItem:(k,v)=>data[k]=v};};
const sample=(x=0,extra={})=>({x,z:0,y:0,speed:10,slip:0,surface:'asphalt',wanted:0,damage:0,...extra});
const job=(extra={})=>({id:'contract-0',type:'race',points:[{x:25,y:0,z:0}],limit:90,cash:1000,xp:120,level:1,...extra});
test('purchase is ranked, affordable, unique and persists',()=>{
 const s=store(),c=createCareer(catalog,s);assert.equal(c.state.cash,2500);assert.equal(c.purchase('supercar').ok,false);assert.equal(c.purchase('sprint').ok,false);assert.equal(c.select('supercar'),false);
 c.reward(job(),10);c.reward(job(),10);c.reward(job(),10);c.reward(job(),10);
 assert.equal(c.purchase('sprint').ok,true);const balance=c.state.cash;assert.equal(c.purchase('sprint').ok,false);assert.equal(c.state.cash,balance);assert.equal(c.select('sprint'),true);
 const restored=createCareer(catalog,s);assert.equal(restored.state.selected,'sprint');assert.equal(restored.state.cash,balance);assert.equal(restored.state.records['contract-0'].count,4);
 assert.equal(c.fine(1e9),balance);assert.equal(c.state.cash,0);
});
test('invalid saves and unavailable storage do not break play',()=>{
 const s=store();s.setItem(KEY,'{broken');const c=createCareer(catalog,s);assert.equal(c.state.cash,2500);
 s.setItem(KEY,JSON.stringify({version:1,cash:-50,xp:'oops',owned:['fake','metro','metro'],records:{'contract-0':null}}));const d=createCareer(catalog,s);assert.deepEqual(d.state.owned,['sedan','metro']);assert.equal(d.state.cash,2500);assert.equal(d.level,1);
 const e=createCareer(catalog,{getItem(){throw Error('denied')},setItem(){throw Error('quota')}});e.fine(50);assert.equal(e.state.cash,2450);assert.equal(e.saveError,true);
});
test('ordered checkpoints pay once with first-clear and medal bonuses',()=>{
 const c=createCareer(catalog,store()),results=[],m=createMissionEngine(c,r=>results.push(r));m.start(job({points:[{x:25,y:0,z:0},{x:60,y:0,z:0}]}),sample());
 assert.equal(m.start(job(),sample()).ok,false);m.update(.1,sample(10));assert.equal(m.active.stage,1);m.update(.1,sample(20));m.update(.1,sample(30));m.update(.1,sample(45));assert.equal(m.active,null);assert.equal(results.length,1);assert.equal(c.state.cash,4250);m.update(1,sample(60));m.cancel();assert.equal(c.state.cash,4250);
});
test('recovery, timeout, teleport and wrong elevation never pay',()=>{
 for(const mode of ['cancel','timeout','teleport','height']){const c=createCareer(catalog,store()),m=createMissionEngine(c);m.start(job(),sample());if(mode==='cancel')m.cancel();if(mode==='timeout')m.update(100,sample());if(mode==='teleport')m.update(.1,sample(500));if(mode==='height')m.update(.1,sample(10,{y:20}));assert.equal(c.state.cash,2500);}
});
test('delivery requires stopping for two seconds; pause does not count',()=>{
 const c=createCareer(catalog,store()),m=createMissionEngine(c);m.start(job({type:'delivery',points:[{x:0,y:0,z:0}]}),sample());m.update(3,sample());assert.ok(m.active);m.update(0,sample(0,{speed:0}));assert.equal(m.active.hold,0);m.update(1,sample(0,{speed:0}));assert.ok(m.active);m.update(1,sample(0,{speed:0}));assert.equal(m.active,null);assert.equal(c.state.records['contract-0'].count,1);
});
test('clean driving resets on collisions and drift excludes grass and airborne spins',()=>{
 const c=createCareer(catalog,store()),m=createMissionEngine(c);m.start(job({type:'clean',points:[],goal:100}),sample());m.update(1,sample(20));assert.equal(m.active.clean,20);m.update(1,sample(30,{damage:1}));assert.equal(m.active.clean,0);m.cancel();m.start(job({type:'drift',points:[],goal:1000}),sample());m.update(1,sample(10,{slip:40,surface:'grass'}));m.update(1,sample(20,{slip:40,air:true}));assert.equal(m.active.drift,0);m.update(1,sample(30,{slip:40}));assert.equal(m.active.drift,40);
});
test('escape needs a pursuit followed by actual escape and distance',()=>{
 const c=createCareer(catalog,store()),m=createMissionEngine(c);m.start(job({type:'escape',points:[]}),sample());m.update(1,sample(100));assert.ok(m.active);m.update(1,sample(200,{wanted:1}));assert.ok(m.active);m.update(1,sample(220));assert.equal(m.active,null);assert.equal(c.state.records['contract-0'].count,1);
});
test('catalog has 24 uniquely authored, priced, ranked cars',()=>{
 const designs=require('../assets/cars/designs.json');assert.equal(catalog.length,24);assert.equal(new Set(catalog.map(c=>c.id)).size,24);
 for(const c of catalog){const d=designs.find(d=>d.id===c.id);assert.ok(d);assert.equal(c.length,d.L);assert.ok(Number.isSafeInteger(c.price)&&c.price>=0);assert.ok(c.level>=1&&c.level<=10);assert.equal(c.authored,true);}
 assert.equal(new Set(designs.map(d=>[d.L,d.W,d.H,...d.axles].join(','))).size,24);
});
