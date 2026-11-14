/**
 * Switchboard · agy-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Google Antigravity CLI (`agy --print`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON -
 * every Antigravity-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `agy` and `git`. The `agy` process it launches
 * does authenticate - exactly as you do at the terminal. Read this file before
 * you run it.
 *
 * Note: `agy --print` takes the prompt as a command-line argument, so the brief is
 * visible in the host process list (`ps`, /proc). On a shared machine keep secrets
 * out of the brief - reference them by a path or env var the workspace can read.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job -
 * after it reviews the diff and re-runs the project gates.
 *
 * Antigravity owns its own permission policy. This helper does not pass
 * --dangerously-skip-permissions by default; opt into that flag only when the
 * human explicitly accepts it. Pass --sandbox to enable Antigravity's terminal
 * sandbox for the run.
 *
 * `--read-only` composes both: `--sandbox --dangerously-skip-permissions`. That
 * pairing looks alarming and is deliberate — the sandbox is the enforcement and
 * the auto-approve only lets tools run *inside* it. Plan mode alone cannot do
 * the job: headless `--print` has no way to answer a permission prompt, so agy
 * auto-denies the first tool that needs one and the run returns nothing at all
 * ("a tool required the \"command\" permission that headless mode cannot prompt
 * for"). Verified on agy 1.1.28, macOS: under --sandbox, writes to the working
 * tree are overlaid and discarded, and every path outside the workspace fails
 * with EPERM for read *and* write.
 *
 * Two consequences worth knowing before choosing this lane:
 *   - The sandbox confines READS to the workspace too. A brief that cites an
 *     absolute path outside --cd cannot be followed; keep briefs self-contained
 *     or add the path with agy's own --add-dir.
 *   - Inside the workspace a write appears to succeed to the agent — it reads
 *     its own overlay back — and is then discarded. The tree is safe, but a
 *     confused run may report edits it did not make. Trust `touchedFiles`, not
 *     the agent's account of itself.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Antigravity (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Antigravity model label (default: agy's configured default).
 *   --effort <level>        Reasoning effort: low, medium, or high (passed as agy's own --effort).
 *   --project <id>          Use an existing Antigravity project.
 *   --new-project           Force a fresh Antigravity project (default for fresh runs).
 *   --resume-last           Continue the most recent Antigravity conversation; send only the delta brief.
 *   --conversation <id>     Continue a specific Antigravity conversation; send only the delta brief.
 *   --sandbox               Enable Antigravity's terminal sandbox for this run.
 *   --read-only             Review/diagnosis with no edits: runs under agy's sandbox with
 *                           tool approval auto-granted inside it (`--sandbox
 *                           --dangerously-skip-permissions`). Reads and writes are both
 *                           confined to the workspace. Mutually exclusive with
 *                           --dangerously-skip-permissions as a flag: that alone, without
 *                           the sandbox, is full access.
 *   --dangerously-skip-permissions
 *                           Auto-approve Antigravity tool permission requests. Use only with human approval.
 *                           Mutually exclusive with --read-only.
 *   --print-timeout <dur>   Timeout agy itself applies to print mode (default: 30m).
 *   --timeout <dur>         Relay-side watchdog, h/m/s like 30m (default: --print-timeout
 *                           plus a 60s grace). On expiry the agy process tree is killed and
 *                           result.json gets status "timeout". Set it explicitly when agy
 *                           may hang past its own print timeout.
 *   --stall-timeout <dur>   Opt-in stall watchdog, h/m/s like 5m (default: off). If agy.log
 *                           gains no new `streamGenerateContent` line for this long, the agy
 *                           process tree is killed and result.json gets status "stalled".
 *                           The clock starts at launch and restarts on every generation call.
 *                           Set it above your longest expected tool step (a long test run
 *                           makes no generation calls). Keys on agy's own log format, which
 *                           agy does not document as stable.
 *   --add-dir <dir>        Add an extra workspace directory. Repeatable.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout -
 *   status, exitCode, agyVersion, projectId, conversationId, finalMessage
 *   (Antigravity's own report), touchedFiles (git porcelain, null if git can't report),
 *   readOnlyViolation (on --read-only), and the paths to brief.txt, final.txt, agy.log, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `agy` binary exits 127;
 * otherwise the exit code mirrors Antigravity's own, except that an exit-zero
 * permission denial, silent no-op, or abandoned background tasks without edits is forced to exit 1.
 * If the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome -
 * completed, failed, timeout (the relay watchdog fired after explicit --timeout,
 * or after --print-timeout plus 60s grace), stalled (--stall-timeout passed with
 * no generation call in agy.log; the tree may hold usable work), aborted (the
 * relay itself was killed and forwarded the kill to agy), or agy_unavailable. An orchestrator that polls for the
 * file must therefore also treat a non-zero exit with no file as a usage error.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fail } from "../core/cli.mjs";
import { MAX_TIMER_MS, parseDuration } from "../core/duration.mjs";
import { nestedGitUnsafe, runGit } from "../core/git.mjs";
import { runRelay } from "../core/relay.mjs";
import { runArtifactPaths } from "../core/run.mjs";

// The OS caps one argv string (~128KB on Linux via MAX_ARG_STRLEN; Windows caps the whole
// command line at 32K characters), and agy takes the brief as an argument.
const MAX_BRIEF_BYTES = (process.platform === "win32" ? 12 : 120) * 1024;
const PRINT_GRACE_MS = 60_000;
const DURATION_RANGE = "from 1s through 596h31m23s";
// agy logs one of these per model request; a healthy run emits them steadily between tool steps.
const GENERATION_MARKER = "streamGenerateContent";

// sha256 over the whole worktree (status, index and worktree diffs, and the content of every
// dirty path, recursing into submodules), or null when git cannot give a complete answer.
// Relay artifacts that live inside the repository are excluded.
// The top level is the pinned repository; a nested checkout is entered only when its
// own config cannot make git run anything.
function gitWorktreeFingerprint(cwd, excludedPaths = [], nested = false) {
  try {
    if (nested && nestedGitUnsafe(cwd)) return null;
    const plain = (args) => execFileSync("git", args, {
      cwd,
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const git = nested ? plain : (args) => runGit(cwd, args);
    const root = realpathSync.native(git(["rev-parse", "--show-toplevel"]).toString("utf8").replace(/\r?\n$/, ""));
    const exclusions = excludedPaths
      .map((path) => {
        const absolute = resolve(path);
        try { return relative(root, realpathSync.native(absolute)); }
        catch { return relative(root, join(realpathSync.native(dirname(absolute)), basename(absolute))); }
      })
      .filter((path) => path && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path))
      .map((path) => `:(exclude,top,literal)${path.replaceAll("\\", "/")}`);
    const pathspec = [":(top)", ...exclusions];
    const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ...pathspec]);
    const fingerprint = createHash("sha256").update("status\0").update(status);
    fingerprint.update("\0index\0").update(git(["diff", "--cached", "--raw", "--full-index", "--no-renames", "-z", "--", ...pathspec]));
    fingerprint.update("\0worktree\0").update(git(["diff", "--raw", "--full-index", "--no-renames", "-z", "--", ...pathspec]));

    const paths = [...new Set(status.toString("utf8").split("\0").filter(Boolean).map((entry) => entry.slice(3)))].sort();
    for (const path of paths) {
      const fullPath = join(cwd, path);
      fingerprint.update("\0path\0").update(path).update("\0");
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        fingerprint.update("missing");
        continue;
      }
      fingerprint.update(String(stat.mode)).update("\0");
      if (stat.isSymbolicLink()) fingerprint.update(readlinkSync(fullPath));
      else if (stat.isFile()) fingerprint.update(git(["hash-object", "--no-filters", "--", path]));
      else if (stat.isDirectory()) {
        const nestedState = gitWorktreeFingerprint(fullPath, excludedPaths, true);
        if (nestedState === null) return null;
        let headState;
        try {
          headState = plain(["-C", fullPath, "rev-parse", "--verify", "HEAD"]);
        } catch {
          const symbolicHead = plain(["-C", fullPath, "symbolic-ref", "--quiet", "HEAD"]).toString("utf8").trim();
          const target = spawnSync("git", ["-C", fullPath, "show-ref", "--verify", "--quiet", symbolicHead], { cwd, timeout: 10_000, killSignal: "SIGKILL", stdio: "ignore" });
          if (target.status !== 1) return null;
          headState = Buffer.from(`unborn\0${symbolicHead}`);
        }
        fingerprint.update("submodule\0").update(headState).update(nestedState);
      } else return null;
    }
    return fingerprint.digest("hex");
  } catch {
    return null;
  }
}

const fingerprintNow = (opts, run) => gitWorktreeFingerprint(opts.cd, runArtifactPaths(run));

function parseIdsFromLog(logPath) {
  const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const first = (patterns) => patterns.map((pattern) => text.match(pattern)).find(Boolean)?.[1] ?? null;
  return {
    projectId: first([
      /project: created project "[^"]*" \(id=([0-9a-f-]+)\)/i,
      /Conversation using project ID: ([0-9a-f-]+)/i,
      /Backend project ID updated dynamically to: ([0-9a-f-]+)/i,
    ]),
    conversationId: first([/Print mode: conversation=([0-9a-f-]+)/i, /Created conversation ([0-9a-f-]+)/i]),
  };
}

// Returns a poll function: true when agy.log gained a generation line since the last poll.
// Reads only the new bytes; a carry of marker-length-minus-one bytes catches a marker split
// across reads without ever counting the same one twice.
function makeGenerationWatch(logPath) {
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  let carry = "";
  return () => {
    let fd;
    try {
      fd = openSync(logPath, "r");
    } catch {
      return false; // agy has not created the log yet
    }
    try {
      const size = fstatSync(fd).size;
      if (size < offset) {
        offset = 0;
        carry = "";
      }
      let found = false;
      while (offset < size) {
        const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (read <= 0) break;
        offset += read;
        const text = carry + buffer.toString("latin1", 0, read);
        if (text.includes(GENERATION_MARKER)) found = true;
        carry = text.slice(-(GENERATION_MARKER.length - 1));
      }
      return found;
    } catch {
      return false;
    } finally {
      closeSync(fd);
    }
  };
}

const agy = {
  key: "agy",
  versionField: "agyVersion",
  defaults: { model: null, effort: null, project: null, conversation: null, printTimeout: "30m", stallTimeout: null },
  flags: {
    "--model": { key: "model" },
    "--effort": { key: "effort" },
    "--project": { key: "project" },
    "--new-project": { key: "newProject", kind: "bool" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--conversation": { key: "conversation" },
    "--sandbox": { key: "sandbox", kind: "bool" },
    "--read-only": { key: "readOnly", kind: "bool" },
    "--dangerously-skip-permissions": { key: "dangerouslySkipPermissions", kind: "bool" },
    "--print-timeout": { key: "printTimeout" },
    "--stall-timeout": { key: "stallTimeout" },
    "--add-dir": { key: "addDirs", kind: "list" },
  },
  laneConflicts: { readOnly: ["readOnly", "dangerouslySkipPermissions"] },
  validate(opts) {
    if (opts.effort !== null && !["low", "medium", "high"].includes(opts.effort)) {
      fail(`invalid --effort "${opts.effort}" (expected: low, medium, high)`);
    }
    if (opts.readOnly && opts.dangerouslySkipPermissions) {
      fail("--read-only and --dangerously-skip-permissions are mutually exclusive; pass only one");
    }
    if (opts.resumeLast && opts.conversation) {
      fail("--resume-last and --conversation are mutually exclusive; pass only one");
    }
    if (opts.stallTimeout !== null && parseDuration(opts.stallTimeout) === null) {
      fail(`--stall-timeout "${opts.stallTimeout}" must be an h/m/s duration ${DURATION_RANGE}`);
    }
    const printTimeoutMs = parseDuration(opts.printTimeout);
    if (printTimeoutMs === null || printTimeoutMs + PRINT_GRACE_MS > MAX_TIMER_MS) {
      fail(`--print-timeout "${opts.printTimeout}" must be an h/m/s duration from 1s through 596h30m23s so its 60s grace fits the relay watchdog limit`);
    }
    if (opts.project && (opts.resumeLast || opts.conversation)) fail("--project cannot be combined with --resume-last or --conversation");
    if (opts.project && opts.newProject) fail("--project and --new-project are mutually exclusive");
    if (opts.newProject && (opts.resumeLast || opts.conversation)) fail("--new-project cannot be combined with --resume-last or --conversation");
    // agy requires absolute --add-dir paths; resolve against --cd (not the relay's cwd) here,
    // since --add-dir may appear before --cd on the command line.
    opts.addDirs = opts.addDirs.map((dir) => resolve(opts.cd, dir));
    // An explicit --timeout wins over the default print-timeout-plus-grace: agy can hang well
    // past its own print timeout, which is exactly the case the grace window cannot cover.
    opts.implicitTimeout = opts.timeout === null;
    if (opts.implicitTimeout) opts.timeout = `${(printTimeoutMs + PRINT_GRACE_MS) / 1000}s`;
  },
  maxBriefBytes: MAX_BRIEF_BYTES,
  briefTooLarge: (kb) => `brief is ${kb}KB; agy passes the prompt as a CLI argument, which the OS caps (~128KB on Linux, 32K characters for the whole command line on Windows). Trim it, or have agy read large context from the workspace instead of inlining it.`,
  artifacts: { logPath: "agy.log" },
  timeoutLabel: (opts) => opts.implicitTimeout ? `--print-timeout ${opts.printTimeout} plus 60s grace` : `--timeout ${opts.timeout}`,
  // The wall-clock watchdog cannot tell a stalled run from a slow one: after a dropped stream agy
  // can keep re-running auth and model-discovery handshakes, so the process stays alive and
  // agy.log keeps growing while no model request is ever made again. Opt-in, because it keys on
  // agy's log format rather than a documented contract. A new generation call in the log is the
  // activity signal (not output), so it is reported through busy().
  stall: {
    ms: (opts) => (opts.stallTimeout === null ? null : parseDuration(opts.stallTimeout)),
    busy: (state) => (state.sawGeneration ??= makeGenerationWatch(state.run.logPath))(),
    message: (opts) => `agy logged no ${GENERATION_MARKER} call for --stall-timeout ${opts.stallTimeout}; killed by the relay stall watchdog — the working tree may hold nearly finished work, inspect it before re-dispatching`,
  },
  state: () => ({ out: "", err: "" }),
  fields: (opts, state, run) => ({
    model: opts.model,
    effort: opts.effort,
    stallTimeout: opts.stallTimeout,
    project: opts.project,
    sandbox: opts.sandbox,
    readOnly: opts.readOnly,
    // Three-valued: true when fingerprints prove a change, false when coverage is complete and
    // proves none, null when a fingerprint could not be taken or the run was not read-only.
    readOnlyViolation: !opts.readOnly || state.before == null ? null : (() => {
      const after = state.after !== undefined ? state.after : fingerprintNow(opts, run);
      return after === null ? null : after !== state.before;
    })(),
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    resumed: Boolean(opts.resumeLast || opts.conversation),
    ...parseIdsFromLog(run.logPath),
    logPath: existsSync(run.logPath) ? run.logPath : null,
  }),
  version: () => ({
    launch: { command: "agy", args: ["changelog"] },
    parse(out) {
      const firstLine = out.trim().split("\n").find(Boolean) || "";
      return firstLine.match(/^([^:\s]+):/)?.[1] ?? firstLine;
    },
  }),
  unavailableHint: "Install the Antigravity CLI and complete first-launch setup.",
  launch(opts, brief, run, state) {
    Object.assign(state, { opts, run, before: fingerprintNow(opts, run) });
    const resuming = opts.resumeLast || opts.conversation;
    const args = [];
    if (opts.project) args.push("--project", opts.project);
    else if (opts.conversation) args.push("--conversation", opts.conversation);
    else if (opts.resumeLast) args.push("--continue");
    else args.push("--new-project");
    // Relying on cwd alone can produce a false "I created the file" response, so pin the
    // workspace explicitly (agy requires an absolute path; opts.cd is already resolved). A resumed
    // conversation already carries that pin; explicit --add-dir values are forwarded on every run.
    if (!resuming) args.push("--add-dir", opts.cd);
    for (const dir of opts.addDirs) args.push("--add-dir", dir);
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);
    if (opts.readOnly) {
      // The sandbox is the enforcement; the auto-approve only lets tools run inside it. Plan
      // mode cannot work headless: agy auto-denies any tool needing a permission prompt, so
      // the first command ended the run with nothing returned.
      args.push("--sandbox", "--dangerously-skip-permissions");
    } else {
      if (opts.sandbox) args.push("--sandbox");
      if (opts.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    }
    args.push("--print-timeout", opts.printTimeout, "--log-file", run.logPath);
    // --print=<brief>, not ["--print", brief]: agy's flag parser intercepts a value that is
    // exactly a bare flag ("--help"); the equals form always binds the value.
    args.push(`--print=${brief}`);
    // A native binary: launched directly, so multi-line briefs and spaced paths ride argv.
    return { command: "agy", args, env: { ...process.env, PWD: opts.cd } };
  },
  onText: (text, state) => { state.out += text; },
  onStderr: (text, state) => { state.err += text; },
  final: (state) => state.out.trim(),
  verdict(state, { code }) {
    const { opts, run } = state;
    const finalMessage = state.out.trim();
    state.after = fingerprintNow(opts, run);
    const unchanged = state.before !== null && state.after === state.before;
    const denied = /no output produced\s+[—-]\s+a tool required the "([^"]+)" permission that headless\s+mode cannot prompt for, so it was auto-denied/i.exec(state.err);
    if (denied) {
      return { error: `Antigravity auto-denied the ${denied[1]} permission because headless --print cannot prompt; ask the human whether to re-dispatch with --dangerously-skip-permissions and treat that run as full access` };
    }
    // A clean run still owes the caller a report: with neither a final message nor observable
    // worktree changes, exit 0 cannot confirm any dispatch completed.
    if (code === 0 && !finalMessage && (state.before === null || state.after === null || unchanged)) {
      return { error: "agy exited 0 without a final message or observable working-tree changes; the relay cannot confirm this dispatch completed" };
    }
    if (code === 0 && !opts.readOnly && unchanged && /terminating\s+\d+\s+background task\(s\) on exit/i.test(state.err)) {
      return { error: "agy exited 0 after ending its turn with background task(s) still pending and no observable working-tree changes; the relay cannot confirm this dispatch completed" };
    }
    return finalMessage ? null : { fields: { stderrTail: state.err.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-20) } };
  },
  summary: (result) => [
    ...(result.projectId ? [`project id: ${result.projectId}`] : []),
    ...(result.conversationId ? [`conversation id (resume with: --conversation ${result.conversationId}): ${result.conversationId}`] : []),
  ],
};

await runRelay(agy);
