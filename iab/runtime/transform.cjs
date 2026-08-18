const { rendererPatchSource } = require("./renderer-patch.cjs");

const ATTACH_CALL =
  "UB({configureBrowserSession:r,params:s,preloadPath:d,webPreferences:a})";
const ATTACH_CALL_REPLACEMENT =
  "UB({configureBrowserSession:r,conversationId:D.conversationId,params:s,preloadPath:d,webPreferences:a})";

const CONFIGURE_WEBVIEW =
  "function UB({configureBrowserSession:e,params:t,preloadPath:n,webPreferences:r}){t.partition=is(`app`),r.session=e(),r.preload=n,GB(t,r)}";
const CONFIGURE_WEBVIEW_REPLACEMENT =
  "function UB({configureBrowserSession:e,conversationId:o,params:t,preloadPath:n,webPreferences:r}){t.partition=is(o),r.session=e(o),r.preload=n,GB(t,r)}";

const CONFIGURE_SESSION_CALLBACK =
  "configureBrowserSession:()=>this.browserSessionService.configure(),";
const CONFIGURE_SESSION_CALLBACK_REPLACEMENT =
  "configureBrowserSession:e=>this.browserSessionService.configure(e),";

const ROUTE_PARSER_PREFIX =
  "function MB(e){let t=e[AB]??e[`data-conversation-id`]??null,n=e[jB]??null;";
const ROUTE_PARSER_PREFIX_REPLACEMENT =
  "function MB(e){let c=e.src,m=`#codex-iab-thread-profile:`,d=typeof c==`string`?c.indexOf(m):-1;if(d>=0)try{let[t,n]=decodeURIComponent(c.slice(d+m.length)).split(`\\0`);if(t?.length>0&&n?.length>0)return{browserTabId:ue(n),conversationId:t}}catch{}let t=e[AB]??e[`data-conversation-id`]??null,n=e[jB]??null;";

const REGISTERED_ROUTE_LOOKUP =
  "let h=PB(s.partition),g=h==null?null:p.registeredWebviewHostsByRoutePartition.get(h)??null,_=MB(s),v=NB(s),";
const REGISTERED_ROUTE_LOOKUP_REPLACEMENT =
  "let _=MB(s),h=_==null?PB(s.partition):Ve(_.conversationId,_.browserTabId),g=h==null?null:p.registeredWebviewHostsByRoutePartition.get(h)??null,v=NB(s),";

const SESSION_SERVICE_PREFIX =
  "var fV=class{options;configured=!1;constructor(e){this.options=e}configure(){let e=l.session.fromPartition(is(`app`));return this.configured?e:";
const SESSION_SERVICE_PREFIX_REPLACEMENT =
  "var fV=class{options;configured=new Set;constructor(e){this.options=e}configure(t=`app`){let e=(globalThis.__codexIabSeedProfile?.(is(t)),l.session.fromPartition(is(t)));return this.configured.has(t)?e:";

const SESSION_SERVICE_SUFFIX =
  "}),this.configured=!0,e)}async clearBrowsingData";
const SESSION_SERVICE_SUFFIX_REPLACEMENT =
  "}),this.configured.add(t),e)}async clearBrowsingData";

const HOST_METADATA_PREFIX =
  "function NB(e){let t=e.partition;if(typeof t!=`string`)return null;";
const HOST_METADATA_PREFIX_REPLACEMENT =
  "function NB(e){let u=e.src,m=`#codex-iab-thread-profile:`,d=typeof u==`string`?u.indexOf(m):-1;if(d>=0)try{let[,,c,l]=decodeURIComponent(u.slice(d+m.length)).split(`\\0`),h=Number(l);if(c?.length>0&&Number.isInteger(h)&&h>0)return{hostGeneration:h,rendererInstanceId:c}}catch{}let c=e[`data-codex-iab-renderer-instance-id`],l=Number(e[`data-codex-iab-host-generation`]);if(typeof c==`string`&&c.length>0&&Number.isInteger(l)&&l>0)return{hostGeneration:l,rendererInstanceId:c};let t=e.partition;if(typeof t!=`string`)return null;";

const ELECTRON_IMPORT_SUFFIX =
  "l=e.o(l);let d=require(\"node:os\")";
const ELECTRON_IMPORT_SUFFIX_REPLACEMENT =
  `l=e.o(l);globalThis.__codexIabInstallChromeProfileImport?.(l);l.app.on(\`web-contents-created\`,(e,t)=>{t.on(\`dom-ready\`,()=>{t.executeJavaScript(${JSON.stringify(rendererPatchSource())},!0).then(e=>{e&&globalThis.__codexIabRuntimeLog?.({event:\`renderer-partition-hook-installed\`,webContentsId:t.id})}).catch(e=>{globalThis.__codexIabRuntimeLog?.({event:\`renderer-partition-hook-failed\`,error:e instanceof Error?e.message:String(e),webContentsId:t.id})})})});let d=require(\"node:os\")`;

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
  if (!inspection.isTargetBundle) {
    return { changed: false, inspection, source };
  }

  const invalid = inspection.patches.filter((patch) => patch.occurrences !== 1);
  if (invalid.length > 0) {
    throw new Error(
      `Codex IAB runtime patch does not match this App build: ${invalid
        .map((patch) => `${patch.description}=${patch.occurrences}`)
        .join(", ")}`,
    );
  }

  let transformed = source;
  for (const [needle, replacement] of PATCHES) {
    transformed = transformed.replace(needle, replacement);
  }
  return { changed: true, inspection, source: transformed };
}

module.exports = {
  inspectMainBundle,
  transformMainBundle,
};
