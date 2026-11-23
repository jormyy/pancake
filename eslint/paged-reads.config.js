const { defineConfig } = require('eslint/config')
const tsParser = require('@typescript-eslint/parser')
const pagedReads = require('./paged-reads')

module.exports = defineConfig([
    {
        ignores: ['**/node_modules/**', 'dist/**', 'core/cjs/**', '**/*.test.ts', '**/*.test.tsx'],
    },
    {
        files: ['**/*.{js,mjs,cjs,ts,tsx,mts}'],
        languageOptions: { parser: tsParser, sourceType: 'module' },
        linterOptions: { noInlineConfig: true },
        plugins: { pancake: { rules: { 'paged-reads': pagedReads } } },
        rules: { 'pancake/paged-reads': 'error' },
    },
])
