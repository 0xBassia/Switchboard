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

export const binaryName = (skill) => (skill === "cursor" ? "cursor-agent" : skill === "warp" ? "oz" : skill);

export const skillDir = (skill) => `delegit-${skill}`;

export const relayPath = (testDir, skill) =>
  join(testDir, "..", "skills", `delegit-${skill}`, "scripts", "relay.mjs");
