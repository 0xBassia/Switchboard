// Run artifacts: the per-run directory, the atomic result.json writer, and the
// human-readable summary printed on stdout.

import { chmodSync, closeSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fail } from "./cli.mjs";

export const RESULT_SCHEMA = "switchboard-relay.result.v1";

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Briefs and transcripts can hold sensitive context, so artifacts are private:
// the default directory is a fresh 0700 mkdtemp and every file is 0600.
const PRIVATE_FILE = 0o600;

// Removes `path` only when its directory holds an entry with exactly that
// name. On a case-insensitive filesystem rmSync("final.txt") would otherwise
// delete a user's FINAL.TXT sitting in an in-repo --out-dir.
export function removeExact(path) {
  let entries;
  try { entries = readdirSync(dirname(path)); } catch { return; }
  if (entries.includes(basename(path))) rmSync(path, { force: true });
}

// Unlink, then create exclusively: a stale symlink at an artifact path is
// removed, never written through, and a case-aliased user file makes the
// create fail rather than be overwritten.
export function writePrivate(path, data) {
  removeExact(path);
  writeFileSync(path, data, { encoding: "utf8", mode: PRIVATE_FILE, flag: "wx" });
  try { chmodSync(path, PRIVATE_FILE); } catch { /* best effort on filesystems without modes */ }
}

// Creates an artifact exclusively and keeps it open: every later write goes through
// the descriptor, so an entry swapped mid-run (a link planted by the implementer)
// can never redirect it. "wx+" so the same descriptor serves the stderr tail.
export function openPrivate(path) {
  removeExact(path);
  const fd = openSync(path, "wx+", PRIVATE_FILE);
  try { fchmodSync(fd, PRIVATE_FILE); } catch { /* best effort on filesystems without modes */ }
  return fd;
}

// Artifacts the implementer writes itself (codex's final.txt) get the
// relay's own mode once it has exited. Links are left alone: chmod would follow them.
export function privatizeArtifacts(run) {
  if (!runDirIntact(run)) return;
  for (const path of runArtifactPaths(run)) {
    try {
      if (lstatSync(path).isFile()) chmodSync(path, PRIVATE_FILE);
    } catch { /* absent, or a filesystem without modes */ }
  }
}

// A symlink at --out-dir, or at any directory between --cd and an --out-dir inside it,
// is refused before anything is created: a link committed in the repository (or left by
// an earlier implementer) would otherwise steer artifacts, and the removal of stale
// ones, into a directory of its choosing. Links above --cd, or outside it, are the
// user's own and are followed.
function linkedOutDir(outDir, cd) {
  const target = resolve(outDir);
  const roots = [resolve(cd)];
  try { roots.push(realpathSync(cd)); } catch { /* validated as a directory already */ }
  const below = (path) => roots.some((root) => {
    const rel = relative(root, path);
    // By component: an entry named "..cache" is below the root, only ".." climbs out.
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  });
  for (let path = target; ; path = dirname(path)) {
    let stat = null;
    try { stat = lstatSync(path); } catch { /* not created yet */ }
    if (stat?.isSymbolicLink() && (path === target || below(path))) return path;
    if (dirname(path) === path) return null;
  }
}

// extra: { pathKey: fileName } for adapter-specific artifacts (profile.json, ...).
export function prepareRunDir(opts, brief, extra = {}) {
  let outDir = opts.outDir;
  if (outDir) {
    const link = linkedOutDir(outDir, opts.cd);
    if (link) fail(`--out-dir goes through a symbolic link (${link}); pass a real directory path`);
  }
  try {
    if (outDir) {
      mkdirSync(outDir, { recursive: true, mode: 0o700 });
    } else {
      const parent = join(tmpdir(), "switchboard-relay");
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      outDir = mkdtempSync(join(parent, `${basename(opts.cd) || "repo"}-${timestamp()}-`));
    }
  } catch (error) {
    fail(`cannot create the artifact directory ${outDir || tmpdir()}: ${error.message}`);
  }
  let identity;
  try {
    const realDir = realpathSync(outDir);
    const stat = lstatSync(realDir);
    identity = { realDir, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    fail(`cannot inspect the artifact directory ${outDir}: ${error.message}`);
  }
  const run = {
    outDir,
    dirIdentity: identity,
    startedAt: new Date().toISOString(),
    briefPath: join(outDir, "brief.txt"),
    finalPath: join(outDir, "final.txt"),
    eventsPath: join(outDir, "events.jsonl"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  for (const [key, name] of Object.entries(extra)) run[key] = join(outDir, name);
  try {
    // A reused --out-dir must not leak a previous run's report or result.
    removeExact(run.finalPath);
    removeExact(run.resultPath);
    writePrivate(run.briefPath, brief);
    run.eventsFd = openPrivate(run.eventsPath);
    run.stderrFd = openPrivate(run.stderrPath);
  } catch (error) {
    fail(`cannot write run artifacts in ${outDir}: ${error.message}`);
  }
  return run;
}

// The run directory is still the one created at the start: the same real path, still
// a directory (not a link), with the same device and inode. An implementer that renamed
// it and planted a link (or swapped a parent) would otherwise steer every later
// path-based write (final.txt, result.json, chmod) into a directory of its choosing.
export function runDirIntact(run) {
  const id = run.dirIdentity;
  if (!id) return true;
  try {
    if (realpathSync(run.outDir) !== id.realDir) return false;
    const stat = lstatSync(id.realDir);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === id.dev && stat.ino === id.ino;
  } catch {
    return false;
  }
}

export const RUN_DIR_MOVED = "the artifact directory was moved or replaced during the run, so nothing more was written there (result.json included)";

// Publish atomically so a polling orchestrator never reads a half-written file.
// The temp name is unpredictable and created exclusively ("wx"), so a symlink
// planted at it cannot redirect the write; rename replaces a link, never follows it.
export function writeAtomic(path, text) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, text, { encoding: "utf8", mode: PRIVATE_FILE, flag: "wx" });
  renameSync(temporary, path);
}

export function writeJsonAtomic(path, value) {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function runArtifactPaths(run) {
  return Object.entries(run).filter(([key]) => key.endsWith("Path")).map(([, path]) => path);
}

// fields(): the run's configuration and live state, re-read on every write.
// finish(result): last-moment additions (the read-only verdict).
export function makeResultWriter(base, run, fields, finish) {
  return (outcome) => {
    const result = {
      schema: RESULT_SCHEMA,
      ...base,
      ...fields(),
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      eventsPath: run.eventsPath,
      stderrPath: run.stderrPath,
      ...outcome,
    };
    if (finish) finish(result);
    if (!runDirIntact(run)) {
      // Never publish through a swapped directory; the summary on stdout still reports.
      result.status = "failed";
      if (!result.exitCode) result.exitCode = 1;
      result.error = result.error ? `${RUN_DIR_MOVED}; ${result.error}` : RUN_DIR_MOVED;
      result.finalPath = null;
      Object.defineProperty(result, "unpublished", { value: true });
      return result;
    }
    writeJsonAtomic(run.resultPath, result);
    return result;
  };
}

const MAX_STDERR_TAIL_BYTES = 64 * 1024;

// The last 20 non-blank lines within the final 64 KiB of stderr.txt. A line cut
// by the window is marked, and a cut multibyte character is skipped, so the
// tail stays bounded and valid however long a single line is. `source` is the
// relay's own descriptor (never a path the implementer could have re-pointed)
// or, for a finished run, a path.
export function readStderrTail(source) {
  const owned = typeof source !== "number";
  let fd;
  try {
    fd = owned ? openSync(source, "r") : source;
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_STDERR_TAIL_BYTES);
    const readStart = Math.max(0, start - 1);
    const buffer = Buffer.alloc(size - readStart);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, readStart + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    let offset = start - readStart;
    // The preceding byte distinguishes a cut line from a line starting at the window boundary.
    const partialLine = offset > 0 && buffer[0] !== 0x0a;
    while (partialLine && offset < bytesRead && (buffer[offset] & 0xc0) === 0x80) offset += 1;
    const lines = buffer.subarray(offset, bytesRead).toString("utf8").split(/\r?\n/).map((line) => line.trimEnd());
    if (partialLine && lines[0]?.trim()) lines[0] = `[truncated; read stderrPath] ${lines[0]}`;
    return lines.filter((line) => line.trim()).slice(-20);
  } catch {
    // A missing or unreadable diagnostic must not prevent the result from being published.
    return [];
  } finally {
    if (owned && fd !== undefined) closeSync(fd);
  }
}

const MAX_LISTED_FILES = 40;

// view: { name, versionField, lines?(result) => string[], report?, empty? }
export function printSummary(result, resultPath, view) {
  const lines = [""];
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  ${view.name} ${result[view.versionField] ?? "?"}`);
  if (view.readOnly && result.readOnlyViolation === true) {
    lines.push("warning: a git-visible change was detected during this --read-only run; inspect the working tree immediately.");
  } else if (view.readOnly && result.readOnlyViolation === null) {
    lines.push("warning: this --read-only tripwire had incomplete coverage; inspect the working tree directly.");
  }
  if (result.signal === "SIGKILL" && result.status === "failed") {
    lines.push(`hint: the host killed the process (commonly the OOM killer or a supervisor timeout) — this is not a ${view.name} error; check host memory and re-dispatch, or split the task into smaller briefs.`);
  }
  if (result.signal === "SIGTERM" && result.status === "failed") {
    lines.push(`hint: something outside the relay terminated ${view.name} (a supervisor, the session ending, or a manual kill) — when the relay itself does the killing it reports status "timeout" or "aborted" instead; inspect the working tree before re-dispatching.`);
  }
  if (result.resumed) lines.push("mode: resumed an existing session");
  if (result.sessionId) {
    lines.push(view.resumeFlag === false
      ? `session id: ${result.sessionId}`
      : `session id (resume with: ${view.resumeFlag || "--session"} ${result.sessionId}): ${result.sessionId}`);
  }
  if (view.lines) lines.push(...view.lines(result));
  if (result.tokens) {
    const parts = [`in ${result.tokens.input ?? "?"}`, `out ${result.tokens.output ?? "?"}`];
    if (result.tokens.cacheRead !== null) parts.push(`cache read ${result.tokens.cacheRead}`);
    if (result.tokens.reasoning !== null) parts.push(`reasoning ${result.tokens.reasoning}`);
    lines.push(`tokens: ${parts.join(", ")}`);
  }
  if (typeof result.totalCostUsd === "number") lines.push(`cost: $${result.totalCostUsd}`);
  const touched = result.touchedFiles;
  if (touched === null || touched === undefined) {
    lines.push("touched files: git unavailable - inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, MAX_LISTED_FILES)) lines.push(`  ${file}`);
    if (touched.length > MAX_LISTED_FILES) lines.push(`  ... and ${touched.length - MAX_LISTED_FILES} more`);
  }
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push(`--- ${view.name} final report ---`);
  lines.push(result.finalMessage || view.empty || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(result.unpublished ? "result: not written (the artifact directory was replaced during the run)" : `result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}
