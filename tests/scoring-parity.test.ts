import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

// Scoring parity drift-guard.
//
// The fantasy-points formula is physically duplicated because Railway (backend)
// and Supabase Edge (Deno) deploys cannot resolve the @pancake/core workspace
// package, and Postgres needs its own copy. There is therefore no single
// importable source of truth — so this test IS the source of truth: it fails the
// build the moment any copy's arithmetic or category set drifts from the others.
//
// Covered copies:
//   - core/src/scoring/formula.ts            (canonical TS)
//   - backend/src/lib/scoring.ts             (authoritative matchup scorer)
//   - supabase/functions/_shared/scoring.ts  (edge mirror)
//   - SQL compute_fantasy_points() + v_fantasy_points (latest migration)

const ROOT = path.resolve(__dirname, '..')

const TS_SCORERS: Record<string, string> = {
    core: 'core/src/scoring/formula.ts',
    backend: 'backend/src/lib/scoring.ts',
    edge: 'supabase/functions/_shared/scoring.ts',
}

// statField -> scoring_settings key. Order is irrelevant; presence is enforced.
const CATEGORY_PAIRS: Array<[string, string]> = [
    ['stats.points', 'points'],
    ['stats.rebounds', 'rebounds'],
    ['stats.assists', 'assists'],
    ['stats.steals', 'steals'],
    ['stats.blocks', 'blocks'],
    ['stats.turnovers', 'turnovers'],
    ['stats.threePointersMade', 'three_pointers_made'],
    ['stats.fieldGoalsMade', 'field_goals_made'],
    ['stats.fieldGoalsAttempted', 'field_goals_attempted'],
    ['stats.freeThrowsMade', 'free_throws_made'],
    ['stats.freeThrowsAttempted', 'free_throws_attempted'],
]
const BONUS_KEYS = ['double_double', 'triple_double']
const ALL_SETTINGS_KEYS = [...CATEGORY_PAIRS.map(([, k]) => k), ...BONUS_KEYS].sort()

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')

const extractTsFormula = (src: string): string => {
    const m = src.match(/stats\.points[\s\S]*?\.toFixed\(2\)/)
    if (!m) throw new Error('calculateFantasyPoints arithmetic block not found')
    return m[0].replace(/\s+/g, '')
}

const latestScoringMigration = (): string => {
    const dir = path.join(ROOT, 'supabase/migrations')
    const defining = readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .filter((f) => /FUNCTION\s+compute_fantasy_points/i.test(readFileSync(path.join(dir, f), 'utf8')))
        .sort()
    if (!defining.length) throw new Error('no migration defines compute_fantasy_points')
    return readFileSync(path.join(dir, defining[defining.length - 1]), 'utf8')
}

describe('scoring parity — TS copies', () => {
    const blocks = Object.fromEntries(
        Object.entries(TS_SCORERS).map(([name, rel]) => [name, extractTsFormula(read(rel))]),
    )

    it('all three TS implementations have byte-identical arithmetic', () => {
        expect(blocks.backend).toBe(blocks.core)
        expect(blocks.edge).toBe(blocks.core)
    })

    it.each(Object.keys(TS_SCORERS))('%s scores every category against the right settings key', (name) => {
        const block = blocks[name]
        for (const [field, key] of CATEGORY_PAIRS) {
            expect(block).toContain(`${field}*(settings.${key}??0)`)
        }
        expect(block).toContain('(stats.doubleDouble?(settings.double_double??0):0)')
        expect(block).toContain('(stats.tripleDouble?(settings.triple_double??0):0)')
    })

    it.each(Object.entries(TS_SCORERS))('%s short-circuits DNP and rounds to 2 decimals', (_name, rel) => {
        const src = read(rel).replace(/\s+/g, '')
        expect(src).toContain('if(stats.didNotPlay)return0')
        expect(src).toContain('.toFixed(2)')
    })
})

describe('scoring parity — SQL copy', () => {
    const sql = latestScoringMigration()

    it('compute_fantasy_points references exactly the canonical settings keys', () => {
        const fn = sql.slice(sql.indexOf('FUNCTION compute_fantasy_points'), sql.indexOf('CREATE OR REPLACE VIEW v_fantasy_points'))
        const keys = [...fn.matchAll(/->>'([a-z_]+)'/g)].map((m) => m[1]).filter((k) => k !== 'scoring_settings')
        expect([...new Set(keys)].sort()).toEqual(ALL_SETTINGS_KEYS)
    })

    it('v_fantasy_points references exactly the canonical settings keys', () => {
        const view = sql.slice(sql.indexOf('VIEW v_fantasy_points'))
        const keys = [...view.matchAll(/->>'([a-z_]+)'/g)].map((m) => m[1])
        expect([...new Set(keys)].sort()).toEqual(ALL_SETTINGS_KEYS)
    })

    it('SQL fn and view both zero out DNP and filter to regular-season games', () => {
        expect(sql).toMatch(/did_not_play\s+THEN\s+RETURN\s+0/i)
        expect(sql).toMatch(/WHEN\s+pgs\.did_not_play\s+THEN\s+0/i)
        // regular-season purity must be enforced in both the fn and the view
        const purityMatches = sql.match(/is_regular_season_game_id/gi) ?? []
        expect(purityMatches.length).toBeGreaterThanOrEqual(2)
    })
})
