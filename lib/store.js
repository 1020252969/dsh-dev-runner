/**
 * dsh-dev-runner — project table persistence.
 *
 * WHY A PLUGIN-OWNED FILE. The first version kept the project table inside the
 * profile's `cordis.patch.yml`, which meant every edit a user made in the panel
 * had to be written back into the harness's own configuration — a file that a
 * crashing host, a profile reset, or another plugin's patch can overwrite. The
 * table is plugin data, so it lives in plugin data: one JSON document under the
 * DSH home, written atomically, with the profile config kept as a fallback for
 * people who declare projects there.
 *
 * FAILURE PHILOSOPHY. Loading never throws. A missing file is an empty table, a
 * corrupt file is reported as a problem and preserved as `<file>.corrupt-<stamp>`
 * before the next write — losing a hand-written project table to a bad byte is
 * not an acceptable failure mode.
 *
 * PURE BY CONSTRUCTION: only `node:fs`/`node:path`, no host services, so the
 * whole module is unit-testable from a temp directory.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const STORE_VERSION = 1;

const LIMITS = {
  readyTimeoutMs: [1_000, 3_600_000],
  stopGraceMs: [0, 120_000],
  stopTimeoutMs: [1_000, 600_000],
  readyPort: [1, 65_535],
  restartDelayMs: [0, 600_000],
};

/** `Garden-Api` / `garden_api` / `garden.api` all become `garden-api`. */
export function slugify(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug === '' ? 'project' : slug;
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** Absent, unparseable and out-of-range values all fall back — never coerced. */
function clampNumber(value, [min, max], fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(asString(value));
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min || parsed > max) return fallback;
  return Math.round(parsed);
}

/**
 * Accept both spellings users reach for: an object (`{ "JAVA_HOME": "…" }`) and
 * the array form every shell taught them (`["JAVA_HOME=…"]`).
 */
function normalizeEnv(input) {
  if (Array.isArray(input)) {
    const env = {};
    for (const entry of input) {
      const text = asString(entry);
      const split = text.indexOf('=');
      if (split <= 0) continue;
      env[text.slice(0, split).trim()] = text.slice(split + 1).trim();
    }
    return env;
  }
  if (typeof input === 'object' && input !== null) {
    const env = {};
    for (const [key, value] of Object.entries(input)) {
      const name = asString(key);
      if (name === '' || value === undefined || value === null) continue;
      env[name] = String(value);
    }
    return env;
  }
  return {};
}

function normalizeSteps(input, problems, projectId) {
  if (!Array.isArray(input)) return [];
  const steps = [];
  for (const [index, raw] of input.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      problems.push(`${projectId}: before[${index}] is not an object — dropped`);
      continue;
    }
    const command = asString(raw.command);
    if (command === '') {
      problems.push(`${projectId}: before[${index}] has no command — dropped`);
      continue;
    }
    steps.push({
      name: asString(raw.name) === '' ? `step ${index + 1}` : asString(raw.name),
      command,
      expect: asString(raw.expect),
      timeoutMs: clampNumber(raw.timeoutMs, LIMITS.readyTimeoutMs, 120_000),
      continueOnError: raw.continueOnError === true,
    });
  }
  return steps;
}

/**
 * Turn one loosely-typed entry into a project the runner can execute, collecting
 * every reason it rejected something. Only `cwd` and `command` are truly
 * required; the id is derived from either.
 */
export function normalizeProject(input, options = {}) {
  const problems = [];
  if (typeof input !== 'object' || input === null) {
    return { project: null, problems: [`project ${options.index ?? '?'} is not an object`] };
  }
  const cwd = asString(input.cwd) === '' ? asString(options.fallbackCwd) : asString(input.cwd);
  const command = asString(input.command);
  const args = asString(input.args);
  if (cwd === '') problems.push('missing "cwd"');
  if (command === '') problems.push('missing "command"');
  const id = slugify(asString(input.id) === '' ? (path.basename(cwd) || input.name) : input.id);
  if (cwd === '' || command === '') return { project: null, problems: problems.map((problem) => `${id}: ${problem}`) };

  const readyPort = input.readyPort === null || input.readyPort === undefined || input.readyPort === ''
    ? null
    : clampNumber(input.readyPort, LIMITS.readyPort, null);
  if (input.readyPort !== null && input.readyPort !== undefined && input.readyPort !== '' && readyPort === null) {
    problems.push(`${id}: "readyPort" is not a port number — ignored`);
  }
  const project = {
    id,
    name: asString(input.name) === '' ? id : asString(input.name),
    cwd,
    command,
    args,
    env: normalizeEnv(input.env),
    role: ['backend', 'frontend', 'service', 'infra'].includes(input.role) ? input.role : 'service',
    framework: asString(input.framework) || undefined,
    readyPort,
    readyHost: asString(input.readyHost) || undefined,
    readyUrl: asString(input.readyUrl) || undefined,
    readyTimeoutMs: clampNumber(input.readyTimeoutMs, LIMITS.readyTimeoutMs, 120_000),
    stopGraceMs: clampNumber(input.stopGraceMs, LIMITS.stopGraceMs, 8_000),
    restartDelayMs: clampNumber(input.restartDelayMs, LIMITS.restartDelayMs, 1_000),
    autoRestart: input.autoRestart === true,
    // A command that is *supposed* to exit (`kubectl apply`, a code generator, a
    // one-shot migration) must not be reported as a failure when it does, and
    // must not be restarted. Only an explicit `true` opts in.
    ...(input.oneShot === true ? { oneShot: true } : {}),
    dependsOn: Array.isArray(input.dependsOn)
      ? [...new Set(input.dependsOn.map((entry) => slugify(entry)).filter((entry) => entry !== ''))]
      : [],
    before: normalizeSteps(input.before, problems, id),
    source: asString(input.source) || 'configured',
  };
  if (project.readyUrl !== undefined && !/^https?:\/\//u.test(project.readyUrl)) {
    problems.push(`${id}: "readyUrl" must start with http:// or https:// — ignored`);
    project.readyUrl = undefined;
  }
  return { project, problems };
}

/**
 * Normalize a whole table: drops unusable entries, de-duplicates ids, and breaks
 * dependency cycles so a `dependsOn` typo can never deadlock a start-all.
 */
export function normalizeProjects(input) {
  const problems = [];
  const list = Array.isArray(input) ? input : [];
  const projects = [];
  const seen = new Set();
  for (const [index, raw] of list.entries()) {
    const { project, problems: entryProblems } = normalizeProject(raw, { index });
    problems.push(...entryProblems);
    if (project === null) continue;
    if (seen.has(project.id)) {
      problems.push(`${project.id}: duplicate id — entry ${index + 1} dropped`);
      continue;
    }
    seen.add(project.id);
    projects.push(project);
  }
  // A dependency on an id that does not exist is a dangling pointer (dropped);
  // a cycle among existing ids is reported and cut at the back edge.
  for (const project of projects) {
    const unknown = project.dependsOn.filter((id) => !seen.has(id));
    if (unknown.length > 0) {
      problems.push(`${project.id}: dependsOn ${unknown.join(', ')} — unknown project, ignored`);
    }
    project.dependsOn = project.dependsOn.filter((id) => seen.has(id) && id !== project.id);
  }
  const state = new Map();
  const cut = (project) => {
    const mark = state.get(project.id);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      problems.push(`${project.id}: dependency cycle — this edge was cut`);
      project.dependsOn = [];
      return;
    }
    state.set(project.id, 'visiting');
    for (const id of [...project.dependsOn]) cut(projects.find((candidate) => candidate.id === id));
    state.set(project.id, 'done');
  };
  for (const project of projects) cut(project);
  return { projects, problems };
}

/** Envelope written to disk; the version lets a future release migrate in place. */
export function toDocument(projects) {
  return { version: STORE_VERSION, updatedAt: new Date().toISOString(), projects };
}

/**
 * One JSON document, written with a temp file + rename so a crash mid-write can
 * never leave a half-written table behind.
 */
export class ProjectStore {
  #dir;
  #file;
  #problems = [];

  constructor(options = {}) {
    this.#dir = options.dir;
    if (typeof this.#dir !== 'string' || this.#dir === '') throw new Error('ProjectStore needs a "dir"');
    this.#file = path.join(this.#dir, options.file ?? 'projects.json');
  }

  get filePath() {
    return this.#file;
  }

  /** Problems seen during the last load — never thrown, always reportable. */
  get problems() {
    return [...this.#problems];
  }

  async load() {
    this.#problems = [];
    let text;
    try {
      text = await fs.readFile(this.#file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#problems.push(`cannot read ${this.#file}: ${error?.message ?? error}`);
      return { projects: [], exists: false };
    }
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
      try {
        await fs.rename(this.#file, `${this.#file}.corrupt-${stamp}`);
        this.#problems.push(`${this.#file} is not valid JSON — kept as ${path.basename(this.#file)}.corrupt-${stamp}, starting empty`);
      } catch (error) {
        this.#problems.push(`${this.#file} is not valid JSON and could not be preserved: ${error?.message ?? error}`);
      }
      return { projects: [], exists: false };
    }
    const raw = Array.isArray(document?.projects) ? document.projects : Array.isArray(document) ? document : [];
    const { projects, problems } = normalizeProjects(raw);
    this.#problems = problems;
    return { projects, exists: true };
  }

  async save(projects) {
    const { projects: normalized, problems } = normalizeProjects(projects);
    await fs.mkdir(this.#dir, { recursive: true });
    const temporary = `${this.#file}.tmp-${process.pid}`;
    await fs.writeFile(temporary, `${JSON.stringify(toDocument(normalized), null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.#file);
    this.#problems = problems;
    return { projects: normalized, problems };
  }

  /**
   * Read-modify-write under one lock-free critical section. The host routes are
   * serialized already (`enqueue`), so a mutex here would only hide bugs.
   */
  async update(mutator) {
    const { projects } = await this.load();
    const next = await mutator(projects);
    return this.save(next ?? projects);
  }
}
