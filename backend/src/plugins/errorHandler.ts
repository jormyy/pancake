import { FastifyInstance } from 'fastify'

export class AppError extends Error {
    statusCode: number
    constructor(message: string, statusCode = 500) {
        super(message)
        this.statusCode = statusCode
    }
}

export class ValidationError extends AppError {
    constructor(message: string) {
        super(message, 400)
    }
}

export class NotFoundError extends AppError {
    constructor(message: string) {
        super(message, 404)
    }
}

export default async function errorHandlerPlugin(app: FastifyInstance) {
    app.setErrorHandler((error: Error, request, reply) => {
        const statusCode = (error as AppError).statusCode ?? 500
        const isServerError = statusCode >= 500

        if (isServerError) {
            request.log.error({ err: error, requestId: request.id }, 'Unhandled request error')
        }

        reply.status(statusCode).send({
            ok: false,
            error: isServerError ? 'Internal server error' : error.message || 'Request failed',
            requestId: request.id,
        })
    })
}
