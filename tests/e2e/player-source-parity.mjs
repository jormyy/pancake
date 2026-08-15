// Side-by-side parity between the dormant Sleeper player source and the
// keyless ESPN replacement (players master list + injuries). Run before and
// after cutover; each run appends a dated summary to
// docs/sleeper-migration.md and writes a full JSON artifact next to it.
//
//   npm run parity:players
import path from 'node:path'
import process from 'node:process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const ROOT = process.cwd()
const DOC_PATH = path.join(ROOT, 'docs/sleeper-migration.md')
const ARTIFACT_DIR = path.join(ROOT, 'docs/sleeper-migration-parity')

const SLEEPER_URL = process.env.SLEEPER_BASE_URL
  ? `${process.env.SLEEPER_BASE_URL}/players/nba`
  : 'https://api.sleeper.app/v1/players/nba'
const ESPN_BASE = process.env.ESPN_SITE_BASE_URL ??
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'

const ESPN_TEAM_CODES = { GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS' }
const ESPN_INJURY_STATUSES = { 'Out': 'Out', 'Day-To-Day': 'DTD', 'Questionable': 'Questionable', 'Doubtful': 'Doubtful' }
const POSITION_GROUPS = { PG: 'G', SG: 'G', G: 'G', SF: 'F', PF: 'F', F: 'F', C: 'C' }

const normalizeName = (name) => name
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
  .replace(/[^a-z]/g, '')

const getJson = async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`)
  return response.json()
}

const main = async () => {
  const sleeperRaw = await getJson(SLEEPER_URL)
  const sleeper = Object.values(sleeperRaw).filter((p) =>
    p?.sport === 'nba' && (p.first_name || p.last_name) && /^\d+$/.test(p.player_id ?? '') && p.team)

  const teamsPayload = await getJson(`${ESPN_BASE}/teams`)
  const teams = teamsPayload.sports[0].leagues[0].teams.map((entry) => entry.team)
  const espn = []
  for (const team of teams) {
    const roster = await getJson(`${ESPN_BASE}/teams/${team.id}/roster`)
    for (const athlete of roster.athletes ?? []) {
      espn.push({
        id: String(athlete.id),
        name: athlete.fullName ?? `${athlete.firstName} ${athlete.lastName}`,
        team: ESPN_TEAM_CODES[team.abbreviation] ?? team.abbreviation,
        position: athlete.position?.abbreviation ?? null,
        yearsExp: typeof athlete.experience?.years === 'number' ? athlete.experience.years : null,
      })
    }
  }
  const injuriesPayload = await getJson(`${ESPN_BASE}/injuries`)
  const espnInjuryByName = new Map()
  for (const team of injuriesPayload.injuries ?? []) {
    for (const injury of team.injuries ?? []) {
      const mapped = ESPN_INJURY_STATUSES[injury.status]
      const injuredName = injury.athlete?.displayName
      if (injuredName && mapped) espnInjuryByName.set(normalizeName(injuredName), mapped)
    }
  }

  const espnByName = new Map(espn.map((player) => [normalizeName(player.name), player]))
  let matched = 0
  let teamAgree = 0
  let positionCompatible = 0
  let positionComparable = 0
  let injuryComparable = 0
  let injuryAgree = 0
  let sleeperInjured = 0
  let espnInjured = 0
  let yearsExpComparable = 0
  let yearsExpAgree = 0
  const unmatched = []
  for (const player of sleeper) {
    const name = `${player.first_name} ${player.last_name}`
    const espnPlayer = espnByName.get(normalizeName(name))
    if (!espnPlayer) {
      unmatched.push({ name, team: player.team })
      continue
    }
    matched += 1
    if (espnPlayer.team === player.team) teamAgree += 1
    const sleeperGroup = POSITION_GROUPS[player.position]
    const espnGroup = POSITION_GROUPS[espnPlayer.position]
    if (sleeperGroup && espnGroup) {
      positionComparable += 1
      if (sleeperGroup === espnGroup) positionCompatible += 1
    }
    const sleeperInjury = player.injury_status && player.injury_status !== 'Scrambled' ? player.injury_status : null
    const espnInjury = espnInjuryByName.get(normalizeName(name)) ?? null
    if (sleeperInjury && espnInjury) {
      injuryComparable += 1
      if (sleeperInjury === espnInjury) injuryAgree += 1
    }
    if (sleeperInjury) sleeperInjured += 1
    if (espnInjury) espnInjured += 1
    if (typeof player.years_exp === 'number' && typeof espnPlayer.yearsExp === 'number') {
      yearsExpComparable += 1
      if (player.years_exp === espnPlayer.yearsExp) yearsExpAgree += 1
    }
  }

  const pct = (num, den) => den === 0 ? null : Math.round((num / den) * 1000) / 10
  const summary = {
    ranAt: new Date().toISOString(),
    sleeperRostered: sleeper.length,
    espnRostered: espn.length,
    matchedByName: matched,
    coveragePct: pct(matched, sleeper.length),
    teamAgreementPct: pct(teamAgree, matched),
    positionGroupAgreementPct: pct(positionCompatible, positionComparable),
    sleeperInjured,
    espnInjured,
    injuryComparable,
    injuryStatusAgreementPct: pct(injuryAgree, injuryComparable),
    yearsExpAgreementPct: pct(yearsExpAgree, yearsExpComparable),
    unmatchedSleeperPlayers: unmatched.length,
  }

  await mkdir(ARTIFACT_DIR, { recursive: true })
  const stamp = summary.ranAt.replace(/[:.]/g, '-')
  await writeFile(
    path.join(ARTIFACT_DIR, `run-${stamp}.json`),
    `${JSON.stringify({ summary, unmatched }, null, 2)}\n`,
  )

  const line = `| ${summary.ranAt} | ${summary.sleeperRostered} | ${summary.espnRostered} | ` +
    `${summary.matchedByName} (${summary.coveragePct}%) | ${summary.teamAgreementPct}% | ` +
    `${summary.positionGroupAgreementPct}% | ${summary.sleeperInjured}/${summary.espnInjured}, ` +
    `both ${summary.injuryComparable} agree ${summary.injuryStatusAgreementPct ?? 'n/a'}% | ` +
    `${summary.unmatchedSleeperPlayers} |`
  const existing = await readFile(DOC_PATH, 'utf8').catch(() => null)
  if (existing?.includes('<!-- parity-runs -->')) {
    await writeFile(DOC_PATH, existing.replace('<!-- parity-runs -->', `<!-- parity-runs -->\n${line}`))
  }
  console.log(JSON.stringify(summary, null, 2))
  if ((summary.coveragePct ?? 0) < 95 || (summary.teamAgreementPct ?? 0) < 97) {
    console.error('Parity below thresholds (coverage >= 95%, team agreement >= 97%)')
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
