import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationsDirectory = path.join(process.cwd(), 'supabase/migrations')
const read = (filename: string) => readFileSync(path.join(migrationsDirectory, filename), 'utf8')
const bounded = (source: string) =>
    source.includes("SET lock_timeout = '5s';") &&
    source.includes("SET statement_timeout = '2min';") &&
    source.includes('RESET statement_timeout;') &&
    source.includes('RESET lock_timeout;')
const onlineRouteConstraintSequence = (source: string) => {
    const notValid = source.indexOf('trade_items_from_member_present CHECK (from_member_id IS NOT NULL) NOT VALID')
    const validate = source.indexOf('VALIDATE CONSTRAINT trade_items_from_member_present')
    const setNotNull = source.indexOf('ALTER COLUMN from_member_id SET NOT NULL')
    return notValid >= 0 && validate > notValid && setNotNull > validate
}

describe('branch migration deployment safety', () => {
    it('bounds every blocking migration from the trade hardening series onward', () => {
        const blocking = /\b(?:ALTER TABLE|DROP TABLE|DROP TRIGGER|DROP INDEX|UPDATE public\.)\b/i
        const migrations = readdirSync(migrationsDirectory)
            .filter((filename) => filename.endsWith('.sql') && filename >= '20260709100024_')
            .filter((filename) => blocking.test(read(filename)))

        expect(migrations).not.toEqual([])
        for (const migration of migrations) expect(bounded(read(migration)), migration).toBe(true)

        const mutation = read('20260709100027_sleeper_lazy_roster_limits.sql')
            .replace("SET lock_timeout = '5s';", '')
        expect(bounded(mutation)).toBe(false)
    })

    it('validates route presence online before taking the short NOT NULL lock', () => {
        const migration = read('20260709100024_trade_route_and_feed_hardening.sql')
        expect(onlineRouteConstraintSequence(migration)).toBe(true)

        const mutation = migration.replace(
            'trade_items_from_member_present CHECK (from_member_id IS NOT NULL) NOT VALID',
            'trade_items_from_member_present CHECK (from_member_id IS NOT NULL)',
        )
        expect(onlineRouteConstraintSequence(mutation)).toBe(false)
    })

    it('records the canonical acceptance route and complete index cleanup additively', () => {
        const canonical = readFileSync(
            path.join(process.cwd(), 'supabase/sql/functions/by-name/private/accept_trade_participant_atomic.sql'),
            'utf8',
        )
        const additive = read('20260709100031_finalize_trade_route_and_index_ownership.sql')

        expect(canonical).toContain('accepted_item.from_member_id = v_from_member')
        expect(canonical).not.toContain('accepted_item.side')
        expect(additive).toContain('accepted_item.from_member_id = v_from_member')
        expect(additive).not.toContain('accepted_item.side')
        for (const index of [
            'idx_trades_league_proposer_recent',
            'idx_trades_league_recipient_recent',
            'idx_trades_member_proposed',
            'idx_trades_recipient_proposed',
            'idx_trades_vetoable_recent',
        ]) expect(additive).toContain(`DROP INDEX IF EXISTS public.${index};`)
    })
})
