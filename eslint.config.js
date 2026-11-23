const fs = require('node:fs')
const path = require('node:path')
const { defineConfig } = require('eslint/config')
const expoConfig = require('eslint-config-expo/flat')

const rulesDirectory = path.join(__dirname, 'eslint/rules')
const restrictions = fs.readdirSync(rulesDirectory).filter(file => file.endsWith('.js')).sort()
    .map(file => ({ name: path.basename(file, '.js'), ...require(path.join(rulesDirectory, file)) }))

const pancake = {
    rules: Object.fromEntries(restrictions.map(({ name, restrictedSyntax }) => [name, {
        meta: { type: 'problem', schema: [] },
        create: context => Object.fromEntries(restrictedSyntax.map(({ selector, message }) =>
            [selector, node => context.report({ node, message })])),
    }])),
}

module.exports = defineConfig([
    expoConfig,
    {
        ignores: ['dist/*', 'core/cjs/**', 'tools/perf/.cache/**', 'tools/verify/evidence/**'],
    },
    {
        files: ['scripts/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.js', 'tests/**/*.mjs', 'tools/**/*.mjs'],
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
    ...restrictions.map(({ name, files, ignores }) => ({
        files,
        ignores,
        plugins: { pancake },
        rules: { [`pancake/${name}`]: 'error' },
    })),
])
