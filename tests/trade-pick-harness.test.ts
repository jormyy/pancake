import { expect, it } from 'vitest'
import { extractTradePickTables } from './e2e/trade-pick-backup.mjs'
import { privateTradePickEnvironment } from './e2e/trade-pick-local-setup.mjs'
import { isLocalTradePickUrl } from './e2e/trade-pick-browser.mjs'

it('extracts only the trade reproduction tables from a backup', () => {
    const tables = ['leagues', 'league_members', 'league_seasons', 'players', 'roster_players', 'draft_picks', 'trades', 'trade_participants', 'trade_items', 'league_activity', 'roster_transactions']
    const data = [...tables.map(table => `INSERT INTO "public"."${table}" ("value") VALUES\n('Mike''s pick; keep this');`), 'INSERT INTO "auth"."users" ("secret") VALUES\n(\'must not copy\');'].join('\n')
    const result = extractTradePickTables(data)
    expect(result.match(/INSERT INTO/g)).toHaveLength(11)
    expect(result).toContain("Mike''s pick; keep this")
    expect(result).not.toContain('must not copy')
    expect(() => extractTradePickTables('')).toThrow()
})

it('rejects a different stack before writing local settings', () => {
    const status = { API_URL: 'http://127.0.0.1:59621', DB_URL: 'postgresql://postgres:postgres@127.0.0.1:59622/postgres', ANON_KEY: 'local', SERVICE_ROLE_KEY: 'local' }
    expect(privateTradePickEnvironment(status).EXPO_PUBLIC_SUPABASE_URL).toBe(status.API_URL)
    expect(() => privateTradePickEnvironment({ ...status, API_URL: 'https://example.supabase.co' })).toThrow()
    expect(() => privateTradePickEnvironment({ ...status, DB_URL: 'postgresql://localhost:54322/postgres' })).toThrow()
    expect(() => privateTradePickEnvironment({ ...status, DB_URL: 'postgresql://example.com:59622/postgres' })).toThrow()
})

it('blocks hosted browser requests in the local reproduction', () => {
    expect(isLocalTradePickUrl('http://127.0.0.1:59680/trades')).toBe(true)
    expect(isLocalTradePickUrl('https://example.supabase.co/auth/v1/token')).toBe(false)
    expect(isLocalTradePickUrl('https://vercel.com')).toBe(false)
})
