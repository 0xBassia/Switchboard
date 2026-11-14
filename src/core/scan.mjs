// Incremental parsers for implementer stdout. Both bound retained input to
// MAX_BUFFERED_CHARS so a runaway stream cannot exhaust memory.

export const MAX_BUFFERED_CHARS = 1_048_576;

// Extracts top-level JSON objects from a stream that may interleave them with
// non-JSON noise (progress bars, banners) and split them across chunks. Every
// supported CLI writes one event per line, so a candidate object that reaches a
// line break unclosed is abandoned, as is one whose `{` is not followed by a key
// or `}`. Otherwise one stray brace in a banner would nest every later event
// until the buffer cap dropped them all.
export function makeEventScanner(onObject) {
  let buf = "";
  let index = 0;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let expectKey = false;
  // After an oversized event is dropped, the rest of its line is discarded: rescanning
  // inside the rejected value would promote a nested object (tool output) to an event.
  let skipLine = false;
  const abandon = () => {
    depth = 0;
    start = -1;
    inString = false;
    escaped = false;
    expectKey = false;
  };
  return (chunk) => {
    if (!chunk) return;
    buf += chunk;
    for (;;) {
      while (index < buf.length) {
        const ch = buf[index];
        if (skipLine) {
          if (ch === "\n" || ch === "\r") skipLine = false;
          index += 1;
          continue;
        }
        // Only track strings inside an object (depth > 0). At depth 0 we are
        // skipping a junk prefix, and an unmatched `"` there must not swallow the
        // real `{...}` that follows in the same chunk.
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          else if (ch === "\n" || ch === "\r") abandon();
          index += 1;
          continue;
        }
        if (depth > 0 && (ch === "\n" || ch === "\r")) {
          abandon();
          index += 1;
          continue;
        }
        if (expectKey && ch !== " " && ch !== "\t") {
          expectKey = false;
          if (ch !== '"' && ch !== "}") {
            // Not an object after all: rescan this character at depth 0.
            abandon();
            continue;
          }
        }
        if (ch === '"') {
          if (depth > 0) inString = true;
        } else if (ch === "{") {
          if (depth === 0) start = index;
          depth += 1;
          expectKey = true;
        } else if (ch === "}") {
          if (depth > 0) {
            depth -= 1;
            if (depth === 0 && start !== -1) {
              const slice = buf.slice(start, index + 1);
              start = -1;
              let parsed;
              try { parsed = JSON.parse(slice); } catch { parsed = undefined; /* skip malformed */ }
              if (parsed !== undefined) onObject(parsed);
            }
          }
        }
        index += 1;
      }
      if (depth === 0 || start === -1 || buf.length - start <= MAX_BUFFERED_CHARS) break;
      // An object over the retained-input cap is dropped with the rest of its line;
      // scanning resumes at the next line break.
      buf = buf.slice(start + MAX_BUFFERED_CHARS);
      index = 0;
      abandon();
      skipLine = true;
    }
    if (depth > 0 && start !== -1) {
      if (start > 0) {
        buf = buf.slice(start);
        index -= start;
        start = 0;
      }
    } else {
      buf = "";
      index = 0;
      start = -1;
    }
  };
}

// One JSON value per line (JSONL / NDJSON). Non-JSON lines are skipped.
// A line over the cap is dropped whole, through its line break.
export function makeLineScanner(onObject) {
  let buf = "";
  let skipLine = false;
  return (chunk) => {
    if (!chunk) return;
    let start = 0;
    for (;;) {
      const end = chunk.indexOf("\n", start);
      if (end === -1) break;
      const line = buf + chunk.slice(start, end);
      buf = "";
      if (skipLine) {
        skipLine = false;
        start = end + 1;
        continue;
      }
      const trimmed = line.trim();
      if (trimmed) {
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; /* skip non-JSON lines */ }
        if (parsed !== undefined) onObject(parsed);
      }
      start = end + 1;
    }
    if (skipLine) return;
    buf += chunk.slice(start);
    if (buf.length > MAX_BUFFERED_CHARS) {
      buf = "";
      skipLine = true;
    }
  };
}
