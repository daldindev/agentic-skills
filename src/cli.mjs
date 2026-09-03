#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { PACKAGE_ROOT, readJson } from "./fs-utils.mjs";
import { DEFAULT_INSTALL_DIR, init, status, update } from "./install.mjs";
import { UPSTREAM, extractPort, loadArchive, materialize } from "./upstream.mjs";

const HELP = `agentic-skills - install the ag-kit agent roles, skills, and workflows into any project

Usage:
  agentic-skills init    [options]   Download ag-kit and install the content into <path>/<dir>
  agentic-skills update  [options]   Download ag-kit again and update installed files, preserving local edits
  agentic-skills status  [options]   Show what is installed and which files were changed locally

Options:
  -p, --path <dir>        Project directory (default: current directory)
  -d, --dir <name>        Install directory inside the project (default: ${DEFAULT_INSTALL_DIR})
  -r, --ref <git-ref>     Upstream branch, tag, or commit to install (default: ${UPSTREAM.ref})
      --archive <source>  Install from a local ag-kit .tar.gz or a URL instead of GitHub
  -f, --force             Overwrite locally modified files
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
    force: { type: "boolean", short: "f", default: false },
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

/** Download the upstream archive and lay the ported tree out in a temp dir. */
const fetchIncoming = async () => {
  log(values.archive ? `Reading ${values.archive}` : `Downloading ${UPSTREAM.repository} at ${values.ref}`);
  const buffer = await loadArchive({ ref: values.ref, archive: values.archive });
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
      ref: values.archive ? null : values.ref,
      commit: port.commit,
      version: port.version,
    },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
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
    `${prefix}added ${plan.add.length}, updated ${plan.update.length}, removed ${plan.remove.length}, ` +
    `skipped ${plan.skip.length}, kept ${plan.keep.length}, unchanged ${plan.unchanged.length}`,
  );
  list("Skipped (modified locally; use --force to overwrite)", plan.skip, (item) => `${item.file}: ${item.reason}`);
  list("Kept (removed upstream but modified locally)", plan.keep, (item) => `${item.file}: ${item.reason}`);
  if (result.mode === "update" && result.hadManifest === false) {
    console.log("\nNo manifest was found, so files that differ from upstream were skipped. Re-run with --force to overwrite them.");
  }
  if (result.mode === "init" && !result.dryRun) {
    console.log(`\nPoint your assistant at ${path.join(result.installDir, "ARCHITECTURE.md")} to get the inventory.`);
  }
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
  } else if (command === "init" || command === "update") {
    const incoming = await fetchIncoming();
    try {
      const options = {
        path: values.path,
        dir: values.dir,
        force: values.force,
        dryRun: values["dry-run"],
        incomingDir: incoming.dir,
        upstream: incoming.upstream,
      };
      const result = command === "init" ? await init(options) : await update(options);
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else printPlan(result);
      if (result.plan.skip.length || result.plan.keep.length) process.exitCode = 2;
    } finally {
      await incoming.cleanup();
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
