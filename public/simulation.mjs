// Pilot protocol v1: the server alone owns progress, collisions, energy, items and results.
export const TAU = Math.PI * 2;
export const WIDTH = 15;
export const LAPS = 3;
export const CAPACITY = 8;
export const COLORS = ['#ff6748','#40d9e4','#fbd05a','#a794ff','#ff86bd','#9dda69','#639dff','#faf3df'];
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const wrap = (x, n) => ((x % n) + n) % n;
// Item rules. Pickup windows are measured against race.time (one timeline everywhere).
// Six-piece kit: missile / mine / emp / shield / boost / tractor.
export const ITEM_DEFS = {
  missile: {label:'脉冲飞弹', category:'attack', cooldown:1.5, icon:'➤'},
  mine:    {label:'泡沫地雷', category:'attack', cooldown:1.5, icon:'✸'},
  emp:     {label:'电磁风暴', category:'attack', cooldown:1.5, icon:'⚡'},
  shield:  {label:'能量护盾', category:'defense', cooldown:2, icon:'⛨'},
  boost:   {label:'超级氮气', category:'motion', cooldown:1.5, icon:'»'},
  tractor: {label:'引力牵引', category:'motion', cooldown:1.5, icon:'◎'},
};
export const ITEM_IDS = Object.keys(ITEM_DEFS);
export const ITEM_BOXES = 10;
export const ITEM_BOX_OFFSETS = [31, 85, 139, 193, 247, 301, 355, 409, 463, 517];
export const ITEM_BOX_LANES = [-2.6, 2.6];
export const ITEM_BOX_RESPAWN = 8;
export const MISSILE_SPEED = 62;
export const MISSILE_LIFE = 2.6;
export const MISSILE_LOCK_RANGE = 55;
export const MISSILE_LOCK_GAP = 12;
export const MINE_RADIUS = 2.4;
export const MINE_LIFE = 45;
export const EMP_RADIUS = 11;
export const EMP_DURATION = 2.2;
export const SHIELD_DURATION = 3;
export const SLOW_DURATION = 1.6;
export const SPIN_DURATION = 1.2;
export const JUMP_DURATION = 1.4;
export const JUMP_HEIGHT = 1.5;
export const SMOKE_DURATION = 4;
export const SMOKE_RADIUS = 10;
export const ITEM_BOX_RADIUS = 2.2;
export const TRACTOR_DURATION = 1.5;
export const PERFECT_BLOCK_WINDOW = 0.6;
export const PERFECT_BLOCK_ENERGY = 15;
// Drift release has two readable tiers. Charge grows fastest while the car is
// actually loaded in a bend, so sawing across a straight is a poor substitute
// for learning the track.
export const DRIFT_MINI_THRESHOLD = 0.55;
export const DRIFT_MINI_CHARGE = 0.22;
export const DRIFT_MINI_BOOST = 0.8;
export const DRIFT_PERFECT_THRESHOLD = 1.15;
export const DRIFT_PERFECT_CHARGE = 0.72;
export const DRIFT_PERFECT_BOOST = 1.05;
// Hit guard: a short immunity after missile/mine hits, blocks chain stuns.
export const GUARD_DURATION = 1.0;
// Camera pacing. A shot is never cut before SHOT_FLOOR has been on screen; a
// shot *type* (follow/aerial/finish) additionally holds SHOT_KIND_FLOOR so the
// broadcast pans instead of strobing between angles. Crossing the line is
// exempt: the flag is the one moment that always cuts through.
export const SHOT_FLOOR = 2.0;
export const SHOT_KIND_FLOOR = 3.0;
// Duel bar. Two cars duel when they hold the same patch of road: the bout needs
// DUEL_HOLD of sustained proximity to appear, tolerates the looser BREAK limits
// without restarting, and lingers DUEL_LINGER after the fight breaks so the bar
// cannot flicker on a single frame of separation.
export const DUEL_GAP = 22;
export const DUEL_LANE = 2.2;
export const DUEL_HOLD = 1.2;
export const DUEL_BREAK = 30;
export const DUEL_LANE_BREAK = 3.5;
export const DUEL_LINGER = 1.5;
// Result-screen titles. Exactly one per finisher; unique titles are granted by
// priority so the loudest stat owns the award.
export const TITLES = {
  champion: {label:'冠军'},
  item_master: {label:'道具大师'},
  iron_wall: {label:'铁壁'},
  overtake_king: {label:'超车狂魔'},
  nitro_freak: {label:'氮气狂徒'},
  last_stand: {label:'末路狂奔'},
  steady: {label:'稳步前行'},
};
// Catalogue of director highlight types recorded by the server.
export const HIGHLIGHT_TYPES = ['overtake','overtaken','overtake_after_boost','missile_hit','shield_block','mine_hit','last_lap','finish_line','car_collision','item_use'];
// Rendering and touch use the same logical landscape surface, even inside a
// browser that keeps a portrait viewport. Spectators retain their actual aspect.
export function landscapeSurface(width, height, spectator = false) {
  const rotated = !spectator && height > width;
  return { width: rotated ? height : width, height: rotated ? width : height, rotated };
}
export function surfaceDelta(dx, dy, rotated) {
  return rotated ? {x:dy, y:-dx} : {x:dx, y:dy};
}
// Track catalogue. Shape is a Fourier ribbon (x/z harmonics of the lap angle);
// width is a base half-width plus periodic cosine bumps (narrow hairpins,
// wide start straight). Coefficients were validated numerically: no
// self-intersection, lap length 700-860, inside the island scenery.
export const TRACKS = {
  bay: {
    id: 'bay', name: '海湾环线', title: 'BAY GRAND PRIX',
    cx: { 1: 136, 3: 24, 5: -2.5 }, cz: { 1: 94, 2: 20, 4: 3.2 },
    halfW: { base: 7.5, bumps: [] },
    marks: {
      bridge: [0.2170395605131668, 0.28725824185566196],
      tunnel: { from: 0.4851472529117846, to: 0.5617494507399612, step: 5 },
      lighthouse: { s: 0.09958285717662947, lane: -34 },
    },
  },
  ridge: {
    id: 'ridge', name: '山脊赛道', title: 'RIDGE GRAND PRIX',
    // Hand-laid loop (hairpin NE, esses W): closed Catmull-Rom through 20
    // control points, fitted to harmonics. [cos, sin] pairs per k.
    cx: { 1: [-14.73, 125.56], 2: [6.88, 16.07], 3: [-5.55, 11.05], 4: [-0.74, 1.2], 5: [1.97, 0.85], 6: [-0.43, -3.11], 7: [-1.43, -3.29], 8: [-1.82, 1.77], 9: [-0.01, 1.59], 10: 1.58, 11: [0, -0.99], 12: [-0.7, -0.68] },
    cz: { 1: [-73.98, 4.66], 2: [-13.91, 14.66], 3: [-1.79, -15.58], 4: [6.62, 3.5], 5: [-2.63, -2.35], 6: [3, -1.17], 7: [-0.48, 1.19], 8: [0.47, -0.67], 9: [0.43, 0.66], 10: [0.05, 0], 11: [0.27, -0.41], 12: [0.18, 0.25] },
    // Mountain profile: low start, high hairpin/esses. Visual only.
    ey: {
      base: 4.5,
      bumps: [
        { at: 0.33, w: 0.15, height: 16 },
        { at: 0.75, w: 0.2, height: 6 },
      ],
    },
    halfW: {
      base: 7.5,
      bumps: [
        { at: 0.29, w: 0.06, depth: -3.3 },
        { at: 0.40, w: 0.05, depth: -3.3 },
        { at: 0.0, w: 0.08, depth: 2.0 },
        { at: 0.60, w: 0.08, depth: -1.5 },
        { at: 0.85, w: 0.08, depth: -1.5 },
      ],
    },
    marks: {
      bridge: [0.06, 0.11],
      tunnel: { from: 0.68, to: 0.78, step: 5 },
      lighthouse: { x: 150, y: 0.7, z: 0 },
    },
  },
};
export const TRACK_IDS = Object.keys(TRACKS);
let activeTrack = TRACKS.bay;
let samples = [];
let distance = [];
export let TRACK_LENGTH = 0;
function buildTrackData() {
  const cfg = activeTrack;
  // Harmonic term: legacy number = cos-only (x) / sin-only (z);
  // [cos, sin] pair = full phase (ridge).
  const termX = (v, k, a) => typeof v === 'number' ? v * Math.cos(k * a) : v[0] * Math.cos(k * a) + v[1] * Math.sin(k * a);
  const termZ = (v, k, a) => typeof v === 'number' ? v * Math.sin(k * a) : v[0] * Math.cos(k * a) + v[1] * Math.sin(k * a);
  const bumpY = (t) => {
    let y = cfg.ey.base;
    for (const b of cfg.ey.bumps) {
      let d = Math.abs(t - b.at);
      d = Math.min(d, 1 - d);
      if (d < b.w) y += b.height * Math.pow(Math.cos(Math.PI / 2 * d / b.w), 2);
    }
    return y;
  };
  const point = (t) => {
    const a = t * TAU;
    let x = 0, z = 0;
    for (const [k, v] of Object.entries(cfg.cx)) x += termX(v, Number(k), a);
    for (const [k, v] of Object.entries(cfg.cz)) z += termZ(v, Number(k), a);
    return {
      x,
      y: cfg.ey ? bumpY(t) : 4.5 + 8 * Math.pow((1 + Math.sin(a)) / 2, 2.5) + 3 * Math.sin(3 * a),
      z,
    };
  };
  samples = Array.from({ length: 1025 }, (_, i) => point(i / 1024));
  distance = [0];
  for (let i = 1; i < samples.length; i++) distance.push(distance[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z));
  TRACK_LENGTH = distance.at(-1);
}
buildTrackData();
/** Switch the active track shape. Returns false for unknown ids. */
export function useTrack(id) {
  const cfg = TRACKS[id];
  if (!cfg) return false;
  activeTrack = cfg;
  buildTrackData();
  return true;
}
export function currentTrackId() { return activeTrack.id; }
export function currentTrackTitle() { return activeTrack.title; }
/** Landmark placement for the active track (fractions of lap, or fixed point). */
export function currentMarks() { return activeTrack.marks; }
/** Half road width at arc position s (smooth, periodic). */
export function halfWidthAt(s) {
  const t = wrap(s, TRACK_LENGTH) / TRACK_LENGTH;
  let hw = activeTrack.halfW.base;
  for (const b of activeTrack.halfW.bumps) {
    let d = Math.abs(t - b.at);
    d = Math.min(d, 1 - d);
    if (d < b.w) hw += b.depth * Math.pow(Math.cos(Math.PI / 2 * d / b.w), 2);
  }
  return hw;
}
export function trackAt(s, lane = 0) {
  s = wrap(s, TRACK_LENGTH);
  let lo = 0, hi = 1024;
  while (hi-lo > 1) { const m = (lo+hi)>>1; if (distance[m] <= s) lo = m; else hi = m; }
  const a = samples[lo], b = samples[hi], t = (s-distance[lo])/(distance[hi]-distance[lo]);
  const dx = b.x-a.x, dz = b.z-a.z, len = Math.hypot(dx,dz);
  return { x: a.x+(b.x-a.x)*t - dz/len*lane, y: a.y+(b.y-a.y)*t, z: a.z+(b.z-a.z)*t+dx/len*lane, yaw: Math.atan2(dx,dz) };
}
// Positive lane is screen-right when the driver looks along the track tangent.
export function joystickInput(dx, dy, radius) {
  if (![dx,dy,radius].every(Number.isFinite) || radius <= 0) return {x:0,y:0,steer:0};
  const length=Math.hypot(dx,dy), ratio=length>radius?radius/length:1;
  const x=dx*ratio, y=dy*ratio, normalized=x/radius;
  const steer=Math.abs(normalized)<.08?0:Math.sign(normalized)*(Math.abs(normalized)-.08)/.92;
  return {x,y,steer};
}
export function newCar(id) {
  return { id, name: `车手 ${String(id+1).padStart(2,'0')}`, human: false, connected: false, ready: false,
    s: Math.floor(id/2)*-5 || 0, lane: id%2 ? 2.6 : -2.6, speed: 0, lateral: 0,
    energy: 35, boost: 0, drift: false, finish: null, seq: -1, inputAt: -Infinity,
    steer: 0, steerSm: 0, heldDrift: false, brake: false, boostQueued: false, incidentAt: -Infinity,
    item: null, useAt: -Infinity, slowUntil: -Infinity, slowSpinUntil: -Infinity,
    empUntil: -Infinity, shieldUntil: -Infinity, spinUntil: -Infinity, spinAge: 0,
    jumpUntil: -Infinity, itemEventAt: -Infinity, misfireAt: -Infinity, lastLap: false,
    tractorUntil: -Infinity, tractorTarget: null, trailPity: 0,
    driftTime: 0, driftCharge: 0, guardUntil: -Infinity,
    // Per-race award counters; reset with the car, read by computeAwards.
    stats: { hits:0, blocks:0, overtakes:0, boostOvertakes:0, pityPeak:0 },
    aiNextUseAt: -Infinity };
}
function raceConfig(options = {}) {
  const laps = Number(options.laps);
  const seconds = Number(options.seconds);
  return {
    laps: Number.isInteger(laps) ? clamp(laps, 1, 10) : LAPS,
    seconds: Number.isFinite(seconds) ? clamp(seconds, 30, 300) : 90,
  };
}
export function makeRace(trackId = 'bay', options = {}) {
  useTrack(TRACKS[trackId] ? trackId : 'bay');
  const config = raceConfig(options);
  return { trackId: activeTrack.id, laps: config.laps, seconds: config.seconds, cars: Array.from({length:CAPACITY},(_,id)=>newCar(id)), phase:'demo', time:0, remaining:config.seconds, round:0, phaseLeft:0, events:[], eventId:0, focus:0, focusReason:'赛道巡游', focusUntil:0,
    focusSeverity:0, shot:'follow', shotS:null, shotAt:-Infinity, shotKindAt:-Infinity, pendingShot:null,
    duel:null, duelKey:'', duelSince:0, duelUntil:0, duelFlash:0, awards:[],
    highlights:[], highlightId:0,
    boxes:Array.from({length:ITEM_BOXES},(_,i)=>({id:i,slot:i,lane:ITEM_BOX_LANES[i%2],item:0,respawnAt:-Infinity})),
    entities:[], entityId:0, tick:0 };
}
// Wipe every director/camera decision that belongs to a single race. highlightId
// deliberately survives: ids must keep increasing across races so clients never
// mistake a fresh event for a replay of the previous one.
export function resetDirector(race) {
  race.highlights=[];
  race.focus=0; race.focusUntil=0; race.focusSeverity=0;
  race.shot='follow'; race.shotS=null; race.shotAt=-Infinity; race.shotKindAt=-Infinity; race.pendingShot=null;
  race.duel=null; race.duelKey=''; race.duelSince=0; race.duelUntil=0; race.duelFlash=0;
  race.awards=[];
}
export function openLobby(race) {
  race.phase='lobby'; race.phaseLeft=0; race.remaining=race.seconds; race.events=[];
  resetDirector(race); race.focusReason='发车集结区';
  for (const car of race.cars) {
    const s = Math.floor(car.id / 2) * -6 || 0;
    const lane = car.id % 2 ? 2.6 : -2.6;
    Object.assign(car, newCar(car.id), { name: car.name, human: car.human, connected: car.connected, ready: false, s, lane, speed: 0, lateral: 0 });
  }
  for (const box of race.boxes) box.respawnAt=-Infinity;
  race.entities=[];
}
export function startRace(race) {
  race.round++; race.phase='countdown'; race.phaseLeft=4; race.remaining=race.seconds; race.events=[];
  // New race: wipe the last race's director feed and result titles.
  resetDirector(race); race.focusReason='发车准备';
  for (const car of race.cars) Object.assign(car, newCar(car.id), {name:car.name, human:car.human, connected:car.connected, ready: true});
  for (const box of race.boxes) box.respawnAt=-Infinity;
  race.entities=[];
}
function emit(race, car, text, priority=1) {
  race.events.unshift({id:++race.eventId, car:car.id, text, time:race.time, priority});
  race.events.length=Math.min(race.events.length,6);
}
const SHOT_LABELS={overtake:'超车时刻',overtaken:'被超车',overtake_after_boost:'氮气超车',missile_hit:'导弹命中',shield_block:'护盾格挡',mine_hit:'地雷命中',last_lap:'最后一圈',finish_line:'冲线时刻',car_collision:'并排争夺',item_use:'道具交锋'};
// Point the camera. Both pacing floors apply unless `urgent` (crossing the line
// must never wait): a shot-type change inside SHOT_KIND_FLOOR keeps the current
// angle while still moving the subject, so the broadcast pans rather than
// strobing between follow/aerial/finish.
function setShot(race,{focus,reason,severity,kind,shotS,until,urgent=false}){
  if(!urgent&&race.time-race.shotAt<SHOT_FLOOR)return false;
  let k=kind;
  if(k!==race.shot&&!urgent&&race.time-race.shotKindAt<SHOT_KIND_FLOOR)k=race.shot;
  // The first shot after a reset starts the kind clock even when the angle does
  // not change, so a reset race is not treated as an infinitely old shot.
  if(k!==race.shot||!Number.isFinite(race.shotKindAt))race.shotKindAt=race.time;
  race.shot=k; race.shotAt=race.time;
  race.focus=focus; race.focusReason=reason; race.focusSeverity=severity; race.focusUntil=until;
  race.shotS=k==='aerial'?Math.round(clamp(shotS??race.cars[focus].s,0,Infinity)):null;
  return true;
}
// Play one highlight. Attack outcomes own the victim's car; everything else owns
// the actor's.
function applyHighlight(race,h){
  const actor=h.actorId!==null?race.cars[h.actorId]:null;
  if(!actor)return;
  const victim=h.targetId!==null?race.cars[h.targetId]:null;
  const impact=victim&&(h.type==='missile_hit'||h.type==='mine_hit'||h.type==='shield_block');
  const star=impact?victim:actor;
  setShot(race,{focus:star.id,reason:SHOT_LABELS[h.type]??'精彩瞬间',severity:h.severity,
    kind:h.type==='finish_line'?'finish':(h.severity>=3?'aerial':'follow'),
    shotS:star.s,until:race.time+3+h.severity,urgent:h.type==='finish_line'});
}
// Director arbitration. A highlight claims the camera for a severity-scaled
// minimum stay; only a strictly higher severity may cut in early, and never
// before SHOT_FLOOR has elapsed. A blocked highlight is delayed, not dropped:
// the biggest one waits in `pendingShot` and plays when the floor expires.
function direct(race,h){
  if(h.actorId===null||h.actorId===undefined||!race.cars[h.actorId])return;
  if(race.time<race.focusUntil&&h.severity<=race.focusSeverity)return;
  if(h.type!=='finish_line'&&race.time-race.shotAt<SHOT_FLOOR){
    if(!race.pendingShot||h.severity>race.pendingShot.severity)race.pendingShot=h;
    return;
  }
  applyHighlight(race,h);
}
export function flushPendingShot(race){
  const h=race.pendingShot;
  if(!h||race.time-race.shotAt<SHOT_FLOOR)return;
  race.pendingShot=null;
  if(race.time<race.focusUntil&&h.severity<=race.focusSeverity)return;
  applyHighlight(race,h);
}
// Director highlight: a server-judged memorable moment, severity 1-5.
// Shapes mirror the product spec: {id,type,timestamp,actorId,targetId,position,severity}.
function highlight(race, type, actor, target=null, severity=1) {
  const position = actor ? Math.round(clamp(actor.s,0,Infinity)) : null;
  const h={ id:++race.highlightId, type, timestamp: Math.round(race.time*1000)/1000, actorId: actor?actor.id:null, targetId: target?target.id:null,
    position, severity };
  race.highlights.unshift(h);
  race.highlights.length=Math.min(race.highlights.length,20);
  direct(race,h);
}
// Duel detection with hysteresis. A live pair is kept while it stays inside the
// looser BREAK limits (so a brief wobble does not end the bar), a fresh pair has
// to earn its way in through DUEL_GAP/DUEL_LANE, and the winner of the exchange
// is whoever leads on the ribbon right now.
function updateDuel(race){
  const now=race.time;
  // Demo counts: the attract loop is the big screen's shopfront, so a duel in
  // the AI patrol is worth showing too. Lobby/countdown/result never duel.
  const running=race.phase==='racing'||race.phase==='demo';
  const gapOf=(a,b)=>Math.abs(wrap(a.s-b.s+TRACK_LENGTH/2,TRACK_LENGTH)-TRACK_LENGTH/2);
  const laneOf=(a,b)=>Math.abs(a.lane-b.lane);
  if(!running){race.duel=null;race.duelKey='';return;}
  let pick=null;
  if(race.duel){
    const a=race.cars[race.duel.a],b=race.cars[race.duel.b];
    if(a.finish===null&&b.finish===null&&gapOf(a,b)<=DUEL_BREAK&&laneOf(a,b)<=DUEL_LANE_BREAK)pick={i:race.duel.a,j:race.duel.b};
  }
  if(!pick){
    let bestGap=Infinity;
    for(let i=0;i<CAPACITY;i++)for(let j=i+1;j<CAPACITY;j++){
      const a=race.cars[i],b=race.cars[j];
      if(a.finish!==null||b.finish!==null)continue;
      const gap=gapOf(a,b);
      if(gap>DUEL_GAP||laneOf(a,b)>DUEL_LANE)continue;
      if(gap<bestGap){bestGap=gap;pick={i,j};}
    }
  }
  if(!pick){
    // Nobody is close any more: hold the last duel on screen for a beat, then drop it.
    if(race.duel&&now>=race.duelUntil){race.duel=null;race.duelKey='';}
    return;
  }
  const key=`${pick.i}-${pick.j}`;
  if(key!==race.duelKey){race.duelKey=key;race.duelSince=now;race.duelFlash=0;race.duel=null;}
  const a=race.cars[pick.i],b=race.cars[pick.j];
  const ahead=a.s>=b.s?pick.i:pick.j;
  if(race.duel&&race.duel.ahead!==ahead)race.duelFlash=now;
  race.duelUntil=now+DUEL_LINGER;
  if(now-race.duelSince<DUEL_HOLD)return;
  race.duel={a:pick.i,b:pick.j,ahead,flash:race.duelFlash,ratio:clamp((a.s-b.s)/DUEL_GAP,-1,1)};
}
// Result titles: exactly one per car. Unique titles go to the best qualifying
// car, scanning the finishing order so ties favour the better finisher.
export function computeAwards(race){
  const order=ranking(race);
  const awards=race.cars.map(c=>({id:c.id,key:'steady',label:TITLES.steady.label,detail:'稳稳跑完全程'}));
  const taken=new Set();
  const give=(id,key,detail)=>{
    if(id===null||id===undefined||taken.has(id))return;
    taken.add(id);
    awards[id]={id,key,label:TITLES[key].label,detail};
  };
  const best=(score,min,key,text)=>{
    let win=null;
    // Already-titled cars are out of the running, so a driver who won 冠军 with
    // the biggest hit count does not swallow 道具大师 as well.
    for(const c of order){if(taken.has(c.id))continue;const v=score(c);if(v>=min&&(!win||v>win.value))win={id:c.id,value:v};}
    if(win)give(win.id,key,text(win.value));
  };
  give(order[0].id,'champion','第一个冲过终点');
  best(c=>c.stats.hits,3,'item_master',v=>`道具命中 ${v} 次`);
  best(c=>c.stats.blocks,2,'iron_wall',v=>`成功格挡 ${v} 次`);
  best(c=>c.stats.overtakes,3,'overtake_king',v=>`完成超车 ${v} 次`);
  best(c=>c.stats.boostOvertakes,2,'nitro_freak',v=>`氮气超车 ${v} 次`);
  best(c=>c.stats.pityPeak,2,'last_stand',v=>`末名坚持 ${v} 次`);
  return awards;
}
export function ranking(race) {
  return [...race.cars].sort((a,b) => {
    if (a.finish!==null || b.finish!==null) return (a.finish??Infinity)-(b.finish??Infinity);
    return b.s-a.s;
  });
}
export function applyInput(car, message, now) {
  if (!Number.isSafeInteger(message.seq) || message.seq <= car.seq || !Number.isFinite(message.steer)
      || Math.abs(message.steer)>1 || typeof message.drift!=='boolean' || typeof message.boost!=='boolean' || typeof message.brake!=='boolean') return false;
  car.seq=message.seq; car.inputAt=now; car.steer=message.steer; car.heldDrift=message.drift; car.brake=message.brake;
  car.boostQueued ||= message.boost;
  return true;
}
// Server-authoritative item use; the client only asks, never decides the result.
export function useItem(race, car, now) {
  if ((race.phase !== 'racing' && race.phase !== 'demo') || car.finish !== null || !car.item) return false;
  if (now - car.useAt < ITEM_DEFS[car.item].cooldown) return false;
  // EMP jams every nitro source alike; the held item obeys the same rule as the
  // energy nitro and is not consumed while jammed.
  if (car.item==='boost'&&race.time<car.empUntil) {emit(race,car,'电磁干扰 · 氮气无法使用',1);return false;}
  car.useAt=now; car.itemEventAt=now;
  const kind=car.item;
  if (kind==='shield') {
    car.shieldUntil=now+SHIELD_DURATION;
    emit(race,car,'护盾展开',2); highlight(race,'item_use',car,null,1);
  } else if (kind==='boost') {
    car.boost=Math.max(car.boost,1.7);
    emit(race,car,'超级氮气加速',2); highlight(race,'item_use',car,null,1);
  } else if (kind==='tractor') {
    // Tractor grapple: lock the nearest car ahead like a missile, then dash
    // with magnetic lane homing. Fired blind it is only a weak boost.
    let target=null,bestGap=Infinity;
    for(const c of race.cars){
      if(c.finish!==null||c.id===car.id)continue;
      const gap=wrap(c.s-car.s+TRACK_LENGTH/2,TRACK_LENGTH)-TRACK_LENGTH/2;
      if(gap>=MISSILE_LOCK_GAP&&gap<=MISSILE_LOCK_RANGE&&gap<bestGap){bestGap=gap;target=c;}
    }
    if (target) {
      car.boost=Math.max(car.boost,1.4);
      car.tractorUntil=now+TRACTOR_DURATION; car.tractorTarget=target.id;
      emit(race,car,`牵引锁定 ${target.name}`,3);
      highlight(race,'item_use',car,target,2);
    } else {
      car.boost=Math.max(car.boost,1.0);
      emit(race,car,'牵引小喷',2); highlight(race,'item_use',car,null,1);
    }
  } else if (kind==='missile') {
    // Lock the nearest car physically ahead on the ribbon, measured as the
    // signed forward distance around the loop; only cars inside
    // [MISSILE_LOCK_GAP, MISSILE_LOCK_RANGE] qualify. Lapping is irrelevant:
    // a car about to be lapped is still physically in front and lockable.
    let target=null,bestGap=Infinity;
    for(const c of race.cars){
      if(c.finish!==null||c.id===car.id)continue;
      const gap=wrap(c.s-car.s+TRACK_LENGTH/2,TRACK_LENGTH)-TRACK_LENGTH/2;
      if(gap>=MISSILE_LOCK_GAP&&gap<=MISSILE_LOCK_RANGE&&gap<bestGap){bestGap=gap;target=c;}
    }
    race.entities.push({id:++race.entityId,kind:'missile',owner:car.id,s:car.s+4,lane:car.lane,alive:true,bornAt:now,life:MISSILE_LIFE,speed:MISSILE_SPEED,targetId:target?target.id:null});
    emit(race,car,target?`脉冲飞弹锁定 ${target.name}`:'脉冲飞弹发射',3);
    highlight(race,'item_use',car,target,3);
  } else if (kind==='mine') {
    race.entities.push({id:++race.entityId,kind:'mine',owner:car.id,s:car.s-4,lane:car.lane,alive:true,bornAt:now,life:MINE_LIFE,speed:0,targetId:null});
    emit(race,car,'布下泡沫地雷',2); highlight(race,'item_use',car,null,1);
  } else if (kind==='emp') {
    race.entities.push({id:++race.entityId,kind:'emp',owner:car.id,s:car.s+4,lane:car.lane,alive:true,bornAt:now,life:.45,speed:car.speed+14,targetId:null});
    emit(race,car,'电磁风暴释放',3); highlight(race,'item_use',car,null,3);
  }
  car.item=null;
  return true;
}
// Lateral grip: corners have a speed limit v=sqrt(grip/|kappa|). Over it the
// tyres scrub speed off; drifting raises the cap, so the fast line through a
// hairpin is brake-then-drift, not flat out.
export const GRIP_LIMIT = 90;
export const DRIFT_GRIP_BONUS = 1.5;
export const GRIP_SCRUB = 28;
// Static traffic pylons: indestructible track furniture. Positions are a pure
// function of the track so client and server always agree (see pylonAt).
export const PYLON_COUNT = 7;
export function pylonAt(k) {
  const s = k / 8 * TRACK_LENGTH, hw = halfWidthAt(s);
  return { s, lane: (k % 2 ? 1 : -1) * Math.max(1.5, hw - 1.2) };
}
export function cornerCurvature(s) {
  const a = trackAt(s - 3, 0).yaw, b = trackAt(s + 3, 0).yaw;
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d / 6;
}
// An offset lane has a different real path length from the centre line. This
// bounded factor rewards holding the inside of a bend without turning the
// lane system into an extreme shortcut on very tight sampled corners.
export function racingLineFactor(s, lane) {
  const curvature = cornerCurvature(s);
  const bend = clamp(Math.abs(curvature) * 40, 0, 1);
  const offsetMetric = Math.max(0.5, 1 + curvature * lane);
  const geometric = clamp(1 / offsetMetric, 0.88, 1.12);
  return 1 + (geometric - 1) * bend;
}

export function driftStage(car) {
  if (car.driftTime >= DRIFT_PERFECT_THRESHOLD && car.driftCharge >= DRIFT_PERFECT_CHARGE) return 2;
  if (car.driftTime >= DRIFT_MINI_THRESHOLD && car.driftCharge >= DRIFT_MINI_CHARGE) return 1;
  return 0;
}

function driftChargeRate(car, steer) {
  const steering = clamp((Math.abs(steer) - 0.08) / 0.92, 0, 1);
  // Ignore the tiny curvature noise present on a sampled straight. Once
  // lateral acceleration becomes meaningful the meter fills rapidly.
  const lateralLoad = Math.abs(cornerCurvature(car.s)) * Math.max(12, car.speed);
  const cornerLoad = clamp((lateralLoad - 0.12) / 0.55, 0, 1);
  return steering * (0.08 + 0.92 * cornerLoad);
}
function blockedByShield(race, victim) { return race.time<victim.shieldUntil; }
function blockedByGuard(race, victim) { return race.time<victim.guardUntil; }
function slowCar(race, car, now, spin=false) {
  car.slowUntil=now+SLOW_DURATION;
  if (spin) { car.spinUntil=now+SPIN_DURATION; car.spinAge=0; }
  car.boost=Math.min(car.boost,.4);
}
function guardCar(race, car, now) { car.guardUntil=now+GUARD_DURATION; }
function slowFactor(car, now) { return now<car.slowUntil?.4:1; }
function dollySlowFactor(car, now) { return now<car.slowSpinUntil?.5:1; }
// Perfect block: shield raised within the window before impact refunds energy.
// Call BEFORE consuming the shield (shieldUntil still holds the expiry).
function perfectBlock(race, victim, now) {
  const raisedAt = victim.shieldUntil - SHIELD_DURATION;
  if (now - raisedAt > PERFECT_BLOCK_WINDOW) return false;
  emit(race, victim, '完美格挡！', 4);
  return true;
}
function applyMissileHit(race, missile, victim, now) {
  missile.alive=false;
  if (blockedByShield(race,victim)) {
    const perfect = perfectBlock(race, victim, now);
    victim.shieldUntil=now; victim.itemEventAt=now; victim.stats.blocks++;
    if (perfect) victim.energy = clamp(victim.energy + PERFECT_BLOCK_ENERGY, 0, 100);
    emit(race,victim,perfect?'完美格挡导弹！':'护盾格挡导弹',4); highlight(race,'shield_block',victim,null,3);
    emit(race,race.cars[missile.owner],`${victim.name} 护盾格挡了导弹`,1);
    return true;
  }
  if (blockedByGuard(race,victim)) {
    victim.itemEventAt=now;
    emit(race,victim,'受击保护 · 伤害豁免',1);
    return true;
  }
  victim.itemEventAt=now; slowCar(race,victim,now); victim.speed=Math.min(victim.speed,6); guardCar(race,victim,now);
  race.cars[missile.owner].stats.hits++;
  emit(race,victim,'被导弹击中',4); highlight(race,'missile_hit',race.cars[missile.owner],victim,4);
  return false;
}
function applyMineHit(race, mine, victim, now) {
  mine.alive=false;
  if (blockedByShield(race,victim)) {
    const perfect = perfectBlock(race, victim, now);
    victim.shieldUntil=now; victim.itemEventAt=now; victim.stats.blocks++;
    if (perfect) victim.energy = clamp(victim.energy + PERFECT_BLOCK_ENERGY, 0, 100);
    emit(race,victim,perfect?'完美格挡地雷！':'护盾挡下地雷',4); highlight(race,'shield_block',victim,null,3);
    emit(race,race.cars[mine.owner],`${victim.name} 护盾挡下了地雷`,1);
    return true;
  }
  if (blockedByGuard(race,victim)) {
    victim.itemEventAt=now;
    emit(race,victim,'受击保护 · 伤害豁免',1);
    return true;
  }
  victim.itemEventAt=now; slowCar(race,victim,now,true); guardCar(race,victim,now);
  race.cars[mine.owner].stats.hits++;
  emit(race,victim,'触发地雷',4); highlight(race,'mine_hit',race.cars[mine.owner],victim,3);
  return false;
}
function updateEntities(race, dt) {
  const now=race.time;
  for (const e of race.entities) {
    if (!e.alive) continue;
    if (e.kind==='missile') {
      if (e.targetId!==null) {
        const t=race.cars[e.targetId];
        if (t.finish===null) e.lane+=(clamp(t.lane,-6.5,6.5)-e.lane)*Math.min(1,dt*7);
      }
      e.s+=e.speed*dt;
      for (const c of race.cars) {
        if (c.finish!==null||c.id===e.owner||c.jumpUntil>now) continue;
        if (Math.abs(wrap(e.s-c.s+TRACK_LENGTH/2,TRACK_LENGTH)-TRACK_LENGTH/2)<1.8&&Math.abs(e.lane-c.lane)<1.4) {
          if(!applyMissileHit(race,e,c,now)) emit(race,c,'导弹命中',4); break;
        }
      }
    } else if (e.kind==='mine') {
      for (const c of race.cars) {
        if (c.finish!==null||c.id===e.owner||c.jumpUntil>now) continue;
        if (Math.abs(wrap(e.s-c.s+TRACK_LENGTH/2,TRACK_LENGTH)-TRACK_LENGTH/2)<MINE_RADIUS&&Math.abs(e.lane-c.lane)<1.5) {
          if(!applyMineHit(race,e,c,now)) emit(race,c,'地雷命中',4); break;
        }
      }
    } else if (e.kind==='emp') {
      e.s+=e.speed*dt;
      for (const c of race.cars) {
        if (c.finish!==null||c.id===e.owner) continue;
        if (Math.abs(wrap(e.s-c.s+TRACK_LENGTH/2,TRACK_LENGTH)-TRACK_LENGTH/2)<EMP_RADIUS&&Math.abs(e.lane-c.lane)<7) {
          c.empUntil=now+EMP_DURATION; c.itemEventAt=now; c.boost=Math.min(c.boost,.4);
        }
      }
    }
    e.life-=dt;
    if (e.life<=0) e.alive=false;
  }
  race.entities=race.entities.filter(e=>e.alive||race.time-e.bornAt<1.2);
  if (race.entities.length>96) race.entities=race.entities.slice(-96);
}
// Rank-weighted item pools. Leaders get defense/mild tools, the back gets
// chase and attack, last place builds pity toward tractor/boost.
export function rollPickup(race, car) {
  const order = ranking(race).filter(c => c.finish === null);
  const pos = order.findIndex(c => c.id === car.id);
  const last = pos === order.length - 1 && order.length > 1;
  car.trailPity = last ? car.trailPity + 1 : 0;
  if (car.stats) car.stats.pityPeak = Math.max(car.stats.pityPeak, car.trailPity);
  const pity = Math.min(3, car.trailPity) * 0.05;
  let table;
  if (pos <= 0) table = { shield: .30, boost: .25, mine: .25, missile: .10, emp: .05, tractor: .05 };
  else if (pos <= 3) table = { missile: .20, mine: .20, emp: .15, shield: .20, boost: .15, tractor: .10 };
  else if (!last) table = { missile: .25, emp: .20, tractor: .25, boost: .15, shield: .10, mine: .05 };
  else table = { tractor: .30 + pity, boost: .25 + pity, missile: .20, emp: .15, shield: .10, mine: 0 };
  let total = 0;
  for (const k in table) total += table[k];
  let roll = Math.random() * total;
  for (const k in table) {
    roll -= table[k];
    if (roll <= 0) return k;
  }
  return 'boost';
}
function updateItemBoxes(race) {
  for (const box of race.boxes) {
    if (race.time>=box.respawnAt) box.item=Math.floor(Math.random()*ITEM_IDS.length);
    if (box.item===null||box.item===undefined) continue;
    const boxS=(box.slot+1)/ITEM_BOXES*TRACK_LENGTH;
    for (const c of race.cars) {
      if (c.finish!==null||c.item!==null||c.jumpUntil>race.time) continue;
      if (Math.abs(wrap(boxS-c.s+TRACK_LENGTH/2,TRACK_LENGTH)-TRACK_LENGTH/2)<ITEM_BOX_RADIUS&&Math.abs(c.lane-box.lane)<1.5) {
        c.item=rollPickup(race,c); box.item=null; box.respawnAt=race.time+ITEM_BOX_RESPAWN;
        c.itemEventAt=race.time; emit(race,c,`拾取 ${ITEM_DEFS[c.item].label}`,1);
        break;
      }
    }
  }
}
export function stepRace(race, dt) {
  race.time+=dt;
  if (race.phase==='lobby') {
    // Lobby: cars remain in starting grid positions waiting for server start confirmation.
    for (const car of race.cars) {
      car.speed = 0;
      car.lateral = 0;
      car.boost = 0;
      car.drift = false;
    }
    return;
  }
  if (race.phase==='countdown' || race.phase==='result') {
    race.phaseLeft-=dt;
    if (race.phase==='result') updateEntities(race,dt);
    if (race.phaseLeft<=0) {
      if (race.phase==='countdown') race.phase='racing';
      else if (race.cars.some(c=>c.human&&c.connected)) openLobby(race);
      else { race.phase='demo'; for (const car of race.cars) Object.assign(car,newCar(car.id)); race.entities=[]; for (const box of race.boxes) box.respawnAt=-Infinity; }
    }
    return;
  }
  const before=ranking(race).map(c=>c.id);
  if(race.phase==='racing') race.remaining=Math.max(0,race.remaining-dt);
  updateItemBoxes(race);
  updateEntities(race,dt);
  for(const c of race.cars) {
    if(c.finish!==null) { c.speed=Math.max(0,c.speed-dt*18); continue; }
    const ai=!c.human || !c.connected || race.phase==='demo';
    const fresh=race.time-c.inputAt<0.3;

    // AI steering: seeks available item boxes when empty, otherwise follows dynamic line
    const allowAiItems = race.phase === 'demo' || (race.phase === 'racing' && race.cars.some(x => x.human && x.connected));
    // Narrow sections (hairpins) shrink the racing line amplitude with the road.
    const laneAmp = 3.8 * clamp((halfWidthAt(c.s) - 2) / 5.5, 0.4, 1);
    let targetLane = Math.sin(c.s / 43 + c.id * 2) * laneAmp;
    if (ai && c.item === null && allowAiItems) {
      for (const box of race.boxes) {
        if (box.item !== null && box.item !== undefined) {
          const boxS = (box.slot + 1) / ITEM_BOXES * TRACK_LENGTH;
          const fwd = wrap(boxS - c.s, TRACK_LENGTH);
          if (fwd > 2 && fwd < 55) {
            targetLane = box.lane;
            break;
          }
        }
      }
    }
    let steer = ai ? clamp((targetLane - c.lane) * 0.75, -1, 1) : fresh ? c.steer : 0;
    if(c.spinUntil>race.time) {
      c.spinAge+=dt;
      steer=Math.sin(c.spinAge*TAU/SPIN_DURATION*1.5)*.9;
    } else c.spinAge=0;
    c.drift=ai ? Math.abs(steer)>.6 : fresh&&c.heldDrift&&Math.abs(steer)>.1;
    // Steering feel: slew-limit small inputs, desensitize at speed. The spin
    // override above stays raw so punishment never feels mushy.
    if(!(c.spinUntil>race.time)) c.steerSm+=(steer-c.steerSm)*Math.min(1,dt*10);
    else c.steerSm=steer;
    const authority=1-0.35*clamp((c.speed-20)/28,0,1);
    const effSteer=c.steerSm*authority;
    // A loaded bend charges much faster than weaving on a straight. Releasing
    // deliberately converts the earned tier to a small or perfect exit boost.
    // A stale network input drops both values and never grants a reward.
    if (c.drift) {
      c.driftTime+=dt;
      c.driftCharge+=dt*driftChargeRate(c,effSteer);
    }
    else {
      const stage=driftStage(c);
      if ((ai || fresh) && stage>0 && c.finish===null && c.boost<=0 && c.empUntil<=race.time) {
        c.boost=stage===2?DRIFT_PERFECT_BOOST:DRIFT_MINI_BOOST;
        if(race.phase==='racing') emit(race,c,stage===2?'完美漂移 · 强力小喷':'漂移小喷',stage===2?3:2);
      }
      c.driftTime=0;
      c.driftCharge=0;
    }
    if((ai ? c.energy>85 : fresh&&c.boostQueued) && c.energy>=30 && c.boost<=0 && c.empUntil<=race.time) {
      c.energy-=30; c.boost=1.7;
      if(race.phase==='racing') emit(race,c,'氮气冲刺',2);
    }
    c.boostQueued=false;
    c.boost=Math.max(0,c.boost-dt);

    // AI Active Item Usage: uses held items intelligently during demo or active multiplayer races
    if (ai && c.item !== null && allowAiItems) {
      if (c.aiNextUseAt === undefined || c.aiNextUseAt === -Infinity) {
        c.aiNextUseAt = race.time + 0.6 + (c.id % 4) * 0.3;
      }
      if (race.time >= c.aiNextUseAt && race.time - c.useAt >= 1.5) {
        let shouldFire = false;
        const kind = c.item;
        if (kind === 'missile') {
          let hasTarget = false;
          for (const other of race.cars) {
            if (other.finish !== null || other.id === c.id) continue;
            const gap = wrap(other.s - c.s + TRACK_LENGTH / 2, TRACK_LENGTH) - TRACK_LENGTH / 2;
            if (gap >= MISSILE_LOCK_GAP && gap <= MISSILE_LOCK_RANGE) { hasTarget = true; break; }
          }
          if (hasTarget || race.phase === 'demo' || race.time >= c.aiNextUseAt + 2.5) shouldFire = true;
        } else if (kind === 'mine') {
          shouldFire = true;
        } else if (kind === 'shield') {
          const targeted = race.entities.some(e => e.alive && e.kind === 'missile' && e.targetId === c.id);
          if (targeted || race.time >= c.aiNextUseAt + 1.2) shouldFire = true;
        } else if (kind === 'boost' || kind === 'emp' || kind === 'tractor') {
          shouldFire = true;
        }
        if (shouldFire) {
          useItem(race, c, race.time);
          c.aiNextUseAt = race.time + 1.8 + (c.id % 3) * 0.8;
        }
      }
    }
    const target=(c.boost>0?48:31+(ai?c.id*.18:0)) * (!ai&&fresh&&c.brake?.36:1) * slowFactor(c,race.time) * dollySlowFactor(c,race.time);
    c.speed+=(target-c.speed)*Math.min(1,dt*1.6);
    // Grip cap: bleed down to the corner limit, never push up.
    const grip = GRIP_LIMIT * (c.drift ? DRIFT_GRIP_BONUS : 1);
    const vmax = Math.sqrt(grip / Math.max(Math.abs(cornerCurvature(c.s)), 1e-4));
    if (c.speed > vmax) c.speed = Math.max(vmax, c.speed - dt * GRIP_SCRUB);
    c.lateral+=(effSteer*(c.drift?10:7)-c.lateral)*Math.min(1,dt*(c.drift?2.8:8));
    c.lane+=c.lateral*dt;
    // Tractor homing: magnetic pull toward the locked victim's line.
    if (race.time < c.tractorUntil && c.tractorTarget !== null) {
      const vt = race.cars[c.tractorTarget];
      if (vt && vt.finish === null) {
        c.lane += (clamp(vt.lane, -6.5, 6.5) - c.lane) * Math.min(1, dt * 1.5);
      }
    }
    const wallAt = halfWidthAt(c.s) - 1;
    if(Math.abs(c.lane)>wallAt) {
      c.lane=clamp(c.lane,-wallAt,wallAt); c.lateral*=-.3; c.speed*=.94; c.driftTime=0; c.driftCharge=0;
      if(race.time-c.incidentAt>3 && race.phase==='racing') {emit(race,c,'贴墙惊险过弯',1);c.incidentAt=race.time;}
    }
    // Pylons are solid: clipping one costs speed and kills the drift charge.
    for (let k = 1; k <= PYLON_COUNT; k++) {
      const py = pylonAt(k);
      const gap = wrap(py.s - c.s + TRACK_LENGTH / 2, TRACK_LENGTH) - TRACK_LENGTH / 2;
      if (Math.abs(gap) > 1.4 || Math.abs(c.lane - py.lane) > 1.0) continue;
      c.speed = Math.max(8, c.speed * 0.82);
      c.lateral += (c.lane >= py.lane ? 1 : -1) * 2.5;
      c.driftTime = 0;
      c.driftCharge = 0;
      if (race.time - c.incidentAt > 3 && race.phase === 'racing') { emit(race, c, '撞上雪糕筒', 1); c.incidentAt = race.time; }
      break;
    }
    c.energy=clamp(c.energy+dt*(c.drift?12:2),0,100);
    c.s+=c.speed*dt*racingLineFactor(c.s,c.lane);
    if(race.phase==='racing'&&c.s>=race.laps*TRACK_LENGTH) {c.finish=race.seconds-race.remaining; emit(race,c,'冲过终点',4); highlight(race,'finish_line',c,null,4);}
    if(race.phase==='racing'&&c.finish===null&&c.s>=(race.laps-1)*TRACK_LENGTH&&!c.lastLap) {c.lastLap=true; emit(race,c,'进入最后一圈',3); highlight(race,'last_lap',c,null,2);}
  }
  for(let i=0;i<CAPACITY;i++) for(let j=i+1;j<CAPACITY;j++) {
    const a=race.cars[i],b=race.cars[j];
    if(a.finish!==null||b.finish!==null)continue;
    const gap=wrap(a.s-b.s+TRACK_LENGTH/2,TRACK_LENGTH)-TRACK_LENGTH/2;
    if(Math.abs(gap)<3.1&&Math.abs(a.lane-b.lane)<1.8) {
      const push=(1.8-Math.abs(a.lane-b.lane))*.5;
      const dir=a.lane>=b.lane?1:-1;
      a.lane=clamp(a.lane+push*dir,-6.5,6.5);b.lane=clamp(b.lane-push*dir,-6.5,6.5);
      // Boosting through: positional shove stays, speed loss is waived.
      if(a.boost<=0) a.speed=Math.max(12,a.speed-1.8);
      if(b.boost<=0) b.speed=Math.max(12,b.speed-1.8);
      if(race.time-a.incidentAt>3&&race.phase==='racing'){ emit(race,a,'并排争夺',3); highlight(race,'car_collision',a,b,1); a.incidentAt=race.time; }
    }
  }
  const order=ranking(race);
  if(race.phase==='racing') {
    const passer=order.find((c,i)=>before.indexOf(c.id)>i&&c.s>25&&race.time-c.incidentAt>3);
    if(passer){
      const passerIdx=order.indexOf(passer),victim=order[passerIdx+1]??null;
      passer.stats.overtakes++; if(passer.boost>0)passer.stats.boostOvertakes++;
      highlight(race,passer.boost>0?'overtake_after_boost':'overtake',passer,victim,passer.boost>0?3:2);
      if(victim)highlight(race,'overtaken',victim,passer,1);
      emit(race,passer,passer.boost>0?'氮气凶猛超车':'完成超车',3);
      passer.incidentAt=race.time;
    }
    if(race.remaining<=0||race.cars.every(c=>c.finish!==null)) {
      race.phase='result';race.phaseLeft=12;
      race.awards=computeAwards(race);
      race.focus=order[0].id;race.focusReason='本场冠军';race.shot='finish';race.shotS=null;
      race.focusSeverity=5;race.focusUntil=race.time+12;
      race.shotAt=race.time;race.shotKindAt=race.time;race.pendingShot=null;race.duel=null;
    }
  }
  // A highlight that lost the floor race plays the moment the floor expires.
  flushPendingShot(race);
  updateDuel(race);
  if(race.time>race.focusUntil){
    // Idle director: a live duel outranks a lonely leader, otherwise follow him.
    if(race.duel){
      setShot(race,{focus:race.duel.ahead,reason:'贴身对决',severity:1,kind:'aerial',
        shotS:(race.cars[race.duel.a].s+race.cars[race.duel.b].s)/2,until:race.time+3});
    } else {
      setShot(race,{focus:order[0].id,reason:'领跑车手',severity:0,kind:'follow',until:race.time+5});
    }
  }
  race.tick++;
}
export function snapshot(race) {
  return {v:1,type:'state',time:race.time,round:race.round,trackId:race.trackId,laps:race.laps,seconds:race.seconds,phase:race.phase,phaseLeft:race.phaseLeft,remaining:race.remaining,
    focus:race.focus,focusReason:race.focusReason,shot:race.shot,shotS:race.shotS===null?null:Math.round(race.shotS*10)/10,
    duel:race.duel?{a:race.duel.a,b:race.duel.b,ahead:race.duel.ahead,ratio:Math.round(race.duel.ratio*1000)/1000,flash:Math.round(race.duel.flash*1000)/1000}:null,
    awards:race.awards,
    events:race.events,order:ranking(race).map(c=>c.id),
    boxes:race.boxes.map(b=>({id:b.id,item:b.item})),
    entities:race.entities.filter(e=>e.alive).map(e=>({id:e.id,kind:e.kind,owner:e.owner,s:Math.round(e.s*100)/100,lane:Math.round(e.lane*100)/100,targetId:e.targetId})),
    highlights:race.highlights.slice(0,5),
    cars:race.cars.map(c=>({id:c.id,name:c.name,human:c.human,connected:c.connected,ready:Boolean(c.ready),s:c.s,lane:c.lane,speed:c.speed,energy:c.energy,boost:c.boost,drift:c.drift,driftTime:c.driftTime,driftCharge:c.driftCharge,driftStage:driftStage(c),finish:c.finish,lateral:c.lateral,seq:c.seq,
      steer:Math.round(c.steer*1000)/1000,guardUntil:c.guardUntil,item:c.item,itemEventAt:c.itemEventAt,
      slowUntil:c.slowUntil,slowSpinUntil:c.slowSpinUntil,empUntil:c.empUntil,shieldUntil:c.shieldUntil,
      spinUntil:c.spinUntil,spinAge:c.spinAge,jumpUntil:c.jumpUntil,
      useAt:c.useAt,empBlock:c.empUntil>race.time}))};
}
