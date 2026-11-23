// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config')
const expoConfig = require('eslint-config-expo/flat')
const { easternDayConfig } = require('./eslint/eastern-day.config')

const rosterCapacityMessage = 'Read roster location and limits through lib/roster-capacity (rosterLocation/partitionRoster/rosterLimits); inline is_on_ir/is_on_taxi checks counted taxi players as active in PR #5.'
const rosterCapacityNames = 'is_on_ir|is_on_taxi|roster_size|ir_slots|taxi_slots'

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
    {
        files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'hooks/**/*.{ts,tsx}', 'contexts/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
        ignores: ['lib/roster-capacity.ts', 'lib/league.ts', 'lib/commissioner-settings-draft.ts'],
        rules: {
            'no-restricted-syntax': ['error',
                {
                    selector: `MemberExpression[property.name=/^(${rosterCapacityNames})$/]:not(AssignmentExpression > MemberExpression.left)`,
                    message: rosterCapacityMessage,
                },
                {
                    selector: `MemberExpression[computed=true][property.value=/^(${rosterCapacityNames})$/]:not(AssignmentExpression > MemberExpression.left)`,
                    message: rosterCapacityMessage,
                },
                {
                    selector: `ObjectPattern > Property[key.name=/^(${rosterCapacityNames})$/]`,
                    message: rosterCapacityMessage,
                },
                {
                    selector: `ObjectPattern > Property[key.value=/^(${rosterCapacityNames})$/]`,
                    message: rosterCapacityMessage,
                },
                {
                    selector: `MemberExpression[computed=true][property.type="TemplateLiteral"][property.expressions.length=0][property.quasis.0.value.cooked=/^(${rosterCapacityNames})$/]:not(AssignmentExpression > MemberExpression.left)`,
                    message: rosterCapacityMessage,
                },
            ],
        },
    },
    easternDayConfig,
])
