/* Career interface, road-based event authoring and world navigation. */
window.createMissionSystem = function({city,scene,car,career,getDamage,getWanted,travel,repair,onPause}) {
  const $=id=>document.getElementById(id), money=n=>'$'+Math.round(n).toLocaleString();
  const jobs=[],types=['delivery','race','clean','drift','escape'];
  const names={delivery:['First Dispatch','Market Supplies','Priority Courier','Valley Logistics','Last Mile'],race:['Town Sprint','Crossroads Cup','Valley Dash','Long Way Home','Apex Invitational'],clean:['Easy Miles','Passenger Comfort','Smooth Operator','Precision Driver','Perfect Journey'],drift:['Loose Ends','Sideways Club','Smoke Signals','Angle Master','Drift Legend'],escape:['Lose the Tail','Out of Sight','Heatwave','Vanishing Act','Most Wanted']};
  const nearLinks=city.links.filter(l=>l.kind!=='ramp'&&l.lanes?.[0]?.pts.length>2);
  const mid=l=>l.lanes[0].pts[Math.floor(l.lanes[0].pts.length/2)];
  const origin=nearLinks.reduce((best,l)=>Math.hypot(mid(l).x-city.start.x,mid(l).z-city.start.z)<Math.hypot(mid(best).x-city.start.x,mid(best).z-city.start.z)?l:best);
  const goals=city.nodes.filter(n=>n.out.length&&n.in.length).sort((a,b)=>Math.hypot(a.x-city.start.x,a.z-city.start.z)-Math.hypot(b.x-city.start.x,b.z-city.start.z));
  function routeFor(tier) {
    const range=350+tier*350;
    for(const n of goals.filter(n=>Math.hypot(n.x-city.start.x,n.z-city.start.z)>range)) {
      const path=city.route(origin,n);
      if(path?.length>=2) {
        const points=path.map(mid).map(p=>({x:p.x,y:p.y||0,z:p.z}));
        return points.filter((p,i)=>!i||Math.hypot(p.x-points[i-1].x,p.z-points[i-1].z)>25);
      }
    }
    return [mid(origin)];
  }
  const routes=Array.from({length:5},(_,i)=>routeFor(i));
  for(let i=0;i<25;i++) {
    const type=types[i%5],tier=Math.floor(i/5),route=routes[tier],points=type==='race'?route:type==='delivery'?[route[Math.floor((route.length-1)/2)],route[route.length-1]].filter((p,j,a)=>!j||p!==a[j-1]):[];
    let length=0,last=city.start;for(const p of route){length+=Math.hypot(p.x-last.x,p.z-last.z);last=p;}
    const limit=type==='race'?Math.ceil(80+length/11):type==='delivery'?Math.ceil(140+length/9):type==='escape'?180+tier*35:180+tier*45;
    jobs.push({id:'contract-'+i,name:names[type][tier],type,level:tier+1,limit,cash:1200+tier*1800+(type==='escape'?800:0),xp:120+tier*90,goal:type==='drift'?500+tier*600:450+tier*450,points,route,start:city.start,tier});
  }
  const ring=new THREE.Mesh(new THREE.TorusGeometry(11,.22,8,64),new THREE.MeshBasicMaterial({color:0x53e4c1,depthTest:false,transparent:true,opacity:.8}));ring.rotation.x=Math.PI/2;ring.renderOrder=10;
  const beam=new THREE.Mesh(new THREE.CylinderGeometry(.5,.5,35,12),new THREE.MeshBasicMaterial({color:0x53e4c1,transparent:true,opacity:.24,depthWrite:false}));scene.add(ring,beam);ring.visible=beam.visible=false;
  let lastResult=null,filter='all',uiClock=0;
  const engine=createMissionEngine(career,result=>{lastResult=result;ring.visible=beam.visible=false;renderResult();refresh();});
  function rules(j){return j.type==='delivery'?'Stop inside each green zone for 2 seconds.':j.type==='race'?'Pass every checkpoint in order before time runs out.':j.type==='clean'?`Drive ${j.goal} m on asphalt at 18–108 km/h. Collisions reset the clean distance.`:j.type==='drift'?`Score ${j.goal} drift points on asphalt. Keep moving and hold a controlled slide.`:'Lose the police after the pursuit begins. Drive at least 150 m; getting busted fails the job.';}
  function refresh(){
    $('career-cash').textContent=money(career.state.cash);$('career-rank').textContent=`RANK ${career.level} · ${career.state.xp.toLocaleString()} XP`;
    $('career-owned').textContent=`${career.state.owned.length} / 24 cars`;
    $('save-status').textContent=career.saveError?'Progress could not be saved in this browser.':'Progress saves automatically in this browser.';
    $('board-balance').textContent=`${money(career.state.cash)} · Rank ${career.level} · ${Object.keys(career.state.records).length} / 25 completed`;
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
    if(engine.active||career.level<job.level)return false;
    lastResult=null;$('mission-result').hidden=true;travel(job.start);repair();
    const r=engine.start(job,sample());if(!r.ok)return false;
    if(job.type==='escape')api.onPursuit?.(Math.min(3,1+Math.floor(job.tier/2)));
    toggle(false);refresh();return true;
  }
  function renderResult(){
    const r=lastResult;if(!r)return;
    $('mission-result').hidden=false;$('result-title').textContent=r.ok?'CONTRACT COMPLETE':'CONTRACT ENDED';
    $('result-name').textContent=r.job.name;$('result-reason').textContent=r.ok?`${r.reward.medal.toUpperCase()} · ${r.elapsed.toFixed(1)}s${r.reward.first?' · First-clear bonus':''}`:r.reason;
    $('result-pay').textContent=r.ok?`+${money(r.reward.cash)} / +${r.reward.xp} XP${r.reward.rankUp?' · RANK UP!':''}`:'No entry fee. Try again when you’re ready.';
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
      const progress=a.job.type==='clean'?`${Math.floor(a.clean)} / ${a.job.goal} m clean`:a.job.type==='drift'?`${Math.floor(a.drift)} / ${a.job.goal} drift points`:a.job.type==='escape'?'Lose the wanted stars · stay moving':`${a.stage+1} / ${a.job.points.length} ${a.job.type==='delivery'?'stops':'checkpoints'}`;
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
  const api={engine,jobs,update,toggle,refresh,drawMap,begin,get target(){return engine.active?.job.points[engine.active.stage];},get paused(){return !$('mission-board').hidden||!$('mission-result').hidden;},onPursuit:null};
  refresh();return api;
};
