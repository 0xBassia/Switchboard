/**
 * Switchboard · muse-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to Muse Code (`muse exec`), capture the run,
 * and write a structured result the orchestrating agent can review. The
 * orchestrator runs this one command and reads the result JSON — every
 * Muse-specific mechanic lives in here.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `muse` and `git`. The `muse` process it launches
 * does authenticate — exactly as you do at the terminal. Read this file before
 * you run it.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job —
 * after it reviews the diff and re-runs the project gates.
 *
 * Headless Muse is `muse exec` only. `muse resume` is the interactive TUI and is
 * never invoked. Write runs keep Muse's sandbox on and pass `--disable-approval`
 * so a headless run cannot hang on a tool-approval prompt. `--read-only` adds
 * `--disable-write` (non-shell filesystem writes) and `--disable-shell`.
 * `--yolo` is not the default and is not exposed.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Muse (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Muse model id (optional; Muse's own default applies).
 *   --effort <level>        Passed as --reasoning-effort: none|minimal|low|medium|high|xhigh|max|ultra.
 *   --provider <mode>       Relay-only: echo | meta. Omit to use Muse's default (meta). Not a fleet dial.
 *   --read-only             Add --disable-write and --disable-shell (keep --disable-approval).
 *   --session <id>          Continue a specific session via --session-id; send only the delta brief.
 *   --resume-last           Rejected: muse resume --last is TUI-only. Use --session <id>.
 *   --timeout <dur>         Relay-side watchdog (default: off). Durations use h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under system temp).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, museVersion, sessionId, finalMessage (from
 *   run.terminal.completed), touchedFiles, stderrTail on a run that did not
 *   succeed, and paths to events.jsonl, final.txt and stderr.txt. stderr.txt
 *   holds the complete stderr stream; stderrTail is up to 20 nonblank lines
 *   from its final 64 KiB, with a partial first line marked as truncated.
 *
 * Exit codes: a pre-run usage error exits 2 before any run and writes no result
 * file; a missing `muse` binary exits 127; otherwise the exit code mirrors Muse's
 * own except a zero child exit without run.terminal.completed is reported failed.
 * Once the brief validates, result.json is written on every outcome —
 * completed, failed, timeout, aborted, or muse_unavailable.
 */

import { fail } from "../core/cli.mjs";
import { runRelay } from "../core/relay.mjs";
import { makeLineScanner } from "../core/scan.mjs";
import { tripwire } from "../core/tripwire.mjs";

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const PROVIDERS = ["echo", "meta"];

const muse = {
  key: "muse",
  versionField: "museVersion",
  flags: {
    "--model": { key: "model" },
    "--effort": { key: "effort" },
    "--provider": { key: "provider" },
    "--read-only": { key: "readOnly", kind: "bool" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--session": { key: "session" },
  },
  defaults: { model: null, effort: null, provider: null, session: null },
  validate(opts) {
    if (opts.resumeLast) fail("muse resume --last is TUI-only; headless resume is --session <id>");
    if (opts.model !== null && !SAFE_MODEL.test(opts.model)) {
      fail("--model contains unsupported characters (allowed: letters, digits, . _ : / -)");
    }
    if (opts.effort !== null && !EFFORTS.includes(opts.effort)) {
      fail(`invalid --effort "${opts.effort}" (expected: ${EFFORTS.join(", ")})`);
    }
    if (opts.provider !== null && !PROVIDERS.includes(opts.provider)) {
      fail(`invalid --provider "${opts.provider}" (expected: echo or meta)`);
    }
    if (opts.session !== null && !SAFE_SESSION.test(opts.session)) {
      fail("--session must be a shell-safe session id (letters, digits, . _ : -)");
    }
  },
  readOnly: (opts) => opts.readOnly,
  tripwire,
  state: (opts) => ({ sessionId: opts.session, finalMessage: "", sawTerminal: false, terminalOk: false }),
  fields: (opts) => ({
    model: opts.model,
    effort: opts.effort,
    provider: opts.provider,
    readOnly: opts.readOnly,
    resumed: Boolean(opts.session),
  }),
  binary: "muse",
  unavailableHint: "Install Muse Code and run `muse login`.",
  version: () => ({ launch: { command: "muse", args: ["--version"] } }),
  // The brief goes in a prompt file and --workspace is an argv value: no shell.
  launch(opts, brief, run) {
    const args = [
      "exec", "--json",
      "--prompt-file", run.briefPath,
      "--disable-approval", "--trust-workspace",
      "--workspace", opts.cd,
      "--user-input-auto-resolve",
    ];
    if (opts.readOnly) args.push("--disable-write", "--disable-shell");
    if (opts.session) args.push("--session-id", opts.session);
    if (opts.provider) args.push("--provider", opts.provider);
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--reasoning-effort", opts.effort);
    return { command: "muse", args, env: { ...process.env, PWD: opts.cd } };
  },
  scanner: makeLineScanner,
  onEvent(event, state) {
    if (!event || typeof event !== "object") return;
    const { stream, payload_type: type } = event;
    if (stream && stream.kind === "session" && typeof stream.id === "string" && stream.id) {
      state.sessionId = stream.id;
    }
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    if (type !== "run.terminal.completed" && payload.kind !== "run_terminal") return;
    state.sawTerminal = true;
    if (typeof payload.text === "string") state.finalMessage = payload.text;
    state.terminalOk = payload.terminal == null || payload.terminal === "completed";
  },
  final: (state) => state.finalMessage.trim(),
  verdict(state, { code }) {
    if (code !== 0) return {};
    if (!state.sawTerminal) return { error: "muse exited 0 without a run.terminal.completed event" };
    if (!state.terminalOk) return { error: "muse reported a run.terminal event that was not completed" };
    return {};
  },
};

await runRelay(muse);
