import { describe, expect, it, vi } from 'vitest'
import { localTarget, publicUrl, safeHeaders, requireMini } from '../../scripts/perf-lab/common.mjs'
import { evidenceFailures, inventory } from '../../scripts/perf-lab/workloads.mjs'
import { rankCosts, verifyArtifacts } from '../../scripts/perf-lab/report.mjs'
import { backupTables, stackValues, statementDelta } from '../../scripts/perf-lab/database.mjs'
import { privateConfig } from '../../scripts/perf-lab/setup.mjs'
import { preflight } from '../../scripts/perf-lab/preflight.mjs'
import { readFile } from 'node:fs/promises'

describe('private lab boundaries', () => {
  it('refuses heavy work outside the isolated mini checkout', async () => {
    await expect(requireMini()).rejects.toThrow()
  })
  it('rejects hosted endpoints and every other port block', () => {
    for (const url of ['https://ceeytbfmwsnzalxlkalc.supabase.co', 'https://pancakedynasty.vercel.app', 'http://127.0.0.1:58921', 'http://127.0.0.1:58321', 'http://192.168.1.1:57221']) {
      expect(() => localTarget(url)).toThrow()
    }
    expect(localTarget('http://127.0.0.1:57221').port).toBe('57221')
  })
  it('keeps credentials out of request evidence', () => {
    expect(publicUrl('http://127.0.0.1:57221/auth?token=secret')).not.toContain('secret')
    expect(safeHeaders({ authorization: 'secret', 'set-cookie': 'secret', etag: 'v1' })).toEqual({ etag: 'v1' })
  })
})

describe('database capture and setup', () => {
  it('keeps every configured port inside the private block', async () => {
    const text = privateConfig(await readFile('supabase/config.toml', 'utf8'))
    expect(text).toContain('project_id = "pt4bafablelab"')
    expect(text).not.toMatch(/\b543\d\d\b/)
    expect(text).toContain('inspector_port = 57283')
    expect(text).toMatch(/\[db.migrations\][^[]*\nenabled = false/)
  })
  it('refuses backup include commands and wrong stack keys', () => {
    const data = 'INSERT INTO "public"."players" (id) VALUES (1);\nINSERT INTO "public"."leagues" (id) VALUES (1);'
    expect(backupTables(data)).toHaveLength(2)
    expect(() => backupTables(`${data}\n\\i secret.sql`)).toThrow()
    expect(() => stackValues('API_URL="http://127.0.0.1:57221"')).toThrow()
  })
  it('subtracts statement snapshots and rejects counter resets', () => {
    const before = [{ queryid: '1', toplevel: true, calls: 2, rows: 4, total_exec_time: 20, shared_blks_hit: 10 }]
    const after = [{ ...before[0], calls: 3, rows: 7, total_exec_time: 25, shared_blks_hit: 13 }]
    expect(statementDelta(before, after)[0]).toMatchObject({ calls: 1, rows: 3, total_exec_time: 5, shared_blks_hit: 3 })
    expect(() => statementDelta(after, before)).toThrow()
  })
  it('keeps identical statements separate across database roles', () => {
    const before = [{ queryid: '1', userid: 'a', dbid: 'lab', toplevel: true, calls: 10 }, { queryid: '1', userid: 'b', dbid: 'lab', toplevel: true, calls: 2 }]
    const after = before.map(row => ({ ...row, calls: row.calls + 1 }))
    expect(statementDelta(before, after).map((row: { calls: number }) => row.calls)).toEqual([1, 1])
  })
  it('fails preflight when a required command is missing', async () => {
    const execute = async (name: string) => ({ code: name === 'docker' ? 1 : 0, stdout: name === 'node' ? 'v22.23.3' : '', stderr: '' })
    const result = await preflight({ full: false, execute })
    expect(result.passed).toBe(false)
    expect(result.checks).toContainEqual({ name: 'docker', passed: false })
  })
  it('rejects missing checkpoint tools before starting the database', async () => {
    const execute = vi.fn(async (file: string) => ({ code: file === 'pg_dump' ? 127 : 0, stdout: file === 'node' ? 'v22.23.2' : '', stderr: '' }))
    const result = await preflight({ full: false, execute })
    expect(result.passed).toBe(false)
    expect(result.checks).toContainEqual({ name: 'pg_dump', passed: false })
    expect(execute.mock.calls.some(([file]) => file === 'pg_restore')).toBe(true)
  })
})

describe('frozen workload evidence', () => {
  it('covers each source route and every declared state', async () => {
    const work = await inventory()
    expect(work.routes.length).toBeGreaterThan(20)
    for (const surface of work.surfaces) expect(work.rows.filter((row: { surface: string }) => row.surface === surface.id)).toHaveLength(24)
    expect(new Set(work.rows.map((row: { id: string }) => row.id)).size).toBe(work.rows.length)
    expect(work.surfaces.some((row: { scenario?: string }) => row.scenario)).toBe(true)
  })
  it('rejects missing, stale and falsely green evidence', () => {
    const row = { id: 'home/member/final/offline', role: 'member', state: 'offline', day: 'final' }
    expect(evidenceFailures(row, null, 'current')).toEqual(['not run'])
    const failures = evidenceFailures(row, { id: row.id, fingerprint: 'old', webkit: { passed: true } }, 'current')
    expect(failures).toContain('different workload or source')
    expect(failures).toContain('webkit bytesIn missing')
    expect(failures).toContain('webkit offline content unproved')
    expect(failures).toContain('iPhone standalone emulation unproved')
  })
  it('rejects a fabricated artifact reference', async () => {
    const failures = await verifyArtifacts({ webkit: { har: '../outside.har' } }, '/nonexistent')
    expect(failures).toContain('webkit unsafe har')
    expect(failures.length).toBeGreaterThan(1)
  })
  it('ranks cost times frequency instead of a single slow sample', () => {
    expect(rankCosts([{ id: 'rare', dbMs: 100, frequency: 1 }, { id: 'frequent', dbMs: 20, frequency: 10 }]).map((row: { id: string }) => row.id)).toEqual(['frequent', 'rare'])
  })
})
