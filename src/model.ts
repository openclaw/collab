export const MAX_DOCUMENT_CHARS = 60_000;
export type Anchor = { quote: string; prefix: string; suffix: string; orphaned?: boolean };
export type Reply = { id: string; body: string; author: "you" | "agent"; createdAt: string };
export type Comment = {
  id: string;
  anchor: Anchor;
  body: string;
  resolved: boolean;
  replies: Reply[];
  createdAt: string;
};
export type Proposal = {
  id: string;
  commentId?: string;
  before: string;
  after: string;
  reason: string;
  baseRevision: number;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
};
export type Document = {
  sessionKey: string;
  title: string;
  markdown: string;
  revision: number;
  version: number;
  comments: Comment[];
  proposals: Proposal[];
  updatedAt: string;
};
export const WELCOME =
  "# Make something worth sharing\n\nA good draft starts a conversation. Write here, or import a Markdown file, then invite your agent to help.\n\n## A simple way to collaborate\n\n1. **Write naturally.** Format with the toolbar or familiar Markdown shortcuts.\n2. **Highlight a passage.** Add a comment about what you want to change.\n3. **Send to agent.** Your feedback goes straight into this session.\n4. **Review the suggestions.** Accept the changes you like. You stay in control.\n\n> Your words first. Your agent beside you.\n\nTry selecting this sentence and asking your agent to make it more concise.\n";
export function initialDocument(sessionKey: string): Document {
  return {
    sessionKey,
    title: "Untitled document",
    markdown: WELCOME,
    revision: 0,
    version: 0,
    comments: [],
    proposals: [],
    updatedAt: new Date().toISOString(),
  };
}
export function uniquePosition(text: string, quote: string): number {
  if (!quote) throw new Error("Select non-empty text to replace.");
  const at = text.indexOf(quote);
  if (at < 0) throw new Error("That passage has changed. Ask the agent for a fresh suggestion.");
  if (text.indexOf(quote, at + 1) !== -1)
    throw new Error("That passage occurs more than once. Include more surrounding text.");
  return at;
}
export function applyProposal(
  markdown: string,
  proposal: Pick<Proposal, "before" | "after">,
): string {
  const at = uniquePosition(markdown, proposal.before);
  return markdown.slice(0, at) + proposal.after + markdown.slice(at + proposal.before.length);
}
