# Multi-task queues

The single-task loop scales to a queue, and that is where delegation pays off most — a removal split
across layers, a migration touching many files, a refactor sweep. The discipline that makes a queue
trustworthy is sequencing and bookkeeping, not parallelism.

## Run sequentially, one commit per task

Run tasks **one at a time, in dependency order**, landing each after review and gates before
dispatching the next:

```bash
node "<skill-dir>/scripts/relay.mjs" --brief task-01.txt --cd /path/to/repo
```

- Later briefs can rely on earlier work only after it lands.
- One commit per task keeps history reviewable and each step revertible.
- A clean tree before each dispatch keeps `touchedFiles` honest.

Use parallel runs only for genuinely independent tasks in separate working trees. Sequential is
the default because it preserves clean task boundaries.

## Carry decided constraints forward

Fresh Oh My Pi sessions do not remember earlier tasks. If task 2 chooses a helper name, fixture
location, or interface that task 5 needs, write that fact into task 5's brief.

Use a resumed Oh My Pi session only for rework on the same task. Send a delta brief with
`--resume-last`, or with `--session <id>` from that task's `result.json`. Start unrelated queue
items in fresh sessions.

## Keep a progress file

For more than two or three tasks, maintain one progress file beside the work:

- **Status table** — queued / at-implementer / reviewed+committed, with the commit hash.
- **Per-task review notes** — what landed, what you verified, and gate outcomes.
- **Needs your eyes** — design decisions, non-blocking nitpicks, and questions for the human.
- **End-of-run checklist** — the final cross-task verification.

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

- A task cannot be completed correctly within its brief.
- Review calls the plan itself into question.
- Gates reveal a problem affecting already-landed tasks.

Report the landed state, commit hashes, and open question, then wait.

## Parallel batches

For independent tasks, the `switchboard-queue` skill dispatches several briefs in parallel, each in its own
git worktree, and gives you one report to review. Dependent steps still run in order with this skill
alone, as above. A queue task that targets Oh My Pi:

```json
{"id": "example-task", "brief": "briefs/example-task.md", "implementer": "omp"}
```
