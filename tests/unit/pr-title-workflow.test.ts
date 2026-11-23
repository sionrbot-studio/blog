import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vite-plus/test';

const workflow = readFileSync(
  new URL('../../.github/workflows/pr-title.yml', import.meta.url),
  'utf8',
);
const scriptBlock = workflow
  .split('          script: |\n')[1]!
  .split('\n')
  .map((line) => line.replace(/^            /, ''))
  .join('\n');

const sha = 'a'.repeat(40);
const versionBranch = 'release-please--branches--release--components--sionrbot-blog';

async function runTitleScript(options: {
  eventName: 'pull_request' | 'merge_group';
  pullRequest?: { title: string; baseRef: string; headRef: string };
  queuedPrs?: { headSha: string; number: number; title: string; headRefName: string }[];
}) {
  const failures: string[] = [];
  const core = {
    info: vi.fn(),
    setFailed: (message: string) => failures.push(message),
  };
  const github = {
    graphql: vi.fn(async () => ({
      repository: {
        mergeQueue: {
          entries: {
            nodes: (options.queuedPrs ?? []).map((entry) => ({
              headCommit: { oid: entry.headSha },
              pullRequest: {
                number: entry.number,
                title: entry.title,
                headRefName: entry.headRefName,
              },
            })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    })),
  };
  const context = {
    eventName: options.eventName,
    sha,
    repo: { owner: 'owner', repo: 'blog' },
    payload:
      options.eventName === 'merge_group'
        ? { merge_group: { base_ref: 'refs/heads/main', head_sha: sha } }
        : {
            pull_request: {
              title: options.pullRequest!.title,
              base: { ref: options.pullRequest!.baseRef },
              head: { ref: options.pullRequest!.headRef },
            },
          },
  };

  await (runInNewContext(`(async () => {\n${scriptBlock}\n})()`, {
    github,
    context,
    core,
  }) as Promise<void>);
  return { failures };
}

describe('PR title and Merge Queue policy', () => {
  it('blocks back-merge PRs from entering the main squash merge queue', async () => {
    for (const queued of [
      {
        headSha: sha,
        number: 141,
        title: 'chore(release): back-merge v1.10.2',
        headRefName: 'release',
      },
      {
        headSha: sha,
        number: 142,
        title: 'chore(release): back-merge conflict fix',
        headRefName: 'back-merge/v1.10.2',
      },
      {
        headSha: sha,
        number: 143,
        title: 'chore: back-merge release records',
        headRefName: 'chore/sync',
      },
    ]) {
      const { failures } = await runTitleScript({
        eventName: 'merge_group',
        queuedPrs: [queued],
      });
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('squash merge queue');
    }
  });

  it('allows normal Conventional Commit PRs in the main merge queue', async () => {
    const { failures } = await runTitleScript({
      eventName: 'merge_group',
      queuedPrs: [
        {
          headSha: sha,
          number: 150,
          title: 'feat: add reading time',
          headRefName: 'feat/reading-time',
        },
      ],
    });
    expect(failures).toEqual([]);
  });

  it('enforces standardized titles for promote/*, content/*, version, and back-merge PRs', async () => {
    const valid = [
      {
        title: 'chore(release): promote search fix',
        baseRef: 'release',
        headRef: 'promote/search',
      },
      { title: 'content: publish new essay', baseRef: 'release', headRef: 'content/new-essay' },
      { title: 'content(blog): update about page', baseRef: 'release', headRef: 'content/about' },
      { title: 'chore(release): release 1.11.0', baseRef: 'release', headRef: versionBranch },
      { title: 'fix(search): hotfix scroll lock', baseRef: 'release', headRef: 'hotfix/scroll' },
      { title: 'chore(release): back-merge v1.11.0 records', baseRef: 'main', headRef: 'release' },
      {
        title: 'chore(release): back-merge v1.11.0 records',
        baseRef: 'main',
        headRef: 'back-merge/v1.11.0',
      },
    ];
    for (const pullRequest of valid) {
      expect((await runTitleScript({ eventName: 'pull_request', pullRequest })).failures).toEqual(
        [],
      );
    }

    const invalid = [
      { title: 'chore: promote search fix', baseRef: 'release', headRef: 'promote/search' },
      { title: 'feat: promote search fix', baseRef: 'release', headRef: 'promote/search' },
      { title: 'feat: add article', baseRef: 'release', headRef: 'content/new-essay' },
      { title: 'content!: breaking article', baseRef: 'release', headRef: 'content/new-essay' },
      { title: 'chore: release 1.11.0', baseRef: 'release', headRef: versionBranch },
      { title: 'chore: back-merge v1.11.0', baseRef: 'main', headRef: 'release' },
      { title: 'chore: back-merge v1.11.0', baseRef: 'main', headRef: 'back-merge/v1.11.0' },
    ];
    for (const pullRequest of invalid) {
      expect(
        (await runTitleScript({ eventName: 'pull_request', pullRequest })).failures.length,
      ).toBeGreaterThan(0);
    }
  });
});
