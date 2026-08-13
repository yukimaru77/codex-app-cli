import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isChromeProfileSource,
  listChromeProfiles,
  resolveChromeProfile,
} from "../iab/lib/chrome-profile.mjs";

test("lists real Chrome profile directories without reading browser data", (context) => {
  const root = createChromeRoot(context, {
    Default: { name: "Chrome" },
    "Profile 2": { name: "Work" },
  });
  writeFileSync(path.join(root, "Default", "Cookies"), "cookie-db");
  writeFileSync(path.join(root, "Profile 2", "Login Data"), "password-db");
  writeFileSync(path.join(root, "Profile 2", "History"), "history-db");

  assert.deepEqual(listChromeProfiles(root), [
    {
      source: "chrome:Default",
      directory: "Default",
      displayName: "Chrome",
      profilePath: path.join(root, "Default"),
      hasCookies: true,
      hasPasswords: false,
      hasHistory: false,
    },
    {
      source: "chrome:Profile 2",
      directory: "Profile 2",
      displayName: "Work",
      profilePath: path.join(root, "Profile 2"),
      hasCookies: false,
      hasPasswords: true,
      hasHistory: true,
    },
  ]);
});

test("resolves Chrome --from by directory first and then by display name", (context) => {
  const root = createChromeRoot(context, {
    Default: { name: "Personal" },
    "Profile 1": { name: "Work" },
  });

  assert.equal(resolveChromeProfile("chrome:Profile 1", root).displayName, "Work");
  assert.equal(resolveChromeProfile("chrome:Personal", root).directory, "Default");
  assert.equal(isChromeProfileSource("chrome:Default"), true);
  assert.equal(isChromeProfileSource("codex-browser-app"), false);
});

test("rejects ambiguous, missing, and path-like Chrome selectors", (context) => {
  const root = createChromeRoot(context, {
    Default: { name: "Same" },
    "Profile 1": { name: "Same" },
    "../escape": { name: "Ignored" },
  });

  assert.throws(() => resolveChromeProfile("chrome:Same", root), /ambiguous/);
  assert.throws(() => resolveChromeProfile("chrome:Missing", root), /not found/);
  assert.throws(() => resolveChromeProfile("chrome:", root), /requires/);
  assert.equal(listChromeProfiles(root).some(({ directory }) => directory === "../escape"), false);
});

test("detects the newer Network cookie path and excludes symlink profiles", (context) => {
  const root = createChromeRoot(context, {
    Default: { name: "Default" },
    "Profile 1": { name: "Linked" },
  });
  rmSync(path.join(root, "Profile 1"), { recursive: true });
  symlinkSync(path.join(root, "Default"), path.join(root, "Profile 1"));
  mkdirSync(path.join(root, "Default", "Network"));
  writeFileSync(path.join(root, "Default", "Network", "Cookies"), "cookie-db");

  const profiles = listChromeProfiles(root);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].directory, "Default");
  assert.equal(profiles[0].hasCookies, true);
});

function createChromeRoot(context, profiles) {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-chrome-profile-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  for (const directory of Object.keys(profiles)) {
    if (directory.includes("/")) continue;
    mkdirSync(path.join(root, directory), { recursive: true });
  }
  writeFileSync(
    path.join(root, "Local State"),
    JSON.stringify({ profile: { info_cache: profiles } }),
  );
  return root;
}
