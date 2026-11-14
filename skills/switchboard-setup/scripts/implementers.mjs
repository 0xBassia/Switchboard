/**
 * Canonical implementer registry for switchboard-setup.
 *
 * One table: skill key → binary, launch hints, supported lane dials, probes.
 * Consumed by discover.mjs and config.mjs. Relays will share this in Phase 2.
 *
 * `usageProbe.path` walks down from the CLI's state directory to the folders that
 * hold session entries ("*" matches any directory at that level); `entry` + `match`
 * say which names count as one session. Session files hold the user's conversations,
 * so these are listed and stat'd only — never opened.
 *
 * Node built-ins only. No network, credentials, or telemetry.
 */

/** @typedef {"model"|"effort"|"variant"|"timeout"|"readOnly"|"sandbox"|"force"|"provider"} Dial */

/**
 * @type {readonly {
 *   key: string,
 *   skill: string,
 *   binary: string,
 *   versionArgs: string[],
 *   versionFallbackArgs?: string[],
 *   versionFormat?: "colon-prefix",
 *   authProbe: null | {
 *     args: string[],
 *     jsonField?: string,
 *     successPattern?: RegExp,
 *     failPattern?: RegExp,
 *     missMeansFalse?: boolean,
 *   },
 *   modelProbe: null
 *     | { args: string[], format: "lines"|"cursor"|"table" }
 *     | { envDir: string, homeSubdir: string, file: string, format: "codex-cache" }
 *     | { static: readonly string[] },
 *   usageProbe: null | {
 *     envDir?: string,
 *     envSubdir?: string,
 *     homeSubdir: string,
 *     path: readonly string[],
 *     entry: "file"|"dir"|"any",
 *     match: RegExp,
 *   },
 *   supports: Dial[],
 * }[]}
 */
export const IMPLEMENTERS = Object.freeze([
  {
    key: "claude",
    skill: "switchboard-claude",
    binary: "claude",
    versionArgs: ["--version"],
    authProbe: { args: ["auth", "status"], jsonField: "loggedIn" },
    // No listing command; `--model` takes one of these aliases or a full model name.
    modelProbe: { static: ["fable", "opus", "sonnet", "haiku"] },
    // <config>/projects/<project-slug>/<session-uuid>.jsonl — one file per session.
    usageProbe: {
      envDir: "CLAUDE_CONFIG_DIR",
      homeSubdir: ".claude",
      path: ["projects", "*"],
      entry: "file",
      match: /\.jsonl$/,
    },
    supports: ["model", "effort", "timeout", "readOnly"],
  },
  {
    key: "codex",
    skill: "switchboard-codex",
    binary: "codex",
    versionArgs: ["--version"],
    // codex writes login status to stderr, not stdout.
    authProbe: {
      args: ["login", "status"],
      successPattern: /logged in/i,
      failPattern: /not logged in/i,
    },
    // Never spawn `codex models`: the positional word is read as a prompt and hits the API.
    // The locally cached catalog is the only offline listing.
    modelProbe: {
      envDir: "CODEX_HOME",
      homeSubdir: ".codex",
      file: "models_cache.json",
      format: "codex-cache",
    },
    // sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl. archived_sessions is a second
    // store of the same shape; counting only live rollouts keeps one meaning per number.
    usageProbe: {
      envDir: "CODEX_HOME",
      homeSubdir: ".codex",
      path: ["sessions", "*", "*", "*"],
      entry: "file",
      match: /^rollout-.*\.jsonl$/,
    },
    supports: ["model", "effort", "sandbox", "timeout", "readOnly"],
  },
  {
    key: "opencode",
    skill: "switchboard-opencode",
    binary: "opencode",
    versionArgs: ["--version"],
    // Exits 0 with an empty list too; a "●" row is the only auth signal, so a clean run
    // without one is the logged-out state, not an ambiguous miss.
    authProbe: { args: ["auth", "list"], successPattern: /^●\s/m, missMeansFalse: true },
    modelProbe: { args: ["models"], format: "lines" },
    // No usage probe: the session files under ~/.local/share/opencode/storage stopped
    // being written when OpenCode moved to opencode.db, and a session count from that
    // database would mean opening conversation content.
    usageProbe: null,
    // OpenCode reasoning intensity is --variant, not --effort.
    supports: ["model", "variant", "timeout", "readOnly"],
  },
  {
    key: "cursor",
    skill: "switchboard-cursor",
    binary: "cursor-agent",
    versionArgs: ["--version"],
    authProbe: {
      args: ["status"],
      successPattern: /logged in as/i,
      failPattern: /not logged in/i,
    },
    modelProbe: { args: ["models"], format: "cursor" },
    // projects/<project-slug>/agent-transcripts/<chat-uuid>/ — what the CLI writes per
    // chat; some layouts write flat <chat-uuid>.txt files instead, so accept either.
    // ~/.cursor/chats holds only a handful of older IDE-side entries.
    usageProbe: {
      homeSubdir: ".cursor",
      path: ["projects", "*", "agent-transcripts"],
      entry: "any",
      match: /^[0-9a-f]{8}-[0-9a-f]{4}-/i,
    },
    // Cursor sandbox is explicit per dispatch only; it is intentionally not a fleet dial.
    supports: ["model", "force", "timeout", "readOnly"],
  },
  {
    key: "pi",
    skill: "switchboard-pi",
    binary: "pi",
    versionArgs: ["--version"],
    authProbe: null,
    // Must stay a flag: `pi models` is read as a prompt and hits the API.
    modelProbe: { args: ["--list-models"], format: "table" },
    // ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl.
    usageProbe: {
      homeSubdir: ".pi/agent",
      path: ["sessions", "*"],
      entry: "file",
      match: /\.jsonl$/,
    },
    supports: ["provider", "model", "timeout", "readOnly"],
  },
  {
    key: "omp",
    skill: "switchboard-omp",
    binary: "omp",
    versionArgs: ["--version"],
    authProbe: null,
    // Must stay the `models` subcommand: `omp --list-models` is a stale flag and a
    // hard error. Catalog output is grouped/JSON, not a stable identifier list, so
    // this script does not parse it — the skill documents `omp models` instead.
    modelProbe: null,
    // ~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl.
    usageProbe: {
      envDir: "PI_CODING_AGENT_DIR",
      homeSubdir: ".omp/agent",
      path: ["sessions", "*"],
      entry: "file",
      match: /\.jsonl$/,
    },
    supports: ["provider", "model", "effort", "timeout", "readOnly"],
  },
  {
    key: "warp",
    skill: "switchboard-warp",
    binary: "oz",
    versionArgs: ["--version"],
    // `--output-format text` prints one `type:id` line; the default `pretty` format
    // spells the type out ("User ID: …") and so reads differently per principal. A
    // headless host authenticated with WARP_API_KEY is a service account, not a
    // user, so the probe must accept both or it reports CI as logged out.
    authProbe: {
      args: ["whoami", "--output-format", "text"],
      successPattern: /^(?:user|service_account):\S/m,
    },
    // `oz model list` emits a JSON array of {id} objects, which none of the shared
    // list formats parse; ids are read from the CLI directly instead of probed.
    modelProbe: null,
    // Conversations live server-side, so there is no local session directory to count.
    usageProbe: null,
    // `oz agent run` exposes no sandbox, permission-mode, or read-only flag, so
    // those dials are deliberately absent — the relay refuses a lane that sets one.
    supports: ["model", "timeout"],
  },
]);

/** Prototype-free map so names like "toString" cannot pass as implementers. */
export const IMPLEMENTER_BY_KEY = Object.freeze(
  IMPLEMENTERS.reduce((map, impl) => {
    map[impl.key] = impl;
    return map;
  }, Object.create(null)),
);

export const CLAUDE_EFFORT = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultracode"]);
export const OMP_THINKING = Object.freeze(["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const CODEX_SANDBOX = Object.freeze(["read-only", "workspace-write", "danger-full-access"]);
/** Positive h/m/s duration, same shape relays accept. */
export const TIMEOUT_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/**
 * Model/provider token shapes mirrored from each relay's parseArgs.
 * Relays that do not constrain the string still get a non-empty check in config.mjs.
 */
export const MODEL_TOKEN = Object.freeze({
  /** Keep in lockstep with switchboard-claude SAFE_MODEL. */
  claude: /^[A-Za-z0-9][A-Za-z0-9._:@\/\[\]-]*$/,
  /** Keep in lockstep with switchboard-cursor SAFE_MODEL. */
  cursor: /^[A-Za-z0-9][A-Za-z0-9._:@\/\[\]\,=-]*$/,
  /** Keep in lockstep with pi/omp/codex shell-safe tokens. */
  shellSafe: /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/,
  /** Keep in lockstep with switchboard-opencode MODEL_TOKEN: adds # for provider/model#variant (opencode 2.x), plus @ and ~ for catalog ids (@cf/..., model@default, ~vendor/model-latest). */
  opencode: /^[A-Za-z0-9][A-Za-z0-9._:@~\/#-]*$/,
});

export const CONFIG_VERSION = "switchboard-fleet.v1";
export const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const ALL_DIALS = Object.freeze([
  "model",
  "effort",
  "variant",
  "timeout",
  "readOnly",
  "sandbox",
  "force",
  "provider",
]);
