const path = require("node:path");
const fs = require("node:fs");

const IMPORT_PROFILE_PATTERN = /^codex-browser-chrome-import-[0-9a-f-]{36}$/i;

function decodeChromeImportRequest(encoded) {
  let request;
  try {
    request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid Chrome import request encoding");
  }
  if (request == null || typeof request !== "object") {
    throw new Error("invalid Chrome import request");
  }
  if (typeof request.requestId !== "string" || request.requestId.length === 0) {
    throw new Error("Chrome import request requires a requestId");
  }
  if (typeof request.profilePath !== "string" || !path.isAbsolute(request.profilePath)) {
    throw new Error("Chrome import request requires an absolute profilePath");
  }
  if (
    typeof request.destinationProfile !== "string" ||
    !IMPORT_PROFILE_PATTERN.test(request.destinationProfile)
  ) {
    throw new Error("Chrome import request has an invalid destinationProfile");
  }
  if (typeof request.cookieFile !== "string" || !path.isAbsolute(request.cookieFile)) {
    throw new Error("Chrome import request requires an absolute cookieFile");
  }
  return {
    requestId: request.requestId,
    profilePath: path.resolve(request.profilePath),
    destinationProfile: request.destinationProfile,
    cookieFile: path.resolve(request.cookieFile),
  };
}

function readSupplementalCookies(cookieFile) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(cookieFile, "utf8"));
  } finally {
    fs.rmSync(cookieFile, { force: true });
  }
  if (payload == null || typeof payload !== "object" || !Array.isArray(payload.cookies)) {
    throw new Error("supplemental Chrome cookie file is invalid");
  }
  return payload;
}

async function importChromeProfile({ electron, request, log }) {
  // Codex's standard importer is owned by the fixed App browser partition.
  // Snapshotting that partition into the requested isolated seed happens only
  // after this import-only App process exits.
  const appBrowserSession = electron.session.fromPartition("persist:codex-browser-app");
  const importer = appBrowserSession.browserProfileImporter;
  if (importer == null || typeof importer.list !== "function" || typeof importer.import !== "function") {
    throw new Error("Installed Codex App does not expose the browser profile importer");
  }

  const profiles = await importer.list();
  const selected = profiles.find((profile) =>
    profile?.source === "chrome" &&
    typeof profile.profilePath === "string" &&
    path.resolve(profile.profilePath) === request.profilePath);
  if (selected == null) {
    throw new Error("Selected Chrome profile is no longer importable; close Chrome and try again");
  }

  const result = await importer.import({
    source: "chrome",
    profilePath: selected.profilePath,
    importCookies: true,
    importPasswords: true,
    importHistory: false,
  });
  const supplemental = readSupplementalCookies(request.cookieFile);
  if (appBrowserSession.cookies == null || typeof appBrowserSession.cookies.set !== "function") {
    throw new Error("Installed Codex App does not expose Electron cookie storage");
  }
  for (const cookie of supplemental.cookies) {
    await appBrowserSession.cookies.set(cookie);
  }
  if (typeof appBrowserSession.cookies.flushStore === "function") {
    await appBrowserSession.cookies.flushStore();
  }
  if (typeof appBrowserSession.flushStorageData === "function") {
    await appBrowserSession.flushStorageData();
  }
  log({
    event: "chrome-profile-import-completed",
    requestId: request.requestId,
    destinationProfile: request.destinationProfile,
    source: "chrome",
    sourceProfileDirectory: selected.profileDirectoryName,
    result: {
      ...result,
      supplementalCookies: {
        imported: supplemental.cookies.length,
        skippedPartitioned: supplemental.skippedPartitioned ?? 0,
        skippedExpired: supplemental.skippedExpired ?? 0,
      },
    },
  });
  return {
    ...result,
    supplementalCookies: {
      imported: supplemental.cookies.length,
      skippedPartitioned: supplemental.skippedPartitioned ?? 0,
      skippedExpired: supplemental.skippedExpired ?? 0,
    },
  };
}

function installChromeProfileImport({ electron, encodedRequest, log }) {
  const request = decodeChromeImportRequest(encodedRequest);
  return electron.app.whenReady()
    .then(() => importChromeProfile({ electron, request, log }))
    .then(() => {
      electron.app.exit(0);
    })
    .catch((error) => {
      log({
        event: "chrome-profile-import-failed",
        requestId: request.requestId,
        destinationProfile: request.destinationProfile,
        error: error instanceof Error ? error.message : String(error),
      });
      electron.app.exit(1);
    });
}

module.exports = {
  decodeChromeImportRequest,
  importChromeProfile,
  installChromeProfileImport,
};
