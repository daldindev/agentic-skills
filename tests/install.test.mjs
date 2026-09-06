import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { METADATA_DIR, init, inspect, loadManifest, status, sync, update } from "../src/install.mjs";
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

// A body long enough that two edits can sit far apart, or on top of each other.
const doc = (...body) => `---\nname: helper\n---\n\n${body.join("\n")}\n`;
const BODY = ["# helper", "", "## Setup", "", "step one", "step two", "step three", "", "## Notes", "", "read the docs"];
const at = (index, line) => BODY.map((value, i) => (i === index ? line : value));

/** Install BODY, let the caller move each side, then update with the base available. */
const threeWay = async (t, { yours, theirs }) => {
  const baseDir = await tmpDir(t);
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);

  await makeIncoming(baseDir, { extra: { "agent/helper.md": doc(...BODY) } });
  await init({ path: project, incomingDir: baseDir, upstream });
  await makeIncoming(incomingDir, { extra: { "agent/helper.md": doc(...theirs) } });
  await write(project, { ".agents/agent/helper.md": doc(...yours) });

  return { project, baseDir, incomingDir };
};

test("update merges an edit that never touched upstream's", async (t) => {
  const { project, baseDir, incomingDir } = await threeWay(t, {
    yours: at(4, "step ONE"),
    theirs: at(10, "read the manual"),
  });

  const result = await update({ path: project, incomingDir, baseDir });
  assert.deepEqual(result.plan.merge.map((item) => item.file), ["agent/helper.md"]);
  assert.deepEqual(result.plan.skip, [], "a merged file is no longer frozen");

  const merged = await read(project, ".agents/agent/helper.md");
  assert.equal(merged, doc(...at(4, "step ONE").map((line, i) => (i === 10 ? "read the manual" : line))));
  assert.match(merged, /step ONE/, "your line survived");
  assert.match(merged, /read the manual/, "upstream's line landed");
});

test("update refuses to merge when both sides wrote in the same place", async (t) => {
  const { project, baseDir, incomingDir } = await threeWay(t, {
    yours: at(5, "step TWO, mine"),
    theirs: at(5, "step two, theirs"),
  });
  const before = await read(project, ".agents/agent/helper.md");

  const result = await update({ path: project, incomingDir, baseDir });
  assert.deepEqual(result.plan.merge, []);
  assert.equal(result.plan.skip.length, 1);
  assert.match(result.plan.skip[0].reason, /overlap in one place/);
  assert.equal(await read(project, ".agents/agent/helper.md"), before, "the file was left exactly as it was");
});

test("update refuses to merge when both sides wrote on adjacent lines", async (t) => {
  const { project, baseDir, incomingDir } = await threeWay(t, {
    yours: at(4, "step ONE"),
    theirs: at(5, "step TWO"),
  });

  const result = await update({ path: project, incomingDir, baseDir });
  assert.deepEqual(result.plan.merge, [], "nothing separates the two edits, so neither is applied");
  assert.equal(result.plan.skip.length, 1);
});

test("update refuses to merge when the base is not provably what was installed", async (t) => {
  const { project, incomingDir } = await threeWay(t, {
    yours: at(4, "step ONE"),
    theirs: at(10, "read the manual"),
  });

  // A base tree that is not the one the manifest recorded.
  const wrongBase = await tmpDir(t);
  await makeIncoming(wrongBase, { extra: { "agent/helper.md": doc(...at(0, "# something else")) } });

  const result = await update({ path: project, incomingDir, baseDir: wrongBase });
  assert.deepEqual(result.plan.merge, []);
  assert.match(result.plan.skip[0].reason, /no proven common ancestor/);
  assert.match(await read(project, ".agents/agent/helper.md"), /step ONE/);
});

test("update refuses to merge a file the manifest does not track", async (t) => {
  const baseDir = await tmpDir(t);
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(baseDir);
  await makeIncoming(incomingDir);

  // Installed without a manifest entry for this file, so no ancestor is known.
  await init({ path: project, incomingDir: baseDir });
  await write(project, { ".agents/extra.md": "mine" });
  await write(baseDir, { "extra.md": "base" });
  await write(incomingDir, { "extra.md": "theirs" });

  const result = await update({ path: project, incomingDir, baseDir });
  assert.deepEqual(result.plan.merge, []);
  assert.equal(await read(project, ".agents/extra.md"), "mine");
});

test("without a base, update stays exactly as conservative as before", async (t) => {
  const { project, incomingDir } = await threeWay(t, {
    yours: at(4, "step ONE"),
    theirs: at(10, "read the manual"),
  });

  const result = await update({ path: project, incomingDir });
  assert.deepEqual(result.plan.merge, []);
  assert.equal(result.plan.skip.length, 1);
  assert.match(await read(project, ".agents/agent/helper.md"), /step ONE/);
});

test("a merge never drops a line you wrote, even where upstream rewrote around it", async (t) => {
  const { project, baseDir, incomingDir } = await threeWay(t, {
    yours: [...BODY.slice(0, 7), "", "## My conventions", "", "use pnpm"],
    theirs: at(2, "## Getting started"),
  });

  const result = await update({ path: project, incomingDir, baseDir });
  assert.equal(result.plan.merge.length, 1);

  const merged = await read(project, ".agents/agent/helper.md");
  assert.match(merged, /## My conventions/);
  assert.match(merged, /use pnpm/);
  assert.match(merged, /## Getting started/);
  assert.doesNotMatch(merged, /## Notes/, "upstream kept its heading change, yours replaced the tail");
});

test("a dry run reports the merge without writing it", async (t) => {
  const { project, baseDir, incomingDir } = await threeWay(t, {
    yours: at(4, "step ONE"),
    theirs: at(10, "read the manual"),
  });
  const before = await read(project, ".agents/agent/helper.md");

  const result = await update({ path: project, incomingDir, baseDir, dryRun: true });
  assert.equal(result.plan.merge.length, 1);
  assert.equal(await read(project, ".agents/agent/helper.md"), before);
});

test("--force takes upstream wholesale and merges nothing", async (t) => {
  const { project, baseDir, incomingDir } = await threeWay(t, {
    yours: at(4, "step ONE"),
    theirs: at(10, "read the manual"),
  });

  const result = await update({ path: project, incomingDir, baseDir, force: true });
  assert.deepEqual(result.plan.merge, [], "nothing reaches the merge step, because nothing was skipped");
  assert.deepEqual(result.plan.update, ["agent/helper.md"]);
  assert.doesNotMatch(await read(project, ".agents/agent/helper.md"), /step ONE/);
});

test("merging leaves the install ready to merge again next time", async (t) => {
  const { project, baseDir, incomingDir } = await threeWay(t, {
    yours: at(4, "step ONE"),
    theirs: at(10, "read the manual"),
  });
  await update({ path: project, incomingDir, baseDir, upstream });

  // Upstream moves again. The tree just merged from is now the recorded ancestor.
  const newer = await tmpDir(t);
  await makeIncoming(newer, { extra: { "agent/helper.md": doc(...at(10, "read the manual").map((line, i) => (i === 8 ? "## Remarks" : line))) } });

  const second = await update({ path: project, incomingDir: newer, baseDir: incomingDir });
  assert.deepEqual(second.plan.merge.map((item) => item.file), ["agent/helper.md"]);

  const merged = await read(project, ".agents/agent/helper.md");
  assert.match(merged, /step ONE/, "your edit survived a second merge");
  assert.match(merged, /## Remarks/);
  assert.match(merged, /read the manual/);
});

test("a file left frozen keeps the ancestor it actually descends from", async (t) => {
  const { project, incomingDir, baseDir } = await threeWay(t, {
    yours: at(5, "step TWO, mine"),
    theirs: at(5, "step two, theirs"),
  });
  const beforeHash = (await loadManifest(path.join(project, ".agents"))).files["agent/helper.md"];

  await update({ path: project, incomingDir, baseDir, upstream });
  const afterHash = (await loadManifest(path.join(project, ".agents"))).files["agent/helper.md"];

  assert.equal(afterHash, beforeHash, "nothing was written, so the recorded ancestor must not move");
});

test("a frozen file is never merged against an ancestor it does not descend from", async (t) => {
  const { project, baseDir, incomingDir } = await threeWay(t, {
    yours: at(4, "step ONE"),
    theirs: at(6, "step THREE"),
  });

  // Upstream's change is skipped without being applied, so it is not in the file.
  const held = await update({ path: project, incomingDir, upstream });
  assert.equal(held.plan.skip.length, 1);
  assert.doesNotMatch(await read(project, ".agents/agent/helper.md"), /step THREE/);

  // Upstream moves again. Offering the version that was skipped as the base must
  // not merge: the file never descended from it, and merging would read
  // upstream's earlier change as a deletion and quietly undo it.
  const newer = await tmpDir(t);
  await makeIncoming(newer, { extra: { "agent/helper.md": doc(...at(6, "step THREE").map((line, i) => (i === 10 ? "read the manual" : line))) } });

  const second = await update({ path: project, incomingDir: newer, baseDir: incomingDir, upstream });
  assert.deepEqual(second.plan.merge, [], "the offered base is not this file's ancestor");
  assert.match(second.plan.skip[0].reason, /no proven common ancestor/);

  const onDisk = await read(project, ".agents/agent/helper.md");
  assert.match(onDisk, /step ONE/);
  assert.doesNotMatch(onDisk, /read the manual/, "nothing was applied");

  // And the original base still merges, because that is what the file descends from.
  const third = await update({ path: project, incomingDir: newer, baseDir, upstream });
  assert.deepEqual(third.plan.merge.map((item) => item.file), ["agent/helper.md"]);
  assert.match(await read(project, ".agents/agent/helper.md"), /step THREE/, "upstream's earlier change finally lands");
});

test("a file gone from both sides stops being tracked", async (t) => {
  const baseDir = await tmpDir(t);
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(baseDir, { extra: { "workflows/retired.md": md("retired") } });
  await init({ path: project, incomingDir: baseDir });
  await makeIncoming(incomingDir);

  await fs.rm(path.join(project, ".agents/workflows/retired.md"));
  await update({ path: project, incomingDir, baseDir });

  const manifest = await loadManifest(path.join(project, ".agents"));
  assert.ok(!("workflows/retired.md" in manifest.files), "nothing on disk and nothing upstream to track");
  assert.deepEqual((await status({ path: project })).missing, [], "and it is not reported missing forever");
});

test("a file upstream removed is kept, never merged", async (t) => {
  const baseDir = await tmpDir(t);
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(baseDir, { extra: { "workflows/old.md": md("old") } });
  await init({ path: project, incomingDir: baseDir });
  await makeIncoming(incomingDir);
  await write(project, { ".agents/workflows/old.md": "my version" });

  const result = await update({ path: project, incomingDir, baseDir });
  assert.deepEqual(result.plan.merge, []);
  assert.deepEqual(result.plan.keep.map((item) => item.file), ["workflows/old.md"]);
  assert.equal(await read(project, ".agents/workflows/old.md"), "my version");
});

test("inspect separates your lines from upstream's when it has the base", async (t) => {
  const baseDir = await tmpDir(t);
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(baseDir);
  await init({ path: project, incomingDir: baseDir });
  await makeIncoming(incomingDir);

  // Both sides append a different section to the end of the same file.
  await write(project, { ".agents/agent/helper.md": `${md("helper")}\n## My conventions\n` });
  await write(incomingDir, { "agent/helper.md": `${md("helper")}\n## Troubleshooting\n` });

  const report = await inspect({ path: project, incomingDir, baseDir, upstream });
  assert.equal(report.comparedAgainstBase, true);
  assert.equal(report.frozen.length, 1);

  const [entry] = report.frozen;
  assert.equal(entry.file, "agent/helper.md");
  assert.equal(entry.collisions, 1);

  const [region] = entry.regions;
  assert.deepEqual(region.authors, ["upstream", "yours"]);
  assert.ok(region.yours.includes("## My conventions"));
  assert.ok(region.upstream.includes("## Troubleshooting"));
  assert.ok(!region.yours.includes("## Troubleshooting"), "your side must not carry upstream's text");
});

test("inspect counts a file frozen with no overlap as zero collisions", async (t) => {
  const baseDir = await tmpDir(t);
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(baseDir, { extra: { "agent/helper.md": md("helper", "line: one\nline: two\nline: three\nline: four\n") } });
  await init({ path: project, incomingDir: baseDir });
  await makeIncoming(incomingDir, { extra: { "agent/helper.md": md("helper", "line: one\nline: two\nline: three\nline: FOUR\n") } });

  await write(project, { ".agents/agent/helper.md": md("helper", "line: ONE\nline: two\nline: three\nline: four\n") });

  const [entry] = (await inspect({ path: project, incomingDir, baseDir })).frozen;
  assert.equal(entry.collisions, 0, "the two edits are four lines apart");
  assert.deepEqual(entry.regions.map((region) => region.authors.join("+")), ["yours", "upstream"]);
});

test("inspect reports no regions when it cannot read the base", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir);
  await init({ path: project, incomingDir });
  await write(project, { ".agents/agent/helper.md": "mine" });

  const report = await inspect({ path: project, incomingDir });
  assert.equal(report.comparedAgainstBase, false);
  assert.equal(report.frozen.length, 1);
  assert.equal(report.frozen[0].regions, null);
});

test("inspect reports nothing when no file is frozen", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir);
  await init({ path: project, incomingDir });
  await write(project, { ".agents/mine.md": "my own file" });

  const report = await inspect({ path: project, incomingDir });
  assert.deepEqual(report.frozen, []);
  assert.deepEqual(report.removedUpstream, []);
});

test("inspect lists files upstream removed that were edited locally", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir, { extra: { "workflows/old.md": md("old") } });
  await init({ path: project, incomingDir });

  await write(project, { ".agents/workflows/old.md": "my version" });
  await fs.rm(path.join(incomingDir, "workflows/old.md"));

  const report = await inspect({ path: project, incomingDir });
  assert.deepEqual(report.removedUpstream.map((item) => item.file), ["workflows/old.md"]);
  assert.deepEqual(report.frozen, []);
});

test("inspect errors when nothing is installed", async (t) => {
  const incomingDir = await tmpDir(t);
  const project = await tmpDir(t);
  await makeIncoming(incomingDir);

  await assert.rejects(inspect({ path: project, incomingDir }), /Run "agentic-skills init" first/);
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
