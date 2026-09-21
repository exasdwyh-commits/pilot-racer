// Local renderer evidence; uses installed Chrome and Node's WebSocket, no dependency.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPilot } from '../server.mjs';
import { useTrack, TRACK_LENGTH } from '../public/simulation.mjs';

const run = process.argv[2] ?? 'after';
if (!/^[a-z0-9-]+$/.test(run)) throw new Error('Use a safe run name');
const out = new URL(`../artifacts/scene-items-2026-09-20/${run}/`, import.meta.url);
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'pilot-scene-qa-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });
const pilot = await createPilot({ host: '127.0.0.1', port: 0, manual: true });
let ws;
const errors = [], pending = new Map();
let counter = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await sleep(100); }
  }
  if (!port) throw new Error('Chrome did not start');
  const tab = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); pending.delete(message.id); if (!task) return; clearTimeout(task.timer);
      if (message.error) task.reject(message.error); else task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  const metrics = [];
  for (const track of ['bay', 'ridge']) {
    useTrack(track); pilot.race.trackId = track; pilot.race.phase = 'racing';
    pilot.race.focus = 0; pilot.race.focusUntil = Infinity; pilot.race.focusReason = '场景检查';
    for (const car of pilot.race.cars) { car.s = TRACK_LENGTH * (track === 'bay' ? 0.18 : 0.29) - car.id * 5; car.speed = 0; car.human = car.connected = true; }
    await send('Page.navigate', { url: `http://127.0.0.1:${pilot.port}/display` });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(`window.__builtTrack === '${track}' && !!window.__perf`)) break;
      await sleep(100);
    }
    // Manual authority has a genuine racing snapshot and a fixed camera position.
    // This is a scene fixture, not evidence of live input or measured phone FPS.
    await sleep(1200);
    for (const quality of ['high', 'low']) {
      if (quality === 'low') await evaluate(`document.getElementById('quality-toggle').click()`);
      await sleep(1200);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(new URL(`${track}-${quality}.png`, out), Buffer.from(shot.data, 'base64'));
      metrics.push({ track, quality, perf: await evaluate('window.__perf'), scene: await evaluate('window.__sceneDiagnostics'), buildError: await evaluate('window.__pilotBuildErr ?? null') });
    }
  }
  await writeFile(new URL('report.json', out), JSON.stringify({ run, fixture: 'authoritative racing snapshot; stationary cars; desktop Chrome', metrics, errors }, null, 2));
  console.log(JSON.stringify({ out: out.pathname, metrics, errors }, null, 2));
} finally {
  ws?.close(); chrome.kill('SIGTERM'); await pilot.close();
}
