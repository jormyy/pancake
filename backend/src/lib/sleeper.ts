import axios from 'axios'

const client = axios.create({
    baseURL: 'https://api.sleeper.app/v1',
    timeout: 30000, // players endpoint is ~5MB
})

export interface SleeperPlayer {
    player_id: string
    first_name: string | null
    last_name: string | null
    full_name: string | null
    team: string | null
    position: string | null
    age: number | null
    status: string | null
    injury_status: string | null
    injury_notes: string | null
    active: boolean
    sport: string
}

// GET all NBA players — returns a giant object keyed by sleeper player_id
export async function fetchAllPlayers(): Promise<Record<string, SleeperPlayer>> {
    const { data } = await client.get<Record<string, SleeperPlayer>>('/players/nba')
    return data
}
