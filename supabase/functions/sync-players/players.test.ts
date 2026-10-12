import { fetchAllPlayers, PLAYER_PAGE } from './players.ts'

type Row = { id: string; display_name: string }
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// In-memory players table whose contents an overlapping sync changes between page reads.
function table(initial: Row[], betweenPages: (rows: Row[], page: number) => void) {
  const rows = [...initial]
  let page = 0
  const client = {
    from: (name: string) => {
      if (name !== 'players') throw new Error(`unexpected table ${name}`)
      let after: string | null = null
      let limit = Infinity
      let ordered = false
      const builder = {
        select: () => builder,
        order: (column: string, { ascending }: { ascending: boolean }) => {
          ordered = column === 'id' && ascending
          return builder
        },
        limit: (n: number) => {
          limit = n
          return builder
        },
        gt: (column: string, value: string) => {
          if (column !== 'id') throw new Error('keyset must use id')
          after = value
          return builder
        },
        then: (resolve: (value: { data: Row[]; error: null }) => unknown) => {
          if (!ordered) throw new Error('pages must be ordered by id')
          if (page > 0) betweenPages(rows, page)
          page += 1
          const data = rows
            .filter((row) => after == null || row.id > after)
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, limit)
          return Promise.resolve({ data, error: null }).then(resolve)
        },
      }
      return builder
    },
  }
  // deno-lint-ignore no-explicit-any
  return client as any
}

Deno.test('player reads return every stable row once while an overlapping sync updates, merges and inserts', async () => {
  const initial = Array.from({ length: PLAYER_PAGE * 2 + 131 }, (_, n) => ({ id: id(n * 10), display_name: `Player ${n}` }))
  const merged = id(50)
  const result = await fetchAllPlayers<Row>(table(initial, (rows, page) => {
    if (page === 1) {
      // A merge deletes an already-read loser and an insert lands before the cursor.
      rows.splice(rows.findIndex((row) => row.id === merged), 1)
      rows.push({ id: id(55), display_name: 'Inserted behind cursor' })
      for (const row of rows) row.display_name = `${row.display_name} updated`
    }
  }), 'id, display_name')

  const ids = result.map((row) => row.id)
  if (new Set(ids).size !== ids.length) throw new Error('a row was returned twice')
  const stable = initial.filter((row) => row.id !== merged).map((row) => row.id)
  const missing = stable.filter((rowId) => !ids.includes(rowId))
  if (missing.length > 0) throw new Error(`stable rows were skipped: ${missing.slice(0, 3)}`)
})

Deno.test('player reads stop after a short page and propagate errors', async () => {
  const empty = await fetchAllPlayers<Row>(table([], () => {}), 'id, display_name')
  if (empty.length !== 0) throw new Error('empty table returned rows')

  const exact = Array.from({ length: PLAYER_PAGE }, (_, n) => ({ id: id(n), display_name: `P${n}` }))
  const full = await fetchAllPlayers<Row>(table(exact, () => {}), 'id, display_name')
  if (full.length !== PLAYER_PAGE) throw new Error(`exact page returned ${full.length}`)

  const failure = { message: 'boom' }
  const failing = { from: () => ({ select: () => failing.from(), order: () => failing.from(), limit: () => failing.from(), gt: () => failing.from(), then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: failure }).then(resolve) }) }
  let thrown: unknown = null
  try {
    // deno-lint-ignore no-explicit-any
    await fetchAllPlayers(failing as any, 'id')
  } catch (error) {
    thrown = error
  }
  if (thrown !== failure) throw new Error('read error was swallowed')
})
