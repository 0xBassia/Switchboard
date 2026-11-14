/**
 * Switchboard · qoder-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to Qoder CLI (`qodercli -p`), capture the
 * structured event stream, and write a result the orchestrator can review.
 * The relay uses Node built-ins only and shells out only to `qodercli`, `git`,
 * and the platform process-termination utility when needed. It makes no
 * network calls, reads no credentials, sends no telemetry, and never commits.
 *
 * The brief is passed as a command-line argument. Keep secrets out of the
 * brief on shared hosts; point Qoder at workspace files or environment
 * variables instead.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Brief path. If omitted, read stdin.
 *   --cd <dir>              Qoder working root (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Model from `qodercli --list-models`.
 *   --context-window <n>    Positive integer; supported models only.
 *   --resume <id>           Resume one Qoder session; send a delta brief.
 *   --resume-last           Continue the latest session; send a delta brief.
 *   --add-dir <dir>         Add a workspace directory. Repeatable.
 *   --permission-mode <m>   default | accept_edits | auto |
 *                           bypass_permissions | dont_ask | plan
 *                           (default: auto).
 *   --timeout <dur>         Relay watchdog (default: 30m; h/m/s syntax).
 *   --out-dir <dir>         Artifact directory (default: system temp).
 *   -h, --help              Show this help.
 *
 * Result: <out-dir>/result.json plus brief.txt, events.jsonl, stderr.txt, and
 * final.txt when Qoder emits a final message. Pre-run usage errors exit 2 and
 * write no result. Missing `qodercli` exits 127 with qoder_unavailable. Once
 * dispatched, every outcome writes a result: completed, failed, timeout,
 * aborted, or qoder_unavailable.
 */

import { fail } from "../core/cli.mjs";
import { runRelay } from "../core/relay.mjs";
import { makeEventScanner } from "../core/scan.mjs";
import { resolve } from "node:path";

const PERMISSION_MODES = ["default", "accept_edits", "bypass_permissions", "dont_ask", "auto", "plan"];

// qodercli takes the brief as an argv value; the OS caps one argument.
const MAX_BRIEF_BYTES = (process.platform === "win32" ? 12 : 120) * 1024;

// Text of an assistant-shaped content value: a string, or an array of text blocks.
function textBlocks(content) {
  if (typeof content === "string") return [content];
  return Array.isArray(content)
    ? content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text)
    : [];
}

const qoder = {
  key: "qoder",
  name: "qodercli",
  versionField: "qoderVersion",
  flags: {
    "--model": { key: "model" },
    "--context-window": { key: "contextWindow" },
    "--resume": { key: "resume" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--add-dir": { key: "addDirs", kind: "list" },
    "--permission-mode": { key: "permissionMode" },
  },
  defaults: { timeout: "30m", model: null, contextWindow: null, resume: null, permissionMode: "auto" },
  validate(opts) {
    if (opts.resumeLast && opts.resume) fail("--resume-last and --resume are mutually exclusive; pass only one");
    if (opts.resume !== null && !opts.resume.trim()) fail("--resume must not be empty");
    if (opts.model !== null && !opts.model.trim()) fail("--model must not be empty");
    if (opts.contextWindow !== null && !/^[1-9]\d*$/.test(opts.contextWindow)) {
      fail("--context-window must be a positive integer");
    }
    if (!PERMISSION_MODES.includes(opts.permissionMode)) {
      fail(`unsupported --permission-mode: ${opts.permissionMode}`);
    }
    opts.addDirs = opts.addDirs.map((dir) => resolve(opts.cd, dir));
  },
  maxBriefBytes: MAX_BRIEF_BYTES,
  briefTooLarge: (kb) => `brief is ${kb}KB; keep large context in workspace files instead of argv`,
  state: () => ({
    actualModel: null,
    actualPermissionMode: null,
    usage: null,
    finalResult: "",
    resultIsError: false,
    resultSubtype: null,
    qoderErrors: [],
    permissionDenials: [],
    text: [],
    deltas: [],
  }),
  fields: (opts, state) => ({
    model: opts.model,
    contextWindow: opts.contextWindow,
    permissionMode: opts.permissionMode,
    resumed: Boolean(opts.resumeLast || opts.resume),
    actualModel: state.actualModel,
    actualPermissionMode: state.actualPermissionMode,
    usage: state.usage,
    resultSubtype: state.resultSubtype,
    qoderErrors: state.qoderErrors,
    permissionDenials: state.permissionDenials,
  }),
  resumeFlag: "--resume",
  binary: "qodercli",
  unavailableHint: "Install from https://docs.qoder.com/en/cli/quick-start, then run `qodercli login` or set QODER_PERSONAL_ACCESS_TOKEN for automation.",
  version: () => ({ launch: { command: "qodercli", args: ["--version"] } }),
  launch(opts, brief) {
    const args = ["--output-format", "stream-json", "--permission-mode", opts.permissionMode];
    if (opts.resume) args.push("--resume", opts.resume);
    else if (opts.resumeLast) args.push("-c");
    if (opts.model) args.push("--model", opts.model);
    if (opts.contextWindow) args.push("--context-window", opts.contextWindow);
    for (const dir of opts.addDirs) args.push("--add-dir", dir);
    args.push("-p", brief);
    return { command: "qodercli", args };
  },
  scanner: makeEventScanner,
  onEvent(event, state) {
    const sessionId = event.session_id ?? event.sessionId ?? event.session?.id;
    if (typeof sessionId === "string") state.sessionId = sessionId;
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") state.actualModel = event.model;
      const mode = event.permissionMode ?? event.permission_mode;
      if (typeof mode === "string") state.actualPermissionMode = mode;
    }
    if (event.type === "assistant" || event.role === "assistant") {
      state.text.push(...textBlocks(event.message?.content ?? event.content));
    }
    if (event.type === "content_block_delta" && typeof event.delta?.text === "string") {
      state.deltas.push(event.delta.text);
    }
    if (event.type === "result" || event.type === "final") {
      state.resultSubtype = typeof event.subtype === "string" ? event.subtype : null;
      state.resultIsError = event.is_error === true || event.status === "error";
      const text = event.result ?? event.final_message ?? event.finalMessage;
      if (typeof text === "string") state.finalResult = text;
      if (!state.finalResult && typeof event.message === "string") state.finalResult = event.message;
      if (!state.finalResult && Array.isArray(event.message?.content)) {
        state.finalResult = textBlocks(event.message.content).join("\n\n");
      }
      if (event.usage && typeof event.usage === "object") state.usage = event.usage;
      if (Array.isArray(event.errors)) state.qoderErrors = event.errors;
      if (Array.isArray(event.permission_denials)) state.permissionDenials = event.permission_denials;
    }
  },
  final: (state) => state.finalResult || state.text.join("\n\n") || state.deltas.join(""),
  verdict: (state) => (state.resultIsError ? { error: "qodercli reported an error result" } : {}),
  summary: (result) => [
    ...(result.actualModel ? [`model: ${result.actualModel}`] : []),
    ...(result.contextWindow ? [`context window requested: ${result.contextWindow}`] : []),
  ],
};

await runRelay(qoder);
