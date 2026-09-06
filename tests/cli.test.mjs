import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { COMMIT, buildArchive, md, tmpDir, upstreamFiles } from "./helpers.mjs";

const run = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(packageRoot, "src", "cli.mjs");
const exec = (args) => run(process.execPath, [cli, ...args]).catch((error) => error);

const writeArchive = async (dir, options) => {
  const file = path.join(dir, `ag-kit-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`);
  await fs.writeFile(file, buildArchive(upstreamFiles(options)));
  return file;
};

test("--version prints the package version", async () => {
  const { stdout } = await exec(["--version"]);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("no arguments prints help", async () => {
  const { stdout } = await exec([]);
  assert.match(stdout, /Usage:/);
});

test("an unknown command exits 1", async () => {
  const result = await exec(["frobnicate"]);
  assert.equal(result.code, 1);
});

test("a missing archive is reported as an error", async (t) => {
  const project = await tmpDir(t);
  const result = await exec(["init", "--path", project, "--archive", path.join(project, "missing.tar.gz")]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Error: /);
});

test("init, status, and update run end to end from an archive", async (t) => {
  const project = await tmpDir(t);
  const archive = await writeArchive(project);

  const installed = await exec(["init", "--path", project, "--archive", archive]);
  assert.equal(installed.code ?? 0, 0, installed.stderr);
  assert.match(installed.stdout, /source: ag-kit 2026\.1\.1 \(0123456\)/);
  assert.match(installed.stdout, /added 6/);
  assert.match(installed.stdout, /ARCHITECTURE\.md/);
  await fs.access(path.join(project, ".agents", "agent", "helper.md"));
  await assert.rejects(fs.access(path.join(project, ".agents", "rules")));

  const reported = await exec(["status", "--path", project, "--json"]);
  const info = JSON.parse(reported.stdout);
  assert.equal(info.installed, true);
  assert.equal(info.counts.tracked, 6);
  assert.equal(info.manifest.upstream.commit, COMMIT);
  assert.equal(info.manifest.upstream.ref, null);

  const newer = await writeArchive(project, { version: "2026.2.2", skillBody: "alpha v2" });
  const dry = await exec(["update", "--path", project, "--archive", newer, "--dry-run"]);
  assert.match(dry.stdout, /\[dry run\] added 0, updated 2/);
  assert.match(await fs.readFile(path.join(project, ".agents", "skills", "alpha", "SKILL.md"), "utf8"), /alpha v1/);

  const updated = await exec(["update", "--path", project, "--archive", newer]);
  assert.equal(updated.code ?? 0, 0, updated.stderr);
  assert.match(await fs.readFile(path.join(project, ".agents", "skills", "alpha", "SKILL.md"), "utf8"), /alpha v2/);

  const again = await exec(["init", "--path", project, "--archive", newer]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists/);
});

test("update exits 2 and lists files it skipped because they were modified locally", async (t) => {
  const project = await tmpDir(t);
  const archive = await writeArchive(project);
  await exec(["init", "--path", project, "--archive", archive]);
  await fs.writeFile(path.join(project, ".agents", "workflows", "go.md"), md("go", "local: yes\n"));

  const newer = await writeArchive(project, { skillBody: "alpha v2" });
  const result = await exec(["update", "--path", project, "--archive", newer]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /Skipped .*\(1\)/);
  assert.match(result.stdout, /workflows\/go\.md: modified locally/);
});

test("sync is idempotent across a missing and an existing install", async (t) => {
  const project = await tmpDir(t);
  const archive = await writeArchive(project);

  const first = await exec(["sync", "--path", project, "--archive", archive]);
  assert.equal(first.code ?? 0, 0, first.stderr);
  assert.match(first.stdout, /^sync: /m);
  assert.match(first.stdout, /added 6/);
  assert.match(first.stdout, /ARCHITECTURE\.md/);

  const newer = await writeArchive(project, { version: "2026.2.2", skillBody: "alpha v2" });
  const second = await exec(["sync", "--path", project, "--archive", newer]);
  assert.equal(second.code ?? 0, 0, second.stderr);
  assert.match(second.stdout, /added 0, updated 2/);
  assert.doesNotMatch(second.stdout, /ARCHITECTURE\.md to get the inventory/);
  assert.match(await fs.readFile(path.join(project, ".agents", "skills", "alpha", "SKILL.md"), "utf8"), /alpha v2/);
});

test("sync --force overwrites local edits instead of exiting 2", async (t) => {
  const project = await tmpDir(t);
  const archive = await writeArchive(project);
  await exec(["sync", "--path", project, "--archive", archive]);
  await fs.writeFile(path.join(project, ".agents", "workflows", "go.md"), md("go", "local: yes\n"));

  const newer = await writeArchive(project, { skillBody: "alpha v2" });
  const skipped = await exec(["sync", "--path", project, "--archive", newer]);
  assert.equal(skipped.code, 2);

  const forced = await exec(["sync", "--path", project, "--archive", newer, "--force"]);
  assert.equal(forced.code ?? 0, 0, forced.stderr);
  assert.equal(await fs.readFile(path.join(project, ".agents", "workflows", "go.md"), "utf8"), md("go"));
});

const MERGE_BODY = "alpha v1\n\n## Setup\n\nstep one\nstep two\nstep three\n\n## Notes\n\nread the docs\n";

test("update merges an edit upstream stayed away from, and exits 0", async (t) => {
  const project = await tmpDir(t);
  const base = await writeArchive(project, { skillBody: MERGE_BODY });
  await exec(["init", "--path", project, "--archive", base]);

  const skill = path.join(project, ".agents", "skills", "alpha", "SKILL.md");
  await fs.writeFile(skill, (await fs.readFile(skill, "utf8")).replace("step one", "step ONE"));

  const newer = await writeArchive(project, { skillBody: MERGE_BODY.replace("read the docs", "read the manual") });
  const result = await exec(["update", "--path", project, "--archive", newer, "--base-archive", base]);

  assert.equal(result.code ?? 0, 0, "a merged file is not a skipped file");
  assert.match(result.stdout, /merged 1/);
  assert.match(result.stdout, /Merged \(your change and upstream's did not touch\) \(1\):/);

  const merged = await fs.readFile(skill, "utf8");
  assert.match(merged, /step ONE/, "your edit survived");
  assert.match(merged, /read the manual/, "upstream's edit landed");
});

test("--archive never reaches for the network, even with a file to merge", async (t) => {
  const project = await tmpDir(t);
  const base = await writeArchive(project, { skillBody: MERGE_BODY });
  await exec(["init", "--path", project, "--archive", base]);

  const skill = path.join(project, ".agents", "skills", "alpha", "SKILL.md");
  await fs.writeFile(skill, (await fs.readFile(skill, "utf8")).replace("step one", "step ONE"));

  const newer = await writeArchive(project, { skillBody: MERGE_BODY.replace("read the docs", "read the manual") });
  const result = await exec(["update", "--path", project, "--archive", newer]);

  assert.doesNotMatch(result.stdout, /Downloading/, "--archive means this run was told not to use the network");
  assert.equal(result.stderr, "", "and so it has nothing to warn about");
  assert.match(result.stdout, /merged 0/, "without a base there is nothing to merge against");

  // The same run merges once the base is supplied from disk.
  const withBase = await exec(["update", "--path", project, "--archive", newer, "--base-archive", base]);
  assert.doesNotMatch(withBase.stdout, /Downloading/);
  assert.match(withBase.stdout, /merged 1/);
});

test("--no-merge leaves an edited file frozen even when it would merge cleanly", async (t) => {
  const project = await tmpDir(t);
  const base = await writeArchive(project, { skillBody: MERGE_BODY });
  await exec(["init", "--path", project, "--archive", base]);

  const skill = path.join(project, ".agents", "skills", "alpha", "SKILL.md");
  await fs.writeFile(skill, (await fs.readFile(skill, "utf8")).replace("step one", "step ONE"));
  const before = await fs.readFile(skill, "utf8");

  const newer = await writeArchive(project, { skillBody: MERGE_BODY.replace("read the docs", "read the manual") });
  const args = ["--path", project, "--archive", newer, "--base-archive", base];

  const result = await exec(["update", ...args, "--no-merge"]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /merged 0/);
  assert.equal(await fs.readFile(skill, "utf8"), before);

  // The same run without the flag does merge, so the flag is what held it back.
  const merged = await exec(["update", ...args]);
  assert.equal(merged.code ?? 0, 0, merged.stderr);
  assert.match(await fs.readFile(skill, "utf8"), /read the manual/);
});

test("update leaves a file frozen when the two edits overlap, and still exits 2", async (t) => {
  const project = await tmpDir(t);
  const base = await writeArchive(project, { skillBody: MERGE_BODY });
  await exec(["init", "--path", project, "--archive", base]);

  const skill = path.join(project, ".agents", "skills", "alpha", "SKILL.md");
  await fs.writeFile(skill, (await fs.readFile(skill, "utf8")).replace("step two", "step TWO, mine"));
  const before = await fs.readFile(skill, "utf8");

  const newer = await writeArchive(project, { skillBody: MERGE_BODY.replace("step two", "step two, theirs") });
  const result = await exec(["update", "--path", project, "--archive", newer, "--base-archive", base]);

  assert.equal(result.code, 2);
  assert.match(result.stdout, /merged 0/);
  assert.match(result.stdout, /overlap in one place/);
  assert.equal(await fs.readFile(skill, "utf8"), before, "the file was not touched");
});

test("diff summarises the frozen files and classifies why each is stuck", async (t) => {
  const project = await tmpDir(t);
  const base = await writeArchive(project);
  await exec(["init", "--path", project, "--archive", base]);

  const skill = path.join(project, ".agents", "skills", "alpha", "SKILL.md");
  await fs.writeFile(skill, `${await fs.readFile(skill, "utf8")}\n## My conventions\n`);

  const newer = await writeArchive(project, { skillBody: "alpha v1\n\n## Troubleshooting\n" });
  const result = await exec(["diff", "--path", project, "--archive", newer, "--base-archive", base]);

  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.match(result.stdout, /^1 frozen file\. 1 blocked by an overlap\.$/m);
  assert.match(result.stdout, /skills\/alpha\/SKILL\.md\s+1 region changed, 1 written by both sides/);
  assert.match(result.stdout, /diff only reads - nothing was written/);
  assert.doesNotMatch(result.stdout, /## Troubleshooting/, "the summary lists files, not their contents");
});

test("diff on one path names who wrote each side", async (t) => {
  const project = await tmpDir(t);
  const base = await writeArchive(project);
  await exec(["init", "--path", project, "--archive", base]);

  const skill = path.join(project, ".agents", "skills", "alpha", "SKILL.md");
  await fs.writeFile(skill, `${await fs.readFile(skill, "utf8")}\n## My conventions\n`);

  const newer = await writeArchive(project, { skillBody: "alpha v1\n\n## Troubleshooting\n" });
  const args = ["--path", project, "--archive", newer, "--base-archive", base];
  const result = await exec(["diff", "skills/alpha/SKILL.md", ...args]);

  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.match(result.stdout, /both sides wrote here/);
  assert.match(result.stdout, /^\s+yours \| ## My conventions$/m);
  assert.match(result.stdout, /^\s+upstr \| ## Troubleshooting$/m);
  assert.doesNotMatch(result.stdout, /^\s+yours \| ## Troubleshooting$/m);

  const asJson = await exec(["diff", "--json", ...args]);
  const report = JSON.parse(asJson.stdout);
  assert.equal(report.comparedAgainstBase, true);
  assert.deepEqual(report.frozen[0].regions[0].authors, ["upstream", "yours"]);

  const missing = await exec(["diff", "agent/helper.md", ...args]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /is not frozen/);
});

test("diff says so when it cannot read the version you installed from", async (t) => {
  const project = await tmpDir(t);
  const base = await writeArchive(project);
  await exec(["init", "--path", project, "--archive", base]);
  await fs.writeFile(path.join(project, ".agents", "workflows", "go.md"), md("go", "local: yes\n"));

  const newer = await writeArchive(project, { skillBody: "alpha v2" });
  const result = await exec(["diff", "--path", project, "--archive", newer, "--base-archive", path.join(project, "gone.tar.gz")]);

  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.match(result.stderr, /warning: could not read the version you installed from/);
  assert.match(result.stdout, /no way to tell your changes from upstream's/);
  assert.match(result.stdout, /workflows\/go\.md/);
});

test("diff says so when nothing is frozen, and leaves the install alone", async (t) => {
  const project = await tmpDir(t);
  const archive = await writeArchive(project);
  await exec(["init", "--path", project, "--archive", archive]);

  const newer = await writeArchive(project, { skillBody: "alpha v2" });
  const result = await exec(["diff", "--path", project, "--archive", newer]);

  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.match(result.stdout, /Nothing is frozen/);
  assert.match(await fs.readFile(path.join(project, ".agents", "skills", "alpha", "SKILL.md"), "utf8"), /alpha v1/);
});

test("an upstream layout change surfaces as a warning, not a failure", async (t) => {
  const project = await tmpDir(t);
  const files = upstreamFiles();
  files[".agents/ARCHITECTURE.md"] = files[".agents/ARCHITECTURE.md"].replace("## 🔄 Workflows (1)", "## 🔄 Commands (1)");
  const archive = path.join(project, "ag-kit.tar.gz");
  await fs.writeFile(archive, buildArchive(files));

  const result = await exec(["init", "--path", project, "--archive", archive]);
  assert.equal(result.code ?? 0, 0, result.stderr);
  assert.match(result.stderr, /warning: .*installed verbatim/);
});
