import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../public/app.mjs", import.meta.url), "utf8");

assert.match(app, /query\.get\('hub'\) === '1'/);
assert.match(app, /query\.get\('name'\)/);
assert.match(app, /broadcast\.hidden = true/);
assert.match(app, /startRace\.hidden = true/);
assert.match(app, /pending = \{ name: hubName \}/);

console.log("Hub runtime UI contract verified: embedded display is clean and guest nickname can auto-join.");
