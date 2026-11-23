import { strict as assert } from 'node:assert'
const api = Deno.env.get('SUPABASE_URL')!
assert.ok(api && ['localhost', '127.0.0.1'].includes(new URL(api).hostname))
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { loadNamePlayerResolver } = await import('../../functions/_shared/playerResolver.ts')

const SEEDED = 2500
const token = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
const players = Array.from({ length: SEEDED }, (_, index) => ({
  id: crypto.randomUUID(),
  first_name: 'Paged',
  last_name: `Read${token}x${index}`,
  position: 'PG' as const,
  eligible_positions: ['PG'],
  years_exp: 2,
}))
const q = async (op: PromiseLike<{ data: any; error: { message: string } | null }>): Promise<any> => {
  const { data, error } = await op
  if (error) throw new Error(error.message)
  return data
}

try {
  for (let offset = 0; offset < players.length; offset += 500) {
    await q(supabase.from('players').insert(players.slice(offset, offset + 500)))
  }
  const capped = await q(supabase.from('players').select('id').limit(SEEDED * 4))
  assert.equal(capped.length, 1000, 'The local API must cap reads at max_rows=1000, or this test cannot fail')

  const { byExactName } = await loadNamePlayerResolver()
  const missing = players.filter((player, index) => byExactName.get(`paged read${token}x${index}`) !== player.id)
  assert.equal(missing.length, 0, `Player lookup dropped ${missing.length} of ${SEEDED} seeded players; read every page through fetchAllPages`)
  console.log(`paged-reads: player lookup resolved all ${SEEDED} seeded players past the 1000-row cap`)
} finally {
  for (let offset = 0; offset < players.length; offset += 200) {
    await q(supabase.from('players').delete().in('id', players.slice(offset, offset + 200).map((player) => player.id)))
  }
}
