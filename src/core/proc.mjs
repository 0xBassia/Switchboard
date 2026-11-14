// Process control: launch an implementer in its own process group and fell the
// whole tree on the way out.

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { isAbsolute } from "node:path";

// Switchboard runs on macOS, Linux and WSL. Native Windows is refused up front,
// before any artifact exists, rather than half-supported.
export function refuseNativeWindows() {
  if (process.platform !== "win32") return;
  process.stderr.write("switchboard: native Windows is not supported; run it inside WSL (https://learn.microsoft.com/windows/wsl/)\n");
  process.exit(2);
}

// POSIX lookup treats an empty or relative PATH entry (a stray ":" from PATH=$X:$PATH)
// as a directory relative to the child's cwd, which is the untrusted --cd checkout, so
// only absolute entries are kept, for the relay and everything it starts.
export function guardExePath() {
  if (process.env.PATH === undefined) return;
  const entries = process.env.PATH.split(":");
  const kept = entries.filter((entry) => isAbsolute(entry));
  if (kept.length !== entries.length) process.env.PATH = kept.join(":");
}

export function signalExitCode(signal, fallback = 15) {
  return 128 + (constants.signals[signal] || fallback);
}

export function killChild(child, signal = "SIGTERM") {
  if (!child || !child.pid) return;
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

// launch: { command, args, env?, cwd?, stdin? }
// Children lead a new process group so killChild reaches grandchildren. No shell
// ever runs: the command and its args go to execve as they are.
export function spawnLaunch(launch, extra = {}) {
  guardExePath();
  const options = {
    cwd: launch.cwd,
    env: launch.env || process.env,
    stdio: [launch.stdin === undefined || launch.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    detached: true,
    ...extra,
  };
  return spawn(launch.command, launch.args, options);
}

// Runs `launch` to completion with a hard deadline and resolves with
// { version, error }. `version` is null with no error when the binary is
// missing; any other failure is an error, shaped like execFileSync's
// (code: "ETIMEDOUT" | status | stderr), so a broken CLI is never dispatched to.
export function probeVersion(launch, timeoutMs, { parse = (out) => out.trim(), onChild } = {}) {
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
      // Whatever the outcome, nothing the probe started may outlive it: a --version that
      // forks a background child would otherwise keep running through dispatch.
      killChild(child, "SIGKILL");
      if (onChild) onChild(null);
      done(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child, "SIGKILL");
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
      if (code !== 0) {
        finish({ version: null, error: Object.assign(new Error(`version probe exited ${code ?? signal}`), { status: code, signal, stderr }) });
        return;
      }
      finish({ version: parse(stdout, stderr) || "unknown", error: null });
    });
  });
}
