const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { transformMainBundle } = require("./transform.cjs");
const { createProfileSeeder } = require("./profile-seed.cjs");
const { installChromeProfileImport } = require("./chrome-import.cjs");
const { installRendererSettingsPatch } = require("./renderer-settings-patch.cjs");
const {
  installTrustedServicePathHooks,
  rewriteTrustedServicesEnv,
} = require("./browser-plugin-path.cjs");
const { RUNTIME_PATCH_VERSION } = require("./version.cjs");

const logPath =
  process.env.CODEX_IAB_RUNTIME_LOG ||
  path.join(os.homedir(), ".codex", "log", "iab-thread-profiles.jsonl");

function log(event) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Logging must not prevent the signed App from starting.
  }
}

const originalCompile = Module.prototype._compile;
Module.prototype._compile = function compileWithThreadProfiles(source, filename) {
  try {
    const result = transformMainBundle(source);
    if (result.changed) {
      const sourceSha256 = crypto.createHash("sha256").update(source).digest("hex");
      log({
        event: "main-bundle-patched-in-memory",
        filename,
        sourceSha256,
        runtimePatchVersion: RUNTIME_PATCH_VERSION,
      });
      source = result.source;
    }
  } catch (error) {
    log({
      event: "main-bundle-patch-failed",
      error: error instanceof Error ? error.message : String(error),
      filename,
    });
    throw error;
  }
  return originalCompile.call(this, source, filename);
};

globalThis.__codexIabRuntimeLog = log;
globalThis.__codexInstallRendererSettingsPatch = (webContents) =>
  installRendererSettingsPatch(webContents, log);
globalThis.__codexIabInstallTrustedServicePathHooks = (electron) =>
  installTrustedServicePathHooks({ electron, log });

rewriteTrustedServicesEnv(process.env, log);
installTrustedServicePathHooks({
  childProcess: require("node:child_process"),
  log,
});

const chromeImportRequest = process.env.CODEX_IAB_CHROME_IMPORT_REQUEST;
if (chromeImportRequest != null) {
  globalThis.__codexIabInstallChromeProfileImport = (electron) => {
    installChromeProfileImport({ electron, encodedRequest: chromeImportRequest, log });
  };
}

const partitionsPath =
  process.env.CODEX_IAB_PARTITIONS_PATH ||
  path.join(os.homedir(), "Library", "Application Support", "Codex", "Default", "Partitions");
const sourceProfile = process.env.CODEX_IAB_SEED_PROFILE || "codex-browser-app";
const seedProfile = createProfileSeeder({ partitionsPath, sourceProfile });
globalThis.__codexIabSeedProfile = (partition) => {
  const result = seedProfile(partition);
  if (!result.reused) log({ event: "thread-profile-seeded", ...result });
  return result;
};

log({ event: "runtime-preload-installed" });
