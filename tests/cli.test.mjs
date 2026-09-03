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
