import './common.mjs'
const database = await import('../../../scripts/perf-lab/database.mjs')
export const localKeys = database.localKeys
export const sql = database.sql
export const restoreBackup = database.restoreBackup
export const networkFenceSql = database.networkFenceSql.replaceAll('host[.]lima[.]internal', 'host[.]docker[.]internal')
