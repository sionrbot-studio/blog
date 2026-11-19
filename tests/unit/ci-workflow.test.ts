import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vite-plus/test';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const gate = workflow.split('\n  verify:\n')[1];
const script = gate.split("<<'NODE'\n")[1].split('\n          NODE')[0];
const names = gate.match(/needs: \[(.+)\]/)![1].split(', ');
const scopedJobs: Record<string, string[]> = {
  docs: [],
  unit: ['lint', 'types', 'unit'],
  contracts: ['lint', 'types', 'contracts'],
  default: ['lint', 'types', 'browser'],
  i18n: ['lint', 'types', 'browser'],
  'configured-forms': ['lint', 'types', 'browser'],
  rendering: ['lint', 'types', 'browser'],
  'production-path': ['lint', 'types', 'browser'],
};

function verify(scope: string, override?: Record<string, string>, event = 'pull_request') {
  const selected = ['scope', 'format', ...(scopedJobs[scope] ?? [])];
  const jobs = Object.fromEntries(
    names.map((name) => [
      name,
      {
        outputs: { scope },
        result:
          override?.[name] ?? (scope === 'full' || selected.includes(name) ? 'success' : 'skipped'),
      },
    ]),
  );
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { NEEDS: JSON.stringify(jobs), GITHUB_EVENT_NAME: event },
  }).status;
}

test.each([...Object.keys(scopedJobs), 'full'])('%s requires all selected jobs', (scope) => {
  expect(verify(scope)).toBe(0);
  expect(verify(scope, { format: 'failure' })).toBe(1);
  expect(verify(scope, { scope: 'cancelled' })).toBe(1);
});
test('contracts and browser scopes fail when their selected job is omitted', () => {
  expect(verify('contracts', { contracts: 'skipped' })).toBe(1);
  expect(verify('default', { browser: 'skipped' })).toBe(1);
});
test.each(['workflow_dispatch', 'merge_group'])('%s requires complete verification', (event) => {
  expect(verify('full', undefined, event)).toBe(0);
  expect(verify('i18n', undefined, event)).toBe(1);
});
test.each(['failure', 'skipped', 'cancelled'])('full verification rejects %s', (result) => {
  expect(verify('full', { browser: result })).toBe(1);
});
test('unknown scope cannot satisfy the gate', () => expect(verify('')).toBe(1));
test('all worker jobs feed the unconditional required gate', () => {
  const declarations = [...workflow.split('\njobs:\n')[1].matchAll(/^  (\w+):$/gm)].map(
    (match) => match[1],
  );
  expect(names.sort()).toEqual(declarations.filter((name) => name !== 'verify').sort());
  expect(gate).toContain('if: always()');
  expect(workflow).not.toMatch(/^\s+paths(?:-ignore)?:/m);
  expect(workflow).toContain('  pull_request:');
  expect(workflow).toContain('  workflow_dispatch:');
  expect(workflow).toContain('fetch-depth: 0');
  expect(workflow).toContain('filter: blob:none');
  expect(workflow).toContain('matrix: ${{ fromJSON(needs.scope.outputs.browser_matrix) }}');
});

test.each(['lint', 'types', 'unit'])('unit-only changes require %s to run', (job) => {
  expect(verify('unit', { [job]: 'skipped' })).toBe(1);
});

test.each(['build', 'contracts', 'browser'])('full scope rejects a skipped %s job', (job) => {
  expect(verify('full', { [job]: 'skipped' })).toBe(1);
});
