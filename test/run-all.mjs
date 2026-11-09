/**
 * One runner for every suite, so a reader (and CI) gets a single verdict.
 *
 * Each suite is a plain script that prints `n/n <name> tests passed` and exits
 * non-zero on failure; running them as child processes keeps them independent —
 * one suite's global stubs (`window`, `console`) cannot leak into another.
 *
 * Usage: node test/run-all.mjs [--filter <name>]
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SUITES = [
  ['discovery', 'discover.spec.mjs'],
  ['store', 'store.spec.mjs'],
  ['config', 'config.spec.mjs'],
  ['host', 'host.spec.mjs'],
  ['client', 'client.spec.mjs'],
  ['render', 'render.spec.mjs'],
  // Not a suite: it reads the suites and asserts the documents quote them
  // correctly. A release checklist that lies about coverage is worse than none.
  ['docs', 'check-docs.mjs'],
];

const filter = process.argv.includes('--filter')
  ? process.argv[process.argv.indexOf('--filter') + 1]
  : undefined;
const here = path.dirname(fileURLToPath(import.meta.url));

/** Run one suite, forwarding its output; resolves to whether it passed. */
function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', () => resolve({ ok: false, summary: 'could not start' }));
    child.on('close', (code) => {
      const summary = stdout
        .split(/\r?\n/u)
        .reverse()
        .find((line) => /(checks|tests) passed|test\(s\) failed/u.test(line));
      resolve({ ok: code === 0, summary: (summary ?? '').trim() });
    });
  });
}

const results = [];
for (const [name, file] of SUITES) {
  if (filter !== undefined && !name.includes(filter)) continue;
  process.stdout.write(`\n--- ${name} (${file}) ---\n`);
  const result = await run(file);
  results.push({ name, ...result });
}

process.stdout.write('\n=== summary ===\n');
for (const result of results) {
  process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(10)} ${result.summary}\n`);
}
const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} suites passed\n`);
if (failed.length > 0) process.exitCode = 1;
