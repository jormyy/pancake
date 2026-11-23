import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import rosterLockScope, { rosterLockScopeFailures } from '../scripts/db-source-rules/roster-lock-scope.mjs'
import { latestFunctionDefinitions } from '../scripts/check-db-function-sources.mjs'

const fn = (name: string, body: string, header = 'RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public') =>
    `CREATE OR REPLACE FUNCTION ${name}(p_league_id uuid, p_member_id uuid, p_player_id uuid)\n${header}\nAS $$\nBEGIN\n${body}\nEND;\n$$;\n`

describe('roster lock scope rule', () => {
    it('flags the de0fbd0d toggle that row-locked roster_players before its player lock', async () => {
        const fixture = await readFile('tools/formal/lock-order/fixtures/drop-row-lock-first/bad/functions.sql', 'utf8')
        const failures = rosterLockScopeFailures(fixture, 'bad.sql')

        expect(failures).toContainEqual(expect.stringMatching(/public\.toggle_ir_atomic.* locks roster_players rows before its roster locks; take roster locks through private\.lock_roster_scope before any row lock\./))
    })

    it('flags the c271b58e waiver edit that row-locked claims with no team or player lock', () => {
        const failures = rosterLockScopeFailures(fn('public.edit_waiver_claim_atomic', `
  SELECT 1 FROM waiver_claims WHERE id = p_player_id FOR UPDATE;
  UPDATE waiver_claims SET bid_amount = 1 WHERE id = p_player_id;`), 'c271b58e.sql')

        expect(failures).toEqual([expect.stringMatching(/edit_waiver_claim_atomic.* locks waiver_claims rows to write them without team or player locks/)])
    })

    it('flags raw team and player advisory locks outside the helper', () => {
        const failures = rosterLockScopeFailures(fn('public.add_free_agent_atomic', `
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));`), 'raw.sql')

        expect(failures).toEqual([expect.stringMatching(/takes a raw team or player advisory lock; take roster locks through private\.lock_roster_scope/)])
    })

    it('accepts roster locks taken through the helper before any row lock', () => {
        expect(rosterLockScopeFailures(fn('public.drop_player_atomic', `
  PERFORM private.lock_roster_scope(p_league_id, ARRAY[p_member_id], ARRAY[p_player_id]);
  PERFORM 1 FROM roster_players WHERE id = p_player_id FOR UPDATE;
  UPDATE roster_players SET is_on_ir = true WHERE id = p_player_id;`), 'ok.sql')).toEqual([])
    })

    it('flags a row lock taken before a later helper call', () => {
        expect(rosterLockScopeFailures(fn('public.drop_player_atomic', `
  PERFORM 1 FROM drafts WHERE id = p_player_id FOR UPDATE;
  PERFORM private.lock_roster_scope(p_league_id, ARRAY[p_member_id], '{}');`), 'late.sql')).toEqual([expect.stringMatching(/locks drafts rows before its roster locks/)])
    })

    it('keeps non-blocking try locks and season locks outside the rule', () => {
        expect(rosterLockScopeFailures(fn('public.process_next_waiver_claim_atomic', `
  IF NOT pg_try_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text)) THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_season_id::text));
  PERFORM 1 FROM waiver_claims WHERE id = p_player_id FOR UPDATE SKIP LOCKED;`), 'try.sql')).toEqual([])
    })

    it('ignores the lock text inside comments and strings', () => {
        expect(rosterLockScopeFailures(fn('public.notes', `
  -- PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));
  RAISE NOTICE 'pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text))';`), 'notes.sql')).toEqual([])
    })

    it('passes every latest migration definition', async () => {
        expect(await rosterLockScope({ definitions: await latestFunctionDefinitions() })).toEqual([])
    })
})

