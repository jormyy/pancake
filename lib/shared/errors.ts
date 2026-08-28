/** A failed data request. `code` is the database SQLSTATE when the server forwarded one. */
export class RequestError extends Error {
    code?: string
    status?: number

    constructor(message: string, options: { code?: string | null; status?: number } = {}) {
        super(message)
        this.code = options.code ?? undefined
        this.status = options.status
    }
}

export function rpcError(error: { message: string; code?: string | null }, message = error.message): RequestError {
    return new RequestError(message, { code: error.code })
}
