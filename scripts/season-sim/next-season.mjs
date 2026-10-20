import assert from 'node:assert/strict'
import path from 'node:path'
import { appendFile, readFile } from 'node:fs/promises'
import { etDate, miniRoot, sha256, writeGzip, writeJson } from './common.mjs'
import { fixtureStore } from './fixtures.mjs'
import { planDay } from './planner.mjs'
import { prepareLineups, checkLineups } from './lineups.mjs'
import { assertFinals, assertLeaguePoints } from './assertions.mjs'
import { assertClientScores, assertClosedWeeks } from './live-checks.mjs'
import { sql, sqlJson } from './local-stack.mjs'

export function remapGame(box, pbp, source, target) {
  const shift = Date.parse(target.time) - Date.parse(source.time)
  assert.ok(Number.isFinite(shift))
  const mappedBox = structuredClone(box), mappedPbp = structuredClone(pbp)
  mappedBox.game.gameId = target.id
  mappedBox.game.gameTimeUTC = target.time
  mappedBox.game.gameEt = `${target.date}T12:00:00-04:00`
  mappedBox.game.gameCode = `${target.date.replaceAll('-', '')}/${target.away}${target.home}`
  for (const action of mappedPbp.game.actions) action.timeActual = new Date(Date.parse(action.timeActual) + shift).toISOString()
  mappedPbp.game.gameId = target.id
  return { box: mappedBox, pbp: mappedPbp }
}

export async function prepareNextFixtures() {
  const directory = path.join(miniRoot, 'fixtures')
  const source = JSON.parse(await readFile(path.join(directory, 'next-schedule-source.json'), 'utf8'))
  const bytes = await readFile(path.join(directory, source.file))
  assert.equal(sha256(bytes), source.sha256)
  const schedule = JSON.parse(bytes.toString())
  assert.equal(schedule.leagueSchedule.seasonYear, '2026-27')
  const published = schedule.leagueSchedule.gameDates.flatMap(day => day.games).filter(game => game.gameId.startsWith('00226') && game.homeTeam.teamTricode && game.awayTeam.teamTricode)
    .map(game => ({ id: game.gameId, date: etDate(game.gameDateTimeUTC), time: game.gameDateTimeUTC, home: game.homeTeam.teamTricode, away: game.awayTeam.teamTricode, provenance: 'SYNTHETIC' })).sort((a, b) => a.time.localeCompare(b.time))
  assert.ok(published.length > 0)
  const first = published[0].date
  const monday = new Date(`${first}T12:00:00Z`)
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7)
  const end = new Date(monday.getTime() + 13 * 86400000).toISOString().slice(0, 10)
  const selected = published.filter(game => game.date <= end)
  const store = await fixtureStore(directory)
  const original = JSON.parse(await readFile(path.join(directory, 'games.json'), 'utf8'))
  const history = original.games.filter(game => game.id.startsWith('00225'))
  const mapping = []
  for (const target of selected) {
    const template = history.find(game => game.home === target.home && game.away === target.away)
    assert.ok(template, `Historical template for ${target.away}@${target.home}`)
    const remapped = remapGame(await store.json(`boxscore-${template.id}`), await store.json(`playbyplay-${template.id}`), template, target)
    for (const [kind, payload] of [['boxscore', remapped.box], ['playbyplay', remapped.pbp]]) {
      const data = Buffer.from(JSON.stringify(payload)), hash = sha256(data), key = `${kind}-${target.id}`, file = `${key}-${hash}.json.gz`
      await writeGzip(path.join(directory, file), data)
      await appendFile(path.join(directory, 'manifest.jsonl'), `${JSON.stringify({ key, file, sha256: hash, status: 200, bytes: data.length, provenance: 'SYNTHETIC', template: `${kind}-${template.id}`, retrievedAt: null, generatedAt: new Date().toISOString() })}\n`)
    }
    mapping.push({ target: target.id, template: template.id, targetTime: target.time, templateTime: template.time, scheduleSha256: source.sha256, provenance: 'SYNTHETIC' })
  }
  await writeJson(path.join(directory, 'next-season-mapping.json'), { first, end, mapping, schedule: source, rule: 'Historical same-team box/PBP data; game identity and times remapped. Every stat and live snapshot is SYNTHETIC.' })
  await writeJson(path.join(directory, 'games.json'), { ...original, games: [...history, ...selected] })
  return { first, end, games: selected.length, provenance: 'SYNTHETIC', scheduleProvenance: 'REAL-RAW' }
}

async function historyDigest(c, oldSeason) {
  return sql(`SELECT json_build_object('stats',(SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE g.season_year=2026),'matchups',(SELECT md5(string_agg(row_to_json(m)::text,'' ORDER BY m.id)) FROM matchups m WHERE league_season_id='${oldSeason}'),'standings',(SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM standings s WHERE league_season_id='${oldSeason}'),'usedPicks',(SELECT md5(string_agg(row_to_json(p)::text,'' ORDER BY p.id)) FROM draft_picks p WHERE league_id='${c.leagueId}' AND is_used))`)
}

export async function runNextSeason(c, oldSeason, move, report, snapshot) {
  const mapping = JSON.parse(await readFile(path.join(miniRoot, 'fixtures/next-season-mapping.json'), 'utf8'))
  const history = await historyDigest(c, oldSeason)
  c.seasonYear = 2027
  const existing = await c.rest(c.users[0], `standings?select=*&league_season_id=eq.${c.leagueSeasonId}`)
  assert.ok(existing.every(row => row.wins === 0 && row.losses === 0 && row.ties === 0 && Number(row.points_for) === 0), 'Next-season standings start fresh')
  await move(`${mapping.first}T14:00:00Z`)
  await snapshot('next-season-start', mapping.first, 2)
  const rows = await sqlJson(`SELECT coalesce(json_agg(w ORDER BY week_number),'[]') FROM season_weeks w WHERE season_year=2027 AND week_number IN (1,2)`, 'Next-season calendar')
  assert.equal(rows.length, 2, 'Production schedule ingestion creates both fantasy weeks')
  const matchups = await c.rest(c.users[0], `matchups?select=*&league_season_id=eq.${c.leagueSeasonId}&matchup_type=eq.regular_season&week_number=lte.2`)
  assert.equal(matchups.length, c.users.length, 'Production boundary generates next-season matchups')
  const checked = [], store = await fixtureStore(path.join(miniRoot, 'fixtures'))
  const { games } = JSON.parse(await readFile(path.join(miniRoot, 'fixtures/games.json'), 'utf8'))
  let previous = {}
  const days = []
  for (const date of [...new Set(games.filter(game => game.id.startsWith('00226')).map(game => game.date))].sort()) {
    await move(`${date}T14:00:00Z`)
    const today = games.filter(game => game.date === date), day = { date, provenance: 'SYNTHETIC' }
    await prepareLineups(c, date, day)
    const plan = await planDay(today, store, date)
    for (const event of plan.events) {
      await move(event.at)
      await checkLineups(c, date, day)
      const live = await assertClientScores(c, { week: day.lineups.week, previous })
      previous = { ...previous, ...live.observations }
    }
    const next = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
    await move(`${next}T09:00:00Z`)
    day.finals = await assertFinals(date)
    day.points = await assertLeaguePoints({ ...c, date, plannedEmptyWeek: 2 })
    day.weekly = await assertClosedWeeks(c, next, checked)
    for (const pick of [...report.actions.tradeDeadline.transferredPicks, { id: report.offseasonTrade.pickId, owner: report.offseasonTrade.owner }]) assert.equal(await sql(`SELECT current_owner_id FROM draft_picks WHERE id='${pick.id}'`), pick.owner, 'Future pick ownership survives next-season scoring')
    assert.equal(await historyDigest(c, oldSeason), history, 'Season-one stats, matchups, standings and used picks stay unchanged')
    days.push(day)
  }
  assert.deepEqual(checked, [1, 2], 'Both next-season fantasy weeks close and pass')
  report.nextSeason = { passed: true, days, historyPreserved: true, provenance: 'Published REAL-RAW schedule; SYNTHETIC game data' }
  return report.nextSeason
}
