import { normalizeName } from '../_shared/nameMatch.ts'
import * as cheerio from 'npm:cheerio'

export type FantasyProsProjectionType = 'daily' | 'weekly_avg' | 'weekly_total'

export type FantasyProsProjectionStats = {
  points: number | null
  rebounds: number | null
  assists: number | null
  steals: number | null
  blocks: number | null
  three_pointers_made: number | null
  turnovers: number | null
  minutes: number | null
  games_played: number | null
  field_goal_pct: number | null
  free_throw_pct: number | null
}

export type FantasyProsProjectionRow = FantasyProsProjectionStats & {
  sourceRowNumber: number
  name: string
  normalizedName: string
  team: string | null
  positions: string[]
  status: string | null
  opponent: string | null
  rawPlayerCell: string
  rawStats: Record<string, string | null>
}

const POSITION_RE = /^(PG|SG|SF|PF|C|G|F|UTIL)$/i
const STATUS_ALIASES: Record<string, string> = {
  O: 'Out',
  OUT: 'Out',
  IR: 'IR',
  DTD: 'DTD',
  GTD: 'GTD',
  Q: 'Questionable',
  QUESTIONABLE: 'Questionable',
  PROBABLE: 'Probable',
}

const HEADER_MAP: Record<string, keyof FantasyProsProjectionStats | 'player' | 'opponent'> = {
  PLAYER: 'player',
  OPP: 'opponent',
  OPPONENT: 'opponent',
  PTS: 'points',
  REB: 'rebounds',
  AST: 'assists',
  STL: 'steals',
  BLK: 'blocks',
  '3PM': 'three_pointers_made',
  TO: 'turnovers',
  MIN: 'minutes',
  GP: 'games_played',
  'FG%': 'field_goal_pct',
  'FT%': 'free_throw_pct',
}

export function parseFantasyProsProjectionHtml(html: string): FantasyProsProjectionRow[] {
  const $ = cheerio.load(html)
  const table = findProjectionTable($)
  if (table.length === 0) return []

  const headers = table.find('thead th, tr:first-child th')
    .map((_, th) => normalizeHeader($(th).text()))
    .get()
  const mappedHeaders = headers.map((header) => HEADER_MAP[header] ?? null)
  const playerIndex = mappedHeaders.indexOf('player')
  if (playerIndex < 0) return []

  const rows: FantasyProsProjectionRow[] = []
  table.find('tbody tr').each((_, tr) => {
    const cells = $(tr).children('td')
    if (cells.length <= playerIndex || cells.first().attr('colspan')) return

    const playerCell = cells.eq(playerIndex)
    const parsedPlayer = parseFantasyProsPlayerCell($.html(playerCell), playerCell.text())
    if (!parsedPlayer.name) return

    const rawStats: Record<string, string | null> = {}
    const stats = emptyStats()
    mappedHeaders.forEach((field, index) => {
      if (index === playerIndex || !field || field === 'player') return
      const value = cleanText(cells.eq(index).text()) || null
      if (field === 'opponent') {
        parsedPlayer.opponent = value
        return
      }
      rawStats[field] = value
      const parsedNumber = parseNumber(value)
      if (field === 'games_played') stats[field] = parsedNumber == null ? null : Math.round(parsedNumber)
      else stats[field] = parsedNumber
    })

    rows.push({
      sourceRowNumber: rows.length + 1,
      name: parsedPlayer.name,
      normalizedName: normalizeName(parsedPlayer.name),
      team: parsedPlayer.team,
      positions: parsedPlayer.positions,
      status: parsedPlayer.status,
      opponent: parsedPlayer.opponent,
      rawPlayerCell: parsedPlayer.rawText,
      rawStats,
      ...stats,
    })
  })

  return rows
}

export function parseFantasyProsPlayerCell(
  cellHtml: string,
  fallbackText?: string,
): {
  name: string
  team: string | null
  positions: string[]
  status: string | null
  opponent: string | null
  rawText: string
} {
  const $ = cheerio.load(cellHtml)
  const rawText = cleanText(fallbackText ?? $.text())
  const linkedName = cleanText($('a').first().text())
  const statusText = parseStatus(
    cleanText(
      [
        $('.player-status').first().text(),
        $('.injury').first().text(),
        $('.fp-player-status').first().text(),
      ].filter(Boolean).join(' '),
    ),
  )

  if (linkedName) {
    const meta = cleanText(rawText.replace(linkedName, ''))
    const parsedMeta = parseTrailingMeta(meta)
    return {
      name: linkedName,
      team: parsedMeta.team,
      positions: parsedMeta.positions,
      status: statusText ?? parsedMeta.status,
      opponent: null,
      rawText,
    }
  }

  const parsed = parseNameWithTrailingMeta(rawText)
  return {
    name: parsed.name,
    team: parsed.team,
    positions: parsed.positions,
    status: statusText ?? parsed.status,
    opponent: null,
    rawText,
  }
}

function findProjectionTable($: cheerio.CheerioAPI): ReturnType<cheerio.CheerioAPI> {
  const candidates = $('table').filter((_, table) => {
    const labels = $(table).find('thead th, tr:first-child th')
      .map((__, th) => normalizeHeader($(th).text()))
      .get()
    return labels.includes('PLAYER') && labels.includes('PTS') && (labels.includes('REB') || labels.includes('AST'))
  })
  return candidates.first()
}

function parseNameWithTrailingMeta(value: string): {
  name: string
  team: string | null
  positions: string[]
  status: string | null
} {
  const parenthesizedMeta = value.match(/^(.*?)\s+(\([^)]+\)(?:\s+.+)?)$/)
  if (parenthesizedMeta) {
    const parsedMeta = parseTrailingMeta(parenthesizedMeta[2])
    if (parsedMeta.team || parsedMeta.positions.length > 0 || parsedMeta.status) {
      return {
        name: cleanText(parenthesizedMeta[1]),
        ...parsedMeta,
      }
    }
  }

  const match = value.match(/^(.*?)\s+([A-Z]{2,4}|FA)\s*-\s*([A-Z,\s/]+?)(?:\s+([A-Za-z][A-Za-z\s-]+|O|Q))?$/)
  if (!match) return { name: value, team: null, positions: [], status: null }

  return {
    name: cleanText(match[1]),
    team: normalizeSourceTeam(match[2]),
    positions: parsePositions(match[3]),
    status: parseStatus(match[4] ?? null),
  }
}

function parseTrailingMeta(value: string): {
  team: string | null
  positions: string[]
  status: string | null
} {
  const cleaned = cleanText(value.replace(/^[-,]/, ''))
  const match = cleaned.match(/^\(?\s*([A-Z]{2,4}|FA)\s*-\s*([A-Z,\s/]+?)(?:\s*\))?(?:\s+([A-Za-z][A-Za-z\s-]+|O|Q))?$/)
  if (!match) return { team: null, positions: [], status: null }

  return {
    team: normalizeSourceTeam(match[1]),
    positions: parsePositions(match[2]),
    status: parseStatus(match[3] ?? null),
  }
}

function parsePositions(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\s/]+/)
        .map((pos) => pos.trim().toUpperCase())
        .filter((pos) => POSITION_RE.test(pos)),
    ),
  )
}

function parseStatus(value: string | null): string | null {
  const status = cleanText(value ?? '')
  if (!status) return null
  const key = status.toUpperCase()
  return STATUS_ALIASES[key] ?? status
}

function normalizeSourceTeam(value: string | null): string | null {
  const team = cleanText(value ?? '').toUpperCase()
  return team || null
}

function parseNumber(value: string | null): number | null {
  const cleaned = cleanText(value ?? '').replace(/[%,$]/g, '')
  if (!cleaned || cleaned === '-' || cleaned === '—') return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeHeader(value: string): string {
  return cleanText(value).toUpperCase().replace(/\s+/g, ' ')
}

function cleanText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

function emptyStats(): FantasyProsProjectionStats {
  return {
    points: null,
    rebounds: null,
    assists: null,
    steals: null,
    blocks: null,
    three_pointers_made: null,
    turnovers: null,
    minutes: null,
    games_played: null,
    field_goal_pct: null,
    free_throw_pct: null,
  }
}
