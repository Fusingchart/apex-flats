/* Local career ledger and deterministic contract rules. No renderer or DOM dependencies. */
(function(root) {
'use strict';
const KEY = 'apex.career.v1';
const integer = (n, fallback=0) => Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 100000000) : fallback;
const levelOf = xp => Math.min(10, 1 + Math.floor(Math.sqrt(xp / 350)));
function createCareer(catalog, storage) {
  const starter = ['sedan','metro'];
  const fresh = () => ({version:1,cash:2500,xp:0,owned:[...starter],selected:'sedan',records:{},totalEarned:0});
  let state=fresh(), saveError=false;
  try {
    const raw=JSON.parse(storage?.getItem(KEY)||'null');
    if(raw?.version===1) {
      state.cash=integer(raw.cash,2500);state.xp=integer(raw.xp);state.totalEarned=integer(raw.totalEarned);
      state.owned=[...new Set([...starter,...(Array.isArray(raw.owned)?raw.owned:[]).filter(id=>catalog.some(c=>c.id===id))])];
      state.selected=state.owned.includes(raw.selected)?raw.selected:'sedan';
      if(raw.records && typeof raw.records==='object') for(const [id,r] of Object.entries(raw.records)) {
        if(!/^contract-\d+$/.test(id)||!r||typeof r!=='object')continue;
        state.records[id]={count:integer(r.count),best:Number.isFinite(r.best)&&r.best>0?r.best:0,medal:['bronze','silver','gold'].includes(r.medal)?r.medal:'bronze'};
      }
    }
  }catch(e){saveError=true;}
  function save(){try{storage?.setItem(KEY,JSON.stringify(state));saveError=!storage;}catch(e){saveError=true;}}
  function purchase(id){
    const c=catalog.find(c=>c.id===id);if(!c)return {ok:false,reason:'Unknown car'};
    if(state.owned.includes(id))return {ok:false,reason:'Already owned'};
    if(levelOf(state.xp)<c.level)return {ok:false,reason:`Reach rank ${c.level}`};
    if(state.cash<c.price)return {ok:false,reason:'Earn more cash with contracts'};
    state.cash-=c.price;state.owned.push(id);save();return {ok:true};
  }
  function select(id){if(!state.owned.includes(id))return false;state.selected=id;save();return true;}
  function reward(job,seconds){
    const old=state.records[job.id],first=!old?.count;
    const medal=seconds<=job.limit*.55?'gold':seconds<=job.limit*.78?'silver':'bronze';
    const bonus=medal==='gold'?1.25:medal==='silver'?1.1:1;
    const cash=Math.round(job.cash*bonus)+(first?Math.round(job.cash*.5):0),xp=job.xp+(first?100:0);
    const oldLevel=levelOf(state.xp);state.cash+=cash;state.xp+=xp;state.totalEarned+=cash;
    const tiers=['bronze','silver','gold'];state.records[job.id]={count:(old?.count||0)+1,best:Math.min(old?.best||Infinity,seconds),medal:tiers[Math.max(tiers.indexOf(old?.medal),tiers.indexOf(medal))]};save();
    return {cash,xp,medal,first,rankUp:levelOf(state.xp)>oldLevel};
  }
  function fine(amount){const paid=Math.min(state.cash,Math.max(0,Math.round(Number.isFinite(amount)?amount:0)));state.cash-=paid;save();return paid;}
  return {get state(){return state;},get level(){return levelOf(state.xp);},get saveError(){return saveError;},save,purchase,select,reward,fine};
}
function createMissionEngine(career,onResult=()=>{}) {
  let active=null;
  function finish(ok,reason){if(!active)return null;const a=active;active=null;const reward=ok?career.reward(a.job,Math.max(.01,a.elapsed)):null;const result={ok,reason,job:a.job,elapsed:a.elapsed,reward};onResult(result);return result;}
  function start(job,sample){
    if(active)return {ok:false,reason:'Finish or abandon your current contract'};
    if(career.level<job.level)return {ok:false,reason:`Reach rank ${job.level}`};
    active={job,elapsed:0,stage:0,hold:0,distance:0,drift:0,clean:0,sawWanted:false,last:{x:sample.x,z:sample.z},lastDamage:sample.damage||0};return {ok:true};
  }
  function update(dt,s){
    const a=active;if(!a||!(dt>0)||!Number.isFinite(dt))return;
    a.elapsed+=dt;if(a.elapsed>=a.job.limit)return finish(false,'Time ran out');
    const moved=Math.hypot(s.x-a.last.x,s.z-a.last.z);a.last={x:s.x,z:s.z};
    if(!Number.isFinite(moved)||moved>Math.max(10,dt*150))return finish(false,'Run interrupted by relocation');
    a.distance+=moved;
    const hit=(s.damage||0)>a.lastDamage+.002;a.lastDamage=s.damage||0;
    if(a.job.type==='clean'&&hit){a.clean=0;}
    else if(a.job.type==='clean'&&s.speed>5&&s.speed<30&&s.surface==='asphalt')a.clean+=moved;
    if(a.job.type==='drift'&&s.speed>8&&s.speed<65&&Math.abs(s.slip)>15&&Math.abs(s.slip)<80&&s.surface==='asphalt'&&!s.air&&!hit)a.drift+=dt*Math.min(Math.abs(s.slip),55)*s.speed/10;
    if(s.wanted>0)a.sawWanted=true;
    if(a.job.type==='escape'&&a.sawWanted&&!s.wanted&&a.distance>150)return finish(true,'Pursuit escaped');
    if(a.job.type==='clean'&&a.clean>=a.job.goal)return finish(true,'Clean driving target reached');
    if(a.job.type==='drift'&&a.drift>=a.job.goal)return finish(true,'Drift target reached');
    const target=a.job.points?.[a.stage];
    if(target){
      const near=Math.hypot(target.x-s.x,target.z-s.z)<(a.job.type==='delivery'?12:18)&&Math.abs(target.y-s.y)<7;
      if(a.job.type==='delivery')a.hold=near&&s.speed<1.5?a.hold+dt:0;
      if(near&&(a.job.type!=='delivery'||a.hold>=2)) {a.stage++;a.hold=0;if(a.stage===a.job.points.length)return finish(true,'Route complete');}
    }
  }
  return {get active(){return active;},start,update,cancel:(reason='Contract abandoned')=>finish(false,reason)};
}
const api={KEY,levelOf,createCareer,createMissionEngine};
if(typeof module!=='undefined')module.exports=api;else Object.assign(root,api);
})(typeof window!=='undefined'?window:globalThis);
