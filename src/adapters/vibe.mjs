/**
 * Switchboard · vibe-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Mistral Vibe CLI (`vibe --prompt`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Vibe-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `vibe`, `git`, and Windows `taskkill` for
 * process-tree termination. The `vibe` process it launches does authenticate —
 * exactly as you do at the terminal. Read this file before you run it.
 *
 * Note: `vibe --prompt` takes the prompt as a command-line argument, so the
 * brief is visible in the host process list (`ps`, /proc). On a shared machine
 * keep secrets out of the brief — reference them by a path or environment
 * variable the workspace can read.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * — after it reviews the diff and re-runs the project gates.
 *
 * Default mode uses Vibe's `accept-edits` agent, which auto-approves its
 * built-in file edits while other tools remain unapproved in headless mode.
 * `--full-access` explicitly opts into `auto-approve`; `--plan-only` selects
 * Vibe's read-only `plan` agent.
 *
 * Upstream Vibe works on Windows but officially supports and targets UNIX. This
 * repository has not smoke-tested the relay's native Windows launch.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>           Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>               Working root for Vibe (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --max-turns <n>          Maximum number of Vibe agent turns (--max-turns).
 *   --max-price <usd>        Indicative cost threshold in USD (--max-price);
 *                            not a hard budget.
 *   --max-tokens <n>         Maximum cumulative session tokens (--max-tokens).
 *   --session <id>           Resume a specific Vibe session (--resume SESSION_ID);
 *                            send only the delta brief.
 *   --resume-last            Resume the most recent Vibe session (--continue);
 *                            send only the delta brief.
 *   --plan-only              Use Vibe's read-only plan agent.
 *   --full-access            Use Vibe's auto-approve agent; all tool executions
 *                            are approved. Mutually exclusive with --plan-only.
 *   --enabled-tools <tool>   Enable only this tool (--enabled-tools). Repeatable.
 *   --disabled-tools <tool>  Disable this tool (--disabled-tools). Repeatable.
 *   --timeout <dur>          Relay-side watchdog (default: 30m). Vibe has no
 *                            timeout flag; durations use h/m/s strings.
 *   --out-dir <dir>          Where to write run artifacts (default: a fresh dir
 *                            under the system temp dir).
 *   -h, --help               Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, vibeVersion, agent, finalMessage (the last
 *   assistant message), touchedFiles (git porcelain, null if git cannot report),
 *   and paths to brief.txt, final.txt, events.jsonl, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `vibe` binary exits 127;
 * otherwise the exit code mirrors Vibe's own (0 success, non-zero failure). If
 * the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal. Once the run artifacts are prepared,
 * `result.json` is written on every outcome — completed, failed, timeout, aborted, or
 * vibe_unavailable.
 */

import { fail } from "../core/cli.mjs";
import { runRelay } from "../core/relay.mjs";
import { makeLineScanner } from "../core/scan.mjs";
import { tripwire } from "../core/tripwire.mjs";

// vibe takes the brief as an argv value; the OS caps one argument.
const MAX_BRIEF_BYTES = (process.platform === "win32" ? 12 : 120) * 1024;

const agentName = (opts) => (opts.planOnly ? "plan" : opts.fullAccess ? "auto-approve" : "accept-edits");

function positiveInt(opts, key, flag) {
  const raw = opts[key];
  if (raw === null) return;
  const n = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(n)) fail(`${flag} must be a positive safe integer; got: ${raw}`);
  opts[key] = n;
}

const vibe = {
  key: "vibe",
  versionField: "vibeVersion",
  flags: {
    "--max-turns": { key: "maxTurns" },
    "--max-price": { key: "maxPrice" },
    "--max-tokens": { key: "maxTokens" },
    "--session": { key: "session" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--plan-only": { key: "planOnly", kind: "bool" },
    "--full-access": { key: "fullAccess", kind: "bool" },
    "--enabled-tools": { key: "enabledTools", kind: "list" },
    "--disabled-tools": { key: "disabledTools", kind: "list" },
  },
  defaults: { timeout: "30m", maxTurns: null, maxPrice: null, maxTokens: null, session: null },
  // Explicit access flags settle the agent, so they also beat the lane's dials.
  laneConflicts: {
    planOnly: ["planOnly", "readOnly", "fullAccess"],
    readOnly: ["readOnly", "planOnly", "fullAccess"],
  },
  validate(opts) {
    positiveInt(opts, "maxTurns", "--max-turns");
    if (opts.maxPrice !== null) {
      const n = Number(opts.maxPrice);
      if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(opts.maxPrice) || !Number.isFinite(n) || n <= 0) {
        fail(`--max-price must be a positive decimal number; got: ${opts.maxPrice}`);
      }
      opts.maxPrice = n;
    }
    positiveInt(opts, "maxTokens", "--max-tokens");
    if (opts.resumeLast && opts.session) fail("--resume-last and --session are mutually exclusive; pass only one");
    if (opts.session !== null && !opts.session.trim()) fail("--session must not be empty");
    if (opts.planOnly && opts.fullAccess) fail("--plan-only and --full-access are mutually exclusive");
    if (opts.enabledTools.some((tool) => !tool.trim())) fail("--enabled-tools must not be empty");
    if (opts.disabledTools.some((tool) => !tool.trim())) fail("--disabled-tools must not be empty");
  },
  checkBrief(brief) {
    if (brief.includes("\0")) fail("brief contains a NUL byte, which cannot be passed in --prompt");
  },
  maxBriefBytes: MAX_BRIEF_BYTES,
  briefTooLarge: (kb) => `brief is ${kb}KB; keep large context in workspace files instead of argv`,
  readOnly: (opts) => agentName(opts) === "plan",
  tripwire,
  state: () => ({ text: [] }),
  fields: (opts) => ({
    agent: agentName(opts),
    maxTurns: opts.maxTurns,
    maxPrice: opts.maxPrice,
    maxTokens: opts.maxTokens,
    resumed: Boolean(opts.resumeLast || opts.session),
  }),
  binary: "vibe",
  unavailableHint: "Install `uv`, run `uv tool install mistral-vibe`, and configure MISTRAL_API_KEY.",
  version: () => ({ launch: { command: "vibe", args: ["--version"] } }),
  launch(opts, brief) {
    const args = ["--output", "streaming", "--agent", agentName(opts), "--trust"];
    if (opts.maxTurns != null) args.push("--max-turns", String(opts.maxTurns));
    if (opts.maxPrice != null) args.push("--max-price", String(opts.maxPrice));
    if (opts.maxTokens != null) args.push("--max-tokens", String(opts.maxTokens));
    if (opts.session) args.push("--resume", opts.session);
    else if (opts.resumeLast) args.push("--continue");
    for (const tool of opts.enabledTools) args.push("--enabled-tools", tool);
    for (const tool of opts.disabledTools) args.push("--disabled-tools", tool);
    // --prompt=<brief> binds a brief that starts with "-" instead of parsing it as a flag.
    args.push(`--prompt=${brief}`);
    return { command: "vibe", args };
  },
  scanner: makeLineScanner,
  onEvent(event, state) {
    if (!event || typeof event !== "object" || event.role !== "assistant") return;
    const { content } = event;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((c) => c && c.type === "text").map((c) => (typeof c.text === "string" ? c.text : "")).join("")
        : "";
    if (text) state.text.push(text);
  },
  final: (state) => state.text.at(-1) || "",
};

await runRelay(vibe);
