# Dispatch and poll

`scripts/relay.mjs` wraps Cursor's headless print mode (`cursor-agent -p`), captures its structured
stream, and writes a `result.json`. Run one command, then read one file.

## Before the first run

```bash
command -v cursor-agent
cursor-agent --version
cursor-agent status
```

Follow the installer for your platform at [cursor.com/cli](https://cursor.com/cli), inspect what it
will run, then authenticate with `cursor-agent login`.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

`<skill-dir>` is the installed folder containing this skill's `SKILL.md`.

| Flag | Effect |
| --- | --- |
| `--brief <file>` | Brief path. Omit it to read the brief from stdin. |
| `--cd <dir>` | Working root and child process cwd (default: current directory). |
| `--lane <name>` | Fleet lane from `delegit-setup` config. Applies that lane's dials; fails if the lane's `implementer` is not this relay. Explicit dial flags win. |
| `--model <name>` | Cursor model for this run (default: your Cursor default, usually `auto`). Names come from `cursor-agent models`. |
| `--read-only` | Run in Cursor's plan mode: read-only analysis, no edits, no `--force`. |
| `--sandbox <mode>` | Override Cursor's sandbox for this dispatch: `enabled` or `disabled`. |
| `--no-force` | Keep the run write-capable but withhold `--force`; commands requiring approval are refused. |
| `--session <id>` | Resume a specific Cursor chat (`--resume <id>`); send only the delta brief. |
| `--resume-last` | Resume the most recent Cursor chat (`--continue`); send only the delta brief. |
| `--add-dir <dir>` | Add an extra workspace root on Cursor `2026.07.23` or newer. Repeatable. Edits there are not reported in `touchedFiles`. |
| `--timeout <dur>` | Relay watchdog (default: `30m`; h/m/s strings). cursor-agent has no timeout flag. |
| `--out-dir <dir>` | Artifact directory (default: a fresh directory under the system temp dir). |
| `-h`, `--help` | Print the relay's header help. |

`--session` and `--resume-last` are mutually exclusive. The child cwd pins the primary workspace;
`--add-dir` adds extra workspace roots only.

A fresh run defaults to write-capable with `--force` (commands run without approval unless your
Cursor config denies them). `--no-force` withholds automatic command approval while retaining file
edits; `--read-only` switches to plan mode instead. The relay always passes `--trust` so a headless
run never stalls on the workspace-trust prompt — point `--cd` only at repositories you trust.

## Artifacts and result fields

Artifacts live outside the repo by default, so they do not appear in `touchedFiles`; an `--out-dir`
inside the worktree can make the artifacts appear there:

- `brief.txt` — the exact brief.
- `events.jsonl` — raw cursor-agent stdout events.
- `final.txt` — the final report; absent if none was emitted.
- `stderr.txt` — complete stderr.
- `result.json` — the stable `delegit-relay.result.v1` contract.

`result.json` fields:

- `schema`, `tool` (`"cursor-agent"`), `status` (`completed` | `failed` | `timeout` | `stalled` |
  `aborted` | `cursor_agent_unavailable`), `exitCode`, and `signal` (`null` unless the child died on a signal).
- `workdir`, `model` (the requested name or `null`), `resolvedModel` (the model Cursor actually
  served, from its init event), `permissionMode` (the mode Cursor reported applying), `readOnly`,
  `force`, `sandbox` (the requested value or `null`, not a claim about what Cursor applied),
  `stallTimeout` (the `--stall-timeout` you passed, or `null`),
  `resumed`, `cursorAgentVersion`, `sessionId`, `startedAt`, and `finishedAt`.
- `briefPath`, `finalPath`, `eventsPath`, and `stderrPath`.
- `finalMessage` — the `result` field of Cursor's closing event; when the run died before emitting
  one, the assistant text chunks joined with `"\n\n"` instead. Tool calls and tool results are
  excluded.
- `touchedFiles` — `git status --porcelain` lines for the **final working tree under `--cd` only**,
  not an attribution of Cursor's edits: anything already dirty before dispatch shows up too, and
  edits Cursor makes inside `--add-dir` roots do not show up at all — inspect those trees yourself.
  Dispatch from a clean tree when you want the list to read as "what Cursor changed". `null` means
  git could not report; `[]` means git ran and the tree is clean.
- `gitError` — set when `touchedFiles` is `null`, with the reason. Besides a missing `git` or a
  `--cd` that was not inside a Git repository when the run started (a repository the implementer
  creates during the run is never consulted), it is set when a Git setting that can run commands
  (filters, diff drivers, `core.fsmonitor`, a hooks path, includes) changed during the run: the
  relay pins the repository before dispatch and then stops asking Git. Every relay `git` call runs
  with `core.fsmonitor` switched off, and the implementer inherits that setting.
- `usage` — Cursor's token-usage object from the closing result event, or `null` if no result event
  supplied one.
- `stderrTail` — the last 20 non-empty stderr lines on any run that did not complete (`failed`,
  `timeout`, `stalled`, `aborted`), except a launch failure, which reports `failed` with no `stderrTail`.
- `error` — present for launch failures, when the relay watchdog fires (`timeout`) or the stall
  watchdog fires (`stalled`), on an `aborted`
  run, and when Cursor's own result event carries `is_error: true`.

## Waiting for completion

The relay blocks. Use the orchestrator's background-command facility, or background it in a shell
and poll for `result.json`. The run is done only when the process exits and the file contains a
`status`.

A pre-run usage error exits 2 and writes no result. A missing `cursor-agent` exits 127 and writes
`status: "cursor_agent_unavailable"`.

## When a run misbehaves

- **`status: "cursor_agent_unavailable"` (exit 127):** install the Cursor CLI, authenticate with
  `cursor-agent login`, and re-dispatch.
- **`status: "failed"`:** read `stderrTail`, `stderrPath`, and the tail of `events.jsonl`. If the
  result event carried `is_error: true` the relay reports `failed` even on a zero exit; Cursor's own
  message is in `finalMessage`. An unknown `--model` name fails fast — re-check against
  `cursor-agent models`.
- **A version-preflight failure:** the relay writes `failed` with the probe's exit code, or `timeout`
  with exit 124 when the probe exceeds the smaller of the run watchdog and 10 seconds. Cursor is not
  dispatched.
- **`status: "aborted"`:** the relay itself was killed (its parent's timeout, a stopped task, a
  closed terminal) and forwarded the kill to cursor-agent. The result is written before the relay
  exits; inspect the working tree before re-dispatching.
- **`status: "failed"` with `signal: "SIGKILL"`:** the host killed the process, commonly through the
  OOM killer or a supervisor timeout. This is not a Cursor error; check host memory and re-dispatch,
  or split the task into smaller briefs.
- **`status: "timeout"`:** the `--timeout` watchdog killed the run; `error` reads
  `cursor-agent did not finish within --timeout <dur>; killed by the relay watchdog`. Increase
  `--timeout` or split the task. The relay sends SIGTERM, waits 10 seconds, then sends SIGKILL if
  needed.
- **`status: "stalled"`:** `--stall-timeout` was passed and cursor-agent emitted nothing for that
  long while no tool call was in flight; the relay killed it the same way as `timeout`. Observed on
  Linux with `cursor-agent` 2026.10.01-e373342 (`composer-2.5`): after finishing its edits and gates
  the agent emitted `thinking` `completed`, then never streamed its final message and never exited,
  so without this the run sat until `--timeout`. The clock restarts on every stdout/stderr chunk and
  pauses between a `tool_call` `started` and its `completed` (a long test run streams nothing in
  between), so a slow command does not trip it. Inspect the working tree, then resume the session
  (`--session <id>`) with a delta brief asking it to finish and report.
- **Empty `finalMessage`:** inspect `touchedFiles` and the diff. Add a
  `<structured_output_contract>` to the next brief to require a closing report.

## Recovering lost work

`events.jsonl` in the run directory records every event the implementer streamed. If finished
work is lost — the run killed late, or the working tree damaged afterward — read the event log
before re-dispatching: it identifies which files and tool commands were involved, which scopes
what needs redoing. Whether it also carries the edit contents depends on what the CLI streams,
so treat any reconstruction as unverified until it matches a working-tree diff — when the tree
still holds the work, preserve the tree rather than replaying the log.

## What the relay runs

The argv is equivalent to:

```bash
cursor-agent --print --output-format stream-json --trust \
  [--force | --mode plan] [--sandbox enabled|disabled] [--model <name>] \
  [--resume <id> | --continue] \
  [--add-dir <dir> ...]   # brief on stdin
```

`--no-force` omits both `--force` and `--mode plan`; the run can edit files, but approval-gated
commands are refused.

The brief rides stdin, so it is not visible in the host process list and has no OS argument-size
cap. No shell runs; sandbox, model, and session values are validated before they ride argv.

Around the run, the relay keeps only absolute `PATH` entries (an empty or relative entry would
resolve inside the checkout). After the implementer exits it sends SIGKILL to everything left in the
implementer's process group, so a background process the brief started, such as a dev server
or a watcher, does not survive the run. A process that left the group (for example with `setsid`) is
not covered.

## The commit boundary

The relay never commits — by design, not omission. Cursor edits the working tree; the orchestrator
reviews, re-runs the gates, and commits. See [review-and-land.md](review-and-land.md).
