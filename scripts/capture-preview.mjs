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

  const display = await browser.newPage({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
  });
  await display.goto(base + '/display', { waitUntil: 'domcontentloaded' });
  await display.waitForSelector('#game-surface', { timeout: 15_000 });
  await display.waitForTimeout(4_000);

  const phone = await browser.newPage({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  await phone.goto(base + '/?code=' + encodeURIComponent(info.code), { waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('#join-form', { state: 'attached', timeout: 10_000 });
  // The player page deliberately rotates its logical surface in some mobile
  // viewport combinations. Submit through the real DOM event so visual CSS
  // transforms do not make Playwright misclassify the form as "not visible".
  await phone.evaluate(() => {
    const input = document.querySelector('#name');
    const form = document.querySelector('#join-form');
    input.value = 'Preview Driver';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await phone.waitForFunction(() => document.body.classList.contains('driving'), null, {
    timeout: 10_000,
  });

  const start = await fetch(base + '/api/start', { method: 'POST' });
  if (!start.ok) throw new Error('POST /api/start failed: ' + start.status);

  await display.waitForTimeout(6_500);

  await display.screenshot({
    path: 'docs/screenshots/tv-auto-director.png',
    fullPage: true,
  });

  await display.locator('#next').click();
  await display.locator('#camera-next').click();
  await display.waitForTimeout(1_200);
  await display.screenshot({
    path: 'docs/screenshots/tv-free-director.png',
    fullPage: true,
  });

  await display.locator('#angle').click();
  await display.locator('#angle').click();
  await display.waitForTimeout(1_200);
  await display.screenshot({
    path: 'docs/screenshots/tv-helicopter.png',
    fullPage: true,
  });

  await phone.waitForTimeout(1_000);
  await phone.screenshot({
    path: 'docs/screenshots/phone-race.png',
    fullPage: true,
  });

  const directorState = await display.evaluate(() => window.__broadcastCamera ?? null);
  if (!directorState || !['free', 'auto'].includes(directorState.mode)) {
    throw new Error('Broadcast camera debug state was not populated.');
  }
  const modelState = await display.evaluate(() => window.__pilotKartModels ?? {});
  if (Object.keys(modelState).length < 8) {
    throw new Error('Expected all eight visual kart slots to be registered.');
  }
} finally {
  await browser.close();
}
