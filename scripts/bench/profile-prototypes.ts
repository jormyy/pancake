import { connect } from './request-driver.ts'
import { guardTarget, summarize } from './profile.ts'

const flags = new Map<string,string>()
for (let index=0;index<Deno.args.length;index+=2) flags.set(Deno.args[index],Deno.args[index+1])
const out=flags.get('--out')
const label=flags.get('--label') ?? 'stale-weeks-prototype'
const rounds=Number(flags.get('--rounds') ?? 5)
const db=Deno.env.get('SUPABASE_DB_URL') ?? ''
guardTarget(db,'56322')
if (!out || !/^[a-z0-9_-]+$/i.test(label) || !Number.isInteger(rounds) || rounds<5) throw Error('Use --out DIR --label NAME --rounds N, with at least five rounds')
const root=await Deno.realPath(new URL('../../',import.meta.url).pathname)
await Deno.mkdir(out,{recursive:true})
const directory=await Deno.realPath(out)
if (directory===root || directory.startsWith(root+'/')) throw Error('Keep evidence outside the source tree')
const destination=`${directory}/${label}.json`
try { await Deno.stat(destination); throw Error('Evidence already exists') } catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
const sql=connect(db,true)
const observer=connect(db)
const samples: Record<string,unknown>[]=[]
try {
  const [{season}]=await observer`SELECT bench.profile_id(100001) season`
  const [{body}]=await observer`SELECT prosrc body FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='get_stale_score_weeks'`
  const original=String(body).trim().replaceAll('p_league_season_id',`'${season}'::uuid`).replaceAll('p_through_week','21')
  const prototype=`WITH eligible_weeks AS MATERIALIZED (
    SELECT DISTINCT matchup.week_number FROM public.matchups matchup
    WHERE matchup.league_season_id='${season}'::uuid AND matchup.week_number<=21
      AND matchup.is_finalized IS TRUE AND NOT matchup.is_voided
      AND NOT EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id='${season}'::uuid)
      AND NOT private.playoff_matchup_is_consumed(matchup.id)
    ) SELECT eligible.week_number FROM eligible_weeks eligible
    LEFT JOIN private.score_week_certificates certificate ON certificate.league_season_id='${season}'::uuid AND certificate.week_number=eligible.week_number
    WHERE certificate.input_token IS NULL OR certificate.input_token IS DISTINCT FROM private.score_input_token('${season}'::uuid,eligible.week_number)
    ORDER BY eligible.week_number`
  const queries={original,prototype}
  const originalRows=await observer.unsafe(original)
  const prototypeRows=await observer.unsafe(prototype)
  if (JSON.stringify(originalRows)!==JSON.stringify(prototypeRows)) throw Error('Prototype changes the fixture result')
  for (let round=0;round<rounds;round++) for (const variant of round%2 ? ['prototype','original'] as const : ['original','prototype'] as const) {
    await observer`SELECT extensions.pg_stat_statements_reset()`
    const started=performance.now()
    const plan=await sql.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${queries[variant]}`)
    const ms=performance.now()-started
    const statements=await observer`SELECT query,calls::float8,rows::float8,total_exec_time,mean_exec_time,shared_blks_hit::float8,shared_blks_read::float8,toplevel
      FROM extensions.pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%' ORDER BY total_exec_time DESC`
    const detail=plan[0]['QUERY PLAN'][0]
    samples.push({round,variant,ms,executionMs:detail['Execution Time'],planningMs:detail['Planning Time'],plan,statements})
  }
  const summary=Object.fromEntries(['original','prototype'].map(variant => [variant,{
    ms:summarize(samples.filter(s=>s.variant===variant).map(s=>Number(s.ms))),
    executionMs:summarize(samples.filter(s=>s.variant===variant).map(s=>Number(s.executionMs))),
  }]))
  const [context]=await observer`SELECT bench.profile_id(1) league,bench.profile_id(200101) member,bench.profile_id(101) owner`
  const tradePlan=await observer.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE authenticated')
    await tx`SELECT set_config('request.jwt.claim.sub',${context.owner},true)`
    return await tx.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT t.id,t.status,t.proposed_at,(SELECT jsonb_agg(jsonb_build_object('id',i.id,'side',i.side,'player_id',i.player_id,'pick_id',i.pick_id)) FROM public.trade_items i WHERE i.trade_id=t.id) trade_items
      FROM public.trades t WHERE t.league_id='${context.league}'::uuid
        AND (t.proposer_member_id='${context.member}'::uuid OR t.recipient_member_id='${context.member}'::uuid)
      ORDER BY t.proposed_at DESC LIMIT 40`)
  })
  await Deno.writeTextFile(destination,JSON.stringify({label,rounds,command:['deno run --no-lock --node-modules-dir=none -A scripts/bench/profile-prototypes.ts',...Deno.args].join(' '),
    method:'Alternating read-only SQL queries on one warmed local database. No function is replaced. Result equality covers this seeded state, not all scoring histories.',rowsMatch:true,returnedRows:originalRows.length,queries,summary,samples,tradePlan:{role:'authenticated',plan:tradePlan}},null,2)+'\n')
  console.log(JSON.stringify(summary))
} finally { await sql.end();await observer.end() }
