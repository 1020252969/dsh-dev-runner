/**
 * dsh-dev-runner — host route and lifecycle tests.
 *
 * These run the real `apply()` against a stub host: a fake `webServer` that
 * captures the registered handler, a fake `subprocess` whose handles the test
 * drives explicitly, and a throwaway store directory. That covers the contract
 * the client depends on (routes, shapes, persistence, readiness, auto-restart)
 * without needing an Electron host per run.
 *
 * Run: node test/host.spec.mjs
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply, Runner, commandLine, readinessTarget } from '../lib/index.js';

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL ${name}`);
    console.log(String(error?.stack ?? error).split('\n').slice(0, 6).join('\n'));
  }
}

/**
 * Poll until the predicate returns something truthy. The predicate may be
 * async — awaiting it is the whole point, since a boolean buried in a promise
 * would otherwise look like success on the first tick.
 */
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A subprocess stub: commands ending in `exit N` finish; others stay alive. */
function createHost() {
  const routes = [];
  const effects = [];
  const logs = [];
  const spawned = [];
  let stubborn = false;

  const subprocess = {
    spawn(options) {
      const record = { options, stdout: [], stderr: [], terminated: 0, exitCode: null };
      let settle;
      let rejectDone;
      const done = new Promise((resolve, reject) => {
        settle = resolve;
        rejectDone = reject;
      });
      record.reject = (error) => {
        if (record.finished) return;
        record.finished = true;
        rejectDone(error);
      };
      const readStream = (stream, offset) => {
        const text = record[stream].join('');
        return { text: text.slice(offset), nextOffset: text.length };
      };
      const finish = (outcome) => {
        if (record.exitCode !== null || record.finished) return;
        record.finished = true;
        record.exitCode = outcome.exitCode ?? null;
        settle(outcome);
      };
      record.finish = finish;
      record.push = (stream, text) => record[stream].push(text);
      record.handle = {
        done,
        collected: {
          stdout: { readFrom: (offset) => readStream('stdout', offset) },
          stderr: { readFrom: (offset) => readStream('stderr', offset) },
        },
        terminate: async () => {
          record.terminated += 1;
          // A child can ignore SIGTERM for a while. When it does, `handle.done`
          // stays pending after terminate(), and anything awaiting it alone is
          // holding the user hostage. Tests that care set `host.stubborn = true`.
          if (stubborn) return;
          finish({ exitCode: null, signal: 'SIGTERM' });
        },
        waitForExit: async () => {},
      };
      spawned.push(record);

      // The real seam reports a missing working directory asynchronously, through
      // `handle.done` rejecting (`Error: spawn cmd.exe ENOENT`), not as a throw
      // from spawn(). A stub that threw synchronously would let `start()` pass
      // even with no settle window, which is exactly the bug being guarded.
      const badCwd = typeof options.cwd === 'string' && !existsSync(options.cwd);
      if (badCwd) {
        setTimeout(() => {
          // `record.reject` owns the `finished` flag; setting it here too would
          // make the reject a no-op.
          const failure = new Error(`spawn ${options.argv[0]} ENOENT (cwd ${options.cwd})`);
          record.reject?.(failure);
        }, 5);
      }

      const line = options.argv.join(' ');
      const code = /exit\s+(\d+)/u.exec(line);
      if (code !== null) setTimeout(() => finish({ exitCode: Number(code[1]), signal: null }), 5);
      return record.handle;
    },
  };

  const logger = {
    info: (message) => logs.push(`info ${message}`),
    warn: (message) => logs.push(`warn ${message}`),
    error: (message) => logs.push(`error ${message}`),
  };

  const ctx = {
    logger,
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === 'function') effects.push(dispose);
    },
    webServer: { register: (options) => routes.push(options) },
    subprocess,
  };

  return { ctx, routes, effects, logs, spawned, setStubborn: (value) => { stubborn = value; } };
}

function makeRes() {
  const res = { status: 0, headers: {}, body: '' };
  res.writeHead = (status, headers = {}) => {
    res.status = status;
    Object.assign(res.headers, headers);
  };
  res.end = (payload) => { res.body += payload ?? ''; };
  return res;
}

function makeReq({ method = 'GET', url = '/', body, address = '127.0.0.1', headers = {} }) {
  const stream = body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  stream.method = method;
  stream.url = `/dev-runner/api${url}`;
  stream.socket = { remoteAddress: address };
  stream.headers = headers;
  return stream;
}

/** Start a plugin instance and return a request helper bound to its handler. */
async function boot(config = {}) {
  const host = createHost();
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-runner-test-'));
  apply(host.ctx, { storeDir, ...config });
  assert.equal(host.routes.length, 1, 'the api route must be registered');
  const handler = host.routes[0].handler;
  const call = async (method, url, body, options = {}) => {
    const res = makeRes();
    await handler(makeReq({ method, url, body, ...options }), res);
    let json;
    try {
      json = JSON.parse(res.body);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, body: res.body, json, storeDir };
  };
  return { host, call, storeDir };
}

/**
 * The command as the seam received it, joined back into one string.
 *
 * After the tokenising change a plain command arrives as separate argv entries,
 * so assertions on "the command" must join rather than read the last element.
 */
function argvText(record) {
  const argv = record.options.argv;
  return argv[0] === 'cmd.exe' || argv[0] === '/bin/sh' ? String(argv.at(-1)) : argv.join(' ');
}
const project = (overrides = {}) => ({
  id: 'api',
  name: 'api',
  cwd: process.cwd(),
  command: 'sleep forever',
  ...overrides,
});

await test('status reports the profile config as the source when no store file exists', async () => {
  const { call } = await boot({ projects: [project()] });
  const status = await call('GET', '/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.source, 'config');
  assert.equal(status.json.projects.length, 1);
  assert.equal(status.json.projects[0].id, 'api');
  assert.equal(status.json.version, 2);
});

await test('editing the table creates the plugin-owned file and flips the source', async () => {
  const { call, storeDir } = await boot({ projects: [project()] });
  const saved = await call('PUT', '/projects', { projects: [project(), project({ id: 'web', name: 'web', command: 'npm run dev' })] });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.source, 'store');
  assert.equal(saved.json.projects.length, 2);
  const file = JSON.parse(await fs.readFile(path.join(storeDir, 'projects.json'), 'utf8'));
  assert.equal(file.version, 1);
  assert.deepEqual(file.projects.map((entry) => entry.id), ['api', 'web']);
});

await test('the store file wins over the profile config on the next activation', async () => {
  const first = await boot({ projects: [project({ id: 'from-config' })] });
  await first.call('PUT', '/projects', { projects: [project({ id: 'from-file' })] });
  const second = await boot({ storeDir: first.storeDir, projects: [project({ id: 'from-config' })] });
  const status = await second.call('GET', '/status');
  assert.equal(status.json.source, 'store');
  assert.deepEqual(status.json.projects.map((entry) => entry.id), ['from-file']);
});

await test('PUT rejects a body without a projects array', async () => {
  const { call } = await boot();
  const bad = await call('PUT', '/projects', { nope: true });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /projects/u);
});

await test('POST /projects appends a new project and updates an existing one in place', async () => {
  const { call } = await boot({ projects: [project()] });
  const added = await call('POST', '/projects', project({ id: 'web', name: 'web', command: 'npm run dev' }));
  assert.deepEqual(added.json.projects.map((entry) => entry.id), ['api', 'web']);
  const updated = await call('POST', '/projects', project({ id: 'web', name: 'renamed', command: 'npm run dev' }));
  assert.deepEqual(updated.json.projects.map((entry) => entry.id), ['api', 'web']);
  assert.equal(updated.json.projects[1].name, 'renamed');
});

await test('DELETE /projects/:id removes the project and stops it first', async () => {
  const { call, host } = await boot({ projects: [project()] });
  await call('POST', '/projects/api/start');
  assert.equal(host.spawned.length, 1);
  const removed = await call('DELETE', '/projects/api');
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.projects, []);
  assert.equal(host.spawned[0].terminated, 1);
  const missing = await call('DELETE', '/projects/api');
  assert.equal(missing.status, 404);
});

await test('starting a project streams its output and stopping terminates the range', async () => {
  const { call, host } = await boot({ projects: [project({ command: 'log hello' })] });
  const started = await call('POST', '/projects/api/start');
  assert.equal(started.json.project.state, 'running');
  host.spawned[0].push('stdout', 'listening on 8080\n');
  const page = await waitFor(async () => {
    const logs = await call('GET', '/logs?id=api&since=0');
    return logs.json.entries.some((entry) => entry.text === 'listening on 8080') ? logs.json : undefined;
  });
  assert.ok(page.entries.every((entry, index, all) => index === 0 || entry.seq > all[index - 1].seq), 'entries must be ordered');
  const stopped = await call('POST', '/projects/api/stop');
  assert.equal(stopped.json.project.state, 'stopped');
  assert.equal(host.spawned[0].terminated, 1);
});

await test('the download route returns the retained log as text', async () => {
  const { call, host } = await boot({ projects: [project({ command: 'log hello' })] });
  await call('POST', '/projects/api/start');
  host.spawned[0].push('stderr', 'boom\n');
  await waitFor(async () => {
    const text = await call('GET', '/logs.txt?id=api');
    return text.body.includes('boom') ? text : undefined;
  });
  const text = await call('GET', '/logs.txt?id=api');
  assert.equal(text.status, 200);
  assert.match(text.headers['Content-Disposition'], /api\.log/u);
  assert.match(text.body, /\[stderr\] boom/u);
});

await test('unknown ids answer 404 on every id-scoped route', async () => {
  const { call } = await boot({ projects: [project()] });
  assert.equal((await call('POST', '/projects/nope/start')).status, 404);
  assert.equal((await call('POST', '/projects/nope/stop')).status, 404);
  assert.equal((await call('GET', '/logs?id=nope')).status, 404);
  assert.equal((await call('GET', '/logs.txt?id=nope')).status, 404);
  assert.equal((await call('POST', '/projects/nope/restart')).status, 404);
});

await test('non-loopback callers are refused', async () => {
  const { host } = await boot({ projects: [project()] });
  const res = makeRes();
  await host.routes[0].handler(makeReq({ url: '/status', address: '10.0.0.5' }), res);
  assert.equal(res.status, 403);
});

await test('a page on another origin cannot drive this api, while local tooling still can', async () => {
  const { call } = await boot({ projects: [project()] });
  const host = { host: '127.0.0.1:58627' };
  const foreign = await call('GET', '/status', undefined, {
    headers: { ...host, origin: 'https://evil.example' },
  });
  assert.equal(foreign.status, 403);
  const same = await call('GET', '/status', undefined, {
    headers: { ...host, origin: 'http://127.0.0.1:58627' },
  });
  assert.equal(same.status, 200);
  const noOrigin = await call('GET', '/status', undefined, { headers: { ...host } });
  assert.equal(noOrigin.status, 200, 'curl and scripts send no Origin and must keep working');
});

await test('a project with no readiness probe is reported running, not ready', async () => {
  const { call } = await boot({ projects: [project()] });
  const started = await call('POST', '/projects/api/start');
  assert.match(started.json.project.detail, /no readiness probe/u);
});

await test('readyUrl readiness reports the HTTP status that answered', async () => {
  const server = http.createServer((req, res) => res.writeHead(204).end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const { call } = await boot({ projects: [project({ readyUrl: `http://127.0.0.1:${port}/health` })] });
    const started = await call('POST', '/projects/api/start');
    assert.match(started.json.project.detail, /ready in \d+ ms \(http:\/\/127\.0\.0\.1:\d+\/health → 204\)/u);
  } finally {
    server.close();
  }
});

await test('readyUrl accepts a self-signed HTTPS certificate', async () => {
  // Local dev servers behind TLS almost always use a self-signed certificate.
  // The probe must accept one -- it is asking "did this server answer", not
  // "is the operator's PKI healthy". Verified against a real handshake, not a
  // stub: Node's default would refuse with DEPTH_ZERO_SELF_SIGNED_CERT.
  const https = await import('node:https');
  const fs = await import('node:fs');
  const url = await import('node:url');
  // The certificate ships with the tests (test/fixtures/self-signed.pfx, ten
  // years, CN=localhost) so this check never depends on the machine's key store.
  const pfxPath = url.fileURLToPath(new URL('./fixtures/self-signed.pfx', import.meta.url));
  if (!fs.existsSync(pfxPath)) {
    console.log('     skip: self-signed fixture not present');
    return;
  }
  const server = https.createServer(
    { pfx: fs.readFileSync(pfxPath), passphrase: 'dev-runner-test' },
    (req, res) => res.writeHead(200).end('ok'),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const { call } = await boot({ projects: [project({ readyUrl: `https://127.0.0.1:${port}/health`, readyTimeoutMs: 6000 })] });
    const started = await call('POST', '/projects/api/start');
    assert.match(
      started.json.project.detail,
      new RegExp(`ready in \\d+ ms \\(https://127\\.0\\.0\\.1:${port}/health → 200\\)`, 'u'),
      'the self-signed server answered and its status is reported',
    );
  } finally {
    server.close();
  }
});

/** Find a port that nothing is listening on right now. */
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  // A just-closed socket can still swallow a connect on Windows; confirm the
  // port really is silent before handing it to a test that asserts that.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const silent = await new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(true));
    });
    if (silent) return port;
    await sleep(50);
  }
  throw new Error(`could not find a free port (last candidate ${port})`);
}

await test('readyPort readiness waits for a listener that appears after the spawn', async () => {
  // The port must be free when the project starts and answered later: a listener
  // that was already up belongs to somebody else, and claiming it as "ready in 0
  // ms" is the bug this test guards.
  const port = await freePort();
  const { call } = await boot({ projects: [project({ readyPort: port, readyHost: '127.0.0.1', readyTimeoutMs: 8000 })] });
  const pending = call('POST', '/projects/api/start');
  await sleep(400);
  const late = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => late.listen(port, '127.0.0.1', resolve));
  try {
    const started = await pending;
    assert.match(
      started.json.project.detail,
      new RegExp(`ready in \\d+ ms \\(127\\.0\\.0\\.1:${port}\\)`, 'u'),
      `expected a measured readiness, got ${started.json.project.detail}`,
    );
  } finally {
    late.close();
  }
});

await test('a port that was already taken is reported as a conflict, not as readiness', async () => {
  const squatter = http.createServer((req, res) => res.end('not ours'));
  await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const port = squatter.address().port;
  try {
    const { call } = await boot({ projects: [project({ readyPort: port, readyHost: '127.0.0.1', readyTimeoutMs: 5000 })] });
    const started = await call('POST', '/projects/api/start');
    assert.match(started.json.project.detail, /was already in use before this project started/u);
    // Note: "already in use" contains the substring "ready in" (al-READY-IN-use),
    // which is exactly why this asserts on the measured-readiness shape instead.
    assert.equal(/ready in \d+ ms/u.test(started.json.project.detail), false,
      `it must not claim measured readiness it did not earn: ${started.json.project.detail}`);
  } finally {
    squatter.close();
  }
});

await test('an unanswered readiness target becomes a warning, not a failure', async () => {
  const { call } = await boot({ projects: [project({ readyPort: 1, readyHost: '127.0.0.1', readyTimeoutMs: 1000 })] });
  const started = await call('POST', '/projects/api/start');
  assert.equal(started.json.project.state, 'running');
  assert.match(started.json.project.detail, /never answered within 1000 ms/u);
});

await test('only the project env reaches spawn, so the host keeps scrubbing credentials', async () => {
  // The subprocess provider strips credentials and DSH_* from the parent
  // environment and then merges this map. Forwarding process.env from here would
  // hand every dev server exactly the variables the host just removed.
  const { call, host } = await boot({ projects: [project({ env: { DEV_RUNNER_PROBE: 'yes' } })] });
  await call('POST', '/projects/api/start');
  const options = host.spawned[0].options;
  assert.deepEqual(options.env, { DEV_RUNNER_PROBE: 'yes' });
  assert.equal('PATH' in options.env, false, 'process.env must not be forwarded');
  assert.equal(argvText(host.spawned[0]), 'sleep forever');
});

await test('arguments are appended to the command line', async () => {
  const { call, host } = await boot({ projects: [project({ command: 'npm run dev', args: '-- --host' })] });
  await call('POST', '/projects/api/start');
  assert.deepEqual(host.spawned[0].options.argv.slice(-1), ['npm run dev -- --host']);
  assert.equal(commandLine({ command: 'npm run dev', args: '-- --host' }), 'npm run dev -- --host');
});

await test('pre-launch steps run first and abort the start when one fails', async () => {
  const { call, host } = await boot({
    projects: [project({ before: [{ name: 'compile', command: 'exit 1' }] })],
  });
  const started = await call('POST', '/projects/api/start');
  assert.equal(started.json.project.state, 'failed');
  assert.match(started.json.project.detail, /pre-launch step "compile" failed/u);
  assert.equal(host.spawned.length, 1, 'the long-running command must not start after a failed step');
  assert.equal(started.json.project.steps[0].state, 'failed');
});

await test('a failing dependency blocks its dependents instead of starting them against nothing', async () => {
  const { call, host } = await boot({
    projects: [
      project({ id: 'api', command: 'exit 1' }),
      project({ id: 'web', command: 'sleep forever', dependsOn: ['api'], readyPort: null }),
    ],
  });
  // start-all waits out the settle window for `api`, which dies at once.
  const all = await call('POST', '/start-all');
  const web = all.json.projects.find((entry) => entry.id === 'web');
  assert.equal(web.state, 'failed');
  assert.match(web.detail, /dependency "api" is not running/u);
  assert.equal(host.spawned.length, 1);
});

await test('deleting a project mid-start leaves no child behind', async () => {
  // The row can be deleted while a project is still `starting` (a slow pre-launch
  // step keeps it there for seconds). `start()` holds a reference to the runtime
  // object; if the table swap only looks at ids, the in-flight start happily
  // spawns afterwards and the user has a process nothing will ever stop.
  const { call, host } = await boot({
    projects: [project({ command: 'sleep forever', before: [{ name: 'slow', command: 'sleep forever', timeoutMs: 3000 }] })],
  });
  // A pre-launch step that ignores SIGTERM must still not keep `start()` open:
  // deleting the row has to answer while the step refuses to die.
  host.setStubborn(true);
  // Fire the start and delete the row while the pre-launch step is still running.
  // The start does not answer until its pre-launch step finishes, so the delete
  // has to go out while that step is still running: that is the window where a
  // removed row used to still spawn.
  const starting = call('POST', '/projects/api/start');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const removed = await call('DELETE', '/projects/api');
  assert.equal(removed.status, 200);
  await starting;
  await new Promise((resolve) => setTimeout(resolve, 800));
  // The pre-launch step did spawn (and was killed); what must never happen is
  // the long-running command being spawned for a row that is already gone.
  // Pre-launch steps always spawn with a fixed 3000 ms grace, so the project's
  // own command is the only record that carries the project's stopGraceMs.
  const mainSpawns = host.spawned.filter((record) => record.options.graceMs !== 3000);
  assert.equal(mainSpawns.length, 0, 'a project that left the table never spawns its command');
  const status = await call('GET', '/status');
  assert.deepEqual(status.json.projects.map((item) => item.id), [], 'the row is gone');
});

await test('pressing start-all twice does not spawn a project twice', async () => {
  // The button is easy to double-click while a start is in flight: the first
  // call is still walking the table (waiting out a dependency) when the second
  // arrives. Whatever the second call answers, a project must not end up with two
  // children, and the answer must agree with what is actually running.
  const { call, host } = await boot({ projects: [project({ command: 'sleep forever' })] });
  const [first, second] = await Promise.all([call('POST', '/start-all'), call('POST', '/start-all')]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const spawned = host.spawned.length;
  assert.equal(spawned, 1, 'exactly one child per project, however many start-all calls land');
  const status = await call('GET', '/status');
  assert.equal(status.json.projects[0].state, 'running');
  for (const answer of [first, second]) {
    const listed = answer.json.projects.find((item) => item.id === 'api');
    assert.equal(listed.state, 'running', 'neither answer may claim the project failed');
  }
});

await test('stop-all cancels a start-all that is still walking the table', async () => {
  // A start answers only after its readiness probe gives up. With three projects
  // that wait the default two minutes each, "Stop all" during startup has to end
  // the run there, not spawn the remaining projects after the user asked for
  // quiet.
  const { call, host } = await boot({
    projects: [
      project({ id: 'api', command: 'sleep api', readyPort: 1, readyTimeoutMs: 3000 }),
      project({ id: 'web', command: 'sleep web', readyPort: 2, readyTimeoutMs: 3000 }),
      project({ id: 'worker', command: 'sleep worker', readyPort: 3, readyTimeoutMs: 3000 }),
    ],
  });
  const running = call('POST', '/start-all');
  await waitFor(() => host.spawned.length >= 1);
  const stopped = await call('POST', '/stop-all');
  assert.equal(stopped.status, 200);
  const answer = await running;
  assert.equal(answer.json.cancelled, true, 'the run reports that it was cut short');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(host.spawned.length, 1, 'no project starts after stop-all');
  const status = await call('GET', '/status');
  for (const entry of status.json.projects) {
    assert.notEqual(entry.state, 'running', `${entry.id} is not left running`);
  }
});

await test('start-all brings up a dependency before its dependent', async () => {
  const { call, host } = await boot({
    projects: [
      project({ id: 'web', command: 'sleep web', dependsOn: ['api'] }),
      project({ id: 'api', command: 'sleep api' }),
    ],
  });
  const all = await call('POST', '/start-all');
  assert.deepEqual(host.spawned.map((record) => argvText(record)), ['sleep api', 'sleep web']);
  assert.deepEqual(all.json.projects.map((entry) => entry.state), ['running', 'running']);
});

await test('a crashing project restarts itself when asked', async () => {
  const { call, host } = await boot({
    projects: [project({ command: 'exit 7', autoRestart: true, restartDelayMs: 0 })],
  });
  await call('POST', '/projects/api/start');
  await waitFor(() => host.spawned.length >= 2);
  const status = await waitFor(async () => {
    const value = await call('GET', '/status');
    return value.json.projects[0].restarts >= 1 ? value.json : undefined;
  });
  assert.ok(status.projects[0].restarts >= 1);
});

await test('auto-restart gives up after repeated short lives instead of spinning', async () => {
  const { call, host } = await boot({
    projects: [project({ command: 'exit 7', autoRestart: true, restartDelayMs: 0 })],
  });
  await call('POST', '/projects/api/start');
  // Five short lives is the guard's limit: the first start plus four restarts.
  const logs = await waitFor(async () => {
    const page = await call('GET', '/logs?id=api&since=0');
    return page.json.entries.some((entry) => /auto-restart stopped after/u.test(entry.text)) ? page.json : undefined;
  });
  assert.ok(logs.entries.some((entry) => /auto-restart stopped after \d+ short-lived exits/u.test(entry.text)));
  assert.ok(host.spawned.length <= 6, `auto-restart must stop, saw ${host.spawned.length} spawns`);
});

await test('stopping cancels a pending auto-restart', async () => {
  const { call, host } = await boot({
    projects: [project({ command: 'exit 7', autoRestart: true, restartDelayMs: 200 })],
  });
  await call('POST', '/projects/api/start');
  await waitFor(() => host.spawned.length >= 1);
  await call('POST', '/projects/api/stop');
  const before = host.spawned.length;
  await sleep(400);
  assert.equal(host.spawned.length, before, 'no new process may appear after an explicit stop');
});

await test('a running project keeps running when the table is edited, and picks up changes on restart', async () => {
  const { call, host } = await boot({ projects: [project()] });
  await call('POST', '/projects/api/start');
  const saved = await call('PUT', '/projects', { projects: [project({ command: 'sleep changed' })] });
  assert.equal(saved.json.projects[0].command, 'sleep changed');
  assert.equal((await call('GET', '/status')).json.projects[0].state, 'running');
  await call('POST', '/projects/api/restart');
  assert.equal(argvText(host.spawned.at(-1)), 'sleep changed');
});

await test('discovery finds a Maven backend and a Vite frontend and apply writes them to the table', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-runner-discovery-'));
  await fs.mkdir(path.join(root, 'svc', 'src', 'main', 'resources'), { recursive: true });
  await fs.writeFile(path.join(root, 'svc', 'pom.xml'), '<project><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>');
  await fs.writeFile(path.join(root, 'svc', 'src', 'main', 'resources', 'application.yml'), 'server:\n  port: 9099\n');
  await fs.mkdir(path.join(root, 'web'), { recursive: true });
  await fs.writeFile(path.join(root, 'web', 'package.json'), JSON.stringify({ name: 'web', scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
  await fs.writeFile(path.join(root, 'web', 'vite.config.ts'), 'export default { server: { port: 5199, proxy: { "/api": { target: "http://127.0.0.1:9099" } } } }');

  const { call } = await boot();
  const scan = await call('POST', '/discover', { root });
  assert.equal(scan.status, 200);
  const ids = scan.json.candidates.map((candidate) => candidate.id);
  assert.deepEqual(ids, ['svc', 'web']);
  const backend = scan.json.candidates[0];
  const frontend = scan.json.candidates[1];
  assert.equal(backend.readyPort, 9099);
  assert.match(backend.readyPortSource, /application\.yml/u);
  assert.equal(frontend.readyPort, 5199);
  assert.deepEqual(frontend.dependsOn, ['svc']);
  assert.match(frontend.dependsOnWhy, /proxy targets port 9099/u);

  const applied = await call('POST', '/discover/apply', { candidates: scan.json.candidates });
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.json.projects.map((entry) => entry.id), ['svc', 'web']);
  assert.deepEqual(applied.json.projects[1].dependsOn, ['svc']);
  assert.equal(applied.json.source, 'store');

  const again = await call('POST', '/discover/apply', { candidates: scan.json.candidates });
  assert.deepEqual(again.json.projects.map((entry) => entry.id), ['svc', 'web'], 'applying twice must not duplicate');
});

await test('a scan in flight can be cancelled and the answer says so', async () => {
  const host = createHost();
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-runner-test-'));
  const runner = new Runner(host.ctx, { storeDir, projects: [] });
  await runner.ensureLoaded();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-runner-cancel-'));
  // Enough directories that the walk is certainly still running when the cancel
  // lands: the point is that the host stops walking, not that anything rejects.
  for (let index = 0; index < 400; index += 1) {
    const dir = path.join(root, 'svc-' + index);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }));
  }
  const scanning = runner.discover(root, { maxDepth: 2 });
  await sleep(30);
  assert.equal(runner.cancelDiscover(), true, 'a scan in flight must be cancellable');
  const result = await scanning;
  assert.equal(result.cancelled, true);
  assert.match(result.problems.join('\n'), /scan cancelled/u);
  assert.equal(runner.cancelDiscover(), false, 'nothing is left to cancel');
  await fs.rm(root, { recursive: true, force: true });
});

await test('the cancel route answers whether a scan was in flight', async () => {
  const { call } = await boot();
  const idle = await call('POST', '/discover/cancel', {});
  assert.equal(idle.status, 200);
  assert.equal(idle.json.cancelled, false);
});

await test('discover without a folder and without configured projects explains itself', async () => {
  const { call } = await boot();
  const scan = await call('POST', '/discover', {});
  assert.equal(scan.status, 400);
  assert.match(scan.json.error, /no folder to scan/u);
});

await test('replaceProjects itself terminates a child whose project left the table', async () => {
  // The PUT route stops what it removes before writing, so a route-level test
  // would pass even if replaceProjects never killed anything — it would just be
  // borrowing the caller's correctness. This drives replaceProjects directly,
  // which is the seam applyDiscovery and a mid-start edit actually use.
  const host = createHost();
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-runner-test-'));
  const runner = new Runner(host.ctx, { storeDir, projects: [project({ id: 'keep' }), project({ id: 'drop' })] });
  await runner.ensureLoaded();
  await runner.start('drop');
  assert.equal(host.spawned.length, 1);
  const dropped = host.spawned[0];
  runner.replaceProjects([project({ id: 'keep' })]);
  assert.equal(dropped.terminated, 1, 'the vanished project was terminated by replaceProjects itself');
  assert.equal(runner.runtimes.get('drop'), undefined, 'and its runtime is gone');
  assert.equal(runner.runtimes.get('keep') !== undefined, true, 'the survivor is untouched');
});

await test('a spawn that cannot exec is failed in the start answer, not a poll later', async () => {
  // Regression: the first implementation reported 'running' as soon as spawn()
  // returned, so a missing folder or a missing executable showed a green dot for
  // one poll and a red one afterwards. The start answer must already say failed,
  // and it must name the cause.
  const { call } = await boot({ projects: [project({ cwd: path.join(os.tmpdir(), 'dev-runner-no-such-dir-xyz'), command: 'echo hi' })] });
  const started = await call('POST', '/projects/api/start');
  assert.equal(started.json.project.state, 'failed', `expected failed, got ${started.json.project.state}`);
  assert.match(started.json.project.detail, /ENOENT|no such file|spawn/u, String(started.json.project.detail));
});

await test('a command that exits at once is failed in the start answer, not a poll later', async () => {
  // Same regression, other shape: the spawn succeeds but the shell rejects the
  // command, so the child dies at once. The answer must not claim running.
  const { call, host } = await boot({ projects: [project({ command: 'exit 7' })] });
  const started = await call('POST', '/projects/api/start');
  assert.equal(started.json.project.state, 'failed', `expected failed, got ${started.json.project.state}`);
  assert.equal(host.spawned[0].exitCode, 7);
  const logs = await call('GET', '/logs?id=api');
  assert.equal(logs.json.entries.some((entry) => /exited with code 7/u.test(entry.text)), true, 'the exit code reached the log');
});

await test('a project that survives the spawn grace is reported running', async () => {
  // The counterpart of the two above: the wait must not turn every fast project
  // into a failure. This is the check that would catch an over-eager timeout.
  const { call } = await boot({ projects: [project()] });
  const started = await call('POST', '/projects/api/start');
  assert.equal(started.json.project.state, 'running', `expected running, got ${started.json.project.state}`);
});

await test('output the provider dropped is reported as lossy, and the log keeps moving', async () => {
  // The provider's reader keeps a bounded tail. When the child out-writes it, a
  // read can answer `lossy: true` (the requested range is gone) and a
  // `nextOffset` that is BEHIND what we asked for. Clamping the cursor forward
  // would pin it past the window and freeze the log while the child keeps
  // writing; the cursor must follow the provider, and the reader must be told
  // the log is incomplete.
  const host = createHost();
  // Override the stub's stdout reader with a windowed one.
  const inner = host.ctx.subprocess.spawn.bind(host.ctx.subprocess);
  host.ctx.subprocess.spawn = (options) => {
    const handle = inner(options);
    let text = '';
    let dropped = 0;
    const cap = 12; // smaller than two lines, so any real batch overflows it
    handle.collected.stdout.readFrom = (offset) => {
      const absoluteStart = dropped;
      const start = Math.max(0, offset - absoluteStart);
      const lossy = offset < absoluteStart;
      if (start >= text.length) return { text: '', nextOffset: absoluteStart + text.length, lossy };
      return { text: text.slice(start), nextOffset: absoluteStart + text.length, lossy };
    };
    const record = host.spawned[host.spawned.length - 1];
    record.append = (chunk) => {
      text += chunk;
      if (text.length > cap) {
        const overflow = text.length - cap;
        text = text.slice(overflow);
        dropped += overflow;
      }
    };
    return handle;
  };
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-runner-test-'));
  const runner = new Runner(host.ctx, { storeDir, projects: [project()] });
  await runner.ensureLoaded();
  await runner.start('api');

  const child = host.spawned[host.spawned.length - 1];
  // First a line the drain actually reads, so the cursor is established inside
  // the window; only then overflow it. Without that baseline the very first read
  // starts at 0 and cannot be "behind" anything.
  child.append('first\n');
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (let index = 0; index < 10; index += 1) child.append(`l${index}\n`);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const page = runner.logs('api', 0);
  assert.equal(page.lossy, true, 'the loss is reported to the reader');
  assert.equal(runner.runtimes.get('api').lossy, true, 'and remembered on the runtime');
  assert.ok(page.entries.some((entry) => entry.stream === 'runner' && /discarded data/u.test(entry.text)),
    'the log carries a note saying why it is incomplete');

  // The important half: later output still arrives.
  child.append('after-gap\n');
  await new Promise((resolve) => setTimeout(resolve, 600));
  const later = runner.logs('api', page.nextSince);
  assert.equal(later.entries.some((entry) => entry.text === 'after-gap'), true,
    `the log must keep moving after a gap, got ${JSON.stringify(later.entries.map((entry) => entry.text))}`);
});

await test('a stop that lands while the start is waiting for readiness wins', async () => {
  // The start call waits on the readiness probe; if the user presses Stop in that
  // window, the readiness branch must not overwrite `stopped` with "ready in … ms".
  // Regression: it did, so a project the user had just stopped reported running.
  const port = await freePort();
  const { call, host } = await boot({ projects: [project({ readyPort: port, readyHost: '127.0.0.1', readyTimeoutMs: 6000 })] });
  const starting = call('POST', '/projects/api/start');
  await sleep(500);
  const stopped = await call('POST', '/projects/api/stop');
  assert.equal(stopped.json.project.state, 'stopped', 'stop reports stopped immediately');
  const started = await starting;
  assert.equal(started.json.project.state, 'stopped', `the pending start must not report running, got ${started.json.project.state}`);
  assert.equal(/ready in \d+ ms/u.test(String(started.json.project.detail)), false,
    `and it must not claim readiness: ${started.json.project.detail}`);
  assert.equal(host.spawned[0].terminated, 1, 'the child was terminated exactly once');
});

await test('a stop that lands before the spawn does not let the process start', async () => {
  // The window before the spawn is wide when pre-launch steps run: `runtime.handle`
  // is undefined there, which used to make `stop()` fall through, mark the project
  // stopped, and return — after which the start went on to spawn anyway. The user
  // sees "stopped" next to a dev server that is very much running.
  const { call, host } = await boot({
    projects: [project({ command: 'sleep forever', before: [{ name: 'slow', command: 'sleep forever', timeoutMs: 3000 }] })],
  });
  const starting = call('POST', '/projects/api/start');
  await sleep(200);
  const stopped = await call('POST', '/projects/api/stop');
  assert.equal(stopped.json.project.state, 'stopped');
  const started = await starting;
  assert.equal(started.json.project.state, 'stopped', `the pending start must not report running, got ${started.json.project.state}`);
  await sleep(400);
  const main = host.spawned.filter((record) => record.options.graceMs !== 3000);
  assert.equal(main.length, 0, 'a project stopped before its spawn never spawns');
});

await test('a quoted executable path runs directly instead of through cmd.exe', async () => {
  // Verified on this machine: cmd.exe cannot start a QUOTED executable path --
  // cmd re-reads the string under its own quoting rules and looks for a command
  // whose name begins with a quote character. Splitting the line into argv and
  // handing it to the seam (whose contract is argv[0]=program, no shell
  // interpretation) is what makes quoted paths work.
  const QUOTED = process.platform === 'win32'
    ? '"' + process.execPath + '" --version'
    : process.execPath + ' --version';
  const { call, host } = await boot({ projects: [project({ command: QUOTED })] });
  await call('POST', '/projects/api/start');
  const argv = host.spawned[0].options.argv;
  const joined = argv.join(' ');
  assert.equal(/cmd\.exe/iu.test(argv[0]), false, 'a quoted path must not be wrapped in cmd.exe');
  assert.equal(argv[0], process.execPath, 'argv[0] is the executable itself');
  assert.match(joined, /--version/u);
});

await test('commands that need a shell still go through cmd.exe on Windows', async () => {
  // The counterpart: tokenising must not break  && b, a pipe, or a .cmd shim.
  if (process.platform !== 'win32') return;
  for (const command of ['echo a && echo b', 'echo a | findstr a', 'npm run dev:h5']) {
    const { call, host } = await boot({ projects: [project({ command })] });
    await call('POST', '/projects/api/start');
    assert.match(host.spawned[0].options.argv[0], /cmd\.exe/iu, 'shell syntax stays on cmd.exe: ' + command);
  }
});
await test('the runner never writes outside the configured store directory', async () => {
  const runner = new Runner({ logger: { info() {}, warn() {}, error() {} } }, { storeDir: path.join(os.tmpdir(), 'dev-runner-unused') });
  assert.equal(path.dirname(runner.storeFile), path.join(os.tmpdir(), 'dev-runner-unused'));
  assert.equal(readinessTarget({ readyUrl: 'http://x/health' }), 'url http://x/health');
  assert.equal(readinessTarget({ readyPort: 8080, readyHost: '127.0.0.1' }), 'port 8080 on 127.0.0.1');
  assert.equal(readinessTarget({}), '');
});

await test('a project that is already running survives an unrelated table edit', async () => {
  // PUT writes the whole table, and any client holding a stale copy will send a
  // normalised view of projects it never touched. If the host treated "the saved
  // row differs from the running row" as a reason to stop, one edit to one project
  // would take down every other dev server the user had arranged by hand.
  const { call, host, storeDir } = await boot({
    projects: [
      project({ id: 'api', command: 'sleep api' }),
      project({ id: 'web', command: 'sleep web', stopGraceMs: 1234 }),
    ],
  });
  await call('POST', '/projects/api/start');
  const listed = (await call('GET', '/projects')).json.projects;
  assert.equal(listed.length, 2);
  // Rewrite the table with the same two rows, edited in ways that do not change
  // what runs: a new name for the sibling, a different grace for the running one.
  const next = listed.map((item) => (item.id === 'web'
    ? { ...item, name: 'web renamed', stopGraceMs: 4321 }
    : { ...item, name: 'api renamed' }));
  const applied = await call('PUT', '/projects', { projects: next });
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.json.applied.removed, [], 'no row left the table');
  assert.ok(await fs.readdir(storeDir).then((names) => names.includes('projects.json')));
  await sleep(300);
  const status = await call('GET', '/status');
  const api = status.json.projects.find((item) => item.id === 'api');
  assert.equal(api.state, 'running', 'the running project kept running');
  assert.equal(host.spawned.length, 1, 'and was not restarted');
  assert.equal(host.spawned[0].terminated, 0, 'its process was never signalled');
});

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} host tests passed`);
if (failed.length > 0) process.exitCode = 1;


