import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('generated Edge shared files', () => {
    it('match their canonical core/backend sources', () => {
        const result = spawnSync('npm', ['run', 'check:edge-shared'], {
            cwd: process.cwd(),
            encoding: 'utf8',
        })

        expect(result.status, result.stderr || result.stdout).toBe(0)
    })
})
