const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createRequestId(): string {
    return globalThis.crypto.randomUUID()
}

export function requestId(value?: string): string {
    const id = value ?? createRequestId()
    if (!uuidPattern.test(id)) throw new Error('Request ID must be a UUID.')
    return id
}

export const guardedRpcNames = new Set([
    'set_player_slot_atomic', 'set_player_slot_moves_atomic', 'auto_set_lineup_atomic', 'auto_set_lineup_service_atomic',
    'update_lineup_slots_atomic', 'create_waiver_claim_atomic', 'edit_waiver_claim_atomic', 'cancel_waiver_claim_atomic',
    'reorder_waiver_claim_atomic', 'propose_trade_atomic', 'propose_multi_team_trade_atomic', 'submit_trade_offer_atomic',
    'accept_trade_atomic', 'accept_trade_with_plan_atomic', 'reject_trade_atomic', 'withdraw_trade_atomic', 'veto_trade_atomic',
    'set_trade_roster_plan_atomic', 'set_trade_taxi_destinations_atomic', 'add_trade_block_item_atomic', 'remove_trade_block_item_atomic',
    'make_snake_pick_atomic', 'commissioner_snake_pick_atomic', 'create_auction_nomination_atomic', 'place_auction_bid_atomic',
    'withdraw_auction_nomination_atomic', 'toggle_ir_atomic', 'toggle_taxi_atomic', 'activate_roster_player_with_lineup_atomic',
    'activate_roster_player_with_overflow_atomic', 'add_free_agent_atomic', 'drop_and_add_free_agent_atomic', 'drop_player_atomic',
    'update_league_settings_atomic', 'update_league_configuration_atomic', 'commissioner_adjust_faab_balance_atomic',
    'commissioner_override_weekly_add_count_atomic', 'notif_publish_announcement_atomic', 'create_league', 'join_league_by_invite_code',
    'save_client_settings_atomic', 'auto_pick_snake_pick_atomic',
])

function guardedApiPath(path: string): boolean {
    return /\/waivers\/claims(?:\/[^/]+\/(?:cancel|edit|reorder))?$/.test(path)
        || /\/trades\/(?:propose|propose-multi|block|[^/]+\/(?:accept|reject|withdraw|veto|counter|counter-multi|edit|edit-multi|roster-plan|taxi-destinations)|block\/[^/]+\/remove)$/.test(path)
        || /\/league\/(?:roster\/(?:ir|taxi)|lineup\/auto-set-season)$/.test(path)
        || /\/draft\/[^/]+\/(?:snake-pick|auto-pick|commissioner-pick|nominate|bid|withdraw-nomination)$/.test(path)
}

export function createMutationFetch(fetcher: typeof fetch, readIdentity?: () => unknown): typeof fetch {
    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost')
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return fetcher(input, init)
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        if (!url.pathname.startsWith('/rest/v1/') && !url.pathname.includes('/functions/v1/api/') && !headers.has('x-request-id')) return fetcher(input, init)
        let bodyId: string | undefined
        if (typeof init?.body === 'string') {
            try {
                const body = JSON.parse(init.body)
                bodyId = body?.p_request_id ?? body?.requestId
            } catch {}
        }
        headers.set('x-request-id', requestId(bodyId ?? headers.get('x-request-id') ?? undefined))
        const rpcName = url.pathname.match(/\/rest\/v1\/rpc\/([^/]+)$/)?.[1]
        const guarded = rpcName ? guardedRpcNames.has(rpcName) : guardedApiPath(url.pathname)
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        const identity = readIdentity?.()
        const canRetry = (attempt: number) => guarded && attempt === 0 && !signal?.aborted && (!readIdentity || readIdentity() === identity)
        const request = input instanceof Request ? input.clone() : input
        for (let attempt = 0; ; attempt += 1) {
            try {
                const response = await fetcher(request instanceof Request ? request.clone() : request, { ...init, headers })
                if (!guarded) return response
                const bytes = await response.arrayBuffer()
                if (response.status >= 500 && canRetry(attempt)) continue
                return new Response(response.status === 204 || response.status === 205 ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
            } catch (error) {
                if (!canRetry(attempt)) throw error
            }
        }
    }
}
