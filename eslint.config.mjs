import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/coverage/',
      '**/dist/',
      '**/node_modules/',
      '**/release/',
      'desktop-dist/',
      'dist/',
      'release/',
      'web-dist/',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}'],
  })),
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: [
      'packages/framework/src/adapters/node/app-server-transport.ts',
      'test/virtual-terminal.ts',
    ],
    rules: {
      // These are deliberate protocol and terminal-control parsers.
      'no-control-regex': 'off',
    },
  },
  {
    files: [
      'packages/framework/src/**/*.ts',
      'apps/cli/src/**/*.ts',
      'apps/web/**/*.{ts,tsx}',
      'apps/zenx/src/**/*.ts',
      'apps/imzen/{src,test}/**/*.ts',
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      ...reactHooks.configs['recommended-latest'].rules,
    },
  }
);
