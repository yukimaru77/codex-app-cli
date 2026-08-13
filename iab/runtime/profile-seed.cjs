const fs = require("node:fs");
const path = require("node:path");

function storageDirectoryName(partition) {
  if (typeof partition !== "string" || !partition.startsWith("persist:codex-browser-")) {
    throw new Error(`unsupported browser partition: ${partition}`);
  }
  return partition
    .slice("persist:".length)
    .replaceAll(/%([0-9A-F]{2})/g, (_match, hex) => `%25${hex.toLowerCase()}`);
}

function createProfileSeeder({ partitionsPath, sourceProfile, fsImpl = fs }) {
  if (path.basename(sourceProfile) !== sourceProfile || !sourceProfile.startsWith("codex-browser-")) {
    throw new Error(`invalid source browser profile: ${sourceProfile}`);
  }
  const root = path.resolve(partitionsPath);
  const sourcePath = path.join(root, sourceProfile);

  return function seedProfile(partition) {
    const destinationProfile = storageDirectoryName(partition);
    const destinationPath = path.join(root, destinationProfile);
    if (destinationPath === sourcePath) {
      return { destinationProfile, reused: true, sourceProfile };
    }

    try {
      const destinationStat = fsImpl.lstatSync(destinationPath);
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
        throw new Error(`thread browser profile is not a regular directory: ${destinationProfile}`);
      }
      return { destinationProfile, reused: true, sourceProfile };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    let sourceStat;
    try {
      sourceStat = fsImpl.lstatSync(sourcePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`source browser profile does not exist: ${sourceProfile}`);
      }
      throw error;
    }
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error(`source browser profile is not a regular directory: ${sourceProfile}`);
    }

    try {
      fsImpl.cpSync(sourcePath, destinationPath, {
        errorOnExist: true,
        force: false,
        recursive: true,
      });
    } catch (error) {
      fsImpl.rmSync(destinationPath, { force: true, recursive: true });
      throw error;
    }
    return { destinationProfile, reused: false, sourceProfile };
  };
}

module.exports = { createProfileSeeder, storageDirectoryName };
