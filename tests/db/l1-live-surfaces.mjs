import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { createBrowser } from '../e2e/browser-agent.mjs'
import { runWithScenarioResourceOwner } from '../e2e/scenario-resource-owner.mjs'
import { setupTradeGameplayFixture } from '../e2e/trade-fixture.mjs'
import { localKeys, sql } from '../../scripts/perf-lab/database.mjs'
import { requireMini, project } from '../../scripts/perf-lab/common.mjs'
import { setupRequest } from './l1-realtime-setup-retry.mjs'

await requireMini()
assert.equal(project, 'pt4bafablel1')
process.env.E2E_BROWSER_SCREENSHOT_MODE = 'agent'
const root = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-l1')
const { origin, active } = JSON.parse(await readFile(path.join(root, 'runtime-ready.json'), 'utf8'))
const transport = process.argv[2] ?? 'broadcast'
assert.ok(['broadcast', 'postgres'].includes(transport))
assert.equal(active, transport)
assert.equal(new URL(origin).port, '62284')
const keys = await localKeys()
const run = `l1-surfaces-${Date.now()}`
const names = [0, 1].map(index => `${run}-${index}`)
const browser = createBrowser({ defaultTimeout: 60000 })
const quote = value => `'${String(value).replaceAll("'", "''")}'`
const evaluate = async (name, code) => {
  const output = await browser(name, ['eval', code])
  const result = JSON.parse(output.trim().split('\n').at(-1))
  return typeof result === 'string' ? JSON.parse(result) : result
}
const body = name => evaluate(name, 'JSON.stringify({text:document.body.innerText,labels:[...document.querySelectorAll("[aria-label]")].map(n=>n.getAttribute("aria-label")),document:window.__l1Document,path:location.pathname})')
const waitFor = async (name, predicate) => {
  let last
  for (let attempt = 0; attempt < 80; attempt++) {
    last = await body(name)
    if (predicate(last)) return last
    await delay(250)
  }
  throw new Error(`Browser did not converge: ${last.path}: ${last.text.slice(0, 1200)}`)
}
let stage = 'fixture'
const results = []
const tokens = new Set()
const setupRetries = []
await runWithScenarioResourceOwner('L1 seven live browser surfaces', async () => {
  let result
  try {
    const originalFetch = globalThis.fetch
    let fixture
    try {
      globalThis.fetch = (url, options) => setupRequest(url, options, { operation: 'fixture', retries: setupRetries, fetcher: originalFetch })
      fixture = await setupTradeGameplayFixture({ supabaseUrl: keys.API_URL, serviceRoleKey: keys.SERVICE_ROLE_KEY, anonKey: keys.ANON_KEY }, 0, { includeFuturePicks: false, isolatedPlayers: true })
    } finally { globalThis.fetch = originalFetch }
    const { league, currentSeason, proposer, recipient, proposerPlayer, recipientPlayer } = fixture
    const calendar = JSON.parse(await sql(`SELECT json_build_object('today',(now() AT TIME ZONE league.timezone)::date,'week',week.week_number)
      FROM public.leagues league JOIN public.season_weeks week ON week.season_year=${currentSeason.season_year}
        AND (now() AT TIME ZONE league.timezone)::date BETWEEN week.week_start AND week.week_end WHERE league.id=${quote(league.id)}`))
    const matchup = randomUUID()
    await sql(`INSERT INTO public.matchups(id,league_id,league_season_id,week_number,matchup_type,home_member_id,away_member_id,home_points,away_points)
      VALUES(${quote(matchup)},${quote(league.id)},${quote(currentSeason.id)},${calendar.week},'regular_season',${quote(proposer.id)},${quote(recipient.id)},101.1,99.9)`)
    for (const name of names) {
      const response = await setupRequest(`${keys.API_URL}/auth/v1/token?grant_type=password`, { method: 'POST',
        headers: { apikey: keys.ANON_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ email: fixture.users[0].email, password: fixture.password }), redirect: 'error' }, { operation: 'login', retries: setupRetries })
      assert.ok(response.ok)
      const session = await response.json()
      assert.ok(!tokens.has(session.access_token))
      tokens.add(session.access_token)
      await browser(name, ['--executable-path', chromium.executablePath(), '--args', `--host-resolver-rules=MAP ${new URL(origin).hostname} 127.0.0.1,--no-proxy-server`, '--ignore-https-errors', '--allowed-domains', new URL(origin).hostname, 'open', origin])
      await browser(name, ['set', 'viewport', '390', '844'])
      await evaluate(name, `localStorage.setItem(${JSON.stringify(`sb-${new URL(origin).hostname.split('.')[0]}-auth-token`)},${JSON.stringify(JSON.stringify(session))}); JSON.stringify({ok:true})`)
    }
    const open = async (route, ready) => {
      for (const name of names) {
        await browser(name, ['open', origin + route])
        await waitFor(name, ready)
        await evaluate(name, `window.__l1Document=${JSON.stringify(`${stage}:${name}`)}; JSON.stringify({ok:true})`)
      }
      await delay(2000)
    }
    const visible = async predicate => {
      const delivered = []
      for (const name of names) {
        const state = await waitFor(name, predicate)
        assert.equal(state.document, `${stage}:${name}`, 'Delivery must not require reloading the document')
        delivered.push(name)
        await browser(name, ['screenshot', path.join(root, 'evidence', `${run}-${stage}-${names.indexOf(name)}.png`)])
      }
      results.push({ surface: stage, devices: delivered.length, status: 'pass' })
      console.log(JSON.stringify(results.at(-1)))
    }
    stage = 'matchup-scores'
    await open('/', state => state.text.includes('101.1'))
    await sql(`UPDATE public.matchups SET home_points=147.3 WHERE id=${quote(matchup)}`)
    await visible(state => state.text.includes('147.3'))
    stage = 'lineups'
    await open('/lineup', state => state.labels.includes(`Bench ${proposerPlayer.display_name}`))
    await sql(`INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type)
      VALUES(${quote(league.id)},${quote(currentSeason.id)},${quote(proposer.id)},${quote(proposerPlayer.id)},${calendar.week},${quote(calendar.today)},'PG')`)
    await visible(state => state.labels.includes(`PG ${proposerPlayer.display_name}`))
    stage = 'trades'
    await open('/trades', state => state.text.includes('Offers'))
    const trade = randomUUID()
    await sql(`BEGIN;
      INSERT INTO public.trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,notes)
        VALUES(${quote(trade)},${quote(league.id)},${quote(currentSeason.id)},${quote(proposer.id)},${quote(recipient.id)},'L1 live trade');
      INSERT INTO public.trade_participants(trade_id,member_id,sort_order,is_initiator,accepted_at)
        VALUES(${quote(trade)},${quote(proposer.id)},0,true,now()),(${quote(trade)},${quote(recipient.id)},1,false,NULL);
      INSERT INTO public.trade_items(trade_id,side,player_id,from_member_id,to_member_id)
        VALUES(${quote(trade)},'proposer',${quote(proposerPlayer.id)},${quote(proposer.id)},${quote(recipient.id)}),
          (${quote(trade)},'recipient',${quote(recipientPlayer.id)},${quote(recipient.id)},${quote(proposer.id)});
      COMMIT;`)
    await visible(state => state.text.includes(recipient.team_name) && state.text.includes(proposerPlayer.display_name))
    stage = 'claims'
    await open('/players?section=waivers', state => state.text.toLowerCase().includes('pending claims (0)'))
    const { data: claimPlayer, error: playerError } = await fixture.admin.from('players').insert({
      first_name: 'L1', last_name: `Claim ${Date.now()}`, nba_team: 'FA', position: 'PG', eligible_positions: ['PG'], status: 'Active',
    }).select('id,display_name').single()
    assert.ifError(playerError)
    fixture.registerCreatedPlayer(claimPlayer.id)
    await sql(`INSERT INTO public.waiver_claims(league_id,league_season_id,member_id,player_id,priority_at_submission,process_date)
      VALUES(${quote(league.id)},${quote(currentSeason.id)},${quote(proposer.id)},${quote(claimPlayer.id)},1,${quote(calendar.today)}::date+2)`)
    await visible(state => state.text.toLowerCase().includes('pending claims (1)') && state.text.includes(claimPlayer.display_name))
    stage = 'forecasts'
    await open('/', state => state.text.includes('147.3'))
    const forecast = { modelVersion: 'l1-browser-fixture', teams: [
      { memberId: proposer.id, currentPoints: 147.3, projectedFinal: 321, winProbability: 0.73 },
      { memberId: recipient.id, currentPoints: 99.9, projectedFinal: 222, winProbability: 0.27 },
    ], tieProbability: 0, games: [], missingInputs: [] }
    await sql(`INSERT INTO public.matchup_forecasts(matchup_id,league_id,input_revision,forecast,valid_until)
      VALUES(${quote(matchup)},${quote(league.id)},1,${quote(JSON.stringify(forecast))},now()+interval '1 hour')`)
    await visible(state => state.text.includes('321 proj') && state.text.includes('73% win'))
    stage = 'notifications'
    await open('/league?tab=activity', state => state.text.includes('Activity'))
    const announcement = `L1 live announcement ${Date.now()}`
    await sql(`INSERT INTO public.league_announcements(id,league_id,author_member_id,body)
      VALUES(${quote(randomUUID())},${quote(league.id)},${quote(proposer.id)},${quote(announcement)})`)
    await visible(state => state.text.includes(announcement))
    stage = 'drafts'
    const draft = randomUUID(), nomination = randomUUID()
    await sql(`BEGIN;
      INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,status,is_mock,created_by_member_id,budget_per_team,started_at,current_nomination_order)
        VALUES(${quote(draft)},${quote(league.id)},${quote(currentSeason.id)},'auction','in_progress',true,${quote(proposer.id)},200,now(),1);
      INSERT INTO public.draft_orders(draft_id,member_id,position) VALUES(${quote(draft)},${quote(proposer.id)},1),(${quote(draft)},${quote(recipient.id)},2);
      INSERT INTO public.draft_budgets(draft_id,member_id,initial_budget,remaining) VALUES(${quote(draft)},${quote(proposer.id)},200,200),(${quote(draft)},${quote(recipient.id)},200,200);
      INSERT INTO public.nominations(id,draft_id,nominating_member_id,player_id,nomination_order,status,current_bid_amount,countdown_expires_at)
        VALUES(${quote(nomination)},${quote(draft)},${quote(proposer.id)},${quote(claimPlayer.id)},1,'open',2,now()+interval '1 hour');
      COMMIT;`)
    await open(`/draft-room?draftId=${draft}`, state => state.text.includes(claimPlayer.display_name))
    await sql(`UPDATE public.nominations SET current_bid_amount=23,current_bidder_id=${quote(proposer.id)} WHERE id=${quote(nomination)}`)
    await visible(state => state.text.includes('$23'))
    result = { status: 'pass', devices: 2, independentSessions: true, notifications: 'In-app commissioner announcement in the activity feed; no external push or email', results }
  } catch (error) {
    const diagnostics = []
    for (const name of names) diagnostics.push({ name,
      state: await body(name).catch(() => null),
      console: await browser(name, ['console']).catch(() => ''),
      errors: await browser(name, ['errors']).catch(() => ''),
    })
    await writeFile(path.join(root, 'evidence', `live-surfaces-${transport}-diagnostics.json`),
      JSON.stringify(diagnostics).replace(/eyJ[\w.-]+/g, '[redacted]').replace(/sb_secret_[\w-]+/g, '[redacted]'), { mode: 0o600 })
    result = { status: 'fail', stage, results, error: String(error.message).replace(/eyJ[\w.-]+/g, '[redacted]').slice(0, 1500) }
    process.exitCode = 1
  } finally {
    for (const name of names) await browser(name, ['close']).catch(() => {})
    const file = transport === 'broadcast' ? 'live-surfaces.json' : 'live-surfaces-postgres.json'
    await writeFile(path.join(root, 'evidence', file), JSON.stringify({ ...result, setupRetries }, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(result))
  }
})
