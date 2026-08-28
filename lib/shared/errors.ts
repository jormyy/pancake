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
