import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vite-plus/test';
import {
  browserMatrix,
  detectCiScope,
  isDevelopmentDocument,
  pathsOutsideScope,
} from '../../scripts/ci-scope';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function repository(
  change: (
    write: (path: string, content?: string) => void,
    git: (...args: string[]) => string,
  ) => void,
) {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-scope-'));
  directories.push(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path: string, content = 'updated\n') => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'CI scope test');
  git('config', 'user.email', 'ci-scope@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  write('README.md', '# Initial\n');
  write('docs/remove.md', '# Remove\n');
  write('src/example.ts', 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'topic');
  change(write, git);
  git('add', '-A');
  git('commit', '--allow-empty', '-m', 'topic');
  const head = git('rev-parse', 'HEAD');
  git('checkout', 'main');
  git('merge', '--no-ff', 'topic', '-m', 'merge');
  const eventPath = join(cwd, 'event.json');
  writeFileSync(
    eventPath,
    JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }),
  );
  return {
    cwd,
    git,
    eventPath,
    scope: () => detectCiScope(cwd, 'pull_request', eventPath, () => {}),
  };
}

describe('development document allowlist', () => {
  test.each([
    'README.md',
    'AGENTS.md',
    'GLOSSARY.md',
    'THIRD-PARTY-NOTICES.md',
    'docs/nested/guide.md',
  ])('%s is documentation', (path) => {
    expect(isDevelopmentDocument(path)).toBe(true);
  });
  test.each([
    'CHANGELOG.md',
    'src/content/blog/post.md',
    'docs/example.ts',
    'docs/page.mdx',
    'new.md',
    'README.MD',
    '/docs/a.md',
    'docs/../src/a.md',
    'docs//a.md',
    'docs\\a.md',
    'docs/a\nb.md',
  ])('%s requires full verification', (path) => {
    expect(isDevelopmentDocument(path)).toBe(false);
  });
});

test('recognizes documentation across the proposed merge', () => {
  expect(repository((write) => write('docs/guide.md')).scope()).toBe('docs');
});

test.each(['src/content/blog/post.md', 'CHANGELOG.md', 'unknown.md', 'src/example.ts'])(
  'keeps full verification for documentation mixed with %s',
  (path) => {
    expect(
      repository((write) => {
        write('README.md');
        write(path);
      }).scope(),
    ).toBe('full');
  },
);

test('includes earlier PR commits, not just the latest documentation commit', () => {
  const repo = repository((write, git) => {
    write('src/example.ts');
    git('add', '.');
    git('commit', '-m', 'code');
    write('README.md');
  });
  expect(repo.scope()).toBe('full');
});

test('handles documentation deletion and rename', () => {
  expect(repository((_write, git) => git('rm', 'docs/remove.md')).scope()).toBe('docs');
  expect(repository((_write, git) => git('mv', 'docs/remove.md', 'docs/renamed.md')).scope()).toBe(
    'docs',
  );
});

test('moving code into documentation still requires full verification', () => {
  expect(repository((_write, git) => git('mv', 'src/example.ts', 'docs/example.md')).scope()).toBe(
    'full',
  );
});

test('manual runs and empty diffs require full verification', () => {
  const repo = repository(() => {});
  expect(repo.scope()).toBe('full');
  expect(detectCiScope(repo.cwd, 'workflow_dispatch', repo.eventPath)).toBe('full');
});

test('mismatched commit identities and malformed events fall back to full verification', () => {
  const repo = repository((write) => write('README.md'));
  writeFileSync(
    repo.eventPath,
    JSON.stringify({
      pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } },
    }),
  );
  expect(repo.scope()).toBe('full');
  writeFileSync(repo.eventPath, '{broken');
  expect(repo.scope()).toBe('full');
  expect(detectCiScope(repo.cwd, 'pull_request', undefined, () => {})).toBe('full');
});

test('depth two has enough history while depth one falls back', () => {
  const repo = repository((write) => write('README.md'));
  for (const depth of [1, 2]) {
    const clone = mkdtempSync(join(tmpdir(), 'ci-scope-clone-'));
    directories.push(clone);
    execFileSync('git', ['clone', '--depth', String(depth), `file://${repo.cwd}`, clone], {
      stdio: 'pipe',
    });
    expect(detectCiScope(clone, 'pull_request', repo.eventPath, () => {})).toBe(
      depth === 2 ? 'docs' : 'full',
    );
  }
});

test('CLI emits fallback output and fails if it cannot write the required output', () => {
  const repo = repository((write) => write('README.md'));
  const script = fileURLToPath(new URL('../../scripts/ci-scope.ts', import.meta.url));
  const output = join(repo.cwd, 'output');
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: join(repo.cwd, 'missing'),
    GITHUB_OUTPUT: output,
  };
  expect(spawnSync(process.execPath, [script], { cwd: repo.cwd, env }).status).toBe(0);
  expect(readFileSync(output, 'utf8')).toBe(
    `scope=full\nbrowser_matrix=${JSON.stringify(browserMatrix('full'))}\n`,
  );
  expect(
    spawnSync(process.execPath, [script], {
      cwd: repo.cwd,
      env: { ...env, GITHUB_OUTPUT: repo.cwd },
    }).status,
  ).not.toBe(0);
});

test('unit test changes narrow PR checks, mixed changes keep full coverage', () => {
  expect(repository((write) => write('tests/unit/tooling/a.test.ts')).scope()).toBe('unit');
  expect(repository((write) => write('tests/unit/a.test.ts')).scope()).toBe('unit');
  expect(
    repository((write) => {
      write('tests/unit/tooling/a.test.ts');
      write('src/example.ts');
    }).scope(),
  ).toBe('full');
  expect(repository((write) => write('tests/support/helper.ts')).scope()).toBe('full');
});

test.each([
  ['tests/build/example.test.ts', 'contracts'],
  ['tests/build/tooling/example.test.ts', 'contracts'],
  ['tests/e2e/deterministic/default/example.e2e.ts', 'default'],
  ['tests/e2e/deterministic/production-path/nested/example.e2e.ts', 'production-path'],
  ['tests/e2e/deterministic/unknown/example.e2e.ts', 'full'],
  ['tests/e2e/ai/rendering/example.e2e.ts', 'full'],
  ['tests/e2e/deterministic/default/helper.ts', 'full'],
])('%s selects %s', (path, scope) => {
  expect(repository((write) => write(path)).scope()).toBe(scope);
});

test('mixed browser variants require full verification', () => {
  expect(
    repository((write) => {
      write('tests/e2e/deterministic/default/example.e2e.ts');
      write('tests/e2e/deterministic/i18n/example.e2e.ts');
    }).scope(),
  ).toBe('full');
});

test('a falsely selected browser scope fails on a hidden source change', () => {
  const repo = repository((write) => {
    write('tests/e2e/deterministic/default/example.e2e.ts');
    write('src/example.ts');
  });
  expect(pathsOutsideScope(repo.cwd, 'default')).toEqual(['src/example.ts']);
});

test('browser selection retains every configured target in the variant', () => {
  const full = [
    { variant: 'default', target: 'desktop' },
    { variant: 'default', target: 'narrow' },
    { variant: 'default', target: 'webkit' },
    { variant: 'i18n', target: 'desktop,narrow,webkit' },
    { variant: 'configured-forms', target: 'desktop,narrow,webkit' },
    { variant: 'rendering', target: 'desktop,narrow,webkit' },
    { variant: 'production-path', target: 'desktop' },
  ];
  expect(browserMatrix('full').include).toEqual(full);
  expect(browserMatrix('default').include).toEqual(full.slice(0, 3));
  expect(browserMatrix('i18n').include).toEqual(full.slice(3, 4));
  expect(browserMatrix('contracts').include).toEqual([]);
});

test('the independent Git tree check catches a source change omitted from the path list', () => {
  const repo = repository((write) => {
    write('tests/unit/example.test.ts');
    write('src/example.ts');
  });
  const bin = join(repo.cwd, 'bin');
  mkdirSync(bin);
  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
for arg do
  if [ "$arg" = diff ]; then printf 'tests/unit/example.test.ts\\0'; exit 0; fi
done
exec "$REAL_GIT" "$@"
`,
    { mode: 0o755 },
  );
  const output = join(repo.cwd, 'output');
  const script = fileURLToPath(new URL('../../scripts/ci-scope.ts', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    cwd: repo.cwd,
    env: {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      REAL_GIT: git,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: repo.eventPath,
      GITHUB_OUTPUT: output,
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr.toString()).toContain(
    'CI scope unit would omit changed files: ["src/example.ts"]',
  );
});

describe('release-meta scope for version PRs', () => {
  const versionBranch = 'release-please--branches--release--components--sionrbot-blog';

  function versionPrRepository(
    change: (write: (path: string, content?: string) => void) => void,
    refs: { baseRef?: string; headRef?: string; headRepo?: string } = {},
  ) {
    const cwd = mkdtempSync(join(tmpdir(), 'ci-scope-release-meta-'));
    directories.push(cwd);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const write = (path: string, content = '') => {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    };
    git('init', '-b', 'release');
    git('config', 'user.name', 'CI scope test');
    git('config', 'user.email', 'ci-scope@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    write(
      'package.json',
      JSON.stringify({ name: 'blog', version: '1.10.2', dependencies: { astro: '7.4.12' } }) + '\n',
    );
    write('.release-please-manifest.json', JSON.stringify({ '.': '1.10.2' }) + '\n');
    write('CHANGELOG.md', '# Changelog\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'version-pr');
    change(write);
    git('add', '-A');
    git('commit', '--allow-empty', '-m', 'chore(release): release 1.10.3');
    const head = git('rev-parse', 'HEAD');
    git('checkout', 'release');
    git('merge', '--no-ff', 'version-pr', '-m', 'merge');
    const eventPath = join(cwd, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          base: {
            ref: refs.baseRef ?? 'release',
            sha: base,
            repo: { full_name: 'owner/blog' },
          },
          head: {
            ref: refs.headRef ?? versionBranch,
            sha: head,
            repo: { full_name: refs.headRepo ?? 'owner/blog' },
          },
        },
      }),
    );
    return {
      cwd,
      scope: () => detectCiScope(cwd, 'pull_request', eventPath, () => {}),
    };
  }

  test('selects release-meta when a same-repo release version PR changes only version metadata', () => {
    const repo = versionPrRepository((write) => {
      write(
        'package.json',
        JSON.stringify({ name: 'blog', version: '1.10.3', dependencies: { astro: '7.4.12' } }) +
          '\n',
      );
      write('.release-please-manifest.json', JSON.stringify({ '.': '1.10.3' }) + '\n');
      write('CHANGELOG.md', '# Changelog\n\n## 1.10.3\n\n- fix: demo\n');
    });
    expect(repo.scope()).toBe('release-meta');
    expect(browserMatrix('release-meta').include).toEqual([]);
  });

  test('falls back to full if package.json changes any field beyond version', () => {
    const repo = versionPrRepository((write) => {
      write(
        'package.json',
        JSON.stringify({ name: 'blog', version: '1.10.3', dependencies: { astro: '7.4.13' } }) +
          '\n',
      );
      write('.release-please-manifest.json', JSON.stringify({ '.': '1.10.3' }) + '\n');
    });
    expect(repo.scope()).toBe('full');
  });

  test('falls back to full for mismatched versions, non-release base, wrong branch, or fork PRs', () => {
    const bumpOnly = (write: (path: string, content?: string) => void) => {
      write(
        'package.json',
        JSON.stringify({ name: 'blog', version: '1.10.3', dependencies: { astro: '7.4.12' } }) +
          '\n',
      );
      write('.release-please-manifest.json', JSON.stringify({ '.': '1.10.3' }) + '\n');
    };
    expect(versionPrRepository(bumpOnly, { baseRef: 'main' }).scope()).toBe('full');
    expect(versionPrRepository(bumpOnly, { headRef: 'promote/batch' }).scope()).toBe('full');
    expect(versionPrRepository(bumpOnly, { headRepo: 'fork/blog' }).scope()).toBe('full');
    expect(
      versionPrRepository((write) => {
        write(
          'package.json',
          JSON.stringify({ name: 'blog', version: '1.10.3', dependencies: { astro: '7.4.12' } }) +
            '\n',
        );
        write('.release-please-manifest.json', JSON.stringify({ '.': '1.10.4' }) + '\n');
      }).scope(),
    ).toBe('full');
  });
});
