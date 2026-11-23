import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { baseForNewBranch } from '../../scripts/pre-push';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'pre-push-'));
  directories.push(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (file: string, content: string, message: string) => {
    writeFileSync(join(cwd, file), content);
    git('add', file);
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };

  git('init', '-b', 'main');
  git('config', 'user.name', 'Pre-push test');
  git('config', 'user.email', 'pre-push@example.invalid');
  git('config', 'commit.gpgsign', 'false');

  const base = commit('README.md', '# Base\n', 'chore: base');
  git('update-ref', 'refs/remotes/origin/main', base);
  git('update-ref', 'refs/remotes/origin/release', base);

  return { cwd, git, commit, base };
}

describe('pre-push new-branch base selection', () => {
  it('picks origin/main for a branch created from an ahead main', () => {
    const repo = createRepo();
    const mainHead = repo.commit('README.md', '# Main ahead\n', 'ci: update main');
    repo.git('update-ref', 'refs/remotes/origin/main', mainHead);
    repo.git('checkout', '-b', 'feat/demo');
    const topicHead = repo.commit('feature.txt', 'hello\n', 'feat: demo');

    expect(baseForNewBranch('origin', topicHead, repo.cwd)).toBe(mainHead);
  });

  it('picks origin/release for a branch created from an ahead release', () => {
    const repo = createRepo();
    const mainHead = repo.commit('README.md', '# Main ahead\n', 'ci: update main');
    repo.git('update-ref', 'refs/remotes/origin/main', mainHead);

    repo.git('checkout', '-b', 'release', repo.base);
    const releaseHead = repo.commit('post.md', '# Release post\n', 'content: add post');
    repo.git('update-ref', 'refs/remotes/origin/release', releaseHead);

    repo.git('checkout', '-b', 'hotfix/post-typo');
    const hotfixHead = repo.commit('post.md', '# Fixed post\n', 'content: fix typo');

    expect(baseForNewBranch('origin', hotfixHead, repo.cwd)).toBe(releaseHead);
  });

  it('falls back to the empty tree when neither remote tracking branch exists', () => {
    const repo = createRepo();
    const head = repo.commit('orphan.txt', 'data\n', 'chore: local');
    const emptyTree = repo.git('hash-object', '-t', 'tree', '--stdin');

    expect(baseForNewBranch('missing', head, repo.cwd)).toBe(emptyTree);
  });
});
