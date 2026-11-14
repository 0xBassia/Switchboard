# Relay sources

Every `skills/switchboard-<name>/scripts/relay.mjs` is **generated**. Edit the sources here, then run:

```sh
node tools/build.mjs            # rebuild every relay
node tools/build.mjs codex      # rebuild one
node tools/build.mjs --check    # CI: fail if a committed relay is stale
```

Skills install one directory at a time, so a shipped relay cannot import anything outside its
own folder. `tools/build.mjs` inlines the `src/core` modules an adapter imports and keeps only
the top-level declarations the adapter actually reaches. Each relay stays standalone and
carries no dead code.

```
src/core/      shared engine (Node built-ins only)
  relay.mjs      runRelay: intake → lane → artifacts → preflight → supervise → result
  cli.mjs        spec-driven flags, --help from the header comment, brief intake
  lane.mjs       fleet lane resolution through switchboard-setup
  proc.mjs       process-group launch, tree kill, async version probe
  run.mjs        run directory, atomic result.json, stdout summary
  scan.mjs       JSON-object and JSONL stream scanners, stderr tail
  git.mjs        git porcelain snapshot
  tripwire.mjs   read-only tripwire (opt-in per adapter)
  duration.mjs   h/m/s durations bounded to Node's timer range
src/adapters/  one file per implementer CLI: its flags, version probe, launch, events
```

## Source rules

The bundler enforces these, and a violation is a build error:

- Imports use the form `import { a, b as c } from "..."`. Relative paths are inlined, and
  `node:` built-ins are merged. Nothing else may be imported.
- Top-level declarations start at column 0. Their names are unique across everything an
  adapter pulls in.
- The adapter's first `/** */` block is the relay header and doubles as `--help`.
- The adapter ends with `await runRelay(adapter);`.

## Lifecycle guarantees (owned by core, identical for every implementer)

- A usage error exits 2 before any artifact exists. `--cd` and `--out-dir` are validated as
  directories.
- Once the brief validates, `result.json` is written atomically on every outcome:
  `completed`, `failed`, `timeout`, `stalled` (adapters with an opt-in stall watchdog), `aborted`, or
  `<key>_unavailable`.
- A missing binary exits 127. A broken one (its version probe fails or hangs) is never
  dispatched to: `failed` with the probe's exit code, or `timeout` with exit 124. Whatever the
  probe's outcome, its process group is killed before dispatch (POSIX).
- A refusal from an adapter's `prepare` (thrown; `usage: true` keeps exit 2) is still recorded as
  a `failed` result.json.
- An `--out-dir` that is a symbolic link, or that reaches through one below `--cd`, is a usage
  error (exit 2) before anything is created or removed.
- The artifact directory's identity (real path, device, inode) is pinned at the start. If the
  implementer moves or replaces it, the relay writes nothing more there: no `final.txt`, no
  `result.json`, and the run fails with the reason on stdout. The check runs before each write,
  once the implementer's process group is gone; Node has no directory-relative writes, so a
  process that escaped the group and swaps the directory between check and write is not
  covered.
- SIGTERM, SIGINT and SIGHUP on the relay are recorded and forwarded to the whole implementer
  process tree, during preflight and during dispatch.
- `events.jsonl` and `stderr.txt` are written through descriptors opened exclusively at start, so
  an entry the implementer swaps mid-run can never redirect them; artifacts the implementer writes
  itself are made private once it has exited.
- On Windows the relay never resolves a bare command (`git`, the implementer) in the `--cd`
  checkout: `NoDefaultCurrentDirectoryInExePath` is set for itself and inherited by the implementer.
- Every `git` call the relay makes runs with `core.fsmonitor` switched off (git 2.31+; the
  implementer inherits that setting), with no hooks, with every configured clean, smudge and
  process filter switched off by name (so a `.gitattributes` line added mid-run cannot start
  one), and without writing the index. The repository is
  pinned before dispatch. If a Git setting that can run commands (filters, diff drivers,
  `core.fsmonitor`, a hooks path, includes, and each submodule's config, attributes and hooks) changes during
  the run, the relay stops asking Git: `touchedFiles` is `null` and `result.json` gets a `gitError`
  string. `gitError` also explains other `null` cases, such as a `--cd` that was not inside a Git
  repository when the run started.
- The relay keeps only absolute `PATH` entries; an empty or relative entry would resolve inside the
  checkout.
- After the implementer exits, the relay sends SIGKILL to everything left in its process group
  (POSIX). A process that left the group is not covered; on Windows leftovers keep running.
- The read-only tripwire counts a commit or other ref move in any namespace (remote-tracking refs
  excepted, so a background fetch is not a write), a change to `.git/info/exclude`,
  `.git/info/attributes`, the `core.excludesFile` setting or that file's contents, or the name or
  contents of an ignored `.gitignore`, skip-worktree or assume-unchanged flags, and a
  changed command-running Git setting as violations. An aborted run reports `readOnlyViolation: null` until the implementer is gone.
- The `--timeout` watchdog sends SIGTERM, then SIGKILL after 10s, to the process group. A
  run that timed out is never `completed`.
- An orphaned grandchild holding the stdio pipes cannot wedge the relay.

## Adapter contract

Only `key`, `versionField`, `fields` and `launch` are required.

```
  key            implementer key: lane lookup, result `tool`, `<key>_unavailable`
  name           display name in messages (default: key)
  versionField   result field for the probed version, e.g. "codexVersion"
  flags          parseArgs spec for implementer-specific flags
  defaults       option defaults; `timeout: null` disables the watchdog
  laneConflicts, onDial   lane dial precedence (see lane.mjs)
  validate(opts, flagged) cross-flag checks; call fail() to reject
  checkBrief(brief, opts)  reject a brief before any artifact exists (call fail())
  maxBriefBytes, briefTooLarge(kb)   argv-carried briefs must fit the OS cap
  artifacts      extra run files, { pathKey: fileName }
  state(opts)    initial per-run state; `sessionId` is always tracked
  fields(opts, state, run)  configuration/state fields of result.json
  readOnly(opts), tripwire   true arms the tripwire (pass `tripwire` from tripwire.mjs)
  tripwireIgnore(path)  true for repo-relative paths the CLI writes as its own bookkeeping
                 even when read-only; outside the tripwire
  version(opts)  { launch, timeoutMs?, parse?, missing? } to probe, { unavailable: true }
                 when the adapter's own launcher lookup already failed, or null to skip
  prepare(opts, run, state, brief)  last step before launch (profiles, env); throw to
                 refuse (core records a failed result; `usage: true` keeps exit 2)
  launch(opts, brief, run, state)   { command, args, shell?, env?, stdin? }
  scanner        makeEventScanner | makeLineScanner from scan.mjs, fed to onEvent;
                 omit it to receive decoded stdout text in onText(text, state, run)
  final(state)   the implementer's final report (written to final.txt)
  finalByImplementer  true when the CLI itself writes final.txt (codex -o); core leaves it alone
  verdict(state, close)  { error?, fields? } after a clean exit; an error fails the run
  timeoutLabel(opts)  how the watchdog's limit is named in its error (default "--timeout <dur>")
  tokens(state)  the CLI's reported counts as { input, output, cacheRead, cacheWrite, reasoning };
                 core normalizes them into result `tokens` (null when nothing is reported)
  cost(state)    the CLI's reported spend in USD, written as result `totalCostUsd`
  touched(files) filter git porcelain (e.g. drop the implementer's own files)
  summary(result)  extra summary lines; resumeFlag  flag shown in the session hint
                 (default --session; false prints the id without a resume hint)
  slug           result identity when it differs from key: `tool` and `<slug>_unavailable`
  stall          { ms(opts), busy(state)?, message(opts) } opt-in stall watchdog: kills a
                 silent run (no output, nothing busy) and reports status "stalled"
  binary, unavailableHint  executable name and install advice for a missing CLI
```

Flag spec entries are `{ key, kind?: "value" | "bool" | "list", path?, pattern?, choices? }`.
Every explicitly passed flag marks its key as set, and set keys win over lane dials. The
common flags `--brief`, `--cd`, `--lane`, `--timeout` and `--out-dir` are built in.

`src/adapters/pi.mjs` is a compact reference adapter. `src/adapters/claude.mjs` shows
stdin briefs, a resolved launcher with cmd.exe shims, a settings profile artifact, the
tripwire, and a verdict.
