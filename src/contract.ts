import { Type, type TSchema } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
const short = () => Type.String({ maxLength: 4000 });
const text = () => Type.String({ maxLength: 60000 });
const id = () => Type.String({ minLength: 1, maxLength: 200 });
const object = <T extends Record<string, TSchema>>(p: T) =>
  Type.Object(p, { additionalProperties: false });
export const anchorSchema = object({
  quote: short(),
  prefix: short(),
  suffix: short(),
  orphaned: Type.Optional(Type.Boolean()),
});
const replySchema = object({
  id: id(),
  body: short(),
  author: Type.Union([Type.Literal("you"), Type.Literal("agent")]),
  createdAt: short(),
});
const commentSchema = object({
  id: id(),
  anchor: anchorSchema,
  body: short(),
  resolved: Type.Boolean(),
  replies: Type.Array(replySchema),
  createdAt: short(),
});
const proposalSchema = object({
  id: id(),
  commentId: Type.Optional(id()),
  before: text(),
  after: text(),
  reason: short(),
  baseRevision: Type.Integer(),
  status: Type.Union([Type.Literal("pending"), Type.Literal("accepted"), Type.Literal("rejected")]),
  createdAt: short(),
});
const documentSchema = object({
  sessionKey: short(),
  filePath: Type.Optional(short()),
  fileHash: Type.Optional(short()),
  savedFromDraftRevision: Type.Optional(Type.Integer()),
  lastRename: Type.Optional(object({ fromPath: short(), revision: Type.Integer() })),
  title: short(),
  markdown: text(),
  revision: Type.Integer(),
  version: Type.Integer(),
  comments: Type.Array(commentSchema),
  proposals: Type.Array(proposalSchema),
  updatedAt: short(),
});
export const contract = defineFeatureContract({
  pluginId: "collab",
  operations: {
    draft: {
      kind: "action",
      description: "Return to the session draft, retaining workspace document history.",
      input: object({}),
      output: documentSchema,
    },
    files: {
      kind: "query",
      description: "Find Markdown documents in this session's workspace, most recent first.",
      input: object({ query: Type.Optional(short()) }),
      output: object({
        workspace: short(),
        files: Type.Array(object({ path: short(), name: short(), modifiedAt: short() })),
        truncated: Type.Boolean(),
      }),
    },
    open: {
      kind: "action",
      description:
        "Open an existing workspace Markdown file in this session's Collab sidebar. Accepts a workspace-relative or absolute .md path. Keeps review history per document; never changes file contents. The result identifies the active file. Use collab_read before proposing edits; only human acceptance writes proposals to the file.",
      input: object({ path: short() }),
      output: documentSchema,
      tool: { name: "collab_open", label: "Open document in Collab" },
    },
    read: {
      kind: "query",
      description:
        "Read the active document and its workspace filePath in this session’s Collab, including comments, replies, pending suggestions, and revision. Call before replying or proposing an edit.",
      input: object({}),
      output: documentSchema,
      tool: { name: "collab_read", label: "Read Collab document" },
    },
    create: {
      kind: "action",
      description:
        "Initialize the untouched Collab document in this session with a title and Markdown. Refuses to overwrite an edited document. Use collab_propose for subsequent changes.",
      input: object({ title: short(), markdown: text() }),
      output: documentSchema,
      tool: { name: "collab_create", label: "Create Collab document" },
    },
    save_as: {
      kind: "action",
      description:
        "Save the session draft as a new workspace Markdown file, preserving its comments and suggestions. Never overwrites an existing file. Human editor only.",
      input: object({ path: short(), revision: Type.Integer() }),
      output: documentSchema,
    },
    rename: {
      kind: "action",
      description:
        "Rename the active workspace Markdown file in its current folder, keeping comments and suggestions. Never overwrites another file. Human editor only.",
      input: object({ path: short(), name: short(), revision: Type.Integer() }),
      output: documentSchema,
    },
    save: {
      kind: "action",
      description: "Save human edits from the editor, with optimistic document revision checking.",
      input: object({
        title: short(),
        markdown: text(),
        revision: Type.Integer(),
        anchors: Type.Array(object({ id: id(), anchor: anchorSchema })),
      }),
      output: documentSchema,
    },
    comment: {
      kind: "action",
      description: "Add an anchored comment from the editor.",
      input: object({ body: short(), anchor: anchorSchema, revision: Type.Integer() }),
      output: documentSchema,
    },
    reply: {
      kind: "action",
      description:
        "Reply to a Collab comment in this session. Does not change the document or resolve the comment.",
      input: object({ commentId: id(), body: short() }),
      output: documentSchema,
      tool: { name: "collab_reply", label: "Reply to Collab comment" },
    },
    resolve: {
      kind: "action",
      description: "Resolve or reopen a comment from the UI.",
      input: object({ commentId: id(), resolved: Type.Boolean() }),
      output: documentSchema,
    },
    propose: {
      kind: "action",
      description:
        "Propose an exact Markdown replacement for human approval in Collab. First read the document. before must occur exactly once in its Markdown; include surrounding context for repeated passages. after is replacement Markdown, empty to delete. Never applies the edit; only the human UI can accept it.",
      input: object({
        before: text(),
        after: text(),
        reason: short(),
        revision: Type.Integer(),
        commentId: Type.Optional(id()),
      }),
      output: documentSchema,
      tool: { name: "collab_propose", label: "Propose Collab edit" },
    },
    review: {
      kind: "action",
      description: "Accept or reject one proposed edit from the human UI.",
      input: object({ proposalId: id(), accept: Type.Boolean(), revision: Type.Integer() }),
      output: documentSchema,
    },
  },
  events: { changed: object({ sessionKey: short(), version: Type.Integer() }) },
});
