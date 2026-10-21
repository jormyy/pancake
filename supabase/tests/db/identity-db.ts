import assert from 'node:assert/strict'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
for (const [value, port] of [[api, '57721'], [db, '57722']]) {
  const target = new URL(value)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname))
  assert.equal(target.port, port)
}

export const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
export const sql = async (statement: string): Promise<string> => {
  const child = new Deno.Command('psql', {
    args: [db, '-XqAtv', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'piped', stderr: 'piped',
  }).spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(statement))
  await writer.close()
  const result = await child.output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

export const fixture = async <T>(name: string): Promise<T> =>
  JSON.parse(await Deno.readTextFile(new URL(`../../../tests/fixtures/identity/${name}`, import.meta.url)))

export type Identity = { name: string; firstName: string; familyName: string }
type RookieGame = {
  gameId: string; date: string; team: string; played: string
  stats: { points: number; reboundsTotal: number; assists: number; steals: number; blocks: number; turnovers: number; threePointersMade: number }
}
export type Rookie = { pick: number; name: string; personId?: string; identities?: Identity[]; games?: RookieGame[] }
