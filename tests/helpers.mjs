import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

export const tmpDir = async (t, prefix = "agentic-skills-test-") => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

export const write = async (root, files) => {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
};

export const read = (root, relative) => fs.readFile(path.join(root, relative), "utf8");

export const md = (name, extra = "") => `---
name: ${name}
description: ${name} description
${extra}---

# ${name}
`;

export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

export const UPSTREAM_ARCHITECTURE = `# AG Kit Architecture

> Runtime-native toolkit — 2026.1.1

---

## 📋 Overview

Mentions rules, hooks, and the IDE runtime.

---

## 🤖 Agents (1)

| Agent | Focus |
| --- | --- |
| \`helper\` | Helping |

---

## 🧩 Skills (1)

| Skill | Description |
| --- | --- |
| \`alpha\` | Alpha skill |

---

## 🔄 Workflows (1)

| Command | Description |
| --- | --- |
| \`/go\` | Go |

---

## 🎯 Skill Loading Protocol (Conditional)

Load on demand.

---

## 🛠️ Runtime Scripts

Talks about .agents/scripts/ and hooks.

---

## 🔗 Quick Reference

| Need | Agent |
| --- | --- |
| Help | \`helper\` |
`;

/** Files of a fake ag-kit checkout, keyed by repository-relative path. */
export const upstreamFiles = ({ version = "2026.1.1", skillBody = "alpha v1", architecture = UPSTREAM_ARCHITECTURE } = {}) => ({
  LICENSE: "MIT License\n\nCopyright (c) 2026 VUDOVN\n",
  "package.json": `{ "name": "ag-kit", "version": "${version}" }\n`,
  ".agents/VERSION": `${version}\n`,
  ".agents/ARCHITECTURE.md": architecture,
  ".agents/agent/helper.md": md("helper"),
  ".agents/skills/alpha/SKILL.md": md("alpha", "when_to_use: always\n") + skillBody,
  ".agents/skills/alpha/scripts/check.py": "print(1)\n",
  ".agents/skills/alpha/__pycache__/check.cpython-312.pyc": "junk",
  ".agents/workflows/go.md": md("go"),
  ".agents/rules/should-not-copy.md": "nope",
  ".agents/memory/should-not-copy.md": "nope",
  ".agents/hooks/should-not-copy.mjs": "nope",
  "web/public/index.html": "<html></html>",
});

const BLOCK = 512;

const header = ({ name, size, type, prefix = "" }) => {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100, 8, "utf8");
  block.write("0000000\0", 108, 8, "utf8");
  block.write("0000000\0", 116, 8, "utf8");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  block.write("00000000000\0", 136, 12, "utf8");
  block.write("        ", 148, 8, "utf8");
  block.write(type, 156, 1, "utf8");
  block.write("ustar\0", 257, 6, "utf8");
  block.write("00", 263, 2, "utf8");
  if (prefix) block.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  return block;
};

const entry = (options, data = Buffer.alloc(0)) => {
  const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK, 0);
  data.copy(padded);
  return Buffer.concat([header({ ...options, size: data.length }), padded]);
};

const paxRecord = (key, value) => {
  let length = `${key}=${value}\n`.length + 1;
  length += String(length).length;
  if (String(length).length !== String(length - 1).length) length += 0;
  return `${length} ${key}=${value}\n`;
};

/**
 * Build a gzip tar archive the way GitHub serves one: a pax global header
 * carrying the commit, a top-level "<name>-<ref>/" directory, ustar entries.
 * `extraEntries` lets tests append raw entries such as pax path headers.
 */
export const buildArchive = (files, { root = "ag-kit-main", commit = COMMIT, extraEntries = [] } = {}) => {
  const parts = [];
  if (commit) parts.push(entry({ name: "pax_global_header", type: "g" }, Buffer.from(paxRecord("comment", commit))));
  parts.push(entry({ name: `${root}/`, type: "5" }));
  for (const [relative, content] of Object.entries(files)) {
    parts.push(entry({ name: `${root}/${relative}`, type: "0" }, Buffer.from(content)));
  }
  parts.push(...extraEntries);
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return zlib.gzipSync(Buffer.concat(parts));
};

export const rawEntry = entry;
export const rawPaxRecord = paxRecord;
