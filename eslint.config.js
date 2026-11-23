const fs = require('node:fs')
const path = require('node:path')
const { defineConfig } = require('eslint/config')
const expoConfig = require('eslint-config-expo/flat')
const noSourceTextTests = require('./eslint/rules/no-source-text-tests')

const sourceTextContracts = [
    'tests/rls-grants.test.ts',
    'tests/source-guard.ts',
    'tests/db-security-catalog-contract.test.ts',
    'tests/security-regression.test.ts',
    'tests/public-cli/policy.test.ts',
    'tests/realtime-publication.test.ts',
    'tests/helpers/realtime-publication.ts',
    'tests/lib/api-client.test.ts',
    'tests/migration-deployment-safety.test.ts',
    'tests/release-edge-compatibility.test.ts',
    'tests/release-history-attestations.test.ts',
    'tests/e2e-attestation-head.test.ts',
    'tests/helpers/attested-migrations.ts',
    'tests/database-types-parity.test.ts',
]

const rulesDirectory = path.join(__dirname, 'eslint/rules')
const restrictions = fs.readdirSync(rulesDirectory).filter(file => file.endsWith('.js')).sort()
    .map(file => ({ name: path.basename(file, '.js'), ...require(path.join(rulesDirectory, file)) }))
    .filter(rule => rule.restrictedSyntax)

const pancake = {
    rules: {
        ...Object.fromEntries(restrictions.map(({ name, restrictedSyntax }) => [name, {
            meta: { type: 'problem', schema: [] },
            create: context => Object.fromEntries(restrictedSyntax.map(({ selector, message }) =>
                [selector, node => context.report({ node, message })])),
        }])),
        'no-source-text-tests': noSourceTextTests,
    },
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
        files: ['tests/**/*.test.{ts,tsx}', 'tests/helpers/**/*.{ts,tsx,js,mjs}', 'tests/*.ts'],
        ignores: sourceTextContracts,
        plugins: { pancake },
        rules: { 'pancake/no-source-text-tests': 'error' },
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
