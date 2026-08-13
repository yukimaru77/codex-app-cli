import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  decodeChromeImportRequest,
  importChromeProfile,
  installChromeProfileImport,
} = require("../iab/runtime/chrome-import.cjs");

const REQUEST = {
  requestId: "request-1",
  profilePath: "/Users/test/Library/Application Support/Google/Chrome/Profile 1",
  destinationProfile: "codex-browser-chrome-import-01900000-0000-7000-8000-000000000001",
};

test("decodes and validates a Chrome import request", () => {
  const encoded = Buffer.from(JSON.stringify(REQUEST)).toString("base64url");
  assert.deepEqual(decodeChromeImportRequest(encoded), REQUEST);
  assert.throws(
    () => decodeChromeImportRequest(Buffer.from("{}").toString("base64url")),
    /requestId/,
  );
  assert.throws(
    () => decodeChromeImportRequest(Buffer.from(JSON.stringify({
      ...REQUEST,
      profilePath: "Profile 1",
    })).toString("base64url")),
    /absolute profilePath/,
  );
  assert.throws(
    () => decodeChromeImportRequest(Buffer.from(JSON.stringify({
      ...REQUEST,
      destinationProfile: "codex-browser-app",
    })).toString("base64url")),
    /invalid destinationProfile/,
  );
});

test("uses the signed App browserProfileImporter with the standard import defaults", async () => {
  const calls = [];
  const selected = {
    source: "chrome",
    profilePath: REQUEST.profilePath,
    profileDirectoryName: "Profile 1",
  };
  const electron = fakeElectron({
    profiles: [selected],
    result: { cookies: { imported: 3 }, passwords: { imported: 2 } },
    calls,
  });
  const events = [];

  const result = await importChromeProfile({
    electron,
    request: REQUEST,
    log: (event) => events.push(event),
  });

  assert.deepEqual(result, { cookies: { imported: 3 }, passwords: { imported: 2 } });
  assert.deepEqual(calls, [
    ["fromPartition", "persist:codex-browser-app"],
    ["list"],
    ["import", {
      source: "chrome",
      profilePath: REQUEST.profilePath,
      importCookies: true,
      importPasswords: true,
      importHistory: false,
    }],
    ["flushStorageData"],
  ]);
  assert.equal(events[0].event, "chrome-profile-import-completed");
  assert.equal(events[0].sourceProfileDirectory, "Profile 1");
});

test("fails closed when the official importer no longer lists the selected profile", async () => {
  const electron = fakeElectron({ profiles: [], result: {}, calls: [] });
  await assert.rejects(
    importChromeProfile({ electron, request: REQUEST, log: () => {} }),
    /no longer importable/,
  );
});

test("import-only lifecycle logs failure and exits nonzero", async () => {
  const calls = [];
  const electron = fakeElectron({ profiles: [], result: {}, calls });
  const events = [];
  const encodedRequest = Buffer.from(JSON.stringify(REQUEST)).toString("base64url");

  await installChromeProfileImport({
    electron,
    encodedRequest,
    log: (event) => events.push(event),
  });

  assert.equal(events[0].event, "chrome-profile-import-failed");
  assert.deepEqual(calls.at(-1), ["exit", 1]);
});

test("import-only lifecycle logs completion and exits zero", async () => {
  const calls = [];
  const electron = fakeElectron({
    profiles: [{
      source: "chrome",
      profilePath: REQUEST.profilePath,
      profileDirectoryName: "Profile 1",
    }],
    result: { cookies: { status: "success" } },
    calls,
  });
  const events = [];

  await installChromeProfileImport({
    electron,
    encodedRequest: Buffer.from(JSON.stringify(REQUEST)).toString("base64url"),
    log: (event) => events.push(event),
  });

  assert.equal(events[0].event, "chrome-profile-import-completed");
  assert.deepEqual(calls.at(-1), ["exit", 0]);
});

function fakeElectron({ profiles, result, calls }) {
  return {
    app: {
      whenReady: () => Promise.resolve(),
      exit: (code) => calls.push(["exit", code]),
    },
    session: {
      fromPartition: (partition) => {
        calls.push(["fromPartition", partition]);
        return {
          browserProfileImporter: {
            list: async () => {
              calls.push(["list"]);
              return profiles;
            },
            import: async (request) => {
              calls.push(["import", request]);
              return result;
            },
          },
          flushStorageData: async () => {
            calls.push(["flushStorageData"]);
          },
        };
      },
    },
  };
}
