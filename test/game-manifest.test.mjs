import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../game.json", import.meta.url), "utf8"),
);

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.id, "pilot-racer");
assert.equal(manifest.category, "racing");

assert.equal(manifest.runtime.kind, "process");
assert.deepEqual(manifest.runtime.command, ["node", "server.mjs"]);
assert.equal(manifest.runtime.healthPath, "/info");
assert.equal(manifest.runtime.workingDirectoryEnv, "PILOT_RACER_DIR");

assert.equal(manifest.entrypoints.display, "/display");
assert.equal(manifest.entrypoints.player, "/");

assert.equal(manifest.round.joinPolicy, "ephemeral-code");
assert.ok(manifest.round.codeTtlSeconds > 0);
assert.equal(manifest.round.lateJoin, false);

assert.ok(manifest.commercial.entitlements.includes("game:kart-racing"));
assert.equal(manifest.capabilities.aiFill, true);
assert.equal(manifest.capabilities.reconnect, true);

// Keep the existing standalone launcher contract intact while Hub integration evolves.
assert.equal(manifest.runtime.port, 9010);
assert.equal(manifest.runtime.healthProtocol, "pilot-racer/1");
assert.ok(Array.isArray(manifest.settings));
assert.ok(Array.isArray(manifest.links));
