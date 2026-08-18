import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSupplementalChromeCookies,
  deriveChromeCookieKey,
  exportSupplementalChromeCookies,
} from "../iab/lib/chrome-cookies.mjs";

const PASSWORD = "test-safe-storage-password";
const BASE_ROW = {
  hostKey: ".example.com",
  topFrameSiteKey: "",
  name: "session",
  value: "",
  path: "/account",
  expiresUtc: 13_500_000_000_000_000,
  secure: 1,
  httpOnly: 1,
  persistent: 1,
  sameSite: 1,
  sourceScheme: 2,
};

test("decrypts v24 host-bound Chrome cookies and maps Electron details", () => {
  const rows = [{
    ...BASE_ROW,
    encryptedValueHex: encryptCookie("opaque-session-value", BASE_ROW.hostKey),
  }];
  const result = buildSupplementalChromeCookies({
    rows,
    databaseVersion: 24,
    password: PASSWORD,
    nowSeconds: 1_800_000_000,
  });

  assert.deepEqual(result, {
    cookies: [{
      url: "https://example.com/account",
      name: "session",
      value: "opaque-session-value",
      domain: ".example.com",
      path: "/account",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: 1_855_526_400,
    }],
    skippedPartitioned: 0,
    skippedExpired: 0,
  });
});

test("rejects a v24 cookie whose encrypted host binding does not match", () => {
  assert.throws(
    () => buildSupplementalChromeCookies({
      rows: [{
        ...BASE_ROW,
        hostKey: ".other.example",
        encryptedValueHex: encryptCookie("opaque-session-value", BASE_ROW.hostKey),
      }],
      databaseVersion: 24,
      password: PASSWORD,
    }),
    /host binding did not match/,
  );
});

test("skips partitioned and expired cookies without weakening their semantics", () => {
  const encryptedValueHex = encryptCookie("value", BASE_ROW.hostKey);
  const result = buildSupplementalChromeCookies({
    rows: [
      { ...BASE_ROW, encryptedValueHex, topFrameSiteKey: "https://top.example" },
      { ...BASE_ROW, encryptedValueHex, expiresUtc: 11_644_473_601_000_000 },
    ],
    databaseVersion: 24,
    password: PASSWORD,
    nowSeconds: 2,
  });
  assert.deepEqual(result, { cookies: [], skippedPartitioned: 1, skippedExpired: 1 });
});

test("exports cookies through a mode-0600 temporary file and cleans it", (context) => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-app-cookie-export-test-"));
  context.after(() => rmSync(temporaryRoot, { force: true, recursive: true }));
  const rows = [{
    ...BASE_ROW,
    encryptedValueHex: encryptCookie("opaque-session-value", BASE_ROW.hostKey),
  }];
  const spawnSyncImpl = (command, args) => {
    if (command === "/usr/bin/security") {
      return { status: 0, stdout: `${PASSWORD}\n`, stderr: "" };
    }
    const sql = args.at(-1);
    if (sql.includes("SELECT 1 FROM cookies")) return { status: 0, stdout: "1\n", stderr: "" };
    if (sql.includes("SELECT value FROM meta")) {
      return { status: 0, stdout: '[{"value":"24"}]', stderr: "" };
    }
    return { status: 0, stdout: JSON.stringify(rows), stderr: "" };
  };

  const exported = exportSupplementalChromeCookies("/tmp/Profile 1", {
    spawnSyncImpl,
    temporaryRoot,
  });
  assert.equal(statSync(exported.filePath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(exported.filePath, "utf8")).cookies.length, 1);
  exported.cleanup();
  assert.equal(existsSync(exported.filePath), false);
});

function encryptCookie(value, hostKey) {
  const cipher = createCipheriv(
    "aes-128-cbc",
    deriveChromeCookieKey(PASSWORD),
    Buffer.alloc(16, " "),
  );
  const clear = Buffer.concat([
    createHash("sha256").update(hostKey).digest(),
    Buffer.from(value, "utf8"),
  ]);
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(clear),
    cipher.final(),
  ]).toString("hex");
}
