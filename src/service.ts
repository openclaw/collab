import path from "node:path";
import {
  createMarkdown,
  fingerprint,
  listMarkdown,
  readMarkdown,
  renameMarkdown,
  workspaceFile,
  writeMarkdown,
} from "./workspace.js";
import { randomUUID } from "node:crypto";
import { applyProposal, initialDocument, uniquePosition, type Document } from "./model.js";
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
function sessionWrite(ctx: FeatureInvocationContext) {
  if (ctx.source !== "session-action") return;
  const scopes = ctx.action.client?.scopes ?? [];
  if (!scopes.includes("operator.write") && !scopes.includes("operator.admin"))
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
  options: {
    workspace?: (ctx: FeatureInvocationContext) => string;
    show?: (ctx: FeatureInvocationContext) => Promise<void>;
  } = {},
): FeatureHandlers<typeof contract> {
  const workspace = (ctx: FeatureInvocationContext) => {
    const root = options.workspace?.(ctx);
    if (!root) throw new Error("This session has no workspace.");
    if (ctx.source === "tool" && ctx.tool.sandboxed)
      throw new Error("Workspace Collab is not available to sandboxed tools.");
    return root;
  };
  const mutate = async (
    ctx: FeatureInvocationContext,
    fn: (doc: Document) => void | Promise<void>,
    writesFile = false,
  ) => {
    let priorMarkdown = "";
    const doc = await store.mutate(
      sessionKey(ctx),
      async (doc) => {
        priorMarkdown = doc.markdown;
        await fn(doc);
      },
      async (doc) => {
        if (writesFile && doc.filePath && doc.markdown !== priorMarkdown) {
          doc.fileHash = await writeMarkdown(
            workspace(ctx),
            doc.filePath,
            doc.fileHash!,
            doc.markdown,
          );
        }
      },
    );
    changed(doc);
    return doc;
  };
  return {
    draft: async (_, ctx) => {
      human(ctx);
      return mutate(ctx, async (doc) => {
        if (!doc.filePath) return;
        await store.archive(doc);
        const archived = await store.archived(doc.sessionKey, "draft");
        const restored = archived ?? initialDocument(doc.sessionKey);
        const revision = doc.revision + 1,
          version = doc.version;
        delete doc.filePath;
        delete doc.fileHash;
        delete doc.savedFromDraftRevision;
        delete doc.lastRename;
        Object.assign(doc, restored, { revision, version });
      });
    },
    files: (input, ctx) => listMarkdown(workspace(ctx), input.query),
    open: async (input, ctx) => {
      sessionWrite(ctx);
      const root = workspace(ctx);
      const file = await readMarkdown(root, input.path);
      const doc = await mutate(ctx, async (doc) => {
        if (doc.filePath === file.filePath && doc.fileHash === file.fileHash) return;
        await store.archive(doc);
        const archived = await store.archived(doc.sessionKey, file.filePath);
        const nextRevision = doc.revision + 1;
        const nextVersion = doc.version;
        const currentSession = doc.sessionKey;
        delete doc.savedFromDraftRevision;
        delete doc.lastRename;
        Object.assign(doc, archived ?? { comments: [], proposals: [] });
        Object.assign(doc, file, {
          sessionKey: currentSession,
          title: path.basename(file.filePath),
          revision: nextRevision,
          version: nextVersion,
        });
      });
      await options.show?.(ctx);
      return doc;
    },
    read: async (_, ctx) => {
      const doc = await store.read(sessionKey(ctx));
      if (!doc.filePath) return doc;
      const file = await readMarkdown(workspace(ctx), doc.filePath);
      if (file.fileHash === doc.fileHash) return doc;
      return mutate(ctx, async (latest) => {
        if (!latest.filePath || latest.filePath !== doc.filePath) return;
        const current = await readMarkdown(workspace(ctx), latest.filePath);
        if (current.fileHash !== latest.fileHash) {
          Object.assign(latest, current);
          latest.revision++;
        }
      });
    },
    create: async (input, ctx) => {
      sessionWrite(ctx);
      return mutate(ctx, (doc) => {
        if (doc.revision !== 0 || doc.comments.length || doc.proposals.length)
          throw new Error("This document is already in use. Propose changes for approval instead.");
        nonempty(input.title);
        doc.title = input.title;
        doc.markdown = input.markdown;
        doc.revision++;
      });
    },
    save_as: async (input, ctx) => {
      human(ctx);
      const root = workspace(ctx);
      const filePath = await workspaceFile(root, input.path, true);
      let create = false;
      const doc = await store.mutate(
        sessionKey(ctx),
        (doc) => {
          // A lost response can be retried without creating a second file or resetting history.
          if (doc.filePath === filePath && doc.savedFromDraftRevision === input.revision) return;
          revision(doc, input.revision);
          if (doc.filePath) throw new Error("This document is already saved to a file.");
          doc.filePath = filePath;
          doc.fileHash = fingerprint(doc.markdown);
          doc.savedFromDraftRevision = input.revision;
          doc.title = path.basename(filePath);
          doc.revision++;
          create = true;
        },
        async (doc) => {
          if (!create) return;
          // Retire any older archived draft. The active draft remains intact if creation fails.
          await store.archive(initialDocument(doc.sessionKey));
          return createMarkdown(root, filePath, doc.markdown);
        },
      );
      changed(doc);
      return doc;
    },
    rename: async (input, ctx) => {
      human(ctx);
      const root = workspace(ctx);
      const name = input.name.trim();
      if (!name || name.includes("/") || name.includes("\\") || !/\.(md|markdown)$/i.test(name))
        throw new Error("Enter a filename ending in .md or .markdown, without a folder path.");
      const fromPath = await workspaceFile(root, input.path, true);
      const filePath = await workspaceFile(root, path.join(path.dirname(fromPath), name), true);
      let move = false;
      const doc = await store.mutate(
        sessionKey(ctx),
        (doc) => {
          if (
            doc.filePath === filePath &&
            doc.lastRename?.fromPath === fromPath &&
            doc.lastRename.revision === input.revision
          )
            return;
          revision(doc, input.revision);
          if (!doc.filePath || doc.filePath !== fromPath)
            throw new Error("The active document changed. Open the file you want to rename.");
          if (filePath === fromPath) return;
          doc.filePath = filePath;
          doc.title = name;
          doc.lastRename = { fromPath, revision: input.revision };
          doc.revision++;
          move = true;
        },
        async (doc) => {
          if (!move) return;
          const rollback = await renameMarkdown(root, fromPath, filePath, doc.fileHash!);
          try {
            // A reused old filename must not inherit this document's review history.
            await store.archive({ ...initialDocument(doc.sessionKey), filePath: fromPath });
            // Preserve history at the new path even if active-state publication is interrupted.
            await store.archive(doc);
          } catch (error) {
            await rollback();
            throw error;
          }
          return rollback;
        },
      );
      changed(doc);
      return doc;
    },
    save: (input, ctx) => {
      human(ctx);
      return mutate(
        ctx,
        (doc) => {
          revision(doc, input.revision);
          doc.title = doc.filePath ? path.basename(doc.filePath) : input.title;
          doc.markdown = input.markdown;
          doc.revision++;
          for (const entry of input.anchors) {
            const comment = doc.comments.find((c) => c.id === entry.id);
            if (comment) comment.anchor = entry.anchor;
          }
        },
        true,
      );
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
    reply: async (input, ctx) => {
      sessionWrite(ctx);
      return mutate(ctx, (doc) => {
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
      });
    },
    resolve: (input, ctx) => {
      human(ctx);
      return mutate(ctx, (doc) => {
        const c = doc.comments.find((c) => c.id === input.commentId);
        if (!c) throw new Error("Comment not found.");
        c.resolved = input.resolved;
      });
    },
    propose: async (input, ctx) => {
      sessionWrite(ctx);
      return mutate(ctx, (doc) => {
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
      });
    },
    review: (input, ctx) => {
      human(ctx);
      return mutate(
        ctx,
        (doc) => {
          revision(doc, input.revision);
          const p = doc.proposals.find((p) => p.id === input.proposalId);
          if (!p) throw new Error("Suggestion not found.");
          if (p.status !== "pending") throw new Error("This suggestion has already been reviewed.");
          if (input.accept) {
            doc.markdown = applyProposal(doc.markdown, p);
            for (const c of doc.comments) {
              if (c.anchor.quote === p.before)
                c.anchor = { ...c.anchor, quote: p.after, orphaned: !p.after.trim() };
            }
            doc.revision++;
          }
          p.status = input.accept ? "accepted" : "rejected";
        },
        true,
      );
    },
  };
}
