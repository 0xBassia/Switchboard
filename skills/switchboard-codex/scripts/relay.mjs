#!/usr/bin/env node
/**
 * Switchboard · switchboard-codex · relay.mjs
 *
 * Dispatch a self-contained brief to the OpenAI Codex CLI (`codex exec`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Codex-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified on Claude Code; other shell-capable agents
 * (OpenCode, Cursor, …) are designed-for but not yet verified.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `codex` and `git`. The `codex` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * It deliberately does NOT commit. Whether Codex's sandbox can write `.git`
 * varies by Codex version, OS, and execution path, so committing is always the
 * orchestrator's job — after it reviews the diff and re-runs the project gates.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Codex (default: current directory).
 *   --lane <name>           Fleet lane from switchboard-setup config (dials apply; explicit flags win).
 *   --model <name>          Codex model (default: Codex's own configured default).
 *   --effort <level>        Reasoning effort, passed to Codex as
 *                           `-c model_reasoning_effort=<level>` (default: Codex's
 *                           own configured default).
 *   --subagent-model <name> Default model for subagents Codex spawns during the run,
 *                           passed as `-c agents.default_subagent_model=<name>`.
 *   --subagent-effort <level>
 *                           Default reasoning effort for those subagents, passed as
 *                           `-c agents.default_subagent_reasoning_effort=<level>`.
 *                           Without either, subagents follow Codex's own config. A model
 *                           TOML reads as a number (e.g. 5.5) fails at startup; an
 *                           unknown model or unsupported effort fails only the spawn, so
 *                           the run can still exit 0. Pass them again on every resume:
 *                           Codex does not carry them over.
 *   --web-search <mode>     Codex's web search mode, passed as `-c web_search=<mode>`
 *                           (Codex's modes: disabled | cached | indexed | live; default:
 *                           Codex's own configured default). Search is a hosted tool, so
 *                           it works under every sandbox, read-only included. Pass it
 *                           again on every resume: Codex does not carry it over.
 *   --network-access        Allow network access inside the workspace-write sandbox, passed
 *                           to Codex as `-c sandbox_workspace_write.network_access=true`.
 *                           Pass it again on every resume, with the sandbox named by
 *                           --sandbox or a fleet lane: Codex does not carry it over.
 *                           Rejected with a read-only sandbox, which Codex keeps offline.
 *   --sandbox <mode>        read-only | workspace-write | danger-full-access
 *                           (default: workspace-write).
 *   --read-only             Shortcut for --sandbox read-only (review/diagnosis, no edits).
 *   --resume-last           Continue the most recent Codex session; send only the delta brief.
 *                           An explicit --sandbox/--read-only override applies to the resumed turn.
 *   --session <id>          Continue a specific Codex session by thread id (from a prior
 *                           result.json). Safer than --resume-last when other Codex runs
 *                           may have happened since - "last" is global, not per-repo.
 *                           Mutually exclusive with --resume-last.
 *   --clean-env             Launch Codex and its version preflight with only runtime basics.
 *                           Changes inherited variables only; does not protect files or other
 *                           same-user secrets.
 *   --ignore-user-config    Do not load Codex user config. Authentication still uses CODEX_HOME;
 *                           useful for isolated reviews that must not start ambient MCP servers.
 *   --keep-env <name>       Keep one additional variable under --clean-env (repeatable).
 *                           Required for environment-backed auth and other stripped variables.
 *   --skip-git-repo-check   Allow running outside a git repository.
 *   --timeout <dur>         Relay-side watchdog (default: off). Durations use h/m/s
 *                           strings like 30m or 2h. On expiry the codex child is killed
 *                           and result.json gets status "timeout". Codex has no timeout
 *                           flag of its own, so the watchdog is relay-only.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, codexVersion, threadId (for a later resume), finalMessage
 *   (Codex's own report), touchedFiles (git porcelain, null if git can't report), stderrTail on a
 *   run that did not succeed, and the paths to events.jsonl, final.txt and stderr.txt. stderr.txt
 *   holds the complete stderr stream; stderrTail is up to 20 nonblank lines from its final
 *   64 KiB, with a partial first line marked as truncated.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `codex` binary exits 127;
 * otherwise the exit code mirrors Codex's own (0 success, non-zero failure).
 * If the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, timeout (the --timeout watchdog fired), aborted (the relay
 * itself was killed and forwarded the kill to codex), or codex_unavailable. An
 * orchestrator that polls for the file must therefore also treat a non-zero exit
 * with no file as a usage error.
 */

// GENERATED by tools/build.mjs from src/adapters/codex.mjs and src/core/.
// Do not edit this file: edit the sources, then run `node tools/build.mjs`.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { constants, devNull, homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

// ---- src/core/cli.mjs

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}


// The relay's leading block comment doubles as --help text.
function headerComment(fallback = "relay.mjs - dispatch a brief to an implementer CLI\n") {
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return fallback;
  return `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n`;
}


// Flags every relay accepts. Adapters add their own; an adapter entry with the
// same name replaces the common one.
const COMMON_FLAGS = {
  "--brief": { key: "brief" },
  "--cd": { key: "cd", path: true },
  "--lane": { key: "lane" },
  "--timeout": { key: "timeout" },
  "--out-dir": { key: "outDir", path: true },
};


// spec: { [flag]: { key, kind?: "value" | "bool" | "list", path?, pattern?, choices?, label? } }
// "value" (default) takes the next argv token; "bool" sets true; "list" appends.
// `pattern` / `choices` validate the value with a uniform error message.
// Returns { opts, flagged } where `flagged` holds every key set explicitly.
function parseArgs(argv, spec, defaults) {
  const flags = { ...COMMON_FLAGS, ...spec };
  const flagged = new Set();
  const opts = {
    lane: null,
    laneSource: null,
    brief: null,
    cd: process.cwd(),
    outDir: null,
    ...defaults,
  };
  for (const [flag, def] of Object.entries(flags)) {
    if (def.kind === "list" && !Array.isArray(opts[def.key])) opts[def.key] = [];
    if (def.kind === "bool" && opts[def.key] === undefined) opts[def.key] = false;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(headerComment());
      process.exit(0);
    }
    const def = Object.hasOwn(flags, arg) ? flags[arg] : null;
    if (!def) fail(`unknown option: ${arg}`);
    flagged.add(def.key);
    if (def.kind === "bool") {
      opts[def.key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) fail(`${arg} requires a value`);
    // An empty path would resolve to the current directory and quietly make it the artifact dir.
    if (value === "") fail(`${arg} requires a non-empty value`);
    i += 1;
    checkValue(arg, value, def);
    const stored = def.path ? resolve(value) : value;
    if (def.kind === "list") opts[def.key].push(stored);
    else opts[def.key] = stored;
  }
  return { opts, flagged };
}


function checkValue(label, value, def) {
  if (def.choices && !def.choices.includes(value)) {
    fail(`${label} must be one of: ${def.choices.join(", ")} (got "${value}")`);
  }
  if (def.pattern && !def.pattern.test(value)) {
    fail(`${label} "${value}" contains unsupported characters`);
  }
}


// Fails unless at most one of the named keys is set.
function exclusive(opts, pairs) {
  for (const [a, b, message] of pairs) {
    if (opts[a] && opts[b]) fail(message);
  }
}


// Some editors and PowerShell (`>` and Out-File) save briefs as UTF-16 with a BOM;
// decode the common BOMs instead of dispatching mojibake, and refuse NUL bytes, which
// no CLI's argv accepts anyway.
function decodeBrief(bytes, label) {
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    if ((bytes.length - 2) % 2) fail(`${label} is not valid UTF-16; save the brief as UTF-8 text`);
    text = bytes.subarray(2).toString("utf16le");
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    if ((bytes.length - 2) % 2) fail(`${label} is not valid UTF-16; save the brief as UTF-8 text`);
    text = Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = bytes.subarray(3).toString("utf8");
  } else {
    text = bytes.toString("utf8");
  }
  if (text.includes("\0")) fail(`${label} contains NUL bytes; save the brief as UTF-8 text`);
  return text;
}


function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    let bytes;
    try {
      bytes = readFileSync(opts.brief);
    } catch (error) {
      fail(`cannot read brief file ${opts.brief}: ${error.message}`);
    }
    return decodeBrief(bytes, `brief file ${opts.brief}`);
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  let bytes;
  try {
    bytes = readFileSync(0);
  } catch {
    return "";
  }
  return decodeBrief(bytes, "the brief on stdin");
}

// ---- src/core/duration.mjs

const MAX_TIMER_MS = 2_147_483_647;


function parseDuration(duration) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  try {
    const seconds =
      BigInt(match[1] || 0) * 3600n +
      BigInt(match[2] || 0) * 60n +
      BigInt(match[3] || 0);
    const milliseconds = seconds * 1000n;
    if (milliseconds <= 0n || milliseconds > BigInt(MAX_TIMER_MS)) return null;
    return Number(milliseconds);
  } catch {
    return null;
  }
}

// ---- src/core/proc.mjs

function refuseNativeWindows() {
  if (process.platform !== "win32") return;
  process.stderr.write("switchboard: native Windows is not supported; run it inside WSL (https://learn.microsoft.com/windows/wsl/)\n");
  process.exit(2);
}


// POSIX lookup treats an empty or relative PATH entry (a stray ":" from PATH=$X:$PATH)
// as a directory relative to the child's cwd, which is the untrusted --cd checkout, so
// only absolute entries are kept, for the relay and everything it starts.
function guardExePath() {
  if (process.env.PATH === undefined) return;
  const entries = process.env.PATH.split(":");
  const kept = entries.filter((entry) => isAbsolute(entry));
  if (kept.length !== entries.length) process.env.PATH = kept.join(":");
}


function signalExitCode(signal, fallback = 15) {
  return 128 + (constants.signals[signal] || fallback);
}


function killChild(child, signal = "SIGTERM") {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process group already exited.
    }
  }
}


// launch: { command, args, env?, cwd?, stdin? }
// Children lead a new process group so killChild reaches grandchildren. No shell
// ever runs: the command and its args go to execve as they are.
function spawnLaunch(launch, extra = {}) {
  guardExePath();
  const options = {
    cwd: launch.cwd,
    env: launch.env || process.env,
    stdio: [launch.stdin === undefined || launch.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    detached: true,
    ...extra,
  };
  return spawn(launch.command, launch.args, options);
}


// Runs `launch` to completion with a hard deadline and resolves with
// { version, error }. `version` is null with no error when the binary is
// missing; any other failure is an error, shaped like execFileSync's
// (code: "ETIMEDOUT" | status | stderr), so a broken CLI is never dispatched to.
function probeVersion(launch, timeoutMs, { parse = (out) => out.trim(), onChild } = {}) {
  return new Promise((done) => {
    let child;
    try {
      child = spawnLaunch({ ...launch, stdin: null });
    } catch (error) {
      done({ version: null, error: error.code === "ENOENT" ? null : error });
      return;
    }
    if (onChild) onChild(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Whatever the outcome, nothing the probe started may outlive it: a --version that
      // forks a background child would otherwise keep running through dispatch.
      killChild(child, "SIGKILL");
      if (onChild) onChild(null);
      done(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child, "SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      // If the kill cannot land, "close" may never fire; do not wait on it.
      setTimeout(() => finish({ version: null, error: Object.assign(new Error("version probe timed out"), { code: "ETIMEDOUT", stderr }) }), 2_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { if (stdout.length < 65_536) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 65_536) stderr += chunk; });
    child.on("error", (error) => {
      finish({ version: null, error: error.code === "ENOENT" ? null : error });
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish({ version: null, error: Object.assign(new Error("version probe timed out"), { code: "ETIMEDOUT", stderr }) });
        return;
      }
      if (code !== 0) {
        finish({ version: null, error: Object.assign(new Error(`version probe exited ${code ?? signal}`), { status: code, signal, stderr }) });
        return;
      }
      finish({ version: parse(stdout, stderr) || "unknown", error: null });
    });
  });
}

// ---- src/core/git.mjs

function hardenGit() {
  const count = Number(process.env.GIT_CONFIG_COUNT) || 0;
  for (let i = 0; i < count; i += 1) {
    if (process.env[`GIT_CONFIG_KEY_${i}`] === "core.fsmonitor" && process.env[`GIT_CONFIG_VALUE_${i}`] === "") return;
  }
  process.env[`GIT_CONFIG_KEY_${count}`] = "core.fsmonitor";
  process.env[`GIT_CONFIG_VALUE_${count}`] = "";
  process.env.GIT_CONFIG_COUNT = String(count + 1);
}


// Settings that make status, ls-files, diff or hash-object run a program, from any
// scope and any included file (--includes), each with the file it came from.
const COMMAND_KEYS = "^(core\\.(fsmonitor|hookspath|worktree|attributesfile|pager|editor|sshcommand|gitproxy)|filter\\.|diff\\.[^.]+\\.(command|textconv)|merge\\.[^.]+\\.driver|include\\.|includeif\\.)";


let pinned = null;

let lastError = null;


// The relay's own git calls never write the index (an index write runs the
// post-index-change hook) and never run hooks at all; the implementer keeps its own.
const SAFE_ARGS = ["-c", `core.hooksPath=${devNull}`];


// Clean, smudge and process filters run during status and ls-files whenever an
// attribute names them, and the implementer can add a .gitattributes line at will.
// So every filter driver git knows of is switched off by name for the relay's own
// calls: an empty command means "no filter", and a required filter is no longer
// required. Passed through GIT_CONFIG_* (no "=" splitting), so any name is safe.
function safeEnv(filters = []) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  let count = Number(env.GIT_CONFIG_COUNT) || 0;
  for (const name of filters) {
    for (const [key, value] of [["clean", ""], ["smudge", ""], ["process", ""], ["required", "false"]]) {
      env[`GIT_CONFIG_KEY_${count}`] = `filter.${name}.${key}`;
      env[`GIT_CONFIG_VALUE_${count}`] = value;
      count += 1;
    }
  }
  env.GIT_CONFIG_COUNT = String(count);
  return env;
}


// Filter driver names from `config --null --name-only` output (filter.<name>.<var>).
function filterNames(output, into) {
  for (const key of output.split("\0")) {
    if (!/^filter\./i.test(key)) continue;
    const last = key.lastIndexOf(".");
    if (last > 7) into.add(key.slice(7, last));
  }
}


function plainGit(cwd, args) {
  guardExePath();
  hardenGit();
  return execFileSync("git", [...SAFE_ARGS, ...args], {
    cwd, env: safeEnv(), encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"],
  }).replace(/\r?\n$/, "");
}


// A file's bytes, or every file's bytes under a directory, into the hash.
function hashPath(hash, path) {
  hash.update("\0").update(path).update("\0");
  let stat;
  try { stat = statSync(path); } catch (error) { hash.update(`<${error.code || "unreadable"}>`); return; }
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) hashPath(hash, join(path, name));
  } else if (stat.isFile()) {
    try { hash.update(readFileSync(path)); } catch (error) { hash.update(`<${error.code || "unreadable"}>`); }
  }
}


// The command-running settings as git resolves them for the pinned repository, plus
// each registered submodule's gitdir pointer (where a submodule's own config lives).
// git status recurses into registered submodules and applies their own config,
// info/attributes and hooks, so those are part of the surface too.
function commandSurface(gitDir, workTree) {
  const hash = createHash("sha256");
  const filters = new Set();
  const git = (args, encoding) => execFileSync("git", [...SAFE_ARGS, "--git-dir", gitDir, "--work-tree", workTree, ...args], {
    cwd: workTree, env: safeEnv(), encoding, timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
  });
  // Exit 1 is "no such keys"; anything else means git could not say.
  const config = (args) => {
    try { return git(["config", "--includes", "--null", ...args], "utf8"); } catch (error) {
      if (error?.status === 1) return "";
      throw error;
    }
  };
  try {
    hash.update(config(["--show-origin", "--get-regexp", COMMAND_KEYS]));
    filterNames(config(["--name-only", "--get-regexp", "^filter\\."]), filters);
  } catch {
    return null;
  }
  try {
    for (const field of git(["ls-files", "--stage", "-z"], "utf8").split("\0")) {
      if (!field.startsWith("160000 ")) continue;
      const path = join(workTree, field.slice(field.indexOf("\t") + 1));
      const pointer = join(path, ".git");
      hashPath(hash, pointer);
      let moduleDir = pointer;
      try {
        const target = /^gitdir: (.+)$/m.exec(readFileSync(pointer, "utf8"));
        if (target) moduleDir = resolve(path, target[1].trim());
      } catch { /* a directory .git, or none */ }
      for (const name of ["config", "config.worktree", join("info", "attributes"), "hooks"]) hashPath(hash, join(moduleDir, name));
      // git status applies the submodule's own filters inside it.
      for (const name of ["config", "config.worktree"]) {
        try { filterNames(config(["--file", join(moduleDir, name), "--name-only", "--get-regexp", "^filter\\."]), filters); } catch { /* absent */ }
      }
    }
  } catch { /* no index yet */ }
  return { digest: hash.digest("hex"), filters: [...filters] };
}


// Called once before dispatch. A --cd outside any repository pins "no repository":
// a repository the implementer creates there later is never consulted.
function pinGitRepository(cwd) {
  const at = resolve(cwd);
  lastError = null;
  try {
    const gitDir = plainGit(at, ["rev-parse", "--absolute-git-dir"]);
    const workTree = plainGit(at, ["rev-parse", "--show-toplevel"]);
    const surface = commandSurface(gitDir, workTree);
    pinned = { cwd: at, gitDir, workTree, surface: surface?.digest ?? null, filters: surface?.filters ?? [] };
  } catch {
    pinned = { cwd: at, gitDir: null };
  }
  return pinned;
}


// true: nothing pinned, or no command-running setting changed since the pin.
// false: one changed. null: git could not say (so neither answer is earned).
function gitPinIntact() {
  if (!pinned || pinned.gitDir === null) return true;
  if (pinned.surface === null) return null;
  const now = commandSurface(pinned.gitDir, pinned.workTree);
  if (now === null) return null;
  return now.digest === pinned.surface;
}


// Why the last git call refused or failed, for the result; null after a success.
function lastGitError() {
  return lastError;
}


function insidePinned(cwd) {
  if (!pinned) return false;
  // By component: an entry named "..cache" is inside, only ".." itself climbs out.
  const within = (r) => r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
  if (within(relative(pinned.cwd, resolve(cwd)))) return true;
  return Boolean(pinned.workTree) && within(relative(pinned.workTree, resolve(cwd)));
}


// git for the run's repository. Throws when git cannot report safely; callers turn
// that into "unknown" (null), never into a clean answer.
function runGit(cwd, args, options = {}) {
  guardExePath();
  hardenGit();
  let full = args;
  let filters = [];
  if (insidePinned(cwd)) {
    if (pinned.gitDir === null) {
      lastError = "git could not identify a repository at --cd when the run started";
      throw new Error(lastError);
    }
    const intact = gitPinIntact();
    if (intact !== true) {
      lastError = intact === false
        ? "a git setting that can run commands changed during the run, so git was not asked"
        : "git could not read the repository's settings, so it was not asked";
      throw new Error(lastError);
    }
    full = ["--git-dir", pinned.gitDir, "--work-tree", pinned.workTree, ...args];
    filters = pinned.filters;
  }
  try {
    const output = execFileSync("git", [...SAFE_ARGS, ...full], {
      cwd, env: safeEnv(filters), timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, ...options,
    });
    lastError = null;
    return output;
  } catch (error) {
    lastError = error?.code === "ETIMEDOUT" || error?.signal === "SIGKILL" ? "git did not answer within 10 seconds" : "git could not report";
    throw error;
  }
}


// `git status --porcelain` lines for the working tree, or null when git cannot
// report (not a repository, git missing, a hung probe, a changed command setting).
function gitTouchedFiles(cwd) {
  try {
    const output = runGit(cwd, ["status", "--porcelain"], { encoding: "utf8" });
    return output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

// ---- src/core/lane.mjs

const LANE_CONFLICTS = {
  agent: ["agent", "readOnly"],
  sandbox: ["sandbox", "readOnly"],
  readOnly: ["readOnly"],
};


function applyFleetLane(opts, flagged, implementer, { conflicts = {}, onDial } = {}) {
  if (!opts.lane) return;
  const script = join(dirname(fileURLToPath(import.meta.url)), "../../switchboard-setup/scripts/lane.mjs");
  if (!existsSync(script)) {
    fail("--lane requires the switchboard-setup skill installed beside this relay");
  }
  const r = spawnSync(
    process.execPath,
    [script, "resolve", "--cwd", opts.cd, "--lane", opts.lane, "--implementer", implementer],
    { encoding: "utf8", env: process.env, timeout: 30_000, killSignal: "SIGKILL" },
  );
  if (r.error) fail(`lane resolve failed: ${r.error.message}`);
  if (r.status !== 0) {
    fail((r.stderr || "lane resolve failed").trim().replace(/^lane\.mjs:\s*/, ""));
  }
  let resolved;
  try {
    const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
    resolved = JSON.parse(lines[lines.length - 1]);
  } catch {
    fail("lane resolve returned invalid JSON");
  }
  opts.laneSource = resolved.source;
  const table = { ...LANE_CONFLICTS, ...conflicts };
  for (const [field, value] of Object.entries(resolved.dials || {})) {
    const deciders = table[field] || [field];
    if (deciders.some((key) => flagged.has(key))) continue;
    opts[field] = value;
    if (onDial) onDial(field, value, opts);
  }
}

// ---- src/core/run.mjs

const RESULT_SCHEMA = "switchboard-relay.result.v1";


function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}


// Briefs and transcripts can hold sensitive context, so artifacts are private:
// the default directory is a fresh 0700 mkdtemp and every file is 0600.
const PRIVATE_FILE = 0o600;


// Removes `path` only when its directory holds an entry with exactly that
// name. On a case-insensitive filesystem rmSync("final.txt") would otherwise
// delete a user's FINAL.TXT sitting in an in-repo --out-dir.
function removeExact(path) {
  let entries;
  try { entries = readdirSync(dirname(path)); } catch { return; }
  if (entries.includes(basename(path))) rmSync(path, { force: true });
}


// Unlink, then create exclusively: a stale symlink at an artifact path is
// removed, never written through, and a case-aliased user file makes the
// create fail rather than be overwritten.
function writePrivate(path, data) {
  removeExact(path);
  writeFileSync(path, data, { encoding: "utf8", mode: PRIVATE_FILE, flag: "wx" });
  try { chmodSync(path, PRIVATE_FILE); } catch { /* best effort on filesystems without modes */ }
}


// Creates an artifact exclusively and keeps it open: every later write goes through
// the descriptor, so an entry swapped mid-run (a link planted by the implementer)
// can never redirect it. "wx+" so the same descriptor serves the stderr tail.
function openPrivate(path) {
  removeExact(path);
  const fd = openSync(path, "wx+", PRIVATE_FILE);
  try { fchmodSync(fd, PRIVATE_FILE); } catch { /* best effort on filesystems without modes */ }
  return fd;
}


// Artifacts the implementer writes itself (codex's final.txt) get the
// relay's own mode once it has exited. Links are left alone: chmod would follow them.
function privatizeArtifacts(run) {
  if (!runDirIntact(run)) return;
  for (const path of runArtifactPaths(run)) {
    try {
      if (lstatSync(path).isFile()) chmodSync(path, PRIVATE_FILE);
    } catch { /* absent, or a filesystem without modes */ }
  }
}


// A symlink at --out-dir, or at any directory between --cd and an --out-dir inside it,
// is refused before anything is created: a link committed in the repository (or left by
// an earlier implementer) would otherwise steer artifacts, and the removal of stale
// ones, into a directory of its choosing. Links above --cd, or outside it, are the
// user's own and are followed.
function linkedOutDir(outDir, cd) {
  const target = resolve(outDir);
  const roots = [resolve(cd)];
  try { roots.push(realpathSync(cd)); } catch { /* validated as a directory already */ }
  const below = (path) => roots.some((root) => {
    const rel = relative(root, path);
    // By component: an entry named "..cache" is below the root, only ".." climbs out.
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  });
  for (let path = target; ; path = dirname(path)) {
    let stat = null;
    try { stat = lstatSync(path); } catch { /* not created yet */ }
    if (stat?.isSymbolicLink() && (path === target || below(path))) return path;
    if (dirname(path) === path) return null;
  }
}


// extra: { pathKey: fileName } for adapter-specific artifacts (profile.json, ...).
function prepareRunDir(opts, brief, extra = {}) {
  let outDir = opts.outDir;
  if (outDir) {
    const link = linkedOutDir(outDir, opts.cd);
    if (link) fail(`--out-dir goes through a symbolic link (${link}); pass a real directory path`);
  }
  try {
    if (outDir) {
      mkdirSync(outDir, { recursive: true, mode: 0o700 });
    } else {
      const parent = join(tmpdir(), "switchboard-relay");
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      outDir = mkdtempSync(join(parent, `${basename(opts.cd) || "repo"}-${timestamp()}-`));
    }
  } catch (error) {
    fail(`cannot create the artifact directory ${outDir || tmpdir()}: ${error.message}`);
  }
  let identity;
  try {
    const realDir = realpathSync(outDir);
    const stat = lstatSync(realDir);
    identity = { realDir, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    fail(`cannot inspect the artifact directory ${outDir}: ${error.message}`);
  }
  const run = {
    outDir,
    dirIdentity: identity,
    startedAt: new Date().toISOString(),
    briefPath: join(outDir, "brief.txt"),
    finalPath: join(outDir, "final.txt"),
    eventsPath: join(outDir, "events.jsonl"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  for (const [key, name] of Object.entries(extra)) run[key] = join(outDir, name);
  try {
    // A reused --out-dir must not leak a previous run's report or result.
    removeExact(run.finalPath);
    removeExact(run.resultPath);
    writePrivate(run.briefPath, brief);
    run.eventsFd = openPrivate(run.eventsPath);
    run.stderrFd = openPrivate(run.stderrPath);
  } catch (error) {
    fail(`cannot write run artifacts in ${outDir}: ${error.message}`);
  }
  return run;
}


// The run directory is still the one created at the start: the same real path, still
// a directory (not a link), with the same device and inode. An implementer that renamed
// it and planted a link (or swapped a parent) would otherwise steer every later
// path-based write (final.txt, result.json, chmod) into a directory of its choosing.
function runDirIntact(run) {
  const id = run.dirIdentity;
  if (!id) return true;
  try {
    if (realpathSync(run.outDir) !== id.realDir) return false;
    const stat = lstatSync(id.realDir);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === id.dev && stat.ino === id.ino;
  } catch {
    return false;
  }
}


const RUN_DIR_MOVED = "the artifact directory was moved or replaced during the run, so nothing more was written there (result.json included)";


// Publish atomically so a polling orchestrator never reads a half-written file.
// The temp name is unpredictable and created exclusively ("wx"), so a symlink
// planted at it cannot redirect the write; rename replaces a link, never follows it.
function writeAtomic(path, text) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, text, { encoding: "utf8", mode: PRIVATE_FILE, flag: "wx" });
  renameSync(temporary, path);
}


function writeJsonAtomic(path, value) {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}


function runArtifactPaths(run) {
  return Object.entries(run).filter(([key]) => key.endsWith("Path")).map(([, path]) => path);
}


// fields(): the run's configuration and live state, re-read on every write.
// finish(result): last-moment additions (the read-only verdict).
function makeResultWriter(base, run, fields, finish) {
  return (outcome) => {
    const result = {
      schema: RESULT_SCHEMA,
      ...base,
      ...fields(),
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      eventsPath: run.eventsPath,
      stderrPath: run.stderrPath,
      ...outcome,
    };
    if (finish) finish(result);
    if (!runDirIntact(run)) {
      // Never publish through a swapped directory; the summary on stdout still reports.
      result.status = "failed";
      if (!result.exitCode) result.exitCode = 1;
      result.error = result.error ? `${RUN_DIR_MOVED}; ${result.error}` : RUN_DIR_MOVED;
      result.finalPath = null;
      Object.defineProperty(result, "unpublished", { value: true });
      return result;
    }
    writeJsonAtomic(run.resultPath, result);
    return result;
  };
}


const MAX_STDERR_TAIL_BYTES = 64 * 1024;


// The last 20 non-blank lines within the final 64 KiB of stderr.txt. A line cut
// by the window is marked, and a cut multibyte character is skipped, so the
// tail stays bounded and valid however long a single line is. `source` is the
// relay's own descriptor (never a path the implementer could have re-pointed)
// or, for a finished run, a path.
function readStderrTail(source) {
  const owned = typeof source !== "number";
  let fd;
  try {
    fd = owned ? openSync(source, "r") : source;
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_STDERR_TAIL_BYTES);
    const readStart = Math.max(0, start - 1);
    const buffer = Buffer.alloc(size - readStart);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, readStart + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    let offset = start - readStart;
    // The preceding byte distinguishes a cut line from a line starting at the window boundary.
    const partialLine = offset > 0 && buffer[0] !== 0x0a;
    while (partialLine && offset < bytesRead && (buffer[offset] & 0xc0) === 0x80) offset += 1;
    const lines = buffer.subarray(offset, bytesRead).toString("utf8").split(/\r?\n/).map((line) => line.trimEnd());
    if (partialLine && lines[0]?.trim()) lines[0] = `[truncated; read stderrPath] ${lines[0]}`;
    return lines.filter((line) => line.trim()).slice(-20);
  } catch {
    // A missing or unreadable diagnostic must not prevent the result from being published.
    return [];
  } finally {
    if (owned && fd !== undefined) closeSync(fd);
  }
}


const MAX_LISTED_FILES = 40;


// view: { name, versionField, lines?(result) => string[], report?, empty? }
function printSummary(result, resultPath, view) {
  const lines = [""];
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  ${view.name} ${result[view.versionField] ?? "?"}`);
  if (view.readOnly && result.readOnlyViolation === true) {
    lines.push("warning: a git-visible change was detected during this --read-only run; inspect the working tree immediately.");
  } else if (view.readOnly && result.readOnlyViolation === null) {
    lines.push("warning: this --read-only tripwire had incomplete coverage; inspect the working tree directly.");
  }
  if (result.signal === "SIGKILL" && result.status === "failed") {
    lines.push(`hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a ${view.name} error; check host memory and re-dispatch, or split the task into smaller briefs.`);
  }
  if (result.signal === "SIGTERM" && result.status === "failed") {
    lines.push(`hint: something outside the relay terminated ${view.name} (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status "timeout" or "aborted" instead; inspect the working tree before re-dispatching.`);
  }
  if (result.resumed) lines.push("mode: resumed an existing session");
  if (result.sessionId) {
    lines.push(view.resumeFlag === false
      ? `session id: ${result.sessionId}`
      : `session id (resume with: ${view.resumeFlag || "--session"} ${result.sessionId}): ${result.sessionId}`);
  }
  if (view.lines) lines.push(...view.lines(result));
  if (result.tokens) {
    const parts = [`in ${result.tokens.input ?? "?"}`, `out ${result.tokens.output ?? "?"}`];
    if (result.tokens.cacheRead !== null) parts.push(`cache read ${result.tokens.cacheRead}`);
    if (result.tokens.reasoning !== null) parts.push(`reasoning ${result.tokens.reasoning}`);
    lines.push(`tokens: ${parts.join(", ")}`);
  }
  if (typeof result.totalCostUsd === "number") lines.push(`cost: $${result.totalCostUsd}`);
  const touched = result.touchedFiles;
  if (touched === null || touched === undefined) {
    lines.push("touched files: git unavailable - inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, MAX_LISTED_FILES)) lines.push(`  ${file}`);
    if (touched.length > MAX_LISTED_FILES) lines.push(`  ... and ${touched.length - MAX_LISTED_FILES} more`);
  }
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push(`--- ${view.name} final report ---`);
  lines.push(result.finalMessage || view.empty || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(result.unpublished ? "result: not written (the artifact directory was replaced during the run)" : `result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ---- src/core/relay.mjs

const RELAY_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

const SIGKILL_GRACE_MS = 10_000;

const ABORT_GRACE_MS = 2_000;

const DRAIN_GRACE_MS = 500;

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;


const finiteOrNull = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);


// Adapters return whatever counts their CLI reports; anything missing or
// malformed becomes null, and no counts at all means `tokens: null`.
function normalizeTokens(raw) {
  if (!raw || typeof raw !== "object") return null;
  const tokens = {
    input: finiteOrNull(raw.input),
    output: finiteOrNull(raw.output),
    cacheRead: finiteOrNull(raw.cacheRead),
    cacheWrite: finiteOrNull(raw.cacheWrite),
    reasoning: finiteOrNull(raw.reasoning),
  };
  return Object.values(tokens).some((value) => value !== null) ? tokens : null;
}


// lstat, not existsSync: a dangling symlink is still an entry someone put there.
function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}


function checkDirectories(opts) {
  let cd;
  try { cd = statSync(opts.cd); } catch { fail(`--cd directory not found: ${opts.cd}`); }
  if (!cd.isDirectory()) fail(`--cd is not a directory: ${opts.cd}`);
  if (opts.outDir && existsSync(opts.outDir) && !statSync(opts.outDir).isDirectory()) {
    fail(`--out-dir is not a directory: ${opts.outDir}`);
  }
}


function onRelaySignals(handler) {
  const handlers = RELAY_SIGNALS.map((signal) => [signal, () => handler(signal)]);
  for (const [signal, fn] of handlers) process.on(signal, fn);
  return () => {
    for (const [signal, fn] of handlers) process.removeListener(signal, fn);
  };
}


// See src/README.md for the adapter contract.
async function runRelay(a) {
  // --help still answers; anything else on native Windows stops here, before any
  // lane lookup or artifact.
  const { opts, flagged } = parseArgs(process.argv.slice(2), a.flags || {}, { timeout: null, ...a.defaults });
  refuseNativeWindows();
  guardExePath();
  hardenGit();
  const name = a.name || a.key;
  // Result identity (`tool`, `<slug>_unavailable`) can differ from the lane key.
  const slug = a.slug || a.key;
  const unavailableStatus = `${slug.replace(/-/g, "_")}_unavailable`;
  applyFleetLane(opts, flagged, a.key, { conflicts: a.laneConflicts, onDial: a.onDial });
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  checkDirectories(opts);
  if (a.validate) a.validate(opts, flagged);

  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");
  if (a.checkBrief) a.checkBrief(brief, opts);
  if (a.maxBriefBytes) {
    const bytes = Buffer.byteLength(brief, "utf8");
    if (bytes > a.maxBriefBytes) fail(a.briefTooLarge(Math.round(bytes / 1024)));
  }

  const run = prepareRunDir(opts, brief, a.artifacts);
  const state = { sessionId: null, ...(a.state ? a.state(opts) : {}) };
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  let version = null;
  // Armed before the synchronous Git baseline: a signal that lands during it is
  // queued and handled right after, so it still produces a result instead of
  // the default instant death.
  let probeChild = null;
  // An abort before dispatch never compares a meaningful "after" state, and a
  // terminal ^C reaches the Git baseline too: the verdict is unknown, never false.
  let verdictKnown = true;
  // While an aborted implementer is still exiting, any verdict would be a guess.
  const verdictGate = { pending: false };
  const releasePreflight = onRelaySignals((signal) => {
    releasePreflight();
    verdictKnown = false;
    const result = report({
      status: "aborted",
      exitCode: signalExitCode(signal),
      signal,
      finalMessage: "",
      error: `the relay was killed by ${signal} during the ${name} version preflight; ${name} was not dispatched`,
    });
    if (probeChild) killChild(probeChild, "SIGKILL");
    process.exit(result.exitCode);
  });
  // Before dispatch: the repository every later git call is held to.
  pinGitRepository(opts.cd);
  const snapshot = a.tripwire && a.readOnly(opts) ? a.tripwire.snapshot(opts.cd, runArtifactPaths(run), a.tripwireIgnore) : null;

  const write = makeResultWriter(
    { lane: opts.lane, laneSource: opts.laneSource, tool: slug, workdir: opts.cd },
    run,
    () => ({
      ...a.fields(opts, state, run),
      [a.versionField]: version,
      sessionId: state.sessionId,
      // One usage shape for every implementer; null where the CLI does not report it.
      tokens: normalizeTokens(a.tokens ? a.tokens(state) : null),
      totalCostUsd: finiteOrNull(a.cost ? a.cost(state) : null),
    }),
    snapshot ? (result) => { result.readOnlyViolation = verdictKnown && !verdictGate.pending ? a.tripwire.check(snapshot) : null; } : null,
  );
  const view = {
    name,
    versionField: a.versionField,
    lines: a.summary,
    empty: a.emptyReport,
    resumeFlag: a.resumeFlag,
    // Tripwire warnings belong to read-only runs only; a write-capable run may
    // still carry `readOnlyViolation: null` for schema stability.
    readOnly: Boolean(snapshot) || Boolean(a.readOnly && a.readOnly(opts)),
  };
  const touched = () => {
    const files = gitTouchedFiles(opts.cd);
    return files && a.touched ? a.touched(files) : files;
  };
  // prepareRunDir removed any stale final.txt, so one that exists now and was
  // not written by the relay appeared during the run (a user file renamed into
  // an in-repo --out-dir, say). It is never replaced; the run fails instead.
  let finalOwned = false;
  // An adapter whose CLI writes final.txt itself (finalByImplementer) owns it.
  const finalBlocked = () => !a.finalByImplementer && !finalOwned && entryExists(run.finalPath);
  const finalMessage = () => {
    const message = a.final ? a.final(state) : "";
    if (message && !a.finalByImplementer && !finalBlocked() && runDirIntact(run)) {
      // Atomic: a symlink planted at final.txt mid-run is replaced, never written through.
      try {
        writeAtomic(run.finalPath, message);
        finalOwned = true;
      } catch { /* report it inline anyway */ }
    }
    return message;
  };
  const report = (outcome) => {
    const touchedFiles = touched();
    // Say why touchedFiles is null rather than leave the orchestrator to guess.
    const gitError = touchedFiles === null ? lastGitError() : null;
    const result = write({ finalMessage: finalMessage(), touchedFiles, ...(gitError ? { gitError } : {}), ...outcome });
    printSummary(result, run.resultPath, view);
    return result;
  };

  // Last line of defence: a bug in an adapter hook must still leave a result and
  // must not orphan the implementer's process group.
  const crash = (error) => {
    killChild(guard.child, "SIGKILL");
    try {
      report({ status: "failed", exitCode: 1, signal: null, error: `relay internal error: ${error && error.stack ? error.stack : error}` });
    } catch {
      process.stderr.write(`relay: internal error: ${error && error.stack ? error.stack : error}\n`);
    }
    process.exit(1);
  };
  const guard = { child: null };
  // A closed stdout/stderr (the orchestrator went away) must not turn into a
  // crash that overwrites the real outcome: result.json is the contract.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);

  // Preflight: prove the CLI exists and answers before sending it the brief.
  const probe = a.version ? a.version(opts) : null;
  const unavailable = () => {
    const result = report({
      status: unavailableStatus,
      exitCode: 127,
      signal: null,
      finalMessage: "",
      error: `\`${a.binary || a.key}\` was not found on PATH; nothing was dispatched`,
    });
    process.stderr.write(`relay: \`${a.binary || a.key}\` not found on PATH.${a.unavailableHint ? ` ${a.unavailableHint}` : ""}\n`);
    process.exit(result.exitCode);
  };
  if (probe && probe.unavailable) unavailable();
  if (probe) {
    const probeTimeoutMs = probe.timeoutMs ?? Math.min(timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS);
    const outcome = await probeVersion({ cwd: opts.cd, ...probe.launch }, probeTimeoutMs, {
      parse: probe.parse,
      onChild: (child) => { probeChild = child; guard.child = child; },
    });
    version = outcome.version;
    if (!outcome.version && !outcome.error) unavailable();
    if (outcome.error) {
      const error = outcome.error;
      const timedOut = error.code === "ETIMEDOUT";
      const stderr = String(error.stderr || "").trim();
      if (stderr) writeSync(run.stderrFd, `${stderr}\n`);
      const message = timedOut
        ? `${name} --version preflight timed out after ${probeTimeoutMs}ms; ${name} was not dispatched`
        : `${name} --version preflight failed${Number.isInteger(error.status) ? ` with exit ${error.status}` : ""}; ${name} was not dispatched`;
      const result = report({
        status: timedOut ? "timeout" : "failed",
        exitCode: timedOut ? 124 : Number.isInteger(error.status) && error.status !== 0 ? error.status : 1,
        signal: null,
        finalMessage: "",
        stderrTail: readStderrTail(run.stderrFd),
        error: message,
      });
      process.stderr.write(`relay: ${message}\n`);
      process.exit(result.exitCode);
    }
  }

  // prepare runs after the artifacts exist, so a refusal there (a flag the probed
  // version does not support, a profile that cannot be written) still gets a result.
  // An error with `usage: true` keeps the usage exit code 2.
  if (a.prepare) {
    try {
      await a.prepare(opts, run, state, brief);
    } catch (error) {
      const message = `${error && error.message ? error.message : String(error)}; ${name} was not dispatched`;
      const result = report({ status: "failed", exitCode: error?.usage ? 2 : 1, signal: null, finalMessage: "", error: message });
      process.stderr.write(`relay: ${message}\n`);
      process.exit(result.exitCode);
    }
  }
  releasePreflight();
  supervise(a, { name, opts, brief, run, state, timeoutMs, report, guard, probed: Boolean(probe), unavailableStatus, finalBlocked, verdictGate });
}


function supervise(a, { name, opts, brief, run, state, timeoutMs, report, guard, probed, unavailableStatus, finalBlocked, verdictGate }) {
  let launch;
  let child;
  try {
    launch = { cwd: opts.cd, ...a.launch(opts, brief, run, state) };
    child = spawnLaunch(launch);
    guard.child = child;
  } catch (error) {
    const result = report({ status: "failed", exitCode: 1, signal: null, error: error.message || String(error) });
    process.exit(result.exitCode);
  }

  // A handler that throws on one odd event must neither kill a good run nor
  // vanish: the run continues and result.json lists what went wrong.
  const eventErrors = [];
  const guarded = (fn) => (value) => {
    try {
      fn(value);
    } catch (error) {
      if (eventErrors.length < 5) eventErrors.push(String(error && error.message ? error.message : error));
    }
  };
  const parse = a.scanner
    ? a.scanner(guarded((event) => a.onEvent(event, state, run)))
    : guarded((text) => { if (text && a.onText) a.onText(text, state, run); });
  const reportRun = (outcome) => report(eventErrors.length ? { ...outcome, eventErrors } : outcome);
  // Files get the raw bytes; only in-memory parsing is decoded, across chunk
  // boundaries so a split multibyte character cannot corrupt the report.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let lastActivity = Date.now();
  // Through the descriptors opened at start, never by path: the implementer cannot
  // re-point an artifact mid-run.
  child.stdout.on("data", (chunk) => {
    lastActivity = Date.now();
    writeSync(run.eventsFd, chunk);
    parse(stdoutDecoder.write(chunk));
  });
  child.stderr.on("data", (chunk) => {
    lastActivity = Date.now();
    process.stderr.write(chunk);
    writeSync(run.stderrFd, chunk);
    const text = stderrDecoder.write(chunk);
    if (a.onStderr) a.onStderr(text, state);
  });

  let settled = false;
  let watchdogFired = false;
  let stallFired = false;
  let watchdogTimer = null;
  let sigkillTimer = null;
  let stallPoll = null;
  const dropPipes = () => {
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const disarm = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    if (stallPoll) clearInterval(stallPoll);
  };
  // Signal handlers stay installed after settling: a repeat signal during the
  // abort grace must be ignored, not fall through to the default (instant death).
  const settle = () => {
    if (settled) return false;
    settled = true;
    disarm();
    return true;
  };

  const fireWatchdog = () => {
    if (watchdogFired || settled) return;
    watchdogFired = true;
    if (stallPoll) clearInterval(stallPoll);
    child.once("exit", dropPipes);
    killChild(child);
    sigkillTimer = setTimeout(() => {
      if (!settled) killChild(child, "SIGKILL");
    }, SIGKILL_GRACE_MS);
  };
  if (timeoutMs !== null) watchdogTimer = setTimeout(fireWatchdog, timeoutMs);

  // Stall watchdog (opt-in per adapter): output is activity, and the clock
  // pauses while the adapter reports work in flight (a long silent tool call).
  // It catches an implementer that is alive but stuck, long before --timeout.
  const stallMs = a.stall ? a.stall.ms(opts) : null;
  if (stallMs) {
    stallPoll = setInterval(() => {
      if (watchdogFired || settled) return;
      if (a.stall.busy && a.stall.busy(state)) lastActivity = Date.now();
      else if (Date.now() - lastActivity >= stallMs) {
        stallFired = true;
        fireWatchdog();
      }
    }, Math.min(5_000, Math.max(250, Math.floor(stallMs / 4))));
  }

  // The relay's own death must still produce a result, and must take the
  // implementer with it.
  onRelaySignals((signal) => {
    if (!settle()) return;
    child.once("exit", dropPipes);
    killChild(child);
    const fields = () => ({
      status: "aborted",
      exitCode: signalExitCode(signal),
      signal,
      stderrTail: readStderrTail(run.stderrFd),
      error: `the relay was killed by ${signal}; ${name} was terminated with it — inspect the working tree before re-dispatching`,
    });
    // A first record in case the relay dies during the grace window; the implementer is
    // still exiting, so it carries no read-only verdict yet.
    verdictGate.pending = true;
    reportRun(fields());
    setTimeout(() => {
      killChild(child, "SIGKILL");
      verdictGate.pending = false;
      // The child may flush files during the grace window; refresh the record
      // so it matches the tree the orchestrator will actually find.
      const result = reportRun(fields());
      process.exit(result.exitCode);
    }, ABORT_GRACE_MS);
  });

  // A grandchild that outlives the implementer and inherited its pipes keeps
  // them open, so "close" would never fire. Once the implementer is gone the
  // pipes hold nothing we need: drop them after a short drain grace.
  child.once("exit", () => {
    // Leaving the watchdog armed past a clean exit could mislabel it a timeout.
    if (!watchdogFired) disarm();
    const drain = setTimeout(() => {
      if (!settled) dropPipes();
    }, DRAIN_GRACE_MS);
    drain.unref();
  });

  child.on("error", (error) => {
    if (!settle()) return;
    // Missing at launch means unavailable only if no probe already found it; a
    // binary that answered --version and then vanished is a failed run.
    const missing = error && error.code === "ENOENT";
    const unavailable = missing && !probed;
    const result = reportRun({
      status: unavailable ? unavailableStatus : "failed",
      exitCode: unavailable ? 127 : 1,
      signal: null,
      ...(unavailable ? {} : { stderrTail: readStderrTail(run.stderrFd) }),
      error: missing && probed
        ? `${name} answered the version probe but could not be launched (${error.message}); nothing was dispatched`
        : error && error.message ? error.message : String(error),
    });
    process.exit(result.exitCode);
  });

  child.on("close", (code, signal) => {
    if (!settle()) return;
    parse(stdoutDecoder.end());
    // An unterminated final line still counts; for the object scanner this is a no-op.
    if (a.scanner) parse("\n");
    if (a.onStderr) a.onStderr(stderrDecoder.end(), state);
    // Nothing the implementer left in its process group may outlive the report: a background
    // job could write after the tripwire's last look (a process that left the group with
    // setsid is out of reach).
    killChild(child, "SIGKILL");
    privatizeArtifacts(run);
    let judged = !watchdogFired && a.verdict ? a.verdict(state, { code, signal }) || {} : {};
    if (!judged.error && finalBlocked()) {
      judged = { ...judged, error: `could not safely create final.txt: ${run.finalPath} appeared during the run and was left untouched` };
    }
    // A timed-out run is failed even if the implementer exits 0 on SIGTERM.
    const succeeded = code === 0 && !watchdogFired && !judged.error;
    const mapped = code ?? (signal ? signalExitCode(signal, 0) : 1);
    const error = stallFired
      ? a.stall.message(opts)
      : watchdogFired
        ? `${name} did not finish within ${a.timeoutLabel ? a.timeoutLabel(opts) : `--timeout ${opts.timeout}`}; killed by the relay watchdog`
        : judged.error;
    const result = reportRun({
      status: succeeded ? "completed" : stallFired ? "stalled" : watchdogFired ? "timeout" : "failed",
      exitCode: succeeded ? 0 : mapped === 0 || mapped === 128 ? 1 : mapped,
      signal: signal ?? null,
      ...(succeeded ? {} : { stderrTail: readStderrTail(run.stderrFd) }),
      ...(error ? { error } : {}),
      ...judged.fields,
    });
    process.exit(result.exitCode);
  });

  if (child.stdin) {
    // A launch failure can surface on the child and on its stdin; the child's
    // error handler owns the outcome, so the pipe error is swallowed.
    child.stdin.on("error", () => {});
    child.stdin.end(launch.stdin);
  }
}

// ---- src/core/scan.mjs

const MAX_BUFFERED_CHARS = 1_048_576;


// One JSON value per line (JSONL / NDJSON). Non-JSON lines are skipped.
// A line over the cap is dropped whole, through its line break.
function makeLineScanner(onObject) {
  let buf = "";
  let skipLine = false;
  return (chunk) => {
    if (!chunk) return;
    let start = 0;
    for (;;) {
      const end = chunk.indexOf("\n", start);
      if (end === -1) break;
      const line = buf + chunk.slice(start, end);
      buf = "";
      if (skipLine) {
        skipLine = false;
        start = end + 1;
        continue;
      }
      const trimmed = line.trim();
      if (trimmed) {
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; /* skip non-JSON lines */ }
        if (parsed !== undefined) onObject(parsed);
      }
      start = end + 1;
    }
    if (skipLine) return;
    buf += chunk.slice(start);
    if (buf.length > MAX_BUFFERED_CHARS) {
      buf = "";
      skipLine = true;
    }
  };
}

// ---- src/core/tripwire.mjs

const FINGERPRINT_UNREADABLE = "<unreadable>";

const FINGERPRINT_DIRECTORY = "<directory>";


function gitRepoRoot(cwd) {
  // Porcelain paths are relative to the repository ROOT, not to the directory git ran in
  // (--porcelain forces status.relativePaths off). Joining them against a --cd that is a
  // subdirectory would look for <repo>/src/src/file and find nothing at either end.
  try {
    return runGit(cwd, ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).replace(/\n$/, "") || null;
  } catch {
    return null;
  }
}


function gitStatusEntries(cwd) {
  // -z so a path containing a space, a quote, or a newline stays one field rather than being
  // quoted and escaped; -uall so an untracked directory is expanded into its files, because a
  // collapsed "?? dir/" line never changes when a file inside it does.
  try {
    const output = runGit(cwd, ["status", "--porcelain", "-z", "-uall"]);
    const fields = new TextDecoder("utf-8", { fatal: true }).decode(output)
      .split("\0").filter((field) => field.length > 0);
    const entries = [];
    for (let i = 0; i < fields.length; i += 1) {
      const entry = fields[i];
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      // R and C can sit in EITHER status column, and under -z such an entry is followed by its
      // origin path as its own unprefixed field. Consume that field in both cases. A rename
      // origin belongs in the dirty set (the file moved away from it); a copy origin does not,
      // since a copy source can be a perfectly clean file.
      const renamed = status.includes("R");
      const copied = status.includes("C");
      let origin = null;
      if (renamed || copied) {
        i += 1;
        origin = fields[i] ?? null;
      }
      entries.push({ status, path, origin });
    }
    return entries;
  } catch {
    return null;
  }
}


function dirtyPaths(cwd) {
  const entries = gitStatusEntries(cwd);
  if (entries === null) return null;
  const paths = [];
  for (const entry of entries) {
    paths.push(entry.path);
    if (entry.status.includes("R") && entry.origin !== null) paths.push(entry.origin);
  }
  return paths;
}


// Index entries git status does not look at: skip-worktree (S) and assume-unchanged
// (lowercase tags). A path flagged before dispatch is fingerprinted like a dirty one;
// a flag set or cleared during the run is itself a write to the repository.
function hiddenIndexEntries(cwd) {
  try {
    const output = runGit(cwd, ["ls-files", "-v", "-z"]);
    const hidden = {};
    for (const field of new TextDecoder("utf-8", { fatal: true }).decode(output).split("\0")) {
      if (field.length < 3) continue;
      const tag = field[0];
      if (tag === "S" || (tag >= "a" && tag <= "z")) hidden[field.slice(2)] = tag;
    }
    return hidden;
  } catch {
    return null;
  }
}


function asciiFold(value) {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}


function canonicalFilePath(path) {
  const absolute = resolve(path);
  let parent;
  try { parent = realpathSync.native(dirname(absolute)); } catch { return absolute; }
  const leaf = basename(absolute);
  const canonical = join(parent, leaf);
  try { lstatSync(canonical); } catch { return canonical; }
  try {
    const entries = readdirSync(parent);
    if (entries.includes(leaf)) return canonical;
    const matches = entries.filter((entry) => asciiFold(entry) === asciiFold(leaf));
    return join(parent, matches.length === 1 ? matches[0] : leaf);
  } catch {
    return canonical;
  }
}


function gitPathKey(root, path) {
  let canonicalRoot;
  try { canonicalRoot = realpathSync.native(root); } catch { canonicalRoot = resolve(root); }
  return relative(canonicalRoot, canonicalFilePath(path));
}


function gitPathIsExcluded(root, path, excluded, foldedExcluded) {
  return excluded.has(path) ||
    (foldedExcluded.has(asciiFold(path)) && excluded.has(gitPathKey(root, join(root, path))));
}


// `ignore` (optional) takes a repo-relative, "/"-separated path and returns
// true for files the implementer is known to write as its own bookkeeping
// even in a read-only mode; those paths are outside the tripwire.
function gitTripwireState(cwd, excludedPaths, ignore) {
  const root = gitRepoRoot(cwd);
  if (root === null) return null;
  const entries = gitStatusEntries(cwd);
  if (entries === null) return null;
  const excluded = new Set(excludedPaths.map((path) => gitPathKey(root, path)));
  const foldedExcluded = new Set([...excluded].map(asciiFold));
  return entries.flatMap((entry) => [
    [entry.status, "path", entry.path],
    ...(entry.origin === null ? [] : [[entry.status.replace(/[^RC]/g, " "), "origin", entry.origin]]),
  ]
    .filter(([, , path]) => !gitPathIsExcluded(root, path, excluded, foldedExcluded) && !(ignore && ignore(path))));
}


function pathFingerprint(absolutePath) {
  // Identity, not just bytes: a retargeted symlink, a flipped mode bit, or a file replaced by a
  // directory are all writes, and none of them change file contents.
  let stats;
  try {
    stats = lstatSync(absolutePath);
  } catch (error) {
    // Absence is a state, not a failure - it differs from every real fingerprint, so a deletion
    // or a re-creation still registers. Any other errno means we genuinely cannot tell.
    return error && error.code === "ENOENT" ? "absent" : FINGERPRINT_UNREADABLE;
  }
  if (stats.isSymbolicLink()) {
    try {
      return `symlink:${readlinkSync(absolutePath, { encoding: "buffer" }).toString("hex")}`;
    } catch {
      return FINGERPRINT_UNREADABLE;
    }
  }
  // A directory in the dirty set is a submodule, whose contents belong to another repository.
  // Reported as unknown coverage rather than silently passed off as unchanged.
  if (stats.isDirectory()) return FINGERPRINT_DIRECTORY;
  if (!stats.isFile()) return FINGERPRINT_UNREADABLE;
  let fd;
  try {
    // Streamed rather than read whole: an unignored multi-gigabyte artifact must not be pulled
    // into memory just to answer whether it changed.
    const hash = createHash("sha256");
    fd = openSync(absolutePath, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return `file:${(stats.mode & 0o7777).toString(8)}:${hash.digest("hex")}`;
  } catch {
    return FINGERPRINT_UNREADABLE;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}


function gitIndexFingerprints(root, paths) {
  if (paths.length === 0) return new Map();
  try {
    const output = runGit(root, ["ls-files", "--stage", "-z"]);
    const wanted = new Set(paths);
    const prints = new Map(paths.map((path) => [path, []]));
    for (const field of new TextDecoder("utf-8", { fatal: true }).decode(output).split("\0")) {
      if (!field) continue;
      const separator = field.indexOf("\t");
      if (separator === -1) return null;
      const path = field.slice(separator + 1);
      if (wanted.has(path)) prints.get(path).push(field.slice(0, separator));
    }
    return prints;
  } catch {
    return null;
  }
}


function fingerprintPaths(root, paths) {
  // `complete` goes false the moment one path cannot be fingerprinted, so the caller reports
  // "unknown" instead of an unearned clean bill of health.
  const indexPrints = gitIndexFingerprints(root, paths);
  const prints = new Map();
  let complete = indexPrints !== null;
  for (const path of paths) {
    const file = pathFingerprint(join(root, path));
    if (file === FINGERPRINT_UNREADABLE || file === FINGERPRINT_DIRECTORY) complete = false;
    prints.set(path, { file, index: indexPrints?.get(path) ?? null });
  }
  return { prints, complete };
}


function fingerprintDirtyPaths(cwd, excludedPaths, ignore) {
  // Only the already-dirty set is covered. A path that is clean at dispatch and gets written
  // surfaces as a brand-new porcelain line anyway, and fingerprinting a whole repository per run
  // would cost far more than the case it covers.
  const root = gitRepoRoot(cwd);
  if (root === null) return null;
  const dirty = dirtyPaths(cwd);
  const hidden = hiddenIndexEntries(cwd);
  if (dirty === null || hidden === null) return null;
  const paths = [...new Set([...dirty, ...Object.keys(hidden)])];
  const excluded = new Set(excludedPaths.map((path) => gitPathKey(root, path)));
  const foldedExcluded = new Set([...excluded].map(asciiFold));
  return {
    root,
    ...fingerprintPaths(root, paths.filter((path) => !gitPathIsExcluded(root, path, excluded, foldedExcluded) && !(ignore && ignore(path)))),
  };
}


function changedDirtyPaths(before) {
  // Re-fingerprint exactly the baseline paths, not whatever happens to be dirty now: a path the
  // run newly dirtied is already reported by the porcelain comparison, and letting an unreadable
  // one of those blind this signal would be a regression, not caution.
  if (!before) return { changed: [], complete: false };
  const now = fingerprintPaths(before.root, [...before.prints.keys()]);
  const changed = [];
  for (const [path, print] of before.prints) {
    const current = now.prints.get(path);
    const fileKnown = print.file !== FINGERPRINT_UNREADABLE && current.file !== FINGERPRINT_UNREADABLE;
    const fileChanged = fileKnown &&
      !(print.file === FINGERPRINT_DIRECTORY && current.file === FINGERPRINT_DIRECTORY) &&
      current.file !== print.file;
    const indexChanged = print.index !== null && current.index !== null &&
      JSON.stringify(current.index) !== JSON.stringify(print.index);
    if (fileChanged || indexChanged) changed.push(path);
  }
  return { changed: changed.sort(), complete: before.complete && now.complete };
}


function readOnlyVerdict(beforeTree, afterTree, beforeFingerprints) {
  // Three-valued on purpose. Proof of a write settles it even when the other signal is unknown;
  // only when nothing is proven AND coverage is incomplete is the answer genuinely unknown.
  // Collapsing that last case to false is the false assurance a tripwire must never give.
  const changed = changedDirtyPaths(beforeFingerprints);
  const porcelainMoved =
    beforeTree !== null && afterTree !== null && JSON.stringify(beforeTree) !== JSON.stringify(afterTree);
  if (porcelainMoved || changed.changed.length > 0) return true;
  if (beforeTree === null || afterTree === null || !changed.complete) return null;
  return false;
}



// Facade: take the baseline before dispatch, ask for the verdict after. `excluded`
// lists the relay's own artifact paths, which may live inside the repository.
// What `git status` does not show but a write can still change: commits and other ref
// moves (HEAD, branches, stash), and the ignore rules that decide which new files status
// lists at all.
// A file's bytes for the state, "<absent>" when it does not exist; anything else
// (unreadable, a directory) throws, so the state is unknown rather than clean.
function fileState(path) {
  try { return readFileSync(path, "latin1"); } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "<absent>";
    throw error;
  }
}


function repositoryState(cwd) {
  try {
    // Every ref but refs/remotes: a background fetch (an IDE's) moves those without the
    // implementer. Custom namespaces (refs/custom/...) count like branches.
    const refs = runGit(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"], { encoding: "utf8" })
      .split("\n").filter((line) => line && !line.startsWith("refs/remotes/")).join("\n");
    let head;
    try { head = runGit(cwd, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { head = "<unborn>"; }
    let symbolic;
    try { symbolic = runGit(cwd, ["symbolic-ref", "-q", "HEAD"], { encoding: "utf8" }).trim(); } catch { symbolic = "<detached>"; }
    const rules = [];
    for (const name of ["info/exclude", "info/attributes"]) {
      const path = runGit(cwd, ["rev-parse", "--git-path", name], { encoding: "utf8" }).trim();
      rules.push(`${name}\0${fileState(resolve(cwd, path))}`);
    }
    // A config that points status at another ignore list, that list's contents (or the
    // default global one's), and every .gitignore that is itself ignored, with its contents
    // (a self-ignoring one hides everything beside it, and can be rewritten unseen).
    let ignoreConfig = "";
    try {
      ignoreConfig = runGit(cwd, ["config", "--show-origin", "--null", "--get-regexp", "^(core\\.excludesfile|extensions\\.)"], { encoding: "utf8" });
    } catch (error) {
      if (error?.status !== 1) throw error;
    }
    let excludesFile = null;
    try {
      excludesFile = runGit(cwd, ["config", "--path", "--get", "core.excludesFile"], { encoding: "utf8" }).replace(/\r?\n$/, "");
    } catch (error) {
      if (error?.status !== 1) throw error;
    }
    if (!excludesFile) {
      const xdg = process.env.XDG_CONFIG_HOME || (homedir() ? join(homedir(), ".config") : null);
      excludesFile = xdg ? join(xdg, "git", "ignore") : null;
    }
    const excludes = excludesFile ? `${excludesFile}\0${fileState(resolve(cwd, excludesFile))}` : "<none>";
    // --directory: an ignored directory (node_modules) is listed once, never walked.
    const root = runGit(cwd, ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).replace(/\r?\n$/, "");
    const ignoredIgnores = runGit(cwd, ["ls-files", "-z", "--full-name", "--others", "--ignored", "--exclude-standard", "--directory"], { encoding: "utf8", cwd: root })
      .split("\0").filter((path) => path === ".gitignore" || path.endsWith("/.gitignore")).sort()
      .map((path) => `${path}\0${fileState(join(root, path))}`);
    return JSON.stringify({ head, symbolic, refs, rules, ignoreConfig, excludes, ignoredIgnores });
  } catch {
    return null;
  }
}


function readOnlySnapshot(cwd, excluded, ignore) {
  return {
    cwd,
    excluded,
    ignore,
    tree: gitTripwireState(cwd, excluded, ignore),
    prints: fingerprintDirtyPaths(cwd, excluded, ignore),
    hidden: hiddenIndexEntries(cwd),
    repository: repositoryState(cwd),
  };
}


function readOnlyCheck(snapshot) {
  // Rewriting the repository's own config, or flagging an index entry so status stops
  // looking at it, are writes in their own right, and ones that would blind this check.
  const intact = gitPinIntact();
  if (intact === false) return true;
  if (intact === null) return null;
  const hidden = hiddenIndexEntries(snapshot.cwd);
  if (snapshot.hidden !== null && hidden !== null && JSON.stringify(hidden) !== JSON.stringify(snapshot.hidden)) return true;
  const repository = repositoryState(snapshot.cwd);
  if (snapshot.repository !== null && repository !== null && repository !== snapshot.repository) return true;
  const verdict = readOnlyVerdict(snapshot.tree, gitTripwireState(snapshot.cwd, snapshot.excluded, snapshot.ignore), snapshot.prints);
  const covered = snapshot.hidden !== null && hidden !== null && snapshot.repository !== null && repository !== null;
  return verdict === false && !covered ? null : verdict;
}


const tripwire = { snapshot: readOnlySnapshot, check: readOnlyCheck };

// ---- src/adapters/codex.mjs

const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];

const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Model rides argv; a plain token cannot pass for a flag. Same family as pi. Keep in
// lockstep with switchboard-setup MODEL_TOKEN.shellSafe.
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

// Effort and web search modes are Codex-owned enums that vary by version; the relay
// checks only for a bare token.
const BARE_TOKEN = /^[a-z][a-z0-9-]*$/i;

const KEEP_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
  "TMPDIR", "CODEX_HOME", "TEMP", "TMP"];


function codexEnv(opts) {
  const env = opts.cleanEnv
    ? Object.fromEntries([...KEEP_ENV, ...opts.keepEnv].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]))
    : { ...process.env };
  if (opts.cleanEnv) {
    // The relay's own hardening survives a clean environment: core.fsmonitor stays off
    // (GIT_CONFIG_*).
    for (const key of Object.keys(process.env)) {
      if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) env[key] = process.env[key];
    }
  }
  return env;
}


function codexArgs(opts, finalPath) {
  const args = ["exec"];
  if (opts.ignoreUserConfig) args.push("--ignore-user-config");
  const resuming = Boolean(opts.session || opts.resumeLast);
  // Codex accepts shared exec options before the resume subcommand. Reapply only
  // an explicitly selected sandbox; otherwise leave the active Codex config alone.
  if (resuming && opts.sandboxConfigured) args.push("-s", opts.sandbox);
  if (opts.session) args.push("resume", opts.session);
  else if (opts.resumeLast) args.push("resume", "--last");
  args.push("--json", "-o", finalPath);
  if (!resuming) args.push("-s", opts.sandbox);
  if (opts.model) args.push("-m", opts.model);
  // `-c` is accepted by the resume subcommand, so these overrides apply to fresh and
  // resumed runs alike. Keep every `-c` after `resume`: once one follows it, Codex
  // drops any placed before it.
  const overrides = [
    [opts.effort !== null, `model_reasoning_effort=${opts.effort}`],
    [opts.subagentModel !== null, `agents.default_subagent_model=${opts.subagentModel}`],
    [opts.subagentEffort !== null, `agents.default_subagent_reasoning_effort=${opts.subagentEffort}`],
    [opts.webSearch !== null, `web_search=${opts.webSearch}`],
    [opts.networkAccess, "sandbox_workspace_write.network_access=true"],
  ];
  for (const [enabled, override] of overrides) if (enabled) args.push("-c", override);
  if (opts.skipGitRepoCheck) args.push("--skip-git-repo-check");
  args.push("-"); // read the prompt from stdin
  return args;
}


const threadId = (event) => event.thread_id ?? event.threadId ?? (event.thread && (event.thread.thread_id ?? event.thread.id)) ?? null;


const codex = {
  key: "codex",
  name: "Codex",
  versionField: "codexVersion",
  defaults: {
    model: null,
    effort: null,
    subagentModel: null,
    subagentEffort: null,
    webSearch: null,
    sandbox: "workspace-write",
    sandboxConfigured: false,
    session: null,
  },
  flags: {
    "--model": { key: "model" },
    "--effort": { key: "effort" },
    "--subagent-model": { key: "subagentModel" },
    "--subagent-effort": { key: "subagentEffort" },
    "--web-search": { key: "webSearch" },
    "--network-access": { key: "networkAccess", kind: "bool" },
    "--sandbox": { key: "sandbox" },
    "--read-only": { key: "readOnly", kind: "bool" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--session": { key: "session" },
    "--clean-env": { key: "cleanEnv", kind: "bool" },
    "--ignore-user-config": { key: "ignoreUserConfig", kind: "bool" },
    "--keep-env": { key: "keepEnv", kind: "list" },
    "--skip-git-repo-check": { key: "skipGitRepoCheck", kind: "bool" },
  },
  onDial(field, value, opts) {
    if (field === "sandbox") opts.sandboxConfigured = true;
  },
  validate(opts, flagged) {
    // --read-only is a shortcut for --sandbox read-only; an explicit contradiction is a usage
    // error, not a silent downgrade of the caller's sandbox choice.
    if (opts.readOnly && flagged.has("sandbox") && opts.sandbox !== "read-only") {
      fail(`--read-only and --sandbox ${opts.sandbox} are mutually exclusive; pass only one`);
    }
    if (opts.readOnly) opts.sandbox = "read-only";
    if (flagged.has("sandbox") || flagged.has("readOnly")) opts.sandboxConfigured = true;
    if (!SANDBOX_MODES.includes(opts.sandbox)) {
      fail(`invalid --sandbox "${opts.sandbox}" (expected: ${SANDBOX_MODES.join(", ")})`);
    }
    // Codex ignores the workspace-write network key under read-only and the run stays
    // offline without a word, so refuse the pair rather than record access that never happened.
    if (opts.networkAccess && opts.sandbox === "read-only") {
      fail("--network-access cannot be combined with a read-only sandbox: Codex keeps read-only offline");
    }
    // An unqualified resume runs under Codex's configured sandbox, which may be read-only
    // and drop the override without a word; require the sandbox named so the record holds.
    if (opts.networkAccess && (opts.session || opts.resumeLast) && !opts.sandboxConfigured) {
      fail("--network-access on a resumed run needs the sandbox named by --sandbox (e.g. --sandbox workspace-write) or a fleet lane");
    }
    for (const [flag, value] of [["--effort", opts.effort], ["--web-search", opts.webSearch]]) {
      if (value !== null && !BARE_TOKEN.test(value)) fail(`invalid ${flag} "${value}" (expected a non-empty bare token)`);
    }
    for (const [flag, value] of [["--model", opts.model], ["--subagent-model", opts.subagentModel]]) {
      if (value !== null && !SAFE_MODEL.test(value)) fail(`${flag} contains unsupported characters (allowed: letters, digits, . _ : / -)`);
    }
    if (opts.subagentEffort !== null && !BARE_TOKEN.test(opts.subagentEffort)) {
      fail(`invalid --subagent-effort "${opts.subagentEffort}" (expected a non-empty bare token)`);
    }
    if (opts.keepEnv.length && !opts.cleanEnv) fail("--keep-env requires --clean-env");
    const badName = opts.keepEnv.find((name) => !SAFE_ENV_NAME.test(name));
    if (badName) fail(`invalid --keep-env "${badName}" (expected an environment variable name)`);
    const unset = opts.keepEnv.find((name) => process.env[name] === undefined);
    if (unset) fail(`--keep-env "${unset}" is not set`);
    exclusive(opts, [["session", "resumeLast", "--session and --resume-last are mutually exclusive; pass only one"]]);
    if (opts.session !== null && !SAFE_SESSION.test(opts.session)) {
      fail("--session must be a shell-safe thread id (letters, digits, . _ : -)");
    }
  },
  readOnly: (opts) => opts.sandbox === "read-only",
  tripwire,
  fields: (opts, state) => ({
    sandbox: !(opts.session || opts.resumeLast) || opts.sandboxConfigured ? opts.sandbox : "(Codex config on resume)",
    model: opts.model,
    effort: opts.effort,
    subagentModel: opts.subagentModel,
    subagentEffort: opts.subagentEffort,
    webSearch: opts.webSearch,
    networkAccess: opts.networkAccess,
    resumeLast: opts.resumeLast,
    session: opts.session,
    cleanEnv: opts.cleanEnv,
    ignoreUserConfig: opts.ignoreUserConfig,
    keepEnv: opts.keepEnv,
    threadId: state.sessionId,
  }),
  version: (opts) => ({
    launch: { command: "codex", args: ["--version"], env: codexEnv(opts) },
  }),
  binary: "codex",
  unavailableHint: "Install it (npm i -g @openai/codex) and run `codex login`.",
  prepare: (opts, run, state) => { state.finalPath = run.finalPath; },
  // The brief goes through stdin, never argv, and no shell runs.
  launch: (opts, brief, run) => ({
    command: "codex",
    args: codexArgs(opts, run.finalPath),
    env: codexEnv(opts),
    stdin: brief,
  }),
  scanner: makeLineScanner,
  onEvent(event, state) {
    const id = event && typeof event === "object" ? threadId(event) : null;
    if (id) state.sessionId = id;
  },
  // Codex writes its own report to the -o file.
  finalByImplementer: true,
  final: (state) => (state.finalPath && existsSync(state.finalPath) ? readFileSync(state.finalPath, "utf8").trim() : ""),
  summary(result) {
    if (result.resumeLast) return ["mode: resumed most recent session"];
    return result.session ? [`mode: resumed session ${result.session}`] : [];
  },
};


await runRelay(codex);
