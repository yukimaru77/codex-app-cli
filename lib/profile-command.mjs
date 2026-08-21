import os from 'node:os';
import path from 'node:path';

import { listChromeProfiles } from '../iab/lib/chrome-profile.mjs';
import {
  defaultRuntimeLogPath,
  findAppMainProcesses,
  inspectBrowserServiceModule,
  inspectRuntimeCompatibility,
  RUNTIME_PATCH_VERSION,
  readRuntimeEvents,
  restartAppWithThreadProfiles,
  restoreNormalApp,
} from '../iab/lib/runtime-launcher.mjs';
import {
  defaultPartitionsPath,
  listBrowserProfiles,
} from '../iab/lib/profile-storage.mjs';

export function profileUsage() {
  return `Usage:
  codex-app profile inspect
  codex-app profile list
  codex-app profile chrome-list
  codex-app profile restart [--from <profile>] [--conversation <id>] [--thread <id> ...] [--replace]
  codex-app profile status
  codex-app profile restore

Examples:
  codex-app profile restart --from default
  codex-app profile restart --from 'chrome:Profile 1'
  codex-app profile restart --from 'chrome:Work' --conversation <session-id> --replace

The signed App bundle is not modified. The IAB runtime patch is applied only in memory.`;
}

export function profileThreadIds(options) {
  const values = [];
  if (options.conversation != null) values.push(options.conversation);
  if (Array.isArray(options.thread)) values.push(...options.thread);
  else if (options.thread != null) values.push(options.thread);
  return [...new Set(values)];
}

export function runProfileCommand(
  subcommand,
  options = {},
  env = process.env,
) {
  if (subcommand == null || subcommand === 'help' || subcommand === '--help') {
    return profileUsage();
  }
  if (options._?.length > 1) {
    throw new Error(`profile ${subcommand} does not accept positional arguments`);
  }

  const appPath = env.CODEX_IAB_APP_PATH || '/Applications/ChatGPT.app';
  const logPath = env.CODEX_IAB_RUNTIME_LOG || defaultRuntimeLogPath();
  const partitionsPath = env.CODEX_IAB_PARTITIONS_PATH || defaultPartitionsPath();
  const chromeRoot = env.CODEX_IAB_CHROME_ROOT || path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Google',
    'Chrome',
  );

  if (subcommand === 'inspect') {
    return inspectRuntimeCompatibility(appPath);
  }
  if (subcommand === 'list') {
    return listBrowserProfiles(partitionsPath);
  }
  if (subcommand === 'chrome-list') {
    return listChromeProfiles(chromeRoot).map((profile) => ({
      source: profile.source,
      name: profile.displayName,
      directory: profile.directory,
      hasCookies: profile.hasCookies,
      hasPasswords: profile.hasPasswords,
      hasHistory: profile.hasHistory,
    }));
  }
  if (subcommand === 'restart') {
    const threadIds = profileThreadIds(options);
    if (options.replace && threadIds.length === 0) {
      throw new Error('--replace requires --conversation or --thread');
    }
    return restartAppWithThreadProfiles({
      appPath,
      logPath,
      seedFrom: options.from ?? 'default',
      threadIds,
      replaceSeed: Boolean(options.replace),
      partitionsPath,
      chromeRoot,
    });
  }
  if (subcommand === 'status') {
    const pids = findAppMainProcesses(appPath);
    const events = readRuntimeEvents(logPath);
    const activeEvent = events.findLast((event) =>
      pids.includes(event.pid) && event.event === 'main-bundle-patched-in-memory') ?? null;
    const remountEvent = events.findLast((event) =>
      pids.includes(event.pid) && event.event === 'browser-service-path-remounted') ?? null;
    return {
      pids,
      runtimeActive: activeEvent?.runtimePatchVersion === RUNTIME_PATCH_VERSION,
      latestRuntimeEvent: activeEvent,
      latestBrowserServiceRemount: remountEvent,
      browserService: inspectBrowserServiceModule(),
      runtimePatchVersion: RUNTIME_PATCH_VERSION,
      signedAppModified: false,
    };
  }
  if (subcommand === 'restore') {
    return restoreNormalApp({ appPath });
  }
  throw new Error(`Unknown profile command: ${subcommand}`);
}
