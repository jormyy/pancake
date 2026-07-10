import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (filename: string) => readFileSync(path.join(process.cwd(), filename), 'utf8')

describe('comprehensive repository gates', () => {
    it('provides one local command covering quality, Edge, generated schema, and the live catalog', () => {
        const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
        expect(scripts['check:comprehensive']).toBe(
            'npm run check:quality && npm run check:edge-functions && ' +
            'npm run check:database-types && npm run check:db-function-catalog',
        )
    })

    it('enforces every comprehensive gate across environment-specific CI jobs', () => {
        const workflow = read('.github/workflows/test.yml')
        for (const command of [
            'npm run check:quality',
            'npm run check:edge-functions',
            'npm run check:database-types',
            'npm run check:db-function-catalog',
        ]) expect(workflow).toContain(command)
    })

    it('serves database Edge integration with a matching internal token', () => {
        const workflow = read('.github/workflows/test.yml')
        expect(workflow).toContain(
            'supabase functions serve --env-file /tmp/pancake-database-edge.env',
        )
        expect(workflow.match(/PANCAKE_EDGE_INTERNAL_TOKEN=local-database-ci-token/g)).toHaveLength(2)
    })

    it('runs browser scenarios with project-local executables on PATH', () => {
        const workflow = read('.github/workflows/test.yml')
        expect(workflow).toContain(
            'npm exec -- node tests/e2e/browser-ci-scenario.mjs --scenario=${{ matrix.scenario }}',
        )
    })
})
