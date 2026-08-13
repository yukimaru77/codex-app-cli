import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function defaultPartitionsPath(homeDirectory = os.homedir()) {
  return path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "Codex",
    "Default",
    "Partitions",
  );
}

export function listBrowserProfiles(partitionsPath = defaultPartitionsPath()) {
  try {
    return readdirSync(partitionsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("codex-browser-"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export function seedBrowserProfiles({
  from,
  threadIds,
  replace = false,
  partitionsPath = defaultPartitionsPath(),
  now = () => new Date(),
}) {
  if (typeof from !== "string" || from.length === 0) {
    throw new Error("a source browser profile is required");
  }
  if (!Array.isArray(threadIds) || threadIds.length === 0) {
    throw new Error("at least one thread ID is required");
  }

  const sourceName = resolveBrowserProfileName(from);
  const sourcePath = profilePath(partitionsPath, sourceName);
  const sourceStat = checkedDirectory(sourcePath, `source browser profile does not exist: ${sourceName}`);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`source browser profile must not be a symbolic link: ${sourceName}`);
  }

  mkdirSync(partitionsPath, { recursive: true });
  const seen = new Set();
  return threadIds.map((threadId) => {
    if (!THREAD_ID_PATTERN.test(threadId)) throw new Error(`invalid thread ID: ${threadId}`);
    if (seen.has(threadId)) throw new Error(`duplicate thread ID: ${threadId}`);
    seen.add(threadId);

    const destinationName = `codex-browser-${threadId}`;
    const destinationPath = profilePath(partitionsPath, destinationName);
    if (sourcePath === destinationPath) {
      return { threadId, profile: destinationName, source: sourceName, reused: true, backup: null };
    }

    let destinationExists = false;
    try {
      const destinationStat = lstatSync(destinationPath);
      if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
        throw new Error(`thread browser profile is not a regular directory: ${destinationName}`);
      }
      destinationExists = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    if (destinationExists && !replace) {
      return { threadId, profile: destinationName, source: sourceName, reused: true, backup: null };
    }

    let backupPath = null;
    if (destinationExists) {
      const timestamp = now().toISOString().replaceAll(/[^0-9]/g, "");
      backupPath = `${destinationPath}.backup-${timestamp}`;
      renameSync(destinationPath, backupPath);
    }

    try {
      cpSync(sourcePath, destinationPath, {
        errorOnExist: true,
        force: false,
        recursive: true,
      });
    } catch (error) {
      rmSync(destinationPath, { force: true, recursive: true });
      if (backupPath != null) renameSync(backupPath, destinationPath);
      throw error;
    }

    return {
      threadId,
      profile: destinationName,
      source: sourceName,
      reused: false,
      backup: backupPath == null ? null : path.basename(backupPath),
    };
  });
}

export function resolveBrowserProfileName(value) {
  if (value === "default" || value === "app") return "codex-browser-app";
  if (path.basename(value) !== value || value === "." || value === "..") {
    throw new Error(`browser profile must be a name from 'codex-app profile list': ${value}`);
  }
  if (!value.startsWith("codex-browser-")) {
    throw new Error(`browser profile must start with codex-browser-: ${value}`);
  }
  return value;
}

function profilePath(partitionsPath, name) {
  return path.join(path.resolve(partitionsPath), name);
}

function checkedDirectory(directory, message) {
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory()) throw new Error(message);
    return stat;
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(message);
    throw error;
  }
}
