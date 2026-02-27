import axios from 'axios'
import * as cheerio from 'cheerio'

const RANKINGS_URL = 'https://hashtagbasketball.com/fantasy-basketball-dynasty-rankings'

export type DynastyRanking = {
  rank: number
  name: string
  team: string
  position: string
  age: number | null
}

export async function scrapeDynastyRankings(): Promise<DynastyRanking[]> {
  const { data: html } = await axios.get(RANKINGS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PancakeApp/1.0)' },
    timeout: 30_000,
  })

  const $ = cheerio.load(html)
  const rankings: DynastyRanking[] = []

  $('table.table--statistics tr').each((_, row) => {
    // Use only desktop cells (d-none d-md-table-cell) — skips the mobile cell
    const cells = $(row).find('td.dynasty.d-none')
    if (cells.length < 5) return

    // Column order: RANK | PLAYER | AGE | TEAM | POS | COMMENTS
    const rankText = $(cells[0]).find('span').first().text().replace('#', '').trim()
    const rank = parseInt(rankText)
    if (isNaN(rank)) return

    // Player name: first text node inside the cell (before the hidden input)
    const name = $(cells[1])
      .contents()
      .filter((_, n) => n.type === 'text')
      .first()
      .text()
      .trim()

    const age = parseFloat($(cells[2]).text().trim()) || null
    const team = $(cells[3]).text().trim()
    const position = $(cells[4]).text().trim()

    if (name) {
      rankings.push({ rank, name, team, position, age })
    }
  })

  return rankings
}
