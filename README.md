# Collab

Write with your agent, without giving up control of the document.

Collab adds a Markdown editor to an OpenClaw session’s side panel. Write and format text, highlight a passage, leave a comment, and send your feedback to the agent. Its replies and suggested edits appear beside your draft. The draft changes only when you accept a suggestion.

## Use it

1. In a session, open **Side panel → Collab**. You can also open **Collab** from the main sidebar for a larger view.
2. Write directly, use Markdown shortcuts, or import a `.md` file.
3. Select a passage and choose **+ Comment** (`⌘/Ctrl + Alt + M`).
4. Choose **Send to agent**. This sends a real message to the same session; no copy/paste is needed.
5. Open **Suggestions** to compare the old and new text. Choose **Accept change** or **Decline**.

The toolbar supports headings, emphasis, lists, tasks, quotes, code, tables, undo, and redo. Markdown links and images render in the editor. Export downloads your current draft as Markdown, including unsaved edits.

## Fast by design

- Typing, selection, undo, and highlighting run locally in Tiptap/ProseMirror.
- Saves wait for a 650 ms typing pause; no network request is made for each keystroke.
- Replies and suggestions arrive through events, without polling or replacing the editor.
- The editor is initialized only when a Collab view opens. The current OpenClaw builder ships one browser bundle, so this defers initialization, not the bundle download.
- No paid collaboration service, CDN script, or remote editor backend is required.

## Data and approval

Each session has one document. The Gateway stores it in `<OpenClaw state>/collab/documents/`, as an atomically replaced JSON file containing Markdown, comments, and suggestions. Session keys are hashed for filenames. Switching sessions switches documents.

Agent tools:

| Tool             | Purpose                                             |
| ---------------- | --------------------------------------------------- |
| `collab_read`    | Read the draft, revision, comments, and suggestions |
| `collab_create`  | Initialize an untouched document                    |
| `collab_reply`   | Reply to a comment                                  |
| `collab_propose` | Propose an exact Markdown replacement               |

There is no agent tool for accepting an edit. Approval is a UI operation. Proposed text is matched exactly; missing or ambiguous passages are rejected. Unrelated edits can be retained when accepting a still-valid suggestion. Concurrent document saves use revision checks instead of silently overwriting another view.

Unsaved drafts are retained in browser storage at the save boundary and when the panel closes. After a conflict, export the local draft before reloading. This is not simultaneous multiplayer editing, and a crash before the debounce boundary can lose the last fraction of a second of typing.

Comments follow local editing through ProseMirror transaction mappings. Quote context reconnects them after reloading; removed or ambiguous passages are not silently assigned to a different quote. Resolved comments and reviewed suggestions remain in history.

## Develop

This repository targets the running OpenClaw **2026.9.7 development checkout**, with its native Control UI and typed feature-contract APIs. It is private and not published to npm. The initial development dependency points to the verified host checkout at `/Users/jalehman/Projects/openclaw-memory-runtime`; change that dependency if building on another machine. The version range alone does not guarantee these development APIs exist in another build.

```sh
npm install
npm run check
npm test
npm run build
npm run validate
./node_modules/.bin/openclaw plugins install --link --force .
```

Use the repository’s CLI: a different `openclaw` on PATH may target an older schema. Native UI requires **Settings → Labs → Custom plugin UI**, already enabled on the development Gateway.

After backend changes, build and run:

```sh
./node_modules/.bin/openclaw plugins reload collab
```

After browser-only changes, build and use **Reload plugin UI**, or:

```sh
./node_modules/.bin/openclaw gateway call plugins.controlUi.reload --params '{"pluginId":"collab"}'
```

A Gateway restart is not required. `npm run pack` creates a plugin archive.

## Current limits

- One document per session; no document library or real-time multiplayer cursors.
- Documents up to 200,000 characters, 500 comments, and 500 suggestions.
- Tiptap’s Markdown support is still beta. Supported Markdown is normalized on save; this is not a byte-preserving source editor. Arbitrary HTML, MDX, and custom Markdown extensions are outside this version’s scope.
- Proposals are exact Markdown replacements, not a general merge engine.

The editor uses the open-source [Tiptap Markdown extension](https://tiptap.dev/docs/editor/markdown/getting-started/basic-usage). Tests cover content round-trips, anchored selections, permission refreshes, approval enforcement, save conflicts, and stale suggestions.
