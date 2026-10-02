// Isolated browser-to-real-service proof; no production documents or settings are changed.
import { chromium } from "playwright-core";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { DocumentStore } from "../src/store.js";
import { createHandlers } from "../src/service.js";
await mkdir("artifacts", { recursive: true });
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "collab-ui-")));
const workspace = path.join(directory, "workspace");
await mkdir(workspace);
const original =
  "---\ntitle: Preserve this metadata\n---\n\n# A clearer way to write\n\nThis paragraph could be a little shorter.\n\n## Next steps\n\nKeep the useful details.\n";
await writeFile(path.join(workspace, "draft.md"), original);
await writeFile(path.join(workspace, "other.md"), "# Another document\n\nA separate draft.\n");
const formattingOriginal =
  "# A clearer way to write\n\nThis paragraph could be a little shorter.\n\n## Next steps\n\nKeep the useful details.";
await writeFile(path.join(workspace, "format.md"), formattingOriginal);
const store = new DocumentStore(path.join(directory, "state"));
const ctx: any = {
  source: "session-action",
  action: { sessionKey: "ui-proof", client: { scopes: ["operator.write"] } },
};
const agent: any = { source: "tool", tool: { sessionKey: "ui-proof" } };
const h = createHandlers(store, () => {}, { workspace: () => workspace });
await h.open({ path: "format.md" }, ctx);
await build({
  entryPoints: ["src/editor.ts"],
  bundle: true,
  format: "esm",
  outfile: path.join(directory, "editor.js"),
});
const js = await readFile(path.join(directory, "editor.js"), "utf8");
const css = await readFile(path.join(directory, "editor.css"), "utf8");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.COLLAB_BROWSER_EXECUTABLE
    ? { executablePath: process.env.COLLAB_BROWSER_EXECUTABLE }
    : { channel: "chrome" }),
});
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 850 } });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  const calls: string[] = [];
  let failSave = false;
  let failComment = true;
  let loseSendResponse = true;
  let loseSaveAsResponse = false;
  let loseRenameResponse = false;
  const renameRequests: { path: string; name: string; revision: number }[] = [];
  const saveAsRequests: { path: string; revision: number }[] = [];
  const sends: { message: string; idempotencyKey: string; sessionKey: string }[] = [];
  const acceptedMessages = new Map<string, string>();
  await page.exposeFunction("invoke", async (method: string, params: any) => {
    if (method === "chat.send") {
      calls.push(method);
      sends.push({ ...params });
      const saved = await h.read({}, agent);
      const id = params.idempotencyKey.replace("collab-feedback-", "");
      assert.ok(saved.comments.some((c) => c.id === id || c.replies.some((r) => r.id === id)));
      assert.equal(params.sessionKey, "ui-proof");
      acceptedMessages.set(params.idempotencyKey, params.message);
      if (loseSendResponse) {
        loseSendResponse = false;
        throw new Error("Response lost after acceptance (test)");
      }
      return { status: "started" };
    }
    calls.push(params.actionId);
    if (failSave && params.actionId === "save") throw new Error("Offline (test)");
    if (failComment && params.actionId === "comment") throw new Error("Comment save failed (test)");
    if (params.actionId === "save_as") saveAsRequests.push({ ...params.payload });
    if (params.actionId === "rename") renameRequests.push({ ...params.payload });
    const result = await (h as any)[params.actionId](params.payload, ctx);
    if (params.actionId === "save_as" && loseSaveAsResponse) {
      loseSaveAsResponse = false;
      throw new Error("Save as response lost after publication (test)");
    }
    if (params.actionId === "rename" && loseRenameResponse) {
      loseRenameResponse = false;
      throw new Error("Rename response lost after publication (test)");
    }
    return { ok: true, result };
  });
  await page.addInitScript({
    content: `Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (text) => { window.copiedPath = text; } }
  });`,
  });
  await page.route("http://collab.test/**", (route: any) => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill({
      contentType: pathname.endsWith(".js") ? "text/javascript" : "text/html",
      body:
        pathname === "/editor.js"
          ? js
          : `<!doctype html><style>:root{--text:#26352d;--muted:#657b6f;--bg:#f5f8f5;--bg-elevated:#fff;--border:#d3ddd5;--accent:#257650;--accent-hover:#1e6041;--accent-foreground:#fff;--accent-subtle:#25765018;--font-body:system-ui;--shadow-md:0 4px 15px #0002}body{margin:0}#app{width:min(560px,100%);height:850px; margin:auto}${css}</style><div id="app"></div><script type="module">import {mountEditor} from '/editor.js';window.listeners=[];window.host={pluginId:'collab',signal:new AbortController().signal,connection:{connected:true,canWrite:true},request:window.invoke,onEvent:(name,fn)=>{listeners.push(fn);return()=>{}},subscribe:()=>()=>{},navigation:{pageHref:()=>'/plugin?plugin=collab&id=open'}};window.view=mountEditor(document.querySelector('#app'),{host,signal:host.signal,props:{sessionKey:'ui-proof'},presented:true});</script>`,
    });
  });
  await page.goto("http://collab.test");
  await page
    .getByRole("textbox", { name: "Document editor", exact: true })
    .waitFor()
    .catch(async (error: unknown) => {
      console.error(
        JSON.stringify({ errors, body: await page.locator("body").innerText(), calls }),
      );
      throw error;
    });
  assert.equal(calls.filter((c) => c === "save").length, 0);
  assert.equal(await page.getByRole("button", { name: "Send to agent", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Copy file path", exact: true }).click();
  assert.equal(
    await page.evaluate(() => (window as any).copiedPath),
    path.join(workspace, "format.md"),
  );
  assert.equal(await page.locator(".collab-status").innerText(), "Path copied");
  // Real DOM text selection, not a fake editor command.
  async function selectParagraph() {
    await page.evaluate(() => {
      const paragraph = document.querySelector(".tiptap > p")!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      (document.querySelector(".tiptap") as HTMLElement).focus();
      document.dispatchEvent(new Event("selectionchange"));
    });
  }
  await selectParagraph();
  const options = page.getByLabel("Document options", { exact: true });
  const bubble = page.getByRole("toolbar", { name: "Selected text", exact: true });
  const format = bubble.locator(".collab-format-options > summary");
  const formatting = page.getByRole("toolbar", { name: "Document formatting" });
  assert.equal(await page.locator(".collab-menu .collab-format-options").count(), 0);
  await bubble.waitFor({ state: "visible" });
  await format.waitFor({ state: "visible" });
  await formatting.waitFor({ state: "hidden" });
  await page.locator(".collab").screenshot({ path: "artifacts/collab-format-collapsed.png" });
  await format.click();
  await formatting.waitFor({ state: "visible" });
  assert.deepEqual(
    await formatting
      .locator("button")
      .evaluateAll((buttons: HTMLElement[]) => buttons.map((b) => b.getAttribute("aria-label"))),
    [
      "Bold",
      "Italic",
      "Heading 1",
      "Heading 2",
      "Bullet list",
      "Numbered list",
      "Task list",
      "Quote",
      "Code block",
      "Insert table",
      "Undo",
      "Redo",
    ],
  );
  await page.locator(".collab").screenshot({ path: "artifacts/collab-format-expanded.png" });
  // Opening the selection popup's Format section must preserve the selected passage.
  await formatting.getByRole("button", { name: "Bold", exact: true }).click();
  await page.locator(".tiptap > p strong").waitFor();
  await page.waitForFunction(
    () => document.querySelector(".collab-status")?.textContent === "Saved",
  );
  assert.match(
    await readFile(path.join(workspace, "format.md"), "utf8"),
    /\*\*This paragraph could be a little shorter\.\*\*/,
  );
  await formatting.getByRole("button", { name: "Undo", exact: true }).click();
  await page.locator(".tiptap > p strong").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.querySelector(".collab-status")?.textContent === "Saved",
  );
  assert.equal(await readFile(path.join(workspace, "format.md"), "utf8"), formattingOriginal);
  await format.click();
  await formatting.waitFor({ state: "hidden" });
  await format.press("Enter");
  await formatting.waitFor({ state: "visible" });
  await format.press("Space");
  await formatting.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Open…", exact: true }).click();
  await page.getByRole("button", { name: /draft.md/ }).click();
  await page.waitForFunction(() =>
    document.querySelector(".collab-file-path")?.textContent?.endsWith("/draft.md"),
  );
  await selectParagraph();
  await bubble.waitFor({ state: "visible" });
  await page.locator(".collab").screenshot({ path: "artifacts/collab-selection.png" });
  await bubble.getByRole("button", { name: "+ Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment", exact: true }).fill("Make this concise.");
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Comment save failed" }).waitFor();
  assert.equal(sends.length, 0);
  assert.equal((await h.read({}, agent)).comments.length, 0);
  assert.equal(
    await page.getByRole("textbox", { name: "New comment", exact: true }).inputValue(),
    "Make this concise.",
  );
  failComment = false;
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await page.locator(".collab-card").waitFor();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  assert.equal(sends.length, 1);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.locator(".collab-delivery").waitFor({ state: "hidden" });
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0], sends[1]);
  assert.equal(acceptedMessages.size, 1);
  assert.equal(await page.locator(".tiptap > .collab-card").count(), 1);
  assert.equal(await page.locator(".collab-rail").count(), 0);
  const doc = await h.read({}, agent);
  assert.equal(doc.comments.length, 1);
  assert.equal(doc.markdown, original); // comments must never be serialized into Markdown
  await h.reply({ commentId: doc.comments[0].id, body: "Here is a shorter version." }, agent);
  await page.evaluate(() =>
    (window as any).listeners.forEach((fn: any) => fn({ sessionKey: "ui-proof", version: 999 })),
  );
  await page.getByText("Here is a shorter version.", { exact: true }).waitFor();
  assert.equal(sends.length, 2); // agent replies must not cause an auto-send loop
  loseSendResponse = true;
  await page
    .getByRole("textbox", { name: "Reply to comment", exact: true })
    .fill("Keep the meaning, please.");
  await page.getByRole("button", { name: "Post reply", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  assert.equal(sends.length, 3);
  await page.reload();
  await page.getByRole("textbox", { name: "Document editor", exact: true }).waitFor();
  await page.locator(".collab-delivery").waitFor({ state: "hidden" });
  assert.equal(sends.length, 4);
  assert.deepEqual(sends[2], sends[3]);
  assert.equal(acceptedMessages.size, 2);
  assert.match(sends[2].message, /Keep the meaning, please/);
  assert.equal((await h.read({}, agent)).comments[0].replies.length, 2);
  await h.propose(
    {
      commentId: doc.comments[0].id,
      before: "This paragraph could be a little shorter.",
      after: "This paragraph can be shorter.",
      reason: "Remove filler.",
      revision: doc.revision,
    },
    agent,
  );
  await page.evaluate(() =>
    (window as any).listeners.forEach((fn: any) => fn({ sessionKey: "ui-proof", version: 999 })),
  );
  await page.getByRole("button", { name: "Accept change", exact: true }).waitFor();
  assert.equal(await readFile(path.join(workspace, "draft.md"), "utf8"), original);
  await page.locator(".collab").screenshot({ path: "artifacts/collab-inline-review.png" });
  await page.getByRole("button", { name: "Accept change", exact: true }).click();
  await page
    .getByRole("button", { name: "Accept change", exact: true })
    .waitFor({ state: "hidden" });
  assert.match(
    await readFile(path.join(workspace, "draft.md"), "utf8"),
    /This paragraph can be shorter/,
  );
  await page.getByRole("button", { name: "Open…", exact: true }).click();
  await page.getByRole("button", { name: /other.md/ }).click();
  await page
    .getByRole("textbox", { name: "Document editor", exact: true })
    .getByRole("heading", { name: "Another document" })
    .waitFor();
  await page.getByRole("button", { name: "Open…", exact: true }).click();
  await page.getByRole("button", { name: /draft.md/ }).click();
  await page.locator(".tiptap > .collab-card").waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Reply to comment", exact: true }).count(),
    1,
  );
  // A live inherited palette change updates every Collab accent with no remount.
  const theme = await page.evaluate(() => {
    const editor = document.querySelector(".tiptap");
    document.documentElement.style.setProperty("--accent", "rgb(210, 120, 240)");
    document.documentElement.style.setProperty("--bg", "rgb(25, 26, 32)");
    document.documentElement.style.setProperty("--bg-elevated", "rgb(32, 33, 40)");
    document.documentElement.style.setProperty("--text", "rgb(235, 232, 242)");
    return {
      accent: getComputedStyle(document.querySelector(".collab-comment-button")!).color,
      sameEditor: editor === document.querySelector(".tiptap"),
    };
  });
  assert.equal(theme.accent, "rgb(210, 120, 240)");
  assert.equal(theme.sameEditor, true);
  await page.locator(".collab").screenshot({ path: "artifacts/collab-dark.png" });
  await page.setViewportSize({ width: 390, height: 850 });
  await page.evaluate(() => {
    document.querySelector<HTMLElement>("#app")!.style.width = "100%";
  });
  assert.equal(
    await page.evaluate(() => document.querySelector(".collab")!.scrollWidth > 390),
    false,
  );
  assert.equal(await page.locator(".tiptap > .collab-card").count(), 1);
  // Unsaved draft recovery belongs to its file, not whichever file opens next.
  failSave = true;
  const input = page.getByRole("textbox", { name: "Document editor", exact: true });
  await input.locator(":scope > p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Unsaved proof.");
  assert.match(await input.innerText(), /Unsaved proof/);
  await page.evaluate(() => window.dispatchEvent(new Event("beforeunload")));
  assert.match(
    await page.evaluate(() => Object.values(localStorage).find((x) => x.includes("Unsaved proof"))),
    /Preserve this metadata/,
  );
  await h.open({ path: "other.md" }, agent);
  await page.evaluate(() =>
    (window as any).listeners.forEach((fn: any) => fn({ sessionKey: "ui-proof", version: 999 })),
  );
  await input.getByRole("heading", { name: "Another document" }).waitFor();
  assert.doesNotMatch(await input.innerText(), /Unsaved proof/);
  await h.open({ path: "draft.md" }, agent);
  await page.evaluate(() =>
    (window as any).listeners.forEach((fn: any) => fn({ sessionKey: "ui-proof", version: 999 })),
  );
  await page.waitForFunction(() =>
    document.querySelector(".tiptap")?.textContent?.includes("Unsaved proof"),
  );
  assert.match(await input.innerText(), /Unsaved proof/);
  // A session draft becomes a real file, with live review history and pending edits intact.
  failSave = false;
  let draft = await h.draft({}, ctx);
  draft = await h.save(
    {
      title: "A session draft",
      markdown:
        "---\ntitle: Retain this metadata\n---\n\n# Session draft\n\nKeep this passage.\n\nMore ideas.",
      revision: draft.revision,
      anchors: [],
    },
    ctx,
  );
  draft = await h.comment(
    {
      body: "Make this shorter.",
      anchor: { quote: "Keep this passage.", prefix: "", suffix: "" },
      revision: draft.revision,
    },
    ctx,
  );
  draft = await h.reply(
    { commentId: draft.comments[0].id, body: "This review should travel with the file." },
    agent,
  );
  draft = await h.propose(
    {
      commentId: draft.comments[0].id,
      before: "Keep this passage.",
      after: "Keep this.",
      reason: "Less filler.",
      revision: draft.revision,
    },
    agent,
  );
  await page.reload();
  await page.getByRole("button", { name: "Accept change", exact: true }).waitFor();
  await page.getByLabel("Document options", { exact: true }).click();
  await page.getByRole("button", { name: "Save as…", exact: true }).click();
  const saveForm = page.getByRole("form", { name: "Save draft as a file" });
  const newPath = page.getByRole("textbox", { name: "New Markdown file path" });
  assert.equal(await newPath.inputValue(), "A session draft.md");
  await page.locator(".collab").screenshot({ path: "artifacts/collab-save-as.png" });
  await newPath.press("Escape");
  await saveForm.waitFor({ state: "hidden" });
  assert.equal(saveAsRequests.length, 0);
  await page.getByLabel("Document options", { exact: true }).click();
  await page.getByRole("button", { name: "Save as…", exact: true }).click();
  await newPath.fill("other.md");
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "already exists" }).waitFor();
  assert.equal(await newPath.inputValue(), "other.md");
  assert.equal((await h.read({}, agent)).filePath, undefined);
  assert.equal(
    await readFile(path.join(workspace, "other.md"), "utf8"),
    "# Another document\n\nA separate draft.\n",
  );
  await input.locator(":scope > p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Fresh words.");
  await newPath.fill("saved/session-draft.md");
  loseSaveAsResponse = true;
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "response lost" }).waitFor();
  const written = await h.read({}, agent);
  assert.match(written.markdown, /Fresh words/);
  assert.match(written.markdown, /^---\ntitle: Retain this metadata\n---/);
  assert.equal(written.proposals[0].status, "pending");
  assert.deepEqual(
    written.comments.map((c) => ({ id: c.id, body: c.body, replies: c.replies })),
    draft.comments.map((c) => ({ id: c.id, body: c.body, replies: c.replies })),
  );
  assert.equal(await readFile(written.filePath!, "utf8"), written.markdown);
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  await saveForm.waitFor({ state: "hidden" });
  assert.deepEqual(saveAsRequests[1], saveAsRequests[2]);
  assert.equal((await h.read({}, agent)).revision, written.revision);
  await page.getByRole("button", { name: "Copy file path", exact: true }).click();
  assert.equal(await page.evaluate(() => (window as any).copiedPath), written.filePath);
  assert.equal(
    await page.getByRole("textbox", { name: "Filename", exact: true }).inputValue(),
    "session-draft.md",
  );
  await page.getByRole("button", { name: "Accept change", exact: true }).click();
  await page
    .getByRole("button", { name: "Accept change", exact: true })
    .waitFor({ state: "hidden" });
  assert.match(await readFile(written.filePath!, "utf8"), /Keep this\./);
  await input.locator(":scope > p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Saved to the file.");
  await page.waitForFunction(
    () => document.querySelector(".collab-status")?.textContent === "Saved",
  );
  assert.match(await readFile(written.filePath!, "utf8"), /Saved to the file/);
  await page.reload();
  await page.getByRole("button", { name: "Copy file path", exact: true }).waitFor();
  await page.getByText("This review should travel with the file.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open…", exact: true }).click();
  await page.getByRole("button", { name: "Session draft", exact: true }).click();
  await input.getByRole("heading", { name: "Make something worth sharing" }).waitFor();
  assert.equal(await page.locator(".collab-card").count(), 0);
  await page.getByRole("button", { name: "Open…", exact: true }).click();
  await page.getByRole("button", { name: /session-draft.md/ }).click();
  await page.getByText("This review should travel with the file.", { exact: true }).waitFor();
  assert.match(await input.innerText(), /Saved to the file/);
  // Filename edits are explicit, not per-keystroke autosaves. Escape cancels, Enter/blur commit.
  const filename = page.getByRole("textbox", { name: "Filename", exact: true });
  await page.getByLabel("Document options", { exact: true }).click();
  await page.getByRole("button", { name: "Rename…", exact: true }).click();
  assert.equal(
    await filename.evaluate((node: HTMLInputElement) => node.selectionEnd),
    "session-draft".length,
  );
  await filename.fill("cancelled.md");
  await filename.press("Escape");
  assert.equal(await filename.inputValue(), "session-draft.md");
  assert.equal(renameRequests.length, 0);
  await writeFile(path.join(workspace, "saved", "existing.md"), "Keep this destination");
  await filename.fill("existing.md");
  await filename.press("Enter");
  await page.getByRole("alert").filter({ hasText: "already exists" }).waitFor();
  assert.equal(await filename.inputValue(), "existing.md");
  assert.equal(
    await readFile(path.join(workspace, "saved", "existing.md"), "utf8"),
    "Keep this destination",
  );
  const beforeRename = await h.read({}, agent);
  await filename.fill("a-better-name.md");
  loseRenameResponse = true;
  await filename.press("Enter");
  await page.getByRole("alert").filter({ hasText: "Rename response lost" }).waitFor();
  const renamed = await h.read({}, agent);
  assert.equal(renamed.title, "a-better-name.md");
  assert.equal(await filename.inputValue(), "a-better-name.md");
  assert.deepEqual(renamed.comments, beforeRename.comments);
  assert.deepEqual(renamed.proposals, beforeRename.proposals);
  await filename.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".collab-status")?.textContent === "File renamed",
  );
  assert.deepEqual(renameRequests[1], renameRequests[2]);
  assert.equal((await h.read({}, agent)).revision, renamed.revision);
  await assert.rejects(() => readFile(beforeRename.filePath!), { code: "ENOENT" });
  assert.equal(await readFile(renamed.filePath!, "utf8"), beforeRename.markdown);
  await page.getByRole("button", { name: "Copy file path", exact: true }).click();
  assert.equal(await page.evaluate(() => (window as any).copiedPath), renamed.filePath);
  await filename.fill("final-name.md");
  await filename.press("Tab");
  await page.waitForFunction(() =>
    document.querySelector(".collab-file-path")?.textContent?.endsWith("/final-name.md"),
  );
  await input.locator(":scope > p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" After renaming.");
  await page.waitForFunction(
    () => document.querySelector(".collab-status")?.textContent === "Saved",
  );
  assert.match(
    await readFile(path.join(workspace, "saved", "final-name.md"), "utf8"),
    /After renaming/,
  );
  await page.reload();
  await page.getByText("This review should travel with the file.", { exact: true }).waitFor();
  assert.equal(await filename.inputValue(), "final-name.md");
  await page.getByRole("button", { name: "Open…", exact: true }).click();
  await page.getByRole("button", { name: "Session draft", exact: true }).click();
  await input.getByRole("heading", { name: "Make something worth sharing" }).waitFor();
  await page.getByRole("button", { name: "Open…", exact: true }).click();
  await page.getByRole("button", { name: /final-name.md/ }).click();
  await page.getByText("This review should travel with the file.", { exact: true }).waitFor();
  assert.equal(await filename.inputValue(), "final-name.md");
  assert.match(await input.innerText(), /After renaming/);
  await page.locator(".collab").screenshot({ path: "artifacts/collab-renamed-file.png" });
  // A rename in a different view must not strand an unsaved draft at the vanished path.
  failSave = true;
  await input.locator(":scope > p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Unsaved during remote rename.");
  const remoteBase = await h.read({}, agent);
  const remote = await h.rename(
    { path: remoteBase.filePath!, name: "remote-name.md", revision: remoteBase.revision },
    ctx,
  );
  await page.evaluate(() =>
    (window as any).listeners.forEach((fn: any) => fn({ sessionKey: "ui-proof", version: 999 })),
  );
  await page.getByRole("alert").filter({ hasText: "another view" }).waitFor();
  assert.match(await input.innerText(), /Unsaved during remote rename/);
  assert.equal(
    await page.getByRole("button", { name: "Copy file path", exact: true }).innerText(),
    remote.filePath,
  );
  assert.match(
    await page.evaluate(
      (key: string) => localStorage.getItem(key),
      `collab:draft:ui-proof:${remote.filePath}`,
    ),
    /Unsaved during remote rename/,
  );
  assert.doesNotMatch(await readFile(remote.filePath!, "utf8"), /Unsaved during remote rename/);
  assert.equal(
    await page.evaluate(() => document.querySelector(".collab")!.scrollWidth > 390),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        formatDisclosure: true,
        keyboardFormattingDisclosure: true,
        selectedTextFormatting: true,
        copyFullFilePath: true,
        autoSendSavedCommentsAndReplies: true,
        failedSaveDoesNotSend: true,
        stableDeliveryRetry: true,
        deliverySurvivesReload: true,
        agentRepliesDoNotResend: true,
        selectionBubble: true,
        inlineComments: true,
        approvalWritesRealFile: true,
        workspaceSwitchHistory: true,
        liveThemeInheritance: true,
        narrowLayout: true,
        perFileDraftRecovery: true,
        saveDraftAsFile: true,
        saveAsPreservesReviewAndUnsavedEdits: true,
        saveAsRefusesOverwrite: true,
        saveAsLostResponseRetry: true,
        savedFileAutosaveAndApproval: true,
        savedFileReloadAndHistory: true,
        inlineFilenameEditing: true,
        renameCancelEnterAndBlur: true,
        renameRefusesOverwrite: true,
        renameLostResponseRetry: true,
        renamedFileHistoryAndAutosave: true,
        remoteRenamePreservesUnsavedDraft: true,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
