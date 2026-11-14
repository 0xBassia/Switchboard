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
      // A complete object may exceed the retained-input cap within this chunk.
      // Drop only an oversized partial, then rescan its suffix so a later
      // concatenated event is not lost.
      buf = buf.slice(start + MAX_BUFFERED_CHARS);
      index = 0;
      abandon();
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
export function makeLineScanner(onObject) {
  let buf = "";
  return (chunk) => {
    if (!chunk) return;
    let start = 0;
    for (;;) {
      const end = chunk.indexOf("\n", start);
      if (end === -1) break;
      const line = buf + chunk.slice(start, end);
      buf = "";
      const trimmed = line.trim();
      if (trimmed) {
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; /* skip non-JSON lines */ }
        if (parsed !== undefined) onObject(parsed);
      }
      start = end + 1;
    }
    buf += chunk.slice(start);
    if (buf.length > MAX_BUFFERED_CHARS) buf = "";
  };
}
