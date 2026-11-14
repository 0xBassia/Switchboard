// Command-line surface shared by every relay: spec-driven flag parsing, the
// header-comment --help, and brief intake.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

// The relay's leading block comment doubles as --help text.
export function headerComment(fallback = "relay.mjs - dispatch a brief to an implementer CLI\n") {
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return fallback;
  return `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n`;
}

// Flags every relay accepts. Adapters add their own; an adapter entry with the
// same name replaces the common one.
const COMMON_FLAGS = {
  "--brief": { key: "brief" },
  "--cd": { key: "cd", path: true },
  "--lane": { key: "lane" },
  "--timeout": { key: "timeout" },
  "--out-dir": { key: "outDir", path: true },
};

// spec: { [flag]: { key, kind?: "value" | "bool" | "list", path?, pattern?, choices?, label? } }
// "value" (default) takes the next argv token; "bool" sets true; "list" appends.
// `pattern` / `choices` validate the value with a uniform error message.
// Returns { opts, flagged } where `flagged` holds every key set explicitly.
export function parseArgs(argv, spec, defaults) {
  const flags = { ...COMMON_FLAGS, ...spec };
  const flagged = new Set();
  const opts = {
    lane: null,
    laneSource: null,
    brief: null,
    cd: process.cwd(),
    outDir: null,
    ...defaults,
  };
  for (const [flag, def] of Object.entries(flags)) {
    if (def.kind === "list" && !Array.isArray(opts[def.key])) opts[def.key] = [];
    if (def.kind === "bool" && opts[def.key] === undefined) opts[def.key] = false;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(headerComment());
      process.exit(0);
    }
    const def = Object.hasOwn(flags, arg) ? flags[arg] : null;
    if (!def) fail(`unknown option: ${arg}`);
    flagged.add(def.key);
    if (def.kind === "bool") {
      opts[def.key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) fail(`${arg} requires a value`);
    // An empty path would resolve to the current directory and quietly make it the artifact dir.
    if (value === "") fail(`${arg} requires a non-empty value`);
    i += 1;
    checkValue(arg, value, def);
    const stored = def.path ? resolve(value) : value;
    if (def.kind === "list") opts[def.key].push(stored);
    else opts[def.key] = stored;
  }
  return { opts, flagged };
}

export function checkValue(label, value, def) {
  if (def.choices && !def.choices.includes(value)) {
    fail(`${label} must be one of: ${def.choices.join(", ")} (got "${value}")`);
  }
  if (def.pattern && !def.pattern.test(value)) {
    fail(`${label} "${value}" contains unsupported characters`);
  }
}

// Fails unless at most one of the named keys is set.
export function exclusive(opts, pairs) {
  for (const [a, b, message] of pairs) {
    if (opts[a] && opts[b]) fail(message);
  }
}

// Briefs saved by Windows PowerShell 5.1 (`>` and Out-File) are UTF-16 with a BOM;
// decode the common BOMs instead of dispatching mojibake, and refuse NUL bytes, which
// no CLI's argv accepts anyway.
function decodeBrief(bytes, label) {
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    if ((bytes.length - 2) % 2) fail(`${label} is not valid UTF-16; save the brief as UTF-8 text`);
    text = bytes.subarray(2).toString("utf16le");
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    if ((bytes.length - 2) % 2) fail(`${label} is not valid UTF-16; save the brief as UTF-8 text`);
    text = Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = bytes.subarray(3).toString("utf8");
  } else {
    text = bytes.toString("utf8");
  }
  if (text.includes("\0")) fail(`${label} contains NUL bytes; save the brief as UTF-8 text`);
  return text;
}

export function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    let bytes;
    try {
      bytes = readFileSync(opts.brief);
    } catch (error) {
      fail(`cannot read brief file ${opts.brief}: ${error.message}`);
    }
    return decodeBrief(bytes, `brief file ${opts.brief}`);
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  let bytes;
  try {
    bytes = readFileSync(0);
  } catch {
    return "";
  }
  return decodeBrief(bytes, "the brief on stdin");
}
