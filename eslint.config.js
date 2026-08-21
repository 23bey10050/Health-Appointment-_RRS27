import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // An unused variable is almost always a leftover from a refactor. Naming it with a leading
      // underscore is the escape hatch for the cases where we really do have to accept an argument
      // we do not use.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Forgetting an await on a promise is the single most common source of "it worked in dev and
      // vanished in production" bugs, so it is an error here rather than a warning.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Plain JavaScript files - config and the small build scripts - sit outside every tsconfig, so
    // the type-aware rules have no type information to work from and would only report that fact
    // over and over.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Build and setup scripts are command line tools. Printing is what they are for, and they run
    // on Node directly rather than through the bundler, so Node's globals are theirs to use.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    // The browser app, and only the browser app - `window`, `fetch` and `localStorage` are real
    // globals here, not typos, and the two React-specific plugins have nothing useful to say
    // about a Fastify route handler on the other side of this monorepo.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh, 'jsx-a11y': jsxA11y },
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Vite's Fast Refresh needs a component file to export only components - a stray helper
      // function exported alongside one silently breaks hot reload for that file. `Component` is
      // this project's own convention for a lazy route's default export (see router.tsx), which
      // is exactly the shape this rule expects.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
);
