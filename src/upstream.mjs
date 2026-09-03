import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { isIgnoredName } from "./fs-utils.mjs";
import { readTar } from "./tar.mjs";

export const UPSTREAM = {
  repository: "https://github.com/vudovn/ag-kit",
  owner: "vudovn",
  name: "ag-kit",
  ref: "main",
};

/** Upstream path to installed path. Everything listed here is copied verbatim. */
export const PORTED = {
  directories: {
    ".agents/agent": "agent",
    ".agents/skills": "skills",
    ".agents/workflows": "workflows",
  },
  files: {
    ".agents/ARCHITECTURE.md": "ARCHITECTURE.md",
    LICENSE: "LICENSE",
  },
  version: ".agents/VERSION",
};

/**
 * Sections of the upstream ARCHITECTURE.md that describe the content. The
 * others describe upstream's wiring into its own runtime and are dropped.
 * Matching is by heading text after any leading emoji, so "## 🤖 Agents (20)"
 * matches "Agents".
 */
export const ARCHITECTURE_SECTIONS = [
  "Agents",
  "Skills",
  "Workflows",
  "Skill Loading Protocol",
  "Quick Reference",
];

/**
 * The real upstream archive is under 1 MB compressed and a few MB expanded.
 * The cap bounds decompression, which is where a small hostile file turns into
 * gigabytes; the timeout bounds a server that accepts a connection and stalls.
 */
export const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 30_000;

const megabytes = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

export const archiveUrl = (ref = UPSTREAM.ref) =>
  `https://codeload.github.com/${UPSTREAM.owner}/${UPSTREAM.name}/tar.gz/${ref.split("/").map(encodeURIComponent).join("/")}`;

const download = async (url, fetchImpl) => {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`Timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s downloading ${url}`);
    }
    throw new Error(`Could not download ${url}: ${error?.message || error}`);
  }
  if (!response.ok) {
    throw new Error(`Download failed with ${response.status} ${response.statusText} for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
};

/**
 * Get the upstream archive as a gzip buffer. `archive` may be a local .tar.gz
 * path or an http(s) URL; otherwise the GitHub archive for `ref` is fetched.
 */
export async function loadArchive({ ref = UPSTREAM.ref, archive = null, fetchImpl = globalThis.fetch } = {}) {
  if (archive) {
    if (/^https?:\/\//.test(archive)) return download(archive, fetchImpl);
    return fs.readFile(archive);
  }
  return download(archiveUrl(ref), fetchImpl);
}

/**
 * Archive entries are attacker-controlled whenever --archive is used, so a
 * path is accepted only when it cannot escape the directory it is written
 * into: no absolute paths, no "." or ".." segments, no backslashes (a
 * separator on Windows), and no NUL bytes.
 */
export function assertSafeRelativePath(relative, source = relative) {
  const unsafe =
    !relative ||
    relative.includes("\0") ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..");

  if (unsafe) {
    throw new Error(`The archive contains an unsafe path and was not extracted: ${JSON.stringify(source)}`);
  }
  return relative;
}

const headingTitle = (heading) =>
  heading.replace(/^##\s*/, "").replace(/^[^\p{L}\p{N}]+/u, "").trim().toLowerCase();

const matchesSection = (heading, name) => {
  const title = headingTitle(heading);
  const wanted = name.toLowerCase();
  return title === wanted || title.startsWith(`${wanted} `) || title.startsWith(`${wanted}(`);
};

/**
 * Keep only the ARCHITECTURE.md sections that describe the installed content.
 * When upstream no longer has one of the expected sections the file is
 * returned verbatim with a warning, so an upstream restructure never blocks
 * an install.
 */
export function portArchitecture(markdown, { commit, version } = {}) {
  const sections = [];
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^## /.test(line)) {
      current = { heading: line, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }

  const picked = [];
  for (const name of ARCHITECTURE_SECTIONS) {
    const section = sections.find((candidate) => matchesSection(candidate.heading, name));
    if (!section) {
      return {
        text: markdown,
        warning: `Upstream ARCHITECTURE.md has no "${name}" section, so it was installed verbatim.`,
      };
    }
    picked.push(section);
  }

  const trim = (lines) => {
    const body = [...lines];
    while (body.length && (body.at(-1).trim() === "" || body.at(-1).trim() === "---")) body.pop();
    while (body.length && body[0].trim() === "") body.shift();
    return body;
  };

  const source = [version ? `\`${version}\`` : null, commit ? `commit \`${commit.slice(0, 7)}\`` : null]
    .filter(Boolean)
    .join(", ");
  const header = [
    "# ag-kit Architecture",
    "",
    `> Inventory of the agents, skills, and workflows installed from [ag-kit](${UPSTREAM.repository})${source ? ` (${source})` : ""}.`,
    "> Sections about upstream tooling that is not part of this install were omitted; the sections below are upstream text, unchanged.",
  ].join("\n");

  const body = picked
    .map((section) => [section.heading, "", ...trim(section.lines)].join("\n"))
    .join("\n\n---\n\n");

  return { text: `${header}\n\n---\n\n${body}\n`, warning: null };
}

/**
 * Turn the upstream archive into the tree to install.
 * Returns { files: Map<installedPath, Buffer>, commit, version, warnings }.
 */
export function extractPort(archive, { filterArchitecture = true } = {}) {
  let tar;
  try {
    tar = zlib.gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(`The archive expands to more than ${megabytes(MAX_EXPANDED_BYTES)}, which is far bigger than ag-kit. Refusing to extract it.`);
    }
    throw new Error(`The archive could not be read as a .tar.gz: ${error?.message || error}`);
  }

  const raw = new Map();
  let commit = null;

  for (const entry of readTar(tar)) {
    if (entry.type === "global") {
      const comment = entry.pax?.comment;
      if (comment && /^[0-9a-f]{40}$/.test(comment)) commit = comment;
      continue;
    }
    if (entry.type !== "file") continue;
    const slash = entry.name.indexOf("/");
    if (slash === -1) continue;
    raw.set(entry.name.slice(slash + 1), entry.data);
  }

  const layoutHint = "Upstream may have changed its layout. Try --ref with a known-good tag, or update agentic-skills.";
  const files = new Map();

  for (const [from, to] of Object.entries(PORTED.directories)) {
    let count = 0;
    for (const [name, data] of raw) {
      if (!name.startsWith(`${from}/`)) continue;
      const relative = name.slice(from.length + 1);
      if (relative.split("/").some(isIgnoredName)) continue;
      files.set(assertSafeRelativePath(`${to}/${relative}`, name), data);
      count += 1;
    }
    if (count === 0) throw new Error(`The archive has no files under ${from}. ${layoutHint}`);
  }

  for (const [from, to] of Object.entries(PORTED.files)) {
    if (!raw.has(from)) throw new Error(`The archive has no ${from}. ${layoutHint}`);
    files.set(to, raw.get(from));
  }

  let version = "unknown";
  if (raw.has(PORTED.version)) {
    version = raw.get(PORTED.version).toString("utf8").trim() || version;
  } else if (raw.has("package.json")) {
    try {
      version = JSON.parse(raw.get("package.json").toString("utf8")).version || version;
    } catch {
      /* keep "unknown" */
    }
  }

  const warnings = [];
  if (filterArchitecture) {
    const ported = portArchitecture(files.get("ARCHITECTURE.md").toString("utf8"), { commit, version });
    files.set("ARCHITECTURE.md", Buffer.from(ported.text, "utf8"));
    if (ported.warning) warnings.push(ported.warning);
  }

  return { files, commit, version, warnings };
}

/** Write an extracted tree to a directory, never outside it. */
export async function materialize(files, dir) {
  const root = path.resolve(dir);
  for (const [relative, data] of files) {
    const target = path.resolve(root, ...relative.split("/"));
    if (!target.startsWith(root + path.sep)) {
      throw new Error(`Refusing to write ${JSON.stringify(relative)} outside ${root}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }
}
