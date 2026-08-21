import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  inspectBrowserServiceModule,
  installTrustedServicePathHooks,
  remountBrowserServicePath,
  rewriteTrustedServicesEnv,
} = require("../iab/runtime/browser-plugin-path.cjs");

function writeService(root, marketplace, plugin, version) {
  const servicePath = path.join(
    root,
    "plugins",
    "cache",
    marketplace,
    plugin,
    version,
    "scripts",
    "browser-service.mjs",
  );
  mkdirSync(path.dirname(servicePath), { recursive: true });
  writeFileSync(servicePath, `export const version = ${JSON.stringify(version)};\n`);
  return servicePath;
}

test("keeps a Browser service path that still exists", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-plugin-current-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const current = writeService(root, "openai-bundled", "browser", "26.818.21641");

  const result = remountBrowserServicePath(current);
  assert.deepEqual(result, {
    path: current,
    remounted: false,
    version: "26.818.21641",
  });
});

test("remounts a missing App-version path onto the installed Browser plugin", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-plugin-stale-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const current = writeService(root, "openai-bundled", "browser", "26.818.21641");
  const stale = path.join(
    root,
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    "26.814.41407",
    "scripts",
    "browser-service.mjs",
  );

  const result = remountBrowserServicePath(stale);
  assert.deepEqual(result, {
    path: current,
    remounted: true,
    version: "26.818.21641",
  });
});

test("prefers the latest Browser plugin cache when remounting", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-plugin-latest-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  writeService(root, "openai-bundled", "browser", "26.810.52044");
  const current = writeService(root, "openai-bundled", "browser", "26.818.21641");
  symlinkSync("26.818.21641", path.join(root, "plugins", "cache", "openai-bundled", "browser", "latest"));
  const stale = path.join(
    root,
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    "26.814.41407",
    "scripts",
    "browser-service.mjs",
  );

  const result = remountBrowserServicePath(stale);
  assert.equal(result.path, current);
  assert.equal(result.remounted, true);
  assert.equal(result.version, "26.818.21641");
});

test("does not invent a replacement outside the same plugin cache family", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-plugin-unrelated-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  writeService(root, "openai-bundled", "browser", "26.818.21641");
  const other = path.join(root, "not-a-plugin-cache", "browser-service.mjs");

  const result = remountBrowserServicePath(other);
  assert.deepEqual(result, {
    path: other,
    remounted: false,
    version: null,
  });
});

test("rewrites only the missing browser key in NODE_REPL_TRUSTED_SERVICES", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-plugin-env-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const current = writeService(root, "openai-bundled", "browser", "26.818.21641");
  const stale = path.join(
    root,
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    "26.814.41407",
    "scripts",
    "browser-service.mjs",
  );
  const events = [];
  const env = {
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
      browser: stale,
      sky: "@oai/sky/service",
    }),
  };

  const rewritten = rewriteTrustedServicesEnv(env, (event) => events.push(event));
  assert.equal(rewritten, true);
  assert.deepEqual(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES), {
    browser: current,
    sky: "@oai/sky/service",
  });
  assert.equal(events.at(-1)?.event, "browser-service-path-remounted");
  assert.equal(events.at(-1)?.from, stale);
  assert.equal(events.at(-1)?.to, current);
});

test("leaves trusted services unchanged when the Browser module still exists", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-plugin-keep-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const current = writeService(root, "openai-bundled", "browser", "26.818.21641");
  const env = {
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
      browser: current,
      sky: "@oai/sky/service",
    }),
  };
  const original = env.NODE_REPL_TRUSTED_SERVICES;

  assert.equal(rewriteTrustedServicesEnv(env), false);
  assert.equal(env.NODE_REPL_TRUSTED_SERVICES, original);
});

test("rewrites stale trusted-worker env when the App spawns node_repl", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-plugin-spawn-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const current = writeService(root, "openai-bundled", "browser", "26.818.21641");
  const stale = path.join(
    root,
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    "26.814.41407",
    "scripts",
    "browser-service.mjs",
  );
  const calls = [];
  const childProcess = {
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { pid: 7 };
    },
  };

  installTrustedServicePathHooks({ childProcess, log() {} });
  const env = {
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
      browser: stale,
      sky: "@oai/sky/service",
    }),
  };
  const child = childProcess.spawn("/tmp/node_repl", [], { env });
  assert.equal(child.pid, 7);
  assert.deepEqual(JSON.parse(calls[0].options.env.NODE_REPL_TRUSTED_SERVICES), {
    browser: current,
    sky: "@oai/sky/service",
  });
});

test("inspects a stale path from Codex config.toml when env is unset", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-plugin-config-"));
  const previous = process.env.NODE_REPL_TRUSTED_SERVICES;
  delete process.env.NODE_REPL_TRUSTED_SERVICES;
  context.after(() => {
    rmSync(root, { force: true, recursive: true });
    if (previous == null) delete process.env.NODE_REPL_TRUSTED_SERVICES;
    else process.env.NODE_REPL_TRUSTED_SERVICES = previous;
  });
  const current = writeService(root, "openai-bundled", "browser", "26.818.21641");
  const stale = path.join(
    root,
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    "26.814.41407",
    "scripts",
    "browser-service.mjs",
  );
  writeFileSync(path.join(root, "config.toml"), [
    "model = \"gpt-5.6-sol\"",
    `NODE_REPL_TRUSTED_SERVICES = '${JSON.stringify({
      browser: stale,
      sky: "@oai/sky/service",
    })}'`,
    "",
  ].join("\n"));

  assert.deepEqual(inspectBrowserServiceModule({ codexHome: root }), {
    configuredPath: stale,
    resolvedPath: current,
    remounted: true,
    pluginVersion: "26.818.21641",
  });
});

test("inspects the resolved Browser service module for profile status", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-iab-plugin-inspect-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const current = writeService(root, "openai-bundled", "browser", "26.818.21641");
  const stale = path.join(
    root,
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    "26.814.41407",
    "scripts",
    "browser-service.mjs",
  );

  assert.deepEqual(inspectBrowserServiceModule({
    configuredServices: JSON.stringify({ browser: stale, sky: "@oai/sky/service" }),
  }), {
    configuredPath: stale,
    resolvedPath: current,
    remounted: true,
    pluginVersion: "26.818.21641",
  });
});
