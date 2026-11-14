---
name: switchboard-queue
description: >-
  Run several coding tasks in parallel across implementer CLIs (Claude Code, Codex, Cursor,
  OpenCode and the other installed switchboard-* implementer skills), each in its own git worktree, with
  fallback to another lane when an implementer is missing, then review and land each result
  yourself. Use when the user wants multiple briefs dispatched at once, a batch or queue of
  delegated tasks, work split across several implementers, or a task that should fall back
  to a second implementer if the first is unavailable. Not for a single task with one known
  implementer: use that implementer's switchboard-* skill directly.
license: MIT
compatibility: Requires Node 18+, git 2.31+, and the implementer skills for every implementer a task names. Lanes require switchboard-setup.
metadata:
  version: 1.1.0
---

# Switchboard Queue

You are the **orchestrator**. This skill dispatches a batch of **briefs** in parallel, each to an
**implementer** chosen by **lane** or by name, and gives you one report to review. It never commits:
you review each task's diff, re-run the project's **gates**, and **land** what passes.

## When to use it

- Several independent tasks that can run at the same time (a feature, its tests, a doc update).
- The same kind of work spread over different implementers.
- A task that should **fall back** to a second lane or implementer when the first CLI is missing.

For one task with one known implementer, use that implementer's `switchboard-<cli>` skill directly.

## Workflow

1. **Write one brief per task.** Each brief is self-contained, as for any delegation: the
   implementer has none of your context. Tasks run in parallel, so they must not depend on each
   other's output.
2. **Commit or stash first.** Worktree tasks start from `HEAD`; uncommitted changes in the checkout
   are not in their worktrees. The queue warns when the checkout is dirty.
3. **Write the queue file** (`switchboard-queue.v1`), paths relative to the file:

   ```json
   {
     "version": "switchboard-queue.v1",
     "concurrency": 3,
     "tasks": [
       { "id": "billing", "brief": "briefs/billing.md", "lane": "feature", "fallback": ["bulk"] },
       { "id": "tests", "brief": "briefs/tests.md", "implementer": "codex", "args": ["--timeout", "45m"],
         "review": { "lane": "review" } },
       { "id": "review", "brief": "briefs/review.md", "lane": "review", "worktree": false }
     ]
   }
   ```

   - Each task names one target: a `lane` (configured with `switchboard-setup`) or an `implementer`
     key (`claude`, `codex`, `cursor`, `opencode`, `pi`, `omp`, `warp`).
   - `fallback` lists more targets; a string is a lane name, an object names `lane` or `implementer`.
   - `review` names a second implementer to cross-review the result: a lane string, `{"lane": ...}`
     or `{"implementer": ...}`. See Cross-review below.
   - `args` go to the relay unchanged. The queue owns `--brief`, `--cd`, `--out-dir` and `--lane`.
   - `worktree` defaults to `true`. Set it to `false` only for read-only tasks that must see the
     live checkout.
   - `id` names the task's branch (`switchboard/<run>-<id>`), so it must also be a valid git ref
     component: no `..`, no trailing `.` or `.lock`. Ids that differ only by letter case are
     refused, because branch and directory names collide by case on macOS and Windows.
4. **Run it** from the repository:

   ```bash
   node <skill-dir>/scripts/queue.mjs run queue.json --cd <repo>
   ```

   It prints one line per task and writes `queue-result.json`. Run it in the background for long
   batches and read the result file when it exits. Give every run a fresh `--out-dir` (or none, for
   a temporary one): a directory that already holds a run is refused.
5. **Review each task.** For a worktree task, inspect `git -C <worktree> status` and `git -C <worktree> diff`,
   read the task's `finalMessage` and its attempt's `result.json`, and re-run the gates inside the
   worktree. If the task has a `review`, read `review.findings` and the verdict too, but still do your
   own review: a second opinion is not a substitute for it. Land what passes on your branch, by merge or cherry-pick after committing in the worktree.
6. **Clean up** once the work is landed:

   ```bash
   node <skill-dir>/scripts/queue.mjs cleanup <out-dir>/queue-result.json
   ```

   Cleanup never forces: a worktree with uncommitted work, or a branch that is not merged, is kept
   and listed.

## Cross-review

A task with `review` gets a second implementer to look at its result before you do.

- **When it runs.** After the task completes, in the same worktree. A task that failed, timed out or
  was aborted is not reviewed.
- **The review brief.** The queue writes `tasks/<id>/review-<target>/review-brief.md`: the original
  brief, `git status --porcelain`, `git diff <baseCommit>` (capped at 200,000 characters, and lower
  for a reviewer whose relay passes the brief on the command line) and an instruction to end with
  `VERDICT: APPROVE` or `VERDICT: CHANGES_REQUESTED`.
- **Read-only.** The reviewer's relay runs with its `--read-only` flag. The relay reports `readOnlyViolation` on the review record where it
  can detect a write.
- **The verdict.** `approved` or `changes_requested`, read from the last line of the reviewer's
  final message that begins with `VERDICT:`. No such line, or a review that did not complete,
  gives `null`.
- **Queue status.** The queue is `completed` only when every task completed and every requested
  review approved. Otherwise it is `partial` and the exit code is 1, even though the task itself
  completed.
- **Who can review.** Any implementer whose relay has a read-only mode. `warp` has none, so it can
  be a queue task but not a reviewer; naming it in `review` is a usage error (exit 2) before
  anything runs.
- **If the repository's settings change.** The queue records the repository's hooks and its Git
  settings that can run commands (filters, diff drivers, `core.fsmonitor`, a hooks path, includes)
  before the first dispatch. If they change during the run, it skips the review diff (the review
  brief says so) and refuses to create new worktrees. Inspect the working tree directly.

The verdict is the reviewer's opinion, not a gate. Read the findings, then review the diff and
re-run the gates yourself before you land.

## Fallback rules

The next target is tried only when the previous one was **never dispatched**: its CLI is missing
(`*_unavailable`) or its version preflight failed. A run that started and then failed, timed out,
or stalled is **not** retried, because it may already have changed files. Inspect it, then decide.

## Reading the result

`queue-result.json` (`switchboard-queue.result.v1`) holds:

- `status`: `completed`, `partial`, `failed`, or `aborted`;
- `baseCommit` and `baseDirty`;
- per task: `status`, the `attempts` made (target, status, `resultPath` of each relay result),
  `worktree` (`path`, `branch`), `touchedFiles`, `finalMessage`, `tokens`, `totalCostUsd`, and
  `readOnlyViolation` where the relay reports one, and `review` when one was requested and the task
  completed: `target`, `implementer`, `status`, `verdict` (`approved`, `changes_requested` or
  `null`), `findings` (the reviewer's final message), `readOnlyViolation`, `tokens`,
  `totalCostUsd`, `briefPath` and `resultPath`;
- `totals`: task counts, `reviewed` and `approved` review counts, and summed tokens and cost where
  the implementers report them (reviews included).

Exit code 0 means every task completed and every requested review approved; 1 means at least one did not; 2 is a usage error before any
run. Stopping the queue (SIGTERM or Ctrl-C) stops every running relay: on macOS and Linux each
relay records its own `aborted` result; on Windows, which has no catchable SIGTERM, the queue
terminates each relay's process tree and records the abort itself (the attempt has no
`resultPath`). Unstarted tasks are marked `skipped`.

## Trust

`queue.mjs` uses Node built-ins only and makes no network calls of its own. Its `git` calls run with
`core.fsmonitor` switched off, and it keeps only absolute `PATH` entries. It runs `git` and the
sibling relays, and it reads lanes through `switchboard-setup`. It never commits or pushes, and the
only removal it forces is of a worktree whose creation failed before any implementer ran, so the
next run can create it again.
