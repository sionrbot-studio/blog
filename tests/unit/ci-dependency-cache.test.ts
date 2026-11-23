import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';

const directories: string[] = [];
const cacheKeyScript = '.github/actions/dependencies/cache-key.mjs';
const installRecipe = '.github/actions/dependencies/action.yml';
const prepare = 'vp config --no-agent';

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const manifest = {
  name: 'cache-key-fixture',
  version: '1.0.0',
  dependencies: { astro: '7.4.12' },
  devEngines: { runtime: { name: 'node', version: '26.13.0', onFail: 'ignore' } },
  packageManager: 'pnpm@11.28.10',
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-dependency-cache-'));
  directories.push(root);
  const cwd = join(root, 'checkout');
  mkdirSync(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), contents);
  };
  const writeManifest = (
    value: typeof manifest & { private?: boolean; scripts?: Record<string, string> },
  ) => write('package.json', JSON.stringify(value) + '\n');
  const output = join(root, 'output');
  git('init');
  writeManifest(manifest);
  write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  write('pnpm-workspace.yaml', 'packages: []\n');
  write('.npmrc', 'ignore-scripts=false\n');
  write('patches/example.patch', 'original patch\n');
  write(installRecipe, 'name: Install locked dependencies\n');
  copyFileSync(new URL(`../../${cacheKeyScript}`, import.meta.url), join(cwd, cacheKeyScript));

  return {
    cwd,
    write,
    writeManifest,
    outputs() {
      git('add', '-A');
      writeFileSync(output, '');
      execFileSync(process.execPath, [cacheKeyScript], {
        cwd,
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          RUNNER_OS: 'Linux',
          RUNNER_ARCH: 'X64',
          CACHE_ENVIRONMENT: 'unit-test',
        },
      });
      return Object.fromEntries(
        readFileSync(output, 'utf8')
          .trimEnd()
          .split('\n')
          .map((line) => line.split('=')),
      );
    },
  };
}

test.each([
  ['no other scripts', {}],
  ['unrelated scripts', { scripts: { dev: 'astro dev' } }],
] as const)('the supported prepare script preserves the key with %s', (_label, extra) => {
  const repo = fixture();
  const base = { ...manifest, ...extra };
  repo.writeManifest(base);
  const original = repo.outputs();
  expect(original.cache_id).toMatch(/^modules-v2-Linux-X64-unit-test-[a-f0-9]{64}$/);
  expect(original.register_hooks).toBe('false');
  repo.writeManifest({ ...base, scripts: { ...base.scripts, prepare } });
  expect(repo.outputs()).toMatchObject({ cache_id: original.cache_id, register_hooks: 'true' });
});

test.each([
  ['dependencies', { dependencies: { astro: '7.4.13' } }],
  ['runtime', { devEngines: { runtime: { ...manifest.devEngines.runtime, version: '26.13.1' } } }],
  ['package manager', { packageManager: 'pnpm@11.28.11' }],
] as const)('a change to %s invalidates the dependency key', (_label, change) => {
  const repo = fixture();
  const original = repo.outputs().cache_id;
  repo.writeManifest({ ...manifest, ...change });
  const updated = repo.outputs().cache_id;
  expect(updated).toMatch(/^modules-v2-/);
  expect(updated).not.toBe(original);
});

test.each([
  ['pnpm-lock.yaml', "lockfileVersion: '9.0'\n# changed lockfile\n"],
  ['pnpm-workspace.yaml', 'packages: []\nstrictPeerDependencies: true\n'],
  ['.npmrc', 'ignore-scripts=true\n'],
  ['patches/example.patch', 'modified patch\n'],
  [installRecipe, 'name: Updated install recipe\n'],
])('changing %s invalidates the dependency key', (path, contents) => {
  const repo = fixture();
  const original = repo.outputs().cache_id;
  repo.write(path, contents);
  const updated = repo.outputs().cache_id;
  expect(updated).toMatch(/^modules-v2-/);
  expect(updated).not.toBe(original);
});

test('renaming a patch invalidates the key even when its bytes are identical', () => {
  const repo = fixture();
  const original = repo.outputs().cache_id;
  renameSync(join(repo.cwd, 'patches/example.patch'), join(repo.cwd, 'patches/renamed.patch'));
  const updated = repo.outputs().cache_id;
  expect(updated).toMatch(/^modules-v2-/);
  expect(updated).not.toBe(original);
});

test('independent source changes preserve the dependency key', () => {
  const repo = fixture();
  const original = repo.outputs();
  repo.write('src/example.ts', 'export const sample = 1;\n');
  expect(repo.outputs()).toEqual(original);
});

test('version bumps preserve the cache key for private root packages, not public packages', () => {
  const repo = fixture();
  repo.writeManifest({ ...manifest, private: true, version: '1.10.2' });
  const privateOriginal = repo.outputs().cache_id;
  repo.writeManifest({ ...manifest, private: true, version: '1.10.3' });
  expect(repo.outputs().cache_id).toBe(privateOriginal);

  repo.writeManifest({ ...manifest, version: '1.10.2' });
  const publicOriginal = repo.outputs().cache_id;
  repo.writeManifest({ ...manifest, version: '1.10.3' });
  expect(repo.outputs().cache_id).not.toBe(publicOriginal);
});

test.each(['prepare', 'preinstall', 'install', 'postinstall'])(
  'a custom %s lifecycle script disables dependency caching',
  (lifecycle) => {
    const repo = fixture();
    repo.writeManifest({
      ...manifest,
      scripts: { prepare, [lifecycle]: 'node custom-install.mjs' },
    });
    const outputs = repo.outputs();
    expect(outputs.cache_id).toBe('');
    if (lifecycle === 'prepare') expect(outputs.register_hooks).toBe('false');
  },
);

test('a tracked pnpm hook file disables dependency caching', () => {
  const repo = fixture();
  expect(repo.outputs().cache_id).toMatch(/^modules-v2-/);
  repo.write('.pnpmfile.cjs', 'module.exports = {};\n');
  expect(repo.outputs().cache_id).toBe('');
});

test('cache hits replay only supported hook registration; cache misses still install', () => {
  const action = readFileSync(new URL(`../../${installRecipe}`, import.meta.url), 'utf8');
  expect(action).toContain(
    "if: steps.inputs.outputs.cache_id != ''\n      uses: actions/cache/restore@",
  );
  expect(action).toContain(
    "if: steps.modules.outputs.cache-hit != 'true'\n      shell: bash\n      run: vp install --frozen-lockfile",
  );
  expect(action).toContain(
    "if: steps.modules.outputs.cache-hit == 'true' && steps.inputs.outputs.register_hooks == 'true'\n      shell: bash\n      run: vp config --no-agent",
  );
});
