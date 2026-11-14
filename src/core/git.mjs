// Every git call the relay makes after dispatch runs against a repository the
// implementer may have tampered with, as the user and outside any sandbox. So:
// git config that runs a command during status/ls-files is switched off or
// watched, the repository is pinned before dispatch (a nested repo planted
// under --cd cannot take over discovery), and git calls stop when a setting
// that could run a command changes mid-run. Needs git 2.31+ (GIT_CONFIG_COUNT).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { devNull } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

// The relay's own git calls never write the index (an index write runs the
// post-index-change hook) and never run hooks at all; the implementer keeps its own.
const SAFE_ARGS = ["-c", `core.hooksPath=${devNull}`];

// Clean, smudge and process filters run during status and ls-files whenever an
// attribute names them, and the implementer can add a .gitattributes line at will.
// So every filter driver git knows of is switched off by name for the relay's own
// calls: an empty command means "no filter", and a required filter is no longer
// required. Passed through GIT_CONFIG_* (no "=" splitting), so any name is safe.
function safeEnv(filters = []) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  let count = Number(env.GIT_CONFIG_COUNT) || 0;
  for (const name of filters) {
    for (const [key, value] of [["clean", ""], ["smudge", ""], ["process", ""], ["required", "false"]]) {
      env[`GIT_CONFIG_KEY_${count}`] = `filter.${name}.${key}`;
      env[`GIT_CONFIG_VALUE_${count}`] = value;
      count += 1;
    }
  }
  env.GIT_CONFIG_COUNT = String(count);
  return env;
}

// Filter driver names from `config --null --name-only` output (filter.<name>.<var>).
function filterNames(output, into) {
  for (const key of output.split("\0")) {
    if (!/^filter\./i.test(key)) continue;
    const last = key.lastIndexOf(".");
    if (last > 7) into.add(key.slice(7, last));
  }
}

function plainGit(cwd, args) {
  guardExePath();
  hardenGit();
  return execFileSync("git", [...SAFE_ARGS, ...args], {
    cwd, env: safeEnv(), encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"],
  }).replace(/\r?\n$/, "");
}

// A file's bytes, or every file's bytes under a directory, into the hash.
function hashPath(hash, path) {
  hash.update("\0").update(path).update("\0");
  let stat;
  try { stat = statSync(path); } catch (error) { hash.update(`<${error.code || "unreadable"}>`); return; }
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) hashPath(hash, join(path, name));
  } else if (stat.isFile()) {
    try { hash.update(readFileSync(path)); } catch (error) { hash.update(`<${error.code || "unreadable"}>`); }
  }
}

// The command-running settings as git resolves them for the pinned repository, plus
// each registered submodule's gitdir pointer (where a submodule's own config lives).
// git status recurses into registered submodules and applies their own config,
// info/attributes and hooks, so those are part of the surface too.
function commandSurface(gitDir, workTree) {
  const hash = createHash("sha256");
  const filters = new Set();
  const git = (args, encoding) => execFileSync("git", [...SAFE_ARGS, "--git-dir", gitDir, "--work-tree", workTree, ...args], {
    cwd: workTree, env: safeEnv(), encoding, timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
  });
  // Exit 1 is "no such keys"; anything else means git could not say.
  const config = (args) => {
    try { return git(["config", "--includes", "--null", ...args], "utf8"); } catch (error) {
      if (error?.status === 1) return "";
      throw error;
    }
  };
  try {
    hash.update(config(["--show-origin", "--get-regexp", COMMAND_KEYS]));
    filterNames(config(["--name-only", "--get-regexp", "^filter\\."]), filters);
  } catch {
    return null;
  }
  try {
    for (const field of git(["ls-files", "--stage", "-z"], "utf8").split("\0")) {
      if (!field.startsWith("160000 ")) continue;
      const path = join(workTree, field.slice(field.indexOf("\t") + 1));
      const pointer = join(path, ".git");
      hashPath(hash, pointer);
      let moduleDir = pointer;
      try {
        const target = /^gitdir: (.+)$/m.exec(readFileSync(pointer, "utf8"));
        if (target) moduleDir = resolve(path, target[1].trim());
      } catch { /* a directory .git, or none */ }
      for (const name of ["config", "config.worktree", join("info", "attributes"), "hooks"]) hashPath(hash, join(moduleDir, name));
      // git status applies the submodule's own filters inside it.
      for (const name of ["config", "config.worktree"]) {
        try { filterNames(config(["--file", join(moduleDir, name), "--name-only", "--get-regexp", "^filter\\."]), filters); } catch { /* absent */ }
      }
    }
  } catch { /* no index yet */ }
  return { digest: hash.digest("hex"), filters: [...filters] };
}

// Called once before dispatch. A --cd outside any repository pins "no repository":
// a repository the implementer creates there later is never consulted.
export function pinGitRepository(cwd) {
  const at = resolve(cwd);
  lastError = null;
  try {
    const gitDir = plainGit(at, ["rev-parse", "--absolute-git-dir"]);
    const workTree = plainGit(at, ["rev-parse", "--show-toplevel"]);
    const surface = commandSurface(gitDir, workTree);
    pinned = { cwd: at, gitDir, workTree, surface: surface?.digest ?? null, filters: surface?.filters ?? [] };
  } catch {
    pinned = { cwd: at, gitDir: null };
  }
  return pinned;
}

// true: nothing pinned, or no command-running setting changed since the pin.
// false: one changed. null: git could not say (so neither answer is earned).
export function gitPinIntact() {
  if (!pinned || pinned.gitDir === null) return true;
  if (pinned.surface === null) return null;
  const now = commandSurface(pinned.gitDir, pinned.workTree);
  if (now === null) return null;
  return now.digest === pinned.surface;
}

// Why the last git call refused or failed, for the result; null after a success.
export function lastGitError() {
  return lastError;
}

function insidePinned(cwd) {
  if (!pinned) return false;
  // By component: an entry named "..cache" is inside, only ".." itself climbs out.
  const within = (r) => r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
  if (within(relative(pinned.cwd, resolve(cwd)))) return true;
  return Boolean(pinned.workTree) && within(relative(pinned.workTree, resolve(cwd)));
}

// git for the run's repository. Throws when git cannot report safely; callers turn
// that into "unknown" (null), never into a clean answer.
export function runGit(cwd, args, options = {}) {
  guardExePath();
  hardenGit();
  let full = args;
  let filters = [];
  if (insidePinned(cwd)) {
    if (pinned.gitDir === null) {
      lastError = "git could not identify a repository at --cd when the run started";
      throw new Error(lastError);
    }
    const intact = gitPinIntact();
    if (intact !== true) {
      lastError = intact === false
        ? "a git setting that can run commands changed during the run, so git was not asked"
        : "git could not read the repository's settings, so it was not asked";
      throw new Error(lastError);
    }
    full = ["--git-dir", pinned.gitDir, "--work-tree", pinned.workTree, ...args];
    filters = pinned.filters;
  }
  try {
    const output = execFileSync("git", [...SAFE_ARGS, ...full], {
      cwd, env: safeEnv(filters), timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, ...options,
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
