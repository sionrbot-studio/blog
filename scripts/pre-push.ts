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
let hasChanges = false;
for (const update of readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)) {
  const [, oid, target, previous] = update.split(' ');
  if (!target.startsWith('refs/heads/') || isZeroOid(oid)) continue;

  const base = isZeroOid(previous) ? baseForNewBranch(remote, oid) : previous;
  const changesForRef = git('diff', '--name-status', '-z', '--no-renames', base, oid, '--')
    .split('\0')
    .filter(Boolean);
  if (changesForRef.length === 0) continue;
  hasChanges = true;

  // Tools read the working tree. Verify it represents the commit that will be pushed.
  const pushedTree = git('rev-parse', `${oid}^{tree}`).trim();
  if (pushedTree !== git('rev-parse', 'HEAD^{tree}').trim() || git('status', '--porcelain=v1')) {
    console.error(`Pre-push requires a clean checkout of the commit for ${target}.`);
    process.exit(1);
  }
  for (let index = 0; index < changesForRef.length; index += 2) {
    const [status, file] = changesForRef.slice(index, index + 2);
    if (status !== 'D') changes.add(`./${file}`);
  }
}

if (hasChanges) {
  if (changes.size > 0) {
    const files = [...changes];
    const templates = files.filter((file) => file.endsWith('.astro'));
    run('fmt', '--check', '--no-error-on-unmatched-pattern', '--', ...files);
    run('lint', '--no-error-on-unmatched-pattern', '--', ...files);
    if (templates.length > 0) run('exec', 'eslint', '--', ...templates);
  }

  // Changed exports and removed paths can invalidate any of their consumers.
  // Native TypeScript covers Astro diagnostics tsrs currently omits.
  run('run', '--no-cache', 'check');
  run('check', '--no-fmt', '--no-lint');
}
