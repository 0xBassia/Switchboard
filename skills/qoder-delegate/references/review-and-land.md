# Review and land

Qoder did the typing; the orchestrator owns the judgment. Verify reality, not the self-report.

## Check tests before trusting gates

- Treat unbriefed test edits as contract changes.
- Treat skipped, disabled, or commented tests as failures.
- Treat loosened assertions as weakened gates.

## Re-run the gates yourself

`finalMessage` contains Qoder's claims. Run the repository's actual test, lint, typecheck, and build
commands yourself. For specialized changes:

- Round-trip migrations and schemas.
- Search for dangling references after removals and renames.
- Exercise stateful behavior, not only compilation.

## Read the diff against the brief

Start with `touchedFiles`, then read the full diff for:

- **Scope creep** — excluded changes.
- **Scope shortfall** — missing behavior or cleanup.
- **Quiet decisions** — defensible but unasked choices requiring review.

`touchedFiles` is final tree state, not attribution. Start clean when possible and inspect every
`--add-dir` workspace separately.

## The implementer sweep

Look for hardcoded success data, swallowed errors, nonexistent dependencies or APIs, dead helpers,
duplicate patterns, tests that assert internals, speculative options, and guards that hide missing
trust-boundary validation. Run your own review skills if installed.

## Rework: send the delta

Continue the same session with only the correction:

```bash
echo "Keep the fix, replace the mocked DB assertion with the real migrated fixture, remove the unused import, and rerun the stated gates." |
  node "<skill-dir>/scripts/relay.mjs" --resume-last --cd /path/to/repo
```

Use `--resume <id>` for the specific `sessionId` in `result.json`. Rework receives the same independent
gate and diff review.

## The commit boundary

When the gates pass and the diff holds, **the orchestrator commits**, never the implementer. Write a
clear message describing what landed. Qoder must never run `git add` or `git commit` for this
workflow.

From dispatch until that commit, the uncommitted working tree is the authoritative copy of the
implementer's work — the only one you can commit from, and often the only copy at all. Never run
`git checkout`, `reset`, `clean`, or a branch switch in the workspace between those two points —
however messy an interrupted run looks, inspect it first: `git status`, `git diff`,
`git diff --cached` for anything the implementer staged (plain `git diff` is blind to the index), and open any
untracked files (`??` in `git status`) directly — they are the implementer's new files, and no diff
shows their contents. The tree is evidence, not clutter. After that inspection the verdict can
legitimately be to discard — work built on a premise you have since corrected, for example — and
then `git checkout`/`clean` is the right tool. The ban is on reflexive cleanup before anyone has
looked.

## Surface, do not absorb

- Report Qoder's design decisions and defensible deviations.
- Note non-blocking issues you did not block on.
- Stop and ask when correct completion requires expanding the brief.

For a queue, keep these notes in the progress file described in
[multi-task-queues.md](multi-task-queues.md).
