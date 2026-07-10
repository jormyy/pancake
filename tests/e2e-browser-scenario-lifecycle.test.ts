import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runBrowserScenarioLifecycle } from './e2e/browser-scenario-lifecycle.mjs'
import { captureBrowserScreenshot } from './e2e/browser-agent.mjs'

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
    it('writes identical scenario-detail reports for the registry owner', async () => {
        const { artifactDir, reportPath } = await createTempPaths()
        const browser = vi.fn(async (_session: string, command: string[]) => browserOutput(command))
        const report = await runBrowserScenarioLifecycle({
            browser,
            session: 'session',
            artifactDir,
            reportPath,
            season: 4,
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
        expect(browser).not.toHaveBeenCalledWith('session', ['close'], expect.anything())
    })

    it('preserves the primary scenario failure in both detail reports', async () => {
        const { artifactDir, reportPath } = await createTempPaths()
        const browser = vi.fn(async (_session: string, command: string[]) => browserOutput(command))

        await expect(runBrowserScenarioLifecycle({
            browser,
            session: 'session',
            artifactDir,
            reportPath,
            season: 1,
            fixtureSummary: () => ({}),
            notes: [],
            failureLabel: 'scenario failed',
            run: async () => { throw new Error('scenario assertion failed') },
            verifyFailure: async () => ({}),
        })).rejects.toThrow('scenario assertion failed')
        expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({
            status: 'FAIL',
            error: 'scenario assertion failed',
        })
        expect(JSON.parse(await readFile(path.join(artifactDir, 'summary.json'), 'utf8'))).toEqual(
            JSON.parse(await readFile(reportPath, 'utf8')),
        )
    })

    it('fails a passing scenario when the browser console reports an application error', async () => {
        const { artifactDir, reportPath } = await createTempPaths()
        const browser = vi.fn(async (_session: string, command: string[]) =>
            command[0] === 'console' ? '[error] query render failed' : browserOutput(command))

        await expect(runBrowserScenarioLifecycle({
            browser,
            session: 'session',
            artifactDir,
            reportPath,
            season: 1,
            fixtureSummary: () => ({}),
            notes: [],
            failureLabel: 'scenario failed',
            run: async () => ({ fields: {}, failures: [] }),
            verifyFailure: async () => ({}),
        })).rejects.toThrow('console errors')
        expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({ status: 'FAIL' })
    })

    it('fails hard when required screenshot transport fails', async () => {
        const { artifactDir } = await createTempPaths()
        const browser = vi.fn(async () => { throw new Error('screenshot transport failed') })
        await expect(captureBrowserScreenshot(browser, 'session', artifactDir, 'required.png'))
            .rejects.toThrow('screenshot transport failed')
    })
})
