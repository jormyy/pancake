import { connect } from './request-driver.ts'

const url = Deno.env.get('SUPABASE_DB_URL') ?? 'postgresql://postgres:postgres@127.0.0.1:56322/postgres'
const owner = connect(url)
const first = connect(url)
const second = connect(url)
const token = crypto.randomUUID()
const [window] = await owner`SELECT now()+interval '90 seconds' AS tipoff,(now() AT TIME ZONE 'America/New_York')::date AS date`
try {
  await owner`INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date,status,token,lease_until)
    VALUES(${window.tipoff},${window.date},'queued',${token},now()+interval '45 seconds')`
  const claims = await Promise.all([first, second].map(async (sql) => {
    const [claim] = await sql`SELECT public.claim_lineup_tipoff_dispatch(${window.tipoff},${token}) AS date`
    return claim.date
  }))
  if (claims.filter(Boolean).length !== 1) throw new Error('Concurrent workers both claim or both miss the window.')
  const [dispatch] = await owner`SELECT status FROM public.lineup_tipoff_dispatches WHERE tipoff_at=${window.tipoff}`
  if (dispatch.status !== 'running') throw new Error('Claim does not enter running state.')
  console.log('Two concurrent SQL workers produce exactly one claim.')
} finally {
  await owner`DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at=${window.tipoff} AND token=${token}`
  await Promise.all([owner.end(), first.end(), second.end()])
}
