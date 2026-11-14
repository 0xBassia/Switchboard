// Fleet lanes: resolve a named lane through the switchboard-setup skill and apply
// its dials. Explicit flags always win over lane dials.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./cli.mjs";

// A dial is skipped when any of these explicitly passed flags already decides it.
// Adapters extend this table for their own mode flags.
export const LANE_CONFLICTS = {
  agent: ["agent", "readOnly"],
  sandbox: ["sandbox", "readOnly"],
  readOnly: ["readOnly"],
};

export function applyFleetLane(opts, flagged, implementer, { conflicts = {}, onDial } = {}) {
  if (!opts.lane) return;
  const script = join(dirname(fileURLToPath(import.meta.url)), "../../switchboard-setup/scripts/lane.mjs");
  if (!existsSync(script)) {
    fail("--lane requires the switchboard-setup skill installed beside this relay");
  }
  const r = spawnSync(
    process.execPath,
    [script, "resolve", "--cwd", opts.cd, "--lane", opts.lane, "--implementer", implementer],
    { encoding: "utf8", env: process.env, timeout: 30_000, killSignal: "SIGKILL" },
  );
  if (r.error) fail(`lane resolve failed: ${r.error.message}`);
  if (r.status !== 0) {
    fail((r.stderr || "lane resolve failed").trim().replace(/^lane\.mjs:\s*/, ""));
  }
  let resolved;
  try {
    const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
    resolved = JSON.parse(lines[lines.length - 1]);
  } catch {
    fail("lane resolve returned invalid JSON");
  }
  opts.laneSource = resolved.source;
  const table = { ...LANE_CONFLICTS, ...conflicts };
  for (const [field, value] of Object.entries(resolved.dials || {})) {
    const deciders = table[field] || [field];
    if (deciders.some((key) => flagged.has(key))) continue;
    opts[field] = value;
    if (onDial) onDial(field, value, opts);
  }
}
