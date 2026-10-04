/* Career interface, road-based event authoring and world navigation. */
window.createMissionSystem = function({city,scene,car,career,getDamage,getWanted,travel,repair,onPause}) {
  const $=id=>document.getElementById(id), money=n=>'$'+Math.round(n).toLocaleString();
  const jobs=[],types=['delivery','race','clean','drift','escape'];
  const names={
    delivery:['First Dispatch','Market Supplies','Priority Courier','Valley Logistics','Last Mile','Glass Cargo','Hospital Run','Gallery Transfer','Diplomatic Pouch','Crown Jewels'],
    race:['Town Sprint','Crossroads Cup','Valley Dash','Long Way Home','Apex Invitational','River Loop','Hillclimb Rush','Midnight Express','Grand Tour','Valley Grand Prix'],
    clean:['Easy Miles','Passenger Comfort','Smooth Operator','Precision Driver','Perfect Journey','Executive Shuttle','Chauffeur Exam','Glass of Water','Royal Escort','Zero Tolerance'],
    drift:['Loose Ends','Sideways Club','Smoke Signals','Angle Master','Drift Legend','Tandem Ghost','Canyon Carver','Tyre Wall','Sideways Saint','Drift King'],
    escape:['Lose the Tail','Out of Sight','Heatwave','Vanishing Act','Most Wanted','Ghost Protocol','Five-Alarm','Dragnet','Manhunt','Public Enemy']};
  const TIERS=10, LEVELS=[1,2,3,5,7,9,12,15,18,22];
  const nearLinks=city.links.filter(l=>l.kind!=='ramp'&&l.lanes?.[0]?.pts.length>2);
  const mid=l=>l.lanes[0].pts[Math.floor(l.lanes[0].pts.length/2)];
  const nearestLink=(x,z)=>nearLinks.reduce((best,l)=>{const d=Math.hypot(mid(l).x-x,mid(l).z-z);return d<best.d?{l,d}:best;},{l:null,d:Infinity}).l;
  const origin=nearestLink(city.start.x,city.start.z);
  const goals=city.nodes.filter(n=>n.out.length&&n.in.length);
  const thin=points=>points.filter((p,i)=>!i||Math.hypot(p.x-points[i-1].x,p.z-points[i-1].z)>25);
  // a deterministic chain of legs: each leg heads for a junction at least `range` metres from where it began
  function chain(start,legs,range,seed){
    let link=start,points=[],ends=[],rnd=seed;
    const next=()=>(rnd=(rnd*16807)%2147483647)/2147483647;
    for(let k=0;k<legs;k++){
      const from=mid(link),far=goals.filter(n=>{const d=Math.hypot(n.x-from.x,n.z-from.z);return d>range&&d<range*1.8;});
      let path=null;
      for(let t=0;t<12&&!path&&far.length;t++){const p=city.route(link,far[Math.floor(next()*far.length)]);if(p?.length>=2)path=p;}
      if(!path)break;
      points.push(...path.map(mid).map(p=>({x:p.x,y:p.y||0,z:p.z})));ends.push(points[points.length-1]);link=path[path.length-1];
    }
    return {points:thin(points.length?points:[mid(start)]),ends,last:link};
  }
  function length(route,from){let n=0,last=from;for(const p of route){n+=Math.hypot(p.x-last.x,p.z-last.z);last=p;}return n;}
  const routes=Array.from({length:TIERS},(_,t)=>chain(origin,1+Math.floor(t/3),350+t*170,7919*(t+1)));
  for(let i=0;i<TIERS*5;i++) {
    const type=types[i%5],tier=Math.floor(i/5),R=routes[tier],route=R.points;
    const points=type==='race'?route:type==='delivery'?(R.ends.length>1?R.ends:[route[Math.floor((route.length-1)/2)],route[route.length-1]]).filter((p,j,a)=>!j||p!==a[j-1]):[];
    const len=length(route,city.start),pace=1+tier*.09; // later tiers expect a faster car and cleaner lines
    const limit=Math.ceil(type==='race'?(70+len/11)/pace:type==='delivery'?(130+len/9)/pace+points.length*4:type==='escape'?200+tier*25:170+tier*40);
    jobs.push({id:'contract-'+i,name:names[type][tier],type,level:LEVELS[tier],limit,cash:Math.round(1500*1.42**tier/100)*100+(type==='escape'?800*(tier+1):0),xp:150+40*tier*tier+60*tier,
      goal:type==='drift'?600+tier*tier*90+tier*400:500+tier*500,points,route,start:city.start,tier,cargo:type==='delivery'&&tier>=3,fragile:type==='delivery'&&tier>=6,
      pursuit:type==='escape'?Math.min(5,1+Math.floor(tier/2)):0});
  }
  const ring=new THREE.Mesh(new THREE.TorusGeometry(11,.22,8,64),new THREE.MeshBasicMaterial({color:0x53e4c1,depthTest:false,transparent:true,opacity:.8}));ring.rotation.x=Math.PI/2;ring.renderOrder=10;
  const beam=new THREE.Mesh(new THREE.CylinderGeometry(.5,.5,35,12),new THREE.MeshBasicMaterial({color:0x53e4c1,transparent:true,opacity:.24,depthWrite:false}));scene.add(ring,beam);ring.visible=beam.visible=false;
  let lastResult=null,filter='all',uiClock=0;
  const engine=createMissionEngine(career,result=>{lastResult=result;ring.visible=beam.visible=false;renderResult();refresh();});
  function rules(j){if(j.rules)return j.rules;return j.type==='delivery'?'Stop inside each green zone for 2 seconds.'+(j.fragile?' Fragile cargo: heavy crashes destroy it.':j.cargo?' Crashes damage the cargo and cut the pay.':''):j.type==='race'?'Pass every checkpoint in order before time runs out.':j.type==='clean'?`Drive ${j.goal} m on asphalt at 18–108 km/h. Collisions reset the clean distance.`:j.type==='drift'?`Score ${j.goal} drift points on asphalt. Keep moving and hold a controlled slide.`:'Lose the police after the pursuit begins. Drive at least 150 m; getting busted fails the job.';}
  function refresh(){
    $('career-cash').textContent=money(career.state.cash);$('career-rank').textContent=`RANK ${career.level} · ${career.state.xp.toLocaleString()} XP`;
    $('career-owned').textContent=`${career.state.owned.length} / 24 cars`+(api.status?' · '+api.status():'');
    $('save-status').textContent=career.saveError?'Progress could not be saved in this browser.':'Progress saves automatically in this browser.';
    $('board-balance').textContent=`${money(career.state.cash)} · Rank ${career.level} · ${Object.keys(career.state.records).length} / ${jobs.length} completed`;
  }
  function renderBoard(){
    refresh();$('contract-list').replaceChildren();
    for(const j of jobs.filter(j=>filter==='all'||j.type===filter)){
      const record=career.state.records[j.id],locked=career.level<j.level,b=document.createElement('article');b.className='contract-card';
      b.innerHTML=`<div class="job-meta">${j.type.toUpperCase()} <span>${record?record.medal.toUpperCase()+' · '+record.count+' clears':'NEW CONTRACT'}</span></div><h3>${j.name}</h3><p>${rules(j)}</p><div class="job-pay">${money(j.cash)} <small>+ ${j.xp} XP</small></div><div class="job-detail">${Math.floor(j.limit/60)}:${String(j.limit%60).padStart(2,'0')} limit · Rank ${j.level}${record?' · Best '+record.best.toFixed(1)+'s':' · +50% cash on first clear'}</div>`;
      const btn=document.createElement('button');btn.textContent=locked?`Unlock at rank ${j.level}`:engine.active?'Contract in progress':'Travel & start';btn.disabled=locked||!!engine.active;btn.onclick=()=>begin(j);b.append(btn);$('contract-list').append(b);
    }
    $('abandon-job').hidden=!engine.active;
  }
  function toggle(force){const open=force??$('mission-board').hidden;if(open){$('garage').hidden=true;renderBoard();} $('mission-board').hidden=!open;onPause();if(open)$('close-missions').focus();}
  function begin(job){
    if(engine.active||career.level<(job.level||1))return false;
    lastResult=null;$('mission-result').hidden=true;if(job.start){travel(job.start);repair();}
    const r=engine.start(job,sample());if(!r.ok)return false;
    job.onStart?.();
    if(job.pursuit)api.onPursuit?.(job.pursuit,job);
    toggle(false);refresh();return true;
  }
  function renderResult(){
    const r=lastResult;if(!r)return;
    $('mission-result').hidden=false;$('result-title').textContent=r.ok?'CONTRACT COMPLETE':'CONTRACT ENDED';
    $('result-name').textContent=r.job.name;$('result-reason').textContent=r.ok?(r.reward.label||`${r.reward.medal.toUpperCase()} · ${r.elapsed.toFixed(1)}s${r.reward.first?' · First-clear bonus':''}`):r.reason;$('result-retry').hidden=!!r.job.biz;
    $('result-pay').textContent=r.ok?`+${money(r.reward.cash)} / +${r.reward.xp} XP${r.reward.rankUp?' · RANK UP!':''}`:(r.job.failText||'No entry fee. Try again when you’re ready.');
    onPause();
  }
  function sample(){return {x:car.x,z:car.z,y:car.y,speed:Math.hypot(car.vx,car.vz),slip:car.slipDeg,air:car.air,surface:car.surface,damage:getDamage(),wanted:getWanted()};}
  function update(dt){
    engine.update(dt,sample());uiClock+=dt;
    const a=engine.active,p=a?.job.points[a.stage];ring.visible=beam.visible=!!p;
    if(p){ring.position.set(p.x,p.y+.18,p.z);beam.position.set(p.x,p.y+17.5,p.z);ring.scale.setScalar(1+.025*Math.sin(uiClock*4));}
    $('active-job').hidden=!a;
    if(a){
      $('job-name').textContent=a.job.name;
      const remain=Math.max(0,a.job.limit-a.elapsed);$('job-time').textContent=`${Math.floor(remain/60)}:${String(Math.floor(remain%60)).padStart(2,'0')}`;
      $('job-time').classList.toggle('urgent',remain<20);
      let progress=a.job.type==='clean'?`${Math.floor(a.clean)} / ${a.job.goal} m clean`:a.job.type==='drift'?`${Math.floor(a.drift)} / ${a.job.goal} drift points`:a.job.type==='escape'?'Lose the wanted stars · stay moving':`${a.stage+1} / ${a.job.points.length} ${a.job.type==='delivery'?'stops':'checkpoints'}`;
      if(a.job.cargo)progress+=` · Cargo ${Math.round(a.integrity*100)}%`;
      $('job-progress').textContent=progress;
      $('job-target').textContent=p?`${Math.round(Math.hypot(p.x-car.x,p.z-car.z))} m · ${a.job.type==='delivery'?(a.hold>0?'Unloading… '+Math.ceil(2-a.hold)+'s':'Stop in the green zone'):'Follow the green marker'}`:rules(a.job);
      if(p){const angle=Math.atan2(p.x-car.x,p.z-car.z)-car.h;$('job-arrow').style.transform=`rotate(${angle}rad)`;$('job-arrow').hidden=false;}else $('job-arrow').hidden=true;
    }
  }
  function drawMap(g,X,Y){const a=engine.active;if(!a?.job.points.length)return;g.save();g.strokeStyle='#53e4c1';g.fillStyle='#53e4c1';g.lineWidth=2;g.setLineDash([5,4]);g.beginPath();g.moveTo(X(car.x,car.z),Y(car.x,car.z));for(const p of a.job.points.slice(a.stage))g.lineTo(X(p.x,p.z),Y(p.x,p.z));g.stroke();g.setLineDash([]);const p=a.job.points[a.stage];g.beginPath();g.arc(X(p.x,p.z),Y(p.x,p.z),6,0,Math.PI*2);g.fill();g.restore();}
  $('open-missions').onclick=()=>toggle();$('close-missions').onclick=()=>toggle(false);
  $('mission-filter').onchange=e=>{filter=e.target.value;renderBoard();};
  $('abandon-job').onclick=()=>{toggle(false);engine.cancel();};
  $('result-close').onclick=()=>{$('mission-result').hidden=true;onPause();};
  $('result-retry').onclick=()=>begin(lastResult.job);
  $('result-board').onclick=()=>{$('mission-result').hidden=true;toggle(true);};
  const api={engine,jobs,update,toggle,refresh,drawMap,begin,chain,status:null,get target(){return engine.active?.job.points[engine.active.stage];},get paused(){return !$('mission-board').hidden||!$('mission-result').hidden;},onPursuit:null};
  refresh();return api;
};
