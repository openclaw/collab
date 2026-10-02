import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import { DocumentStore } from "../src/store.js";
import { createHandlers } from "../src/service.js";
import { createMarkdown } from "../src/workspace.js";
import { WELCOME } from "../src/model.js";
const human = {
  source: "session-action",
  action: { sessionKey: "session-one", client: { scopes: ["operator.write"] } },
} as FeatureInvocationContext;
const agent = { source: "tool", tool: { sessionKey: "session-one" } } as FeatureInvocationContext;
async function fixture(t: any) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "collab-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DocumentStore(directory);
  return { store, handlers: createHandlers(store, () => {}), directory };
}
test("agent proposes and replies, only a human accepts; accepted text survives reload", async (t) => {
  const { handlers: h, directory } = await fixture(t);
  let d = await h.create({ title: "Draft", markdown: "# Draft\n\nWe write many words." }, agent);
  d = await h.comment(
    {
      body: "Shorten this",
      anchor: { quote: "We write many words.", prefix: "", suffix: "" },
      revision: d.revision,
    },
    human,
  );
  const commentId = d.comments[0].id;
  d = await h.reply({ commentId, body: "Here is a shorter option." }, agent);
  d = await h.propose(
    {
      before: "We write many words.",
      after: "We write.",
      reason: "More concise.",
      revision: d.revision,
      commentId,
    },
    agent,
  );
  assert.match(d.markdown, /many words/);
  assert.equal(d.comments[0].replies[0].author, "agent");
  const input = { proposalId: d.proposals[0].id, accept: true, revision: d.revision };
  await assert.rejects(async () => h.review(input, agent), /human editor/);
  await assert.rejects(
    async () => h.save({ title: "x", markdown: "x", revision: d.revision, anchors: [] }, agent),
    /human editor/,
  );
  d = await h.review(input, human);
  assert.equal(d.markdown, "# Draft\n\nWe write.");
  assert.equal((await new DocumentStore(directory).read("session-one")).markdown, d.markdown);
  await assert.rejects(
    async () => h.review({ ...input, revision: d.revision }, human),
    /already been reviewed/,
  );
  await assert.rejects(
    async () => h.create({ title: "Overwrite", markdown: "NO" }, agent),
    /already in use/,
  );
});
test("simultaneous saves use CAS without losing comments; failed mutations leave valid state", async (t) => {
  const { handlers: h, store } = await fixture(t);
  const d = await h.read({}, human);
  const results = await Promise.allSettled(
    ["A", "B"].map((markdown) =>
      h.save({ title: "Draft", markdown, revision: d.revision, anchors: [] }, human),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await store.read("session-one")).revision, 1);
  await assert.rejects(
    async () => h.propose({ before: "missing", after: "no", reason: "no", revision: 1 }, agent),
    /passage has changed/,
  );
  await h.reply({ commentId: "absent", body: "no" }, agent).catch(() => {});
  assert.equal((await h.read({}, human)).revision, 1);
});
test("stale suggestions cannot replace changed text; unrelated edits can rebase", async (t) => {
  const { handlers: h } = await fixture(t);
  let d = await h.create({ title: "Test", markdown: "One.\n\nTwo." }, agent);
  d = await h.propose(
    { before: "One.", after: "First.", reason: "Improve.", revision: d.revision },
    agent,
  );
  d = await h.save(
    { title: d.title, markdown: "One.\n\nTwo updated.", revision: d.revision, anchors: [] },
    human,
  );
  d = await h.review({ proposalId: d.proposals[0].id, accept: true, revision: d.revision }, human);
  assert.equal(d.markdown, "First.\n\nTwo updated.");
  d = await h.propose(
    { before: "First.", after: "1.", reason: "Shorter.", revision: d.revision },
    agent,
  );
  d = await h.save(
    { title: d.title, markdown: "Changed.", revision: d.revision, anchors: [] },
    human,
  );
  await assert.rejects(
    async () =>
      h.review({ proposalId: d.proposals[1].id, accept: true, revision: d.revision }, human),
    /passage has changed/,
  );
  assert.equal((await h.read({}, human)).proposals[1].status, "pending");
});
test("ambiguous replacements, cross-session state, and read-only actions", async (t) => {
  const { handlers: h, store } = await fixture(t);
  const d = await h.create({ title: "Test", markdown: "same same" }, agent);
  await assert.rejects(
    async () =>
      h.propose({ before: "same", after: "different", reason: "x", revision: d.revision }, agent),
    /more than once/,
  );
  const readonly = {
    source: "session-action",
    action: { sessionKey: "session-one", client: { scopes: ["operator.read"] } },
  } as FeatureInvocationContext;
  await assert.rejects(
    async () => h.review({ proposalId: "x", accept: true, revision: d.revision }, readonly),
    /human editor/,
  );
  assert.equal((await store.read("../../other-session")).revision, 0);
  assert.equal((await h.read({}, human)).markdown, "same same");
});

test("transport-size limits reject before publication and preserve the readable document", async (t) => {
  const { handlers: h, store } = await fixture(t);
  const d = await h.create({ title: "Valid", markdown: "Keep this." }, agent);
  await assert.rejects(
    async () =>
      h.save(
        { title: d.title, markdown: "x".repeat(60001), revision: d.revision, anchors: [] },
        human,
      ),
    /60,000/,
  );
  await assert.rejects(
    () =>
      store.mutate("session-one", (doc) => {
        for (let i = 0; i < 100; i++)
          doc.proposals.push({
            id: String(i),
            before: "a".repeat(2000),
            after: "b".repeat(2000),
            reason: "Review",
            baseRevision: 1,
            status: "pending",
            createdAt: "",
          });
      }),
    /size limit/,
  );
  const after = await h.read({}, human);
  assert.equal(after.markdown, "Keep this.");
  assert.equal(after.proposals.length, 0);
  assert.equal(after.revision, d.revision);
});

test("workspace documents round-trip, retain separate comments, and reject stale cross-file saves", async (t) => {
  const { writeFile, readFile, mkdir } = await import("node:fs/promises");
  const { directory, store } = await fixture(t);
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "first.md"), "# First\n\nKeep this paragraph.\n");
  await writeFile(path.join(workspace, "second.md"), "# Second\n\nDifferent text.\n");
  const h = createHandlers(store, () => {}, { workspace: () => workspace });
  await h.create({ title: "Session draft", markdown: "Preserve my original draft." }, agent);
  assert.equal((await h.files({}, human)).files.length, 2);
  let first = await h.open({ path: "first.md" }, agent);
  assert.equal(first.filePath, path.join(workspace, "first.md"));
  assert.equal(await readFile(first.filePath!, "utf8"), first.markdown);
  first = await h.comment(
    {
      body: "Shorter?",
      anchor: { quote: "Keep this paragraph.", prefix: "", suffix: "" },
      revision: first.revision,
    },
    human,
  );
  first = await h.propose(
    {
      before: "Keep this paragraph.",
      after: "Keep this.",
      reason: "Shorter",
      revision: first.revision,
    },
    agent,
  );
  assert.match(await readFile(first.filePath!, "utf8"), /this paragraph/);
  first = await h.review(
    { proposalId: first.proposals[0].id, accept: true, revision: first.revision },
    human,
  );
  assert.match(await readFile(first.filePath!, "utf8"), /Keep this\./);
  const second = await h.open({ path: "second.md" }, agent);
  assert.equal(second.comments.length, 0);
  await assert.rejects(
    () =>
      h.save({ title: "Wrong", markdown: "wrong", revision: first.revision, anchors: [] }, human),
    /changed in another view/,
  );
  first = await h.open({ path: "first.md" }, human);
  assert.equal(first.comments.length, 1);
  assert.equal(first.proposals[0].status, "accepted");
  assert.ok(first.revision > second.revision);
  assert.equal((await new DocumentStore(directory).read("session-one")).filePath, first.filePath);
  const draft = await h.draft({}, human);
  assert.equal(draft.filePath, undefined);
  assert.equal(draft.markdown, "Preserve my original draft.");
});

test("external file changes are preserved, read refreshes them, and paths stay inside workspace", async (t) => {
  const { writeFile, readFile, mkdir, symlink } = await import("node:fs/promises");
  const { directory, store } = await fixture(t);
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const file = path.join(workspace, "draft.md");
  await writeFile(file, "Original");
  const h = createHandlers(store, () => {}, { workspace: () => workspace });
  const d = await h.open({ path: "draft.md" }, human);
  await writeFile(file, "External changes");
  await assert.rejects(
    () =>
      h.save(
        { title: d.title, markdown: "stale overwrite", revision: d.revision, anchors: [] },
        human,
      ),
    /changed outside Collab/,
  );
  assert.equal(await readFile(file, "utf8"), "External changes");
  const refreshed = await h.read({}, agent);
  assert.equal(refreshed.markdown, "External changes");
  assert.ok(refreshed.revision > d.revision);
  await assert.rejects(() => h.open({ path: "../secret.md" }, human), /inside this session/);
  await writeFile(path.join(directory, "secret.md"), "private");
  await symlink(path.join(directory, "secret.md"), path.join(workspace, "alias.md"));
  await assert.rejects(() => h.open({ path: "alias.md" }, agent), /symbolic link/);
  assert.equal((await h.files({}, human)).files.length, 1);
});

test("Save as moves the draft and its complete review history to a new file", async (t) => {
  const { mkdir, writeFile, readFile, realpath } = await import("node:fs/promises");
  const { directory, store } = await fixture(t);
  const workspace = path.join(await realpath(directory), "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "other.md"), "Other document");
  const h = createHandlers(store, () => {}, { workspace: () => workspace });
  const markdown = "---\ntitle: Keep metadata\n---\n\n# Draft\n\nWe write many words.\n";
  let d = await h.create({ title: "A session draft", markdown }, agent);
  d = await h.comment(
    {
      body: "Shorten this",
      anchor: { quote: "We write many words.", prefix: "", suffix: "" },
      revision: d.revision,
    },
    human,
  );
  d = await h.reply({ commentId: d.comments[0].id, body: "Here is a suggestion." }, agent);
  d = await h.propose(
    {
      before: "We write many words.",
      after: "We write.",
      reason: "Shorter",
      revision: d.revision,
      commentId: d.comments[0].id,
    },
    agent,
  );
  // A previous trip to a file left an archived copy of this draft.
  await h.open({ path: "other.md" }, human);
  d = await h.draft({}, human);
  const request = { path: "notes/new-draft.md", revision: d.revision };
  const saved = await h.save_as(request, human);
  assert.equal(saved.filePath, path.join(workspace, request.path));
  assert.equal(saved.title, "new-draft.md");
  assert.equal(await readFile(saved.filePath!, "utf8"), markdown);
  assert.deepEqual(saved.comments, d.comments);
  assert.deepEqual(saved.proposals, d.proposals);
  assert.equal(saved.proposals[0].status, "pending");
  assert.equal((await new DocumentStore(directory).read("session-one")).filePath, saved.filePath);
  // Replay after a lost response does not duplicate or reset the document.
  const retried = await h.save_as(request, human);
  assert.equal(retried.revision, saved.revision);
  assert.deepEqual(retried.comments, saved.comments);
  await assert.rejects(
    () => h.save({ title: d.title, markdown: "Stale", revision: d.revision, anchors: [] }, human),
    /changed in another view/,
  );
  const accepted = await h.review(
    { proposalId: saved.proposals[0].id, accept: true, revision: saved.revision },
    human,
  );
  assert.match(await readFile(saved.filePath!, "utf8"), /We write\./);
  const edited = await h.save(
    {
      title: accepted.title,
      markdown: accepted.markdown + "\nMore text.",
      revision: accepted.revision,
      anchors: [],
    },
    human,
  );
  assert.equal(await readFile(saved.filePath!, "utf8"), edited.markdown);
  assert.equal((await h.save_as(request, human)).markdown, edited.markdown);
  const fresh = await h.draft({}, human);
  assert.equal(fresh.markdown, WELCOME);
  assert.equal(fresh.comments.length, 0);
  assert.equal(fresh.savedFromDraftRevision, undefined);
  const reopened = await h.open({ path: request.path }, human);
  assert.deepEqual(reopened.comments, edited.comments);
  assert.deepEqual(reopened.proposals, edited.proposals);
  assert.equal(reopened.markdown, edited.markdown);
});

test("Save as rejects overwrites, escaped paths, links, stale revisions, and non-human callers", async (t) => {
  const { mkdir, writeFile, readFile, symlink, realpath, readdir } =
    await import("node:fs/promises");
  const { directory, store } = await fixture(t);
  const workspace = path.join(await realpath(directory), "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "existing.md"), "Keep this file");
  await symlink(directory, path.join(workspace, "linked"));
  const h = createHandlers(store, () => {}, { workspace: () => workspace });
  const d = await h.create({ title: "Draft", markdown: "Keep this draft" }, agent);
  for (const [destination, pattern] of [
    ["existing.md", /already exists/],
    ["../escape.md", /inside this session/],
    ["linked/escape.md", /symbolic link/],
    ["not-markdown.txt", /\.md/],
  ] as const)
    await assert.rejects(
      () => h.save_as({ path: destination, revision: d.revision }, human),
      pattern,
    );
  await assert.rejects(
    () => h.save_as({ path: "new.md", revision: 0 }, human),
    /changed in another view/,
  );
  await assert.rejects(
    () => h.save_as({ path: "new.md", revision: d.revision }, agent),
    /human editor/,
  );
  const readonly = {
    source: "session-action",
    action: { sessionKey: "session-one", client: { scopes: ["operator.read"] } },
  } as FeatureInvocationContext;
  await assert.rejects(
    () => h.save_as({ path: "new.md", revision: d.revision }, readonly),
    /human editor/,
  );
  assert.deepEqual(await h.read({}, human), d);
  assert.equal(await readFile(path.join(workspace, "existing.md"), "utf8"), "Keep this file");
  assert.deepEqual((await readdir(workspace)).sort(), ["existing.md", "linked"]);
});

test("competing sessions cannot overwrite a newly created file", async (t) => {
  const { mkdir, realpath, readFile, readdir } = await import("node:fs/promises");
  const { directory, store } = await fixture(t);
  const workspace = path.join(await realpath(directory), "workspace");
  await mkdir(workspace);
  const h = createHandlers(store, () => {}, { workspace: () => workspace });
  const other = {
    source: "session-action",
    action: { sessionKey: "session-two", client: { scopes: ["operator.write"] } },
  } as FeatureInvocationContext;
  await h.create({ title: "One", markdown: "First draft" }, human);
  await h.create({ title: "Two", markdown: "Second draft" }, other);
  const results = await Promise.allSettled(
    [human, other].map((ctx) => h.save_as({ path: "shared.md", revision: 1 }, ctx)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const winner = results.find((r) => r.status === "fulfilled")! as PromiseFulfilledResult<any>;
  assert.equal(await readFile(path.join(workspace, "shared.md"), "utf8"), winner.value.markdown);
  const loser = await store.read(results[0].status === "rejected" ? "session-one" : "session-two");
  assert.equal(loser.filePath, undefined);
  assert.equal(loser.revision, 1);
  assert.deepEqual(await readdir(workspace), ["shared.md"]);
});

test("failed state publication removes the newly created file and retains the original draft", async (t) => {
  const { mkdir, realpath, rename, writeFile, unlink, readdir } = await import("node:fs/promises");
  const { directory } = await fixture(t);
  const workspace = path.join(await realpath(directory), "workspace");
  await mkdir(workspace);
  const statePath = path.join(directory, "state");
  const store = new DocumentStore(statePath);
  await store.mutate("s", (d) => {
    d.markdown = "Keep the original draft";
  });
  const original = await store.read("s");
  await assert.rejects(() =>
    store.mutate(
      "s",
      (d) => {
        d.filePath = path.join(workspace, "new.md");
      },
      async (d) => {
        const rollback = await createMarkdown(workspace, "new.md", d.markdown);
        await rename(statePath, statePath + "-backup");
        await writeFile(statePath, "Block state publication");
        return async () => {
          await rollback();
          await unlink(statePath);
          await rename(statePath + "-backup", statePath);
        };
      },
    ),
  );
  assert.deepEqual(await store.read("s"), original);
  assert.deepEqual(await readdir(workspace), []);
});

test("renaming retains file bytes, permissions, review history, retries, and subsequent saves", async (t) => {
  const { mkdir, realpath, writeFile, readFile, stat, readdir } = await import("node:fs/promises");
  const { directory, store } = await fixture(t);
  const workspace = path.join(await realpath(directory), "workspace");
  await mkdir(workspace);
  const original = "---\r\ntitle: Keep this\r\n---\r\n\r\n# Draft\r\n\r\nKeep the words.\r\n";
  const oldPath = path.join(workspace, "original.md");
  await writeFile(oldPath, original, { mode: 0o640 });
  const originalMode = (await stat(oldPath)).mode & 0o777;
  const h = createHandlers(store, () => {}, { workspace: () => workspace });
  let d = await h.open({ path: "original.md" }, human);
  d = await h.comment(
    {
      body: "Shorter?",
      anchor: { quote: "Keep the words.", prefix: "", suffix: "" },
      revision: d.revision,
    },
    human,
  );
  d = await h.reply({ commentId: d.comments[0].id, body: "Yes." }, agent);
  d = await h.propose(
    {
      before: "Keep the words.",
      after: "Keep words.",
      reason: "Shorter",
      revision: d.revision,
      commentId: d.comments[0].id,
    },
    agent,
  );
  await h.draft({}, human); // Leave an old archived copy to retire during the rename.
  d = await h.open({ path: "original.md" }, human);
  const request = { path: d.filePath!, name: "renamed.md", revision: d.revision };
  let renamed = await h.rename(request, human);
  assert.equal(renamed.title, "renamed.md");
  assert.equal(await readFile(renamed.filePath!, "utf8"), original);
  await assert.rejects(() => stat(oldPath), { code: "ENOENT" });
  assert.equal((await stat(renamed.filePath!)).mode & 0o777, originalMode);
  assert.deepEqual(renamed.comments, d.comments);
  assert.deepEqual(renamed.proposals, d.proposals);
  assert.equal((await h.rename(request, human)).revision, renamed.revision);
  await assert.rejects(
    () => h.save({ title: d.title, markdown: "Stale", revision: d.revision, anchors: [] }, human),
    /changed in another view/,
  );
  renamed = await h.review(
    { proposalId: d.proposals[0].id, accept: true, revision: renamed.revision },
    human,
  );
  renamed = await h.save(
    {
      title: "Do not replace filename",
      markdown: renamed.markdown + "\nNew words.",
      revision: renamed.revision,
      anchors: [],
    },
    human,
  );
  assert.equal(renamed.title, "renamed.md");
  assert.equal(await readFile(renamed.filePath!, "utf8"), renamed.markdown);
  renamed = await h.rename(
    { path: renamed.filePath!, name: "RENAMED.md", revision: renamed.revision },
    human,
  );
  assert.deepEqual(await readdir(workspace), ["RENAMED.md"]);
  await h.draft({}, human);
  const reopened = await h.open({ path: "RENAMED.md" }, human);
  assert.deepEqual(reopened.comments, renamed.comments);
  assert.deepEqual(reopened.proposals, renamed.proposals);
  assert.equal(
    (await new DocumentStore(directory).read("session-one")).filePath,
    reopened.filePath,
  );
  await writeFile(oldPath, "A genuinely different document.");
  const reused = await h.open({ path: "original.md" }, human);
  assert.equal(reused.comments.length, 0);
  assert.equal(reused.proposals.length, 0);
  assert.equal(reused.lastRename, undefined);
});

test("renaming rejects collisions, stale or external edits, invalid names and non-human callers", async (t) => {
  const { mkdir, realpath, writeFile, readFile, symlink, readdir } =
    await import("node:fs/promises");
  const { directory, store } = await fixture(t);
  const workspace = path.join(await realpath(directory), "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "draft.md"), "Original");
  await writeFile(path.join(workspace, "existing.md"), "Keep this");
  await symlink(path.join(workspace, "existing.md"), path.join(workspace, "link.md"));
  const h = createHandlers(store, () => {}, { workspace: () => workspace });
  const d = await h.open({ path: "draft.md" }, human);
  const request = { path: d.filePath!, name: "new.md", revision: d.revision };
  for (const [name, pattern] of [
    ["existing.md", /already exists/],
    ["link.md", /symbolic link/],
    ["../escape.md", /without a folder/],
    ["wrong.txt", /ending in/],
    ["", /filename/],
  ] as const)
    await assert.rejects(() => h.rename({ ...request, name }, human), pattern);
  await assert.rejects(() => h.rename(request, agent), /human editor/);
  await assert.rejects(
    () => h.rename({ ...request, revision: 0 }, human),
    /changed in another view/,
  );
  await assert.rejects(
    () => h.rename({ ...request, path: path.join(workspace, "existing.md") }, human),
    /active document changed/,
  );
  await writeFile(d.filePath!, "External edits");
  await assert.rejects(() => h.rename(request, human), /changed outside Collab/);
  assert.equal(await readFile(d.filePath!, "utf8"), "External edits");
  assert.equal(await readFile(path.join(workspace, "existing.md"), "utf8"), "Keep this");
  assert.deepEqual(await store.read("session-one"), d);
  assert.deepEqual((await readdir(workspace)).sort(), ["draft.md", "existing.md", "link.md"]);
});

test("a rename publication failure restores the old path and all active review state", async (t) => {
  const { mkdir, realpath, writeFile, readFile, readdir } = await import("node:fs/promises");
  const { directory, store } = await fixture(t);
  const workspace = path.join(await realpath(directory), "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "old.md"), "Keep this.");
  const h = createHandlers(store, () => {}, { workspace: () => workspace });
  const d = await h.open({ path: "old.md" }, human);
  const archive = store.archive.bind(store);
  store.archive = async (doc) => {
    if (doc.filePath?.endsWith("/new.md")) throw new Error("Publication failed (test)");
    await archive(doc);
  };
  await assert.rejects(
    () => h.rename({ path: d.filePath!, name: "new.md", revision: d.revision }, human),
    /Publication failed/,
  );
  assert.deepEqual(await store.read("session-one"), d);
  assert.equal(await readFile(d.filePath!, "utf8"), "Keep this.");
  assert.deepEqual(await readdir(workspace), ["old.md"]);
});
