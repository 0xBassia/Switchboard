// Every git call the relay makes after dispatch runs against a repository the
// implementer may have tampered with, as the user and outside any sandbox. So:
// git config that runs a command during status/ls-files is switched off or
// watched, the repository is pinned before dispatch (a nested repo planted
// under --cd cannot take over discovery), and git calls stop when a setting
// that could run a command changes mid-run. Needs git 2.31+ (GIT_CONFIG_COUNT).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { guardExePath } from "./proc.mjs";

// Command-line scope (GIT_CONFIG_COUNT) outranks every config file, and it reaches
// the git processes git itself starts for submodules. The implementer inherits it too.
// An empty value turns fsmonitor off on every git version: before 2.36 it is a hook
// path ("false" would be run as a hook), from 2.36 a boolean.
export function hardenGit() {
  const count = Number(process.env.GIT_CONFIG_COUNT) || 0;
  for (let i = 0; i < count; i += 1) {
    if (process.env[`GIT_CONFIG_KEY_${i}`] === "core.fsmonitor" && process.env[`GIT_CONFIG_VALUE_${i}`] === "") return;
  }
  process.env[`GIT_CONFIG_KEY_${count}`] = "core.fsmonitor";
  process.env[`GIT_CONFIG_VALUE_${count}`] = "";
  process.env.GIT_CONFIG_COUNT = String(count + 1);
}

// Settings that make status, ls-files, diff or hash-object run a program, from any
// scope and any included file (--includes), each with the file it came from.
const COMMAND_KEYS = "^(core\\.(fsmonitor|hookspath|worktree|attributesfile|pager|editor|sshcommand|gitproxy)|filter\\.|diff\\.[^.]+\\.(command|textconv)|merge\\.[^.]+\\.driver|include\\.|includeif\\.)";

let pinned = null;
let lastError = null;

function plainGit(cwd, args) {
  guardExePath();
  hardenGit();
  return execFileSync("git", args, {
    cwd, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"],
  }).replace(/\r?\n$/, "");
}

// The command-running settings as git resolves them for the pinned repository, plus
// each registered submodule's gitdir pointer (where a submodule's own config lives).
function commandSurface(gitDir, workTree) {
  const hash = createHash("sha256");
  try {
    hash.update(execFileSync("git", ["--git-dir", gitDir, "--work-tree", workTree, "config", "--includes", "--show-origin", "--null", "--get-regexp", COMMAND_KEYS], {
      cwd: workTree, timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch (error) {
    // Exit 1 is "no such keys"; anything else means git could not say.
    if (error?.status !== 1) return null;
  }
  try {
    const stage = execFileSync("git", ["--git-dir", gitDir, "--work-tree", workTree, "ls-files", "--stage", "-z"], {
      cwd: workTree, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
    });
    for (const field of stage.split("\0")) {
      if (!field.startsWith("160000 ")) continue;
      const pointer = join(workTree, field.slice(field.indexOf("\t") + 1), ".git");
      hash.update("\0submodule\0").update(pointer).update("\0");
      try { hash.update(readFileSync(pointer)); } catch (error) { hash.update(`<${error.code || "unreadable"}>`); }
    }
  } catch { /* no index yet */ }
  return hash.digest("hex");
}

// Called once before dispatch. A --cd outside any repository pins "no repository":
// a repository the implementer creates there later is never consulted.
export function pinGitRepository(cwd) {
  const at = resolve(cwd);
  lastError = null;
  try {
    const gitDir = plainGit(at, ["rev-parse", "--absolute-git-dir"]);
    const workTree = plainGit(at, ["rev-parse", "--show-toplevel"]);
    pinned = { cwd: at, gitDir, workTree, surface: commandSurface(gitDir, workTree) };
  } catch {
    pinned = { cwd: at, gitDir: null };
  }
  return pinned;
}

// True when nothing was pinned or no command-running setting changed since the pin.
export function gitPinIntact() {
  if (!pinned || pinned.gitDir === null) return true;
  const now = commandSurface(pinned.gitDir, pinned.workTree);
  return now !== null && now === pinned.surface;
}

// Why the last git call refused or failed, for the result; null after a success.
export function lastGitError() {
  return lastError;
}

function insidePinned(cwd) {
  if (!pinned) return false;
  const within = (r) => r === "" || (!r.startsWith("..") && !isAbsolute(r));
  if (within(relative(pinned.cwd, resolve(cwd)))) return true;
  return Boolean(pinned.workTree) && within(relative(pinned.workTree, resolve(cwd)));
}

// git for the run's repository. Throws when git cannot report safely; callers turn
// that into "unknown" (null), never into a clean answer.
export function runGit(cwd, args, options = {}) {
  guardExePath();
  hardenGit();
  let full = args;
  if (insidePinned(cwd)) {
    if (pinned.gitDir === null) {
      lastError = "--cd was not inside a git repository when the run started";
      throw new Error(lastError);
    }
    if (!gitPinIntact()) {
      lastError = "a git setting that can run commands changed during the run, so git was not asked";
      throw new Error(lastError);
    }
    full = ["--git-dir", pinned.gitDir, "--work-tree", pinned.workTree, ...args];
  }
  try {
    const output = execFileSync("git", full, {
      cwd, timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, ...options,
    });
    lastError = null;
    return output;
  } catch (error) {
    lastError = error?.code === "ETIMEDOUT" || error?.signal === "SIGKILL" ? "git did not answer within 10 seconds" : "git could not report";
    throw error;
  }
}

// `git status --porcelain` lines for the working tree, or null when git cannot
// report (not a repository, git missing, a hung probe, a changed command setting).
export function gitTouchedFiles(cwd) {
  try {
    const output = runGit(cwd, ["status", "--porcelain"], { encoding: "utf8" });
    return output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}
