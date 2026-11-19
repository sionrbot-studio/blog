// Build artifact tests exercise Astro's virtual helper against the real config.
export function getRelativeLocaleUrl(locale: string, path: string): string {
  return `/${locale === 'zh-Hans' ? 'zh/' : ''}${path}`;
}
