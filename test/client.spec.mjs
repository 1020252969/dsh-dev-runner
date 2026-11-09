/**
 * Client-half smoke tests.
 *
 * The browser bundle cannot be rendered here, so this covers what a page load
 * would otherwise be the first to discover: the module registers its four seats
 * with the host, both locale dictionaries carry the same keys, and the two pure
 * helpers the panel leans on (ANSI parsing and draft conversion) behave.
 *
 * The module is imported with a stub `window.__ModuleLoader__` and stub React,
 * which is exactly how the harness loads it — `factory(require)` is called by
 * the loader, not by this file.
 */

import assert from 'node:assert/strict';

let spec;
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      spec = value;
    },
  },
};

const ReactShim = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn(),
};
const jsxShim = {
  jsx: (type, props) => ({ type, props: props ?? {} }),
  jsxs: (type, props) => ({ type, props: props ?? {} }),
  Fragment: 'Fragment',
};
const requireShim = (id) => {
  if (id === 'react') return ReactShim;
  if (id === 'react/jsx-runtime') return jsxShim;
  throw new Error(`unexpected require(${id})`);
};

await import('../lib/client.js');

let failures = 0;
let total = 0;
function test(label, body) {
  total += 1;
  try {
    body();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${label}`);
    console.log(String(error?.stack ?? error).split('\n').slice(0, 6).join('\n'));
  }
}

/** A minimal stand-in for the client context, recording what got registered. */
function makeCtx() {
  const seats = [];
  const tabs = [];
  const locales = {};
  const opened = [];
  const ctx = {
    effect(fn) {
      return fn();
    },
    // The host serves `sidebarRight`; a client that only ever probes for it must
    // work when it is missing, which is why the stub can be switched off.
    get(name) {
      if (name !== 'sidebarRight') return undefined;
      return {
        openTab(kind) {
          opened.push(kind);
        },
      };
    },
    locale: {
      register(namespace, dictionaries) {
        locales[namespace] = dictionaries;
        return () => {};
      },
      bind(namespace) {
        const dictionaries = locales[namespace] ?? {};
        return (key, params) => {
          const template = (dictionaries.zh ?? {})[key] ?? key;
          if (params === undefined) return template;
          return template.replace(/\{(\w+)\}/gu, (_, name) => String(params[name]));
        };
      },
    },
    sidebarRightTabs: {
      register(value) {
        tabs.push(value);
        return () => {};
      },
    },
    slots: {
      inject(_slotName, callback) {
        callback();
        return () => {};
      },
      register(options, Component) {
        seats.push({ options, Component });
        return () => {};
      },
    },
  };
  return { ctx, seats, tabs, locales, opened };
}

test('the module declares one plugin named dsh-dev-runner', () => {
  assert.equal(spec.id, 'dsh-dev-runner');
  assert.equal(typeof spec.factory, 'function');
});

const plugin = spec.factory(requireShim);

test('the client half keeps the services both host lines serve', () => {
  assert.equal(plugin.name, 'dsh-dev-runner-client');
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']);
});

test('apply() registers the page type and all four seats', () => {
  const { ctx, seats, tabs } = makeCtx();
  plugin.apply(ctx);

  assert.equal(tabs.length, 1, 'expected exactly one page type');
  assert.equal(tabs[0].kind, 'dev-runner');
  assert.equal(tabs[0].id, 'dsh-dev-runner');
  assert.equal(tabs[0].multiple, false);
  assert.equal(tabs[0].guide[0].order, 21);

  const names = seats.map((seat) => seat.options.name);
  assert.deepEqual(names, [
    'sidebar.right.tab.guide.entry',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'conversation.session.header.utilities',
  ]);
  for (const seat of seats) {
    assert.equal(seat.options.locale, 'devRunner');
    assert.equal(typeof seat.Component, 'function');
    assert.equal(typeof seat.options.inject, 'function');
    assert.ok(seat.options.inject('session-1').sessionId === 'session-1');
  }
  const header = seats[3];
  assert.equal(header.options.order, 30, 'header control should sit after the host controls');
  assert.equal(header.options.id, 'dsh-dev-runner');
});

test('the header pill opens the panel through the host sidebar service', () => {
  const { ctx, seats, opened } = makeCtx();
  plugin.apply(ctx);
  const open = seats[3].options.inject('session-1').openPanel;
  assert.equal(typeof open, 'function', 'the header seat must receive a way to open the panel');
  assert.equal(open(), true);
  assert.deepEqual(opened, ['dev-runner']);

  // A host line without the service must leave the pill informational rather
  // than throwing inside a header click handler.
  const bare = makeCtx();
  bare.ctx.get = () => undefined;
  plugin.apply(bare.ctx);
  const bareOpen = bare.seats[3].options.inject('session-1').openPanel;
  assert.equal(bareOpen(), false, 'no service means no door, not a crash');
  assert.deepEqual(bare.opened, []);
});

test('a seat that throws does not stop the others from registering', () => {
  const { ctx, seats } = makeCtx();
  const original = ctx.sidebarRightTabs.register;
  ctx.sidebarRightTabs.register = () => {
    throw new Error('this host line serves no tab registry');
  };
  // The failure is the point of this test, so keep its warning out of the suite
  // output: a red line here would hide a real one.
  const originalError = console.error;
  console.error = () => {};
  try {
    plugin.apply(ctx);
  } finally {
    console.error = originalError;
    ctx.sidebarRightTabs.register = original;
  }
  assert.equal(seats.length, 4, 'the four seats must survive a failing tab registry');
});

test('both locale dictionaries define the same keys', () => {
  const { ctx, locales } = makeCtx();
  plugin.apply(ctx);
  const dictionaries = locales.devRunner;
  assert.ok(dictionaries !== undefined, 'locale namespace devRunner must be registered');
  const zh = Object.keys(dictionaries.zh).sort();
  const en = Object.keys(dictionaries.en).sort();
  const missingInEn = zh.filter((key) => !en.includes(key));
  const missingInZh = en.filter((key) => !zh.includes(key));
  assert.deepEqual(missingInEn, [], `English is missing: ${missingInEn.join(', ')}`);
  assert.deepEqual(missingInZh, [], `Chinese is missing: ${missingInZh.join(', ')}`);
});

const { ansiSpans, stripAnsi, projectToDraft, draftToProject, draftProblems, discoveryPlan, optionKey } = plugin.testing;
const t = (key, params) => {
  if (params === undefined) return key;
  return `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`;
};

test('SGR colours become spans instead of text', () => {
  const spans = ansiSpans('\u001b[32mready\u001b[0m on \u001b[1;31mport 8080\u001b[0m');
  const text = spans.map((span) => span.text).join('');
  assert.equal(text, 'ready on port 8080');
  assert.equal(spans[0].style.color, '#16a34a');
  const bold = spans.find((span) => span.text === 'port 8080');
  assert.equal(bold.style.color, '#dc2626');
  assert.equal(bold.style.fontWeight, 600);
});

test('256-colour and truecolor sequences are understood', () => {
  const indexed = ansiSpans('\u001b[38;5;196mx\u001b[0m');
  assert.equal(indexed[0].style.color, 'rgb(255, 0, 0)');
  const truecolor = ansiSpans('\u001b[38;2;1;2;3my\u001b[0m');
  assert.equal(truecolor[0].style.color, 'rgb(1, 2, 3)');
  const grey = ansiSpans('\u001b[38;5;240mz\u001b[0m');
  assert.equal(grey[0].style.color, 'rgb(88, 88, 88)');
});

test('an unknown code never eats the text after it', () => {
  const spans = ansiSpans('before \u001b[99m after');
  assert.equal(spans.map((span) => span.text).join(''), 'before  after');
});

test('stripAnsi leaves copyable plain text and drops cursor moves', () => {
  assert.equal(stripAnsi('\u001b[2K\u001b[1Gline\u001b[0m'), 'line');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('a project survives a round trip through the editor draft', () => {
  const project = {
    id: 'api',
    name: 'api',
    cwd: 'D:\\srv\\api',
    command: 'mvn spring-boot:run',
    args: '-q',
    role: 'backend',
    framework: 'spring',
    readyPort: 8080,
    readyUrl: '',
    readyTimeoutMs: 120000,
    stopGraceMs: 8000,
    autoRestart: true,
    restartDelayMs: 1000,
    dependsOn: ['db'],
    env: { SPRING_PROFILES_ACTIVE: 'dev' },
    before: [{ name: 'compile', command: 'mvn -q compile', expect: '' }],
  };
  const back = draftToProject(projectToDraft(project));
  assert.equal(back.id, 'api');
  assert.equal(back.cwd, 'D:\\srv\\api');
  assert.equal(back.args, '-q');
  assert.equal(back.readyPort, 8080);
  assert.equal(back.autoRestart, true);
  assert.deepEqual(back.dependsOn, ['db']);
  assert.deepEqual(back.env, { SPRING_PROFILES_ACTIVE: 'dev' });
  assert.deepEqual(back.before, [{ name: 'compile', command: 'mvn -q compile', expect: '', continueOnError: false }]);
  assert.equal(back.readyHost, '', 'an unset readyHost stays empty rather than becoming undefined');
});

test('the editor can round-trip a step that is allowed to fail', () => {
  // `continueOnError` was supported by the host but unreachable from the panel:
  // the draft format had no column for it. It now rides in the fourth cell as the
  // word `continue`, which is also accepted when the expect text is empty.
  const project = {
    id: 'api', name: 'api', cwd: '/srv/api', command: 'run', args: '', role: 'service', framework: '',
    readyPort: 8080, readyUrl: '', readyTimeoutMs: 120000, stopGraceMs: 8000, autoRestart: false,
    restartDelayMs: 1000, dependsOn: [], env: {},
    before: [
      { name: 'compile', command: 'mvn -q compile', expect: 'BUILD SUCCESS', continueOnError: false },
      { name: 'migrate', command: 'flyway migrate', expect: '', continueOnError: true },
    ],
  };
  const draft = projectToDraft(project);
  assert.equal(draft.beforeText.split('\n')[0], 'compile | mvn -q compile | BUILD SUCCESS');
  assert.equal(draft.beforeText.split('\n')[1], 'migrate | flyway migrate |  | continue');
  const back = draftToProject(draft);
  assert.deepEqual(back.before, project.before);
});

test('the editor exposes the probe host, and an empty one means auto', () => {
  // `readyHost` was in the config schema and the README but had no field in the
  // panel, so a Vite server that binds only ::1 could not be expressed by hand.
  const draft = projectToDraft({ id: 'api', cwd: '/srv/api', command: 'run', readyPort: 5173, readyHost: '::1' });
  assert.equal(draft.readyHost, '::1');
  assert.equal(draftToProject(draft).readyHost, '::1');
  const auto = draftToProject(projectToDraft({ id: 'api', cwd: '/srv/api', command: 'run', readyPort: 5173 }));
  assert.equal(auto.readyHost, '');
});
test('a blank optional number stays absent rather than becoming zero', () => {
  const back = draftToProject(projectToDraft({ id: 'x', cwd: '/x', command: 'y' }));
  assert.equal('readyPort' in back, false);
  assert.equal('readyTimeoutMs' in back, false);
  assert.equal(back.name, 'x', 'an empty name falls back to the id');
});

test('the editor refuses a draft the store would reject', () => {
  const problems = draftProblems(projectToDraft({ id: 'x', command: '' }), new Set(), t);
  assert.ok(problems.some((problem) => problem.startsWith('editor.invalid.cwd')), problems.join(' '));
  assert.ok(problems.some((problem) => problem.startsWith('editor.invalid.command')), problems.join(' '));
});

test('the editor catches a bad port, a bad url and an unknown dependency', () => {
  const draft = projectToDraft({
    id: 'x',
    cwd: '/x',
    command: 'y',
    readyPort: 70000,
    readyUrl: 'localhost:8080',
    dependsOn: ['ghost'],
  });
  const problems = draftProblems(draft, new Set(['api']), t);
  assert.ok(problems.some((problem) => problem.startsWith('editor.invalid.port')), problems.join(' '));
  assert.ok(problems.some((problem) => problem.startsWith('editor.invalid.url')), problems.join(' '));
  assert.ok(problems.some((problem) => problem.startsWith('editor.invalid.dependsOn')), problems.join(' '));
  draft.readyPort = '8080';
  draft.readyUrl = 'http://127.0.0.1:8080/health';
  draft.dependsOn = 'api';
  assert.deepEqual(draftProblems(draft, new Set(['api']), t), []);
});

test('malformed env and pre-launch lines are reported with their line number', () => {
  const draft = projectToDraft({ id: 'x', cwd: '/x', command: 'y' });
  draft.envText = 'GOOD=1\nNOT_AN_ASSIGNMENT';
  draft.beforeText = 'compile | mvn -q compile\njustaname';
  const problems = draftProblems(draft, new Set(), t);
  assert.ok(problems.some((problem) => problem.startsWith('editor.invalid.env(line=2)')), problems.join(' '));
  assert.ok(problems.some((problem) => problem.startsWith('editor.invalid.before(line=2)')), problems.join(' '));
});

/** The shape `POST /discover` answers with, trimmed to what planning reads. */
function scanFixture() {
  return [
    {
      id: 'garden-api',
      name: 'garden-api',
      cwd: 'D:\\garden\\garden-api',
      role: 'backend',
      framework: 'spring',
      command: 'mvn -Dmaven.test.skip=true spring-boot:run',
      readyPort: 8080,
      commandOptions: [
        { command: 'mvn -Dmaven.test.skip=true spring-boot:run', note: 'standard' },
        { command: 'mvn -q -Dmaven.test.skip=true compile', note: 'compile first' },
      ],
    },
    {
      id: 'garden-uniapp',
      name: 'garden-uniapp',
      cwd: 'D:\\garden\\garden-uniapp',
      role: 'frontend',
      framework: 'uni-app',
      command: 'npm run dev:h5',
      readyPort: 5173,
      dependsOn: ['garden-api'],
      commandOptions: [
        { script: 'dev:h5', command: 'npm run dev:h5', readyPort: 5173 },
        { script: 'dev:mp-weixin', command: 'npm run dev:mp-weixin', readyPort: null },
      ],
    },
  ];
}

test('one command per candidate keeps the discovered ids', () => {
  const plan = discoveryPlan(scanFixture(), [optionKey('garden-api', 0), optionKey('garden-uniapp', 0)]);
  assert.deepEqual(plan.map((project) => project.id), ['garden-api', 'garden-uniapp']);
  assert.equal(plan[0].command, 'mvn -Dmaven.test.skip=true spring-boot:run');
  assert.equal(plan[1].command, 'npm run dev:h5');
  assert.deepEqual(plan[1].dependsOn, ['garden-api']);
  assert.equal(plan[0].source, 'discovered');
});

test('two commands of one project become two projects with unique ids', () => {
  const plan = discoveryPlan(scanFixture(), [
    optionKey('garden-uniapp', 0),
    optionKey('garden-uniapp', 1),
  ]);
  assert.deepEqual(plan.map((project) => project.id), ['garden-uniapp-dev-h5', 'garden-uniapp-dev-mp-weixin']);
  assert.deepEqual(plan.map((project) => project.command), ['npm run dev:h5', 'npm run dev:mp-weixin']);
  assert.deepEqual(plan.map((project) => project.name), ['garden-uniapp · dev:h5', 'garden-uniapp · dev:mp-weixin']);
  assert.equal(plan[1].readyPort, null, 'a compile-only target keeps its null port');
});

test('splitting a project rewires whoever depended on it', () => {
  const plan = discoveryPlan(scanFixture(), [
    optionKey('garden-api', 0),
    optionKey('garden-api', 1),
    optionKey('garden-uniapp', 0),
  ]);
  const frontend = plan.find((project) => project.id === 'garden-uniapp');
  assert.deepEqual(frontend.dependsOn, ['garden-api-standard', 'garden-api-compile-first']);
  assert.deepEqual(plan[0].dependsOn, [], 'nothing depends on itself');
});

test('an unpicked candidate produces nothing, and a dependency may be unpicked', () => {
  assert.deepEqual(discoveryPlan(scanFixture(), []), []);
  const orphan = discoveryPlan(scanFixture(), [optionKey('garden-uniapp', 0)]);
  assert.deepEqual(orphan.map((project) => project.id), ['garden-uniapp']);
  assert.deepEqual(orphan[0].dependsOn, ['garden-api'],
    'the declared dependency survives even though that candidate was not picked');
});

if (failures > 0) {
  console.log(`\n${total - failures}/${total} client tests passed`);
  process.exitCode = 1;
} else {
  console.log(`\n${total}/${total} client tests passed`);
}
