/**
 * Switchboard · cursor-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Cursor Agent CLI (`cursor-agent -p`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Cursor-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified against cursor-agent 2026.07.23 on Windows.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `cursor-agent` and `git` (plus taskkill on
 * Windows for process-tree termination). The `cursor-agent` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * The brief is fed on the child's stdin, never argv, so it is not visible in
 * the host process list and has no OS argument-size cap.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * — after it reviews the diff and re-runs the project gates.
 *
 * Autonomy: a fresh run defaults to write-capable with `--force` (Cursor runs
 * commands without approval unless your Cursor config denies them). Pass
 * `--read-only` to run in Cursor's plan mode (read-only/planning, no edits)
 * instead. The relay always passes `--trust` so a headless run never stalls
 * on the workspace-trust prompt — point --cd only at repositories you trust.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for Cursor (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Cursor model (default: your Cursor default, usually
 *                           auto). List names with `cursor-agent models`.
 *   --read-only             Run in Cursor's plan mode: read-only analysis, no
 *                           edits, no --force.
 *   --sandbox <mode>        Explicitly enable or disable Cursor's sandbox for
 *                           this dispatch (enabled | disabled).
 *   --no-force              Withhold --force on a write-capable run; commands
 *                           that require approval are refused instead of run.
 *   --session <id>          Resume a specific Cursor chat (`--resume <id>`);
 *                           send only the delta brief.
 *   --resume-last           Resume the most recent Cursor chat (`--continue`);
 *                           send only the delta brief.
 *   --add-dir <dir>         Add an extra workspace root. Repeatable; requires
 *                           cursor-agent 2026.07.23 or newer.
 *   --timeout <dur>         Relay-side watchdog (default: 30m; h/m/s strings
 *                           like 90s, 45m, 2h). cursor-agent has no timeout flag.
 *   --stall-timeout <dur>   Opt-in stall watchdog, h/m/s like 10m (default: off).
 *                           If cursor-agent emits no output for this long while
 *                           no tool call is in flight, the process tree is killed
 *                           and result.json gets status "stalled". The clock
 *                           pauses during a tool call (a long test run streams
 *                           nothing until it completes), so only a silent agent
 *                           turn counts.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, cursorAgentVersion, sessionId, resolvedModel,
 *   permissionMode, force, sandbox (requested value or null), usage,
 *   finalMessage (Cursor's own report),
 *   touchedFiles (git porcelain, null if git cannot report), and paths to
 *   brief.txt, final.txt, events.jsonl, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `cursor-agent` binary
 * exits 127 and writes status `cursor_agent_unavailable`; otherwise the exit
 * code mirrors cursor-agent's own (0 success, non-zero failure). If the child
 * dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal. Once the brief validates, `result.json` is
 * written on every outcome — completed, failed, timeout (the --timeout
 * watchdog fired), stalled (the --stall-timeout watchdog fired), aborted (the relay itself was killed and forwarded the kill
 * to cursor-agent), or cursor_agent_unavailable.
 */

import { resolve } from "node:path";
import { exclusive, fail } from "../core/cli.mjs";
import { parseDuration } from "../core/duration.mjs";
import { IS_WIN, cmdShimMissing } from "../core/proc.mjs";
import { runRelay } from "../core/relay.mjs";
import { makeEventScanner } from "../core/scan.mjs";
import { tripwire } from "../core/tripwire.mjs";

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/[\],=-]*$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SANDBOX_MODES = ["enabled", "disabled"];

// shell:true on win32 (needed for the cursor-agent.cmd shim) does not quote
// args, so a path with spaces would split, and a parameterized model
// ("opus[context=1m,effort=high]") would be re-tokenized by the shim's
// PowerShell hop. Quote those values on Windows only; on POSIX the quotes
// would become literal characters.
// A trailing backslash (a drive-root path) would escape the closing quote, so it is doubled.
const winq = (value) => (IS_WIN ? `"${value.replace(/(\\+)$/, "$1$1")}"` : value);

const cursor = {
  key: "cursor",
  slug: "cursor-agent",
  name: "cursor-agent",
  versionField: "cursorAgentVersion",
  defaults: { timeout: "30m", model: null, readOnly: false, force: true, sandbox: null, session: null, stallTimeout: null },
  flags: {
    "--model": { key: "model" },
    "--read-only": { key: "readOnly", kind: "bool" },
    "--sandbox": { key: "sandbox" },
    "--no-force": { key: "noForce", kind: "bool" },
    "--session": { key: "session" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--add-dir": { key: "addDirs", kind: "list" },
    "--stall-timeout": { key: "stallTimeout" },
  },
  laneConflicts: { force: ["noForce"] },
  validate(opts) {
    if (opts.noForce) opts.force = false;
    if (opts.sandbox !== null && !SANDBOX_MODES.includes(opts.sandbox)) {
      fail(`--sandbox "${opts.sandbox}" is invalid; expected enabled or disabled`);
    }
    exclusive(opts, [["resumeLast", "session", "--resume-last and --session are mutually exclusive; pass only one"]]);
    if (opts.model !== null && !SAFE_MODEL.test(opts.model)) {
      fail("--model contains unsupported characters (allowed: letters, digits, . _ : @ / [ ] , = -)");
    }
    if (opts.session !== null && !SAFE_SESSION.test(opts.session)) {
      fail("--session contains unsupported characters (allowed: letters, digits, . _ : -)");
    }
    // cursor-agent resolves a relative --add-dir against ITS cwd, so resolve
    // against --cd, which may appear after --add-dir on the command line.
    opts.addDirs = opts.addDirs.map((dir) => resolve(opts.cd, dir));
    if (IS_WIN && opts.addDirs.some((dir) => /[\0\r\n"%!]/.test(dir))) {
      fail("--add-dir cannot contain %, !, a quote, or a newline when cursor-agent launches through cmd.exe");
    }
    if (opts.stallTimeout !== null && parseDuration(opts.stallTimeout) === null) {
      fail(`--stall-timeout "${opts.stallTimeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
    }
  },
  readOnly: (opts) => opts.readOnly,
  tripwire,
  state: () => ({
    toolsInFlight: new Set(),
    resolvedModel: null,
    permissionMode: null,
    usage: null,
    resultMessage: null,
    resultIsError: false,
    text: [],
  }),
  fields: (opts, state) => ({
    model: opts.model,
    readOnly: opts.readOnly,
    force: opts.force && !opts.readOnly,
    stallTimeout: opts.stallTimeout,
    sandbox: opts.sandbox,
    resumed: Boolean(opts.resumeLast || opts.session),
    resolvedModel: state.resolvedModel,
    permissionMode: state.permissionMode,
    usage: state.usage,
  }),
  // A shell launch on win32 resolves the cursor-agent.cmd shim; cmd.exe then
  // reports a missing command as exit 9009 rather than ENOENT.
  version: () => ({ launch: { command: "cursor-agent", args: ["--version"], shell: IS_WIN }, missing: cmdShimMissing }),
  binary: "cursor-agent",
  unavailableHint: "Install the Cursor CLI (https://cursor.com/cli) and run `cursor-agent login`.",
  launch(opts, brief) {
    const args = ["--print", "--output-format", "stream-json", "--trust"];
    if (opts.readOnly) args.push("--mode", "plan");
    else if (opts.force) args.push("--force");
    if (opts.sandbox) args.push("--sandbox", opts.sandbox);
    if (opts.model) args.push("--model", winq(opts.model));
    if (opts.session) args.push("--resume", winq(opts.session));
    else if (opts.resumeLast) args.push("--continue");
    for (const dir of opts.addDirs) args.push("--add-dir", winq(dir));
    // The brief rides stdin: no process-list exposure, no OS argv-size cap.
    return { command: "cursor-agent", args, shell: IS_WIN, stdin: brief };
  },
  // Cursor streams nothing between a tool call's started and completed events,
  // however long the command runs, so the stall clock pauses while one is open.
  // A live cursor-agent that goes silent between turns is what this catches.
  stall: {
    ms: (opts) => (opts.stallTimeout === null ? null : parseDuration(opts.stallTimeout)),
    busy: (state) => state.toolsInFlight.size > 0,
    message: (opts) => `cursor-agent produced no output for --stall-timeout ${opts.stallTimeout} with no tool call in flight; killed by the relay stall watchdog — inspect the working tree, then resume the session with a delta brief`,
  },
  scanner: makeEventScanner,
  onEvent(event, state) {
    if (event.type === "tool_call" && typeof event.call_id === "string") {
      if (event.subtype === "started") state.toolsInFlight.add(event.call_id);
      else if (event.subtype === "completed") state.toolsInFlight.delete(event.call_id);
    }
    if (typeof event.session_id === "string") state.sessionId = event.session_id;
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") state.resolvedModel = event.model;
      if (typeof event.permissionMode === "string") state.permissionMode = event.permissionMode;
    } else if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const part of event.message.content) {
        if (part?.type === "text" && typeof part.text === "string") state.text.push(part.text);
      }
    } else if (event.type === "result") {
      if (typeof event.result === "string") state.resultMessage = event.result;
      if (event.is_error === true) state.resultIsError = true;
      if (event.usage && typeof event.usage === "object") state.usage = event.usage;
    }
  },
  // Raw usage is kept in `usage`; the result event's counts are camelCase on the real CLI
  // (inputTokens/outputTokens) and snake_case in older captures, so both spellings are read.
  // Only the counts the result event is known to carry; extend when a real
  // stream-json capture documents more.
  tokens: (state) => state.usage && {
    input: state.usage.inputTokens ?? state.usage.input_tokens,
    output: state.usage.outputTokens ?? state.usage.output_tokens,
  },
  // Prefer the result event's own report; fall back to the assistant text
  // stream when the run died before emitting one.
  final: (state) => (state.resultMessage?.trim() ? state.resultMessage : state.text.join("\n\n")),
  verdict: (state) => (state.resultIsError ? { error: "cursor-agent reported an error result (is_error: true in its result event)" } : null),
  summary(result) {
    const lines = [];
    if (result.readOnly) lines.push("mode: read-only (plan)");
    if (result.resolvedModel) lines.push(`model: ${result.resolvedModel}${result.permissionMode ? `  ·  permission mode: ${result.permissionMode}` : ""}`);
    return lines;
  },
};

await runRelay(cursor);
