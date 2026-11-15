# Multi-task queues

The single-task loop scales to a queue, and that is where delegation pays off most — a removal split
across layers, a migration touching many files, a refactor sweep. The discipline that makes a queue
trustworthy is sequencing and bookkeeping, not parallelism.

## Run sequentially, one commit per task

Dispatch one task at a time in dependency order. Review, run gates, and land it before dispatching the
next:

```bash
node "<skill-dir>/scripts/relay.mjs" --brief task-01.txt --cd /path/to/repo
```

- Later tasks can rely on earlier behavior only after it lands.
- One reviewed commit per task keeps rollback and history clear.
- A clean tree before each dispatch makes `touchedFiles` useful.

Use parallel dispatches only for genuinely independent tasks in separate working trees. Multiple
implementers editing one tree destroy attribution and make the review boundary unreliable.

## Carry decided constraints forward

Implementation surfaces facts the original plan did not have: a helper got named, a fixture lives in
a specific place, an interface was chosen. When a later task depends on one of those, **fold it into
that task's brief** as an explicit line. A fresh Claude session has no memory of the earlier run, so a
constraint that emerged in task 2 must be restated in task 5's brief or it will not hold. This is
the queue equivalent of keeping briefs self-contained.

Each unrelated queue item should start a new Claude session. Use `--resume-last` or `--session <id>`
only for rework on the same task; send a delta brief.

Claude Code will discover `CLAUDE.md`, but it does not generically auto-load `AGENTS.md`. Carry the
applicable `AGENTS.md` constraints into every brief rather than assuming the first session established
them for later sessions.

## Keep a progress file

For more than two or three tasks, maintain one durable progress file:

- **Status:** queued / dispatched / reviewed+landed, including the commit hash.
- **Per-task review:** what landed, what was inspected, and gate outcomes.
- **Needs your eyes:** design decisions, non-blocking concerns, and questions for the human.
- **Session/artifact pointers:** the task's `sessionId` and `result.json` path for rework or diagnosis.
- **End-of-run gates:** the final cross-task verification still required.

Update it when each task lands, not in one batch at the end.

## Close with a coherence check

Per-task review proves each step in isolation; it does not prove the steps cohere. After the last task,
verify the whole:

- Run the full test/build once more on the final tree — not just the last task's slice.
- Do a repo-wide check for the thing the queue was about (e.g. after a removal, grep the entire tree
  for any surviving reference; after a rename, confirm no stragglers).
- For schema work, replay all the new migrations from a clean state and check for drift.
- Then push and open or update the PR, with a description that reflects what actually shipped.

## When to stop and ask

Proceed on work that follows from the agreed plan. Stop and surface when:

- a task cannot be completed correctly within its brief;
- review calls the plan itself into question;
- a gate reveals a problem in an already-landed task;
- the next task requires a permission or host-boundary change the human did not approve.

Report what has landed, commit hashes, the current tree state, and the open question, then wait.

## Parallel batches

For independent tasks, the `delegit-queue` skill dispatches several briefs in parallel, each in its own
git worktree, and gives you one report to review. Dependent steps still run in order with this skill
alone, as above. A queue task that targets Claude:

```json
{"id": "example-task", "brief": "briefs/example-task.md", "implementer": "claude"}
```
