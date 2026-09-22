import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {createPilot} from '../server.mjs';
function client(port){
 const ws=new WebSocket(`ws://127.0.0.1:${port}/socket`),buffer=[],waiters=[];
 ws.on('message',d=>{const m=JSON.parse(d);const i=waiters.findIndex(w=>w.type===m.type);if(i>=0){const[w]=waiters.splice(i,1);clearTimeout(w.timer);w.resolve(m);}else buffer.push(m);});
 return {ws,open:new Promise(ok=>ws.once('open',ok)),send:m=>ws.send(JSON.stringify({v:1,...m})),next:type=>{const i=buffer.findIndex(m=>m.type===type);if(i>=0)return Promise.resolve(buffer.splice(i,1)[0]);return new Promise((resolve,reject)=>{const w={type,resolve,timer:setTimeout(()=>reject(new Error(`timeout: ${type}`)),2000)};waiters.push(w);});}};
}
test('real sockets: distinct seats, shared authoritative state, role restrictions, capacity and resume',async t=>{
 const p=await createPilot({host:'127.0.0.1',port:0,manual:true});t.after(()=>p.close());
 const display=client(p.port);await display.open;display.send({type:'hello',role:'display'});await display.next('welcome');
 const players=[];
 for(let i=0;i<8;i++){const c=client(p.port);await c.open;c.send({type:'hello',role:'player',code:p.code,name:`玩家${i}`});c.welcome=await c.next('welcome');players.push(c);}
 assert.equal(new Set(players.map(c=>c.welcome.id)).size,8);
 const extra=client(p.port);await extra.open;extra.send({type:'hello',role:'player',code:p.code,name:'第九人'});assert.match((await extra.next('error')).message,/已满/);
 const a=players[0];display.send({type:'input',seq:99,steer:1,drift:true,boost:true,brake:false});await new Promise(ok=>setTimeout(ok,20));assert.equal(p.race.cars[0].seq,-1);
 display.send({type:'start'});await new Promise(ok=>setTimeout(ok,20));
 for(let i=0;i<125;i++)p.tick();
 a.send({type:'input',seq:1,steer:1,drift:true,boost:true,brake:false});await new Promise(ok=>setTimeout(ok,20));p.tick();assert.equal(p.race.cars[0].seq,1);assert.ok(p.race.cars[0].boost>0);
 assert.ok((await display.next('state')).cars.length===8);
 const resume=client(p.port);await resume.open;resume.send({type:'hello',role:'player',code:p.code,token:a.welcome.token});assert.match((await resume.next('error')).message,/另一个页面/);
 const closed=new Promise(ok=>a.ws.once('close',ok));a.ws.close();await closed;await new Promise(ok=>setTimeout(ok,20));assert.equal(p.race.cars[0].connected,false);
 resume.send({type:'hello',role:'player',code:p.code,token:a.welcome.token});const welcome=await resume.next('welcome');assert.equal(welcome.id,a.welcome.id);assert.equal(p.race.cars[0].seq,-1);assert.equal(p.race.cars[0].connected,true);
  const res=await fetch(`http://127.0.0.1:${p.port}/qr.svg`);assert.equal(res.status,200);assert.match(await res.text(),/<svg/);
  assert.equal((await fetch(`http://127.0.0.1:${p.port}/server.mjs`)).status,404);
  const roomEnv=await fetch(`http://127.0.0.1:${p.port}/vendor/examples/jsm/environments/RoomEnvironment.js`);
  assert.equal(roomEnv.status,200,'local IBL helper is served');
  const cameraMap=await fetch(`http://127.0.0.1:${p.port}/broadcast-cameras.mjs`);
  assert.equal(cameraMap.status,200,'TV broadcast camera map module is served');
  assert.match(await cameraMap.text(),/bay-hairpin/,'Bay camera templates reach the browser');
  const asphalt=await fetch(`http://127.0.0.1:${p.port}/assets/textures/asphalt_track_diff_1k.png`);
  assert.equal(asphalt.status,200,'PBR road texture is served');
  assert.match(asphalt.headers.get('cache-control')||'',/max-age=3600/,'heavy local art assets are cached');
  const glb=await fetch(`http://127.0.0.1:${p.port}/models/tree_palm.glb`);assert.equal(glb.status,200);
  assert.match(glb.headers.get('content-type'),/model\/gltf-binary/);
  assert.equal((await fetch(`http://127.0.0.1:${p.port}/models/%2e%2e%2fserver.mjs`)).status,400);
  const ads=await fetch(`http://127.0.0.1:${p.port}/api/ads`);assert.equal(ads.status,200);
  const adsJson=await ads.json();
  assert.ok(Number.isFinite(adsJson.version)&&adsJson.version>0,'ads carry an mtime version');
  assert.ok(Array.isArray(adsJson.creatives)&&adsJson.creatives.length>0,'ads carry creatives');
  assert.ok(Array.isArray(adsJson.slots)&&adsJson.slots.length>0,'ads carry slots');
});
test('item use is server judged over real sockets and reflected in snapshots',async t=>{
 const p=await createPilot({host:'127.0.0.1',port:0,manual:true});t.after(()=>p.close());
 const display=client(p.port);await display.open;display.send({type:'hello',role:'display'});await display.next('welcome');
 const a=client(p.port);await a.open;a.send({type:'hello',role:'player',code:p.code,name:'道具手'});
 const w=await a.next('welcome');
 p.race.phase='racing';
 p.race.cars[w.id].item='missile';p.race.cars[w.id].useAt=-1e9;
 a.send({type:'use'});
 await new Promise(ok=>setTimeout(ok,30));
 assert.equal(p.race.cars[w.id].item,null,'item consumed by server');
 assert.ok(p.race.entities.some(e=>e.kind==='missile'),'missile spawned server-side');
 p.tick();
 // A freshly connected spectator must receive the complete current state,
 // which is also what a reconnecting player gets.
 const fresh=client(p.port);await fresh.open;fresh.send({type:'hello',role:'display'});await fresh.next('welcome');
 const state=await fresh.next('state');
 assert.ok(Array.isArray(state.entities)&&state.entities.length>0,'entities in snapshot');
 assert.ok(Array.isArray(state.boxes)&&state.boxes.length===10,'item boxes in snapshot');
 assert.ok(Array.isArray(state.highlights),'highlights in snapshot');
 assert.ok('slowUntil' in state.cars[w.id]&&'shieldUntil' in state.cars[w.id]&&'jumpUntil' in state.cars[w.id],'effect fields in snapshot');
 // Spectator/display sockets cannot use items.
 const before=p.race.entities.length;
 display.send({type:'use'});
 await new Promise(ok=>setTimeout(ok,20));
 assert.equal(p.race.entities.length,before,'display use ignored');
});
test('players can only ready and leave; only display can start race; leaving frees seat and resets to demo when empty',async t=>{
  const p=await createPilot({host:'127.0.0.1',port:0,manual:true});t.after(()=>p.close());
  const display=client(p.port);await display.open;display.send({type:'hello',role:'display'});await display.next('welcome');
  const player=client(p.port);await player.open;player.send({type:'hello',role:'player',code:p.code,name:'测试选手'});
  const w=await player.next('welcome');
  assert.equal(p.race.phase,'lobby','entered lobby on join');
  assert.equal(p.race.cars[w.id].ready,true,'default ready is true');

  // Player cannot start race
  player.send({type:'start'});
  const err=await player.next('error');
  assert.match(err.message,/只有大屏端可以开始比赛/);
  assert.equal(p.race.phase,'lobby','race remains in lobby');

  // Player toggles ready
  player.send({type:'ready',ready:false});
  await new Promise(ok=>setTimeout(ok,20));
  assert.equal(p.race.cars[w.id].ready,false,'ready toggled to false');
  player.send({type:'ready',ready:true});
  await new Promise(ok=>setTimeout(ok,20));
  assert.equal(p.race.cars[w.id].ready,true,'ready toggled to true');

  // Player leaves room
  player.send({type:'leave'});
  const left=await player.next('left');
  assert.ok(left,'received left ack');
  await new Promise(ok=>setTimeout(ok,30));
  assert.equal(p.race.cars[w.id].human,false,'seat freed from human');
  assert.equal(p.race.cars[w.id].connected,false,'seat freed from connection');
  assert.equal(p.race.phase,'demo','empty lobby reverted to demo');

  // Re-join with a new player into the freed seat
  const p2=client(p.port);await p2.open;p2.send({type:'hello',role:'player',code:p.code,name:'新选手'});
  const w2=await p2.next('welcome');
  assert.equal(w2.id,w.id,'reused freed seat');
  assert.equal(p.race.phase,'lobby');

  // Display starts race
  display.send({type:'start'});
  await new Promise(ok=>setTimeout(ok,20));
  assert.equal(p.race.phase,'countdown','display started race');
});
test('display can switch tracks in lobby; racing and players cannot',async t=>{
  const p=await createPilot({host:'127.0.0.1',port:0,manual:true});t.after(()=>p.close());
  const display=client(p.port);await display.open;display.send({type:'hello',role:'display'});await display.next('welcome');
  const player=client(p.port);await player.open;player.send({type:'hello',role:'player',code:p.code,name:'选图手'});
  const w=await player.next('welcome');
  assert.equal(p.race.trackId,'bay','default track');
  display.send({type:'select-track',trackId:'ridge'});
  await new Promise(ok=>setTimeout(ok,20));
  assert.equal(p.race.trackId,'ridge','lobby switch applies');
  assert.equal(p.race.cars[w.id].human,true,'seated player stays seated');
  assert.equal(p.race.cars[w.id].s,0,'grid re-laid on the new track');
  p.tick();
  await display.next('state'); // drain the hello-time snapshot
  p.tick();
  const state=await display.next('state');
  assert.equal(state.trackId,'ridge','snapshot carries trackId');
  display.send({type:'select-track',trackId:'mystery'});
  await new Promise(ok=>setTimeout(ok,20));
  assert.equal(p.race.trackId,'ridge','unknown track ignored');
  player.send({type:'select-track',trackId:'bay'});
  await new Promise(ok=>setTimeout(ok,20));
  assert.equal(p.race.trackId,'ridge','player select ignored');
  display.send({type:'start'});
  await new Promise(ok=>setTimeout(ok,20));
  assert.equal(p.race.phase,'countdown');
  display.send({type:'select-track',trackId:'bay'});
  await new Promise(ok=>setTimeout(ok,20));
  assert.equal(p.race.trackId,'ridge','mid-race switch ignored');
});
