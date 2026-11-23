import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';

// The only root install hook whose effects we can reproduce after restoring node_modules.
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const scripts = manifest.scripts ?? {};
const registerHooks = scripts.prepare === 'vp config --no-agent';
if (registerHooks) delete scripts.prepare;
if (Object.keys(scripts).length === 0) delete manifest.scripts;
// A private root package's release version bump does not alter installed node_modules.
if (manifest.private === true) delete manifest.version;

const installHooks = [
  'pnpm:devPreinstall',
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
];

function cacheId() {
  // A custom hook can read arbitrary source files or generate files outside node_modules.
  if (installHooks.some((name) => Object.hasOwn(scripts, name))) return '';
  if (existsSync('.pnpmfile.cjs') || existsSync('.pnpmfile.mjs')) return '';

  // Actions checks out a clean Git tree. Index records cover path, file mode and blob
  // identity, including patch renames. Keep the entire remaining manifest in the key.
  const inputs = execFileSync('git', [
    '-c',
    `safe.directory=${realpathSync('.')}`,
    'ls-files',
    '--stage',
    '-z',
    '--',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    'patches/',
    '.github/actions/dependencies/action.yml',
  ]);
  const digest = createHash('sha256')
    .update(JSON.stringify(manifest))
    .update('\0')
    .update(inputs)
    .digest('hex');
  const platform = [
    process.env.RUNNER_OS,
    process.env.RUNNER_ARCH,
    process.env.CACHE_ENVIRONMENT,
  ].join('-');

  // Exact compatibility with main@c659d60's warmed v1 tree. The digest above binds
  // this install recipe and every input; any other fingerprint gets its own v2 key.
  if (digest === 'b60aa8df082b3e6d75bdcf596b822074aeaf656bf54c2d1cbd03bd7120b88a1c') {
    return `modules-v1-${platform}-00510a80e812b8da8b379badf13c5f87b30b1b1b79254774f2753038364cb106`;
  }
  return `modules-v2-${platform}-${digest}`;
}

appendFileSync(
  process.env.GITHUB_OUTPUT,
  `cache_id=${cacheId()}\nregister_hooks=${registerHooks}\n`,
);
