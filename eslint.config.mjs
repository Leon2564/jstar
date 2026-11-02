// One lint config for every TypeScript workspace, run in the PR gate (scripts/ci-local.sh): errors fail it,
// warnings are the backlog to clear before a rule is raised to an error.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**', '**/dist/**', '**/dist-single/**', '**/.wrangler/**', '**/test-results/**',
      '**/playwright-report/**', 'apps/agent/**', 'assets/**', 'docs/**', '.ci-local/**', '**/*.config.*',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Durable Object state is typed DurableObjectState<{}> by the Workers types.
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true, allowShortCircuit: true }],
      // Japanese copy uses the full-width space (U+3000) on purpose.
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipJSXText: true, skipComments: true }],
      // Byte-range checks such as /[^\x00-\x7F]/ are intended.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'apps/admin/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
