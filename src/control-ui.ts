import type { ControlUiPlugin, ControlUiPanel } from "openclaw/plugin-sdk/control-ui";
// Defer editor initialization until a Collab surface is opened. The host currently publishes one browser bundle.
const mount: ControlUiPanel["mount"] = (container, context) => {
  let disposed = false;
  let current = context;
  let view: ReturnType<ControlUiPanel["mount"]>;
  const loading = document.createElement("p");
  loading.textContent = "Opening Collab…";
  loading.style.padding = "24px";
  container.append(loading);
  void import("./editor.js")
    .then(({ mountEditor }) => {
      if (disposed || context.signal.aborted) return;
      loading.remove();
      view = mountEditor(container, current);
    })
    .catch((error) => {
      if (!disposed) loading.textContent = `Could not open Collab: ${String(error)}`;
    });
  return {
    update(next) {
      current = next;
      view?.update?.(next);
    },
    focus() {
      view?.focus?.();
    },
    dispose() {
      disposed = true;
      view?.dispose?.();
      loading.remove();
    },
  };
};
export default {
  id: "collab",
  activate(host) {
    host.ui.registerPanel({ id: "document", label: "Collab", mount });
    host.ui.registerPage({
      id: "document",
      label: "Collab",
      mount(container, context) {
        const sessionKey = context.props.sessionKey || host.sessions.selectedKey;
        const agentId =
          context.props.agentId || host.agents.selectedId || host.agents.defaultId || undefined;
        if (!sessionKey) {
          container.textContent = "Open a session, then choose Collab from its side panels.";
          return;
        }
        const view = mount(container, { ...context, props: { sessionKey, agentId } });
        return {
          update(next) {
            const key = next.props.sessionKey || host.sessions.selectedKey;
            if (key)
              view?.update?.({
                ...next,
                props: {
                  sessionKey: key,
                  agentId:
                    next.props.agentId ||
                    host.agents.selectedId ||
                    host.agents.defaultId ||
                    undefined,
                },
              });
          },
          dispose: () => view?.dispose?.(),
          focus: () => view?.focus?.(),
        };
      },
    });
    host.ui.registerNavigation({
      id: "collab",
      label: "Collab",
      icon: "fileText",
      page: { id: "document" },
    });
  },
} satisfies ControlUiPlugin;
