# Contributing

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Two people have independently built the same implementer skill twice now. Both times someone's work was
wasted. So: **claim an implementer before you build it**, and check the open pull requests first.

[Open claims](https://github.com/0xBassia/Switchboard/issues?q=is%3Aissue+label%3Aimplementer) · [Open pull requests](https://github.com/0xBassia/Switchboard/pulls)

## What counts as an implementer skill

Four invariants hold for every skill here, and they are the bar for a new one:

- **A separate CLI edits a real working tree, and the diff is the deliverable.** Not an API wrapper,
  not a hosted gateway — an implementer whose work is reviewable with `git diff`. If there is no
  working tree to review, it does not belong here.
- **The relay never commits.** Committing belongs to the reviewer.
- **Node built-ins only.** No dependencies, no network calls of its own, no credentials read or
  written, no telemetry. The relay launches its implementer CLI and `git`, never through a shell.
- **Autonomy is stated in the CLI's own terms**, and whatever it cannot enforce is said plainly. A
  CLI with no read-only mode is mergeable; a skill that implies it has one is not.

## Merge checklist for a new skill

- [ ] `skills/switchboard-<name>/SKILL.md` — a `description` that triggers on delegation to that CLI and
      nothing else, plus `compatibility:` naming the binary and its auth step.
- [ ] Four `references/*.md`: `writing-the-brief`, `dispatch-and-poll`, `review-and-land`,
      `multi-task-queues`. Not three, not five — the shape is the contract.
- [ ] One `scripts/relay.mjs`, generated from `src/adapters/<name>.mjs` by `node tools/build.mjs`; Node built-ins only, and it never commits.
- [ ] `result.json` speaks `switchboard-relay.result.v1`: `status`, `exitCode`, `signal`, the final
      report, `touchedFiles` (`null` when git cannot report, with a `gitError` string saying why; `[]` when the tree is clean), and a
      session id where the CLI exposes one.
- [ ] Usage errors exit 2 before writing a result file; a missing binary exits 127 **with** one.
- [ ] Registered in `test/harness/constants.mjs` — the new relay enters the timeout and abort matrix like
      every sibling. The suite fails if a skill directory is missing from that matrix, is short a
      reference, or is absent from `skills.sh.json`, so this one checks itself.
- [ ] A row in the README table, and a vocabulary row in `AGENTS.md` using that CLI's own terms.
- [ ] An entry in `skills.sh.json`.
- [ ] A verification line in the README's **Verification status** list. Claim only what you ran —
      "contract-tested, live run pending" is a mergeable answer. "Verified" without a run is not.

## Utility skills (exception)

`switchboard-setup` is a **utility** skill: it configures fleet **lanes** (discover → propose → approve →
write). `switchboard-queue` runs a batch of briefs in parallel through the
installed sibling relays, each in a git worktree, with fallback to another lane or implementer when a
CLI is missing; it never commits. Neither is an implementer skill.

Utility checklist (instead of the four-references + `relay.mjs` bar above):

- [ ] `skills/<name>/SKILL.md` with a `description` that triggers on its specific support function, not selection of an implementer.
- [ ] JavaScript under `scripts/` uses Node built-ins only, under the trust line described in `AGENTS.md`.
- [ ] No `relay.mjs`; setup does not dispatch, and the queue only drives the installed sibling relays.
- [ ] Registered in `skills.sh.json` (Setup grouping is fine, or its own grouping such as Queue).
- [ ] Listed in the smoke suite's **utility** carve-out (not the implementer timeout/abort matrix).
- [ ] A short README mention and utility scope in `AGENTS.md`.
- [ ] `switchboard-queue` changes: run `node --test test/queue.test.mjs` (fake implementer CLIs, temporary
      git repositories and HOME only).

Do not invent a second utility that duplicates lane setup. Extend `switchboard-setup` instead.

## Releases

Install pinning uses **git tags**, not `metadata.version` alone:

1. Land the release on `main`.
2. Set every skill's `metadata.version` to the release semver (e.g. `1.0.0`).
3. Create an annotated tag: `git tag -a v1.0.0 -m "v1.0.0"` and `git push origin v1.0.0`.
4. Users install with `npx skills add 0xBassia/switchboard@v1.0.0`.

Bump the tag for user-visible skill or relay contract changes. Docs-only or smoke-only may be a
patch. Schema ids (`switchboard-fleet.v1`, …) bump independently when the JSON shape breaks.

## Everything else

Fixes to a relay, a reference, or the README need no claim. Keep the diff to one concern, run
`node test/relay-smoke.mjs` and `npx skills add . --list`, and say in the pull request what you ran.
For a single relay or concern during development, `node test/relay-smoke.mjs --only codex` (comma-separated
module names — see `test/relay/index.mjs`) skips the rest of the matrix.
A changed relay also wants a direct run — `--help` plus a read-only or no-write run against a
throwaway repo. The full pre-publish list is in [AGENTS.md](AGENTS.md).

To back a "Verification status" line with a real run, use `node tools/verify-live.mjs`. It finds the
implementer CLIs installed on your machine and prints its plan; add `--run` to dispatch (this spends
real tokens on your accounts, so pass a cheap model, e.g. `--arg claude=--model=haiku`). Each CLI gets
a read-only and a write check in a throwaway repository, and the README-ready lines land in
`verification/`. Commit the JSON record with the README change.

Before changing completion detection or `touchedFiles`, read the relevant skill's result contract.
Exercise clean, pre-dirty, same-dirty-path, dirty-submodule, and git-unavailable worktrees, and assert
the exact `switchboard-relay.result.v1` fields instead of generic success or failure.

## Relay sources

Never edit a `skills/switchboard-*/scripts/relay.mjs` by hand: each one is generated. Behavior shared by
every relay (flag intake, lanes, artifacts, preflight, the watchdog, signal handling, `result.json`) lives
once in `src/core/`. What is specific to one CLI (its flags, version probe, launch, event parsing) lives
in `src/adapters/<name>.mjs`. Edit the source, then run `node tools/build.mjs` and commit the regenerated
relays together with the source. `node tools/build.mjs --check` (in CI) fails on any stale relay.
[src/README.md](src/README.md) has the adapter contract and the guarantees core owns.

A fix in `src/core/` reaches every relay at once, so run the whole `node test/relay-smoke.mjs`
and `node --test test/core.test.mjs`. A new implementer is one adapter file plus its skill
directory.

Supported platforms are macOS, Linux and WSL; native Windows is not supported (use WSL). Every
relay, the queue and the setup scripts refuse native Windows with exit 2, so do not add Windows
code paths (shell launches, `.cmd` shims, `taskkill`) back.

## Review

One maintainer reviews these and reads the relay line by line. Expect questions about anything the
verification line claims.

Automated reviewers such as CodeRabbit, Codex, and Greptile are advisory. If one is unavailable,
rate-limited, or silent, record that and continue; do not wait or retry. Required project gates plus
maintainer review determine readiness.

Where two pull requests cover the same implementer, this checklist decides — the one that satisfies
more of it merges. Ties break on verification evidence, then on the earlier claim. The other pull
request's distinct improvements get pulled in and credited by number in the commit that lands them.

House rules, the controlled vocabulary, and the pre-publish checklist are in
[AGENTS.md](AGENTS.md) — read it before opening a pull request, and point your agent at it too.
