import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { functionLifecycleEventsInSource, dollarQuotedStatement } from '../scripts/check-db-function-sources.mjs'

export const ROOT = path.resolve(__dirname, '..')

export const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')
export const readFunctionSource = (functionName: string, schema = 'public'): string =>
    read(`supabase/sql/functions/by-name/${schema}/${functionName}.sql`)
export const readFunctionSources = (functions: (string | [string, string])[]): string =>
    functions.map((entry) => {
        const [functionName, schema] = Array.isArray(entry) ? entry : [entry, 'public']
        return readFunctionSource(functionName, schema)
    }).join('\n')
export const migrationFiles = readdirSync(path.join(ROOT, 'supabase/migrations'))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort()
export const migrationsFrom = (version: string): string =>
    migrationFiles
        .filter((file) => file >= version)
        .map((file) => read(`supabase/migrations/${file}`))
        .join('\n')

const allMigrations = (): string =>
    migrationFiles
        .map((file) => `\n-- migration:${file}\n${read(`supabase/migrations/${file}`)}`)
        .join('\n')

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const objectNamePattern = (name: string, schema: string): string =>
    schema === 'public'
        ? `(?:${escapeRegExp(schema)}\\.)?${escapeRegExp(name)}`
        : `${escapeRegExp(schema)}\\.${escapeRegExp(name)}`
const identifierPattern = (identifier: string): string =>
    `(?:"${escapeRegExp(identifier.replaceAll('"', '""'))}"|${escapeRegExp(identifier)})`

export const latestFunctionDefinition = (functionName: string, schema = 'public'): string => {
    const key = `${schema}.${functionName}`
    let definition: string | null = null
    let wasDefined = false
    for (const event of functionLifecycleEventsInSource(allMigrations())) {
        if (event.key !== key) continue
        if (event.type === 'create') {
            definition = event.definition
            wasDefined = true
        } else {
            definition = null
        }
    }
    if (definition) return definition
    if (wasDefined) throw new Error(`${key} is dropped after its latest definition`)
    throw new Error(`No migration defines ${key}`)
}

export const latestViewDefinition = (viewName: string, schema = 'public'): string => {
    const migrations = allMigrations()
    const qualifiedName = objectNamePattern(viewName, schema)
    const createPattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+${qualifiedName}\\b`, 'gi')
    let createMatch: RegExpExecArray | null
    let latestCreateIndex = -1

    while ((createMatch = createPattern.exec(migrations)) !== null) {
        latestCreateIndex = createMatch.index
    }

    if (latestCreateIndex === -1) {
        throw new Error(`No migration defines ${schema}.${viewName}`)
    }

    const definition = dollarQuotedStatement(migrations.slice(latestCreateIndex))
    const laterSql = migrations.slice(latestCreateIndex + definition.length)
    const dropPattern = new RegExp(`DROP\\s+VIEW(?:\\s+IF\\s+EXISTS)?\\s+${qualifiedName}\\b`, 'i')

    if (dropPattern.test(laterSql)) {
        throw new Error(`${schema}.${viewName} is dropped after its latest definition`)
    }

    return definition
}

export const latestPolicyDefinition = (policyName: string, tableName: string, schema = 'public'): string => {
    const migrations = allMigrations()
    const policy = identifierPattern(policyName)
    const table = objectNamePattern(tableName, schema)
    const createPattern = new RegExp(`CREATE\\s+POLICY\\s+${policy}\\s+ON\\s+${table}\\b`, 'gi')
    let createMatch: RegExpExecArray | null
    let latestCreateIndex = -1

    while ((createMatch = createPattern.exec(migrations)) !== null) {
        latestCreateIndex = createMatch.index
    }

    if (latestCreateIndex === -1) {
        throw new Error(`No migration defines policy ${policyName} on ${schema}.${tableName}`)
    }

    const definition = dollarQuotedStatement(migrations.slice(latestCreateIndex))
    const laterSql = migrations.slice(latestCreateIndex + definition.length)
    const dropPattern = new RegExp(`DROP\\s+POLICY(?:\\s+IF\\s+EXISTS)?\\s+${policy}\\s+ON\\s+${table}\\b`, 'i')

    if (dropPattern.test(laterSql)) {
        throw new Error(`Policy ${policyName} on ${schema}.${tableName} is dropped after its latest definition`)
    }

    return definition
}

export const functionPrivilegeStatements = (functionName: string, schema = 'public'): string[] => {
    const qualifiedName = objectNamePattern(functionName, schema)
    const pattern = new RegExp(
        `(?:REVOKE|GRANT)\\s+[^;]*\\bON\\s+FUNCTION\\s+${qualifiedName}\\s*\\([^)]*\\)[^;]*;`,
        'gi',
    )
    return allMigrations().match(pattern) ?? []
}

export const tablePrivilegeStatements = (tableName: string, schema = 'public'): string[] => {
    const qualifiedName = objectNamePattern(tableName, schema)
    const pattern = new RegExp(`(?:REVOKE|GRANT)\\s+[^;]*\\bON\\s+${qualifiedName}\\b[^;]*;`, 'gi')
    return allMigrations().match(pattern) ?? []
}

export const latestCronScheduleStatement = (jobName: string): string => {
    const migrations = allMigrations()
    const job = escapeRegExp(jobName)
    const schedulePattern = new RegExp(`cron\\.schedule\\(\\s*'${job}'`, 'gi')
    let scheduleMatch: RegExpExecArray | null
    let latestScheduleIndex = -1

    while ((scheduleMatch = schedulePattern.exec(migrations)) !== null) {
        latestScheduleIndex = scheduleMatch.index
    }

    if (latestScheduleIndex === -1) {
        throw new Error(`No migration schedules cron job ${jobName}`)
    }

    const statement = dollarQuotedStatement(migrations.slice(latestScheduleIndex))
    const laterSql = migrations.slice(latestScheduleIndex + statement.length)
    const unschedulePattern = new RegExp(`cron\\.unschedule\\(\\s*'${job}'`, 'i')

    if (unschedulePattern.test(laterSql)) {
        throw new Error(`Cron job ${jobName} is unscheduled after its latest schedule`)
    }

    return statement
}

export const latestTriggerStatement = (triggerName: string): string => {
    const migrations = allMigrations()
    const escapedName = escapeRegExp(triggerName)
    const createPattern = new RegExp(`CREATE\\s+TRIGGER\\s+${escapedName}\\b`, 'gi')
    let createMatch: RegExpExecArray | null
    let latestCreateIndex = -1

    while ((createMatch = createPattern.exec(migrations)) !== null) {
        latestCreateIndex = createMatch.index
    }

    if (latestCreateIndex === -1) {
        throw new Error(`No migration creates trigger ${triggerName}`)
    }

    const laterCreateSql = migrations.slice(latestCreateIndex)
    const semicolonIndex = laterCreateSql.indexOf(';')
    if (semicolonIndex === -1) throw new Error(`Could not find terminator for trigger ${triggerName}`)

    const statement = laterCreateSql.slice(0, semicolonIndex + 1)
    const laterSql = migrations.slice(latestCreateIndex + statement.length)
    const dropPattern = new RegExp(`DROP\\s+TRIGGER(?:\\s+IF\\s+EXISTS)?\\s+${escapedName}\\b`, 'i')

    if (dropPattern.test(laterSql)) {
        throw new Error(`Trigger ${triggerName} is dropped after its latest definition`)
    }

    return statement
}

export const sources = {
    scoringCronAuctionMigration: read('supabase/migrations/20260627000003_scoring_cron_auction_startup.sql'),
    etSeasonYearMigration: read('supabase/migrations/20260627000004_et_season_year_league_setup.sql'),
    auctionLifecycleMigration: read('supabase/migrations/20260627000005_auction_lifecycle.sql'),
    auctionAuthLockMigration: read('supabase/migrations/20260627000006_auction_auth_lock_order.sql'),
    auctionWithdrawAuthMigration: read('supabase/migrations/20260627000007_auction_withdraw_auth.sql'),
    inviteTradeLineupMigration: read('supabase/migrations/20260627000008_invite_trade_lineup_guards.sql'),
    rosterOwnershipHistoryMigration: read('supabase/migrations/20260627000009_roster_ownership_history.sql'),
    rookieDraftLedgerMigration: read('supabase/migrations/20260627000010_rookie_draft_ledger_budget_caps.sql'),
    lineupCurrentSeasonMigration: read('supabase/migrations/20260627000011_lineup_current_season_guards.sql'),
    playoffWaiverSeasonMigration: read('supabase/migrations/20260627000012_playoff_waiver_season_guards.sql'),
    playoffBracketFreezeMigration: read('supabase/migrations/20260627000013_playoff_bracket_freeze.sql'),
    playoffScheduleTradeDeadlineMigration: read('supabase/migrations/20260627000014_playoff_schedule_trade_deadline.sql'),
    integrationLintMigration: read('supabase/migrations/20260627000015_integration_db_lint.sql'),
    inviteCodeSecurityMigration: read('supabase/migrations/20260627000016_invite_code_security.sql'),
    rpcArrayCapsMigration: read('supabase/migrations/20260627000017_rpc_json_array_caps.sql'),
    internalEdgeTokenMigration: read('supabase/migrations/20260627000024_internal_edge_token_rookie_commissioner.sql'),
    waiverMigration: read('supabase/migrations/20260606000020_waiver_clears_live_poll_cdn_ledger.sql'),
    rookieDraftTimerMigration: read('supabase/migrations/20260630000005_rookie_draft_server_timers.sql'),
    draftConfigMockMigration: read('supabase/migrations/20260630000006_draft_config_mock_drafts.sql'),
}
