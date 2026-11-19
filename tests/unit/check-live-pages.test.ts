import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { checkLivePages } from '../../scripts/check-live-pages.ts';

const source = 'https://sionrbot-studio.github.io/blog/';
const personal = 'https://sionrbot.github.io/blog/';
const identity = {
  SOURCE_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '12',
  GITHUB_RUN_ATTEMPT: '2',
};
const marker = `${identity.SOURCE_SHA} 12 2\n`;
const rss = '<?xml version="1.0"?><rss><channel /></rss>\n';
const article = '<!doctype html><html lang="zh"><body>旧文章</body></html>\n';
let mirrorDir: string | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (mirrorDir) await rm(mirrorDir, { recursive: true, force: true });
  mirrorDir = undefined;
});

async function mirrorFixture() {
  mirrorDir = await mkdtemp(join(tmpdir(), 'live-pages-'));
  await mkdir(join(mirrorDir, 'articles/freedom'), { recursive: true });
  await writeFile(join(mirrorDir, 'rss.xml'), rss);
  await writeFile(join(mirrorDir, 'articles/freedom/index.html'), article);
  return { ...identity, MIRROR_BLOG_DIR: mirrorDir };
}

describe('live Pages release verification', () => {
  it('verifies the current release on the organization deployment URL', async () => {
    const fetchMock = vi.fn(async () => new Response(marker));
    vi.stubGlobal('fetch', fetchMock);
    await checkLivePages('source', source, identity);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      new URL('release-id.txt', source),
      expect.objectContaining({ method: 'GET', redirect: 'manual', cache: 'no-store' }),
    );
  });

  it.each([
    ['source', source],
    ['personal', personal],
  ] as const)('rejects an old marker with HTTP 200 on %s', async (target, url) => {
    const fetchMock = vi.fn(async () => new Response(`${identity.SOURCE_SHA} 12 1\n`));
    vi.stubGlobal('fetch', fetchMock);
    await expect(checkLivePages(target, url, identity)).rejects.toThrow(
      'release-id.txt: response bytes differ from this release',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects the personal URL in source mode before sending a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(checkLivePages('source', personal, identity)).rejects.toThrow(
      'Unexpected source Pages URL',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a marker redirect', async () => {
    const fetchMock = vi.fn(async () => Response.redirect(new URL('release-id.txt', personal)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(checkLivePages('source', source, identity)).rejects.toThrow(
      'release-id.txt: expected HTTP 200, got 302',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['none', 'rss.xml', 'articles/freedom/'])(
    'verifies matching personal contents and rejects a mismatch in %s',
    async (mismatch) => {
      const env = await mirrorFixture();
      const files = { 'release-id.txt': marker, 'rss.xml': rss, 'articles/freedom/': article };
      const fetchMock = vi.fn(async (url: URL) => {
        const path = url.pathname.slice('/blog/'.length) as keyof typeof files;
        return new Response(path === mismatch ? files[path].trimEnd() : files[path]);
      });
      vi.stubGlobal('fetch', fetchMock);
      const check = checkLivePages('personal', personal, env);
      if (mismatch === 'none') {
        await check;
        expect(fetchMock.mock.calls.map(([url]) => url.href).sort()).toEqual(
          Object.keys(files)
            .map((path) => new URL(path, personal).href)
            .sort(),
        );
      } else {
        await expect(check).rejects.toThrow(`${mismatch}: response bytes differ from this release`);
      }
    },
  );
});
