/**
 * SQLSTATEs raised by Pancake's own rules (the `PA` class). The SQL that raises
 * each one owns its message; the Edge API forwards the code and the client
 * classifies on it here rather than on message text.
 */
export const RULE_CODES = {
    /** private.assert_weekly_add_available */
    weeklyAddLimit: 'PA001',
    /** private.prevent_uncleared_waiver_free_agent_add and the add RPC's pre-check */
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
    status?: number

    constructor(message: string, options: { code?: string; status?: number } = {}) {
        super(message)
        this.code = options.code
        this.status = options.status
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
