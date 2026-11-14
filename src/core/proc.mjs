// Process control: launch an implementer in its own process group and fell the
// whole tree on the way out.

import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:os";

export const IS_WIN = process.platform === "win32";

// Windows looks for a bare command in the current directory before PATH: cmd.exe
// always, CreateProcess unless this variable is set. The --cd checkout is untrusted,
// so it must never get to supply `git`, `taskkill` or the implementer itself. The
// implementer inherits it, which is the safe default there too.
export function guardExePath() {
  if (IS_WIN && !process.env.NoDefaultCurrentDirectoryInExePath) process.env.NoDefaultCurrentDirectoryInExePath = "1";
}

export function signalExitCode(signal, fallback = 15) {
  return 128 + (constants.signals[signal] || fallback);
}

export function killChild(child, signal = "SIGTERM") {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    if (signal !== "SIGTERM") return;
    guardExePath();
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch {
      // The process tree already exited.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process group already exited.
    }
  }
}

// launch: { command, args, shell?, verbatim?, env?, cwd?, stdin? }
// POSIX children lead a new process group so killChild reaches grandchildren.
// With `shell` the command line is serialized once (Node 24 warns on shell:true
// plus an args array); callers must pass only token-validated or quoted args.
export function spawnLaunch(launch, extra = {}) {
  guardExePath();
  const options = {
    cwd: launch.cwd,
    env: IS_WIN ? { NoDefaultCurrentDirectoryInExePath: "1", ...(launch.env || process.env) } : (launch.env || process.env),
    stdio: [launch.stdin === undefined || launch.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    detached: !IS_WIN,
    windowsHide: true,
    ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
    ...extra,
  };
  if (launch.shell) return spawn([launch.command, ...launch.args].join(" "), { ...options, shell: true });
  return spawn(launch.command, launch.args, options);
}

// Runs `launch` to completion with a hard deadline and resolves with
// { version, error }. `version` is null with no error when the binary is
// missing; any other failure is an error, shaped like execFileSync's
// (code: "ETIMEDOUT" | status | stderr), so a broken CLI is never dispatched to.
export function probeVersion(launch, timeoutMs, { parse = (out) => out.trim(), onChild, missing } = {}) {
  return new Promise((done) => {
    let child;
    try {
      child = spawnLaunch({ ...launch, stdin: null });
    } catch (error) {
      done({ version: null, error: error.code === "ENOENT" ? null : error });
      return;
    }
    if (onChild) onChild(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (onChild) onChild(null);
      done(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child, IS_WIN ? "SIGTERM" : "SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      // If the kill cannot land, "close" may never fire; do not wait on it.
      setTimeout(() => finish({ version: null, error: Object.assign(new Error("version probe timed out"), { code: "ETIMEDOUT", stderr }) }), 2_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { if (stdout.length < 65_536) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 65_536) stderr += chunk; });
    child.on("error", (error) => {
      finish({ version: null, error: error.code === "ENOENT" ? null : error });
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish({ version: null, error: Object.assign(new Error("version probe timed out"), { code: "ETIMEDOUT", stderr }) });
        return;
      }
      if (missing && missing(code, stderr)) {
        finish({ version: null, error: null });
        return;
      }
      if (code !== 0) {
        finish({ version: null, error: Object.assign(new Error(`version probe exited ${code ?? signal}`), { status: code, signal, stderr }) });
        return;
      }
      finish({ version: parse(stdout, stderr) || "unknown", error: null });
    });
  });
}

// cmd.exe reports a missing command as exit 9009 or "is not recognized" text.
export function cmdShimMissing(code, stderr) {
  return IS_WIN && (code === 9009 || /is not recognized as an internal or external command/i.test(stderr));
}
