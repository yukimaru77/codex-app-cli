import { spawnSync } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  pbkdf2Sync,
} from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const COOKIE_QUERY = `
SELECT
  host_key AS hostKey,
  top_frame_site_key AS topFrameSiteKey,
  name,
  value,
  hex(encrypted_value) AS encryptedValueHex,
  path,
  expires_utc AS expiresUtc,
  is_secure AS secure,
  is_httponly AS httpOnly,
  is_persistent AS persistent,
  samesite AS sameSite,
  source_scheme AS sourceScheme
FROM cookies
ORDER BY host_key, path, name;
`;

export function resolveChromeCookiesPath(profilePath) {
  const direct = path.join(profilePath, "Cookies");
  const network = path.join(profilePath, "Network", "Cookies");
  return { direct, network };
}

export function deriveChromeCookieKey(password) {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

export function decryptChromeCookie({
  encryptedValueHex,
  hostKey,
  databaseVersion,
  key,
}) {
  const encrypted = Buffer.from(encryptedValueHex, "hex");
  const prefix = encrypted.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") {
    throw new Error(`unsupported Chrome cookie encryption version for ${hostKey}`);
  }
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  let clear = Buffer.concat([
    decipher.update(encrypted.subarray(3)),
    decipher.final(),
  ]);
  if (Number(databaseVersion) >= 24) {
    const expectedHostHash = createHash("sha256").update(hostKey).digest();
    if (clear.length < expectedHostHash.length ||
        !clear.subarray(0, expectedHostHash.length).equals(expectedHostHash)) {
      throw new Error(`Chrome cookie host binding did not match for ${hostKey}`);
    }
    clear = clear.subarray(expectedHostHash.length);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(clear);
}

export function chromeCookieToElectronDetails(cookie, value) {
  const host = cookie.hostKey.replace(/^\./, "");
  const cookiePath = cookie.path?.startsWith("/") ? cookie.path : "/";
  const secure = Boolean(Number(cookie.secure));
  const details = {
    url: `${secure || Number(cookie.sourceScheme) === 2 ? "https" : "http"}://${host}${cookiePath}`,
    name: cookie.name,
    value,
    path: cookiePath,
    secure,
    httpOnly: Boolean(Number(cookie.httpOnly)),
    sameSite: chromeSameSiteToElectron(cookie.sameSite),
  };
  if (cookie.hostKey.startsWith(".")) details.domain = cookie.hostKey;
  if (Boolean(Number(cookie.persistent)) && Number(cookie.expiresUtc) > 0) {
    details.expirationDate = Number(cookie.expiresUtc) / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS;
  }
  return details;
}

export function buildSupplementalChromeCookies({
  rows,
  databaseVersion,
  password,
  nowSeconds = Date.now() / 1000,
}) {
  const key = deriveChromeCookieKey(password);
  const cookies = [];
  let skippedPartitioned = 0;
  let skippedExpired = 0;
  for (const row of rows) {
    // Electron's public cookies.set API has no partition-key input. Codex's
    // standard importer remains responsible for CHIPS cookies; this pass
    // restores the first-party/session cookies it currently omits.
    if (row.topFrameSiteKey) {
      skippedPartitioned += 1;
      continue;
    }
    const value = row.value || decryptChromeCookie({
      encryptedValueHex: row.encryptedValueHex,
      hostKey: row.hostKey,
      databaseVersion,
      key,
    });
    const details = chromeCookieToElectronDetails(row, value);
    if (details.expirationDate != null && details.expirationDate <= nowSeconds) {
      skippedExpired += 1;
      continue;
    }
    cookies.push(details);
  }
  return { cookies, skippedPartitioned, skippedExpired };
}

export function exportSupplementalChromeCookies(
  profilePath,
  {
    spawnSyncImpl = spawnSync,
    temporaryRoot = os.tmpdir(),
  } = {},
) {
  const { direct, network } = resolveChromeCookiesPath(profilePath);
  const databasePath = firstReadableCookieDatabase(spawnSyncImpl, [direct, network]);
  const databaseVersion = runChecked(
    spawnSyncImpl,
    "/usr/bin/sqlite3",
    ["-readonly", "-json", databasePath, "SELECT value FROM meta WHERE key='version';"],
    "Chrome cookie metadata read",
  );
  const rowsOutput = runChecked(
    spawnSyncImpl,
    "/usr/bin/sqlite3",
    ["-readonly", "-json", databasePath, COOKIE_QUERY],
    "Chrome cookie read",
  );
  const password = runChecked(
    spawnSyncImpl,
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "Chrome Safe Storage"],
    "Chrome Safe Storage key read",
  ).replace(/\r?\n$/, "");
  const versionRows = parseJson(databaseVersion, "Chrome cookie metadata");
  const rows = parseJson(rowsOutput, "Chrome cookies");
  const payload = buildSupplementalChromeCookies({
    rows,
    databaseVersion: versionRows[0]?.value ?? 0,
    password,
  });
  const directory = mkdtempSync(path.join(temporaryRoot, "codex-app-chrome-cookies-"));
  const filePath = path.join(directory, "cookies.json");
  writeFileSync(filePath, JSON.stringify(payload), { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(filePath, 0o600);
  let cleaned = false;
  return {
    filePath,
    count: payload.cookies.length,
    skippedPartitioned: payload.skippedPartitioned,
    skippedExpired: payload.skippedExpired,
    cleanup() {
      if (cleaned) return;
      rmSync(directory, { force: true, recursive: true });
      cleaned = true;
    },
  };
}

function chromeSameSiteToElectron(value) {
  return ({
    "-1": "unspecified",
    0: "no_restriction",
    1: "lax",
    2: "strict",
  })[String(value)] ?? "unspecified";
}

function firstReadableCookieDatabase(spawnSyncImpl, candidates) {
  for (const candidate of candidates) {
    const result = spawnSyncImpl(
      "/usr/bin/sqlite3",
      ["-readonly", candidate, "SELECT 1 FROM cookies LIMIT 1;"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.error == null && result.status === 0) return candidate;
  }
  throw new Error("Chrome profile does not contain a readable cookie database");
}

function runChecked(spawnSyncImpl, command, args, label) {
  const result = spawnSyncImpl(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error != null) throw result.error;
  if (result.status !== 0) {
    const details = String(result.stderr ?? result.stdout ?? "").trim();
    throw new Error(`${label} failed${details.length > 0 ? `: ${details}` : ""}`);
  }
  return String(result.stdout ?? "");
}

function parseJson(value, label) {
  try {
    return JSON.parse(value || "[]");
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}
