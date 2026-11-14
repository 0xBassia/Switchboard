import { join } from "node:path";

export const SKILLS = ["claude", "codex", "cursor", "opencode", "pi", "omp", "warp"];

export const EXTRA_ARGS = {
  claude: [],
  codex: [],
  cursor: [],
  opencode: ["--model", "fake/model"],
  pi: [],
  omp: [],
  warp: [],
};

export const WIN = process.platform === "win32";

export const binaryName = (skill) => (skill === "cursor" ? "cursor-agent" : skill === "warp" ? "oz" : skill);

export const skillDir = (skill) => `switchboard-${skill}`;

export const relayPath = (testDir, skill) =>
  join(testDir, "..", "skills", `switchboard-${skill}`, "scripts", "relay.mjs");
