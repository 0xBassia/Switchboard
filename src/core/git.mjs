// Every git call the relay makes after dispatch runs against a repository the
// implementer may have tampered with, as the user and outside any sandbox. So:
// git config that runs a command during status/ls-files is switched off, the
// repository is pinned before dispatch (a nested repo planted under --cd cannot
// take over discovery), and a pinned config that changed mid-run stops git
// calls altogether.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { guardExePath } from "./proc.mjs";

// Command-line scope (GIT_CONFIG_COUNT) outranks every config file, and it reaches
// the git processes git itself starts for submodules. The implementer inherits it too.
export function hardenGit() {
  const count = Number(process.env.GIT_CONFIG_COUNT) || 0;
  for (let i = 0; i < count; i += 1) {
    if (process.env[`GIT_CONFIG_KEY_${i}`] === "core.fsmonitor") return;
  }
  process.env[`GIT_CONFIG_KEY_${count}`] = "core.fsmonitor";
  process.env[`GIT_CONFIG_VALUE_${count}`] = "false";
  process.env.GIT_CONFIG_COUNT = String(count + 1);
}

let pinned = null;

function plainGit(cwd, args) {
  guardExePath();
  hardenGit();
  return execFileSync("git", args, {
    cwd, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"],
  }).replace(/\r?\n$/, "");
}

// Files whose change could make git run something: the repository's config, and
// for each registered submodule its gitdir pointer and config.
function watchedFiles(gitDir, commonDir, workTree) {
  const files = [join(gitDir, "config"), join(gitDir, "config.worktree"), join(commonDir, "config"), join(commonDir, "config.worktree")];
  try {
    const stage = execFileSync("git", ["--git-dir", gitDir, "--work-tree", workTree, "ls-files", "--stage", "-z"], {
      cwd: workTree, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
    });
    for (const field of stage.split("\0")) {
      if (!field.startsWith("160000 ")) continue;
      const path = field.slice(field.indexOf("\t") + 1);
      const pointer = join(workTree, path, ".git");
      files.push(pointer);
      try {
        const target = /^gitdir: (.+)$/m.exec(readFileSync(pointer, "utf8"));
        if (target) files.push(join(resolve(join(workTree, path), target[1].trim()), "config"));
      } catch { /* a submodule without a gitdir pointer file */ }
    }
  } catch { /* no index yet */ }
  return [...new Set(files)];
}

function digestOf(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file).update("\0");
    try { hash.update(readFileSync(file)); } catch (error) { hash.update(`<${error.code || "unreadable"}>`); }
    hash.update("\0");
  }
  return hash.digest("hex");
}

// Called once before dispatch. A --cd outside any repository pins "no repository":
// a repository the implementer creates there later is never consulted.
export function pinGitRepository(cwd) {
  const at = resolve(cwd);
  try {
    const gitDir = plainGit(at, ["rev-parse", "--absolute-git-dir"]);
    const workTree = plainGit(at, ["rev-parse", "--show-toplevel"]);
    let commonDir;
    try { commonDir = plainGit(at, ["rev-parse", "--path-format=absolute", "--git-common-dir"]); }
    catch { commonDir = resolve(at, plainGit(at, ["rev-parse", "--git-common-dir"])); }
    const files = watchedFiles(gitDir, commonDir, workTree);
    pinned = { cwd: at, gitDir, workTree, files, digest: digestOf(files) };
  } catch {
    pinned = { cwd: at, gitDir: null };
  }
  return pinned;
}

// True when nothing was pinned or the pinned configuration is unchanged.
export function gitPinIntact() {
  return !pinned || pinned.gitDir === null || digestOf(pinned.files) === pinned.digest;
}

function insidePinned(cwd) {
  if (!pinned) return false;
  const rel = relative(pinned.cwd, resolve(cwd));
  const relTree = pinned.workTree ? relative(pinned.workTree, resolve(cwd)) : "..";
  const within = (r) => r === "" || (!r.startsWith("..") && !isAbsolute(r));
  return within(rel) || within(relTree);
}

// git for the run's repository. Throws when git cannot report safely; callers turn
// that into "unknown" (null), never into a clean answer.
export function runGit(cwd, args, options = {}) {
  guardExePath();
  hardenGit();
  let full = args;
  if (insidePinned(cwd)) {
    if (pinned.gitDir === null) throw new Error("no repository at dispatch");
    if (!gitPinIntact()) throw new Error("the repository's git configuration changed during the run");
    full = ["--git-dir", pinned.gitDir, "--work-tree", pinned.workTree, ...args];
  }
  return execFileSync("git", full, {
    cwd, timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, ...options,
  });
}

// A repository found inside the worktree after dispatch (a nested or submodule
// checkout) is the implementer's to shape: refuse it when its config can run things.
export function nestedGitUnsafe(dir) {
  try {
    guardExePath();
    hardenGit();
    const keys = execFileSync("git", ["-C", dir, "config", "--local", "--name-only", "--get-regexp", "^(filter\\.|diff\\.|core\\.fsmonitor|core\\.hookspath|include\\.|includeif\\.)"], {
      encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"],
    });
    return keys.trim().length > 0;
  } catch (error) {
    // exit 1: no matching key. Anything else: cannot tell, so unsafe.
    return error?.status !== 1;
  }
}

// `git status --porcelain` lines for the working tree, or null when git cannot
// report (not a repository, git missing, a hung probe, tampered config).
export function gitTouchedFiles(cwd) {
  try {
    const output = runGit(cwd, ["status", "--porcelain"], { encoding: "utf8" });
    return output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}
