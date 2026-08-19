import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { transformRendererBundle } = require("../iab/runtime/renderer-settings-patch.cjs");

test("removes both stale-state guards from the installed renderer bundle", () => {
  const source = [
    "async updateThreadSettingsForNextTurn(e,t){let n=0}",
    "this.getConversation(e)?.latestThreadSettings===i&&this.updateConversationState(e,e=>{Ksn(e,t)})",
    "this.getConversation(e)?.latestThreadSettings===a&&this.updateConversationState(e,e=>{Ksn(e,t)})",
  ].join(";");
  const result = transformRendererBundle(source);
  assert.deepEqual(result.occurrences, [1, 1, 1]);
  assert.match(result.source, /updateThreadSettingsForNextTurn\(e,t\)\{this\.updateConversationState/);
  assert.equal(result.source.includes("latestThreadSettings==="), false);
  assert.equal(result.source.match(/this\.updateConversationState/g)?.length, 3);
});

test("fails closed when the renderer no longer matches", () => {
  assert.throws(() => transformRendererBundle("different build"), /does not match/);
});
