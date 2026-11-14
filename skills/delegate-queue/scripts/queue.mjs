#!/usr/bin/env node
/**
 * Switchboard · delegate-queue · queue.mjs
 *
 * Run several briefs at once across any mix of implementers, each in its own
 * git worktree, and collect one report. It drives the installed sibling
 * `<key>-delegate/scripts/relay.mjs` files; it never talks to an implementer
 * CLI itself, and it never commits.
 *
 * Trust posture: Node built-ins only, no network calls of its own, no
 * credentials, no telemetry. It runs `git` (worktree add/remove, branch) and
 * the sibling relays, and `config.mjs load` from delegate-setup when a task
 * names a lane.
 *
 * Usage:
 *   node queue.mjs run <queue.json> [--cd <repo>] [--out-dir <dir>] [--concurrency <n>]
 *   node queue.mjs cleanup <queue-result.json>
 *   node queue.mjs --help
 *
 * Queue file (switchboard-queue.v1), paths relative to the queue file:
 *   {
 *     "version": "switchboard-queue.v1",
 *     "concurrency": 3,
 *     "tasks": [
 *       { "id": "billing", "brief": "briefs/billing.md", "lane": "feature",
 *         "fallback": ["bulk", { "implementer": "codex" }] },
 *       { "id": "tests", "brief": "briefs/tests.md", "implementer": "codex",
 *         "args": ["--timeout", "45m"] },
 *       { "id": "review", "brief": "briefs/review.md", "lane": "review",
 *         "worktree": false }
 *     ]
 *   }
 *
 * Each task names a target, a `lane` or an `implementer`; `fallback` lists
 * more targets (a string is a lane name). `args` are passed to the relay
 * as-is, except the flags the queue owns: --brief, --cd, --out-dir, --lane.
 *
 * Worktrees: a task with `worktree` (the default) runs in a fresh worktree on
 * branch `switchboard/<run>-<id>`, created from HEAD, so parallel tasks never touch
 * each other or your checkout. Uncommitted changes in your checkout are not in
 * those worktrees; the queue warns when the checkout is dirty. Set
 * `"worktree": false` for read-only tasks that should see the live tree.
 *
 * Fallback: the next target is tried only when the previous one was never
 * dispatched: the CLI is missing (`*_unavailable`) or its version preflight
 * failed. A run that started and then failed, timed out or stalled is not
 * retried, because it may have changed files; it is reported for review.
 *
 * Result: <out-dir>/queue-result.json (switchboard-queue.result.v1), written
 * atomically and private, with every attempt's relay result path, status,
 * worktree and branch, touched files, tokens and cost, plus totals. Exit 0 when
 * every task completed, 1 otherwise, 2 on a usage error before any run. On
 * SIGTERM/SIGINT the queue forwards the signal to running relays, waits for
 * their results, marks unstarted tasks skipped, and exits 128 + signal.
 *
 * cleanup removes each task's worktree with `git worktree remove` (never
 * forced) and deletes its branch with `git branch -d` (merged only). Anything
 * with unlanded work is kept and listed.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Windows looks for a bare command (`git`, `taskkill`) in the current directory before
// PATH; the checkout is untrusted, so never let it supply one.
if (process.platform === "win32" && !process.env.NoDefaultCurrentDirectoryInExePath) process.env.NoDefaultCurrentDirectoryInExePath = "1";

const QUEUE_VERSION = "switchboard-queue.v1";
const RESULT_SCHEMA = "switchboard-queue.result.v1";
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Ids name worktree branches (switchboard/<run>-<id>), so git's ref rules apply as well.
const validTaskId = (id) => TASK_ID.test(id) && !id.includes("..") && !id.endsWith(".") && !id.endsWith(".lock");
const IMPLEMENTER_KEY = /^[a-z][a-z0-9]*$/;
const OWNED_FLAGS = new Set(["--brief", "--cd", "--out-dir", "--lane"]);
const MAX_CONCURRENCY = 16;
const MAX_REVIEW_DIFF_CHARS = 200_000;
// Relays that pass the brief on argv cap it at the OS limit; a review brief must fit.
const ARGV_BRIEF_IMPLEMENTERS = new Set(["agy", "kimi", "qoder", "vibe", "warp"]);
const ARGV_BRIEF_BYTES = (process.platform === "win32" ? 12 : 120) * 1024;
// Checkout hooks (git-lfs, dependency installs) can run long: far more than git()'s cap.
const WORKTREE_ADD_TIMEOUT_MS = 10 * 60_000;
// The flag that makes each relay read-only; a reviewer must have one.
const READ_ONLY_FLAG = {
  agy: "--read-only", aider: "--read-only", claude: "--read-only", cline: "--plan", codex: "--read-only",
  commandcode: "--read-only", copilot: "--read-only", cursor: "--read-only", grok: "--read-only",
  muse: "--read-only", omp: "--read-only", opencode: "--read-only", pi: "--read-only",
  vibe: "--plan-only", zcode: "--read-only",
};
const ABORT_WAIT_MS = 15_000;
const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fail(message, code = 2) {
  process.stderr.write(`queue: ${message}\n`);
  process.exit(code);
}

function help() {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  process.stdout.write(`${match[1].replace(/^\s*\* ?/gm, "").trim()}\n`);
  process.exit(0);
}

// Config that makes git run a command (core.fsmonitor) is off for every git call, here and
// in the relays, which inherit it.
if (!/core\.fsmonitor/.test(Object.keys(process.env).filter((key) => key.startsWith("GIT_CONFIG_KEY_")).map((key) => process.env[key]).join(" "))) {
  const count = Number(process.env.GIT_CONFIG_COUNT) || 0;
  process.env[`GIT_CONFIG_KEY_${count}`] = "core.fsmonitor";
  process.env[`GIT_CONFIG_VALUE_${count}`] = "false";
  process.env.GIT_CONFIG_COUNT = String(count + 1);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim();
}

// After an implementer ran in a worktree, git is pointed at the worktree's own gitdir
// (recorded at creation, inside the main .git) instead of trusting the .git pointer file
// the implementer could have rewritten; diff drivers from config never run.
function worktreeGit(task, cwd, args, options = {}) {
  const pinned = task.gitDir ? ["--git-dir", task.gitDir, "--work-tree", cwd] : [];
  return execFileSync("git", [...pinned, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, ...options });
}

// Exclusive temp file plus rename: a link planted at the target (by an implementer that
// could write under the out-dir) is replaced, never written through.
function writeTextAtomic(path, text) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function writeJsonAtomic(path, value) {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---- queue file

function normalizeTarget(raw, where) {
  if (typeof raw === "string") raw = { lane: raw };
  if (!raw || typeof raw !== "object") fail(`${where}: a target is a lane name or { "lane" } / { "implementer" }`);
  const keys = ["lane", "implementer"].filter((key) => raw[key] !== undefined);
  if (keys.length !== 1) fail(`${where}: name exactly one of "lane" or "implementer"`);
  if (raw.lane !== undefined && (typeof raw.lane !== "string" || !raw.lane)) fail(`${where}: "lane" must be a non-empty string`);
  if (raw.implementer !== undefined && !IMPLEMENTER_KEY.test(raw.implementer)) fail(`${where}: unknown implementer "${raw.implementer}"`);
  return raw.lane !== undefined ? { lane: raw.lane } : { implementer: raw.implementer };
}

function parseQueue(text, baseDir) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    fail(`queue file is not valid JSON: ${error.message}`);
  }
  if (!doc || doc.version !== QUEUE_VERSION) fail(`queue file must declare "version": "${QUEUE_VERSION}"`);
  if (!Array.isArray(doc.tasks) || doc.tasks.length === 0) fail("queue file needs a non-empty \"tasks\" array");
  const seen = new Set();
  const tasks = doc.tasks.map((task, index) => {
    const where = `tasks[${index}]`;
    if (!task || typeof task !== "object") fail(`${where} must be an object`);
    if (typeof task.id !== "string" || !validTaskId(task.id)) fail(`${where}: "id" must match ${TASK_ID} with no "..", trailing "." or ".lock" (it names a git branch)`);
    if (seen.has(task.id)) fail(`${where}: duplicate id "${task.id}"`);
    seen.add(task.id);
    if (typeof task.brief !== "string" || !task.brief) fail(`${task.id}: "brief" must be a path`);
    const brief = resolve(baseDir, task.brief);
    if (!existsSync(brief)) fail(`${task.id}: brief not found: ${brief}`);
    const args = task.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) fail(`${task.id}: "args" must be an array of strings`);
    const owned = args.find((arg) => OWNED_FLAGS.has(arg.split("=")[0]));
    if (owned) fail(`${task.id}: "args" may not set ${owned.split("=")[0]}; the queue owns it`);
    if (task.worktree !== undefined && typeof task.worktree !== "boolean") fail(`${task.id}: "worktree" must be true or false`);
    const fallback = task.fallback ?? [];
    if (!Array.isArray(fallback)) fail(`${task.id}: "fallback" must be an array`);
    const primary = normalizeTarget({ lane: task.lane, implementer: task.implementer }, task.id);
    return {
      id: task.id,
      brief,
      args,
      worktree: task.worktree !== false,
      targets: [primary, ...fallback.map((target, i) => normalizeTarget(target, `${task.id}.fallback[${i}]`))],
      review: task.review === undefined ? null : normalizeTarget(task.review, `${task.id}.review`),
    };
  });
  const concurrency = doc.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    fail(`"concurrency" must be an integer from 1 to ${MAX_CONCURRENCY}`);
  }
  return { tasks, concurrency };
}

// ---- lanes and relays

let laneCache = null;
function laneImplementer(lane, repo) {
  if (!laneCache) {
    const config = join(skillsDir, "delegate-setup", "scripts", "config.mjs");
    if (!existsSync(config)) fail("a task names a lane, which requires the delegate-setup skill installed beside delegate-queue");
    const loaded = spawnSync(process.execPath, [config, "load", "--cwd", repo], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    if (loaded.status !== 0) fail(`could not load lanes: ${(loaded.stderr || "").trim()}`);
    laneCache = JSON.parse(loaded.stdout);
  }
  const entry = (laneCache.lanes || {})[lane];
  if (!entry) fail(`no lane named "${lane}" (configure it with delegate-setup)`);
  // Every relay would refuse it at dispatch; say so once, before anything runs.
  if (entry.source === "project" && !laneCache.projectTrusted) {
    fail(`lane "${lane}" comes from the project fleet config, which is not trusted; review and approve it with delegate-setup before dispatch`);
  }
  return entry.implementer;
}

function relayPath(implementer) {
  return join(skillsDir, `${implementer}-delegate`, "scripts", "relay.mjs");
}

function resolveTargets(tasks, repo) {
  for (const task of tasks) {
    for (const target of task.targets) {
      target.implementer = target.implementer ?? laneImplementer(target.lane, repo);
      if (!existsSync(relayPath(target.implementer))) {
        fail(`${task.id}: the ${target.implementer}-delegate skill is not installed beside delegate-queue`);
      }
    }
    if (task.review) {
      const reviewer = task.review;
      reviewer.implementer = reviewer.implementer ?? laneImplementer(reviewer.lane, repo);
      if (!READ_ONLY_FLAG[reviewer.implementer]) {
        fail(`${task.id}: ${reviewer.implementer} cannot review: its relay has no read-only mode`);
      }
      if (!existsSync(relayPath(reviewer.implementer))) {
        fail(`${task.id}: the ${reviewer.implementer}-delegate skill is not installed beside delegate-queue`);
      }
    }
  }
}

// ---- cross-review

function collectReview(task, cwd, base) {
  const original = readFileSync(task.brief, "utf8").trim();
  let status = "";
  let diff = "";
  try { status = worktreeGit(task, cwd, ["status", "--porcelain"]).trim(); } catch { status = "(git status unavailable)"; }
  try {
    diff = worktreeGit(task, cwd, ["diff", "--no-ext-diff", "--no-textconv", base], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    diff = "(git diff unavailable: inspect the working tree directly)";
  }
  return { original, status, diff, base };
}

function renderReview({ original, status, diff, base }, diffLimit) {
  if (diff.length > diffLimit) {
    diff = `${diff.slice(0, diffLimit)}\n… diff truncated at ${diffLimit} characters; run \`git diff ${base}\` for the rest.`;
  }
  // A fence longer than any tilde run inside the diff cannot be closed early.
  const fence = "~".repeat(Math.max(4, ...[...diff.matchAll(/~+/g)].map((m) => m[0].length + 1)));
  return [
    "# Review request",
    "",
    "Another coding agent made the changes in this working tree for the task below. Review them.",
    "This is a read-only review: do not modify, create or delete any file.",
    "",
    "## The task it was given",
    "",
    original,
    "",
    "## What changed",
    "",
    "`git status --porcelain` (read untracked `??` files directly):",
    "",
    fence,
    status || "(no changes)",
    fence,
    "",
    `\`git diff ${base}\` for tracked files:`,
    "",
    `${fence}diff`,
    diff || "(no tracked changes)",
    fence,
    "",
    "## What to report",
    "",
    "Check the change against the task: correctness, requirements it missed, bugs, edits outside the",
    "task's scope, and missing or weak tests. List each finding with its file and line, most severe first.",
    "End your report with exactly one of these lines:",
    "",
    "VERDICT: APPROVE",
    "VERDICT: CHANGES_REQUESTED",
    "",
  ].join("\n");
}


// The diff is cut to MAX_REVIEW_DIFF_CHARS, and further for a reviewer whose relay
// carries the brief on argv, so the review is dispatched rather than refused.
function reviewBrief(task, cwd, base, implementer) {
  const parts = collectReview(task, cwd, base);
  let limit = MAX_REVIEW_DIFF_CHARS;
  let text = renderReview(parts, limit);
  if (ARGV_BRIEF_IMPLEMENTERS.has(implementer)) {
    const budget = ARGV_BRIEF_BYTES - 1024;
    while (Buffer.byteLength(text, "utf8") > budget && limit > 0) {
      limit = Math.floor(limit / 2);
      text = renderReview(parts, limit);
    }
  }
  return text;
}

function parseVerdict(text) {
  // Whole lines only: a restated instruction ("end with VERDICT: APPROVE or ...") is not a verdict.
  const matches = [...String(text || "").matchAll(/^\s*\**\s*VERDICT:\s*(APPROVE|CHANGES_REQUESTED)\b/gim)];
  if (!matches.length) return null;
  return matches[matches.length - 1][1].toUpperCase() === "APPROVE" ? "approved" : "changes_requested";
}

async function runReview(task, record, cwd, ctx) {
  const reviewer = task.review;
  const dir = join(ctx.outDir, "tasks", task.id, `review-${reviewer.lane ?? reviewer.implementer}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const briefPath = join(dir, "review-brief.md");
  writeTextAtomic(briefPath, reviewBrief(task, cwd, ctx.baseCommit ?? "HEAD", reviewer.implementer));
  const outcome = await runRelay({ brief: briefPath, args: [READ_ONLY_FLAG[reviewer.implementer]] }, reviewer, cwd, join(dir, "relay"), ctx.running);
  const result = outcome.result;
  record.review = {
    target: reviewer.lane ? { lane: reviewer.lane } : { implementer: reviewer.implementer },
    implementer: reviewer.implementer,
    status: result?.status ?? (ctx.aborting ? "aborted" : "failed"),
    verdict: result?.status === "completed" ? parseVerdict(result.finalMessage) : null,
    findings: result?.finalMessage ?? "",
    readOnlyViolation: result?.readOnlyViolation ?? null,
    tokens: result?.tokens ?? null,
    totalCostUsd: result?.totalCostUsd ?? null,
    briefPath,
    resultPath: result ? join(dir, "relay", "result.json") : null,
  };
}

// A target was never handed the brief: try the next one.
function neverDispatched(result) {
  if (!result) return false;
  if (typeof result.status === "string" && result.status.endsWith("_unavailable")) return true;
  return (result.status === "failed" || result.status === "timeout") &&
    typeof result.error === "string" && /version preflight .*not dispatched/.test(result.error);
}

// ---- running

function createWorktree(repo, runId, task, outDir) {
  const path = join(outDir, "worktrees", task.id);
  const branch = `switchboard/${runId}-${task.id}`;
  try {
    execFileSync("git", ["worktree", "add", "-q", "-b", branch, path, "HEAD"],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: WORKTREE_ADD_TIMEOUT_MS });
  } catch (error) {
    // Nothing of the user's is in a half-made worktree: clear it and its branch so the
    // next run can create them again, then report the failure.
    for (const args of [["worktree", "remove", "--force", path], ["worktree", "prune"], ["branch", "-D", branch]]) {
      spawnSync("git", args, { cwd: repo, stdio: "ignore", timeout: 30_000 });
    }
    throw error;
  }
  // Pinned before any implementer runs in it.
  task.gitDir = git(path, ["rev-parse", "--absolute-git-dir"]);
  return { path, branch };
}

function readResult(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function runRelay(task, target, cwd, attemptDir, running) {
  return new Promise((done) => {
    mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    const args = [relayPath(target.implementer), "--brief", task.brief, "--cd", cwd, "--out-dir", attemptDir];
    if (target.lane) args.push("--lane", target.lane);
    args.push(...task.args);
    // The relay's output streams straight to disk through a file opened exclusively
    // before the relay starts and held until it exits: nothing is buffered for the
    // whole run, and an entry the implementer plants or swaps cannot redirect it.
    let output = null;
    let child = null;
    try {
      output = createWriteStream(join(attemptDir, "relay-output.txt"), { flags: "wx", mode: 0o600 });
      output.on("error", () => {
        output = null;
        if (child) { child.stdout.resume(); child.stderr.resume(); }
      });
    } catch { /* best effort: the relay's own artifacts still land in attemptDir */ }
    child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    running.add(child);
    if (output) {
      child.stdout.pipe(output, { end: false });
      child.stderr.pipe(output, { end: false });
    } else {
      child.stdout.resume();
      child.stderr.resume();
    }
    child.on("close", (code, signal) => {
      running.delete(child);
      if (output) output.end();
      done({ code, signal, result: readResult(join(attemptDir, "result.json")) });
    });
    child.on("error", (error) => {
      running.delete(child);
      done({ code: null, signal: null, result: null, error: error.message });
    });
  });
}

// POSIX: SIGTERM lets each relay record its own aborted result and fell its
// implementer's process group. Windows has no catchable SIGTERM (kill() is a
// hard terminate that would orphan the implementer), so fell the whole tree.
function stopRelay(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
}

async function runTask(task, ctx) {
  const started = Date.now();
  const record = { id: task.id, status: "running", attempts: [], worktree: null };
  ctx.records.set(task.id, record);
  let cwd = ctx.repo;
  if (task.worktree) {
    try {
      record.worktree = createWorktree(ctx.repo, ctx.runId, task, ctx.outDir);
      cwd = record.worktree.path;
    } catch (error) {
      record.status = "failed";
      record.error = `could not create a worktree: ${String(error.stderr || error.message).trim()}`;
      record.durationMs = Date.now() - started;
      return;
    }
  } else {
    try { task.gitDir = git(cwd, ["rev-parse", "--absolute-git-dir"]); } catch { /* not pinned: plain git */ }
  }
  for (const [index, target] of task.targets.entries()) {
    if (ctx.aborting) break;
    const attemptDir = join(ctx.outDir, "tasks", task.id, `${index + 1}-${target.lane ?? target.implementer}`);
    const outcome = await runRelay(task, target, cwd, attemptDir, ctx.running);
    const result = outcome.result;
    record.attempts.push({
      target: target.lane ? { lane: target.lane } : { implementer: target.implementer },
      implementer: target.implementer,
      // A relay felled during an abort (Windows has no catchable SIGTERM) leaves no result.
      status: result?.status ?? (ctx.aborting ? "aborted" : outcome.code === 2 ? "rejected" : "failed"),
      exitCode: result?.exitCode ?? outcome.code,
      resultPath: result ? join(attemptDir, "result.json") : null,
      outputPath: join(attemptDir, "relay-output.txt"),
      ...(result?.error || outcome.error
        ? { error: result?.error ?? outcome.error }
        : !result && ctx.aborting ? { error: "the queue was stopped and the relay was felled before it wrote a result" } : {}),
    });
    if (!neverDispatched(result)) {
      Object.assign(record, {
        // A relay felled during an abort may leave no result of its own.
        status: result?.status ?? (ctx.aborting ? "aborted" : "failed"),
        implementer: target.implementer,
        touchedFiles: result?.touchedFiles ?? null,
        finalMessage: result?.finalMessage ?? "",
        tokens: result?.tokens ?? null,
        totalCostUsd: result?.totalCostUsd ?? null,
        ...(result?.readOnlyViolation !== undefined ? { readOnlyViolation: result.readOnlyViolation } : {}),
        ...(result ? {} : {
          error: ctx.aborting
            ? "the queue was stopped and the relay was felled before it wrote a result; inspect the worktree"
            : "the relay exited without a result; see the attempt's relay-output.txt",
        }),
      });
      break;
    }
  }
  if (record.status === "running") {
    record.status = ctx.aborting ? "aborted" : "unavailable";
    if (!ctx.aborting) record.error = "no target could be dispatched: every implementer was missing or failed its preflight";
  }
  // Only finished work is worth a second opinion.
  if (task.review && record.status === "completed" && !ctx.aborting) await runReview(task, record, cwd, ctx);
  record.durationMs = Date.now() - started;
}

function sumOf(records, pick) {
  const values = records.map(pick).filter((value) => typeof value === "number");
  return values.length ? Number(values.reduce((a, b) => a + b, 0).toFixed(6)) : null;
}

function buildResult(ctx, tasks, finished) {
  const records = tasks.map((task) => ctx.records.get(task.id) ?? { id: task.id, status: "skipped", attempts: [], worktree: null });
  const completed = records.filter((record) => record.status === "completed").length;
  const reviewed = records.filter((record) => record.review);
  const approved = reviewed.filter((record) => record.review.verdict === "approved").length;
  // A task whose review did not approve is not done, so the queue is not either.
  const done = records.filter((record) => record.status === "completed" && (!ctx.reviews.has(record.id) || record.review?.verdict === "approved")).length;
  const both = (pick) => (record) => {
    const values = [pick(record), record.review ? pick(record.review) : null].filter((value) => typeof value === "number");
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  return {
    schema: RESULT_SCHEMA,
    status: ctx.aborting ? "aborted" : done === records.length ? "completed" : completed === 0 ? "failed" : "partial",
    repo: ctx.repo,
    baseCommit: ctx.baseCommit,
    baseDirty: ctx.baseDirty,
    runId: ctx.runId,
    concurrency: ctx.concurrency,
    startedAt: ctx.startedAt,
    finishedAt: finished ? new Date().toISOString() : null,
    totals: {
      tasks: records.length,
      completed,
      reviewed: reviewed.length,
      approved,
      inputTokens: sumOf(records, both((record) => record.tokens?.input)),
      outputTokens: sumOf(records, both((record) => record.tokens?.output)),
      totalCostUsd: sumOf(records, both((record) => record.totalCostUsd)),
    },
    tasks: records,
  };
}

function printSummary(result, resultPath) {
  const reviews = result.totals.reviewed ? ` · ${result.totals.approved}/${result.totals.reviewed} reviews approved` : "";
  const lines = ["", `queue: ${result.status} · ${result.totals.completed}/${result.totals.tasks} completed${reviews}`];
  for (const task of result.tasks) {
    const via = task.attempts.length ? task.attempts.map((a) => `${a.target.lane ?? a.implementer}:${a.status}`).join(" -> ") : "not started";
    lines.push(`  ${task.status.padEnd(11)} ${task.id}  (${via})${task.worktree ? `  ${task.worktree.branch}` : ""}`);
    if (task.review) {
      const verdict = task.review.verdict ?? (task.review.status === "completed" ? "no verdict" : task.review.status);
      lines.push(`              review by ${task.review.target.lane ?? task.review.implementer}: ${verdict}`);
    }
  }
  if (result.totals.totalCostUsd !== null) lines.push(`cost: $${result.totals.totalCostUsd}`);
  if (result.baseDirty) lines.push("note: your checkout had uncommitted changes; the worktrees started from HEAD without them.");
  lines.push("", `result: ${resultPath}`);
  lines.push("queue does not commit. Review each task's worktree diff, re-run the gates, then land it yourself.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function run(argv) {
  let queueFile = null;
  let repo = process.cwd();
  let outDir = null;
  let concurrency = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (argv[i + 1] === undefined) fail(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };
    if (arg === "--cd") repo = resolve(value());
    else if (arg === "--out-dir") outDir = resolve(value());
    else if (arg === "--concurrency") concurrency = Number(value());
    else if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    else if (queueFile === null) queueFile = resolve(arg);
    else fail(`unexpected argument: ${arg}`);
  }
  if (!queueFile) fail("run needs a queue file: node queue.mjs run <queue.json>");
  if (!existsSync(queueFile)) fail(`queue file not found: ${queueFile}`);
  const parsed = parseQueue(readFileSync(queueFile, "utf8"), dirname(queueFile));
  if (concurrency !== null && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY)) {
    fail(`--concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
  }
  let top;
  try {
    top = git(repo, ["rev-parse", "--show-toplevel"]);
  } catch {
    fail(`--cd is not inside a git repository: ${repo}`);
  }
  if (parsed.tasks.some((task) => task.worktree)) {
    try { git(top, ["rev-parse", "--verify", "HEAD"]); } catch { fail("worktrees need at least one commit in the repository"); }
  }
  resolveTargets(parsed.tasks, top);

  const runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(2).toString("hex")}`;
  if (outDir) {
    // A reused out-dir would overwrite the previous run's manifest and collide with its
    // worktrees, leaving cleanup blind to them.
    for (const name of ["queue-result.json", "worktrees", "tasks"]) {
      if (existsSync(join(outDir, name))) fail(`--out-dir already holds a queue run (${name}); pass a fresh directory, or run cleanup on its queue-result.json and remove it first`);
    }
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
  } else {
    mkdirSync(join(tmpdir(), "switchboard-queue"), { recursive: true, mode: 0o700 });
    outDir = mkdtempSync(join(tmpdir(), "switchboard-queue", `${basename(top)}-${runId}-`));
  }
  const ctx = {
    repo: top,
    outDir,
    runId,
    concurrency: concurrency ?? parsed.concurrency,
    baseCommit: (() => { try { return git(top, ["rev-parse", "HEAD"]); } catch { return null; } })(),
    baseDirty: (() => { try { return git(top, ["status", "--porcelain"]).length > 0; } catch { return null; } })(),
    startedAt: new Date().toISOString(),
    records: new Map(),
    reviews: new Set(parsed.tasks.filter((task) => task.review).map((task) => task.id)),
    running: new Set(),
    aborting: false,
  };
  const resultPath = join(outDir, "queue-result.json");
  if (ctx.baseDirty && parsed.tasks.some((task) => task.worktree)) {
    process.stderr.write("queue: your checkout has uncommitted changes; worktree tasks start from HEAD without them\n");
  }

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      if (ctx.aborting) return;
      ctx.aborting = true;
      for (const child of ctx.running) stopRelay(child);
      const deadline = Date.now() + ABORT_WAIT_MS;
      const finish = () => {
        if (ctx.running.size > 0 && Date.now() < deadline) {
          setTimeout(finish, 100);
          return;
        }
        // A relay still running past the wait is recorded as aborted, not left "running".
        for (const record of ctx.records.values()) {
          if (record.status === "running") {
            Object.assign(record, { status: "aborted", error: "the relay did not exit within the abort wait; check its attempt directory" });
          }
        }
        const result = buildResult(ctx, parsed.tasks, true);
        writeJsonAtomic(resultPath, result);
        printSummary(result, resultPath);
        process.exit(128 + (constants.signals[signal] || 15));
      };
      finish();
    });
  }

  const pending = [...parsed.tasks];
  const worker = async () => {
    while (pending.length && !ctx.aborting) {
      const task = pending.shift();
      await runTask(task, ctx);
      if (!ctx.aborting) writeJsonAtomic(resultPath, buildResult(ctx, parsed.tasks, false));
    }
  };
  await Promise.all(Array.from({ length: Math.min(ctx.concurrency, parsed.tasks.length) }, worker));
  if (ctx.aborting) return;
  const result = buildResult(ctx, parsed.tasks, true);
  writeJsonAtomic(resultPath, result);
  printSummary(result, resultPath);
  process.exit(result.status === "completed" ? 0 : 1);
}

function cleanup(argv) {
  if (argv.length !== 1) fail("cleanup needs one queue-result.json");
  const file = resolve(argv[0]);
  const result = readResult(file);
  if (!result || result.schema !== RESULT_SCHEMA) fail(`not a ${RESULT_SCHEMA} file: ${file}`);
  const kept = [];
  for (const task of result.tasks) {
    if (!task.worktree) continue;
    const { path, branch } = task.worktree;
    if (existsSync(path)) {
      const removed = spawnSync("git", ["worktree", "remove", path], { cwd: result.repo, encoding: "utf8" });
      if (removed.status !== 0) {
        kept.push(`${task.id}: worktree kept (${(removed.stderr || "").trim().split("\n").pop()})`);
        continue;
      }
    }
    else {
      // A worktree whose directory is gone still holds its branch until git forgets it.
      spawnSync("git", ["worktree", "prune"], { cwd: result.repo, stdio: "ignore" });
    }
    const deleted = spawnSync("git", ["branch", "-d", branch], { cwd: result.repo, encoding: "utf8" });
    if (deleted.status !== 0 && !/not found/.test(deleted.stderr)) {
      const reason = (deleted.stderr || "").trim().split("\n").pop() || "not merged";
      kept.push(`${task.id}: branch ${branch} kept (${reason}; land it or delete it with git branch -D)`);
    }
  }
  process.stdout.write(kept.length ? `queue cleanup: kept\n  ${kept.join("\n  ")}\n` : "queue cleanup: all worktrees and merged branches removed\n");
}

const [command, ...rest] = process.argv.slice(2);
if (command === "-h" || command === "--help" || command === undefined) help();
else if (command === "run") await run(rest);
else if (command === "cleanup") cleanup(rest);
else fail(`unknown command: ${command} (expected run or cleanup)`);
