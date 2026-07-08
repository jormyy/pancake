import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations')

export const FUNCTION_SOURCE_GROUPS = [
  {
    label: 'auction lifecycle',
    file: 'supabase/sql/functions/auction-lifecycle.sql',
    functions: [
      ['public', 'start_auction_draft_atomic'],
      ['public', 'create_auction_nomination_atomic'],
      ['public', 'place_auction_bid_atomic'],
      ['public', 'close_auction_nomination_atomic'],
      ['public', 'withdraw_auction_nomination_atomic'],
    ],
  },
  {
    label: 'dynasty projections and search',
    file: 'supabase/sql/functions/dynasty-projections-search.sql',
    functions: [
      ['public', 'projection_stat_fantasy_points'],
      ['public', 'get_league_projection_rows'],
      ['public', 'search_players'],
      ['public', 'invoke_projection_sync_if_due'],
      ['public', 'replace_dynasty_rankings'],
    ],
  },
  {
    label: 'dynasty transactions and settings',
    file: 'supabase/sql/functions/dynasty-transactions.sql',
    functions: [
      ['private', 'current_add_week_number'],
      ['private', 'ensure_faab_balance'],
      ['private', 'ensure_season_faab_balances'],
      ['private', 'weekly_add_limit_message'],
      ['private', 'assert_weekly_add_available'],
      ['private', 'consume_weekly_add'],
      ['private', 'log_league_activity'],
      ['public', 'get_league_activity_feed'],
      ['public', 'get_member_transaction_state'],
      ['public', 'commissioner_adjust_faab_balance_atomic'],
      ['public', 'commissioner_override_weekly_add_count_atomic'],
      ['public', 'update_league_settings_atomic'],
    ],
  },
  {
    label: 'lineup moves',
    file: 'supabase/sql/functions/lineup-moves.sql',
    functions: [
      ['public', 'lineup_slot_allowed_positions'],
      ['public', 'set_player_slot_moves_atomic'],
      ['public', 'set_player_slot_atomic'],
      ['public', 'auto_set_lineup_atomic'],
    ],
  },
  {
    label: 'trade negotiation',
    file: 'supabase/sql/functions/trade-negotiation.sql',
    functions: [
      ['private', 'clear_trade_block_listing_on_inactive_roster'],
      ['private', 'create_trade_offer'],
      ['public', 'propose_trade_atomic'],
      ['private', 'create_multi_team_trade_offer'],
      ['public', 'propose_multi_team_trade_atomic'],
      ['private', 'replace_trade_offer'],
      ['public', 'counter_trade_atomic'],
      ['public', 'edit_trade_atomic'],
      ['private', 'prevent_expired_or_unfunded_trade_accept'],
      ['public', 'expire_pending_trades_atomic'],
      ['public', 'complete_accepted_trade_atomic'],
      ['public', 'accept_multi_team_trade_atomic'],
      ['public', 'reject_trade_atomic'],
      ['public', 'withdraw_trade_atomic'],
      ['public', 'process_due_accepted_trades_atomic'],
      ['public', 'add_trade_block_item_atomic'],
      ['public', 'remove_trade_block_item_atomic'],
    ],
  },
  {
    label: 'waivers and adds',
    file: 'supabase/sql/functions/waivers-and-adds.sql',
    functions: [
      ['private', 'clear_future_unlocked_lineups'],
      ['private', 'clear_trade_block_listing_for_asset'],
      ['private', 'validate_waiver_claim_drop_player'],
      ['private', 'release_roster_player_to_waivers'],
      ['public', 'add_free_agent_atomic'],
      ['public', 'create_waiver_claim_atomic'],
      ['public', 'edit_waiver_claim_atomic'],
      ['public', 'cancel_waiver_claim_atomic'],
      ['public', 'reorder_waiver_claim_atomic'],
      ['private', 'fail_waiver_claim'],
      ['public', 'process_next_waiver_claim_atomic'],
      ['public', 'process_due_waiver_claims_atomic'],
      ['public', 'expire_waiver_wire_logs'],
    ],
  },
]

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const objectNamePattern = (name, schema) => {
  const escapedName = escapeRegExp(name)
  if (schema === 'public') return `(?:${escapeRegExp(schema)}\\.)?${escapedName}`
  return `${escapeRegExp(schema)}\\.${escapedName}`
}

const dollarQuotedStatement = (source) => {
  const asMatch = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(source)
  const semicolonIndex = source.indexOf(';')
  if (!asMatch || (semicolonIndex !== -1 && semicolonIndex < asMatch.index)) {
    if (semicolonIndex === -1) throw new Error('Could not find SQL statement terminator')
    return source.slice(0, semicolonIndex + 1)
  }

  const delimiter = asMatch[1]
  const openIndex = asMatch.index + asMatch[0].lastIndexOf(delimiter)
  const closeIndex = source.indexOf(delimiter, openIndex + delimiter.length)
  if (closeIndex === -1) throw new Error(`Could not find closing ${delimiter} delimiter`)

  const functionTerminator = source.indexOf(';', closeIndex + delimiter.length)
  if (functionTerminator === -1) throw new Error('Could not find SQL function terminator')
  return source.slice(0, functionTerminator + 1)
}

const normalizeSql = (source) => source.replace(/\r\n/g, '\n').trim()
const functionKey = ([schema, name]) => `${schema}.${name}`

const migrationFiles = async () =>
  (await readdir(MIGRATIONS_DIR))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort()

const allMigrations = async () => {
  const files = await migrationFiles()
  const chunks = await Promise.all(
    files.map(async (file) => `\n-- migration:${file}\n${await readFile(path.join(MIGRATIONS_DIR, file), 'utf8')}`),
  )
  return chunks.join('\n')
}

export const functionDefinitionsInSource = (source) => {
  const pattern = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(public|private)\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi
  const definitions = new Map()
  let match

  while ((match = pattern.exec(source)) !== null) {
    const schema = match[1] ?? 'public'
    const name = match[2]
    definitions.set(`${schema}.${name}`, dollarQuotedStatement(source.slice(match.index)))
  }

  return definitions
}

export const latestFunctionDefinition = async (schema, name) => {
  const migrations = await allMigrations()
  const qualifiedName = objectNamePattern(name, schema)
  const createPattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${qualifiedName}\\s*\\(`, 'gi')
  let createMatch
  let latestCreateIndex = -1

  while ((createMatch = createPattern.exec(migrations)) !== null) {
    latestCreateIndex = createMatch.index
  }

  if (latestCreateIndex === -1) {
    throw new Error(`No migration defines ${schema}.${name}`)
  }

  return dollarQuotedStatement(migrations.slice(latestCreateIndex))
}

export const canonicalSourceForGroup = async (group) => {
  const definitions = []
  for (const [schema, name] of group.functions) {
    definitions.push(normalizeSql(await latestFunctionDefinition(schema, name)))
  }

  return [
    `-- Canonical SQL source for ${group.label}.`,
    '-- Edit this file first, then copy changed function statements into a timestamped Supabase migration.',
    '-- npm run check:db-function-sources verifies the latest migration definitions still match.',
    '',
    ...definitions.flatMap((definition) => [definition, '']),
  ].join('\n')
}

export const writeFunctionSources = async () => {
  for (const group of FUNCTION_SOURCE_GROUPS) {
    const target = path.join(ROOT, group.file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, await canonicalSourceForGroup(group), 'utf8')
  }
}

export const checkFunctionSourceGroup = async (group) => {
  const failures = []
  const expectedKeys = group.functions.map(functionKey)
  const sourcePath = path.join(ROOT, group.file)
  const source = await readFile(sourcePath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (source === null) return [`${group.file} is missing`]

  const sourceDefinitions = functionDefinitionsInSource(source)
  const extraKeys = [...sourceDefinitions.keys()].filter((key) => !expectedKeys.includes(key))
  if (extraKeys.length > 0) failures.push(`${group.file} contains unmanaged function(s): ${extraKeys.join(', ')}`)

  for (const [schema, name] of group.functions) {
    const key = `${schema}.${name}`
    const sourceDefinition = sourceDefinitions.get(key)
    if (!sourceDefinition) {
      failures.push(`${group.file} is missing ${key}`)
      continue
    }

    const migrationDefinition = await latestFunctionDefinition(schema, name)
    if (normalizeSql(sourceDefinition) !== normalizeSql(migrationDefinition)) {
      failures.push(`${group.file} does not match latest migration definition for ${key}`)
    }
  }

  return failures
}

export const checkFunctionSources = async () => {
  const groupedFailures = await Promise.all(FUNCTION_SOURCE_GROUPS.map(checkFunctionSourceGroup))
  return groupedFailures.flat()
}

const runCli = async () => {
  const command = process.argv[2] ?? '--check'
  if (command === '--write') {
    await writeFunctionSources()
    return
  }
  if (command !== '--check') {
    throw new Error(`Unknown command ${command}. Use --check or --write.`)
  }

  const failures = await checkFunctionSources()
  if (failures.length > 0) {
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
