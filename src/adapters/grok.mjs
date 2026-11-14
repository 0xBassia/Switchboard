/**
 * Switchboard · grok-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Grok Build CLI (`grok --prompt-file`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Grok-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified end-to-end on macOS against grok 0.2.101;
 * other shell-capable agents (Claude Code, Cursor, …) are designed-for but not
 * yet verified there.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `grok` and `git`. The `grok` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job —
 * after it reviews the diff and re-runs the project gates.
 *
 * Grok's default permission mode is `ask`, which blocks on approval prompts in
 * a non-interactive pipe. The relay therefore sets autonomy explicitly:
 *   default        — `--always-approve --sandbox workspace` (write in CWD)
 *   --read-only    — `--always-approve --sandbox read-only` (review intent)
 *   --full-access  — `--always-approve --sandbox off` (unrestricted; opt-in)
 *
 * `--read-only` is kernel-enforced on grok 1.0.25 (Seatbelt on macOS, Landlock
 * on Linux): grok's write/search_replace tools and shell redirects alike fail
 * with EPERM. It is not total, though — the profile still permits writes to
 * /tmp, /var/tmp and ~/.grok/, so a repo under one of those paths is NOT
 * protected, and on macOS the profile does not restrict child-process network.
 * Always confirm `touchedFiles` after a read-only run; don't rely on the flag
 * alone.
 * The relay reports `readOnlyViolation` as true when git porcelain or an
 * already-dirty Git-visible path proves a change, false when coverage is
 * complete and detects none, and null when coverage is incomplete. It cannot
 * attribute a concurrent change to Grok and does not cover ignored paths.
 *
 * The brief is handed to grok via `--prompt-file`, never argv: it stays out of
 * the host process list, isn't bounded by the OS arg-length cap, and a brief
 * that starts with "-" can't be misread as a flag.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Grok (default: current directory).
 *   --trust-git-root <dir>  Explicitly trust this exact Git root for relay Git checks
 *                           only; no persistent config or child permission changes.
 *                           Validation asks git once — via a single-use
 *                           wildcard-trust query — for git's own canonical
 *                           spelling of that exact root, verifies it against the
 *                           path you supplied, and scopes every relay Git check to
 *                           that string: git matches safe.directory against
 *                           literal path forms it canonicalizes itself, which
 *                           Node cannot reproduce reliably on Windows.
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Grok model (default: Grok's own configured default).
 *   --effort <level>        Reasoning effort for this run (passed as `--effort`).
 *   --max-turns <n>         Maximum number of agent turns for this run.
 *   --read-only             Review/diagnosis with no edits (`--sandbox read-only`).
 *   --full-access           Unrestricted auto-approve (`--sandbox off`); opt-in.
 *   --resume-last           Continue the most recent Grok session for this cwd;
 *                           send only the delta brief.
 *   --session <id>          Continue a specific session id; send only the delta brief.
 *                           Mutually exclusive with --resume-last.
 *   --timeout <dur>         Relay-side watchdog (default: off). Durations use h/m/s
 *                           strings like 30m or 2h. On expiry the grok child is killed
 *                           and result.json gets status "timeout".
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, grokVersion, sessionId (for a later resume), finalMessage
 *   (Grok's own report), usage (token counts from the run's end event, null if
 *   none), touchedFiles (git porcelain, null if git can't report), and the paths
 *   to events.jsonl and final.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `grok` binary exits 127;
 * otherwise the exit code mirrors Grok's own (0 success, non-zero failure). If
 * the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, timeout (the --timeout watchdog fired), aborted (the relay
 * itself was killed and forwarded the kill to grok), or grok_unavailable. An
 * orchestrator that polls for the
 * file must therefore also treat a non-zero exit with no file as a usage error.
 */

import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { exclusive, fail } from "../core/cli.mjs";
import { IS_WIN } from "../core/proc.mjs";
import { runRelay } from "../core/relay.mjs";
import { makeEventScanner } from "../core/scan.mjs";
import { tripwire } from "../core/tripwire.mjs";

// The Grok child never inherits the Git trust exception configured below.
const CHILD_ENV = { ...process.env };
// These values reach a shell on win32 (shell:true for the .cmd shim).
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/;
const AUTONOMY_MODES = new Set(["workspace-write", "read-only", "full-access"]);
const SANDBOX = { "read-only": "read-only", "full-access": "off", "workspace-write": "workspace" };

// `grok version` is documented; builds that only answer `--version` get the
// fallback. A missing binary is conclusive, and the whole sequence runs under
// the relay's single preflight timeout, which kills this wrapper's process group.
const VERSION_PROBE = `
const { spawnSync } = require("node:child_process");
const win = process.platform === "win32";
const run = (arg) => win ? spawnSync("grok " + arg, { encoding: "utf8", shell: true }) : spawnSync("grok", [arg], { encoding: "utf8" });
const missing = (r) => (r.error && r.error.code === "ENOENT") || (win && /not recognized as an internal or external command/i.test(r.stderr || ""));
let r = run("version");
if (r.status !== 0 && !missing(r)) r = run("--version");
if (missing(r)) { process.stderr.write("grok-missing"); process.exit(1); }
if (r.status !== 0) { process.stderr.write(r.stderr || ""); process.exit(r.status || 1); }
process.stdout.write(r.stdout);
`;

function insideGitRoot(root, cwd) {
  const path = relative(root, realpathSync(cwd));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

// Compare by filesystem identity, never by resolved path string: Node does not
// expand Windows 8.3 short names but git canonicalizes them away.
function samePhysicalDir(a, b) {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.ino !== 0 && sb.ino !== 0) return sa.dev === sb.dev && sa.ino === sb.ino;
    return relative(realpathSync(a), realpathSync(b)) === "";
  } catch {
    return false;
  }
}

// Trusts one exact Git root for the relay's own Git checks, through
// process-scoped GIT_CONFIG_* entries that CHILD_ENV never carries. Git is asked
// once, under a single-use wildcard, for its own spelling of the root: that
// literal string is what safe.directory is matched against.
function configureGitTrust(opts) {
  if (opts.trustGitRoot === null) return;
  try {
    if (opts.trustGitRoot.includes("*")) throw new Error("wildcard trust is unsupported");
    const asGiven = resolve(opts.trustGitRoot);
    const root = realpathSync(asGiven);
    if (root.includes("*")) throw new Error("wildcard trust is unsupported");
    if (!insideGitRoot(root, opts.cd)) throw new Error("--cd is outside the supplied root");
    const reported = execFileSync("git", ["-c", "safe.directory=*", "rev-parse", "--show-toplevel"], {
      cwd: asGiven, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    }).replace(/\r?\n$/, "");
    if (!samePhysicalDir(root, reported)) {
      const detail = JSON.stringify({ asGiven, root, reported }).replace(/\s+/g, " ").slice(0, 300);
      throw new Error(`path is not a Git worktree root (identity check failed: ${detail})`);
    }
    opts.trustedGitRoot = root.replaceAll("\\", "/");
    // Git's own spelling first, the forward-slashed form as belt-and-braces.
    const first = Number(process.env.GIT_CONFIG_COUNT) || 0;
    process.env.GIT_CONFIG_COUNT = String(first + 2);
    [reported, opts.trustedGitRoot].forEach((value, i) => {
      process.env[`GIT_CONFIG_KEY_${first + i}`] = "safe.directory";
      process.env[`GIT_CONFIG_VALUE_${first + i}`] = value;
    });
  } catch (err) {
    let cause = err?.message ?? String(err);
    if (err?.stderr != null) {
      const gitStderr = String(err.stderr).replace(/\s+/g, " ").trim();
      if (gitStderr && !cause.includes(gitStderr)) cause += ` — git stderr: ${gitStderr.slice(-300)}`;
    }
    fail(`--trust-git-root must name an accessible exact Git worktree root containing --cd; Git must be available (wildcards are unsupported): ${cause}`);
  }
}

const grok = {
  key: "grok",
  versionField: "grokVersion",
  defaults: { trustGitRoot: null, model: null, effort: null, maxTurns: null, autonomy: "workspace-write", session: null },
  flags: {
    "--trust-git-root": { key: "trustGitRoot" },
    "--model": { key: "model" },
    "--effort": { key: "effort" },
    "--max-turns": { key: "maxTurns" },
    "--read-only": { key: "readOnly", kind: "bool" },
    "--full-access": { key: "fullAccess", kind: "bool" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--session": { key: "session" },
  },
  laneConflicts: { autonomy: ["readOnly", "fullAccess"] },
  validate(opts) {
    if (opts.readOnly) opts.autonomy = "read-only";
    else if (opts.fullAccess) opts.autonomy = "full-access";
    if (!AUTONOMY_MODES.has(opts.autonomy)) fail(`invalid autonomy "${opts.autonomy}"`);
    exclusive(opts, [["resumeLast", "session", "--resume-last and --session are mutually exclusive"]]);
    for (const flag of ["model", "effort", "session"]) {
      if (opts[flag] !== null && !SAFE_TOKEN.test(opts[flag])) {
        fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
      }
    }
    // Digits-only also keeps the value safe for the win32 shell launch.
    if (opts.maxTurns !== null && !/^[1-9]\d*$/.test(opts.maxTurns)) fail("--max-turns must be a positive integer");
    configureGitTrust(opts);
  },
  state: (opts) => ({ sessionId: opts.session, text: [], usage: null }),
  fields: (opts, state) => ({
    trustedGitRoot: opts.trustedGitRoot ?? null,
    autonomy: opts.autonomy,
    model: opts.model,
    effort: opts.effort,
    resumeLast: opts.resumeLast,
    usage: state.usage,
  }),
  readOnly: (opts) => opts.autonomy === "read-only",
  tripwire,
  version: () => ({
    launch: { command: process.execPath, args: ["-e", VERSION_PROBE], env: CHILD_ENV },
    missing: (code, stderr) => stderr.includes("grok-missing"),
  }),
  binary: "grok",
  unavailableHint: "Install it with `npm i -g @xai-official/grok` and run `grok login`.",
  launch(opts, brief, run) {
    // shell:true on win32 resolves the grok.cmd shim; it does not quote args, so
    // the two spaceable paths are quoted (a trailing backslash, as in a drive-root
    // --cd, would escape the closing quote, so it is doubled). The brief travels as
    // --prompt-file and the other values are token-validated. Autonomy is re-passed on resume.
    const path = (value) => (IS_WIN ? `"${value.replace(/(\\+)$/, "$1$1")}"` : value);
    const args = ["--no-auto-update", "--no-alt-screen", "--output-format", "streaming-json", "--cwd", path(opts.cd)];
    if (opts.resumeLast) args.push("--continue");
    else if (opts.session) args.push("--resume", opts.session);
    // The sandbox is the enforcement; plan mode would cancel headless tools.
    args.push("--sandbox", SANDBOX[opts.autonomy], "--always-approve");
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);
    if (opts.maxTurns) args.push("--max-turns", opts.maxTurns);
    args.push("--prompt-file", path(run.briefPath));
    return { command: "grok", args, shell: IS_WIN, env: CHILD_ENV };
  },
  scanner: makeEventScanner,
  onEvent(event, state) {
    const session = event.sessionId ?? event.session_id ?? (event.session && (event.session.id ?? event.session.sessionId));
    if (session) state.sessionId = session;
    // The reply streams as {"type":"text","data":"…"}; "thought" events stay out of the report.
    if (event.type === "text") {
      const chunk = typeof event.data === "string" ? event.data : event.text;
      if (typeof chunk === "string" && chunk) state.text.push(chunk);
    }
    if (event.usage && typeof event.usage === "object") state.usage = event.usage;
  },
  // The run's end event carries input_tokens / output_tokens (dispatch-and-poll.md).
  tokens: (state) => state.usage && {
    input: state.usage.input_tokens,
    output: state.usage.output_tokens,
  },
  final: (state) => state.text.join("").trim(),
  summary: (result) => [
    `autonomy: ${result.autonomy}`,
    ...(result.resumeLast ? ["mode: resumed most recent session (--continue)"] : []),
  ],
};

await runRelay(grok);
