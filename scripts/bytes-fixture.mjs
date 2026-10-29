import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { labRoot, requireMini } from './perf-lab/common.mjs'
import { localKeys, sql } from './perf-lab/database.mjs'
import { fileURLToPath } from 'node:url'

export async function seedByteScreens(keys) {
  const league = await sql(`SELECT league.id FROM public.leagues league
    WHERE league.status='active' AND EXISTS (SELECT 1 FROM public.league_seasons season WHERE season.league_id=league.id AND season.is_current)
    AND (SELECT count(*) FROM public.league_members member WHERE member.league_id=league.id)>=2
    AND EXISTS (SELECT 1 FROM public.roster_players roster WHERE roster.league_id=league.id)
    ORDER BY (SELECT count(*) FROM public.roster_players roster WHERE roster.league_id=league.id) DESC LIMIT 1`)
  assert.match(league, /^[a-f0-9-]{36}$/)
  const members = JSON.parse(await sql(`SELECT json_agg(row) FROM (SELECT id,user_id FROM public.league_members member WHERE league_id='${league}'
    ORDER BY (SELECT count(*) FROM public.roster_players roster WHERE roster.member_id=member.id) DESC,id) row`))
  const email = `bytes-${randomUUID()}@example.invalid`
  const password = randomBytes(24).toString('base64url')
  const admin = createClient(keys.API_URL, keys.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: 'Byte measurement' } })
  assert.ifError(created.error)
  const userId = created.data.user.id
  await sql(`UPDATE public.league_members SET user_id='${userId}' WHERE id='${members[0].id}'`)
  members[0].user_id = userId
  const players = JSON.parse(await sql(`SELECT json_agg(row) FROM (SELECT player.id FROM public.players player
    JOIN public.roster_players roster ON roster.player_id=player.id WHERE roster.member_id='${members[0].id}' ORDER BY player.id) row`))
  const createdDraft = await admin.rpc('create_mock_draft_room_atomic', {
    p_league_id: league, p_member_id: members[0].id, p_user_id: userId,
    p_room_name: 'Byte measurement', p_draft_type: 'auction', p_rounds: 2,
  })
  assert.ifError(createdDraft.error)
  const draftId = createdDraft.data.id
  const joined = await admin.from('draft_room_members').insert(members.slice(1).map(member => ({ draft_id: draftId, member_id: member.id })))
  assert.ifError(joined.error)
  const started = await admin.rpc('start_mock_draft_room_atomic', { p_draft_id: draftId, p_member_id: members[0].id, p_user_id: userId })
  assert.ifError(started.error)
  const drafts = [{ id: draftId, draft_type: 'auction' }]
  assert.ok(players?.length)
  const fixture = { leagueId: league, members, players, drafts, users: [{ email }], password }
  await mkdir(path.join(labRoot, 'seed'), { recursive: true })
  await writeFile(path.join(labRoot, 'seed/complete.json'), JSON.stringify(fixture), { mode: 0o600 })
  return { fixture }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await requireMini()
  await seedByteScreens(await localKeys())
  console.log('Local screen fixture ready.')
}
