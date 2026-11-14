/**
 * Switchboard · switchboard-codex · relay.mjs
 *
 * Dispatch a self-contained brief to the OpenAI Codex CLI (`codex exec`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every Codex-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified on Claude Code; other shell-capable agents
 * (OpenCode, Cursor, …) are designed-for but not yet verified.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `codex` and `git`. The `codex` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * It deliberately does NOT commit. Whether Codex's sandbox can write `.git`
 * varies by Codex version, OS, and execution path, so committing is always the
 * orchestrator's job — after it reviews the diff and re-runs the project gates.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Codex (default: current directory).
 *   --lane <name>           Fleet lane from switchboard-setup config (dials apply; explicit flags win).
 *   --model <name>          Codex model (default: Codex's own configured default).
 *   --effort <level>        Reasoning effort, passed to Codex as
 *                           `-c model_reasoning_effort=<level>` (default: Codex's
 *                           own configured default).
 *   --subagent-model <name> Default model for subagents Codex spawns during the run,
 *                           passed as `-c agents.default_subagent_model=<name>`.
 *   --subagent-effort <level>
 *                           Default reasoning effort for those subagents, passed as
 *                           `-c agents.default_subagent_reasoning_effort=<level>`.
 *                           Without either, subagents follow Codex's own config. A model
 *                           TOML reads as a number (e.g. 5.5) fails at startup; an
 *                           unknown model or unsupported effort fails only the spawn, so
 *                           the run can still exit 0. Pass them again on every resume:
 *                           Codex does not carry them over.
 *   --web-search <mode>     Codex's web search mode, passed as `-c web_search=<mode>`
 *                           (Codex's modes: disabled | cached | indexed | live; default:
 *                           Codex's own configured default). Search is a hosted tool, so
 *                           it works under every sandbox, read-only included. Pass it
 *                           again on every resume: Codex does not carry it over.
 *   --network-access        Allow network access inside the workspace-write sandbox, passed
 *                           to Codex as `-c sandbox_workspace_write.network_access=true`.
 *                           Pass it again on every resume, with the sandbox named by
 *                           --sandbox or a fleet lane: Codex does not carry it over.
 *                           Rejected with a read-only sandbox, which Codex keeps offline.
 *   --sandbox <mode>        read-only | workspace-write | danger-full-access
 *                           (default: workspace-write).
 *   --read-only             Shortcut for --sandbox read-only (review/diagnosis, no edits).
 *   --resume-last           Continue the most recent Codex session; send only the delta brief.
 *                           An explicit --sandbox/--read-only override applies to the resumed turn.
 *   --session <id>          Continue a specific Codex session by thread id (from a prior
 *                           result.json). Safer than --resume-last when other Codex runs
 *                           may have happened since - "last" is global, not per-repo.
 *                           Mutually exclusive with --resume-last.
 *   --clean-env             Launch Codex and its version preflight with only runtime basics.
 *                           Changes inherited variables only; does not protect files or other
 *                           same-user secrets.
 *   --ignore-user-config    Do not load Codex user config. Authentication still uses CODEX_HOME;
 *                           useful for isolated reviews that must not start ambient MCP servers.
 *   --keep-env <name>       Keep one additional variable under --clean-env (repeatable).
 *                           Required for environment-backed auth and other stripped variables.
 *   --skip-git-repo-check   Allow running outside a git repository.
 *   --timeout <dur>         Relay-side watchdog (default: off). Durations use h/m/s
 *                           strings like 30m or 2h. On expiry the codex child is killed
 *                           and result.json gets status "timeout". Codex has no timeout
 *                           flag of its own, so the watchdog is relay-only.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, codexVersion, threadId (for a later resume), finalMessage
 *   (Codex's own report), touchedFiles (git porcelain, null if git can't report), stderrTail on a
 *   run that did not succeed, and the paths to events.jsonl, final.txt and stderr.txt. stderr.txt
 *   holds the complete stderr stream; stderrTail is up to 20 nonblank lines from its final
 *   64 KiB, with a partial first line marked as truncated.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `codex` binary exits 127;
 * otherwise the exit code mirrors Codex's own (0 success, non-zero failure).
 * If the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, timeout (the --timeout watchdog fired), aborted (the relay
 * itself was killed and forwarded the kill to codex), or codex_unavailable. An
 * orchestrator that polls for the file must therefore also treat a non-zero exit
 * with no file as a usage error.
 */

import { existsSync, readFileSync } from "node:fs";
import { exclusive, fail } from "../core/cli.mjs";
import { runRelay } from "../core/relay.mjs";
import { makeLineScanner } from "../core/scan.mjs";
import { tripwire } from "../core/tripwire.mjs";

const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Model rides argv; a plain token cannot pass for a flag. Same family as pi. Keep in
// lockstep with switchboard-setup MODEL_TOKEN.shellSafe.
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
// Effort and web search modes are Codex-owned enums that vary by version; the relay
// checks only for a bare token.
const BARE_TOKEN = /^[a-z][a-z0-9-]*$/i;
const KEEP_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
  "TMPDIR", "CODEX_HOME", "TEMP", "TMP"];

function codexEnv(opts) {
  const env = opts.cleanEnv
    ? Object.fromEntries([...KEEP_ENV, ...opts.keepEnv].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]))
    : { ...process.env };
  if (opts.cleanEnv) {
    // The relay's own hardening survives a clean environment: core.fsmonitor stays off
    // (GIT_CONFIG_*).
    for (const key of Object.keys(process.env)) {
      if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) env[key] = process.env[key];
    }
  }
  return env;
}

function codexArgs(opts, finalPath) {
  const args = ["exec"];
  if (opts.ignoreUserConfig) args.push("--ignore-user-config");
  const resuming = Boolean(opts.session || opts.resumeLast);
  // Codex accepts shared exec options before the resume subcommand. Reapply only
  // an explicitly selected sandbox; otherwise leave the active Codex config alone.
  if (resuming && opts.sandboxConfigured) args.push("-s", opts.sandbox);
  if (opts.session) args.push("resume", opts.session);
  else if (opts.resumeLast) args.push("resume", "--last");
  args.push("--json", "-o", finalPath);
  if (!resuming) args.push("-s", opts.sandbox);
  if (opts.model) args.push("-m", opts.model);
  // `-c` is accepted by the resume subcommand, so these overrides apply to fresh and
  // resumed runs alike. Keep every `-c` after `resume`: once one follows it, Codex
  // drops any placed before it.
  const overrides = [
    [opts.effort !== null, `model_reasoning_effort=${opts.effort}`],
    [opts.subagentModel !== null, `agents.default_subagent_model=${opts.subagentModel}`],
    [opts.subagentEffort !== null, `agents.default_subagent_reasoning_effort=${opts.subagentEffort}`],
    [opts.webSearch !== null, `web_search=${opts.webSearch}`],
    [opts.networkAccess, "sandbox_workspace_write.network_access=true"],
  ];
  for (const [enabled, override] of overrides) if (enabled) args.push("-c", override);
  if (opts.skipGitRepoCheck) args.push("--skip-git-repo-check");
  args.push("-"); // read the prompt from stdin
  return args;
}

const threadId = (event) => event.thread_id ?? event.threadId ?? (event.thread && (event.thread.thread_id ?? event.thread.id)) ?? null;

const codex = {
  key: "codex",
  name: "Codex",
  versionField: "codexVersion",
  defaults: {
    model: null,
    effort: null,
    subagentModel: null,
    subagentEffort: null,
    webSearch: null,
    sandbox: "workspace-write",
    sandboxConfigured: false,
    session: null,
  },
  flags: {
    "--model": { key: "model" },
    "--effort": { key: "effort" },
    "--subagent-model": { key: "subagentModel" },
    "--subagent-effort": { key: "subagentEffort" },
    "--web-search": { key: "webSearch" },
    "--network-access": { key: "networkAccess", kind: "bool" },
    "--sandbox": { key: "sandbox" },
    "--read-only": { key: "readOnly", kind: "bool" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--session": { key: "session" },
    "--clean-env": { key: "cleanEnv", kind: "bool" },
    "--ignore-user-config": { key: "ignoreUserConfig", kind: "bool" },
    "--keep-env": { key: "keepEnv", kind: "list" },
    "--skip-git-repo-check": { key: "skipGitRepoCheck", kind: "bool" },
  },
  onDial(field, value, opts) {
    if (field === "sandbox") opts.sandboxConfigured = true;
  },
  validate(opts, flagged) {
    // --read-only is a shortcut for --sandbox read-only; an explicit contradiction is a usage
    // error, not a silent downgrade of the caller's sandbox choice.
    if (opts.readOnly && flagged.has("sandbox") && opts.sandbox !== "read-only") {
      fail(`--read-only and --sandbox ${opts.sandbox} are mutually exclusive; pass only one`);
    }
    if (opts.readOnly) opts.sandbox = "read-only";
    if (flagged.has("sandbox") || flagged.has("readOnly")) opts.sandboxConfigured = true;
    if (!SANDBOX_MODES.includes(opts.sandbox)) {
      fail(`invalid --sandbox "${opts.sandbox}" (expected: ${SANDBOX_MODES.join(", ")})`);
    }
    // Codex ignores the workspace-write network key under read-only and the run stays
    // offline without a word, so refuse the pair rather than record access that never happened.
    if (opts.networkAccess && opts.sandbox === "read-only") {
      fail("--network-access cannot be combined with a read-only sandbox: Codex keeps read-only offline");
    }
    // An unqualified resume runs under Codex's configured sandbox, which may be read-only
    // and drop the override without a word; require the sandbox named so the record holds.
    if (opts.networkAccess && (opts.session || opts.resumeLast) && !opts.sandboxConfigured) {
      fail("--network-access on a resumed run needs the sandbox named by --sandbox (e.g. --sandbox workspace-write) or a fleet lane");
    }
    for (const [flag, value] of [["--effort", opts.effort], ["--web-search", opts.webSearch]]) {
      if (value !== null && !BARE_TOKEN.test(value)) fail(`invalid ${flag} "${value}" (expected a non-empty bare token)`);
    }
    for (const [flag, value] of [["--model", opts.model], ["--subagent-model", opts.subagentModel]]) {
      if (value !== null && !SAFE_MODEL.test(value)) fail(`${flag} contains unsupported characters (allowed: letters, digits, . _ : / -)`);
    }
    if (opts.subagentEffort !== null && !BARE_TOKEN.test(opts.subagentEffort)) {
      fail(`invalid --subagent-effort "${opts.subagentEffort}" (expected a non-empty bare token)`);
    }
    if (opts.keepEnv.length && !opts.cleanEnv) fail("--keep-env requires --clean-env");
    const badName = opts.keepEnv.find((name) => !SAFE_ENV_NAME.test(name));
    if (badName) fail(`invalid --keep-env "${badName}" (expected an environment variable name)`);
    const unset = opts.keepEnv.find((name) => process.env[name] === undefined);
    if (unset) fail(`--keep-env "${unset}" is not set`);
    exclusive(opts, [["session", "resumeLast", "--session and --resume-last are mutually exclusive; pass only one"]]);
    if (opts.session !== null && !SAFE_SESSION.test(opts.session)) {
      fail("--session must be a shell-safe thread id (letters, digits, . _ : -)");
    }
  },
  readOnly: (opts) => opts.sandbox === "read-only",
  tripwire,
  fields: (opts, state) => ({
    sandbox: !(opts.session || opts.resumeLast) || opts.sandboxConfigured ? opts.sandbox : "(Codex config on resume)",
    model: opts.model,
    effort: opts.effort,
    subagentModel: opts.subagentModel,
    subagentEffort: opts.subagentEffort,
    webSearch: opts.webSearch,
    networkAccess: opts.networkAccess,
    resumeLast: opts.resumeLast,
    session: opts.session,
    cleanEnv: opts.cleanEnv,
    ignoreUserConfig: opts.ignoreUserConfig,
    keepEnv: opts.keepEnv,
    threadId: state.sessionId,
  }),
  version: (opts) => ({
    launch: { command: "codex", args: ["--version"], env: codexEnv(opts) },
  }),
  binary: "codex",
  unavailableHint: "Install it (npm i -g @openai/codex) and run `codex login`.",
  prepare: (opts, run, state) => { state.finalPath = run.finalPath; },
  // The brief goes through stdin, never argv, and no shell runs.
  launch: (opts, brief, run) => ({
    command: "codex",
    args: codexArgs(opts, run.finalPath),
    env: codexEnv(opts),
    stdin: brief,
  }),
  scanner: makeLineScanner,
  onEvent(event, state) {
    const id = event && typeof event === "object" ? threadId(event) : null;
    if (id) state.sessionId = id;
  },
  // Codex writes its own report to the -o file.
  finalByImplementer: true,
  final: (state) => (state.finalPath && existsSync(state.finalPath) ? readFileSync(state.finalPath, "utf8").trim() : ""),
  summary(result) {
    if (result.resumeLast) return ["mode: resumed most recent session"];
    return result.session ? [`mode: resumed session ${result.session}`] : [];
  },
};

await runRelay(codex);
