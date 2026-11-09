/**
 * The exported `Config` schema is load-bearing: the harness loader validates a
 * profile's config through it before the plugin runs, and a schema that rejects
 * a config the plugin would happily normalize turns a typo into "the plugin
 * never loaded". These tests pin three properties:
 *
 *   1. the shape this profile actually configures still validates,
 *   2. absent fields come back filled with the documented defaults,
 *   3. extra keys and out-of-range-but-plausible values do not throw.
 *
 * Validation goes through the Standard Schema interface because that is exactly
 * what the loader calls (`runtime.Config["~standard"].validate(config)`), so the
 * test exercises the real path rather than a schemastery convenience wrapper.
 */

import assert from 'node:assert/strict';
import { Config } from '../lib/index.js';

let failures = 0;
function test(label, body) {
  try {
    body();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${label}`);
    console.log(String(error?.stack ?? error).split('\n').slice(0, 6).join('\n'));
  }
}

function validate(value) {
  const result = Config['~standard'].validate(value);
  if ('issues' in result && result.issues) throw new Error(`validation failed: ${JSON.stringify(result.issues)}`);
  return result.value;
}

// The real profile config (cordis.patch.yml, id: dev-runner), copied verbatim
// including the fields this plugin never writes itself.
const PROFILE_CONFIG = {
  projects: [
    {
      id: 'backend',
      name: 'backend',
      command: 'mvn -Dmaven.test.skip=true spring-boot:run',
      cwd: 'D:\\document\\learn\\garden\\garden-api',
      readyPort: 8080,
    },
    {
      id: 'frontend',
      name: 'frontend',
      command: 'npm run dev:h5',
      cwd: 'D:\\document\\learn\\garden\\garden-uniapp',
      dependsOn: ['backend'],
      readyPort: 5173,
    },
  ],
};

test('the profile config this plugin ships against still validates', () => {
  const value = validate(PROFILE_CONFIG);
  assert.equal(value.projects.length, 2);
  assert.equal(value.projects[0].command, 'mvn -Dmaven.test.skip=true spring-boot:run');
  assert.equal(value.projects[0].readyPort, 8080);
  assert.deepEqual(value.projects[1].dependsOn, ['backend']);
});

test('absent fields are filled with defaults rather than left undefined', () => {
  const value = validate(PROFILE_CONFIG);
  const [backend] = value.projects;
  assert.equal(backend.args, '');
  assert.deepEqual(backend.env, {});
  assert.equal(backend.role, 'service');
  assert.equal(backend.autoRestart, false);
  assert.equal(backend.readyTimeoutMs, 120_000);
  assert.equal(backend.stopGraceMs, 8_000);
  assert.equal(backend.restartDelayMs, 1_000);
  assert.deepEqual(backend.before, []);
  assert.equal(value.discoverDepth, 2);
});

test('an empty config is valid and yields an empty project table', () => {
  const value = validate({});
  assert.deepEqual(value.projects, []);
  assert.equal(value.discoverDepth, 2);
});

test('unknown keys do not invalidate a config', () => {
  const value = validate({
    projects: [{ id: 'web', command: 'npm run dev', cwd: '/tmp/web', source: 'discovered', describe: 'x' }],
    somethingElse: true,
  });
  assert.equal(value.projects.length, 1);
  assert.equal(value.projects[0].id, 'web');
});

test('a half-filled project still validates; the store is what rejects it', () => {
  // No cwd, no command: `lib/store.js` records the problem and drops the row,
  // which is a diagnosable outcome. The schema must not be the thing that
  // decides the plugin cannot load at all.
  const value = validate({ projects: [{ id: 'broken' }] });
  assert.equal(value.projects.length, 1);
});

test('a project can carry before steps and env entries', () => {
  const value = validate({
    projects: [{
      id: 'api',
      command: 'mvn spring-boot:run',
      cwd: '/srv/api',
      env: { SPRING_PROFILES_ACTIVE: 'dev' },
      autoRestart: true,
      before: [{ name: 'compile', command: 'mvn -q compile', expect: 'compile' }],
    }],
  });
  assert.deepEqual(value.projects[0].env, { SPRING_PROFILES_ACTIVE: 'dev' });
  assert.equal(value.projects[0].autoRestart, true);
  assert.equal(value.projects[0].before[0].command, 'mvn -q compile');
  assert.equal(value.projects[0].before[0].timeoutMs, 120_000);
  assert.equal(value.projects[0].before[0].continueOnError, false);
});

if (failures > 0) {
  console.log(`\n${6 - failures}/6 config tests passed`);
  process.exitCode = 1;
} else {
  console.log('\n6/6 config tests passed');
}
