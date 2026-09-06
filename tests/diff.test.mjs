import test from "node:test";
import assert from "node:assert/strict";
import { changedRegions, diffLines, locate, mergeClean } from "../src/diff.mjs";

const text = (...lines) => `${lines.join("\n")}\n`;
const authorsOf = (regions) => regions.map((region) => region.authors.join("+"));

test("diffLines marks added, removed, and unchanged lines", () => {
  const ops = diffLines(text("keep", "drop", "tail"), text("keep", "new", "tail"));
  assert.deepEqual(ops, [
    { type: "context", line: "keep" },
    { type: "remove", line: "drop" },
    { type: "add", line: "new" },
    { type: "context", line: "tail" },
  ]);
});

test("a trailing newline alone is not a difference", () => {
  assert.deepEqual(changedRegions({ base: "a\nb\n", yours: "a\nb", upstream: "a\nb\n" }), []);
});

test("a file nobody changed has no regions", () => {
  const same = text("a", "b", "c");
  assert.deepEqual(changedRegions({ base: same, yours: same, upstream: same }), []);
});

test("a line only you changed is attributed to you, with all three versions", () => {
  const base = text("one", "two", "three");
  const regions = changedRegions({ base, yours: text("one", "three"), upstream: base });

  assert.equal(regions.length, 1);
  const [region] = regions;
  assert.deepEqual(region.authors, ["yours"]);
  assert.deepEqual(region.base, ["two"]);
  assert.deepEqual(region.yours, []);
  assert.deepEqual(region.upstream, ["two"]);
});

test("a line only upstream changed is attributed to upstream", () => {
  const base = text("one", "two", "three");
  const regions = changedRegions({ base, yours: base, upstream: text("one", "TWO", "three") });

  assert.deepEqual(authorsOf(regions), ["upstream"]);
  assert.deepEqual(regions[0].yours, ["two"]);
  assert.deepEqual(regions[0].upstream, ["TWO"]);
});

test("two appends at the same point are one region written by both sides", () => {
  const base = text("one", "two");
  const regions = changedRegions({
    base,
    yours: text("one", "two", "mine"),
    upstream: text("one", "two", "theirs"),
  });

  assert.deepEqual(authorsOf(regions), ["upstream+yours"]);
  assert.deepEqual(regions[0].base, []);
  assert.deepEqual(regions[0].yours, ["mine"]);
  assert.deepEqual(regions[0].upstream, ["theirs"]);
});

test("changes far apart stay separate regions, each with one author", () => {
  const base = text("a", "b", "c", "d", "e", "f", "g");
  const regions = changedRegions({
    base,
    yours: text("A", "b", "c", "d", "e", "f", "g"),
    upstream: text("a", "b", "c", "d", "e", "f", "G"),
  });

  assert.deepEqual(authorsOf(regions), ["yours", "upstream"]);
});

test("adjacent changes are one region, the way a merge tool treats them", () => {
  const base = text("a", "b", "c");
  const regions = changedRegions({
    base,
    yours: text("A", "b", "c"),
    upstream: text("a", "B", "c"),
  });

  assert.deepEqual(authorsOf(regions), ["upstream+yours"]);
});

test("a base that does not exist reads as both sides writing the whole file", () => {
  const regions = changedRegions({ base: "", yours: text("mine"), upstream: text("theirs") });
  assert.deepEqual(authorsOf(regions), ["upstream+yours"]);
  assert.deepEqual(regions[0].base, []);
});

test("mergeClean carries both sides when they never met", () => {
  const base = text("a", "b", "c", "d", "e", "f", "g");
  const { merged, conflicts } = mergeClean({
    base,
    yours: text("A", "b", "c", "d", "e", "f", "g"),
    upstream: text("a", "b", "c", "d", "e", "f", "G"),
  });

  assert.equal(conflicts, 0);
  assert.equal(merged, text("A", "b", "c", "d", "e", "f", "G"));
});

test("mergeClean keeps a line you deleted deleted", () => {
  const base = text("a", "b", "c", "d", "e");
  const { merged } = mergeClean({
    base,
    yours: text("a", "c", "d", "e"),
    upstream: text("a", "b", "c", "d", "E"),
  });

  assert.equal(merged, text("a", "c", "d", "E"));
});

test("mergeClean refuses rather than guessing when both sides wrote in one place", () => {
  const base = text("a", "b", "c");
  const { merged, conflicts } = mergeClean({
    base,
    yours: text("a", "MINE", "c"),
    upstream: text("a", "THEIRS", "c"),
  });

  assert.equal(merged, null);
  assert.equal(conflicts, 1);
});

test("mergeClean counts every place the two sides collided", () => {
  const base = text("a", "b", "c", "d", "e", "f", "g", "h", "i");
  const { merged, conflicts } = mergeClean({
    base,
    yours: text("A", "b", "c", "d", "e", "f", "g", "h", "I"),
    upstream: text("1", "b", "c", "d", "e", "f", "g", "h", "9"),
  });

  assert.equal(merged, null);
  assert.equal(conflicts, 2);
});

test("a one-line change in a long file is still a one-line change", () => {
  // Long enough that comparing the whole file would pass the alignment size cap
  // and collapse every line into a single all-or-nothing region.
  const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
  const swap = (index, value) => lines.map((line, i) => (i === index ? value : line));

  const regions = changedRegions({
    base: text(...lines),
    yours: text(...swap(40, "line 40, mine")),
    upstream: text(...swap(1200, "line 1200, theirs")),
  });

  assert.deepEqual(authorsOf(regions), ["yours", "upstream"]);
  assert.deepEqual(regions[0].base, ["line 40"]);
  assert.deepEqual(regions[1].base, ["line 1200"]);

  const { merged } = mergeClean({
    base: text(...lines),
    yours: text(...swap(40, "line 40, mine")),
    upstream: text(...swap(1200, "line 1200, theirs")),
  });
  assert.match(merged, /line 40, mine/);
  assert.match(merged, /line 1200, theirs/);
});

test("mergeClean keeps the line endings and final newline of the file it replaces", () => {
  const crlf = "L1\r\nL2\r\nL3\r\n";
  const { merged } = mergeClean({ base: "L1\nL2\nL3\n", yours: crlf, upstream: "L1\nL2\nL3-NEW\n" });
  assert.equal(merged, "L1\r\nL2\r\nL3-NEW\r\n");

  const noTrailer = mergeClean({ base: "L1\nL2\n", yours: "L1\nL2", upstream: "L1\nL2-NEW\n" });
  assert.equal(noTrailer.merged, "L1\nL2-NEW");
});

test("mergeClean returns the file unchanged when nobody changed anything", () => {
  const same = text("a", "b");
  assert.equal(mergeClean({ base: same, yours: same, upstream: same }).merged, same);
});

test("locate names the nearest heading above a region, or the end of the file", () => {
  const base = text("# alpha", "", "## Setup", "", "passo um", "passo dois");
  const [inSetup] = changedRegions({ base, yours: text("# alpha", "", "## Setup", "", "passo um"), upstream: base });
  assert.equal(locate(base, inSetup), 'line 6, in "## Setup"');

  const [atEnd] = changedRegions({ base, yours: `${base}extra\n`, upstream: base });
  assert.equal(locate(base, atEnd), "end of file");
});
