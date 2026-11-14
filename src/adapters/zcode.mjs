/**
 * Switchboard · zcode-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Z.AI ZCode CLI, capture the run, and
 * write a structured result the orchestrating agent can review. The
 * orchestrator runs this one command and reads the result JSON — every
 * ZCode-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified on Claude Code; other shell-capable agents
 * (OpenCode, Cursor, …) are designed-for but not yet verified.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `zcode` (or `node <bundle>`) and `git`. The
 * ZCode process it launches does authenticate — exactly as you do at the
 * terminal. Read this file before you run it.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's
 * job — after it reviews the diff and re-runs the project gates.
 *
 * Finding the CLI: ZCode ships its CLI inside the desktop app rather than on
 * PATH or npm, so the relay resolves it as --zcode-path/ZCODE_CLI → PATH → the
 * installed app bundle, and records which route won in result.json.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for ZCode (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --mode <mode>           ZCode's own --mode. Only `plan` and `yolo` are accepted
 *                           (default: yolo). ZCode also documents `build` and `edit`,
 *                           but a headless run has no permission client, so those two
 *                           block every write tool and exit 0 having changed nothing;
 *                           this relay rejects them rather than report that as success.
 *   --read-only             Shortcut for --mode plan (review/diagnosis, no edits).
 *   --disallowed-tools <l>  Comma/space-separated tool denylist, e.g. "Write,Edit,Bash".
 *                           Enforced by ZCode. There is no --allowed-tools counterpart.
 *   --resume-last           Continue the latest ZCode session for --cd; send only the
 *                           delta brief. Scoped to the directory, not a global "last".
 *   --session <id>          Continue a specific ZCode session by its sess_... id (from a
 *                           prior result.json). Mutually exclusive with --resume-last.
 *   --zcode-path <file>     Path to the ZCode CLI (a .cjs bundle or a binary/shim).
 *                           Overrides PATH and bundle discovery; ZCODE_CLI does the same.
 *   --timeout <dur>         Relay-side watchdog (default: off). Durations use h/m/s
 *                           strings like 30m or 2h. On expiry the ZCode child is killed
 *                           and result.json gets status "timeout". ZCode has no timeout
 *                           flag of its own, so the watchdog is relay-only.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Brief delivery: ZCode reads no stdin, so the brief is written to brief.md in
 * the run directory and passed with ZCode's own --attach. That also keeps the
 * brief clear of the command line, which is bounded on Windows.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, zcodeVersion, zcodeSource, mode, sessionId (for a later
 *   resume), finalMessage (ZCode's own report), touchedFiles (git porcelain, null if git
 *   can't report), readOnlyViolation, usage, contextWindow, and the paths to the raw
 *   output and final.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief, a rejected
 * --mode) exits 2 before any run and writes no result file; a ZCode CLI that
 * cannot be found — including one named explicitly that does not exist — exits
 * 127 and DOES write one; otherwise the exit code mirrors ZCode's own (0
 * success, non-zero failure). If the child dies on a signal, the exit code is
 * 128 plus the signal number and `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, timeout (the --timeout watchdog fired), aborted (the relay
 * itself was killed and forwarded the kill to ZCode), or zcode_unavailable. An
 * orchestrator that polls for the file must therefore also treat a non-zero exit
 * with no file as a usage error.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { exclusive, fail } from "../core/cli.mjs";
import { IS_WIN, cmdShimMissing } from "../core/proc.mjs";
import { runRelay } from "../core/relay.mjs";
import { writeAtomic, writePrivate } from "../core/run.mjs";
import { MAX_BUFFERED_CHARS } from "../core/scan.mjs";
import { tripwire } from "../core/tripwire.mjs";

// build/edit are documented by the CLI but rejected here: a headless run has no
// permission client, so they block every write tool and exit 0 having changed
// nothing (issue #55).
const ZCODE_MODES = ["plan", "yolo"];
const REJECTED_MODES = ["build", "edit"];
// Both values can reach cmd.exe when the CLI resolved to a .cmd shim.
const SAFE_SESSION = /^sess_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_TOOLS = /^[A-Za-z0-9][A-Za-z0-9 ,.:*()_/-]*$/;
// ZCode reads no stdin: the brief travels as an attached file and the prompt is
// this fixed instruction.
const ATTACH_PROMPT = "Follow the attached brief exactly.";

const isShim = (target) => IS_WIN && /\.(?:cmd|bat)$/i.test(target.command);
// Under shell:true the file is not quoted, so a shim under C:\Program Files splits.
const commandOf = (target) => (isShim(target) ? `"${target.command}"` : target.command);

// The bundled CLI is a Node bundle, so it runs under node and needs no shell.
const asTarget = (file, source) => (/\.(?:c?js|mjs)$/i.test(file)
  ? { command: process.execPath, prefixArgs: [file], display: file, source }
  : { command: file, prefixArgs: [], display: file, source });

function onPath(binary) {
  const suffixes = IS_WIN ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim()).filter(Boolean) : [""];
  for (const entry of (process.env.PATH || process.env.Path || "").split(delimiter).map((value) => value.replace(/^"(.*)"$/, "$1")).filter((value) => value && isAbsolute(value))) {
    for (const suffix of suffixes) {
      const candidate = join(resolve(entry), `${binary}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// The desktop app's bundled CLI. Linux ships an AppImage with no fixed path, so
// there --zcode-path or ZCODE_CLI is required.
function bundleCandidates() {
  const home = homedir();
  if (IS_WIN) return [join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "ZCode", "resources", "glm", "zcode.cjs")];
  if (process.platform !== "darwin") return [];
  return ["/Applications", join(home, "Applications")].map((dir) => join(dir, "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs"));
}

// --zcode-path/ZCODE_CLI → PATH → installed app bundle. A named CLI that does not
// exist is the same condition as finding none: zcode_unavailable, not a usage error.
function resolveZcode(opts) {
  // ZCODE_CLI must be absolute: a relative one would resolve inside whatever directory the relay runs from.
  const fromEnv = (process.env.ZCODE_CLI || "").trim();
  const named = opts.zcodePath || (fromEnv && isAbsolute(fromEnv) ? fromEnv : "");
  if (named) return existsSync(named) ? asTarget(resolve(named), opts.zcodePath ? "flag" : "env") : null;
  const found = onPath("zcode");
  if (found) return asTarget(found, "path");
  const bundle = bundleCandidates().find((candidate) => existsSync(candidate));
  return bundle ? asTarget(bundle, "bundle") : null;
}

// --json prints ONE document at the end, but the bundled AI SDK may print a
// warning banner on stdout first, so skip to the first brace.
function parseOutput(stdout) {
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const zcode = {
  key: "zcode",
  name: "ZCode",
  versionField: "zcodeVersion",
  defaults: { mode: null, disallowedTools: null, session: null, zcodePath: null },
  flags: {
    "--mode": { key: "mode" },
    "--read-only": { key: "readOnly", kind: "bool" },
    "--disallowed-tools": { key: "disallowedTools" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--session": { key: "session" },
    "--zcode-path": { key: "zcodePath", path: true },
  },
  // delegate-setup carries --mode as the `permissionMode` dial.
  laneConflicts: { permissionMode: ["mode", "readOnly"], readOnly: ["readOnly", "mode"] },
  validate(opts) {
    if (opts.mode === null && typeof opts.permissionMode === "string") opts.mode = opts.permissionMode;
    if (opts.readOnly && opts.mode !== null && opts.mode !== "plan") {
      fail(`--read-only conflicts with --mode ${opts.mode}; read-only runs use ZCode's plan mode`);
    }
    if (opts.mode === null) opts.mode = opts.readOnly ? "plan" : "yolo";
    if (REJECTED_MODES.includes(opts.mode)) {
      fail(`--mode ${opts.mode} cannot write in a headless run: ZCode has no permission client there, so its write tools are blocked and the run exits 0 having changed nothing. Use --mode yolo to write, or --read-only for plan mode.`);
    }
    if (!ZCODE_MODES.includes(opts.mode)) fail(`invalid --mode "${opts.mode}" (expected: ${ZCODE_MODES.join(", ")})`);
    opts.readOnly = opts.mode === "plan";
    if (opts.disallowedTools !== null && !SAFE_TOOLS.test(opts.disallowedTools)) {
      fail("--disallowed-tools contains unsupported characters (allowed: letters, digits, spaces, and , . : * ( ) _ / -)");
    }
    exclusive(opts, [["session", "resumeLast", "--session and --resume-last are mutually exclusive; pass only one"]]);
    if (opts.session !== null && !SAFE_SESSION.test(opts.session)) {
      fail("--session must be a ZCode session id of the form sess_... (letters, digits, . _ : -)");
    }
  },
  artifacts: { outputPath: "output.json", attachPath: "brief.md" },
  state: () => ({ out: "", truncated: false, doc: null }),
  fields: (opts, state, run) => ({
    mode: opts.mode,
    readOnly: opts.readOnly,
    disallowedTools: opts.disallowedTools,
    resumeLast: opts.resumeLast,
    session: opts.session,
    zcodeSource: opts.target ? opts.target.source : null,
    zcodePath: opts.target ? opts.target.display : null,
    outputPath: existsSync(run.outputPath) ? run.outputPath : null,
    readOnlyViolation: null,
    usage: state.doc?.usage ?? null,
    contextWindow: state.doc?.projection?.contextWindow ?? null,
  }),
  readOnly: (opts) => opts.readOnly,
  tripwire,
  version(opts) {
    // The run's opts carry no state yet, so resolve here and stash on opts.
    opts.target = resolveZcode(opts);
    if (!opts.target) return { unavailable: true };
    // A .cmd shim on win32 needs shell:true; a `node <bundle>` launch must not get it.
    return {
      launch: { command: commandOf(opts.target), args: [...opts.target.prefixArgs, "--version"], shell: isShim(opts.target) },
      missing: cmdShimMissing,
    };
  },
  binary: "zcode",
  unavailableHint: "ZCode ships its CLI inside the desktop app, so point at it with --zcode-path <file> or ZCODE_CLI, put a `zcode` shim on PATH, or install the ZCode desktop app.",
  prepare(opts, run, state, brief) {
    // Private like the core's own artifacts: 0600, never through a planted link.
    writePrivate(run.attachPath, brief);
    state.outputPath = run.outputPath;
  },
  launch(opts, brief, run) {
    // Spaceable values are quoted only where a .cmd shim puts cmd.exe in the path. A
    // trailing backslash (a drive-root --cd) would escape the closing quote, so it is doubled.
    const quote = (value) => (isShim(opts.target) ? `"${value.replace(/(\\+)$/, "$1$1")}"` : value);
    const args = [...opts.target.prefixArgs, "--cwd", quote(opts.cd), "--json", "--no-color", "--mode", opts.mode];
    if (opts.disallowedTools) args.push("--disallowed-tools", quote(opts.disallowedTools));
    // --resume takes a sess_ id; -c continues the latest session for --cwd.
    if (opts.session) args.push("--resume", opts.session);
    else if (opts.resumeLast) args.push("-c");
    args.push("--attach", quote(run.attachPath), "--prompt", quote(ATTACH_PROMPT));
    return { command: commandOf(opts.target), args, shell: isShim(opts.target) };
  },
  // One document arrives at the end, so stdout is buffered whole. Past the bound
  // the head is kept, since the document starts there.
  onText(text, state) {
    if (state.truncated) return;
    state.out = (state.out + text).slice(0, MAX_BUFFERED_CHARS + 1);
    state.truncated = state.out.length > MAX_BUFFERED_CHARS;
    if (state.truncated) state.out = state.out.slice(0, MAX_BUFFERED_CHARS);
  },
  // The JSON document's usage block: inputTokens, outputTokens, cacheReadTokens,
  // cacheWriteTokens, reasoningTokens (no cost field is documented).
  tokens: (state) => state.doc?.usage && {
    input: state.doc.usage.inputTokens,
    output: state.doc.usage.outputTokens,
    cacheRead: state.doc.usage.cacheReadTokens,
    cacheWrite: state.doc.usage.cacheWriteTokens,
    reasoning: state.doc.usage.reasoningTokens,
  },
  final(state) {
    // Re-parsed on every report, so a partial run still yields its session.
    state.doc = parseOutput(state.out);
    if (state.doc?.sessionId) state.sessionId = state.doc.sessionId;
    // Keep the raw stream beside the result for a reviewer to read when it is malformed.
    // Atomic: a link planted at output.json mid-run is replaced, never written through.
    if (state.out && state.outputPath) {
      try { writeAtomic(state.outputPath, state.out); } catch { /* the report carries the text anyway */ }
    }
    return typeof state.doc?.response === "string" ? state.doc.response.trim() : state.out.trim();
  },
  verdict: (state) => (parseOutput(state.out) ? null : {
    fields: {
      parseWarning: state.truncated
        ? `ZCode's stdout exceeded ${MAX_BUFFERED_CHARS} characters and was truncated; the JSON result could not be parsed. finalMessage is the raw head — read outputPath.`
        : "ZCode's stdout did not contain a parseable JSON result; finalMessage is the raw output — read outputPath.",
    },
  }),
  summary: (result) => [
    `mode: ${result.mode}${result.readOnly ? " (read-only)" : ""}`,
    ...(result.resumeLast ? ["resume: latest session for this directory"] : []),
    ...(result.session ? [`resume: session ${result.session}`] : []),
    ...(result.parseWarning ? [`warning: ${result.parseWarning}`] : []),
  ],
};

await runRelay(zcode);
