import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { transformRendererBundle } = require("../iab/runtime/renderer-settings-patch.cjs");

test("removes both stale-state guards from the installed renderer bundle", () => {
  const source = [
    "async updateThreadSettingsForNextTurn(e,t){let n=0}",
    "this.getConversation(e)?.latestThreadSettings===i&&this.updateConversationState(e,e=>{Aat(e,t)})",
    "this.getConversation(e)?.latestThreadSettings===a&&this.updateConversationState(e,e=>{Aat(e,t)})",
    "let v=ZVc(_),{modelSettings:y,selectComposerModelAndReasoningEffort:b,setModelAndReasoningEffort:x}=v,S;",
    "case`thread-follower-load-complete-history`:{let n=0}",
    "if(o==null)throw Error(`no-client-found: thread stream owner became unavailable`);return{method:t.method,result:{revision:o}}",
  ].join(";");
  const result = transformRendererBundle(source);
  assert.deepEqual(result.occurrences, [1, 1, 1, 1, 1, 1]);
  assert.match(result.source, /localStorage\.setItem\(`codex-app-cli-thread-settings:/);
  assert.match(result.source, /localStorage\.getItem\(`codex-app-cli-thread-settings:/);
  assert.match(result.source, /e\?\.effort===`max`\?`xhigh`/);
  assert.equal(result.source.includes("latestThreadSettings==="), false);
  assert.equal(result.source.match(/this\.updateConversationState/g)?.length, 3);
  assert.match(result.source, /await e\.resumeConversationForUnavailableOwner/);
  assert.match(result.source, /markConversationNeedsResumeForUnavailableOwner/);
  assert.doesNotMatch(result.source, /if\(o==null\)throw Error/);
});

test("fails closed when the renderer no longer matches", () => {
  assert.throws(() => transformRendererBundle("different build"), /does not match/);
});
