import assert from 'node:assert/strict'

// The target is the stack this checkout owns: its URLs come from the environment (CI names or the
// `supabase status -o env` names) and must match supabase/config.toml unless PANCAKE_TEST_* overrides the ports.
const config = await Deno.readTextFile(new URL('../../config.toml', import.meta.url))
const configured = (section: string) => config.match(new RegExp(`^\\[${section}\\]\\n(?:(?!\\[)[^\\n]*\\n)*?port\\s*=\\s*(\\d+)\\s*$`, 'm'))?.[1]
const configProject = config.match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m)?.[1]
const configApiPort = configured('api'), configDbPort = configured('db')
assert.ok(configProject && configApiPort && configDbPort, 'supabase/config.toml must declare project_id and api/db ports')
assert.equal(Deno.env.get('PANCAKE_TEST_PROJECT_ID') ?? configProject, configProject, 'PANCAKE_TEST_PROJECT_ID must name this checkout stack')
for (const [name, alias] of [['SUPABASE_URL', 'API_URL'], ['SUPABASE_DB_URL', 'DB_URL'], ['PANCAKE_SUPABASE_SECRET_KEY', 'SECRET_KEY']]) {
  const value = Deno.env.get(name) ?? Deno.env.get(alias)
  if (value) Deno.env.set(name, value)
}
const api = Deno.env.get('SUPABASE_URL')
const db = Deno.env.get('SUPABASE_DB_URL')
assert.ok(api && db, 'Set SUPABASE_URL/SUPABASE_DB_URL or API_URL/DB_URL from the local stack')
for (const [value, port] of [[api, Deno.env.get('PANCAKE_TEST_API_PORT') ?? configApiPort], [db, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? configDbPort]]) {
  const target = new URL(value)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'Only a loopback stack is allowed')
  assert.equal(target.port, port, `Only the expected local port ${port} is allowed`)
  assert.ok(!target.port.startsWith('582'), 'Refuse the protected replay block 582xx')
  assert.ok(!target.port.startsWith('543') || configApiPort.startsWith('543'), 'Refuse the orchestrator block 543xx from another checkout')
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
