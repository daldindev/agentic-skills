#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { PACKAGE_ROOT, readJson } from "./fs-utils.mjs";
import { DEFAULT_INSTALL_DIR, init, inspect, status, sync, update } from "./install.mjs";
import { UPSTREAM, extractPort, loadArchive, materialize } from "./upstream.mjs";

const HELP = `agentic-skills - install the ag-kit agent roles, skills, and workflows into any project

Usage:
  agentic-skills init    [options]   Download ag-kit and install the content into <path>/<dir>
  agentic-skills update  [options]   Download ag-kit again and update installed files, preserving local edits
  agentic-skills sync    [options]   Install if missing, update if present; safe to run unattended
  agentic-skills status  [options]   Show what is installed and which files were changed locally
  agentic-skills diff    [path]      Show why your edits froze a file, and what they are holding back

Options:
  -p, --path <dir>        Project directory (default: current directory)
  -d, --dir <name>        Install directory inside the project (default: ${DEFAULT_INSTALL_DIR})
  -r, --ref <git-ref>     Upstream branch, tag, or commit to install (default: ${UPSTREAM.ref})
      --archive <source>  Install from a local ag-kit .tar.gz or a URL instead of GitHub
      --base-archive <s>  The version you installed from, as a local .tar.gz or URL, instead of
                          downloading the commit in the manifest. Used to tell your changes
                          from upstream's, by update, sync, and diff
  -f, --force             Overwrite locally modified files
      --no-merge          Never combine a local edit with an upstream change; leave every
                          edited file frozen, whether or not the two touch
      --dry-run           Download and show the plan without writing anything
      --json              Print machine-readable output
  -h, --help              Show this help
  -v, --version           Show the package version

Exit codes:
  0  success
  1  error
  2  completed, but some files were skipped because they were modified locally
`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    path: { type: "string", short: "p" },
    dir: { type: "string", short: "d" },
    ref: { type: "string", short: "r", default: UPSTREAM.ref },
    archive: { type: "string" },
    "base-archive": { type: "string" },
    force: { type: "boolean", short: "f", default: false },
    "no-merge": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false },
  },
});

const command = positionals[0];
const log = (message) => {
  if (!values.json) console.log(message);
};

const list = (label, items, format = (item) => item) => {
  if (!items.length) return;
  console.log(`\n${label} (${items.length}):`);
  for (const item of items) console.log(`  ${format(item)}`);
};

/** Download one upstream archive and lay the ported tree out in a temp dir. */
const fetchTree = async ({ ref = null, archive = null }) => {
  log(archive ? `Reading ${archive}` : `Downloading ${UPSTREAM.repository} at ${ref}`);
  const buffer = await loadArchive({ ref, archive });
  const port = extractPort(buffer);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-skills-"));
  try {
    await materialize(port.files, dir);
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
  for (const warning of port.warnings) console.error(`warning: ${warning}`);
  return {
    dir,
    upstream: {
      repository: UPSTREAM.repository,
      ref: archive ? null : ref,
      commit: port.commit,
      version: port.version,
    },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
};

/**
 * The version the install came from, so both sides of a local edit can be told
 * apart. Called only once something is actually frozen, and never fatal: without
 * it the run just stays as conservative as it was before.
 *
 * `--archive` means this run was asked not to reach for the network, so the base
 * has to come from `--base-archive` or not at all.
 */
let loadedBase = null;
const loadBase = async (manifest) => {
  const archive = values["base-archive"];
  if (!archive && values.archive) return null;

  const commit = manifest?.upstream?.commit;
  if (!archive && !commit) return null;

  try {
    loadedBase = await fetchTree(archive ? { archive } : { ref: commit });
    return loadedBase;
  } catch (error) {
    console.error(`warning: could not read the version you installed from: ${error.message}`);
    return null;
  }
};

const describeUpstream = (upstream) => {
  if (!upstream) return "unknown upstream";
  const commit = upstream.commit ? ` (${upstream.commit.slice(0, 7)})` : "";
  return `ag-kit ${upstream.version}${commit}`;
};

const printPlan = (result) => {
  const { plan } = result;
  const prefix = result.dryRun ? "[dry run] " : "";
  console.log(`${prefix}${result.mode}: ${result.installDir}`);
  console.log(`${prefix}source: ${describeUpstream(result.upstream)}`);
  console.log(
    `${prefix}added ${plan.add.length}, updated ${plan.update.length}, merged ${plan.merge.length}, ` +
    `removed ${plan.remove.length}, skipped ${plan.skip.length}, kept ${plan.keep.length}, ` +
    `unchanged ${plan.unchanged.length}`,
  );
  list("Merged (your change and upstream's did not touch)", plan.merge, (item) => item.file);
  list("Skipped (left frozen; use --force to overwrite)", plan.skip, (item) => `${item.file}: ${item.reason}`);
  list("Kept (removed upstream but modified locally)", plan.keep, (item) => `${item.file}: ${item.reason}`);
  if (result.hadManifest === false && plan.skip.length) {
    console.log("\nNo manifest was found, so files that differ from upstream were skipped. Re-run with --force to overwrite them.");
  }
  if (result.created && !result.dryRun) {
    console.log(`\nPoint your assistant at ${path.join(result.installDir, "ARCHITECTURE.md")} to get the inventory.`);
  }
};

const SIDE = { base: "base ", yours: "yours", upstream: "upstr" };
const REGION_LINES = 20;
const plural = (count, word) => `${count} ${count === 1 ? word : `${word}s`}`;

const authorPhrase = (authors) => {
  if (authors.length === 2) return "both sides wrote here";
  return authors[0] === "yours" ? "only you wrote here" : "only upstream wrote here";
};

/** One side of a region. A bare `|` is a blank line; no `|` means the side has nothing here. */
const printSide = (side, lines) => {
  if (!lines.length) {
    console.log(`      ${SIDE[side]}   nothing here`);
    return;
  }
  for (const line of lines.slice(0, REGION_LINES)) console.log(`      ${SIDE[side]} | ${line}`);
  const rest = lines.length - REGION_LINES;
  if (rest > 0) console.log(`      ${SIDE[side]}   ~ ${plural(rest, "more line")} ~`);
};

const printDiffFile = (report, entry) => {
  console.log(entry.file);
  console.log(`  installed ${describeUpstream(report.base)} -> upstream ${describeUpstream(report.upstream)}`);
  console.log(`  ${plural(entry.regions.length, "region")} changed, ${entry.collisions} written by both sides`);

  entry.regions.forEach((region, index) => {
    console.log(`\n  [${index + 1}] ${region.where.padEnd(38)} ${authorPhrase(region.authors)}`);
    printSide("base", region.base);
    printSide("yours", region.yours);
    printSide("upstream", region.upstream);
    if (region.authors.length === 2) {
      console.log("\n      note: no untouched line separates your lines from upstream's here,");
      console.log("            so neither side can be applied without deciding about the other.");
    }
  });

  console.log("\ndiff only reads - nothing was written.");
};

const printDiffSummary = (report) => {
  console.log(`diff:   ${report.installDir}`);
  console.log(`source: ${describeUpstream(report.upstream)}`);
  if (report.comparedAgainstBase) console.log(`base:   ${describeUpstream(report.base)}`);

  const entries = [...report.frozen, ...report.removedUpstream];
  if (!entries.length) {
    console.log("\nNothing is frozen: every installed file either matches upstream, tracks it cleanly, or is your own.");
    return;
  }

  const width = Math.max(...entries.map((entry) => entry.file.length));
  if (!report.comparedAgainstBase) {
    console.log(`\n${plural(entries.length, "frozen file")}, and no way to tell your changes from upstream's:`);
    console.log(report.hadManifest
      ? "the version this install came from could not be read. Pass --base-archive to supply it."
      : "this install has no manifest saying which version it came from.");
    for (const entry of entries) console.log(`  ${entry.file}`);
    return;
  }

  const blocked = report.frozen.filter((entry) => entry.collisions > 0).length;
  const byRule = report.frozen.length - blocked;
  const parts = [];
  if (blocked) parts.push(`${blocked} blocked by an overlap`);
  if (byRule) parts.push(`${byRule} frozen by the per-file rule alone`);
  if (report.removedUpstream.length) parts.push(`${report.removedUpstream.length} removed upstream`);

  console.log(`\n${plural(entries.length, "frozen file")}. ${parts.join(", ")}.`);
  console.log("diff only reads - nothing was written.\n");

  for (const entry of report.frozen) {
    const both = entry.collisions ? `${entry.collisions} written by both sides` : "none written by both sides";
    console.log(`  ${entry.file.padEnd(width)}  ${plural(entry.regions.length, "region")} changed, ${both}`);
  }
  for (const entry of report.removedUpstream) {
    console.log(`  ${entry.file.padEnd(width)}  removed upstream, kept because you edited it`);
  }
  console.log('\nRun "agentic-skills diff <path>" to see the three versions of one file.');
};

const printStatus = (info) => {
  console.log(`package:   ${info.package.packageName} ${info.package.packageVersion}`);
  console.log(`target:    ${info.installDir}`);
  if (!info.installed) {
    console.log('status:    not installed (run "agentic-skills init")');
    return;
  }
  if (!info.manifest) {
    console.log("status:    installed without a manifest (not managed by agentic-skills)");
  } else {
    console.log(`installed: ${describeUpstream(info.manifest.upstream)} on ${info.manifest.updatedAt}`);
  }
  const counts = info.counts;
  console.log(`files:     ${counts.tracked} tracked, ${counts.modified} modified, ${counts.missing} missing, ${counts.untracked} untracked`);
  console.log('run "agentic-skills update --dry-run" to see what a fresh download would change');
  list("Modified locally", info.modified);
  list("Missing", info.missing);
};

try {
  if (values.version) {
    const pkg = await readJson(path.join(PACKAGE_ROOT, "package.json"));
    console.log(pkg.version);
  } else if (values.help || !command || command === "help") {
    process.stdout.write(HELP);
  } else if (command === "init" || command === "update" || command === "sync") {
    const merging = !values.force && !values["no-merge"];
    const incoming = await fetchTree({ ref: values.ref, archive: values.archive });
    try {
      const options = {
        path: values.path,
        dir: values.dir,
        force: values.force,
        dryRun: values["dry-run"],
        incomingDir: incoming.dir,
        loadBase: merging ? loadBase : null,
        upstream: incoming.upstream,
      };
      const run = { init, update, sync }[command];
      const result = await run(options);
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else printPlan(result);
      if (result.plan.skip.length || result.plan.keep.length) process.exitCode = 2;
    } finally {
      await incoming.cleanup();
      if (loadedBase) await loadedBase.cleanup();
    }
  } else if (command === "diff") {
    const target = { path: values.path, dir: values.dir };
    const incoming = await fetchTree({ ref: values.ref, archive: values.archive });
    try {
      const report = await inspect({
        ...target,
        incomingDir: incoming.dir,
        loadBase,
        upstream: incoming.upstream,
      });

      const wanted = positionals[1]?.replaceAll("\\", "/");
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else if (!wanted) printDiffSummary(report);
      else {
        const entry = report.frozen.find((item) => item.file === wanted);
        if (entry?.regions) printDiffFile(report, entry);
        else if (entry) console.error(`${wanted} is frozen, but the version you installed from could not be read.`);
        else {
          console.error(`${wanted} is not frozen. Run "agentic-skills diff" to list the files that are.`);
          process.exitCode = 1;
        }
      }
    } finally {
      await incoming.cleanup();
      if (loadedBase) await loadedBase.cleanup();
    }
  } else if (command === "status") {
    const info = await status({ path: values.path, dir: values.dir });
    if (values.json) console.log(JSON.stringify(info, null, 2));
    else printStatus(info);
  } else {
    console.error(`Unknown command: ${command}\n`);
    process.stdout.write(HELP);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
