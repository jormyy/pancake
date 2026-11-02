import { evidencePath } from '../helpers/evidence-path.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { analyzeTradeEstimate } from '../../supabase/functions/_shared/tradeEstimate.ts'
import { compareTradeTotals, curveTradeValue, TRADE_FORMULA_VERSION } from '../../supabase/functions/_shared/dynastyEngineTradeValues.ts'
import { syncTradeValues } from '../../supabase/functions/_shared/tradeValues.ts'

assert.match(process.cwd(), /\/lanes\/fable-ui25\/repo$/)
assert.match(readFileSync('supabase/config.toml', 'utf8'), /^project_id = "pt4bafabletc"$/m)
const database = 'postgresql://postgres:postgres@127.0.0.1:63922/postgres'
const sql = input => execFileSync('psql', [database, '-XqAt', '-v', 'ON_ERROR_STOP=1'], {
  input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
}).trim()
const literal = value => `'${String(value).replaceAll("'", "''")}'`
const json = query => JSON.parse(sql(query))
const previous = JSON.parse(execFileSync('git', ['show', 'a807346b:tests/evidence/trade-curve/report.json'], { encoding: 'utf8' }))
const old = {}
new Function('exports', execFileSync('git', ['show', '892b6bca:core/cjs/dynasty/tradeScoring.js'], { encoding: 'utf8' }))(old)
const source = readFileSync('tests/fixtures/trade-values/onenumberhoops.json', 'utf8')
const players = json('SELECT json_agg(row) FROM (SELECT id,display_name,nba_team,position,eligible_positions FROM public.players) row')
const imported = await syncTradeValues({
  claim: async () => { throw new Error('The local report cannot claim a live fetch') },
  fail: async () => { throw new Error('The local report cannot schedule a retry') },
  cached: async () => { throw new Error('The local report requires its recorded fixture') },
  players: async () => players, overrides: async () => ({}),
  publish: async payload => json(`SELECT public.publish_trade_values(${literal(JSON.stringify(payload.rows))}::jsonb,
    ${literal(JSON.stringify(payload.picks))}::jsonb,${literal(payload.source)},${literal(payload.fetchedAt)}::timestamptz,${literal(payload.mode)});`),
}, { format: 'json', content: source })
assert.ok(Number(imported.matched) > 400)
const league = json("SELECT json_build_object('id',league.id,'name',league.name,'seasonId',season.id,'seasonYear',season.season_year) FROM public.leagues league JOIN public.league_seasons season ON season.league_id=league.id AND season.is_current WHERE league.name='OFFICIAL LEAGUE'")
const members = json(`SELECT json_object_agg(id,team_name) FROM public.league_members WHERE league_id=${literal(league.id)}`)
const trades = json(`SELECT COALESCE(json_agg(row),'[]') FROM (SELECT id,status,proposed_at FROM public.trades
  WHERE league_id=${literal(league.id)} AND league_season_id=${literal(league.seasonId)} ORDER BY proposed_at,id) row`)
const completed = trades.filter(trade => trade.status === 'completed').length
assert.ok(trades.some(trade => ['pending', 'accepted'].includes(trade.status)))
const summary = (teams, legacy = false) => {
  const totals = teams.map(team => ({ memberId: team.memberId,
    total: legacy ? team.valuesReceived + Math.max(0, team.packageEffect) : team.adjustedValue,
    net: legacy ? team.valuesReceived - team.valuesSent + team.packageEffect : team.netValue,
    spots: team.rosterSlotEffect ?? 0, cuts: team.rosterCutValue ?? 0, open: team.openRosterSpots ?? 0 }))
  const comparison = compareTradeTotals(totals.map(team => team.total))
  const winner = [...totals].sort((a, b) => b.net - a.net)[0]
  return { ...comparison, totals, verdict: comparison.fair ? 'Fair' : `${members[winner.memberId]} wins` }
}
const rows = trades.map(trade => {
  const inputs = json(`SELECT public.get_trade_estimate_reanalysis_inputs(${literal(trade.id)},'trade-curve-report');`)
  const analysis = analyzeTradeEstimate(inputs, Date.parse(inputs.observedAt))
  const before = analysis.teams.map(team => {
    const side = direction => inputs.terms.filter(term => term[direction] === team.memberId).map(term => analysis.assets.find(asset =>
      asset.assetId === (term.playerId ?? term.pickId ?? `faab:${term.fromMemberId}:${term.toMemberId}`)).values.overall)
    return { memberId: team.memberId, ...old.scoreTradeSides(side('fromMemberId'), side('toMemberId')) }
  })
  const prior = previous.rows.find(row => row.id === trade.id)
  assert.ok(prior, 'The prior curve report covers this real trade')
  assert.equal(prior.bestFreeAgentValue, inputs.bestFreeAgentValue)
  return { ...trade, release: summary(before, true), before: prior.after, after: summary(analysis.teams), bestFreeAgentValue: inputs.bestFreeAgentValue, bestFreeAgentCurvedValue: curveTradeValue(inputs.bestFreeAgentValue),
    assets: inputs.terms.map(term => ({ from: members[term.fromMemberId], to: members[term.toMemberId],
      label: analysis.assets.find(asset => asset.assetId === (term.playerId ?? term.pickId ?? `faab:${term.fromMemberId}:${term.toMemberId}`)).label })),
    missing: analysis.missingInputs,
  }
})
let updated = 0
while (true) {
  const batch = json("SELECT COALESCE(json_agg(id),'[]') FROM public.get_trade_estimate_reanalysis_batch() id")
  if (!batch.length) break
  for (const id of batch) {
    const inputs = json(`SELECT public.get_trade_estimate_reanalysis_inputs(${literal(id)});`)
    const analysis = analyzeTradeEstimate(inputs, Date.parse(inputs.observedAt))
    const first = sql(`SELECT public.save_trade_estimate_reanalysis(${literal(id)},${literal(JSON.stringify(inputs))}::jsonb,${literal(JSON.stringify(analysis))}::jsonb);`)
    const replay = sql(`SELECT public.save_trade_estimate_reanalysis(${literal(id)},${literal(JSON.stringify(inputs))}::jsonb,${literal(JSON.stringify(analysis))}::jsonb);`)
    assert.equal(first, replay)
    assert.equal(sql(`SELECT public.get_trade_estimate_reanalysis_inputs(${literal(id)}) IS NULL`), 't')
    updated++
  }
}
assert.equal(sql('SELECT public.queue_trade_estimate_reanalysis()'), '0')
assert.equal(Number(sql(`SELECT count(*) FROM public.trades trade JOIN public.trade_estimates estimate ON estimate.trade_id=trade.id
  JOIN public.trade_estimate_quotes quote ON quote.id=estimate.quote_id WHERE trade.league_id=${literal(league.id)}
  AND trade.league_season_id=${literal(league.seasonId)} AND trade.status IN('pending','accepted','completed')
  AND quote.model_version=${literal(TRADE_FORMULA_VERSION)}`)), rows.filter(row => ['pending','accepted','completed'].includes(row.status)).length)
const f = value => Number(value.toFixed(3)).toLocaleString('en-US', { maximumFractionDigits: 3 })
const clean = value => String(value).replaceAll('|', '/').replaceAll('\n', ' ')
const totals = result => result.totals.map(team => `${clean(members[team.memberId])}: ${f(team.total)}`).join('<br>')
const nets = result => result.totals.map(team => `${clean(members[team.memberId])}: ${team.net > 0 ? '+' : ''}${f(team.net)}`).join('<br>')
const terms = result => result.totals.map(team => `${clean(members[team.memberId])}: ${team.spots > 0 ? '+' : ''}${f(team.spots)} (cuts ${f(team.cuts)})`).join('<br>')
const maxSpot = Math.max(0, ...rows.flatMap(row => row.after.totals.map(team => Math.abs(team.spots))))
const maxRatio = Math.max(0, ...rows.flatMap(row => row.after.totals.map(team => Math.abs(team.spots) / Math.max(1, Math.abs(team.total)) * 100)))
const changed = rows.filter(row => row.before.verdict !== row.after.verdict).length
const releaseChanged = rows.filter(row => row.release.verdict !== row.after.verdict).length
const lines = [
  '# Trade curve', '',
  `Model: \`${TRADE_FORMULA_VERSION}\`. Exponent and fairness tolerance live in \`core/src/dynasty/tradeScoring.ts\`.`, '',
  'Source values stay OneNumberHoops trade_value on 0–1000. Players and picks use 1000 × (value / 1000)^5 at the package sum. FAAB keeps its existing value. No consolidation bonus remains.', '',
  'Each team keeps its curved received and sent totals. Net value is received − sent − cuts. The two package totals include each recipient’s roster terms. Their absolute gap is divided by the larger absolute package total. A gap at most 5% is Fair. The winner has the higher net value. Signed opposite net values are not used as the gap denominator.', '',
  `Open roster spots add no value. The curve already discounts low-value players. Picks and FAAB do not use player spots. All player locations count. Roster limits still follow regular, IR, and taxi capacity. Incoming taxi players stay on taxi; explicit saved IR and taxi destinations are honored. Excess players cost the lowest curved values in the overfull section, including incumbents. Missing imported values contribute zero.`, '',
  'Exact exponent 5 arithmetic gives 950 → 773.780937; 942 → 741.744806; 900 → 590.49; 851 → 446.321492; 800 → 327.68; 700 → 168.07; 600 → 77.76; 500 → 31.25. The supplied Luka reference of 743 differs from the formula, which rounds to 742. The formula is used directly. Luka versus Duren + Sarr + Castle + George is 741.744806 versus 600.773297 before roster terms. The team receiving Luka gets +75; the four-player recipient gets −75. Adjusted received packages are 816.744806 versus 525.773297 before cuts. Luka’s recipient has net +215.971509. Gilgeous-Alexander versus two 500s is 773.780937 versus 62.5 before roster terms.', '',
  `## Backup replay`, '',
  `The 2026-10-28 production-shaped backup was restored only to project \`pt4bafabletc\`, ports 639xx, on the mini. No production service was contacted. The recorded OneNumberHoops fixture matched ${imported.matched} players.`, '',
  `The table includes all ${rows.length} OFFICIAL LEAGUE trades in season ${league.seasonYear}, across every saved status. ${completed} are completed. This backup has no completed trades. The completed-trade SQL recipe covers that path. Before and after use the same imported snapshot and existing pick values. Before uses exponent 5.5 with flat roster spots recorded at \`a807346b\` on the same backup and source fixture. The release 2.10.2 baseline from \`892b6bca\` is retained below. These are replay judgments, not historical proposal-time judgments.`, '',
  'Rosters use the real backup roster for the trade’s season. Completed trade assets are normalized back to their sending teams and transferred once. Assets no longer rostered are restored to their original sending team for this comparison. The backup does not contain a complete historical roster snapshot for every proposal, so this replay measures the backup roster context rather than claiming exact roster conditions on the proposal date.', '',
  `Required cuts use the curve. Largest absolute new roster term, including cuts: **${f(maxSpot)}**. Largest roster term relative to its adjusted package: **${f(maxRatio)}%**. Verdicts changed from the prior curve: **${changed}/${rows.length}**. Verdicts changed from release 2.10.2: **${releaseChanged}/${rows.length}**.`, '',
  '| Trade / status | Assets sent | Before: exponent 5.5 totals | Before gap / verdict | After: exponent 5 totals | After gap / verdict | After team nets | New roster terms |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map(row => `| \`${row.id}\`<br>${row.proposed_at.slice(0,10)} · ${row.status} | ${row.assets.map(asset => `${clean(asset.from)} → ${clean(asset.to)}: ${clean(asset.label)}`).join('<br>')} | ${totals(row.before)} | ${f(row.before.gapPercent)}% · ${clean(row.before.verdict)} | ${totals(row.after)} | ${f(row.after.gapPercent)}% · ${clean(row.after.verdict)} | ${nets(row.after)} | ${terms(row.after)} |`), '',
  '### Release 2.10.2 baseline', '',
  '| Trade | Original package totals | Original gap / verdict |',
  '| --- | --- | --- |',
  ...rows.map(row => `| \`${row.id}\` | ${totals(row.release)} | ${f(row.release.gapPercent)}% · ${clean(row.release.verdict)} |`), '',
  `Stored reanalysis updated ${updated} eligible trades across the restored backup. Every save was replayed and returned the same quote ID. A repeated input request returned null. The queue finished at zero. Original estimate history was retained.`, '',
  '## Database functions', '',
  'Changed canonical functions:', '',
  ...['private.build_trade_estimate_inputs','private.trade_value_player_inputs','public.get_trade_revaluation_inputs','public.get_trade_estimate_reanalysis_inputs','public.save_trade_estimate_reanalysis','public.get_trade_estimate_reanalysis_batch','public.queue_trade_estimate_reanalysis','public.get_trade_cards','public.view_trade_details'].map(name => `- \`${name}\``), '',
  'Inspected without changing their arithmetic-free behavior: private.refresh_trade_values and private.trade_value_fantasy_averages. Refresh publishes the shared engine result without applying a second curve. Fingerprint, revaluation scan, and pacing functions are unchanged.', '',
  '## Verification', '',
  'Run the mini setup with node tests/e2e/trade-curve-mini.mjs setup. Run SQL checks with node tests/e2e/trade-curve-mini.mjs verify. Generate this report with node tests/e2e/trade-curve-report.mjs. Build with the prepare-web mode. Browser evidence uses node tests/e2e/trade-curve-browser.mjs.', '',
]
mkdirSync(evidencePath('trade-curve'), { recursive: true })
writeFileSync(evidencePath('trade-curve/report.json'), JSON.stringify({ league, model: TRADE_FORMULA_VERSION, previousModel: previous.model, imported, updated, maxSpot, maxRatio, changed, releaseChanged, rows }, null, 2) + '\n')
const existing = readFileSync('docs/trade-curve.md', 'utf8')
const verification = existing.includes('\nFocused Vitest:') ? existing.slice(existing.indexOf('\nFocused Vitest:')) : ''
writeFileSync(evidencePath('trade-curve/report.md'), lines.join('\n') + verification)
console.log(JSON.stringify({ trades: rows.length, updated, changed, releaseChanged, maxSpot, maxRatio }))
