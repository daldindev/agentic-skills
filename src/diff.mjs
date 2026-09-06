/**
 * Three-way comparison of one file, used to explain why a local edit froze it.
 *
 * Everything is measured against the version the user installed from, so every
 * difference has a known author: the installed tree changed it, upstream
 * changed it, or both wrote in the same place. A two-way comparison cannot
 * tell those apart, which is the whole reason this exists.
 *
 * Nothing here merges anything. It only describes.
 */

/** Above this many table cells the alignment degrades to "replaced wholesale". */
const MAX_CELLS = 4_000_000;

export const toLines = (text) => {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

const mark = (type) => (line) => ({ type, line });

/** Longest common subsequence alignment of two line arrays. */
function align(a, b) {
  if (!a.length) return b.map(mark("add"));
  if (!b.length) return a.map(mark("remove"));
  if (a.length * b.length > MAX_CELLS) return [...a.map(mark("remove")), ...b.map(mark("add"))];

  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: "context", line: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ type: "remove", line: a[i++] });
    } else {
      ops.push({ type: "add", line: b[j++] });
    }
  }
  while (i < a.length) ops.push({ type: "remove", line: a[i++] });
  while (j < b.length) ops.push({ type: "add", line: b[j++] });
  return ops;
}

/**
 * Compare two texts line by line. Identical head and tail are trimmed first,
 * so an edit in one section does not pay for the rest of the file.
 */
export function diffLines(before, after) {
  const a = toLines(before);
  const b = toLines(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  return [
    ...a.slice(0, start).map(mark("context")),
    ...align(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map(mark("context")),
  ];
}

/**
 * Rewrite the comparison as an edit script against the base: a list of
 * `[start, end)` base ranges and the lines that replace each one. An insertion
 * is an empty range, which is what lets two insertions at the same point be
 * recognised as the same place.
 */
function editsAgainstBase(baseLines, otherLines) {
  // Trim the identical head and tail first, so a one-line change in a long file
  // never pays for the whole file, and never trips the size cap in `align`.
  let start = 0;
  while (start < baseLines.length && start < otherLines.length && baseLines[start] === otherLines[start]) start++;

  let endBase = baseLines.length;
  let endOther = otherLines.length;
  while (endBase > start && endOther > start && baseLines[endBase - 1] === otherLines[endOther - 1]) {
    endBase--;
    endOther--;
  }

  const ops = align(baseLines.slice(start, endBase), otherLines.slice(start, endOther));
  const edits = [];
  let index = start;
  let current = null;

  for (const op of ops) {
    if (op.type === "context") {
      if (current) edits.push(current);
      current = null;
      index++;
      continue;
    }
    current ||= { start: index, end: index, lines: [] };
    if (op.type === "remove") current.end = ++index;
    else current.lines.push(op.line);
  }
  if (current) edits.push(current);

  return edits;
}

/** Replay one side's edits over a slice of the base. */
function applyEdits(baseLines, start, end, edits) {
  const out = [];
  let cursor = start;
  for (const edit of edits) {
    out.push(...baseLines.slice(cursor, edit.start));
    out.push(...edit.lines);
    cursor = edit.end;
  }
  out.push(...baseLines.slice(cursor, end));
  return out;
}

/**
 * Every place the two sides diverged from the base, with all three versions of
 * that place and who wrote there.
 *
 * Ranges that touch are one region, the way a merge tool treats them: two
 * changes with no untouched line between them cannot be applied independently.
 */
export function changedRegions({ base, yours, upstream }) {
  const baseLines = toLines(base);
  const sides = {
    yours: editsAgainstBase(baseLines, toLines(yours)),
    upstream: editsAgainstBase(baseLines, toLines(upstream)),
  };

  const all = Object.entries(sides)
    .flatMap(([side, edits]) => edits.map((edit) => ({ ...edit, side })))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const grouped = [];
  for (const edit of all) {
    const last = grouped[grouped.length - 1];
    if (last && edit.start <= last.end) {
      last.end = Math.max(last.end, edit.end);
      last.parts.push(edit);
    } else {
      grouped.push({ start: edit.start, end: edit.end, parts: [edit] });
    }
  }

  return grouped.map((region) => {
    const authors = [...new Set(region.parts.map((part) => part.side))].sort();
    const partsFor = (side) => region.parts.filter((part) => part.side === side);
    return {
      baseStart: region.start,
      baseEnd: region.end,
      authors,
      base: baseLines.slice(region.start, region.end),
      yours: applyEdits(baseLines, region.start, region.end, partsFor("yours")),
      upstream: applyEdits(baseLines, region.start, region.end, partsFor("upstream")),
    };
  });
}

/**
 * Combine both sides when, and only when, they never wrote in the same place.
 *
 * A region with one author is unambiguous: taking that author's text is the
 * same operation `update` performs on a file nobody edited, with the scope
 * corrected from the file to the region. A region with two authors has no
 * answer that is not a guess, so the whole file is refused rather than
 * half-merged. Nothing the user wrote is ever dropped by this function.
 */
export function mergeClean({ base, yours, upstream }) {
  const regions = changedRegions({ base, yours, upstream });
  const conflicts = regions.filter((region) => region.authors.length === 2);
  if (conflicts.length) return { merged: null, conflicts: conflicts.length };

  const baseLines = toLines(base);
  const out = [];
  let cursor = 0;
  for (const region of regions) {
    out.push(...baseLines.slice(cursor, region.baseStart));
    out.push(...(region.authors[0] === "yours" ? region.yours : region.upstream));
    cursor = region.baseEnd;
  }
  out.push(...baseLines.slice(cursor));

  // The result replaces the reader's file, so it keeps the reader's line endings
  // and their choice about a final newline. A merge should change what it says,
  // not how every line in the file is terminated.
  const eol = yours.includes("\r\n") ? "\r\n" : "\n";
  const trailing = /\r?\n$/.test(yours) ? eol : "";
  return { merged: out.length ? out.join(eol) + trailing : "", conflicts: 0 };
}

/** The nearest Markdown heading above a region, to say where in the file it sits. */
export function locate(base, region) {
  const baseLines = toLines(base);
  if (region.baseStart >= baseLines.length) return "end of file";
  for (let i = region.baseStart; i >= 0; i--) {
    if (baseLines[i].startsWith("#")) return `line ${region.baseStart + 1}, in "${baseLines[i].trim()}"`;
  }
  return `line ${region.baseStart + 1}`;
}
