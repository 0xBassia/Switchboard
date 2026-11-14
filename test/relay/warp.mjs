import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// oz is a native binary (no shell): every flag reaches it as its own argv entry, and the
// brief rides --prompt verbatim.
export async function runWarp(h) {
  const argsFile = join(h.scratch, "args-warp");
  const workDir = h.freshRepo("work-warp");
  const run = spawnSync(process.execPath, [
    h.relayPath("warp"), "--brief", h.briefPath, "--cd", workDir, "--out-dir", join(h.scratch, "out-warp"),
    "--profile", "team-profile", "--skill", "review-skill", "--no-snapshot", "--conversation", "conv-123",
  ], { env: { ...h.baseEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: argsFile }, encoding: "utf8" });
  const args = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : [];
  h.check("warp: the relay runs oz agent run with ndjson output", run.status === 0 && args[0] === "agent" && args[1] === "run" && h.pair(args, "--output-format", "ndjson"));
  h.check("warp: --cwd pins the working directory", h.pair(args, "--cwd", workDir));
  h.check("warp: --profile, --skill and --conversation reach oz", h.pair(args, "--profile", "team-profile") && h.pair(args, "--skill", "review-skill") && h.pair(args, "--conversation", "conv-123"));
  h.check("warp: --no-snapshot reaches oz", args.includes("--no-snapshot"));
  h.check("warp: the brief is the --prompt value, verbatim", h.pair(args, "--prompt", readFileSync(h.briefPath, "utf8")));
  const unsafe = spawnSync(process.execPath, [h.relayPath("warp"), "--brief", h.briefPath, "--cd", workDir, "--profile", "--skill"],
    { env: h.baseEnv, encoding: "utf8" });
  h.check("warp: a flag-like value is rejected before dispatch", unsafe.status === 2);
}
