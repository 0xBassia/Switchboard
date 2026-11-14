// Switchboard · test/core.test.mjs
//
// Unit tests for src/core and the relay bundler. Node built-ins only:
//   node --test test/core.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_TIMER_MS, parseDuration } from "../src/core/duration.mjs";
import { makeLineScanner } from "../src/core/scan.mjs";
import { probeVersion } from "../src/core/proc.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("parseDuration accepts h/m/s and rejects the rest", () => {
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("1h30m"), 5_400_000);
  assert.equal(parseDuration("2m5s"), 125_000);
  for (const bad of ["", "0s", "5", "1d", "m", "-1s", "1.5h", " 1m"]) assert.equal(parseDuration(bad), null, bad);
  assert.equal(parseDuration(`${Math.floor(MAX_TIMER_MS / 1000)}s`), Math.floor(MAX_TIMER_MS / 1000) * 1000);
  assert.equal(parseDuration("999999999h"), null);
});

test("makeLineScanner joins split lines and skips noise", () => {
  const seen = [];
  const scan = makeLineScanner((event) => seen.push(event));
  scan('{"a":1}\nnoise\n{"b":');
  scan('2}\n');
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
});

test("probeVersion distinguishes missing, broken, hung, and healthy CLIs", async () => {
  const node = process.execPath;
  assert.deepEqual(await probeVersion({ command: "definitely-not-a-cli-xyz", args: [] }, 2_000), { version: null, error: null });
  const healthy = await probeVersion({ command: node, args: ["-e", "console.log('v1.2.3')"] }, 5_000);
  assert.equal(healthy.version, "v1.2.3");
  const broken = await probeVersion({ command: node, args: ["-e", "console.error('boom'); process.exit(7)"] }, 5_000);
  assert.equal(broken.version, null);
  assert.equal(broken.error.status, 7);
  assert.match(broken.error.stderr, /boom/);
  const started = Date.now();
  const hung = await probeVersion({ command: node, args: ["-e", "setInterval(() => {}, 1000)"] }, 300);
  assert.equal(hung.error.code, "ETIMEDOUT");
  assert.ok(Date.now() - started < 5_000);
});

test("committed relays match a fresh build", () => {
  const result = spawnSync(process.execPath, [join(root, "tools", "build.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("bundler keeps only reachable code and rejects bad sources", () => {
  const temp = mkdtempSync(join(tmpdir(), "relay-build-"));
  try {
    mkdirSync(join(temp, "tools"));
    mkdirSync(join(temp, "src", "adapters"), { recursive: true });
    mkdirSync(join(temp, "src", "core"));
    mkdirSync(join(temp, "skills", "switchboard-demo", "scripts"), { recursive: true });
    copyFileSync(join(root, "tools", "build.mjs"), join(temp, "tools", "build.mjs"));
    writeFileSync(join(temp, "src", "core", "lib.mjs"), [
      'import { join } from "node:path";',
      'import { tmpdir } from "node:os";',
      "export function used() {",
      "  return join(\"a\", \"b\");",
      "}",
      "",
      "export function unused() {",
      "  return tmpdir();",
      "}",
      "",
    ].join("\n"));
    writeFileSync(join(temp, "src", "adapters", "demo.mjs"), [
      "/**",
      " * demo relay",
      " */",
      'import { used } from "../core/lib.mjs";',
      "",
      "console.log(used());",
      "",
    ].join("\n"));
    const built = spawnSync(process.execPath, [join(temp, "tools", "build.mjs")], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const out = spawnSync(process.execPath, [join(temp, "skills", "switchboard-demo", "scripts", "relay.mjs")], { encoding: "utf8" });
    assert.equal(out.stdout.trim(), join("a", "b"));
    const source = readFileSync(join(temp, "skills", "switchboard-demo", "scripts", "relay.mjs"), "utf8");
    assert.doesNotMatch(source, /function unused/);
    assert.doesNotMatch(source, /tmpdir/);
    writeFileSync(join(temp, "src", "adapters", "demo.mjs"), '/**\n * x\n */\nimport fs from "node:fs";\nfs;\n');
    assert.notEqual(spawnSync(process.execPath, [join(temp, "tools", "build.mjs")], { encoding: "utf8" }).status, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
