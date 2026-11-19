import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vite-plus/test';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const gate = workflow.split('\n  verify:\n')[1];
const script = gate.split("<<'NODE'\n")[1].split('\n          NODE')[0];
const names = gate.match(/needs: \[(.+)\]/)![1].split(', ');
const fullOnly = names.filter((name) => !['scope', 'format'].includes(name));

function verify(scope: string, override?: Record<string, string>) {
  const jobs = Object.fromEntries(
    names.map((name) => [
      name,
      {
        outputs: { scope },
        result:
          override?.[name] ??
          ((scope === 'docs' && fullOnly.includes(name)) ||
          (scope === 'unit' && ['build', 'contracts', 'browser'].includes(name))
            ? 'skipped'
            : 'success'),
      },
    ]),
  );
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { NEEDS: JSON.stringify(jobs) },
  }).status;
}

test.each(['docs', 'unit', 'full'])(
  '%s requires all selected jobs and successful formatting',
  (scope) => {
    expect(verify(scope)).toBe(0);
    expect(verify(scope, { format: 'failure' })).toBe(1);
    expect(verify(scope, { scope: 'cancelled' })).toBe(1);
  },
);
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
  for (const name of fullOnly)
    expect(workflow.split('\n  ' + name + ':\n')[1].split('    steps:')[0]).toContain(
      "if: needs.scope.outputs.scope != 'docs'",
    );
});
