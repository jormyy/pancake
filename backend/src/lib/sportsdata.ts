import axios from 'axios'

const BASE_URL = 'https://api.sportsdata.io/v3/nba'
const API_KEY = process.env.SPORTSDATA_API_KEY!

const client = axios.create({
    baseURL: BASE_URL,
    headers: { 'Ocp-Apim-Subscription-Key': API_KEY },
})

// GET /scores/json/Players
export async function fetchAllPlayers() {
    const { data } = await client.get('/scores/json/Players')
    return data
}

// GET /scores/json/Games/{season}
// season = e.g. "2025" for the 2024-25 NBA season
export async function fetchSeasonSchedule(season: string) {
    const { data } = await client.get(`/scores/json/Games/${season}`)
    return data
}

// GET /stats/json/PlayerGameStatsByDate/{date}
// date = YYYY-MMM-DD (e.g. "2025-FEB-26")
export async function fetchStatsByDate(date: string) {
    const { data } = await client.get(`/stats/json/PlayerGameStatsByDate/${date}`)
    return data
}

// GET /projections/json/PlayerGameProjectionStatsByDate/{date}
export async function fetchProjectionsByDate(date: string) {
    const { data } = await client.get(`/projections/json/PlayerGameProjectionStatsByDate/${date}`)
    return data
}

// Format a JS Date to SportsData.io date string: YYYY-MMM-DD (uppercase month)
export function formatDate(date: Date): string {
    const year = date.getFullYear()
    const month = date.toLocaleString('en-US', { month: 'short' }).toUpperCase()
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

// Get current NBA season year
// NBA 2024-25 season → returns "2025"
export function currentSeason(): string {
    const now = new Date()
    // Season rolls over in October
    return now.getMonth() >= 9 ? String(now.getFullYear() + 1) : String(now.getFullYear())
}
