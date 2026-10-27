import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright'
import { resolvedEnv } from '../../e2e/env.mjs'
import { timelineSurfaceFailures } from '../../e2e/browser-smoke.mjs'

const env = resolvedEnv()
const db = new URL(env.dbUrl)
if (db.hostname !== '127.0.0.1' || db.port !== '59922' || env.supabaseUrl !== 'http://127.0.0.1:59921') throw new Error('Use the private timeline stack.')
const state = JSON.parse(await readFile('tests/e2e-state.json', 'utf8'))
for (const id of [state.leagueId, state.users[0].id, state.users[1].id]) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid fixture identity.')
}
const sql = source => execFileSync('psql', [env.dbUrl, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { input: source, encoding: 'utf8' }).trim()
if (sql(`SELECT EXISTS(SELECT 1 FROM public.waiver_claims WHERE league_id='${state.leagueId}' AND bid_amount=9 AND status::text LIKE 'failed%');`) !== 't') sql(`DO $timeline$
DECLARE league uuid := '${state.leagueId}'; season uuid; first_member uuid; second_member uuid; player uuid;
  won uuid; lost uuid; sent uuid; counter uuid; day date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  SELECT id INTO season FROM public.league_seasons WHERE league_id=league AND is_current;
  SELECT id INTO first_member FROM public.league_members WHERE league_id=league AND user_id='${state.users[0].id}';
  SELECT id INTO second_member FROM public.league_members WHERE league_id=league AND user_id='${state.users[1].id}';
  SELECT id INTO player FROM public.players WHERE sportsdata_id='e2e-player-001';
  UPDATE public.drafts SET status='completed',completed_at=now() WHERE league_id=league AND NOT is_mock;
  UPDATE public.leagues SET status='active',waiver_mode='faab' WHERE id=league;
  INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance) VALUES(league,season,first_member,100),(league,season,second_member,100)
    ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    SELECT season_year,1,day,day+6 FROM public.league_seasons WHERE id=season
    ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=excluded.week_start,week_end=excluded.week_end;
  won := public.create_waiver_claim_atomic(league,first_member,player,NULL,'${state.users[0].id}',17);
  lost := public.create_waiver_claim_atomic(league,second_member,player,NULL,'${state.users[1].id}',9);
  UPDATE public.waiver_claims SET process_date=day-1 WHERE id IN(won,lost);
  PERFORM public.process_due_waiver_claims_atomic(day);
  sent := public.propose_trade_atomic(league,season,first_member,second_member,'{}','{}','{}','{}',NULL,NULL,1,1);
  counter := public.submit_trade_offer_atomic('${state.users[1].id}',gen_random_uuid(),second_member,'counter',
    jsonb_build_object('tradeId',sent,'recipientMemberId',first_member,'offerFaabAmount',2,'requestFaabAmount',1));
  PERFORM public.accept_trade_atomic(counter,first_member);
  UPDATE public.trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=counter;
  PERFORM public.complete_accepted_trade_atomic(counter);
  PERFORM public.auto_set_lineup_service_atomic(second_member,league,season,day,'[]');
  UPDATE public.matchups SET home_member_id=first_member,away_member_id=second_member,is_finalized=true
    WHERE id=(SELECT id FROM public.matchups WHERE league_id=league LIMIT 1);
END;
$timeline$;`)
const fixture = JSON.parse(sql(`SELECT jsonb_build_object('reason',failure_reason,'claimId',id,'memberId',member_id)
  FROM public.waiver_claims WHERE league_id='${state.leagueId}' AND bid_amount=9 ORDER BY submitted_at DESC LIMIT 1;`))
if (!fixture.reason) throw new Error('The real losing claim has no recorded reason.')
const evidence = process.env.TIMELINE_EVIDENCE
if (!evidence) throw new Error('TIMELINE_EVIDENCE is required.')
await mkdir(evidence, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    await context.route('**/*', route => {
        const url = new URL(route.request().url())
        return url.hostname === '127.0.0.1' || url.protocol === 'data:' ? route.continue() : route.abort()
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${env.frontendUrl}/sign-in`)
    await page.locator('#pancake-auth-document').waitFor({ state: 'detached' })
    await page.getByPlaceholder('you@example.com', { exact: true }).fill(state.users[1].email)
    await page.getByPlaceholder('Your password', { exact: true }).fill(state.password)
    await page.getByRole('button', { name: 'Sign In', exact: true }).click()
    await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor({ timeout: 30_000 }).catch(async error => {
        console.log('Page:', new URL(page.url()).pathname)
        console.log((await page.locator('body').innerText()).slice(0, 2000))
        console.log('Browser errors:', errors)
        throw error
    })
    await page.getByRole('button', { name: 'Timeline', exact: true }).click()
    await page.getByText(fixture.reason, { exact: true }).waitFor({ timeout: 30_000 })
    const surface = await page.evaluate(() => ({ text: document.body.innerText, buttons: [...document.querySelectorAll('[role=button],button')].map(node => node.textContent.trim()) }))
    const failures = timelineSurfaceFailures(surface)
    if (failures.length) throw new Error(failures.join('; '))
    for (const summary of ['Trade offer sent', 'Counteroffer sent', 'Trade accepted', 'Trade executed', 'Lineup auto-set', 'Matchup scores finalized']) {
        await page.getByText(summary, { exact: true }).first().waitFor()
    }
    await page.getByRole('button', { name: 'Claims', exact: true }).click()
    await page.getByText(fixture.reason, { exact: true }).waitFor()
    if (await page.getByText('Trade executed', { exact: true }).count()) throw new Error('Claims includes a trade.')
    await page.goto(`${env.frontendUrl}/timeline?memberId=${fixture.memberId}&entityId=${fixture.claimId}&filter=claims`)
    await page.getByText(fixture.reason, { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Show all team activity', exact: true }).click()
    await page.getByRole('button', { name: 'All', exact: true }).click()
    const tradeId = sql(`SELECT detail->>'id' FROM public.league_events WHERE league_id='${state.leagueId}' AND kind='trade.executed' ORDER BY id DESC LIMIT 1;`)
    await page.goto(`${env.frontendUrl}/timeline?memberId=${fixture.memberId}&entityId=${tradeId}&filter=trades`)
    await page.getByText('Trade offer sent', { exact: true }).waitFor()
    await page.getByText('Trade executed', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Show all team activity', exact: true }).click()
    await page.getByRole('button', { name: 'All', exact: true }).click()
    await page.screenshot({ path: path.join(evidence, 'timeline-live-mobile.png'), fullPage: true })
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Timeline overflows the mobile viewport.')
    if (errors.length) throw new Error(errors.join('\n'))
    await writeFile(path.join(evidence, 'timeline-live.json'), JSON.stringify({ status: 'PASS', reason: fixture.reason,
        checks: ['local sign-in', 'Home entry', 'recorded claim reason', 'real trade lifecycle', 'auto-set', 'scores', 'filters', 'claim deep link', 'trade chain deep link', 'mobile width'] }, null, 2))
    console.log('PASS: local sign-in, Home entry, real event reasons, lifecycle rows, filters, deep link, mobile width')
} finally {
    await browser.close()
}
