/* Apex Holdings: the CEO layer. Offices, production businesses, a nightclub, raids, upkeep and milestones.
   Pure rules on top of the career ledger (state lives in career.state.empire and saves with it). No DOM. */
(function(root) {
'use strict';
const DAY = 720; // one business day = 12 minutes of play
const OFFICES = [
  {id:'office-1',name:'Ashby Plaza Suite',price:100000,level:5,slots:3,bonus:.05,upkeep:2000},
  {id:'office-2',name:'Riverside Tower, 31st Floor',price:600000,level:12,slots:5,bonus:.12,upkeep:5000},
  {id:'office-3',name:'Summit Penthouse',price:2000000,level:22,slots:6,bonus:.2,upkeep:10000},
];
// unit: sale value per unit; secs: production time per unit; cap: storage; supplyCost: price of a full 100% resupply
const BUSINESSES = [
  {id:'courier',name:'Valley Courier Depot',kind:'production',product:'Parcels',price:45000,level:3,unit:1200,cap:30,secs:75,supplyCost:9000,upkeep:1000,raid:.15,office:false,dist:550,angle:.4},
  {id:'salvage',name:'Southbank Salvage',kind:'production',product:'Auto parts',price:180000,level:7,unit:2600,cap:35,secs:90,supplyCost:22000,upkeep:3000,raid:.25,office:true,dist:1100,angle:2.6},
  {id:'import',name:'Harbour Import / Export',kind:'production',product:'Imported cars',price:420000,level:11,unit:6000,cap:25,secs:140,supplyCost:48000,upkeep:6000,raid:.3,office:true,dist:1600,angle:4.4},
  {id:'club',name:'Club Meridian',kind:'venue',product:'Nightlife',price:750000,level:15,income:40000,safe:100000,upkeep:8000,raid:.2,office:true,dist:900,angle:5.6},
  {id:'freight',name:'Ashby Freight Hub',kind:'production',product:'Freight',price:1400000,level:20,unit:11000,cap:40,secs:120,supplyCost:140000,upkeep:12000,raid:.35,office:true,dist:2200,angle:1.5},
  {id:'lab',name:'Apex Prototype Labs',kind:'production',product:'Prototypes',price:3000000,level:26,unit:28000,cap:30,secs:160,supplyCost:320000,upkeep:20000,raid:.4,office:true,dist:2800,angle:3.4},
];
const UPGRADES = {
  production:{equipment:{name:'Equipment',cost:.5,desc:'Produces 35% faster'},staff:{name:'Staff',cost:.4,desc:'Product sells for 30% more'},security:{name:'Security',cost:.3,desc:'Raids 80% less likely'}},
  venue:{equipment:{name:'Sound system',cost:.5,desc:'Popularity fades 40% slower'},staff:{name:'Management',cost:.4,desc:'Earns 40% more'},security:{name:'Security',cost:.3,desc:'Raids 80% less likely'}},
};
const PER_UNIT = 5; // supplies used per unit (a full resupply makes 20 units)
const GOALS = [
  {id:'venture',name:'First Venture',desc:'Own a business',cash:10000,test:(e)=>owned(e).length>=1},
  {id:'office',name:'Corner Office',desc:'Register Apex Holdings by buying an office',cash:25000,test:e=>!!e.office},
  {id:'supply',name:'Supply Chain',desc:'Complete 3 supply runs',cash:20000,test:e=>e.stats.sources>=3},
  {id:'sixfig',name:'Six Figures',desc:'Sell $100,000 of product',cash:30000,test:e=>e.stats.sales>=100000},
  {id:'loaded',name:'Fully Loaded',desc:'Buy all three upgrades for one business',cash:75000,test:e=>owned(e).some(id=>Object.values(e.owned[id].up).every(Boolean))},
  {id:'defender',name:'Hold the Line',desc:'Defend 3 raids',cash:60000,test:e=>e.stats.defends>=3},
  {id:'mogul',name:'Mogul',desc:'Own 4 businesses',cash:150000,test:e=>owned(e).length>=4},
  {id:'million',name:'Millionaire',desc:'Sell $1,000,000 of product',cash:250000,test:e=>e.stats.sales>=1000000},
  {id:'penthouse',name:'Top Floor',desc:'Own the Summit Penthouse',cash:300000,test:e=>e.office==='office-3'},
  {id:'empire',name:'Empire',desc:'Own all six businesses',cash:500000,test:e=>owned(e).length>=6},
  {id:'tycoon',name:'Valley Tycoon',desc:'Reach a $20,000,000 net worth',cash:1000000,test:(e,w)=>w>=20000000},
];
const owned = e => Object.keys(e.owned);
const num = (n,lo,hi,d=0) => Number.isFinite(n) ? Math.min(hi,Math.max(lo,n)) : d;

function fresh(){return {office:null,owned:{},clock:0,day:1,raid:null,goals:{},stats:{sales:0,sells:0,sources:0,defends:0,raidsLost:0,invested:0}};}
function sanitize(raw){
  const e=fresh();if(!raw||typeof raw!=='object')return e;
  if(OFFICES.some(o=>o.id===raw.office))e.office=raw.office;
  e.clock=num(raw.clock,0,DAY);e.day=Math.floor(num(raw.day,1,1e6,1));
  for(const b of BUSINESSES){const r=raw.owned?.[b.id];if(!r||typeof r!=='object')continue;
    e.owned[b.id]={stock:num(r.stock,0,b.cap||0),supplies:num(r.supplies,0,100),progress:num(r.progress,0,1e4),pop:num(r.pop,0,100,60),safe:num(r.safe,0,b.safe||0),unpaid:!!r.unpaid,
      up:{equipment:!!r.up?.equipment,staff:!!r.up?.staff,security:!!r.up?.security}};}
  if(raw.raid&&e.owned[raw.raid.id])e.raid={id:raw.raid.id,t:num(raw.raid.t,0,600,240)};
  for(const g of GOALS)if(raw.goals?.[g.id])e.goals[g.id]=true;
  for(const k of Object.keys(e.stats))e.stats[k]=num(raw.stats?.[k],0,1e12);
  return e;
}

function createEmpire(career, cars=[], rng=Math.random) {
  const st=career.state;st.empire=sanitize(st.empire);
  const E=()=>st.empire, biz=id=>BUSINESSES.find(b=>b.id===id), office=()=>OFFICES.find(o=>o.id===E().office);
  const slots=()=>office()?.slots??1;
  let saveT=0;
  function spend(n){if(st.cash<n)return false;st.cash-=n;E().stats.invested+=n;return true;}
  function netWorth(){
    const e=E();let w=st.cash+(office()?.price||0);
    for(const id of owned(e)){const b=biz(id),o=e.owned[id];w+=b.price;for(const k in o.up)if(o.up[k])w+=b.price*UPGRADES[b.kind][k].cost;w+=saleValue(id)*.5+(o.safe||0);}
    for(const id of st.owned){const c=cars.find(c=>c.id===id);if(c)w+=c.price;}
    return Math.round(w);
  }
  function check(id){
    const b=biz(id),e=E();if(!b)return 'Unknown business';
    if(e.owned[id])return 'Already owned';
    if(career.level<b.level)return `Reach rank ${b.level}`;
    if(b.office&&!e.office)return 'Buy an office first';
    if(owned(e).length>=slots())return 'Upgrade your office for more slots';
    if(st.cash<b.price)return 'Not enough cash';
    return null;
  }
  function buy(id){
    const why=check(id);if(why)return {ok:false,reason:why};
    const b=biz(id);spend(b.price);E().owned[id]={stock:0,supplies:b.kind==='production'?40:0,progress:0,pop:b.kind==='venue'?60:0,safe:0,unpaid:false,up:{equipment:false,staff:false,security:false}};
    career.save();return {ok:true};
  }
  function officeCheck(id){
    const o=OFFICES.find(o=>o.id===id),cur=office();if(!o)return 'Unknown office';
    if(cur&&OFFICES.indexOf(cur)>=OFFICES.indexOf(o))return 'Already owned';
    if(career.level<o.level)return `Reach rank ${o.level}`;
    if(st.cash<o.price-(cur?cur.price/2:0))return 'Not enough cash';
    return null;
  }
  // moving up trades the old office in at half price
  function buyOffice(id){const why=officeCheck(id);if(why)return {ok:false,reason:why};const o=OFFICES.find(o=>o.id===id),cur=office();spend(o.price-(cur?cur.price/2:0));E().office=id;career.save();return {ok:true};}
  function upgradeCost(id,k){const b=biz(id);return Math.round(b.price*UPGRADES[b.kind][k].cost/1000)*1000;}
  function upgrade(id,k){
    const o=E().owned[id];if(!o||!(k in o.up))return {ok:false,reason:'Not available'};if(o.up[k])return {ok:false,reason:'Already installed'};
    if(!spend(upgradeCost(id,k)))return {ok:false,reason:'Not enough cash'};o.up[k]=true;career.save();return {ok:true};
  }
  function supplyCost(id){const b=biz(id),o=E().owned[id];return o&&b.kind==='production'?Math.round(b.supplyCost*(100-o.supplies)/100/100)*100:0;}
  function buySupplies(id){const c=supplyCost(id),o=E().owned[id];if(!o||!c)return {ok:false,reason:'Supplies are full'};if(!spend(c))return {ok:false,reason:'Not enough cash'};o.supplies=100;career.save();return {ok:true,cost:c};}
  function addSupplies(id,n){const o=E().owned[id];if(!o)return;o.supplies=Math.min(100,o.supplies+n);E().stats.sources++;career.save();}
  function unitValue(id){const b=biz(id),o=E().owned[id];return b.unit*(o?.up.staff?1.3:1)*(1+(office()?.bonus||0));}
  function saleValue(id){const b=biz(id),o=E().owned[id];return o&&b.kind==='production'?Math.round(o.stock*unitValue(id)):0;}
  function rate(id){const b=biz(id),o=E().owned[id];return b.secs*(o.up.equipment?.65:1);}
  function timeToFull(id){const b=biz(id),o=E().owned[id];if(!o||b.kind!=='production')return 0;const units=Math.min(b.cap-o.stock,Math.floor(o.supplies/PER_UNIT));return units>0?units*rate(id)-o.progress:0;}
  // a sale takes the whole stock out of the building; finishing pays for what survived, failing loses a quarter of it
  function startSale(id){const o=E().owned[id];if(!o||o.stock<1)return null;const sale={id,units:o.stock,value:saleValue(id)};o.stock=0;o.progress=0;career.save();return sale;}
  function finishSale(sale,ok,integrity=1){
    const o=E().owned[sale.id];
    if(!ok){if(o)o.stock=Math.min(biz(sale.id).cap,o.stock+Math.floor(sale.units*.75));career.save();return null;}
    const cash=Math.round(sale.value*Math.max(.25,num(integrity,0,1,1))),xp=Math.min(9000,Math.round(400+cash/40));
    E().stats.sales+=cash;E().stats.sells++;const r=career.earn(cash,xp);return {...r,cash,xp};
  }
  function collect(id){const o=E().owned[id];if(!o||!(o.safe>=1))return 0;const n=Math.floor(o.safe);o.safe=0;career.earn(n,0);E().stats.sales+=n;return n;}
  function promote(id){const o=E().owned[id];if(o)o.pop=Math.min(100,o.pop+50);career.save();}
  function payUpkeep(id){const o=E().owned[id];if(!o?.unpaid)return {ok:false,reason:'Nothing owed'};if(!spend(biz(id).upkeep))return {ok:false,reason:'Not enough cash'};o.unpaid=false;career.save();return {ok:true};}
  function defended(){const r=E().raid;if(!r)return false;E().raid=null;E().stats.defends++;career.save();return true;}
  function claimGoals(){
    const e=E(),w=netWorth(),out=[];
    for(const g of GOALS)if(!e.goals[g.id]&&g.test(e,w)){e.goals[g.id]=true;career.earn(g.cash,Math.round(g.cash/50));out.push({type:'goal',goal:g});}
    return out;
  }
  // business time passes while you play (not while the tab is closed)
  function update(dt){
    if(!(dt>0)||!Number.isFinite(dt))return [];
    dt=Math.min(dt,5);const e=E(),ev=[];
    for(const id of owned(e)){
      const b=biz(id),o=e.owned[id];if(o.unpaid)continue;
      if(b.kind==='production'){
        if(o.stock>=b.cap||o.supplies<PER_UNIT){o.progress=0;continue;}
        o.progress+=dt;
        while(o.progress>=rate(id)&&o.stock<b.cap&&o.supplies>=PER_UNIT){o.progress-=rate(id);o.stock++;o.supplies-=PER_UNIT;if(o.stock===b.cap)ev.push({type:'full',id});else if(o.supplies<PER_UNIT)ev.push({type:'empty',id});}
      }else{
        o.pop=Math.max(0,o.pop-dt*100/(2*DAY)*(o.up.equipment?.6:1));
        o.safe=Math.min(b.safe,o.safe+b.income*(o.up.staff?1.4:1)*(o.pop/100)*dt/DAY);
      }
    }
    // raids: more likely the more there is to take
    if(e.raid){e.raid.t-=dt;if(e.raid.t<=0){const o=e.owned[e.raid.id],b=biz(e.raid.id);let lost=0;
      if(o){if(b.kind==='production'){lost=Math.ceil(o.stock*.4);o.stock-=lost;}else{lost=Math.round(o.safe*.5);o.safe-=lost;}}
      ev.push({type:'raidLost',id:e.raid.id,lost});e.raid=null;e.stats.raidsLost++;}}
    else for(const id of owned(e)){const b=biz(id),o=e.owned[id],load=b.kind==='production'?o.stock/b.cap:o.safe/b.safe;
      if(load<.35)continue;
      if(rng()<b.raid*(o.up.security?.2:1)*load*dt/DAY){e.raid={id,t:240};ev.push({type:'raid',id});break;}}
    e.clock+=dt;
    if(e.clock>=DAY){e.clock-=DAY;e.day++;let bill=office()?.upkeep||0;
      if(bill)st.cash-=Math.min(st.cash,bill);
      for(const id of owned(e)){const o=e.owned[id],c=biz(id).upkeep;if(o.unpaid)continue;if(st.cash>=c){st.cash-=c;bill+=c;}else{o.unpaid=true;ev.push({type:'unpaid',id});}}
      ev.push({type:'day',day:e.day,bill});}
    ev.push(...claimGoals());
    saveT+=dt;if(ev.length||saveT>10){saveT=0;career.save();}
    return ev;
  }
  return {get state(){return E();},biz,office,slots,check,buy,officeCheck,buyOffice,upgrade,upgradeCost,supplyCost,buySupplies,addSupplies,
    saleValue,unitValue,timeToFull,startSale,finishSale,collect,promote,payUpkeep,defended,netWorth,update,claimGoals};
}
const api={DAY,OFFICES,BUSINESSES,UPGRADES,GOALS,PER_UNIT,createEmpire,sanitizeEmpire:sanitize};
if(typeof module!=='undefined')module.exports=api;else Object.assign(root,api);
})(typeof window!=='undefined'?window:globalThis);
