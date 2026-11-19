import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';

const project = new URL('../../../', import.meta.url);
const component = `---
let count = 0;
let label = 'Count';
---
<p>{label}: {count++}</p>
`;

it('preserves a template write through both lint fixes and lets ESLint fix a read-only binding', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'astro-prefer-const-'));
  const file = join(cwd, 'Counter.astro');
  try {
    for (const name of ['vite.config.ts', 'eslint.config.js', 'package.json']) {
      copyFileSync(new URL(name, project), join(cwd, name));
    }
    symlinkSync(new URL('node_modules', project), join(cwd, 'node_modules'), 'junction');

    writeFileSync(file, component);
    execFileSync('vp', ['lint', '--fix', 'Counter.astro'], { cwd });
    const oxlintOutput = readFileSync(file, 'utf8');
    expect(oxlintOutput).toContain('let count = 0;');
    expect(oxlintOutput).toContain('{count++}');

    writeFileSync(file, component);
    execFileSync('vp', ['exec', 'eslint', '--fix', 'Counter.astro'], { cwd });
    expect(readFileSync(file, 'utf8')).toBe(component.replace('let label', 'const label'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
