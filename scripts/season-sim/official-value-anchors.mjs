import assert from 'node:assert/strict'
import { sqlJson } from './local-stack.mjs'
import { statPoints } from './score-oracle.mjs'

export const valueAnchors = Object.freeze({
  version: 'historical-plausibility-v1',
  scope: 'Prespecified engineering judgments on the 0–1000 scale; no market-price ground truth or model-quality threshold',
  highProduction: [300, 1000],
  lowProductionVeteran: [0, 500],
  nextFirst: [300, 950],
  nextThird: [50, 450],
  tenPercentFaab: [1, 50],
  halfBudgetFaab: [5, 200],
})

export function checkAnchoredValue(value, anchor) {
  const [low, high] = valueAnchors[anchor]
  assert.ok(Number.isFinite(value) && value >= low && value <= high, `${anchor}: ${value} outside frozen judgment [${low},${high}]`)
  return { anchor, low, high, value, passed: true }
}

export async function productionAnchors(c) {
  const settings = (await c.rest(c.users[0], `leagues?select=scoring_settings&id=eq.${c.leagueId}`))[0].scoring_settings
  const rows = await sqlJson(`SELECT coalesce(json_agg(r),'[]') FROM (SELECT s.*,g.game_date,r.member_id,p.display_name,p.years_exp,row_number() OVER(PARTITION BY s.player_id ORDER BY g.game_date DESC,s.id) AS recency FROM roster_players r JOIN players p ON p.id=r.player_id JOIN player_game_stats s ON s.player_id=r.player_id JOIN nba_games g ON g.id=s.game_id WHERE r.league_season_id='${c.leagueSeasonId}' AND NOT r.is_on_ir AND NOT r.is_on_taxi AND g.status='Final' AND g.nba_game_id LIKE '002%' AND NOT s.did_not_play AND g.game_date<(now() AT TIME ZONE 'America/New_York')::date) r WHERE recency<=30`, 'Prior-only production value anchors')
  const players = [...new Set(rows.map(row => row.player_id))].map(id => {
    const history = rows.filter(row => row.player_id === id)
    return { playerId: id, memberId: history[0].member_id, name: history[0].display_name, experience: history[0].years_exp, history, mean: history.reduce((sum, row) => sum + statPoints(row, settings), 0) / history.length }
  }).filter(player => player.history.length >= 10).sort((a, b) => b.mean - a.mean || a.playerId.localeCompare(b.playerId))
  const high = players.find(player => player.mean >= 40)
  const low = players.find(player => player.mean <= 10 && player.experience >= 5 && player.memberId !== high?.memberId)
  if (!high || !low) return { passed: false, gap: 'No distinct owners satisfy both frozen production anchor criteria', qualifyingPlayers: players.length, judgments: valueAnchors }
  const actor = c.users.find(user => user.memberId === high.memberId)
  assert.ok(actor)
  const items = [{ fromMemberId: high.memberId, toMemberId: low.memberId, playerId: high.playerId }, { fromMemberId: low.memberId, toMemberId: high.memberId, playerId: low.playerId }]
  const { quote } = await c.api(actor, '/trades/estimate', { memberId: actor.memberId, items })
  const value = id => quote.analysis.assets.find(asset => asset.assetId === id).values.overall
  const checks = [checkAnchoredValue(value(high.playerId), 'highProduction'), checkAnchoredValue(value(low.playerId), 'lowProductionVeteran')]
  assert.ok(value(high.playerId) > value(low.playerId), 'Established high production exceeds a low-production veteran')
  const [frozenQuote] = await c.rest(actor, `trade_estimate_quotes?select=*&id=eq.${quote.id}`)
  return { passed: true, judgments: valueAnchors, high, low, items, quote, frozenQuote, checks }
}
