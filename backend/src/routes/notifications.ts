import { FastifyInstance } from 'fastify'
import { notifyMember } from '../lib/notifications'
import { supabase } from '../lib/supabase'
import { AppError, ValidationError } from '../plugins/errorHandler'
import { NotifyTradeBody } from '../schemas'

/**
 * Verify the requesting user is in the same league as the target member.
 */
async function verifySameLeague(userId: string, memberId: string): Promise<string> {
    const { data: targetMember, error: targetError } = await supabase
        .from('league_members')
        .select('league_id')
        .eq('id', memberId)
        .single()

    if (targetError || !targetMember) {
        throw new AppError('Member not found', 404)
    }

    const { data: callerMember } = await supabase
        .from('league_members')
        .select('id')
        .eq('league_id', targetMember.league_id)
        .eq('user_id', userId)
        .maybeSingle()

    if (!callerMember) {
        throw new AppError('Not authorized to notify this member', 403)
    }

    return targetMember.league_id
}

export default async function notifyRoutes(app: FastifyInstance) {
    app.post('/trade', { schema: { body: NotifyTradeBody } }, async (req) => {
        const { memberId, title, body } = req.body as {
            memberId: string
            title: string
            body: string
        }

        if (!title?.trim() || !body?.trim()) {
            throw new ValidationError('Title and body are required')
        }

        await verifySameLeague(req.userId, memberId)
        await notifyMember(memberId, title, body)
        return { ok: true }
    })
}
