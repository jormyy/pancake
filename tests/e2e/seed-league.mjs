import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv } from './env.mjs'

const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/e2e-seed-report.md')
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')

const currentSeasonYear = (now = new Date()) => {
  return now.getUTCMonth() >= 9 ? now.getUTCFullYear() + 1 : now.getUTCFullYear()
}

const writeReport = async ({ runId, league, users, checks }) => {
  const lines = [
    '# E2E Seed Report',
    '',
    `- Run ID: ${runId}`,
    `- League ID: ${league?.id ?? '<not-created>'}`,
    `- Invite Code: ${league?.invite_code ?? '<not-created>'}`,
    `- Users: ${users.length}`,
    '',
    '## Checks',
    '',
    '| Check | Status | Detail |',
    '| --- | --- | --- |',
    ...checks.map((check) => `| ${check.name} | ${check.status} | ${check.detail} |`),
  ]
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`)
}

const writeState = async ({ runId, league, users, password }) => {
  const state = {
    runId,
    leagueId: league.id,
    inviteCode: league.invite_code,
    password,
    users: users.map((user) => ({
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      teamName: user.teamName,
    })),
    createdAt: new Date().toISOString(),
  }
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`)
}

const createConfirmedUser = async (admin, user) => {
  const { data, error } = await admin.auth.admin.createUser({
    email: user.email,
    password: user.password,
    email_confirm: true,
    user_metadata: {
      username: user.username,
      display_name: user.displayName,
    },
  })
  if (error) throw new Error(`createUser ${user.email}: ${error.message}`)
  if (!data.user) throw new Error(`createUser ${user.email}: no user returned`)
  return data.user
}

const signInClient = async (env, email, password) => {
  const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`signIn ${email}: ${error.message}`)
  return client
}

const main = async () => {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])

  const runId = process.env.E2E_SEED_RUN_ID ?? new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const password = `Pancake-e2e-${runId}!`
  const users = Array.from({ length: 10 }, (_, index) => {
    const n = index + 1
    return {
      email: `pancake-e2e-${runId}-${n}@example.com`,
      password,
      username: `pancake_e2e_${runId}_${n}`,
      displayName: `Pancake E2E ${runId} #${n}`,
      teamName: `E2E Team ${n}`,
    }
  })

  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const checks = []
  let league = null

  try {
    const createdUsers = []
    for (const user of users) {
      const authUser = await createConfirmedUser(admin, user)
      createdUsers.push({ ...user, id: authUser.id })
    }

    const profiles = createdUsers.map((user) => ({
      id: user.id,
      username: user.username,
      display_name: user.displayName,
    }))
    const { error: profileError } = await admin.from('profiles').upsert(profiles, { onConflict: 'id' })
    if (profileError) throw new Error(`profiles upsert: ${profileError.message}`)

    const commissioner = await signInClient(env, users[0].email, password)
    const { data: createdLeague, error: createError } = await commissioner.rpc('create_league', {
      p_name: `Pancake E2E ${runId}`,
      p_team_name: users[0].teamName,
      p_auction_budget: 200,
    })
    if (createError) throw new Error(`create_league: ${createError.message}`)
    league = createdLeague

    for (const user of users.slice(1)) {
      const client = await signInClient(env, user.email, password)
      const { error } = await client.rpc('join_league_by_invite_code', {
        p_invite_code: league.invite_code,
        p_team_name: user.teamName,
      })
      if (error) throw new Error(`join ${user.email}: ${error.message}`)
    }

    const { data: members, error: membersError } = await admin
      .from('league_members')
      .select('id, team_name')
      .eq('league_id', league.id)
    if (membersError) throw new Error(`members check: ${membersError.message}`)
    checks.push({
      name: 'league_members',
      status: members?.length === 10 ? 'PASS' : 'FAIL',
      detail: `${members?.length ?? 0} rows`,
    })

    const seasonYear = currentSeasonYear()
    const minPickYear = seasonYear + 1
    const maxPickYear = seasonYear + 5
    const { data: picks, error: picksError } = await admin
      .from('draft_picks')
      .select('id, season_year, round, original_owner_id, current_owner_id')
      .eq('league_id', league.id)
      .gte('season_year', minPickYear)
      .lte('season_year', maxPickYear)
    if (picksError) throw new Error(`draft_picks check: ${picksError.message}`)
    checks.push({
      name: 'future_pick_bank',
      status: picks?.length === 150 ? 'PASS' : 'FAIL',
      detail: `${picks?.length ?? 0} rows for ${minPickYear}-${maxPickYear}`,
    })

    const failures = checks.filter((check) => check.status !== 'PASS')
    await writeReport({ runId, league, users: createdUsers, checks })
    if (failures.length === 0) {
      await writeState({ runId, league, users: createdUsers, password })
    }
    if (failures.length > 0) process.exitCode = 1
  } catch (error) {
    checks.push({ name: 'seed', status: 'ERROR', detail: error instanceof Error ? error.message : String(error) })
    await writeReport({ runId, league, users, checks })
    throw error
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
