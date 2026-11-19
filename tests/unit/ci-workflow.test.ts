import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const gate = workflow.split('\n  verify:\n')[1];
const script = gate.split("<<'NODE'\n")[1].split('\n          NODE')[0];
const names = ['scope', 'format', 'lint', 'types', 'unit', 'build', 'contracts', 'browser'];
const fullOnly = names.filter((name) => !['scope', 'format'].includes(name));

function verify(
  scope: string,
  overrides: Record<string, string | null> = {},
  event = 'pull_request',
) {
  const jobs = Object.fromEntries(
    names
      .filter((name) => overrides[name] !== null)
      .map((name) => [
        name,
        {
          outputs: name === 'scope' ? { scope } : {},
          result:
            overrides[name] ??
            (scope === 'docs' && fullOnly.includes(name) ? 'skipped' : 'success'),
        },
      ]),
  );
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { GITHUB_EVENT_NAME: event, NEEDS: JSON.stringify(jobs) },
  }).status;
}

test.each(['docs', 'full'])('%s requires all selected jobs and successful formatting', (scope) => {
  expect(verify(scope)).toBe(0);
  expect(verify(scope, { format: 'failure' })).toBe(1);
  expect(verify(scope, { scope: 'cancelled' })).toBe(1);
});

test('documentation verification keeps the formatting job and skips full-only checks', () => {
  const formatJob = workflow.split('\n  format:\n')[1].split('\n  lint:\n')[0];
  expect(formatJob).toContain('run: vp fmt --check');
  expect(formatJob).not.toMatch(/^    if:/m);
  expect(verify('docs', { unit: 'success' })).toBe(1);
});

test('merge groups select full verification without consulting the PR selector', () => {
  const scopeJob = workflow.split('\n  scope:\n')[1].split('\n  format:\n')[0];
  const select = scopeJob.split('- id: select\n        run: |\n')[1].trimEnd();
  const directory = mkdtempSync(join(tmpdir(), 'ci-scope-'));
  const output = join(directory, 'output');
  try {
    const result = spawnSync('sh', ['-eu', '-c', select], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: 'merge_group', GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('scope=full\n');
  } finally {
    rmSync(directory, { recursive: true });
  }
  expect(verify('full', {}, 'merge_group')).toBe(0);
  expect(verify('docs', {}, 'merge_group')).toBe(1);
});

test.each(['failure', 'cancelled', 'skipped', null])(
  'full merge-group verification rejects browser result %s',
  (result) => {
    expect(verify('full', { browser: result }, 'merge_group')).toBe(1);
  },
);

test('merge groups run the unit and timezone suites without the Vite+ task cache', () => {
  const unitJob = workflow.split('\n  unit:\n')[1].split('\n  build:\n')[0];
  const queueCacheFlag = "${{ github.event_name == 'merge_group' && '--no-cache' || '' }}";
  expect(unitJob).toContain(`- run: vp run ${queueCacheFlag} test:unit\n`);
  expect(unitJob).toContain(`- run: vp run ${queueCacheFlag} test:unit:tz\n`);
});

test('unknown scope cannot satisfy the gate', () => expect(verify('')).toBe(1));

test('all worker jobs feed the unconditional required gate', () => {
  const declarations = [...workflow.split('\njobs:\n')[1].matchAll(/^  (\w+):$/gm)].map(
    (match) => match[1],
  );
  const dependencies = gate.match(/^    needs: \[(.+)\]$/m)![1].split(', ');
  expect(dependencies.sort()).toEqual([...names].sort());
  expect(declarations.sort()).toEqual([...names, 'verify'].sort());
  expect(gate).toContain('if: always()');
  expect(workflow).not.toMatch(/^\s+paths(?:-ignore)?:/m);
  expect(workflow).toContain('  merge_group:\n    types: [checks_requested]\n    branches: [main]');
  expect(workflow).toContain('  pull_request:');
  expect(workflow).toContain('  workflow_dispatch:');
  expect(workflow).toContain('fetch-depth: 0');
  expect(workflow).toContain('filter: blob:none');
  for (const name of fullOnly)
    expect(workflow.split('\n  ' + name + ':\n')[1].split('    steps:')[0]).toContain(
      "if: needs.scope.outputs.scope != 'docs'",
    );
});

test('a cold installation must succeed before saving the exact dependency tree', () => {
  const action = readFileSync(
    new URL('../../.github/actions/dependencies/action.yml', import.meta.url),
    'utf8',
  );
  expect(action).toContain('run: vp install --frozen-lockfile');
  expect(action).toContain('path: node_modules');
  expect(action).not.toMatch(/continue-on-error|restore-keys/);
  expect(action.indexOf('vp install')).toBeLessThan(action.indexOf('uses: actions/cache/save'));
});
