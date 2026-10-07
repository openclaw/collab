import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Anchor, Comment } from "./model.js";
export const threadKey = new PluginKey<DecorationSet>("collab-inline-threads");
export const anchorKey = new PluginKey<DecorationSet>("collab-comments");
export const CommentHighlights = Extension.create({
  name: "collabComments",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: threadKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, previous) => tr.getMeta(threadKey) ?? previous.map(tr.mapping, tr.doc),
        },
        props: { decorations: (state) => threadKey.getState(state) },
      }),
      new Plugin({
        key: anchorKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, previous) {
            return tr.getMeta(anchorKey) ?? previous.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return anchorKey.getState(state);
          },
        },
      }),
    ];
  },
});
export function project(doc: PMNode) {
  let text = "";
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock && text) {
      text += "\n";
      positions.push(pos);
    }
    if (node.isText) {
      const value = node.text!;
      text += value;
      for (let i = 0; i < value.length; i++) positions.push(pos + i);
    }
    if (node.type.name === "hardBreak") {
      text += "\n";
      positions.push(pos);
    }
  });
  return { text, positions };
}
export function makeAnchor(
  doc: PMNode,
  from: number,
  to: number,
  projection = project(doc),
): Anchor {
  const { text, positions } = projection;
  const start = positions.findIndex((p) => p >= from);
  if (start < 0 || positions[start] >= to) return { quote: "", prefix: "", suffix: "" };
  let end = positions.findIndex((p) => p >= to);
  if (end < 0) end = positions.length;
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - 32), start),
    suffix: text.slice(end, end + 32),
  };
}
export function locate(text: string, anchor: Anchor): number {
  if (!anchor.quote || anchor.orphaned) return -1;
  const hits: number[] = [];
  let at = text.indexOf(anchor.quote);
  while (at >= 0) {
    hits.push(at);
    at = text.indexOf(anchor.quote, at + 1);
  }
  if (hits.length === 1) return hits[0];
  const contextual = hits.filter(
    (i) =>
      (!anchor.prefix || text.slice(Math.max(0, i - anchor.prefix.length), i) === anchor.prefix) &&
      (!anchor.suffix ||
        text.slice(i + anchor.quote.length, i + anchor.quote.length + anchor.suffix.length) ===
          anchor.suffix),
  );
  return contextual.length === 1 ? contextual[0] : -1;
}
export function highlights(doc: PMNode, comments: Comment[], previous?: DecorationSet) {
  const { text, positions } = project(doc);
  const old = new Map(previous?.find().map((d) => [d.spec.id as string, d]) ?? []);
  const decorations: Decoration[] = [];
  for (const c of comments) {
    if (c.resolved) continue;
    const existing = old.get(c.id);
    if (existing) {
      decorations.push(existing);
      continue;
    }
    const at = locate(text, c.anchor);
    if (at < 0) continue;
    const from = positions[at],
      to = positions[at + c.anchor.quote.length - 1] + 1;
    if (from < to)
      decorations.push(
        Decoration.inline(
          from,
          to,
          { class: "collab-highlight", "data-comment-id": c.id },
          { id: c.id, inclusiveStart: false, inclusiveEnd: false },
        ),
      );
  }
  return DecorationSet.create(doc, decorations);
}
