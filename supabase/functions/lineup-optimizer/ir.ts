import { supabase } from '../_shared/supabase.ts'
import type { OptimizerSetting } from './settings.ts'

type IrMove = {
  kind: 'designate' | 'swap' | 'activate'
  designatePlayerId?: string
  activatePlayerId?: string
}

type IrSkipped = {
  playerId: string
  reason: string
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

type IrRpc = (name: 'auto_manage_ir_service', args: {
  p_league_id: string
  p_league_season_id: string
  p_member_id: string
}) => PromiseLike<{ data: unknown; error: { message: string } | null }>

async function manageIr(setting: OptimizerSetting): Promise<IrOutcome> {
  const { data, error } = await (supabase.rpc as unknown as IrRpc)('auto_manage_ir_service', {
    p_league_id: setting.league_id,
    p_league_season_id: setting.league_season_id,
    p_member_id: setting.member_id,
  })
  if (error) throw error
  return normalizeIrOutcome(data)
}

export async function manageIrForMember(setting: OptimizerSetting): Promise<IrOutcome> {
  try {
    return await manageIr(setting)
  } catch (error) {
    console.error('[lineup-optimizer] IR management failed', { setting, error })
    return EMPTY_IR_OUTCOME
  }
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
      ? [{ playerId: row.playerId, reason: row.reason }]
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
