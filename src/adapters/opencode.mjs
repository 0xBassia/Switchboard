/**
 * Switchboard · opencode-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the OpenCode CLI (`opencode run`),
 * capture the run, and write a structured result the orchestrating agent can
 * review. The orchestrator runs this one command and reads the result JSON —
 * every OpenCode-specific mechanic lives in here, which keeps the skill
 * orchestrator-agnostic. Verified against opencode CLI v1.17.13.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `opencode` and `git`. The `opencode` process it
 * launches does authenticate — exactly as you do at the terminal. Read this
 * file before you run it.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job —
 * after it reviews the diff and re-runs the project gates.
 *
 * OpenCode autonomy is governed by the chosen agent, not a sandbox enum:
 *   build (default) — write-capable; edits files in the working dir headlessly.
 *   plan            — read-only; reviews/diagnoses without touching the tree.
 * A build run passes `--auto` by default so OpenCode never blocks on a permission
 * prompt no one can answer in headless mode; the orchestrator's diff review is the
 * safety net. Pass --no-auto to instead honor the agent's own permission config.
 * A plan (read-only) run never gets --auto, so it can't be auto-approved into edits.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for OpenCode (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          Model as provider/model, or provider/model#variant on opencode 2.x.
 *                           REQUIRED for a fresh run — OpenCode has no
 *                           safe default; a resumed run inherits its session's model.
 *   --agent <name>          OpenCode agent (default: build). Use plan for read-only review.
 *   --read-only             Shortcut for --agent plan (review/diagnosis, no edits).
 *   --variant <name>        Provider reasoning effort (e.g. high, max, minimal). Sent as
 *                           --variant on opencode 1.x; on 2.x it joins the model value
 *                           as provider/model#variant (2.x has no --variant flag).
 *   --no-auto               Don't pass --auto; honor the agent's own permission config (a headless
 *                           run may then hang if the agent is set to ask for a permission).
 *   --resume-last           Continue the most recent OpenCode session; send only the delta brief.
 *   --session <id>          Continue a specific session id (ses_...); send only the delta brief.
 *   --pure                  Run OpenCode without external plugins (cleaner event stream).
 *                           1.x only; rejected on 2.x, which dropped the flag.
 *   --timeout <dur>         Relay-side watchdog (default: off). Durations use h/m/s
 *                           strings like 30m or 2h. On expiry the opencode child is
 *                           killed and result.json gets status "timeout".
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir, so the repo under review stays clean).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout —
 *   status, exitCode, signal, opencodeVersion, sessionId (for a later resume), finalMessage
 *   (OpenCode's own report), touchedFiles (git porcelain, null if git can't report), and the
 *   paths to events.jsonl and final.txt.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief) exits 2
 * before any run and writes no result file; a missing `opencode` binary exits 127;
 * otherwise the exit code mirrors OpenCode's own (0 success, non-zero failure).
 * If the child dies on a signal, the exit code is 128 plus the signal number and
 * `result.json` records the signal.
 * Once the brief validates, `result.json` is written on every outcome —
 * completed, failed, timeout (the --timeout watchdog fired), aborted (the relay
 * itself was killed and forwarded the kill to opencode), or
 * opencode_unavailable. An orchestrator that polls for the
 * file must therefore also treat a non-zero exit with no file as a usage error.
 */

import { exclusive, fail } from "../core/cli.mjs";
import { IS_WIN, cmdShimMissing } from "../core/proc.mjs";
import { runRelay } from "../core/relay.mjs";
import { makeEventScanner } from "../core/scan.mjs";
import { tripwire } from "../core/tripwire.mjs";

// model/variant reach cmd.exe on win32 (shell:true for the opencode.cmd shim). The
// model token may carry a variant suffix (provider/model#variant on opencode 2.x), and
// catalog ids carry '@' (Workers AI @cf/..., Vertex model@default, region@eu) and '~'
// (OpenRouter/Kilo ~vendor/model-latest aliases). None of '#', '@' or '~' is a cmd.exe
// metacharacter, and no shell runs off win32. Keep SAFE_TOKEN in lockstep with
// delegate-setup MODEL_TOKEN.shellSafe, and MODEL_TOKEN with MODEL_TOKEN.opencode.
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@~/#-]*$/;

// opencode 2.x replaced the --variant flag with a provider/model#variant model value
// (2.0.11's `run --help` documents exactly that format and ships no --variant flag);
// 1.x still documents --variant. An unparseable string falls back to the 1.x mapping,
// the flag every opencode line has accepted so far.
const joinsVariant = (version) => Number(/(\d+)(?:\.\d+)*/.exec(String(version || ""))?.[1]) >= 2;

const opencode = {
  key: "opencode",
  versionField: "opencodeVersion",
  defaults: { model: null, agent: "build", variant: null, auto: true, session: null },
  flags: {
    "--model": { key: "model" },
    "--agent": { key: "agent" },
    "--read-only": { key: "readOnly", kind: "bool" },
    "--variant": { key: "variant" },
    "--auto": { key: "autoFlag", kind: "bool" },
    "--no-auto": { key: "noAuto", kind: "bool" },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--session": { key: "session" },
    "--pure": { key: "pure", kind: "bool" },
  },
  validate(opts, flagged) {
    if (opts.readOnly) opts.agent = "plan";
    // Both ride a cmd.exe command line on win32 (the .cmd shim), so only plain tokens pass.
    if (!SAFE_TOKEN.test(opts.agent)) {
      fail("--agent contains unsupported characters (allowed: letters, digits, . _ : / -)");
    }
    if (opts.session !== null && !SAFE_TOKEN.test(opts.session)) {
      fail("--session contains unsupported characters (allowed: letters, digits, . _ : / -)");
    }
    // The later of --auto / --no-auto wins.
    if (flagged.has("autoFlag") || flagged.has("noAuto")) {
      opts.auto = process.argv.lastIndexOf("--no-auto") <= process.argv.lastIndexOf("--auto");
    }
    if (opts.model !== null && !MODEL_TOKEN.test(opts.model)) {
      fail("--model contains unsupported characters (allowed: letters, digits, . _ : @ ~ / # -)");
    }
    if (opts.variant !== null && !SAFE_TOKEN.test(opts.variant)) {
      fail("--variant contains unsupported characters (allowed: letters, digits, . _ : / -)");
    }
    if (opts.model !== null && opts.model.includes("#") && opts.variant !== null) {
      fail("--model already carries a variant (provider/model#variant); pass either that or --model plus --variant, not both");
    }
    exclusive(opts, [["session", "resumeLast", "--session and --resume-last are mutually exclusive; pass only one"]]);
    // OpenCode has no safe default model (a bare `opencode run` errors); a resumed run
    // inherits its session's model.
    if (!opts.model && !opts.resumeLast && !opts.session) {
      fail("no model given: pass --model provider/model — opencode has no safe default (e.g. a plan you're subscribed to, like opencode-go/kimi-k2.7-code)");
    }
  },
  // The plan agent is the relay's read-only mode (--read-only selects it; so can --agent plan or a lane).
  readOnly: (opts) => opts.readOnly || opts.agent === "plan",
  tripwire,
  state: (opts) => ({ sessionId: opts.session, parts: new Map(), cost: null }),
  fields: (opts, state) => ({
    agent: opts.agent,
    model: opts.model,
    variant: opts.variant,
    auto: opts.auto,
    resumed: Boolean(opts.session || opts.resumeLast),
    resumeLast: opts.resumeLast,
    cost: state.cost === null ? null : Number(state.cost.toFixed(6)),
  }),
  version: (opts) => ({
    // On Windows, npm installs `opencode` as a .cmd shim, which needs shell:true to resolve.
    launch: { command: "opencode", args: ["--version"], shell: IS_WIN },
    parse: (out) => (opts.versionText = out.trim()),
    missing: cmdShimMissing,
  }),
  binary: "opencode",
  // The variant dial depends on the probed version, so check it before dispatch.
  prepare(opts) {
    // A resumed run may inherit its session's model, but a variant can only join a
    // model value, and 2.x has no --variant flag to fall back to.
    if (opts.variant && !opts.model && joinsVariant(opts.versionText)) {
      fail("--variant needs --model on opencode 2.x: the variant joins the model value as provider/model#variant");
    }
    // 2.x dropped --pure from `opencode run`.
    if (opts.pure && joinsVariant(opts.versionText)) {
      fail("--pure is not supported on opencode 2.x: `opencode run` dropped the flag and has no replacement; drop --pure");
    }
  },
  launch(opts, brief) {
    const args = ["run", "--format", "json"];
    if (opts.pure) args.push("--pure");
    // OpenCode selects the agent for each prompt, so preserve the requested autonomy
    // on resumed turns too.
    if (opts.session) args.push("--session", opts.session);
    else if (opts.resumeLast) args.push("--continue");
    args.push("--agent", opts.agent);
    const joined = Boolean(opts.model && opts.variant) && joinsVariant(opts.versionText);
    if (opts.model) args.push("--model", joined ? `${opts.model}#${opts.variant}` : opts.model);
    if (opts.variant && !joined) args.push("--variant", opts.variant);
    // --auto approves permissions a headless build run could never answer. Never on a
    // plan (read-only) run: it would approve the plan agent's ask-gated edit/bash.
    if (opts.auto && opts.agent !== "plan") args.push("--auto");
    // The brief is piped on stdin. PWD is pinned because OpenCode can resolve its
    // project root from the inherited PWD, which spawn does not rewrite. The argv holds
    // only flag names and token-validated values (agent, model, variant, session), so
    // shell:true on win32 (for the .cmd shim) is safe.
    return { command: "opencode", args, shell: IS_WIN, env: { ...process.env, PWD: opts.cd }, stdin: brief };
  },
  scanner: makeEventScanner,
  onEvent(event, state) {
    // Real events carry `sessionID`; plugin notify objects carry `session_id`.
    const sid = event.sessionID || event.session_id;
    if (sid) state.sessionId = sid;
    // Key text by part.id so streamed updates replace rather than duplicate; the Map
    // keeps first-seen order.
    const part = event.part;
    if (event.type === "text" && part && part.type === "text") {
      state.parts.set(part.id || `anon-${state.parts.size}`, part.text ?? "");
    }
    if (event.type === "step_finish" && part && typeof part.cost === "number") state.cost = (state.cost ?? 0) + part.cost;
  },
  cost: (state) => state.cost,
  final: (state) => [...state.parts.values()].join("").trim(),
  summary: (result) => (typeof result.cost === "number" ? [`cost: $${result.cost}`] : []),
};

await runRelay(opencode);
