import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export const PACKAGE_ROOT = path.resolve(currentDir, "..");

const IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db", "__pycache__"]);
const IGNORED_SUFFIXES = [".pyc"];

export const toPosix = (value) => value.split(path.sep).join("/");

export const isIgnoredName = (name) =>
  IGNORED_NAMES.has(name) || IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix));

export const exists = async (target) => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

export const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

export const writeJson = async (file, data) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
};

export const hashFile = async (file) =>
  crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");

/**
 * Map of posix-relative file path to sha256 for every file under `root`.
 * `ignorePrefixes` are posix-relative paths to skip entirely.
 */
export async function snapshotTree(root, { ignorePrefixes = [] } = {}) {
  const snapshot = {};
  if (!(await exists(root))) return snapshot;

  const visit = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (isIgnoredName(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (ignorePrefixes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) snapshot[relative] = await hashFile(absolute);
    }
  };

  await visit(root);
  return snapshot;
}

export async function copyFile(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

export async function removeEmptyParents(file, stopDir) {
  const stop = path.resolve(stopDir);
  let current = path.dirname(path.resolve(file));
  while (current !== stop && current.startsWith(`${stop}${path.sep}`)) {
    const entries = await fs.readdir(current).catch(() => null);
    if (!entries || entries.length > 0) break;
    await fs.rmdir(current);
    current = path.dirname(current);
  }
}
