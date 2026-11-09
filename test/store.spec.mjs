/**
 * dsh-dev-runner — config store tests.
 *
 * Run: node test/store.spec.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ProjectStore, normalizeProjects, slugify, toDocument } from '../lib/store.js';

const cases = [];
const only = process.argv.find((argument) => argument.startsWith('--only='))?.slice(7) ?? '';

function test(name, fn) {
  cases.push({ name, fn });
}

async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-runner-store-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('slugify keeps ids stable and shell-safe', () => {
  assert.equal(slugify('Garden-Api'), 'garden-api');
  assert.equal(slugify('garden_api'), 'garden-api');
  assert.equal(slugify('garden.api'), 'garden-api');
  assert.equal(slugify('  '), 'project');
});

test('a project only needs cwd and command; the rest is defaulted', () => {
  const { projects, problems } = normalizeProjects([{ cwd: 'C:/x/garden-api', command: 'mvn spring-boot:run' }]);
  assert.deepEqual(problems, []);
  assert.equal(projects.length, 1);
  const [project] = projects;
  assert.equal(project.id, 'garden-api');
  assert.equal(project.name, 'garden-api');
  assert.equal(project.readyTimeoutMs, 120_000);
  assert.equal(project.stopGraceMs, 8_000);
  assert.equal(project.autoRestart, false);
  assert.deepEqual(project.env, {});
  assert.deepEqual(project.before, []);
});

test('entries without a command or cwd are rejected with a reason', () => {
  const { projects, problems } = normalizeProjects([
    { id: 'api', cwd: 'C:/x/api' },
    { id: 'web', command: 'npm run dev' },
    null,
  ]);
  assert.deepEqual(projects, []);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /missing "command"/u);
  assert.match(problems[1], /missing "cwd"/u);
  assert.match(problems[2], /not an object/u);
});

test('duplicate ids are dropped, the first wins', () => {
  const { projects, problems } = normalizeProjects([
    { id: 'api', cwd: 'C:/x/api', command: 'mvn spring-boot:run' },
    { id: 'api', cwd: 'C:/y/api', command: 'mvn spring-boot:run' },
  ]);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].cwd, 'C:/x/api');
  assert.match(problems[0], /duplicate id/u);
});

test('env accepts both the object and the KEY=VALUE array form', () => {
  const { projects } = normalizeProjects([
    { id: 'a', cwd: 'C:/a', command: 'run', env: { JAVA_HOME: 'C:/jdk', SKIP: undefined } },
    { id: 'b', cwd: 'C:/b', command: 'run', env: ['MODE=dev', 'BROKEN', 'SPACED= a b '] },
  ]);
  assert.deepEqual(projects[0].env, { JAVA_HOME: 'C:/jdk' });
  assert.deepEqual(projects[1].env, { MODE: 'dev', SPACED: 'a b' });
});

test('numeric fields fall back to their defaults instead of being coerced', () => {
  const { projects, problems } = normalizeProjects([
    { id: 'a', cwd: 'C:/a', command: 'run', readyPort: 99999, readyTimeoutMs: 10, stopGraceMs: 10 ** 9 },
    { id: 'b', cwd: 'C:/b', command: 'run', readyPort: '8123', readyTimeoutMs: '45000' },
  ]);
  assert.equal(projects[0].readyPort, null, 'out-of-range ports are ignored, never coerced');
  assert.equal(projects[0].readyTimeoutMs, 120_000, 'an absurd timeout falls back to the default');
  assert.equal(projects[0].stopGraceMs, 8_000);
  assert.equal(projects[1].readyPort, 8123, 'a numeric string is still a number');
  assert.equal(projects[1].readyTimeoutMs, 45_000);
  assert.match(problems.join('\n'), /not a port number/u);
});

test('a malformed readyUrl is reported rather than started against', () => {
  const { projects, problems } = normalizeProjects([{ id: 'a', cwd: 'C:/a', command: 'run', readyUrl: 'localhost:8080' }]);
  assert.equal(projects[0].readyUrl, undefined);
  assert.match(problems[0], /readyUrl/u);
});

test('before steps need a command and get sensible defaults', () => {
  const { projects, problems } = normalizeProjects([{
    id: 'a',
    cwd: 'C:/a',
    command: 'run',
    before: [{ command: 'npm ci' }, { name: 'migrate', command: 'flyway migrate', expect: 'Successfully applied', continueOnError: true }, { name: 'nope' }, 'nonsense'],
  }]);
  assert.equal(projects[0].before.length, 2);
  assert.equal(projects[0].before[0].name, 'step 1');
  assert.equal(projects[0].before[0].timeoutMs, 120_000);
  assert.equal(projects[0].before[1].continueOnError, true);
  assert.equal(problems.filter((problem) => /before\[/u.test(problem)).length, 2);
});

test('a dependency on a project that does not exist is dropped', () => {
  const { projects, problems } = normalizeProjects([
    { id: 'web', cwd: 'C:/web', command: 'npm run dev', dependsOn: ['api', 'ghost'] },
    { id: 'api', cwd: 'C:/api', command: 'mvn spring-boot:run' },
  ]);
  const web = projects.find((project) => project.id === 'web');
  assert.deepEqual(web.dependsOn, ['api']);
  assert.match(problems.join('\n'), /unknown project/u);
});

test('a dependency cycle is reported and broken', () => {
  const { projects, problems } = normalizeProjects([
    { id: 'web', cwd: 'C:/web', command: 'npm run dev', dependsOn: ['api'] },
    { id: 'api', cwd: 'C:/api', command: 'mvn spring-boot:run', dependsOn: ['web'] },
  ]);
  const web = projects.find((project) => project.id === 'web');
  const api = projects.find((project) => project.id === 'api');
  assert.equal(web.dependsOn.includes('api') && api.dependsOn.includes('web'), false, 'the graph handed to the runner must be acyclic');
  assert.equal(web.dependsOn.includes('api') || api.dependsOn.includes('web'), true, 'only the closing edge is cut');
  assert.match(problems.join('\n'), /dependency cycle/u);
});

test('a self-reference is not a dependency', () => {
  const { projects } = normalizeProjects([{ id: 'api', cwd: 'C:/api', command: 'run', dependsOn: ['api'] }]);
  assert.deepEqual(projects[0].dependsOn, []);
});

test('a fresh store is empty and writes an atomic document', async () => {
  await fixture(async (dir) => {
    const store = new ProjectStore({ dir });
    const empty = await store.load();
    assert.deepEqual(empty, { projects: [], exists: false });
    const saved = await store.save([{ id: 'api', cwd: 'C:/api', command: 'mvn spring-boot:run', readyPort: 8080 }]);
    assert.equal(saved.projects.length, 1);
    const text = await fs.readFile(store.filePath, 'utf8');
    const document = JSON.parse(text);
    assert.equal(document.version, 1);
    assert.equal(document.projects[0].readyPort, 8080);
    assert.equal(typeof document.updatedAt, 'string');
    const entries = await fs.readdir(dir);
    assert.deepEqual(entries, ['projects.json'], 'no temp file is left behind');
    const reloaded = await store.load();
    assert.equal(reloaded.exists, true);
    assert.equal(reloaded.projects.length, 1);
  });
});

test('a corrupt file is preserved, not silently overwritten', async () => {
  await fixture(async (dir) => {
    const store = new ProjectStore({ dir });
    await fs.writeFile(store.filePath, '{ this is not json', 'utf8');
    const loaded = await store.load();
    assert.deepEqual(loaded.projects, []);
    assert.match(store.problems[0], /not valid JSON/u);
    const entries = await fs.readdir(dir);
    assert.equal(entries.filter((name) => name.includes('.corrupt-')).length, 1);
    assert.equal(entries.includes('projects.json'), false);
  });
});

test('update() round-trips through disk under a mutator', async () => {
  await fixture(async (dir) => {
    const store = new ProjectStore({ dir });
    await store.save([{ id: 'api', cwd: 'C:/api', command: 'mvn spring-boot:run' }]);
    await store.update((projects) => [...projects, { id: 'web', cwd: 'C:/web', command: 'npm run dev', dependsOn: ['api'] }]);
    const { projects } = await store.load();
    assert.deepEqual(projects.map((project) => project.id).sort(), ['api', 'web']);
    assert.deepEqual(projects.find((project) => project.id === 'web').dependsOn, ['api']);
  });
});

test('a bare array on disk is still understood (pre-envelope file)', async () => {
  await fixture(async (dir) => {
    const store = new ProjectStore({ dir });
    await fs.writeFile(store.filePath, JSON.stringify([{ id: 'api', cwd: 'C:/api', command: 'mvn spring-boot:run' }]), 'utf8');
    const { projects } = await store.load();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, 'api');
  });
});

test('toDocument stamps a version and a time', () => {
  const document = toDocument([]);
  assert.equal(document.version, 1);
  assert.match(document.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
});

let passed = 0;
const failures = [];
for (const { name, fn } of cases) {
  if (only !== '' && !name.includes(only)) continue;
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n${String(error.message).split('\n').slice(0, 6).map((line) => `       ${line}`).join('\n')}\n`);
  }
}

process.stdout.write(`\n${passed}/${passed + failures.length} store tests passed\n`);
if (failures.length > 0) process.exitCode = 1;
