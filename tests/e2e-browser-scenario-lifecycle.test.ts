import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runBrowserScenarioLifecycle } from './e2e/browser-scenario-lifecycle.mjs'

const tempDirs: string[] = []

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const createTempPaths = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pancake-browser-lifecycle-'))
    tempDirs.push(root)
    return { artifactDir: path.join(root, 'artifacts'), reportPath: path.join(root, 'report.json') }
}

const browserOutput = (command: string[]) => {
    if (command[0] === 'errors') return ''
    if (command[0] === 'console') return 'console clean'
    if (command[0] === 'network') return 'GET /lineup 200'
    return ''
}

describe('browser scenario lifecycle', () => {
    it('writes identical canonical reports and releases both resource owners', async () => {
        const { artifactDir, reportPath } = await createTempPaths()
        const browser = vi.fn(async (_session: string, command: string[]) => browserOutput(command))
        const dispose = vi.fn(async () => undefined)

        const report = await runBrowserScenarioLifecycle({
            browser,
            session: 'session',
            artifactDir,
            reportPath,
            season: 4,
            fixture: { dispose },
            fixtureSummary: () => ({ leagueId: 'league' }),
            notes: ['test'],
            failureLabel: 'scenario failed',
            run: async ({ record }: { record: (value: Record<string, unknown>) => void }) => {
                record({ click: 'ok' })
                return { fields: { persisted: true }, failures: [] }
            },
            verifyFailure: async () => ({}),
        })

        expect(report).toMatchObject({ status: 'PASS', season: 4, persisted: true })
        expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(report)
        expect(JSON.parse(await readFile(path.join(artifactDir, 'summary.json'), 'utf8'))).toEqual(report)
        expect(browser).toHaveBeenCalledWith('session', ['close'], { timeout: 10_000 })
        expect(dispose).toHaveBeenCalledOnce()
    })

    it('fails the scenario when browser cleanup leaks even after assertions pass', async () => {
        const { artifactDir, reportPath } = await createTempPaths()
        const browser = vi.fn(async (_session: string, command: string[]) => {
            if (command[0] === 'close') throw new Error('session still owned')
            return browserOutput(command)
        })

        await expect(runBrowserScenarioLifecycle({
            browser,
            session: 'session',
            artifactDir,
            reportPath,
            season: 1,
            fixture: { dispose: vi.fn(async () => undefined) },
            fixtureSummary: () => ({}),
            notes: [],
            failureLabel: 'scenario failed',
            run: async () => ({ fields: {}, failures: [] }),
            verifyFailure: async () => ({}),
        })).rejects.toThrow('cleanup was not clean')
        expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({
            status: 'FAIL',
            cleanupError: expect.stringContaining('session still owned'),
        })
    })

    it('still disposes the fixture when browser close fails', async () => {
        const { artifactDir, reportPath } = await createTempPaths()
        const dispose = vi.fn(async () => undefined)
        const browser = vi.fn(async (_session: string, command: string[]) => {
            if (command[0] === 'close') throw new Error('close failed')
            return browserOutput(command)
        })

        await expect(runBrowserScenarioLifecycle({
            browser,
            session: 'session',
            artifactDir,
            reportPath,
            season: 1,
            fixture: { dispose },
            fixtureSummary: () => ({}),
            notes: [],
            failureLabel: 'scenario failed',
            run: async () => ({ fields: {}, failures: [] }),
            verifyFailure: async () => ({}),
        })).rejects.toThrow('cleanup was not clean')
        expect(dispose).toHaveBeenCalledOnce()
    })
})
