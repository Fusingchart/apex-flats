const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCareer,createMissionEngine,KEY}=require('../src/career.js');
const {createEmpire,DAY,PER_UNIT}=require('../src/business.js');
const catalog=require('../assets/cars/cars.json');
const store=()=>{const data={};return {getItem:k=>data[k],setItem:(k,v)=>data[k]=v};};
const rich=(cash,xp)=>{const s=store(),c=createCareer(catalog,s);c.state.cash=cash;c.state.xp=xp;return {s,c};};
const never=()=>1;

test('buying needs rank, cash, an office and a free slot',()=>{
 const {c}=rich(2500,0),e=createEmpire(c,catalog,never);
 assert.equal(e.buy('courier').reason,'Reach rank 3');
 c.state.xp=350*4;assert.equal(e.buy('courier').reason,'Not enough cash');
 c.state.cash=1e7;c.state.xp=350*49*49;assert.equal(e.buy('courier').ok,true);assert.equal(e.buy('courier').ok,false);
 assert.equal(e.buy('salvage').reason,'Buy an office first');
 assert.equal(e.buyOffice('office-1').ok,true);assert.equal(e.buy('salvage').ok,true);assert.equal(e.buy('import').ok,true);
 assert.equal(e.buy('club').reason,'Upgrade your office for more slots');
 const before=c.state.cash;assert.equal(e.buyOffice('office-2').ok,true);assert.equal(before-c.state.cash,600000-50000);
 assert.equal(e.buyOffice('office-1').ok,false);assert.equal(e.buy('club').ok,true);
});

test('production consumes supplies, stops when full, and survives a reload',()=>{
 const {s,c}=rich(1e6,350*9),e=createEmpire(c,catalog,never);e.buy('courier');
 const o=e.state.owned.courier;assert.equal(o.supplies,40);
 for(let i=0;i<75*3;i++)e.update(1);assert.equal(o.stock,3);assert.equal(o.supplies,40-3*PER_UNIT);
 assert.equal(e.buySupplies('courier').ok,true);assert.equal(o.supplies,100);
 for(let i=0;i<75*60;i++)e.update(1);assert.equal(o.stock,23);assert.ok(o.supplies<PER_UNIT);
 const again=createEmpire(createCareer(catalog,s),catalog,never);assert.equal(again.state.owned.courier.stock,23);
});

test('equipment speeds production and staff raises value',()=>{
 const {c}=rich(1e6,350*9),e=createEmpire(c,catalog,never);e.buy('courier');
 const base=e.unitValue('courier');e.upgrade('courier','staff');assert.equal(Math.round(e.unitValue('courier')),Math.round(base*1.3));
 e.upgrade('courier','equipment');for(let i=0;i<Math.ceil(75*.65);i++)e.update(1);assert.equal(e.state.owned.courier.stock,1);
 assert.equal(e.upgrade('courier','staff').ok,false);
});

test('sales pay for intact product and return 75% when they fail',()=>{
 const {c}=rich(1e6,350*9),e=createEmpire(c,catalog,never);e.buy('courier');e.state.owned.courier.stock=20;
 const sale=e.startSale('courier');assert.equal(e.state.owned.courier.stock,0);
 const cash=c.state.cash,r=e.finishSale(sale,true,.5);assert.equal(r.cash,Math.round(sale.value*.5));assert.equal(c.state.cash,cash+r.cash);
 e.state.owned.courier.stock=20;const lost=e.startSale('courier');assert.equal(e.finishSale(lost,false),null);assert.equal(e.state.owned.courier.stock,15);
});

test('business jobs use the mission engine pay hook and cargo integrity',()=>{
 const {c}=rich(0,0),m=createMissionEngine(c);let failed=0;
 const job={id:'biz-x',biz:true,type:'delivery',points:[{x:50,y:0,z:0}],limit:100,cargo:true,pay:a=>({cash:0,xp:0,label:String(a.integrity)}),onFail:()=>failed++};
 const smp=(x,d=0,speed=10)=>({x,z:0,y:0,speed,slip:0,surface:'asphalt',wanted:0,damage:d});
 m.start(job,smp(0));m.update(.1,smp(5,.24));assert.ok(m.active.integrity<.95&&m.active.integrity>.9);m.cancel();assert.equal(failed,1);assert.equal(c.state.cash,0);
 m.start({...job,fragile:true},smp(0));m.update(.1,smp(5,1));assert.ok(m.active);m.update(.1,smp(6,2));assert.equal(m.active,null);assert.equal(failed,2);
});

test('upkeep, unpaid shutdown, raids and milestones',()=>{
 let roll=1;const {c}=rich(200000,350*9),e=createEmpire(c,catalog,()=>roll);e.buy('courier');
 const o=e.state.owned.courier;e.update(1);assert.equal(e.state.goals.venture,true);c.state.cash=500;
 for(let i=1;i<DAY;i++)e.update(1);assert.equal(o.unpaid,true);assert.equal(e.state.day,2);
 const st=o.stock;e.update(5);assert.equal(o.stock,st);
 c.state.cash=5000;assert.equal(e.payUpkeep('courier').ok,true);assert.equal(o.unpaid,false);
 o.stock=30;roll=0;const ev=e.update(1);assert.ok(ev.some(v=>v.type==='raid'));assert.equal(e.state.raid.id,'courier');
 for(let i=0;i<240;i++)e.update(1);assert.equal(o.stock,18);assert.equal(e.state.raid,null);
 assert.equal(e.state.goals.venture,true);assert.ok(!e.state.goals.office);
});

test('older saves load with an empty empire; bad empire data is cleaned',()=>{
 const s=store();s.setItem(KEY,JSON.stringify({version:1,cash:999,xp:0,owned:['sedan'],records:{},empire:{office:'hack',owned:{courier:{stock:1e9,supplies:-4},fake:{}},stats:{sales:'x'}}}));
 const c=createCareer(catalog,s),e=createEmpire(c,catalog);
 assert.equal(e.state.office,null);assert.deepEqual(Object.keys(e.state.owned),['courier']);assert.equal(e.state.owned.courier.stock,30);assert.equal(e.state.owned.courier.supplies,0);assert.equal(e.state.stats.sales,0);
});
