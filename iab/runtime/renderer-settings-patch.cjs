const SETTINGS_GUARDS = [
  "this.getConversation(e)?.latestThreadSettings===i&&this.updateConversationState(e,e=>{Ksn(e,t)})",
  "this.getConversation(e)?.latestThreadSettings===a&&this.updateConversationState(e,e=>{Ksn(e,t)})",
];
const SETTINGS_METHOD_PREFIX = "async updateThreadSettingsForNextTurn(e,t){let n=";
const SETTINGS_METHOD_PREFIX_REPLACEMENT =
  "async updateThreadSettingsForNextTurn(e,t){try{localStorage.setItem(`codex-app-cli-thread-settings:${e}`,JSON.stringify(t))}catch{}this.updateConversationState(e,e=>{Ksn(e,t)});let n=";
const COMPOSER_SETTINGS_SOURCE =
  "let v=OOc(_),{modelSettings:y,selectComposerModelAndReasoningEffort:b,setModelAndReasoningEffort:x}=v,S;";
const COMPOSER_SETTINGS_REPLACEMENT =
  "let v=OOc(_),{modelSettings:y,selectComposerModelAndReasoningEffort:b,setModelAndReasoningEffort:x}=v,S;y=(()=>{try{let e=JSON.parse(localStorage.getItem(`codex-app-cli-thread-settings:${n}`)),t=e?.effort===`max`?`xhigh`:e?.effort;return e?{...y,model:e.model??y.model,reasoningEffort:t??y.reasoningEffort}:y}catch{return y}})();";

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function transformRendererBundle(source) {
  const occurrences = [
    countOccurrences(source, SETTINGS_METHOD_PREFIX),
    ...SETTINGS_GUARDS.map((needle) => countOccurrences(source, needle)),
    countOccurrences(source, COMPOSER_SETTINGS_SOURCE),
  ];
  if (occurrences.some((count) => count !== 1)) {
    throw new Error(
      `Codex renderer settings patch does not match this App build: ${occurrences.join(",")}`,
    );
  }
  let transformed = source.replace(
    SETTINGS_METHOD_PREFIX,
    SETTINGS_METHOD_PREFIX_REPLACEMENT,
  );
  for (const needle of SETTINGS_GUARDS) {
    const replacement = needle.slice(needle.indexOf("this.updateConversationState"));
    transformed = transformed.replace(needle, replacement);
  }
  transformed = transformed.replace(
    COMPOSER_SETTINGS_SOURCE,
    COMPOSER_SETTINGS_REPLACEMENT,
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
