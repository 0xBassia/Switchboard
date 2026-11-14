import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { SKILLS, WIN, binaryName } from "./constants.mjs";

const harnessDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(harnessDir, "..", "fixtures");

export function installShim(h) {
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
  h.baseEnv = {
    ...process.env,
    PATH: shimDir + delimiter + process.env.PATH,
    SMOKE_NODE: process.execPath,
  };

  const slowWriteHook = join(h.scratch, "slow-result-write.cjs");
  copyFileSync(join(fixturesDir, "slow-result-write.cjs"), slowWriteHook);
  h.slowWriteNodeOptions = [process.env.NODE_OPTIONS, `--require=${JSON.stringify(slowWriteHook.replaceAll("\\", "/"))}`]
    .filter(Boolean)
    .join(" ");
}
