# Working on Delegit

This repo is a [Skills CLI](https://github.com/vercel-labs/skills) package of **delegation skills** —
skills that let an orchestrating agent drive a separate CLI coding agent as an implementer, then review
and land the result. Seven implementer skills ship today: `delegit-claude` (Claude Code),
`delegit-codex` (OpenAI Codex), `delegit-cursor` (Cursor Agent CLI), `delegit-opencode`
(OpenCode), `delegit-pi` (Pi CLI), `delegit-omp` (Oh My Pi), and `delegit-warp` (Warp Agent
CLI); more can be added later without renaming the repo. Two **utility** skills ship alongside them:
`delegit-setup` (configure fleet lanes — setup only, never dispatches) and `delegit-queue` (run a
batch of briefs in parallel through the sibling relays, each in a git worktree, with lane/implementer
fallback).

## Vocabulary

One controlled vocabulary keeps the docs from drifting and stops edits (human or AI) from coining new
jargon. Use these terms; don't invent synonyms.

| Use | For | Not |
| --- | --- | --- |
| **delegate** / **delegation** | the activity, and this skill family | "relay" (as the activity), "hand-off", "offload" |
| **orchestrator** | the driving agent (Claude Code, …) | "controller", "driver" |
| **implementer** | the separate agent (Claude, Codex, OpenCode, Cursor, Pi, Oh My Pi, Warp) | "worker", "sub-agent", "executor" |
| **brief** | the self-contained task spec sent to the implementer | "task file", "the prompt", "the spec" |
| **gates** | the project's test/lint/build commands | "checks", "CI" |
| **dispatch** | sending the brief to the implementer | "fire off", "kick off" |
| **land** | commit the verified work yourself | — |
| **relay** / `relay.mjs` | the dispatch **script** only | never a *category* of skills |
| **lane** | a named fleet binding: implementer + optional dials (`model`, `effort` / `variant`, …) | "route", "profile" |
| **fleet** | the user's set of lanes (which CLI handles which kind of work) | — |
| **setup skill** / `delegit-setup` | utility that discovers CLIs and writes the lane map after approval | an implementer skill |
| `exec`, `sandbox`, `resume`, `session`, `subagents` | Codex's own terms — use verbatim | don't paraphrase them; never use `subagents` as a generic synonym for implementer |
| `run`, `agent` (`build`/`plan`), `session` | OpenCode's own terms — use verbatim | "sandbox" (OpenCode has no sandbox enum; autonomy is the agent) |
| `session`, `--continue`, `--resume`, `plan mode`, `--force`, `--sandbox` (`enabled`/`disabled`), `--trust`, `models` | Cursor Agent's own terms — use verbatim when discussing `cursor-agent` | don't paraphrase them |
| `session`, `--continue`, `--resume`, `permission mode` (`acceptEdits`/`plan`/`bypassPermissions`), `sandbox`, `subagents`, `agent teams`, `background sessions` | Claude Code's own terms — use verbatim when discussing Claude | never use `subagents` as a generic synonym for implementer |
| `agent run`, `conversation` / `--conversation`, `run_id`, `run_url`, `--cwd`, `--output-format ndjson`, `--profile`, `--skill`, `--no-snapshot`, `run-cloud` | Warp Agent CLI's own terms — use verbatim when discussing `oz` | never call `oz` "the warp CLI" in a launch context — `warp` is the interactive TUI and cannot be relayed; don't invent a Warp sandbox or permission-mode enum (`oz agent run` has neither) |
| `session`, `--continue`, `--session`, `print mode`, `--mode json`, `tools`, `context files`, `project trust` | Pi's own terms — use verbatim when discussing `pi` | don't paraphrase them |
| `session`, `--continue`, `--resume` / `--session`, `--print`, `--mode json`, `omp models`, `--thinking`, `approvalMode` (`always-ask`/`write`/`yolo`), `--yolo` / `--auto-approve`, `--tools`, `--no-extensions` / `--no-skills` / `--no-rules`, `--max-time`, `--profile` | Oh My Pi's own terms — use verbatim when discussing `omp` | never call `omp` "pi" in a launch context — `pi` is a different CLI (`delegit-pi`); don't invent an omp sandbox enum; `--yolo` is `tools.approvalMode: yolo`, not a permission-mode enum |

Banned on sight: coined umbrella terms in user-facing surfaces (README headings, `skills.sh.json`
titles); any reference to the author's local machine or config; model/version pins (`GPT-5.x` →
version-neutral) everywhere except the README's "Verification status" list, where the exact CLI
version a run was made against is what makes the claim checkable; and claims that can't be verified
("verified" without a run → hedge or cut). Every
CLI flag, field, and command in the docs must match the installed implementer CLI (`claude` /
`codex` / `opencode` / `cursor-agent` / `pi` / `oz` / `omp`) and the skill's `relay.mjs`.

## Conventions

- **One skill per directory** under `skills/<name>/`, each with a `SKILL.md` plus optional
  `references/` and `scripts/`. Implementer skills are named `delegit-<cli>` (the repo is the
  prefix; the target agent is the suffix).
- **Utility skills** (`delegit-setup` and `delegit-queue`) are the exception to the implementer
  shape: they are not `delegit-<cli>` implementer skills, they do not ship `scripts/relay.mjs` or the four
  brief/dispatch/review/queue references. `delegit-setup` never dispatches coding work;
  `delegit-queue` drives the installed sibling `delegit-<cli>/scripts/relay.mjs` relays in parallel (it
  has no relay of its own). Their JavaScript uses Node built-ins only. No network of their own,
  credentials, or telemetry. Document any new utility in `CONTRIBUTING.md` and register it in
  `skills.sh.json` and the smoke suite's utility carve-out.
- **`SKILL.md` frontmatter:** `name` (must equal the directory), `description`, and optionally
  `license`, `compatibility`, `metadata.version`, `allowed-tools`. The **`description` is the only
  triggering signal** — keep it to what the skill does and when to use it, phrased to trigger reliably.
  Provenance, status caveats, and how-it-works detail go in the body or here, never in the description.
  Keep `description` **under 1024 characters** — some orchestrators hard-cap it and reject
  the skill otherwise.
- **Package versioning:** release with an annotated git tag `vMAJOR.MINOR.PATCH` on `main`. Bump
  every skill's `metadata.version` to the same semver in that release (informational only — installers
  pin via `@v…`, not frontmatter). Wire/schema ids (`delegit-fleet.v1`, `delegit-relay.result.v1`)
  are separate; bump those only when the JSON contract breaks.
- **Progressive disclosure:** keep `SKILL.md` lean; push depth into `references/*.md` that load only
  when needed.
- **Executables:** keep them minimal and inspectable. Each implementer skill has one
  `scripts/relay.mjs`, **generated** by `node tools/build.mjs` from `src/adapters/<name>.mjs` plus the
  shared engine in `src/core/` (see `src/README.md`). Never hand-edit a generated relay: change the
  source, rebuild, and commit both; CI runs `node tools/build.mjs --check`. Utility skills may ship other scripts (e.g. `discover.mjs`, `config.mjs`, `queue.mjs`) under
  the same trust line: JavaScript uses Node built-ins only, no package dependencies, no network calls of their own, no
  credentials, no telemetry. `queue.mjs` drives sibling relays and runs `git worktree` / `git branch`
  (cleanup removes only unmodified worktrees and merged branches, never forced), but never commits.
  The README's trust section must stay accurate.

## Before publishing a change

- Validate the package locally: `npx skills add . --list`.
- Rebuild relays after any `src/` change: `node tools/build.mjs`, then `node --test test/core.test.mjs`.
- Smoke-test any changed script directly (e.g. `node skills/<skill>/scripts/relay.mjs --help`, and a
  no-write or read-only run against a throwaway repo) before relying on it.
- Supported platforms are macOS, Linux and WSL; native Windows is not supported (use WSL), and every
  entry point refuses it with exit 2. Do not add Windows code paths back.
- If you touch how a `relay.mjs` launches its implementer CLI, keep it shell-free: every relay spawns
  its CLI directly with an argv array, and all value flags are token-validated. The `oz` launch matters
  most: `oz agent run` takes the brief as its `--prompt` argv value (its `-f/--file` config path does
  not satisfy the required prompt group), and a shell would reinterpret that text.
- Keep the README's "Verification status" honest — claim only what's been run.

## Local Claude Code config

Claude Code reads `CLAUDE.md`, not `AGENTS.md`. If you want this file active while working here in
Claude Code, symlink it (it's gitignored): `ln -s AGENTS.md CLAUDE.md`, or just copy it with `cp` if
you don't need a live link.
