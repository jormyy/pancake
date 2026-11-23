import { describe, expect, it } from 'vitest'

const actor = 'p_trade_id uuid, p_member_id uuid, p_user_id uuid'

const action = (name: string, body: string, parameters = actor) => `
CREATE OR REPLACE FUNCTION ${name}(${parameters})
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_trade trades%ROWTYPE;
  __request_context jsonb;
BEGIN
${body}
END;
$$;`

const failures = async (sql: string) => {
  const { functionDefinitionsInSource } = await import('../scripts/check-db-function-sources.mjs')
  const { tradeEntryOrderFailuresIn } = await import('../scripts/db-source-rules/trade-entry-order.mjs')
  return tradeEntryOrderFailuresIn(functionDefinitionsInSource(sql))
}

const gate = "  v_trade := private.begin_trade_action(p_trade_id, p_member_id, p_user_id, 'edit');"

describe('trade entry order rule', () => {
  it.each([
    ['an expiry write before the actor check', 'private.replace_trade_offer', `
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  IF v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired' WHERE id = p_trade_id;
    RETURN NULL;
  END IF;
${gate}`, actor],
    ['a trade row lock before team and player locks', 'private.accept_trade_participant_atomic', `
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(p_member_id::text));`, 'p_trade_id uuid, p_accepting_member_id uuid'],
    ['a receipt replay before membership', 'public.reject_trade_atomic', `
  __request_context := private.request_begin('public.reject_trade_atomic', '[]', NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
${gate}`, actor],
  ])('rejects %s and names the fix', async (_label, name, body, parameters) => {
    expect(await failures(action(name, body, parameters))).toEqual([
      expect.stringMatching(new RegExp(`^${name.replace('.', '\\.')} line \\d+ .*Call private\\.begin_trade_action before writing or replaying \\(members, players, then trade; see 20261011000043\\)$`)),
    ])
  })

  it('accepts validation before the gate and every effect after it', async () => {
    expect(await failures(action('public.reject_trade_atomic', `
  IF p_trade_id IS NULL THEN RAISE EXCEPTION 'A trade is required.'; END IF;
${gate}
  __request_context := private.request_begin('public.reject_trade_atomic', '[]', NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  UPDATE trades SET status = 'rejected' WHERE id = p_trade_id;
  RETURN '{}';`))).toEqual([])
  })

  it('allows the queue batch to claim rows with SKIP LOCKED', async () => {
    expect(await failures(action('public.process_due_accepted_trades_atomic', `
  PERFORM 1 FROM trades WHERE status = 'accepted' FOR UPDATE SKIP LOCKED;`, 'p_limit int'))).toEqual([])
  })
})
