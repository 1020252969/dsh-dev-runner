/**
 * Keep the documentation honest about the test suite.
 *
 * The README tables and RELEASE.md quote a per-suite count and a total. Those
 * numbers rot the moment a test is added, and a stale number in a release
 * document is worse than no number: it tells a reader something false about
 * coverage. So the counts are read from the suites themselves and compared with
 * what the documents claim.
 *
 * Run: node test/check-docs.mjs   (also part of `npm test`)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

/** The suites, in the order the documents list them. */
const SUITES = [
  ['discover', 'discover.spec.mjs'],
  ['store', 'store.spec.mjs'],
  ['config', 'config.spec.mjs'],
  ['host', 'host.spec.mjs'],
  ['client', 'client.spec.mjs'],
  ['render', 'render.spec.mjs'],
];

/**
 * Count the checks a suite declares.
 *
 * Suites use two shapes: `await test('name', …)` / `test('name', …)` for
 * callback-based ones, and `await check('name', …)` for the render harness.
 * Counting the declarations is deliberately simpler than running them here —
 * `npm test` already runs them, and this checker must be cheap and side-effect
 * free.
 */
async function countSuite(file) {
  const text = await fs.readFile(path.join(here, file), 'utf8');
  const tests = (text.match(/^\s*(await\s+)?test\(/gmu) ?? []).length;
  const checks = (text.match(/^\s*(await\s+)?check\(/gmu) ?? []).length;
  return tests + checks;
}

const problems = [];
const counts = {};
for (const [name, file] of SUITES) {
  counts[name] = await countSuite(file);
  if (counts[name] === 0) problems.push(`${file}: declares no test()/check() at all`);
}
const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

/**
 * Assert one document claims the same numbers the suites do.
 * @param file - document to read.
 * @param patterns - per-suite regular expressions with the count as group 1.
 */
async function checkDocument(file, patterns) {
  let text;
  try {
    text = await fs.readFile(path.join(root, file), 'utf8');
  } catch {
    problems.push(`${file}: cannot be read`);
    return;
  }
  for (const [suite, pattern] of Object.entries(patterns)) {
    const match = text.match(pattern);
    if (match === null) {
      problems.push(`${file}: no row for ${suite}`);
      continue;
    }
    // `total` is a pseudo-suite: the sum, not a file of its own.
    const expected = suite === 'total' ? total : counts[suite];
    if (expected === undefined) {
      problems.push(`${file}: the checker does not know a suite called "${suite}"`);
      continue;
    }
    if (Number(match[1]) !== expected) {
      problems.push(`${file}: ${suite} is documented as ${match[1]}, but the suites declare ${expected}`);
    }
  }
}

await checkDocument('README.md', {
  discover: /\| `test\/discover\.spec\.mjs` \| (\d+) \|/u,
  store: /\| `test\/store\.spec\.mjs` \| (\d+) \|/u,
  config: /\| `test\/config\.spec\.mjs` \| (\d+) \|/u,
  host: /\| `test\/host\.spec\.mjs` \| (\d+) \|/u,
  client: /\| `test\/client\.spec\.mjs` \| (\d+) \|/u,
  render: /\| `test\/render\.spec\.mjs` \| (\d+) \|/u,
});
// The bilingual README carries both languages and both tables; `checkDocument`
// asserts every pattern it is given, so the Chinese numbers are verified against
// the same suites rather than trusted.
await checkDocument('docs-zh-CN.md', {
  discover: /\| `test\/discover\.spec\.mjs` \| (\d+) \|/u,
  store: /\| `test\/store\.spec\.mjs` \| (\d+) \|/u,
  config: /\| `test\/config\.spec\.mjs` \| (\d+) \|/u,
  host: /\| `test\/host\.spec\.mjs` \| (\d+) \|/u,
  client: /\| `test\/client\.spec\.mjs` \| (\d+) \|/u,
  render: /\| `test\/render\.spec\.mjs` \| (\d+) \|/u,
});
await checkDocument('RELEASE.md', {
  // RELEASE.md writes the counts on one `npm test` line without the leading `#`
  // comment marker the READMEs use, so both patterns must allow it to be absent.
  total: /npm test\s+(?:#\s+)?(\d+) checks/u,
  discover: /npm test\s+(?:#\s+)?\d+ checks: (\d+) discovery/u,
});

// The totals quoted in prose must match too. The bilingual README states both
// languages' totals (in two separate sentences), so it is checked twice with the
// same document.
const TOTALS = [
  { file: 'README.md', pattern: /(\w+) suites — \*\*(\d+) checks\*\*/u, language: 'en' },
  { file: 'README.md', pattern: /(六)个测试套件——\*\*(\d+) 项检查\*\*/u, language: 'zh' },
  { file: 'docs-zh-CN.md', pattern: /(六)个测试套件——\*\*(\d+) 项检查\*\*/u, language: 'zh' },
  { file: 'RELEASE.md', pattern: /npm test\s+(?:#\s+)?(\d+) checks/u, language: 'en' },
];

for (const { file, pattern, language } of TOTALS) {
  let text;
  try {
    text = await fs.readFile(path.join(root, file), 'utf8');
  } catch {
    problems.push(`${file}: cannot be read`);
    continue;
  }
  const match = text.match(pattern);
  if (match === null) {
    problems.push(`${file}: no ${language} total count found`);
    continue;
  }
  // RELEASE.md's single group is the total; the READMEs put the suite count first.
  const claimed = file === 'RELEASE.md' ? Number(match[1]) : Number(match[2]);
  if (claimed !== total) problems.push(`${file} (${language}): total is documented as ${claimed}, but the suites declare ${total}`);
  if (file !== 'RELEASE.md') {
    const suitesClaim = language === 'en' ? Number(match[1] === 'Six' ? 6 : 0) : 6;
    if (suitesClaim !== SUITES.length) problems.push(`${file} (${language}): claims ${match[1]} suites, but ${SUITES.length} exist`);
  }
}

if (problems.length > 0) {
  console.log('documentation does not match the suites:');
  for (const problem of problems) console.log(`  - ${problem}`);
  console.log(`\n${problems.length} documentation problem(s)`);
  process.exitCode = 1;
} else {
  console.log(`documentation matches the suites: ${SUITES.map(([name]) => `${name} ${counts[name]}`).join(', ')} (total ${total})`);
  console.log(`\n${SUITES.length} documentation checks passed (one per suite row in each document)`);
}
