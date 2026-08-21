const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVICE_NAME = "browser-service.mjs";
const CHILD_PROCESS_METHODS = ["spawn", "spawnSync", "fork", "execFile", "execFileSync"];

function remountBrowserServicePath(configuredPath) {
  if (typeof configuredPath !== "string" || configuredPath.length === 0) {
    return { path: configuredPath, remounted: false, version: null };
  }

  const resolvedConfigured = path.resolve(configuredPath);
  if (fs.existsSync(resolvedConfigured)) {
    return {
      path: resolvedConfigured,
      remounted: false,
      version: parsePluginServicePath(resolvedConfigured)?.version ?? null,
    };
  }

  const parsed = parsePluginServicePath(resolvedConfigured);
  if (parsed == null) {
    return { path: configuredPath, remounted: false, version: null };
  }

  const replacement = selectInstalledBrowserService(parsed.familyRoot);
  if (replacement == null) {
    return { path: configuredPath, remounted: false, version: null };
  }

  return {
    path: replacement.path,
    remounted: true,
    version: replacement.version,
  };
}

function rewriteTrustedServicesEnv(env, log) {
  if (env == null || typeof env !== "object") return false;
  const raw = env.NODE_REPL_TRUSTED_SERVICES;
  if (typeof raw !== "string" || raw.length === 0) return false;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed == null || typeof parsed !== "object" || typeof parsed.browser !== "string") {
    return false;
  }

  const from = parsed.browser;
  const remount = remountBrowserServicePath(from);
  if (!remount.remounted) return false;

  parsed.browser = remount.path;
  env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify(parsed);
  log?.({
    event: "browser-service-path-remounted",
    from,
    to: remount.path,
    version: remount.version,
  });
  return true;
}

function installTrustedServicePathHooks({ childProcess, electron, log } = {}) {
  if (childProcess != null) {
    for (const name of CHILD_PROCESS_METHODS) {
      if (typeof childProcess[name] === "function") {
        childProcess[name] = wrapWithEnvRewrite(childProcess[name], log);
      }
    }
  }
  if (electron?.utilityProcess != null && typeof electron.utilityProcess.fork === "function") {
    electron.utilityProcess.fork = wrapWithEnvRewrite(electron.utilityProcess.fork, log);
  }
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function inspectBrowserServiceModule({
  configuredServices,
  codexHome = defaultCodexHome(),
} = {}) {
  const rawServices = configuredServices
    ?? process.env.NODE_REPL_TRUSTED_SERVICES
    ?? readTrustedServicesFromConfig(codexHome);
  let configuredPath = null;
  if (typeof rawServices === "string" && rawServices.length > 0) {
    try {
      const parsed = JSON.parse(rawServices);
      if (typeof parsed?.browser === "string") configuredPath = parsed.browser;
    } catch {
      configuredPath = null;
    }
  }
  if (configuredPath == null) {
    return {
      configuredPath: null,
      resolvedPath: null,
      remounted: false,
      pluginVersion: null,
    };
  }
  const remount = remountBrowserServicePath(configuredPath);
  return {
    configuredPath,
    resolvedPath: remount.path,
    remounted: remount.remounted,
    pluginVersion: remount.version,
  };
}

function readTrustedServicesFromConfig(codexHome) {
  try {
    const text = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    const match = text.match(/^\s*NODE_REPL_TRUSTED_SERVICES\s*=\s*'((?:\\'|[^'])*)'/m)
      ?? text.match(/^\s*NODE_REPL_TRUSTED_SERVICES\s*=\s*"((?:\\"|[^"])*)"/m);
    return match?.[1]?.replace(/\\'/g, "'").replace(/\\"/g, "\"") ?? null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function parsePluginServicePath(filePath) {
  if (path.basename(filePath) !== SERVICE_NAME) return null;
  const scriptsDir = path.dirname(filePath);
  if (path.basename(scriptsDir) !== "scripts") return null;
  const versionDir = path.dirname(scriptsDir);
  const pluginDir = path.dirname(versionDir);
  const marketplaceDir = path.dirname(pluginDir);
  const cacheDir = path.dirname(marketplaceDir);
  if (path.basename(cacheDir) !== "cache") return null;
  if (path.basename(path.dirname(cacheDir)) !== "plugins") return null;
  return {
    version: path.basename(versionDir),
    plugin: path.basename(pluginDir),
    marketplace: path.basename(marketplaceDir),
    familyRoot: pluginDir,
  };
}

function selectInstalledBrowserService(familyRoot) {
  let entries;
  try {
    entries = fs.readdirSync(familyRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const installed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const servicePath = path.join(familyRoot, entry.name, "scripts", SERVICE_NAME);
    if (!fs.existsSync(servicePath)) continue;
    const version = entry.name === "latest"
      ? path.basename(path.dirname(path.dirname(fs.realpathSync(servicePath))))
      : entry.name;
    installed.push({
      name: entry.name,
      path: path.resolve(familyRoot, version, "scripts", SERVICE_NAME),
      version,
    });
  }
  if (installed.length === 0) return null;

  const latest = installed.find((candidate) => candidate.name === "latest");
  if (latest != null) return { path: latest.path, version: latest.version };

  installed.sort((left, right) => comparePluginVersions(left.version, right.version));
  const newest = installed[installed.length - 1];
  return { path: newest.path, version: newest.version };
}

function comparePluginVersions(left, right) {
  const leftParts = String(left).split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = String(right).split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
}

function wrapWithEnvRewrite(fn, log) {
  return function rewriteChildEnv(...args) {
    const optionIndex = findOptionsIndex(args);
    if (optionIndex >= 0 && args[optionIndex]?.env != null && typeof args[optionIndex].env === "object") {
      const options = { ...args[optionIndex], env: { ...args[optionIndex].env } };
      rewriteTrustedServicesEnv(options.env, log);
      args[optionIndex] = options;
    }
    return fn.apply(this, args);
  };
}

function findOptionsIndex(args) {
  if (args.length >= 3 && args[2] != null && typeof args[2] === "object" && !Array.isArray(args[2])) {
    return 2;
  }
  if (
    args.length === 2 &&
    args[1] != null &&
    typeof args[1] === "object" &&
    !Array.isArray(args[1])
  ) {
    return 1;
  }
  return -1;
}

module.exports = {
  inspectBrowserServiceModule,
  installTrustedServicePathHooks,
  remountBrowserServicePath,
  rewriteTrustedServicesEnv,
};
