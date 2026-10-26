/** Review-only adapter, intentionally not imported by App/AuxiliaryPanel. */
import type {
  SidebarClientIdentity,
  SidebarClientPort,
  SidebarPage,
} from "../../main/experimental-sidebar-control.js";

/**
 * Actual integration must adapt AuxiliaryPanel's existing file/browser handlers,
 * preserving dirty drafts, selection epochs, Host permissions and browser target
 * ownership. This adapter neither reads paths nor navigates a browser itself.
 */
export function experimentalSidebarView<File, Tab>(ports: {
  current(): SidebarClientIdentity | null;
  pages(): readonly SidebarPage[];
  show(fullscreen?: boolean): void;
  readFile(threadId: string, path: string): Promise<File>;
  createBrowserTab(threadId: string, url: string): Promise<Tab>;
  selectFile(file: File): void;
  selectBrowserTab(tab: Tab): void;
  openPage(pageId: string): void;
}): SidebarClientPort {
  return {
    current: () => ports.current(),
    pages: () => ports.pages(),
    async dispatch(command, context) {
      context.assertCurrent();
      switch (command.action) {
        case "show":
          ports.show();
          break;
        case "set_fullscreen":
          // Sidebar content area only, never Electron/OS full-screen mode.
          ports.show(command.fullscreen);
          break;
        case "open_file": {
          const file = await ports.readFile(context.threadId, command.path);
          context.assertCurrent();
          ports.selectFile(file);
          ports.show();
          break;
        }
        case "open_website": {
          const tab = await ports.createBrowserTab(
            context.threadId,
            command.url,
          );
          // A tab may have been created even if the view was revoked while waiting.
          // Never retry, close it, or select it in another Thread automatically.
          context.assertCurrent();
          ports.selectBrowserTab(tab);
          ports.show();
          break;
        }
        case "open_page":
          if (!ports.pages().some((page) => page.id === command.pageId))
            throw new Error("Page was removed before navigation");
          ports.openPage(command.pageId);
          break;
      }
      return { status: "applied" };
    },
  };
}

/** Current registered pages and panels, never inferred names or arbitrary routes. */
export function experimentalSidebarPluginNavigation(ports: {
  snapshot(): Pick<
    import("../../main/capabilities/types.js").ZenXPluginSnapshot,
    "pages" | "panels"
  >;
  navigatePage(route: string): void;
  selectPanel(tabId: string): void;
  show(): void;
}): Pick<Parameters<typeof experimentalSidebarView>[0], "pages" | "openPage"> {
  return {
    pages: () => {
      const snapshot = ports.snapshot();
      return [
        ...snapshot.pages.map((page) => ({
          id: `page:${page.key}`,
          title: page.title,
        })),
        ...snapshot.panels.map((panel) => ({
          id: `panel:${panel.key}`,
          title: panel.title,
        })),
      ];
    },
    openPage: (id) => {
      const snapshot = ports.snapshot();
      const page = snapshot.pages.find(
        (candidate) => id === `page:${candidate.key}`,
      );
      const panel = snapshot.panels.find(
        (candidate) => id === `panel:${candidate.key}`,
      );
      if (page) ports.navigatePage(page.route);
      else if (panel) {
        // Same tab ID as App and AuxiliaryPanel use. Subagents is a panel, not
        // a separate route: panel:zenx-subagents:subagents -> this exact tab.
        ports.selectPanel(`plugin:${panel.key}`);
        ports.show();
      } else throw new Error("Page or panel is no longer registered");
    },
  };
}
