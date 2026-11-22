import { supabase } from '../_shared/supabase.ts'
import { TRANSIENT_HTTP_STATUSES, TRANSIENT_SQLSTATES, TransientHttpError } from '../_shared/transientError.ts'
import type { OptimizerSetting } from './settings.ts'

type IrMove = {
  kind: 'designate' | 'swap' | 'activate'
  designatePlayerId?: string
  activatePlayerId?: string
}

type IrSkipped = {
  playerId: string
  reason: string
  sqlstate?: string
}

type IrNotice = {
  playerId: string
  playerName: string
  reason: string
  action: string
}

export type IrOutcome = {
  moves: IrMove[]
  skipped: IrSkipped[]
  notices: IrNotice[]
}

export const EMPTY_IR_OUTCOME: IrOutcome = { moves: [], skipped: [], notices: [] }

class TransientIrError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'TransientIrError'
    this.code = code
  }
}

type IrRpcResult = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null; status?: number }>

type IrRpc = (name: 'auto_manage_ir_service', args: {
  p_league_id: string
  p_league_season_id: string
  p_member_id: string
}) => IrRpcResult

export type TipoffIrFence = {
  tipoffAt: string
  token: string
  scope: string
}

type FencedIrRpc = (name: 'auto_manage_ir_tipoff_service', args: {
  p_tipoff_at: string
  p_token: string
  p_league_id: string
  p_league_season_id: string
  p_member_id: string
  p_scope: string
}) => IrRpcResult

async function irOutcome(request: IrRpcResult): Promise<IrOutcome> {
  const { data, error, status } = await request
  if (error) {
    if (typeof status === 'number' && TRANSIENT_HTTP_STATUSES.has(status)) {
      throw new TransientHttpError(status, error.message)
    }
    throw error
  }
  return normalizeIrOutcome(data)
}

async function manageIr(setting: OptimizerSetting): Promise<IrOutcome> {
  return irOutcome((supabase.rpc as unknown as IrRpc)('auto_manage_ir_service', {
    p_league_id: setting.league_id,
    p_league_season_id: setting.league_season_id,
    p_member_id: setting.member_id,
  }))
}

async function manageIrFenced(setting: OptimizerSetting, fence: TipoffIrFence): Promise<IrOutcome> {
  return irOutcome((supabase.rpc as unknown as FencedIrRpc)('auto_manage_ir_tipoff_service', {
    p_tipoff_at: fence.tipoffAt,
    p_token: fence.token,
    p_league_id: setting.league_id,
    p_league_season_id: setting.league_season_id,
    p_member_id: setting.member_id,
    p_scope: fence.scope,
  }))
}

export async function manageIrForMember(setting: OptimizerSetting): Promise<IrOutcome> {
  try {
    return await manageIr(setting)
  } catch (error) {
    console.error('[lineup-optimizer] IR management failed', { setting, error })
    return EMPTY_IR_OUTCOME
  }
}

export async function manageIrForMemberStrict(setting: OptimizerSetting): Promise<IrOutcome> {
  const outcome = await manageIr(setting)
  const transient = outcome.skipped.find((skip) => skip.sqlstate && TRANSIENT_SQLSTATES.has(skip.sqlstate))
  if (transient?.sqlstate) throw new TransientIrError(transient.sqlstate, transient.reason)
  return outcome
}

export async function manageIrForTipoffMemberStrict(setting: OptimizerSetting, fence: TipoffIrFence): Promise<IrOutcome> {
  const outcome = await manageIrFenced(setting, fence)
  const transient = outcome.skipped.find((skip) => skip.sqlstate && TRANSIENT_SQLSTATES.has(skip.sqlstate))
  if (transient?.sqlstate) throw new TransientIrError(transient.sqlstate, transient.reason)
  return outcome
}

function normalizeIrOutcome(value: unknown): IrOutcome {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    moves: rows(record.moves).flatMap((move) => {
      const kind = move.kind
      if (kind !== 'designate' && kind !== 'swap' && kind !== 'activate') return []
      return [{
        kind,
        ...(typeof move.designatePlayerId === 'string' ? { designatePlayerId: move.designatePlayerId } : {}),
        ...(typeof move.activatePlayerId === 'string' ? { activatePlayerId: move.activatePlayerId } : {}),
      }]
    }),
    skipped: rows(record.skipped).flatMap((row) => typeof row.playerId === 'string' && typeof row.reason === 'string'
      ? [{ playerId: row.playerId, reason: row.reason,
          ...(typeof row.sqlstate === 'string' ? { sqlstate: row.sqlstate } : {}) }]
      : []),
    notices: rows(record.notices).flatMap((row) => typeof row.playerId === 'string' && typeof row.playerName === 'string' &&
      typeof row.reason === 'string' && typeof row.action === 'string'
      ? [{ playerId: row.playerId, playerName: row.playerName, reason: row.reason, action: row.action }]
      : []),
  }
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    : []
}
