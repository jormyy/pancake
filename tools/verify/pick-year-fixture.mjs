import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const targetLeagueId = 'faab8d8f-6a60-4bbc-8f5d-44050b652cdd'
const uuid = value => assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const literal = value => `'${String(value).replaceAll("'", "''")}'`

export function preparePickYearFixture(snapshot, seed, query) {
  assert.equal(snapshot.league_id, targetLeagueId)
  assert.equal(snapshot.picks.length, 150)
  assert.match(snapshot.before_sha256, /^[0-9a-f]{64}$/)
  assert.match(snapshot.after_sha256, /^[0-9a-f]{64}$/)
  assert.notEqual(snapshot.before_sha256, snapshot.after_sha256)
  assert.equal(seed.users.length, 10)
  for (const user of seed.users) uuid(user.id)
  assert.equal(new Set(seed.users.map(user => user.id)).size, 10)
  for (const pick of snapshot.picks) {
    for (const id of [pick.id, pick.original_owner_id, pick.current_owner_id]) uuid(id)
    assert.ok(Number.isInteger(pick.season_year) && pick.season_year >= 2028 && pick.season_year <= 2032)
    assert.ok([1, 2, 3].includes(pick.round))
    assert.equal(pick.is_used, false)
    assert.equal(pick.used_at, null)
    assert.equal(pick.rookie_draft_id, null)
    assert.equal(pick.protections, null)
    assert.ok(typeof pick.created_at === 'string' && Number.isFinite(Date.parse(pick.created_at)))
  }
  assert.equal(new Set(snapshot.picks.map(pick => pick.id)).size, 150)
  assert.equal(new Set(snapshot.picks.map(pick => `${pick.original_owner_id}/${pick.season_year}/${pick.round}`)).size, 150)
  const owners = [...new Set(snapshot.picks.map(pick => pick.original_owner_id))].sort()
  assert.equal(owners.length, 10)
  assert.ok(snapshot.picks.every(pick => owners.includes(pick.current_owner_id)))
  const transferred = snapshot.picks.filter(pick => pick.current_owner_id !== pick.original_owner_id)
  assert.equal(transferred.length, 7)
  const acquired = id => transferred.filter(pick => pick.current_owner_id === id).length
  owners.sort((a, b) => acquired(b) - acquired(a) || a.localeCompare(b))
  const memberId = owners[0]
  const ownerNames = Object.fromEntries(owners.map((id, index) => [id, `Year Team ${index + 1}`]))
  const userByMember = Object.fromEntries(owners.map((id, index) => [id, seed.users[index].id]))
  const listed = transferred.filter(pick => pick.current_owner_id === memberId)
    .sort((a, b) => a.season_year - b.season_year || a.round - b.round || a.id.localeCompare(b.id))[0]
  assert.ok(listed)
  transferred.sort((a, b) => Number(b.id === listed.id) - Number(a.id === listed.id) || a.id.localeCompare(b.id))
  const seasonId = randomUUID()
  const quoteId = randomUUID()
  const historyVersion = 'pick-year-verification-v1'
  const unrelatedPlayerId = randomUUID()
  const terms = [
    { fromMemberId: listed.original_owner_id, toMemberId: listed.current_owner_id, playerId: null, pickId: listed.id, faabAmount: 0 },
    { fromMemberId: listed.current_owner_id, toMemberId: listed.original_owner_id, playerId: null, pickId: null, faabAmount: 1 },
  ]
  const inputs = {
    leagueId: targetLeagueId, seasonId, seasonYear: 2027, teams: 10, rosterSize: 14, faabBudget: 100,
    terms, players: [{ player_id: unrelatedPlayerId, seasonYear: 2027 }], replacementPlayers: [],
    picks: [{ id: listed.id, seasonYear: listed.season_year, round: listed.round, ownerId: listed.original_owner_id,
      originalOwnerId: listed.original_owner_id, originalTeamName: ownerNames[listed.original_owner_id], slot: null,
      valueBands: { early: 123, mid: 123, late: 123 } }],
  }
  const analysis = {
    strategy: 'overall', confidence: 1, missingInputs: [], assumptions: [], sources: [],
    teams: [listed.original_owner_id, listed.current_owner_id].map(id => ({ memberId: id,
      valuesSent: 123, valuesReceived: 123, shortTermPoints: 0, longTermValue: 0,
      packageEffect: 0, replacementEffect: 0, rosterSlotEffect: 0, impact: 0, netValue: 0, adjustedValue: 123 })),
    assets: [{ assetId: listed.id, kind: 'pick', label: `${listed.season_year - 1} Round ${listed.round} · ${ownerNames[listed.original_owner_id]}`,
      values: { overall: 123, contend: 123, rebuild: 123 }, ranges: {},
      components: { production: 0, projection: 0, market: 123, age: 1, healthMultiplier: 1,
        movementMultiplier: 1, replacement: 0, rosterSlot: 0, package: 0, shortTermPoints: 0, longTermValue: 123 },
      sources: [], confidence: 1, missingInputs: [], assumptions: [] }],
  }
  const memberValues = owners.map((id, index) => `(${literal(id)},${literal(targetLeagueId)},${literal(seed.users[index].id)},${literal(index === 0 ? 'commissioner' : 'manager')}::public.league_member_role,${literal(ownerNames[id])})`).join(',\n')
  const transfers = transferred.map(pick => `
    PERFORM set_config('request.jwt.claim.sub',${literal(userByMember[pick.original_owner_id])},true);
    trade_id := public.propose_trade_atomic(${literal(targetLeagueId)},${literal(seasonId)},
      ${literal(pick.original_owner_id)},${literal(pick.current_owner_id)},'{}'::uuid[],'{}'::uuid[],
      ARRAY[${literal(pick.id)}::uuid],'{}'::uuid[],'Pick year verification',NULL,0,1);
    trade_ids := array_append(trade_ids,trade_id);
    PERFORM set_config('request.jwt.claim.sub',${literal(userByMember[pick.current_owner_id])},true);
    PERFORM public.accept_trade_atomic(trade_id,${literal(pick.current_owner_id)});
    PERFORM public.complete_accepted_trade_atomic(trade_id);
    IF (SELECT status FROM public.trades WHERE id=trade_id) IS DISTINCT FROM 'completed'::public.trade_status THEN
      RAISE EXCEPTION 'Pick year fixture trade did not complete';
    END IF;`).join('\n')
  const sql = `BEGIN;
    SET LOCAL statement_timeout='60s';
    SET LOCAL lock_timeout='5s';
    CREATE TEMP TABLE pick_year_fixture_result(payload jsonb) ON COMMIT DROP;
    DO $fixture$
    DECLARE
      expected jsonb := ${literal(JSON.stringify(snapshot.picks))}::jsonb;
      frozen_inputs jsonb := ${literal(JSON.stringify(inputs))}::jsonb;
      frozen_analysis jsonb := ${literal(JSON.stringify(analysis))}::jsonb;
      trade_id uuid;
      trade_ids uuid[] := '{}';
      frozen_quote jsonb;
    BEGIN
      IF EXISTS(SELECT 1 FROM public.leagues WHERE id=${literal(targetLeagueId)}) THEN
        RAISE EXCEPTION 'Pick year fixture target league already exists';
      END IF;
      INSERT INTO public.leagues(id,name,slug,commissioner_id,status,future_pick_years,waiver_mode,trade_veto_mode,faab_starting_budget)
      VALUES(${literal(targetLeagueId)},'Draft year verification','draft-year-verification',${literal(seed.users[0].id)},'active',5,'faab','disabled',100);
      INSERT INTO public.league_seasons(id,league_id,season_year,is_current)
      VALUES(${literal(seasonId)},${literal(targetLeagueId)},2027,true);
      INSERT INTO public.league_members(id,league_id,user_id,role,team_name) VALUES ${memberValues};
      INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance)
      SELECT ${literal(targetLeagueId)},${literal(seasonId)},id,100 FROM public.league_members WHERE league_id=${literal(targetLeagueId)}
      ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=EXCLUDED.balance;
      INSERT INTO public.draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id,is_used,used_at,rookie_draft_id,created_at)
      SELECT (pick->>'id')::uuid,${literal(targetLeagueId)},(pick->>'season_year')::int,(pick->>'round')::int,
        (pick->>'original_owner_id')::uuid,(pick->>'original_owner_id')::uuid,false,NULL,NULL,(pick->>'created_at')::timestamptz
      FROM jsonb_array_elements(expected) pick;
      ${transfers}
      IF (SELECT count(*) FROM public.draft_picks WHERE league_id=${literal(targetLeagueId)})<>150 OR EXISTS(
        SELECT 1 FROM jsonb_array_elements(expected) expected_pick
        LEFT JOIN public.draft_picks pick ON pick.id=(expected_pick->>'id')::uuid
        WHERE pick.id IS NULL OR pick.league_id IS DISTINCT FROM ${literal(targetLeagueId)}::uuid
          OR pick.season_year IS DISTINCT FROM (expected_pick->>'season_year')::int
          OR pick.round IS DISTINCT FROM (expected_pick->>'round')::int
          OR pick.original_owner_id IS DISTINCT FROM (expected_pick->>'original_owner_id')::uuid
          OR pick.current_owner_id IS DISTINCT FROM (expected_pick->>'current_owner_id')::uuid
          OR pick.created_at IS DISTINCT FROM (expected_pick->>'created_at')::timestamptz
          OR pick.is_used OR pick.used_at IS NOT NULL OR pick.rookie_draft_id IS NOT NULL
      ) THEN RAISE EXCEPTION 'Pick year fixture does not match its filtered before snapshot'; END IF;
      INSERT INTO public.trade_estimate_quotes(id,league_id,league_season_id,member_id,terms,inputs,analysis,model_version,input_version,expires_at)
      VALUES(${literal(quoteId)},${literal(targetLeagueId)},${literal(seasonId)},${literal(listed.original_owner_id)},
        frozen_inputs->'terms',frozen_inputs,frozen_analysis,'onenumber-trade-curve-v6',md5(frozen_inputs::text),now()+interval '1 hour');
      INSERT INTO public.trade_estimates(trade_id,quote_id) VALUES(trade_ids[1],${literal(quoteId)})
      ON CONFLICT(trade_id) DO UPDATE SET quote_id=EXCLUDED.quote_id,unavailable_reason=NULL;
      SELECT to_jsonb(quote) INTO frozen_quote FROM public.trade_estimate_quotes quote WHERE id=${literal(quoteId)};
      INSERT INTO public.trade_estimate_history(trade_id,formula_version,quote_id,snapshot)
      VALUES(trade_ids[1],${literal(historyVersion)},${literal(quoteId)},
        jsonb_build_object('inputs',frozen_inputs,'quote',frozen_quote,'analysis',frozen_analysis,'value',123));
      INSERT INTO public.trade_value_cache(trade_id,league_id,league_season_id,revaluation,valid_until,version)
      VALUES(trade_ids[1],${literal(targetLeagueId)},${literal(seasonId)},
        jsonb_build_object('tradeId',trade_ids[1],'analysis',frozen_analysis,'modelVersion','onenumber-trade-curve-v6','inputVersion',md5(frozen_inputs::text),'seasonYear',2027),
        now()+interval '1 hour',1)
      ON CONFLICT(trade_id) DO UPDATE SET revaluation=EXCLUDED.revaluation,valid_until=EXCLUDED.valid_until,version=EXCLUDED.version;
      PERFORM set_config('request.jwt.claim.sub',${literal(seed.users[0].id)},true);
      PERFORM public.add_trade_block_item_atomic(${literal(memberId)},${literal(targetLeagueId)},NULL,${literal(listed.id)},'Calendar year fixture',${literal(seed.users[0].id)});
      INSERT INTO pick_year_fixture_result(payload) VALUES(jsonb_build_object('tradeIds',trade_ids));
    END;
    $fixture$;
    SELECT payload FROM pick_year_fixture_result;
    COMMIT;`
  const output = query(sql)
  const line = String(output).trim().split('\n').findLast(value => value.trimStart().startsWith('{'))
  assert.ok(line, 'Fixture query must return its completed trade IDs')
  const result = JSON.parse(line)
  assert.equal(result.tradeIds.length, 7)
  for (const id of result.tradeIds) uuid(id)
  assert.equal(new Set(result.tradeIds).size, 7)
  return { leagueId: targetLeagueId, seasonId, memberId, ownerNames, userByMember,
    tradeIds: result.tradeIds, quoteId, historyVersion, listedPickId: listed.id }
}
