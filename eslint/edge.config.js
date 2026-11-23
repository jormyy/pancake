const tsParser = require('@typescript-eslint/parser')
const gamePhase = require('./rules/game-phase')

module.exports = [
    {
        files: ['supabase/functions/**/*.ts'],
        ignores: ['supabase/functions/**/*.test.ts', 'supabase/functions/_shared/gamePhase.ts'],
        languageOptions: { parser: tsParser },
        linterOptions: { reportUnusedDisableDirectives: 'off' },
        plugins: { pancake: { rules: { 'game-phase': gamePhase } } },
        rules: { 'pancake/game-phase': 'error' },
    },
]
