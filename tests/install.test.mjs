import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { METADATA_DIR, init, loadManifest, status, sync, update } from "../src/install.mjs";
import { md, read, tmpDir, write } from "./helpers.mjs";

const upstream = { repository: "https://github.com/vudovn/ag-kit", ref: "main", commit: "a".repeat(40), version: "1" };

const makeIncoming = async (root, { alpha = "alpha v1", extra = {} } = {}) => {
  await write(root, {
    "ARCHITECTURE.md": "# Arch\n",
    LICENSE: "MIT License\n",
    "agent/helper.md": md("helper"),
    "skills/alpha/SKILL.md": md("alpha") + alpha,
    "workflows/go.md": md("go"),
    ...extra,
  });
};

test("init installs the incoming tree and records a manifest with upstream provenance", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir);

  const result = await init({ path: project, incomingDir, upstream });
  assert.equal(result.created, true);
  assert.equal(result.plan.add.length, 5);
  assert.equal(await read(project, ".agents/agent/helper.md"), md("helper"));

  const manifest = await loadManifest(path.join(project, ".agents"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(Object.keys(manifest.files).length, 5);
  assert.deepEqual(manifest.upstream, upstream);
  assert.ok(manifest.packageVersion);
});

test("init refuses a non-empty target unless forced", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir);
  await write(project, { ".agents/custom.md": "mine" });

  await assert.rejects(init({ path: project, incomingDir }), /already exists/);

  const result = await init({ path: project, incomingDir, force: true });
  assert.equal(result.created, false, "forcing over an existing tree creates nothing");
  assert.equal(result.plan.add.length, 5);
  assert.equal(await read(project, ".agents/custom.md"), "mine");
});

test("init honours a custom directory and a dry run", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir);

  const dry = await init({ path: project, incomingDir, dir: "ai", dryRun: true });
  assert.equal(dry.dryRun, true);
  await assert.rejects(fs.access(path.join(project, "ai")));

  await init({ path: project, incomingDir, dir: "ai" });
  await fs.access(path.join(project, "ai", "workflows", "go.md"));
});

test("update applies upstream changes, preserves local edits, and drops stale files", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir, { extra: { "workflows/old.md": md("old") } });
  await init({ path: project, incomingDir });

  await write(project, {
    ".agents/skills/alpha/SKILL.md": "my local version",
    ".agents/skills/mine/SKILL.md": md("mine"),
  });

  await fs.rm(path.join(incomingDir, "workflows/old.md"));
  await makeIncoming(incomingDir, {
    alpha: "alpha v2",
    extra: { "agent/helper.md": md("helper", "version: 2.0.0\n"), "skills/beta/SKILL.md": md("beta") },
  });

  const dry = await update({ path: project, incomingDir, dryRun: true });
  assert.deepEqual(dry.plan.add, ["skills/beta/SKILL.md"]);
  assert.deepEqual(dry.plan.update, ["agent/helper.md"]);
  assert.deepEqual(dry.plan.remove, ["workflows/old.md"]);
  assert.deepEqual(dry.plan.skip.map((item) => item.file), ["skills/alpha/SKILL.md"]);
  assert.equal(await read(project, ".agents/skills/alpha/SKILL.md"), "my local version");

  await update({ path: project, incomingDir, upstream: { ...upstream, version: "2" } });
  assert.equal(await read(project, ".agents/skills/alpha/SKILL.md"), "my local version");
  assert.equal(await read(project, ".agents/agent/helper.md"), md("helper", "version: 2.0.0\n"));
  assert.equal(await read(project, ".agents/skills/mine/SKILL.md"), md("mine"));
  await assert.rejects(fs.access(path.join(project, ".agents/workflows/old.md")));
  assert.equal((await loadManifest(path.join(project, ".agents"))).upstream.version, "2");

  const forced = await update({ path: project, incomingDir, force: true });
  assert.deepEqual(forced.plan.update, ["skills/alpha/SKILL.md"]);
  assert.match(await read(project, ".agents/skills/alpha/SKILL.md"), /alpha v2/);
});

test("update without a manifest only adds new files unless forced", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir);
  await write(project, { ".agents/agent/helper.md": "legacy content" });

  const result = await update({ path: project, incomingDir });
  assert.equal(result.hadManifest, false);
  assert.equal(result.plan.skip.length, 1);
  assert.equal(result.plan.add.length, 4);
  assert.equal(await read(project, ".agents/agent/helper.md"), "legacy content");
  assert.ok(await loadManifest(path.join(project, ".agents")));
});

test("update into an empty directory reports a first install", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir);
  await fs.mkdir(path.join(project, ".agents"));

  const result = await update({ path: project, incomingDir });
  assert.equal(result.created, true, "an empty directory holds no install yet");
  assert.equal(result.plan.add.length, 5);
});

test("update errors when nothing is installed", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir);

  await assert.rejects(update({ path: project, incomingDir }), /Run "agentic-skills init" first/);
});

test("sync installs when nothing is there and updates when something is", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir);

  const fresh = await sync({ path: project, incomingDir, upstream });
  assert.equal(fresh.created, true);
  assert.equal(fresh.plan.add.length, 5);
  assert.ok(await loadManifest(path.join(project, ".agents")));

  await makeIncoming(incomingDir, { alpha: "alpha v2" });
  const again = await sync({ path: project, incomingDir, upstream });
  assert.equal(again.created, false);
  assert.deepEqual(again.plan.update, ["skills/alpha/SKILL.md"]);
  assert.match(await read(project, ".agents/skills/alpha/SKILL.md"), /alpha v2/);
});

test("sync preserves local edits unless forced", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir);
  await sync({ path: project, incomingDir });

  await write(project, { ".agents/agent/helper.md": "my helper", ".agents/mine.md": "mine" });
  await makeIncoming(incomingDir, { alpha: "alpha v2" });

  const kept = await sync({ path: project, incomingDir });
  assert.deepEqual(kept.plan.skip.map((item) => item.file), ["agent/helper.md"]);
  assert.equal(await read(project, ".agents/agent/helper.md"), "my helper");

  const forced = await sync({ path: project, incomingDir, force: true });
  assert.equal(forced.plan.skip.length, 0);
  assert.equal(await read(project, ".agents/agent/helper.md"), md("helper"));
  assert.equal(await read(project, ".agents/mine.md"), "mine");
});

test("sync adopts a tree it did not install without clobbering it", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir);
  await write(project, { ".agents/agent/helper.md": "legacy content" });

  const result = await sync({ path: project, incomingDir });
  assert.equal(result.created, false);
  assert.equal(result.hadManifest, false);
  assert.equal(result.plan.skip.length, 1);
  assert.equal(await read(project, ".agents/agent/helper.md"), "legacy content");
});

test("status reports local state without fetching", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir);

  const before = await status({ path: project });
  assert.equal(before.installed, false);

  await init({ path: project, incomingDir, upstream });
  await write(project, { ".agents/agent/helper.md": "edited", ".agents/extra.md": "x" });
  await fs.rm(path.join(project, ".agents/workflows/go.md"));

  const after = await status({ path: project });
  assert.equal(after.installed, true);
  assert.deepEqual(after.counts, { tracked: 5, modified: 1, missing: 1, untracked: 1 });
  assert.equal(after.manifest.upstream.commit, upstream.commit);
  assert.ok(!after.untracked.includes(`${METADATA_DIR}/manifest.json`));
});
