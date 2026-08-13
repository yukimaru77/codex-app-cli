import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { defaultAppPath } from "./app-inspection.mjs";

export const OPENAI_TEAM_ID = "2DC432GLL2";
export const CODEX_BUNDLE_ID = "com.openai.codex";

export function inspectSignedOfficialApp(
  appPath = defaultAppPath(),
  { spawnSyncImpl = spawnSync } = {},
) {
  const resolvedAppPath = path.resolve(appPath);
  const appStat = statSync(resolvedAppPath);
  if (!appStat.isDirectory()) {
    throw new Error(`App path is not a directory: ${resolvedAppPath}`);
  }

  runChecked(
    spawnSyncImpl,
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", resolvedAppPath],
    "Official app signature verification",
  );
  const signatureResult = runChecked(
    spawnSyncImpl,
    "/usr/bin/codesign",
    ["-dv", "--verbose=4", resolvedAppPath],
    "Official app signature inspection",
  );
  const signatureText = `${signatureResult.stdout ?? ""}\n${signatureResult.stderr ?? ""}`;
  const identifier = matchField(signatureText, "Identifier");
  const teamIdentifier = matchField(signatureText, "TeamIdentifier");
  const executablePath = matchField(signatureText, "Executable");
  const authority = signatureText
    .split(/\r?\n/)
    .find((line) => line.startsWith("Authority="))
    ?.slice("Authority=".length) ?? null;

  if (identifier !== CODEX_BUNDLE_ID) {
    throw new Error(`Unexpected app bundle identifier: ${identifier ?? "missing"}`);
  }
  if (teamIdentifier !== OPENAI_TEAM_ID) {
    throw new Error(`Unexpected signing team: ${teamIdentifier ?? "missing"}`);
  }
  if (authority == null || !authority.includes("OpenAI OpCo, LLC")) {
    throw new Error(`Unexpected signing authority: ${authority ?? "missing"}`);
  }
  if (
    executablePath == null ||
    !path.resolve(executablePath).startsWith(`${resolvedAppPath}${path.sep}Contents${path.sep}MacOS${path.sep}`)
  ) {
    throw new Error(`Unexpected app executable: ${executablePath ?? "missing"}`);
  }

  return {
    appPath: resolvedAppPath,
    identifier,
    teamIdentifier,
    authority,
    executablePath: path.resolve(executablePath),
  };
}

function matchField(text, name) {
  const match = text.match(new RegExp(`^${name}=(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function runChecked(spawnSyncImpl, command, args, label) {
  const result = spawnSyncImpl(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${label} failed${detail === "" ? "" : `: ${detail}`}`);
  }
  return result;
}
