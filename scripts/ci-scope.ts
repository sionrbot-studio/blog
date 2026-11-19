import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const rootDocuments = new Set(['README.md', 'AGENTS.md', 'GLOSSARY.md', 'THIRD-PARTY-NOTICES.md']);

export function isDevelopmentDocument(path: string): boolean {
  if (/[\\\r\n]/u.test(path) || path.split('/').some((part) => ['', '.', '..'].includes(part)))
    return false;
  return rootDocuments.has(path) || (path.startsWith('docs/') && path.endsWith('.md'));
}

const browserVariants = [
  'default',
  'i18n',
  'configured-forms',
  'rendering',
  'production-path',
] as const;
type BrowserVariant = (typeof browserVariants)[number];
type NarrowScope = 'docs' | 'unit' | 'contracts' | BrowserVariant;
type Scope = 'full' | NarrowScope;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', `safe.directory=${realpathSync(cwd)}`, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function readPullRequestDiff(cwd: string, eventPath: string | undefined): string {
  if (!eventPath) throw new Error('Missing pull request event');
  const event = JSON.parse(readFileSync(eventPath, 'utf8')) as {
    pull_request?: { base?: { sha?: unknown }; head?: { sha?: unknown } };
  } | null;
  const base = event?.pull_request?.base?.sha;
  const head = event?.pull_request?.head?.sha;
  if (
    typeof base !== 'string' ||
    typeof head !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(base) ||
    !/^[a-f0-9]{40}$/u.test(head)
  )
    throw new Error('Missing pull request commit identities');
  const parents = git(cwd, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ');
  if (parents.length !== 3 || parents[1] !== base || parents[2] !== head)
    throw new Error('Checkout does not match the pull request merge parents');
  // Compare the whole proposed merge with its base. Renames contribute both paths.
  return git(
    cwd,
    'diff',
    '--name-only',
    '--no-renames',
    '--ignore-submodules=none',
    '-z',
    'HEAD^1',
    'HEAD',
    '--',
    // #121 negative control: truncate only the primary path list on this probe PR.
    ...(process.env.GITHUB_HEAD_REF === 'test/independent-tree-guard-probe' ? ['README.md'] : []),
  );
}

function scopeForPath(path: string): Scope {
  if (isDevelopmentDocument(path)) return 'docs';
  if (/^tests\/unit\/(?:[\w.-]+\/)*[\w.-]+\.test\.ts$/u.test(path)) return 'unit';
  if (/^tests\/build\/(?:[\w.-]+\/)*[\w.-]+\.test\.ts$/u.test(path)) return 'contracts';
  const variant = /^tests\/e2e\/deterministic\/([\w-]+)\/(?:[\w.-]+\/)*[\w.-]+\.e2e\.ts$/u.exec(
    path,
  )?.[1];
  return browserVariants.find((name) => name === variant) ?? 'full';
}

export function pathsOutsideScope(cwd: string, scope: NarrowScope): string[] {
  const exclusions =
    scope === 'docs'
      ? [
          ...[...rootDocuments].map((file) => `:(top,exclude,literal)${file}`),
          ':(top,exclude,glob)docs/**/*.md',
        ]
      : [
          `:(top,exclude,glob)${
            scope === 'unit'
              ? 'tests/unit/**/*.test.ts'
              : scope === 'contracts'
                ? 'tests/build/**/*.test.ts'
                : `tests/e2e/deterministic/${scope}/**/*.e2e.ts`
          }`,
        ];
  // Compare the complete Git trees with independent pathspec exclusions.
  const unexpected = git(
    cwd,
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '--no-renames',
    '--ignore-submodules=none',
    '-r',
    '-z',
    'HEAD^1',
    'HEAD',
    '--',
    ...exclusions,
  );
  return unexpected.split('\0').slice(0, -1);
}

export function detectCiScope(
  cwd: string,
  eventName: string | undefined,
  eventPath: string | undefined,
  warn: (message: string) => void = console.warn,
): Scope {
  if (eventName !== 'pull_request') return 'full';
  let diff;
  try {
    diff = readPullRequestDiff(cwd, eventPath);
  } catch {
    warn('Could not establish the complete pull request change; running full verification.');
    return 'full';
  }
  if (!diff.endsWith('\0')) return 'full';
  const paths = diff.slice(0, -1).split('\0');
  const scope = scopeForPath(paths[0]);
  if (scope === 'full' || !paths.every((path) => scopeForPath(path) === scope)) return 'full';
  let unexpected;
  try {
    unexpected = pathsOutsideScope(cwd, scope);
  } catch {
    warn('Could not independently verify the Git trees; running full verification.');
    return 'full';
  }
  if (unexpected.length > 0)
    throw new Error(`CI scope ${scope} would omit changed files: ${JSON.stringify(unexpected)}`);
  return scope;
}

export function browserMatrix(scope: Scope) {
  return {
    include: browserVariants
      .filter((variant) => scope === 'full' || variant === scope)
      .flatMap((variant) => {
        const targets =
          variant === 'default'
            ? ['desktop', 'narrow', 'webkit']
            : [variant === 'production-path' ? 'desktop' : 'desktop,narrow,webkit'];
        return targets.map((target) => ({ variant, target }));
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scope = detectCiScope(
    process.cwd(),
    process.env.GITHUB_EVENT_NAME,
    process.env.GITHUB_EVENT_PATH,
  );
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `scope=${scope}\nbrowser_matrix=${JSON.stringify(browserMatrix(scope))}\n`,
  );
  console.log(`CI verification scope: ${scope}`);
}
