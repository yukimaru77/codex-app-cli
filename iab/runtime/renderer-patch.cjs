function rendererPatchSource() {
  return String.raw`(() => {
    const marker = Symbol.for("codex.iab.threadProfiles.setAttribute");
    const prototype = Element.prototype;
    if (prototype[marker]) return false;

    const originalSetAttribute = prototype.setAttribute;
    const routePrefix = "persist:codex-browser-app-route:";
    const hostMarker = ":host:";
    const sourceMarker = "#codex-iab-thread-profile:";
    const routeByWebview = new WeakMap();

    function parseRoutePartition(value) {
      if (typeof value !== "string" || !value.startsWith(routePrefix)) return null;
      const hostIndex = value.lastIndexOf(hostMarker);
      if (hostIndex < routePrefix.length) return null;
      const encodedRoute = value.slice(routePrefix.length, hostIndex);
      const host = value.slice(hostIndex + hostMarker.length);
      const separator = host.lastIndexOf(":");
      if (separator < 1) return null;
      const rendererInstanceId = host.slice(0, separator);
      const hostGeneration = Number(host.slice(separator + 1));
      if (!Number.isInteger(hostGeneration) || hostGeneration <= 0) return null;
      let browserTabId;
      let conversationId;
      try {
        [conversationId, browserTabId] = decodeURIComponent(encodedRoute).split("\0");
      } catch {
        return null;
      }
      if (!conversationId || !browserTabId) return null;
      return {
        browserTabId,
        conversationId,
        hostGeneration,
        rendererInstanceId,
        partition: "persist:codex-browser-" + encodeURIComponent(conversationId),
      };
    }

    prototype.setAttribute = function setAttributeWithThreadProfile(name, value) {
      if (this.tagName === "WEBVIEW" && name === "partition") {
        const route = parseRoutePartition(value);
        if (route != null) {
          routeByWebview.set(this, route);
          originalSetAttribute.call(
            this,
            "data-codex-iab-renderer-instance-id",
            route.rendererInstanceId,
          );
          originalSetAttribute.call(
            this,
            "data-codex-iab-host-generation",
            String(route.hostGeneration),
          );
          value = route.partition;
        }
      } else if (this.tagName === "WEBVIEW" && name === "src" && value === "about:blank") {
        const route = routeByWebview.get(this);
        if (route != null) {
          value = sourceMarker + encodeURIComponent([
            route.conversationId,
            route.browserTabId,
            route.rendererInstanceId,
            route.hostGeneration,
          ].join("\0"));
        }
      }
      return originalSetAttribute.call(this, name, value);
    };
    Object.defineProperty(prototype, marker, { value: true });
    return true;
  })()`;
}

module.exports = { rendererPatchSource };
