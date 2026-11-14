#!/usr/bin/env node
// Live verification: run each installed implementer CLI through its relay
// against a throwaway git repository and record what actually happened, in a
// form that can back the README's "Verification status" list.
//
// This spends real tokens on your own CLI accounts, so it only dispatches with
// --run; without it, it prints the plan.
//
// Usage:
//   node tools/verify-live.mjs [--run] [--only claude,codex] [--arg claude=--model=haiku ...]
//                              [--timeout 10m] [--out <dir>]
//
// Per CLI (installed and not known to be logged out):
//   read-only  a brief that only reads; passes when the run completes, no file
//              changes, and the tripwire (where the relay has one) reports false
//   write      a brief that creates switchboard-check.txt; passes when the run
//              completes, the file holds "switchboard ok", and touchedFiles reports it
// Results: <out>/verify-<date>-<platform>.json and a .md with README lines.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDuration } from "../src/core/duration.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const discoverScript = join(root, "skills", "switchboard-setup", "scripts", "discover.mjs");

const READ_BRIEF = `List the files in this repository and summarize what README.md says in one sentence.

This is a read-only task: do not create, modify, or delete any file, and do not run commands that write.
Report the file list and the one-sentence summary.`;
const WRITE_BRIEF = `Create a file named switchboard-check.txt in the repository root containing exactly one line:

switchboard ok

Do not modify, create, or delete any other file, and do not commit.
Report what you created.`;

const platformName = { darwin: "macOS", linux: "Linux", win32: "native Windows" }[platform()] || platform();

function fail(message) {
  process.stderr.write(`verify-live: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { run: false, only: null, extra: {}, timeout: "10m", out: join(root, "verification") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (argv[i + 1] === undefined) fail(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };
    if (arg === "--run") opts.run = true;
    else if (arg === "--only") opts.only = new Set(value().split(",").map((key) => key.trim()).filter(Boolean));
    else if (arg === "--timeout") {
      opts.timeout = value();
      if (parseDuration(opts.timeout) === null) fail(`--timeout ${opts.timeout} is not a valid h/m/s duration`);
    }
    else if (arg === "--out") opts.out = resolve(value());
    else if (arg === "--arg") {
      const spec = value();
      const at = spec.indexOf("=");
      if (at < 1) fail(`--arg takes <key>=<relay flag>, e.g. claude=--model=haiku (got ${spec})`);
      const key = spec.slice(0, at);
      // "--model=haiku" becomes two argv tokens for the relay's spec parser.
      const flag = spec.slice(at + 1);
      const eq = flag.indexOf("=");
      (opts.extra[key] ||= []).push(...(flag.startsWith("--") && eq > 0 ? [flag.slice(0, eq), flag.slice(eq + 1)] : [flag]));
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((line) => line.startsWith("//")).map((line) => line.replace(/^\/\/ ?/, "")).join("\n")}\n`);
      process.exit(0);
    } else fail(`unknown option: ${arg}`);
  }
  return opts;
}

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-verify-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init", "-q"]);
  writeFileSync(join(dir, "README.md"), "# Sample\n\nA tiny repository used to verify Switchboard relays.\n");
  writeFileSync(join(dir, "notes.txt"), "first line\n");
  git(["add", "."]);
  git(["-c", "user.name=switchboard", "-c", "user.email=switchboard@example.invalid", "commit", "-qm", "init"]);
  return dir;
}

function porcelain(dir) {
  return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
}

function runCheck(cli, kind, opts) {
  const repo = freshRepo();
  const out = mkdtempSync(join(tmpdir(), "switchboard-verify-out-"));
  const briefPath = join(out, "..", `${out.split(/[\\/]/).pop()}-brief.txt`);
  writeFileSync(briefPath, kind === "read-only" ? READ_BRIEF : WRITE_BRIEF);
  const args = [
    join(root, "skills", `switchboard-${cli.key}`, "scripts", "relay.mjs"),
    "--brief", briefPath, "--cd", repo, "--out-dir", out, "--timeout", opts.timeout,
    ...(kind === "read-only" ? [cli.readOnlyFlag] : []),
    ...(opts.extra[cli.key] || []),
  ];
  const started = Date.now();
  // The hard cap follows the relay's own budget, plus room for its kill and report.
  const proc = spawnSync(process.execPath, args, { encoding: "utf8", timeout: parseDuration(opts.timeout) + 2 * 60_000 });
  const resultPath = join(out, "result.json");
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;
  const status = porcelain(repo);
  let passed;
  let detail;
  if (!result) {
    passed = false;
    detail = `no result.json (relay exit ${proc.status}): ${(proc.stderr || "").trim().split("\n").pop()}`;
  } else if (kind === "read-only") {
    // The relay's tripwire is the authority where it exists: it ignores the implementer's own
    // bookkeeping that a bare porcelain check would count.
    const tripwire = result.readOnlyViolation;
    passed = result.status === "completed" && (tripwire === undefined ? status === "" : tripwire === false);
    detail = `status ${result.status}, tree ${status === "" ? "unchanged" : "CHANGED"}, readOnlyViolation ${tripwire ?? "n/a"}`;
  } else {
    const file = join(repo, "switchboard-check.txt");
    const content = existsSync(file) ? readFileSync(file, "utf8").trim() : null;
    const reported = (result.touchedFiles || []).some((line) => line.includes("switchboard-check.txt"));
    passed = result.status === "completed" && content === "switchboard ok" && reported;
    detail = `status ${result.status}, switchboard-check.txt ${content === null ? "missing" : JSON.stringify(content)}, touchedFiles ${reported ? "reports it" : "does not report it"}`;
  }
  const record = {
    kind,
    passed,
    detail,
    seconds: Math.round((Date.now() - started) / 1000),
    status: result?.status ?? null,
    exitCode: result?.exitCode ?? proc.status,
    tokens: result?.tokens ?? null,
    totalCostUsd: result?.totalCostUsd ?? null,
    resultPath: result ? resultPath : null,
  };
  rmSync(repo, { recursive: true, force: true });
  rmSync(briefPath, { force: true });
  return record;
}

const READ_ONLY_FLAG = {
  claude: "--read-only", codex: "--read-only", cursor: "--read-only",
  omp: "--read-only", opencode: "--read-only", pi: "--read-only",
};

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const found = spawnSync(process.execPath, [discoverScript], { encoding: "utf8" });
  if (found.status !== 0) fail(`discover.mjs failed: ${found.stderr}`);
  const discovered = JSON.parse(found.stdout).discovered
    .filter((cli) => !opts.only || opts.only.has(cli.key))
    .map((cli) => ({ ...cli, readOnlyFlag: READ_ONLY_FLAG[cli.key] ?? null }));
  if (opts.only) {
    const missing = [...opts.only].filter((key) => !discovered.some((cli) => cli.key === key));
    if (missing.length) process.stderr.write(`verify-live: not installed here: ${missing.join(", ")}\n`);
  }
  const runnable = discovered.filter((cli) => cli.authenticated !== false);
  for (const cli of discovered.filter((item) => item.authenticated === false)) {
    process.stderr.write(`verify-live: skipping ${cli.key}: installed but logged out\n`);
  }
  if (!runnable.length) fail("no installed, logged-in implementer CLI found");

  process.stdout.write(`Plan (${platformName}):\n`);
  for (const cli of runnable) {
    const checks = [cli.readOnlyFlag ? "read-only" : null, "write"].filter(Boolean).join(" + ");
    process.stdout.write(`  ${cli.key.padEnd(12)} ${cli.version ?? "?"}  ${checks}${opts.extra[cli.key] ? `  extra: ${opts.extra[cli.key].join(" ")}` : ""}\n`);
  }
  if (!opts.run) {
    process.stdout.write("\nDry run: nothing dispatched. Add --run to spend real tokens on these checks.\n");
    return;
  }

  const results = [];
  for (const cli of runnable) {
    const checks = [];
    if (cli.readOnlyFlag) checks.push(runCheck(cli, "read-only", opts));
    checks.push(runCheck(cli, "write", opts));
    for (const check of checks) {
      process.stdout.write(`  ${check.passed ? "pass" : "FAIL"}  ${cli.key} ${check.kind}: ${check.detail} (${check.seconds}s)\n`);
    }
    results.push({ key: cli.key, skill: cli.skill, binary: cli.binary, version: cli.version, checks });
  }

  const date = new Date().toISOString().slice(0, 10);
  const doc = { schema: "switchboard-verify.v1", date, platform: platformName, osRelease: release(), node: process.version, results };
  mkdirSync(opts.out, { recursive: true });
  const base = join(opts.out, `verify-${date}-${platform()}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(doc, null, 2)}\n`);
  const lines = results.map((entry) => {
    const parts = entry.checks.map((check) => (check.kind === "read-only"
      ? `a \`--read-only\` dispatch ${check.passed ? "completed with no read-only violation" : `did NOT pass (${check.detail})`}`
      : `a write dispatch ${check.passed ? "created the briefed file and reported it in `touchedFiles`" : `did NOT pass (${check.detail})`}`));
    return `- \`${entry.skill}\` — ${platformName}, \`${entry.binary}\` ${entry.version}: ${parts.join("; ")} (Switchboard live check, ${date}).`;
  });
  writeFileSync(`${base}.md`, `${lines.join("\n")}\n`);
  process.stdout.write(`\nresults: ${base}.json\nREADME lines: ${base}.md\n`);
  process.exit(results.every((entry) => entry.checks.every((check) => check.passed)) ? 0 : 1);
}

main();
