/**
 * Switchboard · switchboard-claude · relay.mjs
 *
 * Dispatch a self-contained brief to a separate Claude Code CLI process
 * (`claude -p`), capture the structured stream, and write a stable result the
 * orchestrator can review.
 *
 * Trust posture: this relay makes no network calls of its own, reads or writes
 * no credentials, sends no telemetry, and has no dependencies (Node built-ins
 * only). It launches `claude` and uses `git status --porcelain`. Claude
 * authenticates and makes its own network calls exactly as it does at the
 * terminal.
 *
 * The relay never commits. Its write-capable profiles use string rules to deny
 * common direct forms of `git commit`, `git push`, and nested `claude`, plus
 * any command containing `switchboard-claude`. Aliases, scripts, and wrappers can
 * bypass those speed bumps; the brief's no-commit instruction and orchestrator
 * review remain the boundary. The orchestrator re-runs the project gates and
 * lands the work.
 *
 * Normal runs use Claude's `acceptEdits` permission mode with an explicit tool
 * surface (Read, Glob, Grep, Edit, Write, and Bash). An inline settings file
 * requires Claude's shell sandbox (macOS, Linux, WSL2), disables its
 * unsandboxed escape hatch, and auto-approves commands that stay
 * sandboxed so non-interactive gates can run. That sandbox covers shell
 * processes and their children only; merged local or managed settings can
 * affect its effective boundary, and it is not a universal boundary around
 * Claude Code.
 *
 * `--read-only` uses plan mode and exposes only Read, Glob, and Grep: no edit,
 * write, shell, MCP, skill, command, or Agent tool. The relay also compares git
 * porcelain before and after, and also fingerprints working-tree and index state for paths
 * that were already dirty, and emits `readOnlyViolation`. This is a tripwire,
 * not an OS boundary: it reports detected Git-visible changes, it does not prevent them. It is
 * three-valued - `null` means coverage was incomplete (git unavailable, a
 * submodule, an unreadable path), never "nothing happened". Git-ignored paths
 * are outside it.
 *
 * Every profile disables configured MCP discovery and Claude.ai connectors,
 * denies all MCP tools, and disables skills and commands for the child while
 * preserving normal authentication, CLAUDE.md discovery, hooks, and the rest of
 * the inherited environment. Hooks are outside the tool restriction and can
 * mutate a read-only run; readOnlyViolation is the tripwire. When nested under
 * Claude Code, the child environment removes only CLAUDECODE;
 * CLAUDE_CODE_CHILD_SESSION and credential variables are preserved. The same
 * environment is used for version preflight.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>                    Brief path. Omit to read the brief from stdin.
 *   --cd <dir>                        Child cwd (default: current directory).
 *   --lane <name>           Fleet lane from switchboard-setup config (dials apply; explicit flags win).
 *   --out-dir <dir>                   Artifact directory (default: system temp).
 *   --timeout <dur>                   Relay watchdog; off by default. Use h/m/s,
 *                                     such as 30m, 90s, or 1h30m.
 *   --model <name>                    Claude model alias or full name.
 *   --effort <level>                  low | medium | high | xhigh | max | ultracode
 *   --max-turns <n>                   Positive agentic-turn limit.
 *   --max-budget-usd <amount>         Positive decimal spend limit.
 *   --autocompact <auto|tokens>       Set Claude's auto-compact window.
 *                                     Requires claude 2.1.221 or newer.
 *   --resume-last                     Map to Claude's --continue.
 *   --session <id>                    Map to Claude's --resume <id>.
 *                                     Mutually exclusive with --resume-last.
 *   --read-only                       Plan mode with Read, Glob, and Grep only.
 *   --dangerously-skip-permissions    Opt into Claude's bypassPermissions mode.
 *   --project-settings                Also load the repository's .claude/settings.json and
 *                                     settings.local.json (hooks included). Trusted repos only.
 *                                     Mutually exclusive with --read-only.
 *   -h, --help                        Show this help.
 *
 * Claude is always launched with:
 *   -p --output-format stream-json --verbose
 * The brief is sent through stdin, never argv. `--bg` and `--bare` are not used.
 *
 * Artifacts:
 *   brief.txt       exact brief sent on stdin
 *   events.jsonl    raw Claude stdout stream
 *   final.txt       final result event's text
 *   stderr.txt      complete Claude stderr
 *   profile.json    inspectable per-run settings passed with --settings
 *   result.json     switchboard-relay.result.v1
 *
 * Exit codes: usage errors exit 2 before result.json; a missing `claude` exits
 * 127 with status "claude_unavailable"; otherwise the exit mirrors Claude, with
 * a forced non-zero code for timeout or a terminal error result. Once the brief
 * and artifact directory validate, result.json is written for completed,
 * failed, timeout, aborted, and claude_unavailable outcomes.
 */

import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { exclusive, fail } from "../core/cli.mjs";
import { runRelay } from "../core/relay.mjs";
import { writeJsonAtomic } from "../core/run.mjs";
import { makeEventScanner } from "../core/scan.mjs";
import { tripwire } from "../core/tripwire.mjs";

// Claude Code caps piped stdin at 10MB.
const MAX_BRIEF_BYTES = 10_000_000;
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultracode"];
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@\/\[\]-]*$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// Nested under Claude Code, only CLAUDECODE is removed; credentials and
// CLAUDE_CODE_CHILD_SESSION are preserved.
function childEnvironment() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

// Resolves `claude` on PATH to an executable file, spawned directly.
function resolveClaudeLauncher(env) {
  if (!env.PATH) return null;
  // Absolute entries only: an empty or relative entry would resolve inside the untrusted --cd.
  for (const entry of env.PATH.split(":").filter((dir) => isAbsolute(dir))) {
    const candidate = join(entry, "claude");
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

function permissionMode(opts) {
  if (opts.readOnly) return "plan";
  if (opts.dangerouslySkipPermissions) return "bypassPermissions";
  return "acceptEdits";
}

function toolSurface(opts) {
  return opts.readOnly ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write,Bash";
}

function profileSettings(opts) {
  const shell = "Bash";
  return {
    disableClaudeAiConnectors: true,
    permissions: {
      deny: opts.readOnly
        ? []
        : [
            // Two-wildcard git forms require text after the subcommand, so the
            // single-wildcard forms also catch `git -C <dir> push`; they also
            // deny reads like `git log --grep push`. Anchor `claude` at command
            // position so reads mentioning it remain allowed. Keep
            // `switchboard-claude` as a substring rule to stop recursive relay
            // invocation; any command containing it is denied.
            `${shell}(git commit *)`,
            `${shell}(git * commit *)`,
            `${shell}(git * commit)`,
            `${shell}(git push *)`,
            `${shell}(git * push *)`,
            `${shell}(git * push)`,
            `${shell}(claude *)`,
            `${shell}(*switchboard-claude*)`,
          ],
    },
    ...(!opts.readOnly
      ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
            excludedCommands: [],
            filesystem: { disabled: false },
          },
        }
      : {}),
  };
}

function claudeArgs(opts, run) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--tools", toolSurface(opts),
    "--strict-mcp-config",
    "--disallowedTools", "mcp__*",
    "--disable-slash-commands",
    "--settings", run.settingsPath,
    // Project and local settings come from the repository, and their hooks run commands
    // outside the tool limits and the sandbox; only the user's own settings load unless
    // the caller trusts the repository.
    "--setting-sources", opts.projectSettings ? "user,project,local" : "user",
  ];
  if (opts.readOnly) {
    args.push("--permission-mode", "plan");
  } else if (opts.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else {
    // Only commands that remain inside Claude's sandbox are auto-approved.
    args.push("--permission-mode", "acceptEdits");
  }
  // The permission profile is passed on every invocation, including
  // --continue/--resume, rather than assuming a session remembers it.
  if (opts.resumeLast) args.push("--continue");
  else if (opts.session) args.push("--resume", opts.session);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.maxTurns) args.push("--max-turns", opts.maxTurns);
  if (opts.maxBudgetUsd) args.push("--max-budget-usd", opts.maxBudgetUsd);
  if (opts.autocompact) args.push("--autocompact", opts.autocompact);
  return args;
}

function eventSessionId(event) {
  return event.session_id ?? event.sessionId ?? (event.session && (event.session.id ?? event.session.session_id)) ?? null;
}

const finiteNumber = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

const claude = {
  key: "claude",
  versionField: "claudeVersion",
  defaults: {
    model: null,
    effort: null,
    maxTurns: null,
    maxBudgetUsd: null,
    autocompact: null,
    session: null,
    projectSettings: false,
  },
  flags: {
    "--model": { key: "model", pattern: SAFE_MODEL },
    "--effort": { key: "effort", choices: EFFORT_LEVELS },
    "--max-turns": { key: "maxTurns", pattern: /^[1-9]\d{0,14}$/ },
    "--max-budget-usd": { key: "maxBudgetUsd", pattern: /^(?:0|[1-9]\d*)(?:\.\d+)?$/ },
    "--autocompact": { key: "autocompact", pattern: /^(?:auto|[1-9]\d*[km]?)$/i },
    "--resume-last": { key: "resumeLast", kind: "bool" },
    "--session": { key: "session", pattern: SAFE_SESSION },
    "--read-only": { key: "readOnly", kind: "bool" },
    "--dangerously-skip-permissions": { key: "dangerouslySkipPermissions", kind: "bool" },
    "--project-settings": { key: "projectSettings", kind: "bool" },
  },
  validate(opts) {
    exclusive(opts, [
      ["resumeLast", "session", "--resume-last and --session are mutually exclusive; pass only one"],
      ["readOnly", "dangerouslySkipPermissions", "--read-only and --dangerously-skip-permissions are mutually exclusive"],
      ["readOnly", "projectSettings", "--read-only and --project-settings are mutually exclusive: a read-only run never loads the repository's hooks"],
    ]);
    if (opts.maxBudgetUsd !== null && !(Number(opts.maxBudgetUsd) > 0)) {
      fail("--max-budget-usd must be a positive decimal number");
    }
  },
  // An explicit --dangerously-skip-permissions overrides a lane's readOnly dial.
  laneConflicts: { readOnly: ["readOnly", "dangerouslySkipPermissions"] },
  maxBriefBytes: MAX_BRIEF_BYTES,
  briefTooLarge: (kb) => `brief is ${Math.ceil(kb / 1000)}MB; Claude Code caps piped stdin at 10MB. Put large context in the workspace and reference it from a smaller brief.`,
  artifacts: { settingsPath: "profile.json" },
  readOnly: (opts) => opts.readOnly,
  tripwire,
  state: (opts) => ({
    env: childEnvironment(),
    launcher: null,
    sessionId: opts.session,
    permissionMode: permissionMode(opts),
    sawResult: false,
    resultSubtype: null,
    resultIsError: false,
    finalMessage: "",
    numTurns: null,
    usage: null,
    totalCostUsd: null,
  }),
  fields: (opts, state, run) => ({
    model: opts.model,
    effort: opts.effort,
    maxTurns: opts.maxTurns === null ? null : Number(opts.maxTurns),
    maxBudgetUsd: opts.maxBudgetUsd === null ? null : Number(opts.maxBudgetUsd),
    ...(opts.autocompact === null ? {} : { autocompact: opts.autocompact }),
    timeout: opts.timeout,
    readOnly: opts.readOnly,
    projectSettings: opts.projectSettings,
    resumed: Boolean(opts.resumeLast || opts.session),
    resumeLast: opts.resumeLast,
    permissionMode: state.permissionMode,
    toolSurface: toolSurface(opts).split(","),
    shellSandbox: opts.readOnly ? "not-applicable" : "strict",
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    resultSubtype: state.resultSubtype,
    numTurns: state.numTurns,
    usage: state.usage,
    settingsPath: run.settingsPath,
  }),
  version(opts) {
    // The run's opts carry no state yet, so resolve here and stash on opts.
    opts.launcher = resolveClaudeLauncher(childEnvironment());
    if (!opts.launcher) return { unavailable: true };
    return { launch: { command: opts.launcher, args: ["--version"], env: childEnvironment() }, timeoutMs: 15_000 };
  },
  unavailableHint: "Install Claude Code and run `claude auth login`.",
  prepare(opts, run) {
    writeJsonAtomic(run.settingsPath, profileSettings(opts));
  },
  launch(opts, brief, run, state) {
    // The brief is sent through stdin, never argv.
    return { command: opts.launcher, args: claudeArgs(opts, run), env: state.env, stdin: brief };
  },
  scanner: makeEventScanner,
  onEvent(event, state) {
    if (!event || typeof event !== "object") return;
    const sessionId = eventSessionId(event);
    if (typeof sessionId === "string" && sessionId) state.sessionId = sessionId;
    if (event.type === "system" && event.subtype === "init") {
      const mode = event.permissionMode ?? event.permission_mode;
      if (typeof mode === "string" && mode) state.permissionMode = mode;
    }
    if (event.type !== "result") return;
    state.sawResult = true;
    state.resultSubtype = typeof event.subtype === "string" ? event.subtype : null;
    state.resultIsError = event.is_error === true ||
      (state.resultSubtype !== null && /^error(?:_|$)/i.test(state.resultSubtype));
    state.finalMessage = typeof event.result === "string" ? event.result : "";
    state.usage = event.usage && typeof event.usage === "object" ? event.usage : null;
    state.totalCostUsd = finiteNumber(event.total_cost_usd ?? event.cost_usd);
    state.numTurns = finiteNumber(event.num_turns ?? event.numTurns);
  },
  // The terminal result event carries Anthropic usage counts and the run's spend.
  tokens: (state) => state.usage && {
    input: state.usage.input_tokens,
    output: state.usage.output_tokens,
    cacheRead: state.usage.cache_read_input_tokens,
    cacheWrite: state.usage.cache_creation_input_tokens,
  },
  cost: (state) => state.totalCostUsd,
  final: (state) => state.finalMessage,
  verdict(state) {
    if (!state.sawResult) return { error: "claude exited without a terminal result event; inspect events.jsonl and stderr.txt" };
    if (state.resultIsError) return { error: `claude returned an error result${state.resultSubtype ? ` (${state.resultSubtype})` : ""}` };
    return null;
  },
  summary(result) {
    const lines = [`permission mode: ${result.permissionMode}  ·  shell sandbox: ${result.shellSandbox}`];
    if (result.dangerouslySkipPermissions) {
      lines.push("warning: bypassPermissions was explicitly enabled; direct file tools can reach beyond normal permission boundaries.");
    }
    if (result.resultSubtype) lines.push(`result subtype: ${result.resultSubtype}`);
    if (typeof result.numTurns === "number") lines.push(`turns: ${result.numTurns}`);
    return lines;
  },
  emptyReport: "(no final result text captured)",
};

await runRelay(claude);
