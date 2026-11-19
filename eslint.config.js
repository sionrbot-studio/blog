// Oxlint (`vp lint`) covers JavaScript and TypeScript. ESLint remains for
// `.astro` files only: eslint-plugin-astro needs a custom parser and processor
// that Oxlint's JS plugin API does not support.
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';

export default [
  {
    ignores: [
      'dist/',
      '.astro/',
      '.cloudflare/',
      'node_modules/',
      'tests/test-results/',
      '.vitest/',
    ],
  },
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  {
    files: ['**/*.astro'],
    rules: { 'prefer-const': 'error' },
  },
];
