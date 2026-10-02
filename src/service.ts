import { randomUUID } from "node:crypto";
import { applyProposal, uniquePosition, type Document } from "./model.js";
import { DocumentStore } from "./store.js";
import type { FeatureHandlers, FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { contract } from "./contract.js";
export function sessionKey(ctx: FeatureInvocationContext) {
  const key =
    ctx.source === "tool"
      ? ctx.tool.sessionKey
      : ctx.source === "session-action"
        ? ctx.action.sessionKey
        : undefined;
  if (!key) throw new Error("Open Collab in a session first.");
  return key;
}
function human(ctx: FeatureInvocationContext) {
  if (
    ctx.source !== "session-action" ||
    (!ctx.action.client?.scopes.includes("operator.write") &&
      !ctx.action.client?.scopes.includes("operator.admin"))
  )
    throw new Error("This action is only available from the human editor.");
}
function revision(doc: Document, expected: number) {
  if (doc.revision !== expected)
    throw new Error(
      "This document changed in another view. Your local draft is preserved; export it before reloading.",
    );
}
function nonempty(value: string) {
  if (!value.trim()) throw new Error("Please enter some text.");
}
export function createHandlers(
  store: DocumentStore,
  changed: (doc: Document) => void,
): FeatureHandlers<typeof contract> {
  const mutate = async (ctx: FeatureInvocationContext, fn: (doc: Document) => void) => {
    const doc = await store.mutate(sessionKey(ctx), fn);
    changed(doc);
    return doc;
  };
  return {
    read: (_, ctx) => store.read(sessionKey(ctx)),
    create: (input, ctx) =>
      mutate(ctx, (doc) => {
        if (doc.revision !== 0 || doc.comments.length || doc.proposals.length)
          throw new Error("This document is already in use. Propose changes for approval instead.");
        nonempty(input.title);
        doc.title = input.title;
        doc.markdown = input.markdown;
        doc.revision++;
      }),
    save: (input, ctx) => {
      human(ctx);
      return mutate(ctx, (doc) => {
        revision(doc, input.revision);
        doc.title = input.title;
        doc.markdown = input.markdown;
        doc.revision++;
        for (const entry of input.anchors) {
          const comment = doc.comments.find((c) => c.id === entry.id);
          if (comment) comment.anchor = entry.anchor;
        }
      });
    },
    comment: (input, ctx) => {
      human(ctx);
      return mutate(ctx, (doc) => {
        revision(doc, input.revision);
        nonempty(input.body);
        nonempty(input.anchor.quote);
        if (doc.comments.length >= 500)
          throw new Error("This document has reached its 500-comment limit.");
        doc.comments.push({
          id: randomUUID(),
          anchor: input.anchor,
          body: input.body,
          replies: [],
          resolved: false,
          createdAt: new Date().toISOString(),
        });
      });
    },
    reply: (input, ctx) =>
      mutate(ctx, (doc) => {
        nonempty(input.body);
        const c = doc.comments.find((c) => c.id === input.commentId);
        if (!c) throw new Error("Comment not found.");
        if (c.replies.length >= 100) throw new Error("This thread has reached its reply limit.");
        c.replies.push({
          id: randomUUID(),
          body: input.body,
          author: ctx.source === "tool" ? "agent" : "you",
          createdAt: new Date().toISOString(),
        });
      }),
    resolve: (input, ctx) => {
      human(ctx);
      return mutate(ctx, (doc) => {
        const c = doc.comments.find((c) => c.id === input.commentId);
        if (!c) throw new Error("Comment not found.");
        c.resolved = input.resolved;
      });
    },
    propose: (input, ctx) =>
      mutate(ctx, (doc) => {
        revision(doc, input.revision);
        uniquePosition(doc.markdown, input.before);
        nonempty(input.reason);
        if (input.before === input.after) throw new Error("The proposed text is unchanged.");
        if (input.commentId && !doc.comments.some((c) => c.id === input.commentId))
          throw new Error("Comment not found.");
        if (doc.proposals.length >= 500)
          throw new Error("This document has reached its suggestion limit.");
        doc.proposals.push({
          id: randomUUID(),
          before: input.before,
          after: input.after,
          reason: input.reason,
          baseRevision: doc.revision,
          ...(input.commentId ? { commentId: input.commentId } : {}),
          status: "pending",
          createdAt: new Date().toISOString(),
        });
      }),
    review: (input, ctx) => {
      human(ctx);
      return mutate(ctx, (doc) => {
        revision(doc, input.revision);
        const p = doc.proposals.find((p) => p.id === input.proposalId);
        if (!p) throw new Error("Suggestion not found.");
        if (p.status !== "pending") throw new Error("This suggestion has already been reviewed.");
        if (input.accept) {
          doc.markdown = applyProposal(doc.markdown, p);
          doc.revision++;
        }
        p.status = input.accept ? "accepted" : "rejected";
      });
    },
  };
}
