import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationsDirectory = path.join(process.cwd(), 'supabase/migrations')
const read = (filename: string) => readFileSync(path.join(migrationsDirectory, filename), 'utf8')
const blocking = /\b(?:ALTER TABLE|DROP TABLE|DROP TRIGGER|DROP INDEX|UPDATE public\.)\b/gi
const bounded = (source: string) => {
    const blockingOffsets = [...source.matchAll(blocking)].map((match) => match.index)
    if (blockingOffsets.length === 0) return false
    const firstBlocking = blockingOffsets[0]
    const lastBlocking = blockingOffsets.at(-1)!
    const lockTimeout = source.indexOf("SET lock_timeout = '5s';")
    const statementTimeout = source.indexOf("SET statement_timeout = '2min';")
    const statementReset = source.lastIndexOf('RESET statement_timeout;')
    const lockReset = source.lastIndexOf('RESET lock_timeout;')
    return lockTimeout >= 0 && statementTimeout >= 0 &&
        lockTimeout < firstBlocking && statementTimeout < firstBlocking &&
        statementReset > lastBlocking && lockReset > lastBlocking
}
const onlineRouteConstraintSequence = (source: string, route: 'from' | 'to') => {
    const constraint = `trade_items_${route}_member_present`
    const column = `${route}_member_id`
    const notValid = source.indexOf(`${constraint} CHECK (${column} IS NOT NULL) NOT VALID`)
    const validate = source.indexOf(`VALIDATE CONSTRAINT ${constraint}`)
    const setNotNull = source.indexOf(`ALTER COLUMN ${column} SET NOT NULL`)
    return notValid >= 0 && validate > notValid && setNotNull > validate
}

describe('branch migration deployment safety', () => {
    it('bounds every blocking migration from the trade hardening series onward', () => {
        const migrations = readdirSync(migrationsDirectory)
            .filter((filename) => filename.endsWith('.sql') && filename >= '20260709100024_')
            .filter((filename) => new RegExp(blocking.source, 'i').test(read(filename)))

        expect(migrations).not.toEqual([])
        for (const migration of migrations) expect(bounded(read(migration)), migration).toBe(true)

        const mutation = read('20260709100027_sleeper_lazy_roster_limits.sql')
            .replace('RESET statement_timeout;', '')
            .replace('RESET lock_timeout;', '')
            .replace(
                "SET statement_timeout = '2min';",
                "SET statement_timeout = '2min';\nRESET statement_timeout;\nRESET lock_timeout;",
            )
        expect(bounded(mutation)).toBe(false)
    })

    it.each(['from', 'to'] as const)(
        'validates the %s route online before taking the short NOT NULL lock',
        (route) => {
            const migration = read('20260709100024_trade_route_and_feed_hardening.sql')
            expect(onlineRouteConstraintSequence(migration, route)).toBe(true)

            const constraint = `trade_items_${route}_member_present`
            const column = `${route}_member_id`
            const mutation = migration.replace(
                `${constraint} CHECK (${column} IS NOT NULL) NOT VALID`,
                `${constraint} CHECK (${column} IS NOT NULL)`,
            )
            expect(onlineRouteConstraintSequence(mutation, route)).toBe(false)
        },
    )

    it('records the canonical acceptance route and complete index cleanup additively', () => {
        const canonical = readFileSync(
            path.join(process.cwd(), 'supabase/sql/functions/by-name/private/accept_trade_participant_atomic.sql'),
            'utf8',
        )
        const additive = read('20260709100031_finalize_trade_route_and_index_ownership.sql')

        expect(canonical).toContain('private.assert_trade_assets_acceptance_ready')
        expect(canonical).not.toContain('accepted_item.player_id')
        expect(canonical).not.toContain('accepted_item.pick_id')
        expect(canonical).not.toContain('accepted_item.side')
        expect(additive).toContain('accepted_item.from_member_id = v_from_member')
        expect(additive).not.toContain('accepted_item.side')
        const assetAssertion = read('20260709100032_canonical_trade_asset_acceptance_assertion.sql')
        expect(assetAssertion).toContain('private.assert_trade_assets_acceptance_ready')
        expect(assetAssertion).not.toContain('FOR v_item IN')
        for (const index of [
            'idx_trades_league_proposer_recent',
            'idx_trades_league_recipient_recent',
            'idx_trades_member_proposed',
            'idx_trades_recipient_proposed',
            'idx_trades_vetoable_recent',
        ]) expect(additive).toContain(`DROP INDEX IF EXISTS public.${index};`)
    })
})
