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

  assert.equal(packageJson.files.includes('.agents'), true);
  assert.match(skill, /^name: codex-session-in-codex-app$/m);
  assert.match(skill, /--fast on\|off/);
  assert.equal(fs.existsSync(path.join(skillRoot, 'scripts', 'run.sh')), true);
  assert.equal(fs.existsSync(path.join(skillRoot, 'agents', 'openai.yaml')), true);
});
