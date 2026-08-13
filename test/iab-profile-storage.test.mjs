import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listBrowserProfiles,
  seedBrowserProfiles,
} from "../iab/lib/profile-storage.mjs";

const THREAD_A = "01900000-0000-7000-8000-000000000001";

test("lists browser profiles and seeds a thread from the selected profile", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-profile-seed-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const source = path.join(root, "codex-browser-app");
  const sourceStorage = path.join(source, "Local Storage");
  fsMkdir(sourceStorage);
  writeFileSync(path.join(source, "Cookies"), "signed-in-cookie-store");
  writeFileSync(path.join(sourceStorage, "state"), "signed-in-local-storage");

  assert.deepEqual(listBrowserProfiles(root), ["codex-browser-app"]);
  const [result] = seedBrowserProfiles({
    from: "default",
    threadIds: [THREAD_A],
    partitionsPath: root,
  });

  assert.deepEqual(result, {
    threadId: THREAD_A,
    profile: `codex-browser-${THREAD_A}`,
    source: "codex-browser-app",
    reused: false,
    backup: null,
  });
  assert.equal(
    readFileSync(path.join(root, result.profile, "Cookies"), "utf8"),
    "signed-in-cookie-store",
  );
  assert.equal(
    readFileSync(path.join(root, result.profile, "Local Storage", "state"), "utf8"),
    "signed-in-local-storage",
  );
});

test("reuses an existing thread profile so reopening does not reset it", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-profile-reuse-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  fsMkdir(path.join(root, "codex-browser-app"));
  const destination = path.join(root, `codex-browser-${THREAD_A}`);
  fsMkdir(destination);
  writeFileSync(path.join(destination, "Cookies"), "thread-cookie-store");

  const [result] = seedBrowserProfiles({
    from: "default",
    threadIds: [THREAD_A],
    partitionsPath: root,
  });

  assert.equal(result.reused, true);
  assert.equal(readFileSync(path.join(destination, "Cookies"), "utf8"), "thread-cookie-store");
});

test("replace preserves the old thread profile as a backup", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-profile-replace-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const source = path.join(root, "codex-browser-app");
  const destination = path.join(root, `codex-browser-${THREAD_A}`);
  fsMkdir(source);
  fsMkdir(destination);
  writeFileSync(path.join(source, "Cookies"), "source-cookie-store");
  writeFileSync(path.join(destination, "Cookies"), "old-thread-cookie-store");

  const [result] = seedBrowserProfiles({
    from: "codex-browser-app",
    threadIds: [THREAD_A],
    replace: true,
    partitionsPath: root,
    now: () => new Date("2026-08-12T10:00:00.000Z"),
  });

  assert.equal(result.reused, false);
  assert.equal(result.backup, `codex-browser-${THREAD_A}.backup-20260812100000000`);
  assert.equal(readFileSync(path.join(destination, "Cookies"), "utf8"), "source-cookie-store");
  assert.equal(
    readFileSync(path.join(root, result.backup, "Cookies"), "utf8"),
    "old-thread-cookie-store",
  );
});

test("rejects paths and invalid thread IDs", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-profile-invalid-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  fsMkdir(path.join(root, "codex-browser-app"));
  assert.throws(
    () => seedBrowserProfiles({ from: "../profile", threadIds: [THREAD_A], partitionsPath: root }),
    /must be a name/,
  );
  assert.throws(
    () => seedBrowserProfiles({ from: "default", threadIds: ["not-a-thread"], partitionsPath: root }),
    /invalid thread ID/,
  );
  assert.equal(existsSync(path.join(root, "codex-browser-not-a-thread")), false);
});

function fsMkdir(directory) {
  mkdirSync(directory, { recursive: true });
}
