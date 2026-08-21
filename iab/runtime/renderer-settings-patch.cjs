const SETTINGS_GUARD_VARIANTS = [
  [
    "this.getConversation(e)?.latestThreadSettings===i&&this.updateConversationState(e,e=>{Aat(e,t)})",
    "this.getConversation(e)?.latestThreadSettings===i&&this.updateConversationState(e,e=>{Fat(e,t)})",
  ],
  [
    "this.getConversation(e)?.latestThreadSettings===a&&this.updateConversationState(e,e=>{Aat(e,t)})",
    "this.getConversation(e)?.latestThreadSettings===a&&this.updateConversationState(e,e=>{Fat(e,t)})",
  ],
];
const SETTINGS_METHOD_PREFIX = "async updateThreadSettingsForNextTurn(e,t){let n=";
const COMPOSER_SETTINGS_SOURCES = [
  "let v=ZVc(_),{modelSettings:y,selectComposerModelAndReasoningEffort:b,setModelAndReasoningEffort:x}=v,S;",
  "let v=eUc(_),{modelSettings:y,selectComposerModelAndReasoningEffort:b,setModelAndReasoningEffort:x}=v,S;",
];
const COMPOSER_SETTINGS_REPLACEMENT =
  (source) => source + "y=(()=>{try{let e=JSON.parse(localStorage.getItem(`codex-app-cli-thread-settings:${n}`)),t=e?.effort===`max`?`xhigh`:e?.effort;return e?{...y,model:e.model??y.model,reasoningEffort:t??y.reasoningEffort}:y}catch{return y}})();";
const LOAD_COMPLETE_HISTORY_PREFIX = "case`thread-follower-load-complete-history`:{let n=";
const LOAD_COMPLETE_HISTORY_PREFIX_REPLACEMENT =
  "case`thread-follower-load-complete-history`:{let u=e.getStreamRole(t.params.conversationId);u?.role===`follower`&&e.markConversationNeedsResumeForUnavailableOwner(t.params.conversationId,u.ownerClientId);await e.resumeConversationForUnavailableOwner({conversationId:t.params.conversationId,model:null,reasoningEffort:null,serviceTier:null,workspaceRoots:[e.getConversationCwd(t.params.conversationId)??`/`],collaborationMode:e.getConversation(t.params.conversationId)?.latestCollaborationMode??null});let n=";
const LOAD_COMPLETE_HISTORY_NULL_GUARD =
  "if(o==null)throw Error(`no-client-found: thread stream owner became unavailable`);return{method:t.method,result:{revision:o}}";
const LOAD_COMPLETE_HISTORY_NULL_GUARD_REPLACEMENT =
  "o??=e.getConversationStreamRevision(t.params.conversationId)??0;return{method:t.method,result:{revision:o}}";

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function transformRendererBundle(source) {
  const settingsGuards = SETTINGS_GUARD_VARIANTS.map((variants) => {
    const matches = variants.filter((needle) => countOccurrences(source, needle) === 1);
    return matches.length === 1 ? matches[0] : null;
  });
  const composerSources = COMPOSER_SETTINGS_SOURCES.filter((needle) => countOccurrences(source, needle) === 1);
  const occurrences = [
    countOccurrences(source, SETTINGS_METHOD_PREFIX),
    ...settingsGuards.map((needle) => needle == null ? 0 : 1),
    composerSources.length,
    countOccurrences(source, LOAD_COMPLETE_HISTORY_PREFIX),
    countOccurrences(source, LOAD_COMPLETE_HISTORY_NULL_GUARD),
  ];
  if (occurrences.some((count) => count !== 1)) {
    throw new Error(
      `Codex renderer settings patch does not match this App build: ${occurrences.join(",")}`,
    );
  }
  let transformed = source.replace(
    SETTINGS_METHOD_PREFIX,
    "async updateThreadSettingsForNextTurn(e,t){try{localStorage.setItem(`codex-app-cli-thread-settings:${e}`,JSON.stringify(t))}catch{}"
      + settingsGuards[0].slice(settingsGuards[0].indexOf("this.updateConversationState"))
      + ";let n=",
  );
  for (const needle of settingsGuards) {
    const replacement = needle.slice(needle.indexOf("this.updateConversationState"));
    transformed = transformed.replace(needle, replacement);
  }
  transformed = transformed.replace(
    composerSources[0],
    COMPOSER_SETTINGS_REPLACEMENT(composerSources[0]),
  );
  transformed = transformed.replace(
    LOAD_COMPLETE_HISTORY_PREFIX,
    LOAD_COMPLETE_HISTORY_PREFIX_REPLACEMENT,
  );
  transformed = transformed.replace(
    LOAD_COMPLETE_HISTORY_NULL_GUARD,
    LOAD_COMPLETE_HISTORY_NULL_GUARD_REPLACEMENT,
  );
  return { source: transformed, occurrences };
}

function installRendererSettingsPatch(webContents, log = () => {}) {
  const debuggerApi = webContents?.debugger;
  if (debuggerApi == null || debuggerApi.isAttached()) return false;
  try {
    debuggerApi.attach("1.3");
  } catch (error) {
    log({ event: "renderer-settings-debugger-attach-failed", error: String(error) });
    return false;
  }

  const onMessage = async (_event, method, params) => {
    if (method !== "Fetch.requestPaused") return;
    const { requestId, request, responseStatusCode, responseHeaders = [] } = params;
    try {
      if (!/\/assets\/app-initial-[^/]+\.js(?:\?|$)/.test(request.url) || responseStatusCode == null) {
        await debuggerApi.sendCommand("Fetch.continueRequest", { requestId });
        return;
      }
      const response = await debuggerApi.sendCommand("Fetch.getResponseBody", { requestId });
      const original = response.base64Encoded
        ? Buffer.from(response.body, "base64").toString("utf8")
        : response.body;
      const transformed = transformRendererBundle(original);
      await debuggerApi.sendCommand("Fetch.fulfillRequest", {
        requestId,
        responseCode: responseStatusCode,
        responseHeaders: responseHeaders.filter(({ name }) => name.toLowerCase() !== "content-length"),
        body: Buffer.from(transformed.source, "utf8").toString("base64"),
      });
      log({ event: "renderer-settings-patched-in-memory", url: request.url });
      await debuggerApi.sendCommand("Fetch.disable");
      debuggerApi.off("message", onMessage);
      debuggerApi.detach();
    } catch (error) {
      log({ event: "renderer-settings-patch-failed", error: String(error), url: request.url });
      try { await debuggerApi.sendCommand("Fetch.continueRequest", { requestId }); } catch {}
    }
  };
  debuggerApi.on("message", onMessage);
  debuggerApi.sendCommand("Fetch.enable", {
    patterns: [{ urlPattern: "*app-initial-*.js*", requestStage: "Response" }],
  }).catch((error) => {
    log({ event: "renderer-settings-fetch-enable-failed", error: String(error) });
  });
  return true;
}

module.exports = { installRendererSettingsPatch, transformRendererBundle };
