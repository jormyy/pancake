import { normalizeName } from '../_shared/nameMatch.ts'
import * as cheerio from 'npm:cheerio@1.2.0'

type CheerioSelection = ReturnType<cheerio.CheerioAPI>

export type RankingStats = {
  games_played: number | null
  field_goal_pct: number | null
  free_throw_pct: number | null
  three_pointers_made: number | null
  points: number | null
  rebounds: number | null
  assists: number | null
  steals: number | null
  blocks: number | null
  turnovers: number | null
}

export type RankingRow = RankingStats & {
  rank: number
  name: string
  team: string | null
  positions: string[]
  sourcePlayerId: string | null
  age: number | null
  rankChange: number
  comment: string | null
}

const TEAM_ALIASES: Record<string, string> = {
  BKN: 'BKN',
  GS: 'GS',
  GSW: 'GS',
  NO: 'NO',
  NOP: 'NO',
  NY: 'NY',
  NYK: 'NY',
  SA: 'SA',
  SAS: 'SA',
}
const EXPECTED_STAT_LABELS = ['GP', 'FG%', 'FT%', '3PM', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO']

export function normalizeTeam(team: string | null): string | null {
  if (!team) return null
  const upper = team.toUpperCase()
  return TEAM_ALIASES[upper] ?? upper
}

export function isDraftPlaceholder(ranking: Pick<RankingRow, 'team' | 'name'>): boolean {
  return normalizeTeam(ranking.team) === 'DRA' || /^\d{4}\s+draft\s+\(/i.test(ranking.name)
}

export function parseDynastyRankingsHtml(html: string): RankingRow[] {
  const $ = cheerio.load(html)
  const cardRankings = parseDynastyCards($)
  if (cardRankings.length > 0) return dedupeRankings(cardRankings)
  return parseLegacyDynastyTable($)
}

export function parseDynastyRankingOrderHtml(html: string): RankingRow[] {
  const $ = cheerio.load(html)
  if ($('.dyn-card').length === 0) return parseLegacyDynastyTable($)
  const rankings: RankingRow[] = []

  $('.dyn-card').each((_, card) => {
    const rank = parseInt($(card).find('.dyn-rank').first().text().trim())
    const name = cleanText($(card).find('.dyn-name').first().contents()
      .filter((_, node) => node.type === 'text').text())
    if (isNaN(rank) || !name) return

    const badges = $(card).find('.dyn-meta .badge')
      .map((_, badge) => cleanText($(badge).text()))
      .get()
      .filter(Boolean)
    const age = parseNumber((badges.find((badge) => /yo$/i.test(badge)) ?? '').replace(/yo$/i, ''))
    const nonAge = badges.filter((badge) => !/yo$/i.test(badge))
    rankings.push({
      rank,
      name,
      team: nonAge.length > 0 ? nonAge[nonAge.length - 1] : null,
      positions: nonAge.slice(0, -1),
      sourcePlayerId: null,
      age,
      rankChange: 0,
      comment: null,
      ...emptyStats(),
    })
  })

  return dedupeRankings(rankings)
}

// Hashtag's 2026-08 redesign: one .dyn-card per player instead of one table
// row. Badges run [positions..., TEAM, AGEyo]; the nine per-game stats live in
// .dyn-mini; GP comes from the current-season row of the embedded stat table;
// the writeup lives in .dyn-outlook. Player source ids no longer exist.
function parseDynastyCards($: cheerio.CheerioAPI): RankingRow[] {
  const rankings: RankingRow[] = []

  $('.dyn-card').each((_, card) => {
    const rankCell = $(card).find('.dyn-rank').first()
    const rank = parseInt(rankCell.clone().children().remove().end().text().trim())
    if (isNaN(rank)) return

    const name = cleanText($(card).find('.dyn-name').first().clone().children().remove().end().text())
    if (!name) return

    const badges = $(card).find('.dyn-meta .badge')
      .map((_, badge) => cleanText($(badge).text()))
      .get()
      .filter(Boolean)
    const age = parseNumber((badges.find((badge) => /yo$/i.test(badge)) ?? '').replace(/yo$/i, ''))
    const nonAge = badges.filter((badge) => !/yo$/i.test(badge))
    const team = nonAge.length > 0 ? nonAge[nonAge.length - 1] : null
    const positions = nonAge.slice(0, -1)

    const stats = emptyStats()
    $(card).find('.dyn-mini .m').each((_, mini) => {
      const label = cleanText($(mini).find('small').text()).toUpperCase()
      const value = parseNumber($(mini).clone().children('small').remove().end().text())
      if (value == null) return
      if (label === 'FG%') stats.field_goal_pct = value
      else if (label === 'FT%') stats.free_throw_pct = value
      else if (label === '3PM') stats.three_pointers_made = value
      else if (label === 'PTS') stats.points = value
      else if (label === 'REB') stats.rebounds = value
      else if (label === 'AST') stats.assists = value
      else if (label === 'STL') stats.steals = value
      else if (label === 'BLK') stats.blocks = value
      else if (label === 'TO') stats.turnovers = value
    })
    const currentSeasonCells = $(card)
      .find('table.table--statistics tr').eq(1)
      .find('td')
    const gamesPlayed = parseNumber($(currentSeasonCells[2]).text())
    if (gamesPlayed != null) stats.games_played = Math.round(gamesPlayed)

    rankings.push({
      rank,
      name,
      team,
      positions,
      sourcePlayerId: null,
      age,
      rankChange: parseCardRankChange($, rankCell),
      comment: cleanText($(card).find('.dyn-outlook').first().text()) || null,
      ...stats,
    })
  })

  return rankings
}

function parseCardRankChange($: cheerio.CheerioAPI, rankCell: ReturnType<cheerio.CheerioAPI>): number {
  const trend = rankCell.find('.dyn-trend').first()
  if (trend.length === 0) return 0
  const change = parseInt(cleanText(trend.clone().children().remove().end().text()))
  if (isNaN(change)) return 0
  const iconClass = trend.find('i').attr('class') ?? ''
  if (iconClass.includes('arrow-circle-down')) return -change
  if (iconClass.includes('arrow-circle-up')) return change
  return 0
}

function parseLegacyDynastyTable($: cheerio.CheerioAPI): RankingRow[] {
  const rankings: RankingRow[] = []

  $('table.table--statistics').first().find('> tbody > tr, > tr').each((_, row) => {
    const cells = $(row).children('td.dynasty.d-none')
    if (cells.length < 6) return

    const rankText = $(cells[0]).find('span').first().text().replace('#', '').trim()
    const rank = parseInt(rankText)
    if (isNaN(rank)) return

    const name = $(cells[1])
      .contents()
      .filter((_, n) => n.type === 'text')
      .first()
      .text()
      .trim()
    if (!name) return

    const commentCell = $(cells[5])
    if (!hasExpectedStatLabels($, commentCell)) return
    rankings.push({
      rank,
      name,
      team: cleanText($(cells[3]).text()) || null,
      positions: cleanText($(cells[4]).text()).split(',').map((pos) => pos.trim()).filter(Boolean),
      sourcePlayerId: $(cells[1]).find('input[type="hidden"]').attr('value') ?? null,
      age: parseNumber($(cells[2]).text()),
      rankChange: parseRankChange($(cells[0])),
      comment: cleanText(commentCell.clone().find('.dyn-statwrap').remove().end().text()) || null,
      ...parseRankingStats($, commentCell),
    })
  })

  return dedupeRankings(rankings)
}

export function selectedDynastyRankingType(html: string): string | null {
  const $ = cheerio.load(html)
  return $('#ContentPlaceHolder1_DDTYPE option[selected]').attr('value') ?? null
}

function hasExpectedStatLabels($: cheerio.CheerioAPI, cell: CheerioSelection): boolean {
  const labels = cell.find('.dyn-statgrid td .lbl')
    .map((_, label) => cleanText($(label).text()).toUpperCase())
    .get()
  return EXPECTED_STAT_LABELS.every((label) => labels.includes(label))
}

function emptyStats(): RankingStats {
  return {
    games_played: null,
    field_goal_pct: null,
    free_throw_pct: null,
    three_pointers_made: null,
    points: null,
    rebounds: null,
    assists: null,
    steals: null,
    blocks: null,
    turnovers: null,
  }
}

function parseRankingStats($: cheerio.CheerioAPI, cell: CheerioSelection): RankingStats {
  const stats = emptyStats()
  cell.find('.dyn-statgrid td').each((_, statCell) => {
    const label = cleanText($(statCell).find('.lbl').text()).toUpperCase()
    const value = parseNumber($(statCell).clone().children('.lbl').remove().end().text())
    if (value == null) return

    if (label === 'GP') stats.games_played = Math.round(value)
    else if (label === 'FG%') stats.field_goal_pct = value
    else if (label === 'FT%') stats.free_throw_pct = value
    else if (label === '3PM') stats.three_pointers_made = value
    else if (label === 'PTS') stats.points = value
    else if (label === 'REB') stats.rebounds = value
    else if (label === 'AST') stats.assists = value
    else if (label === 'STL') stats.steals = value
    else if (label === 'BLK') stats.blocks = value
    else if (label === 'TO') stats.turnovers = value
  })
  return stats
}

function parseRankChange(rankCell: CheerioSelection): number {
  const changeText = rankCell.find('.small').text().trim()
  const change = parseInt(changeText)
  if (isNaN(change)) return 0

  const iconClass = rankCell.find('i').attr('class') ?? ''
  if (iconClass.includes('arrow-circle-down')) return -change
  if (iconClass.includes('arrow-circle-up')) return change
  return 0
}

function parseNumber(value: string): number | null {
  const normalized = cleanText(value)
  if (!normalized) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function dedupeRankings(rankings: RankingRow[]): RankingRow[] {
  const byKey = new Map<string, RankingRow>()
  for (const ranking of rankings) {
    const key = ranking.sourcePlayerId
      ? `site:${ranking.sourcePlayerId}`
      : `name:${normalizeName(ranking.name)}:${normalizeTeam(ranking.team) ?? ''}`
    const existing = byKey.get(key)
    if (!existing || ranking.rank < existing.rank) byKey.set(key, ranking)
  }
  return [...byKey.values()].sort((a, b) => a.rank - b.rank)
}
