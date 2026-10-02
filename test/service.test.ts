import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import { DocumentStore } from "../src/store.js";
import { createHandlers } from "../src/service.js";
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
