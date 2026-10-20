import { strict as assert } from 'node:assert'
import { connect } from './request-driver.ts'
import { guardTarget } from './profile.ts'

Deno.test({
  name: 'distinct-first stale weeks preserve certificates, corrections, consumed rows and retired inputs',
  ignore: !Deno.env.get('SUPABASE_DB_URL'),
  async fn() {
    const db = Deno.env.get('SUPABASE_DB_URL')!
    guardTarget(db, '56322')
    const sql = connect(db)
    try {
      const [{ season }] = await sql`SELECT bench.profile_id(100001) season`
      const original = async () => await sql`SELECT DISTINCT matchup.week_number
        FROM public.matchups matchup
        LEFT JOIN private.score_week_certificates certificate ON certificate.league_season_id=matchup.league_season_id AND certificate.week_number=matchup.week_number
        WHERE matchup.league_season_id=${season} AND matchup.week_number<=20
          AND NOT EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id=${season})
          AND matchup.is_finalized IS TRUE AND NOT matchup.is_voided
          AND NOT private.playoff_matchup_is_consumed(matchup.id)
          AND (certificate.input_token IS NULL OR certificate.input_token IS DISTINCT FROM private.score_input_token(${season},matchup.week_number))
        ORDER BY matchup.week_number`
      const current = async () => await sql`SELECT * FROM public.get_stale_score_weeks(${season},20)`
      const equal = async () => {
        const actual = Array.from(await current(), row => row.week_number)
        assert.deepEqual(actual, Array.from(await original(), row => row.week_number))
        assert.equal(new Set(actual).size, actual.length)
        return actual
      }
      assert.deepEqual(await equal(), [])
      for (const scenario of ['missing', 'stale', 'correction', 'result-race', 'voided', 'retired', 'consumed', 'mixed']) {
        await sql.unsafe('BEGIN')
        try {
          const [{ token }] = await sql`SELECT public.capture_score_inputs(${season},3) token`
          const [{ payload }] = await sql`SELECT jsonb_build_array(jsonb_build_object('id',id,'input_token',${sql.json(token)}::jsonb,
            'home_points',home_points,'away_points',away_points,'home_max_possible_points',home_max_possible_points,
            'away_max_possible_points',away_max_possible_points,'winner_member_id',winner_member_id)) payload
            FROM public.matchups WHERE league_season_id=${season} AND week_number=3 ORDER BY id LIMIT 1`
          if (scenario === 'missing' || scenario === 'voided' || scenario === 'consumed' || scenario === 'mixed') {
            await sql`DELETE FROM private.score_week_certificates WHERE league_season_id=${season} AND week_number=3`
          }
          if (scenario === 'stale') await sql`UPDATE private.score_week_certificates SET input_token='{}' WHERE league_season_id=${season} AND week_number=3`
          if (scenario === 'correction') await sql`UPDATE public.player_game_stats SET points=points+1 WHERE id=(SELECT id FROM public.player_game_stats WHERE season_year=2026 AND week_number=3 ORDER BY id LIMIT 1)`
          if (scenario === 'result-race') await sql`UPDATE public.matchups SET home_max_possible_points=home_max_possible_points+1 WHERE id=(SELECT id FROM public.matchups WHERE league_season_id=${season} AND week_number=3 ORDER BY id LIMIT 1)`
          if (scenario === 'voided') await sql`UPDATE public.matchups SET is_voided=true WHERE league_season_id=${season} AND week_number=3`
          if (scenario === 'retired') await sql`INSERT INTO private.retired_score_inputs(league_season_id) VALUES(${season})`
          if (scenario === 'consumed' || scenario === 'mixed') {
            await sql`UPDATE public.matchups SET matchup_type='playoff_quarterfinal',playoff_round=1
              WHERE league_season_id=${season} AND week_number=3
                AND (${scenario}='consumed' OR id=(SELECT id FROM public.matchups WHERE league_season_id=${season} AND week_number=3 ORDER BY id LIMIT 1))`
            await sql`UPDATE public.matchups SET matchup_type='playoff_semifinal',playoff_round=2
              WHERE id=(SELECT id FROM public.matchups WHERE league_season_id=${season} AND week_number=4 ORDER BY id LIMIT 1)`
          }
          const actual = await equal()
          if (['missing', 'stale', 'correction', 'result-race', 'mixed'].includes(scenario)) assert.ok(actual.includes(3), scenario)
          else assert.ok(!actual.includes(3), scenario)
          if (scenario === 'retired') assert.deepEqual(actual, [])
          if (scenario === 'correction' || scenario === 'result-race') {
            await assert.rejects(
              () => sql`SELECT public.finalize_score_week_atomic(bench.profile_id(1),${season},3,${sql.json(payload)}::jsonb,'[]'::jsonb)`,
              (error: unknown) => { assert.equal((error as { code?: string }).code, 'PT409'); return true },
            )
          }
          console.log(JSON.stringify({ scenario, weeks: actual }))
        } finally {
          await sql.unsafe('ROLLBACK')
        }
      }
      assert.deepEqual(await equal(), [])
    } finally {
      await sql.end()
    }
  },
})
