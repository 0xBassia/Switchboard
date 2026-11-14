// The relay engine. An adapter describes one implementer CLI (flags, version
// probe, launch, event parsing); runRelay owns everything else: intake, lanes,
// artifacts, preflight, supervision, and the result contract.
//
// Lifecycle guarantees, identical for every implementer:
//   - usage errors exit 2 before any artifact exists;
//   - once the brief validates, result.json is written on every outcome:
//     completed, failed, timeout, aborted, or <key>_unavailable;
//   - a missing binary exits 127; a broken one (version probe fails or hangs)
//     is never dispatched to;
//   - the relay's own death (SIGTERM/SIGINT/SIGHUP) is recorded and forwarded
//     to the whole implementer process tree, during preflight and dispatch;
//   - an orphaned grandchild holding the pipes cannot wedge the relay.

import { existsSync, lstatSync, statSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { fail, parseArgs, readBrief } from "./cli.mjs";
import { parseDuration } from "./duration.mjs";
import { gitTouchedFiles, hardenGit, lastGitError, pinGitRepository } from "./git.mjs";
import { applyFleetLane } from "./lane.mjs";
import { guardExePath, IS_WIN, killChild, probeVersion, signalExitCode, spawnLaunch } from "./proc.mjs";
import { makeResultWriter, prepareRunDir, printSummary, privatizeArtifacts, readStderrTail, runArtifactPaths, runDirIntact, writeAtomic } from "./run.mjs";

const RELAY_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const SIGKILL_GRACE_MS = 10_000;
const ABORT_GRACE_MS = 2_000;
const DRAIN_GRACE_MS = 500;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

const finiteOrNull = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

// Adapters return whatever counts their CLI reports; anything missing or
// malformed becomes null, and no counts at all means `tokens: null`.
function normalizeTokens(raw) {
  if (!raw || typeof raw !== "object") return null;
  const tokens = {
    input: finiteOrNull(raw.input),
    output: finiteOrNull(raw.output),
    cacheRead: finiteOrNull(raw.cacheRead),
    cacheWrite: finiteOrNull(raw.cacheWrite),
    reasoning: finiteOrNull(raw.reasoning),
  };
  return Object.values(tokens).some((value) => value !== null) ? tokens : null;
}

// lstat, not existsSync: a dangling symlink is still an entry someone put there.
function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function checkDirectories(opts) {
  let cd;
  try { cd = statSync(opts.cd); } catch { fail(`--cd directory not found: ${opts.cd}`); }
  if (!cd.isDirectory()) fail(`--cd is not a directory: ${opts.cd}`);
  if (opts.outDir && existsSync(opts.outDir) && !statSync(opts.outDir).isDirectory()) {
    fail(`--out-dir is not a directory: ${opts.outDir}`);
  }
}

function onRelaySignals(handler) {
  const handlers = RELAY_SIGNALS.map((signal) => [signal, () => handler(signal)]);
  for (const [signal, fn] of handlers) process.on(signal, fn);
  return () => {
    for (const [signal, fn] of handlers) process.removeListener(signal, fn);
  };
}

// See src/README.md for the adapter contract.
export async function runRelay(a) {
  guardExePath();
  hardenGit();
  const name = a.name || a.key;
  // Result identity (`tool`, `<slug>_unavailable`) can differ from the lane key.
  const slug = a.slug || a.key;
  const unavailableStatus = `${slug.replace(/-/g, "_")}_unavailable`;
  const { opts, flagged } = parseArgs(process.argv.slice(2), a.flags || {}, { timeout: null, ...a.defaults });
  applyFleetLane(opts, flagged, a.key, { conflicts: a.laneConflicts, onDial: a.onDial });
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  checkDirectories(opts);
  if (a.validate) a.validate(opts, flagged);

  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");
  if (a.checkBrief) a.checkBrief(brief, opts);
  if (a.maxBriefBytes) {
    const bytes = Buffer.byteLength(brief, "utf8");
    if (bytes > a.maxBriefBytes) fail(a.briefTooLarge(Math.round(bytes / 1024)));
  }

  const run = prepareRunDir(opts, brief, a.artifacts);
  const state = { sessionId: null, ...(a.state ? a.state(opts) : {}) };
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  let version = null;
  // Armed before the synchronous Git baseline: a signal that lands during it is
  // queued and handled right after, so it still produces a result instead of
  // the default instant death.
  let probeChild = null;
  // An abort before dispatch never compares a meaningful "after" state, and a
  // terminal ^C reaches the Git baseline too: the verdict is unknown, never false.
  let verdictKnown = true;
  // While an aborted implementer is still exiting, any verdict would be a guess.
  const verdictGate = { pending: false };
  const releasePreflight = onRelaySignals((signal) => {
    releasePreflight();
    verdictKnown = false;
    const result = report({
      status: "aborted",
      exitCode: signalExitCode(signal),
      signal,
      finalMessage: "",
      error: `the relay was killed by ${signal} during the ${name} version preflight; ${name} was not dispatched`,
    });
    if (probeChild) killChild(probeChild, IS_WIN ? "SIGTERM" : "SIGKILL");
    process.exit(result.exitCode);
  });
  // Before dispatch: the repository every later git call is held to.
  pinGitRepository(opts.cd);
  const snapshot = a.tripwire && a.readOnly(opts) ? a.tripwire.snapshot(opts.cd, runArtifactPaths(run), a.tripwireIgnore) : null;

  const write = makeResultWriter(
    { lane: opts.lane, laneSource: opts.laneSource, tool: slug, workdir: opts.cd },
    run,
    () => ({
      ...a.fields(opts, state, run),
      [a.versionField]: version,
      sessionId: state.sessionId,
      // One usage shape for every implementer; null where the CLI does not report it.
      tokens: normalizeTokens(a.tokens ? a.tokens(state) : null),
      totalCostUsd: finiteOrNull(a.cost ? a.cost(state) : null),
    }),
    snapshot ? (result) => { result.readOnlyViolation = verdictKnown && !verdictGate.pending ? a.tripwire.check(snapshot) : null; } : null,
  );
  const view = {
    name,
    versionField: a.versionField,
    lines: a.summary,
    empty: a.emptyReport,
    resumeFlag: a.resumeFlag,
    // Tripwire warnings belong to read-only runs only; a write-capable run may
    // still carry `readOnlyViolation: null` for schema stability.
    readOnly: Boolean(snapshot) || Boolean(a.readOnly && a.readOnly(opts)),
  };
  const touched = () => {
    const files = gitTouchedFiles(opts.cd);
    return files && a.touched ? a.touched(files) : files;
  };
  // prepareRunDir removed any stale final.txt, so one that exists now and was
  // not written by the relay appeared during the run (a user file renamed into
  // an in-repo --out-dir, say). It is never replaced; the run fails instead.
  let finalOwned = false;
  // An adapter whose CLI writes final.txt itself (finalByImplementer) owns it.
  const finalBlocked = () => !a.finalByImplementer && !finalOwned && entryExists(run.finalPath);
  const finalMessage = () => {
    const message = a.final ? a.final(state) : "";
    if (message && !a.finalByImplementer && !finalBlocked() && runDirIntact(run)) {
      // Atomic: a symlink planted at final.txt mid-run is replaced, never written through.
      try {
        writeAtomic(run.finalPath, message);
        finalOwned = true;
      } catch { /* report it inline anyway */ }
    }
    return message;
  };
  const report = (outcome) => {
    const touchedFiles = touched();
    // Say why touchedFiles is null rather than leave the orchestrator to guess.
    const gitError = touchedFiles === null ? lastGitError() : null;
    const result = write({ finalMessage: finalMessage(), touchedFiles, ...(gitError ? { gitError } : {}), ...outcome });
    printSummary(result, run.resultPath, view);
    return result;
  };

  // Last line of defence: a bug in an adapter hook must still leave a result and
  // must not orphan the implementer's process group.
  const crash = (error) => {
    killChild(guard.child, IS_WIN ? "SIGTERM" : "SIGKILL");
    try {
      report({ status: "failed", exitCode: 1, signal: null, error: `relay internal error: ${error && error.stack ? error.stack : error}` });
    } catch {
      process.stderr.write(`relay: internal error: ${error && error.stack ? error.stack : error}\n`);
    }
    process.exit(1);
  };
  const guard = { child: null };
  // A closed stdout/stderr (the orchestrator went away) must not turn into a
  // crash that overwrites the real outcome: result.json is the contract.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);

  // Preflight: prove the CLI exists and answers before sending it the brief.
  const probe = a.version ? a.version(opts) : null;
  const unavailable = () => {
    const result = report({
      status: unavailableStatus,
      exitCode: 127,
      signal: null,
      finalMessage: "",
      error: `\`${a.binary || a.key}\` was not found on PATH; nothing was dispatched`,
    });
    process.stderr.write(`relay: \`${a.binary || a.key}\` not found on PATH.${a.unavailableHint ? ` ${a.unavailableHint}` : ""}\n`);
    process.exit(result.exitCode);
  };
  if (probe && probe.unavailable) unavailable();
  if (probe) {
    const probeTimeoutMs = probe.timeoutMs ?? Math.min(timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS);
    const outcome = await probeVersion({ cwd: opts.cd, ...probe.launch }, probeTimeoutMs, {
      parse: probe.parse,
      missing: probe.missing,
      onChild: (child) => { probeChild = child; guard.child = child; },
    });
    version = outcome.version;
    if (!outcome.version && !outcome.error) unavailable();
    if (outcome.error) {
      const error = outcome.error;
      const timedOut = error.code === "ETIMEDOUT";
      const stderr = String(error.stderr || "").trim();
      if (stderr) writeSync(run.stderrFd, `${stderr}\n`);
      const message = timedOut
        ? `${name} --version preflight timed out after ${probeTimeoutMs}ms; ${name} was not dispatched`
        : `${name} --version preflight failed${Number.isInteger(error.status) ? ` with exit ${error.status}` : ""}; ${name} was not dispatched`;
      const result = report({
        status: timedOut ? "timeout" : "failed",
        exitCode: timedOut ? 124 : Number.isInteger(error.status) && error.status !== 0 ? error.status : 1,
        signal: null,
        finalMessage: "",
        stderrTail: readStderrTail(run.stderrFd),
        error: message,
      });
      process.stderr.write(`relay: ${message}\n`);
      process.exit(result.exitCode);
    }
  }

  // prepare runs after the artifacts exist, so a refusal there (a flag the probed
  // version does not support, a profile that cannot be written) still gets a result.
  // An error with `usage: true` keeps the usage exit code 2.
  if (a.prepare) {
    try {
      await a.prepare(opts, run, state, brief);
    } catch (error) {
      const message = `${error && error.message ? error.message : String(error)}; ${name} was not dispatched`;
      const result = report({ status: "failed", exitCode: error?.usage ? 2 : 1, signal: null, finalMessage: "", error: message });
      process.stderr.write(`relay: ${message}\n`);
      process.exit(result.exitCode);
    }
  }
  releasePreflight();
  supervise(a, { name, opts, brief, run, state, timeoutMs, report, guard, probed: Boolean(probe), unavailableStatus, finalBlocked, verdictGate });
}

function supervise(a, { name, opts, brief, run, state, timeoutMs, report, guard, probed, unavailableStatus, finalBlocked, verdictGate }) {
  let launch;
  let child;
  try {
    launch = { cwd: opts.cd, ...a.launch(opts, brief, run, state) };
    // cmd.exe cannot start in a UNC directory: it falls back to %SystemRoot% with a
    // warning, and the brief would run there while the report names the share.
    if (IS_WIN && (launch.shell || /(^|[\\/])cmd\.exe$/i.test(launch.command))) {
      if (/^\\\\[^?.\\]/.test(launch.cwd)) {
        throw new Error(`--cd is a UNC path and ${name} launches through cmd.exe, which cannot run in one; map the share to a drive letter first`);
      }
      // Paths reach cmd.exe inside quotes, where %VAR% and !VAR! still expand.
      if ([opts.cd, run.outDir].some((path) => /[\0\r\n"%!]/.test(path))) {
        throw new Error(`${name} launches through cmd.exe, which would rewrite %, ! or a quote in --cd or --out-dir; use a path without them`);
      }
    }
    child = spawnLaunch(launch);
    guard.child = child;
  } catch (error) {
    const result = report({ status: "failed", exitCode: 1, signal: null, error: error.message || String(error) });
    process.exit(result.exitCode);
  }

  // A handler that throws on one odd event must neither kill a good run nor
  // vanish: the run continues and result.json lists what went wrong.
  const eventErrors = [];
  const guarded = (fn) => (value) => {
    try {
      fn(value);
    } catch (error) {
      if (eventErrors.length < 5) eventErrors.push(String(error && error.message ? error.message : error));
    }
  };
  const parse = a.scanner
    ? a.scanner(guarded((event) => a.onEvent(event, state, run)))
    : guarded((text) => { if (text && a.onText) a.onText(text, state, run); });
  const reportRun = (outcome) => report(eventErrors.length ? { ...outcome, eventErrors } : outcome);
  // Files get the raw bytes; only in-memory parsing is decoded, across chunk
  // boundaries so a split multibyte character cannot corrupt the report.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let lastActivity = Date.now();
  // Through the descriptors opened at start, never by path: the implementer cannot
  // re-point an artifact mid-run.
  child.stdout.on("data", (chunk) => {
    lastActivity = Date.now();
    writeSync(run.eventsFd, chunk);
    parse(stdoutDecoder.write(chunk));
  });
  child.stderr.on("data", (chunk) => {
    lastActivity = Date.now();
    process.stderr.write(chunk);
    writeSync(run.stderrFd, chunk);
    const text = stderrDecoder.write(chunk);
    if (a.onStderr) a.onStderr(text, state);
  });

  let settled = false;
  let watchdogFired = false;
  let stallFired = false;
  let watchdogTimer = null;
  let sigkillTimer = null;
  let stallPoll = null;
  const dropPipes = () => {
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const disarm = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    if (stallPoll) clearInterval(stallPoll);
  };
  // Signal handlers stay installed after settling: a repeat signal during the
  // abort grace must be ignored, not fall through to the default (instant death).
  const settle = () => {
    if (settled) return false;
    settled = true;
    disarm();
    return true;
  };

  const fireWatchdog = () => {
    if (watchdogFired || settled) return;
    watchdogFired = true;
    if (stallPoll) clearInterval(stallPoll);
    child.once("exit", dropPipes);
    killChild(child);
    sigkillTimer = setTimeout(() => {
      if (!settled) killChild(child, "SIGKILL");
    }, SIGKILL_GRACE_MS);
  };
  if (timeoutMs !== null) watchdogTimer = setTimeout(fireWatchdog, timeoutMs);

  // Stall watchdog (opt-in per adapter): output is activity, and the clock
  // pauses while the adapter reports work in flight (a long silent tool call).
  // It catches an implementer that is alive but stuck, long before --timeout.
  const stallMs = a.stall ? a.stall.ms(opts) : null;
  if (stallMs) {
    stallPoll = setInterval(() => {
      if (watchdogFired || settled) return;
      if (a.stall.busy && a.stall.busy(state)) lastActivity = Date.now();
      else if (Date.now() - lastActivity >= stallMs) {
        stallFired = true;
        fireWatchdog();
      }
    }, Math.min(5_000, Math.max(250, Math.floor(stallMs / 4))));
  }

  // The relay's own death must still produce a result, and must take the
  // implementer with it. SIGTERM/SIGHUP registration is a no-op on Windows.
  onRelaySignals((signal) => {
    if (!settle()) return;
    child.once("exit", dropPipes);
    killChild(child);
    const fields = () => ({
      status: "aborted",
      exitCode: signalExitCode(signal),
      signal,
      stderrTail: readStderrTail(run.stderrFd),
      error: `the relay was killed by ${signal}; ${name} was terminated with it — inspect the working tree before re-dispatching`,
    });
    // A first record in case the relay dies during the grace window; the implementer is
    // still exiting, so it carries no read-only verdict yet.
    verdictGate.pending = true;
    reportRun(fields());
    setTimeout(() => {
      killChild(child, "SIGKILL");
      verdictGate.pending = false;
      // The child may flush files during the grace window; refresh the record
      // so it matches the tree the orchestrator will actually find.
      const result = reportRun(fields());
      process.exit(result.exitCode);
    }, ABORT_GRACE_MS);
  });

  // A grandchild that outlives the implementer and inherited its pipes keeps
  // them open, so "close" would never fire. Once the implementer is gone the
  // pipes hold nothing we need: drop them after a short drain grace.
  child.once("exit", () => {
    // Leaving the watchdog armed past a clean exit could mislabel it a timeout.
    if (!watchdogFired) disarm();
    const drain = setTimeout(() => {
      if (!settled) dropPipes();
    }, DRAIN_GRACE_MS);
    drain.unref();
  });

  child.on("error", (error) => {
    if (!settle()) return;
    // Missing at launch means unavailable only if no probe already found it; a
    // binary that answered --version and then vanished is a failed run.
    const missing = error && error.code === "ENOENT";
    const unavailable = missing && !probed;
    const result = reportRun({
      status: unavailable ? unavailableStatus : "failed",
      exitCode: unavailable ? 127 : 1,
      signal: null,
      ...(unavailable ? {} : { stderrTail: readStderrTail(run.stderrFd) }),
      error: missing && probed
        ? `${name} answered the version probe but could not be launched (${error.message}); nothing was dispatched`
        : error && error.message ? error.message : String(error),
    });
    process.exit(result.exitCode);
  });

  child.on("close", (code, signal) => {
    if (!settle()) return;
    parse(stdoutDecoder.end());
    // An unterminated final line still counts; for the object scanner this is a no-op.
    if (a.scanner) parse("\n");
    if (a.onStderr) a.onStderr(stderrDecoder.end(), state);
    // Nothing the implementer left in its process group may outlive the report: a background
    // job could write after the tripwire's last look (a process that left the group with
    // setsid is out of reach). POSIX only; on Windows the leftovers keep running.
    killChild(child, "SIGKILL");
    privatizeArtifacts(run);
    let judged = !watchdogFired && a.verdict ? a.verdict(state, { code, signal }) || {} : {};
    if (!judged.error && finalBlocked()) {
      judged = { ...judged, error: `could not safely create final.txt: ${run.finalPath} appeared during the run and was left untouched` };
    }
    // A timed-out run is failed even if the implementer exits 0 on SIGTERM.
    const succeeded = code === 0 && !watchdogFired && !judged.error;
    const mapped = code ?? (signal ? signalExitCode(signal, 0) : 1);
    const error = stallFired
      ? a.stall.message(opts)
      : watchdogFired
        ? `${name} did not finish within ${a.timeoutLabel ? a.timeoutLabel(opts) : `--timeout ${opts.timeout}`}; killed by the relay watchdog`
        : judged.error;
    const result = reportRun({
      status: succeeded ? "completed" : stallFired ? "stalled" : watchdogFired ? "timeout" : "failed",
      exitCode: succeeded ? 0 : mapped === 0 || mapped === 128 ? 1 : mapped,
      signal: signal ?? null,
      ...(succeeded ? {} : { stderrTail: readStderrTail(run.stderrFd) }),
      ...(error ? { error } : {}),
      ...judged.fields,
    });
    process.exit(result.exitCode);
  });

  if (child.stdin) {
    // A launch failure can surface on the child and on its stdin; the child's
    // error handler owns the outcome, so the pipe error is swallowed.
    child.stdin.on("error", () => {});
    child.stdin.end(launch.stdin);
  }
}
