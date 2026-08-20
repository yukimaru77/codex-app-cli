const { rendererPatchSource } = require("./renderer-patch.cjs");

const ATTACH_CALL =
  "qB({configureBrowserSession:i,params:c,preloadPath:f,webPreferences:o})";
const ATTACH_CALL_REPLACEMENT =
  "qB({configureBrowserSession:i,conversationId:O.conversationId,params:c,preloadPath:f,webPreferences:o})";

const CONFIGURE_WEBVIEW =
  "function qB({configureBrowserSession:e,params:t,preloadPath:n,webPreferences:r}){t.partition=es(`app`),r.session=e(),r.preload=n,YB(t,r)}";
const CONFIGURE_WEBVIEW_REPLACEMENT =
  "function qB({configureBrowserSession:e,conversationId:o,params:t,preloadPath:n,webPreferences:r}){t.partition=es(o),r.session=e(o),r.preload=n,YB(t,r)}";

const CONFIGURE_SESSION_CALLBACK =
  "configureBrowserSession:()=>this.browserSessionService.configure(),";
const CONFIGURE_SESSION_CALLBACK_REPLACEMENT =
  "configureBrowserSession:e=>this.browserSessionService.configure(e),";

const ROUTE_PARSER_PREFIX =
  "function IB(e){let t=e[PB]??e[`data-conversation-id`]??null,n=e[FB]??null;";
const ROUTE_PARSER_PREFIX_REPLACEMENT =
  "function IB(e){let c=e.src,m=`#codex-iab-thread-profile:`,d=typeof c==`string`?c.indexOf(m):-1;if(d>=0)try{let[t,n]=decodeURIComponent(c.slice(d+m.length)).split(`\\0`);if(t?.length>0&&n?.length>0)return{browserTabId:se(n),conversationId:t}}catch{}let t=e[PB]??e[`data-conversation-id`]??null,n=e[FB]??null;";

const REGISTERED_ROUTE_LOOKUP =
  "let g=RB(c.partition),_=g==null?null:m.registeredWebviewHostsByRoutePartition.get(g)??null,v=IB(c),y=LB(c),";
const REGISTERED_ROUTE_LOOKUP_REPLACEMENT =
  "let v=IB(c),g=v==null?RB(c.partition):Le(v.conversationId,v.browserTabId),_=g==null?null:m.registeredWebviewHostsByRoutePartition.get(g)??null,y=LB(c),";

const SESSION_SERVICE_PREFIX =
  "var gV=class{options;configured=!1;constructor(e){this.options=e}configure(){let e=l.session.fromPartition(es(`app`));return this.configured?e:";
const SESSION_SERVICE_PREFIX_REPLACEMENT =
  "var gV=class{options;configured=new Set;constructor(e){this.options=e}configure(t=`app`){let e=(globalThis.__codexIabSeedProfile?.(es(t)),l.session.fromPartition(es(t)));return this.configured.has(t)?e:";

const SESSION_SERVICE_SUFFIX =
  "}),this.configured=!0,e)}async clearBrowsingData";
const SESSION_SERVICE_SUFFIX_REPLACEMENT =
  "}),this.configured.add(t),e)}async clearBrowsingData";

const HOST_METADATA_PREFIX =
  "function LB(e){let t=e.partition;if(typeof t!=`string`)return null;";
const HOST_METADATA_PREFIX_REPLACEMENT =
  "function LB(e){let u=e.src,m=`#codex-iab-thread-profile:`,d=typeof u==`string`?u.indexOf(m):-1;if(d>=0)try{let[,,c,l]=decodeURIComponent(u.slice(d+m.length)).split(`\\0`),h=Number(l);if(c?.length>0&&Number.isInteger(h)&&h>0)return{hostGeneration:h,rendererInstanceId:c}}catch{}let c=e[`data-codex-iab-renderer-instance-id`],l=Number(e[`data-codex-iab-host-generation`]);if(typeof c==`string`&&c.length>0&&Number.isInteger(l)&&l>0)return{hostGeneration:l,rendererInstanceId:c};let t=e.partition;if(typeof t!=`string`)return null;";

const ELECTRON_IMPORT_SUFFIX =
  "l=e.o(l);let d=require(\"node:os\")";
const ELECTRON_IMPORT_SUFFIX_REPLACEMENT =
  `l=e.o(l);globalThis.__codexIabInstallChromeProfileImport?.(l);l.app.on(\`web-contents-created\`,(e,t)=>{globalThis.__codexInstallRendererSettingsPatch?.(t);t.on(\`dom-ready\`,()=>{t.executeJavaScript(${JSON.stringify(rendererPatchSource())},!0).then(e=>{e&&globalThis.__codexIabRuntimeLog?.({event:\`renderer-partition-hook-installed\`,webContentsId:t.id})}).catch(e=>{globalThis.__codexIabRuntimeLog?.({event:\`renderer-partition-hook-failed\`,error:e instanceof Error?e.message:String(e),webContentsId:t.id})})})});let d=require(\"node:os\")`;

const FOLLOWER_SETTINGS_FORWARD = "async function fce(e,t,n,r){let i=";
const FOLLOWER_SETTINGS_FORWARD_REPLACEMENT =
  "async function fce(e,t,n,r){if(n.method===`thread-follower-update-thread-settings`){let e=JSON.stringify(`codex-app-cli-thread-settings:${n.params.conversationId}`),t=JSON.stringify(JSON.stringify(n.params.threadSettings)),r=`try{localStorage.setItem(${e},${t})}catch{}`;await Promise.allSettled(require(`electron`).webContents.getAllWebContents().map(e=>e.executeJavaScript(r,!0)))}let i=";

const FOLLOWER_HANDLER_OWNER_CHECK =
  "i=async({conversationId:t},r=b9)=>await C9(n.getThreadRole({hostId:e,conversationId:t}),r,`thread-role-timeout`)===`owner`,";
const FOLLOWER_HANDLER_OWNER_CHECK_REPLACEMENT =
  "i=async()=>!0,";

const PATCHES = [
  [ATTACH_CALL, ATTACH_CALL_REPLACEMENT, "thread route passed to browser session"],
  [CONFIGURE_WEBVIEW, CONFIGURE_WEBVIEW_REPLACEMENT, "thread partition assigned to webview"],
  [CONFIGURE_SESSION_CALLBACK, CONFIGURE_SESSION_CALLBACK_REPLACEMENT, "thread route forwarded to browser session service"],
  [ROUTE_PARSER_PREFIX, ROUTE_PARSER_PREFIX_REPLACEMENT, "stable partition route metadata accepted"],
  [REGISTERED_ROUTE_LOOKUP, REGISTERED_ROUTE_LOOKUP_REPLACEMENT, "registered route recovered for stable partition"],
  [SESSION_SERVICE_PREFIX, SESSION_SERVICE_PREFIX_REPLACEMENT, "browser session service keyed by thread"],
  [SESSION_SERVICE_SUFFIX, SESSION_SERVICE_SUFFIX_REPLACEMENT, "configured thread session recorded"],
  [HOST_METADATA_PREFIX, HOST_METADATA_PREFIX_REPLACEMENT, "stable partition host metadata accepted"],
  [ELECTRON_IMPORT_SUFFIX, ELECTRON_IMPORT_SUFFIX_REPLACEMENT, "renderer partition hook registered"],
];

function countOccurrences(source, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function inspectMainBundle(source) {
  return {
    isTargetBundle:
      source.includes("IAB_LIFECYCLE") &&
      source.includes("persist:codex-browser-") &&
      source.includes("browser-sidebar-manager"),
    patches: PATCHES.map(([needle, , description]) => ({
      description,
      occurrences: countOccurrences(source, needle),
    })),
  };
}

function transformMainBundle(source) {
  const inspection = inspectMainBundle(source);
  const followerSettingsOccurrences = countOccurrences(source, FOLLOWER_SETTINGS_FORWARD);
  const followerHandlerOccurrences = countOccurrences(source, FOLLOWER_HANDLER_OWNER_CHECK);
  if (!inspection.isTargetBundle && followerSettingsOccurrences === 0 && followerHandlerOccurrences === 0) {
    return { changed: false, inspection, source };
  }

  const invalid = inspection.isTargetBundle
    ? inspection.patches.filter((patch) => patch.occurrences !== 1)
    : [];
  if (invalid.length > 0 || followerSettingsOccurrences > 1 || followerHandlerOccurrences > 1) {
    throw new Error(
      `Codex IAB runtime patch does not match this App build: ${invalid
        .map((patch) => `${patch.description}=${patch.occurrences}`)
        .concat(followerSettingsOccurrences > 1
          ? [`thread settings persisted in app renderers=${followerSettingsOccurrences}`]
          : [])
        .concat(followerHandlerOccurrences > 1
          ? [`follower handler owner check=${followerHandlerOccurrences}`]
          : [])
        .join(", ")}`,
    );
  }

  let transformed = source;
  if (inspection.isTargetBundle) {
    for (const [needle, replacement] of PATCHES) {
      transformed = transformed.replace(needle, replacement);
    }
  }
  if (followerSettingsOccurrences === 1) {
    transformed = transformed.replace(FOLLOWER_SETTINGS_FORWARD, FOLLOWER_SETTINGS_FORWARD_REPLACEMENT);
  }
  if (followerHandlerOccurrences === 1) {
    transformed = transformed.replace(FOLLOWER_HANDLER_OWNER_CHECK, FOLLOWER_HANDLER_OWNER_CHECK_REPLACEMENT);
  }
  return { changed: true, inspection, source: transformed };
}

module.exports = {
  inspectMainBundle,
  transformMainBundle,
};
