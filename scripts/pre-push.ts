import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
const isZeroOid = (oid: string) => /^0+$/.test(oid);

function baseForNewBranch(remote: string, oid: string) {
  const upstream = `refs/remotes/${remote}/main`;
  const base = spawnSync('git', ['merge-base', upstream, oid], { encoding: 'utf8' });
  if (base.error) throw base.error;
  return base.status === 0
    ? base.stdout.trim()
    : git('hash-object', '-t', 'tree', '--stdin').trim();
}

function run(...args: string[]) {
  const result = spawnSync('vp', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const [remote] = process.argv.slice(2);
const changes = new Set<string>();
for (const update of readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)) {
  const [, oid, target, previous] = update.split(' ');
  if (!target.startsWith('refs/heads/') || isZeroOid(oid)) continue;

  const base = isZeroOid(previous) ? baseForNewBranch(remote, oid) : previous;
  const files = git('diff', '--name-only', '-z', '--diff-filter=ACMRT', base, oid, '--')
    .split('\0')
    .filter(Boolean);
  if (files.length === 0) continue;

  // Tools read the working tree. Verify it represents the commit that will be pushed.
  const pushedTree = git('rev-parse', `${oid}^{tree}`).trim();
  if (pushedTree !== git('rev-parse', 'HEAD^{tree}').trim() || git('status', '--porcelain=v1')) {
    console.error(`Pre-push requires a clean checkout of the commit for ${target}.`);
    process.exit(1);
  }
  for (const file of files) changes.add(`./${file}`);
}

if (changes.size > 0) {
  const files = [...changes];
  const templates = files.filter((file) => file.endsWith('.astro'));
  run('fmt', '--check', '--no-error-on-unmatched-pattern', '--', ...files);
  // Native TypeScript covers Astro template diagnostics that tsrs currently omits.
  if (templates.length > 0) run('run', 'check');
  else run('run', 'astro', 'sync');
  run('check', '--no-fmt', '--no-error-on-unmatched-pattern', '--', ...files);
  if (templates.length > 0) run('exec', 'eslint', '--', ...templates);
}
