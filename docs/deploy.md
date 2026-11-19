# Deploy

Sionrbot personal blog builds to a static site in `dist/`. There is no server runtime to configure.

## Before you deploy

Verify live branch/environment rules first. When setting up the publication line,
follow the authorized [release branch cutover](release-branch-spec.md#实施清单与切换).
The settings below are requirements,
not evidence that remote configuration has already changed. Content deployment
uses the same builds, artifacts and smoke checks; see [the content entry point](releasing.md#deploy-content-independently).

Set `site.url` in `src/config.ts` to your production URL. It is used for canonical links, RSS, and the sitemap.

## Requirements

- Install the [Vite+ CLI](https://viteplus.dev/guide/global-cli) for local verification. It selects the Node.js runtime and pnpm version pinned in `package.json`.
- Keep `pnpm-workspace.yaml#nodeVersion` aligned with `package.json#devEngines.runtime` for dependency engine checks.

## Build

```sh
vp install
vp run build
```

Output goes to `dist/`.

## GitHub Pages

The source repository is `sionrbot-studio/blog`. In that repository's
**Settings → Pages**, select **GitHub Actions**. Its project site is
https://sionrbot-studio.github.io/blog/.

Readers keep using the personal site at https://sionrbot.github.io/blog/.
The Pages build uses this URL for canonical links, RSS, and the sitemap.
Astro derives the origin and the `/blog/` base path from `site.url` in
`src/config.ts`. A separate deployment or local test build can override it with
`SITE_URL`.

The [release workflow](../.github/workflows/release.yml) checks the Pages build
for the fixed source SHA and adds a release marker to the artifact before upload.
After deployment, the Pages job verifies the marker and runs smoke checks at the
`page_url` returned by the deployment. Only this job receives Pages write and OIDC
permissions.

After the source checks pass, the workflow syncs the same artifact to `blog/` in
`sionrbot/sionrbot.github.io`. Once that commit deploys, it verifies the marker
on the personal site and compares the public [RSS feed](https://sionrbot.github.io/blog/rss.xml)
and an [existing article](https://sionrbot.github.io/blog/articles/freedom/) with
the files in the artifact. See [personal Pages mirror setup](releasing.md#personal-pages-mirror).

In the source repository, under **Settings → Environments → github-pages → Deployment branches and tags**,
choose **Selected branches and tags** and add these two **Branch** rules:

- `release`
- `refs/pull/*/merge`

Software releases use a merged version PR's `pull_request` event; content
deployments use `workflow_dispatch` from `release`.
GitHub evaluates environment access against the event's ref, which can be
`refs/pull/<number>/merge`; checking out the validated merge SHA does not change
that event ref. Keep both rules so the environment accepts the workflow's event
context. The workflow still checks that the same-repository version PR merged
into `release` and validates its fixed merge SHA before publication and deployment.
See [GitHub's deployment branch rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#deployment-branches-and-tags).

Production deployment follows merged software version PRs or explicitly approved
content dispatches. Ordinary pushes and promotion merges do not deploy.
Each platform consumes its own output from the same release run and attempt.
Before deploying, each job checks the public software baseline and its tag, and
requires the fixed candidate SHA to equal live `release` HEAD. Any newer HEAD
supersedes the old deployment candidate, even without a successful newer run.

For temporary deployment or smoke failures, use **Re-run all jobs** on the
original **Release fixed source** run. This repeats validation and both builds at
the original version and SHA while that SHA remains `release` HEAD. Deployment-only retries reject outputs from an
older attempt. Software source defects require a repaired subsequent version; content errors
use a new eligible content SHA; see
[release recovery](releasing.md#inspect-and-retry). Published history remains
unchanged. There is no manual arbitrary-tag deployment entry point.
An environment-rule rejection requires correcting the environment configuration
first, then using the same **Re-run all jobs** procedure.

Use the workflow's deployment URL to open the site. The Chinese UI is under
`/blog/zh/`. Preview locally with `vp run preview` and open the same
`/blog/` prefix. GitHub Pages serves the generated root `404.html` for
unknown URLs; it does not automatically choose the Chinese error page.

## Cloudflare Workers

The release workflow also builds for
https://sionrbot-blog.pgsnotfound404.workers.dev. Its domain and root path differ
from Pages, so the preparation job checks this output separately and clears
`.cloudflare/output/` before running `cf build`. It validates the new v1 output
with a deployment dry-run and uploads only `.cloudflare/output/v1/`. The
Workers job checks out the fixed SHA for tooling, downloads that artifact by ID
into `.cloudflare/output/v1/`, and runs
`cf deploy --prebuilt`, followed by GET smoke checks. Pages and Workers run
independently; a failure in one leaves the workflow failed while the other still
attempts deployment and smoke.

Set repository Actions secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. The token needs Workers Scripts Write for the target
account. This static deployment uses the workers.dev hostname and no DNS, KV,
R2, or server-side Astro adapter.

For local production-output verification, use the Workers URL so navigation,
assets, feeds, and SEO metadata use the root path. Keep `site.url` unchanged for
GitHub Pages. The preparation job uses the same build and verification steps before publication:

```sh
export SITE_URL=https://sionrbot-blog.pgsnotfound404.workers.dev
vp run build
vp test --project build tests/build/base-path.test.ts tests/build/routes.test.ts tests/build/seo.test.ts
node scripts/check-production-output.ts dist "$SITE_URL"
rm -rf .cloudflare/output
vp exec cf build
test -d .cloudflare/output/v1
vp exec cf deploy --prebuilt --dry-run
```

Production deployment goes through the shared release workflow. CI receives
Cloudflare credentials only in the deploy step; local verification stops at dry-run.

`cf build` delegates to the project’s pinned Wrangler. `wrangler.config.ts`
selects `dist/` as the asset directory, and `cloudflare.config.ts` defines the
Worker name and static routing. Both the dry-run and production deployment use
`--prebuilt` to consume the same verified v1 files.

Unknown URLs return the generated root `404.html` with HTTP 404. Chinese pages
remain under `/zh/`; missing Chinese paths also use the root error page.

## Hosting provider presets

Configure the provider to install development dependencies before building.
The build commands below use the project-local `vp` installed with those
dependencies. Use `vp run build` when the Vite+ CLI is already on the build
environment's PATH.

### Cloudflare Pages

Build command: `./node_modules/.bin/vp run build`. Output directory: `dist`.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sionrbot-studio/blog)

### Vercel

Framework preset: Astro. Build command: `./node_modules/.bin/vp run build`. Output directory: `dist`.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/sionrbot-studio/blog)

### Netlify

Build command: `./node_modules/.bin/vp run build`. Publish directory: `dist`.

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/sionrbot-studio/blog)

## CI and deployment verification

[CI](../.github/workflows/ci.yml) runs one `verify` job on pull requests and manual
dispatch. For a PR whose complete diff changes only `README.md`, `AGENTS.md`,
`GLOSSARY.md`, `THIRD-PARTY-NOTICES.md`, or Markdown files under `docs/`,
[scripts/ci-scope.ts](../scripts/ci-scope.ts) selects formatting-only verification.
All other changes, manual dispatches, and uncertain scope detection run full
verification with a fixed root-hosted test URL. It installs dependencies once, runs
source/translation/unit/timezone checks, builds the baseline, checks build
contracts and internal links, and runs the four deterministic browser suites on
`desktop,narrow,webkit` plus the `production-path` desktop journey. The baseline
stays in the same job's workspace. Diagnostics are uploaded for inspection.

Lighthouse and rendering AI checks are on-demand tools; see
[Testing](../tests/TESTING.md). PR validation, release preparation, publication,
and each platform's deployment and smoke remain separate outcomes. Test URLs,
Pages output, and Workers output cannot be interchanged.

After deployment, `scripts/smoke-site.ts` performs bounded GET checks for the
home and Chinese pages, Pagefind JavaScript, and a random missing path.
It requires correct statuses and content types and rejects HTML fallback for
JavaScript. It does not submit forms or replace full browser regression.
Local preview success does not establish hosted availability; inspect both
platforms' actual smoke steps in the fixed-source release run.
