# Fleet schema (`switchboard-fleet.v1`)

One concept: **lanes**. A lane names an implementer and optional dials.

## Document

```json
{
  "version": "switchboard-fleet.v1",
  "lanes": {
    "feature": {
      "implementer": "opencode",
      "model": "opencode/gpt-5",
      "variant": "high"
    },
    "tests": {
      "implementer": "codex",
      "effort": "medium"
    },
    "complex": {
      "implementer": "claude",
      "effort": "high"
    }
  }
}
```

- `version` must be `switchboard-fleet.v1`.
- `lanes` is an object keyed by lane name (`[A-Za-z0-9][A-Za-z0-9._-]*`).
- Every lane **requires** `implementer` (a key from the registry below).
- Other fields are dials; only dials listed for that implementer are allowed.

## Paths

| Scope | Path |
| --- | --- |
| Global | `$XDG_CONFIG_HOME/switchboard/config.json` when `XDG_CONFIG_HOME` is set; otherwise `~/.config/switchboard/config.json` (`os.homedir()` → `HOME` / `USERPROFILE`) |
| Project | `<git-root>/.switchboard/config.json` |

Project overlays global by **whole-lane replace** (same lane name in project fully replaces the global lane).
Relays apply a project lane only when its exact config content matches the approval hash written under
the repository's shared Git metadata (its common `.git` directory, so every worktree shares it) by an explicitly approved `config.mjs write --scope project`. Cloned or
later-edited project config fails closed until it is reviewed and written again through `switchboard-setup`.

## Implementer keys and dials

| Key | Skill | Binary | Supported dials |
| --- | --- | --- | --- |
| `claude` | switchboard-claude | `claude` | model, effort, timeout, readOnly |
| `codex` | switchboard-codex | `codex` | model, effort, sandbox, timeout, readOnly |
| `opencode` | switchboard-opencode | `opencode` | model, **variant**, timeout, readOnly |
| `cursor` | switchboard-cursor | `cursor-agent` | model, force, timeout, readOnly |
| `pi` | switchboard-pi | `pi` | provider, model, timeout, readOnly |
| `omp` | switchboard-omp | `omp` | provider, model, **effort** (`--thinking`), timeout, readOnly |
| `warp` | switchboard-warp | `oz` | model, timeout |

OpenCode uses `variant` for reasoning intensity, not `effort`. Do not write `effort` on an `opencode` lane.
Oh My Pi (`omp`) uses the lane `effort` dial for omp's `--thinking` (`off`, `auto`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Do not write `thinking` as a lane field.
OpenCode lanes **require** `model` in `provider/model` form, with a non-empty provider before the first
`/` and at least one non-`/` character after it.

Boolean dials: `readOnly`, `force`. All other dials are non-empty strings. Duration strings for
`timeout` use `h`/`m`/`s` (e.g. `30m`) and must fit the relay watchdog ceiling (~24.8 days).
Do not combine `readOnly: true` with a write-capable `sandbox` / `force`.
`model` / `provider` / OpenCode `variant` must match the bound relay’s token rules (e.g. Claude
rejects spaces; Pi/Oh My Pi/OpenCode/Codex use a shell-safe token set — Windows `shell:true`
launches, and Oh My Pi's flag-injection defense even without a shell).

## Helpers

```bash
node <skill-dir>/scripts/discover.mjs
node <skill-dir>/scripts/config.mjs load [--cwd <dir>]
node <skill-dir>/scripts/config.mjs validate <file>
node <skill-dir>/scripts/config.mjs write --scope global|project [--cwd <dir>] <file>
node <skill-dir>/scripts/lane.mjs resolve --cwd <dir> --lane <name> --implementer <key>
```

`load` prints the **effective** map (each lane includes a `source` of `global` or `project`) and
`projectTrusted`, which reports whether the current project content matches its local approval hash.
`lane.mjs resolve` is what the implementer relays call for `--lane`: it fails loud on a missing
lane, untrusted project config, or implementer mismatch, and prints relay-native dials
(e.g. codex `readOnly` → `sandbox: read-only`).
