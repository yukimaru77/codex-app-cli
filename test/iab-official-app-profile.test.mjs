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
import { inspectSignedOfficialApp } from "../iab/lib/official-app-profile.mjs";
import {
  buildRuntimeOpenArguments,
  createChromeImportRequest,
  encodeChromeImportRequest,
  findAppMainProcesses,
  isolateAppBrowserProfile,
  openAppWithRetry,
  readRuntimeEvents,
  requestAppQuitWithFallback,
  requestAppQuitWithRetry,
  snapshotImportedChromeProfile,
} from "../iab/lib/runtime-launcher.mjs";

test("isolates and restores the fixed App profile around a Chrome import", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-import-isolation-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const appProfile = path.join(root, "codex-browser-app");
  mkdirSync(appProfile);
  writeFileSync(path.join(appProfile, "Cookies"), "original-cookies");

  const isolation = isolateAppBrowserProfile({ partitionsPath: root, nonce: "test" });
  assert.equal(existsSync(path.join(isolation.backupPath, "Cookies")), true);
  writeFileSync(path.join(appProfile, "Cookies"), "imported-cookies");
  isolation.restore();

  assert.equal(readFileSync(path.join(appProfile, "Cookies"), "utf8"), "original-cookies");
  assert.equal(existsSync(isolation.backupPath), false);
});

test("restores the fixed App profile only once after import failure cleanup", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-import-cleanup-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const isolation = isolateAppBrowserProfile({ partitionsPath: root, nonce: "test" });
  writeFileSync(path.join(isolation.appProfilePath, "Cookies"), "partial-import");

  isolation.restore();
  isolation.restore();

  assert.equal(existsSync(isolation.appProfilePath), true);
  assert.equal(existsSync(path.join(isolation.appProfilePath, "Cookies")), false);
});

test("builds an in-memory runtime launch for the unmodified official app", () => {
  assert.deepEqual(buildRuntimeOpenArguments({
    appPath: "/Applications/ChatGPT.app",
    preloadPath: "/tmp/iab/preload.cjs",
    logPath: "/tmp/iab/runtime.jsonl",
  }), [
    "--env",
    "NODE_OPTIONS=--require=/tmp/iab/preload.cjs",
    "--env",
    "CODEX_IAB_RUNTIME_LOG=/tmp/iab/runtime.jsonl",
    "--env",
    "CODEX_IAB_SEED_PROFILE=codex-browser-app",
    "--env",
    `CODEX_IAB_PARTITIONS_PATH=${path.join(os.homedir(), "Library", "Application Support", "Codex", "Default", "Partitions")}`,
    "-a",
    "/Applications/ChatGPT.app",
  ]);
});

test("retries the transient Launch Services -600 error", () => {
  const results = [
    { status: 1, stdout: "", stderr: "_LSOpenURLsWithCompletionHandler() failed with error -600." },
    { status: 0, stdout: "", stderr: "" },
  ];
  const calls = [];
  const result = openAppWithRetry(
    (command, args) => {
      calls.push([command, args]);
      return results.shift();
    },
    ["-a", "/Applications/ChatGPT.app"],
    { label: "App launch", timeoutMs: 1_000 },
  );
  assert.equal(result.status, 0);
  assert.equal(calls.length, 2);
});

test("retries the transient App quit cancellation", () => {
  const results = [
    { status: 1, stdout: "", stderr: "execution error: cancelled. (-128)" },
    { status: 0, stdout: "", stderr: "" },
  ];
  const calls = [];
  const result = requestAppQuitWithRetry(
    (command, args, options) => {
      calls.push([command, args, options]);
      return results.shift();
    },
    Date.now() + 1_000,
  );
  assert.equal(result.status, 0);
  assert.equal(calls.length, 2);
});

test("falls back to TERM when the App repeatedly cancels quit", () => {
  const calls = [];
  const result = requestAppQuitWithFallback(
    (command, args) => {
      calls.push([command, args]);
      if (command === "/usr/bin/osascript") {
        return { status: 1, stdout: "", stderr: "execution error: cancelled. (-128)" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    [123, 456],
    Date.now(),
  );
  assert.deepEqual(result, { status: 0, fallback: "SIGTERM" });
  assert.deepEqual(calls.slice(-2), [
    ["/bin/kill", ["-TERM", "123"]],
    ["/bin/kill", ["-TERM", "456"]],
  ]);
});

test("builds an import-only launch using an encoded Chrome profile request", (context) => {
  const chromeRoot = mkdtempSync(path.join(os.tmpdir(), "codex-iab-launch-chrome-"));
  context.after(() => rmSync(chromeRoot, { force: true, recursive: true }));
  const profilePath = path.join(chromeRoot, "Profile 1");
  mkdirSync(profilePath, { recursive: true });
  writeFileSync(
    path.join(chromeRoot, "Local State"),
    JSON.stringify({ profile: { info_cache: { "Profile 1": { name: "Work" } } } }),
  );
  const prepared = createChromeImportRequest("chrome:Work", {
    chromeRoot,
    requestId: "01900000-0000-7000-8000-000000000001",
  });

  assert.equal(prepared.profile.directory, "Profile 1");
  assert.deepEqual(prepared.request, {
    requestId: "01900000-0000-7000-8000-000000000001",
    profilePath,
    destinationProfile: "codex-browser-chrome-import-01900000-0000-7000-8000-000000000001",
  });
  const args = buildRuntimeOpenArguments({
    appPath: "/Applications/ChatGPT.app",
    preloadPath: "/tmp/iab/preload.cjs",
    logPath: "/tmp/iab/runtime.jsonl",
    chromeImportRequest: prepared.request,
  });
  assert.ok(args.includes(
    `CODEX_IAB_CHROME_IMPORT_REQUEST=${encodeChromeImportRequest(prepared.request)}`,
  ));
});

test("snapshots the fixed App importer profile into a unique isolated seed", (context) => {
  const partitionsPath = mkdtempSync(path.join(os.tmpdir(), "codex-iab-import-snapshot-"));
  context.after(() => rmSync(partitionsPath, { force: true, recursive: true }));
  const source = path.join(partitionsPath, "codex-browser-app");
  const localStorage = path.join(source, "Local Storage");
  mkdirSync(localStorage, { recursive: true });
  writeFileSync(path.join(source, "Cookies"), "imported-cookie-store");
  writeFileSync(path.join(localStorage, "state"), "imported-local-storage");

  const destinationProfile =
    "codex-browser-chrome-import-01900000-0000-7000-8000-000000000001";
  const result = snapshotImportedChromeProfile({ destinationProfile, partitionsPath });

  assert.deepEqual(result, {
    destinationProfile,
    reused: false,
    sourceProfile: "codex-browser-app",
  });
  assert.equal(
    readFileSync(path.join(partitionsPath, destinationProfile, "Cookies"), "utf8"),
    "imported-cookie-store",
  );
  assert.equal(
    readFileSync(path.join(partitionsPath, destinationProfile, "Local Storage", "state"), "utf8"),
    "imported-local-storage",
  );
});

test("finds only official App main processes", () => {
  const executable = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
  assert.deepEqual(findAppMainProcesses("/Applications/ChatGPT.app", {
    spawnSyncImpl: () => ({
      status: 0,
      stdout: [
        `  222 ${executable} --flag`,
        `  111 ${executable}`,
        "  333 /Applications/ChatGPT.app/Contents/Resources/codex app-server",
        "  444 /tmp/ChatGPT",
      ].join("\n"),
      stderr: "",
    }),
  }), [111, 222]);
});

test("reads JSONL runtime events", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-iab-runtime-test-"));
  const logPath = path.join(directory, "runtime.jsonl");
  try {
    writeFileSync(logPath, '{"pid":1,"event":"runtime-preload-installed"}\n{"pid":1,"event":"main-bundle-patched-in-memory"}\n');
    assert.deepEqual(readRuntimeEvents(logPath).map(({ event }) => event), [
      "runtime-preload-installed",
      "main-bundle-patched-in-memory",
    ]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("installed ChatGPT app is signed by OpenAI", (t) => {
  const appPath = "/Applications/ChatGPT.app";
  if (!existsSync(appPath)) {
    t.skip("ChatGPT.app is not installed");
    return;
  }
  const inspection = inspectSignedOfficialApp(appPath);
  assert.equal(inspection.identifier, "com.openai.codex");
  assert.equal(inspection.teamIdentifier, "2DC432GLL2");
  assert.equal(inspection.executablePath, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT");
});
