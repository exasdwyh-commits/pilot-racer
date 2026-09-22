import test from 'node:test';
import assert from 'node:assert/strict';
import {makeRace,startRace,openLobby,stepRace,applyInput,useItem,snapshot,trackAt,trackFrameAt,TRACK_LENGTH,LAPS,SHOT_FLOOR,SHOT_KIND_FLOOR,ranking,ITEM_BOXES,ITEM_IDS,HIGHLIGHT_TYPES,MISSILE_LOCK_RANGE,TRACKS,TRACK_IDS,useTrack,currentTrackId,currentTrackFeatures,halfWidthAt,cornerCurvature,racingLineFactor,GRIP_LIMIT,pylonAt,PYLON_COUNT,rollPickup,aiRacingLane,resolveCarCollisions} from '../public/simulation.mjs';
test('closed elevated track is continuous at seam',()=>{const a=trackAt(0),b=trackAt(TRACK_LENGTH-.001);assert.ok(Math.hypot(a.x-b.x,a.z-b.z)<.01);assert.ok(TRACK_LENGTH>500);});
test('Bay GP V2 is a long technical lap with real elevation and safe road width',()=>{
 useTrack('bay');
 assert.ok(TRACK_LENGTH>1000&&TRACK_LENGTH<1200,`technical lap length ${TRACK_LENGTH.toFixed(0)}m`);
 let maxPitch=0,maxCurvature=0,minWidth=Infinity;
 for(let i=0;i<256;i++){
  const s=i/256*TRACK_LENGTH;
  maxPitch=Math.max(maxPitch,Math.abs(trackFrameAt(s).pitch));
  maxCurvature=Math.max(maxCurvature,Math.abs(cornerCurvature(s)));
  minWidth=Math.min(minWidth,halfWidthAt(s));
 }
 assert.ok(maxPitch>0.025,`elevation creates visible chassis pitch (${maxPitch.toFixed(3)} rad)`);
 assert.ok(maxCurvature>0.055,`route contains genuine braking corners (${maxCurvature.toFixed(3)})`);
 assert.ok(minWidth>=4.3,`tight sections remain raceable (${minWidth.toFixed(2)}m half-width)`);
});
test('AI racing line stays on road and changes side through technical corners',()=>{
 useTrack('bay');
 const r=makeRace('bay');
 const c=r.cars[0];
 const lanes=[];
 for(let i=0;i<80;i++){
  c.s=i/80*TRACK_LENGTH;
  const lane=aiRacingLane(c);
  lanes.push(lane);
  assert.ok(Math.abs(lane)<=halfWidthAt(c.s)-1+0.01,'AI target stays inside collision wall');
 }
 assert.ok(Math.min(...lanes)<-1&&Math.max(...lanes)>1,'AI uses both sides of the circuit');
});
test('Bay GP skill routes reward deliberate boost-pad and ramp lines',()=>{
 useTrack('bay');
 const features=currentTrackFeatures();
 assert.equal(features.boostPads.length,3);
 assert.equal(features.ramps.length,1);

 const pad=features.boostPads[0];
 const r=makeRace('bay');r.phase='racing';settle(r);
 for(const other of r.cars.slice(1))other.finish=1;
 const c=r.cars[0];c.s=pad.at*TRACK_LENGTH-.5;c.lane=pad.lane;c.speed=20;
 stepRace(r,1/30);
 assert.ok(c.boost>0.6,'aligned kart receives route boost');
 assert.equal(c.featureKind,'boost-pad');

 const r2=makeRace('bay');r2.phase='racing';settle(r2);
 for(const other of r2.cars.slice(1))other.finish=1;
 const d=r2.cars[0];d.s=pad.at*TRACK_LENGTH-.5;d.lane=pad.lane+3.2;d.speed=20;
 stepRace(r2,1/30);
 assert.equal(d.featureKind,null,'missing the strip gives no free reward');

 const ramp=features.ramps[0];
 const r3=makeRace('bay');r3.phase='racing';settle(r3);
 for(const other of r3.cars.slice(1))other.finish=1;
 const e=r3.cars[0];e.s=ramp.at*TRACK_LENGTH-.5;e.lane=ramp.lane;e.speed=28;
 stepRace(r3,1/30);
 assert.ok(e.jumpUntil>r3.time,'bridge ramp launches the kart');
 assert.equal(e.featureKind,'ramp');
});
test('slipstream charges in a wake then releases an overtaking burst',()=>{
 const r=makeRace('bay');r.phase='racing';settle(r);
 for(const other of r.cars.slice(2))other.finish=1;
 const follower=r.cars[0],leader=r.cars[1];
 follower.s=20;leader.s=33;follower.lane=leader.lane=0;follower.speed=leader.speed=28;
 for(let i=0;i<36;i++)stepRace(r,1/30);
 assert.ok(follower.drafting,'follower is in the wake');
 assert.ok(follower.draftCharge>=1,'wake reaches full charge');
 follower.lane=4;
 stepRace(r,1/30);
 assert.ok(follower.draftBoost>0.8,'leaving the wake releases the pass boost');
 assert.equal(follower.featureKind,'draft-release');
 const snap=snapshot(r).cars[0];
 assert.ok('draftCharge' in snap&&'draftBoost' in snap,'phone receives drafting state');
});
test('race settings configure track, laps and time limit and survive rematches',()=>{
 const r=makeRace('ridge',{laps:5,seconds:60});
 assert.equal(r.trackId,'ridge');assert.equal(r.laps,5);assert.equal(r.seconds,60);assert.equal(r.remaining,60);
 startRace(r);assert.equal(r.remaining,60);assert.equal(snapshot(r).laps,5);assert.equal(snapshot(r).seconds,60);
 openLobby(r);assert.equal(r.remaining,60);
});
test('countdown holds all cars; server finishes race and rematches connected humans',()=>{
 const r=makeRace();r.cars[0].human=true;r.cars[0].connected=true;r.cars[0].name='小王';startRace(r);
 assert.equal(r.cars[0].name,'小王');for(let i=0;i<90;i++)stepRace(r,1/30);assert.equal(r.cars[0].s,0);
 for(let i=0;i<r.seconds*30+1200&&r.phase!=='result';i++)stepRace(r,1/30);
 assert.equal(r.phase,'result');assert.equal(ranking(r).length,8);assert.ok(r.cars.some(c=>c.finish!==null));
 for(let i=0;i<361;i++)stepRace(r,1/30);assert.equal(r.phase,'lobby');startRace(r);assert.equal(r.phase,'countdown');assert.equal(r.round,2);assert.equal(r.cars[0].finish,null);
});
test('only bounded ordered input accepted; stale control cannot steer or boost',()=>{
 const r=makeRace(),c=r.cars[0];r.phase='racing';c.human=true;c.connected=true;
 const input={seq:1,steer:1,drift:true,boost:false,brake:false};assert.ok(applyInput(c,input,0));assert.equal(applyInput(c,input,0),false);
 assert.equal(applyInput(c,{...input,seq:2,steer:NaN},0),false);assert.equal(applyInput(c,{...input,seq:2,steer:5},0),false);
 assert.equal(applyInput(c,{...input,seq:2,drift:'yes'},0),false);
 c.inputAt=-1;c.lateral=0;c.lane=0;stepRace(r,1/30);assert.equal(c.lateral,0);assert.equal(c.drift,false);
});
test('boost consumes server energy once and cannot be spammed while active',()=>{
  const r=makeRace();r.phase='racing';const c=r.cars[0];c.human=c.connected=true;
  applyInput(c,{seq:1,steer:0,drift:false,boost:true,brake:false},r.time);stepRace(r,1/30);assert.ok(c.boost>1.6);assert.ok(c.energy<6);
  c.energy=50;applyInput(c,{seq:2,steer:0,drift:false,boost:true,brake:false},r.time);stepRace(r,1/30);assert.ok(c.energy>=50);
});
test('sustained drift released grants a mini-boost; short drifts do not',()=>{
  const r=makeRace('ridge');r.phase='racing';settle(r);const c=r.cars[0];c.s=280;let seq=0;
  const hold=(n)=>{for(let i=0;i<n;i++){applyInput(c,{seq:++seq,steer:1,drift:true,boost:false,brake:false},r.time);stepRace(r,1/30);}};
  hold(20);assert.ok(c.drift,'still drifting after a sustained hold');
  applyInput(c,{seq:++seq,steer:0,drift:false,boost:false,brake:false},r.time);stepRace(r,1/30);
  assert.ok(c.boost>=0.7&&c.boost<=0.8,'mini-boost fires on release');
  assert.ok(r.events.some(e=>e.text==='漂移小喷'));
  const r2=makeRace('ridge');r2.phase='racing';settle(r2);const d=r2.cars[0];d.s=280;let seq2=0;
  for(let i=0;i<10;i++){applyInput(d,{seq:++seq2,steer:1,drift:true,boost:false,brake:false},r2.time);stepRace(r2,1/30);}
  applyInput(d,{seq:++seq2,steer:0,drift:false,boost:false,brake:false},r2.time);stepRace(r2,1/30);
  assert.equal(d.boost,0,'a 0.33s drift is too short for a mini-boost');
  useTrack('bay');
});
test('drift rewards loaded corners with two release tiers, not straight weaving',()=>{
  const run=(s,frames)=>{
    const r=makeRace('ridge');r.phase='racing';settle(r);const c=r.cars[0];c.s=s;c.speed=28;let seq=0;
    for(let i=0;i<frames;i++){
      // Pin the test section: compare charge under the same steering effort.
      c.s=s;applyInput(c,{seq:++seq,steer:1,drift:true,boost:false,brake:false},r.time);stepRace(r,1/30);
    }
    return {r,c,seq};
  };
  const straight=run(0,36),bend=run(280,36);
  assert.ok(bend.c.driftCharge>straight.c.driftCharge*2,`bend charges faster (${bend.c.driftCharge.toFixed(2)} > ${straight.c.driftCharge.toFixed(2)})`);
  assert.equal(straight.c.driftStage,undefined,'tier is derived on the authoritative car');
  assert.equal(snapshot(straight.r).cars[0].driftStage,0,'straight weaving has no release tier after 1.2s');
  assert.equal(snapshot(bend.r).cars[0].driftStage,2,'a committed hairpin drift reaches perfect tier');
  applyInput(bend.c,{seq:++bend.seq,steer:0,drift:false,boost:false,brake:false},bend.r.time);stepRace(bend.r,1/30);
  assert.ok(bend.c.boost>0.95,'perfect release grants the stronger exit boost');
  assert.ok(bend.r.events.some(e=>e.text==='完美漂移 · 强力小喷'));
  useTrack('bay');
});
test('inside line makes bounded progress through a bend and has no straight bonus',()=>{
  useTrack('ridge');
  const s=280,k=cornerCurvature(s);assert.ok(k>0.2,'test pins a signed hairpin');
  const inside=racingLineFactor(s,-3),centre=racingLineFactor(s,0),outside=racingLineFactor(s,3);
  assert.ok(inside>centre&&centre>outside,`inside ${inside.toFixed(3)} > centre > outside ${outside.toFixed(3)}`);
  assert.ok(inside<=1.12&&outside>=0.88,'line advantage remains bounded');
  assert.ok(Math.abs(racingLineFactor(320,5)-1)<0.01,'near-straight lane position has no useful bonus');
  useTrack('bay');
});
test('input timeout drops the drift charge with no mini-boost',()=>{
  const r=makeRace();r.phase='racing';settle(r);const c=r.cars[0];let seq=0;
  for(let i=0;i<20;i++){applyInput(c,{seq:++seq,steer:1,drift:true,boost:false,brake:false},r.time);stepRace(r,1/30);}
  assert.ok(c.driftTime>=0.6,'charge accumulated while drifting');
  c.inputAt=r.time-1; // network stall: no fresh input
  stepRace(r,1/30);
  assert.equal(c.boost,0,'stale timeout earns no boost');
  assert.equal(c.driftTime,0,'stale timeout clears the charge');
});
test('hairpin scrubs speed, straights stay flat, drift raises the cap',()=>{
  useTrack('ridge');
  const hairS = 280; // measured max-curvature spot
  assert.ok(Math.abs(cornerCurvature(hairS)) > 0.15,'test pins a real hairpin');
  assert.ok(Math.abs(cornerCurvature(0)) < 0.01,'start straight is flat');
  const run = (drift) => {
    const r = makeRace('ridge');r.phase='racing';settle(r);
    const c = r.cars[0];let seq = 0;
    for (let i = 0; i < 90; i++) {
      c.s = hairS;c.lane = 0;
      if (drift) applyInput(c,{seq:++seq,steer:1,drift:true,boost:false,brake:false},r.time);
      stepRace(r,1/30);
    }
    return r.cars[0].speed;
  };
  const gripSpeed = run(false);
  assert.ok(gripSpeed < 27,`hairpin bleeds full speed (got ${gripSpeed.toFixed(1)})`);
  const driftSpeed = run(true);
  assert.ok(driftSpeed > gripSpeed,`drifting carries more speed (${driftSpeed.toFixed(1)} > ${gripSpeed.toFixed(1)})`);
  const r2 = makeRace('ridge');r2.phase='racing';settle(r2);
  const d = r2.cars[0];d.s = 0;d.lane = 0;
  for (let i = 0; i < 200; i++) stepRace(r2,1/30);
  assert.ok(d.speed > 30,`straight holds full speed (got ${d.speed.toFixed(1)})`);
  useTrack('bay');
});
test('steering creates authoritative heading and lateral motion instead of pure lane sliding',()=>{
  const r=makeRace('bay');r.phase='racing';settle(r);
  for(const other of r.cars.slice(1))other.finish=1;
  const c=r.cars[0];c.s=40;c.lane=0;c.speed=30;let seq=0;
  for(let i=0;i<18;i++){
    applyInput(c,{seq:++seq,steer:.8,drift:false,boost:false,brake:false},r.time);
    stepRace(r,1/30);
  }
  assert.ok(c.headingError>0.08,`body has a real heading angle (${c.headingError.toFixed(3)})`);
  assert.ok(c.lane>0.5,`heading generates road-relative lateral travel (${c.lane.toFixed(2)}m)`);
  assert.ok(Number.isFinite(c.slipAngle),'tyre slip is finite');
  const snap=snapshot(r).cars[0];
  assert.ok('headingError' in snap&&'slipAngle' in snap,'heading/slip ship to render clients');
});
test('drift develops a larger slip angle than grip steering and settles when steering is released',()=>{
  const run=(drift)=>{
    const r=makeRace('bay');r.phase='racing';settle(r);
    for(const other of r.cars.slice(1))other.finish=1;
    const c=r.cars[0];c.s=45;c.lane=0;c.speed=30;let seq=0;
    for(let i=0;i<18;i++){
      applyInput(c,{seq:++seq,steer:.9,drift,boost:false,brake:false},r.time);
      stepRace(r,1/30);
    }
    return {r,c,seq};
  };
  const grip=run(false),drift=run(true);
  assert.ok(
    Math.abs(drift.c.slipAngle)>Math.abs(grip.c.slipAngle)+0.02,
    `drift slip ${drift.c.slipAngle.toFixed(3)} vs grip ${grip.c.slipAngle.toFixed(3)}`,
  );
  const before=Math.abs(drift.c.headingError);
  for(let i=0;i<45;i++){
    applyInput(drift.c,{seq:++drift.seq,steer:0,drift:false,boost:false,brake:false},drift.r.time);
    stepRace(drift.r,1/30);
  }
  assert.ok(Math.abs(drift.c.headingError)<before*.35,'car naturally straightens after steering release');
});
test('high speed desensitizes steering response',()=>{
  useTrack('bay');
  const run = (speed) => {
    const r=makeRace('bay');r.phase='racing';settle(r);
    const c=r.cars[0];c.s=0;c.lane=0;c.speed=speed;c.lateral=0;let seq=0;
    for(let i=0;i<10;i++){
      if(i%5===0)applyInput(c,{seq:++seq,steer:0.5,drift:false,boost:false,brake:false},r.time);
      stepRace(r,1/30);
    }
    return r.cars[0].lateral;
  };
  const low=run(20), high=run(48);
  assert.ok(high<low,`fast steering is calmer (${high.toFixed(2)} < ${low.toFixed(2)})`);
  useTrack('bay');
});
test('pylons are solid and walls kill drift charge',()=>{  useTrack('bay');
  assert.equal(PYLON_COUNT,7);
  const r=makeRace('bay');r.phase='racing';settle(r);
  const py=pylonAt(1);
  const c=r.cars[0];c.s=py.s-0.5;c.lane=py.lane;c.speed=30;c.incidentAt=r.time-4;
  stepRace(r,1/30);
  assert.ok(c.speed<30*0.95,`clipping a pylon scrubs speed (got ${c.speed.toFixed(1)})`);
  assert.ok(r.events.some(e=>e.text==='撞上雪糕筒'),'pylon hit announced');
  const r2=makeRace('bay');r2.phase='racing';settle(r2);
  const d=r2.cars[0];d.s=100;d.lane=0;d.speed=25;d.driftTime=1;
  d.lane=halfWidthAt(100)+2; // force a wall clamp next step
  stepRace(r2,1/30);
  assert.equal(d.driftTime,0,'wall contact clears drift charge');
  assert.ok(d.speed<25*0.99,'wall scrape costs speed');
});
test('missile and mine hits grant a short guard that blocks chain stuns',()=>{
  const r=makeRace();r.phase='racing';settle(r);const [a,b]=r.cars;
  a.s=100;b.s=110;a.lane=b.lane=0;a.speed=b.speed=30;
  const fire=()=>{r.entities.push({id:r.entityId+1,kind:'missile',owner:a.id,s:109,lane:0,alive:true,bornAt:r.time,life:2.6,speed:0,targetId:null});r.entityId++;};
  fire();stepRace(r,1/30);
  assert.ok(b.slowUntil>r.time,'first missile slows');assert.ok(b.guardUntil>r.time,'first hit arms the guard');
  const slowAfterFirst=b.slowUntil;
  fire();stepRace(r,1/30);
  assert.equal(b.slowUntil,slowAfterFirst,'guarded missile does not re-slow');
  assert.ok(r.events.some(e=>e.text==='受击保护 · 伤害豁免'));
  b.guardUntil=-Infinity;
  r.entities.push({id:r.entityId+1,kind:'mine',owner:a.id,s:109,lane:0,alive:true,bornAt:r.time,life:45,speed:0,targetId:null});r.entityId++;
  b.s=109;stepRace(r,1/30);
  assert.ok(b.slowUntil>r.time,'guard expired: mine slows again');
  assert.ok('guardUntil' in snapshot(r).cars[1],'guard ships in snapshot for client effects');
});
test('collision separates cars with impulse response instead of sticky per-frame braking',()=>{
 const r=makeRace();r.phase='racing';const[a,b]=r.cars;
 for(const c of r.cars.slice(2))c.finish=1;
 for(const c of[a,b]){c.s=100;c.lane=0;c.speed=30;c.human=c.connected=true;}
 for(let i=0;i<5;i++)stepRace(r,1/30);
 assert.ok(Math.abs(a.lane-b.lane)>1.2,`penetration resolved to ${Math.abs(a.lane-b.lane).toFixed(2)}m`);
 assert.ok(a.speed>25&&b.speed>25,'contact does not freeze either kart');
 assert.ok(Math.abs(a.lateral-b.lateral)>0.5,'side contact creates opposing lateral momentum');
 assert.ok(r.events.some(e=>e.text==='车身碰撞 · 位置争夺'));
});
test('rear impact transfers speed forward and collision cooldown prevents sticky repeated impulse',()=>{
 const r=makeRace();r.phase='racing';const[front,rear]=r.cars;
 for(const c of r.cars.slice(2))c.finish=1;
 front.s=102;front.lane=0;front.speed=20;
 rear.s=100;rear.lane=0;rear.speed=36;
 resolveCarCollisions(r);
 const afterFront=front.speed,afterRear=rear.speed;
 assert.ok(afterFront>20,'front kart receives momentum');
 assert.ok(afterRear<36,'rear kart gives up momentum');
 resolveCarCollisions(r);
 assert.equal(front.speed,afterFront,'same contact frame cannot apply a second speed impulse');
 assert.equal(rear.speed,afterRear,'cooldown blocks repeated sticky braking');
});

test('right steering moves screen-right in the driving camera around the entire track',()=>{
 for(let s=0;s<TRACK_LENGTH;s+=TRACK_LENGTH/16){
  const center=trackAt(s),ahead=trackAt(s+.1),right=trackAt(s,1);
  const fx=ahead.x-center.x,fz=ahead.z-center.z;
  // Camera right = forward cross world-up = (-forward.z, 0, forward.x).
  assert.ok((right.x-center.x)*-fz+(right.z-center.z)*fx>0);
 }
 const r=makeRace();r.phase='racing';const c=r.cars[0];c.human=c.connected=true;c.s=100;c.lane=0;
 applyInput(c,{seq:1,steer:1,drift:false,boost:false,brake:false},0);stepRace(r,1/30);assert.ok(c.lane>0);
});

test('joystick has a neutral dead zone and circular travel with signed analog output',async()=>{
 const {joystickInput}=await import('../public/simulation.mjs');
 assert.equal(joystickInput(0,20,40).steer,0);
 assert.equal(joystickInput(2,0,40).steer,0);
 assert.equal(joystickInput(80,0,40).steer,1);
 assert.equal(joystickInput(-80,0,40).steer,-1);
 const diagonal=joystickInput(80,80,40);assert.ok(Math.abs(Math.hypot(diagonal.x,diagonal.y)-40)<.001);assert.ok(diagonal.steer>0&&diagonal.steer<1);
 assert.equal(joystickInput(NaN,0,40).steer,0);
});

// ---- Item system ----
function settle(r){for(const c of r.cars){c.human=true;c.connected=true;c.inputAt=-Infinity;}}
function still(c){c.speed=0;}
test('item boxes grant one held item and respawn after 8 seconds',()=>{
 const r=makeRace();r.phase='racing';const c=r.cars[0];
 c.s=TRACK_LENGTH/ITEM_BOXES-1;c.lane=-2.6;c.speed=0;
 stepRace(r,1/30);
 assert.ok(ITEM_IDS.includes(c.item),'pickup granted');
 assert.equal(r.boxes[0].item,null);
 const respawnAt=r.boxes[0].respawnAt;
 // Park every other car so only the held-item rule is under test.
 for(const other of r.cars)if(other.id!==c.id)other.finish=1;
 // Holding one item blocks the next box: it stays on the track.
 c.item='shield';c.s=2*TRACK_LENGTH/ITEM_BOXES-1;c.lane=2.6;c.speed=0;
 stepRace(r,1/30);assert.equal(c.item,'shield');assert.ok(r.boxes[1].item!==null,'box intact');
 // After the 8s window the box is live again.
 for(let i=0;i<250;i++)stepRace(r,1/30);
 assert.ok(r.boxes[0].item!==null,'respawned');
 assert.ok(respawnAt>0);
});
test('useItem is server authoritative: cooldown, empty slot, wrong phase',()=>{
 const r=makeRace();const c=r.cars[0];
 assert.equal(useItem(r,c,0),false,'no item');
 r.phase='racing';c.item='shield';c.useAt=-Infinity;
 assert.equal(useItem(r,c,0),true);
 c.item='shield';
 assert.equal(useItem(r,c,0.5),false,'cooldown');
 assert.equal(useItem(r,c,2.1),true,'after cooldown');
 r.phase='countdown';c.item='mine';
 assert.equal(useItem(r,c,5),false,'phase gate');
});
test('missile locks nearest driver ahead, hit slows for 2s; shield truly blocks',()=>{
 const r=makeRace();r.phase='racing';settle(r);
 const [a,b]=r.cars;
 a.s=200;a.lane=0;a.speed=30;a.item='missile';
 b.s=240;b.lane=0;b.speed=30;
 assert.equal(useItem(r,a,r.time),true);
 assert.equal(a.item,null);
 const missile=r.entities.find(e=>e.kind==='missile');
 assert.ok(missile&&missile.targetId===b.id,'locked nearest ahead');
 for(let i=0;i<40;i++)stepRace(r,1/30);
 assert.ok(b.slowUntil>r.time&&b.slowUntil<=r.time+2.1,'slowed for ~2s from impact');
 assert.ok(r.highlights.some(h=>h.type==='missile_hit'&&h.actorId===a.id&&h.targetId===b.id));
 // Shielded victim: no slow at all.
 const r2=makeRace();r2.phase='racing';settle(r2);
 const [x,y]=r2.cars;
 x.s=200;x.lane=0;x.speed=30;x.item='shield';
 y.s=160;y.lane=0;y.speed=30;y.item='missile';
 useItem(r2,x,r2.time);useItem(r2,y,r2.time);
 for(let i=0;i<40;i++)stepRace(r2,1/30);
 assert.ok(x.slowUntil<0,'shield prevented slow');
 assert.ok(x.speed>20,'shield kept speed');
 assert.ok(r2.highlights.some(h=>h.type==='shield_block'));
});
test('mine hit slows with spin; jumping car passes over unharmed',()=>{
 const r=makeRace();r.phase='racing';settle(r);
 const [a,b]=r.cars;
 a.s=200;a.lane=0;a.speed=30;a.item='mine';
 b.s=150;b.lane=0;b.speed=30;
 useItem(r,a,r.time);
 assert.ok(r.entities.some(e=>e.kind==='mine'));
 for(let i=0;i<55;i++)stepRace(r,1/30);
 assert.ok(r.highlights.some(h=>h.type==='mine_hit'&&h.targetId===b.id));
 assert.ok(b.spinUntil>r.time-1.3,'spin applied');
 assert.ok(b.slowUntil>0);
 // Jump dodge.
 const r2=makeRace();r2.phase='racing';settle(r2);
 const [c,d]=r2.cars;
 c.s=200;c.lane=0;c.speed=30;c.item='mine';
 d.s=150;d.lane=0;d.speed=30;
 useItem(r2,c,r2.time);
 d.jumpUntil=r2.time+3;
 for(let i=0;i<55;i++)stepRace(r2,1/30);
 assert.ok(!r2.highlights.some(h=>h.type==='mine_hit'),'jump avoided mine');
 assert.ok(d.slowUntil<0);
});
test('EMP drains nitrogen in range',()=>{
  const r=makeRace();r.phase='racing';settle(r);
  const [a,b]=r.cars;
  a.s=200;a.lane=0;a.speed=40;a.item='emp';
  b.s=215;b.lane=0;b.speed=40;b.boost=1.5;
  useItem(r,a,r.time);
  for(let i=0;i<20;i++)stepRace(r,1/30);
  assert.ok(b.empUntil>r.time-2.2,'emp applied');
  assert.ok(b.boost<1.5,'boost cut');
});
test('tractor locks ahead, dashes with homing; blind fire is a weak boost',()=>{
  const r=makeRace();r.phase='racing';settle(r);
  const [a,b]=r.cars;
  a.s=100;a.lane=-2;a.speed=25;a.item='tractor';
  b.s=130;b.lane=2;b.speed=25;
  assert.equal(useItem(r,a,r.time),true);
  assert.equal(a.tractorTarget,b.id,'locks nearest ahead');
  assert.ok(a.boost>=1.4,'dash boost');
  const laneBefore=a.lane;
  for(let i=0;i<30;i++)stepRace(r,1/30);
  assert.ok(Math.abs(a.lane-b.lane)<Math.abs(laneBefore-b.lane)+2,'homing pulls toward victim line');
  // Blind fire.
  const r2=makeRace();r2.phase='racing';settle(r2);
  const [c]=r2.cars;c.s=100;c.speed=20;c.item='tractor';
  for(const o of r2.cars.slice(1)){o.finish=1;o.s=-1000;}
  assert.equal(useItem(r2,c,r2.time),true);
  assert.equal(c.tractorTarget,null,'no target in range');
  assert.ok(c.boost>=1.0&&c.boost<1.4,'weak consolation boost');
});
test('perfect block refunds energy; late block does not',()=>{
  const r=makeRace();r.phase='racing';settle(r);
  const [a,b]=r.cars;
  a.s=100;a.lane=0;a.speed=30;a.item='missile';
  b.s=120;b.lane=0;b.speed=30;b.energy=40;
  b.item='shield';useItem(r,b,r.time); // shield raised now
  useItem(r,a,r.time);
  for(let i=0;i<40;i++)stepRace(r,1/30);
  assert.ok(r.events.some(e=>e.text==='完美格挡导弹！'),'perfect announced');
  assert.ok(b.energy>40,'energy refunded');
  // Late shield: raise early, get hit late.
  const r2=makeRace();r2.phase='racing';settle(r2);
  const [x,y]=r2.cars;
  x.s=100;x.lane=0;x.speed=30;x.item='missile';
  y.s=200;y.lane=0;y.speed=0;y.energy=40;
  y.item='shield';useItem(r2,y,r2.time);
  for(let i=0;i<60;i++)stepRace(r2,1/30); // shield ages past the window
  y.s=120;y.speed=30;
  useItem(r2,x,r2.time);
  for(let i=0;i<40;i++)stepRace(r2,1/30);
  assert.ok(!r2.events.some(e=>e.text==='完美格挡导弹！'),'late block is ordinary');
});
test('boosting through side contact keeps speed and visibly shoves the victim',()=>{
  const r=makeRace();r.phase='racing';settle(r);
  for(const c of r.cars.slice(2))c.finish=1;
  const [a,b]=r.cars;
  a.s=100;a.lane=0;a.speed=30;a.boost=1.0;
  b.s=100;b.lane=0.5;b.speed=30;
  stepRace(r,1/30);
  assert.ok(a.speed>=29.5,`booster keeps speed (got ${a.speed.toFixed(1)})`);
  assert.ok(Math.abs(b.lateral)>1,'victim receives a lateral shove');
});
test('pickup pools favor defense up front, chase at the back, pity for last',()=>{
  useTrack('bay');
  const counts = { first: {}, last: {} };
  for (let i = 0; i < 400; i++) {
    const r = makeRace('bay');r.phase = 'racing';
    r.cars.forEach((c, k) => { c.s = 100 - k * 10; c.lane = 0; c.speed = 25; c.item = null; });
    const first = r.cars[0], last = r.cars[7];
    const f = rollPickup(r, first);
    counts.first[f] = (counts.first[f] || 0) + 1;
    const l = rollPickup(r, last);
    counts.last[l] = (counts.last[l] || 0) + 1;
  }
  const fDef = (counts.first.shield || 0) + (counts.first.boost || 0) + (counts.first.mine || 0);
  assert.ok(fDef > 200, `leader leans defense/mild (got ${fDef}/400)`);
  assert.ok((counts.first.tractor || 0) < 60, 'leader rarely gets tractor');
  const lChase = (counts.last.tractor || 0) + (counts.last.boost || 0);
  assert.ok(lChase > 200, `last leans tractor/boost (got ${lChase}/400)`);
  assert.ok((counts.last.mine || 0) < 40, 'last almost never gets mines');
  // Pity accumulates while last, resets when leaving.
  const r2 = makeRace('bay');r2.phase = 'racing';
  r2.cars.forEach((c, k) => { c.s = 100 - k * 10; });
  const tail = r2.cars[7];
  rollPickup(r2, tail);rollPickup(r2, tail);
  assert.equal(tail.trailPity, 2, 'pity counts consecutive lasts');
  tail.s = 500; // takes the lead
  rollPickup(r2, tail);
  assert.equal(tail.trailPity, 0, 'pity resets off last');
  useTrack('bay');
});
test('director highlights carry the required shape and cover the catalogue',()=>{
 const r=makeRace();r.phase='racing';settle(r);
 const [a,b]=r.cars;
 // Collision highlight.
 a.s=100;a.lane=0;a.speed=30;b.s=101;b.lane=.5;b.speed=30;
 for(let i=0;i<3;i++)stepRace(r,1/30);
 const collision=r.highlights.find(h=>h.type==='car_collision');
 assert.ok(collision);
 for(const key of ['type','timestamp','actorId','targetId','position','severity'])assert.ok(key in collision,key);
 assert.equal(collision.actorId,a.id);assert.equal(collision.targetId,b.id);
 assert.ok(collision.severity>=1&&collision.severity<=5);
 // Boost overtake in a fresh race so earlier incidents cannot gate it.
 const r2=makeRace();r2.phase='racing';settle(r2);
 const [p,q]=r2.cars;
 p.s=305;p.lane=-3;p.speed=45;p.boost=1.7;q.s=330;q.lane=3;q.speed=30;
 for(let i=0;i<120;i++)stepRace(r2,1/30);
 assert.ok(r2.highlights.some(h=>h.type==='overtake_after_boost'&&h.actorId===p.id),'boost overtake');
 // Last lap + finish line.
 a.s=2*TRACK_LENGTH-3;a.speed=45;a.boost=0;
 for(let i=0;i<8;i++)stepRace(r,1/30);
 assert.ok(r.highlights.some(h=>h.type==='last_lap'),'last lap recorded');
 a.s=3*TRACK_LENGTH-3;a.speed=45;
 for(let i=0;i<8;i++)stepRace(r,1/30);
 assert.ok(a.finish!==null,'finished');
 assert.ok(r.highlights.some(h=>h.type==='finish_line'&&h.actorId===a.id));
 for(const t of HIGHLIGHT_TYPES)assert.equal(typeof t,'string');
});
test('snapshot includes items, effects, boxes, entities and highlights for reconnects',()=>{
 const r=makeRace();r.phase='racing';settle(r);
 const [a,b]=r.cars;
 a.s=200;a.lane=0;a.speed=30;a.item='missile';
 b.s=240;b.lane=0;b.speed=30;
 useItem(r,a,r.time);
 for(let i=0;i<40;i++)stepRace(r,1/30);
 const s=snapshot(r);
 assert.equal(s.boxes.length,ITEM_BOXES);
 assert.ok(Array.isArray(s.entities));
 assert.ok(Array.isArray(s.highlights)&&s.highlights.length>0);
 assert.ok(s.highlights[0].timestamp<=r.time);
  assert.ok('item' in s.cars[0]&&'slowUntil' in s.cars[0]&&'shieldUntil' in s.cars[0]
    &&'empUntil' in s.cars[0]&&'spinUntil' in s.cars[0]&&'jumpUntil' in s.cars[0]
    &&'itemEventAt' in s.cars[0]&&'slowSpinUntil' in s.cars[0]&&'steer' in s.cars[0]);
  assert.ok(Number.isFinite(s.cars[0].steer)&&Math.abs(s.cars[0].steer)<=1,'steer ships a bounded number for wheel rigging');
  assert.equal(s.cars[1].slowUntil,b.slowUntil);
});

// ---- second track (ridge): shape, widths, switching ----
test('every track is closed, sane-sized and carries switchable snapshots',()=>{
  assert.deepEqual([...TRACK_IDS].sort(),['bay','ridge']);
  for (const id of TRACK_IDS) {
    assert.ok(useTrack(id),`useTrack accepts ${id}`);
    assert.equal(currentTrackId(),id);
    const a=trackAt(0),b=trackAt(TRACK_LENGTH-.001);
    assert.ok(Math.hypot(a.x-b.x,a.z-b.z)<.01,`${id} closes at the seam`);
    const lengthRange = id === 'bay' ? [1000,1200] : [600,900];
    assert.ok(TRACK_LENGTH>lengthRange[0]&&TRACK_LENGTH<lengthRange[1],`${id} lap length in scenery range`);
    let mn=Infinity,mx=0;
    for(let s=0;s<TRACK_LENGTH;s+=2){const h=halfWidthAt(s);mn=Math.min(mn,h);mx=Math.max(mx,h);}
    assert.ok(mn>=4&&mx<=10,`${id} road half-width drivable`);
    const r=makeRace(id);
    assert.equal(r.trackId,id);
    assert.equal(snapshot(r).trackId,id,'snapshot carries trackId for client rebuilds');
  }
  assert.equal(useTrack('unknown'),false,'unknown track rejected');
  useTrack('bay');
});
test('narrow hairpin walls clamp tighter than the start straight',()=>{
  useTrack('ridge');
  const r=makeRace('ridge');r.phase='racing';settle(r);
  let narrowS=0,narrowHW=Infinity;
  for(let s=0;s<TRACK_LENGTH;s+=2){const h=halfWidthAt(s);if(h<narrowHW){narrowHW=h;narrowS=s;}}
  assert.ok(narrowHW<halfWidthAt(0)-2,'ridge has a narrow section off the start straight');
  const c=r.cars[0];c.s=narrowS;c.lane=10;c.speed=20;
  stepRace(r,1/30);
  assert.ok(Math.abs(c.lane)<=halfWidthAt(c.s)-1+1e-9,'wall clamp follows local road width');
  useTrack('bay');
});

// ---- 2026-09-12 acceptance rework regressions ----
test('missile locks the nearest car ahead within forward range, across the seam and over lapping',()=>{
 const r=makeRace();r.phase='racing';settle(r);
 const [shooter,near,far]=r.cars;
 // Review reproduction: shooter s=100, cars ahead at 120 and 150 must lock 120.
 shooter.s=100;near.s=120;far.s=150;shooter.item='missile';
 for(const c of r.cars.slice(3))c.finish=1;
 useItem(r,shooter,r.time);
 assert.equal(r.entities.find(e=>e.kind==='missile').targetId,near.id,'nearest ahead wins, not best ranked');
 // Only an out-of-range car ahead: no lock.
 const r2=makeRace();r2.phase='racing';settle(r2);const [x,farOnly]=r2.cars;
 x.s=100;farOnly.s=100+MISSILE_LOCK_RANGE+5;x.item='missile';
 for(const c of r2.cars.slice(2))c.finish=1;
 useItem(r2,x,r2.time);
 assert.equal(r2.entities.find(e=>e.kind==='missile').targetId,null,'beyond range is not locked');
 // Finish-line seam: a target just past s=TRACK_LENGTH is ahead by forward distance.
 const r3=makeRace();r3.phase='racing';settle(r3);const [y,z]=r3.cars;
 y.s=TRACK_LENGTH-10;z.s=TRACK_LENGTH+10;y.item='missile';
 for(const c of r3.cars.slice(2))c.finish=1;
 useItem(r3,y,r3.time);
 assert.equal(r3.entities.find(e=>e.kind==='missile').targetId,z.id,'seam crossing locks forward');
 // Lapping: a car about to be lapped is still physically ahead and lockable.
 const r4=makeRace();r4.phase='racing';settle(r4);const [w,lapped]=r4.cars;
 w.s=2*TRACK_LENGTH+10;lapped.s=TRACK_LENGTH+30;w.item='missile';
 for(const c of r4.cars.slice(2))c.finish=1;
 useItem(r4,w,r4.time);
 assert.equal(r4.entities.find(e=>e.kind==='missile').targetId,lapped.id,'lapped car physically ahead is lockable');
});
test('last lap is announced once per car per race even when the whole grid crosses together',()=>{
 const r=makeRace();r.phase='racing';
 r.cars.forEach((c,i)=>{c.s=2*TRACK_LENGTH+1+i*6;c.lane=i%2?2.6:-2.6;c.speed=0;});
 stepRace(r,1/30);stepRace(r,1/30);
 assert.equal(r.highlights.filter(h=>h.type==='last_lap').length,8,'eight cars, eight events — never 16');
 for(let i=0;i<20;i++)stepRace(r,1/30);
 assert.equal(r.highlights.filter(h=>h.type==='last_lap').length,8,'no per-frame spam afterwards');
 const lapEvents=r.events.filter(e=>e.text==='进入最后一圈');
 assert.ok(new Set(lapEvents.map(e=>e.car)).size===lapEvents.length,'event feed holds at most one per car');
 assert.ok(r.cars.every(c=>c.lastLap),'per-car flag latched');
});
test('EMP jams the held nitro item exactly like the energy nitro',()=>{
 const r=makeRace();r.phase='racing';const c=r.cars[0];
 c.empUntil=r.time+10;c.item='boost';
 assert.equal(useItem(r,c,r.time),false,'jammed use rejected');
 assert.equal(c.item,'boost','item is not consumed while jammed');
 assert.ok(!r.highlights.some(h=>h.type==='item_use'),'a jammed use creates no director event');
 c.empUntil=r.time-1;
 assert.equal(useItem(r,c,r.time),true,'usable once the EMP ends');
 assert.equal(c.boost,1.7);
});
test('highlights carry stable increasing ids, ship the newest five and reset between races',()=>{
 const r=makeRace();r.phase='racing';settle(r);
 const [a,b]=r.cars;
 const bump=()=>{a.s=b.s=100;a.lane=.4;b.lane=0;a.speed=b.speed=30;a.incidentAt=r.time-4;stepRace(r,1/30);};
 for(let i=0;i<60;i++)bump();
 assert.ok(r.highlights.filter(h=>h.type==='car_collision').length>=10,'collision stream remains stable without per-frame spam');
 for(const h of r.highlights)assert.ok(Number.isSafeInteger(h.id)&&h.id>0,'every highlight has an id');
 for(let i=1;i<r.highlights.length;i++)assert.ok(r.highlights[i-1].id>r.highlights[i].id,'ids strictly decrease from newest');
 const s=snapshot(r);
 assert.equal(s.highlights.length,5,'snapshot ships the recent five');
 assert.equal(s.highlights[0].id,r.highlights[0].id,'newest event always first');
 const maxId=r.highlightId;
 startRace(r);
 assert.equal(r.highlights.length,0,'previous race feed wiped');
 assert.equal(snapshot(r).highlights.length,0,'snapshot is clean for the next race');
 r.phase='racing';bump();
 assert.ok(r.highlightId>maxId&&r.highlights[0].id>maxId,'ids keep increasing across races');
});
test('director: severity owns the camera, the shot floor delays a cut, finish always cuts, idle follows the leader',()=>{
 const r=makeRace();r.phase='racing';settle(r);
 for(const c of r.cars.slice(4))c.finish=1;
 const [a,b,c2,d]=r.cars;
 const park=(c,s,lane=0)=>{c.s=s;c.lane=lane;c.incidentAt=-Infinity;};
 park(a,200);a.speed=30;a.item='missile';
 park(b,240);b.speed=30;
 park(c2,60,.3);c2.speed=30;
 park(d,60,0);d.speed=30;
 useItem(r,a,r.time);
 assert.equal(r.shot,'aerial','a severity-3 launch opens on the aerial camera');
 const openedAt=r.shotAt;
 stepRace(r,1/30);
 assert.ok(r.highlights.some(h=>h.type==='car_collision'),'minor event recorded during the missile flight');
 assert.equal(r.focus,a.id,'a minor event cannot displace the launch inside its dwell');
 for(let i=0;i<42;i++)stepRace(r,1/30);
 assert.ok(r.highlights.some(h=>h.type==='missile_hit'),'missile landed');
 assert.equal(r.focus,a.id,'SHOT_FLOOR: a bigger event cannot cut inside the first 2 s');
 assert.equal(r.shot,'aerial');
 assert.equal(r.pendingShot?.type,'missile_hit','the blocked highlight waits instead of being dropped');
 assert.ok(r.time-openedAt<SHOT_FLOOR,'still inside the floor');
 for(let i=0;i<40;i++)stepRace(r,1/30);
 assert.ok(r.time-openedAt>=SHOT_FLOOR,'floor long gone');
 assert.equal(r.focus,b.id,'the queued major event owns the camera on the victim');
 assert.equal(r.shot,'aerial','event position uses the aerial camera');
 assert.ok(r.shotS!==null&&r.shotS>200,'aerial parked over the impact area');
 assert.equal(r.pendingShot,null,'the queue is consumed once it plays');
 // Age past every dwell, then let the victim take the flag.
 for(let i=0;i<240;i++)stepRace(r,1/30);
 r.focusUntil=0;stepRace(r,1/30);
 b.s=3*TRACK_LENGTH-2;b.speed=45;
 for(let i=0;i<6;i++)stepRace(r,1/30);
 assert.ok(b.finish!==null,'b finished');
 assert.equal(r.shot,'finish','the flag cuts to the finish camera even inside a floor');
 assert.equal(r.focus,b.id);
 // Idle: past every dwell with no events, the director returns to the leader.
 const r2=makeRace();r2.phase='racing';
 r2.cars.forEach((c,i)=>{c.human=true;c.connected=true;c.inputAt=-Infinity;c.s=i*(TRACK_LENGTH/8);c.lane=i%2?6.4:-6.4;c.speed=0;});
 for(let i=0;i<330;i++)stepRace(r2,1/30);
 const leader=[...r2.cars].sort((x,y)=>y.s-x.s)[0];
 assert.equal(r2.focus,leader.id,'idle director follows the leader');
 assert.equal(r2.focusReason,'领跑车手');
 assert.equal(r2.shot,'trackside');assert.ok(r2.shotS!==null,'idle TV station freezes a map position');
});
test('shot kind floor holds the angle while the subject still moves',()=>{
 const r=makeRace();r.phase='racing';settle(r);
 for(const c of r.cars.slice(4))c.finish=1;
 const [a,b,c2,d]=r.cars;
 const park=(c,s,lane=0)=>{c.s=s;c.lane=lane;c.incidentAt=-Infinity;};
 park(a,200);a.speed=0;park(b,240);b.speed=0;park(c2,60,.3);c2.speed=0;park(d,60,0);d.speed=0;
 stepRace(r,1/30);
 assert.ok(r.highlights.some(h=>h.type==='car_collision'),'a minor event opens the show');
 assert.equal(r.shot,'trackside','a low severity stays on an authored circuit camera');
 const kindAt=r.shotKindAt;
 const stationS=r.shotS;
 for(let i=0;i<74;i++)stepRace(r,1/30);
 assert.ok(r.time-r.shotAt>SHOT_FLOOR&&r.time-kindAt<SHOT_KIND_FLOOR,'inside the kind floor, past the shot floor');
 // Move the new story to another sector. The focus may change, but a physical
 // TV station must stay bolted to the previous corner until the kind floor ends.
 a.s=TRACK_LENGTH*.72;
 const fire=()=>{a.item='emp';a.useAt=-Infinity;a.empUntil=-Infinity;useItem(r,a,r.time);stepRace(r,1/30);};
 fire();
 assert.ok(r.highlights.some(h=>h.type==='item_use'),'a severity-3 event arrives');
 assert.equal(r.shot,'trackside','the authored circuit angle holds inside SHOT_KIND_FLOOR');
 assert.equal(r.shotS,stationS,'the physical trackside station anchor stays frozen while it pans');
 assert.equal(r.focus,a.id,'...while the subject still moves to the new event');
 assert.equal(r.shotKindAt,kindAt,'the kind clock did not restart');
 for(let i=0;i<30;i++)stepRace(r,1/30);
 assert.ok(r.time-kindAt>SHOT_KIND_FLOOR,'kind floor expired');
 r.focusUntil=0;r.shotAt=-Infinity;
 fire();
 assert.equal(r.shot,'aerial','the angle finally cuts once the floor expires');
});
test('duel bar forms on sustained proximity, survives a wobble and clears after the linger',()=>{
 const r=makeRace();r.phase='racing';
 r.cars.forEach((c,i)=>{c.human=true;c.connected=true;c.inputAt=-Infinity;c.speed=0;c.lane=i%2?6.4:-6.4;c.s=i*(TRACK_LENGTH/8);});
 const [a,b]=r.cars;
 a.s=300;a.lane=0;b.s=306;b.lane=.6;
 for(let i=0;i<10;i++)stepRace(r,1/30);
 assert.equal(r.duel,null,'no bar before the bout is sustained');
 for(let i=0;i<45;i++)stepRace(r,1/30);
 assert.ok(r.duel,'the bar appears after DUEL_HOLD');
 assert.equal(r.duel.a,0);assert.equal(r.duel.b,1);
 assert.equal(r.duel.ahead,b.id,'the car in front owns the lead side');
 assert.ok(Math.abs(r.duel.ratio)<1,'the tug-of-war ratio stays bounded');
 assert.ok(snapshot(r).duel,'the snapshot ships the duel');
 b.lane=3.2;
 stepRace(r,1/30);
 assert.ok(r.duel,'a wobble inside the break limits keeps the same bout');
 assert.equal(r.duel.b,1,'and the pairing is not restarted');
 b.lane=0;b.s=306+80;
 stepRace(r,1/30);
 assert.ok(r.duel,'the bar lingers after the fight breaks');
 for(let i=0;i<50;i++)stepRace(r,1/30);
 assert.equal(r.duel,null,'the bar clears after the linger');
 assert.equal(snapshot(r).duel,null,'and the snapshot drops it too');
});
test('result titles give every car exactly one award, by priority',()=>{
 const r=makeRace();r.phase='racing';settle(r);
 r.cars.forEach((c,i)=>{c.finish=1+i*.5;c.s=LAPS*TRACK_LENGTH-i;});
 r.cars[0].stats.hits=6;   // champion and top hitter: 冠军 wins the tie
 r.cars[1].stats.hits=4;   // best remaining hitter
 r.cars[2].stats.blocks=3;
 r.cars[3].stats.overtakes=5;
 r.cars[4].stats.boostOvertakes=3;
 r.cars[5].stats.pityPeak=4;
 for(let i=0;i<3;i++)stepRace(r,1/30);
 assert.equal(r.phase,'result');
 const byId=Object.fromEntries(r.awards.map(x=>[x.id,x]));
 assert.equal(r.awards.length,8,'one award entry per car');
 assert.equal(new Set(r.awards.map(x=>x.label)).size,7,'titles are spread, not swallowed');
 assert.equal(byId[0].label,'冠军','the winner keeps the champion title');
 assert.equal(byId[1].label,'道具大师');
 assert.equal(byId[2].label,'铁壁');
 assert.equal(byId[3].label,'超车狂魔');
 assert.equal(byId[4].label,'氮气狂徒');
 assert.equal(byId[5].label,'末路狂奔');
 assert.equal(byId[6].label,'稳步前行','no standout stat falls back to the default');
 assert.equal(byId[7].label,'稳步前行');
 for(const x of r.awards)assert.ok(x.label&&x.detail,'every title carries a label and a reason');
 assert.deepEqual(snapshot(r).awards,r.awards,'the snapshot ships the titles');
 startRace(r);
 assert.equal(r.awards.length,0,'titles reset with the next race');
 assert.equal(snapshot(r).awards.length,0,'and the snapshot clears them');
});
