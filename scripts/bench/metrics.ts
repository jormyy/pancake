export type TableStat = {
  schemaname: string
  relname: string
  seq_tup_read: number | string | null
  idx_tup_fetch: number | string | null
  n_tup_ins: number | string | null
  n_tup_upd: number | string | null
  n_tup_del: number | string | null
}

export function tableMetrics(tables: TableStat[]) {
  const fixtureTables = new Set(['players', 'nba_games', 'fantasypros_projection_rows'])
  const writes = (row: TableStat) => Number(row.n_tup_ins ?? 0) + Number(row.n_tup_upd ?? 0) + Number(row.n_tup_del ?? 0)
  const fixtureRowsWritten = tables.filter((row) => row.schemaname === 'public' && fixtureTables.has(row.relname)).reduce((sum, row) => sum + writes(row), 0)
  const tableRowsWritten = tables.reduce((sum, row) => sum + writes(row), 0)
  return {
    tableRowsRead: tables.reduce((sum, row) => sum + Number(row.seq_tup_read ?? 0) + Number(row.idx_tup_fetch ?? 0), 0),
    tableRowsWritten,
    fixtureRowsWritten,
    productionTableRowsWritten: tableRowsWritten - fixtureRowsWritten,
  }
}
