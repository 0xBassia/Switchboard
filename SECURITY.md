# Security policy

Report vulnerabilities privately through GitHub's private vulnerability reporting (Security tab → "Report a vulnerability") on 0xBassia/Switchboard. Do not open a public issue.

Include:

- the skill
- the CLI and its version
- the OS
- steps to reproduce

You will get an acknowledgement within 7 days. Only the latest release is supported.

## Scope

- relay scripts (`skills/*-delegate/scripts/relay.mjs`)
- `delegate-queue`
- `delegate-setup` config handling
- `codex-background` (bootstrap, server, supervisor)

## Trust model

Relays run as the user, outside any implementer sandbox. They treat the target repository as untrusted: git config that runs commands is switched off, the repository is pinned before dispatch, and artifacts are private and never written through links. An implementer CLI with full write access (no sandbox) can already do anything the user can, so the relay's protections matter most for sandboxed implementers and read-only runs. The read-only tripwire reports writes; it does not prevent them.
