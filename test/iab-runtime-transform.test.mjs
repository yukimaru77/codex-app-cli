import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { appAsarPath, extractText, findMainBundle, findRendererBundle } from "../iab/lib/app-inspection.mjs";

const require = createRequire(import.meta.url);
const { inspectMainBundle, transformMainBundle } = require("../iab/runtime/transform.cjs");
const { rendererPatchSource } = require("../iab/runtime/renderer-patch.cjs");
const { transformRendererBundle } = require("../iab/runtime/renderer-settings-patch.cjs");

const fixture = [
  "persist:codex-browser- browser-sidebar-manager IAB_LIFECYCLE ",
  "qB({configureBrowserSession:i,params:c,preloadPath:f,webPreferences:o}) ",
  "function qB({configureBrowserSession:e,params:t,preloadPath:n,webPreferences:r}){t.partition=es(`app`),r.session=e(),r.preload=n,YB(t,r)} ",
  "configureBrowserSession:()=>this.browserSessionService.configure(), ",
  "function IB(e){let t=e[PB]??e[`data-conversation-id`]??null,n=e[FB]??null; ",
  "let g=RB(c.partition),_=g==null?null:m.registeredWebviewHostsByRoutePartition.get(g)??null,v=IB(c),y=LB(c), ",
  "var gV=class{options;configured=!1;constructor(e){this.options=e}configure(){let e=l.session.fromPartition(es(`app`));return this.configured?e:",
  "configure-body",
  "}),this.configured=!0,e)}async clearBrowsingData",
  " function LB(e){let t=e.partition;if(typeof t!=`string`)return null;",
  " l=e.o(l);let d=require(\"node:os\")",
].join("");

test("rewrites only IAB session selection to use the conversation ID", () => {
  const result = transformMainBundle(fixture);
  assert.equal(result.changed, true);
  assert.match(result.source, /conversationId:O\.conversationId/);
  assert.match(result.source, /t\.partition=es\(o\),r\.session=e\(o\)/);
  assert.match(result.source, /configureBrowserSession:e=>this\.browserSessionService\.configure\(e\)/);
  assert.match(result.source, /configured=new Set/);
  assert.match(result.source, /__codexIabSeedProfile/);
  assert.match(result.source, /fromPartition\(es\(t\)\)/);
  assert.match(result.source, /configured\.add\(t\)/);
  assert.match(result.source, /__codexIabInstallChromeProfileImport/);
  assert.match(result.source, /__codexIabInstallTrustedServicePathHooks/);
  assert.match(result.source, /data-codex-iab-renderer-instance-id/);
  assert.match(result.source, /#codex-iab-thread-profile:/);
  assert.match(result.source, /let v=IB\(c\),g=v==null\?RB\(c\.partition\):Le\(v\.conversationId,v\.browserTabId\)/);
  assert.match(result.source, /y=LB\(c\)/);
  assert.doesNotMatch(result.source, /PB\(c\)/);
  assert.doesNotMatch(result.source, /FB\(c\)/);
  assert.match(result.source, /Le\(v\.conversationId,v\.browserTabId\)/);
  assert.doesNotMatch(result.source, /t\.partition=es\(`app`\)/);
});

test("leaves unrelated JavaScript unchanged", () => {
  const result = transformMainBundle("module.exports = 1");
  assert.equal(result.changed, false);
  assert.equal(result.source, "module.exports = 1");
});

test("fails closed when a target App bundle no longer matches", () => {
  assert.throws(
    () => transformMainBundle("IAB_LIFECYCLE persist:codex-browser- browser-sidebar-manager"),
    /does not match this App build/,
  );
});

test("installed App main bundle matches the runtime patch", () => {
  const asarPath = appAsarPath("/Applications/ChatGPT.app");
  const source = extractText(asarPath, findMainBundle(asarPath));
  const inspection = inspectMainBundle(source);
  assert.equal(inspection.isTargetBundle, true);
  assert.deepEqual(
    inspection.patches.map(({ occurrences }) => occurrences),
    [1, 1, 1, 1, 1, 1, 1, 1, 1],
  );
  assert.equal(transformMainBundle(source).changed, true);
});

test("installed App renderer settings patch fail-closes on the current bundle", () => {
  const asarPath = appAsarPath("/Applications/ChatGPT.app");
  const source = extractText(asarPath, findRendererBundle(asarPath));
  assert.throws(
    () => transformRendererBundle(source),
    /does not match this App build/,
  );
});

test("persists forwarded thread settings from the auxiliary main-process chunk", () => {
  const result = transformMainBundle("async function fce(e,t,n,r){let i=0}");
  assert.equal(result.changed, true);
  assert.match(result.source, /codex-app-cli-thread-settings/);
  assert.match(result.source, /webContents\.getAllWebContents/);
});

test("lets a follower view receive a turn so the App can resume an unavailable owner", () => {
  const source = "i=async({conversationId:t},r=b9)=>await C9(n.getThreadRole({hostId:e,conversationId:t}),r,`thread-role-timeout`)===`owner`,";
  const result = transformMainBundle(source);
  assert.equal(result.changed, true);
  assert.match(result.source, /i=async\(\)=>!0/);
});

test("renderer hook replaces route metadata with a stable per-thread partition", () => {
  const originalSetAttribute = function setAttribute(name, value) {
    this.attributes.set(name, String(value));
  };
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.attributes = new Map();
    }
  }
  FakeElement.prototype.setAttribute = originalSetAttribute;
  const install = new Function("Element", `return ${rendererPatchSource()}`);
  assert.equal(install(FakeElement), true);

  const webview = new FakeElement("WEBVIEW");
  const conversationId = "01900000-0000-7000-8000-000000000001";
  const browserTabId = "tab-1";
  const route = encodeURIComponent(`${conversationId}\0${browserTabId}`);
  webview.setAttribute(
    "partition",
    `persist:codex-browser-app-route:${route}:host:renderer-a:3`,
  );
  assert.equal(
    webview.attributes.get("partition"),
    `persist:codex-browser-${encodeURIComponent(conversationId)}`,
  );
  assert.equal(webview.attributes.get("data-codex-iab-renderer-instance-id"), "renderer-a");
  assert.equal(webview.attributes.get("data-codex-iab-host-generation"), "3");
  webview.setAttribute("src", "about:blank");
  const encodedMetadata = encodeURIComponent([
    conversationId,
    browserTabId,
    "renderer-a",
    "3",
  ].join("\0"));
  assert.equal(
    webview.attributes.get("src"),
    `#codex-iab-thread-profile:${encodedMetadata}`,
  );
});
