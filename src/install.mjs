import fs from "node:fs/promises";
import path from "node:path";
import { changedRegions, locate, mergeClean } from "./diff.mjs";
import {
  PACKAGE_ROOT,
  copyFile,
  exists,
  hashFile,
  readJson,
  removeEmptyParents,
  snapshotTree,
  writeJson,
} from "./fs-utils.mjs";

export const DEFAULT_INSTALL_DIR = ".agents";
export const METADATA_DIR = ".agentic-skills";
export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_SCHEMA_VERSION = 1;

export function resolveTarget({ path: projectPath, dir } = {}) {
  const projectDir = path.resolve(projectPath || process.cwd());
  const installDir = path.resolve(projectDir, dir || DEFAULT_INSTALL_DIR);
  return {
    projectDir,
    installDir,
    manifestPath: path.join(installDir, METADATA_DIR, MANIFEST_FILE),
  };
}

export async function loadManifest(installDir) {
  const manifestPath = path.join(installDir, METADATA_DIR, MANIFEST_FILE);
  if (!(await exists(manifestPath))) return null;
  try {
    const manifest = await readJson(manifestPath);
    if (manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION) return null;
    if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) return null;
    return manifest;
  } catch {
    return null;
  }
}

async function writeManifest(installDir, files, { previous = null, upstream = null } = {}) {
  const now = new Date().toISOString();
  const pkg = await readJson(path.join(PACKAGE_ROOT, "package.json"));
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    packageName: pkg.name,
    packageVersion: pkg.version,
    upstream,
    installedAt: previous?.installedAt || now,
    updatedAt: now,
    files,
  };
  await writeJson(path.join(installDir, METADATA_DIR, MANIFEST_FILE), manifest);
  return manifest;
}

/**
 * What each installed file descends from after this run.
 *
 * Only files this run actually wrote move to the incoming hash. A file left
 * frozen keeps the hash it had, because its ancestor is still the version it was
 * last written from; recording the new one would make a later merge read
 * upstream's change as the user having deleted it.
 */
function nextManifestFiles({ previous, plan }) {
  const kept = new Set(plan.keep.map((item) => item.file));
  const files = {};

  // Carry an entry forward only while the file is still something to track:
  // upstream still ships it, or it is on disk because an edit saved it.
  for (const [file, hash] of Object.entries(previous)) {
    if (plan.incoming[file] !== undefined || kept.has(file)) files[file] = hash;
  }

  for (const file of [...plan.add, ...plan.update, ...plan.unchanged]) files[file] = plan.incoming[file];
  for (const { file } of plan.merge ?? []) files[file] = plan.incoming[file];
  return files;
}

/**
 * Three-way comparison between the installed tree, the incoming tree fetched
 * from upstream, and the hashes recorded at the last install or update.
 *
 * - add:       incoming, not installed
 * - update:    incoming, installed, unchanged locally since the last run (or --force)
 * - skip:      incoming, installed, modified locally (left alone)
 * - remove:    tracked before, gone from incoming, unchanged locally (or --force)
 * - keep:      tracked before, gone from incoming, modified locally
 * - unchanged: already identical to incoming
 *
 * Files the user created themselves are never tracked and never touched.
 */
export async function planUpdate({ installDir, incomingDir, manifest = null, force = false }) {
  const current = await snapshotTree(installDir, { ignorePrefixes: [METADATA_DIR] });
  const incoming = await snapshotTree(incomingDir);
  const previous = manifest?.files || {};
  const files = [...new Set([...Object.keys(current), ...Object.keys(incoming), ...Object.keys(previous)])].sort();

  const plan = { add: [], update: [], skip: [], remove: [], keep: [], unchanged: [], incoming };

  for (const file of files) {
    const currentHash = current[file];
    const incomingHash = incoming[file];
    const previousHash = previous[file];

    if (incomingHash !== undefined) {
      if (currentHash === undefined) plan.add.push(file);
      else if (currentHash === incomingHash) plan.unchanged.push(file);
      else if (currentHash === previousHash || force) plan.update.push(file);
      else {
        plan.skip.push({
          file,
          reason: previousHash === undefined
            ? "differs from upstream and is not tracked by a manifest"
            : "modified locally",
        });
      }
      continue;
    }

    if (currentHash === undefined || previousHash === undefined) continue;
    if (currentHash === previousHash || force) plan.remove.push(file);
    else plan.keep.push({ file, reason: "removed upstream but modified locally" });
  }

  return plan;
}

/**
 * Try to combine both sides for the files the plan would otherwise skip.
 *
 * A file is only ever a merge candidate when the downloaded base hashes to the
 * exact value the manifest recorded for it. That proves the text being used as
 * the common ancestor is the text that was installed; without that proof the
 * file is left frozen, because a wrong ancestor is how a merge loses work.
 */
export async function resolveMerges({ installDir, incomingDir, baseDir, plan, manifest }) {
  if (!baseDir || !manifest) return { merge: [], skip: plan.skip };

  const merge = [];
  const skip = [];

  for (const item of plan.skip) {
    const recorded = manifest.files?.[item.file];
    const basePath = path.join(baseDir, item.file);
    const provable = recorded && (await exists(basePath)) && (await hashFile(basePath)) === recorded;
    if (!provable) {
      skip.push({ ...item, reason: `${item.reason}; no proven common ancestor to merge from` });
      continue;
    }

    const [base, yours, incoming] = await Promise.all([
      fs.readFile(basePath, "utf8"),
      fs.readFile(path.join(installDir, item.file), "utf8"),
      fs.readFile(path.join(incomingDir, item.file), "utf8"),
    ]);

    const { merged, conflicts } = mergeClean({ base, yours, upstream: incoming });
    if (merged === null) {
      skip.push({ ...item, reason: `your change and upstream's overlap in ${conflicts === 1 ? "one place" : `${conflicts} places`}` });
      continue;
    }
    merge.push({ file: item.file, text: merged });
  }

  return { merge, skip };
}

export async function applyPlan({ installDir, incomingDir, plan }) {
  for (const file of [...plan.add, ...plan.update]) {
    await copyFile(path.join(incomingDir, file), path.join(installDir, file));
  }
  for (const { file, text } of plan.merge ?? []) {
    await fs.writeFile(path.join(installDir, file), text);
  }
  for (const file of plan.remove) {
    const target = path.join(installDir, file);
    await fs.rm(target, { force: true });
    await removeEmptyParents(target, installDir);
  }
}

/**
 * Where the version this install came from can be read, if anywhere. `loadBase`
 * is only called once the plan actually has something frozen, so an install with
 * no local edits never pays for a second download.
 */
async function baseFor(options, plan, manifest) {
  if (options.baseDir) return { dir: options.baseDir, upstream: options.base || null };
  if (!plan.skip.length || !options.loadBase) return null;
  return (await options.loadBase(manifest)) || null;
}

async function hasContent(dir) {
  if (!(await exists(dir))) return false;
  const entries = await fs.readdir(dir);
  return entries.length > 0;
}

/**
 * Plan against the incoming tree, apply it, and record the manifest.
 * The three commands differ only in the preconditions they enforce first.
 */
async function reconcile(mode, options) {
  const { installDir } = resolveTarget(options);
  const { incomingDir, upstream = null } = options;

  const created = !(await hasContent(installDir));
  const manifest = await loadManifest(installDir);
  const plan = await planUpdate({ installDir, incomingDir, manifest, force: Boolean(options.force) });

  const base = await baseFor(options, plan, manifest);
  const resolved = await resolveMerges({
    installDir,
    incomingDir,
    baseDir: base?.dir || null,
    plan,
    manifest,
  });
  plan.merge = resolved.merge;
  plan.skip = resolved.skip;

  if (!options.dryRun) {
    await applyPlan({ installDir, incomingDir, plan });
    const files = nextManifestFiles({ previous: manifest?.files || {}, plan });
    await writeManifest(installDir, files, { previous: manifest, upstream });
  }
  return {
    mode,
    installDir,
    plan,
    upstream,
    created,
    hadManifest: Boolean(manifest),
    dryRun: Boolean(options.dryRun),
  };
}

export async function init(options = {}) {
  const { installDir } = resolveTarget(options);

  if (!options.force && (await hasContent(installDir))) {
    throw new Error(
      `${installDir} already exists and is not empty. Run "agentic-skills update" to update it, ` +
      '"agentic-skills sync" if this runs unattended, or pass --force to overwrite managed files in place.',
    );
  }

  return reconcile("init", options);
}

export async function update(options = {}) {
  const { installDir } = resolveTarget(options);

  if (!(await exists(installDir))) {
    throw new Error(`${installDir} does not exist. Run "agentic-skills init" first.`);
  }

  return reconcile("update", options);
}

/**
 * Reconcile whatever state the target is in: install it when missing, update it
 * when it is already there. Neither precondition applies, so this is the command
 * to run unattended - a postinstall, a CI step, a container build - where one
 * line has to work on a fresh clone and on an existing tree alike. Local edits
 * are preserved exactly as with update, and --force overwrites them.
 */
export async function sync(options = {}) {
  return reconcile("sync", options);
}

/**
 * Report what upstream changed in the files a local edit froze.
 *
 * `status` says which files stopped receiving updates; this says what they
 * stopped receiving. Nothing is written, and nothing is merged: the installer
 * never reconciles an edited file on its own, so this is the input a person
 * needs to do it by hand.
 */
export async function inspect(options = {}) {
  const { installDir } = resolveTarget(options);
  const { incomingDir, upstream = null } = options;

  if (!(await exists(installDir))) {
    throw new Error(`${installDir} does not exist. Run "agentic-skills init" first.`);
  }

  const manifest = await loadManifest(installDir);
  const plan = await planUpdate({ installDir, incomingDir, manifest, force: false });
  const base = await baseFor(options, plan, manifest);
  const baseDir = base?.dir || null;
  const read = async (dir, file) => (dir ? fs.readFile(path.join(dir, file), "utf8").catch(() => null) : null);

  const frozen = [];
  for (const { file, reason } of plan.skip) {
    const yours = await read(installDir, file);
    const incoming = await read(incomingDir, file);
    // A file upstream added after this install has no base text; treat it as empty
    // so both sides read as having written the whole thing, which is the truth.
    const baseText = (await read(baseDir, file)) ?? "";

    const regions = baseDir
      ? changedRegions({ base: baseText, yours, upstream: incoming })
        .map((region) => ({ ...region, where: locate(baseText, region) }))
      : null;

    frozen.push({
      file,
      reason,
      regions,
      collisions: regions ? regions.filter((region) => region.authors.length === 2).length : null,
    });
  }

  return {
    installDir,
    upstream,
    base: base?.upstream || null,
    comparedAgainstBase: Boolean(baseDir),
    hadManifest: Boolean(manifest),
    frozen,
    removedUpstream: plan.keep,
  };
}

/** Local report only; nothing is fetched. */
export async function status(options = {}) {
  const { installDir } = resolveTarget(options);
  const pkg = await readJson(path.join(PACKAGE_ROOT, "package.json"));
  const packageMeta = { packageName: pkg.name, packageVersion: pkg.version };

  if (!(await exists(installDir))) {
    return { installed: false, installDir, package: packageMeta };
  }

  const manifest = await loadManifest(installDir);
  const current = await snapshotTree(installDir, { ignorePrefixes: [METADATA_DIR] });
  const tracked = manifest?.files || {};
  const modified = Object.keys(tracked).filter((file) => current[file] !== undefined && current[file] !== tracked[file]);
  const missing = Object.keys(tracked).filter((file) => current[file] === undefined);
  const untracked = Object.keys(current).filter((file) => tracked[file] === undefined);

  return {
    installed: true,
    installDir,
    manifest,
    package: packageMeta,
    counts: {
      tracked: Object.keys(tracked).length,
      modified: modified.length,
      missing: missing.length,
      untracked: untracked.length,
    },
    modified,
    missing,
    untracked,
  };
}
