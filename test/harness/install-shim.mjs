import { spawnSync } from "node:child_process";
import { copyFileSync, writeFileSync, mkdirSync, chmodSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS, binaryName } from "./constants.mjs";

const harnessDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(harnessDir, "..", "fixtures");

// Resolves a host executable once (which); null when absent.
function resolveOnHost(name) {
  const r = spawnSync("which", [name], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
}

// With { isolatePath: true } PATH holds only the shim dir plus node and git, so a CLI
// installed on the host (a real pi, say) can never be picked up by a test.
export function installShim(h, { isolatePath = false } = {}) {
  const shimDir = join(h.scratch, "shim");
  mkdirSync(shimDir);
  copyFileSync(join(fixturesDir, "fake-cli.cjs"), join(shimDir, "fake-cli.cjs"));

  for (const skill of SKILLS) {
    const shim = join(shimDir, binaryName(skill));
    // ${0%/*} is a shell builtin; an external `dirname` would vanish with /usr/bin
    // from the PATH that the Git-unavailable cases deliberately strip.
    writeFileSync(shim, `#!/bin/sh\nexec node "\${0%/*}/fake-cli.cjs" "$@"\n`);
    chmodSync(shim, 0o755);
  }

  h.briefPath = join(h.scratch, "brief.txt");
  writeFileSync(h.briefPath, "smoke brief: run until killed.");
  let pathValue = `${shimDir}:${process.env.PATH}`;
  if (isolatePath) {
    const git = resolveOnHost("git");
    h.check("isolated PATH: git resolves on the host", Boolean(git));
    const toolDir = join(h.scratch, "tools");
    mkdirSync(toolDir);
    symlinkSync(process.execPath, join(toolDir, "node"));
    if (git) symlinkSync(git, join(toolDir, "git"));
    pathValue = `${shimDir}:${toolDir}`;
  }
  h.baseEnv = {
    ...process.env,
    PATH: pathValue,
    SMOKE_NODE: process.execPath,
  };

  const slowWriteHook = join(h.scratch, "slow-result-write.cjs");
  copyFileSync(join(fixturesDir, "slow-result-write.cjs"), slowWriteHook);
  h.slowWriteNodeOptions = [process.env.NODE_OPTIONS, `--require=${JSON.stringify(slowWriteHook)}`]
    .filter(Boolean)
    .join(" ");
}
