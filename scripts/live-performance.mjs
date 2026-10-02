import { createRequire } from "node:module";
import fs from "node:fs/promises";
const require = createRequire(new URL("../node_modules/openclaw/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const browser = await chromium.connectOverCDP(
  process.env.COLLAB_CDP_URL || "http://127.0.0.1:18804",
);
try {
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes("collab-verification"));
  if (!page) throw new Error("Open the dedicated Collab verification session first.");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const saves = [];
  cdp.on("Network.webSocketFrameSent", (e) => {
    try {
      const p = JSON.parse(e.response.payloadData);
      if (
        p.method === "plugins.sessionAction" &&
        p.params?.pluginId === "collab" &&
        p.params?.actionId === "save"
      )
        saves.push(performance.now());
    } catch {}
  });
  const before = await page.locator(".collab .tiptap").innerText();
  await page.evaluate(() => {
    window.__collabEditor = document.querySelector(".collab .tiptap");
    window.__collabLatency = [];
    window.__collabEditor.addEventListener("beforeinput", () => {
      const start = performance.now();
      requestAnimationFrame(() => window.__collabLatency.push(performance.now() - start));
    });
  });
  const input = page.locator(".collab .tiptap");
  await input.click();
  await input.press("ControlOrMeta+End");
  const text = " Responsiveness check.";
  await input.pressSequentially(text, { delay: 3 });
  const whileTyping = saves.length;
  await page.waitForFunction(
    () => document.querySelector(".collab-status")?.textContent === "Saved",
    {},
    { timeout: 10000 },
  );
  const afterBurst = saves.length;
  const stats = await page.evaluate(() => {
    const a = window.__collabLatency.slice().sort((a, b) => a - b);
    return {
      samples: a.length,
      p50InputToFrameMs: a[Math.floor(a.length * 0.5)],
      p95InputToFrameMs: a[Math.floor(a.length * 0.95)],
      sameEditor: window.__collabEditor === document.querySelector(".collab .tiptap"),
    };
  });
  await input.press("ControlOrMeta+z");
  await page.waitForFunction(
    () => document.querySelector(".collab-status")?.textContent === "Saved",
    {},
    { timeout: 10000 },
  );
  const after = await input.innerText();
  if (after !== before) throw new Error("Undo did not restore the test draft.");
  if (whileTyping !== 0 || afterBurst !== 1 || !stats.sameEditor)
    throw new Error("Typing/saving behavior violated the performance contract.");
  const result = {
    ...stats,
    typedCharacters: text.length,
    savesDuringTyping: whileTyping,
    savesAfterPause: afterBurst,
    restoredOriginal: true,
  };
  await fs.mkdir("artifacts", { recursive: true });
  await fs.writeFile("artifacts/browser-performance.json", JSON.stringify(result, null, 2));
  await page.locator(".collab").screenshot({ path: "artifacts/collab-live-panel.png" });
  console.log(JSON.stringify(result, null, 2));
  await cdp.detach();
} finally {
  await browser.close();
}
