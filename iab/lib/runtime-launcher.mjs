import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appAsarPath,
  extractText,
  findMainBundle,
  findRendererBundle,
} from "./app-inspection.mjs";
import {
  CODEX_BUNDLE_ID,
  inspectSignedOfficialApp,
} from "./official-app-profile.mjs";
import {
  defaultChromeRoot,
  isChromeProfileSource,
  resolveChromeProfile,
} from "./chrome-profile.mjs";
import { exportSupplementalChromeCookies } from "./chrome-cookies.mjs";
import {
  defaultPartitionsPath,
  listBrowserProfiles,
  resolveBrowserProfileName,
  seedBrowserProfiles,
} from "./profile-storage.mjs";

const require = createRequire(import.meta.url);
const { inspectMainBundle } = require("../runtime/transform.cjs");
const { transformRendererBundle } = require("../runtime/renderer-settings-patch.cjs");
const { createProfileSeeder } = require("../runtime/profile-seed.cjs");
const { inspectBrowserServiceModule } = require("../runtime/browser-plugin-path.cjs");
export const { RUNTIME_PATCH_VERSION } = require("../runtime/version.cjs");
export { inspectBrowserServiceModule };

export function defaultRuntimePreloadPath() {
  return path.resolve(import.meta.dirname, "..", "runtime", "preload.cjs");
}

export function defaultRuntimeLogPath(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, ".codex", "log", "iab-thread-profiles.jsonl");
}

export function inspectRuntimeCompatibility(appPath = "/Applications/ChatGPT.app") {
  const app = inspectSignedOfficialApp(appPath);
  const asarPath = appAsarPath(app.appPath);
  const mainBundle = findMainBundle(asarPath);
  const inspection = inspectMainBundle(extractText(asarPath, mainBundle));
  const rendererBundle = findRendererBundle(asarPath);
  let rendererInspection;
  try {
    rendererInspection = transformRendererBundle(extractText(asarPath, rendererBundle));
  } catch (error) {
    rendererInspection = {
      occurrences: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const compatible =
    inspection.isTargetBundle &&
    inspection.patches.every(({ occurrences }) => occurrences === 1);
  if (!compatible) {
    throw new Error(
      `Installed App main bundle is not compatible with the runtime patch: ${inspection.patches
        .map(({ description, occurrences }) => `${description}=${occurrences}`)
        .join(", ")}`,
    );
  }
  return {
    app,
    compatible,
    mainBundle,
    rendererBundle,
    rendererPatchPoints: rendererInspection.occurrences,
    patchPoints: inspection.patches,
    browserService: inspectBrowserServiceModule(),
  };
}

export function buildRuntimeOpenArguments({
  appPath = "/Applications/ChatGPT.app",
  preloadPath = defaultRuntimePreloadPath(),
  logPath = defaultRuntimeLogPath(),
  seedFrom = "codex-browser-app",
  partitionsPath = defaultPartitionsPath(),
  chromeImportRequest = null,
} = {}) {
  const sourceProfile = resolveBrowserProfileName(seedFrom);
  const args = [
    "--env",
    `NODE_OPTIONS=--require=${path.resolve(preloadPath)}`,
    "--env",
    `CODEX_IAB_RUNTIME_LOG=${path.resolve(logPath)}`,
    "--env",
    `CODEX_IAB_SEED_PROFILE=${sourceProfile}`,
    "--env",
    `CODEX_IAB_PARTITIONS_PATH=${path.resolve(partitionsPath)}`,
  ];
  if (chromeImportRequest != null) {
    args.push(
      "--env",
      `CODEX_IAB_CHROME_IMPORT_REQUEST=${encodeChromeImportRequest(chromeImportRequest)}`,
    );
  }
  args.push("-a", path.resolve(appPath));
  return args;
}

export function createChromeImportRequest(
  from,
  {
    chromeRoot = defaultChromeRoot(),
    requestId = randomUUID(),
  } = {},
) {
  const profile = resolveChromeProfile(from, chromeRoot);
  return {
    profile,
    request: {
      requestId,
      profilePath: profile.profilePath,
      destinationProfile: `codex-browser-chrome-import-${requestId}`,
    },
  };
}

export function encodeChromeImportRequest(request) {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

export function findAppMainProcesses(
  appPath = "/Applications/ChatGPT.app",
  { spawnSyncImpl = spawnSync } = {},
) {
  const executablePath = path.join(path.resolve(appPath), "Contents", "MacOS", "ChatGPT");
  const result = runChecked(
    spawnSyncImpl,
    "/bin/ps",
    ["-ax", "-o", "pid=,command="],
    "App process inspection",
  );
  const pids = [];
  for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match == null) continue;
    const command = match[2];
    if (command === executablePath || command.startsWith(`${executablePath} `)) {
      pids.push(Number(match[1]));
    }
  }
  return pids.sort((left, right) => left - right);
}

export function restartAppWithThreadProfiles(
  {
    appPath = "/Applications/ChatGPT.app",
    preloadPath = defaultRuntimePreloadPath(),
    logPath = defaultRuntimeLogPath(),
    seedFrom = "codex-browser-app",
    threadIds = [],
    replaceSeed = false,
    partitionsPath = defaultPartitionsPath(),
    chromeRoot = defaultChromeRoot(),
    timeoutMs = 15_000,
  } = {},
  { spawnSyncImpl = spawnSync } = {},
) {
  const compatibility = inspectRuntimeCompatibility(appPath);
  let sourceProfile;
  let chromeImport = null;
  quitApp(appPath, { spawnSyncImpl, timeoutMs });
  if (isChromeProfileSource(seedFrom)) {
    const prepared = createChromeImportRequest(seedFrom, { chromeRoot });
    sourceProfile = prepared.request.destinationProfile;
    const supplementalCookies = exportSupplementalChromeCookies(prepared.profile.profilePath, {
      spawnSyncImpl,
    });
    prepared.request.cookieFile = supplementalCookies.filePath;
    let isolation;
    let importEvent;
    let snapshot;
    try {
      isolation = isolateAppBrowserProfile({ partitionsPath });
      openAppWithRetry(
        spawnSyncImpl,
        ["-n", ...buildRuntimeOpenArguments({
          appPath,
          preloadPath,
          logPath,
          seedFrom: "codex-browser-app",
          partitionsPath,
          chromeImportRequest: prepared.request,
        })],
        { label: "Chrome profile import launch", timeoutMs },
      );
      importEvent = waitForChromeImportEvent(
        prepared.request.requestId,
        logPath,
        timeoutMs,
      );
      waitForAppProcessExit(appPath, importEvent.pid, { spawnSyncImpl, timeoutMs });
      if (importEvent.event === "chrome-profile-import-failed") {
        throw new Error(`Chrome profile import failed: ${importEvent.error}`);
      }
      snapshot = snapshotImportedChromeProfile({
        destinationProfile: sourceProfile,
        partitionsPath,
      });
    } finally {
      supplementalCookies.cleanup();
      isolation?.restore();
    }
    if (!listBrowserProfiles(partitionsPath).includes(sourceProfile)) {
      throw new Error(`Chrome profile import did not create its seed profile: ${sourceProfile}`);
    }
    chromeImport = {
      source: prepared.profile.source,
      directory: prepared.profile.directory,
      displayName: prepared.profile.displayName,
      profile: sourceProfile,
      snapshot,
      result: importEvent.result,
      supplementalCookies: {
        exported: supplementalCookies.count,
        skippedPartitioned: supplementalCookies.skippedPartitioned,
        skippedExpired: supplementalCookies.skippedExpired,
      },
    };
  } else {
    sourceProfile = resolveBrowserProfileName(seedFrom);
    if (!listBrowserProfiles(partitionsPath).includes(sourceProfile)) {
      throw new Error(`source browser profile does not exist: ${sourceProfile}`);
    }
  }
  const seededProfiles = threadIds.length === 0
    ? []
    : seedBrowserProfiles({
        from: sourceProfile,
        threadIds,
        replace: replaceSeed,
        partitionsPath,
      });
  openAppWithRetry(
    spawnSyncImpl,
    buildRuntimeOpenArguments({ appPath, preloadPath, logPath, seedFrom: sourceProfile, partitionsPath }),
    { label: "Runtime-patched App launch", timeoutMs },
  );
  const pid = waitForAppProcess(appPath, { spawnSyncImpl, timeoutMs });
  const event = waitForRuntimeEvent(pid, logPath, timeoutMs);
  return {
    status: "running",
    pid,
    signedAppModified: false,
    seedProfile: sourceProfile,
    chromeImport,
    seededProfiles,
    runtimeEvent: event,
    compatibility,
  };
}

export function isolateAppBrowserProfile({
  partitionsPath = defaultPartitionsPath(),
  nonce = randomUUID(),
} = {}) {
  const root = path.resolve(partitionsPath);
  const appProfilePath = path.join(root, "codex-browser-app");
  const backupPath = path.join(root, `.codex-browser-app.chrome-import-backup-${nonce}`);
  mkdirSync(root, { recursive: true });

  let hadProfile = false;
  try {
    const stat = lstatSync(appProfilePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("App browser profile must be a regular directory");
    }
    renameSync(appProfilePath, backupPath);
    hadProfile = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  mkdirSync(appProfilePath);

  let restored = false;
  return {
    appProfilePath,
    backupPath: hadProfile ? backupPath : null,
    restore() {
      if (restored) return;
      rmSync(appProfilePath, { force: true, recursive: true });
      if (hadProfile) renameSync(backupPath, appProfilePath);
      else mkdirSync(appProfilePath);
      restored = true;
    },
  };
}

export function snapshotImportedChromeProfile({
  destinationProfile,
  partitionsPath = defaultPartitionsPath(),
}) {
  return createProfileSeeder({
    partitionsPath,
    sourceProfile: "codex-browser-app",
  })(`persist:${destinationProfile}`);
}

export function restoreNormalApp(
  { appPath = "/Applications/ChatGPT.app", timeoutMs = 15_000 } = {},
  { spawnSyncImpl = spawnSync } = {},
) {
  const app = inspectSignedOfficialApp(appPath);
  quitApp(appPath, { spawnSyncImpl, timeoutMs });
  openAppWithRetry(
    spawnSyncImpl,
    ["-a", path.resolve(appPath)],
    { label: "Normal App launch", timeoutMs },
  );
  const pid = waitForAppProcess(appPath, { spawnSyncImpl, timeoutMs });
  return { status: "running-normal", pid, signedAppModified: false, app };
}

export function readRuntimeEvents(logPath = defaultRuntimeLogPath()) {
  try {
    return readFileSync(logPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function quitApp(appPath, { spawnSyncImpl, timeoutMs }) {
  const pids = findAppMainProcesses(appPath, { spawnSyncImpl });
  if (pids.length === 0) return;
  const deadline = Date.now() + timeoutMs;
  requestAppQuitWithFallback(spawnSyncImpl, pids, deadline);
  while (Date.now() < deadline) {
    if (findAppMainProcesses(appPath, { spawnSyncImpl }).length === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error("ChatGPT/Codex App did not quit before the timeout");
}

export function requestAppQuitWithRetry(spawnSyncImpl, deadline) {
  while (true) {
    const result = spawnSyncImpl(
      "/usr/bin/osascript",
      ["-e", `tell application id "${CODEX_BUNDLE_ID}" to quit`],
      { encoding: "utf8" },
    );
    if (result.error != null) throw result.error;
    if (result.status === 0) return result;
    const details = String(result.stderr ?? result.stdout ?? "").trim();
    if (!details.includes("(-128)") || Date.now() >= deadline) {
      throw new Error(`App quit failed${details.length > 0 ? `: ${details}` : ""}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
}

export function requestAppQuitWithFallback(spawnSyncImpl, pids, deadline) {
  try {
    return requestAppQuitWithRetry(spawnSyncImpl, Math.min(deadline, Date.now() + 2_000));
  } catch (error) {
    if (!error.message.includes("(-128)")) throw error;
    for (const pid of pids) {
      runChecked(spawnSyncImpl, "/bin/kill", ["-TERM", String(pid)], "App TERM fallback");
    }
    return { status: 0, fallback: "SIGTERM" };
  }
}

function waitForAppProcess(appPath, { spawnSyncImpl, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [pid] = findAppMainProcesses(appPath, { spawnSyncImpl });
    if (pid != null) return pid;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error("ChatGPT/Codex App did not start before the timeout");
}

function waitForRuntimeEvent(pid, logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = readRuntimeEvents(logPath)
      .findLast((candidate) =>
        candidate.pid === pid && candidate.event === "main-bundle-patched-in-memory");
    if (event != null) return event;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`Runtime patch did not report activation for App PID ${pid}`);
}

function waitForChromeImportEvent(requestId, logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = readRuntimeEvents(logPath)
      .findLast((candidate) =>
        candidate.requestId === requestId &&
        (candidate.event === "chrome-profile-import-completed" ||
          candidate.event === "chrome-profile-import-failed"));
    if (event != null) return event;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error("Chrome profile import did not complete before the timeout");
}

function waitForAppProcessExit(appPath, pid, { spawnSyncImpl, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!findAppMainProcesses(appPath, { spawnSyncImpl }).includes(pid)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`Chrome profile import App process ${pid} did not exit before the timeout`);
}

export function openAppWithRetry(
  spawnSyncImpl,
  args,
  { label, timeoutMs },
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = spawnSyncImpl("/usr/bin/open", args, { encoding: "utf8" });
    if (result.error != null) throw result.error;
    if (result.status === 0) return result;
    const details = String(result.stderr ?? result.stdout ?? "").trim();
    if (!details.includes("error -600") || Date.now() >= deadline) {
      throw new Error(`${label} failed${details.length > 0 ? `: ${details}` : ""}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

function runChecked(spawnSyncImpl, command, args, label) {
  const result = spawnSyncImpl(command, args, { encoding: "utf8" });
  if (result.error != null) throw result.error;
  if (result.status !== 0) {
    const details = String(result.stderr ?? result.stdout ?? "").trim();
    throw new Error(`${label} failed${details.length > 0 ? `: ${details}` : ""}`);
  }
  return result;
}
