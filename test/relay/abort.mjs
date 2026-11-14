import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runAbort(h) {
if (h.WIN) {
  console.log("  skip  aborted-path scenarios: Windows delivers no catchable SIGTERM to drive them");
} else {
  for (const skill of h.SKILLS) {
    const outDir = join(h.scratch, `out-abort-${skill}`);
    const pidFile = join(h.scratch, `pid-abort-${skill}`);
    const grandPidFile = join(h.scratch, `grandpid-abort-${skill}`);
    const workDir = h.freshRepo(`work-abort-${skill}`);
    const lateFile = join(workDir, "late-file.txt");
    const extraArgs = h.EXTRA_ARGS[skill];
    const child = h.runRelay(skill, workDir, outDir, extraArgs, { SMOKE_PID_FILE: pidFile, SMOKE_GRAND_PID_FILE: grandPidFile, SMOKE_MODE: "abort", SMOKE_LATE_FILE: lateFile });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    h.check(`${skill} aborted: the fake implementer came up`, await h.until(() => existsSync(pidFile), 10_000));
    const grandPid = existsSync(grandPidFile) ? Number(readFileSync(grandPidFile, "utf8")) : null;
    child.kill("SIGTERM");
    const exited = await new Promise((res) => {
      const t = setTimeout(() => res(false), 20_000);
      child.on("close", () => { clearTimeout(t); res(true); });
    });
    h.check(`${skill} aborted: the relay exited after the grace window`, exited);
    h.check(`${skill} aborted: result.json exists`, existsSync(join(outDir, "result.json")));
    if (existsSync(join(outDir, "result.json"))) {
      const r = h.result(outDir);
      h.check(`${skill} aborted: status is "aborted" (got ${r.status})`, r.status === "aborted");
      h.check(`${skill} aborted: the file flushed during shutdown is in touchedFiles`,
        Array.isArray(r.touchedFiles) && r.touchedFiles.some((f) => f.includes("late-file.txt")));
    }
    h.check(`${skill} aborted: the implementer's own subprocess is dead (whole tree felled)`,
      grandPid !== null && await h.until(() => !h.alive(grandPid), 20_000));
    if (h.failed) console.error(`${skill} relay stderr tail:\n${stderr.split("\n").slice(-6).join("\n")}`);
  }

  const outDir = join(h.scratch, "out-abort-defiant-omp");
  const pidFile = join(h.scratch, "pid-abort-defiant-omp");
  const grandPidFile = join(h.scratch, "grandpid-abort-defiant-omp");
  const workDir = h.freshRepo("work-abort-defiant-omp");
  const child = h.runRelay("omp", workDir, outDir, [], {
    SMOKE_PID_FILE: pidFile,
    SMOKE_GRAND_PID_FILE: grandPidFile,
    SMOKE_GRAND_IGNORES_SIGTERM: "1",
    SMOKE_MODE: "abort-defiant",
  });
  h.check("omp defiant abort: the fake implementer came up",
    await h.until(() => existsSync(pidFile), 10_000));
  const implementerPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
  const grandPid = existsSync(grandPidFile) ? Number(readFileSync(grandPidFile, "utf8")) : null;
  child.kill("SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  h.check("omp defiant abort: relay exits after forced termination", exited);
  h.check("omp defiant abort: result is aborted",
    existsSync(join(outDir, "result.json")) && h.result(outDir).status === "aborted");
  h.check("omp defiant abort: the implementer process is dead",
    implementerPid !== null && await h.until(() => !h.alive(implementerPid), 5000));
  h.check("omp defiant abort: the implementer's own subprocess is dead",
    grandPid !== null && await h.until(() => !h.alive(grandPid), 5000));
}
}
