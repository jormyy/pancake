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
    app.setErrorHandler((error: Error, _request, reply) => {
        const statusCode = (error as AppError).statusCode ?? 500
        const message = error.message || 'Unknown error'

        if (statusCode >= 500) {
            app.log.error(error)
        }

        reply.status(statusCode).send({ ok: false, error: message })
    })
}
