# Security policy

Report vulnerabilities privately through GitHub's private vulnerability reporting (Security tab → "Report a vulnerability") on 0xBassia/Switchboard. Do not open a public issue.

Include:

- the skill
- the CLI and its version
- the OS
- steps to reproduce

You will get an acknowledgement within 7 days. Only the latest release is supported.

## Scope

- relay scripts (`skills/switchboard-*/scripts/relay.mjs`)
- `switchboard-queue`
- `switchboard-setup` config handling

## Trust model

Relays run as the user, outside any implementer sandbox. Their own `git` calls run with `core.fsmonitor` switched off, without hooks and without writing the index, the repository is pinned before dispatch, and if a Git setting that can run commands changes during a run the relay stops asking Git and reports why in `gitError`. Artifacts are private and never written through links. Relays keep only absolute `PATH` entries, and after the implementer exits they kill whatever it left in its process group (POSIX). An implementer CLI with full write access (no sandbox) can already do anything the user can, so the relay's protections matter most for sandboxed implementers and read-only runs. The read-only tripwire reports writes; it does not prevent them.

## Untrusted repositories

The relay protects its own `git` calls; it does not stop an implementer CLI from loading configuration out of the repository it runs in. Cursor Agent (the relay always passes `--trust`), OpenCode (`opencode.json`, `.opencode`), Pi and Oh My Pi (project context and extensions; `omp` disables project extensions, skills and rules unless `--approve`) may do so, and Warp's `oz` has no sandbox. Run those only against repositories you trust, or review their config files first. Claude Code does not load the repository's `.claude/settings.json` or `settings.local.json` unless you pass `--project-settings`, so Claude Code with default settings plus `--read-only` is the safest choice for reviewing an untrusted branch.
