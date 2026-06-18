// @ts-check
import tseslint from 'typescript-eslint';
import pluginJest from 'eslint-plugin-jest';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },

  // TypeScript rules for all source files
  ...tseslint.configs.recommended,
  {
    rules: {
      // declare global { namespace Express } is required for Express type augmentation
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
    },
  },

  // Disable ESLint formatting rules that conflict with Prettier (must come after
  // all other configs that might enable formatting rules)
  prettier,

  // Jest rules scoped to test files only
  {
    files: ['packages/**/__tests__/**/*.ts', 'packages/**/*.test.ts'],
    plugins: { jest: pluginJest },
    rules: {
      ...pluginJest.configs['flat/recommended'].rules,
    },
    languageOptions: {
      globals: pluginJest.environments.globals.globals,
    },
  },
);
