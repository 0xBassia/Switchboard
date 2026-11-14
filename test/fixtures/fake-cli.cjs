const fs = require("node:fs");
const args = process.argv.slice(2);
// A relay whose behavior gates on the probed CLI version (opencode 1.x --variant vs
// 2.x model#variant) drives the gate by overriding the version string here.
const fakeVersion = process.env.SMOKE_VERSION || "fake-cli 0.0.0-smoke";
const capturedEnv = () => Object.fromEntries(
  ["PATH", "HOME", "SMOKE_PROVIDER_TOKEN", "SMOKE_SECRET_TOKEN"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
// Environment-isolation tests cannot pass their control variables through the
// environment. Load their fixture beside the fake before handling --version so
// the preflight and dispatch can be captured independently.
if (!process.env.SMOKE_MODE) {
  try {
    Object.assign(process.env, JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "smoke-fallback.json"), "utf8")));
  } catch { /* no environment-isolation fixture */ }
}
// Every probe form one relay or another uses: --version and the \`version\` / \`changelog\`
// subcommands. Treating them alike lets any relay's hang/fail mode be driven by name.
const versionProbe = args.includes("--version") || args[0] === "version" || args[0] === "changelog";
// Any relay's read-only test can simulate an implementer that writes despite the mode:
// SMOKE_WRITE_FILE names a path (relative to the child cwd) written once at dispatch.
if (!versionProbe && process.env.SMOKE_WRITE_FILE) {
  fs.writeFileSync(require("node:path").resolve(process.env.SMOKE_WRITE_FILE), "written during a read-only run\n");
}
if (versionProbe && process.env.SMOKE_PREFLIGHT_ENV_FILE) {
  fs.writeFileSync(process.env.SMOKE_PREFLIGHT_ENV_FILE, JSON.stringify(capturedEnv()));
}
if (versionProbe && process.env.SMOKE_PREFLIGHT_PID_FILE) {
  fs.writeFileSync(process.env.SMOKE_PREFLIGHT_PID_FILE, String(process.pid));
}
if (versionProbe && /-spawn-error$/.test(process.env.SMOKE_MODE || "") && process.platform !== "win32") {
  const key = process.env.SMOKE_MODE.replace(/-spawn-error$/, "");
  fs.renameSync(require("node:path").join(__dirname, key), require("node:path").join(__dirname, key + ".removed"));
  console.log(fakeVersion);
  process.exit(0);
} else if (versionProbe && /-version-hang$/.test(process.env.SMOKE_MODE || "")) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else if (versionProbe && /-version-fail-silent$/.test(process.env.SMOKE_MODE || "")) {
  process.exit(7);
} else if (versionProbe && /-version-fail$/.test(process.env.SMOKE_MODE || "")) {
  console.error("fake version failure");
  process.exit(7);
} else if (versionProbe) {
  console.log(fakeVersion);
  process.exit(0);
}
if (process.env.SMOKE_FORWARD_ARGS_FILE) fs.writeFileSync(process.env.SMOKE_FORWARD_ARGS_FILE, JSON.stringify(args));
// cursor stall-watchdog modes: emit Cursor-shaped stream-json, then misbehave or finish.
//   cursor-stall      init, then silent forever without exiting (the observed live hang)
//   cursor-slow-tool  a tool call that stays in flight longer than --stall-timeout, then completes
//   cursor-steady     keeps emitting thinking deltas past --stall-timeout, then completes
if (["cursor-stall", "cursor-delayed-shutdown", "cursor-slow-tool", "cursor-steady"].includes(process.env.SMOKE_MODE)) {
  const emit = (event) => console.log(JSON.stringify({ session_id: "cursor-stall-session", ...event }));
  const finish = () => {
    emit({ type: "result", subtype: "success", is_error: false, result: "fake cursor finished" });
    process.exit(0);
  };
  process.stdin.resume();
  process.stdin.on("end", () => {
    emit({ type: "system", subtype: "init", model: "fake", permissionMode: "default" });
    const mode = process.env.SMOKE_MODE;
    if (mode === "cursor-delayed-shutdown") {
      process.once("SIGTERM", () => setTimeout(() => process.exit(0), 2500));
      setInterval(() => {}, 1000);
    } else if (mode === "cursor-stall") {
      emit({ type: "thinking", subtype: "completed" });
      setInterval(() => {}, 1000);
    } else if (mode === "cursor-slow-tool") {
      emit({ type: "tool_call", subtype: "started", call_id: "tool-1" });
      setTimeout(() => {
        emit({ type: "tool_call", subtype: "completed", call_id: "tool-1" });
        finish();
      }, 2500);
    } else {
      const tick = setInterval(() => emit({ type: "thinking", subtype: "delta", text: "." }), 200);
      setTimeout(() => { clearInterval(tick); finish(); }, 2500);
    }
  });
  return;
}
if (process.env.SMOKE_MODE === "capture") {
  fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify(args));
  // Lets a test choose codex's final report (its -o file), e.g. a reviewer's verdict.
  const reportAt = args.indexOf("-o");
  if (process.env.SMOKE_FINAL_TEXT && reportAt !== -1) {
    fs.writeFileSync(args[reportAt + 1].replace(/^"(.*)"$/, "$1"), process.env.SMOKE_FINAL_TEXT);
  }
  if (process.env.SMOKE_ENV_FILE) fs.writeFileSync(process.env.SMOKE_ENV_FILE, JSON.stringify(capturedEnv()));
  process.exit(0);
}
if (process.env.SMOKE_WRITE_FILE) {
  fs.writeFileSync(process.env.SMOKE_WRITE_FILE, "written by fake cli\n");
}
if (process.env.SMOKE_APPEND_INVALID_UTF8) {
  fs.appendFileSync(Buffer.from(process.env.SMOKE_APPEND_INVALID_UTF8, "hex"), "appended by fake cli\n");
}
if (process.env.SMOKE_RETARGET_SYMLINK && process.env.SMOKE_SYMLINK_TARGET_HEX) {
  fs.unlinkSync(process.env.SMOKE_RETARGET_SYMLINK);
  fs.symlinkSync(Buffer.from(process.env.SMOKE_SYMLINK_TARGET_HEX, "hex"), process.env.SMOKE_RETARGET_SYMLINK);
}
if (process.env.SMOKE_INDEX_ONLY_FILE) {
  const { execFileSync } = require("node:child_process");
  const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    input: "new staged content\n",
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["update-index", "--cacheinfo", `100644,${oid},${process.env.SMOKE_INDEX_ONLY_FILE}`]);
}
if (process.env.SMOKE_GIT_RENAME_FROM && process.env.SMOKE_GIT_RENAME_TO) {
  require("node:child_process").execFileSync("git", [
    "mv", "-f", process.env.SMOKE_GIT_RENAME_FROM, process.env.SMOKE_GIT_RENAME_TO,
  ]);
}
if (process.env.SMOKE_MODE === "orphan-holds-stdio") {
  // The normal-exit twin of the timeout-tree cases. codex spawns a shell per command, and on
  // Windows a grandchild routinely outlives it; because that grandchild inherited the pipes,
  // the relay's stdout/stderr stay open after codex itself is gone. "exit" fires, "close"
  // never does, and a relay that only settles on "close" waits forever and writes no result.
  // Unlike the timeout-tree fixture (stdio: "ignore") this grandchild inherits, which is the
  // whole point: holding the pipes open is the failure, not merely outliving the parent.
  const logAt = args.indexOf("--log-file");
  if (logAt !== -1) fs.writeFileSync(args[logAt + 1], "fake implementer log" + String.fromCharCode(10));
  console.log("fake implementer completed");
  const outAt = args.indexOf("-o");
  if (outAt !== -1) {
    // The relay quotes the path on Windows; strip that before writing.
    fs.writeFileSync(args[outAt + 1].replace(/^"(.*)"$/, "$1"), "fake codex completed" + "\n");
  }
  // detached AND inheriting: it is the pair that holds the pipes. An attached grandchild
  // that inherits still lets "close" fire (verified on Windows/Node 24), so a fixture
  // without detached would pass against the unpatched relay and prove nothing.
  const grand = require("node:child_process").spawn(
    process.execPath, ["-e", "setTimeout(() => {}, 60000)"],
    { stdio: "inherit", detached: true });
  if (process.env.SMOKE_GRAND_PID_FILE) {
    fs.writeFileSync(process.env.SMOKE_GRAND_PID_FILE, String(grand.pid));
  }
  grand.unref();
  const delayMs = Number(process.env.SMOKE_ORPHAN_EXIT_DELAY_MS || 0);
  if (Number.isFinite(delayMs) && delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
  process.exit(0);
}
if (process.env.SMOKE_MODE === "codex-stderr-long-line") {
  // The 64 KiB suffix starts inside a four-byte character.
  fs.writeSync(2, "🐎".repeat(20000) + "fin");
  process.exit(7);
}
if (process.env.SMOKE_MODE === "codex-stderr-window-boundary") {
  const first = "first complete diagnostic\n";
  const last = "\nlast diagnostic\n";
  fs.writeSync(2, "outside window\n" + first +
    " ".repeat(64 * 1024 - Buffer.byteLength(first + last)) + last);
  process.exit(7);
}
if (process.env.SMOKE_MODE === "codex-stderr-large") {
  // Many short lines make an unbounded split/map/filter allocate far more than the log.
  const block = Buffer.from("x\n".repeat(32768));
  for (let i = 0; i < 64; i += 1) fs.writeSync(2, block);
  fs.writeSync(2, "\r\n  \r\nfatal: café انتهى 🐎\r\nlast diagnostic without newline");
  process.exit(7);
}
if (process.env.SMOKE_MODE === "codex-stderr-flood") {
  // Stands in for a real `codex exec` transcript: codex streams the banner, its tool calls
  // and the full output of every command it runs to stderr, so the line that explains the
  // failure sits hundreds of lines above the end. Synchronous writes so every line lands
  // before the process dies, and the unread brief on stdin exercises the swallowed-EPIPE path.
  fs.writeSync(2, "early marker: the line that explains the failure\n");
  for (let i = 0; i < 300; i += 1) {
    fs.writeSync(2, `2026-01-01T00:00:00.${String(i).padStart(6, "0")}Z WARN fake cache: failed to renew cache TTL\n`);
  }
  fs.writeSync(2, "fatal: dispatch failed after the flood\n");
  process.exit(1);
}
if (["omp-success", "omp-error"].includes(process.env.SMOKE_MODE)) {
  let brief = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { brief += chunk; });
  process.stdin.on("end", () => {
    const failed = process.env.SMOKE_MODE === "omp-error";
    fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify({ args, brief }));
    console.log(JSON.stringify({ type: "session", version: 3, id: "omp-session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: process.cwd() }));
    console.log(JSON.stringify({ type: "agent_start" }));
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: failed ? "fake omp failed" : "fake omp completed" }],
        provider: "google",
        model: "fake-model",
        usage: { input: 7, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 10, cost: { total: 0.001 } },
        stopReason: failed ? "error" : "stop",
        ...(failed ? { errorMessage: "fake provider failure" } : {}),
      },
    }));
    console.log(JSON.stringify({ type: "agent_end", messages: [] }));
    process.exit(0);
  });
} else if (["pi-success", "pi-error"].includes(process.env.SMOKE_MODE)) {
  let brief = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { brief += chunk; });
  process.stdin.on("end", () => {
    const failed = process.env.SMOKE_MODE === "pi-error";
    fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify({ args, brief }));
    console.log(JSON.stringify({ type: "session", version: 3, id: "pi-session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: process.cwd() }));
    console.log(JSON.stringify({ type: "agent_start" }));
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: failed ? "fake pi failed" : "fake pi completed" }],
        provider: "google",
        model: "fake-model",
        usage: { input: 7, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 10, cost: { total: 0.001 } },
        stopReason: failed ? "error" : "stop",
        ...(failed ? { errorMessage: "fake provider failure" } : {}),
      },
    }));
    console.log(JSON.stringify({ type: "agent_end", messages: [] }));
    process.exit(0);
  });
} else if (["cursor-success", "claude-success", "claude-read-only-write", "claude-read-only-clean", "claude-read-only-append", "claude-chunked"].includes(process.env.SMOKE_MODE)) {
  let brief = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { brief += chunk; });
  process.stdin.on("end", async () => {
    const mode = process.env.SMOKE_MODE;
    if (mode === "cursor-success") {
      fs.writeFileSync(process.env.SMOKE_CAPTURE_FILE, JSON.stringify({ args, brief }));
      console.log(JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "cursor-session-1",
        model: "claude-opus-4-8[context=1m,effort=high,fast=false]",
        permissionMode: args.includes("plan") ? "plan" : "default",
      }));
      console.log(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "cursor-session-1",
        result: "fake cursor completed",
        usage: { inputTokens: 11, outputTokens: 4 },
      }));
      return;
    }
    if (mode === "claude-read-only-write") {
      fs.writeFileSync("read-only-violation.txt", "written by fake claude\n");
    }
    if (mode === "claude-read-only-append") {
      fs.appendFileSync(process.env.SMOKE_APPEND_FILE ?? "already-dirty.txt", "appended by fake claude\n");
    }
    if (process.env.SMOKE_CAPTURE_FILE) {
      fs.writeFileSync(process.env.SMOKE_CAPTURE_FILE, JSON.stringify({
        args,
        brief,
        claudeCode: process.env.CLAUDECODE ?? null,
        childSession: process.env.CLAUDE_CODE_CHILD_SESSION ?? null,
      }));
    }
    const permissionMode = mode.startsWith("claude-read-only") ? "plan" : "acceptEdits";
    console.log(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "11111111-1111-4111-8111-111111111111",
      permissionMode,
    }));
    const resultEvent = {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "11111111-1111-4111-8111-111111111111",
      result: mode === "claude-chunked" ? "café — done ✅" : "fake claude completed",
      num_turns: 3,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    if (mode === "claude-chunked") {
      const output = Buffer.from(JSON.stringify(resultEvent));
      for (let i = 0; i < output.length; i += 1) {
        process.stdout.write(output.subarray(i, i + 1));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      process.stdout.write("\n");
    } else {
      console.log(JSON.stringify(resultEvent));
    }
  });
} else if (process.env.SMOKE_MODE === "opencode-success") {
  let brief = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { brief += chunk; });
  process.stdin.on("end", () => {
    fs.writeFileSync(process.env.SMOKE_ARGS_FILE, JSON.stringify({ args, brief }));
    const sid = "ses_smoke_opencode";
    const emit = (value) => fs.writeSync(1, `${JSON.stringify(value)}\n`);
    emit({ type: "step_start", sessionID: sid, part: { type: "step-start" } });
    // Streamed updates to one part must replace, not duplicate: the relay keys text by part.id.
    emit({ type: "text", sessionID: sid, part: { id: "prt_1", type: "text", text: "fake opencode" } });
    emit({ type: "text", sessionID: sid, part: { id: "prt_1", type: "text", text: "fake opencode completed" } });
    emit({ type: "text", sessionID: sid, part: { id: "prt_2", type: "text", text: " — second segment" } });
    emit({ type: "step_finish", sessionID: sid, part: { type: "step-finish", cost: 0.001 } });
    emit({ type: "step_finish", sessionID: sid, part: { type: "step-finish", cost: 0.0025 } });
    process.exit(0);
  });
} else {
  process.stdin.resume();
  const grandProgram = process.env.SMOKE_GRAND_IGNORES_SIGTERM
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    : "setInterval(() => {}, 1000)";
  const grand = require("node:child_process").spawn(process.execPath, ["-e", grandProgram], { stdio: "ignore" });
  fs.writeFileSync(process.env.SMOKE_GRAND_PID_FILE, String(grand.pid));
  fs.writeFileSync(process.env.SMOKE_PID_FILE, String(process.pid)); // written last: its existence means both pid files are readable
  if (process.env.SMOKE_MODE === "abort") {
    process.on("SIGTERM", () => { fs.writeFileSync(process.env.SMOKE_LATE_FILE, "flushed during shutdown"); process.exit(0); });
  } else if (process.env.SMOKE_MODE === "timeout-yield") {
    process.on("SIGTERM", () => process.exit(0)); // the parent complies while the grandchild ignores
  } else {
    process.on("SIGTERM", () => {}); // ignore, so the relay's SIGKILL escalation is what ends it
  }
  setInterval(() => {}, 1000);
}
