export type ConsolePage = "overview" | "channels" | "keys" | "routing" | "playground" | "requests" | "analytics" | "settings";
export type ConsoleRoute = { page: ConsolePage; settingsTab: "connection" | "routing" };

const pages = new Set<ConsolePage>(["overview", "channels", "keys", "playground", "requests", "analytics", "settings"]);

export function readConsoleRoute(hash = window.location.hash): ConsoleRoute {
  const [name, tab] = hash.replace(/^#\/?/, "").split("/");
  if (name === "routing") return { page: "settings", settingsTab: "routing" };
  return { page: pages.has(name as ConsolePage) ? name as ConsolePage : "overview", settingsTab: tab === "routing" ? "routing" : "connection" };
}

export function consoleRouteHash(page: ConsolePage, settingsTab = "connection"): string {
  return page === "routing" ? "#settings/routing" : page === "settings" ? `#settings/${settingsTab}` : `#${page}`;
}
