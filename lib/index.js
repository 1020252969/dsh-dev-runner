/**
 * dsh-dev-runner — host half.
 *
 * WHY THIS EXISTS. `dsh-idea-launcher` reads IDEA run configurations but starts
 * exactly one at a time (`start()` takes `selectedConfig()`), so bringing up a
 * backend plus a frontend is two clicks and no shared readiness. Nothing in the
 * public plugin catalog does multi-project orchestration either. This package
 * owns that job directly: a project table, sequential pre-launch steps, one
 * command per project, and readiness proven by a probe rather than by "the
 * process is still alive".
 *
 * WHY IT LIVES IN ITS OWN PACKAGE. It spawns through the public
 * `ctx.subprocess` seam, serves its own `/dev-runner/api` prefix, and patches
 * nobody's files. An upstream plugin upgrade cannot remove it, and it carries
 * no project-specific knowledge.
 *
 * WHERE THE TABLE LIVES. Not in the harness's own configuration. Every edit is
 * written to `<DSH_HOME>/.dev-runner/projects.json` (see `lib/store.js` for why),
 * and the profile config stays a fallback for people who declare projects there.
 * The file wins whenever it exists; `/status` and `/projects` both report which
 * source is in force, because "my edit did nothing" is otherwise unexplainable.
 *
 * READINESS IS A CLAIM WITH EVIDENCE. A `readyUrl` that answers HTTP, or a
 * `readyPort` that accepts TCP, is proof; a project configured with neither is
 * simply reported `running`, never "ready". Every detail string names what was
 * tried, so a red row is diagnosable without reading this file.
 *
 * LIFETIME. Children are managed ranges, not detached trees: `terminate()`
 * starts the provider's documented procedure and `waitForExit()` resolves only
 * once the whole range is quiescent. That is what makes "stop" actually stop,
 * unlike a `cmd start` window that escapes the handle.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { ProjectStore, normalizeProjects, slugify } from './store.js';
import { candidateToProject, discoverProjects } from './discover.js';

/** Row name; must match cordis.patch.yml and package.json. */
export const name = 'dev-runner';

/** Both services are hard dependencies: routes hang off one, children off the other. */
export const inject = ['webServer', 'subprocess'];

/** Bumped when the run strategy changes; surfaced by the status route. */
export const RUNNER_VERSION = 2;

const API_PREFIX = '/dev-runner/api';

/** Retained log entries per project (ring buffer). */
const LOG_LIMIT = 2000;

/** Collected bytes requested per stream; the provider keeps a bounded tail. */
const STREAM_MAX_BYTES = 256 * 1024;

/** How often a running project's collected output is drained, in milliseconds. */
const DRAIN_INTERVAL_MS = 250;

const DEFAULT_PROBE_INTERVAL_MS = 500;
const DEFAULT_DISCOVER_DEPTH = 2;

/**
 * How long `startAll` waits for a freshly started project to prove it stays up
 * before it starts that project's dependents. Without this window a backend that
 * dies instantly (port already taken, compile error) still looked "running" for
 * the instant the next project was launched, and its dependents came up against
 * a dead dependency. Only the orchestration path pays this; a single project
 * start returns immediately.
 */
const START_SETTLE_MS = 800;

/**
 * How long `start()` waits, after spawning, before it is willing to report
 * `running`.
 *
 * A spawn that cannot exec (missing folder, missing executable) and a command
 * that dies at once both resolve through `handle.done` within a few
 * milliseconds. Without this window the panel shows a green dot for the first
 * poll and a red one on the next, which teaches the user not to trust the dot.
 */
const START_SPAWN_GRACE_MS = 450;

/**
 * Auto-restart is a convenience, not a supervisor loop: a project that dies in
 * seconds and is restarted forever would spin the CPU and fill the log ring
 * until the user notices. After this many consecutive short lives the runner
 * stops restarting and says so in the log.
 */
const AUTO_RESTART_GUARD = { shortLivedMs: 5_000, maxStreak: 5 };

/**
 * The config schema the harness loader validates and renders.
 *
 * The loader reads `Config` off this module (`runtime.Config = plugin.Config`)
 * and validates through the Standard Schema protocol, so exporting it is what
 * gives `projects` a settings form, per-field validation and defaults. It is
 * deliberately permissive: a field this file cannot use is dropped later by
 * `lib/store.js` with a recorded problem, which beats refusing to load.
 *
 * Per-project numbers here mirror the limits in `lib/store.js`; the store stays
 * the single place that clamps and defaults, so the two can never drift into
 * disagreeing about what an out-of-range value means.
 */
export const Config = z.object({
  discoverDepth: z.number().default(DEFAULT_DISCOVER_DEPTH),
  projects: z.array(z.object({
    id: z.string(),
    name: z.string(),
    cwd: z.string(),
    command: z.string(),
    args: z.string().default(''),
    env: z.dict(z.string()).default({}),
    role: z.string().default('service'),
    framework: z.string().default(''),
    dependsOn: z.array(z.string()).default([]),
    readyPort: z.number(),
    readyHost: z.string().default(''),
    readyUrl: z.string().default(''),
    readyTimeoutMs: z.number().default(120_000),
    stopGraceMs: z.number().default(8_000),
    autoRestart: z.boolean().default(false),
    oneShot: z.boolean().default(false),
    restartDelayMs: z.number().default(1_000),
    before: z.array(z.object({
      name: z.string(),
      command: z.string(),
      expect: z.string().default(''),
      timeoutMs: z.number().default(120_000),
      continueOnError: z.boolean().default(false),
    })).default([]),
  })).default([]),
});

/** Shell syntax that genuinely needs a shell to interpret it. */
const SHELL_SYNTAX = /(?:&&|\|\||[|<>]|\$\()/u;

/**
 * Split a command line into argv, honouring double quotes.
 *
 * This exists because `cmd.exe /c "<whole command>"` cannot run a QUOTED executable
 * path: cmd re-reads the string under its own quoting rules and ends up looking for
 * a command whose name starts with a quote character (`'"C:\...\node.exe"' is not
 * recognized`). Verified on this machine against four cmd spellings
 * (`/d /s /c`, `/d /c`, a doubled `""…""`, and `call`) plus
 * `windowsVerbatimArguments` — all fail the same way, all pass when the command is
 * tokenised and handed to the seam directly, which is the contract the seam
 * actually offers (argv[0] is the program, nothing is shell-interpreted).
 *
 * @param command - the user's command line.
 * @returns argv, or null when the line needs a real shell (quotes are unbalanced
 *   or shell syntax is present).
 */
function tokenizeCommand(command) {
  const argv = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const character of command) {
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && (character === ' ' || character === '\t')) {
      if (started) {
        argv.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (quoted) return null;
  if (started) argv.push(current);
  return argv.length === 0 ? null : argv;
}

/**
 * Map a user command string to an explicit argv.
 *
 * On Windows a plain command runs through `cmd.exe` today only because that was
 * the first thing that worked; a quoted path does not. So the rule is: a line that
 * needs a shell (pipes, redirection, `&&`, `$(…)`), or one that names a `.cmd`
 * shim such as `npm`, goes to `cmd.exe`; everything else is tokenised and run
 * directly. POSIX keeps `/bin/sh -c`, whose quoting rules are the normal ones.
 *
 * @param command - the user's command line.
 * @returns the argv to hand to the subprocess seam.
 */
function shellArgv(command) {
  if (process.platform !== 'win32') return ['/bin/sh', '-c', command];
  if (SHELL_SYNTAX.test(command)) return ['cmd.exe', '/d', '/s', '/c', command];
  const argv = tokenizeCommand(command);
  if (argv === null) return ['cmd.exe', '/d', '/s', '/c', command];
  // Programs that are `.cmd` shims on Windows: a bare argv cannot start them,
  // so those stay on cmd. This list is easy to get wrong — `mvn` was missing
  // once and every Maven project died with `spawn mvn ENOENT`, so the reliable
  // fallback below (resolve the program and look at its extension) backs it up.
  if (/\.(cmd|bat)$/iu.test(argv[0]) || /^(npm|npx|pnpm|yarn|gradlew|gradle|mvn|mvnw|ant|sbt)$/iu.test(argv[0])) {
    return ['cmd.exe', '/d', '/s', '/c', command];
  }
  // A bare name that PATH resolves to a .cmd/.bat is a shim too, whatever it is
  // called: a user's own wrapper is exactly as unspawnable as npm.cmd.
  if (resolvesToShim(argv[0])) return ['cmd.exe', '/d', '/s', '/c', command];
  return argv;
}

/**
 * Whether a bare program name resolves through PATH to a `.cmd`/`.bat` file.
 *
 * Node's spawn does not apply PATHEXT, so `mvn` (really `mvn.cmd`) fails with
 * ENOENT while `node` (really `node.exe`) works. Checking here turns that into
 * a routing decision instead of a runtime error. Only local filesystem work —
 * no process is started, so this is cheap enough to call per spawn.
 */
function resolvesToShim(program) {
  if (path.isAbsolute(program) || /[\\/]/u.test(program)) {
    // An explicit path: only the extension tells us, which the caller covered.
    return false;
  }
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      if (!/^\.(cmd|bat)$/iu.test(ext)) continue;
      if (existsSync(path.join(dir, program + ext.toLowerCase()))) return true;
      if (existsSync(path.join(dir, program + ext))) return true;
    }
  }
  return false;
}

/**
 * Keep only string-valued entries. `process.env`-shaped objects can carry
 * `undefined`, and the subprocess provider rejects a non-string value.
 */
function cleanEnvFrom(source) {
  const out = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** The command line handed to the shell, with optional arguments appended. */
export function commandLine(project) {
  const args = typeof project.args === 'string' ? project.args.trim() : '';
  return args === '' ? project.command : `${project.command} ${args}`;
}

/** DSH home, mirroring the host's own resolution order. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

export function defaultStoreDir() {
  return path.join(dshHome(), '.dev-runner');
}

/** Split a chunk into log lines, keeping a trailing partial line buffered. */
function splitLines(text, carry) {
  const combined = carry + text;
  const parts = combined.split(/\r?\n/u);
  const tail = parts.pop() ?? '';
  return { lines: parts, carry: tail };
}

/**
 * Probe one TCP endpoint once.
 * @returns whether something is listening.
 */
function probePortOnce(port, host, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect({ port, host });
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

/** Probe one HTTP endpoint once; any response proves a server is answering. */
function probeHttpOnce(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      const transport = url.startsWith('https://') ? https : http;
      request = transport.get(url, { timeout: timeoutMs, rejectUnauthorized: false }, (response) => {
        response.resume();
        finish({ status: response.statusCode ?? 0 });
      });
    } catch {
      finish(null);
      return;
    }
    request.once('error', () => finish(null));
    request.once('timeout', () => {
      request.destroy();
      finish(null);
    });
  });
}

/**
 * Addresses tried when `readyHost` is not configured.
 *
 * IPv4 loopback and IPv6 loopback are independent endpoints: a Vite dev server
 * that prints `http://localhost:5173/` commonly binds `::1` only, so probing
 * `127.0.0.1` alone reports "never answered" for a server that is perfectly
 * healthy. Both are tried, and the one that answered is reported.
 */
const AUTO_READY_HOSTS = ['127.0.0.1', '::1'];

/** Probe addresses for one project; an explicit `readyHost` wins over auto. */
function readyHostsOf(project) {
  return project.readyHost === undefined || project.readyHost === '' ? AUTO_READY_HOSTS : [project.readyHost];
}

/**
 * Wait until the project's own evidence of readiness appears.
 *
 * `readyUrl` is checked first because it is the stronger claim (the server
 * answered a request, not merely accepted a socket). With neither configured
 * there is nothing honest to wait for, so the caller reports plain `running`.
 *
 * THE ANSWER MUST BE OURS. A port that answers is not evidence that *this*
 * project is serving it: a leftover process, a colleague's container, or the
 * sibling project started a minute ago all answer just as happily. The caller
 * samples the port immediately before spawning (`occupiedBefore`); if it was
 * already answering then, the project did not produce this listener, and the
 * result is a conflict rather than "ready in 0 ms".
 *
 * @param occupiedBefore - the port answered a probe taken before the spawn.
 * @param exited - resolves when the child exits, so a probe cannot outlive it.
 * @returns `{ detail }` on success, `{ detail, conflict: true }` when the port
 *   was already taken, or null on timeout.
 */
async function waitForReady(project, deadlineMs, intervalMs, signal, occupiedBefore, exited) {
  const started = Date.now();
  const hosts = readyHostsOf(project);
  while (Date.now() - started < deadlineMs) {
    if (signal?.aborted === true) return null;
    if (exited !== undefined) {
      const over = await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 0))]);
      if (over !== undefined) return null;
    }
    if (project.readyUrl !== undefined) {
      const answered = await probeHttpOnce(project.readyUrl, Math.min(2000, intervalMs * 4));
      if (answered !== null) {
        return { ms: Date.now() - started, detail: `ready in ${Date.now() - started} ms (${project.readyUrl} → ${answered.status})` };
      }
    } else if (project.readyPort !== null && project.readyPort !== undefined) {
      for (const host of hosts) {
        if (await probePortOnce(project.readyPort, host, Math.min(1000, intervalMs * 2))) {
          const ms = Date.now() - started;
          if (occupiedBefore === true) {
            return {
              ms,
              conflict: true,
              detail: `${host}:${project.readyPort} was already in use before this project started — this project does not own it`,
            };
          }
          return { ms, detail: `ready in ${ms} ms (${host}:${project.readyPort})` };
        }
      }
    } else {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/** Whether the project's readiness port is answering right now. */
async function portAnsweredNow(project) {
  if (project.readyPort === null || project.readyPort === undefined) return false;
  for (const host of readyHostsOf(project)) {
    if (await probePortOnce(project.readyPort, host, 1000)) return true;
  }
  return false;
}

/** Human description of what readiness was waiting for, for timeout messages. */
export function readinessTarget(project) {
  if (project.readyUrl !== undefined) return `url ${project.readyUrl}`;
  if (project.readyPort !== null && project.readyPort !== undefined) {
    return `port ${project.readyPort} on ${readyHostsOf(project).join(', ')}`;
  }
  return '';
}

/**
 * Order projects so every dependency precedes its dependents, preserving the
 * configured order among independent projects. Cycles are broken at load time
 * by the store, so this only has to produce a stable topological order.
 */
function topologicalOrder(projects) {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const visited = new Set();
  const order = [];
  const visit = (project) => {
    if (visited.has(project.id)) return;
    visited.add(project.id);
    for (const dep of project.dependsOn) {
      const dependency = byId.get(dep);
      if (dependency !== undefined) visit(dependency);
    }
    order.push(project);
  };
  for (const project of projects) visit(project);
  return order;
}

/** Copy a normalized project deeply enough that callers cannot mutate the table. */
function cloneProject(project) {
  return { ...project, env: { ...project.env }, dependsOn: [...project.dependsOn], before: project.before.map((step) => ({ ...step })) };
}

/**
 * Owns every project's runtime state, log ring buffer and lifecycle.
 */
export class Runner {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.config = config ?? {};
    this.storeDir = typeof this.config.storeDir === 'string' && this.config.storeDir !== ''
      ? this.config.storeDir
      : defaultStoreDir();
    this.store = new ProjectStore({
      dir: this.storeDir,
      file: typeof this.config.storeFile === 'string' && this.config.storeFile !== '' ? this.config.storeFile : 'projects.json',
    });
    const configured = normalizeProjects(Array.isArray(this.config.projects) ? this.config.projects : []);
    this.configProjects = configured.projects;
    this.configProblems = configured.problems;
    this.projects = [];
    this.runtimes = new Map();
    this.source = 'pending';
    this.queue = Promise.resolve();
    this.loadPromise = undefined;
    /**
     * The AbortController of the scan in flight, if any.
     *
     * A scan of a real repository can run for a minute, so "cancel" has to reach
     * the walk itself: dropping the response (what the panel's own timeout does)
     * leaves the host reading files at 100% CPU with nothing to show for it.
     */
    this.discoverAbort = null;
  }

  get storeFile() {
    return this.store.filePath;
  }

  /** Problems from loading, falling back to the profile config, or saving. */
  get problems() {
    return [...this.configProblems, ...this.store.problems];
  }

  /** Load the table once; every route awaits this before touching state. */
  ensureLoaded() {
    if (this.loadPromise !== undefined) return this.loadPromise;
    this.loadPromise = (async () => {
      const loaded = await this.store.load();
      if (loaded.exists || this.configProjects.length === 0) {
        this.source = loaded.exists ? 'store' : 'store-empty';
        this.replaceProjects(loaded.projects);
      } else {
        // No plugin file yet: the profile config is the table until the first
        // panel edit creates the file, at which point the file takes over.
        this.source = 'config';
        this.replaceProjects(this.configProjects);
      }
      return this.source;
    })();
    return this.loadPromise;
  }

  /** The effective table, as a copy — never hand out internal objects. */
  readTable() {
    return this.projects.map(cloneProject);
  }

  /**
   * Replace the whole in-memory project set.
   *
   * A project that disappears from the table must not leave a child behind: the
   * routes stop it before calling this, but `applyDiscovery`, a future caller,
   * and a table edited while a project was mid-`starting` all reach here
   * directly. Terminating is therefore done here too, fire-and-forget — the
   * table edit itself must not block on killing a process.
   */
  replaceProjects(projects) {
    this.projects = projects;
    const ids = new Set(projects.map((project) => project.id));
    for (const [id, runtime] of [...this.runtimes]) {
      if (!ids.has(id)) {
        runtime.stopRequested = true;
        runtime.controller?.abort();
        clearTimeout(runtime.restartTimer);
        this.stopDraining(runtime);
        const handle = runtime.handle;
        if (handle !== undefined) {
          handle.terminate().catch((error) => {
            this.logger.warn(`dev-runner: could not terminate "${id}" after it left the table: ${String(error)}`);
          });
        }
        this.runtimes.delete(id);
      }
    }
    for (const project of projects) {
      const existing = this.runtimes.get(project.id);
      if (existing === undefined) this.runtimes.set(project.id, this.createRuntime(project));
      else existing.project = project;
    }
  }

  createRuntime(project) {
    return {
      project,
      state: 'stopped',
      detail: 'idle',
      handle: undefined,
      drainTimer: undefined,
      restartTimer: undefined,
      stopRequested: false,
      restarts: 0,
      shortLivedStreak: 0,
      stdoutOffset: 0,
      stderrOffset: 0,
      stdoutCarry: '',
      stderrCarry: '',
      logs: [],
      nextSeq: 0,
      lossy: false,
      startedAtMs: undefined,
      endedAtMs: undefined,
      exitCode: undefined,
      steps: [],
      controller: undefined,
    };
  }

  /**
   * Apply an edited table: write it, then reconcile runtime state. Running
   * projects whose definition changed keep running (the new command applies on
   * the next start) — silently killing a dev server someone is using would be a
   * worse surprise than a stale process.
   */
  async setProjects(next) {
    const saved = await this.store.save(next);
    const before = new Set(this.projects.map((project) => project.id));
    const after = new Set(saved.projects.map((project) => project.id));
    const removed = [...before].filter((id) => !after.has(id));
    const stopped = [];
    for (const id of removed) {
      const runtime = this.runtimes.get(id);
      if (runtime !== undefined && (runtime.state === 'running' || runtime.state === 'starting')) {
        await this.stop(id);
        stopped.push(id);
      }
    }
    const added = [...after].filter((id) => !before.has(id));
    const updated = [...after].filter((id) => before.has(id));
    this.source = 'store';
    this.loadPromise = Promise.resolve(this.source);
    this.replaceProjects(saved.projects);
    return { added, updated, removed, stopped, problems: saved.problems };
  }

  /** Read-modify-write the effective table, seeding from it when no file exists. */
  async mutate(mutator) {
    await this.ensureLoaded();
    const next = await mutator(this.readTable());
    return this.setProjects(next ?? this.readTable());
  }

  /** Append one log entry, dropping the oldest when the ring is full. */
  appendLog(runtime, stream, text) {
    runtime.logs.push({ seq: runtime.nextSeq, ts: Date.now(), stream, text });
    runtime.nextSeq += 1;
    while (runtime.logs.length > LOG_LIMIT) runtime.logs.shift();
  }

  /** Record a runner-owned event line (start, stop, failure), not child output. */
  note(runtime, text) {
    this.appendLog(runtime, 'runner', text);
  }

  /**
   * Drop one project from the live table immediately, without the serial queue.
   *
   * Used by DELETE: a project in its readiness window occupies the queue until
   * its timeout expires, so queueing the removal behind the very start it is
   * meant to cancel deadlocks the user's click. Aborting the runtime first means
   * the in-flight `start()` sees an aborted signal before it spawns, and the
   * table swap that follows has nothing left to spawn.
   */
  dropProject(projectId) {
    const runtime = this.runtimes.get(projectId);
    if (runtime !== undefined) {
      runtime.stopRequested = true;
      runtime.controller?.abort();
      clearTimeout(runtime.restartTimer);
      this.stopDraining(runtime);
      runtime.handle?.terminate().catch((error) => {
        this.logger.warn(`dev-runner: could not terminate "${projectId}" after it was deleted: ${String(error)}`);
      });
      this.runtimes.delete(projectId);
    }
    this.projects = this.projects.filter((project) => project.id !== projectId);
  }

  /**
   * Serialize start/stop work so two clicks cannot interleave on one project.
   */
  enqueue(task) {
    const next = this.queue.then(task, task);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  snapshot(projectId) {
    const runtime = this.runtimes.get(projectId);
    if (runtime === undefined) return undefined;
    const project = runtime.project;
    return {
      id: project.id,
      name: project.name,
      cwd: project.cwd,
      command: project.command,
      args: project.args,
      env: { ...project.env },
      role: project.role,
      framework: project.framework ?? null,
      source: project.source,
      dependsOn: [...project.dependsOn],
      readyPort: project.readyPort ?? null,
      readyUrl: project.readyUrl ?? null,
      autoRestart: project.autoRestart === true,
      restartDelayMs: project.restartDelayMs,
      restarts: runtime.restarts,
      state: runtime.state,
      // Present while a process this runner spawned is alive. It differs from
      // `command` when the table was edited mid-run: the edit applies on the NEXT
      // start, so the panel can say "running X, configured Y" instead of pretending
      // the new command is in force.
      runningCommand: runtime.runningCommand ?? null,
      detail: runtime.detail,
      startedAtMs: runtime.startedAtMs ?? null,
      endedAtMs: runtime.endedAtMs ?? null,
      exitCode: runtime.exitCode ?? null,
      steps: runtime.steps.map((step) => ({ ...step })),
      lastSeq: runtime.nextSeq,
      firstRetainedSeq: runtime.logs.length === 0 ? runtime.nextSeq : runtime.logs[0].seq,
    };
  }

  snapshotAll() {
    return {
      version: RUNNER_VERSION,
      source: this.source,
      storeFile: this.store.filePath,
      problems: this.problems,
      projects: this.projects.map((project) => this.snapshot(project.id)),
    };
  }

  /**
   * Read log entries at or after `since`.
   *
   * The cursor is a sequence number, and the contract is inclusive: `since` is
   * "the first sequence number I have not seen". `nextSince` is therefore
   * `lastSeq + 1`, and the filter is `>=`. The earlier `>` version lost entries
   * outright: the cursor handed out was `lastSeq + 1`, so the next entry always
   * landed exactly on the cursor and was filtered away. (Found by dumping seq
   * numbers after a window gap — the line after the gap had seq 7 while the
   * previous page's cursor was 7.)
   *
   * `lossy` means "what you are reading is not the whole story", and it has two
   * causes that must not be conflated: the ring buffer overwrote old entries
   * (`since < firstRetained`), or the provider's output window discarded bytes
   * before the drain ever saw them (`runtime.lossy`). The panel shows one notice
   * for either case, but the log itself carries a runner note naming which.
   */
  logs(projectId, since) {
    const runtime = this.runtimes.get(projectId);
    if (runtime === undefined) return undefined;
    const firstRetained = runtime.logs.length === 0 ? runtime.nextSeq : runtime.logs[0].seq;
    // A client that has never read this log asks for 0; sequence numbers start at
    // 0, so an inclusive filter returns the first line too.
    const from = Number.isFinite(since) && since > 0 ? since : 0;
    const entries = runtime.logs.filter((entry) => entry.seq >= from);
    return {
      entries,
      nextSince: entries.length === 0 ? from : entries[entries.length - 1].seq + 1,
      lossy: (from > 0 && from < firstRetained) || runtime.lossy === true,
      state: runtime.state,
      detail: runtime.detail,
    };
  }

  /** The whole retained log as text, for the download route. */
  logText(projectId) {
    const runtime = this.runtimes.get(projectId);
    if (runtime === undefined) return undefined;
    return `${runtime.logs.map((entry) => `[${new Date(entry.ts).toISOString()}] [${entry.stream}] ${entry.text}`).join('\n')}\n`;
  }

  /**
   * Drain newly collected bytes from one stream into the log.
   *
   * `readFrom(offset)` speaks absolute stream offsets and never consumes, but the
   * provider only retains a bounded window (`maxBytes` on the stdio entry, and
   * a spill file beyond it). When the child out-writes that window, bytes we never
   * read are gone and our cursor points into a hole: every later read answers
   * with less than we asked for, and the log appears frozen while the child
   * keeps running.
   *
   * The provider's own reader reports both facts — `lossy` for "the window
   * dropped data" and `nextOffset` for where the retained tail now ends — so the
   * fix is to follow `nextOffset` and surface `lossy` instead of pretending the
   * log is complete.
   */
  drain(runtime, stream) {
    const collected = runtime.handle?.collected?.[stream];
    if (collected === undefined) return;
    const offsetKey = `${stream}Offset`;
    const carryKey = `${stream}Carry`;
    const asked = runtime[offsetKey];
    const read = collected.readFrom(asked);
    if (read.lossy === true) {
      runtime.logGaps = (runtime.logGaps ?? 0) + 1;
      runtime.lossy = true;
      // A gap means the carry buffer from the previous read described bytes
      // nobody will see; keeping it would glue a half line onto an unrelated one.
      runtime[carryKey] = '';
      if (runtime.logGaps === 1) {
        this.note(runtime, `${stream}: the output buffer discarded data before it could be read — the log is incomplete from here on`);
      }
    }
    // The provider's `nextOffset` is the authority, even when it is SMALLER than
    // what we asked for: that is exactly what "your range fell out of the window"
    // looks like, and clamping to the larger value would pin the cursor ahead of
    // the window forever, freezing the log while the child keeps writing.
    runtime[offsetKey] = Number.isFinite(read.nextOffset) ? read.nextOffset : asked;
    if (read.text === '') return;
    const split = splitLines(read.text, runtime[carryKey]);
    runtime[carryKey] = split.carry;
    for (const line of split.lines) this.appendLog(runtime, stream, line);
  }

  startDraining(runtime) {
    if (runtime.drainTimer !== undefined) return;
    runtime.drainTimer = setInterval(() => {
      try {
        this.drain(runtime, 'stdout');
        this.drain(runtime, 'stderr');
      } catch (error) {
        this.logger.warn(`dev-runner: draining ${runtime.project.id} failed: ${String(error)}`);
      }
    }, DRAIN_INTERVAL_MS);
    runtime.drainTimer.unref?.();
  }

  stopDraining(runtime) {
    if (runtime.drainTimer === undefined) return;
    clearInterval(runtime.drainTimer);
    runtime.drainTimer = undefined;
    // One last drain so the final output is not stranded in the provider buffer.
    try {
      this.drain(runtime, 'stdout');
      this.drain(runtime, 'stderr');
    } catch {}
  }

  /** Options handed to the subprocess seam for one project or step. */
  spawnOptions(project, command, signal, graceMs) {
    const env = project?.env ?? {};
    const options = {
      argv: shellArgv(command),
      cwd: project?.cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: STREAM_MAX_BYTES }, stderr: { maxBytes: STREAM_MAX_BYTES } },
      graceMs,
      signal,
    };
    // Only the project's own variables, never a copy of `process.env`.
    //
    // `ctx.subprocess` builds the child environment by taking the parent
    // environment, REMOVING credentials and every `DSH_*` value, and then
    // merging whatever `env` says (a documented `undefined` tombstone removes a
    // single variable). Forwarding `process.env` would hand every dev server the
    // credentials the host just scrubbed, and would also be wrong if a host line
    // ever replaces instead of merges. A project that genuinely needs a scrubbed
    // variable declares it in its own `env` table.
    //
    // Every value must be a string: a stray `undefined` in `process.env` makes
    // the provider throw, and JSON cannot express one anyway.
    const clean = cleanEnvFrom(env);
    if (Object.keys(clean).length > 0) options.env = clean;
    return options;
  }

  /** Run one pre-launch step to completion and report its outcome. */
  async runStep(runtime, step, signal) {
    const record = { name: step.name, command: step.command, state: 'running', exitCode: null, ms: null, message: '' };
    runtime.steps = [...runtime.steps.filter((existing) => existing.name !== step.name), record];
    this.note(runtime, `[before] ${step.name}: ${step.command}`);
    const started = Date.now();
    let handle;
    try {
      handle = this.ctx.subprocess.spawn(this.spawnOptions(runtime.project, step.command, signal, 3000));
    } catch (error) {
      record.state = 'failed';
      record.ms = Date.now() - started;
      record.message = String(error);
      this.note(runtime, `[before] ${step.name}: failed to start: ${String(error)}`);
      return false;
    }
    const timer = setTimeout(() => {
      record.message = `timed out after ${step.timeoutMs} ms`;
      handle.terminate().catch(() => {});
    }, step.timeoutMs);
    timer.unref?.();
    let outcome;
    // A pre-launch step that is killed because the project was deleted or
    // stopped must not hold `start()` open: `handle.done` only settles when the
    // child actually exits, and a terminated child can take a moment the user
    // does not have. The abort signal is the authority here.
    const abortStep = new Promise((resolve) => {
      if (signal?.aborted === true) return resolve({ exitCode: null, signal: 'aborted', aborted: true });
      signal?.addEventListener('abort', () => {
        handle.terminate().catch(() => {});
        resolve({ exitCode: null, signal: 'aborted', aborted: true });
      }, { once: true });
    });
    try {
      outcome = await Promise.race([handle.done, abortStep]);
      if (outcome?.aborted === true) {
        record.state = 'failed';
        record.ms = Date.now() - started;
        record.message = 'cancelled';
        this.note(runtime, `[before] ${step.name}: cancelled`);
        return false;
      }
    } catch (error) {
      outcome = { exitCode: null, signal: null, error: String(error) };
    } finally {
      clearTimeout(timer);
    }
    const stdout = handle.collected?.stdout?.readFrom(0).text ?? '';
    const stderr = handle.collected?.stderr?.readFrom(0).text ?? '';
    for (const line of stdout.split(/\r?\n/u)) if (line !== '') this.appendLog(runtime, 'stdout', line);
    for (const line of stderr.split(/\r?\n/u)) if (line !== '') this.appendLog(runtime, 'stderr', line);
    record.ms = Date.now() - started;
    record.exitCode = outcome?.exitCode ?? null;
    const ok = record.exitCode === 0 && record.message === '';
    if (ok && step.expect !== '' && !(`${stdout}\n${stderr}`).includes(step.expect)) {
      record.state = 'failed';
      record.message = `output does not contain ${JSON.stringify(step.expect)}`;
      this.note(runtime, `[before] ${step.name}: ${record.message}`);
      return false;
    }
    record.state = ok ? 'ok' : 'failed';
    if (record.message === '' && !ok) record.message = `exited with code ${record.exitCode}`;
    this.note(runtime, `[before] ${step.name}: ${record.state} (${record.ms} ms)${record.message === '' ? '' : ` — ${record.message}`}`);
    return record.state === 'ok';
  }

  /**
   * Start one project: pre-launch steps, then the long-running command, then
   * (when configured) a probe that decides whether it actually came up.
   */
  async start(projectId) {
    await this.ensureLoaded();
    const runtime = this.runtimes.get(projectId);
    if (runtime === undefined) throw new Error(`dev-runner: unknown project "${projectId}"`);
    if (runtime.state === 'running' || runtime.state === 'starting') return this.snapshot(projectId);
    clearTimeout(runtime.restartTimer);
    runtime.restartTimer = undefined;
    runtime.stopRequested = false;
    runtime.state = 'starting';
    runtime.detail = 'pre-launch';
    runtime.steps = [];
    runtime.exitCode = undefined;
    runtime.endedAtMs = undefined;
    const command = commandLine(runtime.project);
    this.note(runtime, `start: ${command}`);
    const controller = new AbortController();
    runtime.controller = controller;
    for (const step of runtime.project.before) {
      // A stop during a pre-launch step is not a step failure: `runStep` reports
      // the cancellation as `false`, and blaming the step for something the user
      // asked for would turn "stopped" into a red "failed".
      if (controller.signal.aborted) break;
      const ok = await this.runStep(runtime, step, controller.signal);
      if (controller.signal.aborted) break;
      if (!ok && !step.continueOnError) {
        runtime.state = 'failed';
        runtime.detail = `pre-launch step "${step.name}" failed`;
        this.note(runtime, `aborted: ${runtime.detail}`);
        runtime.controller = undefined;
        return this.snapshot(projectId);
      }
    }
    if (controller.signal.aborted) {
      runtime.state = 'stopped';
      runtime.detail = 'cancelled';
      runtime.controller = undefined;
      return this.snapshot(projectId);
    }
    runtime.detail = 'spawning';
    // Sample the port BEFORE spawning: that is the only moment at which "was
    // this already somebody else's?" can still be answered.
    const occupiedBefore = await portAnsweredNow(runtime.project);
    let handle;
    try {
      handle = this.ctx.subprocess.spawn(this.spawnOptions(runtime.project, command, controller.signal, runtime.project.stopGraceMs));
    } catch (error) {
      runtime.state = 'failed';
      runtime.detail = `spawn failed: ${String(error)}`;
      this.note(runtime, runtime.detail);
      runtime.controller = undefined;
      return this.snapshot(projectId);
    }
    runtime.handle = handle;
    runtime.stdoutOffset = 0;
    runtime.stderrOffset = 0;
    runtime.stdoutCarry = '';
    runtime.stderrCarry = '';
    runtime.startedAtMs = Date.now();
    // Remember what was actually handed to the shell: editing the table while a
    // project runs does not restart it, so `command` above can drift from reality.
    runtime.runningCommand = command;
    runtime.state = 'running';
    this.startDraining(runtime);
    // Resolve as soon as the child exits, so `start` never has to guess whether
    // it is alive; `done` is also the long-running watcher's source of truth.
    let settled;
    const exited = new Promise((resolve) => { settled = resolve; });
    handle.done.then((outcome) => {
      settled(outcome);
      this.stopDraining(runtime);
      const uptime = runtime.startedAtMs === undefined ? 0 : Date.now() - runtime.startedAtMs;
      if (runtime.state === 'running' || runtime.state === 'starting') {
        // A one-shot command (`kubectl apply`, a generator, a migration) is
        // *supposed* to exit. Calling that "failed" would be wrong, calling it
        // `stopped` would be confusing, so it gets its own terminal state.
        if (runtime.stopRequested === true) {
          runtime.state = 'stopped';
          runtime.detail = 'stopped';
        } else if (runtime.project.oneShot === true && outcome?.exitCode === 0) {
          runtime.state = 'done';
          runtime.detail = `finished in ${uptime} ms (exit code 0)`;
        } else {
          runtime.state = runtime.stopRequested || outcome?.exitCode === 0 ? 'stopped' : 'failed';
          runtime.detail = runtime.stopRequested
            ? 'stopped'
            : `process exited with code ${outcome?.exitCode ?? 'null'}`;
        }
        this.note(runtime, runtime.detail);
      }
      runtime.exitCode = outcome?.exitCode ?? null;
      runtime.endedAtMs = Date.now();
      runtime.handle = undefined;
      runtime.shortLivedStreak = uptime < AUTO_RESTART_GUARD.shortLivedMs ? runtime.shortLivedStreak + 1 : 0;
      this.maybeRestart(runtime);
    }, (error) => {
      settled({ exitCode: null, signal: null, error: String(error) });
      this.stopDraining(runtime);
      runtime.state = 'failed';
      runtime.detail = `process failed: ${String(error)}`;
      this.note(runtime, runtime.detail);
      runtime.endedAtMs = Date.now();
      runtime.handle = undefined;
      this.maybeRestart(runtime);
    });

    /**
     * A spawn that cannot exec, or a command that dies at once, resolves through
     * `handle.done` a fraction of a second later. Reporting `running` in that
     * window is a lie the user acts on — they see a green dot, then a second
     * later a red one — so the answer waits for the first `PROBE_SETTLE_MS`.
     */
    const firstOutcome = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(undefined), START_SPAWN_GRACE_MS)),
    ]);
    if (firstOutcome !== undefined) {
      // The child is already dead; its handler above has set the state.
      return this.snapshot(projectId);
    }

    if (runtime.project.readyUrl !== undefined || runtime.project.readyPort !== null && runtime.project.readyPort !== undefined) {
      const target = readinessTarget(runtime.project);
      runtime.detail = `waiting for ${target}`;
      const ready = await waitForReady(
        runtime.project,
        runtime.project.readyTimeoutMs,
        DEFAULT_PROBE_INTERVAL_MS,
        controller.signal,
        occupiedBefore,
        exited,
      );
      // A probe that answers and a process that dies in the same breath is not
      // "ready": the answer is only reported while the child is still alive.
      const outcome = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve(undefined), 0)),
      ]);
      if (outcome !== undefined || runtime.state !== 'running') return this.snapshot(projectId);
      // A stop that lands while this start is waiting for readiness must win.
      // Without this the readiness branch below would overwrite the `stopped`
      // state with "ready in … ms", so a user who pressed Stop during startup
      // would be told the project is running.
      if (controller.signal.aborted === true || runtime.stopRequested === true) {
        return this.snapshot(projectId);
      }
      if (ready === null) {
        if (controller.signal.aborted) return this.snapshot(projectId);
        runtime.detail = `${target} never answered within ${runtime.project.readyTimeoutMs} ms`;
        this.note(runtime, `warning: ${runtime.detail} (the process is still running)`);
      } else if (ready.conflict === true) {
        runtime.detail = ready.detail;
        this.note(runtime, `warning: ${runtime.detail}`);
      } else {
        runtime.detail = ready.detail;
        this.note(runtime, runtime.detail);
      }
    } else {
      runtime.detail = 'running (no readiness probe configured)';
    }
    return this.snapshot(projectId);
  }

  /** Restart a crashed project when it asked for that. */
  maybeRestart(runtime) {
    const project = runtime.project;
    if (project.autoRestart !== true) return;
    if (project.oneShot === true) return;
    if (runtime.stopRequested || runtime.controller?.signal.aborted === true) return;
    if (runtime.state === 'stopped' || runtime.state === 'done') return;
    if (runtime.shortLivedStreak >= AUTO_RESTART_GUARD.maxStreak) {
      this.note(runtime, `auto-restart stopped after ${runtime.shortLivedStreak} short-lived exits — fix the project, then start it again`);
      return;
    }
    const delay = Math.max(0, project.restartDelayMs);
    runtime.restarts += 1;
    this.note(runtime, `auto-restart #${runtime.restarts} in ${delay} ms`);
    runtime.restartTimer = setTimeout(() => {
      runtime.restartTimer = undefined;
      this.enqueue(() => this.start(runtime.project.id)).catch((error) => {
        this.note(runtime, `auto-restart failed: ${String(error)}`);
      });
    }, delay);
    runtime.restartTimer.unref?.();
  }

  /** Terminate the managed range and wait for real quiescence. */
  async stop(projectId) {
    await this.ensureLoaded();
    const runtime = this.runtimes.get(projectId);
    if (runtime === undefined) throw new Error(`dev-runner: unknown project "${projectId}"`);
    // A project that had already failed stays reported as failed; stopping it is
    // just cleanup. Anything else the user stops ends up `stopped`.
    const wasFailed = runtime.state === 'failed';
    runtime.stopRequested = true;
    clearTimeout(runtime.restartTimer);
    runtime.restartTimer = undefined;
    if (runtime.state === 'stopped') return this.snapshot(projectId);
    runtime.controller?.abort();
    const handle = runtime.handle;
    // The start is still before its spawn: `runtime.handle` is undefined because
    // the process does not exist yet, not because there is nothing to stop. `start()`
    // also checks the signal after each step, so this branch is belt-and-braces;
    // it exists so `stop()` answers `stopped` synchronously instead of relying on
    // the in-flight start to converge a moment later.
    if (handle === undefined && runtime.state === 'starting') {
      runtime.state = 'stopped';
      runtime.detail = 'cancelled';
      runtime.controller = undefined;
      this.note(runtime, 'stopped before the process was launched');
      return this.snapshot(projectId);
    }
    if (handle !== undefined) {
      this.note(runtime, 'stop: terminating managed process range');
      try {
        await handle.terminate();
        await handle.waitForExit();
      } catch (error) {
        this.note(runtime, `stop: terminate reported ${String(error)}`);
      }
    }
    this.stopDraining(runtime);
    runtime.handle = undefined;
    runtime.controller = undefined;
    runtime.state = wasFailed ? 'failed' : 'stopped';
    runtime.endedAtMs = Date.now();
    runtime.shortLivedStreak = 0;
    if (runtime.detail === 'idle' || /^(running|ready|waiting)/u.test(runtime.detail)) runtime.detail = 'stopped';
    this.note(runtime, 'stopped');
    return this.snapshot(projectId);
  }

  /** Stop then start, for a project whose command changed. */
  async restart(projectId) {
    await this.stop(projectId);
    return this.start(projectId);
  }

  /**
   * Start every project in dependency order.
   *
   * A failure does NOT stop the run: one misconfigured project must not take
   * down the ones that have nothing to do with it. What a failure does do is
   * stop everything that DEPENDS on it — those cannot work without it, so they
   * are reported `blocked` rather than started against a dead dependency.
   *
   * The return value carries a `failed` list so a caller can say "two of five
   * came up" instead of leaving the user to eyeball five rows.
   */
  async startAll() {
    await this.ensureLoaded();
    // A start does not answer until its readiness probe finishes, which can be
    // the project's whole readyTimeoutMs. A run-wide cancel has to cut that
    // short, or "Stop all" pressed during startup leaves the loop grinding
    // through five 120-second waits.
    const run = new AbortController();
    this.startAllRun = run;
    const results = [];
    try {
      for (const project of topologicalOrder(this.projects)) {
        if (run.signal.aborted) break;
        const runtime = this.runtimes.get(project.id);
        if (runtime === undefined) continue;
        let blocked;
        for (const dep of project.dependsOn) {
          const dependency = this.runtimes.get(dep);
          // `done` counts as satisfied: a one-shot command such as `kubectl apply`
          // has already finished its work by the time the dependent starts, which
          // is exactly the ordering the user wanted.
          if (dependency !== undefined && dependency.state !== 'running' && dependency.state !== 'done') {
            blocked = `dependency "${dep}" is not running`;
            break;
          }
        }
        if (blocked !== undefined) {
          this.note(runtime, `skipped: ${blocked}`);
          runtime.state = 'failed';
          runtime.detail = blocked;
          results.push(this.snapshot(project.id));
          continue;
        }
        try {
          results.push(await this.start(project.id));
          // Give the new process a moment to prove it stays up before any dependent
          // is launched against it. A project that dies here is already reported as
          // failed by its own `handle.done` continuation.
          await this.settle(runtime, run.signal);
        } catch (error) {
          runtime.state = 'failed';
          runtime.detail = String(error);
          this.note(runtime, runtime.detail);
          results.push(this.snapshot(project.id));
        }
      }
    } finally {
      if (this.startAllRun === run) this.startAllRun = undefined;
    }
    // Summarise, so the panel can say "3 of 5 came up" instead of making the
    // user scan five rows for the two red ones.
    const snapshots = this.projects.map((project) => this.snapshot(project.id)).filter((item) => item !== undefined);
    const failed = snapshots
      .filter((item) => item.state === 'failed')
      .map((item) => ({ id: item.id, name: item.name, detail: item.detail }));
    const blocked = results
      .filter((item) => typeof item?.detail === 'string' && item.detail.startsWith('dependency'))
      .map((item) => item.id);
    return { version: RUNNER_VERSION, results: results.filter((item) => item !== undefined), projects: snapshots, failed, blocked, cancelled: run.signal.aborted };
  }

  /**
   * Cancel a start-all that is still working through its table.
   *
   * Called by "Stop all": without it the run would keep starting the remaining
   * projects *after* the user asked everything to stop.
   */
  cancelStartAll() {
    if (this.startAllRun === undefined) return false;
    this.startAllRun.abort();
    return true;
  }

  /** Wait briefly for a just-started project to either survive or be reported dead. */
  async settle(runtime, signal) {
    if (runtime.state !== 'running') return;
    if (signal?.aborted === true) return;
    await new Promise((resolve) => {
      // No `unref()` here: this timer IS the work being awaited. Unref'd, an
      // otherwise idle process exits with "unsettled top-level await" instead of
      // finishing the settle window.
      const timer = setTimeout(resolve, START_SETTLE_MS);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  async stopAll() {
    await this.ensureLoaded();
    this.cancelStartAll();
    for (const project of [...topologicalOrder(this.projects)].reverse()) {
      try {
        await this.stop(project.id);
      } catch (error) {
        this.logger.warn(`dev-runner: stopping ${project.id} failed: ${String(error)}`);
      }
    }
    return this.snapshotAll();
  }

  /** Scan a directory tree for runnable projects; never writes the table. */
  async discover(root, options = {}) {
    await this.ensureLoaded();
    let target = typeof root === 'string' && root.trim() !== '' ? root.trim() : '';
    if (target === '') {
      const configured = typeof this.config.discoverRoot === 'string' && this.config.discoverRoot !== '' ? this.config.discoverRoot : '';
      target = configured;
    }
    if (target === '' && this.projects.length > 0) {
      // A sibling of the projects already configured is the best guess available
      // when the caller did not name a folder.
      target = path.dirname(this.projects[0].cwd);
    }
    if (target === '') {
      throw new Error('dev-runner: no folder to scan — pass "root", or configure one project so a parent folder can be inferred');
    }
    const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth >= 0 ? options.maxDepth : DEFAULT_DISCOVER_DEPTH;
    const controller = new AbortController();
    this.discoverAbort = controller;
    try {
      return await discoverProjects(path.resolve(target), {
        maxDepth,
        ignore: this.config.discoverIgnore,
        signal: controller.signal,
      });
    } finally {
      // A second scan may have started while this one ran; only clear our own.
      if (this.discoverAbort === controller) this.discoverAbort = null;
    }
  }

  /** Stop the scan in flight; answers whether there was one. */
  cancelDiscover() {
    const controller = this.discoverAbort;
    if (controller === null) return false;
    controller.abort();
    return true;
  }

  /** Add discovery results to the table, keeping hand-edited projects intact. */
  async applyDiscovery(candidates, { replace = false } = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    if (list.length === 0) throw new Error('dev-runner: nothing to apply — run a scan first');
    const incoming = list.map((candidate) => candidateToProject(candidate));
    const result = await this.mutate((current) => {
      const byId = new Map(current.map((project) => [project.id, project]));
      for (const project of incoming) {
        if (replace || !byId.has(project.id)) byId.set(project.id, project);
      }
      // Preserve the existing order, appending genuinely new projects.
      const ordered = current.map((project) => byId.get(project.id)).filter((project) => project !== undefined);
      for (const project of incoming) {
        if (!current.some((existing) => existing.id === project.id)) ordered.push(byId.get(project.id));
      }
      return ordered;
    });
    return { ...result, applied: incoming.map((project) => project.id) };
  }

  /** Stop everything and drop timers; runs from the plugin's effect cleanup. */
  async dispose() {
    for (const runtime of this.runtimes.values()) {
      runtime.stopRequested = true;
      runtime.controller?.abort();
      clearTimeout(runtime.restartTimer);
      this.stopDraining(runtime);
      const handle = runtime.handle;
      if (handle === undefined) continue;
      try {
        await handle.terminate();
      } catch {}
    }
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendText(res, status, text, filename) {
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  };
  if (filename !== undefined) headers['Content-Disposition'] = `attachment; filename="${filename}"`;
  res.writeHead(status, headers);
  res.end(text);
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress;
  return address === undefined || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Who may call this API.
 *
 * Two fences, both cheap and both load-bearing:
 *
 * - The socket must be loopback, so nothing off this machine can start or stop
 *   the user's dev servers.
 * - A request that carries an `Origin` must name this very listener. That is
 *   what stops a page on some other site from driving this API through the
 *   user's own browser — a reachable attacker even when the socket is loopback.
 *
 * A request with no `Origin` (curl, a script, another local tool) passes on the
 * address check alone. The host's `connection.requestRejection` helper is
 * deliberately not used here: it also demands a live authenticated browser
 * session, which would lock out exactly the local tooling this API exists to
 * serve while adding nothing against a foreign page, since a foreign page never
 * carries this listener's authority anyway.
 */
function isSameOriginRequest(req) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  const host = req.headers?.host;
  if (typeof host !== 'string' || host === '') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function admissionFence() {
  return (req) => isLoopback(req) && isSameOriginRequest(req);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/** The route table, kept separate so it can be exercised without a live host. */
export function createHandler(ctx, runner) {
  const admitted = admissionFence();
  return async (req, res) => {
    try {
      if (!admitted(req)) return sendJson(res, 403, { ok: false, error: 'not admitted: loopback and same-origin only' });
      const url = new URL(req.url ?? '/', 'http://localhost');
      const rest = url.pathname.slice(API_PREFIX.length) || '/';
      const method = req.method ?? 'GET';
      const queryId = url.searchParams.get('id') ?? '';

      if (rest === '/status' && method === 'GET') {
        await runner.ensureLoaded();
        return sendJson(res, 200, { ok: true, ...runner.snapshotAll() });
      }
      if (rest === '/projects' && method === 'GET') {
        await runner.ensureLoaded();
        return sendJson(res, 200, {
          ok: true,
          source: runner.source,
          storeFile: runner.storeFile,
          problems: runner.problems,
          projects: runner.readTable(),
        });
      }
      if (rest === '/projects' && method === 'PUT') {
        const body = await readBody(req);
        if (!Array.isArray(body?.projects)) return sendJson(res, 400, { ok: false, error: '"projects" must be an array' });
        const applied = await runner.enqueue(() => runner.setProjects(body.projects));
        return sendJson(res, 200, {
          ok: true,
          applied,
          source: runner.source,
          storeFile: runner.storeFile,
          problems: runner.problems,
          projects: runner.readTable(),
        });
      }
      if (rest === '/projects' && method === 'POST') {
        const body = await readBody(req);
        const incoming = body?.project ?? body;
        if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
          return sendJson(res, 400, { ok: false, error: 'body must be a project object' });
        }
        const id = slugify(incoming.id ?? path.basename(String(incoming.cwd ?? '')) ?? '');
        const applied = await runner.enqueue(() => runner.mutate((current) => {
          const index = current.findIndex((project) => project.id === id);
          if (index === -1) return [...current, incoming];
          return current.map((project, position) => (position === index ? incoming : project));
        }));
        return sendJson(res, 200, {
          ok: true,
          applied,
          source: runner.source,
          storeFile: runner.storeFile,
          problems: runner.problems,
          projects: runner.readTable(),
        });
      }
      if (rest === '/discover' && method === 'POST') {
        const body = await readBody(req);
        const result = await runner.discover(body?.root, { maxDepth: body?.maxDepth });
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (rest === '/discover/cancel' && method === 'POST') {
        return sendJson(res, 200, { ok: true, cancelled: runner.cancelDiscover() });
      }
      if (rest === '/discover/apply' && method === 'POST') {
        const body = await readBody(req);
        const applied = await runner.enqueue(() => runner.applyDiscovery(body?.candidates, { replace: body?.replace === true }));
        return sendJson(res, 200, {
          ok: true,
          applied,
          source: runner.source,
          storeFile: runner.storeFile,
          problems: runner.problems,
          projects: runner.readTable(),
        });
      }
      if (rest === '/logs' && method === 'GET') {
        await runner.ensureLoaded();
        const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
        const page = runner.logs(queryId, Number.isFinite(since) && since > 0 ? since : 0);
        if (page === undefined) return sendJson(res, 404, { ok: false, error: `unknown project "${queryId}"` });
        return sendJson(res, 200, { ok: true, id: queryId, ...page });
      }
      if (rest === '/logs.txt' && method === 'GET') {
        await runner.ensureLoaded();
        const text = runner.logText(queryId);
        if (text === undefined) return sendJson(res, 404, { ok: false, error: `unknown project "${queryId}"` });
        return sendText(res, 200, text, `${queryId}.log`);
      }
      if (rest === '/start-all' && method === 'POST') {
        return sendJson(res, 200, { ok: true, ...(await runner.enqueue(() => runner.startAll())) });
      }
      if (rest === '/stop-all' && method === 'POST') {
        // Not queued, for the same reason `/stop` is not: `start-all` holds the
        // queue while it waits out each project's readiness probe, and the whole
        // point of this button is to end that wait.
        return sendJson(res, 200, { ok: true, ...(await runner.stopAll()) });
      }

      const item = rest.match(/^\/projects\/([^/]+)$/u);
      if (item !== null && method === 'DELETE') {
        const id = decodeURIComponent(item[1]);
        await runner.ensureLoaded();
        if (runner.runtimes.get(id) === undefined) return sendJson(res, 404, { ok: false, error: `unknown project "${id}"` });
        // Remove from the table FIRST, without the serial queue, for the same
        // reason `stop` skips it: a project stuck in its readiness window holds
        // the queue for up to its whole timeout, and the row the user is trying
        // to delete is exactly that one. Dropping it from the table aborts its
        // in-flight start (the start checks signal.aborted before spawning), so
        // the queue is not "skipped", it is made irrelevant.
        runner.dropProject(id);
        const applied = await runner.mutate((current) => current.filter((project) => project.id !== id));
        return sendJson(res, 200, {
          ok: true,
          applied,
          source: runner.source,
          storeFile: runner.storeFile,
          problems: runner.problems,
          projects: runner.readTable(),
        });
      }

      const action = rest.match(/^\/projects\/([^/]+)\/(start|stop|restart)$/u);
      if (action !== null && method === 'POST') {
        const id = decodeURIComponent(action[1]);
        const run = action[2];
        await runner.ensureLoaded();
        // Answer 404 for an unknown id before doing any work, so a typo reads as
        // "no such project" rather than as an internal failure.
        if (runner.runtimes.get(id) === undefined) {
          return sendJson(res, 404, { ok: false, error: `unknown project "${id}"` });
        }
        // `stop` deliberately does NOT go through the serial queue: a start can
        // sit in it for its whole readiness window, and a user pressing Stop
        // during that window must interrupt the wait, not queue behind it.
        // (Bug: with both queued, "start then stop 500 ms later" reported the
        // project running because the stop only ran after start had finished.)
        if (run === 'stop') {
          const stopped = await runner.stop(id);
          if (stopped === undefined) return sendJson(res, 404, { ok: false, error: `unknown project "${id}"` });
          return sendJson(res, 200, { ok: true, project: stopped, ...runner.snapshotAll() });
        }
        const result = await runner.enqueue(() => {
          if (run === 'start') return runner.start(id);
          return runner.restart(id);
        });
        if (result === undefined) return sendJson(res, 404, { ok: false, error: `unknown project "${id}"` });
        return sendJson(res, 200, { ok: true, project: result, ...runner.snapshotAll() });
      }

      await readBody(req);
      return sendJson(res, 404, { ok: false, error: `no route for ${method} ${rest}` });
    } catch (error) {
      ctx.logger.warn(`dev-runner: ${String(error)}`);
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  };
}

export function apply(ctx, config) {
  const runner = new Runner(ctx, config);

  ctx.effect(() => async () => {
    await runner.dispose();
  }, 'dev-runner: children');

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: createHandler(ctx, runner),
  }), 'dev-runner: api');

  // The table is loaded lazily by the first request so a bad file cannot make
  // plugin activation fail; report the outcome either way.
  runner.ensureLoaded()
    .then(() => {
      ctx.logger.info(`dev-runner: ${runner.projects.length} project(s) from ${runner.source}; ${API_PREFIX} ready`);
      for (const problem of runner.problems) ctx.logger.warn(`dev-runner: ${problem}`);
    })
    .catch((error) => {
      ctx.logger.warn(`dev-runner: loading the project table failed: ${String(error)}`);
    });
}
