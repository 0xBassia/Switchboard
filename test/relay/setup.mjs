import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- delegit-setup: discover + fleet (fleet lanes) ----
export function runSetup(h) {
  const setupDir = join(h.testDir, "..", "skills", "delegit-setup", "scripts");
  for (const script of ["discover.mjs", "config.mjs", "implementers.mjs", "lane.mjs"]) {
    const c = spawnSync(process.execPath, ["--check", join(setupDir, script)], { encoding: "utf8" });
    h.check(`syntax: delegit-setup/scripts/${script}`, c.status === 0);
  }

  const help = spawnSync(process.execPath, [join(setupDir, "discover.mjs"), "--help"], { encoding: "utf8" });
  h.check("discover --help exits 0", help.status === 0 && /discover\.mjs/.test(help.stdout));

  const discover = spawnSync(process.execPath, [join(setupDir, "discover.mjs")], {
    encoding: "utf8",
    timeout: 120_000,
  });
  h.check("discover exits 0", discover.status === 0);
  let report = null;
  try {
    report = JSON.parse(discover.stdout);
  } catch {
    report = null;
  }
  h.check("discover reports version", report?.version === "delegit-discover.v1");
  h.check("discover lists discovered or missing", Array.isArray(report?.discovered) && Array.isArray(report?.missing));
  h.check(
    "discover covers every implementer in the smoke matrix",
    Array.isArray(report?.discovered) &&
      Array.isArray(report?.missing) &&
      [...report.discovered, ...report.missing].map((entry) => entry.key).sort().join(",") ===
        [...h.SKILLS].sort().join(","),
  );

  // An empty PATH component is the current directory in POSIX lookup. The
  // relays drop such entries so a checkout can never supply a CLI, and
  // discovery must agree: a binary only the current directory holds is missing.
  const cwdProbe = join(h.scratch, "discover-cwd");
  mkdirSync(cwdProbe);
  writeFileSync(
    join(cwdProbe, "codex"),
    '#!/bin/sh\ncase "$1" in --version) echo "9.9.9"; exit 0;; esac\nexit 0\n',
  );
  chmodSync(join(cwdProbe, "codex"), 0o755);
  for (const [label, pathValue] of [
    ["an empty PATH component", ":"],
    ["a set-but-empty PATH", ""],
  ]) {
    const cwdDiscover = spawnSync(process.execPath, [join(setupDir, "discover.mjs")], {
      encoding: "utf8",
      cwd: cwdProbe,
      env: { ...process.env, PATH: pathValue },
    });
    const cwdReport = cwdDiscover.status === 0 ? JSON.parse(cwdDiscover.stdout) : null;
    h.check(
      `discover ignores ${label} (the current directory never supplies a CLI)`,
      cwdReport !== null && !cwdReport.discovered.some((d) => d.key === "codex"),
    );
  }

  // Keep fixtures inside the repo tree so sandboxed CI/dev runs can write; seed a
  // minimal .git without `git init` (hooks/config writes are often blocked).
  const fleetRoot = mkdtempSync(join(h.testDir, "..", ".tmp-fleet-smoke-"));
  const cfgHome = join(fleetRoot, "home");
  const cfgRepo = join(fleetRoot, "repo");
  const bare = join(fleetRoot, "bare");
  mkdirSync(cfgHome);
  mkdirSync(cfgRepo);
  mkdirSync(bare);
  mkdirSync(join(cfgRepo, ".git", "objects"), { recursive: true });
  mkdirSync(join(cfgRepo, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(cfgRepo, ".git", "HEAD"), "ref: refs/heads/master\n");
  writeFileSync(
    join(cfgRepo, ".git", "config"),
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n",
  );
  // Node's os.homedir() uses HOME.
  const prevHome = process.env.HOME;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = cfgHome;
  delete process.env.XDG_CONFIG_HOME;

  try {
    const good = {
      version: "delegit-fleet.v1",
      lanes: {
        feature: { implementer: "opencode", model: "opencode/gpt-5", variant: "high" },
        tests: { implementer: "codex", effort: "medium" },
        "codex-review": { implementer: "codex", readOnly: true },
        "opencode-review": { implementer: "opencode", model: "opencode/gpt-5", readOnly: true },
        "omp-review": { implementer: "omp", readOnly: true, effort: "high" },
      },
    };
    const goodFile = join(cfgRepo, "lanes.json");
    writeFileSync(goodFile, `${JSON.stringify(good, null, 2)}\n`);

    const validate = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", goodFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate accepts a good map", validate.status === 0);

    const bareOpenCode = {
      version: "delegit-fleet.v1",
      lanes: { feature: { implementer: "opencode" } },
    };
    const bareOpenCodeFile = join(cfgRepo, "bare-opencode.json");
    writeFileSync(bareOpenCodeFile, `${JSON.stringify(bareOpenCode)}\n`);
    const rejectBare = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", bareOpenCodeFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate requires model on opencode", rejectBare.status === 2);

    const bareModel = {
      version: "delegit-fleet.v1",
      lanes: { feature: { implementer: "opencode", model: "gpt-5" } },
    };
    const bareModelFile = join(cfgRepo, "bare-model.json");
    writeFileSync(bareModelFile, `${JSON.stringify(bareModel)}\n`);
    const rejectBareModel = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", bareModelFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate requires provider/model for opencode", rejectBareModel.status === 2);

    const codexProvider = {
      version: "delegit-fleet.v1",
      lanes: { feature: { implementer: "codex", provider: "echo" } },
    };
    const codexProviderFile = join(cfgRepo, "codex-provider.json");
    writeFileSync(codexProviderFile, `${JSON.stringify(codexProvider)}\n`);
    const rejectCodexProvider = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", codexProviderFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects provider on codex",
      rejectCodexProvider.status === 2 && /does not support provider/.test(rejectCodexProvider.stderr));

    const ompEffort = {
      version: "delegit-fleet.v1",
      lanes: { feature: { implementer: "omp", effort: "banana" } },
    };
    const ompEffortFile = join(cfgRepo, "omp-effort.json");
    writeFileSync(ompEffortFile, `${JSON.stringify(ompEffort)}\n`);
    const rejectOmpEffort = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", ompEffortFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects unknown omp effort",
      rejectOmpEffort.status === 2 && /off, auto, minimal/.test(rejectOmpEffort.stderr));

    for (const [model, boundary] of [
      ["opencode/", "after"],
      ["/gpt-5", "before"],
      ["opencode//", "after"],
    ]) {
      const malformedModel = {
        version: "delegit-fleet.v1",
        lanes: { feature: { implementer: "opencode", model } },
      };
      const malformedModelFile = join(cfgRepo, `malformed-opencode-model-${boundary}-${model.length}.json`);
      writeFileSync(malformedModelFile, `${JSON.stringify(malformedModel)}\n`);
      const rejected = spawnSync(
        process.execPath,
        [join(setupDir, "config.mjs"), "validate", malformedModelFile],
        { encoding: "utf8", env: process.env },
      );
      h.check(
        `config validate requires model text ${boundary} the opencode provider separator (${model})`,
        rejected.status === 2,
      );
    }

    const hugeTimeout = {
      version: "delegit-fleet.v1",
      lanes: { slow: { implementer: "warp", timeout: "999999999h" } },
    };
    const hugeTimeoutFile = join(cfgRepo, "huge-timeout.json");
    writeFileSync(hugeTimeoutFile, `${JSON.stringify(hugeTimeout)}\n`);
    const rejectTimeout = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", hugeTimeoutFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects timeout above relay ceiling", rejectTimeout.status === 2);

    const conflictAutonomy = {
      version: "delegit-fleet.v1",
      lanes: { feature: { implementer: "codex", readOnly: true, sandbox: "danger-full-access" } },
    };
    const conflictFile = join(cfgRepo, "conflict-autonomy.json");
    writeFileSync(conflictFile, `${JSON.stringify(conflictAutonomy)}\n`);
    const rejectConflict = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", conflictFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects contradictory readOnly+sandbox", rejectConflict.status === 2);

    const badClaudeModel = {
      version: "delegit-fleet.v1",
      lanes: { feature: { implementer: "claude", model: "bad model" } },
    };
    const badClaudeModelFile = join(cfgRepo, "bad-claude-model.json");
    writeFileSync(badClaudeModelFile, `${JSON.stringify(badClaudeModel)}\n`);
    const rejectClaudeModel = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "validate", badClaudeModelFile],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "config validate rejects claude model tokens the relay would reject",
      rejectClaudeModel.status === 2 && /unsupported characters/.test(rejectClaudeModel.stderr),
    );

    const badCodexModel = {
      version: "delegit-fleet.v1",
      lanes: { feature: { implementer: "codex", model: "x & whoami" } },
    };
    const badCodexModelFile = join(cfgRepo, "bad-codex-model.json");
    writeFileSync(badCodexModelFile, `${JSON.stringify(badCodexModel)}\n`);
    const rejectCodexModel = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "validate", badCodexModelFile],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "config validate rejects shell-unsafe codex model",
      rejectCodexModel.status === 2 && /unsupported characters/.test(rejectCodexModel.stderr),
    );
    for (const [field, value] of [["model", "a b;c"], ["effort", "very fast"]]) {
      const badCodexDial = {
        version: "delegit-fleet.v1",
        lanes: { feature: { implementer: "codex", [field]: value } },
      };
      const badCodexDialFile = join(cfgRepo, `bad-codex-dial-${field}.json`);
      writeFileSync(badCodexDialFile, `${JSON.stringify(badCodexDial)}\n`);
      const rejected = spawnSync(
        process.execPath,
        [join(setupDir, "config.mjs"), "validate", badCodexDialFile],
        { encoding: "utf8", env: process.env },
      );
      h.check(`config validate rejects Codex ${field} tokens the relay would reject`,
        rejected.status === 2);
    }
    const unsafeCodexFlag = spawnSync(
      process.execPath,
      [h.relayPath("codex"), "--brief", h.briefPath, "--model", "x & whoami"],
      { encoding: "utf8", env: h.baseEnv },
    );
    h.check("codex relay rejects shell-unsafe --model", unsafeCodexFlag.status === 2);

    const badVariant = {
      version: "delegit-fleet.v1",
      lanes: { feature: { implementer: "opencode", model: "opencode/gpt-5", variant: "high & whoami" } },
    };
    const badVariantFile = join(cfgRepo, "bad-variant.json");
    writeFileSync(badVariantFile, `${JSON.stringify(badVariant)}\n`);
    const rejectVariant = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "validate", badVariantFile],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "config validate rejects shell-unsafe opencode variant",
      rejectVariant.status === 2 && /variant/.test(rejectVariant.stderr),
    );
    const unsafeVariantFlag = spawnSync(
      process.execPath,
      [h.relayPath("opencode"), "--brief", h.briefPath, "--model", "opencode/gpt-5", "--variant", "high & whoami"],
      { encoding: "utf8", env: h.baseEnv },
    );
    h.check("opencode relay rejects shell-unsafe --variant", unsafeVariantFlag.status === 2);

    // OpenCode catalog ids carry '@' and '~', neither of which is a shell metacharacter.
    for (const [shape, model] of [
      ["Workers AI @cf/", "cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
      ["Vertex @default", "google-vertex-anthropic/claude-opus-4-8@default"],
      ["region @eu", "requesty/gpt-6.1-sol@eu"],
      ["OpenRouter ~latest", "openrouter/~anthropic/claude-sonnet-latest"],
    ]) {
      const catalogModel = {
        version: "delegit-fleet.v1",
        lanes: { feature: { implementer: "opencode", model } },
      };
      const catalogModelFile = join(cfgRepo, `catalog-opencode-model-${shape.replace(/\W+/g, "-")}.json`);
      writeFileSync(catalogModelFile, `${JSON.stringify(catalogModel)}\n`);
      const acceptCatalogModel = spawnSync(
        process.execPath,
        [join(setupDir, "config.mjs"), "validate", catalogModelFile],
        { encoding: "utf8", env: process.env },
      );
      h.check(`config validate accepts opencode catalog model id (${shape})`, acceptCatalogModel.status === 0);
    }
    // '@' and '~' must not open the door to shell metacharacters ('&', '%') riding alongside them.
    for (const [index, model] of ["x/@cf & whoami", "x/~%PATH%"].entries()) {
      const badOpenCodeModel = {
        version: "delegit-fleet.v1",
        lanes: { feature: { implementer: "opencode", model } },
      };
      const badOpenCodeModelFile = join(cfgRepo, `bad-opencode-model-${index}.json`);
      writeFileSync(badOpenCodeModelFile, `${JSON.stringify(badOpenCodeModel)}\n`);
      const rejectOpenCodeModel = spawnSync(
        process.execPath,
        [join(setupDir, "config.mjs"), "validate", badOpenCodeModelFile],
        { encoding: "utf8", env: process.env },
      );
      h.check(
        `config validate rejects shell-unsafe opencode model (${model})`,
        rejectOpenCodeModel.status === 2 && /unsupported characters/.test(rejectOpenCodeModel.stderr),
      );
    }

    const badEffort = {
      version: "delegit-fleet.v1",
      lanes: { feature: { implementer: "opencode", model: "opencode/gpt-5", effort: "high" } },
    };
    const badFile = join(cfgRepo, "bad.json");
    writeFileSync(badFile, `${JSON.stringify(badEffort)}\n`);
    const rejectEffort = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", badFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects effort on opencode", rejectEffort.status === 2);

    const badClaude = {
      version: "delegit-fleet.v1",
      lanes: { feature: { implementer: "claude", effort: "banana" } },
    };
    const badClaudeFile = join(cfgRepo, "bad-claude.json");
    writeFileSync(badClaudeFile, `${JSON.stringify(badClaude)}\n`);
    const rejectClaude = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", badClaudeFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects unknown claude effort", rejectClaude.status === 2);

    const badOmp = {
      version: "delegit-fleet.v1",
      lanes: { feature: { implementer: "omp", effort: "inherit" } },
    };
    const badOmpFile = join(cfgRepo, "bad-omp.json");
    writeFileSync(badOmpFile, `${JSON.stringify(badOmp)}\n`);
    const rejectOmp = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", badOmpFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects unknown omp thinking effort",
      rejectOmp.status === 2 && /off, auto, minimal, low, medium, high, xhigh, max/.test(rejectOmp.stderr));

    const badCursorSandbox = {
      version: "delegit-fleet.v1",
      lanes: { feature: { implementer: "cursor", sandbox: "workspace-write" } },
    };
    const badCursorFile = join(cfgRepo, "bad-cursor.json");
    writeFileSync(badCursorFile, `${JSON.stringify(badCursorSandbox)}\n`);
    const rejectCursor = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "validate", badCursorFile], {
      encoding: "utf8",
      env: process.env,
    });
    h.check("config validate rejects cursor sandbox dial", rejectCursor.status === 2);

    const writeGlobal = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "write", "--scope", "global", goodFile],
      { encoding: "utf8", env: process.env },
    );
    h.check("config write --scope global", writeGlobal.status === 0);
    const globalPath = join(cfgHome, ".config", "delegit", "config.json");
    h.check("global config file created", existsSync(globalPath));

    // Phase 2: --lane resolve / mismatch / flag override (global map only so far).
    const laneResolve = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", cfgRepo, "--lane", "feature", "--implementer", "opencode"],
      { encoding: "utf8", env: process.env },
    );
    let laneJson = null;
    try {
      laneJson = JSON.parse(laneResolve.stdout);
    } catch {
      laneJson = null;
    }
    h.check(
      "lane resolve: feature → opencode dials",
      laneResolve.status === 0 &&
        laneJson?.implementer === "opencode" &&
        laneJson?.dials?.model === "opencode/gpt-5" &&
        laneJson?.dials?.variant === "high" &&
        laneJson?.source === "global",
    );

    const codexReadOnly = {
      version: "delegit-fleet.v1",
      lanes: { review: { implementer: "codex", readOnly: true } },
    };
    const codexReadOnlyFile = join(cfgRepo, "codex-readonly.json");
    writeFileSync(codexReadOnlyFile, `${JSON.stringify(codexReadOnly)}\n`);
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", codexReadOnlyFile], {
      encoding: "utf8",
      env: process.env,
    });
    const codexResolve = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", bare, "--lane", "review", "--implementer", "codex"],
      { encoding: "utf8", env: process.env },
    );
    let codexDials = null;
    try {
      codexDials = JSON.parse(codexResolve.stdout);
    } catch {
      codexDials = null;
    }
    h.check(
      "lane resolve: codex readOnly → sandbox read-only",
      codexResolve.status === 0 &&
        codexDials?.dials?.sandbox === "read-only" &&
        codexDials?.dials?.readOnly === undefined,
    );
    // Restore the multi-lane global map for the rest of the fleet suite.
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", goodFile], {
      encoding: "utf8",
      env: process.env,
    });

    const ompThinking = {
      version: "delegit-fleet.v1",
      lanes: { feature: { implementer: "omp", effort: "high", model: "google/fake-model" } },
    };
    const ompThinkingFile = join(cfgRepo, "omp-thinking.json");
    writeFileSync(ompThinkingFile, `${JSON.stringify(ompThinking)}\n`);
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", ompThinkingFile], {
      encoding: "utf8",
      env: process.env,
    });
    const ompResolve = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", bare, "--lane", "feature", "--implementer", "omp"],
      { encoding: "utf8", env: process.env },
    );
    let ompDials = null;
    try {
      ompDials = JSON.parse(ompResolve.stdout);
    } catch {
      ompDials = null;
    }
    h.check(
      "lane resolve: omp effort → thinking",
      ompResolve.status === 0 &&
        ompDials?.dials?.thinking === "high" &&
        ompDials?.dials?.effort === undefined &&
        ompDials?.dials?.model === "google/fake-model",
    );
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", goodFile], {
      encoding: "utf8",
      env: process.env,
    });

    const laneMismatchResolve = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", cfgRepo, "--lane", "feature", "--implementer", "claude"],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "lane resolve: wrong implementer fails loud",
      laneMismatchResolve.status === 2 && /use delegit-opencode/.test(laneMismatchResolve.stderr),
    );

    const laneBrief = join(cfgRepo, "lane-brief.txt");
    writeFileSync(laneBrief, "fleet lane smoke brief\n");
    const laneOut = join(cfgRepo, "out-lane-opencode");
    const laneArgsFile = join(cfgRepo, "args-lane-opencode.json");
    mkdirSync(laneOut, { recursive: true });
    // h.baseEnv snapped process.env before this block cleared XDG_CONFIG_HOME — drop it again.
    const fleetEnv = { ...h.baseEnv, HOME: cfgHome };
    delete fleetEnv.XDG_CONFIG_HOME;

    // Explicit Claude full-access must win over a readOnly lane (flags win).
    const claudeRoLane = {
      version: "delegit-fleet.v1",
      lanes: { review: { implementer: "claude", readOnly: true } },
    };
    const claudeRoFile = join(cfgRepo, "claude-readonly.json");
    writeFileSync(claudeRoFile, `${JSON.stringify(claudeRoLane)}\n`);
    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", claudeRoFile], {
      encoding: "utf8",
      env: process.env,
    });
    const claudeDspOut = join(cfgRepo, "out-claude-dsp");
    mkdirSync(claudeDspOut, { recursive: true });
    const claudeDspBrief = join(cfgRepo, "claude-dsp-brief.txt");
    writeFileSync(claudeDspBrief, "claude dsp override smoke\n");
    const claudeDsp = spawnSync(
      process.execPath,
      [
        h.relayPath("claude"),
        "--brief", claudeDspBrief,
        "--cd", cfgRepo,
        "--out-dir", claudeDspOut,
        "--lane", "review",
        "--dangerously-skip-permissions",
      ],
      {
        encoding: "utf8",
        env: {
          ...fleetEnv,
          SMOKE_MODE: "claude-success",
          SMOKE_CAPTURE_FILE: join(cfgRepo, "claude-dsp-capture.json"),
        },
      },
    );
    h.check(
      "relay --lane: Claude --dangerously-skip-permissions wins over readOnly lane",
      claudeDsp.status === 0 &&
        existsSync(join(claudeDspOut, "result.json")) &&
        h.result(claudeDspOut).dangerouslySkipPermissions === true &&
        h.result(claudeDspOut).readOnly === false,
    );

    spawnSync(process.execPath, [join(setupDir, "config.mjs"), "write", "--scope", "global", goodFile], {
      encoding: "utf8",
      env: process.env,
    });

    const laneDispatch = spawnSync(
      process.execPath,
      [
        h.relayPath("opencode"),
        "--brief", laneBrief,
        "--cd", cfgRepo,
        "--out-dir", laneOut,
        "--lane", "feature",
      ],
      {
        encoding: "utf8",
        env: {
          ...fleetEnv,
          SMOKE_MODE: "capture",
          SMOKE_ARGS_FILE: laneArgsFile,
          SMOKE_VERSION: "opencode v2.0.11",
        },
      },
    );
    const laneArgs = existsSync(laneArgsFile) ? JSON.parse(readFileSync(laneArgsFile, "utf8")) : [];
    // opencode 2.x has no --variant flag: the relay joins the dials as --model provider/model#variant.
    h.check("relay --lane: opencode applies model+variant from lane",
      laneDispatch.status === 0 &&
        h.pair(laneArgs, "--model", "opencode/gpt-5#high") &&
        !laneArgs.includes("--variant"));
    h.check("relay --lane: result records lane provenance",
      existsSync(join(laneOut, "result.json")) &&
        h.result(laneOut).lane === "feature" &&
        h.result(laneOut).laneSource === "global" &&
        h.result(laneOut).model === "opencode/gpt-5" &&
        h.result(laneOut).variant === "high");

    const codexResumeOut = join(cfgRepo, "out-lane-codex-resume");
    const codexResumeArgsFile = join(cfgRepo, "args-lane-codex-resume.json");
    mkdirSync(codexResumeOut, { recursive: true });
    const codexResume = spawnSync(
      process.execPath,
      [
        h.relayPath("codex"),
        "--brief", laneBrief,
        "--cd", cfgRepo,
        "--out-dir", codexResumeOut,
        "--lane", "codex-review",
        "--session", "thread-review",
      ],
      {
        encoding: "utf8",
        env: { ...fleetEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: codexResumeArgsFile },
      },
    );
    const codexResumeArgs = existsSync(codexResumeArgsFile)
      ? JSON.parse(readFileSync(codexResumeArgsFile, "utf8"))
      : [];
    h.check("relay --lane: Codex read-only lane applies before resume",
      codexResume.status === 0 &&
        h.pair(codexResumeArgs, "-s", "read-only") &&
        codexResumeArgs.indexOf("-s") < codexResumeArgs.indexOf("resume") &&
        h.result(codexResumeOut).sandbox === "read-only");
    const codexLaneNetworkOut = join(cfgRepo, "out-lane-codex-network");
    const codexLaneNetwork = spawnSync(
      process.execPath,
      [
        h.relayPath("codex"),
        "--brief", laneBrief,
        "--cd", cfgRepo,
        "--out-dir", codexLaneNetworkOut,
        "--lane", "codex-review",
        "--network-access",
      ],
      { encoding: "utf8", env: { ...fleetEnv, SMOKE_MODE: "capture" } },
    );
    h.check("relay --lane: Codex read-only lane rejects --network-access before artifacts",
      codexLaneNetwork.status === 2 && /--network-access/.test(codexLaneNetwork.stderr) &&
        /read-only/.test(codexLaneNetwork.stderr) && !/unknown option/.test(codexLaneNetwork.stderr) &&
        !existsSync(codexLaneNetworkOut));

    const opencodeResumeOut = join(cfgRepo, "out-lane-opencode-resume");
    const opencodeResumeArgsFile = join(cfgRepo, "args-lane-opencode-resume.json");
    mkdirSync(opencodeResumeOut, { recursive: true });
    const opencodeResume = spawnSync(
      process.execPath,
      [
        h.relayPath("opencode"),
        "--brief", laneBrief,
        "--cd", cfgRepo,
        "--out-dir", opencodeResumeOut,
        "--lane", "opencode-review",
        "--session", "ses_review",
      ],
      {
        encoding: "utf8",
        env: { ...fleetEnv, SMOKE_MODE: "capture", SMOKE_ARGS_FILE: opencodeResumeArgsFile },
      },
    );
    const opencodeResumeArgs = existsSync(opencodeResumeArgsFile)
      ? JSON.parse(readFileSync(opencodeResumeArgsFile, "utf8"))
      : [];
    h.check("relay --lane: OpenCode read-only lane selects plan on resume",
      opencodeResume.status === 0 &&
        h.pair(opencodeResumeArgs, "--agent", "plan") &&
        !opencodeResumeArgs.includes("--auto") &&
        h.result(opencodeResumeOut).agent === "plan" &&
        h.result(opencodeResumeOut).resumed === true);

    const wrongSkill = spawnSync(
      process.execPath,
      [h.relayPath("claude"), "--brief", laneBrief, "--cd", cfgRepo, "--lane", "feature"],
      { encoding: "utf8", env: fleetEnv },
    );
    h.check(
      "relay --lane: wrong skill fails loud (no remap)",
      wrongSkill.status === 2 &&
        /use delegit-opencode/.test(wrongSkill.stderr) &&
        !existsSync(join(cfgRepo, "result.json")),
    );

    const overrideOut = join(cfgRepo, "out-lane-override");
    const overrideArgsFile = join(cfgRepo, "args-lane-override.json");
    mkdirSync(overrideOut, { recursive: true });
    const overrideRun = spawnSync(
      process.execPath,
      [
        h.relayPath("opencode"),
        "--brief", laneBrief,
        "--cd", cfgRepo,
        "--out-dir", overrideOut,
        "--lane", "feature",
        "--model", "openai/gpt-test",
        "--variant", "low",
      ],
      {
        encoding: "utf8",
        env: {
          ...fleetEnv,
          SMOKE_MODE: "capture",
          SMOKE_ARGS_FILE: overrideArgsFile,
          SMOKE_VERSION: "opencode v2.0.11",
        },
      },
    );
    const overrideArgs = existsSync(overrideArgsFile) ? JSON.parse(readFileSync(overrideArgsFile, "utf8")) : [];
    h.check("relay --lane: explicit flags win over lane dials",
      overrideRun.status === 0 &&
        h.pair(overrideArgs, "--model", "openai/gpt-test#low") &&
        !overrideArgs.includes("--variant"));

    const projectOnly = {
      version: "delegit-fleet.v1",
      lanes: {
        feature: { implementer: "claude", effort: "high" },
      },
    };
    const projectFile = join(cfgRepo, "project-lanes.json");
    writeFileSync(projectFile, `${JSON.stringify(projectOnly, null, 2)}\n`);

    const untrustedProject = {
      version: "delegit-fleet.v1",
      lanes: {
        feature: { implementer: "codex", sandbox: "danger-full-access" },
      },
    };
    mkdirSync(join(cfgRepo, ".delegit"), { recursive: true });
    writeFileSync(
      join(cfgRepo, ".delegit", "config.json"),
      `${JSON.stringify(untrustedProject, null, 2)}\n`,
    );
    const rejectUntrustedProject = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", cfgRepo, "--lane", "feature", "--implementer", "codex"],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "lane resolve: cloned project config fails closed until approved",
      rejectUntrustedProject.status === 2 && /project fleet config is not trusted/.test(rejectUntrustedProject.stderr),
    );

    const writeProject = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "write", "--scope", "project", "--cwd", cfgRepo, projectFile],
      { encoding: "utf8", env: process.env },
    );
    h.check("config write --scope project", writeProject.status === 0);
    h.check("project config file created", existsSync(join(cfgRepo, ".delegit", "config.json")));
    h.check(
      "project config approval hash lives under git metadata",
      existsSync(join(cfgRepo, ".git", "delegit", "project-config.sha256")),
    );

    // Symlinked .delegit must not escape the repo.
    const escapeRepo = join(fleetRoot, "escape-repo");
    const escapeOutside = join(fleetRoot, "escape-outside");
    mkdirSync(escapeRepo);
    mkdirSync(escapeOutside);
    mkdirSync(join(escapeRepo, ".git", "objects"), { recursive: true });
    mkdirSync(join(escapeRepo, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(escapeRepo, ".git", "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(join(escapeRepo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    try {
      symlinkSync(escapeOutside, join(escapeRepo, ".delegit"));
      const escapeWrite = spawnSync(
        process.execPath,
        [join(setupDir, "config.mjs"), "write", "--scope", "project", "--cwd", escapeRepo, projectFile],
        { encoding: "utf8", env: process.env },
      );
      h.check(
        "config write rejects symlinked .delegit",
        escapeWrite.status === 2 &&
          /symlink/.test(escapeWrite.stderr) &&
          !existsSync(join(escapeOutside, "config.json")),
      );
    } catch (error) {
      h.check(`config write symlink guard runnable (${error.code || error.message})`, false);
    }

    const load = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "load", "--cwd", cfgRepo],
      { encoding: "utf8", env: process.env },
    );
    h.check("config load exits 0", load.status === 0);
    let effective = null;
    try {
      effective = JSON.parse(load.stdout);
    } catch {
      effective = null;
    }
    h.check(
      "effective feature lane is project (whole-lane replace)",
      effective?.lanes?.feature?.implementer === "claude" &&
        effective?.lanes?.feature?.source === "project" &&
        effective?.lanes?.feature?.effort === "high" &&
        effective?.projectTrusted === true,
    );
    h.check(
      "effective tests lane falls through to global",
      effective?.lanes?.tests?.implementer === "codex" && effective?.lanes?.tests?.source === "global",
    );

    // Outside a project: load with cwd = non-git dir still sees global.
    const loadBare = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "load", "--cwd", bare],
      { encoding: "utf8", env: process.env },
    );
    let bareEff = null;
    try {
      bareEff = JSON.parse(loadBare.stdout);
    } catch {
      bareEff = null;
    }
    h.check("load outside git uses global only", loadBare.status === 0 && bareEff?.lanes?.feature?.source === "global");
    h.check("load outside git does not invent .delegit", !existsSync(join(bare, ".delegit")));

    // After project whole-lane replace, feature → claude; opencode must fail.
    const afterOverlay = spawnSync(
      process.execPath,
      [h.relayPath("opencode"), "--brief", laneBrief, "--cd", cfgRepo, "--lane", "feature"],
      { encoding: "utf8", env: fleetEnv },
    );
    h.check(
      "relay --lane: project overlay remaps implementer (opencode fails)",
      afterOverlay.status === 2 && /use delegit-claude/.test(afterOverlay.stderr),
    );

    // The approval lives under the repository's common git dir, so a linked worktree
    // (delegit-queue's default) resolves the approved project lane too.
    const gitIn = (dir, args) => spawnSync("git", ["-C", dir, "-c", "user.name=Relay Smoke", "-c", "user.email=relay-smoke@example.invalid", ...args], { encoding: "utf8" });
    gitIn(cfgRepo, ["add", ".delegit"]);
    gitIn(cfgRepo, ["commit", "-qm", "fleet config"]);
    const linked = join(fleetRoot, "repo-linked");
    const added = gitIn(cfgRepo, ["worktree", "add", "-q", linked]);
    const fromWorktree = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", linked, "--lane", "feature", "--implementer", "claude"],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "lane resolve: an approved project lane resolves from a linked worktree",
      added.status === 0 && fromWorktree.status === 0 && /"effort":\s*"high"/.test(fromWorktree.stdout),
    );
    // Git with core.autocrlf can check the approved file out with CRLF: same content, still trusted.
    const linkedConfig = join(linked, ".delegit", "config.json");
    writeFileSync(linkedConfig, readFileSync(linkedConfig, "utf8").replace(/\r?\n/g, "\r\n"));
    const fromCrlf = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", linked, "--lane", "feature", "--implementer", "claude"],
      { encoding: "utf8", env: process.env },
    );
    h.check("lane resolve: CRLF line endings in an approved project config keep it trusted", fromCrlf.status === 0);

    // A project file this version cannot parse is ignored (never trusted), not fatal:
    // the user's own global lanes keep resolving in that repository.
    const savedProject = readFileSync(join(cfgRepo, ".delegit", "config.json"), "utf8");
    writeFileSync(join(cfgRepo, ".delegit", "config.json"), "{\"version\":\"delegit-fleet.v2\",\"lanes\":{}}\n");
    const loadBad = spawnSync(
      process.execPath,
      [join(setupDir, "config.mjs"), "load", "--cwd", cfgRepo],
      { encoding: "utf8", env: process.env },
    );
    let badEff = null;
    try { badEff = JSON.parse(loadBad.stdout); } catch { badEff = null; }
    h.check(
      "config load: an unparseable project file is reported, not fatal, and global lanes survive",
      loadBad.status === 0 && badEff?.projectTrusted === false && typeof badEff?.projectError === "string" &&
        badEff?.lanes?.tests?.source === "global" && badEff?.lanes?.feature?.source === "global",
    );
    const resolveGlobalBad = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", cfgRepo, "--lane", "tests", "--implementer", "codex"],
      { encoding: "utf8", env: process.env },
    );
    h.check("lane resolve: a global lane resolves beside an unparseable project file", resolveGlobalBad.status === 0);
    const resolveMissingBad = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", cfgRepo, "--lane", "only-in-project", "--implementer", "claude"],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "lane resolve: a lane missing beside an unparseable project file names the reason",
      resolveMissingBad.status === 2 && /project fleet config ignored/.test(resolveMissingBad.stderr),
    );
    writeFileSync(join(cfgRepo, ".delegit", "config.json"), savedProject);
    // An untrusted repository's config that is a link (to /dev/zero, or to a file
    // outside the repository) is refused at once, never read.
    rmSync(join(cfgRepo, ".delegit", "config.json"));
    symlinkSync("/dev/zero", join(cfgRepo, ".delegit", "config.json"));
    const started = Date.now();
    const loadLink = spawnSync(process.execPath, [join(setupDir, "config.mjs"), "load", "--cwd", cfgRepo],
      { encoding: "utf8", env: process.env, timeout: 20_000 });
    let linkEff = null;
    try { linkEff = JSON.parse(loadLink.stdout); } catch { linkEff = null; }
    h.check("config load: a project config that is a symlink is refused quickly, not read",
      loadLink.status === 0 && Date.now() - started < 10_000 && /not a regular file/.test(linkEff?.projectError ?? "") &&
        linkEff?.lanes?.tests?.source === "global");
    rmSync(join(cfgRepo, ".delegit", "config.json"));
    writeFileSync(join(cfgRepo, ".delegit", "config.json"), savedProject);

    writeFileSync(
      join(cfgRepo, ".delegit", "config.json"),
      `${JSON.stringify(untrustedProject, null, 2)}\n`,
    );
    const rejectChangedProject = spawnSync(
      process.execPath,
      [join(setupDir, "lane.mjs"), "resolve", "--cwd", cfgRepo, "--lane", "feature", "--implementer", "codex"],
      { encoding: "utf8", env: process.env },
    );
    h.check(
      "lane resolve: project config changes invalidate approval",
      rejectChangedProject.status === 2 && /project fleet config is not trusted/.test(rejectChangedProject.stderr),
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(fleetRoot, { recursive: true, force: true });
  }
}
