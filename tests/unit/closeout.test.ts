import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  readBranchDivergence,
  repositoryReady,
  releaseRunSnapshot,
  type ReleaseRun,
  type ReleaseJob,
} from '../../scripts/check-closeout';

const ready = {
  clean: true,
  localStable: true,
  branch: 'main',
  base: 'main',
  localBase: 'release-sha',
  remoteBefore: 'release-sha',
  remoteAfter: 'release-sha',
  mergeOnBase: true,
  pr: {
    number: 39,
    state: 'MERGED',
    url: '',
    baseRefName: 'main',
    headRefName: 'feature',
    headRefOid: 'squashed-sha',
    mergeCommit: { oid: 'feature-merge' },
  },
};

describe('closeout repository snapshot', () => {
  it('accepts a squash merge followed by a synchronized release commit', () => {
    expect(repositoryReady(ready)).toBe(true);
  });
  it.each([
    { localBase: 'feature-merge' },
    { remoteAfter: 'concurrent-merge' },
    { clean: false },
    { localStable: false },
    { branch: 'feature' },
    { mergeOnBase: false },
    { expectedAncestorOnBase: false },
    { pr: { ...ready.pr, state: 'CLOSED' } },
    { pr: { ...ready.pr, baseRefName: 'other' } },
  ])('rejects incomplete state %j', (change) => {
    expect(repositoryReady({ ...ready, ...change })).toBe(false);
  });
  it('accepts an explicit ancestor check when satisfied', () => {
    expect(repositoryReady({ ...ready, expectedAncestorOnBase: true })).toBe(true);
    expect(repositoryReady({ ...ready, expectedAncestorOnBase: null })).toBe(true);
  });
});

const candidateSha = 'a'.repeat(40);
const executionSha = 'b'.repeat(40);
const contentRun: ReleaseRun = {
  id: 123,
  run_attempt: 2,
  path: '.github/workflows/release.yml',
  event: 'workflow_dispatch',
  display_title: `content ${candidateSha}`,
  head_sha: executionSha,
  head_branch: 'release',
  status: 'completed',
  conclusion: 'failure',
  html_url: 'https://github.com/owner/repo/actions/runs/123',
};
const targetJob = (name: string, conclusion: string): ReleaseJob => ({
  name,
  status: 'completed',
  conclusion,
  html_url: `https://github.com/owner/repo/actions/jobs/${name}`,
  steps: [
    { name: 'Deploy', status: 'completed', conclusion: 'success' },
    { name: 'Smoke', status: 'completed', conclusion },
  ],
});

describe('explicit release run snapshot', () => {
  it('separates dispatch candidate from workflow execution source and preserves target smoke evidence', () => {
    const jobs = [
      targetJob('prepare', 'success'),
      targetJob('pages', 'success'),
      targetJob('mirror', 'success'),
      targetJob('workers', 'failure'),
    ];
    const snapshot = releaseRunSnapshot(contentRun, jobs);
    expect(snapshot.candidate).toEqual({
      kind: 'content',
      sha: candidateSha,
      identitySource: 'workflow run-name',
    });
    expect(snapshot.executionSha).toBe(executionSha);
    expect(snapshot.pages?.conclusion).toBe('success');
    expect(snapshot.mirror?.conclusion).toBe('success');
    expect(snapshot.workers?.steps?.[1]?.conclusion).toBe('failure');
    expect(snapshot.run.run_attempt).toBe(2);
  });

  it('does not turn missing or skipped target jobs into success', () => {
    const snapshot = releaseRunSnapshot(contentRun, [targetJob('pages', 'skipped')]);
    expect(snapshot.preparation).toBeNull();
    expect(snapshot.pages?.conclusion).toBe('skipped');
    expect(snapshot.mirror).toBeNull();
    expect(snapshot.workers).toBeNull();
  });

  it('accepts fixed software identity on push to release', () => {
    const snapshot = releaseRunSnapshot(
      { ...contentRun, event: 'push', display_title: `software ${candidateSha}` },
      [],
    );
    expect(snapshot.candidate.kind).toBe('software');
    expect(snapshot.candidate.sha).toBe(candidateSha);
  });

  it.each([
    { path: '.github/workflows/ci.yml' },
    { display_title: 'content main' },
    { display_title: `software ${candidateSha}` },
    { head_branch: 'main' },
    { event: 'push' },
    { event: 'pull_request', display_title: `software ${candidateSha}` },
    { run_attempt: 0 },
  ])('rejects an unrecognized or mismatched run identity %j', (change) => {
    expect(() => releaseRunSnapshot({ ...contentRun, ...change }, [])).toThrow();
  });

  it('rejects ambiguous jobs rather than selecting a successful duplicate', () => {
    expect(() =>
      releaseRunSnapshot(contentRun, [
        targetJob('pages', 'success'),
        targetJob('pages', 'failure'),
      ]),
    ).toThrow('Ambiguous');
  });
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('local main/release divergence snapshot', () => {
  it('counts commits on each side when both local branches exist and returns null otherwise', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'closeout-div-'));
    tempDirs.push(cwd);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const commit = (file: string, content: string, message: string) => {
      writeFileSync(join(cwd, file), content);
      git('add', file);
      git('commit', '-m', message);
    };

    git('init', '-b', 'main');
    git('config', 'user.name', 'Closeout test');
    git('config', 'user.email', 'closeout@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    commit('README.md', '# Base\n', 'chore: base');

    expect(readBranchDivergence(cwd)).toBeNull();

    git('branch', 'release');
    commit('a.txt', '1\n', 'ci: one');
    commit('b.txt', '2\n', 'ci: two');
    git('checkout', 'release');
    commit('c.txt', '3\n', 'chore(release): release 1.0.1');

    expect(readBranchDivergence(cwd)).toEqual({
      mainAheadOfRelease: 2,
      releaseAheadOfMain: 1,
    });
  });
});
