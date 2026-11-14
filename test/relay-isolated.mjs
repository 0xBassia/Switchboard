#!/usr/bin/env node
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The shared list, which package-shape checks against the skills on disk.
import { SKILLS as RELAYS } from "./harness/constants.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (name, condition) => {
  console.log(`${condition ? "  ok " : "  FAIL"}  ${name}`);
  if (!condition) failed += 1;
};

for (const relay of RELAYS) {
  const temp = mkdtempSync(join(tmpdir(), `switchboard-${relay}-`));
  try {
    cpSync(join(here, "..", "skills", `switchboard-${relay}`), join(temp, `switchboard-${relay}`), { recursive: true });
    const result = spawnSync(process.execPath, ["scripts/relay.mjs", "--help"], {
      cwd: join(temp, `switchboard-${relay}`),
      encoding: "utf8",
    });
    check(`${relay}: isolated --help`, result.status === 0 && Boolean(result.stdout.trim()));
    if (result.status !== 0 || !result.stdout.trim()) {
      console.log(`        exit ${result.status}; ${(result.stderr || result.error?.message || "no output").trim()}`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (failed) {
  console.error(`relay isolated install: ${failed} failure(s)`);
  process.exit(1);
}
console.log("relay isolated install: all checks passed");
