import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
for (const target of [status.API_URL, status.DB_URL]) {
  if (new URL(target).hostname !== '127.0.0.1') throw new Error('History fixtures require a private local stack.')
}
const admin = createClient(status.API_URL, status.SECRET_KEY, { auth: { persistSession: false } })
const email = `history-${Date.now()}@example.test`
const { data, error } = await admin.auth.admin.createUser({ email, password: 'History-only-123!', email_confirm: true })
if (error) throw error
const source = readFileSync('tests/db/league-history.sql', 'utf8').split('SET LOCAL ROLE authenticated;')[0]
  .replaceAll('9398', '2025').replaceAll('9399', '2026').replaceAll('9400', '2027').replaceAll('9401', '2028')
  .replace('\\ir rules-support.sql', () => readFileSync('tests/db/rules-support.sql', 'utf8'))
const fixture = JSON.parse(execFileSync('psql', [status.DB_URL, '-XqAt', '-v', 'ON_ERROR_STOP=1'], {
  input: `${source}
    UPDATE public.league_members SET user_id = '${data.user.id}' WHERE id = (SELECT member_ids[1] FROM history_fixture);
    UPDATE public.leagues SET commissioner_id = '${data.user.id}', name = 'Pancake History' WHERE id = (SELECT league_id FROM history_fixture);
    UPDATE public.league_members SET team_name = CASE id
      WHEN (SELECT member_ids[1] FROM history_fixture) THEN 'Maple Legends'
      WHEN (SELECT member_ids[2] FROM history_fixture) THEN 'Golden Stack'
      WHEN (SELECT member_ids[3] FROM history_fixture) THEN 'Sunday Shooters'
      WHEN (SELECT member_ids[4] FROM history_fixture) THEN 'Fourth Seed Champions'
      ELSE 'Breakfast Club' END WHERE league_id = (SELECT league_id FROM history_fixture);
    SELECT jsonb_build_object('leagueId', league_id, 'memberId', member_ids[1], 'email', '${email}') FROM history_fixture;
    DELETE FROM private.live_hint_broadcasts WHERE transaction_id = pg_current_xact_id();
    COMMIT;`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
}).trim())
console.log(JSON.stringify(fixture))
