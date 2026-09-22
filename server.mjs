import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import { makeRace, newCar, openLobby, startRace, stepRace, applyInput, useItem, snapshot, useTrack, TRACKS } from './public/simulation.mjs';
// Ad board config (ads.json). Re-read on every /api/ads request so edits go
// live without restarting; mtime acts as the client refresh version.
async function loadAds() {
  try {
    const [buf, st] = await Promise.all([
      readFile(resolve(ROOT, 'ads.json')),
      stat(resolve(ROOT, 'ads.json')),
    ]);
    const parsed = JSON.parse(buf.toString('utf8'));
    if (!Array.isArray(parsed.creatives) || !Array.isArray(parsed.slots)) throw new Error('bad ads shape');
    return { version: Math.floor(st.mtimeMs), creatives: parsed.creatives, slots: parsed.slots };
  } catch {
    return { version: 0, creatives: [], slots: [] };
  }
}
const ROOT=dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/', ['public/index.html','text/html']], ['/display',['public/index.html','text/html']],
  ['/app.mjs',['public/app.mjs','text/javascript']], ['/styles.css',['public/styles.css','text/css']],
  ['/simulation.mjs',['public/simulation.mjs','text/javascript']],
  ['/scenery.mjs',['public/scenery.mjs','text/javascript']],
  ['/item-visuals.mjs',['public/item-visuals.mjs','text/javascript']],
  ['/garage',['public/garage.html','text/html']],
  ['/garage.mjs',['public/garage.mjs','text/javascript']],
  ['/garage.css',['public/garage.css','text/css']],
  ['/vendor/three.module.js',['node_modules/three/build/three.module.js','text/javascript']],
  ['/vendor/three.core.js',['node_modules/three/build/three.core.js','text/javascript']],
  ['/vendor/examples/jsm/loaders/GLTFLoader.js',['node_modules/three/examples/jsm/loaders/GLTFLoader.js','text/javascript']],
  ['/vendor/examples/jsm/environments/RoomEnvironment.js',['node_modules/three/examples/jsm/environments/RoomEnvironment.js','text/javascript']],
  ['/vendor/examples/jsm/utils/BufferGeometryUtils.js',['node_modules/three/examples/jsm/utils/BufferGeometryUtils.js','text/javascript']],
  ['/vendor/examples/jsm/utils/SkeletonUtils.js',['node_modules/three/examples/jsm/utils/SkeletonUtils.js','text/javascript']],
  ['/audio/bgm-race.mp3',['public/audio/bgm-race.mp3','audio/mpeg']],
  ['/audio/bgm-menu.mp3',['public/audio/bgm-menu.mp3','audio/mpeg']],
  // 自适应音乐族的其余层（见 docs/AUDIO_DESIGN.md 第 5 节）。
  // 缺文件不会让服务崩：下面的 readFile 失败会走 404，音频引擎把该层标 missing 后继续跑。
  ['/audio/bgm-lobby.mp3',['public/audio/bgm-lobby.mp3','audio/mpeg']],
  ['/audio/bgm-race-final.mp3',['public/audio/bgm-race-final.mp3','audio/mpeg']],
  ['/audio/bgm-results.mp3',['public/audio/bgm-results.mp3','audio/mpeg']],
  // 主题曲《NO MORE WAITING》（有主唱的单曲，不参与自适应音乐族的交叉淡化）
  //   -48s 是游戏开场版：从全曲前 32 小节裁出，160 BPM 下正好 48.00s
  ['/audio/no-more-waiting.mp3',['public/audio/no-more-waiting.mp3','audio/mpeg']],
  ['/audio/no-more-waiting-48s.mp3',['public/audio/no-more-waiting-48s.mp3','audio/mpeg']],
  // 试听稿目录：给人判断生成音色用的工作文件，不是交付资产，不随产品发布
  ['/audio/draft/no-more-waiting-30s.mp3',['public/audio/draft/no-more-waiting-30s.mp3','audio/mpeg']],
  // 交互音频引擎与试听调参工作台
  ['/audio-engine.mjs',['public/audio-engine.mjs','text/javascript']],
  ['/audio-lab',['public/audio-lab.html','text/html']],
  ['/audio-lab.html',['public/audio-lab.html','text/html']],
]);
const ASSET_TYPES={'.glb':'model/gltf-binary','.png':'image/png','.jpg':'image/jpeg'};
export async function createPilot({host='0.0.0.0',port=9010,manual=false}={}) {
  const race=makeRace(process.env.TRACK || 'bay', { laps: process.env.LAPS, seconds: process.env.RACE_SECONDS }), sessions=new Map(), code=process.env.ROOM_CODE || 'BAY888';
  let advertised='';
  const http=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost');
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      if(url.pathname==='/api/start' && (req.method==='POST'||req.method==='GET')) {
        startRace(race);
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({ok:true,phase:race.phase}));
        return;
      }
      if(req.method!=='GET'){res.writeHead(405);res.end();return;}
      if(url.pathname==='/info') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code,join:advertised,capacity:8,protocol:'pilot-racer/1'}));return;}
      if(url.pathname==='/api/ads') {
        res.setHeader('Content-Type','application/json');
        res.setHeader('Cache-Control','no-store');
        res.end(JSON.stringify(await loadAds()));
        return;
      }
      if(url.pathname==='/qr.svg') {res.setHeader('Content-Type','image/svg+xml');res.end(await QRCode.toString(advertised,{type:'svg',margin:1,width:176}));return;}
      const file=files.get(url.pathname);
      if(file){
        const ct = file[1].startsWith('audio/') ? file[1] : `${file[1]}; charset=utf-8`;
        res.setHeader('Content-Type', ct);
        // 音频资源可能尚未生成（音乐在合成中）。缺文件返回 404 而不是 500：
        // 音频引擎按 404 把该层标为 missing 后照常跑，只是少一层音乐。
        try{
          res.end(await readFile(resolve(ROOT,file[0])));
        }catch{
          res.writeHead(404);res.end(file[1].startsWith('audio/')?'Audio not generated yet':'Not found');
        }
        return;
      }
      // Static CC0 models: /models/*.glb (see public/models/PROVENANCE.md)
      if(url.pathname.startsWith('/models/')){
        const rel=decodeURIComponent(url.pathname.slice('/models/'.length));
        if(rel.includes('..')||rel.includes('/')||!rel.endsWith('.glb')){res.writeHead(400);res.end('Bad request');return;}
        try{
          const buf=await readFile(resolve(ROOT,'public/models',rel));
          res.setHeader('Content-Type','model/gltf-binary');
          res.setHeader('Cache-Control','public, max-age=3600');
          res.end(buf);
        }catch{res.writeHead(404);res.end('Model not found');}
        return;
      }
      // Static CC0 assets: /assets/racing/*.glb, /assets/textures/*.png
      if(url.pathname.startsWith('/assets/')){
        const rel=decodeURIComponent(url.pathname.slice('/assets/'.length));
        const abs=resolve(ROOT,'assets',rel);
        if(!abs.startsWith(resolve(ROOT,'assets')+'/')&&!abs.startsWith(resolve(ROOT,'assets'))) {res.writeHead(400);res.end('Bad request');return;}
        try{
          const buf=await readFile(abs);
          const ext=abs.slice(abs.lastIndexOf('.'));
          res.setHeader('Content-Type',ASSET_TYPES[ext]||'application/octet-stream');
          res.setHeader('Cache-Control','public, max-age=3600');
          res.end(buf);
        }catch{res.writeHead(404);res.end('Asset not found');}
        return;
      }
      res.writeHead(404);res.end('Not found');
    }catch{res.writeHead(500);res.end('Pilot server error');}
  });
  const wss=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
  http.on('upgrade',(req,socket,head)=>{
    // LAN-only pilot. Reject browser requests originating from another host.
    let sameOrigin=true;
    try{if(req.headers.origin)sameOrigin=new URL(req.headers.origin).host===req.headers.host;}catch{sameOrigin=false;}
    if(req.url!=='/socket'||!sameOrigin||wss.clients.size>=32){socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  });
  const send=(ws,msg)=>{if(ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<128*1024)ws.send(JSON.stringify(msg));};
  wss.on('connection',ws=>{
    ws.role=null;ws.car=null;ws.alive=true;ws.rateAt=Date.now();ws.rate=0;
    const timeout=setTimeout(()=>{if(!ws.role)ws.close(1008,'hello timeout');},5000);
    ws.on('pong',()=>ws.alive=true);
    ws.on('error',()=>{});
    ws.on('message',data=>{
      if(Date.now()-ws.rateAt>1000){ws.rateAt=Date.now();ws.rate=0;}
      if(++ws.rate>120){ws.close(1008,'rate limit');return;}
      let m;try{m=JSON.parse(data.toString());}catch{ws.close(1008,'invalid json');return;}
      if(!m||typeof m!=='object'||m.v!==1){send(ws,{type:'error',message:'协议版本不匹配，请刷新页面'});return;}
      if(m.type==='hello'&&!ws.role){
        if(m.role==='display'){ws.role='display';clearTimeout(timeout);send(ws,{type:'welcome',role:'display'});send(ws,snapshot(race));return;}
        if(m.role!=='player'){send(ws,{type:'error',message:'协议角色不匹配，请刷新页面'});return;}
        let session=typeof m.token==='string'?sessions.get(m.token):null;
        if(session&&session.ws&&session.ws.readyState===WebSocket.OPEN){send(ws,{type:'error',message:'这位车手已在另一个页面驾驶，请关闭原页面'});return;}
        if(session&&session.expires<=race.time){sessions.delete(m.token);session=null;}
        let token=m.token;
        if(!session){
          const taken=new Set([...sessions.values()].filter(s=>s.expires>race.time).map(s=>s.car.id));
          const car=race.cars.find(c=>!taken.has(c.id));
          if(!car){send(ws,{type:'error',message:'8 个座位已满，请稍后再试'});return;}
          token=randomBytes(24).toString('hex');session={car,ws:null,expires:Infinity};sessions.set(token,session);
          car.name=typeof m.name==='string'?m.name.replace(/[\p{Cc}\p{Cf}]/gu,'').trim().slice(0,12)||`车手 ${car.id+1}`:`车手 ${car.id+1}`;
        }
        if(race.phase==='demo') openLobby(race);
        session.ws=ws;session.expires=Infinity;ws.car=session.car;ws.role='player';ws.token=token;
        ws.car.human=true;ws.car.connected=true;ws.car.ready=true;ws.car.seq=-1;ws.car.inputAt=-Infinity;ws.car.boostQueued=false;
        clearTimeout(timeout);
        send(ws,{type:'welcome',role:'player',id:ws.car.id,token,name:ws.car.name});send(ws,snapshot(race));return;
      }
      if(m.type==='start'){
        if(ws.role==='display'){
          if(race.phase==='lobby'||race.phase==='demo') startRace(race);
        } else {
          send(ws,{type:'error',message:'只有大屏端可以开始比赛，手机端请准备'});
        }
        return;
      }
      // Big-screen track select. Lobby/demo only: re-lays the grid on the new
      // track, seated players stay seated.
      if(m.type==='select-track'&&ws.role==='display'){
        if((race.phase==='lobby'||race.phase==='demo')&&typeof m.trackId==='string'&&TRACKS[m.trackId]){
          useTrack(m.trackId); race.trackId=m.trackId; openLobby(race);
        }
        return;
      }
      if(m.type==='ready'&&ws.role==='player'&&ws.car){
        ws.car.ready = typeof m.ready==='boolean'?m.ready:!ws.car.ready;
        return;
      }
      if(m.type==='leave'&&ws.role==='player'&&ws.car){
        if(ws.token) sessions.delete(ws.token);
        const c=ws.car;
        c.human=false;c.connected=false;c.ready=false;c.name=`车手 ${c.id+1}`;c.steer=0;c.boostQueued=false;
        send(ws,{type:'left'});
        ws.role=null;ws.car=null;ws.token=null;
        setTimeout(()=>ws.close(1000,'player left'),30);
        if(race.phase==='lobby'&&!race.cars.some(x=>x.human&&x.connected)){
          race.phase='demo';
          for(const car of race.cars)Object.assign(car,newCar(car.id));
          race.entities=[];
        }
        return;
      }
      if(m.type==='input'&&ws.role==='player')applyInput(ws.car,m,race.time);
      if(m.type==='use'&&ws.role==='player')useItem(race,ws.car,race.time);
    });
    ws.on('close',()=>{
      clearTimeout(timeout);
      if(ws.token){const session=sessions.get(ws.token);if(session?.ws===ws){session.ws=null;session.expires=race.time+15;session.car.connected=false;session.car.steer=0;session.car.boostQueued=false;}}
    });
  });
  function tick(){
    for(const [token,s]of sessions)if(s.expires<=race.time){s.car.human=false;s.car.connected=false;s.car.name=`车手 ${s.car.id+1}`;sessions.delete(token);}
    stepRace(race,1/30);
    const message=snapshot(race);for(const ws of wss.clients)if(ws.role)send(ws,message);
  }
  await new Promise((ok,fail)=>{http.once('error',fail);http.listen(port,host,ok);});
  const timer=manual?null:setInterval(tick,1000/30);
  const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}},3000);
  const bound=http.address().port;
  const ips=Object.values(networkInterfaces()).flat().filter(x=>x&&x.family==='IPv4'&&!x.internal);
  const lan=ips.find(x=>x.address.startsWith('192.168.'))??ips.find(x=>x.address.startsWith('10.'))??ips[0];
  advertised=`http://${host==='127.0.0.1'?'127.0.0.1':lan?.address??'127.0.0.1'}:${bound}/?code=${code}`;
  return {race,code,port:bound,join:advertised,tick,close:async()=>{
    clearInterval(timer);clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();
    await new Promise(ok=>wss.close(ok));await new Promise(ok=>http.close(ok));
  }};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const pilot=await createPilot({port:Number(process.env.PORT??9010),host:process.env.HOST??'0.0.0.0'});
  console.log(`\n极速等位赛 · 3D 单机样机\n大屏：http://localhost:${pilot.port}/display\n手机：${pilot.join}\n同一 Wi-Fi；手机请用 Safari / Chrome 打开。Ctrl+C 停止。\n`);
  process.on('SIGINT',async()=>{await pilot.close();process.exit(0);});
  process.on('SIGTERM',async()=>{await pilot.close();process.exit(0);});
}
