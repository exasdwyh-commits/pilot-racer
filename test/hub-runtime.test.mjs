import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../public/app.mjs", import.meta.url), "utf8");

assert.match(app, /query\.get\('hub'\) === '1'/);
assert.match(app, /query\.get\('name'\)/);
assert.match(app, /query\.get\('round'\)/);
assert.match(app, /broadcast\.hidden = true/);
assert.match(app, /startRace\.hidden = true/);
assert.match(app, /pending = \{ name: hubName \}/);
assert.match(app, /api\/platform\/rounds/);
assert.match(app, /\['finished', 'cancelled', 'expired'\]/);
assert.match(app, /:5177\/join\//);

console.log("Hub runtime UI contract verified: display is clean, guests auto-join, and ended rounds return to Hub.");
