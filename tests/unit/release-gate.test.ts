import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  classifyReleaseHeadBranch,
  evaluateBranchGate,
  isBackMergeHeadBranch,
  isReleasableCommitMessage,
  releaseGateApi,
  releaseVersionBranch,
  type ReleaseGateApi,
} from '../../scripts/release-gate';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createRepo(version = '1.10.2') {
  const cwd = mkdtempSync(join(tmpdir(), 'release-gate-'));
  directories.push(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };

  git('init', '-b', 'main');
  git('config', 'user.name', 'Release gate test');
  git('config', 'user.email', 'release-gate@example.invalid');
  git('config', 'commit.gpgsign', 'false');

  put('package.json', JSON.stringify({ name: 'blog', version }) + '\n');
  put('.release-please-manifest.json', JSON.stringify({ '.': version }) + '\n');
  put('src/content/pages/about.mdx', 'About\n');
  put('src/config.ts', 'export const site = {};\n');
  const tagSha = commit(`chore(release): release ${version}`);
  git('branch', 'release');

  const simulatePrMerge = (baseBranch: string, headBranch: string) => {
    const baseSha = git('rev-parse', baseBranch);
    const headSha = git('rev-parse', headBranch);
    git('checkout', '--detach', baseSha);
    git('merge', '--no-ff', headSha, '-m', `Merge ${headBranch} into ${baseBranch}`);
    return {
      pull_request: {
        number: 200,
        base: { ref: baseBranch, sha: baseSha, repo: { full_name: 'owner/blog' } },
        head: { ref: headBranch, sha: headSha, repo: { full_name: 'owner/blog' } },
      },
    };
  };

  const makeApi = (overrides: Partial<ReleaseGateApi> = {}): ReleaseGateApi => ({
    branchHead: async () => git('rev-parse', 'release'),
    latest: async () => ({ tag_name: `v${version}`, draft: false, prerelease: false }),
    tagCommit: async (tag) => (tag === `v${version}` ? tagSha : null),
    hasPendingReleasePr: async () => false,
    ...overrides,
  });

  return { cwd, git, put, commit, tagSha, simulatePrMerge, makeApi };
}

describe('branch name and commit classification', () => {
  it('classifies allowed release head branches and rejects unsafe or unrelated names', () => {
    expect(classifyReleaseHeadBranch(releaseVersionBranch)).toBe('version');
    expect(classifyReleaseHeadBranch('promote/2026-11-23')).toBe('promote');
    expect(classifyReleaseHeadBranch('content/new-post')).toBe('content');
    expect(classifyReleaseHeadBranch('hotfix/search-scroll')).toBe('hotfix');
    for (const invalid of [
      'main',
      'feat/search',
      'promote/',
      'promote/../main',
      'content/post.lock',
      'hotfix/',
    ]) {
      expect(classifyReleaseHeadBranch(invalid)).toBeNull();
    }
    expect(isBackMergeHeadBranch('release')).toBe(true);
    expect(isBackMergeHeadBranch('back-merge/v1.10.2')).toBe(true);
    expect(isBackMergeHeadBranch('back-merge/../release')).toBe(false);
    expect(isBackMergeHeadBranch('chore/back-merge')).toBe(false);
  });

  it('recognizes commits that trigger a software release version bump', () => {
    expect(isReleasableCommitMessage('feat: add article search')).toBe(true);
    expect(isReleasableCommitMessage('fix(search): lock backdrop scroll')).toBe(true);
    expect(isReleasableCommitMessage('perf: cache pagefind index')).toBe(true);
    expect(isReleasableCommitMessage('revert: revert broken change')).toBe(true);
    expect(isReleasableCommitMessage('chore!: drop Node 22')).toBe(true);
    expect(isReleasableCommitMessage('refactor: reshape config\n\nBREAKING CHANGE: new key')).toBe(
      true,
    );
    expect(isReleasableCommitMessage('ci: parallelize browser tests')).toBe(false);
    expect(isReleasableCommitMessage('chore(deps): bump lucide')).toBe(false);
    expect(isReleasableCommitMessage('content: publish freedom article')).toBe(false);
    expect(isReleasableCommitMessage('docs: update releasing guide')).toBe(false);
  });
});

describe('release branch gate', () => {
  it('accepts direct content/* PRs on release even while main holds unrelated ci/chore commits', async () => {
    const repo = createRepo();
    repo.put('src/config.ts', 'export const site = { ci: true };\n');
    repo.commit('ci: update workflow on main');

    repo.git('checkout', '-b', 'content/new-article', 'release');
    repo.put('src/content/blog/hello.mdx', '---\ntitle: Hello\n---\nBody\n');
    repo.commit('content: publish hello article');

    const event = repo.simulatePrMerge('release', 'content/new-article');
    await expect(
      evaluateBranchGate({
        cwd: repo.cwd,
        repository: 'owner/blog',
        event,
        api: repo.makeApi(),
      }),
    ).resolves.toEqual({
      kind: 'content',
      version: '1.10.2',
      baselineTag: 'v1.10.2',
      baselineSha: repo.tagSha,
    });
  });

  it('rejects content/* PRs that touch files outside the content allowlist', async () => {
    const repo = createRepo();
    repo.git('checkout', '-b', 'content/sneaky', 'release');
    repo.put('src/content/blog/hello.mdx', '# Hello\n');
    repo.put('src/config.ts', 'export const site = { changed: true };\n');
    repo.commit('content: article plus config change');

    const event = repo.simulatePrMerge('release', 'content/sneaky');
    await expect(
      evaluateBranchGate({
        cwd: repo.cwd,
        repository: 'owner/blog',
        event,
        api: repo.makeApi(),
      }),
    ).rejects.toThrow('src/config.ts');
  });

  it('rejects engineering-only promote/* batches without any releasable commit (preventing #113)', async () => {
    const repo = createRepo();
    repo.put('src/config.ts', 'export const site = { tooling: 1 };\n');
    repo.commit('chore(tooling): upgrade vite-plus');
    repo.git('branch', 'promote/tooling-only', 'main');

    const event = repo.simulatePrMerge('release', 'promote/tooling-only');
    await expect(
      evaluateBranchGate({
        cwd: repo.cwd,
        repository: 'owner/blog',
        event,
        api: repo.makeApi(),
      }),
    ).rejects.toThrow('without any releasable commit');
  });

  it('accepts promote/* batches with a releasable software commit or pure content changes', async () => {
    const softwareRepo = createRepo();
    softwareRepo.put('src/config.ts', 'export const site = { fixed: true };\n');
    softwareRepo.commit('fix(search): restore focus');
    softwareRepo.git('branch', 'promote/search-fix', 'main');
    const softwareEvent = softwareRepo.simulatePrMerge('release', 'promote/search-fix');
    await expect(
      evaluateBranchGate({
        cwd: softwareRepo.cwd,
        repository: 'owner/blog',
        event: softwareEvent,
        api: softwareRepo.makeApi(),
      }),
    ).resolves.toMatchObject({ kind: 'promote', mode: 'software', version: '1.10.2' });

    const contentRepo = createRepo();
    contentRepo.put('src/content/blog/pure.mdx', '# Pure\n');
    contentRepo.commit('content: add pure article');
    contentRepo.git('branch', 'promote/pure-content', 'main');
    const contentEvent = contentRepo.simulatePrMerge('release', 'promote/pure-content');
    await expect(
      evaluateBranchGate({
        cwd: contentRepo.cwd,
        repository: 'owner/blog',
        event: contentEvent,
        api: contentRepo.makeApi(),
      }),
    ).resolves.toMatchObject({ kind: 'promote', mode: 'content', version: '1.10.2' });
  });

  it('rejects promote/* when release has un-back-merged commits', async () => {
    const repo = createRepo();
    repo.git('checkout', 'release');
    repo.put('src/content/blog/on-release.mdx', '# Direct\n');
    repo.commit('content: direct release post');

    repo.git('checkout', 'main');
    repo.put('src/config.ts', 'export const site = { feat: true };\n');
    repo.commit('feat: new feature');
    repo.git('branch', 'promote/missing-back-merge', 'main');

    const event = repo.simulatePrMerge('release', 'promote/missing-back-merge');
    await expect(
      evaluateBranchGate({
        cwd: repo.cwd,
        repository: 'owner/blog',
        event,
        api: repo.makeApi(),
      }),
    ).rejects.toThrow('back-merge release into main before promoting');
  });

  it('blocks non-version PRs into release while an autorelease: pending PR remains', async () => {
    const repo = createRepo();
    repo.git('checkout', '-b', 'content/during-pending', 'release');
    repo.put('src/content/blog/p.mdx', '# Pending\n');
    repo.commit('content: during pending');

    const event = repo.simulatePrMerge('release', 'content/during-pending');
    await expect(
      evaluateBranchGate({
        cwd: repo.cwd,
        repository: 'owner/blog',
        event,
        api: repo.makeApi({ hasPendingReleasePr: async () => true }),
      }),
    ).rejects.toThrow('autorelease: pending');
  });

  it('allows hotfix/* during retired-candidate recovery when manifest exceeds latest public release', async () => {
    const repo = createRepo('1.10.2');
    repo.git('checkout', 'release');
    repo.put('package.json', JSON.stringify({ name: 'blog', version: '1.10.3' }) + '\n');
    repo.put('.release-please-manifest.json', JSON.stringify({ '.': '1.10.3' }) + '\n');
    repo.commit('chore(release): release 1.10.3 (retired)');

    repo.git('checkout', '-b', 'hotfix/recover-1103', 'release');
    repo.put('src/config.ts', 'export const site = { repaired: true };\n');
    repo.commit('fix: repair retired candidate');

    const event = repo.simulatePrMerge('release', 'hotfix/recover-1103');
    await expect(
      evaluateBranchGate({
        cwd: repo.cwd,
        repository: 'owner/blog',
        event,
        api: repo.makeApi(),
      }),
    ).resolves.toMatchObject({
      kind: 'hotfix',
      mode: 'software',
      version: '1.10.3',
      baselineTag: 'v1.10.2',
    });
  });

  it('validates version PRs and rejects arbitrary branches targeting release', async () => {
    const repo = createRepo();
    repo.git('checkout', '-b', releaseVersionBranch, 'release');
    repo.put('package.json', JSON.stringify({ name: 'blog', version: '1.10.3' }) + '\n');
    repo.put('.release-please-manifest.json', JSON.stringify({ '.': '1.10.3' }) + '\n');
    repo.commit('chore(release): release 1.10.3');

    const versionEvent = repo.simulatePrMerge('release', releaseVersionBranch);
    await expect(
      evaluateBranchGate({
        cwd: repo.cwd,
        repository: 'owner/blog',
        event: versionEvent,
        api: repo.makeApi(),
      }),
    ).resolves.toEqual({ kind: 'version', version: '1.10.3' });

    repo.git('checkout', '-b', 'feat/rogue', 'release');
    repo.put('src/config.ts', 'export const rogue = true;\n');
    repo.commit('feat: rogue');
    const rogueEvent = repo.simulatePrMerge('release', 'feat/rogue');
    await expect(
      evaluateBranchGate({
        cwd: repo.cwd,
        repository: 'owner/blog',
        event: rogueEvent,
        api: repo.makeApi(),
      }),
    ).rejects.toThrow('cannot target release');
  });

  it('verifies back-merge PRs into main include live release HEAD', async () => {
    const repo = createRepo();
    repo.git('checkout', 'release');
    repo.put('src/content/blog/direct.mdx', '# Direct\n');
    const releaseHead = repo.commit('content: direct');

    const directEvent = repo.simulatePrMerge('main', 'release');
    await expect(
      evaluateBranchGate({
        cwd: repo.cwd,
        repository: 'owner/blog',
        event: directEvent,
        api: repo.makeApi({ branchHead: async () => releaseHead }),
      }),
    ).resolves.toEqual({ kind: 'back-merge', releaseHead });

    repo.git('checkout', '-b', 'back-merge/stale', repo.tagSha);
    repo.put('README.md', '# Stale\n');
    repo.commit('chore(release): back-merge stale');
    const staleEvent = repo.simulatePrMerge('main', 'back-merge/stale');
    await expect(
      evaluateBranchGate({
        cwd: repo.cwd,
        repository: 'owner/blog',
        event: staleEvent,
        api: repo.makeApi({ branchHead: async () => releaseHead }),
      }),
    ).rejects.toThrow('does not contain live release HEAD');
  });
});

describe('release gate GitHub API client', () => {
  it('only flags merged release PRs with autorelease: pending', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith('/issues')) {
        return Response.json([
          { number: 1, pull_request: {} },
          { number: 2, pull_request: {} },
        ]);
      }
      if (url.pathname.endsWith('/pulls/1')) {
        return Response.json({
          merged: false,
          base: { ref: 'release' },
          labels: [{ name: 'autorelease: pending' }],
        });
      }
      if (url.pathname.endsWith('/pulls/2')) {
        return Response.json({
          merged: true,
          base: { ref: 'release' },
          labels: [{ name: 'autorelease: pending' }],
        });
      }
      throw new Error(`Unexpected path: ${url.pathname}`);
    });
    const client = releaseGateApi('owner/blog', 'token', fetcher);
    await expect(client.hasPendingReleasePr()).resolves.toBe(true);
  });
});
