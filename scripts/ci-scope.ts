import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const rootDocuments = new Set(['README.md', 'AGENTS.md', 'GLOSSARY.md', 'THIRD-PARTY-NOTICES.md']);
const releaseMetaFiles = new Set(['package.json', '.release-please-manifest.json', 'CHANGELOG.md']);
const releaseVersionBranch = 'release-please--branches--release--components--sionrbot-blog';
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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
type NarrowScope = 'docs' | 'unit' | 'release-meta' | 'contracts' | BrowserVariant;
type Scope = 'full' | NarrowScope;

interface PullRequestMetadata {
  base?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } };
  head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } };
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', `safe.directory=${realpathSync(cwd)}`, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function readPullRequestContext(
  cwd: string,
  eventPath: string | undefined,
): { diff: string; pullRequest: PullRequestMetadata } {
  if (!eventPath) throw new Error('Missing pull request event');
  const event = JSON.parse(readFileSync(eventPath, 'utf8')) as {
    pull_request?: PullRequestMetadata;
  } | null;
  const pullRequest = event?.pull_request;
  const base = pullRequest?.base?.sha;
  const head = pullRequest?.head?.sha;
  if (
    !pullRequest ||
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
  const diff = git(
    cwd,
    'diff',
    '--name-only',
    '--no-renames',
    '--ignore-submodules=none',
    '-z',
    'HEAD^1',
    'HEAD',
    '--',
  );
  return { diff, pullRequest };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStrictReleaseMetaChange(
  cwd: string,
  pullRequest: PullRequestMetadata,
  paths: string[],
): boolean {
  const baseRepo = pullRequest.base?.repo?.full_name;
  const headRepo = pullRequest.head?.repo?.full_name;
  if (
    pullRequest.base?.ref !== 'release' ||
    pullRequest.head?.ref !== releaseVersionBranch ||
    typeof baseRepo !== 'string' ||
    !baseRepo ||
    baseRepo !== headRepo ||
    paths.length === 0 ||
    !paths.every((path) => releaseMetaFiles.has(path))
  ) {
    return false;
  }

  try {
    const beforePkg: unknown = JSON.parse(git(cwd, 'show', 'HEAD^1:package.json'));
    const afterPkg: unknown = JSON.parse(git(cwd, 'show', 'HEAD:package.json'));
    const beforeManifest: unknown = JSON.parse(
      git(cwd, 'show', 'HEAD^1:.release-please-manifest.json'),
    );
    const afterManifest: unknown = JSON.parse(
      git(cwd, 'show', 'HEAD:.release-please-manifest.json'),
    );
    if (
      !isPlainObject(beforePkg) ||
      !isPlainObject(afterPkg) ||
      !isPlainObject(beforeManifest) ||
      !isPlainObject(afterManifest)
    ) {
      return false;
    }
    if (typeof afterPkg.version !== 'string' || !stableVersion.test(afterPkg.version)) return false;
    if (afterManifest['.'] !== afterPkg.version) return false;

    const omit = (record: Record<string, unknown>, key: string) => {
      const copy = { ...record };
      delete copy[key];
      return copy;
    };
    return (
      isDeepStrictEqual(omit(beforePkg, 'version'), omit(afterPkg, 'version')) &&
      isDeepStrictEqual(omit(beforeManifest, '.'), omit(afterManifest, '.'))
    );
  } catch {
    return false;
  }
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
      : scope === 'release-meta'
        ? [...releaseMetaFiles].map((file) => `:(top,exclude,literal)${file}`)
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
  let context;
  try {
    context = readPullRequestContext(cwd, eventPath);
  } catch {
    warn('Could not establish the complete pull request change; running full verification.');
    return 'full';
  }
  const { diff, pullRequest } = context;
  if (!diff.endsWith('\0')) return 'full';
  const paths = diff.slice(0, -1).split('\0');
  let scope: Scope = isStrictReleaseMetaChange(cwd, pullRequest, paths)
    ? 'release-meta'
    : scopeForPath(paths[0]);
  if (
    scope !== 'release-meta' &&
    (scope === 'full' || !paths.every((path) => scopeForPath(path) === scope))
  ) {
    scope = 'full';
  }
  if (scope === 'full') return 'full';
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
