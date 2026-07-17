// Flat ESLint config for the React + TypeScript frontend.
// Kept intentionally lean: type-aware linting is skipped (it needs the full
// TS project graph and is slower) in favour of the fast recommended rulesets,
// which already catch the bugs that matter on a homelab CI runner.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    // Build output, deps, and config files are not worth linting.
    ignores: ['dist', 'node_modules', 'vite.config.*', 'eslint.config.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // Allow intentionally-unused args/vars when prefixed with `_`.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Test files use jsdom + node globals.
    files: ['**/*.test.{ts,tsx}', 'src/test/**'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
);
