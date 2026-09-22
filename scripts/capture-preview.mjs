import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

await mkdir('docs/screenshots', { recursive: true });

const base = 'http://127.0.0.1:9010';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

try {
  const info = await fetch(base + '/info').then(r => r.json());
  if (!info?.join) throw new Error('Pilot /info did not expose a join URL.');

  // Establish the phone player first. Two cold software-WebGL contexts can
  // otherwise contend badly on GitHub runners and delay the second page before
  // it ever reaches the WebSocket handshake.
  const phone = await browser.newPage({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 1,
  });
  await phone.goto(base + '/?name=' + encodeURIComponent('预览车手'), {
    waitUntil: 'domcontentloaded',
  });
  await phone.waitForFunction(
    () => document.body.classList.contains('driving'),
    null,
    { timeout: 45_000 },
  );

  const display = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  await display.goto(base + '/display', { waitUntil: 'domcontentloaded' });
  await display.waitForSelector('#game-surface', {
    state: 'attached',
    timeout: 20_000,
  });
  await display.waitForTimeout(4_000);

  const start = await fetch(base + '/api/start', { method: 'POST' });
  if (!start.ok) throw new Error('POST /api/start failed: ' + start.status);

  await display.waitForFunction(
    () => document.querySelector('#phase')?.textContent === '比赛进行中',
    null,
    { timeout: 30_000 },
  );
  await display.waitForTimeout(1_500);

  await phone.waitForFunction(
    () => {
      const coach = document.querySelector('#corner-coach');
      return document.querySelector('#phase')?.textContent === '比赛进行中' && coach && !coach.hidden;
    },
    null,
    { timeout: 45_000 },
  );
  await phone.waitForTimeout(500);
  await phone.screenshot({
    path: 'docs/screenshots/phone-driver-hud.png',
    fullPage: false,
    timeout: 120_000,
  });

  await display.screenshot({
    path: 'docs/screenshots/tv-auto-director.png',
    fullPage: false,
    timeout: 120_000,
  });

  // GitHub software-WebGL screenshots can take tens of seconds. Restart the
  // authoritative race before each subsequent frame so a fast AI field cannot
  // finish while Chromium is reading pixels back.
  await fetch(base + '/api/start', { method: 'POST' });
  await display.waitForFunction(
    () => document.querySelector('#phase')?.textContent === '比赛进行中',
    null,
    { timeout: 30_000 },
  );
  await display.keyboard.press('Digit2');
  await display.waitForTimeout(1_200);
  await display.screenshot({
    path: 'docs/screenshots/tv-chase-camera.png',
    fullPage: false,
    timeout: 120_000,
  });

  await fetch(base + '/api/start', { method: 'POST' });
  await display.waitForFunction(
    () => document.querySelector('#phase')?.textContent === '比赛进行中',
    null,
    { timeout: 30_000 },
  );
  await display.keyboard.press('Digit3');
  await display.waitForTimeout(1_200);
  await display.screenshot({
    path: 'docs/screenshots/tv-helicopter.png',
    fullPage: false,
    timeout: 120_000,
  });

  const directorState = await display.evaluate(() => window.__broadcastCamera ?? null);
  if (!directorState || directorState.mode !== 'free' || directorState.shot !== 'helicopter') {
    throw new Error('Broadcast camera debug state was not populated.');
  }
  const modelState = await display.evaluate(() => window.__pilotKartModels ?? {});
  if (Object.keys(modelState).length < 8) {
    throw new Error('Expected all eight visual kart slots to be registered.');
  }
} finally {
  await browser.close();
}
