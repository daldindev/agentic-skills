import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import {
  ARCHITECTURE_SECTIONS,
  DOWNLOAD_TIMEOUT_MS,
  archiveUrl,
  assertSafeRelativePath,
  extractPort,
  loadArchive,
  materialize,
  portArchitecture,
} from "../src/upstream.mjs";
import { COMMIT, UPSTREAM_ARCHITECTURE, buildArchive, md, tmpDir, upstreamFiles } from "./helpers.mjs";

test("archiveUrl points at the GitHub codeload tarball for a ref", () => {
  assert.equal(archiveUrl("main"), "https://codeload.github.com/vudovn/ag-kit/tar.gz/main");
  assert.equal(archiveUrl("v2026.8.31"), "https://codeload.github.com/vudovn/ag-kit/tar.gz/v2026.8.31");
  assert.equal(archiveUrl("refs/heads/dev"), "https://codeload.github.com/vudovn/ag-kit/tar.gz/refs/heads/dev");
});

test("extractPort keeps only the ported paths, verbatim, and renames agent to agents", () => {
  const { files, commit, version, warnings } = extractPort(buildArchive(upstreamFiles()));

  assert.equal(commit, COMMIT);
  assert.equal(version, "2026.1.1");
  assert.deepEqual(warnings, []);
  assert.deepEqual([...files.keys()].sort(), [
    "ARCHITECTURE.md",
    "LICENSE",
    "agent/helper.md",
    "skills/alpha/SKILL.md",
    "skills/alpha/scripts/check.py",
    "workflows/go.md",
  ]);
  assert.equal(files.get("agent/helper.md").toString(), md("helper"));
  assert.match(files.get("LICENSE").toString(), /VUDOVN/);
});

test("extractPort falls back to the root package.json version", () => {
  const files = upstreamFiles({ version: "2026.2.2" });
  delete files[".agents/VERSION"];
  assert.equal(extractPort(buildArchive(files)).version, "2026.2.2");
});

test("extractPort refuses an archive whose layout lacks a ported directory", () => {
  const files = upstreamFiles();
  for (const key of Object.keys(files)) if (key.startsWith(".agents/skills/")) delete files[key];
  assert.throws(() => extractPort(buildArchive(files)), /no files under \.agents\/skills/);
});

test("extractPort refuses an archive without the upstream license", () => {
  const files = upstreamFiles();
  delete files.LICENSE;
  assert.throws(() => extractPort(buildArchive(files)), /no LICENSE/);
});

test("portArchitecture keeps the content sections verbatim and drops the rest", () => {
  const { text, warning } = portArchitecture(UPSTREAM_ARCHITECTURE, { commit: COMMIT, version: "2026.1.1" });

  assert.equal(warning, null);
  for (const name of ARCHITECTURE_SECTIONS) assert.match(text, new RegExp(`^## .*${name}`, "m"));
  assert.match(text, /\| `helper` \| Helping \|/);
  assert.doesNotMatch(text, /Overview/);
  assert.doesNotMatch(text, /Runtime Scripts/);
  assert.doesNotMatch(text, /Runtime-native toolkit/);
  assert.match(text, /commit `0123456`/);
  assert.match(text, /`2026\.1\.1`/);
  assert.ok(text.indexOf("## 🧩 Skills (1)") < text.indexOf("## 🎯 Skill Loading Protocol"));
});

test("portArchitecture returns the file verbatim with a warning when a section is missing", () => {
  const renamed = UPSTREAM_ARCHITECTURE.replace("## 🔄 Workflows (1)", "## 🔄 Commands (1)");
  const { text, warning } = portArchitecture(renamed, { commit: COMMIT, version: "2026.1.1" });
  assert.equal(text, renamed);
  assert.match(warning, /no "Workflows" section/);
});

test("extractPort surfaces the architecture warning and can skip filtering", () => {
  const renamed = UPSTREAM_ARCHITECTURE.replace("## 🔄 Workflows (1)", "## 🔄 Commands (1)");
  const archive = buildArchive(upstreamFiles({ architecture: renamed }));

  const filtered = extractPort(archive);
  assert.equal(filtered.warnings.length, 1);
  assert.equal(filtered.files.get("ARCHITECTURE.md").toString(), renamed);

  const verbatim = extractPort(buildArchive(upstreamFiles()), { filterArchitecture: false });
  assert.equal(verbatim.files.get("ARCHITECTURE.md").toString(), UPSTREAM_ARCHITECTURE);
});

test("loadArchive reads a local file, or downloads a URL through fetch", async (t) => {
  const dir = await tmpDir(t);
  const file = path.join(dir, "ag-kit.tar.gz");
  const archive = buildArchive(upstreamFiles());
  await fs.writeFile(file, archive);

  assert.ok((await loadArchive({ archive: file })).equals(archive));

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, arrayBuffer: async () => archive };
  };
  assert.ok((await loadArchive({ ref: "v1", fetchImpl })).equals(archive));
  assert.ok((await loadArchive({ archive: "https://example.test/x.tgz", fetchImpl })).equals(archive));
  assert.deepEqual(calls, [archiveUrl("v1"), "https://example.test/x.tgz"]);

  const failing = async () => ({ ok: false, status: 404, statusText: "Not Found" });
  await assert.rejects(loadArchive({ ref: "nope", fetchImpl: failing }), /404 Not Found/);
});

test("assertSafeRelativePath rejects every way out of the destination", () => {
  const bs = String.fromCharCode(92);
  for (const unsafe of [
    "skills/../../../evil.md",
    "../evil.md",
    "./evil.md",
    "/etc/passwd",
    "C:/evil.md",
    `skills/..${bs}..${bs}evil.md`,
    `..${bs}evil.md`,
    "skills//evil.md",
    "skills/\0evil.md",
    "",
  ]) {
    assert.throws(() => assertSafeRelativePath(unsafe), /unsafe path/, `should reject ${JSON.stringify(unsafe)}`);
  }
  assert.equal(assertSafeRelativePath("skills/alpha/SKILL.md"), "skills/alpha/SKILL.md");
});

test("extractPort refuses an archive that tries to escape the destination", () => {
  const traversal = upstreamFiles();
  traversal[".agents/skills/../../../../ESCAPED.md"] = "pwned";
  assert.throws(() => extractPort(buildArchive(traversal)), /unsafe path/);

  const bs = String.fromCharCode(92);
  const windows = upstreamFiles();
  windows[`.agents/skills/..${bs}..${bs}ESCAPED.md`] = "pwned";
  assert.throws(() => extractPort(buildArchive(windows)), /unsafe path/);
});

test("materialize refuses to write outside its destination", async (t) => {
  const dir = await tmpDir(t);
  const escaping = new Map([["skills/../../../ESCAPED.md", Buffer.from("pwned")]]);
  await assert.rejects(materialize(escaping, dir), /Refusing to write/);
  await assert.rejects(fs.access(path.resolve(dir, "../../../ESCAPED.md")));
});

test("extractPort refuses a decompression bomb instead of exhausting memory", () => {
  const bomb = zlib.gzipSync(Buffer.alloc(200 * 1024 * 1024));
  assert.ok(bomb.length < 1024 * 1024, "the bomb should be small on disk");
  assert.throws(() => extractPort(bomb), /expands to more than/);
});

test("extractPort reports unreadable archives clearly", () => {
  assert.throws(() => extractPort(Buffer.from("not a gzip at all")), /could not be read as a \.tar\.gz/);
});

test("loadArchive gives every download a timeout and reports one clearly", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(options?.signal);
    return { ok: true, arrayBuffer: async () => buildArchive(upstreamFiles()) };
  };
  await loadArchive({ ref: "main", fetchImpl });
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof AbortSignal, "fetch should receive an AbortSignal");
  assert.ok(DOWNLOAD_TIMEOUT_MS > 0);

  const timingOut = async () => {
    const error = new Error("aborted");
    error.name = "TimeoutError";
    throw error;
  };
  await assert.rejects(loadArchive({ ref: "main", fetchImpl: timingOut }), /Timed out after 30s/);

  const offline = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(loadArchive({ ref: "main", fetchImpl: offline }), /Could not download .*fetch failed/);
});

test("materialize writes the extracted tree to disk", async (t) => {
  const dir = await tmpDir(t);
  const { files } = extractPort(buildArchive(upstreamFiles()));
  await materialize(files, dir);
  assert.equal(await fs.readFile(path.join(dir, "agent", "helper.md"), "utf8"), md("helper"));
  await fs.access(path.join(dir, "skills", "alpha", "scripts", "check.py"));
});
