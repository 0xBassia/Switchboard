/**
 * Delegit · delegit-warp · relay.mjs
 *
 * Dispatch a self-contained brief to the Warp Agent CLI (`oz agent run
 * --output-format ndjson`), capture the newline-delimited JSON event stream,
 * and write a structured result the orchestrating agent can review. The
 * orchestrator runs this one command and reads the result JSON — every
 * Warp-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `oz` and `git`. The `oz` process it launches
 * does authenticate — exactly as you do at the terminal. Read this file before
 * you run it.
 *
 * Brief delivery: `oz agent run` requires one of --prompt/--saved-prompt/
 * --task-id/--skill, and its -f/--file config path does NOT satisfy that
 * requirement, so the brief rides argv as the --prompt value. Two consequences
 * the other relays in this package do not have: the brief is visible in the
 * host process list while the run is live, and a very large brief can hit the
 * OS argv limit. Keep secrets out of the brief — reference workspace files or
 * environment variables instead — and on a shared machine prefer a short brief
 * that points `oz` at files in the repo. Because the brief rides argv, this
 * relay never launches `oz` through a shell.
 *
 * Workspace snapshots: `oz agent run` uploads an end-of-run workspace snapshot
 * by default. The relay does not change that default — it is the CLI's own
 * behavior — but --no-snapshot forwards Warp's flag when you do not want the
 * upload. Decide deliberately for private repositories.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * — after it reviews the diff and re-runs the project gates.
 *
 * Autonomy: `oz agent run` has NO sandbox, NO permission mode, and NO
 * read-only mode. A headless run reads, writes, edits, and executes commands
 * with the user's own permissions and never prompts. This relay therefore
 * offers no --read-only flag: there is nothing in the CLI to enforce it, and
 * advertising one would be a lie. (`--auto-approve` belongs to the interactive
 * `warp` TUI, not to `oz agent run`.) The diff reported in `touchedFiles` is
 * the record of what changed — inspect it after every run.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for oz (default: current directory).
 *   --lane <name>           Fleet lane from delegit-setup config (dials apply; explicit flags win).
 *   --model <id>            Warp model id (default: Warp's own). See `oz model list`.
 *   --profile <id>          Warp agent profile id.
 *   --name <name>           Label for the run (Warp's `--name`).
 *   --conversation <id>     Continue an existing Warp conversation; send only the delta brief.
 *   --skill <spec>          Warp skill used as the base prompt (`name`, `repo:name`, `org/repo:name`).
 *   --mcp <spec>            MCP server config path or inline JSON. Repeatable.
 *   --no-snapshot           Forward Warp's --no-snapshot (disable the end-of-run snapshot upload).
 *   --timeout <dur>         Relay-side watchdog (default: 30m). Durations use h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, ozVersion, runId, runUrl, conversationId,
 *   finalMessage (the agent's own report), model, touchedFiles (git porcelain,
 *   null if git cannot report), snapshotDisabled, and paths to brief.txt,
 *   final.txt, events.jsonl, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `oz` binary exits 127;
 * otherwise the exit code mirrors oz's own (0 success, non-zero failure),
 * except a stream-reported agent error exits 1 even if oz exits 0. If the child
 * dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal. Once the brief validates, `result.json` is
 * written on every outcome — completed, failed, timeout (the --timeout watchdog
 * fired, or the bounded --version preflight hung), aborted (the relay itself
 * was killed and forwarded the kill to oz), or warp_unavailable.
 */

import { fail } from "../core/cli.mjs";
import { runRelay } from "../core/relay.mjs";
import { makeEventScanner } from "../core/scan.mjs";

// Values that ride argv beside the brief. `oz` is launched without a shell, so
// the risk is not quoting but flag injection: a value starting with "-" would be
// read by oz as another option. Require a leading alphanumeric.
const OZ_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

// Warp exposes no read-only, sandbox, or permission-mode flag on `oz agent run`,
// so these lane dials cannot be honoured. Dropping one silently would run a lane
// the user believes is restricted, so refuse instead.
const UNSUPPORTED_DIALS = ["readOnly", "sandbox", "permissionMode", "force", "effort", "variant", "provider"];

// --skill, --mcp and --name legitimately carry characters the token rule rejects
// (an inline MCP JSON blob, a path). Only a leading "-" is dangerous.
const badLoose = (value) => value === "" || value.startsWith("-");

/**
 * Pull agent-visible text out of one ndjson event.
 *
 * The report is carried by `{"type":"agent","text":…}` events, and system events
 * are `type: "system"`. `agent_reasoning` events carry a `text` field of the SAME
 * shape but hold the model's private reasoning, not its report, so they are
 * dropped by type. Tool traffic carries no `text` and stays in events.jsonl.
 * Everything past that stays tolerant rather than pinned to `type === "agent"`,
 * so a renamed or added output event still reports instead of yielding an empty
 * finalMessage; events.jsonl always keeps the raw stream.
 */
function eventTexts(event) {
  if (event.type === "system" || event.type === "agent_reasoning") return [];
  const textParts = (content) => content.filter((part) => part && part.type === "text").map((part) => part.text);
  const message = event.message && typeof event.message === "object" ? event.message : {};
  for (const value of [event.agent_output, event.text]) if (typeof value === "string") return [value];
  for (const value of [event.content, message.content]) {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return textParts(value);
  }
  return [];
}

// The brief rides argv as the --prompt value: the OS caps one argv string (~128KB on Linux via
// MAX_ARG_STRLEN).
const MAX_BRIEF_BYTES = 120 * 1024;

const warp = {
  key: "warp",
  name: "oz",
  binary: "oz",
  versionField: "ozVersion",
  defaults: { timeout: "30m", model: null, profile: null, name: null, conversation: null, skill: null },
  flags: {
    "--model": { key: "model" },
    "--profile": { key: "profile" },
    "--name": { key: "name" },
    "--conversation": { key: "conversation" },
    "--skill": { key: "skill" },
    "--mcp": { key: "mcp", kind: "list" },
    "--no-snapshot": { key: "noSnapshot", kind: "bool" },
  },
  onDial(field, value, opts) {
    if (UNSUPPORTED_DIALS.includes(field)) {
      fail(`lane "${opts.lane}" sets the ${field} dial, which the Warp Agent CLI has no flag for; remove it from the lane or use a different implementer`);
    }
  },
  validate(opts) {
    for (const flag of ["model", "profile", "conversation"]) {
      if (opts[flag] !== null && !OZ_TOKEN.test(opts[flag])) {
        fail(`--${flag} value contains unsupported characters (allowed: letters, digits, . _ : / -)`);
      }
    }
    for (const [flag, values] of [["skill", opts.skill === null ? [] : [opts.skill]], ["mcp", opts.mcp]]) {
      if (values.some(badLoose)) fail(`--${flag} value must be non-empty and must not start with "-"`);
    }
    if (opts.name !== null && badLoose(opts.name)) fail('--name value must be non-empty and must not start with "-"');
  },
  maxBriefBytes: MAX_BRIEF_BYTES,
  briefTooLarge: (kb) => `brief is ${kb}KB; oz agent run takes the prompt as a CLI argument, which the OS caps. Trim it, or point oz at files in the workspace instead of inlining them.`,
  state: () => ({ runId: null, runUrl: null, conversationId: null, streamError: null, text: [] }),
  fields: (opts, state) => ({
    tool: "oz",
    model: opts.model,
    profile: opts.profile,
    snapshotDisabled: opts.noSnapshot,
    resumed: Boolean(opts.conversation),
    runId: state.runId,
    runUrl: state.runUrl,
    conversationId: state.conversationId,
  }),
  // `oz` installs as a native binary, so probe and dispatch both run without a
  // shell - the brief rides argv as the --prompt value and a shell would
  // reinterpret it.
  version: () => ({ launch: { command: "oz", args: ["--version"] } }),
  unavailableHint: "Install the Warp Agent CLI (https://docs.warp.dev/cli/), then authenticate with `oz login` (or set WARP_API_KEY on a headless host).",
  launch(opts, brief) {
    // ndjson streams one event per line. `oz agent run` requires one of
    // --prompt/--saved-prompt/--task-id/--skill, and -f/--file does not satisfy it.
    const args = ["agent", "run", "--output-format", "ndjson", "--cwd", opts.cd];
    if (opts.model) args.push("--model", opts.model);
    if (opts.profile) args.push("--profile", opts.profile);
    if (opts.name) args.push("--name", opts.name);
    if (opts.conversation) args.push("--conversation", opts.conversation);
    if (opts.skill) args.push("--skill", opts.skill);
    for (const spec of opts.mcp) args.push("--mcp", spec);
    if (opts.noSnapshot) args.push("--no-snapshot");
    args.push("--prompt", brief);
    return { command: "oz", args };
  },
  scanner: makeEventScanner,
  onEvent(event, state) {
    if (!event || typeof event !== "object") return;
    if (typeof event.run_id === "string") state.runId = event.run_id;
    if (typeof event.run_url === "string") state.runUrl = event.run_url;
    if (typeof event.conversation_id === "string") state.conversationId = event.conversation_id;
    if (event.type === "error" || event.event_type === "run_failed") {
      const detail = typeof event.message === "string" ? event.message : typeof event.error === "string" ? event.error : null;
      state.streamError = detail || `oz reported ${event.event_type || event.type}`;
    }
    for (const text of eventTexts(event)) if (typeof text === "string" && text.trim()) state.text.push(text);
  },
  final: (state) => state.text.join("\n\n"),
  verdict: (state) => (state.streamError ? { error: state.streamError } : null),
  summary(result) {
    const lines = ["mode: full local tool access — the Warp Agent CLI has no sandbox, permission mode, or read-only run"];
    if (result.snapshotDisabled) lines.push("mode: end-of-run workspace snapshot upload disabled (--no-snapshot)");
    if (result.model) lines.push(`model: ${result.model}`);
    if (result.conversationId) lines.push(`conversation id (continue with: --conversation ${result.conversationId}): ${result.conversationId}`);
    if (result.runId) lines.push(`run id: ${result.runId}`);
    if (result.runUrl) lines.push(`run url: ${result.runUrl}`);
    return lines;
  },
  emptyReport: "(no final message captured — read events.jsonl for the raw stream)",
};

await runRelay(warp);
