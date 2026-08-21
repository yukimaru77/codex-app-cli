import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = path.join(repositoryRoot, '.agents', 'skills', 'codex-session-in-codex-app');

test('packages the repository-scoped Codex App session skill', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const commandGuide = fs.readFileSync(path.join(skillRoot, 'references', 'command-guide.md'), 'utf8');
  const forkToApp = fs.readFileSync(path.join(skillRoot, 'references', 'fork-to-app.md'), 'utf8');

  assert.equal(packageJson.files.includes('.agents'), true);
  assert.match(skill, /^name: codex-session-in-codex-app$/m);
  assert.match(skill, /--fast on\|off/);
  assert.match(skill, /references\/command-guide\.md/);
  assert.match(skill, /references\/fork-to-app\.md/);
  assert.match(commandGuide, /codex-app status/);
  assert.match(commandGuide, /codex-app new/);
  assert.match(commandGuide, /codex-app send/);
  assert.match(commandGuide, /codex-app recognize/);
  assert.match(commandGuide, /codex-app profile/);
  assert.match(forkToApp, /codex fork SOURCE_SESSION_ID/);
  assert.match(forkToApp, /codex-app recognize/);
  assert.match(forkToApp, /codex-app send/);
  assert.match(forkToApp, /Do not use `codex-app new`/);
  assert.equal(fs.existsSync(path.join(skillRoot, 'scripts', 'run.sh')), true);
  assert.equal(fs.existsSync(path.join(skillRoot, 'agents', 'openai.yaml')), true);
});
