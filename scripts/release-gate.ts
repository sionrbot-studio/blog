import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkContentHistory } from './release-content.ts';

export const releaseVersionBranch = 'release-please--branches--release--components--sionrbot-blog';

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const fullSha = /^[a-f0-9]{40}$/;
const releasableHeader = /^(feat|fix|perf|revert)(\([^()\r\n]+\))?!?: \S/u;
const breakingHeader =
  /^(feat|fix|perf|revert|content|docs|chore|test|ci|build|refactor|style)(\([^()\r\n]+\))?!: \S/u;
const breakingFooter = /^BREAKING[ -]CHANGE:\s*\S/m;

export interface GatePullRequestEvent {
  pull_request?: {
    number?: number;
    base?: { ref?: string; sha?: string; repo?: { full_name?: string } };
    head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
  };
}

export interface ReleaseGateApi {
  branchHead(): Promise<string>;
  latest(): Promise<{ tag_name: string; draft: boolean; prerelease: boolean } | null>;
  tagCommit(tag: string): Promise<string | null>;
  hasPendingReleasePr(): Promise<boolean>;
}

export type ReleaseHeadKind = 'version' | 'promote' | 'content' | 'hotfix';

export type BranchGateOutcome =
  | { kind: 'version'; version: string }
  | { kind: 'content'; version: string; baselineTag: string; baselineSha: string }
  | {
      kind: 'promote' | 'hotfix';
      mode: 'content' | 'software';
      version: string;
      baselineTag: string;
      baselineSha: string;
    }
  | { kind: 'back-merge'; releaseHead: string };

function isSafeBranchSegments(suffix: string, allowDots: boolean): boolean {
  if (!suffix || suffix.includes('..') || suffix.endsWith('.lock')) return false;
  const segmentPattern = allowDots
    ? /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/
    : /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/;
  return segmentPattern.test(suffix);
}

export function classifyReleaseHeadBranch(headRef: string): ReleaseHeadKind | null {
  if (headRef === releaseVersionBranch) return 'version';
  if (
    headRef.startsWith('promote/') &&
    isSafeBranchSegments(headRef.slice('promote/'.length), false)
  )
    return 'promote';
  if (
    headRef.startsWith('content/') &&
    isSafeBranchSegments(headRef.slice('content/'.length), true)
  )
    return 'content';
  if (headRef.startsWith('hotfix/') && isSafeBranchSegments(headRef.slice('hotfix/'.length), true))
    return 'hotfix';
  return null;
}

export function isBackMergeHeadBranch(headRef: string): boolean {
  if (headRef === 'release') return true;
  return (
    headRef.startsWith('back-merge/') &&
    isSafeBranchSegments(headRef.slice('back-merge/'.length), true)
  );
}

export function isReleasableCommitMessage(message: string): boolean {
  const header = message.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return (
    releasableHeader.test(header) || breakingHeader.test(header) || breakingFooter.test(message)
  );
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', `safe.directory=${realpathSync(cwd)}`, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    git(cwd, 'merge-base', '--is-ancestor', ancestor, descendant);
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

export function hasReleasableCommit(cwd: string, baselineSha: string, tipSha: string): boolean {
  if (!fullSha.test(baselineSha) || !fullSha.test(tipSha)) {
    throw new Error('Releasability check requires complete commit SHAs');
  }
  if (!isAncestor(cwd, baselineSha, tipSha)) {
    throw new Error(`Software baseline ${baselineSha} is not an ancestor of ${tipSha}`);
  }
  const raw = git(cwd, 'log', '--format=%B%x00', `${baselineSha}..${tipSha}`);
  if (!raw) return false;
  return raw
    .split('\0')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some(isReleasableCommitMessage);
}

async function readAgreedVersion(cwd: string): Promise<string> {
  const [pkgRaw, manifestRaw] = await Promise.all([
    readFile(join(cwd, 'package.json'), 'utf8'),
    readFile(join(cwd, '.release-please-manifest.json'), 'utf8'),
  ]);
  const version = (JSON.parse(pkgRaw) as { version?: unknown }).version;
  const manifestVersion = (JSON.parse(manifestRaw) as Record<string, unknown>)['.'];
  if (typeof version !== 'string' || !stableVersion.test(version) || manifestVersion !== version) {
    throw new Error(
      'package.json and .release-please-manifest.json must agree on a stable version',
    );
  }
  return version;
}

export async function evaluateBranchGate(options: {
  cwd: string;
  repository: string;
  event: GatePullRequestEvent;
  api: ReleaseGateApi;
}): Promise<BranchGateOutcome> {
  const { cwd, repository, event, api } = options;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('Invalid repository');
  }
  const pr = event.pull_request;
  const baseRef = pr?.base?.ref;
  const headRef = pr?.head?.ref;
  const baseSha = pr?.base?.sha;
  const headSha = pr?.head?.sha;
  if (
    !baseRef ||
    !headRef ||
    !baseSha ||
    !headSha ||
    !fullSha.test(baseSha) ||
    !fullSha.test(headSha) ||
    pr?.base?.repo?.full_name !== repository ||
    pr?.head?.repo?.full_name !== repository
  ) {
    throw new Error('Branch gate requires a same-repository pull request with complete SHAs');
  }

  const parents = git(cwd, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ');
  const mergeHead = parents[0];
  if (parents.length !== 3 || !mergeHead || parents[1] !== baseSha || parents[2] !== headSha) {
    throw new Error('Checkout must match the pull request merge commit');
  }

  if (baseRef === 'main') {
    if (!isBackMergeHeadBranch(headRef)) {
      throw new Error(`Branch gate should not run for non-back-merge PR ${headRef} -> main`);
    }
    const releaseHead = await api.branchHead();
    if (!fullSha.test(releaseHead)) {
      throw new Error('Invalid live release branch head');
    }
    if (!isAncestor(cwd, releaseHead, headSha)) {
      throw new Error(
        `Back-merge branch ${headRef} does not contain live release HEAD ${releaseHead}; update it from release instead of merging main into release`,
      );
    }
    return { kind: 'back-merge', releaseHead };
  }

  if (baseRef !== 'release') {
    throw new Error(`Unsupported branch gate target: ${baseRef}`);
  }

  const headKind = classifyReleaseHeadBranch(headRef);
  if (!headKind) {
    throw new Error(
      `Branch ${headRef} cannot target release; use promote/*, content/*, hotfix/*, or the Release Please version PR branch`,
    );
  }

  const version = await readAgreedVersion(cwd);
  if (headKind === 'version') {
    return { kind: 'version', version };
  }

  if (await api.hasPendingReleasePr()) {
    throw new Error(
      'A merged version PR on release still carries autorelease: pending; finish publication or retire it before merging new changes into release',
    );
  }

  const latest = await api.latest();
  if (!latest || latest.draft || latest.prerelease) {
    throw new Error('A public stable software Release baseline is required on release');
  }
  const tagSha = await api.tagCommit(latest.tag_name);
  if (!tagSha || !fullSha.test(tagSha)) {
    throw new Error(`Baseline tag ${latest.tag_name} does not resolve to a commit`);
  }

  if ((headKind === 'content' || headKind === 'promote') && latest.tag_name !== `v${version}`) {
    throw new Error(
      `Version files (${version}) do not match latest public stable Release (${latest.tag_name}); complete software recovery before merging ${headKind} changes`,
    );
  }

  if (headKind === 'content') {
    checkContentHistory(cwd, tagSha, mergeHead);
    return { kind: 'content', version, baselineTag: latest.tag_name, baselineSha: tagSha };
  }

  if (headKind === 'promote' && !isAncestor(cwd, baseSha, headSha)) {
    throw new Error(
      `Promotion branch ${headRef} does not include current release HEAD ${baseSha}; back-merge release into main before promoting`,
    );
  }

  let contentEligible = false;
  let contentError: string | null = null;
  try {
    checkContentHistory(cwd, tagSha, mergeHead);
    contentEligible = true;
  } catch (error) {
    contentError = error instanceof Error ? error.message : String(error);
  }

  if (contentEligible) {
    return {
      kind: headKind,
      mode: 'content',
      version,
      baselineTag: latest.tag_name,
      baselineSha: tagSha,
    };
  }

  if (hasReleasableCommit(cwd, tagSha, headSha)) {
    return {
      kind: headKind,
      mode: 'software',
      version,
      baselineTag: latest.tag_name,
      baselineSha: tagSha,
    };
  }

  throw new Error(
    `${headKind} PR contains non-content changes (${contentError ?? 'outside content scope'}) without any releasable commit (feat, fix, perf, revert, or breaking change). Keep engineering-only changes on main until paired with a releasable software change, or publish articles via content/* from release.`,
  );
}

export function releaseGateApi(repository: string, token: string, fetcher = fetch): ReleaseGateApi {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');

  async function request<T>(path: string, missing = false): Promise<T | null> {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub GET ${path}: ${response.status}`);
    return (await response.json()) as T;
  }

  async function required<T>(path: string): Promise<T> {
    const value = await request<T>(path);
    if (value === null) throw new Error(`Missing GitHub response: ${path}`);
    return value;
  }

  return {
    async branchHead() {
      const ref = await required<{ object: { type: string; sha: string } }>(
        'git/ref/heads/release',
      );
      if (ref.object.type !== 'commit' || !fullSha.test(ref.object.sha)) {
        throw new Error('Invalid release branch head');
      }
      return ref.object.sha;
    },
    latest: () => request('releases/latest', true),
    async tagCommit(tag) {
      type GitObject = { type: string; sha: string };
      const ref = await request<{ object: GitObject }>(
        `git/ref/tags/${encodeURIComponent(tag)}`,
        true,
      );
      let object = ref?.object;
      const seen = new Set<string>();
      while (object?.type === 'tag') {
        if (seen.has(object.sha)) throw new Error('Cyclic tag');
        seen.add(object.sha);
        object = (await required<{ object: GitObject }>(`git/tags/${object.sha}`)).object;
      }
      if (object && object.type !== 'commit') throw new Error('Tag does not resolve to commit');
      return object?.sha ?? null;
    },
    async hasPendingReleasePr() {
      const issues = await required<
        { number: number; pull_request?: Record<string, unknown>; labels?: { name: string }[] }[]
      >('issues?state=closed&labels=autorelease%3A%20pending&per_page=100');
      for (const issue of issues) {
        if (!issue.pull_request) continue;
        const pr = await required<{
          merged: boolean;
          base: { ref: string };
          labels: { name: string }[];
        }>(`pulls/${issue.number}`);
        if (
          pr.merged &&
          pr.base.ref === 'release' &&
          pr.labels.some(({ name }) => name === 'autorelease: pending')
        ) {
          return true;
        }
      }
      return false;
    },
  };
}

async function main(): Promise<void> {
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_TOKEN: token,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: eventName,
  } = process.env;
  if (eventName !== 'pull_request') {
    throw new Error('Branch gate only validates pull_request events');
  }
  if (!repository || !token || !eventPath) {
    throw new Error('GITHUB_REPOSITORY, GITHUB_TOKEN and GITHUB_EVENT_PATH are required');
  }
  const event = JSON.parse(await readFile(eventPath, 'utf8')) as GatePullRequestEvent;
  const outcome = await evaluateBranchGate({
    cwd: process.cwd(),
    repository,
    event,
    api: releaseGateApi(repository, token),
  });
  console.log(JSON.stringify(outcome));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
