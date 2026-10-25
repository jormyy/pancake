import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('transactional trade notification coverage', () => {
    it('routes every trade action through database-owned outbox triggers', () => {
        const edge = read('supabase/functions/api/trades.ts')
        const statusTrigger = read('supabase/sql/functions/by-name/private/enqueue_trade_status_notification.sql')
        const participantTrigger = read('supabase/sql/functions/by-name/private/enqueue_trade_participant_notification.sql')

        expect(edge).not.toContain('notifyMember')
        for (const event of ['trade_rejected', 'trade_withdrawn', 'trade_expired', 'trade_vetoed', 'trade_completed']) {
            expect(statusTrigger).toContain(`'${event}'`)
        }
        for (const event of ['trade_offered', 'trade_countered', 'trade_edited', 'trade_participant_accepted', 'trade_accepted']) {
            expect(participantTrigger).toContain(`'${event}'`)
        }
    })

    it('wires web delivery failures to leased retries and terminal failures to dead letters', () => {
        const edge = read('supabase/functions/process-trades/index.ts')
        const outbox = read('supabase/functions/process-trades/outbox.ts')

        expect(edge).toContain('deliverNotificationOutbox(')
        expect(edge).toContain("supabase.rpc('fail_notification_outbox_atomic'")
        expect(edge).toContain('p_claim_token: row.claim_token')
        expect(edge).toContain("supabase.rpc('dead_letter_notification_outbox_atomic'")
        expect(outbox).toContain("result?.status === 'failed' && !result.retryable")
        expect(outbox).toContain('await fail(row, errorMessage(error))')
    })
})
