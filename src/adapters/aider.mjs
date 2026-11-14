/**
 * Switchboard · aider-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to Aider (`aider --message-file`), capture the
 * run, and write a structured result the orchestrating agent can review. The
 * orchestrator runs this one command and reads the result JSON - every
 * Aider-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. What was actually run, and on what, is recorded in the
 * README's Verification status list rather than pinned here.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `aider` and `git`. The `aider` process it
 * launches does reach its configured model endpoint - exactly as you do at the
 * terminal. Read this file before you run it.
 *
 * The brief is delivered with `--message-file`, so it never rides argv: it is
 * not visible in the host process list and is not subject to the OS argument
 * size cap.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job
 * - after it reviews the diff and re-runs the project gates. Aider is the one
 * implementer here that commits by default, so the relay always passes:
 *   --no-auto-commits    Aider's `--auto-commits` defaults to True and would
 *                        otherwise commit its own edits.
 *   --no-dirty-commits   Aider's `--dirty-commits` defaults to True and would
 *                        otherwise commit YOUR pre-existing uncommitted work
 *                        before it starts editing.
 * Neither flag is configurable through this relay. A run that committed would
 * destroy the reviewable diff this skill exists to produce.
 *
 * The relay also pins the following, none of them configurable, so a headless
 * run stays quiet and leaves no artifacts of its own in the tree:
 *   --yes-always         Aider's own autonomy term; headless runs cannot answer
 *                        a confirmation prompt.
 *   --no-suggest-shell-commands
 *                        The other half of --yes-always: Aider's
 *                        --suggest-shell-commands defaults to True, and under
 *                        --yes-always a suggestion runs on the host unread.
 *   --no-gitignore       Aider otherwise writes `.aider*` into .gitignore on
 *                        startup, dirtying the tree the reviewer is about to read.
 *   --no-analytics       No telemetry from the dispatched run. Aider's own
 *                        --analytics default is "random", which opts some
 *                        sessions in on its own.
 *   --no-check-update    No version check on a dispatch path.
 *   --no-detect-urls     Aider's --detect-urls defaults to True and offers to
 *                        scrape any URL in the message. Under --yes-always that
 *                        offer is auto-accepted, so a URL in the brief becomes an
 *                        unannounced outbound fetch - and, without Playwright
 *                        installed, a run that hangs until the watchdog fires.
 *   --no-pretty          Plain output; colour codes would corrupt the captured report.
 *   --no-stream          Whole responses; the relay captures text, not a live view.
 *
 * Autonomy, in Aider's own terms: `--yes-always` auto-confirms every prompt, and
 * Aider has no sandbox and no permission modes. Within its file scope it edits
 * freely. `--read-only` here maps to Aider's `--dry-run`, which performs the run
 * without modifying files; the relay does not independently verify that claim, so
 * `touchedFiles` remains the evidence of what changed.
 *
 * Aider has no session ids. Its resume unit is the chat history file in the
 * repo (`.aider.chat.history.md`), so `--resume-last` maps to Aider's
 * `--restore-chat-history` and `--history-file` pins a specific one.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, read it from stdin.
 *   --cd <dir>              Working root for Aider (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Aider model name (default: Aider's own configured model).
 *   --api-base <url>        OpenAI-compatible base URL (Aider's --openai-api-base).
 *   --edit-format <fmt>     Aider edit format (its --edit-format, e.g. diff, whole, udiff).
 *   --architect             Use Aider's architect edit format.
 *   --file <path>           Add a file to Aider's editing scope. Repeatable.
 *   --read <path>           Add a read-only context file. Repeatable.
 *   --subtree-only          Restrict Aider to the current subtree of the repo.
 *   --read-only             Dispatch as a dry run (Aider's --dry-run): no files modified.
 *   --resume-last           Restore Aider's chat history for this repo; send only the delta brief.
 *   --history-file <path>   Pin a specific chat history file (Aider's --chat-history-file).
 *   --timeout <dur>         Relay-side watchdog (default: 30m). Durations use h/m/s strings.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir
 *                           under the system temp dir).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout -
 *   status, exitCode, signal, aiderVersion, finalMessage (Aider's own report),
 *   touchedFiles (git porcelain, null if git cannot report), and paths to
 *   brief.txt, final.txt, and stderr.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `aider` binary exits 127
 * with one; otherwise the exit code mirrors Aider's own (0 success, non-zero
 * failure), except an exit-0 model/endpoint failure detected in the report exits
 * 1. If the child dies on a signal, the exit code is 128 plus the signal
 * number and `result.json` records the signal. Once the brief validates,
 * `result.json` is written on every outcome - completed, failed, timeout (the
 * --timeout watchdog fired), aborted (the relay itself was killed and forwarded
 * the kill to aider), or aider_unavailable.
 */

import { exclusive } from "../core/cli.mjs";
import { runRelay } from "../core/relay.mjs";
import { tripwire } from "../core/tripwire.mjs";
import { resolve } from "node:path";

// Aider writes its own bookkeeping into the repo and keeps doing so under --dry-run.
// These stay in touchedFiles, which reports git verbatim, but they must not trip the
// read-only warning: a dry run that touched nothing else is exactly what was asked for.
// The list is exhaustive on purpose. A blanket `.aider*` match would also swallow
// user-managed settings - .aider.conf.yml, .aider.model.settings.yml,
// .aider.model.metadata.json, .aiderignore - and those changing during a dry run is
// precisely what the warning exists to report.
const AIDER_GENERATED_FILE = /^\.aider\.(?:chat\.history\.md|input\.history|llm\.history)$/;
const AIDER_GENERATED_DIR = /^\.aider\.tags\.cache\.v\d+$/;

// Anchored at the repository root, where aider writes them: the same names deeper in
// the tree are ordinary files and stay inside the tripwire.
function isAiderGenerated(path) {
  const segments = path.split("/");
  // the tags cache is a directory; git may report it or anything beneath it
  return AIDER_GENERATED_DIR.test(segments[0]) || (segments.length === 1 && AIDER_GENERATED_FILE.test(segments[0]));
}

function withoutAiderArtifacts(touchedFiles) {
  if (!Array.isArray(touchedFiles)) return [];
  return touchedFiles.filter((line) => {
    // git porcelain v1: two status columns, a space, then the path. A rename reports
    // `old -> new`; judge the destination, which is what the run actually wrote.
    const entry = line.slice(3).trim();
    const target = entry.includes(" -> ") ? entry.slice(entry.lastIndexOf(" -> ") + 4) : entry;
    return !isAiderGenerated(target.replace(/^"|"$/g, ""));
  });
}

// Aider exits 0 after reporting a model or endpoint failure, so exit status alone
// cannot separate "did the work" from "never reached a model". These are aider's
// own end-of-run error lines; matching them turns that silent success into a
// failed status the orchestrator can act on.
// Every pattern is line-anchored: a successful report that merely *mentions*
// OPENAI_API_KEY must not be published as an authentication failure. A diagnostic
// is a line aider emits, not a word it says.
const MODEL_FAILURE_PATTERNS = [
  // litellm surfaces the provider error class at the head of its own line; allow a
  // short prefix ("Error: ", a retry counter) but not a sentence of prose.
  /^.{0,60}?litellm\.(?:APIConnectionError|AuthenticationError|BadRequestError|RateLimitError|NotFoundError|InternalServerError|Timeout)\b/im,
  /^\s*(?:Error|Warning) connecting to /im,
  /^\s*(?:Error|Warning):?\s*(?:\w+_API_KEY|API key)\b.*\b(?:not set|not found|missing|invalid)\b/im,
  /^\s*The API provider is not able to authenticate you\b/im,
  // Needs an endpoint-shaped object: "Unable to connect" on its own is ordinary prose
  // a report could easily contain while describing the very thing it just documented.
  /^\s*Unable to (?:connect|reach)\s+(?:the\s+)?(?:model|endpoint|server|host|API|provider|https?:)/im,
];

function detectModelFailure(text) {
  for (const pattern of MODEL_FAILURE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0].trim();
  }
  return null;
}

// Non-negotiable posture. --no-auto-commits and --no-dirty-commits keep the diff
// reviewable (both default to True in aider); --no-gitignore stops aider writing
// `.aider*` into .gitignore and dirtying the tree; the rest keep headless output
// clean and side-effect free. --no-suggest-shell-commands is the other half of
// --yes-always: a suggestion accepted with nobody there to read it would run on the host.
const PINNED_FLAGS = [
  "--yes-always",
  "--no-suggest-shell-commands",
  "--no-auto-commits",
  "--no-dirty-commits",
  "--no-gitignore",
  "--no-analytics",
  "--no-check-update",
  "--no-detect-urls",
  "--no-pretty",
  "--no-stream",
];

const aider = {
  key: "aider",
  versionField: "aiderVersion",
  defaults: { timeout: "30m", model: null, apiBase: null, editFormat: null, historyFile: null },
  flags: {
    "--model": { key: "model" },
    "--api-base": { key: "apiBase" },
    "--edit-format": { key: "editFormat" },
    "--architect": { key: "architect", kind: "bool" },
    "--file": { key: "files", kind: "list" },
    "--read": { key: "reads", kind: "list" },
    "--subtree-only": { key: "subtreeOnly", kind: "bool" },
    "--read-only": { key: "readOnly", kind: "bool" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--history-file": { key: "historyFile" },
  },
  laneConflicts: { editFormat: ["editFormat", "architect"] },
  validate(opts) {
    exclusive(opts, [["architect", "editFormat", "--architect and --edit-format are mutually exclusive; pass only one"]]);
    // aider resolves a relative --file/--read/--chat-history-file against ITS cwd, so
    // resolve against --cd, which may appear after them on the command line.
    opts.files = opts.files.map((path) => resolve(opts.cd, path));
    opts.reads = opts.reads.map((path) => resolve(opts.cd, path));
    if (opts.historyFile) opts.historyFile = resolve(opts.cd, opts.historyFile);
  },
  state: () => ({ stdout: "", stderr: "" }),
  // --read-only is aider's --dry-run. Aider still rewrites its own history and
  // tags cache under --dry-run, so those paths are outside the tripwire; any
  // other Git-visible write is a violation.
  readOnly: (opts) => opts.readOnly,
  tripwire,
  tripwireIgnore: isAiderGenerated,
  fields: (opts) => ({
    model: opts.model,
    editFormat: opts.architect ? "architect" : opts.editFormat,
    readOnly: opts.readOnly,
    resumed: opts.resumeLast,
  }),
  version: () => ({ launch: { command: "aider", args: ["--version"] } }),
  unavailableHint: "Install Aider (https://aider.chat/docs/install.html) and configure a model.",
  launch(opts, brief, run) {
    const args = [...PINNED_FLAGS];
    if (opts.model) args.push("--model", opts.model);
    if (opts.apiBase) args.push("--openai-api-base", opts.apiBase);
    if (opts.architect) args.push("--architect");
    else if (opts.editFormat) args.push("--edit-format", opts.editFormat);
    if (opts.subtreeOnly) args.push("--subtree-only");
    if (opts.readOnly) args.push("--dry-run");
    if (opts.resumeLast) args.push("--restore-chat-history");
    if (opts.historyFile) args.push("--chat-history-file", opts.historyFile);
    for (const path of opts.reads) args.push("--read", path);
    for (const path of opts.files) args.push("--file", path);
    // The brief rides a file, never argv: it stays out of the host process list and
    // the OS argument cap, and a brief starting with "-" cannot parse as a flag.
    args.push("--message-file", run.briefPath);
    // Aider's pip install provides a native `aider` executable on every platform,
    // so it is launched directly with no shell.
    return { command: "aider", args };
  },
  onText: (text, state) => { state.stdout += text; },
  onStderr: (text, state) => { state.stderr += text; },
  final: (state) => state.stdout.trim(),
  verdict(state, { code, signal }) {
    const failure = detectModelFailure(`${state.stdout.trim()}\n${state.stderr}`);
    if (failure) return { error: `aider reported a model or endpoint failure and exited ${code}: ${failure}` };
    if (code === 0) return null;
    return {
      error: signal
        ? `aider was killed by ${signal} — inspect the working tree before re-dispatching`
        : `aider exited ${code} without reporting a model or endpoint failure; see stderrTail and final.txt`,
    };
  },
  summary(result) {
    const lines = [];
    if (result.readOnly) lines.push("mode: dry run (aider --dry-run) - no files should be modified");
    const unexpected = result.readOnly ? withoutAiderArtifacts(result.touchedFiles) : [];
    if (unexpected.length) {
      lines.push(`warning: --read-only dispatched aider --dry-run, yet ${unexpected.length} path(s) outside aider's own generated history and cache changed. Inspect the diff before trusting this run.`);
    }
    return lines;
  },
};

await runRelay(aider);
