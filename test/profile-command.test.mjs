import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  profileThreadIds,
  profileUsage,
  runProfileCommand,
} from '../lib/profile-command.mjs';

test('documents the integrated profile command surface', () => {
  assert.match(profileUsage(), /codex-app profile chrome-list/);
  assert.match(profileUsage(), /--conversation <id>/);
  assert.match(profileUsage(), /chrome:Profile 1/);
});

test('accepts a conversation and repeated legacy thread selectors without duplicates', () => {
  assert.deepEqual(profileThreadIds({
    conversation: 'thread-a',
    thread: ['thread-b', 'thread-a'],
  }), ['thread-a', 'thread-b']);
});

test('lists embedded Codex browser profiles without spawning codex-iab-profile', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-profile-list-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'codex-browser-app'));
  fs.mkdirSync(path.join(root, 'codex-browser-thread-a'));

  assert.deepEqual(runProfileCommand('list', {}, {
    CODEX_IAB_PARTITIONS_PATH: root,
  }), ['codex-browser-app', 'codex-browser-thread-a']);
});

test('lists Chrome profile selectors through the integrated CLI', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-chrome-list-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Profile 1'));
  fs.writeFileSync(
    path.join(root, 'Local State'),
    JSON.stringify({ profile: { info_cache: { 'Profile 1': { name: 'Work' } } } }),
  );

  const output = execFileSync(
    process.execPath,
    [path.resolve('bin/codex-app.mjs'), 'profile', 'chrome-list'],
    {
      encoding: 'utf8',
      env: { ...process.env, CODEX_IAB_CHROME_ROOT: root },
    },
  );
  assert.deepEqual(JSON.parse(output), [{
    source: 'chrome:Profile 1',
    name: 'Work',
    directory: 'Profile 1',
    hasCookies: false,
    hasPasswords: false,
    hasHistory: false,
  }]);
});

test('requires an explicit session target when replacing a profile', () => {
  assert.throws(
    () => runProfileCommand('restart', { replace: true }, {}),
    /--replace requires --conversation or --thread/,
  );
});
