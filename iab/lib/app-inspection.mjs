import path from "node:path";
import { extractFile, listPackage } from "@electron/asar";

export function extractText(asarPath, internalPath) {
  return extractFile(asarPath, internalPath).toString("utf8");
}

export function findMainBundle(asarPath) {
  const candidates = listPackage(asarPath)
    .map((entry) => entry.replace(/^\//, ""))
    .filter((entry) => /^\.vite\/build\/main-[A-Za-z0-9_-]+\.js$/.test(entry));
  if (candidates.length !== 1) {
    throw new Error(`Expected one main bundle, found ${candidates.length}`);
  }
  return candidates[0];
}

export function defaultAppPath() {
  return "/Applications/ChatGPT.app";
}

export function appAsarPath(appPath) {
  return path.join(appPath, "Contents", "Resources", "app.asar");
}
