import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pagesUrls = {
  source: 'https://sionrbot-studio.github.io/blog/',
  personal: 'https://sionrbot.github.io/blog/',
};

export async function checkLivePages(
  target: 'source' | 'personal',
  pageUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const baseUrl = pagesUrls[target];
  if (pageUrl !== baseUrl && pageUrl + '/' !== baseUrl) {
    throw new Error(`Unexpected ${target} Pages URL. Expected ${baseUrl}, got ${pageUrl}`);
  }

  const { SOURCE_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, MIRROR_BLOG_DIR } = env;
  if (
    !/^[0-9a-f]{40}$/.test(SOURCE_SHA ?? '') ||
    !/^[1-9][0-9]*$/.test(GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]*$/.test(GITHUB_RUN_ATTEMPT ?? '')
  ) {
    throw new Error('Expected the fixed source SHA, run ID, and run attempt');
  }

  const marker = Buffer.from(`${SOURCE_SHA} ${GITHUB_RUN_ID} ${GITHUB_RUN_ATTEMPT}\n`);
  await checkFile(new URL('release-id.txt', baseUrl), marker);
  if (target === 'personal') {
    if (!MIRROR_BLOG_DIR) throw new Error('Expected the verified personal Pages checkout');
    await Promise.all([
      readFile(join(MIRROR_BLOG_DIR, 'rss.xml')).then((rss) =>
        checkFile(new URL('rss.xml', baseUrl), rss),
      ),
      readFile(join(MIRROR_BLOG_DIR, 'articles/freedom/index.html')).then((article) =>
        checkFile(new URL('articles/freedom/', baseUrl), article),
      ),
    ]);
  }
}

async function checkFile(url: URL, expected: Buffer): Promise<void> {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) {
    throw new Error(`${url.href}: expected HTTP 200, got ${response.status}`);
  }
  if (!Buffer.from(await response.arrayBuffer()).equals(expected)) {
    throw new Error(`${url.href}: response bytes differ from this release`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, pageUrl] = process.argv.slice(2);
  if ((target !== 'source' && target !== 'personal') || !pageUrl || process.argv.length !== 4) {
    console.error('Usage: node scripts/check-live-pages.ts source|personal <base-url>');
    process.exitCode = 1;
  } else {
    checkLivePages(target, pageUrl)
      .then(() => console.log(`Verified ${target} Pages release at ${pageUrl}`))
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
