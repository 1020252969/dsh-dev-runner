/**
 * dsh-dev-runner — project discovery.
 *
 * WHY THIS EXISTS. Hand-writing a project table is the reason the first version
 * was worse than `dsh-idea-launcher` for everyday use: IDEA hands you the run
 * configurations, this plugin asked you to type `mvn ... spring-boot:run` and
 * the right port from memory. Discovery closes that gap the honest way — it
 * reads the same files a developer would (pom.xml, package.json, vite config,
 * application.yml, go.mod, pyproject.toml, docker-compose.yml) and proposes a
 * candidate table with the evidence that produced each row.
 *
 * WHAT IT NEVER DOES. It never writes configuration, never starts anything and
 * never guesses silently: every field carries where it came from, and a port
 * that is only a framework convention says so (`readyPortSource`). The caller
 * shows the candidates and the user accepts, edits or ignores them.
 *
 * PURE BY CONSTRUCTION. No host services, no third-party packages, no global
 * state — only `node:fs` and `node:path` — so the same module runs under the
 * host, inside a test, and from a plain `node` CLI.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Directories that never hold a project of their own. */
const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', '.idea', '.vscode', '.dsh', '.agents',
  'node_modules', 'target', 'build', 'dist', 'out', 'coverage',
  '__pycache__', '.venv', 'venv', '.pnpm-store', '.gradle', '.next', '.nuxt',
  '.turbo', '.cache', 'tmp', 'temp', 'logs',
]);

/** npm lifecycle scripts that plausibly start a long-running server, best first. */
const DEV_SCRIPT_PREFERENCE = [
  'dev', 'start', 'serve', 'dev:server', 'server', 'develop', 'watch',
  'dev:h5', 'dev:mp-weixin', 'start:dev',
];

/** Framework conventions, used only when no config file states a port. */
const CONVENTION_PORTS = {
  vite: 5173,
  'uni-app': 5173,
  next: 3000,
  nuxt: 3000,
  'create-react-app': 3000,
  remix: 3000,
  sveltekit: 5173,
  astro: 4321,
  angular: 4200,
  'vue-cli': 8080,
  express: 3000,
  nest: 3000,
  spring: 8080,
  quarkus: 8080,
  django: 8000,
  fastapi: 8000,
  flask: 5000,
  streamlit: 8501,
  go: 8080,
};

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readText(target, limit = 512 * 1024) {
  try {
    const handle = await fs.open(target, 'r');
    try {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, 0);
      // A byte-order mark is invisible and fatal to every parser downstream:
      // `\uFEFFserver:` does not match `^([ \t]*)([^\s#][^:]*?):`, so a BOM'd
      // application.yml silently reported no port at all. PowerShell and Notepad
      // both write one, so this is the common case on Windows, not an edge case.
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

async function readJson(target) {
  const text = await readText(target);
  if (text === '') return null;
  try {
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

async function listDir(target) {
  try {
    return await fs.readdir(target, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** `Garden-Api` / `garden_api` / `garden.api` all become `garden-api`. */
function slugify(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug === '' ? 'project' : slug;
}

/**
 * Interpret the right-hand side of a `port:` line. Spring's placeholder form
 * carries the real answer — `${SERVER_PORT:8080}` means 8080 — while a bare
 * number is taken as written. A placeholder *without* a default depends on the
 * environment, so it is reported as unknown rather than guessed.
 */
function interpretPortValue(raw) {
  const value = String(raw ?? '').trim().replace(/^['"]|['"]$/gu, '');
  const literal = value.match(/^(\d{2,5})$/u);
  if (literal !== null) return { port: Number(literal[1]), via: 'server.port' };
  const withDefault = value.match(/^\$\{[A-Za-z0-9_.]+:(\d{2,5})\}$/u);
  if (withDefault !== null) return { port: Number(withDefault[1]), via: 'placeholder default' };
  const envOnly = value.match(/^\$\{([A-Za-z0-9_.]+)\}$/u);
  if (envOnly !== null) return { port: null, via: `\${${envOnly[1]}} with no default` };
  return null;
}

/**
 * Return the raw value of a nested key path in a YAML-ish document, or null.
 *
 * WHY NOT A REGEX. The obvious pattern for "`server:`, then an indented `port:`"
 * is `(?:[ \t]+[^\r\n]*\r?\n)*?[ \t]+port…`, and that nested quantifier is
 * exponential: every indented line can be divided between the repeated group and
 * its continuation in exponentially many ways. A 63-line `application.yml` whose
 * `spring:` block contains a blank line made the whole scan hang for minutes
 * (found by scanning a real Maven tree, not by a unit test). An indent stack is
 * linear, and it is also the only way to be sure a key belongs to the block we
 * asked for.
 */
function yamlValueAt(text, path) {
  const wanted = path.map((part) => part.toLowerCase());
  const stack = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, '').trimEnd();
    if (line.trim() === '') continue;
    const match = /^([ \t]*)([^\s#][^:]*?)[ \t]*:[ \t]*(.*)$/u.exec(line);
    if (match === null) continue;
    const indent = match[1].replace(/\t/gu, '  ').length;
    const key = match[2].trim().toLowerCase();
    const value = match[3].trim();
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const trail = [...stack.map((entry) => entry.key), key];
    if (value !== '' && trail.length === wanted.length && trail.every((part, index) => part === wanted[index])) {
      return value;
    }
    stack.push({ indent, key });
  }
  return null;
}

/** Read a server port out of an application.yml / application.properties file. */
function portFromSpringText(text) {
  const candidates = [
    yamlValueAt(text, ['server', 'port']),
    yamlValueAt(text, ['quarkus', 'http', 'port']),
  ];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const found = interpretPortValue(candidate);
    if (found !== null) return found;
  }
  const patterns = [
    // YAML inline map: `server: { port: 8080 }` — bounded to a single line.
    /server[ \t]*:[ \t]*\{[^}\r\n]*?port[ \t]*:[ \t]*([^,}\r\n]+)/u,
    // Properties, either dotted or YAML-flat: `server.port=8080`
    /^[ \t]*server\.port[ \t]*[:=][ \t]*([^\r\n#]+)/mu,
    /^[ \t]*quarkus\.http\.port[ \t]*[:=][ \t]*([^\r\n#]+)/mu,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match === null) continue;
    const found = interpretPortValue(match[1]);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Which profile the project actually runs, so `application-dev.yml` beats
 * `application-prod.yml`. `spring.profiles.active: ${ACTIVE_PROFILE:dev}`
 * answers "dev" the same way the port placeholder answers a port.
 */
function activeProfileFromText(text) {
  const flat = text.match(/^[ \t]*spring\.profiles\.active[ \t]*[:=][ \t]*([^\r\n#]+)/mu);
  const raw = yamlValueAt(text, ['spring', 'profiles', 'active']) ?? (flat === null ? null : flat[1]);
  if (raw === null) return null;
  const value = raw.trim().replace(/^['"]|['"]$/gu, '').split(',')[0].trim();
  const withDefault = value.match(/^\$\{[A-Za-z0-9_.]+:([A-Za-z0-9_-]+)\}$/u);
  if (withDefault !== null) return withDefault[1];
  if (/^[A-Za-z0-9_-]+$/u.test(value)) return value;
  return null;
}

const NON_RUNNABLE_PROFILES = new Set(['prod', 'production', 'test', 'staging', 'uat', 'pre', 'preprod']);

/**
 * Spring Boot reads `src/main/resources/application[-profile].yml|properties`.
 * Order matters: the active profile first, then the unprofiled base file, then
 * any other profile, and production/test last — a developer runs `dev`.
 */
async function springPort(cwd) {
  const resources = path.join(cwd, 'src', 'main', 'resources');
  const entries = await listDir(resources);
  const files = entries
    .filter((entry) => entry.isFile() && /^application.*\.(ya?ml|properties)$/u.test(entry.name))
    .map((entry) => entry.name);
  const base = files.find((name) => /^application\.(ya?ml|properties)$/u.test(name));
  const preferred = base === undefined ? null : activeProfileFromText(await readText(path.join(resources, base)));
  const rank = (name) => {
    const suffix = name.replace(/^application/u, '').replace(/\.(ya?ml|properties)$/u, '').replace(/^-/u, '');
    if (suffix === '') return 1;
    if (preferred !== null && suffix === preferred) return 0;
    if (NON_RUNNABLE_PROFILES.has(suffix)) return 3;
    return 2;
  };
  const ordered = files.slice().sort((left, right) => rank(left) - rank(right));
  for (const name of ordered) {
    const found = portFromSpringText(await readText(path.join(resources, name)));
    if (found !== null) return { ...found, file: `src/main/resources/${name}` };
  }
  return null;
}

/** `--port 5173`, `-p 5173` anywhere in a command line. */
function portFromCommandLine(text) {
  const flag = text.match(/(?:^|\s)(?:--port|-p)[\s=]+(\d{2,5})(?:\s|$)/u);
  return flag === null ? null : Number(flag[1]);
}

/** Vite/webpack-style `server: { port: 5173 }`, plus a flat `port: 5173`. */
function portFromViteConfig(text) {
  const server = text.match(/server\s*:\s*\{[\s\S]{0,400}?port\s*:\s*(\d{2,5})/u);
  if (server !== null) return Number(server[1]);
  const env = text.match(/port\s*:\s*(?:Number\s*\(\s*)?(?:process\.env\.[A-Z0-9_]+\s*\?\?\s*)?['"]?(\d{2,5})['"]?/u);
  return env === null ? null : Number(env[1]);
}

/** A dev-server proxy target names the backend's port without any guessing. */
function backendPortFromProxy(text) {
  const target = text.match(/target\s*:\s*['"`]https?:\/\/[^'"`/:]+:(\d{2,5})/u);
  return target === null ? null : Number(target[1]);
}

/** `.env`, `.env.dev`, `.env.local` … any `*_PORT=` wins over a convention. */
async function portFromEnvFiles(cwd) {
  const entries = await listDir(cwd);
  const files = entries
    .filter((entry) => entry.isFile() && /^\.env(\.|$)/u.test(entry.name))
    .sort((left, right) => left.name.length - right.name.length);
  for (const entry of files) {
    const text = await readText(path.join(cwd, entry.name));
    const flag = portFromCommandLine(text);
    if (flag !== null) return { port: flag, via: entry.name };
    const match = text.match(/^\s*(?:VITE_|NEXT_PUBLIC_|REACT_APP_|NUXT_)?PORT\s*=\s*(\d{2,5})/mu);
    if (match !== null) return { port: Number(match[1]), via: entry.name };
  }
  return null;
}

function packageManagerFor(entries) {
  const names = new Set(entries.map((entry) => entry.name));
  if (names.has('pnpm-lock.yaml') || names.has('pnpm-workspace.yaml')) return 'pnpm';
  if (names.has('yarn.lock')) return 'yarn';
  if (names.has('bun.lockb') || names.has('bun.lock')) return 'bun';
  return 'npm';
}

function runScript(manager, script) {
  if (manager === 'yarn') return `yarn ${script}`;
  if (manager === 'pnpm') return `pnpm run ${script}`;
  if (manager === 'bun') return `bun run ${script}`;
  return `npm run ${script}`;
}

/**
 * Which kind of JavaScript project this is, from its dependencies first and its
 * config files second. Ordered most specific first: uni-app also depends on
 * vite, and Next.js ships its own bundler.
 */
function classifyNodeProject(pkg, names, configText) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);
  if (has('@dcloudio/uni-app') || has('@dcloudio/vite-plugin-uni')) return 'uni-app';
  if (has('expo')) return 'expo';
  if (has('react-native')) return 'react-native';
  if (has('next')) return 'next';
  if (has('nuxt') || has('nuxt3')) return 'nuxt';
  if (has('@angular/core') || has('@angular/cli')) return 'angular';
  if (has('@remix-run/dev') || has('@remix-run/react')) return 'remix';
  if (has('@sveltejs/kit')) return 'sveltekit';
  if (has('astro')) return 'astro';
  if (has('@nestjs/core')) return 'nest';
  if (has('react-scripts')) return 'create-react-app';
  if (has('@vue/cli-service')) return 'vue-cli';
  if (has('vite') || [...names].some((name) => /^vite\.config\./u.test(name))) return 'vite';
  if (has('express') || has('koa') || has('fastify')) return 'express';
  return 'node';
}

const FRONTEND_FRAMEWORKS = new Set([
  'uni-app', 'vite', 'next', 'nuxt', 'angular', 'vue-cli', 'create-react-app',
  'sveltekit', 'astro', 'remix', 'expo', 'react-native',
]);

/**
 * Discover one npm-shaped project. `uni-app` is the reason this returns options:
 * a uni-app package has `dev:h5` and `dev:mp-weixin`, and the user must pick the
 * target rather than inherit whichever script happens to sort first.
 */
async function discoverNode(cwd, dirName) {
  const pkg = await readJson(path.join(cwd, 'package.json'));
  if (pkg === null) return [];
  const entries = await listDir(cwd);
  const names = new Set(entries.map((entry) => entry.name));
  const scripts = typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : {};
  const configName = [...names].find((name) => /^(vite|next|nuxt|svelte|astro)\.config\.[cm]?[jt]s$/u.test(name));
  const configText = configName === undefined ? '' : await readText(path.join(cwd, configName));
  const framework = classifyNodeProject(pkg, names, configText);
  const manager = packageManagerFor(entries);
  const evidence = [`package.json${configName === undefined ? '' : ` + ${configName}`}`, `framework: ${framework}`];

  const configPort = configName === undefined ? null : portFromViteConfig(configText);
  const envPort = await portFromEnvFiles(cwd);
  const resolvedPort = configPort ?? envPort?.port ?? null;
  const resolvedSource = configPort !== null ? `${configName} server.port`
    : envPort === null ? null : `${envPort.via} PORT`;
  const proxyPort = configName === undefined ? null : backendPortFromProxy(configText);
  if (proxyPort !== null) evidence.push(`${configName} proxies to port ${proxyPort}`);

  const role = FRONTEND_FRAMEWORKS.has(framework) ? 'frontend' : 'service';

  // Candidate script names, most plausible first, deduplicated.
  const scriptNames = Object.keys(scripts);
  const chosen = [];
  if (framework === 'uni-app') {
    for (const name of ['dev:h5', 'dev', 'dev:mp-weixin', 'dev:app']) {
      if (scriptNames.includes(name)) chosen.push(name);
    }
  } else {
    for (const name of DEV_SCRIPT_PREFERENCE) {
      if (scriptNames.includes(name)) chosen.push(name);
    }
  }
  for (const name of scriptNames) {
    if (chosen.length >= 4) break;
    if (/^(dev|start|serve|watch)(:|$)/u.test(name) && !chosen.includes(name)) chosen.push(name);
  }
  if (chosen.length === 0) {
    evidence.push('no dev/start script found');
    return [];
  }

  const commandOptions = chosen.map((script) => {
    const line = String(scripts[script] ?? '');
    const scriptPort = portFromCommandLine(line);
    // A script that only compiles (mini-program targets) serves no port at all.
    const compiles = /(^|\s)(uni|vue-cli-service)\s+(build|-p\s+mp-)/u.test(line) || /^build/u.test(script);
    const convention = CONVENTION_PORTS[framework];
    return {
      script,
      command: runScript(manager, script),
      readyPort: scriptPort ?? resolvedPort ?? (compiles ? null : convention ?? null),
      readyPortSource: scriptPort !== null ? `--port in script "${script}"`
        : resolvedSource !== null ? resolvedSource
          : compiles ? 'none (compile-only target)'
            : convention === undefined ? 'unknown' : `${framework} convention`,
    };
  });

  const primary = commandOptions[0];
  return [{
    id: slugify(dirName),
    name: dirName,
    cwd,
    role,
    framework,
    packageManager: manager,
    command: primary.command,
    readyPort: primary.readyPort,
    readyPortSource: primary.readyPortSource,
    commandOptions,
    dependsOnHint: proxyPort,
    evidence,
  }];
}

async function discoverMaven(cwd, dirName, signal = null) {
  const text = await readText(path.join(cwd, 'pom.xml'));
  if (text === '') return [];
  // An aggregator is a container, not a service: `mvn spring-boot:run` at its
  // root is meaningless. Returning nothing lets the walk descend into the
  // modules, which is where the runnable projects actually are.
  if (/<packaging>\s*pom\s*<\/packaging>/u.test(text)) return [];
  const isSpring = text.includes('spring-boot-maven-plugin');
  const isQuarkus = text.includes('quarkus-maven-plugin');
  // A plain pom has no honest start command. `mvn exec:java` only works when the
  // pom itself names the main class, so that is the bar for proposing it.
  const isExec = text.includes('exec-maven-plugin') && /<mainClass>/u.test(text);
  if (!isSpring && !isQuarkus && !isExec) return [];
  const evidence = ['pom.xml'];
  if (isSpring) evidence.push('spring-boot-maven-plugin');
  if (isQuarkus) evidence.push('quarkus-maven-plugin');
  if (isExec && !isSpring && !isQuarkus) evidence.push('exec-maven-plugin with a configured mainClass');
  const wrapper = await exists(path.join(cwd, 'mvnw.cmd')) || await exists(path.join(cwd, 'mvnw'));
  const base = wrapper ? 'mvnw' : 'mvn';
  if (wrapper) evidence.push('maven wrapper present');
  const goal = isQuarkus ? 'quarkus:dev' : isSpring ? 'spring-boot:run' : 'exec:java';
  const found = await springPort(cwd);
  if (found !== null) evidence.push(found.port === null ? `${found.file} declares ${found.via}` : `port ${found.port} from ${found.file}`);
  const extra = isSpring ? ['-Dmaven.test.skip=true'] : [];
  const commandOptions = [
    { command: [base, ...extra, goal].join(' '), note: 'standard' },
    ...(isSpring ? [{ command: `${base} -q -Dmaven.test.skip=true compile`, note: 'compile first (pre-launch step)' }] : []),
  ];
  const servesSpring = isSpring || isQuarkus;
  // Register / call edges are only read for projects that could be part of a
  // service mesh. Reading every Java file of every project would make the scan
  // slow for the common single-project case, which is most users.
  let serviceNames = [];
  let calls = [];
  let registryHints = [];
  let configHints = [];
  if (servesSpring) {
    // Config files are always worth reading, and they are cheap: they are read
    // first, outside the source budget, so `bootstrap.yml` can never be crowded
    // out by a few hundred Java files.
    const configFiles = await configBlob(cwd, undefined, signal);
    const configText = configFiles.join('\n');
    // The mesh gate has to look at the dependency block and the source tree, not
    // only at resolved configuration: a project whose *pom* declares OpenFeign
    // or Dubbo has no such key in `application.yml`, and keying the source read
    // on the config alone made every `@FeignClient` call site invisible.
    //
    // The pom itself is not a mesh member by virtue of being a pom: only tags
    // that name a mesh library count, so a plain Spring Boot pom (which carries
    // `spring-cloud-starter-*` for other reasons) does not pay the source read.
    const meshInPom = /spring-cloud-(?:openfeign|loadbalancer|nacos|eureka|consul|zookeeper)|dubbo|spring-cloud-starter-alibaba-(?:nacos|dubbo)|<artifactId>[^<]*(?:seata|sentinel|sleuth|zipkin)[^<]*<\/artifactId>/iu.test(text);
    // A call site can be the *only* evidence of a mesh: a project may import
    // OpenFeign transitively (a parent BOM) and keep no registry key of its own.
    // Probing the source tree before deciding is what makes `@FeignClient` count;
    // the probe stops at the first match, so a plain app pays one directory read.
    const meshMentioned = meshInPom || MESH_DECLARATION.test(configText) || (await mentionsCallSite(cwd, undefined, signal));
    const blob = meshMentioned ? await sourceBlob(cwd, undefined, configFiles, { signal }) : configText;
    const appName = springAppName(blob);
    if (appName !== null) serviceNames.push(appName);
    for (const name of registeredNames(blob)) {
      if (!serviceNames.includes(name)) serviceNames.push(name);
    }
    if (meshMentioned || MESH_CALL_SITE.test(blob)) {
      calls = [...new Set([
        ...feignClients(blob),
        ...balancedUrlTargets(blob),
        ...dubboReferences(blob),
        ...nacosDiscoveryNames(blob),
      ])];
    }
    const registries = registrationTargetsIn(blob, text);
    if (registries.length > 0) {
      // Kept on the candidate, not on the evidence list: the edge builder needs
      // it to decide whether this project waits for a scanned registry.
      registryHints = registries.map((target) => `${target.host}${target.port === null ? '' : `:${target.port}`}`);
      for (const hint of registryHints) if (!serviceNames.includes(hint)) serviceNames.push(hint);
      evidence.push(`registry ${registryHints.join(', ')}`);
    }
    const configCenters = configCenterTargetsIn(blob, text);
    if (configCenters.length > 0) {
      configHints = configCenters.map((target) => `${target.host}${target.port === null ? '' : `:${target.port}`}`);
      evidence.push(`config center ${configHints.join(', ')}`);
    }
    if (serviceNames.length > 0) evidence.push(`service name: ${serviceNames.join(', ')}`);
    if (calls.length > 0) evidence.push(`calls: ${calls.slice(0, 8).join(', ')}`);
  }
  return [{
    id: slugify(dirName),
    name: dirName,
    cwd,
    role: 'backend',
    framework: isQuarkus ? 'quarkus' : isSpring ? 'spring' : 'exec-maven-plugin',
    command: commandOptions[0].command,
    serviceNames,
    calls,
    registry: registryHints,
    configCenter: configHints,
    readyPort: found?.port ?? (servesSpring ? CONVENTION_PORTS.spring : null),
    readyPortSource: found?.port != null ? found.file
      : found === null ? (servesSpring ? 'spring convention' : 'unknown')
        : `${found.file} says ${found.via} — spring convention ${CONVENTION_PORTS.spring}`,
    commandOptions,
    dependsOnHint: null,
    evidence,
  }];
}

async function discoverGradle(cwd, dirName) {
  const names = (await listDir(cwd)).map((entry) => entry.name);
  const buildName = ['build.gradle.kts', 'build.gradle'].find((name) => names.includes(name));
  if (buildName === undefined) return [];
  const text = await readText(path.join(cwd, buildName));
  if (text === '') return [];
  // An Android module has no `run` task — proposing `gradlew run` would fail on
  // the first click. Android apps are not dev servers, so propose nothing.
  if (/com\.android\.(application|library|dynamic-feature|test)/u.test(text) || /\bandroid\s*\{/u.test(text)) return [];
  // `gradle run` is only a real task when the build asks for it: the Spring Boot
  // plugin, the `application` plugin, or Quarkus. Anything else is a guess.
  const isSpring = text.includes('org.springframework.boot');
  const isApplication = /id\(\s*["']application["']\s*\)/u.test(text)
    || /apply\s+plugin\s*:\s*["']application["']/u.test(text)
    || /id\s+["']application["']/u.test(text);
  const isQuarkus = text.includes('io.quarkus');
  if (!isSpring && !isApplication && !isQuarkus) return [];
  const wrapper = names.includes('gradlew.bat') || names.includes('gradlew');
  const base = wrapper ? (process.platform === 'win32' ? 'gradlew.bat' : './gradlew') : 'gradle';
  const found = await springPort(cwd);
  const evidence = [buildName, wrapper ? 'gradle wrapper present' : 'no wrapper (needs a global gradle)'];
  if (isSpring) evidence.push('org.springframework.boot plugin');
  if (isQuarkus) evidence.push('io.quarkus plugin');
  if (isApplication && !isSpring && !isQuarkus) evidence.push('application plugin');
  if (found !== null) evidence.push(`port ${found.port} from ${found.file}`);
  const framework = isSpring ? 'spring' : isQuarkus ? 'quarkus' : 'gradle-application';
  return [{
    id: slugify(dirName),
    name: dirName,
    cwd,
    role: 'backend',
    framework,
    command: isSpring ? `${base} bootRun` : isQuarkus ? `${base} quarkusDev` : `${base} run`,
    readyPort: found?.port ?? (isSpring ? CONVENTION_PORTS.spring : null),
    readyPortSource: found === null ? (isSpring ? 'spring convention' : 'unknown') : found.file,
    commandOptions: [],
    dependsOnHint: null,
    evidence,
  }];
}

async function discoverGo(cwd, dirName) {
  const text = await readText(path.join(cwd, 'go.mod'));
  if (text === '') return [];
  const moduleName = text.match(/^module\s+(\S+)/mu)?.[1] ?? dirName;
  return [{
    id: slugify(dirName),
    name: dirName,
    cwd,
    role: 'service',
    framework: 'go',
    command: 'go run .',
    readyPort: null,
    readyPortSource: 'unknown (go services rarely declare a port)',
    commandOptions: [],
    dependsOnHint: null,
    evidence: [`go.mod (module ${moduleName})`],
  }];
}

async function discoverPython(cwd, dirName) {
  const names = new Set((await listDir(cwd)).map((entry) => entry.name));
  const hasManage = names.has('manage.py');
  const requirements = await readText(path.join(cwd, 'requirements.txt'));
  const pyproject = await readText(path.join(cwd, 'pyproject.toml'));
  const blob = `${requirements}\n${pyproject}`;
  if (!hasManage && blob.trim() === '') return [];
  const evidence = [];
  if (hasManage) evidence.push('manage.py');
  if (requirements !== '') evidence.push('requirements.txt');
  if (pyproject !== '') evidence.push('pyproject.toml');

  let framework = null;
  if (hasManage) framework = 'django';
  else if (/fastapi/u.test(blob)) framework = 'fastapi';
  else if (/flask/u.test(blob)) framework = 'flask';
  else if (/streamlit/u.test(blob)) framework = 'streamlit';
  else return [];

  let command;
  if (framework === 'django') command = 'python manage.py runserver';
  else if (framework === 'fastapi') {
    const appModule = names.has('app') ? 'app.main:app' : 'main:app';
    command = `uvicorn ${appModule} --reload`;
    evidence.push(`uvicorn target ${appModule} (edit if your ASGI app lives elsewhere)`);
  } else if (framework === 'flask') command = 'flask run';
  else command = 'streamlit run app.py';
  return [{
    id: slugify(dirName),
    name: dirName,
    cwd,
    role: 'backend',
    framework,
    command,
    readyPort: CONVENTION_PORTS[framework],
    readyPortSource: `${framework} convention`,
    commandOptions: [],
    dependsOnHint: null,
    evidence,
  }];
}

async function discoverCompose(cwd, dirName) {
  const names = new Set((await listDir(cwd)).map((entry) => entry.name));
  const composeName = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find((name) => names.has(name));
  if (composeName === undefined) return [];
  const text = await readText(path.join(cwd, composeName));
  const services = [...text.matchAll(/^\s{2}([a-z0-9][a-z0-9._-]*)\s*:/gmu)].map((match) => match[1]);
  const published = text.match(/^\s*-\s*['"]?(\d{2,5}):\d{2,5}['"]?\s*$/mu);
  return [{
    id: slugify(dirName),
    name: dirName,
    cwd,
    role: 'infra',
    framework: 'docker-compose',
    command: 'docker compose up',
    readyPort: published === null ? null : Number(published[1]),
    readyPortSource: published === null ? 'unknown' : `${composeName} published port`,
    commandOptions: [],
    dependsOnHint: null,
    evidence: [`${composeName} (${services.length} service${services.length === 1 ? '' : 's'}${services.length === 0 ? '' : `: ${services.slice(0, 6).join(', ')}`})`],
  }];
}

/**
 * A Kubernetes deployment directory: the thing `kubectl apply -f` or `kustomize`
 * turns into a running stack.
 *
 * What this is *for*: a microservice repo that only ships manifests still has a
 * meaningful start order (a deployment that reads a ConfigMap, a service that
 * needs a database), and having the runner bring the whole folder up in one go
 * is more useful than the user remembering the incantation.
 *
 * What this deliberately does NOT do: pretend a Kubernetes resource is a
 * long-running dev process. The command is `kubectl apply` (or `kustomize
 * build | kubectl apply -f -`), which *exits*, so the port is read for
 * evidence only and the project is marked `oneShot`.
 *
 * Recognition is by file extension plus a mandatory `apiVersion:` line: a stray
 * `*.yaml` in a resources folder must not be mistaken for a workload, and the
 * `apiVersion`/`kind` pair is what makes a manifest a manifest.
 */
async function discoverKubernetes(cwd, dirName) {
  const entries = await listDir(cwd);
  const manifestNames = entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => !/^(?:application|bootstrap|docker-compose|compose)\.ya?ml$/u.test(name));
  const hasKustomization = entries.some((entry) => entry.isFile() && /^kustomization\.ya?ml$/u.test(entry.name));
  if (manifestNames.length === 0 && !hasKustomization) return [];

  let manifests = 0;
  let workloads = 0;
  const kinds = new Set();
  let declaredServices = [];
  let port = null;
  let portSource = 'unknown';
  for (const name of manifestNames.slice(0, 40)) {
    const text = await readText(path.join(cwd, name), 512 * 1024);
    if (text === null || !/^[ \t]*apiVersion[ \t]*:/mu.test(text)) continue;
    manifests += 1;
    for (const match of text.matchAll(/^[ \t]*kind[ \t]*:[ \t]*["']?([A-Za-z]+)/gmu)) {
      kinds.add(match[1]);
      if (/^(Deployment|StatefulSet|DaemonSet|Job|CronJob|Pod)$/u.test(match[1])) workloads += 1;
    }
    // YAML puts the value on the next column, so the space after `:` is normal:
    // `- containerPort: 8082`. [ \t]* after the colon is the whole point.
    const containerPort = text.match(/^[ \t]*(?:-\s*)?containerPort[ \t]*:[ \t]*["']?(\d{2,5})/mu);
    if (port === null && containerPort !== null) {
      port = Number(containerPort[1]);
      portSource = `${name} containerPort`;
    }
    if (declaredServices.length === 0) {
      declaredServices = [...text.matchAll(/^[ \t]*name[ \t]*:[ \t]*["']?([a-z0-9][a-z0-9._-]*)/gmu)].map((match) => match[1]);
    }
  }
  if (manifests === 0 && !hasKustomization) return [];

  // A cluster you cannot reach is the normal state on a laptop, so the command is
  // the one that *would* work, and the evidence says what it was recognised from.
  const command = hasKustomization ? 'kubectl apply -k .' : `kubectl apply -f ${manifestNames.length > 1 ? '.' : manifestNames[0]}`;
  const summary = hasKustomization
    ? `kustomization.yaml (${manifests} manifest${manifests === 1 ? '' : 's'}${kinds.size === 0 ? '' : `, kinds: ${[...kinds].slice(0, 5).join(', ')}`})`
    : `${manifests} Kubernetes manifest${manifests === 1 ? '' : 's'}${kinds.size === 0 ? '' : ` (${[...kinds].slice(0, 5).join(', ')})`}`;
  return [{
    id: slugify(dirName),
    name: dirName,
    cwd,
    role: 'infra',
    framework: 'kubernetes',
    command,
    commandOptions: [
      { command, note: 'kubectl apply (one-shot)' },
      ...(hasKustomization ? [{ command: 'kustomize build . | kubectl apply -f -', note: 'render kustomization, then apply (one-shot)' }] : []),
    ],
    readyPort: port,
    readyPortSource: portSource,
    dependsOnHint: null,
    oneShot: true,
    workloadCount: workloads,
    declaredServices,
    evidence: [summary, ...(workloads === 0 ? ['no workload resource - this folder may only hold configuration'] : [])],
  }];
}

/** Every detector, in the order their results are presented. */
const DETECTORS = [
  ['maven', discoverMaven],
  ['gradle', discoverGradle],
  ['node', discoverNode],
  ['python', discoverPython],
  ['go', discoverGo],
  ['compose', discoverCompose],
  ['kubernetes', discoverKubernetes],
];

/**
 * Is this directory a *container* whose children are the projects?
 *
 * A workspace root — npm/yarn/pnpm workspaces, a Maven aggregator whose
 * packaging is `pom`, a Gradle multi-project `settings.gradle` — is not a
 * project itself, and its members sit one level down by definition. The walk
 * therefore descends into containers even when it has already spent its depth
 * budget, which is what makes a monorepo work at the default depth.
 *
 * @returns the kind of container, or `null` when the directory is a project.
 */
async function workspaceKind(cwd) {
  const names = new Set((await listDir(cwd)).map((entry) => entry.name));
  if (names.has('pnpm-workspace.yaml')) return 'pnpm workspace';
  if (names.has('lerna.json')) return 'lerna workspace';
  const pkg = await readJson(path.join(cwd, 'package.json'));
  if (pkg !== null && pkg.workspaces !== undefined) return 'npm/yarn workspace';
  if (names.has('pom.xml')) {
    const text = await readText(path.join(cwd, 'pom.xml'));
    if (/<packaging>\s*pom\s*<\/packaging>/u.test(text) && /<modules>/u.test(text)) return 'maven aggregator';
  }
  const gradle = ['settings.gradle.kts', 'settings.gradle'].find((name) => names.has(name));
  if (gradle !== undefined) {
    const text = await readText(path.join(cwd, gradle));
    if (/^\s*include\s*[(\s'"]/mu.test(text)) return `${gradle} (multi-project)`;
  }
  return null;
}

const ROLE_ORDER = { backend: 0, service: 1, infra: 2, frontend: 3 };

/**
 * Wire the obvious dependency when a scan finds one backend and several
 * frontends: those frontends cannot boot against anything else. A frontend whose
 * dev-server proxy names the backend's port is treated as proof rather than
 * inference, and only that frontend is wired.
 */
/** Service identities a project claims, i.e. what OTHER projects call it by. */
/**
 * `spring.application.name`, read as a line walk.
 *
 * This used to be one regex, and the regex was a hang, not a slowdown: the lazy
 * line group plus a `[ \t]+[^\r\n]*` prefix that can split a single line two
 * ways costs 2^lines backtracks when the match ultimately fails. A blob holding
 * a `spring:` line with no `application.name:` under it (which is what a joined
 * Java tree looks like) therefore never finishes: one core pinned at 100%, no
 * output, forever. That is what the panel's request deadline reported as
 * "no answer within 15s", and why restarting the host was the only cure.
 *
 * A windowed line walk is linear and says the same thing. The window is bounded
 * because the block a `spring:` key opens is hand-written and short.
 */
const SPRING_NAME_WINDOW = 200;

/** `spring.application.name` out of a blob of config/property text, or null. */
function springAppName(text) {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^[ \t]*spring[ \t]*:[ \t]*\r?$/u.test(lines[index])) continue;
    const end = Math.min(lines.length, index + 1 + SPRING_NAME_WINDOW);
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const match = /^[ \t]+application\.name[ \t]*:[ \t]*["']?([A-Za-z0-9._-]+)/u.exec(lines[cursor]);
      if (match !== null) return match[1];
    }
  }
  return null;
}

/**
 * How many source files the scan is willing to read while looking for
 * registration or call edges. A monorepo can hold tens of thousands; the answer
 * does not get better after the first few hundred, and a scan that takes a
 * minute is a scan nobody runs.
 */
const SOURCE_READ_BUDGET = 400;

/**
 * How many *bytes* of source the mesh probe may read before it stops.
 *
 * A file count is not a bound: 400 files of 256 KB each is 100 MB of text, and
 * the regexes downstream are super-linear in the worst case, so a bound in bytes
 * is a bound in time. The probe only needs *some* evidence, and 2 MB of Java
 * holds plenty.
 */
const SOURCE_BYTE_BUDGET = 2 * 1024 * 1024;

/** How much of a single source file is ever read. */
const SOURCE_FILE_BYTES = 64 * 1024;

/** Config files are small and load-bearing, so they get their own byte budget. */
const CONFIG_BYTE_BUDGET = 512 * 1024;

/** How much of a single config file is ever read. */
const CONFIG_FILE_BYTES = 64 * 1024;

/** Cancellation as a plain predicate: the walkers ask between every read. */
function aborted(signal) {
  return signal !== null && signal !== undefined && signal.aborted === true;
}

/** Directories inside a service that never hold its own business code. */
const NON_SOURCE_DIRS = new Set([
  'node_modules', 'target', 'build', 'dist', 'out', '.git', '.idea', '.gradle',
  '.mvn', 'coverage', 'test', 'tests', '__pycache__', '.venv', 'venv',
]);

/**
 * Walk `cwd` collecting the text of source-like files, up to `budget` files.
 *
 * The caller only needs *some* evidence, so this stops as soon as the budget is
 * spent rather than reading everything: one `@FeignClient` anywhere in the tree
 * is as good as one in the thousandth file, and one `nacos` dependency in
 * `pom.xml` is already conclusive.
 *
 * @returns every file's text joined with newlines (bounded, never the whole tree).
 */
async function sourceBlob(cwd, budget = SOURCE_READ_BUDGET, knownConfig = null, options = {}) {
  const signal = options.signal ?? null;
  const byteBudget = Number.isFinite(options.bytes) && options.bytes > 0 ? options.bytes : SOURCE_BYTE_BUDGET;
  const texts = [];
  let read = 0;
  let bytes = 0;
  const pending = [cwd];
  // Configuration files are read first and do not spend the source budget. They
  // are where registration, config-center and port evidence actually lives, and
  // in a Spring app they sit *behind* a `src/main/java` tree in BFS order: with a
  // single shared budget, a project with 400 Java files would never get to its
  // own `bootstrap.yml`. When the caller already has them, they are reused
  // instead of read twice.
  const configFiles = knownConfig === null ? [] : [...knownConfig];
  const already = knownConfig !== null;
  while (pending.length > 0 && read < budget && bytes < byteBudget) {
    if (aborted(signal)) break;
    const dir = pending.shift();
    const entries = await listDir(dir);
    for (const entry of entries) {
      if (read >= budget || bytes >= byteBudget) break;
      if (entry.isDirectory()) {
        const name = entry.name.toLowerCase();
        if (name.startsWith('.') || NON_SOURCE_DIRS.has(name)) continue;
        pending.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const config = isConfigFile(entry.name);
      if (!config && !/\.(java|kt|scala|groovy|ts|js|vue|py)$/u.test(entry.name)) continue;
      if (config && already) continue;
      const text = await readText(path.join(dir, entry.name), config ? CONFIG_FILE_BYTES : SOURCE_FILE_BYTES);
      bytes += text.length;
      if (config) {
        configFiles.push(text);
        continue;
      }
      texts.push(text);
      read += 1;
    }
  }
  return [...configFiles, ...texts].join('\n');
}

/** A file whose contents are configuration rather than code. */
function isConfigFile(name) {
  return /\.(?:ya?ml|properties|xml)$/u.test(name);
}

/**
 * A mesh is declared in configuration when a registry, a config center or a
 * load-balanced client is configured. Deliberately narrow: `feign` as a bare
 * word matches a Spring Boot project's own package name.
 */
const MESH_DECLARATION = /nacos|eureka|consul|zookeeper|dubbo|apollo|spring\.cloud\.config|feign\.client|loadbalancer|discovery[._-]?client/iu;

/** A mesh is used in code when a remote call site appears. */
const MESH_CALL_SITE = /@(?:FeignClient|FeignApi|DubboReference|Reference)\s*\(|https?:\/\/[A-Za-z0-9][A-Za-z0-9-]*\//u;

/**
 * Whether any source file under `cwd` carries a mesh call site.
 *
 * This exists so the expensive `sourceBlob` read can be skipped for ordinary
 * Spring Boot projects *without* making the mesh gate depend on configuration:
 * an OpenFeign client can arrive through a parent BOM and leave no key in
 * `application.yml`, in which case the call site in the source is the only
 * evidence there is. The walk shares `sourceBlob`'s rules (same directories, same
 * extensions) but stops at the first hit and only reads the head of each file.
 */
async function mentionsCallSite(cwd, budget = 400, signal = null) {
  const pending = [cwd];
  let read = 0;
  let bytes = 0;
  while (pending.length > 0 && read < budget && bytes < SOURCE_BYTE_BUDGET) {
    if (aborted(signal)) return false;
    const dir = pending.shift();
    for (const entry of await listDir(dir)) {
      if (entry.isDirectory()) {
        const name = entry.name.toLowerCase();
        if (name.startsWith('.') || NON_SOURCE_DIRS.has(name)) continue;
        pending.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !/\.(java|kt|scala|groovy|ts|js|vue|py)$/u.test(entry.name)) continue;
      read += 1;
      const text = await readText(path.join(dir, entry.name), SOURCE_FILE_BYTES);
      bytes += text.length;
      if (MESH_CALL_SITE.test(text)) return true;
    }
  }
  return false;
}

/**
 * The text of every configuration file under `cwd`, without reading any code.
 *
 * This runs on every Spring-shaped project, so it is bounded by depth and by
 * count: a project that keeps generated config in `target/` (already excluded)
 * or thousands of module YAMLs still answers in milliseconds.
 */
async function configBlob(cwd, budget = 60, signal = null) {
  const texts = [];
  let bytes = 0;
  const pending = [cwd];
  while (pending.length > 0 && texts.length < budget && bytes < CONFIG_BYTE_BUDGET) {
    if (aborted(signal)) break;
    const dir = pending.shift();
    for (const entry of await listDir(dir)) {
      if (texts.length >= budget || bytes >= CONFIG_BYTE_BUDGET) break;
      if (entry.isDirectory()) {
        const name = entry.name.toLowerCase();
        if (name.startsWith('.') || NON_SOURCE_DIRS.has(name)) continue;
        pending.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !isConfigFile(entry.name)) continue;
      const text = await readText(path.join(dir, entry.name), CONFIG_FILE_BYTES);
      bytes += text.length;
      // `readText` answers an empty string for anything it cannot read; a vanished
      // file between listing and reading must not become the string "null" in the
      // evidence blob (which pollutes every regex downstream).
      if (typeof text === 'string') texts.push(text);
    }
  }
  return texts;
}

/** String arguments of every `@FeignClient("x")` -ish annotation in `text`. */
function feignClients(text) {
  const names = new Set();
  const pattern = /@(?:FeignClient|FeignApi|HttpExchangeClent|HttpExchangeClient)\s*\(([\s\S]{0,300}?)\)/gu;
  for (const match of text.matchAll(pattern)) {
    const body = match[1];
    for (const literal of body.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]{1,60})["']/gu)) {
      names.add(literal[1]);
    }
    const named = body.match(/(?:name|value|serviceId|service)\s*=\s*["']([A-Za-z0-9][A-Za-z0-9._-]{1,60})["']/u);
    if (named !== null) names.add(named[1]);
  }
  return [...names];
}

/**
 * `@LoadBalanced RestTemplate` + a `http://service-name/...` URL is the other
 * common way one Spring service names another without Feign.
 */
function balancedUrlTargets(text) {
  const names = new Set();
  for (const match of text.matchAll(/["']https?:\/\/([A-Za-z0-9][A-Za-z0-9._-]{1,60})(?::\d+)?\//gu)) {
    const host = match[1];
    // A literal host would have a dot or be localhost; a bare word is a service id.
    if (host.includes('.') || host === 'localhost' || /^\d+$/u.test(host)) continue;
    names.add(host);
  }
  return [...names];
}

/**
 * Dubbo services a project calls.
 *
 * `@DubboReference(interfaceClass = UserApi.class)` names the *interface*, not
 * the application, and an interface's package (`com.acme.user.api.UserApi`) is
 * the only handle the caller has. The conventional mapping from that package to
 * the providing application is its first and last-but-one segments
 * (`com.acme.user.api` → `user`), which is what `aliasTable` is keyed on.
 *
 * `@DubboReference(application = "user-provider")` and `@Reference(version=...,
 * application=...)` are read verbatim. `version`, `group` and `check` are
 * deliberately ignored: they identify an *instance* of a service, not a project.
 */
function dubboReferences(text) {
  const names = new Set();
  const pattern = /@(?:DubboReference|Reference)\s*\(([\s\S]{0,400}?)\)/gu;
  for (const match of text.matchAll(pattern)) {
    const body = match[1];
    const explicit = body.match(/\b(?:application|serviceName)\s*=\s*["']([A-Za-z0-9][A-Za-z0-9._-]{1,60})["']/u);
    if (explicit !== null) names.add(explicit[1]);
    // Order matters: JS tries alternatives left to right, and `interface` would
    // match the prefix of `interfaceClass` and then fail on `=`. The longest
    // names must come first for the alternation to pick them.
    const iface = body.match(/\b(?:interfaceClass|interfaceName|interface)\s*=\s*([A-Za-z0-9_$.]+)/u);
    if (iface !== null) {
      const name = iface[1].replace(/\.class$/u, '');
      const segments = name.split('.').filter((segment) => segment !== '' && segment !== 'api' && segment !== 'service');
      if (segments.length >= 2) {
        // `com.acme.user.api.UserApi` → segments are [com, acme, user, UserApi];
        // the providing application is the segment *before* the class name.
        const candidate = segments[segments.length - 2];
        names.add(candidate);
        names.add(candidate.replace(/api$/u, ''));
        // The class name itself is a useful alias too (`UserApi` → `user`).
        names.add(segments[segments.length - 1].replace(/(?:Api|Service|Client|Facade)$/u, ''));
      }
    }
  }
  // `dubbo:@DubboReference` in XML config files.
  for (const match of text.matchAll(/<dubbo:reference[^>]*\b(?:interface|id)\s*=\s*["']([A-Za-z0-9._$-]{1,80})["']/gu)) {
    const segments = match[1].split('.').filter((segment) => segment !== '' && segment !== 'api' && segment !== 'service');
    if (segments.length >= 2) names.add(segments[segments.length - 2]);
  }
  return [...names].filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/u.test(name));
}

/**
 * Spring Cloud Alibaba's `@NacosDiscovery`-style call sites are rare, but the
 * Feign-with-name form written in a properties file is not:
 * `feign.client.config.users.url=http://users/`. Handled by
 * `balancedUrlTargets`, so only the explicit `spring.cloud.openfeign.client`
 * aliases are added here.
 */
function nacosDiscoveryNames(text) {
  const names = new Set();
  for (const match of text.matchAll(/[ \t]feign\.client\.config\.([A-Za-z0-9._-]{2,60})\.[A-Za-z]/gu)) {
    if (match[1] === 'default') continue;
    names.add(match[1]);
  }
  return [...names];
}

/**
 * Apollo / Spring Cloud Config / Nacos Config servers a project bootstraps from.
 *
 * A project that reads its configuration remotely cannot start without that
 * server, so it earns a dependency edge in the same way a registry does. Only
 * servers that are themselves part of the scan are wired - a managed Apollo is
 * somebody else's uptime.
 */
function configCenterTargets(text) {
  const found = [];
  const seen = new Set();
  const add = (host, port) => {
    if (host === undefined) return;
    if (!/^(?:localhost|[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[A-Za-z][A-Za-z0-9-]*)$/u.test(host)) return;
    const key = `${host}:${port ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ host, port: port === undefined ? null : Number(port) });
  };
  // A placeholder is resolved by the deployment environment, not by this scan.
  const clean = text.replace(/\$\{[^}]*\}|@[A-Za-z0-9_.-]+@|\{\{[^}]*\}\}/gu, ' ');
  const patterns = [
    // Apollo, YAML shape: `apollo:` newline `meta: http://host:port`. The value
    // lives after the SECOND colon, so this is its own pattern rather than an
    // optional branch of the flat one below - and an `apollo:` block with no
    // `meta` must produce nothing rather than reading `meta` as a host.
    /(?:^|\n)[ \t]*apollo[ \t]*:[ \t\r\n]*(?:[^\r\n]*[\r\n])*?[ \t]+meta(?:\[\d+\])?[ \t]*[:=][ \t\r\n]*["']?(?:https?:\/\/)?([A-Za-z0-9][A-Za-z0-9._-]*)(?::(\d{2,5}))?/gu,
    // Apollo, flat shapes: `apollo.meta=http://host:port`, `app.meta[0]=http://...`
    /(?:^|\n)[ \t]*(?:apollo[._-]?meta|app\.meta(?:\[\d+\])?)[ \t]*[:=][ \t\r\n]*["']?(?:https?:\/\/)?([A-Za-z0-9][A-Za-z0-9._-]*)(?::(\d{2,5}))?/gu,
    // Spring Cloud Config: `spring.cloud.config.uri=http://...` and the legacy
    // `config.server.addr` form. The key is on the left of the `=`, so the
    // pattern must NOT require leading whitespace - a root-level property in a
    // `.properties` file starts at column 0.
    /(?:^|\n)[ \t]*(?:spring\.cloud\.)?config[._-]?(?:uri|server[._-]?addr)[ \t]*[:=][ \t\r\n]*["']?(?:https?:\/\/)?([A-Za-z0-9][A-Za-z0-9._-]*)(?::(\d{2,5}))?/gu,
  ];
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) add(match[1], match[2]);
  }
  return found;
}

function configCenterTargetsIn(...texts) {
  const out = [];
  const seen = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || text === '') continue;
    for (const target of configCenterTargets(text)) {
      const key = `${target.host}:${target.port ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(target);
    }
  }
  return out;
}

/** Service names registered in a discovery server's own properties/YAML. */
function registeredNames(text) {
  const names = new Set();
  for (const match of text.matchAll(/^[ \t]*spring\.application\.name[ \t]*[:=][ \t]*["']?([A-Za-z0-9._-]+)/gmu)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/^[ \t]*application[ \t]*:[ \t]*\r?\n[ \t]+name[ \t]*:[ \t]*["']?([A-Za-z0-9._-]+)/gmu)) {
    names.add(match[1]);
  }
  return [...names];
}

/**
 * Fold every project's `serviceNames` in as an alias, so a call edge written as
 * `@FeignClient("user-service")` finds the project whose directory happens to be
 * called `user` - a very common mismatch (`user` vs `user-service`).
 *
 * The reverse also happens (`spring.application.name: user` in a folder called
 * `user-service`), so the suffix forms are registered both ways.
 */
function aliasTable(candidates) {
  const table = new Map();
  const add = (raw, candidate) => {
    const alias = String(raw).toLowerCase().trim();
    if (alias === '') return;
    // `user-provider` must answer to `user`: a Dubbo/Feign call names the
    // service, while the folder is named after the *role* inside the service.
    // The base alias is registered alongside the full one, never instead of it.
    const base = alias.replace(/[-_.](?:provider|server|app|application|svc|service)$/u, '');
    const forms = [alias, base, `${base}-service`, `service-${base}`, `${base}-svc`];
    for (const form of forms) {
      if (form === '') continue;
      if (!table.has(form)) table.set(form, candidate);
    }
  };
  for (const candidate of candidates) {
    add(candidate.name, candidate);
    add(candidate.id, candidate);
    for (const name of candidate.serviceNames ?? []) add(name, candidate);
  }
  return table;
}

/**
 * Turn discovery hints into `dependsOn` edges for a microservice scan.
 *
 * Two sources of evidence, strongest first:
 *   1. a registration server (Nacos/Eureka/Consul) that lists service names and
 *      the instances behind them - that is a declaration, not an inference;
 *   2. `@FeignClient("x")` and load-balanced `http://x/...` call sites.
 *
 * Everything is best-effort: an unresolvable name is recorded in `unresolved`
 * rather than invented as an edge, because a wrong edge makes the start order
 * worse than no order at all.
 */
function suggestServiceEdges(candidates) {
  const byAlias = aliasTable(candidates);
  for (const candidate of candidates) {
    // Rebuilt from scratch: these edges are an inference, and an inference must
    // not inherit whatever the scan ran before it in this same pass. The result
    // is restored below, so a scan that finds no call sites reports none.
    const carried = candidate.dependsOn ?? [];
    const carriedWhy = candidate.dependsOnWhy ?? null;
    candidate.dependsOn = [];
    candidate.dependsOnWhy = null;
    const edges = new Map();
    const why = [];
    for (const name of candidate.calls ?? []) {
      const target = byAlias.get(String(name).toLowerCase());
      if (target === undefined || target.id === candidate.id) continue;
      if (!edges.has(target.id)) edges.set(target.id, `calls service "${name}"`);
    }
    const merged = [...new Set([...carried, ...edges.keys()])];
    if (merged.length === 0) {
      candidate.dependsOn = [];
      candidate.dependsOnWhy = carriedWhy;
      continue;
    }
    candidate.dependsOn = merged;
    for (const [id, reason] of edges) {
      const target = candidates.find((item) => item.id === id);
      why.push(`${reason} (${target?.name ?? id})`);
    }
    candidate.dependsOnWhy = [carriedWhy, why.join('; ')].filter((part) => part !== null && part !== '').join('; ');
  }
  return candidates;
}

/**
 * A project that describes a microservice stack, as opposed to a plain Spring
 * Boot app that will never be part of a mesh on this machine.
 *
 * The distinction is not cosmetic: a project that talks to a registry or a
 * service by name has its `serviceNames`, `calls`, `registry` and
 * `configCenter` fields populated, and the edge builders iterate exactly those.
 * Without this filter a lone app that happens to mention `eureka` in a comment
 * would take part in alias matching and could receive a nonsense edge.
 *
 * A registry or config server is itself part of a mesh by definition.
 */
function meshShaped(candidate) {
  return isRegistryName(candidate)
    || isConfigCenterName(candidate)
    || (Array.isArray(candidate.calls) && candidate.calls.length > 0)
    || (Array.isArray(candidate.registry) && candidate.registry.length > 0)
    || (Array.isArray(candidate.configCenter) && candidate.configCenter.length > 0);
}

/**
 * A registration server (Nacos/Eureka/Consul) is a dependency of everything that
 * registers with it, but only when it is itself one of the scanned projects -
 * a remote Nacos is somebody else's problem. Matched by host:port against a
 * candidate's declared `readyPort`, or by name against an `infra` candidate.
 *
 * More than one registry can exist in a scan (an Eureka peer ring plus a Nacos
 * for legacy services), so this resolves *per endpoint* rather than picking a
 * single global registry - a project is wired to whichever peers it actually
 * names, and a peer that was not scanned is simply not an edge.
 */
function suggestRegistryEdges(candidates) {
  // By name first: a Nacos server IS the registry whatever its role computed to
  // be (a real Nacos checkout is a Spring Boot app, so it lands on `backend`).
  // Falling back to `infra` keeps a compose-only registry working too.
  const registries = candidates.filter((candidate) => isRegistryName(candidate));
  if (registries.length === 0) return candidates;
  for (const candidate of candidates) {
    if (!meshShaped(candidate)) continue;
    const endpoints = Array.isArray(candidate.registry) ? candidate.registry : [];
    const hits = new Set();
    for (const endpoint of endpoints) {
      const target = matchEndpoint(candidate, endpoint, registries);
      if (target === null || hits.has(target.id)) continue;
      hits.add(target.id);
      candidate.dependsOn = [...new Set([...(candidate.dependsOn ?? []), target.id])];
      candidate.dependsOnWhy = [...(candidate.dependsOnWhy ? [candidate.dependsOnWhy] : []),
        `registers with ${endpoint}`].join('; ');
    }
  }
  return candidates;
}

/** A project that *is* a registration server, by name or by role. */
function isRegistryName(candidate) {
  return /(^|[-_.])(nacos|eureka|consul|zookeeper)([-_.]|$)/iu.test(candidate.name)
    || (candidate.role === 'infra' && /nacos|eureka|consul/iu.test(candidate.name));
}

/** A project that *is* a configuration server, by name or by role. */
function isConfigCenterName(candidate) {
  return /(^|[-_.])(apollo|config[-_]?center|configserver|config-server|config)([-_.]|$)/iu.test(candidate.name)
    || (candidate.role === 'infra' && /apollo|config/iu.test(candidate.name));
}

/** The scanned registry that a declared `host[:port]` endpoint refers to. */
function matchEndpoint(candidate, endpoint, registries) {
  const [host, portText] = endpoint.split(':');
  const port = portText === undefined ? null : Number(portText);
  for (const registry of registries) {
    if (registry.id === candidate.id) continue;
    // The service's own identity, when it happens to look like a registry name,
    // must not become a self-edge through an alias.
    if (registry.serviceNames?.includes(endpoint)) continue;
    if (port !== null && registry.readyPort === port) return registry;
    // No declared port on either side, but the host name is the registry's name:
    // `spring.cloud.nacos.discovery.server-addr: nacos-server` (a compose service
    // name). That is still an unambiguous local reference.
    if (port === null && registry.name.toLowerCase() === host.toLowerCase()) return registry;
    if (/nacos|eureka|consul/iu.test(host) && /nacos|eureka|consul/iu.test(registry.name)) return registry;
  }
  return null;
}

/**
 * A configuration center (Apollo, Spring Cloud Config, Nacos Config) is a
 * dependency of every project that bootstraps from it: without it the project
 * falls back to defaults or refuses to start, depending on
 * `spring.cloud.config.fail-fast`.
 */
function suggestConfigCenterEdges(candidates) {
  const centers = candidates.filter((candidate) => isConfigCenterName(candidate) && candidate.role !== 'frontend');
  if (centers.length === 0) return candidates;
  for (const candidate of candidates) {
    if (!meshShaped(candidate)) continue;
    if (centers.some((center) => center.id === candidate.id)) continue;
    const endpoints = Array.isArray(candidate.configCenter) ? candidate.configCenter : [];
    for (const endpoint of endpoints) {
      const target = matchEndpoint(candidate, endpoint, centers);
      if (target === null) continue;
      candidate.dependsOn = [...new Set([...(candidate.dependsOn ?? []), target.id])];
      candidate.dependsOnWhy = [...(candidate.dependsOnWhy ? [candidate.dependsOnWhy] : []),
        `reads configuration from ${endpoint}`].join('; ');
      break;
    }
  }
  return candidates;
}

/**
 * Split a host list into instances, skipping the scheme.
 *
 * `http://eureka-1:8761/eureka/` must yield `eureka-1:8761`, not `http`
 * followed by whatever number the port happened to be. Rewinding by the length
 * of a consumed scheme is what makes the scan continue *inside* the URL after
 * matching `://` - a lookahead alone would leave the regex engine free to
 * match `http` as the next host.
 */
function instancesIn(list) {
  // A placeholder is decided by the environment at deploy time; the scan cannot
  // know it, and guessing the default would manufacture evidence.
  const text = list.replace(/\$\{[^}]*\}|@[A-Za-z0-9_.-]+@|\{\{[^}]*\}\}/gu, ' ');
  const out = [];
  const seen = new Set();
  const take = (rawHost, rawPort) => {
    const host = rawHost.toLowerCase();
    if (host === 'http' || host === 'https') return;
    if (!/^(?:localhost|[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[a-z][a-z0-9-]*)$/u.test(host)) return;
    const port = rawPort === undefined ? null : Number(rawPort);
    if (port !== null && (port < 1 || port > 65535)) return;
    const key = `${host}:${port ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ host, port });
  };
  // An explicit URL contributes only its authority. What follows the first `/`
  // is a path — Eureka writes `http://host:8761/eureka/`, where `eureka` is a
  // path segment, and the old bare-word scan happily reported it as a peer.
  const url = /https?:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{2,5}))?/gu;
  let index = 0;
  for (const match of text.matchAll(url)) {
    take(match[1], match[2]);
    index = (match.index ?? 0) + match[0].length;
  }
  // Whatever is not inside a URL is read as a bare `host[:port]` entry, split on
  // the usual list separators so `a:8848,b:8848` yields two hosts.
  const rest = text.slice(index).replace(url, ' ');
  for (const entry of rest.split(/[,\s;|]+/u)) {
    const bare = entry.match(/^([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{2,5}))?$/u);
    if (bare === null) continue;
    take(bare[1], bare[2]);
  }
  return out;
}

/**
 * Every `host:port` a registration declaration points at, in the order written.
 *
 * Why a list and not one endpoint: a real registration config is almost never a
 * single address. Eureka's `defaultZone` is a comma-separated list of peers,
 * Nacos' `server-addr` is a comma-separated cluster, and Consul's
 * `bootstrap.servers` is a host list. Taking only the first one is wrong in a way
 * that matters here: the scan may have found *any* of them, and the one written
 * first is usually not the one running locally.
 *
 * Two things are deliberately not resolved:
 *   - placeholders (`${NACOS_HOST:127.0.0.1}`, `@nacos.addr@`, `{{ .Values.x }}`).
 *     Guessing the default would make the port look like evidence when it is a
 *     guess; the project simply gets no registry edge, which is the honest answer.
 *   - hosts that cannot be local (`eureka.example.com`). Only `localhost`, a
 *     dotted-quad address, or a bare word can be a container on this machine.
 */
function registrationTargets(text) {
  const found = [];
  const seen = new Set();
  const add = (host, portText) => {
    if (host === undefined || host === '') return;
    if (!/^(?:localhost|[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[A-Za-z][A-Za-z0-9-]*)$/u.test(host)) return;
    const port = portText === undefined ? null : Number(portText);
    const key = `${host}:${port ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ host, port });
  };
  // A host list: `server-addr: a:8848,b:8848`, `defaultZone: http://a:8761/eureka/,http://b:8761/`.
  const list = /(?:server-addr|defaultZone|default-zone|bootstrap[._-]servers|hosts)[ \t]*[:=][ \t]*["']?([^\r\n"']{1,400})/gu;
  for (const match of text.matchAll(list)) {
    for (const instance of instancesIn(match[1])) add(instance.host, instance.port);
  }
  // A placeholder in the declaration itself means the address is decided by the
  // environment at deploy time, which this scan cannot know. Guessing its
  // default (`${EUREKA_URL:http://eureka:8761}`) would manufacture evidence, so
  // such a declaration is dropped rather than resolved.
  const placeholder = /\$\{[^}]*\}|@[A-Za-z0-9_.-]+@|\{\{[^}]*\}\}/gu;
  const withoutPlaceholders = text.replace(placeholder, ' ');
  // Nacos' kebab form and Eureka's uppercase `DEFAULT_ZONE=` properties form are
  // covered above; these are the remaining shapes worth the extra read.
  const single = [
    /[ \t]nacos[._-]?server[._-]?addr[ \t]*[:=][ \t]*["']?([A-Za-z0-9][A-Za-z0-9._-]*)(?::(\d{2,5}))?/gu,
    /[ \t]eureka[._-]?server[._-]?url[ \t]*[:=][ \t]*["']?(?:https?:\/\/)?([A-Za-z0-9][A-Za-z0-9._-]*)(?::(\d{2,5}))?/gu,
  ];
  for (const pattern of single) {
    for (const match of withoutPlaceholders.matchAll(pattern)) add(match[1], match[2]);
  }
  return found;
}

/**
 * The registration endpoints a project declares, deduplicated across YAML,
 * properties and the build file itself.
 */
function registrationTargetsIn(...texts) {
  const out = [];
  const seen = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || text === '') continue;
    for (const target of registrationTargets(text)) {
      const key = `${target.host}:${target.port ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(target);
    }
  }
  return out;
}

/**
 * `dependsOnHint`-style ordering for infra: a project that only re-exports
 * something already running must start last; a registry must start first.
 * Encoded as an extra edge when the evidence is unambiguous.
 */
function suggestInfraEdges(candidates) {
  const infra = candidates.filter((candidate) => candidate.role === 'infra');
  if (infra.length === 0) return candidates;
  // A compose file that declares services which are also scanned as projects is
  // a statement about the same stack: start the container first.
  for (const candidate of candidates) {
    if (candidate.role === 'infra') continue;
    if (infra.length !== 1) continue;
    const owner = infra[0];
    if (Array.isArray(owner.declaredServices) && owner.declaredServices.some((name) => {
      const alias = String(name).toLowerCase();
      return alias === candidate.name.toLowerCase() || alias === candidate.id;
    })) {
      candidate.dependsOn = [...new Set([...(candidate.dependsOn ?? []), owner.id])];
      candidate.dependsOnWhy = [...(candidate.dependsOnWhy ? [candidate.dependsOnWhy] : []),
        `listed in ${owner.name}`].join('; ');
    }
  }
  return candidates;
}

function suggestDependencies(candidates) {
  const backends = candidates.filter((candidate) => candidate.role === 'backend');
  const frontends = candidates.filter((candidate) => candidate.role === 'frontend');
  if (backends.length === 0 || frontends.length === 0) return candidates;
  const precise = frontends.filter((frontend) => frontend.dependsOnHint !== null
    && backends.some((backend) => backend.readyPort === frontend.dependsOnHint));
  const target = precise.length > 0 ? precise : backends.length === 1 ? frontends : [];
  for (const frontend of target) {
    const backend = backends.length === 1
      ? backends[0]
      : backends.find((candidate) => candidate.readyPort === frontend.dependsOnHint);
    if (backend === undefined || backend.id === frontend.id) continue;
    frontend.dependsOn = [backend.id];
    frontend.dependsOnWhy = frontend.dependsOnHint !== null && backend.readyPort === frontend.dependsOnHint
      ? `its dev-server proxy targets port ${backend.readyPort}, which ${backend.name} serves`
      : 'the only backend in this scan';
  }
  return candidates;
}

/**
 * Scan one directory tree and propose projects.
 *
 * Descent stops at any directory that itself looks like a project, except a
 * container (npm/yarn/pnpm workspaces, a Maven aggregator, a Gradle
 * multi-project root), which is exactly where the real projects live one level
 * down — and which therefore does not consume the depth budget.
 *
 * The walk is bounded twice over: `maxDirs` caps how many directories are read,
 * and directories are keyed by real path so a junction pointing back up the tree
 * cannot loop.
 *
 * @param root - absolute directory to scan.
 * @param options - `maxDepth` (default 2; 0 = the root only), `maxDirs`
 *   (default 600) and `ignore` (extra directory names to skip).
 * @returns `{ root, scanned, candidates, problems }`.
 */
export async function discoverProjects(root, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth >= 0 ? options.maxDepth : 2;
  // A walk that cannot finish is worse than a walk that stops early: bound it and
  // say so. Cycles are handled separately, by real path.
  const maxDirs = Number.isInteger(options.maxDirs) && options.maxDirs > 0 ? options.maxDirs : 600;
  const ignore = new Set([...IGNORED_DIRS, ...(Array.isArray(options.ignore) ? options.ignore : [])]);
  // Cancellation is cooperative: the walk asks between directories and the
  // walkers ask between reads, so a half-finished scan still answers with what
  // it had found rather than leaving a pinned core behind.
  const signal = options.signal ?? null;
  let cancelled = false;
  const candidates = [];
  const problems = [];
  const seen = new Set();
  let scanned = 0;
  let truncated = false;

  const visit = async (cwd, depth) => {
    if (aborted(signal)) {
      cancelled = true;
      return;
    }
    if (scanned >= maxDirs) {
      truncated = true;
      return;
    }
    // Junctions and symlinks can point back up the tree; the real path is what
    // decides whether this directory has been walked before.
    let real = cwd;
    try {
      real = await fs.realpath(cwd);
    } catch {
      real = cwd;
    }
    if (seen.has(real)) return;
    seen.add(real);
    scanned += 1;
    const dirName = path.basename(cwd);
    let found = [];
    for (const [label, detector] of DETECTORS) {
      if (aborted(signal)) {
        cancelled = true;
        break;
      }
      try {
        found = found.concat(await detector(cwd, dirName, signal));
      } catch (error) {
        problems.push(`${cwd}: ${label} detector failed: ${String(error)}`);
      }
    }
    // One directory, one role: a pom.xml wins over a stray package.json kept
    // only for frontend asset tooling.
    const deduped = [];
    for (const candidate of found) {
      if (deduped.some((existing) => existing.role === candidate.role || existing.framework === candidate.framework)) continue;
      deduped.push(candidate);
    }
    candidates.push(...deduped);
    const kind = await workspaceKind(cwd);
    // A container is not a project, so it never consumes the depth budget.
    if (depth >= maxDepth && kind === null) return;
    const descend = deduped.length === 0 || kind !== null;
    if (!descend) return;
    const entries = await listDir(cwd);
    for (const entry of entries) {
      if (aborted(signal)) {
        cancelled = true;
        return;
      }
      if (!entry.isDirectory() || ignore.has(entry.name) || entry.name.startsWith('.')) continue;
      await visit(path.join(cwd, entry.name), depth + 1);
    }
  };

  try {
    await fs.access(root);
  } catch {
    return { root, scanned: 0, candidates: [], problems: [`${root}: directory not found`] };
  }
  await visit(root, 0);
  if (cancelled) {
    problems.push(root + ': scan cancelled; the list below is what had been found so far');
  }
  if (truncated) {
    problems.push(`${root}: stopped after ${maxDirs} directories — scan a narrower root or raise maxDirs`);
  }
  candidates.sort((left, right) => (ROLE_ORDER[left.role] ?? 9) - (ROLE_ORDER[right.role] ?? 9));
  return { root, scanned, candidates: suggestRegistryEdges(suggestConfigCenterEdges(suggestServiceEdges(suggestInfraEdges(suggestDependencies(candidates))))), problems, cancelled };
}

/** Turn a discovered candidate into a config entry, dropping discovery-only keys. */
export function candidateToProject(candidate) {
  return {
    id: candidate.id,
    name: candidate.name,
    cwd: candidate.cwd,
    command: candidate.command,
    role: candidate.role,
    framework: candidate.framework,
    readyPort: candidate.readyPort ?? undefined,
    dependsOn: Array.isArray(candidate.dependsOn) ? [...candidate.dependsOn] : [],
    before: [],
    // A one-shot command (`kubectl apply`) exits successfully on purpose, so the
    // runner must not report it as "failed after 0 s" the way it would for a
    // dev server that died on boot.
    ...(candidate.oneShot === true ? { oneShot: true } : {}),
    source: 'discovered',
  };
}
