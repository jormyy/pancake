import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        env: {
            EXPO_PUBLIC_API_URL: 'http://127.0.0.1:54321/functions/v1/api',
        },
        include: ['tests/**/*.test.ts'],
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, '.'),
        },
    },
})
