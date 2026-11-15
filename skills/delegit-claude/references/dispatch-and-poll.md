# Dispatch and poll

`scripts/relay.mjs` wraps Claude Code's non-interactive `claude -p` mode, sends a brief on stdin,
captures the structured stream, and writes `delegit-relay.result.v1`.

## Before the first run

```bash
command -v claude
claude --version
claude auth status
```

The relay performs its own `claude --version` preflight and records the answer as `claudeVersion`.
When an orchestrator is itself Claude Code, the relay removes only inherited `CLAUDECODE` from the
child environment so a separate CLI process can start. It preserves credentials,
`CLAUDE_CODE_CHILD_SESSION`, and every other environment entry. Version preflight uses that same
environment.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

`<skill-dir>` is the installed folder containing this skill's `SKILL.md`.

| Flag | Effect |
| --- | --- |
| `--brief <file>` | Brief path. Omit it to read stdin. The exact text is then sent to Claude on stdin, never argv. |
| `--cd <dir>` | Child process cwd and target working root (default: current directory). |
| `--lane <name>` | Fleet lane from `delegit-setup` config. Applies that lane's dials; fails if the lane's `implementer` is not this relay. Explicit dial flags win. |
| `--out-dir <dir>` | Artifact directory (default: a fresh directory under the system temp directory). |
| `--timeout <dur>` | Relay watchdog, such as `30m`, `90s`, or `2h` (default: off). |
| `--model <name>` | Claude model alias or full name (default: Claude's configured choice). The relay does not pin a model version. |
| `--effort <level>` | Claude effort: `low`, `medium`, `high`, `xhigh`, `max`, or `ultracode`; availability depends on the model. |
| `--max-turns <n>` | Positive agentic-turn cap. |
| `--max-budget-usd <amount>` | Positive decimal spend cap for print mode. |
| `--autocompact <auto\|tokens>` | Set Claude Code's auto-compact window on Claude Code `2.1.221` or newer. The relay validates a shell-safe shape; the installed Claude CLI owns the supported range. |
| `--resume-last` | Resume the latest session for this cwd with Claude's `--continue`; send a delta brief. |
| `--session <id>` | Resume a specific session with Claude's `--resume <id>`; mutually exclusive with `--resume-last`. |
| `--read-only` | Plan mode with only Read, Glob, and Grep, plus a Git-visible change tripwire. |
| `--dangerously-skip-permissions` | Opt into Claude's `bypassPermissions`; mutually exclusive with `--read-only`. |
| `-h`, `--help` | Print the relay header and option reference. |

Flag values are token- or number-validated, and no shell runs. The brief never reaches a command
line.

## What the relay runs

The common shape is:

```bash
claude -p --output-format stream-json --verbose \
  --tools Read,Glob,Grep,Edit,Write,Bash \
  --strict-mcp-config --disallowedTools 'mcp__*' \
  --disable-slash-commands \
  --settings <profile.json> \
  --permission-mode acceptEdits \
  < brief.txt
```

Read-only uses `--tools Read,Glob,Grep --permission-mode plan`. A
specific session adds `--resume <id>`; the latest session adds `--continue`. The permission and tool
profile is re-passed on every resumed invocation. When requested, `--autocompact <value>` is also
re-passed on every new, `--resume`, or `--continue` invocation rather than assumed to persist from an
earlier launch.

The relay never adds `--bg`: Claude documents background mode as incompatible with `-p`. It never adds
`--bare`, because bare mode skips `CLAUDE.md` and OAuth/keychain authentication.

It always passes `--setting-sources user`, so the repository's `.claude/settings.json` and
`.claude/settings.local.json` (hooks included) are not loaded. `--project-settings` passes
`--setting-sources user,project,local` instead, for a repository you trust. It is mutually exclusive
with `--read-only`, and `result.json` records it as `projectSettings`.

`--strict-mcp-config` without an MCP config prevents configured-server discovery. The inline settings
also disable Claude.ai connectors, while `--disallowedTools 'mcp__*'` denies any MCP tool that managed
policy still supplies. `--disable-slash-commands` prevents skill and command recursion, and `--tools`
omits the Agent tool. These controls do not suppress project `CLAUDE.md` or normal authentication.

Around the run, the relay keeps only absolute `PATH` entries (an empty or relative entry would
resolve inside the checkout). After the implementer exits it sends SIGKILL to everything left in the
implementer's process group, so a background process the brief started, such as a dev server
or a watcher, does not survive the run. A process that left the group (for example with `setsid`) is
not covered.

## Permission reach

### Normal write-capable profile

The normal profile pairs `acceptEdits` with sandbox auto-approval.
`acceptEdits` accepts file edits but does not, by itself, approve ordinary shell gates in a headless
run. `autoAllowBashIfSandboxed: true` approves commands that stay inside Claude's sandbox. A command
that cannot stay sandboxed fails instead of being retried outside it.

The generated `profile.json`:

- uses string rules to deny common direct shell forms of `git commit`, `git push`, and nested
  `claude`, plus any command containing `delegit-claude`; aliases, scripts, and wrappers can bypass
  these speed bumps, so the brief's no-commit instruction and orchestrator review remain the boundary;
- enables Claude's Bash sandbox with `failIfUnavailable: true`,
  `autoAllowBashIfSandboxed: true`, `allowUnsandboxedCommands: false`, and filesystem isolation
  explicitly enabled;
- disables Claude.ai connectors for every profile.

On supported platforms, the strict settings prevent a shell command from silently falling back to an
unsandboxed retry. Claude's sandbox covers **Bash and its child processes only**. Edit/Write remain
Claude Code tools governed by its permission system; the Claude process, your user-level hooks, inherited
configuration, and unrelated host processes are not enclosed in a universal workspace sandbox.

Claude merges some sandbox arrays across settings scopes. Existing managed or user allowlists (and
project or local ones, when you pass `--project-settings`) and `excludedCommands` can therefore affect the effective shell boundary, while managed
policy can further restrict or reject the run. Existing `ask` and `deny` permission rules take
precedence over sandbox auto-approval, so they can still stop a headless gate. Inspect both
`profile.json` and the effective local Claude configuration when the precise boundary matters. Use a
container or VM when only a host-level boundary is acceptable.

### Read-only profile

`--read-only` removes Edit, Write, Bash, Agent, MCP, skills, and commands from the child and
uses `plan` mode. Your user-level hooks still load outside that tool surface and can write. The relay compares
parsed `git status --porcelain -z -uall` and fingerprints working-tree identity and index entries for
paths that were already dirty on every outcome, including aborts:

- `readOnlyViolation: true` — either signal proves a Git-visible change. A commit or other ref move,
  a change to `.git/info/exclude` or `.git/info/attributes`, skip-worktree or assume-unchanged flags,
  and a changed Git setting that can run commands count as violations too.
- `readOnlyViolation: false` — coverage was complete and neither signal detected a change.
- `readOnlyViolation: null` — coverage was incomplete (an aborted run also reports `null` until the
  implementer is gone), for example because git could not report or a
  dirty submodule or unreadable path could not be fingerprinted.

This detects new dirt and changes to readable, already-dirty Git-visible paths, but cannot attribute a
concurrent change. Ignored paths, submodule internals, and writes perfectly restored before the final
snapshot remain outside coverage. Inspect the diff whenever read-only integrity matters.

### Permission bypass

`--dangerously-skip-permissions` passes Claude's flag and records
`permissionMode: "bypassPermissions"` unless the init event reports another value. The explicit tool
surface, commit/push deny rules, MCP/skill restrictions, and supported-platform shell sandbox remain.
However, direct file tools can cross ordinary Claude permission boundaries. This mode requires the
human's explicit acceptance.

## Artifacts

The default artifact directory is outside the repository so relay output does not pollute
`touchedFiles`. A caller-selected `--out-dir` inside the worktree will appear in git status. For a
meaningful `--read-only` review, keep artifacts outside the worktree. The fingerprint signal excludes
only the relay-owned artifact paths, so their later writes do not prove a violation.

- `brief.txt` — exact stdin brief.
- `events.jsonl` — raw stdout bytes from `--output-format stream-json`.
- `final.txt` — final `result` event's `result` text; absent when that text is empty (`finalPath` is
  then `null` in `result.json`).
- `stderr.txt` — complete stderr.
- `profile.json` — exact inline settings passed to Claude.
- `result.json` — stable result contract, written atomically.

## `result.json`

Core fields:

- `schema` — `"delegit-relay.result.v1"`.
- `tool` — `"claude"`.
- `status` — `completed` | `failed` | `timeout` | `aborted` | `claude_unavailable`.
- `exitCode` — Claude's code, `127` when missing, a signal-derived code when available, or a forced
  non-zero value when the watchdog or terminal error result makes a zero code non-successful.
- `signal` — terminating child/relay signal when reported, otherwise `null`.
- `claudeVersion` — version preflight text, `"unknown"` when the binary answered abnormally, or `null`
  when unavailable.
- `permissionMode` — selected profile, updated from `system/init` when present.
- `sessionId` — parsed defensively from init/result events; use with `--session`.
- `resultSubtype` — final result subtype, such as `success` or an error subtype.
- `finalMessage` — final result text.
- `numTurns`, `usage`, `totalCostUsd` — terminal result metadata when present.
- `touchedFiles` — final `git status --porcelain` lines for `--cd`; `null` means git could not report,
  while `[]` means git reported a clean tree. This is the whole final tree, not attribution.
- `gitError` — set when `touchedFiles` is `null`, with the reason. Besides a missing `git` or a
  `--cd` that was not inside a Git repository when the run started (a repository the implementer
  creates during the run is never consulted), it is set when a Git setting that can run commands
  (filters, diff drivers, `core.fsmonitor`, a hooks path, includes) changed during the run: the
  relay pins the repository before dispatch and then stops asking Git. Every relay `git` call runs
  with `core.fsmonitor` switched off, and the implementer inherits that setting.
- `readOnlyViolation` — present only on `--read-only`, with the three-state meaning above.

Run metadata includes `workdir`, `model`, `effort`, `maxTurns`, `maxBudgetUsd`, optional
`autocompact`, `timeout`, `readOnly`,
`resumed`, `resumeLast`, `toolSurface`, `shellSandbox`, `dangerouslySkipPermissions`, timestamps, and
all artifact paths. Failed, timed-out, and aborted runs include `stderrTail` when available;
launch/watchdog/signal failures include `error`.

`autocompact` records only the value the relay requested and passed in argv. It is absent when the
flag was omitted and is not proof that Claude Code applied or enforced the setting. On Claude Code older than 2.1.221 the launch fails with `unknown option '--autocompact'`; if a newer CLI rejects the value's range it fails at argument parsing. Either way the non-zero exit and stderr are preserved and the relay does not retry without the flag.

The relay prints a concise summary and the complete final report to stdout, then exits with
`result.json`'s `exitCode`.

## Waiting for completion

The relay blocks. Use the orchestrator's background-command facility or foreground it for short work.
If using a shell's own background feature, completion requires both:

1. the relay process has exited; and
2. `result.json` contains a terminal `status`.

A usage error exits 2 before creating `result.json`, so also observe process exit. A missing CLI is
different: it exits 127 **with** `status: "claude_unavailable"`.

## When a run misbehaves

- **`claude_unavailable`:** install Claude Code, authenticate with `claude auth login`, and verify the
  same PATH the orchestrator uses.
- **`failed`:** inspect `resultSubtype`, `error`, `stderrTail`, `stderr.txt`, and the tail of
  `events.jsonl`. Common causes are authentication, a model/effort mismatch, managed policy, a missing
  sandbox dependency, or a gate that needs access outside the strict shell boundary.
- **`timeout`:** the relay sent termination to the whole process group/tree and escalated. The working
  tree may contain partial edits; inspect it before resuming or re-dispatching.
- **`aborted`:** the relay caught SIGTERM, SIGINT, or SIGHUP, terminated the implementer tree, wrote an
  outcome, then refreshed `touchedFiles` after a grace window.
- **Host `SIGKILL`:** the relay cannot catch its own SIGKILL. If the child reports SIGKILL, investigate
  host memory or supervisor deadlines.
- **Empty `finalMessage`:** inspect the raw events and diff. Require a closing report in the next brief.

Never clean, reset, or switch branches before inspecting partial work, staged changes, and untracked
files.

## The commit boundary

The relay never commits — by design, not omission. Claude edits the working tree; the orchestrator
reviews, re-runs the gates, and commits. See [review-and-land.md](review-and-land.md).
