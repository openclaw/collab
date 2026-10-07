import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { CommentHighlights, anchorKey, highlights, makeAnchor, locate } from "../src/anchors.js";
import type { Comment } from "../src/model.js";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "HTMLElement",
  "MutationObserver",
  "getComputedStyle",
  "DOMParser",
])
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
test("Markdown round-trip keeps headings, tables, code, tasks, and links", () => {
  const content =
    "# Hello\n\n**Bold** and [link](https://example.com)\n\n- [x] Done\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst n = 1\n```";
  const e = new Editor({
    extensions: [StarterKit, Markdown, TableKit, TaskList, TaskItem],
    content,
    contentType: "markdown",
  });
  const markdown = e.getMarkdown();
  assert.match(markdown, /# Hello/);
  assert.match(markdown, /\*\*Bold\*\*/);
  assert.match(markdown, /\[x\]/);
  assert.match(markdown, /\| A/);
  assert.match(markdown, /```ts/);
  assert.match(markdown, /https:\/\/example.com/);
  e.destroy();
});
test("comment ranges map through typing; deletion removes highlight; context disambiguates repeats", () => {
  const e = new Editor({
    extensions: [StarterKit, Markdown, CommentHighlights],
    content: "Alpha target omega",
    contentType: "markdown",
  });
  const anchor = makeAnchor(e.state.doc, 7, 13);
  assert.equal(anchor.quote, "target");
  const comment = {
    id: "c",
    anchor,
    body: "Edit",
    replies: [],
    resolved: false,
    createdAt: "",
  } satisfies Comment;
  e.view.dispatch(e.state.tr.setMeta(anchorKey, highlights(e.state.doc, [comment])));
  e.commands.insertContentAt(1, "New ");
  let d = anchorKey.getState(e.state)!.find()[0];
  assert.equal(e.state.doc.textBetween(d.from, d.to), "target");
  e.commands.deleteRange({ from: d.from, to: d.to });
  assert.equal(anchorKey.getState(e.state)!.find().length, 0);
  e.destroy();
  assert.equal(locate("same then same", { quote: "same", prefix: "", suffix: "" }), -1);
  assert.equal(locate("same then same", { quote: "same", prefix: "then ", suffix: "" }), 10);
});
test("local transactions remain responsive on a long draft", () => {
  const markdown =
    "# Long draft\n\n" +
    Array.from(
      { length: 300 },
      (_, i) =>
        `Paragraph ${i}. This is a substantial document for a local editing performance check.`,
    ).join("\n\n");
  const e = new Editor({
    extensions: [StarterKit, Markdown, CommentHighlights],
    content: markdown,
    contentType: "markdown",
  });
  const timings: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    e.commands.insertContentAt(10, "x");
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      characters: markdown.length,
      transactions: 100,
      p50Ms: timings[50],
      p95Ms: timings[95],
    }),
  );
  assert.ok(timings[95] < 100, "Local editing must not stall");
  e.destroy();
});
test("permission refresh and comment decorations do not trigger document saves", () => {
  let updates = 0;
  const e = new Editor({
    extensions: [StarterKit, Markdown, CommentHighlights],
    content: "A draft",
    contentType: "markdown",
    onUpdate: () => updates++,
  });
  e.setEditable(true, false);
  e.setEditable(false, false);
  e.setEditable(true, false);
  e.view.dispatch(e.state.tr.setMeta(anchorKey, highlights(e.state.doc, [])));
  assert.equal(updates, 0);
  e.commands.insertContentAt(1, "New ");
  assert.equal(updates, 1);
  e.destroy();
});

function nodeRange(doc: Editor["state"]["doc"], typeName: string) {
  let range: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (node.type.name === typeName) range = { from: pos, to: pos + node.nodeSize };
  });
  if (!range) throw new Error(`missing ${typeName}`);
  return range;
}

test("selections on horizontal rules do not quote neighboring text", () => {
  const middle = new Editor({
    extensions: [StarterKit],
    content: "<p>Hello</p><hr><p>World</p>",
  });
  const rule = nodeRange(middle.state.doc, "horizontalRule");
  const between = makeAnchor(middle.state.doc, rule.from, rule.to);
  assert.equal(between.quote, "");
  assert.equal(between.prefix, "");
  assert.equal(between.suffix, "");
  middle.destroy();

  const trailing = new Editor({
    extensions: [StarterKit],
    content: `<p>${"A".repeat(80)}</p><hr>`,
  });
  const endRule = nodeRange(trailing.state.doc, "horizontalRule");
  const afterText = makeAnchor(trailing.state.doc, endRule.from, endRule.to);
  assert.equal(afterText.quote, "");
  assert.equal(afterText.prefix, "");
  assert.equal(afterText.suffix, "");
  trailing.destroy();
});
