// ESLint 9 (flat config) — substitui o antigo .eslintrc.json.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['**/node_modules/', '**/dist/', '**/build/', '**/*.js', 'client/src/sw.ts'],
  },
  js.configs.recommended,
  {
    files: ['server/src/**/*.ts', 'client/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        // Node + navegador (o client usa fetch/window; o server usa console/process)
        console: 'readonly',
        process: 'readonly',
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Blob: 'readonly',
        FormData: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // `any` controlado é aceito no CRUD genérico (Row = Record<string, any>)
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-var': 'error',
      'prefer-const': 'error',
      // o servidor usa console.log/sentry por design (log.ts)
      'no-console': 'off',
      // no TS o compilador já pega variáveis não definidas (@types/node cobre Buffer etc.)
      'no-undef': 'off',
      // createRequire é usado de propósito em ESM (mail.ts, log.ts, utils.ts)
      '@typescript-eslint/no-require-imports': 'off',
      // hooks do React (apenas efeito nos .tsx)
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
