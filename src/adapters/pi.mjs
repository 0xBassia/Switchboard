/**
 * Switchboard · pi-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Pi coding agent CLI (`pi --mode json`),
 * capture the JSON event stream, and write a structured result the orchestrating
 * agent can review. The orchestrator runs this one command and reads the result
 * JSON — every pi-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Smoke-tested against a current pi CLI on macOS.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `pi` and `git`, plus the platform
 * process-termination utility when a Windows process-tree kill requires one.
 * The `pi` process it launches does authenticate — exactly as you do at the
 * terminal. Read this file before you run it.
 *
 * The brief is piped to pi on stdin, so it never appears in the host process
 * list and no argv size cap applies. Keep secrets out of the brief anyway on
 * shared machines — reference workspace files or environment variables instead.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * — after it reviews the diff and re-runs the project gates.
 *
 * Autonomy: pi has no sandbox and no permission modes — a default headless run
 * reads, writes, edits, and runs shell commands without asking. `--read-only`
 * restricts pi's callable tool surface to `read,grep,find,ls` across built-in,
 * extension, and custom tools; installed extension code still runs with the
 * user's host permissions. The relay passes `--no-approve` unless `--approve`
 * explicitly trusts project `.pi` resources. The diff reported in
 * `touchedFiles` is the record of what changed.
 *
 * pi is installed from npm, so on native Windows `pi` is a `.cmd` shim this
 * relay launches with shell:true. Only token-validated flag values ride argv
 * (the brief never does), which keeps that launch safe.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for pi (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --provider <name>       pi provider name (default: pi's own default).
 *   --model <pattern>       pi model id or pattern (default: pi's own default).
 *                           Letters, digits, and . _ : / - only.
 *   --session <id>          Resume a specific pi session; send only the delta brief.
 *   --resume-last           Continue the most recent pi session for this cwd
 *                           (`pi --continue`); send only the delta brief.
 *   --approve               Trust project-local files for this run. By default
 *                           the relay passes --no-approve.
 *   --read-only             Restrict pi to read,grep,find,ls (no write/edit/bash).
 *   --timeout <dur>         Relay-side watchdog (default: 30m). pi has no timeout
 *                           flag; durations use h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, piVersion, sessionId, finalMessage (pi's own
 *   report), requested/actual provider and model, usage, touchedFiles (git
 *   porcelain, null if git cannot report), readOnly, projectTrusted, and paths
 *   to brief.txt, final.txt, events.jsonl, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `pi` binary exits 127;
 * otherwise the exit code mirrors pi's own (0 success, non-zero failure), except
 * a final assistant `error`/`aborted` event exits 1 even if pi exits 0. If the
 * child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal. Once the brief validates, `result.json` is
 * written on every outcome — completed, failed, timeout (the --timeout watchdog
 * fired, or the bounded --version preflight hung), aborted (the relay itself
 * was killed and forwarded the kill to pi), or pi_unavailable.
 */

import { join } from "node:path";
import { exclusive, fail } from "../core/cli.mjs";
import { IS_WIN } from "../core/proc.mjs";
import { runRelay } from "../core/relay.mjs";
import { makeEventScanner } from "../core/scan.mjs";
import { tripwire } from "../core/tripwire.mjs";

const READ_ONLY_TOOLS = "read,grep,find,ls";
// --model, --provider, and --session values reach a shell on win32 (shell:true for the
// .cmd shim), so they are restricted to safe tokens.
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

// shell:true resolves pi.cmd, but a missing command is only a non-zero exit from
// cmd.exe. Ask the in-box where.exe first and exit 9009 (cmd's own "not found" code)
// so absence stays pi_unavailable.
function windowsProbe() {
  const where = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "where.exe");
  return `("${where}" pi >nul 2>&1 || exit /b 9009) && pi --version`;
}

const pi = {
  key: "pi",
  versionField: "piVersion",
  defaults: { timeout: "30m", provider: null, model: null, session: null },
  flags: {
    "--provider": { key: "provider" },
    "--model": { key: "model" },
    "--session": { key: "session" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--read-only": { key: "readOnly", kind: "bool" },
    "--approve": { key: "approve", kind: "bool" },
  },
  validate(opts) {
    exclusive(opts, [["resumeLast", "session", "--resume-last and --session are mutually exclusive; pass only one"]]);
    for (const flag of ["model", "provider", "session"]) {
      if (opts[flag] !== null && !SAFE_TOKEN.test(opts[flag])) {
        fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
      }
    }
  },
  readOnly: (opts) => opts.readOnly,
  tripwire,
  state: () => ({ actualProvider: null, actualModel: null, usage: null, stopReason: null, assistantError: null, text: [] }),
  fields: (opts, state) => ({
    provider: opts.provider,
    model: opts.model,
    readOnly: opts.readOnly,
    projectTrusted: opts.approve,
    resumed: Boolean(opts.resumeLast || opts.session),
    actualProvider: state.actualProvider,
    actualModel: state.actualModel,
    usage: state.usage,
    stopReason: state.stopReason,
  }),
  // On Windows, npm installs `pi` as a .cmd shim, which needs shell:true to resolve.
  version: () => ({
    launch: IS_WIN ? { command: windowsProbe(), args: [], shell: true } : { command: "pi", args: ["--version"] },
    missing: (code) => IS_WIN && code === 9009,
  }),
  binary: "pi",
  // The brief rides stdin, never argv. --mode json alone is non-interactive: pi reads
  // the piped brief, streams events, and exits. Only fixed flags and token-validated
  // values ride argv, so shell:true on win32 is safe.
  launch(opts, brief) {
    const args = ["--mode", "json"];
    if (opts.provider) args.push("--provider", opts.provider);
    if (opts.model) args.push("--model", opts.model);
    if (opts.session) args.push("--session", opts.session);
    else if (opts.resumeLast) args.push("--continue");
    args.push(opts.approve ? "--approve" : "--no-approve");
    if (opts.readOnly) args.push("--tools", READ_ONLY_TOOLS);
    return { command: "pi", args, shell: IS_WIN, stdin: brief };
  },
  scanner: makeEventScanner,
  onEvent(event, state) {
    if (event.type === "session" && typeof event.id === "string") state.sessionId = event.id;
    const message = event.message;
    if (event.type !== "message_end" || !message || message.role !== "assistant") return;
    const { content } = message;
    if (typeof content === "string") state.text.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) if (part && part.type === "text" && typeof part.text === "string") state.text.push(part.text);
    }
    if (typeof message.provider === "string") state.actualProvider = message.provider;
    if (typeof message.model === "string") state.actualModel = message.model;
    if (message.usage && typeof message.usage === "object") state.usage = message.usage;
    if (typeof message.stopReason === "string") state.stopReason = message.stopReason;
    if (typeof message.errorMessage === "string") state.assistantError = message.errorMessage;
  },
  // message_end carries the assistant message's usage: { input, output, cacheRead, cacheWrite, cost: { total } }.
  tokens: (state) => state.usage && {
    input: state.usage.input,
    output: state.usage.output,
    cacheRead: state.usage.cacheRead,
    cacheWrite: state.usage.cacheWrite,
  },
  cost: (state) => state.usage?.cost?.total,
  final: (state) => state.text.join("\n\n"),
  // A final assistant `error`/`aborted` event fails the run even if pi exits 0.
  verdict: (state) => (state.stopReason === "error" || state.stopReason === "aborted"
    ? { error: state.assistantError || `pi ended with stopReason "${state.stopReason}"` }
    : null),
  summary(result) {
    const lines = [];
    if (result.readOnly) lines.push(`mode: read-only (tools ${READ_ONLY_TOOLS})`);
    if (result.projectTrusted) lines.push("mode: project resources trusted (--approve)");
    if (result.actualModel) lines.push(`model: ${result.actualProvider ? `${result.actualProvider}/` : ""}${result.actualModel}`);
    return lines;
  },
};

await runRelay(pi);
