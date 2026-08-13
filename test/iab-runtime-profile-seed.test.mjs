import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createProfileSeeder, storageDirectoryName } = require("../iab/runtime/profile-seed.cjs");

test("maps the persistent partition to Chromium's storage directory name", () => {
  assert.equal(
    storageDirectoryName("persist:codex-browser-thread%3A01900000-0000-7000-8000-000000000001"),
    "codex-browser-thread%253a01900000-0000-7000-8000-000000000001",
  );
});

test("automatically seeds a new thread and preserves it on later opens", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-runtime-seed-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const source = path.join(root, "codex-browser-app");
  mkdirSync(source);
  writeFileSync(path.join(source, "Cookies"), "imported-app-profile");
  const seed = createProfileSeeder({ partitionsPath: root, sourceProfile: "codex-browser-app" });
  const partition = "persist:codex-browser-01900000-0000-7000-8000-000000000001";

  const first = seed(partition);
  assert.equal(first.reused, false);
  const destination = path.join(root, first.destinationProfile);
  assert.equal(readFileSync(path.join(destination, "Cookies"), "utf8"), "imported-app-profile");

  writeFileSync(path.join(destination, "Cookies"), "independent-thread-profile");
  const reopened = seed(partition);
  assert.equal(reopened.reused, true);
  assert.equal(readFileSync(path.join(destination, "Cookies"), "utf8"), "independent-thread-profile");
});

test("supports an explicitly selected source profile", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-runtime-selected-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const selected = path.join(root, "codex-browser-work");
  mkdirSync(selected);
  writeFileSync(path.join(selected, "Cookies"), "selected-profile");

  const result = createProfileSeeder({
    partitionsPath: root,
    sourceProfile: "codex-browser-work",
  })("persist:codex-browser-01900000-0000-7000-8000-000000000002");

  assert.equal(
    readFileSync(path.join(root, result.destinationProfile, "Cookies"), "utf8"),
    "selected-profile",
  );
});
