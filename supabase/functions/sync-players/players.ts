import type { supabase } from '../_shared/supabase.ts'

export const PLAYER_PAGE = 1000

type Client = Pick<typeof supabase, 'from'>

/**
 * Read every players row in primary-key pages. An unordered OFFSET page shifts
 * when an overlapping sync updates, inserts or merges rows, so the duplicate-name
 * guard could see an incomplete set; keyset pages return each row that exists for
 * the whole scan exactly once.
 */
export async function fetchAllPlayers<Row extends { id: string }>(db: Client, columns: string): Promise<Row[]> {
  const rows: Row[] = []
  let after: string | null = null
  while (true) {
    let query = db.from('players').select(columns).order('id', { ascending: true }).limit(PLAYER_PAGE)
    if (after) query = query.gt('id', after)
    const { data, error } = await query
    if (error) throw error
    const page = (data ?? []) as unknown as Row[]
    rows.push(...page)
    if (page.length < PLAYER_PAGE) return rows
    after = page[page.length - 1].id
  }
}
