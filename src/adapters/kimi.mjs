/**
 * Switchboard · kimi-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Kimi Code CLI (`kimi -p`), capture
 * the run, and write a structured result the orchestrating agent can review.
 * The orchestrator runs this one command and reads the result JSON - every
 * Kimi-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified against kimi CLI 0.24.0 on macOS.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `kimi` and `git`. The `kimi` process it launches
 * does authenticate - exactly as you do at the terminal. Read this file before
 * you run it.
 *
 * Note: `kimi -p` takes the prompt as a command-line argument, so the brief is
 * visible in the host process list (`ps`, /proc). On a shared machine keep
 * secrets out of the brief - reference them by a path or environment variable
 * the workspace can read.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * - after it reviews the diff and re-runs the project gates.
 *
 * Headless `-p` mode always uses Kimi's auto permission mode. Kimi rejects
 * `--yolo`, `--auto`, and `--plan` when combined with `--prompt`, so this relay
 * passes no autonomy flags and offers no read-only mode. The diff reported in
 * `touchedFiles`, not a flag, is the guarantee of what changed.
 *
 * Kimi's supported Homebrew and official-installer distributions provide a
 * native binary on every platform. The npm-installed `kimi` on Windows is a
 * `.cmd` shim this relay does not launch; use the native install there.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for Kimi (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <alias>         Kimi model alias (default: Kimi's own default_model).
 *   --session <id>          Resume a specific Kimi session; send only the delta brief.
 *   --resume-last           Resume the most recent Kimi session for this cwd;
 *                           send only the delta brief.
 *   --add-dir <dir>         Add an extra workspace directory. Repeatable.
 *   --timeout <dur>         Relay-side watchdog (default: 30m). Kimi has no
 *                           timeout flag; durations use h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout -
 *   status, exitCode, signal, kimiVersion, sessionId, finalMessage (Kimi's own
 *   report), touchedFiles (git porcelain, null if git cannot report), and paths
 *   to brief.txt, final.txt, events.jsonl, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `kimi` binary exits 127;
 * otherwise the exit code mirrors Kimi's own (0 success, non-zero failure). If
 * the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal. Once the brief validates, `result.json` is
 * written on every outcome - completed, failed, timeout (the --timeout watchdog
 * fired), aborted (the relay itself was killed and forwarded the kill to kimi),
 * or kimi_unavailable.
 */

import { exclusive } from "../core/cli.mjs";
import { runRelay } from "../core/relay.mjs";
import { makeEventScanner } from "../core/scan.mjs";
import { resolve } from "node:path";

// The OS caps one argv string (~128KB on Linux via MAX_ARG_STRLEN; Windows caps the whole
// command line at 32K characters), and kimi takes the brief as an argument.
const MAX_BRIEF_BYTES = (process.platform === "win32" ? 12 : 120) * 1024;

const kimi = {
  key: "kimi",
  versionField: "kimiVersion",
  defaults: { timeout: "30m", model: null, session: null },
  flags: {
    "--model": { key: "model" },
    "--session": { key: "session" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--add-dir": { key: "addDirs", kind: "list" },
  },
  validate(opts) {
    exclusive(opts, [["resumeLast", "session", "--resume-last and --session are mutually exclusive; pass only one"]]);
    // kimi resolves a relative --add-dir against ITS cwd, so resolve against
    // --cd, which may appear after --add-dir on the command line.
    opts.addDirs = opts.addDirs.map((dir) => resolve(opts.cd, dir));
  },
  maxBriefBytes: MAX_BRIEF_BYTES,
  briefTooLarge: (kb) => `brief is ${kb}KB; kimi passes the prompt as a CLI argument, which the OS caps (~128KB on Linux, 32K characters for the whole command line on Windows). Trim it, or have kimi read large context from the workspace instead of inlining it.`,
  state: () => ({ text: [] }),
  fields: (opts) => ({
    model: opts.model,
    resumed: Boolean(opts.resumeLast || opts.session),
  }),
  version: () => ({ launch: { command: "kimi", args: ["--version"] } }),
  unavailableHint: "Install Kimi Code and run `kimi login`.",
  launch(opts, brief) {
    const args = ["--output-format", "stream-json"];
    if (opts.model) args.push("-m", opts.model);
    if (opts.session) args.push("--session", opts.session);
    else if (opts.resumeLast) args.push("--continue");
    for (const dir of opts.addDirs) args.push("--add-dir", dir);
    // --prompt=<brief>, not ["--prompt", brief]: the equals form binds a brief
    // that starts with "-" instead of letting it parse as a flag.
    args.push(`--prompt=${brief}`);
    return { command: "kimi", args };
  },
  scanner: makeEventScanner,
  onEvent(event, state) {
    if (event.role === "assistant" && typeof event.content === "string") state.text.push(event.content);
    if (event.role === "meta" && event.type === "session.resume_hint" && typeof event.session_id === "string") {
      state.sessionId = event.session_id;
    }
  },
  final: (state) => state.text.join("\n\n"),
};

await runRelay(kimi);
