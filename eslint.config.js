import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import { plugin as shadcn } from '@shadcn/lint';

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
    plugins: { shadcn },
    settings: {
      shadcn: {
        note: 'See docs/frontend.md#design-system-rules for Bifrost component contracts.',
      },
    },
    rules: {
      'shadcn/no-restyle': [
        'error',
        {
          allow: ['layout'],
          contracts: [
            { pattern: '^Button$', allow: ['layout'], deny: ['h-*', 'size-*'] },
            {
              pattern:
                '^(Surface|SettingsGroup|SectionCard|SettingsRowContent|SettingsRowAction|SidebarHeader|SidebarContent|SidebarLink)$',
              allow: ['layout', 'spacing'],
            },
            { pattern: '^SettingsRow$', allow: ['layout', 'spacing', 'opacity-*'] },
            { pattern: '^SettingsLinkRow$', allow: ['layout', 'spacing'] },
            { pattern: '^SettingsRowTitle$', allow: ['layout', 'gap-*', 'typography'] },
            {
              pattern: '^SettingsRowDescription$',
              allow: ['layout', 'typography', 'text-app-text-tertiary', 'text-app-text-quaternary', 'text-warning'],
            },
            { pattern: '^(AgentChat|AgentChatDock)$', allow: ['layout', 'bg-transparent'] },
          ],
        },
      ],
      // v0.1 mistakes these declared shadow tokens for colors.
      'shadcn/no-raw-colors': [
        'error',
        {
          allow: [
            'shadow-linear-control',
            'shadow-linear-outline',
            'shadow-linear-outline-hover',
            'shadow-linear-secondary',
            'shadow-linear-secondary-hover',
            'shadow-linear-popover',
            'shadow-linear-tooltip',
            'shadow-linear-settings',
            'shadow-linear-dialog',
          ],
        },
      ],
      'shadcn/no-unknown-classes': 'error',
      'shadcn/no-arbitrary-values': ['error', { allow: ['layout'] }],
      'shadcn/no-inline-styles': 'error',
      'shadcn/require-static-classes': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['**/server/**'], message: 'Browser code cannot import the Node server.' }],
        },
      ],
    },
  },
  {
    files: ['src/app/components/ui/**/*.{ts,tsx}'],
    rules: {
      'shadcn/no-restyle': 'off',
      'shadcn/no-arbitrary-values': 'off',
      'shadcn/require-static-classes': 'off',
    },
  },
  {
    // Registry-owned brand assets retain their original SVG colors and styles.
    files: ['src/app/components/ui/svgs/*.tsx'],
    rules: {
      'shadcn/no-raw-colors': 'off',
      'shadcn/no-inline-styles': 'off',
    },
  },
  {
    // The standalone mark must match public/favicon.svg, independently of the theme.
    files: ['src/app/components/ui/bifrost-mark.tsx'],
    rules: { 'shadcn/no-raw-colors': 'off' },
  },
  {
    files: ['src/app/components/ui/code-block/code-block.tsx'],
    rules: {
      'shadcn/no-unknown-classes': [
        'error',
        { allow: ['agent-code-block', 'agent-code-toolbar', 'agent-code-language', 'agent-code-actions'] },
      ],
    },
  },
  {
    files: ['src/app/components/ui/markdown-renderer/markdown-renderer.tsx'],
    rules: { 'shadcn/no-unknown-classes': ['error', { allow: ['agent-markdown-segment'] }] },
  },
  {
    files: ['src/app/components/ui/mermaid-diagram/mermaid-diagram.tsx'],
    rules: {
      'shadcn/no-unknown-classes': [
        'error',
        {
          allow: [
            'agent-mermaid',
            'agent-mermaid-menu',
            'agent-mermaid-source',
            'agent-mermaid-loading',
            'agent-mermaid-error',
            'agent-mermaid-stage',
            'agent-mermaid-exact-skeleton',
          ],
        },
      ],
    },
  },
  {
    files: ['src/app/components/ui/sonner.tsx'],
    rules: { 'shadcn/no-unknown-classes': ['error', { allow: ['toaster'] }] },
  },
  {
    // React Spring must write animated values directly; other properties remain checked.
    files: ['src/app/components/ui/sidebar.tsx'],
    rules: {
      'shadcn/no-inline-styles': [
        'error',
        {
          contracts: [
            { pattern: '^animated\\.aside$', allow: ['width', 'left'] },
            { pattern: '^animated\\.div$', allow: ['width'] },
          ],
        },
      ],
    },
  },
  {
    files: ['src/app/components/ui/tooltip.tsx'],
    rules: {
      'shadcn/no-inline-styles': [
        'error',
        { contracts: [{ pattern: '^animated\\.div$', allow: ['opacity', 'transform', 'transformOrigin'] }] },
      ],
    },
  },
  {
    files: ['src/server/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['**/app/**', '@app/*'], message: 'Server code cannot import the React app.' }],
        },
      ],
    },
  },
  {
    files: ['src/features/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/app/**', '**/server/**', '@app/*'],
              allowTypeImports: true,
              message: 'Shared features may reference runtime modules only through type-only imports.',
            },
          ],
        },
      ],
    },
  },
);
