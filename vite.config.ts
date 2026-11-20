import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

// Allow Vite+'s tsrs-lint to load the .astro mapper registered in tsconfig.json.
process.env.TSRS_LINT_RUN_EXTERNAL_CODE = '1';

const sharedWorkers = {
  isolate: false,
  setupFiles: ['tests/support/reset-test-state.ts'],
  sequence: { shuffle: { tests: true } },
};

// ESLint also checks .astro files with the Astro parser and client-side processor.
export default defineConfig({
  run: {
    tasks: {
      check: 'astro sync && tsc --noEmit --runExternalCode',
      'lint:astro': 'eslint "**/*.astro"',
      'test:unit': 'vp test --project unit',
      'test:unit:tz': 'node tests/support/run-date-timezones.ts',
    },
  },
  test: {
    sequence: { shuffle: { files: true } },
    projects: [
      {
        test: {
          ...sharedWorkers,
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          alias: {
            'astro:i18n': fileURLToPath(
              new URL('./tests/support/astro-i18n.stub.ts', import.meta.url),
            ),
            'astro:content': fileURLToPath(
              new URL('./tests/support/astro-content.stub.ts', import.meta.url),
            ),
          },
        },
      },
      {
        test: {
          ...sharedWorkers,
          name: 'build',
          include: ['tests/build/**/*.test.ts'],
          // Fixtures own their sources, output and caches; cap concurrent test files.
          fileParallelism: true,
          maxWorkers: 2,
          sequence: { ...sharedWorkers.sequence, groupOrder: 1 },
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
  lint: {
    plugins: ['oxc', 'typescript', 'unicorn'],
    jsPlugins: [
      {
        name: 'vite-plus',
        specifier: 'vite-plus/oxlint-plugin',
      },
    ],
    categories: {
      correctness: 'warn',
    },
    env: {
      builtin: true,
    },
    ignorePatterns: [
      'dist/',
      '.astro/',
      '.cloudflare/',
      'node_modules/',
      'tests/test-results/',
      '.vitest/',
      '.e2e/',
    ],
    rules: {
      'no-array-constructor': 'error',
      'no-unused-expressions': 'error',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^$', varsIgnorePattern: '^$', reportVarsOnlyUsedAsTypes: true },
      ],
      'typescript/ban-ts-comment': 'error',
      'typescript/no-duplicate-enum-values': 'error',
      'typescript/no-empty-object-type': 'error',
      'typescript/no-explicit-any': 'error',
      'typescript/no-extra-non-null-assertion': 'error',
      'typescript/no-misused-new': 'error',
      'typescript/no-namespace': 'error',
      'typescript/no-non-null-asserted-optional-chain': 'error',
      'typescript/no-require-imports': 'error',
      'typescript/no-this-alias': 'error',
      'typescript/no-unnecessary-type-constraint': 'error',
      'typescript/no-unsafe-declaration-merging': 'error',
      'typescript/no-unsafe-function-type': 'error',
      'typescript/no-wrapper-object-types': 'error',
      'typescript/prefer-as-const': 'error',
      'typescript/prefer-namespace-keyword': 'error',
      'typescript/triple-slash-reference': 'error',
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
    overrides: [
      {
        files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
        rules: {
          'constructor-super': 'off',
          'getter-return': 'off',
          'no-class-assign': 'off',
          'no-const-assign': 'off',
          'no-dupe-class-members': 'off',
          'no-dupe-keys': 'off',
          'no-func-assign': 'off',
          'no-import-assign': 'off',
          'no-new-native-nonconstructor': 'off',
          'no-obj-calls': 'off',
          'no-redeclare': 'off',
          'no-setter-return': 'off',
          'no-this-before-super': 'off',
          'no-undef': 'off',
          'no-unreachable': 'off',
          'no-unsafe-negation': 'off',
          'no-var': 'error',
          'no-with': 'off',
          'prefer-const': 'error',
          'prefer-rest-params': 'error',
          'prefer-spread': 'error',
        },
      },
      {
        files: ['**/*.astro'],
        rules: {
          'no-var': 'error',
          // ESLint's Astro parser sees assignments in template expressions.
          'prefer-const': 'off',
          'prefer-rest-params': 'error',
          'prefer-spread': 'error',
        },
      },
      {
        files: ['**/*.cjs'],
        rules: {
          'typescript/no-require-imports': 'off',
        },
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    singleQuote: true,
    printWidth: 100,
    sortPackageJson: false,
    sortTailwindcss: {
      stylesheet: './src/styles/global.css',
    },
    astro: {},
    associations: [
      {
        files: ['*.astro'],
        language: 'astro',
      },
    ],
    ignorePatterns: [
      'dist/',
      '.astro/',
      '.cloudflare/',
      'pnpm-lock.yaml',
      'tests/test-results/',
      '.vitest/',
      '.e2e/',
      '.agents/skills/e2e/',
    ],
  },
});
