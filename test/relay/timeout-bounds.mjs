import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runTimeoutBounds(h) {
const badTimeoutWorkDir = h.freshRepo("work-bad-timeout");
for (const skill of h.SKILLS) {
  // One directory per value: a single leak would otherwise fail every later value too.
  for (const [i, bad] of ["NONSENSE", "", "10", "10s-junk", "1.5s", "1h30", "0s", "596h31m24s", "600h", "10000h"].entries()) {
    const outDir = join(h.scratch, `out-bad-timeout-${skill}-${i}`);
    const rejected = spawnSync(process.execPath, [
      h.relayPath(skill),
      "--brief", h.briefPath,
      "--cd", badTimeoutWorkDir,
      "--out-dir", outDir,
      "--timeout", bad,
      ...h.EXTRA_ARGS[skill],
    ], { env: h.baseEnv, encoding: "utf8", timeout: 10_000 });
    h.check(`${skill} timeout: "${bad}" is rejected before artifacts`,
      rejected.status === 2 && !existsSync(outDir));
  }
  // Positive control for the bound above: the largest duration the h/m/s grammar can express
  // under the ceiling is still a legitimate budget, so validation must not over-reject the edge.
  const accepted = spawnSync(process.execPath, [
    h.relayPath(skill),
    "--brief", h.briefPath,
    "--cd", badTimeoutWorkDir,
    "--out-dir", join(h.scratch, `out-max-timeout-${skill}`),
    "--timeout", "596h31m23s",
    ...h.EXTRA_ARGS[skill],
  ], {
    env: {
      ...process.env,
      PATH: "",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  h.check(`${skill} timeout: the largest schedulable duration is accepted`, accepted.status !== 2);
}
}
