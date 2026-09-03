import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { parsePax, readTar } from "../src/tar.mjs";
import { COMMIT, buildArchive, rawEntry, rawPaxRecord } from "./helpers.mjs";

const entries = (archive) => [...readTar(zlib.gunzipSync(archive))];

test("readTar yields the global header, directories, and files with their data", () => {
  const archive = buildArchive({ "a.txt": "hello", "dir/b.txt": "world" });
  const all = entries(archive);

  assert.equal(all[0].type, "global");
  assert.equal(all[0].pax.comment, COMMIT);
  assert.deepEqual(all.filter((e) => e.type === "directory").map((e) => e.name), ["ag-kit-main/"]);
  const files = all.filter((e) => e.type === "file");
  assert.deepEqual(files.map((e) => e.name), ["ag-kit-main/a.txt", "ag-kit-main/dir/b.txt"]);
  assert.equal(files[1].data.toString(), "world");
});

test("readTar joins the ustar prefix field onto the name", () => {
  const archive = buildArchive({}, {
    commit: null,
    extraEntries: [rawEntry({ name: "leaf.md", type: "0", prefix: "root/deep/path" }, Buffer.from("x"))],
  });
  const files = entries(archive).filter((e) => e.type === "file");
  assert.deepEqual(files.map((e) => e.name), ["root/deep/path/leaf.md"]);
});

test("readTar applies a pax extended path header to the following entry", () => {
  const longName = `root/${"segment/".repeat(20)}file.md`;
  const archive = buildArchive({}, {
    commit: null,
    extraEntries: [
      rawEntry({ name: "PaxHeader", type: "x" }, Buffer.from(rawPaxRecord("path", longName))),
      rawEntry({ name: "truncated", type: "0" }, Buffer.from("long")),
      rawEntry({ name: "root/after.md", type: "0" }, Buffer.from("after")),
    ],
  });
  const files = entries(archive).filter((e) => e.type === "file");
  assert.deepEqual(files.map((e) => e.name), [longName, "root/after.md"]);
});

test("readTar applies a GNU long-name entry instead of truncating the next path", () => {
  const longName = `root/${"segment/".repeat(20)}gnu.md`;
  const archive = buildArchive({}, {
    commit: null,
    extraEntries: [
      rawEntry({ name: "././@LongLink", type: "L" }, Buffer.from(`${longName}\0`)),
      rawEntry({ name: "root/truncated-by-ustar", type: "0" }, Buffer.from("long")),
      rawEntry({ name: "root/after.md", type: "0" }, Buffer.from("after")),
    ],
  });
  const files = entries(archive).filter((e) => e.type === "file");
  assert.deepEqual(files.map((e) => e.name), [longName, "root/after.md"]);
});

test("readTar skips entry types it does not handle", () => {
  const archive = buildArchive({ "kept.md": "k" }, {
    commit: null,
    extraEntries: [rawEntry({ name: "ag-kit-main/link", type: "2" })],
  });
  const files = entries(archive).filter((e) => e.type === "file");
  assert.deepEqual(files.map((e) => e.name), ["ag-kit-main/kept.md"]);
});

test("readTar rejects a truncated archive", () => {
  const tar = zlib.gunzipSync(buildArchive({ "a.txt": "x".repeat(600) }));
  // Drop the two end-of-archive blocks plus one block of the file's own data.
  assert.throws(() => [...readTar(tar.subarray(0, tar.length - 1536))], /Truncated/);
});

test("parsePax reads multiple records", () => {
  const data = Buffer.from(`${rawPaxRecord("comment", COMMIT)}${rawPaxRecord("path", "a/b")}`);
  assert.deepEqual(parsePax(data), { comment: COMMIT, path: "a/b" });
});
