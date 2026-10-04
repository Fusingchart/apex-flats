/* Apex Holdings interface: property markers, the CEO panel (B), business jobs and alerts. Rules live in business.js. */
window.createEmpireSystem = function({city,scene,car,career,missions,catalog,travel,onPause}) {
  const $=id=>document.getElementById(id), money=n=>'$'+Math.round(n).toLocaleString(), short=n=>n>=1e6?'$'+(n/1e6).toFixed(n>=1e7?1:2)+'M':n>=1e4?'$'+Math.round(n/1e3)+'k':money(n);
  const clock=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
  const empire=createEmpire(career,catalog), TAXI=1500, NEAR=35;
  // each property sits on a street at a fixed bearing and distance from downtown
  const roadLinks=city.links.filter(l=>l.kind!=='ramp'&&l.kind!=='fwy'&&l.lanes?.[0]?.pts.length>4);
  const mid=l=>l.lanes[0].pts[Math.floor(l.lanes[0].pts.length/2)];
  const sites={};
  for(const b of BUSINESSES){
    const lim=city.EXT*.8,tx=Math.max(-lim,Math.min(lim,city.start.x+Math.sin(b.angle)*b.dist)),tz=Math.max(-lim,Math.min(lim,city.start.z+Math.cos(b.angle)*b.dist));
    let link=null,bd=Infinity;for(const l of roadLinks){const m=mid(l),d=Math.hypot(m.x-tx,m.z-tz);if(d<bd&&l.to.out.length){bd=d;link=l;}}
    const pts=link.lanes[0].pts,i=Math.floor(pts.length/2),a=pts[i],c=pts[i+1];
    sites[b.id]={link,point:{x:a.x,y:a.y||0,z:a.z},pose:{x:a.x,y:a.y||0,z:a.z,h:Math.atan2(c.x-a.x,c.z-a.z)}};
  }
  const markers={};
  for(const b of BUSINESSES){
    const p=sites[b.id].point,mat=new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.22,depthWrite:false});
    const beam=new THREE.Mesh(new THREE.CylinderGeometry(1.4,1.4,60,16,1,true),mat);beam.position.set(p.x,p.y+30,p.z);
    const ring=new THREE.Mesh(new THREE.TorusGeometry(8,.18,8,48),new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.7}));ring.rotation.x=Math.PI/2;ring.position.set(p.x,p.y+.2,p.z);
    scene.add(beam,ring);markers[b.id]={beam,ring};
  }
  const wp={mesh:new THREE.Mesh(new THREE.CylinderGeometry(.8,.8,45,12),new THREE.MeshBasicMaterial({color:0xffb547,transparent:true,opacity:.35,depthWrite:false})),target:null};
  wp.mesh.visible=false;scene.add(wp.mesh);
  const dist=id=>Math.hypot(sites[id].point.x-car.x,sites[id].point.z-car.z);
  const at=id=>dist(id)<NEAR&&Math.abs(sites[id].point.y-car.y)<8;
  let toastT=0;
  function notify(title,msg,ms=4200){const t=$('toast');if(!t)return;t.innerHTML=`<b>${title}</b> ${msg}`;t.style.opacity=1;clearTimeout(toastT);toastT=setTimeout(()=>{t.style.opacity=0;},ms);}

  /* ---------- business jobs (run on the shared mission engine) ---------- */
  const rnd=()=>Math.floor(Math.random()*1e9)+1;
  function routeHome(link,id){const p=city.route(link,sites[id].link.to);return p?p.map(mid).map(q=>({x:q.x,y:q.y||0,z:q.z})):[];}
  function sellJob(id){
    const b=empire.biz(id),o=empire.state.owned[id];
    const drops=Math.max(1,Math.min(4,Math.ceil(o.stock/b.cap*4)));
    const R=missions.chain(sites[id].link,drops,500+BUSINESSES.indexOf(b)*80,rnd());if(!R.ends.length)return null;
    const sale=empire.startSale(id);if(!sale)return null;
    const len=R.points.reduce((s,p,i,a)=>s+(i?Math.hypot(p.x-a[i-1].x,p.z-a[i-1].z):0),0);
    const heat=sale.value>40000&&Math.random()<Math.min(.65,sale.value/400000)?Math.min(3,1+Math.floor(sale.value/300000)):0;
    return {id:'biz-sell-'+id,biz:true,name:`Sell ${b.product.toLowerCase()} · ${b.name}`,type:'delivery',points:R.ends,route:R.points,limit:Math.ceil(120+len/8+R.ends.length*5),cargo:true,pursuit:heat,
      rules:`Deliver ${sale.units} units (${money(sale.value)}) to ${R.ends.length} drop${R.ends.length>1?'s':''}. Crashes damage the product.${heat?' Someone tipped off the police.':''}`,
      pay:a=>{const r=empire.finishSale(sale,true,a.integrity);return {...r,label:`${Math.round(a.integrity*100)}% of the product delivered`};},
      onFail:()=>empire.finishSale(sale,false),failText:'A quarter of the product was lost. The rest is back in storage.'};
  }
  function sourceJob(id){
    const b=empire.biz(id),idx=BUSINESSES.indexOf(b),R=missions.chain(sites[id].link,1,600+idx*120,rnd());if(!R.ends.length)return null;
    const back=routeHome(R.last,id);if(!back.length)return null;
    const pick=R.ends[0],home=sites[id].point,len=R.points.length*30+back.length*30;
    return {id:'biz-source-'+id,biz:true,name:`Supply run · ${b.name}`,type:'delivery',points:[pick,home],route:[...R.points,...back],limit:Math.ceil(150+len/7),cargo:true,pursuit:idx>=2?Math.min(3,Math.ceil(idx/2)):0,
      rules:`Collect the supplies, then bring them back to ${b.name}. A damaged load is worth less.${idx>=2?' The pickup is hot: expect police.':''}`,
      pay:a=>{const n=Math.round(60*Math.max(.3,a.integrity));empire.addSupplies(id,n);const r=career.earn(0,350+idx*200);return {...r,cash:0,label:`+${n}% supplies delivered`};},
      failText:'No supplies delivered.'};
  }
  function promoteJob(id){
    const b=empire.biz(id),R=missions.chain(sites[id].link,3,450,rnd());if(R.points.length<3)return null;
    const len=R.points.length*30;
    return {id:'biz-promote-'+id,biz:true,name:`Promote ${b.name}`,type:'race',points:R.points,route:R.points,limit:Math.ceil(60+len/12),
      rules:'Drive the promo route through every checkpoint before time runs out. Popularity +50%.',
      pay:()=>{empire.promote(id);const r=career.earn(0,600);return {...r,cash:0,label:'Popularity +50%'};},failText:'The promotion fizzled.'};
  }
  function defendJob(){
    const r=empire.state.raid;if(!r)return null;const b=empire.biz(r.id),idx=BUSINESSES.indexOf(b);
    return {id:'biz-defend-'+r.id,biz:true,name:`Defend ${b.name}`,type:'delivery',points:[sites[r.id].point],route:[sites[r.id].point],limit:Math.max(10,Math.ceil(r.t)),
      rules:`Rivals are hitting ${b.name}. Get there and hold position for 2 seconds.`,
      pay:()=>{if(!empire.defended())return {cash:0,xp:0,label:'Too late: the raiders got away'};const r2=career.earn(4000*(idx+1),700);return {...r2,label:'Raid repelled'};},failText:'The raid went ahead.'};
  }
  function launch(job){if(!job){notify('BUSINESS','No route available from here. Try again.');return false;}if(!missions.begin(job)){job.onFail?.();notify('BUSINESS','Finish your current job first.');return false;}toggle(false);return true;}

  /* ---------- panel ---------- */
  let open=false,uiT=0;
  function bar(f,cls=''){return `<div class="biz-bar ${cls}"><i style="width:${Math.round(Math.max(0,Math.min(1,f))*100)}%"></i></div>`;}
  function btn(act,id,label,disabled,title=''){return `<button data-act="${act}" data-id="${id}"${disabled?' disabled':''}${title?` title="${title}"`:''}>${label}</button>`;}
  function render(){
    const e=empire.state,o=empire.office(),busy=!!missions.engine.active,raid=e.raid;
    const cash=career.state.cash,w=empire.netWorth(),done=GOALS.filter(g=>e.goals[g.id]).length;
    let h=`<div class="biz-stats"><div><small>NET WORTH</small><b>${short(w)}</b></div><div><small>CASH</small><b>${money(cash)}</b></div><div><small>BUSINESS DAY</small><b>Day ${e.day}</b><em>Upkeep due in ${clock(DAY-e.clock)}</em></div><div><small>LIFETIME SALES</small><b>${short(e.stats.sales)}</b></div><div><small>MILESTONES</small><b>${done} / ${GOALS.length}</b></div></div>`;
    if(raid)h+=`<div class="biz-alert"><b>RAID</b> ${empire.biz(raid.id).name} is under attack · ${clock(raid.t)} left ${btn('defend',raid.id,'Defend it',busy)}</div>`;
    h+=`<h3 class="biz-h">Office</h3><div class="biz-office">`;
    for(const of of OFFICES){const mine=o?.id===of.id,why=empire.officeCheck(of.id),cost=of.price-(o&&!mine?o.price/2:0),past=o&&OFFICES.indexOf(o)>OFFICES.indexOf(of);
      h+=`<article class="biz-card ${mine?'owned':''}"><div class="job-meta">OFFICE · RANK ${of.level}<span>${mine?'YOUR HQ':past?'TRADED IN':short(of.price)}</span></div><h4>${of.name}</h4><p>${of.slots} business slots · +${Math.round(of.bonus*100)}% sale value · ${money(of.upkeep)} / day upkeep</p>${mine||past?'':btn('office',of.id,why?why:`Buy · ${money(cost)}${o?' after trade-in':''}`,!!why)}</article>`;}
    h+=`</div><h3 class="biz-h">Businesses <small>${Object.keys(e.owned).length} / ${empire.slots()} slots</small></h3><div class="biz-grid">`;
    for(const b of BUSINESSES){
      const s=e.owned[b.id],here=at(b.id),km=(dist(b.id)/1000).toFixed(1)+' km';
      h+=`<article class="biz-card ${s?'owned':''} ${raid?.id===b.id?'raided':''}"><div class="job-meta">${b.kind==='venue'?'NIGHTCLUB':'PRODUCTION · '+b.product.toUpperCase()}<span>${here?'YOU ARE HERE':km}</span></div><h4>${b.name}</h4>`;
      if(!s){
        const why=empire.check(b.id),perHour=b.kind==='venue'?b.income*5:3600/b.secs*b.unit;
        h+=`<p>${b.kind==='venue'?`Earns up to ${short(b.income)} a day into the safe while popular. Promote it to keep the crowd coming.`:`Makes ${b.product.toLowerCase()} worth ${money(b.unit)} each, ${b.cap} in storage. Needs supplies.`} About ${short(perHour)} / hour at best. Upkeep ${money(b.upkeep)} / day.</p><div class="job-pay">${short(b.price)} <small>Rank ${b.level}${b.office?' · office':''}</small></div>${btn('buy',b.id,why||'Buy business',!!why)}`;
      }else{
        if(s.unpaid)h+=`<p class="biz-warn">Upkeep unpaid: operations stopped. ${btn('pay',b.id,`Pay ${money(b.upkeep)}`,cash<b.upkeep)}</p>`;
        if(b.kind==='production'){
          const full=empire.timeToFull(b.id);
          h+=`${bar(s.stock/b.cap)}<div class="biz-line">Stock ${s.stock} / ${b.cap}<b>${money(empire.saleValue(b.id))}</b></div>${bar(s.supplies/100,'sup')}<div class="biz-line">Supplies ${Math.round(s.supplies)}%<span>${s.stock>=b.cap?'Storage full':full?'Producing · '+clock(full):'Out of supplies'}</span></div>`;
          h+=`<div class="biz-actions">${btn('supplies',b.id,`Buy supplies · ${money(empire.supplyCost(b.id))}`,!empire.supplyCost(b.id)||cash<empire.supplyCost(b.id))}`;
          h+=here?btn('source',b.id,'Steal supplies (free)',busy||s.supplies>=100)+btn('sell',b.id,'Sell stock',busy||s.stock<1):btn('waypoint',b.id,'Set waypoint')+btn('taxi',b.id,`Taxi · ${money(TAXI)}`,busy||cash<TAXI);
          h+=`</div>`;
        }else{
          h+=`${bar(s.pop/100)}<div class="biz-line">Popularity ${Math.round(s.pop)}%<span>${s.pop<30?'Dead night: promote it':''}</span></div>${bar(s.safe/b.safe,'sup')}<div class="biz-line">Safe<b>${money(s.safe)}</b><span>max ${short(b.safe)}</span></div>`;
          h+=`<div class="biz-actions">${here?btn('collect',b.id,'Collect safe',s.safe<1)+btn('promote',b.id,'Promote the club',busy||s.pop>=95):btn('waypoint',b.id,'Set waypoint')+btn('taxi',b.id,`Taxi · ${money(TAXI)}`,busy||cash<TAXI)}</div>`;
        }
        h+=`<div class="biz-ups">`;for(const [k,u] of Object.entries(UPGRADES[b.kind])){const c=empire.upgradeCost(b.id,k);h+=s.up[k]?`<span class="done">✓ ${u.name}</span>`:btn('upgrade',b.id+':'+k,`${u.name} · ${short(c)}`,cash<c,u.desc);}h+=`</div>`;
      }
      h+=`</article>`;
    }
    h+=`</div><h3 class="biz-h">Milestones</h3><ol class="biz-goals">`;
    for(const g of GOALS)h+=`<li class="${e.goals[g.id]?'done':''}"><b>${g.name}</b> ${g.desc}<span>${e.goals[g.id]?'Claimed':short(g.cash)}</span></li>`;
    h+=`</ol><p class="subtle">Businesses run while you play, including in menus, and stop when the tab is closed. Every 12 minutes is a business day: upkeep is charged and unpaid businesses stop. Selling, stealing supplies, promoting and collecting need you at the property. Raids hit busy properties; get there before the timer runs out or lose part of the stock.</p>`;
    $('empire-body').innerHTML=h;
  }
  function act(a,id){
    const r=a==='buy'?empire.buy(id):a==='office'?empire.buyOffice(id):a==='supplies'?empire.buySupplies(id):a==='pay'?empire.payUpkeep(id):null;
    if(r){notify('BUSINESS',r.ok?(a==='supplies'?`Supplies ordered · ${money(r.cost)}`:a==='pay'?'Upkeep paid':'Purchase complete'):r.reason);}
    else if(a==='upgrade'){const [bid,k]=id.split(':'),u=empire.upgrade(bid,k);notify('UPGRADE',u.ok?`${UPGRADES[empire.biz(bid).kind][k].name} installed`:u.reason);}
    else if(a==='sell'&&at(id))launch(sellJob(id));
    else if(a==='source'&&at(id))launch(sourceJob(id));
    else if(a==='promote'&&at(id))launch(promoteJob(id));
    else if(a==='collect'&&at(id)){const n=empire.collect(id);notify('SAFE',`Collected ${money(n)}`);}
    else if(a==='defend')launch(defendJob());
    else if(a==='waypoint'){wp.target=sites[id].point;notify('WAYPOINT',empire.biz(id).name);toggle(false);}
    else if(a==='taxi'&&!missions.engine.active&&career.state.cash>=TAXI){career.state.cash-=TAXI;career.save();travel(sites[id].pose);toggle(false);notify('TAXI',`Dropped at ${empire.biz(id).name}`);}
    missions.refresh();if(open)render();
  }
  function toggle(force){open=force??!open;$('empire').hidden=!open;if(open){$('garage').hidden=true;missions.toggle(false);render();$('close-empire').focus();}onPause();}
  $('empire-body').addEventListener('click',e=>{const b=e.target.closest('button[data-act]');if(b&&!b.disabled)act(b.dataset.act,b.dataset.id);});
  $('close-empire').onclick=()=>toggle(false);$('open-empire').onclick=()=>toggle(true);

  const NAMES={full:'storage is full',empty:'is out of supplies',unpaid:'missed its upkeep and has stopped'};
  function update(real,dt){
    for(const ev of empire.update(real)){
      if(ev.type==='raid')notify('RAID',`${empire.biz(ev.id).name} is under attack. Press B to defend it.`,6000);
      else if(ev.type==='raidLost'){notify('RAID',`${empire.biz(ev.id).name} was raided`,5000);const a=missions.engine.active;if(a?.job.id==='biz-defend-'+ev.id)missions.engine.cancel('The raid went ahead');}
      else if(ev.type==='day')notify('DAY '+ev.day,ev.bill?`Upkeep paid · ${money(ev.bill)}`:'A new business day');
      else if(ev.type==='goal')notify('MILESTONE',`${ev.goal.name} · +${money(ev.goal.cash)}`,6000);
      else notify('BUSINESS',`${empire.biz(ev.id).name} ${NAMES[ev.type]}`);
      missions.refresh();
    }
    uiT+=real;if(open&&uiT>1){uiT=0;render();}
    const t=performance.now()/1000,e=empire.state;
    for(const b of BUSINESSES){const m=markers[b.id],mine=!!e.owned[b.id],hot=e.raid?.id===b.id,col=hot?(t*3%1<.5?0xff5a4e:0xffffff):mine?0xffb547:0xd8e6ff;
      m.beam.material.color.setHex(col);m.ring.material.color.setHex(col);const near=Math.min(1,Math.max(0,(dist(b.id)-25)/60));m.beam.material.opacity=(hot?.4:mine?.26:.14)*near;m.beam.visible=near>0;m.ring.scale.setScalar(1+.03*Math.sin(t*3));}
    if(wp.target&&Math.hypot(wp.target.x-car.x,wp.target.z-car.z)<NEAR)wp.target=null;
    wp.mesh.visible=!!wp.target&&!missions.engine.active;if(wp.target)wp.mesh.position.set(wp.target.x,wp.target.y+22,wp.target.z);
    const here=BUSINESSES.find(b=>at(b.id));
    $('biz-prompt').hidden=!here||open||missions.paused||!!missions.engine.active;
    if(here)$('biz-prompt').innerHTML=`<b>${here.name}</b> ${e.owned[here.id]?'Press <kbd>B</kbd> to manage':'For sale · press <kbd>B</kbd>'}`;
    $('biz-raid').hidden=!e.raid;if(e.raid)$('biz-raid').textContent=`RAID · ${empire.biz(e.raid.id).name} · ${clock(e.raid.t)}`;
  }
  function drawMap(g,X,Y){
    const e=empire.state;g.save();
    if(wp.target&&!missions.engine.active){g.strokeStyle='#ffb547';g.lineWidth=2;g.setLineDash([3,5]);g.beginPath();g.moveTo(X(car.x,car.z),Y(car.x,car.z));g.lineTo(X(wp.target.x,wp.target.z),Y(wp.target.x,wp.target.z));g.stroke();g.setLineDash([]);}
    for(const b of BUSINESSES){const p=sites[b.id].point,x=X(p.x,p.z),y=Y(p.x,p.z),mine=!!e.owned[b.id];
      g.fillStyle=e.raid?.id===b.id?'#ff5a4e':mine?'#ffb547':'rgba(216,230,255,.8)';g.strokeStyle='#16151a';g.lineWidth=2;
      g.beginPath();g.rect(x-5,y-5,10,10);g.fill();g.stroke();g.fillStyle='#16151a';g.font='bold 8px sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillText('$',x,y+.5);}
    g.restore();
  }
  missions.status=()=>`Day ${empire.state.day} · ${short(empire.netWorth())}`;
  missions.refresh();
  return {empire,sites,update,drawMap,toggle,get open(){return open;},notify};
};
