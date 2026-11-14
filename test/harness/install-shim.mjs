import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, symlinkSync } from "node:fs";
import { join, delimiter, dirname as pathDirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { SKILLS, WIN, binaryName } from "./constants.mjs";

const harnessDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(harnessDir, "..", "fixtures");

// Resolves a host executable once (which/where); null when absent.
function resolveOnHost(name) {
  const r = spawnSync(WIN ? "where" : "which", [name], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
}

// With { isolatePath: true } PATH holds only the shim dir plus node and git, so a CLI
// installed on the host (a real pi, say) can never be picked up by a test.
export function installShim(h, { isolatePath = false } = {}) {
  const shimDir = join(h.scratch, "shim");
  mkdirSync(shimDir);
  copyFileSync(join(fixturesDir, "fake-cli.cjs"), join(shimDir, "fake-cli.cjs"));

  if (WIN) {
    // npm installs these as .cmd shims; omp and oz are native binaries (the compiled fake below).
    for (const skill of ["claude", "codex", "opencode", "cursor", "pi"]) {
      writeFileSync(join(shimDir, `${binaryName(skill)}.cmd`), `@node "%~dp0fake-cli.cjs" %*\r\n`);
    }
    const windir = process.env.WINDIR || "C:\\Windows";
    const csc = [
      join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
      join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
    ].find((p) => existsSync(p));
    h.check("windows: the in-box C# compiler exists (builds the native fake for omp and oz)", Boolean(csc));
    if (csc) {
      const csFile = join(shimDir, "fake-cli.cs");
      copyFileSync(join(fixturesDir, "fake-cli.cs"), csFile);
      const compiled = spawnSync(csc, ["/nologo", `/out:${join(shimDir, "omp.exe")}`, csFile], { encoding: "utf8" });
      h.check("windows: the native fake compiled", compiled.status === 0);
      if (compiled.status === 0) {
        copyFileSync(join(shimDir, "omp.exe"), join(shimDir, "oz.exe"));
      } else {
        console.error(`${compiled.stdout ?? ""}${compiled.stderr ?? ""}`);
      }
    }
  } else {
    for (const skill of SKILLS) {
      const shim = join(shimDir, binaryName(skill));
      // ${0%/*} is a shell builtin; an external `dirname` would vanish with /usr/bin
      // from the PATH that the Git-unavailable cases deliberately strip.
      writeFileSync(shim, `#!/bin/sh\nexec node "\${0%/*}/fake-cli.cjs" "$@"\n`);
      chmodSync(shim, 0o755);
    }
  }

  h.briefPath = join(h.scratch, "brief.txt");
  writeFileSync(h.briefPath, "smoke brief: run until killed.");
  let pathValue = shimDir + delimiter + process.env.PATH;
  if (isolatePath) {
    const git = resolveOnHost("git");
    h.check("isolated PATH: git resolves on the host", Boolean(git));
    if (WIN) {
      // Windows executables load sibling DLLs, so expose whole directories rather than links.
      const dirs = [pathDirname(process.execPath), git && pathDirname(git)].filter(Boolean);
      pathValue = [shimDir, ...new Set(dirs)].join(delimiter);
    } else {
      const toolDir = join(h.scratch, "tools");
      mkdirSync(toolDir);
      symlinkSync(process.execPath, join(toolDir, "node"));
      if (git) symlinkSync(git, join(toolDir, "git"));
      pathValue = shimDir + delimiter + toolDir;
    }
  }
  h.baseEnv = {
    ...process.env,
    PATH: pathValue,
    SMOKE_NODE: process.execPath,
  };

  const slowWriteHook = join(h.scratch, "slow-result-write.cjs");
  copyFileSync(join(fixturesDir, "slow-result-write.cjs"), slowWriteHook);
  h.slowWriteNodeOptions = [process.env.NODE_OPTIONS, `--require=${JSON.stringify(slowWriteHook.replaceAll("\\", "/"))}`]
    .filter(Boolean)
    .join(" ");
}
