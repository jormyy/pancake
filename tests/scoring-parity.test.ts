import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { calculateFantasyPoints, roundFantasyPoints } from '@pancake/core'

// Scoring parity drift-guard.
//
// The fantasy-points formula lives in @pancake/core. Supabase Edge cannot import
// workspaces during deploy, so its deployable copy is generated from core and
// checked by generated-edge-shared.
//
// Covered copies:
//   - core/src/scoring/formula.ts            (canonical TS)
//   - supabase/functions/_shared/scoringCore.ts (generated Edge mirror)
//   - SQL compute_fantasy_points() + v_fantasy_points (latest migration)

const ROOT = path.resolve(__dirname, '..')

const TS_SCORERS: Record<string, string> = {
    core: 'core/src/scoring/formula.ts',
    edge: 'supabase/functions/_shared/scoringCore.ts',
}

// statField -> scoring_settings key. Order is irrelevant; presence is enforced.
const CATEGORY_PAIRS: [string, string][] = [
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
    const m = src.match(/stats\.points[\s\S]*?\(stats\.tripleDouble \? \(settings\.triple_double \?\? 0\) : 0\)/)
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

    it('the generated Edge implementation has byte-identical arithmetic', () => {
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
        expect(src).toContain('roundFantasyPoints(')
        expect(src).not.toContain('.toFixed(2)')
    })

    it('rounds fractional scoring weights to the same 2-decimal oracle', () => {
        expect(calculateFantasyPoints(
            {
                points: 1,
                rebounds: 1,
                assists: 0,
                steals: 0,
                blocks: 0,
                turnovers: 0,
                threePointersMade: 0,
                fieldGoalsMade: 0,
                fieldGoalsAttempted: 0,
                freeThrowsMade: 0,
                freeThrowsAttempted: 0,
                doubleDouble: false,
                tripleDouble: false,
                didNotPlay: false,
            },
            { points: 1 / 3, rebounds: 1 / 3 },
        )).toBe(0.67)
    })

    it('matches SQL half-away-from-zero rounding at cent ties', () => {
        expect(roundFantasyPoints(1.005)).toBe(1.01)
        expect(roundFantasyPoints(2.675)).toBe(2.68)
        expect(roundFantasyPoints(10.075)).toBe(10.08)
        expect(roundFantasyPoints(-1.005)).toBe(-1.01)
        expect(roundFantasyPoints(-2.675)).toBe(-2.68)
        expect(roundFantasyPoints(-10.075)).toBe(-10.08)
    })
})

describe('scoring parity — SQL copy', () => {
    const sql = latestScoringMigration()
    // Slice the fn body and the view body separately so each site is asserted
    // individually (a whole-file count can pass when only one site is correct).
    const fnBody = sql.slice(
        sql.indexOf('FUNCTION compute_fantasy_points'),
        sql.indexOf('CREATE OR REPLACE VIEW v_fantasy_points'),
    )
    const viewBody = sql.slice(sql.indexOf('VIEW v_fantasy_points'))

    const keysIn = (body: string): string[] =>
        [...new Set([...body.matchAll(/->>'([a-z_]+)'/g)].map((m) => m[1]).filter((k) => k !== 'scoring_settings'))].sort()

    it('compute_fantasy_points references exactly the canonical settings keys', () => {
        expect(keysIn(fnBody)).toEqual(ALL_SETTINGS_KEYS)
    })

    it('v_fantasy_points references exactly the canonical settings keys', () => {
        expect(keysIn(viewBody)).toEqual(ALL_SETTINGS_KEYS)
    })

    // Stat column ↔ settings key must be PAIRED (column name == key in this
    // schema): the first `->>'X'` after each `<prefix>.<key>` must be that key,
    // so a swap like `v_stats.points * (->>'rebounds')` fails.
    it('each SQL stat column is multiplied by its own settings key (fn + view, no swap)', () => {
        const firstKeyAfter = (body: string, prefix: string, col: string): string | null => {
            const idx = body.search(new RegExp(`${prefix}\\.${col}\\b`))
            if (idx < 0) return null
            const m = body.slice(idx).match(/->>'([a-z_]+)'/)
            return m ? m[1] : null
        }
        for (const key of ALL_SETTINGS_KEYS) {
            expect(firstKeyAfter(fnBody, 'v_stats', key), `fn: ${key} column paired with wrong key`).toBe(key)
            expect(firstKeyAfter(viewBody, 'pgs', key), `view: ${key} column paired with wrong key`).toBe(key)
        }
    })

    it('SQL fn and view each zero out DNP and filter to regular-season games', () => {
        expect(fnBody).toMatch(/did_not_play\s+THEN\s+RETURN\s+0/i)
        expect(viewBody).toMatch(/WHEN\s+pgs\.did_not_play\s+THEN\s+0/i)
        expect(fnBody, 'compute_fantasy_points missing regular-season purity filter').toMatch(/is_regular_season_game_id/i)
        expect(viewBody, 'v_fantasy_points missing regular-season purity filter').toMatch(/is_regular_season_game_id/i)
    })

    it('SQL fn and view each round per-game fantasy points to 2 decimals', () => {
        expect(fnBody).toMatch(/RETURN\s+ROUND\(v_total,\s*2\)/i)
        expect(viewBody).toMatch(/ELSE\s+ROUND\(/i)
    })
})

describe('regular-season game-id parity', () => {
    it('keeps the Edge adapter pointed at generated helpers', () => {
        expect(read('supabase/functions/_shared/nba.ts')).toContain("from './gameId.ts'")
    })

    it('keeps the generated Edge helper byte-identical to core', () => {
        const core = read('core/src/season/gameId.ts').replace(/\s+/g, '')
        const edge = read('supabase/functions/_shared/gameId.ts')
            .replace('// Generated by scripts/generate-edge-shared.mjs. Do not edit manually.', '')
            .replace(/\s+/g, '')
        expect(edge).toBe(core)
    })

    it('keeps SQL regular-season predicate aligned with the TypeScript rule', () => {
        const scoringCronAuctionMigration = read('supabase/migrations/20260626000002_exclude_non_regular_nba_games.sql')
        expect(scoringCronAuctionMigration).toContain("WHEN btrim(p_game_id) LIKE '002%' THEN true")
        expect(scoringCronAuctionMigration).toContain("WHEN btrim(p_game_id) ~ '^00[0-9]' THEN false")
        expect(scoringCronAuctionMigration).toContain('ELSE true')
    })
})
