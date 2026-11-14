#!/usr/bin/env node
// Builds every skills/switchboard-<name>/scripts/relay.mjs from
// src/adapters/<name>.mjs plus the src/core modules it imports.
//
// Skills install one directory at a time, so a shipped relay cannot import
// anything outside its own folder. This bundler inlines the shared core into
// each relay and keeps only the top-level declarations the adapter actually
// reaches, so every relay is standalone and carries no dead code.
//
// Source rules (enforced here, failures are build errors):
//   - imports are `import { a, b as c } from "..."`: relative paths are
//     inlined, `node:` modules are merged into one import block;
//   - top-level declarations start at column 0 and have unique names across
//     everything an adapter pulls in;
//   - the adapter's first /** */ block is the relay header and --help text.
//
// Usage: node tools/build.mjs [name ...] [--check]
//   --check  fail (exit 1) if any committed relay differs from a fresh build.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adaptersDir = join(root, "src", "adapters");

const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*"([^"]+)";?[ \t]*\n/gm;
const DECL = /^(export\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/;
const IDENT = /[A-Za-z_$][\w$]*/g;
// Identifiers in comments must not keep code alive. Over-stripping inside a
// string literal only ever keeps more, never less, so this stays safe.
const identifiers = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1").matchAll(IDENT);

class BuildError extends Error {}

function parseSpecifiers(list, file) {
  return list.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part);
    if (!match) throw new BuildError(`${file}: unsupported import specifier "${part}"`);
    return { imported: match[1], local: match[2] || match[1] };
  });
}

// Splits a module into its imports and top-level chunks. A chunk is one
// declaration (with the comment lines directly above it) or one top-level
// statement. Lines indented or starting with a closer belong to the chunk above.
// Tracks template literals (with their ${} expressions) and block comments across
// lines so a column-0 line inside one (a multi-line `node -e` script, a Markdown
// template) is never mistaken for a new top-level statement. Quoted strings and
// line comments are skipped; a regex literal is read as code, which only matters
// for one holding an unbalanced backtick.
function scanLine(line, stack) {
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    const frame = stack[stack.length - 1];
    if (frame.type === "block") {
      if (ch === "*" && next === "/") { stack.pop(); i += 2; } else i += 1;
      continue;
    }
    if (frame.type === "template") {
      if (ch === "\\") i += 2;
      else if (ch === "`") { stack.pop(); i += 1; }
      else if (ch === "$" && next === "{") { stack.push({ type: "code", depth: 0 }); i += 2; }
      else i += 1;
      continue;
    }
    if (ch === "/" && next === "/") break;
    if (ch === "/" && next === "*") { stack.push({ type: "block" }); i += 2; continue; }
    if (ch === "'" || ch === '"') {
      i += 1;
      while (i < line.length && line[i] !== ch) i += line[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === "`") { stack.push({ type: "template" }); i += 1; continue; }
    if (!frame.root) {
      if (ch === "{") frame.depth += 1;
      else if (ch === "}") {
        if (frame.depth === 0) { stack.pop(); i += 1; continue; }
        frame.depth -= 1;
      }
    }
    i += 1;
  }
}

function parseModule(file) {
  const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const imports = [];
  for (const match of source.matchAll(IMPORT)) {
    imports.push({ from: match[2], specifiers: parseSpecifiers(match[1], file) });
  }
  if (/^import\s/m.test(source.replace(IMPORT, ""))) {
    throw new BuildError(`${file}: only \`import { ... } from "..."\` is supported`);
  }
  let body = source.replace(IMPORT, "");
  let header = null;
  if (body.startsWith("#!")) body = body.slice(body.indexOf("\n") + 1);
  const headerMatch = /^\s*(\/\*\*[\s\S]*?\*\/)\n/.exec(body);
  if (headerMatch) {
    header = headerMatch[1];
    body = body.slice(headerMatch[0].length);
  }

  const lines = body.split("\n");
  const chunks = [];
  let pending = [];
  let current = null;
  const flush = () => {
    if (current) chunks.push(current);
    current = null;
  };
  const stack = [{ type: "code", root: true }];
  for (const line of lines) {
    // A line that starts inside a template literal or block comment continues the
    // chunk whatever its first column holds.
    const inside = stack.length > 1;
    scanLine(line, stack);
    if (inside) {
      if (current) current.lines.push(line);
      else pending.push(line);
      continue;
    }
    const isComment = /^\s*\/\//.test(line);
    const continues = line === "" || /^[\s})\]]/.test(line) || /^\s*(\*|\/\*)/.test(line);
    if (current && current.open) {
      current.lines.push(line);
      if (/^[})\]]/.test(line)) current.open = false;
      continue;
    }
    if (isComment || line.trim() === "") {
      pending.push(line);
      continue;
    }
    if (continues && current) {
      current.lines.push(...pending, line);
      pending = [];
      continue;
    }
    flush();
    const decl = DECL.exec(line);
    const opensBlock = /[{([]\s*$/.test(line);
    current = {
      name: decl ? decl[2] : null,
      lines: [...pending, decl && decl[1] ? line.replace(/^export\s+/, "") : line],
      open: opensBlock,
    };
    pending = [];
  }
  flush();
  // Leading comment lines of the module (before its first chunk) are its doc.
  const doc = [];
  if (chunks.length) {
    const first = chunks[0].lines;
    while (first.length && (first[0].trim() === "" || /^\s*\/\//.test(first[0]))) doc.push(first.shift());
  }
  for (const chunk of chunks) {
    while (chunk.lines.length && chunk.lines[chunk.lines.length - 1].trim() === "") chunk.lines.pop();
    chunk.text = chunk.lines.join("\n");
  }
  return { file, header, imports, chunks, doc: doc.filter((line) => line.trim()).join("\n") };
}

function collectModules(entry) {
  const ordered = [];
  const seen = new Map();
  const visit = (file, stack) => {
    if (stack.includes(file)) throw new BuildError(`import cycle: ${[...stack, file].map((f) => relative(root, f)).join(" -> ")}`);
    if (seen.has(file)) return;
    const mod = parseModule(file);
    seen.set(file, mod);
    for (const imp of mod.imports) {
      if (imp.from.startsWith(".")) {
        const target = resolve(dirname(file), imp.from);
        if (!existsSync(target)) throw new BuildError(`${relative(root, file)}: cannot resolve ${imp.from}`);
        imp.target = target;
        visit(target, [...stack, file]);
      } else if (!imp.from.startsWith("node:")) {
        throw new BuildError(`${relative(root, file)}: only node: built-ins and relative modules may be imported (got ${imp.from})`);
      }
    }
    ordered.push(mod);
  };
  visit(entry, []);
  return ordered;
}

function bundle(name) {
  const entry = join(adaptersDir, `${name}.mjs`);
  const modules = collectModules(entry);
  const adapter = modules[modules.length - 1];
  if (!adapter.header) throw new BuildError(`src/adapters/${name}.mjs: missing the leading /** */ relay header`);

  const owners = new Map();
  for (const mod of modules) {
    for (const chunk of mod.chunks) {
      if (!chunk.name) continue;
      if (owners.has(chunk.name)) {
        throw new BuildError(`duplicate top-level name ${chunk.name} in ${relative(root, owners.get(chunk.name).file)} and ${relative(root, mod.file)}`);
      }
      owners.set(chunk.name, { file: mod.file, chunk });
    }
  }

  // Reachability from the adapter's top-level statements.
  const kept = new Set();
  const queue = adapter.chunks.filter((chunk) => !chunk.name);
  if (!queue.length) throw new BuildError(`src/adapters/${name}.mjs: no top-level statement runs the relay`);
  while (queue.length) {
    const chunk = queue.pop();
    if (kept.has(chunk)) continue;
    kept.add(chunk);
    for (const [identifier] of identifiers(chunk.text)) {
      const owner = owners.get(identifier);
      if (owner && !kept.has(owner.chunk)) queue.push(owner.chunk);
    }
  }

  // node: imports, merged, limited to names the kept code uses.
  const used = new Set();
  for (const chunk of kept) for (const [identifier] of identifiers(chunk.text)) used.add(identifier);
  const nodeImports = new Map();
  const locals = new Map();
  for (const mod of modules) {
    for (const imp of mod.imports) {
      if (!imp.from.startsWith("node:")) continue;
      for (const spec of imp.specifiers) {
        if (!used.has(spec.local)) continue;
        const key = `${imp.from}#${spec.imported}`;
        if (locals.has(spec.local) && locals.get(spec.local) !== key) {
          throw new BuildError(`local name ${spec.local} imports both ${locals.get(spec.local)} and ${key}`);
        }
        locals.set(spec.local, key);
        if (!nodeImports.has(imp.from)) nodeImports.set(imp.from, new Map());
        nodeImports.get(imp.from).set(spec.local, spec.imported === spec.local ? spec.local : `${spec.imported} as ${spec.local}`);
      }
    }
  }
  const importLines = [...nodeImports.keys()].sort().map((from) =>
    `import { ${[...nodeImports.get(from).values()].sort((a, b) => a.localeCompare(b)).join(", ")} } from "${from}";`);

  const sections = [];
  for (const mod of modules) {
    const chunks = mod.chunks.filter((chunk) => kept.has(chunk));
    if (!chunks.length) continue;
    const label = relative(root, mod.file).replaceAll("\\", "/");
    // Module docs stay in src/; the shipped relay keeps per-declaration comments.
    const parts = [`// ---- ${label}`];
    sections.push([...parts, ...chunks.map((chunk) => chunk.text)].join("\n\n"));
  }

  return [
    "#!/usr/bin/env node",
    adapter.header,
    "",
    `// GENERATED by tools/build.mjs from src/adapters/${name}.mjs and src/core/.`,
    "// Do not edit this file: edit the sources, then run `node tools/build.mjs`.",
    "",
    ...importLines,
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");
}

function relayPath(name) {
  return join(root, "skills", `switchboard-${name}`, "scripts", "relay.mjs");
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const requested = args.filter((arg) => arg !== "--check");
  const available = readdirSync(adaptersDir).filter((file) => file.endsWith(".mjs")).map((file) => file.slice(0, -4)).sort();
  const names = requested.length ? requested : available;
  let failures = 0;
  for (const name of names) {
    if (!available.includes(name)) {
      console.error(`build: no adapter src/adapters/${name}.mjs`);
      failures += 1;
      continue;
    }
    let output;
    try {
      output = bundle(name);
    } catch (error) {
      if (!(error instanceof BuildError)) throw error;
      console.error(`build: ${name}: ${error.message}`);
      failures += 1;
      continue;
    }
    const target = relayPath(name);
    const current = existsSync(target) ? readFileSync(target, "utf8").replace(/\r\n/g, "\n") : null;
    if (check) {
      if (current !== output) {
        console.error(`build: ${relative(root, target)} is stale; run \`node tools/build.mjs ${name}\``);
        failures += 1;
      } else {
        console.log(`  ok   ${name}`);
      }
      continue;
    }
    if (current !== output) writeFileSync(target, output, "utf8");
    const syntax = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
    if (syntax.status !== 0) {
      console.error(`build: ${name}: generated relay fails node --check\n${syntax.stderr}`);
      failures += 1;
      continue;
    }
    console.log(`  built ${relative(root, target)} (${output.split("\n").length} lines)`);
  }
  if (failures) process.exit(1);
}

main();
