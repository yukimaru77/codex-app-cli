import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
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
  cookieFile: "/tmp/codex-app-chrome-cookies/cookies.json",
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
  assert.throws(
    () => decodeChromeImportRequest(Buffer.from(JSON.stringify({
      ...REQUEST,
      cookieFile: undefined,
    })).toString("base64url")),
    /absolute cookieFile/,
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
  const request = requestWithCookieFile({ cookies: [COOKIE], skippedPartitioned: 2 });

  const result = await importChromeProfile({
    electron,
    request,
    log: (event) => events.push(event),
  });

  assert.deepEqual(result, {
    cookies: { imported: 3 },
    passwords: { imported: 2 },
    supplementalCookies: { imported: 1, skippedPartitioned: 2, skippedExpired: 0 },
  });
  assert.deepEqual(calls, [
    ["fromPartition", "persist:codex-browser-app"],
    ["list"],
    ["import", {
      source: "chrome",
      profilePath: request.profilePath,
      importCookies: true,
      importPasswords: true,
      importHistory: false,
    }],
    ["cookies.set", COOKIE],
    ["cookies.flushStore"],
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
  const request = requestWithCookieFile({ cookies: [] });

  await installChromeProfileImport({
    electron,
    encodedRequest: Buffer.from(JSON.stringify(request)).toString("base64url"),
    log: (event) => events.push(event),
  });

  assert.equal(events[0].event, "chrome-profile-import-completed");
  assert.deepEqual(calls.at(-1), ["exit", 0]);
});

test("cookie restore failure deletes the plaintext transfer file and exits nonzero", async () => {
  const calls = [];
  const request = requestWithCookieFile({ cookies: [COOKIE] });
  const electron = fakeElectron({
    profiles: [{
      source: "chrome",
      profilePath: REQUEST.profilePath,
      profileDirectoryName: "Profile 1",
    }],
    result: {},
    calls,
    cookieSetError: new Error("cookie rejected"),
  });
  const events = [];

  await installChromeProfileImport({
    electron,
    encodedRequest: Buffer.from(JSON.stringify(request)).toString("base64url"),
    log: (event) => events.push(event),
  });

  assert.equal(existsSync(request.cookieFile), false);
  assert.equal(events[0].event, "chrome-profile-import-failed");
  assert.deepEqual(calls.at(-1), ["exit", 1]);
});

function fakeElectron({ profiles, result, calls, cookieSetError = null }) {
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
          cookies: {
            set: async (cookie) => {
              calls.push(["cookies.set", cookie]);
              if (cookieSetError != null) throw cookieSetError;
            },
            flushStore: async () => calls.push(["cookies.flushStore"]),
          },
          flushStorageData: async () => {
            calls.push(["flushStorageData"]);
          },
        };
      },
    },
  };
}

const COOKIE = {
  url: "https://example.com/",
  name: "session",
  value: "secret",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
};

function requestWithCookieFile(payload) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-app-runtime-cookie-test-"));
  const cookieFile = path.join(directory, "cookies.json");
  writeFileSync(cookieFile, JSON.stringify(payload), { mode: 0o600 });
  // The runtime removes the file. The temporary directory contains no secret
  // afterward and can be removed by this process on exit.
  process.once("exit", () => rmSync(directory, { force: true, recursive: true }));
  return { ...REQUEST, cookieFile };
}
