/**
 * Switchboard · commandcode-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Command Code CLI (`cmd -p`), capture
 * the run, and write a structured result the orchestrating agent can review.
 * The orchestrator runs this one command and reads the result JSON — every
 * Command Code-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Shell-capable agents use the same file contract.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `cmd` and `git`. The `cmd` process it launches
 * does authenticate — exactly as you do at the terminal. Read this file before
 * you run it.
 *
 * Autonomy, in Command Code's own terms: a `-p` run withholds the write, edit,
 * and shell tools and there is no prompt to grant them mid-run, so the CLI
 * offers exactly two headless states. Without `--yolo` the agent can read, grep,
 * and glob but every write is refused by its permission layer. With `--yolo`
 * (alias `--dangerously-skip-permissions`) every tool is allowed, everywhere the
 * process can reach. There is no filesystem sandbox and no middle setting:
 * `--permission-mode auto-accept` and `--tools-all` do NOT lift the headless
 * write gate (verified — both were refused). So this relay passes `--yolo` for
 * implementation runs and omits it (adding `--permission-mode plan`) for
 * `--read-only`. That read-only guarantee is the CLI's own permission layer, not
 * an OS sandbox. The relay also reports a Git-visible change tripwire through
 * `readOnlyViolation`; ignored and outside-repository paths remain outside it.
 *
 * It deliberately does NOT commit. Committing belongs to the reviewer, after it
 * reads the diff and re-runs the project gates.
 *
 * Windows: Command Code installs as `cmdc` because `cmd` is the system shell.
 * The relay launches that npm shim through cmd.exe, with the brief on stdin and
 * every variable argv value token-validated. COMMANDCODE_BIN can still select
 * an absolute executable or shim when several installs compete.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Command Code (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Model for this run, e.g. vendor/model (default: Command Code's own).
 *                           `cmd --list-models` shows what is available to your account.
 *   --effort <level>        Reasoning effort — low | medium | high, model-dependent
 *                           (default: Command Code's own configured effort).
 *   --read-only             Withhold write/edit/shell tools: no --yolo, plus --permission-mode plan.
 *                           For review and diagnosis. Enforced by the CLI's permission layer, and
 *                           followed by a Git-visible readOnlyViolation tripwire.
 *   --tools-all             Also pass --tools-all, so no tool stays withheld. Ignored under
 *                           --read-only (it does not lift the write gate anyway).
 *   --max-turns <n>         Cap conversation turns (default: Command Code's own, 100).
 *                           Command Code may exit 0 at the cap; a complete max_turns result
 *                           makes the relay report failure and exit 1.
 *   --session <id>          Continue a specific session by id (the sessionId from a prior
 *                           result.json); send only the delta brief. Mutually exclusive
 *                           with --continue-last.
 *   --continue-last         Continue the most recent Command Code session; send only the delta
 *                           brief. "Most recent" is global, not per-repo, so another run can
 *                           steal it — prefer --session.
 *   --clean-env             Launch Command Code and its version preflight with only runtime basics.
 *                           Changes inherited variables only; does not protect files or other
 *                           same-user secrets.
 *   --keep-env <name>       Keep one additional variable under --clean-env (repeatable).
 *                           Required for environment-backed auth and other stripped variables.
 *   --timeout <dur>         Relay-side watchdog (default: off). Durations use h/m/s
 *                           strings like 30m or 2h. On expiry the cmd child is killed
 *                           and result.json gets status "timeout". Command Code has no
 *                           timeout flag of its own, so the watchdog is relay-only.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, outside the target repository).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, commandCodeVersion, sessionId (for a later --session),
 *   resultLine plus resultSubtype/stopReason/usage from Command Code's own result
 *   line, finalMessage (its report), touchedFiles (git porcelain, null if git
 *   can't report), readOnlyViolation, and the paths to events.jsonl and final.txt.
 *
 * A caveat that shapes the parsing: cmd's `run_end` event embeds the entire
 * conversation, so on a real run the tail of the stream exceeds a pipe buffer and
 * cmd exits without waiting for it to drain — the tail arrives cut mid-write and
 * the result line after it is simply lost in live runs. `resultLine`
 * reports which happened ("complete" | "truncated" | "absent"), and everything
 * load-bearing is read from the small early events instead: sessionId from
 * `run_start`, the report from the last `message_end`.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `cmd` binary exits 127;
 * otherwise the relay preserves Command Code's non-zero exit code. A run that
 * exits 0 while its own complete result line reports any non-success subtype is
 * reported failed with exit 1 — Command Code can end a run cleanly with the task unfinished.
 * Where that line was truncated or lost, exit 0 is taken at face value: cmd still
 * exits non-zero for the failures that matter.
 * If the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, timeout (the --timeout watchdog fired), aborted (the relay
 * itself was killed and forwarded the kill to cmd), or commandcode_unavailable. An
 * orchestrator that polls for the file must therefore also treat a non-zero exit
 * with no file as a usage error.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fail } from "../core/cli.mjs";
import { IS_WIN, cmdShimMissing } from "../core/proc.mjs";
import { runRelay } from "../core/relay.mjs";
import { MAX_BUFFERED_CHARS } from "../core/scan.mjs";
import { tripwire } from "../core/tripwire.mjs";

const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Command Code model ids are vendor/name slugs. Keep in lockstep
// with delegate-setup MODEL_TOKEN.shellSafe.
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const RUN_FILES = ["events.jsonl", "final.txt", "brief.txt", "result.json", "stderr.txt"];

const CONFIGURED_BIN = process.env.COMMANDCODE_BIN || null;
// Command Code installs as `cmdc` on Windows because `cmd` is the system shell.
const DEFAULT_BIN = IS_WIN ? "cmdc" : "cmd";
const BIN = CONFIGURED_BIN && /[\\/]/.test(CONFIGURED_BIN) ? resolve(CONFIGURED_BIN) : CONFIGURED_BIN || DEFAULT_BIN;
// The npm shim needs a shell on Windows; an explicit native executable does not.
const WIN_SHELL = IS_WIN && (!CONFIGURED_BIN || /\.(?:cmd|bat)$/i.test(BIN));
const LAUNCH_BIN = WIN_SHELL && /[\\/]/.test(BIN) ? `"${BIN}"` : BIN;

// Command Code's documented headless exit codes, for a summary hint that points at the
// actual cause instead of a bare number.
const EXIT_HINTS = new Map([
  [3, `not authenticated — run \`${DEFAULT_BIN} login\`, then re-dispatch`],
  [4, "permission denied — an implementation run needs write access; this relay passes --yolo unless --read-only was set"],
  [5, "rate limit exceeded — wait and re-dispatch, or lower the model tier"],
  [6, "network failure — check connectivity and re-dispatch"],
  [7, "Command Code API server error (5xx) — transient; re-dispatch"],
  [8, "hit the turn cap — raise --max-turns or split the brief into smaller tasks"],
  [9, "the model produced no response — re-dispatch, and check the brief is not empty of instruction"],
  [10, "insufficient credits — top up the account, then re-dispatch"],
]);

const executablePathKey = (path) => {
  try { return realpathSync.native(path).toLowerCase(); } catch { return resolve(path).toLowerCase(); }
};

// An existing --out-dir may be reused only by a prior relay run. Nothing is deleted here: a
// rejected or later-failing usage error must leave the directory exactly as it found it.
function checkOutDir(outDir) {
  let entries;
  try { entries = readdirSync(outDir); } catch { return; /* absent: the engine creates it */ }
  const stat = (name) => { try { return lstatSync(join(outDir, name)); } catch { return null; } };
  if (!entries.includes("result.json") && stat("result.json")) {
    fail("--out-dir contains a case-aliased result.json artifact");
  }
  if (!RUN_FILES.some((name) => entries.includes(name))) return;
  let priorRun = false;
  try {
    priorRun = stat("result.json").isFile() &&
      JSON.parse(readFileSync(join(outDir, "result.json"), "utf8")).schema === "delegate-relay.result.v1";
  } catch { /* an absent, malformed, or linked marker is not reusable */ }
  if (!priorRun) fail("--out-dir contains relay artifacts without a prior delegate-relay.result.v1 result");
}

function commandCodeEnv(opts) {
  if (!opts.cleanEnv) return process.env;
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
    "TMPDIR", "COMMANDCODE_BIN", "SystemRoot", "SystemDrive", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "TEMP", "TMP", "PATHEXT", "COMSPEC", ...opts.keepEnv];
  return Object.fromEntries(keep.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

/**
 * Command Code streams NDJSON: `{"type":"event",…}` lines, then one
 * `{"type":"result",…}` line carrying finalText, sessionId, subtype, stopReason,
 * and usage.
 *
 * That tail cannot be relied on. The `run_end` event just before it embeds the
 * entire conversation — every tool call, argument, and result — so on a real run
 * it is far larger than a pipe buffer, and cmd exits without waiting for the
 * write to drain: the tail arrives cut mid-string and the result line never
 * lands at all, as observed in live runs.
 * So everything load-bearing is taken from the small early events instead —
 * `run_start` carries the sessionId as the very first line, and each
 * `message_end` carries that message's text blocks, the last of which is the
 * report. The result line is still parsed when it survives, because its subtype
 * is the only place a clean-exit failure is named.
 */
function scanEventLine(line, state) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return; // progress noise, or a partial line; events.jsonl keeps it either way
  }
  const inner = event?.event;
  for (const candidate of [event?.sessionId, inner?.sessionId, inner?.result?.nextState?.sessionId]) {
    if (typeof candidate === "string" && candidate) state.sessionId = candidate;
  }
  // Streamed text, kept per message: the report often arrives as deltas long before
  // the message_end that collects them, and on a cut stream the deltas are all there is.
  if (inner?.type === "message_start") state.deltas = [];
  if (inner?.type === "text_delta" && typeof inner.delta === "string") state.deltas.push(inner.delta);
  if (inner?.type === "text_end" && typeof inner.text === "string" && inner.text.trim()) {
    state.lastText = inner.text.trim();
  }
  // The report as the model actually sent it, before the oversized tail.
  if (inner?.type === "message_end" && Array.isArray(inner.content)) {
    const text = inner.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) state.lastText = text;
  }
  if (event?.type !== "result") return;
  state.result = {
    subtype: typeof event.subtype === "string" ? event.subtype : null,
    stopReason: typeof event.stopReason === "string" ? event.stopReason : null,
    usage: event.usage ?? null,
    durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
    finalText: typeof event.finalText === "string" ? event.finalText : "",
    error: typeof event.error === "string" ? event.error : null,
  };
}

// Prefer the result line's finalText, and fall back to the last message_end text — the same
// report, delivered earlier and small enough to survive a truncated tail — then to the deltas
// of a message whose message_end never arrived.
const reportText = (state) =>
  (state.result?.finalText || state.lastText || state.deltas.join("").trim() || "").trim();

const commandcode = {
  key: "commandcode",
  name: "Command Code",
  versionField: "commandCodeVersion",
  defaults: { model: null, effort: null, maxTurns: null, session: null },
  flags: {
    "--model": { key: "model" },
    "--effort": { key: "effort" },
    "--read-only": { key: "readOnly", kind: "bool" },
    "--tools-all": { key: "toolsAll", kind: "bool" },
    "--max-turns": { key: "maxTurns" },
    "--session": { key: "session" },
    "--continue-last": { key: "continueLast", kind: "bool" },
    "--clean-env": { key: "cleanEnv", kind: "bool" },
    "--keep-env": { key: "keepEnv", kind: "list" },
  },
  validate(opts) {
    if (opts.effort !== null && !/^[a-z][a-z0-9-]*$/i.test(opts.effort)) {
      fail(`invalid --effort "${opts.effort}" (expected a non-empty bare token)`);
    }
    if (opts.model !== null && !SAFE_MODEL.test(opts.model)) {
      fail("--model contains unsupported characters (allowed: letters, digits, . _ : / -)");
    }
    if (opts.maxTurns !== null && !/^[1-9][0-9]{0,4}$/.test(String(opts.maxTurns))) {
      fail(`invalid --max-turns "${opts.maxTurns}" (expected a positive integer up to 99999)`);
    }
    if (opts.keepEnv.length && !opts.cleanEnv) fail("--keep-env requires --clean-env");
    const badName = opts.keepEnv.find((name) => !SAFE_ENV_NAME.test(name));
    if (badName) fail(`invalid --keep-env "${badName}" (expected an environment variable name)`);
    const unsetName = opts.keepEnv.find((name) => process.env[name] === undefined);
    if (unsetName) fail(`--keep-env "${unsetName}" is not set`);
    if (opts.session !== null && opts.continueLast) fail("--session and --continue-last are mutually exclusive; pass only one");
    if (opts.session !== null && !SAFE_SESSION.test(opts.session)) fail("--session must be a session id (letters, digits, . _ : -)");
    if (IS_WIN && CONFIGURED_BIN) {
      if (!isAbsolute(CONFIGURED_BIN)) fail("on Windows COMMANDCODE_BIN must be an absolute path");
      const comspec = process.env.ComSpec || process.env.COMSPEC;
      if (comspec && executablePathKey(BIN) === executablePathKey(comspec)) {
        fail("COMMANDCODE_BIN points to the Windows command interpreter; set it to the Command Code executable");
      }
    }
    if (opts.outDir) checkOutDir(opts.outDir);
  },
  readOnly: (opts) => opts.readOnly,
  // An explicit --tools-all asks for a write-capable run, so it decides against a lane's read-only dial.
  laneConflicts: { readOnly: ["readOnly", "toolsAll"] },
  tripwire,
  state: () => ({ result: null, lastText: null, truncatedTail: false, deltas: [], buffer: "" }),
  fields(opts, state) {
    return {
      readOnly: opts.readOnly,
      autonomy: opts.readOnly ? "plan (write/edit/shell withheld)" : "--yolo (all permissions bypassed)",
      toolsAll: opts.readOnly ? false : opts.toolsAll,
      model: opts.model,
      effort: opts.effort,
      maxTurns: opts.maxTurns === null ? null : Number(opts.maxTurns),
      session: opts.session,
      continueLast: opts.continueLast,
      cleanEnv: opts.cleanEnv,
      keepEnv: opts.keepEnv,
      // How much of the tail survived, so a consumer knows which fields are trustworthy:
      // "complete" = the result line landed, "truncated" = it was cut off mid-write,
      // "absent" = it never arrived. Under the last two, subtype/stopReason/usage are
      // null because cmd never delivered them — not because the run lacked them.
      resultLine: state.result ? "complete" : state.truncatedTail ? "truncated" : "absent",
      resultSubtype: state.result?.subtype ?? null,
      stopReason: state.result?.stopReason ?? null,
      usage: state.result?.usage ?? null,
      durationMs: state.result?.durationMs ?? null,
      // Only --read-only replaces this with a verdict; null says the question does not apply.
      readOnlyViolation: null,
    };
  },
  binary: BIN,
  unavailableHint: `Install Command Code, run \`${DEFAULT_BIN} login\`, or point COMMANDCODE_BIN at the binary.`,
  version: (opts) => ({
    launch: { command: LAUNCH_BIN, args: ["--version"], shell: WIN_SHELL, env: commandCodeEnv(opts) },
    missing: (code, stderr) => WIN_SHELL && cmdShimMissing(code, stderr),
  }),
  launch(opts, brief) {
    // -p with no query argument: Command Code auto-detects the piped brief on stdin.
    // Order matters — an unrecognized flag is read as the optional -p query and the CLI
    // rejects the run with "too many arguments", so only known flags go in here.
    const args = ["-p", "--output-format", "json", "--skip-onboarding", "--no-auto-update", "-t"];
    if (opts.readOnly) {
      // No --yolo: the write, edit, and shell tools stay withheld. Plan mode is the
      // CLI's own name for read-only and makes the intent visible in its transcript.
      args.push("--permission-mode", "plan");
    } else {
      // The only headless setting that enables edits; --permission-mode auto-accept and
      // --tools-all do not lift the gate (verified in direct CLI probes).
      args.push("--yolo");
      if (opts.toolsAll) args.push("--tools-all");
    }
    if (opts.session) args.push("--resume", opts.session);
    else if (opts.continueLast) args.push("--continue");
    if (opts.model) args.push("-m", opts.model);
    if (opts.effort !== null) args.push("--effort", opts.effort);
    if (opts.maxTurns !== null) args.push("--max-turns", String(opts.maxTurns));
    return { command: LAUNCH_BIN, args, shell: WIN_SHELL, env: commandCodeEnv(opts), stdin: brief };
  },
  onText(text, state) {
    state.buffer += text;
    for (let newline; (newline = state.buffer.indexOf("\n")) !== -1;) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      if (line.trim()) scanEventLine(line, state);
    }
    // A run_end event embeds the whole transcript, so one line can be arbitrarily large.
    // Scan it as a fragment rather than growing the buffer without bound; the fragment
    // cannot be parsed, which is exactly what a truncated tail is.
    if (state.buffer.length > MAX_BUFFERED_CHARS) {
      scanEventLine(state.buffer, state);
      state.buffer = "";
      state.truncatedTail = true;
    }
  },
  // The result line's usage block (camelCase, as the fake mirrors it); absent when the tail is cut.
  tokens: (state) => state.result?.usage && {
    input: state.result.usage.inputTokens,
    output: state.result.usage.outputTokens,
    cacheRead: state.result.usage.cacheReadTokens,
    cacheWrite: state.result.usage.cacheWriteTokens,
  },
  final: reportText,
  verdict(state, { code }) {
    // Leftover bytes with no closing newline are a cut-off write, not a final line.
    if (state.buffer.trim()) {
      scanEventLine(state.buffer, state);
      state.truncatedTail = true;
    }
    // Command Code can exit 0 with its own result line reporting an error or a turn cap, so a
    // clean exit is not proof of a completed task where that line exists. Where it does not,
    // the exit code is the authority: cmd truncates its oversized tail on exit, and failing on
    // that lost line would fail every large successful run.
    const { result } = state;
    const cliOk = code === 0 && (result === null || result.subtype === "success");
    const cliError = result?.error
      ? `Command Code reported ${result.subtype ?? "an error"}: ${result.error}`
      : code === 0 && !cliOk
        ? `Command Code exited 0 but reported subtype "${result.subtype}" (stopReason ${result.stopReason ?? "unknown"})`
        : null;
    if (!cliError) return null;
    return cliOk ? { fields: { error: cliError } } : { error: cliError };
  },
  summary(result) {
    const lines = [];
    const hint = EXIT_HINTS.get(result.exitCode);
    if (hint && result.status === "failed") lines.push(`hint: ${hint}`);
    lines.push(`autonomy: ${result.autonomy}`);
    if (result.continueLast) lines.push("mode: continued most recent session");
    if (result.session) lines.push(`mode: resumed session ${result.session}`);
    if (result.resultLine === "truncated" || result.resultLine === "absent") {
      lines.push(`note: cmd's result line was ${result.resultLine} (its oversized run_end tail is not flushed on exit), so subtype/usage are unavailable; the report and session id come from the earlier events.`);
    }
    if (result.resultSubtype && result.resultSubtype !== "success") {
      lines.push(`Command Code result: ${result.resultSubtype}${result.stopReason ? ` (stopReason ${result.stopReason})` : ""}`);
    }
    return lines;
  },
};

await runRelay(commandcode);
