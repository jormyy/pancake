import { describe, expect, it } from 'vitest'

const fn = (body: string) => `
CREATE OR REPLACE FUNCTION public.example_trade_action(p_trade_id uuid, p_member_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_trade trades%ROWTYPE;
BEGIN
${body}
END;
$$;`

const failures = async (sql: string) => {
  const { functionDefinitionsInSource } = await import('../scripts/check-db-function-sources.mjs')
  const { twoPartyFailuresIn } = await import('../scripts/db-source-rules/no-two-party-columns.mjs')
  return twoPartyFailuresIn(functionDefinitionsInSource(sql))
}

const named = (statement: string) => expect.stringMatching(new RegExp(
  `^public\\.example_trade_action line \\d+ \\(${statement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\): Read trade_participants / trade_items\\.from_member_id; two-team columns are display-only\\.$`))

describe('two-party column rule', () => {
  it.each([
    ['a party check on the two-team columns', 'v_party := p_member_id IN (v_trade.proposer_member_id, v_trade.recipient_member_id);'],
    ['a notification sent to the recipient column', 'v_single_recipient := v_trade.recipient_member_id;'],
    ['an owner taken from the item side', "SELECT CASE WHEN item.side = 'proposer' THEN 1 END FROM trade_items item;"],
    ['a side compared with a typed literal', "PERFORM 1 FROM trade_items item WHERE 'recipient'::trade_side = item.side;"],
  ])('rejects %s and names the fix', async (_label, statement) => {
    expect(await failures(fn(`  ${statement}`))).toEqual([named(statement)])
  })

  it('allows display output, new-row writes, and comments', async () => {
    expect(await failures(fn(`
  -- recipient_member_id is display-only
  INSERT INTO trades (league_id, proposer_member_id, recipient_member_id) VALUES (NULL, NULL, NULL);
  INSERT INTO trade_items (trade_id, side) VALUES (p_trade_id, 'proposer'::trade_side);
  SELECT member_id FROM trade_participants WHERE trade_id = p_trade_id AND member_id <> p_member_id;
  RETURN jsonb_build_object('recipientMemberId', v_trade.recipient_member_id, 'note', 'recipient_member_id');`))).toEqual([])
  })
})
