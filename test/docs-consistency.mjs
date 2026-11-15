#!/usr/bin/env node
// Docs consistency lint for the implementer skills (`delegit-<key>`).
//
// The per-CLI docs are deliberately NOT templated (each CLI has real nuance), so they can drift.
// This lint pins the parts that must stay identical. It reads only Markdown, uses Node built-ins,
// and prints every violation before exiting non-zero.
//
// Checks:
//   1. required headings, per file type, with exact text (plus a commented exceptions map);
//   2. canonical sentences that must appear verbatim ({CLI} and {KEY} placeholders supported);
//   3. no lowercase CLI-id leaks where the display name belongs;
//   4. no banned vocabulary synonyms (AGENTS.md "Vocabulary" table) outside code spans;
//   5. in-file Markdown links to heading anchors resolve.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(here, "..", "skills");

const KEYS = ["claude", "codex", "opencode", "cursor", "pi", "omp", "warp"];
const FILES = ["SKILL.md", "references/writing-the-brief.md", "references/dispatch-and-poll.md", "references/review-and-land.md", "references/multi-task-queues.md"];

const failures = [];
let checks = 0;
const fail = (msg) => failures.push(msg);
const check = (ok, msg) => {
  checks += 1;
  if (!ok) fail(msg);
};

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------
const docs = new Map(); // `${key}/${file}` -> parsed doc
const names = {}; // key -> display name, from the "# <Name> Delegate" title

function parse(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headings = [];
  const prose = []; // lines outside fenced blocks and the YAML frontmatter
  let fence = false;
  let frontmatter = 0;
  for (const line of lines) {
    if (line === "---" && frontmatter < 2 && lines[0] === "---") {
      frontmatter += 1;
      continue;
    }
    if (frontmatter === 1) {
      prose.push(line); // frontmatter description is prose too
      continue;
    }
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    prose.push(line);
    if (/^#{1,6} /.test(line)) headings.push(line);
  }
  return {
    headings,
    prose,
    flat: lines.join("\n").replace(/\s+/g, " "), // whitespace-collapsed, fences included
  };
}

for (const key of KEYS) {
  for (const file of FILES) {
    const path = join(SKILLS_DIR, `delegit-${key}`, file);
    const present = existsSync(path);
    check(present, `delegit-${key}/${file}: file is missing`);
    if (present) docs.set(`${key}/${file}`, parse(readFileSync(path, "utf8")));
  }
  const skillPath = join(SKILLS_DIR, `delegit-${key}`, "SKILL.md");
  if (existsSync(skillPath)) {
    const title = readFileSync(skillPath, "utf8").match(/^# (.+?)\s+Delegate\s*$/m);
    check(Boolean(title), `delegit-${key}/SKILL.md: expected a "# <Name> Delegate" title`);
    names[key] = title ? title[1] : key;
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Required headings
// ---------------------------------------------------------------------------------------------
// Computed from the corpus after the drift fixes, then hard-coded: a heading is required when every
// skill (or all but the documented exceptions below) carries it with this exact text.
const REQUIRED_HEADINGS = {
  "SKILL.md": [
    "## When NOT to use this",
    "## Prerequisites (check once)",
    "## The loop",
    "### 1. Write the brief",
    "### 2. Dispatch",
    "### 3. Wait for completion",
    "### 4. Review — do not trust the self-report",
    "### 5. Land it",
    "## Authorization model",
    "## References",
  ],
  "references/writing-the-brief.md": [
    "# Writing the brief",
    "## The shape that works",
    "## Discover the real gates",
    "## Honor repo conventions",
    "## One task per brief",
    "## Premises freeze at dispatch",
    "## A worked example",
  ],
  "references/dispatch-and-poll.md": [
    "# Dispatch and poll",
    "## Before the first run",
    "## Dispatching",
    "## What the relay runs",
    "## Waiting for completion",
    "## When a run misbehaves",
    "## The commit boundary",
  ],
  "references/review-and-land.md": [
    "# Review and land",
    "## Check tests before trusting gates",
    "## Re-run the gates yourself",
    "## Read the diff against the brief",
    "## The implementer sweep",
    "## The commit boundary",
    "## Rework: send the delta",
    "## Surface, do not absorb",
  ],
  "references/multi-task-queues.md": [
    "# Multi-task queues",
    "## Run sequentially, one commit per task",
    "## Carry decided constraints forward",
    "## Keep a progress file",
    "## Close with a coherence check",
    "## When to stop and ask",
    "## Parallel batches",
  ],
};

// Legitimately missing sections: { file: { heading: { skill: reason } } }. Keep this small. A stale
// entry (the skill now has the heading) fails the lint, so the map cannot rot.
const WARP_OPTIONS = "documents the relay as an option reference, not as the shared dispatch walkthrough";
const WARP_CHECKLIST = "reviews through one combined checklist, not the four shared review sections";
const HEADING_EXCEPTIONS = {
  "references/writing-the-brief.md": {
    "## Discover the real gates": {
      warp: "gates are item 5 of its numbered brief structure",
    },
    "## Honor repo conventions": {
      claude: "covered by 'Know what Claude loads' (Claude Code does not auto-load AGENTS.md)",
      warp: "covered by 'Repository context files' (Warp skill directories)",
    },
  },
  "references/dispatch-and-poll.md": {
    "## Before the first run": { warp: WARP_OPTIONS },
    "## Dispatching": { warp: WARP_OPTIONS },
    "## Waiting for completion": { warp: "covered by 'Polling'" },
  },
  "references/review-and-land.md": {
    "## Check tests before trusting gates": { warp: WARP_CHECKLIST },
    "## Re-run the gates yourself": { warp: WARP_CHECKLIST },
    "## Read the diff against the brief": { warp: WARP_CHECKLIST },
    "## The implementer sweep": { warp: WARP_CHECKLIST },
  },
};

for (const [file, wanted] of Object.entries(REQUIRED_HEADINGS)) {
  for (const heading of wanted) {
    const excused = HEADING_EXCEPTIONS[file]?.[heading] ?? {};
    for (const key of KEYS) {
      const doc = docs.get(`${key}/${file}`);
      if (!doc) continue;
      const has = doc.headings.includes(heading);
      if (key in excused) {
        check(!has, `delegit-${key}/${file}: stale exception, it now has "${heading}" (${excused[key]})`);
      } else {
        check(has, `delegit-${key}/${file}: missing heading "${heading}"`);
      }
    }
  }
  // Exceptions must name a required heading and a real skill.
  for (const [heading, bySkill] of Object.entries(HEADING_EXCEPTIONS[file] ?? {})) {
    check(wanted.includes(heading), `exceptions map: "${heading}" is not a required heading of ${file}`);
    for (const key of Object.keys(bySkill)) check(KEYS.includes(key), `exceptions map: unknown skill "${key}"`);
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Canonical sentences
// ---------------------------------------------------------------------------------------------
// `text` is matched against the whitespace-collapsed file, so line wrapping does not matter.
// {CLI} is the display name from the skill title; {KEY} is the skill key (`codex` for delegit-codex).
const NO_COHERENCE = "reviews the whole queue as one aggregate diff instead of the shared checklist";
const CANONICAL = [
  {
    why: "loop intro",
    file: "SKILL.md",
    text: "Run these five steps per task. Steps 1, 4, and 5 require judgment; 2 and 3 are mechanical.",
  },
  {
    why: "commit boundary core sentence",
    file: "references/review-and-land.md",
    text: "When the gates pass and the diff holds, **the orchestrator commits**, never the implementer.",
  },
  {
    why: "commit message",
    file: "references/review-and-land.md",
    text: "Write a clear message describing what landed.",
  },
  {
    why: "uncommitted tree is the authoritative copy",
    file: "references/review-and-land.md",
    text: "From dispatch until that commit, the uncommitted working tree is the authoritative copy of the implementer's work",
    except: {
      warp: "covers discarding against a baseline under 'Rework: send the delta'",
    },
  },
  {
    why: "relay never commits",
    file: "references/dispatch-and-poll.md",
    text: "The relay never commits — by design, not omission.",
  },
  {
    why: "dispatch-side commit boundary",
    file: "references/dispatch-and-poll.md",
    text: "{CLI} edits the working tree; the orchestrator reviews, re-runs the gates, and commits. See [review-and-land.md](review-and-land.md).",
  },
  {
    why: "single bounded job",
    file: "references/writing-the-brief.md",
    text: "Keep each brief to a single, bounded job.",
  },
  {
    why: "one brief, one run, one commit",
    file: "references/writing-the-brief.md",
    text: "One brief → one {CLI} run → one reviewed commit keeps the diff and rollback clean",
  },
  {
    why: "premises freeze",
    file: "references/writing-the-brief.md",
    text: "The implementer starts from the brief's facts and there is no steering channel mid-run.",
  },
  {
    why: "queue intro",
    file: "references/multi-task-queues.md",
    text: "The single-task loop scales to a queue, and that is where delegation pays off most — a removal split across layers, a migration touching many files, a refactor sweep. The discipline that makes a queue trustworthy is sequencing and bookkeeping, not parallelism.",
  },
  {
    why: "coherence check lead-in",
    file: "references/multi-task-queues.md",
    text: "Per-task review proves each step in isolation; it does not prove the steps cohere.",
    except: { warp: NO_COHERENCE },
  },
  {
    why: "parallel batches pointer",
    file: "references/multi-task-queues.md",
    text: "For independent tasks, the `delegit-queue` skill dispatches several briefs in parallel, each in its own git worktree, and gives you one report to review. Dependent steps still run in order with this skill alone, as above.",
  },
  {
    why: "supported platforms (native Windows is refused at runtime)",
    file: "SKILL.md",
    text: "Runs on macOS, Linux and WSL; native Windows is not supported (use WSL).",
  },
  {
    why: "parallel batches example task",
    file: "references/multi-task-queues.md",
    text: 'A queue task that targets {CLI}: ```json {"id": "example-task", "brief": "briefs/example-task.md", "implementer": "{KEY}"} ```',
  },
];

const fill = (text, key) => text.replaceAll("{CLI}", names[key] ?? key).replaceAll("{KEY}", key);
for (const sentence of CANONICAL) {
  const excused = sentence.except ?? {};
  for (const key of KEYS) {
    const doc = docs.get(`${key}/${sentence.file}`);
    if (!doc) continue;
    const has = doc.flat.includes(fill(sentence.text, key).replace(/\s+/g, " "));
    if (key in excused) {
      check(!has, `delegit-${key}/${sentence.file}: stale exception, it now has the "${sentence.why}" sentence (${excused[key]})`);
    } else {
      check(has, `delegit-${key}/${sentence.file}: missing canonical sentence (${sentence.why}): ${fill(sentence.text, key)}`);
    }
  }
}

// warp has no read-only mode (delegit-queue/scripts/queue.mjs), so they can be queue
// tasks but never reviewers. Every other implementer must not claim that.
const NO_READ_ONLY = new Set(["warp"]);
for (const key of KEYS) {
  const doc = docs.get(`${key}/references/multi-task-queues.md`);
  if (!doc) continue;
  const claims = doc.flat.includes(`${names[key]} can be a queue task but not a reviewer`);
  check(claims === NO_READ_ONLY.has(key), `delegit-${key}/references/multi-task-queues.md: ${NO_READ_ONLY.has(key) ? "must say it can be a queue task but not a reviewer" : "must not claim it cannot review"}`);
}

// ---------------------------------------------------------------------------------------------
// 3. No CLI-id leaks
// ---------------------------------------------------------------------------------------------
// Prose should name the implementer by its display name ("one Claude run"), not its lowercase id.
// Binaries in code spans, flags and link targets are fine, so only prose outside them is scanned,
// and only in the three reference files that never need to name a binary in running text.
const LEAK_FILES = ["references/writing-the-brief.md", "references/review-and-land.md", "references/multi-task-queues.md"];
const stripCode = (line) => line.replace(/`[^`]*`/g, "").replace(/\]\([^)]*\)/g, "]");
const idPattern = new RegExp(`(?<![\\w./@-])(${KEYS.join("|")})(?![\\w./@-])`, "g");
for (const key of KEYS) {
  for (const file of LEAK_FILES) {
    const doc = docs.get(`${key}/${file}`);
    if (!doc) continue;
    doc.prose.forEach((line) => {
      for (const match of stripCode(line).matchAll(idPattern)) {
        fail(`delegit-${key}/${file}: lowercase CLI id "${match[1]}" where the display name belongs: ${line.trim()}`);
      }
    });
  }
  // The phrase-level leak ("one claude run") is checked everywhere, binaries aside.
  for (const file of FILES) {
    const doc = docs.get(`${key}/${file}`);
    if (!doc) continue;
    const phrase = new RegExp(`\\b(?:one|a|the) (${KEYS.join("|")}) (?:run|session|conversation)\\b`);
    const found = doc.flat.replace(/`[^`]*`/g, "").match(phrase);
    check(!found, `delegit-${key}/${file}: lowercase CLI id in "${found?.[0]}"`);
  }
}

// ---------------------------------------------------------------------------------------------
// 4. Vocabulary
// ---------------------------------------------------------------------------------------------
// AGENTS.md "Vocabulary" table, the "Not" column: these synonyms must not appear in running text.
// ("relay" is allowed for the dispatch script, so it is not listed.)
const BANNED = [
  [/\bworkers?\b/i, "worker (use: implementer)"],
  [/\bsub-agents?\b/i, "sub-agent (use: implementer; unhyphenated `subagents` is Codex's and Claude's own term and is allowed)"],
  [/\bexecutors?\b/i, "executor (use: implementer)"],
  [/\bfire(?:s|d)? off\b/i, "fire off (use: dispatch)"],
  [/\bkick(?:s|ed|ing)? off\b/i, "kick off (use: dispatch)"],
  [/\bhand-?offs?\b/i, "hand-off (use: delegate / delegation)"],
  [/\boffload(?:s|ed|ing)?\b/i, "offload (use: delegate)"],
];
for (const key of KEYS) {
  for (const file of FILES) {
    const doc = docs.get(`${key}/${file}`);
    if (!doc) continue;
    // Join the prose so a phrase wrapped across two lines ("fire\noff") is still seen.
    const text = doc.prose.map(stripCode).join(" ").replace(/\s+/g, " ");
    for (const [pattern, label] of BANNED) {
      const match = text.match(pattern);
      check(!match, `delegit-${key}/${file}: banned vocabulary "${match?.[0]}": ${label}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 5. Heading anchors
// ---------------------------------------------------------------------------------------------
// Renaming a heading silently breaks links to it, so verify every `file.md#anchor` / `#anchor` link
// between these docs against GitHub's slug rules.
const slug = (heading) =>
  heading
    .replace(/^#+\s+/, "")
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- _]/gu, "")
    .replace(/ /g, "-");
for (const key of KEYS) {
  for (const file of FILES) {
    const doc = docs.get(`${key}/${file}`);
    if (!doc) continue;
    for (const line of doc.prose) {
      for (const link of line.matchAll(/\]\((?:([\w./-]+\.md))?#([^)\s]+)\)/g)) {
        const target = link[1] ? docs.get(`${key}/${resolveRef(file, link[1])}`) : doc;
        if (!target) continue;
        const anchors = new Set(target.headings.map(slug));
        check(anchors.has(link[2]), `delegit-${key}/${file}: link to #${link[2]} matches no heading in ${link[1] ?? file}`);
      }
    }
  }
}
function resolveRef(from, ref) {
  // `[x](dispatch-and-poll.md)` inside references/, `[x](references/y.md)` inside SKILL.md.
  if (from === "SKILL.md") return ref.replace(/^\.\//, "");
  return `references/${ref.replace(/^\.\//, "")}`;
}

// ---------------------------------------------------------------------------------------------
if (failures.length) {
  console.error(`docs consistency: ${failures.length} problem(s) in ${checks} checks`);
  for (const message of failures) console.error(`  FAIL  ${message}`);
  process.exit(1);
}
console.log(`docs consistency: ${checks} checks passed across ${KEYS.length} skills`);
