# Multi-task queues

The single-task loop scales to a queue, and that is where delegation pays off most — a removal split
across layers, a migration touching many files, a refactor sweep. The discipline that makes a queue
trustworthy is sequencing and bookkeeping, not parallelism.

## Run sequentially, one commit per task

Dispatch one task, review it, rerun its gates, and land it before the next:

```bash
node "<skill-dir>/scripts/relay.mjs" --brief task-01.txt --cd /path/to/repo
```

- Later briefs can rely on earlier work only after it lands.
- One commit per task keeps review and rollback bounded.
- A clean tree makes `touchedFiles` useful.
- Parallelize only genuinely independent tasks in separate worktrees.

## Carry decided constraints forward

Fresh Qoder sessions do not remember earlier tasks. If task 2 chooses a helper name, fixture
location, or interface that task 5 needs, write that fact into task 5's brief.

Resume only for rework on the same task. Send a delta with `--resume-last` or `--resume <id>` from that
task's `result.json`. Start unrelated items in fresh sessions.

## Keep a progress file

For more than two or three tasks, track:

- queued / at-implementer / reviewed+committed status and commit hash;
- per-task review notes and gate outcomes;
- design choices and questions needing human review;
- the final cross-task verification.

Update it after every landed task.

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

- A task cannot be completed correctly within its brief.
- Review calls the plan itself into question.
- Gates reveal a problem affecting already-landed tasks.

Report the landed state, commit hashes, and open question, then wait.

## Parallel batches

For independent tasks, the `delegate-queue` skill dispatches several briefs in parallel, each in its own
git worktree, and gives you one report to review. Dependent steps still run in order with this skill
alone, as above. A queue task that targets Qoder:

```json
{"id": "example-task", "brief": "briefs/example-task.md", "implementer": "qoder"}
```

Qoder can be a queue task but not a reviewer: its relay has no read-only mode, so naming it in a task's `review` is a usage error.
