import assert from 'node:assert/strict'
import path from 'node:path'
import { appendFile, readFile } from 'node:fs/promises'
import { season, fixtureDirectory, dates, etDate, sha256, writeGzip, writeJson } from './common.mjs'
import { fixtureStore } from './fixtures.mjs'
import { planDay } from './planner.mjs'
import { prepareLineups, checkLineups } from './lineups.mjs'
import { assertFinals, assertLeaguePoints } from './assertions.mjs'
import { assertLiveCoverage } from './invariants.mjs'
import { assertClientScores, assertClosedWeeks } from './live-checks.mjs'
import { sql, sqlJson } from './local-stack.mjs'
import { beginWaivers, verifyWaivers, assertWaiverReset } from './waiver-scenarios.mjs'
import { assertSkippedWeek, checkNextSchedule } from './skipped-week.mjs'
import { waiverResetAt } from './waiver-oracle.mjs'

export function remapGame(box, pbp, source, target) {
  const shift = Date.parse(target.time) - Date.parse(source.time)
  assert.ok(Number.isFinite(shift))
  const mappedBox = structuredClone(box), mappedPbp = structuredClone(pbp)
  mappedBox.game.gameId = target.id
  mappedBox.game.gameTimeUTC = target.time
  const offset = new Intl.DateTimeFormat('en', { timeZone: 'America/New_York', timeZoneName: 'longOffset' }).formatToParts(new Date(target.time)).find(part => part.type === 'timeZoneName').value.replace('GMT', '')
  const localTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(target.time)).replace(' ', 'T')
  mappedBox.game.gameEt = `${localTime}${offset}`
  mappedBox.game.gameCode = `${target.date.replaceAll('-', '')}/${target.away}${target.home}`
  for (const action of mappedPbp.game.actions) action.timeActual = new Date(Date.parse(action.timeActual) + shift).toISOString()
  mappedPbp.game.gameId = target.id
  return { box: mappedBox, pbp: mappedPbp }
}

export async function nextSeasonMorning(date, move, current = async () => Number(await sql('SELECT extract(epoch FROM now())*1000'))) {
  const at = await current()
  assert.ok(Number.isFinite(at), 'Next-season morning requires the current business clock')
  await move(Math.max(Date.parse(`${date}T14:00:00Z`), at))
}

export async function prepareNextFixtures() {
  assert.notEqual(process.env.SEASON_SIM_MODE,'two-season','Real two-season mode refuses synthetic remapping')
  const directory = fixtureDirectory
  const source = JSON.parse(await readFile(path.join(directory, 'next-schedule-source.json'), 'utf8'))
  const bytes = await readFile(path.join(directory, source.file))
  assert.equal(sha256(bytes), source.sha256)
  const schedule = JSON.parse(bytes.toString())
  assert.equal(schedule.leagueSchedule.seasonYear, `${season.year}-${String(season.year + 1).slice(-2)}`)
  const published = schedule.leagueSchedule.gameDates.flatMap(day => day.games).filter(game => game.gameId.startsWith(`002${String(season.year).slice(-2)}`) && game.homeTeam.teamTricode && game.awayTeam.teamTricode)
    .map(game => ({ id: game.gameId, date: etDate(game.gameDateTimeUTC), time: game.gameDateTimeUTC, home: game.homeTeam.teamTricode, away: game.awayTeam.teamTricode, provenance: 'SYNTHETIC' })).sort((a, b) => a.time.localeCompare(b.time))
  assert.ok(published.length > 0)
  const first = published[0].date
  const monday = new Date(`${first}T12:00:00Z`)
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7)
  const end = new Date(monday.getTime() + 20 * 86400000).toISOString().slice(0, 10)
  const selected = published.filter(game => game.date <= end)
  const store = await fixtureStore(directory)
  const original = JSON.parse(await readFile(path.join(directory, 'games.json'), 'utf8'))
  const history = original.games.filter(game => game.id.startsWith(season.prefix))
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
  return sql(`SELECT json_build_object('stats',(SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE g.season_year=${season.year}),'matchups',(SELECT md5(string_agg(row_to_json(m)::text,'' ORDER BY m.id)) FROM matchups m WHERE league_season_id='${oldSeason}'),'standings',(SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM standings s WHERE league_season_id='${oldSeason}'),'usedPicks',(SELECT md5(string_agg(row_to_json(p)::text,'' ORDER BY p.id)) FROM draft_picks p WHERE league_id='${c.leagueId}' AND is_used))`)
}

export async function runNextSeason(c, oldSeason, move, report, snapshot, checkpoint = async (..._args) => {}, liveCoverage) {
  const began = Date.now()
  const mapping = JSON.parse(await readFile(path.join(fixtureDirectory, 'next-season-mapping.json'), 'utf8'))
  const history = await historyDigest(c, oldSeason)
  const playoffStart = await sql(`SELECT playoff_start_week FROM leagues WHERE id='${c.leagueId}'`)
  c.seasonYear = season.year + 1
  const existing = await c.rest(c.users[0], `standings?select=*&league_season_id=eq.${c.leagueSeasonId}`)
  assert.ok(existing.every(row => row.wins === 0 && row.losses === 0 && row.ties === 0 && Number(row.points_for) === 0), 'Next-season standings start fresh')
  if (!c.skippedWeeks?.includes(1)) {
    await move(`${season.year}-07-01T10:06:00Z`)
    assert.equal(await sql(`SELECT count(*) FROM season_weeks WHERE season_year=${c.seasonYear} AND week_number=1`), '1', 'Published next-season calendar is available before commissioner changes')
    await c.rpc(c.users[0], 'update_league_configuration_atomic', { p_league_id: c.leagueId, p_settings: { skipped_weeks: [1] } })
    c.skippedWeeks = [1]
    report.skippedWeekSettings = { route: '/rest/v1/rpc/update_league_configuration_atomic', at: `${season.year}-07-01T10:06:00Z`, weeks: [1] }
  }
  c.firstDate = mapping.first
  assert.equal(await sql(`SELECT playoff_start_week FROM leagues WHERE id='${c.leagueId}'`),playoffStart,'Skipping week one does not change the configured calendar playoff week')
  await nextSeasonMorning(mapping.first, move)
  await snapshot('next-season-start', mapping.first, 21)
  const rows = await sqlJson(`SELECT coalesce(json_agg(w ORDER BY week_number),'[]') FROM season_weeks w WHERE season_year=${c.seasonYear} AND week_number IN (1,2,3)`, 'Next-season calendar')
  assert.equal(rows.length, 3, 'Production schedule ingestion creates three calendar weeks')
  const matchups = await c.rest(c.users[0], `matchups?select=*&league_season_id=eq.${c.leagueSeasonId}`)
  report.nextSeasonSchedule = checkNextSchedule(matchups, c.users.map(user => user.memberId), Number(playoffStart), [1])
  await assertSkippedWeek(c, 1)
  const checked = [], store = await fixtureStore(fixtureDirectory)
  const { games } = JSON.parse(await readFile(path.join(fixtureDirectory, 'games.json'), 'utf8'))
  let previous = {}
  const days = []
  report.nextSeasonProgress = { beganAt: new Date(began).toISOString(), days }
  for (const date of dates(mapping.first, mapping.end)) {
    const dayBegan = Date.now()
    await checkpoint(`${date}:next-season-morning`)
    await nextSeasonMorning(date, move)
    const today = games.filter(game => game.date === date), day = { date, provenance: 'SYNTHETIC' }
    const week = rows.find(row => date >= row.week_start && date <= row.week_end)?.week_number
    assert.ok(week, 'Every next-season date belongs to a published calendar week')
    await verifyWaivers(c, report)
    if (date === mapping.first) await beginWaivers(c, 'skipped-week-rolling', report)
    if (week !== 1 && date === rows.find(row => row.week_number === week).week_start) {
      report.waiverWeekResets ??= []
      report.waiverWeekResets.push(await assertWaiverReset(c, week, waiverResetAt(rows.find(row => row.week_number === week).week_end)))
    }
    if (date === rows.find(row => row.week_number === 2).week_start) {
      await beginWaivers(c, 'eligible-week-rolling', report)
    }
    if (week !== 1) await prepareLineups(c, date, day)
    const plan = await planDay(today, store, date)
    for (const event of plan.events) {
      await move(event.at)
      if (week === 1) day.skipped = await assertSkippedWeek(c, 1)
      else {
        await checkLineups(c, date, day)
        const live = await assertClientScores(c, { week, previous, expectedCount: c.users.length / 2 })
        previous = { ...previous, ...live.observations }
      }
    }
    const next = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
    await move(`${next}T09:00:00Z`)
    day.finals = today.length ? await assertFinals(date) : { games: 0 }
    day.coverage = assertLiveCoverage(liveCoverage(), today, plan)
    day.points = week === 1 ? await assertSkippedWeek(c, 1) : today.length ? await assertLeaguePoints({ ...c, date }) : null
    if (week !== 1) await assertClientScores(c, { week, previous, expectedCount: c.users.length / 2 })
    await verifyWaivers(c, report)
    day.weekly = await assertClosedWeeks(c, next, checked)
    day.skippedWeek = await assertSkippedWeek(c, 1)
    for (const pick of [...report.actions.tradeDeadline.transferredPicks, { id: report.offseasonTrade.pickId, owner: report.offseasonTrade.owner }, ...(report.offseasonTrade.counterPickId ? [{ id: report.offseasonTrade.counterPickId, owner: report.offseasonTrade.counterOwner }] : [])]) assert.equal(await sql(`SELECT current_owner_id FROM draft_picks WHERE id='${pick.id}'`), pick.owner, 'Future pick ownership survives next-season scoring')
    assert.equal(await historyDigest(c, oldSeason), history, 'Season-one stats, matchups, standings and used picks stay unchanged')
    day.wallSeconds = (Date.now() - dayBegan) / 1000
    days.push(day)
    console.log(JSON.stringify({ nextSeasonDate: date, games: day.finals.games, wallSeconds: day.wallSeconds }))
    await checkpoint(`${date}:next-season-verified`)
  }
  assert.deepEqual(checked, [2, 3], 'Both eligible next-season weeks close and pass')
  assert.equal(await sql(`SELECT playoff_start_week FROM leagues WHERE id='${c.leagueId}'`), playoffStart, 'Skipped weeks preserve the calendar playoff boundary')
  report.nextSeason = { passed: true, days, checked, skippedWeeks: [1], playoffRule: `Configured calendar playoff week ${playoffStart} stays unchanged; skipped regular weeks are omitted, never renumbered.`, historyPreserved: true, provenance: 'Published REAL-RAW schedule; SYNTHETIC game data' }
  report.phaseTimings ??= []
  report.phaseTimings.push({ phase: 'next-season', seconds: (Date.now() - began) / 1000, businessAt: new Date(Number(await sql('SELECT extract(epoch FROM now())*1000'))).toISOString() })
  return report.nextSeason
}
