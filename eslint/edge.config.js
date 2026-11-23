const expoConfig = require('eslint-config-expo/flat')
const gamePhase = require('./rules/game-phase')

const { parser } = expoConfig.flat().find(config => config.languageOptions?.parser).languageOptions

module.exports = [
    {
        files: ['supabase/functions/**/*.ts'],
        ignores: ['supabase/functions/**/*.test.ts', 'supabase/functions/_shared/gamePhase.ts'],
        languageOptions: { parser },
        linterOptions: { reportUnusedDisableDirectives: 'off', noInlineConfig: true },
        plugins: { pancake: { rules: { 'game-phase': gamePhase } } },
        rules: { 'pancake/game-phase': 'error' },
    },
]
