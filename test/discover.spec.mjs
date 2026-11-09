/**
 * dsh-dev-runner — discovery engine tests.
 *
 * Run: node test/discover.spec.mjs
 *
 * Every fixture is built in a temp directory and deleted afterwards, so the
 * suite never touches a real project and never depends on this machine's
 * layout. The one exception is the optional `--scan <dir>` mode at the bottom,
 * which prints what discovery would propose for a real tree.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { candidateToProject, discoverProjects } from '../lib/discover.js';

const cases = [];
const only = process.argv.find((argument) => argument.startsWith('--only='))?.slice(7) ?? '';

function test(name, fn) {
  cases.push({ name, fn });
}

/** Create a file (and its parents) inside the fixture root. */
async function put(root, relative, content) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

/** Build a fresh fixture tree, hand it to `fn`, then remove it. */
async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-runner-discover-'));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const byId = (result, id) => result.candidates.find((candidate) => candidate.id === id);

test('spring boot: command, wrapper-free port from application.yml placeholder', async () => {
  await fixture(async (root) => {
    await put(root, 'garden-api/pom.xml', '<project><artifactId>spring-boot-starter-parent</artifactId><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>');
    await put(root, 'garden-api/src/main/resources/application.yml', 'server:\n  port: ${SERVER_PORT:8080}\nspring:\n  profiles:\n    active: ${ACTIVE_PROFILE:dev}\n');
    await put(root, 'garden-api/src/main/resources/application-dev.yml', 'server:\n  port: ${SERVER_PORT:8080}\n');
    const result = await discoverProjects(root);
    const api = byId(result, 'garden-api');
    assert.ok(api, 'garden-api should be discovered');
    assert.equal(api.role, 'backend');
    assert.equal(api.framework, 'spring');
    assert.equal(api.command, 'mvn -Dmaven.test.skip=true spring-boot:run');
    assert.equal(api.readyPort, 8080);
    assert.match(api.readyPortSource, /application-dev\.yml/u);
    assert.ok(api.evidence.includes('spring-boot-maven-plugin'));
  });
});

test('the active spring profile decides which application-*.yml wins', async () => {
  await fixture(async (root) => {
    await put(root, 'svc/pom.xml', '<project><artifactId>spring-boot-maven-plugin</artifactId></project>');
    await put(root, 'svc/src/main/resources/application.yml', 'server:\n  port: ${SERVER_PORT:8080}\nspring:\n  profiles:\n    active: ${ACTIVE_PROFILE:dev}\n');
    await put(root, 'svc/src/main/resources/application-dev.yml', 'server:\n  port: 8081\n');
    await put(root, 'svc/src/main/resources/application-prod.yml', 'server:\n  port: 80\n');
    const result = await discoverProjects(root);
    const svc = byId(result, 'svc');
    assert.equal(svc.readyPort, 8081, 'prod must not win over the active dev profile');
    assert.match(svc.readyPortSource, /application-dev\.yml/u);
  });
});

test('an env-only placeholder is reported, not guessed', async () => {
  await fixture(async (root) => {
    await put(root, 'svc/pom.xml', '<project><artifactId>spring-boot-maven-plugin</artifactId></project>');
    await put(root, 'svc/src/main/resources/application.yml', 'server:\n  port: ${SERVER_PORT}\n');
    const result = await discoverProjects(root);
    const svc = byId(result, 'svc');
    assert.equal(svc.readyPort, 8080);
    assert.match(svc.readyPortSource, /SERVER_PORT/u);
    assert.match(svc.readyPortSource, /convention/u);
  });
});

test('properties and inline yaml map forms are both understood', async () => {
  await fixture(async (root) => {
    await put(root, 'p1/pom.xml', '<project><artifactId>spring-boot-maven-plugin</artifactId></project>');
    await put(root, 'p1/src/main/resources/application.properties', 'server.port=9091\n');
    await put(root, 'p2/pom.xml', '<project><artifactId>spring-boot-maven-plugin</artifactId></project>');
    await put(root, 'p2/src/main/resources/application.yml', 'server: { port: 9092 }\n');
    const result = await discoverProjects(root);
    assert.equal(byId(result, 'p1').readyPort, 9091);
    assert.equal(byId(result, 'p2').readyPort, 9092);
  });
});

test('maven wrapper is preferred over a global mvn', async () => {
  await fixture(async (root) => {
    await put(root, 'svc/pom.xml', '<project><artifactId>spring-boot-maven-plugin</artifactId></project>');
    await put(root, 'svc/mvnw.cmd', '@echo off\n');
    const result = await discoverProjects(root);
    const svc = byId(result, 'svc');
    assert.ok(svc.command.startsWith('mvnw '), `expected a wrapper command, got ${svc.command}`);
    assert.equal(svc.readyPort, 8080);
    assert.equal(svc.readyPortSource, 'spring convention');
  });
});

test('vite frontend: port from vite.config.ts and its proxy hints at the backend', async () => {
  await fixture(async (root) => {
    await put(root, 'api/pom.xml', '<project><artifactId>spring-boot-maven-plugin</artifactId></project>');
    await put(root, 'api/src/main/resources/application.yml', 'server:\n  port: 8080\n');
    await put(root, 'web/package.json', JSON.stringify({ name: 'web', scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
    await put(root, 'web/vite.config.ts', "export default { server: { port: 5174, proxy: { '/api': { target: 'http://localhost:8080' } } } }\n");
    const result = await discoverProjects(root);
    const web = byId(result, 'web');
    assert.equal(web.role, 'frontend');
    assert.equal(web.framework, 'vite');
    assert.equal(web.command, 'npm run dev');
    assert.equal(web.readyPort, 5174);
    assert.match(web.readyPortSource, /vite\.config\.ts/u);
    assert.deepEqual(web.dependsOn, ['api']);
    assert.match(web.dependsOnWhy, /proxy targets port 8080/u);
  });
});

test('pnpm lockfile switches the runner', async () => {
  await fixture(async (root) => {
    await put(root, 'admin/package.json', JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
    await put(root, 'admin/pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
    const result = await discoverProjects(root);
    assert.equal(byId(result, 'admin').command, 'pnpm run dev');
  });
});

test('uni-app exposes every target and never invents a port for a compiler build', async () => {
  await fixture(async (root) => {
    await put(root, 'app/package.json', JSON.stringify({
      scripts: { 'dev:h5': 'uni -p h5 --mode dev', 'dev:mp-weixin': 'uni -p mp-weixin --mode dev', 'build:h5': 'uni build -p h5' },
      dependencies: { '@dcloudio/uni-app': '3.0.0-5000620260331001' },
      devDependencies: { vite: '5.2.8' },
    }));
    const result = await discoverProjects(root);
    const app = byId(result, 'app');
    assert.equal(app.framework, 'uni-app');
    assert.equal(app.command, 'npm run dev:h5');
    assert.equal(app.readyPort, 5173);
    assert.equal(app.readyPortSource, 'uni-app convention');
    const targets = app.commandOptions.map((option) => option.script);
    assert.deepEqual(targets.slice(0, 2), ['dev:h5', 'dev:mp-weixin']);
    const mp = app.commandOptions.find((option) => option.script === 'dev:mp-weixin');
    assert.equal(mp.readyPort, null, 'mini-program targets serve no port');
    assert.match(mp.readyPortSource, /compile-only/u);
  });
});

test('workspace root is descended into; nested projects are found', async () => {
  await fixture(async (root) => {
    await put(root, 'package.json', JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }));
    await put(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    await put(root, 'packages/site/package.json', JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
    await put(root, 'packages/edge/go.mod', 'module example.com/edge\n\ngo 1.22\n');
    const result = await discoverProjects(root);
    assert.ok(byId(result, 'site'), 'workspace child "site" should be discovered');
    assert.equal(byId(result, 'edge').framework, 'go');
    assert.equal(result.candidates.some((candidate) => candidate.cwd === root), false, 'the workspace root itself is not a project');
  });
});

test('descent stops at a real project and lists what it skipped', async () => {
  await fixture(async (root) => {
    await put(root, 'site/package.json', JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
    await put(root, 'site/legacy/package.json', JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
    const result = await discoverProjects(root);
    assert.equal(byId(result, 'site') !== undefined, true);
    assert.equal(byId(result, 'legacy'), undefined, 'a project inside a project is a separate scan, not a child row');
  });
});

test('a maven aggregator is a container: its modules are searched past maxDepth', async () => {
  await fixture(async (root) => {
    await put(root, 'mono/pom.xml', '<project><packaging>pom</packaging><modules><module>svc</module></modules></project>');
    await put(root, 'mono/svc/pom.xml', '<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>');
    await put(root, 'mono/svc/src/main/resources/application.yml', 'server:\n  port: 9099\n');
    const result = await discoverProjects(root, { maxDepth: 1 });
    assert.equal(byId(result, 'mono'), undefined, 'the aggregator itself is not a project');
    const service = byId(result, 'svc');
    assert.ok(service !== undefined, 'the module one level below the aggregator is found');
    assert.equal(service.readyPort, 9099);
  });
});

test('a plain maven pom with no start plugin proposes nothing', async () => {
  await fixture(async (root) => {
    await put(root, 'shared-lib/pom.xml', '<project><artifactId>shared-lib</artifactId></project>');
    await put(root, 'shared-lib/src/main/java/A.java', 'class A {}\n');
    const result = await discoverProjects(root);
    assert.deepEqual(result.candidates, [], 'with no runnable goal there is no honest command to offer');
  });
});

test('exec:java is only proposed when the pom names a main class', async () => {
  await fixture(async (root) => {
    await put(root, 'worker/pom.xml', '<project><build><plugins><plugin><artifactId>exec-maven-plugin</artifactId><configuration><mainClass>com.example.Main</mainClass></configuration></plugin></plugins></build></project>');
    await put(root, 'nameless/pom.xml', '<project><build><plugins><plugin><artifactId>exec-maven-plugin</artifactId></plugin></plugins></build></project>');
    const result = await discoverProjects(root);
    const worker = byId(result, 'worker');
    assert.equal(worker.command, 'mvn exec:java');
    assert.equal(worker.framework, 'exec-maven-plugin');
    assert.equal(worker.readyPort, null, 'a plain JVM program declares no port, and we do not invent one');
    assert.match(worker.readyPortSource, /unknown/u);
    assert.equal(byId(result, 'nameless'), undefined, 'without a main class exec:java cannot start');
  });
});

test('android projects are not dev servers', async () => {
  await fixture(async (root) => {
    await put(root, 'calendar/settings.gradle.kts', 'include(":app")\n');
    await put(root, 'calendar/build.gradle.kts', 'allprojects {\n  repositories {\n    google()\n  }\n}\n');
    await put(root, 'calendar/app/build.gradle.kts', 'plugins {\n  id("com.android.application")\n}\nandroid {\n  namespace = "x"\n}\n');
    const result = await discoverProjects(root);
    assert.deepEqual(result.candidates, [], 'an android module has no run task to offer');
  });
});

test('gradle needs a plugin that really provides run', async () => {
  await fixture(async (root) => {
    await put(root, 'plain/build.gradle', 'tasks.register("hello") { }\n');
    await put(root, 'cli/build.gradle', 'plugins {\n  id("application")\n}\n');
    const result = await discoverProjects(root);
    assert.equal(byId(result, 'plain'), undefined, 'no application or boot plugin means gradle run is a guess');
    const cli = byId(result, 'cli');
    assert.equal(cli.framework, 'gradle-application');
    assert.match(cli.command, /^(gradlew\.bat|\.\/gradlew|gradle) run$/u);
  });
});

test('node_modules and other build dirs are ignored', async () => {
  await fixture(async (root) => {
    await put(root, 'node_modules/left-pad/package.json', JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
    await put(root, 'target/generated/package.json', JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
    await put(root, 'dist/package.json', JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
    const result = await discoverProjects(root);
    assert.deepEqual(result.candidates, []);
  });
});

test('python, go and compose are recognised in their own roles', async () => {
  await fixture(async (root) => {
    await put(root, 'django-app/manage.py', 'import django\n');
    await put(root, 'django-app/requirements.txt', 'Django==5.0\n');
    await put(root, 'fastapi-app/pyproject.toml', '[project]\ndependencies = ["fastapi"]\n');
    await put(root, 'fastapi-app/app/__init__.py', '');
    await put(root, 'go-svc/go.mod', 'module example.com/svc\n');
    await put(root, 'infra/docker-compose.yml', 'services:\n  db:\n    image: mysql:8\n    ports:\n      - "3307:3306"\n');
    const result = await discoverProjects(root);
    assert.equal(byId(result, 'django-app').command, 'python manage.py runserver');
    assert.equal(byId(result, 'django-app').readyPort, 8000);
    assert.equal(byId(result, 'fastapi-app').command, 'uvicorn app.main:app --reload');
    assert.equal(byId(result, 'go-svc').role, 'service');
    const infra = byId(result, 'infra');
    assert.equal(infra.role, 'infra');
    assert.equal(infra.readyPort, 3307);
    assert.match(infra.evidence[0], /1 service: db/u);
  });
});

test('maxDepth limits the walk', async () => {
  await fixture(async (root) => {
    await put(root, 'a/b/site/package.json', JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
    assert.equal(byId(await discoverProjects(root, { maxDepth: 1 }), 'site'), undefined);
    assert.ok(byId(await discoverProjects(root, { maxDepth: 3 }), 'site'));
  });
});

test('a pathological tree is bounded by maxDirs, and says so', async () => {
  await fixture(async (root) => {
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await put(root, `${name}/deep/package.json`, JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
    }
    const result = await discoverProjects(root, { maxDepth: 4, maxDirs: 3 });
    assert.equal(result.scanned, 3);
    assert.match(result.problems.join('\n'), /stopped after 3 directories/u);
  });
});

test('a junction pointing back up the tree cannot loop the walk', async () => {
  await fixture(async (root) => {
    await put(root, 'site/package.json', JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
    let linked = false;
    try {
      await fs.symlink(root, path.join(root, 'site', 'loop'), 'junction');
      linked = true;
    } catch {
      linked = false;
    }
    if (!linked) {
      console.log('  skip junction is not creatable here');
      return;
    }
    const result = await discoverProjects(root, { maxDepth: 4 });
    assert.ok(byId(result, 'site'), 'the project is still found');
    assert.ok(result.scanned < 10, `the walk must terminate, scanned ${result.scanned}`);
  });
});

test('a spring block with blank lines and comments is read in linear time', async () => {
  // Regression: the first implementation found the active profile with
  // `(?:[ \t]+[^\r\n]*\r?\n)*?[ \t]+active…`, whose nested quantifier is
  // exponential. A real 63-line application.yml hung the scan for minutes;
  // this fixture is the same shape, and the assertion is wall-clock.
  await fixture(async (root) => {
    const lines = [
      'server:',
      '  port: 8081',
      'spring:',
      '  profiles:',
      '',
      '    # the profile below is chosen per machine',
      '    active: dev',
    ];
    for (let index = 0; index < 40; index += 1) lines.push(`  padding-${index}: ${'x'.repeat(20)}`);
    await put(root, 'svc/pom.xml', '<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>');
    await put(root, 'svc/src/main/resources/application.yml', `${lines.join('\n')}\n`);
    await put(root, 'svc/src/main/resources/application-dev.yml', 'server:\n  port: 8091\n');
    await put(root, 'svc/src/main/resources/application-prod.yml', 'server:\n  port: 80\n');

    const started = Date.now();
    const result = await discoverProjects(root);
    const took = Date.now() - started;
    assert.ok(took < 2000, `the scan must not backtrack: took ${took} ms`);
    const svc = byId(result, 'svc');
    assert.equal(svc.readyPort, 8091, 'the active dev profile wins over prod');
    assert.match(svc.readyPortSource, /application-dev\.yml/u);
  });
});

test('a spring block that never names its app cannot stall the walk', async () => {
  // Regression: the app-name matcher used to be one regex whose inner
  // '[ \\t]+[^\\r\\n]*' could split every line two ways, so a 'spring:' key with
  // no 'application.name:' after it cost 2^lines backtracks - a pinned core and
  // no answer, which is what scanning a real Spring tree did.
  await fixture(async (root) => {
    const lines = ['server:', '  port: 8123', 'spring:'];
    for (let index = 0; index < 200; index += 1) lines.push('  padding-' + index + ': ' + 'y'.repeat(24));
    await put(root, 'svc/pom.xml', '<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>');
    await put(root, 'svc/src/main/resources/application.yml', lines.join('\n') + '\n');
    const started = Date.now();
    const result = await discoverProjects(root);
    const took = Date.now() - started;
    assert.ok(took < 3000, 'a config with no app name must not backtrack: took ' + took + ' ms');
    const svc = byId(result, 'svc');
    assert.ok(svc, 'the project is still found');
    assert.equal(svc.readyPort, 8123);
  });
});

test('a cancelled scan stops the walk and reports what it had', async () => {
  await fixture(async (root) => {
    for (let index = 0; index < 8; index += 1) {
      await put(root, 'svc-' + index + '/package.json', JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
    }
    const controller = new AbortController();
    controller.abort();
    const result = await discoverProjects(root, { signal: controller.signal });
    assert.equal(result.cancelled, true, 'the result must say it was cancelled');
    assert.match(result.problems.join('\n'), /scan cancelled/u);
    assert.equal(result.candidates.length, 0, 'a scan that never ran claims nothing');
  });
});

test('expo projects are frontends, not node services', async () => {
  await fixture(async (root) => {
    await put(root, 'app/package.json', JSON.stringify({ scripts: { start: 'expo start' }, dependencies: { expo: '~50.0.0' } }));
    const result = await discoverProjects(root);
    const app = byId(result, 'app');
    assert.equal(app.framework, 'expo');
    assert.equal(app.role, 'frontend');
    assert.equal(app.command, 'npm run start');
  });
});

test('a missing directory is reported, not thrown', async () => {
  const result = await discoverProjects(path.join(os.tmpdir(), 'dev-runner-does-not-exist-12345'));
  assert.deepEqual(result.candidates, []);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /directory not found/u);
});

test('candidateToProject keeps configuration fields and drops discovery notes', async () => {
  const project = candidateToProject({
    id: 'api', name: 'api', cwd: 'C:/x/api', command: 'mvn spring-boot:run', role: 'backend',
    framework: 'spring', readyPort: 8080, dependsOn: ['db'], dependsOnWhy: 'because', evidence: ['pom.xml'], commandOptions: [{}],
  });
  assert.deepEqual(project, {
    id: 'api', name: 'api', cwd: 'C:/x/api', command: 'mvn spring-boot:run', role: 'backend',
    framework: 'spring', readyPort: 8080, dependsOn: ['db'], before: [], source: 'discovered',
  });
});

test('a UTF-8 BOM does not hide the port (PowerShell and Notepad both write one)', async () => {
  await fixture(async (root) => {
    await put(root, 'api/pom.xml', '<project><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>');
    // The BOM makes the first line `\uFEFFserver:`, which no line-anchored YAML
    // pattern matches. Before the fix the port silently fell back to the 8080
    // convention, and in a multi-service scan that made every service look like
    // it wanted the same port.
    await fs.mkdir(path.join(root, 'api/src/main/resources'), { recursive: true });
    await fs.writeFile(path.join(root, 'api/src/main/resources/application.yml'), '\uFEFFserver:\n  port: 9000\n', 'utf8');
    const result = await discoverProjects(root);
    const api = byId(result, 'api');
    assert.equal(api.readyPort, 9000);
    assert.match(api.readyPortSource, /application\.yml/u);
  });
});

test('a monorepo with a backend and a frontend yields both, and links them', async () => {
  await fixture(async (root) => {
    await put(root, 'app/backend/pom.xml', '<project><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>');
    await put(root, 'app/backend/src/main/resources/application.yml', 'server:\n  port: 9000\n');
    await put(root, 'app/frontend/package.json', JSON.stringify({ name: 'web', scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
    await put(root, 'app/frontend/vite.config.js', 'export default {}\n');
    const result = await discoverProjects(root, { maxDepth: 4 });
    const backend = byId(result, 'backend');
    const frontend = byId(result, 'frontend');
    assert.ok(backend, 'the backend is found');
    assert.ok(frontend, 'the frontend is found too (it used to vanish when both claimed 8080)');
    assert.equal(backend.readyPort, 9000);
    assert.equal(frontend.role, 'frontend');
    assert.deepEqual(frontend.dependsOn, ['backend']);
  });
});

test('a spring cloud aggregator yields one candidate per service with its own port', async () => {
  await fixture(async (root) => {
    await put(root, 'cloud/pom.xml', '<project><packaging>pom</packaging><modules><module>gateway</module><module>users</module></modules></project>');
    for (const [name, port] of [['gateway', 8080], ['users', 8081]]) {
      await put(root, `cloud/${name}/pom.xml`, `<project><artifactId>${name}</artifactId><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>`);
      await put(root, `cloud/${name}/src/main/resources/application.yml`, `server:\n  port: ${port}\n`);
    }
    const result = await discoverProjects(root, { maxDepth: 4 });
    assert.equal(result.candidates.length, 2, 'the aggregator itself is not a candidate');
    assert.equal(byId(result, 'gateway').readyPort, 8080);
    assert.equal(byId(result, 'users').readyPort, 8081);
  });
});

test('a @FeignClient call becomes a dependency, and an unknown service does not', async () => {
  await fixture(async (root) => {
    const pom = '<project><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>';
    for (const [name, port] of [['users', 8081], ['orders', 8082]]) {
      await put(root, `svc/${name}/pom.xml`, pom);
      await put(root, `svc/${name}/src/main/resources/application.yml`, `server:\n  port: ${port}\nspring:\n  application:\n    name: ${name}\n`);
    }
    await put(root, 'svc/orders/src/main/java/UserClient.java', '@FeignClient(name = "users")\npublic interface UserClient {}\n');
    // A call to something that was not scanned must not invent an edge.
    await put(root, 'svc/orders/src/main/java/PayClient.java', 'class Pay { String u = "http://payment-service/x"; }\n');
    const result = await discoverProjects(root, { maxDepth: 4 });
    const orders = byId(result, 'orders');
    assert.deepEqual(orders.calls.slice().sort(), ['payment-service', 'users']);
    assert.deepEqual(orders.dependsOn, ['users']);
    assert.match(orders.dependsOnWhy, /calls service "users"/u);
    assert.deepEqual(byId(result, 'users').dependsOn, []);
  });
});

test('a scannable nacos server becomes a dependency of the services that register with it', async () => {
  await fixture(async (root) => {
    const pom = '<project><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>';
    await put(root, 'stack/nacos/pom.xml', pom);
    await put(root, 'stack/nacos/src/main/resources/application.yml', 'server:\n  port: 8848\n');
    await put(root, 'stack/orders/pom.xml', pom);
    await put(root, 'stack/orders/src/main/resources/application.yml', 'server:\n  port: 8082\nspring:\n  cloud:\n    nacos:\n      discovery:\n        server-addr: 127.0.0.1:8848\n');
    await put(root, 'stack/plain/pom.xml', pom);
    await put(root, 'stack/plain/src/main/resources/application.yml', 'server:\n  port: 8083\n');
    const result = await discoverProjects(root, { maxDepth: 4 });
    assert.deepEqual(byId(result, 'orders').dependsOn, ['nacos']);
    assert.match(byId(result, 'orders').dependsOnWhy, /registers with 127\.0\.0\.1:8848/u);
    assert.deepEqual(byId(result, 'plain').dependsOn, [], 'a service with no registry declaration waits for nothing');
  });
});

test('eureka: defaultZone lists several peers, and the one that was scanned wins', async () => {
  await fixture(async (root) => {
    const pom = '<project><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>';
    // The scanned registry is the SECOND peer. Reading only the first instance
    // (`eureka-1`) would leave `orders` with no edge at all.
    await put(root, 'stack/eureka-2/pom.xml', pom);
    await put(root, 'stack/eureka-2/src/main/resources/application.yml', 'server:\n  port: 8761\n');
    await put(root, 'stack/orders/pom.xml', pom);
    await put(root, 'stack/orders/src/main/resources/application.yml', [
      'server:',
      '  port: 8082',
      'eureka:',
      '  client:',
      '    service-url:',
      '      defaultZone: http://eureka-1:8761/eureka/,http://127.0.0.1:8761/eureka/',
      '',
    ].join('\n'));
    const result = await discoverProjects(root, { maxDepth: 4 });
    const orders = byId(result, 'orders');
    assert.deepEqual(orders.registry, ['eureka-1:8761', '127.0.0.1:8761'], 'every peer is recorded');
    assert.deepEqual(orders.dependsOn, ['eureka-2'], 'the local peer is the one that matters');
  });
});

test('eureka: a ${PLACEHOLDER} is not guessed, so an unresolved host never invents an edge', async () => {
  await fixture(async (root) => {
    const pom = '<project><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>';
    await put(root, 'stack/eureka/pom.xml', pom);
    await put(root, 'stack/eureka/src/main/resources/application.yml', 'server:\n  port: 8761\n');
    await put(root, 'stack/orders/pom.xml', pom);
    // Spring would resolve the default, but the scan cannot know the property is
    // set in the deployment environment - so it must not claim the edge.
    await put(root, 'stack/orders/src/main/resources/application.yml', 'eureka:\n  client:\n    service-url:\n      defaultZone: ${EUREKA_URL:http://eureka:8761}/eureka/\n');
    const result = await discoverProjects(root, { maxDepth: 4 });
    assert.deepEqual(byId(result, 'orders').registry, []);
    assert.deepEqual(byId(result, 'orders').dependsOn, []);
  });
});

test('nacos: a comma-separated cluster resolves against the scanned member', async () => {
  await fixture(async (root) => {
    const pom = '<project><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>';
    await put(root, 'stack/nacos/pom.xml', pom);
    await put(root, 'stack/nacos/src/main/resources/application.yml', 'server:\n  port: 8848\n');
    await put(root, 'stack/gateway/pom.xml', pom);
    await put(root, 'stack/gateway/src/main/resources/application.properties', 'server.port=8080\nspring.cloud.nacos.discovery.server-addr=nacos-node-1:8848,nacos:8848\n');
    const result = await discoverProjects(root, { maxDepth: 4 });
    assert.deepEqual(byId(result, 'gateway').dependsOn, ['nacos']);
  });
});

test('dubbo: @DubboReference names an interface, which maps back to the providing application', async () => {
  await fixture(async (root) => {
    const pom = '<project><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>';
    await put(root, 'dubbo/user-provider/pom.xml', pom);
    await put(root, 'dubbo/user-provider/src/main/resources/application.yml', 'dubbo:\n  application:\n    name: user-provider\n  protocol:\n    port: 20880\n');
    await put(root, 'dubbo/order-provider/pom.xml', pom);
    await put(root, 'dubbo/order-provider/src/main/resources/application.yml', 'dubbo:\n  application:\n    name: order-provider\n');
    // The interface package is the only handle the caller has on the provider:
    // com.acme.user.api.UserApi -> "user".
    await put(root, 'dubbo/order-provider/src/main/java/OrderService.java', [
      '@DubboReference(interfaceClass = com.acme.user.api.UserApi.class)',
      'private UserApi userApi;',
      '',
    ].join('\n'));
    const result = await discoverProjects(root, { maxDepth: 4 });
    const order = byId(result, 'order-provider');
    assert.ok(order.calls.includes('user'), 'the interface package maps to a candidate alias');
    assert.deepEqual(order.dependsOn, ['user-provider']);
  });
});

test('config center: bootstrapping from a scanned apollo server is a dependency, and its config is not a workload', async () => {
  await fixture(async (root) => {
    const pom = '<project><build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>';
    await put(root, 'ctrl/apollo/pom.xml', pom);
    await put(root, 'ctrl/apollo/src/main/resources/application.yml', 'server:\n  port: 8070\n');
    await put(root, 'ctrl/orders/pom.xml', pom);
    await put(root, 'ctrl/orders/src/main/resources/bootstrap.yml', 'apollo:\n  meta: http://127.0.0.1:8070\n');
    const result = await discoverProjects(root, { maxDepth: 4 });
    const orders = byId(result, 'orders');
    assert.deepEqual(orders.configCenter, ['127.0.0.1:8070']);
    assert.deepEqual(orders.dependsOn, ['apollo']);
    assert.match(orders.dependsOnWhy, /reads configuration from 127\.0\.0\.1:8070/u);
  });
});

test('kubernetes: manifests are a one-shot deploy, and a stray yaml is not one', async () => {
  await fixture(async (root) => {
    await put(root, 'deploy/k8s/deployment.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: orders\nspec:\n  containers:\n    - name: orders\n      ports:\n        - containerPort: 8082\n');
    await put(root, 'deploy/k8s/service.yaml', 'apiVersion: v1\nkind: Service\nmetadata:\n  name: orders\n');
    // No apiVersion: a resources folder of plain YAML is not a workload.
    await put(root, 'deploy/notes/rules.yaml', 'rules:\n  - allow: all\n');
    const result = await discoverProjects(root, { maxDepth: 4 });
    const k8s = byId(result, 'k8s');
    assert.ok(k8s, 'the manifest folder is found');
    assert.equal(k8s.framework, 'kubernetes');
    assert.equal(k8s.oneShot, true);
    assert.equal(k8s.command, 'kubectl apply -f .');
    assert.equal(k8s.readyPort, 8082, 'containerPort is read as evidence');
    assert.equal(byId(result, 'notes'), undefined, 'a yaml without apiVersion is not a workload folder');
    const project = candidateToProject(k8s);
    assert.equal(project.oneShot, true, 'the flag survives the trip into a project');
  });
});

test('kubernetes: a kustomization is applied with -k and offers the rendered form', async () => {
  await fixture(async (root) => {
    await put(root, 'stack/kustomization.yaml', 'resources:\n  - deployment.yaml\n');
    await put(root, 'stack/deployment.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n');
    const result = await discoverProjects(root, { maxDepth: 3 });
    const stack = byId(result, 'stack');
    assert.equal(stack.command, 'kubectl apply -k .');
    assert.equal(stack.commandOptions.length, 2);
    assert.match(stack.commandOptions[1].command, /kustomize build \. \| kubectl apply -f -/u);
    assert.equal(stack.readyPort, null, 'a deployment without containerPort has no port to probe');
  });
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
    process.stdout.write(`  FAIL ${name}\n       ${String(error.message).replace(/\n/gu, '\n       ')}\n`);
  }
}

process.stdout.write(`\n${passed}/${passed + failures.length} discovery tests passed\n`);
if (failures.length > 0) process.exitCode = 1;

// --- optional real-tree scan: node test/discover.spec.mjs --scan <dir> ---------
const scanIndex = process.argv.indexOf('--scan');
if (scanIndex !== -1) {
  const target = process.argv[scanIndex + 1];
  const result = await discoverProjects(target, { maxDepth: 2 });
  process.stdout.write(`\nscan ${result.root} — ${result.scanned} dirs, ${result.candidates.length} candidate(s)\n`);
  for (const candidate of result.candidates) {
    process.stdout.write(`  [${candidate.role}] ${candidate.name}\n`);
    process.stdout.write(`      command: ${candidate.command}\n`);
    process.stdout.write(`      port: ${candidate.readyPort ?? '-'} (${candidate.readyPortSource})\n`);
    if (candidate.dependsOn?.length > 0) process.stdout.write(`      dependsOn: ${candidate.dependsOn.join(', ')} — ${candidate.dependsOnWhy}\n`);
    for (const option of candidate.commandOptions ?? []) {
      if (option.note !== undefined) process.stdout.write(`      option: ${option.command}  (${option.note})\n`);
    }
    process.stdout.write(`      evidence: ${candidate.evidence.join(' | ')}\n`);
  }
  for (const problem of result.problems) process.stdout.write(`  problem: ${problem}\n`);
}
