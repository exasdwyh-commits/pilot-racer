import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPilot } from '../server.mjs';

test('candidate roster retains four distinct pairs using durable local GLBs', () => {
  const roster=JSON.parse(readFileSync(new URL('../assets/models/roster.json',import.meta.url)));
  assert.equal(roster.length,4);assert.equal(new Set(roster.map(e=>e.id)).size,4);
  for(const entry of roster)for(const kind of ['kart','driver']){
    assert.match(entry[kind],/^\/assets\/models\/[a-z0-9-]+\/[a-z0-9-]+\.glb$/);
    const buf=readFileSync(new URL(`..${entry[kind]}`,import.meta.url));
    assert.equal(buf.toString('ascii',0,4),'glTF');
  }
  const app=readFileSync(new URL('../public/app.mjs',import.meta.url),'utf8');
  assert.ok(!app.includes('roster.json'),'candidate downloads are not part of race startup');
  const garage=readFileSync(new URL('../public/garage.mjs',import.meta.url),'utf8');
  assert.ok(!garage.includes('new WebSocket'),'garage does not claim a race seat');
});

test('candidate garage and its local catalog are served without affecting protocol', async t => {
  const pilot=await createPilot({host:'127.0.0.1',port:0,manual:true});t.after(()=>pilot.close());
  const base=`http://127.0.0.1:${pilot.port}`;
  for(const [path,type] of [['/garage','text/html'],['/garage.mjs','text/javascript'],['/garage.css','text/css']]){
    const res=await fetch(base+path);assert.equal(res.status,200,path);assert.match(res.headers.get('content-type'),new RegExp(type));
  }
  const roster=await (await fetch(base+'/assets/models/roster.json')).json();assert.equal(roster.length,4);
  assert.equal((await (await fetch(base+'/info')).json()).protocol,'pilot-racer/1');
});
