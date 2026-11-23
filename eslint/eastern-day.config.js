const expoConfig = require('eslint-config-expo/flat')
const easternDay = require('./rules/eastern-day')

const { parser } = expoConfig.find((entry) => entry.languageOptions?.parser).languageOptions

const easternDayConfig = {
    files: ['{app,components,contexts,hooks,lib,core/src,server,api,supabase/functions,tests,scripts}/**/*.{js,mjs,ts,tsx}'],
    ignores: ['core/src/dates/**', 'supabase/functions/_shared/date.ts'],
    plugins: { pancake: { rules: { 'eastern-day': easternDay } } },
    rules: { 'pancake/eastern-day': 'error' },
}

module.exports = [
    { ignores: ['core/cjs/**', 'tools/perf/.cache/**', 'tools/verify/evidence/**'] },
    { files: ['**/*.{ts,tsx}'], languageOptions: { parser } },
    { linterOptions: { reportUnusedDisableDirectives: 'off' } },
    easternDayConfig,
]
module.exports.easternDayConfig = easternDayConfig
