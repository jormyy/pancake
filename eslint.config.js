// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config')
const expoConfig = require('eslint-config-expo/flat')

module.exports = defineConfig([
    expoConfig,
    {
        ignores: ['dist/*', 'core/cjs/**'],
    },
    {
        files: ['scripts/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.js', 'tests/**/*.mjs'],
        languageOptions: {
            globals: {
                Buffer: 'readonly',
            },
        },
    },
    {
        files: ['scripts/bench/game-night/edge.mjs'],
        languageOptions: { globals: { Deno: 'readonly' } },
        rules: { 'import/no-unresolved': ['error', { ignore: ['^npm:'] }] },
    },
    {
        files: ['tests/lib/*.test.ts'],
        rules: {
            'import/first': 'off',
        },
    },
])
