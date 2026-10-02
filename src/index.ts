import path from "node:path";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { contract } from "./contract.js";
import { DocumentStore } from "./store.js";
import { createHandlers } from "./service.js";
export default defineFeaturePlugin({
  contract,
  name: "Collab",
  description:
    "Write together. A fast Markdown editor with anchored comments and human-approved agent suggestions.",
  setup(api, events) {
    const store = new DocumentStore(path.join(resolveStateDir(), "collab", "documents"));
    return createHandlers(store, (doc) => {
      try {
        events.emit("changed", { sessionKey: doc.sessionKey, version: doc.version });
      } catch (error) {
        api.logger.warn(`Collab update notification unavailable: ${String(error)}`);
      }
    });
  },
});
