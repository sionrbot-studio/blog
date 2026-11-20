import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vite-plus/test';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const gate = workflow.split('\n  verify:\n')[1];
const script = gate.split("<<'NODE'\n")[1].split('\n          NODE')[0];
const names = ['scope', 'format', 'lint', 'types', 'unit', 'build', 'contracts', 'browser'];
const nonDocs = names.filter((name) => !['scope', 'format'].includes(name));
const fullBrowserMatrix = [
  { variant: 'default', target: 'desktop' },
  { variant: 'default', target: 'narrow' },
  { variant: 'default', target: 'webkit' },
  { variant: 'i18n', target: 'desktop,narrow,webkit' },
  { variant: 'configured-forms', target: 'desktop,narrow,webkit' },
  { variant: 'rendering', target: 'desktop,narrow,webkit' },
  { variant: 'production-path', target: 'desktop' },
];

function browserMatrix(scope: string) {
  return JSON.stringify({
    include: fullBrowserMatrix.filter(({ variant }) => scope === 'full' || variant === scope),
  });
}

function verify(
  scope: string,
  overrides: Record<string, string | null> = {},
  event = 'pull_request',
  matrix = browserMatrix(scope),
) {
  const selected = ['scope', 'format'];
  if (scope !== 'docs') selected.push('lint', 'types');
  if (scope === 'unit') selected.push('unit');
  if (scope === 'contracts') selected.push('contracts');
  if (fullBrowserMatrix.some(({ variant }) => variant === scope)) selected.push('browser');
  const jobs = Object.fromEntries(
    names
      .filter((name) => overrides[name] !== null)
      .map((name) => [
        name,
        {
          outputs: name === 'scope' ? { scope, browser_matrix: matrix } : {},
          result:
            overrides[name] ??
            (scope === 'full' || selected.includes(name) ? 'success' : 'skipped'),
        },
      ]),
  );
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { GITHUB_EVENT_NAME: event, NEEDS: JSON.stringify(jobs) },
  }).status;
}

test.each([
  'docs',
  'unit',
  'contracts',
  'default',
  'i18n',
  'configured-forms',
  'rendering',
  'production-path',
  'full',
])('%s requires all selected jobs and successful formatting', (scope) => {
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

test.each(['merge_group', 'workflow_dispatch'])(
  '%s selects the complete browser matrix without pull request data',
  (event) => {
    expect(workflow).toContain('- id: select\n        run: node scripts/ci-scope.ts');
    const script = fileURLToPath(new URL('../../scripts/ci-scope.ts', import.meta.url));
    const directory = mkdtempSync(join(tmpdir(), 'ci-scope-'));
    const output = join(directory, 'output');
    try {
      const result = spawnSync(process.execPath, [script], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: event,
          GITHUB_EVENT_PATH: join(directory, 'missing-event.json'),
          GITHUB_OUTPUT: output,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe(
        `scope=full\nbrowser_matrix=${browserMatrix('full')}\n`,
      );
    } finally {
      rmSync(directory, { recursive: true });
    }
    expect(verify('full', {}, event)).toBe(0);
    for (const scope of ['docs', 'unit', 'contracts', 'i18n']) {
      expect(verify(scope, {}, event)).toBe(1);
    }
  },
);

test.each([
  ['contracts', 'contracts'],
  ['default', 'browser'],
])('%s rejects unsuccessful or missing %s results', (scope, name) => {
  for (const status of ['failure', 'cancelled', 'skipped', null]) {
    expect(verify(scope, { [name]: status })).toBe(1);
  }
});

test('the gate rejects an incomplete, duplicated, or extraneous browser matrix', () => {
  const missing = JSON.stringify({ include: fullBrowserMatrix.slice(0, -1) });
  const duplicated = JSON.stringify({
    include: [{ variant: 'default', target: 'desktop' }, ...fullBrowserMatrix.slice(0, 2)],
  });
  expect(verify('full', {}, 'merge_group', missing)).toBe(1);
  expect(verify('default', {}, 'pull_request', duplicated)).toBe(1);
  expect(verify('contracts', {}, 'pull_request', browserMatrix('default'))).toBe(1);
});

test.each(['failure', 'cancelled', 'skipped', null])(
  'full merge-group verification rejects browser result %s',
  (result) => {
    expect(verify('full', { browser: result }, 'merge_group')).toBe(1);
  },
);

test('both unit suites run without the Vite+ task cache under their execution budget', () => {
  const unitJob = workflow.split('\n  unit:\n')[1].split('\n  build:\n')[0];
  expect(unitJob).toContain('run: bash scripts/ci-budget.sh 60000 vp run --no-cache test:unit\n');
  expect(unitJob).toContain(
    "if: ${{ !cancelled() && steps.unit_tests.outcome != 'skipped' }}\n" +
      '        run: bash scripts/ci-budget.sh 60000 vp run --no-cache test:unit:tz\n',
  );
});

test('unknown scope cannot satisfy the gate', () => expect(verify('')).toBe(1));

test('all worker jobs feed the unconditional required gate', () => {
  const declarations = [...workflow.split('\njobs:\n')[1].matchAll(/^  (\w+):$/gm)].map(
    (match) => match[1],
  );
  const dependencies = gate.match(/^    needs: \[(.+)\]$/m)![1].split(', ');
  expect(dependencies.sort()).toEqual([...names].sort());
  expect(declarations.sort()).toEqual([...names, 'cancel_build_probe', 'verify'].sort());
  expect(gate).toContain('if: always()');
  expect(workflow).not.toMatch(/^\s+paths(?:-ignore)?:/m);
  expect(workflow).toContain('  merge_group:\n    types: [checks_requested]\n    branches: [main]');
  expect(workflow).toContain('  pull_request:');
  expect(workflow).toContain('  workflow_dispatch:');
  expect(workflow).toContain('fetch-depth: 0');
  expect(workflow).toContain('filter: blob:none');
  const browserScopes =
    'contains(fromJSON(\'["default","i18n","configured-forms","rendering","production-path","full"]\'), ';
  const workers = {
    lint: "needs.scope.outputs.scope != 'docs'",
    types: "needs.scope.outputs.scope != 'docs'",
    unit: "needs.scope.outputs.scope == 'unit' || needs.scope.outputs.scope == 'full'",
    build: "needs.scope.outputs.scope == 'full'",
    contracts: "needs.scope.outputs.scope == 'contracts' || needs.scope.outputs.scope == 'full'",
    browser: browserScopes + 'needs.scope.outputs.scope)',
  };
  for (const [name, condition] of Object.entries(workers))
    expect(workflow.split('\n  ' + name + ':\n')[1].split('    steps:')[0]).toContain(
      `if: ${condition}\n`,
    );
  expect(workflow).toContain('matrix: ${{ fromJSON(needs.scope.outputs.browser_matrix) }}');
  expect(workflow).toContain(`if: ${browserScopes}steps.select.outputs.scope)`);
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

test('each verification worker enforces the environment budget after preparing its dependencies', () => {
  for (const name of ['format', ...nonDocs]) {
    const job = workflow.split(`\n  ${name}:\n`)[1].split(/\n  \w+:\n/)[0];
    const setupFinish = job.indexOf('SETUP_FINISHED=');
    const budgetCheck = job.indexOf('uses: ./.github/actions/check-setup-budget');
    expect(job).toContain('uses: ./.github/actions/dependencies');
    expect(setupFinish).toBeGreaterThan(job.indexOf('uses: ./.github/actions/dependencies'));
    expect(budgetCheck).toBeGreaterThan(setupFinish);
    const budgetStep = job.split(/\n      - /).find((step) => step.includes('check-setup-budget'));
    expect(budgetStep).toContain('if: ${{ !cancelled() }}');
    expect(budgetStep).not.toContain('continue-on-error');
  }
});

test.each(['lint', 'types', 'unit'])('unit-only changes require %s to run', (job) => {
  expect(verify('unit', { [job]: 'skipped' })).toBe(1);
});

test.each(['build', 'contracts', 'browser'])('full scope rejects a skipped %s job', (job) => {
  expect(verify('full', { [job]: 'skipped' })).toBe(1);
});

test.each(['success', 'failure', 'cancelled', null])(
  'unit-only verification requires an explicit skip for omitted browser work, got %s',
  (result) => {
    expect(verify('unit', { browser: result })).toBe(1);
  },
);
