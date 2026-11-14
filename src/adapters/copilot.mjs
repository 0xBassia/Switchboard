/**
 * Switchboard · copilot-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the GitHub Copilot CLI (`copilot -p`),
 * capture the JSONL event stream, and write a structured result the
 * orchestrating agent can review. The orchestrator runs this one command and
 * reads the result JSON — every copilot-specific mechanic lives in here, which
 * keeps the skill orchestrator-agnostic.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `copilot`, `git`, and Windows `taskkill` for
 * process-tree termination. The `copilot` process it launches does
 * authenticate — exactly as you do at the terminal. Read this file before you
 * run it.
 *
 * The brief is handed to copilot via `-p @<file>` (the CLI's @-prefixed file
 * prompt channel, verified on copilot 1.0.78), never argv: it stays out of
 * the host process list, isn't bounded by the OS arg-length cap, and a brief
 * that begins with "-" can't be misread as a flag.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * — after it reviews the diff and re-runs the project gates.
 *
 * Default mode runs without `--allow-all-tools`: headless tool calls are
 * auto-denied by copilot, and the relay detects denial events and reports
 * `status: "failed"` with the CLI's own error message plus a hint to pass
 * `--allow-all-tools`. `--allow-all-tools` explicitly opts in to full tool
 * autonomy. `--read-only` selects `--mode plan`, which disables edit tools so
 * project files can't be changed by direct edits (shell commands still run),
 * and works without `--allow-all-tools`. `--read-only` and `--allow-all-tools`
 * are mutually exclusive.
 *
 * On native Windows `copilot` is an npm-installed `.cmd` shim this relay
 * launches with shell:true. Model and effort values therefore accept only
 * shell-safe tokens; the working directory is the child process cwd; and the
 * brief path is quoted for the shell.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for copilot (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Copilot model (default: copilot's own default, `auto`).
 *                           Letters, digits, and . _ : / - only.
 *   --effort <level>        Reasoning effort for this run (low|medium|high|xhigh|max).
 *   --read-only             Read-only plan mode (`--mode plan`); works without
 *                           `--allow-all-tools`. Mutually exclusive with
 *                           `--allow-all-tools`.
 *   --allow-all-tools       Pass copilot's `--allow-all-tools` for full tool
 *                           autonomy in headless mode. Without this, headless
 *                           tool calls are auto-denied. Mutually exclusive with
 *                           `--read-only`.
 *   --resume-last           Continue the most recent copilot session for this
 *                           cwd (`--continue`); send only the delta brief.
 *   --session <id>          Continue a specific session id (`--resume=<id>`);
 *                           send only the delta brief. Mutually exclusive with
 *                           --resume-last.
 *   --timeout <dur>         Relay-side watchdog (default: 30m). Copilot has no
 *                           timeout flag; durations use h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, copilotVersion, model, effort, readOnly,
 *   allowAllTools, resumed, sessionId, finalMessage (the last non-ephemeral
 *   assistant message), touchedFiles (git porcelain, null if git cannot
 *   report), and paths to brief.txt, final.txt, events.jsonl, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `copilot` binary exits
 * 127; otherwise the exit code mirrors copilot's own (0 success, non-zero
 * failure), except a run whose event stream contains a tool denial exits 1
 * even if copilot exits 0. If the child dies on a signal, the exit code is 128
 * plus the signal number and `result.json` records the signal. Once the brief
 * validates, `result.json` is written on every outcome — completed, failed,
 * timeout (the --timeout watchdog fired), aborted (the relay itself was killed
 * and forwarded the kill to copilot), or copilot_unavailable.
 */

import { exclusive, fail } from "../core/cli.mjs";
import { IS_WIN, cmdShimMissing } from "../core/proc.mjs";
import { runRelay } from "../core/relay.mjs";
import { makeLineScanner } from "../core/scan.mjs";
import { tripwire } from "../core/tripwire.mjs";

// --model, --effort and --session values reach a shell on win32 (shell:true for
// the .cmd shim), so they are restricted to safe tokens. Effort is then checked
// against Copilot's documented enum.
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// On resume (--resume=<id> / --continue), a bare @file reference in the resumed
// session is echoed back instead of executed (verified on copilot 1.0.78); the
// relay wraps the reference in this fixed directive so the delta is acted on.
// The directive is relay-authored text, so the win32 value has no user content
// to mangle inside its shell quotes. Deliberately not appended on fresh runs,
// which execute a bare @file reference correctly.
const RESUME_DIRECTIVE =
  "Execute the instructions in the referenced file, then report what you did. Do not just summarize the file: ";

// A final event without a trailing newline still parses once the stream ends.
let flushEvents = () => {};

const copilot = {
  key: "copilot",
  versionField: "copilotVersion",
  defaults: { timeout: "30m", model: null, effort: null, session: null },
  flags: {
    "--model": { key: "model" },
    "--effort": { key: "effort" },
    "--read-only": { key: "readOnly", kind: "bool" },
    "--allow-all-tools": { key: "allowAllTools", kind: "bool" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--session": { key: "session" },
  },
  laneConflicts: { readOnly: ["readOnly", "allowAllTools"] },
  validate(opts) {
    exclusive(opts, [
      ["readOnly", "allowAllTools", "--read-only and --allow-all-tools are mutually exclusive; plan mode works without tool permissions"],
      ["resumeLast", "session", "--resume-last and --session are mutually exclusive; pass only one"],
    ]);
    if (opts.session !== null && !opts.session.trim()) fail("--session must not be empty");
    for (const flag of ["model", "effort", "session"]) {
      if (opts[flag] !== null && !SAFE_VALUE.test(opts[flag])) {
        fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
      }
    }
    if (opts.effort !== null && !EFFORT_LEVELS.includes(opts.effort)) {
      fail(`invalid --effort "${opts.effort}" (expected: ${EFFORT_LEVELS.join(", ")})`);
    }
  },
  readOnly: (opts) => opts.readOnly,
  tripwire,
  state: () => ({ lastMessage: "", denied: false, denialMessage: "" }),
  fields: (opts) => ({
    model: opts.model,
    effort: opts.effort,
    readOnly: opts.readOnly,
    allowAllTools: opts.allowAllTools,
    resumed: Boolean(opts.resumeLast || opts.session),
  }),
  // `copilot version` prints "GitHub Copilot CLI X.Y.Z" on its first line,
  // optionally followed by an update notice. shell:true resolves the .cmd shim
  // on win32, where cmd.exe reports a missing command as a non-zero exit.
  version: () => ({
    launch: { command: "copilot", args: ["version"], shell: IS_WIN },
    parse(out) {
      const first = out.trim().split("\n")[0].trim();
      return first.match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?)/)?.[1] ?? first;
    },
    missing: cmdShimMissing,
  }),
  unavailableHint: "Install with `npm install -g @github/copilot` and run `copilot login`.",
  launch(opts, brief, run) {
    const args = ["--output-format", "json", "--no-color", "--stream", "off"];
    if (opts.readOnly) args.push("--mode", "plan");
    if (opts.allowAllTools) args.push("--allow-all-tools");
    if (opts.resumeLast) args.push("--continue");
    else if (opts.session) args.push(`--resume=${opts.session}`);
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);
    // The brief rides a file reference, not argv. shell:true on win32 does not
    // quote args, so the spaceable value is quoted for cmd.exe; the resume
    // directive contains spaces, so its whole value is outer-quoted.
    const quote = (value) => (IS_WIN ? `"${value}"` : value);
    args.push("-p", opts.resumeLast || opts.session
      ? quote(`${RESUME_DIRECTIVE}@${run.briefPath}`)
      : `@${quote(run.briefPath)}`);
    return { command: "copilot", args, shell: IS_WIN };
  },
  scanner(onEvent) {
    const scan = makeLineScanner(onEvent);
    flushEvents = () => scan("\n");
    return scan;
  },
  onEvent(event, state) {
    // Ephemeral events (mcp status, skills_loaded, tool.execution_start, ...) carry nothing we keep.
    if (event.ephemeral) return;
    if (event.type === "assistant.message" && typeof event.data?.content === "string") {
      state.lastMessage = event.data.content;
    } else if (event.type === "result" && event.sessionId) {
      state.sessionId = event.sessionId;
    } else if (event.type === "tool.execution_complete" && event.data?.success === false && event.data.error?.code === "denied") {
      // The headless auto-deny trap: copilot exits 0 but the run is a failure.
      state.denied = true;
      state.denialMessage = event.data.error.message || "Permission denied";
    }
  },
  final(state) {
    flushEvents();
    return state.lastMessage;
  },
  verdict(state) {
    flushEvents();
    if (!state.denied) return null;
    return { error: `copilot auto-denied a tool call in headless mode: ${state.denialMessage}. Pass --allow-all-tools to grant full tool permissions` };
  },
  summary(result) {
    const lines = [];
    if (result.readOnly) lines.push("mode: plan (read-only)");
    if (result.allowAllTools) lines.push("autonomy: --allow-all-tools");
    return lines;
  },
};

await runRelay(copilot);
