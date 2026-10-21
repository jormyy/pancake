import assert from 'node:assert/strict'
const db = Deno.env.get('SUPABASE_DB_URL')!
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
assert.equal(new URL(db).port, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322')
const requested = Deno.env.get('POST_CALENDAR_CASE')
const cases = requested ? [requested] : ['durable', 'outside', 'cross-week']
const recipe = await Deno.readTextFile(new URL('../../../tests/db/calendar-ingestion.sql', import.meta.url))
for (const selected of cases) {
assert.ok(['durable', 'outside', 'cross-week'].includes(selected))
const sql = `SELECT set_config('post.calendar_case','${selected}',false);\n${recipe}`
const result = await new Deno.Command('psql', { args: [db, '-Xv', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'inherit', stderr: 'inherit' }).spawn()
const writer = result.stdin.getWriter()
await writer.write(new TextEncoder().encode(sql))
await writer.close()
const status = await result.status
if (!status.success) Deno.exit(status.code)
}
Deno.exit(0)
