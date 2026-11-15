import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Native Windows is not supported: every entry point refuses it with exit 2 and the WSL
// pointer before it reads config or writes anything, while --help still answers. The
// platform is faked with a preload, so this runs on any POSIX host.
const WSL_MESSAGE = "delegit: native Windows is not supported; run it inside WSL (https://learn.microsoft.com/windows/wsl/)";

export function runNativeWindows(h) {
  const preload = join(h.scratch, "fake-win32.mjs");
  writeFileSync(preload, 'Object.defineProperty(process, "platform", { value: "win32" });\n');
  const skillsDir = join(h.testDir, "..", "skills");
  const asWin32 = (script, args, env = h.baseEnv) =>
    spawnSync(process.execPath, ["--import", preload, script, ...args], { env, encoding: "utf8", timeout: 20_000 });
  const refused = (run) => run.status === 2 && run.stderr.includes(WSL_MESSAGE) && run.stdout === "";

  {
    const workDir = h.freshRepo("work-native-windows-pi");
    const outDir = join(h.scratch, "out-native-windows-pi");
    const run = asWin32(h.relayPath("pi"), ["--brief", h.briefPath, "--cd", workDir, "--out-dir", outDir],
      { ...h.baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: join(h.scratch, "args-native-windows-pi") });
    h.check(`native Windows: the pi relay refuses with exit 2 and the WSL pointer (got ${run.status})`, refused(run));
    h.check("native Windows: the pi relay writes no artifacts and never launches pi",
      !existsSync(outDir) && !existsSync(join(h.scratch, "args-native-windows-pi")));
    const help = asWin32(h.relayPath("pi"), ["--help"]);
    h.check("native Windows: pi --help still answers", help.status === 0 && help.stdout.includes("relay.mjs"));
  }
  {
    const queue = join(skillsDir, "delegit-queue", "scripts", "queue.mjs");
    const queueFile = join(h.scratch, "native-windows-queue.json");
    const outDir = join(h.scratch, "out-native-windows-queue");
    writeFileSync(queueFile, JSON.stringify({ version: "delegit-queue.v1", tasks: [{ id: "a", brief: h.briefPath, implementer: "pi" }] }));
    const run = asWin32(queue, ["run", queueFile, "--cd", h.freshRepo("work-native-windows-queue"), "--out-dir", outDir]);
    h.check(`native Windows: the queue refuses with exit 2 and the WSL pointer (got ${run.status})`, refused(run));
    h.check("native Windows: the queue writes no artifacts", !existsSync(outDir));
    const help = asWin32(queue, ["--help"]);
    h.check("native Windows: queue --help still answers", help.status === 0 && help.stdout.includes("queue.mjs"));
  }
  for (const [script, args] of [
    ["config.mjs", ["load"]],
    ["discover.mjs", []],
    ["lane.mjs", ["resolve", "--lane", "feature", "--implementer", "pi"]],
  ]) {
    const path = join(skillsDir, "delegit-setup", "scripts", script);
    const run = asWin32(path, args);
    h.check(`native Windows: setup ${script} refuses with exit 2 and the WSL pointer (got ${run.status})`, refused(run));
    const help = asWin32(path, ["--help"]);
    h.check(`native Windows: setup ${script} --help still answers`, help.status === 0 && help.stdout.trim().length > 0);
  }
}
