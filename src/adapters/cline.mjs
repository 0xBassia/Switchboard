/**
 * Switchboard · cline-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Cline coding agent CLI (`cline --json -v`),
 * capture the JSON event stream, and write a structured result the orchestrating
 * agent can review. The orchestrator runs this one command and reads the result
 * JSON — every cline-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `cline` and `git` (plus `where.exe` / `taskkill`
 * on Windows) — and to `node` for the delegate-setup lane resolver when `--lane`
 * is used. The `cline` process it launches does authenticate — exactly as you do
 * at the terminal. Read this file before you run it.
 *
 * The brief is streamed to cline on stdin. Current Cline JSON mode checks for
 * a positional prompt before it reads piped input, so the relay passes a fixed
 * positional instruction and keeps the full brief out of argv.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * — after it reviews the diff and re-runs the project gates.
 *
 * Autonomy: the relay explicitly sets Cline's `--auto-approve` (true in act
 * mode, false with `--plan`). Plan mode can request a switch to act mode, so
 * `--plan --auto-approve true` is rejected to preserve the read-only gate.
 * Cline also supports sandbox through `--data-dir` / `CLINE_SANDBOX`; this
 * relay does not configure it. The diff reported in `touchedFiles` records
 * what changed.
 *
 * On native Windows `cline` is an npm-installed `.cmd` shim this relay launches
 * with shell:true. Provider and model values therefore accept only shell-safe
 * tokens; the working directory is the child process cwd and the brief stays
 * on stdin.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for cline (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --provider <name>       cline provider id (default: cline's own default).
 *   --model <id>            cline model id (default: cline's own default).
 *                           Letters, digits, and . _ : / - only.
 *   --plan                  Read-only plan mode; forces --auto-approve false.
 *   --auto-approve <bool>   Cline tool auto-approval (default: true in act mode,
 *                           false with --plan). True conflicts with --plan.
 *   --timeout <dur>         Relay-side watchdog (default: 30m). h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, clineVersion, sessionId, finalMessage (cline's own
 *   report, from run_result.text), requested/actual provider and model, usage,
 *   finishReason, touchedFiles (git porcelain, null if git cannot report),
 *   planMode, autoApprove, briefPath, nullable finalPath, eventsPath, and
 *   stderrPath. sessionId is nullable because fresh JSON runs omit it.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `cline` binary exits 127;
 * otherwise the exit code mirrors cline's own (0 success, non-zero failure),
 * except a run_result whose finishReason is not "completed" exits 1 even if
 * cline exits 0. If the child dies on a signal, the exit code is 128 plus the
 * signal number and `result.json` records the signal. Once the brief validates,
 * `result.json` is written on every outcome — completed, failed, timeout (the
 * --timeout watchdog fired, or the bounded --version preflight hung), aborted
 * (the relay itself was killed and forwarded the kill to cline), or
 * cline_unavailable.
 */

import { fail } from "../core/cli.mjs";
import { IS_WIN, cmdShimMissing } from "../core/proc.mjs";
import { runRelay } from "../core/relay.mjs";
import { makeEventScanner } from "../core/scan.mjs";
import { tripwire } from "../core/tripwire.mjs";

const STDIN_PROMPT = "Follow the task instructions provided on stdin.";
// --model and --provider values reach a shell on win32 (shell:true for the .cmd
// shim), so they are restricted to safe tokens.
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const cline = {
  key: "cline",
  // cline has no resume flag, so the summary shows the session id without a hint.
  resumeFlag: false,
  versionField: "clineVersion",
  defaults: { timeout: "30m", provider: null, model: null, autoApprove: null },
  flags: {
    "--provider": { key: "provider" },
    "--model": { key: "model" },
    "--plan": { key: "plan", kind: "bool" },
    "--auto-approve": { key: "autoApprove" },
  },
  validate(opts) {
    if (typeof opts.autoApprove === "string") {
      if (opts.autoApprove !== "true" && opts.autoApprove !== "false") fail("--auto-approve must be true or false");
      opts.autoApprove = opts.autoApprove === "true";
    }
    if (opts.plan && opts.autoApprove === true) {
      fail("--plan conflicts with --auto-approve true; plan mode requires auto-approve false to prevent a switch to act mode");
    }
    if (opts.autoApprove === null) opts.autoApprove = !opts.plan;
    for (const flag of ["model", "provider"]) {
      if (opts[flag] !== null && !SAFE_VALUE.test(opts[flag])) {
        fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
      }
    }
  },
  readOnly: (opts) => opts.plan,
  tripwire,
  state: () => ({ actualProvider: null, actualModel: null, usage: null, finishReason: null, durationMs: null, text: null }),
  fields: (opts, state) => ({
    provider: opts.provider,
    model: opts.model,
    planMode: opts.plan,
    autoApprove: opts.autoApprove,
    actualProvider: state.actualProvider,
    actualModel: state.actualModel,
    usage: state.usage,
    finishReason: state.finishReason,
    durationMs: state.durationMs,
  }),
  // shell:true on win32 resolves the cline.cmd shim; cmd.exe then reports a
  // missing command as exit 9009 rather than ENOENT.
  version: () => ({ launch: { command: "cline", args: ["--version"], shell: IS_WIN }, missing: cmdShimMissing }),
  unavailableHint: "Install or add it to PATH, then re-dispatch.",
  launch(opts, brief) {
    // Current Cline JSON mode checks for a positional prompt before reading
    // piped input. Keep that positional fixed and stream the user brief on stdin.
    const args = ["--json", "-v", "--auto-approve", String(opts.autoApprove)];
    if (opts.provider) args.push("--provider", opts.provider);
    if (opts.model) args.push("--model", opts.model);
    if (opts.plan) args.push("--plan");
    // argv holds only fixed values plus token-validated --provider/--model, so
    // the one serialized shell line on win32 is safe; the brief and cwd never
    // reach cmd.exe.
    args.push(IS_WIN ? `"${STDIN_PROMPT}"` : STDIN_PROMPT);
    return { command: "cline", args, shell: IS_WIN, stdin: brief };
  },
  scanner: makeEventScanner,
  onEvent(event, state) {
    // run_start (verbose-only): requested model/provider.
    if (event.type === "run_start") {
      if (event.sessionId) state.sessionId = event.sessionId;
      const model = event.modelId ?? event.model;
      const provider = event.providerId ?? event.provider;
      if (typeof model === "string") state.actualModel = model;
      if (typeof provider === "string") state.actualProvider = provider;
    } else if (event.type === "run_result") {
      // The final event; finishReason "completed" is success.
      if (typeof event.finishReason === "string") state.finishReason = event.finishReason;
      if (typeof event.text === "string") state.text = event.text;
      if (event.usage && typeof event.usage === "object") state.usage = event.usage;
      if (typeof event.model === "string") state.actualModel = event.model;
      else if (event.model && typeof event.model.id === "string") state.actualModel = event.model.id;
      if (typeof event.durationMs === "number") state.durationMs = event.durationMs;
    } else if (event.type === "run_aborted" || event.type === "run_abort_requested") {
      state.finishReason = "aborted";
    }
  },
  // run_result.usage carries Cline's own camelCase counts.
  tokens: (state) => state.usage && {
    input: state.usage.inputTokens,
    output: state.usage.outputTokens,
  },
  final: (state) => state.text ?? "",
  verdict(state) {
    if (state.finishReason === null) return { error: "cline exited without a run_result event; inspect events.jsonl and stderr.txt" };
    if (state.finishReason !== "completed") return { error: `cline ended with finishReason "${state.finishReason}"` };
    return null;
  },
  summary(result) {
    const lines = [];
    if (result.planMode) lines.push("mode: plan-only (analysis, no edits)");
    if (result.actualModel) lines.push(`model: ${result.actualModel}${result.actualProvider ? ` (provider: ${result.actualProvider})` : ""}`);
    return lines;
  },
};

await runRelay(cline);
