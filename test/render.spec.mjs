/**
 * Render checks for the client half.
 *
 * The bundle normally only runs in a browser under the harness's module loader,
 * so a layout mistake — a field that never renders, a title that reads
 * `undefined`, an escape sequence leaking into visible text, a disabled button
 * that looks enabled — is otherwise found by the user. This drives the *real*
 * component factory through a tiny React stand-in, renders each seat, and asserts
 * on the resulting tree.
 *
 * The stand-in has to be faithful in three ways, or the test would pass against
 * a page that never loads:
 *   - hooks persist per component between renders (state set by a promise needs
 *     a second pass to show up), so `settle()` renders until nothing changes;
 *   - function components are rendered recursively, because most of the panel
 *     is composed of small ones (`Field`, `TextInput`, `LogLine`);
 *   - effects run after the tree is built, and `document` exists, because the
 *     polling hooks read `document.hidden`.
 *
 * It is not a substitute for looking at the GUI; it is the part of that look that
 * can be mechanised.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let spec;
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      spec = value;
    },
  },
};

/**
 * Just enough DOM for the polling hooks and the clipboard fallback.
 *
 * `setInterval` is stubbed out rather than left real: every polling hook starts
 * one, and a live timer keeps the process alive after the last check
 * (`--forceExit` is not a thing in plain Node). The test renders synchronously,
 * so the interval never needs to fire.
 */
globalThis.document = {
  hidden: false,
  body: { appendChild() {}, removeChild() {} },
  createElement: () => ({ style: {}, select() {}, value: '' }),
  execCommand: () => true,
  // The panel listens for pointer/keyboard/wheel to decide how often to poll, so a
  // stub without these would make every mount throw instead of testing anything.
  listeners: new Map(),
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  },
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((item) => item !== handler));
  },
};
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
/**
 * Pending one-shot timers, so a check can fire them on demand.
 *
 * Stubbing `setTimeout` away entirely hid a real behaviour: a request deadline
 * never fires, so nothing that depends on one could be observed. The queue lets a
 * check advance time deliberately instead of sleeping.
 */
const pendingTimers = new Map();
/**
 * The card currently on screen: every settle(components.body, …) replaces it, so
 * this is the only tree whose polling loop the user would actually be running.
 * A poll timer left behind by a previous mount is not this card's timer.
 */
let mountedTree = null;
/** Which card armed each timer, so lastTimerDelay can answer for the current one. */
const timerNodes = new Map();
/** Delay of each pending timer, so a check can prove the panel slowed down. */
const timerDelays = new Map();
let nextTimerId = 1;
const __ownerKinds = new Map();
globalThis.__traceArm = (kind) => { globalThis.__armKind = kind; };
globalThis.setTimeout = (fn, delay) => {
  const id = nextTimerId;
  nextTimerId += 1;
  pendingTimers.set(id, fn);
  timerDelays.set(id, Number(delay) || 0);
  timerNodes.set(id, currentOwner);
  if (globalThis.__armLog) globalThis.__armLog.push(currentOwner);
  if (currentOwner !== null && currentOwner !== undefined) {
    const counts = __ownerKinds.get(currentOwner) ?? {};
    const key = globalThis.__armKind ?? "effect";
    counts[key] = (counts[key] ?? 0) + 1;
    __ownerKinds.set(currentOwner, counts);
  }
  return id;
};
globalThis.clearTimeout = (id) => {
  pendingTimers.delete(id);
  timerDelays.delete(id);
  timerNodes.delete(id);
};
/** Run every pending one-shot timer once (the clock "jumps" past every deadline). */
function fireTimers() {
  const queued = [...pendingTimers.values()];
  pendingTimers.clear();
  timerDelays.clear();
  timerNodes.clear();
  for (const fn of queued) fn();
}
/** The delay of the last timer the current card armed; panels poll through setTimeout. */
function lastTimerDelay(tree = mountedTree) {
  if (tree === null) return 0;
  for (let index = nextTimerId - 1; index > 0; index -= 1) {
    if (timerNodes.get(index) === tree && pendingTimers.has(index)) return timerDelays.get(index) ?? 0;
  }
  return 0;
}
process.on('exit', () => {
  globalThis.setInterval = realSetInterval;
});
// `navigator` is a getter-only global in modern Node, so it has to be replaced
// through its descriptor. The clipboard is only touched by the copy button.
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
});

/** One hook store per component identity, so state survives re-renders. */
const hookStore = new Map();
let cursor = null;
let effectQueue = [];
/**
 * The tree whose effects are running right now. Timers armed from an effect (a
 * polling loop) belong to that tree, which is what lets a check ask the current
 * card for its own cadence after earlier mounts left loops of their own running.
 */
let currentOwner = null;

function slotsFor(component) {
  let slots = hookStore.get(component);
  if (slots === undefined) {
    slots = { values: [], index: 0 };
    hookStore.set(component, slots);
  }
  return slots;
}

const React = {
  useState(initial) {
    const slots = cursor;
    const position = slots.index;
    slots.index += 1;
    if (slots.values[position] === undefined) {
      slots.values[position] = typeof initial === 'function' ? initial() : initial;
    }
    return [slots.values[position], (next) => {
      slots.values[position] = typeof next === 'function' ? next(slots.values[position]) : next;
    }];
  },
  useEffect(fn) {
    const marks = (globalThis.document?.listeners?.get("wheel") ?? []).length;
    effectQueue.push({ owner: currentOwner, fn, marks });
  },
  useMemo(factory) {
    return factory();
  },
  useCallback(fn) {
    return fn;
  },
  useRef(value) {
    const slots = cursor;
    const position = slots.index;
    slots.index += 1;
    if (slots.values[position] === undefined) slots.values[position] = { current: value };
    return slots.values[position];
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return typeof getSnapshot === 'function' ? getSnapshot() : undefined;
  },
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  Fragment: 'Fragment',
};

const jsxShim = {
  jsx: (type, props) => ({ type, props: props ?? {} }),
  jsxs: (type, props) => ({ type, props: props ?? {} }),
  Fragment: 'Fragment',
};
const requireShim = (id) => {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime') return jsxShim;
  throw new Error(`unexpected require(${id})`);
};

await import('../lib/client.js');
const plugin = spec.factory(requireShim);
const { components } = plugin.testing;

/**
 * Render one element, expanding function components.
 * @param type - a component function or a host tag.
 * @param props - its props.
 */
function renderNode(type, props) {
  if (globalThis.__traceRender) console.error('[rc]', typeof type === 'function' ? (type.name || 'anon') : String(type), 'cursor', cursor === null ? 'null' : 'slots');
  if (typeof type !== 'function') return { type, props: props ?? {} };
  const previous = cursor;
  const slots = slotsFor(type);
  slots.index = 0;
  cursor = slots;
  let output;
  try {
    output = type(props ?? {});
  } finally {
    cursor = previous;
  }
  return expand(output);
}

/** Recursively expand every function component in a tree. */
function expand(node) {
  if (node === null || node === undefined || node === false || node === true) return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') return renderNode(node.type, node.props);
  const children = node.props?.children;
  return { ...node, props: { ...node.props, children: children === undefined ? children : expand(children) } };
}

/**
 * Render until the tree stops changing.
 *
 * Polling hooks start an async request on mount and call `setState` when it
 * lands; a single pass would always see the empty first frame. Each pass drains
 * the microtask queue, so two passes are normally enough and the bound catches a
 * component that never settles.
 */
async function settle(Component, props, passes = 6) {
  let tree = null;
  let signature = null;
  for (let pass = 0; pass < passes; pass += 1) {
    effectQueue.length = 0;
    tree = renderNode(Component, props);
    // A tree only fires its own effects while it is on screen. Nested hooks
    // (the runner state a card renders through) are rendered fresh every pass
    // with no tree current, so their effects belong to the tree being settled.
    for (const entry of effectQueue) {
      if (entry.owner === null) entry.owner = tree;
    }
    if (globalThis.__traceRender) console.error("[marks]", effectQueue.map((e) => e.marks + ":" + (e.owner === null ? "n" : "o")).join(" "));
    if (globalThis.__traceRender) console.error("[t]", tree === mountedTree ? "same" : "new", "effects", effectQueue.length, "ownerNull", effectQueue.filter((e) => e.owner === null).length, "pending", pendingTimers.size);
    const queue = [...effectQueue];
    for (const { owner, fn } of queue) {
      if (globalThis.__traceRender) console.error("[exec]", queue.length, "own", queue.filter((q) => q.owner === tree).length, "null", queue.filter((q) => q.owner === null).length);
      if (globalThis.__traceRender) console.error("[exec]", queue.length, "own", queue.filter((q) => q.owner === tree).length, "null", queue.filter((q) => q.owner === null).length, "syncOwner", currentOwner === null ? "null" : "other");
      currentOwner = owner;
      if (globalThis.__traceRender) console.error("[set]", owner === tree ? "tree" : owner === null ? "null" : "other");
      try {
        const cleanup = fn();
        void cleanup;
        if (globalThis.__traceRender) console.error("[armed]", [...timerNodes.entries()].filter(([, own]) => own === tree).length, "pending", pendingTimers.size);
      } finally {
        currentOwner = null;
      }
    }
    await drain();
    mountedTree = tree;
    const next = textOf(tree);
    if (next === signature) return tree;
    signature = next;
  }
  return tree;
}

/** Let queued promises and timers-that-matter run. */
async function drain() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/** Depth-first search over a jsx tree. */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  findAll(node.props?.children, predicate, found);
  return found;
}

/** Every visible string in the tree, concatenated. */function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  return textOf(node.props?.children);
}

const buttons = (tree) => findAll(tree, (node) => node.type === 'button');

/** The translation stub: keys stay visible so assertions can name them. */
const t = (key, params) => (params === undefined
  ? key
  : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`);

const seatProps = (extra = {}) => ({ t, sessionId: 'session-1', ...extra });

// ---------------------------------------------------------------- fixtures ---

const BACKEND = {
  id: 'backend', name: '后端', cwd: 'D:\\garden\\garden-api',
  command: 'mvn -Dmaven.test.skip=true spring-boot:run', args: '', env: {},
  role: 'backend', framework: 'spring', readyPort: 8080, readyUrl: undefined,
  readyTimeoutMs: 180000, stopGraceMs: 8000, restartDelayMs: 1000, autoRestart: false,
  dependsOn: [], before: [], source: 'configured',
};

const FRONTEND = {
  id: 'frontend', name: '前端', cwd: 'D:\\garden\\garden-uniapp', command: 'npm run dev:h5',
  args: '-- --host', env: { PROBE: '1' }, role: 'frontend', framework: 'uni-app', readyPort: 5173,
  readyUrl: 'http://127.0.0.1:5173/', readyTimeoutMs: 90000, stopGraceMs: 8000, restartDelayMs: 1000,
  autoRestart: true, dependsOn: ['backend'],
  before: [{ name: 'codegen', command: 'npm run gen:api', expect: 'generated', timeoutMs: 120000, continueOnError: false }],
  source: 'configured',
};

const TABLE = {
  projects: [BACKEND, FRONTEND],
  source: 'store',
  storeFile: 'C:\\Users\\1\\.dsh\\.dev-runner\\projects.json',
  problems: [],
};

const SNAPSHOT = [
  {
    ...BACKEND, state: 'running', detail: 'ready in 3551 ms (::1:8080)', startedAtMs: 1, endedAtMs: null,
    exitCode: null, restarts: 0, steps: [], lastSeq: 3, firstRetainedSeq: 0,
  },
  {
    ...FRONTEND, state: 'failed', detail: 'process exited with code 1', startedAtMs: 1, endedAtMs: 2,
    exitCode: 1, restarts: 2, lastSeq: 1, firstRetainedSeq: 0,
    steps: [{ name: 'codegen', command: 'npm run gen:api', state: 'ok', exitCode: 0, ms: 812, message: '' }],
  },
];

const LOGS = {
  ok: true, id: 'backend', nextSince: 3, lossy: false, state: 'running',
  entries: [
    { seq: 0, ts: 1, stream: 'stdout', text: '\u001b[32mready\u001b[0m in 2807ms' },
    { seq: 1, ts: 2, stream: 'stderr', text: '\u001b[31mwarn\u001b[0m: slow startup' },
    { seq: 2, ts: 3, stream: 'runner', text: 'ready in 3551 ms (::1:5173)' },
  ],
};

/** Install a fetch stub answering the panel's polls; returns the call log. */
function installFetch(overrides = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    const path = String(url).replace('/dev-runner/api', '');
    let body = { ok: true };
    if (path.startsWith('/status')) {
      body = { ok: true, version: 2, source: TABLE.source, storeFile: TABLE.storeFile, problems: [], projects: SNAPSHOT };
    } else if (path.startsWith('/logs.txt')) {
      body = { ok: true };
    } else if (path.startsWith('/logs')) {
      body = LOGS;
    } else if (path === '/projects') {
      body = { ok: true, ...TABLE };
    }
    if (Object.hasOwn(overrides, path)) body = overrides[path];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return calls;
}

/** Fresh hook stores, so each check starts from a clean mount. */
function resetHooks() {
  hookStore.clear();
  effectQueue = [];
}

let checks = 0;
let failures = 0;
async function check(label, body) {
  checks += 1;
  try {
    resetHooks();
    await body();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${label}`);
    console.log(String(error?.stack ?? error).split('\n').slice(0, 8).join('\n'));
  }
}

// ------------------------------------------------------------------ checks ---

await check('the panel renders both projects, their states and their chips', async () => {
  installFetch();
  const tree = await settle(components.body, seatProps({}), 12);
  const text = textOf(tree);
  assert.ok(text.includes('后端'), 'the backend name is rendered');
  assert.ok(text.includes('前端'), 'the frontend name is rendered');
  assert.ok(text.includes('state.running'), 'the running state is rendered');
  assert.ok(text.includes('state.failed'), 'the failed state is rendered');
  // The selected project is the first one; select the dependent project to
  // assert on the chip that only that one carries.
  const row = buttons(tree).find((node) => textOf(node).includes('前端') && textOf(node).includes('state.failed'));
  assert.ok(row !== undefined, 'the frontend row is a button');
  row.props.onClick();
  const selected = await settle(components.body, seatProps({}), 12);
  const selectedText = textOf(selected);
  assert.ok(selectedText.includes('meta.dependsOn(names=backend)'), `the dependency chip is rendered: ${selectedText.slice(0, 260)}`);
  assert.ok(selectedText.includes('meta.restarts(count=2)'), 'the restart count of the failed project is shown');
  assert.ok(selectedText.includes('source.store(file='), 'the table source is named');
});

await check('the detail pane offers start/stop, restart, edit and delete', async () => {
  installFetch();
  const tree = await settle(components.body, seatProps());
  const labels = buttons(tree).map(textOf);
  assert.ok(labels.some((label) => label.includes('action.stop')), `a running project can be stopped: ${labels.join('|')}`);
  assert.ok(labels.some((label) => label.includes('action.restart')), 'restart is offered');
  assert.ok(labels.some((label) => label.includes('action.edit')), 'edit is offered');
  assert.ok(labels.some((label) => label.includes('action.delete')), 'delete is offered');
  assert.ok(labels.some((label) => label.includes('action.startAll')), 'start-all is offered');
  assert.ok(labels.some((label) => label.includes('action.scan')), 'the scan door is offered');
  assert.ok(labels.some((label) => label.includes('action.add')), 'adding a project is offered');
});

await check('ANSI colour becomes styled spans and never leaks an escape sequence', async () => {
  installFetch();
  const tree = await settle(components.body, seatProps());
  const green = findAll(tree, (node) => node.props?.style?.color === '#16a34a');
  assert.ok(green.length > 0, `the green span was produced (${findAll(tree, (node) => node.props?.style?.color !== undefined).length} styled nodes)`);
  assert.ok(green.some((node) => textOf(node) === 'ready'), 'a green span carries the word, not the code');
  assert.equal(textOf(tree).includes('\u001b['), false, 'no raw escape sequence is rendered');
});

await check('stderr lines are tinted and the runner line is shown', async () => {
  installFetch();
  const tree = await settle(components.logView, {
    ...seatProps(), projectId: 'backend', entries: LOGS.entries, lossy: false, onClear: () => {},
  });
  const red = findAll(tree, (node) => node.props?.style?.color === '#dc2626');
  assert.ok(red.length > 0, 'the stderr line is tinted red');
  const text = textOf(tree);
  assert.ok(text.includes('ready in 3551 ms'), 'the runner line is shown');
  assert.ok(text.includes('action.clearLog'), 'the log toolbar rendered');
  assert.ok(text.includes('action.download'), 'the download link rendered');
});

await check('the project editor renders every field', async () => {
  installFetch();
  const draft = plugin.testing.projectToDraft(FRONTEND);
  const tree = await settle(components.form, {
    ...seatProps(), draft, setDraft: () => {}, knownIds: new Set(['backend', 'frontend']),
    onSubmit: () => {}, onCancel: () => {}, busy: '',
  });
  const text = textOf(tree);
  for (const key of ['editor.id', 'editor.name', 'editor.cwd', 'editor.command', 'editor.args', 'editor.env',
    'editor.readyPort', 'editor.readyHost', 'editor.readyUrl', 'editor.readyTimeoutMs', 'editor.stopGraceMs', 'editor.restartDelayMs',
    'editor.dependsOn', 'editor.before', 'editor.autoRestart']) {
    assert.ok(text.includes(key), `the editor is missing ${key}`);
  }
  const controls = findAll(tree, (node) => node.type === 'input' || node.type === 'textarea' || node.type === 'select');
  assert.ok(controls.length >= 12, `expected the full form, got ${controls.length} controls`);
});

await check('leaving the editor with unsaved changes takes two clicks', async () => {
  // Cancel is the only way out of the editor and it means "throw the typing away".
  // One stray click used to discard a half-filled form with no undo; now it asks
  // first, exactly like delete does. A form nobody touched still closes at once.
  installFetch();
  let cancelled = 0;
  const opened = plugin.testing.projectToDraft(FRONTEND);
  const untouched = await settle(components.form, {
    ...seatProps(), draft: opened, setDraft: () => {}, knownIds: new Set(['backend', 'frontend']),
    onSubmit: () => {}, onCancel: () => { cancelled += 1; }, busy: '',
  });
  const plainExit = buttons(untouched).find((node) => textOf(node) === 'action.cancel');
  assert.ok(plainExit !== undefined, 'an untouched form offers cancel');
  await plainExit.props.onClick();
  assert.equal(cancelled, 1, 'an untouched form closes on the first click');

  // Now the same form after one keystroke.
  const typed = { ...opened, name: 'frontend-renamed' };
  const changed = await settle(components.form, {
    ...seatProps(), draft: typed, setDraft: () => {}, knownIds: new Set(['backend', 'frontend']),
    onSubmit: () => {}, onCancel: () => { cancelled += 1; }, busy: '',
  });
  assert.ok(textOf(changed).includes('action.cancel'), 'the first click does not close the form');
  const leave = buttons(changed).find((node) => textOf(node) === 'action.cancel');
  await leave.props.onClick();
  assert.equal(cancelled, 1, 'a changed form does not close on the first click');
  const asking = await settle(components.form, {
    ...seatProps(), draft: typed, setDraft: () => {}, knownIds: new Set(['backend', 'frontend']),
    onSubmit: () => {}, onCancel: () => { cancelled += 1; }, busy: '',
  });
  const warning = textOf(asking);
  assert.ok(warning.includes('editor.leave'), `the second click asks: ${warning.slice(0, 200)}`);
  assert.ok(warning.includes('action.back'), 'and offers a way back into the form');
  const again = buttons(asking).find((node) => textOf(node) === 'action.deleteConfirm');
  assert.ok(again !== undefined, 'the cancel button becomes the confirm button');
  await again.props.onClick();
  assert.equal(cancelled, 2, 'the second click closes');
});

await check('the editor disables save and names every problem', async () => {
  installFetch();
  const draft = { ...plugin.testing.projectToDraft(BACKEND), cwd: '', readyPort: '70000', dependsOn: 'ghost' };
  const tree = await settle(components.form, {
    ...seatProps(), draft, setDraft: () => {}, knownIds: new Set(['backend']),
    onSubmit: () => {}, onCancel: () => {}, busy: '',
  });
  const text = textOf(tree);
  assert.ok(text.includes('editor.invalid.cwd'), 'the missing folder is reported');
  assert.ok(text.includes('editor.invalid.port'), 'the bad port is reported');
  assert.ok(text.includes('editor.invalid.dependsOn'), 'the unknown dependency is reported');
  const save = buttons(tree).find((node) => textOf(node).includes('action.save'));
  assert.ok(save !== undefined, 'the save button exists');
  // Any opacity clearly below 1 satisfies "visibly disabled": pinning the exact
  // number made every palette tweak look like a regression.
  assert.ok(save.props.style.opacity > 0 && save.props.style.opacity <= 0.5, 'save is visibly disabled');
});

await check('the discovery panel renders its controls', async () => {
  installFetch();
  const tree = await settle(components.discover, {
    ...seatProps(), defaultRoot: 'D:\\garden', onClose: () => {}, onApply: () => {}, busy: '',
  });
  const text = textOf(tree);
  assert.ok(text.includes('discover.heading'), 'the heading rendered');
  assert.ok(text.includes('discover.root'), `the folder field rendered: ${text.slice(0, 200)}`);
  assert.ok(text.includes('discover.depth'), 'the depth field rendered');
  assert.ok(text.includes('discover.apply'), 'the apply button rendered');
  assert.ok(text.includes('discover.replace'), 'the merge/replace choice rendered');
});

await check('the header pill shows the counts and offers exactly two actions', async () => {
  installFetch();
  const tree = await settle(components.header, seatProps({ openPanel: () => true }), 12);
  const text = textOf(tree);
  // The stub keeps the key, so the count is asserted through the parameters it
  // was called with rather than through a formatted string.
  assert.ok(text.includes('header.summary(running=1,total=2)'), `the running/total count is shown: ${text}`);
  const found = buttons(tree);
  assert.equal(found.length, 2, 'one button opens the panel, one starts or stops everything');
  assert.ok(textOf(found[0]).includes('header.summary('), 'the door carries the count');
  assert.ok(/header\.(startAll|stopAll)/u.test(textOf(found[1])), 'the action button names its action');
});

await check('the header pill renders nothing when no project is configured', async () => {
  installFetch({
    '/status': { ok: true, version: 2, source: 'config', storeFile: 'x', problems: [], projects: [] },
  });
  const tree = await settle(components.header, seatProps({ openPanel: () => true }));
  assert.equal(tree, null, 'an empty table leaves the session header alone');
});

await check('a scan result renders one checkbox per command, with its evidence', async () => {
  // Drive the panel's own scan button against a stubbed /discover answer, then
  // assert on what the user would see: both commands of the uni-app project
  // listed separately, the port source named, the wiring reason shown.
  const candidates = [
    {
      id: 'garden-api', name: 'garden-api', cwd: 'D:\\garden\\garden-api', role: 'backend', framework: 'spring',
      command: 'mvn -Dmaven.test.skip=true spring-boot:run', readyPort: 8080,
      readyPortSource: 'src/main/resources/application.yml',
      evidence: ['pom.xml', 'spring-boot-maven-plugin', 'port 8080 from src/main/resources/application.yml'],
      commandOptions: [
        { command: 'mvn -Dmaven.test.skip=true spring-boot:run', note: 'standard' },
        { command: 'mvn -q -Dmaven.test.skip=true compile', note: 'compile first' },
      ],
    },
    {
      id: 'garden-uniapp', name: 'garden-uniapp', cwd: 'D:\\garden\\garden-uniapp', role: 'frontend', framework: 'uni-app',
      command: 'npm run dev:h5', readyPort: 5173, readyPortSource: 'uni-app convention',
      evidence: ['package.json + vite.config.mjs', 'framework: uni-app'],
      dependsOn: ['garden-api'], dependsOnWhy: 'the only backend in this scan',
      commandOptions: [
        { script: 'dev:h5', command: 'npm run dev:h5', readyPort: 5173, readyPortSource: 'uni-app convention' },
        { script: 'dev:mp-weixin', command: 'npm run dev:mp-weixin', readyPort: null, readyPortSource: 'none (compile-only target)' },
      ],
    },
  ];
  installFetch({ '/discover': { ok: true, root: 'D:\\garden', scanned: 5, problems: [], candidates } });

  // The panel mounts with no result, so the first pass only has the folder field.
  const empty = await settle(components.discover, {
    ...seatProps(), defaultRoot: 'D:\\garden', onClose: () => {}, onApply: () => {}, busy: '',
  });
  const scan = buttons(empty).find((node) => textOf(node).includes('discover.scan'));
  assert.ok(scan !== undefined, 'the scan button exists before a scan');
  assert.equal(textOf(empty).includes('garden-api'), false, 'no candidate is shown before scanning');

  // Clicking scan sets state on the mounted instance (the hook store persists),
  // so the next pass renders the answer.
  scan.props.onClick();
  await drain();
  const found = await settle(components.discover, {
    ...seatProps(), defaultRoot: 'D:\\garden', onClose: () => {}, onApply: () => {}, busy: '',
  }, 14);
  const text = textOf(found);
  assert.ok(text.includes('garden-api'), `the backend candidate is listed: ${text.slice(0, 200)}`);
  assert.ok(text.includes('garden-uniapp'), 'the frontend candidate is listed');
  assert.ok(text.includes('npm run dev:h5'), 'the primary command is shown');
  assert.ok(text.includes('npm run dev:mp-weixin'), 'the second uni-app command is offered separately');
  assert.ok(text.includes('mvn -q -Dmaven.test.skip=true compile'), 'the compile-first command is offered separately');
  assert.ok(text.includes('marker:') || text.includes('discover.evidence'), 'the evidence is shown');
  assert.ok(text.includes('src/main/resources/application.yml'), 'the port source is named');
  assert.ok(text.includes('discover.dependency(reason=the only backend in this scan)'), 'the wiring reason is shown');

  // Both candidates keep their primary command ticked by default; the second
  // commands are unticked, so Apply writes two projects, not four.
  const plan = plugin.testing.discoveryPlan(candidates, [plugin.testing.optionKey('garden-api', 0), plugin.testing.optionKey('garden-uniapp', 0)]);
  assert.deepEqual(plan.map((project) => project.id), ['garden-api', 'garden-uniapp']);
  assert.deepEqual(plan[1].dependsOn, ['garden-api']);

  // "Select all" then "primary only" is one click each, and the second must undo
  // the first completely: ticking both uni-app commands means two copies of the
  // same app fighting over port 5173.
  const scanAgain = () => settle(components.discover, {
    ...seatProps(), defaultRoot: 'D:\\garden', onClose: () => {}, onApply: () => {}, busy: '',
  }, 14);
  const all = buttons(found).find((node) => textOf(node) === 'action.selectAll');
  assert.ok(all !== undefined, 'select-all exists once a scan answered');
  all.props.onClick();
  await drain();
  const afterAll = await scanAgain();
  const boxesAfterAll = findAll(afterAll, (node) => node.type === 'input' && node.props?.type === 'checkbox');
  // Seven boxes: four per-command ticks plus the "replace the table" switch, which
  // sits with the buttons and is on by default (scanning is how you replace a table).
  // Select-all only touches the command ticks, so the count is per box type rather
  // than "all boxes are ticked".
  assert.equal(boxesAfterAll.length, 7, `expected four command boxes plus the replace switch, got ${boxesAfterAll.length}`);
  const tickedAfterAll = boxesAfterAll.filter((node) => node.props.checked === true).length;
  const replaceIndex = boxesAfterAll.findIndex((node) => node.props.checked === false);
  assert.equal(replaceIndex, 6, 'the replace switch is the seventh box and is off by default');
  assert.equal(tickedAfterAll, 6, 'the four command ticks are all on after select-all');
  const primary = buttons(afterAll).find((node) => textOf(node) === 'action.selectPrimary');
  assert.ok(primary !== undefined, 'primary-only exists once a scan answered');
  primary.props.onClick();
  await drain();
  const afterPrimary = await scanAgain();
  const boxesAfterPrimary = findAll(afterPrimary, (node) => node.type === 'input' && node.props?.type === 'checkbox');
  // Two commands stay ticked; the replace switch is not a command and keeps its value.
  assert.equal(boxesAfterPrimary.filter((node) => node.props.checked === true).length, 2, 'primary-only leaves exactly one command per candidate');
});

await check('the log filter highlights a match and counts them', async () => {
  installFetch();
  const entries = [
    { seq: 0, ts: 1, stream: 'stdout', text: '\u001b[32mready\u001b[0m in 2807ms' },
    { seq: 1, ts: 2, stream: 'stdout', text: 'ready again' },
    { seq: 2, ts: 3, stream: 'stderr', text: 'not ready yet' },
  ];
  const tree = await settle(components.logView, { ...seatProps(), projectId: 'backend', entries, lossy: false, onClear: () => {} });
  const filter = findAll(tree, (node) => node.type === 'input' && node.props?.placeholder === 'log.filter');
  assert.ok(filter.length === 1, 'the filter box rendered');
  filter[0].props.onChange({ target: { value: 'ready' } });
  await drain();
  const filtered = await settle(components.logView, { ...seatProps(), projectId: 'backend', entries, lossy: false, onClear: () => {} }, 14);
  const text = textOf(filtered);
  assert.ok(text.includes('log.matches('), `the match count is shown: ${text.slice(0, 200)}`);
  const marks = findAll(filtered, (node) => String(node.props?.style?.background ?? '').includes('fde68a'));
  assert.equal(marks.length, 3, 'every matching line is marked, once');
  for (const mark of marks) assert.equal(textOf(mark), 'ready', 'the highlighted text is the query, not the whole line');
});

await check('a request that never answers becomes an error, not a frozen panel', async () => {
  // The panel polls /status every few seconds. Before there was a deadline, a
  // request that never settled kept its socket forever: polls piled up behind a
  // hung host and the panel showed stale project states with no explanation.
  // Now an unanswered request takes the ordinary error path.
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    if (String(url).includes('/status')) {
      // Never resolves -- unless the caller aborts, which is the behaviour under test.
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' };
  };
  await settle(components.body, seatProps(), 12);
  // The deadline is a real timer; the harness holds timers so a check can jump
  // the clock past it instead of sleeping fifteen seconds.
  fireTimers();
  await drain();
  const tree = await settle(components.body, seatProps(), 12);
  const text = textOf(tree);
  // The panel wraps the message in error.request; the stub `t` keeps the key visible.
  assert.ok(text.includes('no answer within'), `the timeout is reported: ${text.slice(0, 300)}`);
  assert.ok(calls.some((entry) => String(entry.url).includes('/status')), 'the panel still asked');
});

await check('deleting takes two clicks inside the panel, never a native dialog', async () => {
  // The delete button used to call window.confirm. Inside Electron a native
  // dialog can be suppressed -- and then confirm() returns false without ever
  // asking -- so the button looked dead. The confirmation is part of the panel
  // now: the first click arms it, the second one deletes.
  const project = SNAPSHOT[0];
  const requests = installFetch();
  const props = { ...seatProps(), selected: project.id, onSelect: () => {} };

  // No native dialog may be reached. If the code still calls confirm, this
  // counter proves it.
  let confirmCalls = 0;
  globalThis.window = { confirm: () => { confirmCalls += 1; return true; } };

  const first = await settle(components.body, props, 14);
  const deleteButton = buttons(first).find((node) => textOf(node) === 'action.delete');
  assert.ok(deleteButton !== undefined, 'the delete button rendered');

  deleteButton.props.onClick();
  await drain();
  const armed = await settle(components.body, props, 14);
  assert.equal(confirmCalls, 0, 'no native confirm() was called');
  assert.ok(textOf(armed).includes('action.deleteConfirm'), 'the button asks for confirmation');
  assert.ok(
    textOf(armed).includes(`confirm.delete(name=${project.name})`),
    'the consequence is spelled out next to the project',
  );
  assert.ok(buttons(armed).some((node) => textOf(node) === 'action.cancel'), 'the confirmation can be withdrawn');

  // Withdrawing returns to the plain button without touching the project.
  const cancel = buttons(armed).find((node) => textOf(node) === 'action.cancel');
  cancel.props.onClick();
  await drain();
  const withdrawn = await settle(components.body, props, 14);
  assert.equal(textOf(withdrawn).includes('action.deleteConfirm'), false, 'cancelling disarms the button');
  assert.equal(requests.filter((entry) => entry.method === 'DELETE').length, 0, 'nothing was deleted yet');

  // Arming again and clicking the same button really deletes.
  const again = buttons(withdrawn).find((node) => textOf(node) === 'action.delete');
  again.props.onClick();
  await drain();
  const armedAgain = await settle(components.body, props, 14);
  const confirmButton = buttons(armedAgain).find((node) => textOf(node) === 'action.deleteConfirm');
  confirmButton.props.onClick();
  await drain();
  await settle(components.body, props, 14);
  const deletes = requests.filter((entry) => entry.method === 'DELETE');
  assert.equal(deletes.length, 1, 'the second click issues exactly one DELETE');
  assert.ok(deletes[0].url.includes(encodeURIComponent(project.id)), 'the DELETE names the project');
  delete globalThis.window;
});

await check('switching projects clears the filter, the follow switch and the cursor', async () => {
  // The panel keeps one log view alive while the selected project changes, so
  // every piece of view state -- the filter text, the follow switch, the jump
  // cursor -- carries over. A filter that matched nothing in the previous
  // project would keep the next one looking empty, which reads as "this project
  // logged nothing".
  const entries = [
    { seq: 0, ts: 1, stream: 'stdout', text: 'alpha ready' },
    { seq: 1, ts: 2, stream: 'stdout', text: 'beta ready' },
  ];
  const props = (projectId) => ({ ...seatProps(), projectId, entries, lossy: false, onClear: () => {} });
  const first = await settle(components.logView, props('alpha'));
  const filter = findAll(first, (node) => node.type === 'input' && node.props?.placeholder === 'log.filter');
  filter[0].props.onChange({ target: { value: 'ready' } });
  const toggle = findAll(first, (node) => node.type === 'input' && node.props?.type === 'checkbox');
  assert.ok(toggle.length === 1, 'the follow switch rendered');
  toggle[0].props.onChange({ target: { checked: false } });
  await drain();

  const filtered = await settle(components.logView, props('alpha'), 14);
  assert.ok(textOf(filtered).includes('log.matches('), 'the filter is active before switching');

  // Same component instance, different project: the view must start clean.
  const switched = await settle(components.logView, props('beta'), 14);
  const text = textOf(switched);
  assert.equal(text.includes('log.matches('), false, 'the filter did not follow the switch');
  const box = findAll(switched, (node) => node.type === 'input' && node.props?.placeholder === 'log.filter');
  assert.equal(box[0].props.value, '', 'the filter box is empty for the new project');
  const box2 = findAll(switched, (node) => node.type === 'input' && node.props?.type === 'checkbox');
  assert.equal(box2[0].props.checked, true, 'follow is back on, so the new project scrolls');
});

await check('a project still waiting for its port says so, instead of just "running"', async () => {
  // The host writes `waiting for port 8080 on 127.0.0.1, ::1` into detail while a
  // probe runs, which can be the whole readiness window. The row must surface it,
  // or a slow start is indistinguishable from a stuck one.
  installFetch({
    '/status': {
      ok: true, version: 2, source: 'store', storeFile: 'x', problems: [],
      projects: [{ ...SNAPSHOT[0], state: 'running', detail: 'waiting for port 8080 on 127.0.0.1, ::1' }],
    },
  });
  const tree = await settle(components.body, seatProps(), 12);
  const text = textOf(tree);
  assert.ok(text.includes('meta.waiting(target=port 8080'), `the row names what it waits for: ${text.slice(0, 240)}`);
  assert.ok(text.includes('state.running'), 'and still reports the state');

  // The counterpart: once the probe answers, the waiting text is gone.
  installFetch();
  const settled = await settle(components.body, seatProps(), 12);
  assert.equal(textOf(settled).includes('meta.waiting('), false, 'a settled project does not claim to be waiting');
});

await check('one project starting does not grey out the other rows', async () => {
  // Start/stop answers only after the readiness probe, so `busy` stays set for
  // seconds. Dimming controls that have nothing to do with the request in flight
  // made the whole panel look frozen; only the acted-on row may dim.
  const bothUp = SNAPSHOT.map((item) => ({ ...item, state: 'running', detail: 'ready in 12 ms' }));
  installFetch({ '/status': { ok: true, version: 2, source: 'store', storeFile: 'x', problems: [], projects: bothUp } });
  const tree = await settle(components.body, seatProps(), 12);
  const stop = buttons(tree).find((node) => textOf(node) === 'action.stop');
  assert.ok(stop !== undefined, 'the selected project offers stop');
  await stop.props.onClick();
  const after = await settle(components.body, seatProps(), 12);
  // "Start all" and "Stop all" act on the whole table, so they legitimately dim
  // while any request is outstanding. A single row's action must not reach them.
  const others = buttons(after).filter((node) => textOf(node) !== 'action.startAll' && textOf(node) !== 'action.stopAll');
  const dimmed = others.filter((node) => node.props.style?.opacity === 0.5);
  assert.equal(dimmed.length <= 1, true, `only the acted-on row dims, saw ${dimmed.length} dimmed of ${others.length}`);
});

await check('an untouched panel slows its polling instead of retrying every second', async () => {
  // The panel is meant to be left open. Two pollers each rebuilding the status
  // every second forever is a fixed cost on a machine that is busy running dev
  // servers, so the cadence follows attention: 1 s while in use, 4 s once quiet.
  // The numbers come from lib/client.js itself so this check tracks the decision.
  // This check pairs a static reading of the constants with a static reading of
  // the decision that uses them. The cadence itself is observable in the browser
  // (leave the panel alone, `/dev-runner/api/status` drops to one call per quiet
  // window); re-deriving the scheduler here would only re-test the stub.
  const text = readFileSync('C:\\Users\\1\\.dsh\\plugins\\dsh-dev-runner\\lib\\client.js', 'utf8');
  const value = (name) => Number((text.match(new RegExp(`const ${name} = ([0-9_]+);`, 'u')) ?? [])[1]?.replaceAll('_', ''));
  const fast = value('POLL_MS');
  const slow = value('POLL_QUIET_MS');
  const attention = value('POLL_ATTENTION_MS');
  assert.equal(Number.isInteger(fast) && fast > 0, true, `POLL_MS is a number (${fast})`);
  assert.equal(slow > fast, true, `quiet polling is slower than busy polling (${slow} > ${fast})`);
  // The attention window is long enough that "quiet" is the steady state, not an
  // accident of one missed keystroke.
  assert.equal(attention >= slow * 10, true, `quiet mode lasts: ${attention} ms vs ${slow} ms per poll`);

  // The schedule has to compare the idle time against the attention window and
  // pick the slow cadence when it has passed; a flipped comparison would poll
  // fast forever while nobody is watching, which is the cost this feature exists
  // to remove.
  assert.equal(/const quietFor = Date\.now\(\) - lastTouchAt\.current\.value;/u.test(text), true,
    'each poll measures how long the panel has been idle');
  assert.equal(/quietFor > POLL_ATTENTION_MS \? POLL_QUIET_MS : POLL_MS/u.test(text), true,
    'an idle panel picks the quiet cadence and a busy one the fast cadence');
  // Every interaction path refreshes the stamp, otherwise a click would not put
  // the panel back on the fast cadence.
  for (const event of ['pointerdown', 'keydown', 'wheel']) {
    assert.equal(text.includes(`document.addEventListener('${event}', touch, true)`), true,
      `${event} counts as attention`);
  }
  assert.equal(/const touch = \(\) => \{ lastTouchAt\.current\.value = Date\.now\(\); \};/u.test(text), true,
    'a touch moves the hands of the idle clock');
});

await check('opening the editor replaces the panel instead of drawing on top of it', async () => {
  // The first version floated the editor over the panel with `absolute: inset 0`,
  // which assumed the pane was its containing block. In the real sidebar the pane
  // scrolls its own content, so the editor's header and footer landed on the
  // project list underneath. The editor now replaces the body: exactly one of
  // "project list" and "editor fields" may be on screen at a time.
  installFetch();
  const closed = await settle(components.body, seatProps(), 12);
  const closedText = textOf(closed);
  assert.ok(closedText.includes('action.add'), 'the toolbar is there');
  assert.equal(closedText.includes('editor.cwd'), false, 'no editor is drawn before one is opened');

  // Pressing "Add project" is what mounts it.
  const add = buttons(closed).find((node) => textOf(node).includes('action.add'));
  assert.ok(add !== undefined, 'the add button exists');
  add.props.onClick();
  const opened = await settle(components.body, seatProps(), 14);
  const openedText = textOf(opened);
  assert.ok(openedText.includes('editor.cwd'), `the editor is on screen: ${openedText.slice(0, 200)}`);
  assert.equal(openedText.includes('action.startAll'), false,
    'and the panel behind it is gone, not merely covered');
});

await check('a running project whose command was edited says the edit is pending', async () => {
  // Editing the table does not restart a running project, so the row would show the
  // new command as if it were in force. The host reports what it actually spawned
  // (runningCommand); when that differs from the table, the row must say so.
  installFetch({
    '/status': {
      ok: true, version: 2, source: 'store', storeFile: 'x', problems: [],
      projects: [{
        ...SNAPSHOT[0], state: 'running', detail: 'ready in 1200 ms (::1:8099)',
        command: 'npm run dev', args: '', runningCommand: 'npm run dev -- --host',
      }],
    },
  });
  const tree = await settle(components.body, seatProps(), 12);
  const text = textOf(tree);
  assert.ok(text.includes('meta.pendingEdit'), 'the row warns the edit is pending: ' + text.slice(0, 200));
});

await check('a project running exactly what is configured shows no such warning', () => {
  // The control: without it, a check that always fires would look like evidence.
  const helpers = plugin.testing;
  assert.equal(helpers.editPending({ command: 'npm run dev', args: '', runningCommand: 'npm run dev' }), false,
    'identical commands are not pending');
  assert.equal(helpers.editPending({ command: 'npm run dev', args: '', runningCommand: 'npm run dev -- --host' }), true,
    'a different running command is');
  assert.equal(helpers.editPending({ command: 'x', args: '', runningCommand: '' }), false,
    'no process means nothing is pending');
});
await check('the guide card and the tab chip render their copy', async () => {
  installFetch();
  const tab = { title: '开发服务', actions: { openTab: () => {}, close: () => {} } };
  const guide = await settle(components.guide, {
    ...seatProps(), title: '开发服务', description: '发现项目、一键启停并跟随日志', kind: 'dev-runner',
    useTabInfo: () => ({ tab }),
  });
  const guideText = textOf(guide);
  assert.ok(guideText.includes('开发服务'), 'the guide names the page');
  assert.ok(guideText.includes('发现项目'), 'the guide describes it');
  const chip = await settle(components.title, { ...seatProps(), useTabInfo: () => ({ tab }) });
  assert.ok(textOf(chip).includes('开发服务'), 'the tab chip shows the title');
});

if (failures > 0) {
  console.log(`\n${checks - failures}/${checks} render checks passed`);
  process.exitCode = 1;
} else {
  console.log(`\n${checks}/${checks} render checks passed`);
}
