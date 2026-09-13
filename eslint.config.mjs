import globals from 'globals';

const safetyRules = {
  'no-unreachable': 'error',
  'no-constant-condition': 'error',
};

export default [
  { ignores: ['build/**', 'build-*/**', 'build-js/**'] },
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    rules: safetyRules,
  },
  {
    files: ['runner/**/*.{js,cjs}', 'tools/**/*.mjs', 'test/**/*.cjs'],
    languageOptions: { ecmaVersion: 2022, globals: globals.node },
    rules: { ...safetyRules, 'no-undef': 'error' },
  },
  {
    files: ['example/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node, NativeHost: 'readonly' },
    },
    rules: { ...safetyRules, 'no-undef': 'error' },
  },
];
