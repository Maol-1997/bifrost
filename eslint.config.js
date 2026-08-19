import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint.config.js', 'migrations/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: ['./tsconfig.json', './tsconfig.app.json'], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['**/server/**'], message: 'Browser code cannot import the Node server.' }],
      }],
    },
  },
  {
    files: ['src/server/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['**/app/**', '@app/*'], message: 'Server code cannot import the React app.' }],
      }],
    },
  },
  {
    files: ['src/features/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/app/**', '**/server/**', '@app/*'],
          message: 'Shared features cannot depend on either runtime.',
        }],
      }],
    },
  },
);
