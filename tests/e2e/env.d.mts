export type ResolvedE2EEnvironment = {
    supabaseUrl?: string
    serviceRoleKey?: string
    anonKey?: string
    apiBaseUrl?: string
    frontendUrl: string
    dbUrl?: string
    e2eAdminSecret?: string
    backendTicksEnabled: boolean
}

export type CommandResult = {
    command: string
    status: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
    error?: Error
}

export function loadEnvFile(filePath: string): void
export function envValue(...names: string[]): string | undefined
export function runCommand(command: string, args: string[], options?: { cwd?: string; timeout?: number }): CommandResult
export function statusFrom(condition: unknown, blocked?: string): 'PASS' | string
export function resolvedEnv(): ResolvedE2EEnvironment
export function requireEnv<Env extends object, Key extends keyof Env>(
    env: Env,
    keys: Key[],
): asserts env is Env & Required<Pick<Env, Key>>
export function describeEndpoint(value: string | undefined): string
export function cleanMessage(value: unknown, options?: { maxLines?: number }): string
export function querySupabaseDb(target: string, label: string, sql: string, timeout?: number): any[]
export function localSupabaseStatus(): any
export function writeMarkdownReport<Row>(options: {
    reportPath: string
    title: string
    rows: Row[]
    columns: { header: string; value: (row: Row) => unknown }[]
}): Promise<Row[]>
export function writeReportIfChanged(reportPath: string, report: string): Promise<void>
export function isProductionSupabaseUrl(value: string | undefined): boolean
