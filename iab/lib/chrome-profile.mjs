import {
  existsSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME_SOURCE_PREFIX = "chrome:";

export function defaultChromeRoot(homeDirectory = os.homedir()) {
  return path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
  );
}

export function isChromeProfileSource(value) {
  return typeof value === "string" && value.startsWith(CHROME_SOURCE_PREFIX);
}

export function listChromeProfiles(chromeRoot = defaultChromeRoot()) {
  const localStatePath = path.join(chromeRoot, "Local State");
  let localState;
  try {
    localState = JSON.parse(readFileSync(localStatePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    if (error instanceof SyntaxError) {
      throw new Error(`Chrome Local State is not valid JSON: ${localStatePath}`);
    }
    throw error;
  }

  const infoCache = localState?.profile?.info_cache;
  if (infoCache == null || typeof infoCache !== "object" || Array.isArray(infoCache)) {
    return [];
  }

  return Object.entries(infoCache)
    .flatMap(([directory, metadata]) => {
      if (!isSinglePathSegment(directory)) return [];
      const profilePath = path.join(path.resolve(chromeRoot), directory);
      let stat;
      try {
        stat = lstatSync(profilePath);
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return [];

      const displayName = typeof metadata?.name === "string" && metadata.name.length > 0
        ? metadata.name
        : directory;
      const cookiesPath = existsSync(path.join(profilePath, "Cookies"))
        ? path.join(profilePath, "Cookies")
        : path.join(profilePath, "Network", "Cookies");
      return [{
        source: `${CHROME_SOURCE_PREFIX}${directory}`,
        directory,
        displayName,
        profilePath,
        hasCookies: existsSync(cookiesPath),
        hasPasswords: existsSync(path.join(profilePath, "Login Data")),
        hasHistory: existsSync(path.join(profilePath, "History")),
      }];
    })
    .sort((left, right) => {
      if (left.directory === "Default") return -1;
      if (right.directory === "Default") return 1;
      return left.directory.localeCompare(right.directory, "en", { numeric: true });
    });
}

export function resolveChromeProfile(value, chromeRoot = defaultChromeRoot()) {
  if (!isChromeProfileSource(value)) {
    throw new Error(`Chrome profile source must start with ${CHROME_SOURCE_PREFIX}`);
  }
  const selector = value.slice(CHROME_SOURCE_PREFIX.length);
  if (selector.length === 0) {
    throw new Error("Chrome profile source requires a directory or display name after chrome:");
  }

  const profiles = listChromeProfiles(chromeRoot);
  const directoryMatch = profiles.find(({ directory }) => directory === selector);
  if (directoryMatch != null) return directoryMatch;

  const displayMatches = profiles.filter(({ displayName }) => displayName === selector);
  if (displayMatches.length === 1) return displayMatches[0];
  if (displayMatches.length > 1) {
    throw new Error(
      `Chrome profile name is ambiguous; use one of: ${displayMatches.map(({ source }) => source).join(", ")}`,
    );
  }
  throw new Error(
    `Chrome profile not found: ${selector}. Run 'codex-app profile chrome-list' to list accepted selectors.`,
  );
}

function isSinglePathSegment(value) {
  return value.length > 0 && value !== "." && value !== ".." && path.basename(value) === value;
}
