import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import ts from 'typescript'

test('database type generation compiles after retired enums leave the schema', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pancake-type-generator-'))
  try {
    await mkdir(path.join(directory, 'types'))
    const enums = ['league_status', 'league_member_role', 'draft_type', 'draft_status', 'nomination_status', 'roster_slot_type', 'nba_position', 'waiver_claim_status', 'trade_status', 'trade_side', 'veto_type', 'matchup_type']
    const tables = ['profiles', 'leagues', 'league_members', 'league_seasons', 'players', 'roster_players', 'weekly_lineups', 'player_game_stats', 'matchups', 'drafts', 'draft_picks']
    const generated = `export type Database = { public: {
      Enums: { ${enums.map(name => `${name}: string`).join('; ')} }
      Tables: { ${tables.map(name => `${name}: { Row: unknown }`).join('; ')} }
      Functions: { activate_roster_player_with_lineup_atomic: { Args: {
        p_free_action?: string; p_free_roster_player_id?: string; p_slot_type?: string
      } }; get_live_checkpoint_work: { Returns: { checkpoint_at: string; game_time: string }[] } }
    } }`
    await writeFile(path.join(directory, 'supabase'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(generated)})\n`, { mode: 0o700 })
    execFileSync(process.execPath, [path.resolve('scripts/generate-database-types.mjs')], {
      cwd: directory, env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` },
    })
    const output = await readFile(path.join(directory, 'types/database.ts'), 'utf8')
    assert.match(output, /checkpoint_at: string \| null/)
    assert.match(output, /game_time: string \| null/)
    const program = ts.createProgram([path.join(directory, 'types/database.ts')], { noEmit: true, noLib: true, strict: true, types: [] })
    assert.deepEqual(program.getSemanticDiagnostics().map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
