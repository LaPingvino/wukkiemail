// ESLint 9 flat config. `npm run lint` was dead before this file existed (ESLint 9
// dropped .eslintrc and there was none anyway), so the eslint-disable comments
// scattered through src/ were decorative. Kept deliberately tight: the recommended
// TS rules WITHOUT type-aware linting (fast, no project service), plus react-hooks,
// which is the one that actually bites here — an un-memoized always-mounted hook
// once cost 95% CPU in this codebase.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '*.config.js', 'scripts/**'] },
  // src/ and public/ carry ~70 `eslint-disable-next-line no-console` /
  // `no-await-in-loop` comments from the era when this project had a working config
  // with those rules on. They're accurate documentation of deliberate choices (every
  // console.* here is an intentional `[wukkiemail]` trace, every awaited loop is
  // intentionally serial), so they stay — but with those rules off they'd each report
  // as an unused directive and bury the real findings. Silence the meta-warning, not
  // the rules.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The service worker runs in a ServiceWorkerGlobalScope, not a window.
    files: ['public/**/*.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // react and jsx-a11y are REGISTERED but their recommended sets are not turned
    // on. Registering is what makes the pre-existing `// eslint-disable-next-line
    // react/no-array-index-key` / `jsx-a11y/no-autofocus` comments in src/ resolve
    // instead of erroring as unknown rules. Switching their recommended sets on is
    // a separate, deliberate cleanup — this app is accessibility-first, so it's
    // worth doing, but not as a silent side effect of reviving the lint script.
    plugins: { 'react-hooks': reactHooks, react, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The matrix-js-sdk surface is loosely typed and this code leans on `as never`
      // casts at its edges; banning `any` outright would be noise, flagging it is not.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Deliberate empty catches are the house style for best-effort local storage
      // and network calls — they all carry an explanatory comment.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-alert': 'warn',
    },
  },
);
