import { runPackageShape } from "./package-shape.mjs";
import { runSyntax } from "./syntax.mjs";
import { runCodex } from "./codex.mjs";
import { runCursor } from "./cursor.mjs";
import { runOpencode } from "./opencode.mjs";
import { runAtomic } from "./atomic.mjs";
import { runPreflight } from "./preflight.mjs";
import { runTimeoutBounds } from "./timeout-bounds.mjs";
import { runClaude } from "./claude.mjs";
import { runReadOnlyTripwire } from "./read-only-tripwire.mjs";
import { runTimeoutTree } from "./timeout-tree.mjs";
import { runAbort } from "./abort.mjs";
import { runOrphanStdio } from "./orphan-stdio.mjs";
import { runSetup } from "./setup.mjs";
import { runPi } from "./pi.mjs";
import { runOmp } from "./omp.mjs";

export const runners = [
  ["package-shape", runPackageShape],
  ["syntax", runSyntax],
  ["codex", runCodex],
  ["cursor", runCursor],
  ["opencode", runOpencode],
  ["atomic", runAtomic],
  ["preflight", runPreflight],
  ["timeout-bounds", runTimeoutBounds],
  ["claude", runClaude],
  ["pi", runPi],
  ["omp", runOmp],
  ["read-only-tripwire", runReadOnlyTripwire],
  ["timeout-tree", runTimeoutTree],
  ["abort", runAbort],
  ["orphan-stdio", runOrphanStdio],
  ["setup", runSetup],
];
