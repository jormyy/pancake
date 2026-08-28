/**
 * SQLSTATEs raised by Pancake's own rules (the `PA` class). The SQL that raises
 * each one owns its message; the code reaches the app through supabase-js for
 * direct RPC calls and through the Edge API for routed ones, and the client
 * classifies on it rather than on message text.
 */
export const RULE_CODES = {
    /** private.assert_weekly_add_available */
    weeklyAddLimit: 'PA001',
    /** private.prevent_uncleared_waiver_free_agent_add */
    onWaivers: 'PA002',
    /** add_free_agent_atomic: the active roster is full */
    rosterFull: 'PA003',
} as const

export function errorCode(error: unknown): string | undefined {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    return typeof code === 'string' ? code : undefined
}

/** A failed data request. `code` is the database SQLSTATE when the server forwarded one. */
export class RequestError extends Error {
    code?: string

    constructor(message: string, options: { code?: string } = {}) {
        super(message)
        this.code = options.code
    }
}

export function rpcError(error: { message: string; code?: string }, message = error.message): RequestError {
    return new RequestError(message, { code: error.code })
}

export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
        return (error as { message: string }).message
    }
    return String(error)
}
