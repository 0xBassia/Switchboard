/**
 * Switchboard · switchboard-omp · relay.mjs
 *
 * Dispatch a self-contained brief to Oh My Pi (`omp --mode json`), capture the
 * JSON event stream, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every omp-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `omp` and `git`. The `omp` process it launches
 * does authenticate — exactly as you do at the terminal. Read this file before
 * you run it.
 *
 * The brief is piped to omp on stdin, so it never appears in the host process
 * list and no argv size cap applies. Keep secrets out of the brief anyway on
 * shared machines — reference workspace files or environment variables instead.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * — after it reviews the diff and re-runs the project gates.
 *
 * Autonomy: omp has no sandbox. Print mode has no approval UI, so a write run
 * passes `--yolo` (`tools.approvalMode: yolo`) and executes without prompts.
 * `--read-only` restricts the callable tool surface to `read,grep,glob`.
 * Installed extension code still runs with the user's host permissions when
 * project resources are trusted. The relay passes `--no-extensions --no-skills
 * --no-rules` unless `--approve` explicitly trusts project `.omp` resources.
 * The diff reported in `touchedFiles` is the record of what changed.
 *
 * omp is a native binary (bun / install script / Homebrew), and this relay
 * never launches it through a shell. Only
 * token-validated flag values ride argv (the brief never does).
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for omp (default: current directory).
 *   --lane <name>           Fleet lane from switchboard-setup config (dials apply; explicit flags win).
 *   --provider <name>       omp provider name (default: omp's own default).
 *   --model <pattern>       omp model id or fuzzy pattern (default: omp's own
 *                           default). List ids with `omp models`, not
 *                           `--list-models`. Letters, digits, and . _ : / - only.
 *   --thinking <level>      omp --thinking: off, auto, minimal, low, medium,
 *                           high, xhigh, or max.
 *   --session <id>          Resume a specific omp session; send only the delta brief.
 *   --resume-last           Continue the most recent omp session for this cwd
 *                           (`omp --continue`); send only the delta brief.
 *   --approve               Trust project-local .omp extensions, skills, and
 *                           rules. By default the relay passes --no-extensions
 *                           --no-skills --no-rules.
 *   --read-only             Restrict omp to read,grep,glob (no write/edit/bash).
 *   --timeout <dur>         Relay-side watchdog (default: 30m). Durations use
 *                           h/m/s strings. omp's --max-time is not forwarded.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, ompVersion, sessionId, finalMessage (omp's own
 *   report), requested/actual provider and model, thinking, usage, touchedFiles
 *   (git porcelain, null if git cannot report), readOnly, yolo, projectTrusted,
 *   and paths to brief.txt, final.txt, events.jsonl, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `omp` binary exits 127;
 * otherwise the exit code mirrors omp's own (0 success, non-zero failure), except
 * a final assistant `error`/`aborted` event exits 1 even if omp exits 0. If the
 * child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal. Once the brief validates, `result.json` is
 * written on every outcome — completed, failed, timeout (the --timeout watchdog
 * fired, or the bounded --version preflight hung), aborted (the relay itself
 * was killed and forwarded the kill to omp), or omp_unavailable.
 */

import { exclusive, fail } from "../core/cli.mjs";
import { runRelay } from "../core/relay.mjs";
import { makeEventScanner } from "../core/scan.mjs";
import { tripwire } from "../core/tripwire.mjs";

const READ_ONLY_TOOLS = "read,grep,glob";
const THINKING_LEVELS = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"];
// --model, --provider, and --session values must not look like flags. omp is
// launched without a shell, so this is flag-injection defense, not quoting.
const OMP_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const omp = {
  key: "omp",
  versionField: "ompVersion",
  defaults: { timeout: "30m", provider: null, model: null, thinking: null, session: null },
  flags: {
    "--provider": { key: "provider" },
    "--model": { key: "model" },
    "--thinking": { key: "thinking" },
    "--session": { key: "session" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--read-only": { key: "readOnly", kind: "bool" },
    "--approve": { key: "approve", kind: "bool" },
  },
  // A lane's effort dial is omp's --thinking; an explicit --thinking wins.
  laneConflicts: { effort: ["thinking"] },
  onDial(field, value, opts) {
    if (field === "effort") opts.thinking = value;
  },
  validate(opts) {
    exclusive(opts, [["resumeLast", "session", "--resume-last and --session are mutually exclusive; pass only one"]]);
    for (const flag of ["model", "provider", "session"]) {
      if (opts[flag] !== null && !OMP_TOKEN.test(opts[flag])) {
        fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
      }
    }
    if (opts.thinking !== null && !THINKING_LEVELS.includes(opts.thinking)) {
      fail(`invalid --thinking "${opts.thinking}" (expected: ${THINKING_LEVELS.join(", ")})`);
    }
  },
  readOnly: (opts) => opts.readOnly,
  tripwire,
  state: () => ({ actualProvider: null, actualModel: null, usage: null, stopReason: null, assistantError: null, text: [] }),
  fields: (opts, state) => ({
    provider: opts.provider,
    model: opts.model,
    thinking: opts.thinking,
    readOnly: opts.readOnly,
    yolo: !opts.readOnly,
    projectTrusted: opts.approve,
    resumed: Boolean(opts.resumeLast || opts.session),
    actualProvider: state.actualProvider,
    actualModel: state.actualModel,
    usage: state.usage,
    stopReason: state.stopReason,
  }),
  // omp is a native binary: never a shell.
  version: () => ({ launch: { command: "omp", args: ["--version"] } }),
  unavailableHint: "Install with `bun install -g @oh-my-pi/pi-coding-agent`, then authenticate (`/login`, or an API-key environment variable).",
  launch(opts, brief) {
    // The brief rides stdin, never argv. --mode json is print mode: omp reads
    // the piped brief, streams events, and exits.
    const args = ["--mode", "json"];
    if (opts.provider) args.push("--provider", opts.provider);
    if (opts.model) args.push("--model", opts.model);
    if (opts.thinking) args.push("--thinking", opts.thinking);
    if (opts.session) args.push("--session", opts.session);
    else if (opts.resumeLast) args.push("--continue");
    if (opts.readOnly) args.push("--tools", READ_ONLY_TOOLS);
    else args.push("--yolo");
    if (!opts.approve) args.push("--no-extensions", "--no-skills", "--no-rules");
    return { command: "omp", args, stdin: brief };
  },
  scanner: makeEventScanner,
  onEvent(event, state) {
    if (event.type === "session" && typeof event.id === "string") state.sessionId = event.id;
    const message = event.type === "message_end" && event.message;
    if (!message || message.role !== "assistant") return;
    if (typeof message.content === "string") state.text.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && part.type === "text" && typeof part.text === "string") state.text.push(part.text);
      }
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
  verdict(state) {
    if (state.stopReason !== "error" && state.stopReason !== "aborted") return null;
    return { error: state.assistantError || `omp ended with stopReason "${state.stopReason}"` };
  },
  summary(result) {
    const lines = [];
    if (result.readOnly) lines.push(`mode: read-only (tools ${READ_ONLY_TOOLS})`);
    if (result.yolo) lines.push("mode: --yolo (tools.approvalMode yolo)");
    if (result.projectTrusted) lines.push("mode: project resources trusted (--approve)");
    if (result.thinking) lines.push(`thinking: ${result.thinking}`);
    if (result.actualModel) lines.push(`model: ${result.actualProvider ? `${result.actualProvider}/` : ""}${result.actualModel}`);
    return lines;
  },
};

await runRelay(omp);
