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
    read: {
      kind: "query",
      description:
        "Read the current session Collab Markdown document, comments, replies, pending suggestions, and revision. Call before replying or proposing an edit.",
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
