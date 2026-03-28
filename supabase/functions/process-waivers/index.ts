import { supabase } from '../_shared/supabase.ts'
import { notifyMember } from '../_shared/notifications.ts'

const WAIVER_CLEARANCE_HOURS = 48

Deno.serve(async () => {
  try {
    await processWaiverClaims()
    return Response.json({ ok: true })
  } catch (e: any) {
    console.error('[process-waivers]', e)
    return Response.json({ ok: false, error: e.message }, { status: 500 })
  }
})

async function processWaiverClaims(): Promise<void> {
  const today = new Date().toISOString().split('T')[0]

  const { data: claims, error: claimsErr } = await (supabase as any)
    .from('waiver_claims')
    .select('id, league_id, league_season_id, member_id, player_id, drop_player_id, priority_at_submission')
    .eq('status', 'pending')
    .lte('process_date', today)
    .order('priority_at_submission', { ascending: true })

  if (claimsErr) throw claimsErr
  if (!claims || claims.length === 0) {
    console.log('[process-waivers] No pending claims.')
    return
  }

  const claimedPlayers = new Set<string>()

  for (const claim of claims as any[]) {
    const key = `${claim.league_id}:${claim.player_id}`

    const { data: playerRow } = await supabase
      .from('players').select('display_name').eq('id', claim.player_id).single()
    const playerName = (playerRow as any)?.display_name ?? 'Unknown'

    if (claimedPlayers.has(key)) {
      await (supabase as any).from('waiver_claims').update({
        status: 'failed_priority',
        processed_at: new Date().toISOString(),
        failure_reason: 'Claimed by higher-priority team.',
      }).eq('id', claim.id)
      await notifyMember(claim.member_id, 'Waiver Claim Failed', `Your claim for ${playerName} was not successful — claimed by a higher-priority team.`).catch(console.error)
      continue
    }

    const now = new Date().toISOString()
    const { data: waiverLog } = await (supabase as any)
      .from('waiver_wire_log')
      .select('id')
      .eq('league_id', claim.league_id)
      .eq('league_season_id', claim.league_season_id)
      .eq('player_id', claim.player_id)
      .is('cleared_at', null)
      .gt('clears_at', now)
      .maybeSingle()

    if (!waiverLog) {
      await (supabase as any).from('waiver_claims').update({
        status: 'failed_priority',
        processed_at: new Date().toISOString(),
        failure_reason: 'Player no longer on waivers.',
      }).eq('id', claim.id)
      continue
    }

    const { data: alreadyOwned } = await (supabase as any)
      .from('roster_players')
      .select('id')
      .eq('league_id', claim.league_id)
      .eq('league_season_id', claim.league_season_id)
      .eq('player_id', claim.player_id)
      .maybeSingle()

    if (alreadyOwned) {
      await (supabase as any).from('waiver_claims').update({
        status: 'failed_priority',
        processed_at: new Date().toISOString(),
        failure_reason: 'Player already on a roster.',
      }).eq('id', claim.id)
      continue
    }

    const { data: league } = await (supabase as any)
      .from('leagues').select('roster_size').eq('id', claim.league_id).single()
    const rosterSize = league?.roster_size ?? 20

    const { count: activeCount } = await (supabase as any)
      .from('roster_players')
      .select('id', { count: 'exact', head: true })
      .eq('member_id', claim.member_id)
      .eq('league_season_id', claim.league_season_id)
      .eq('is_on_ir', false)

    const hasSpace = (activeCount ?? 0) < rosterSize

    if (!hasSpace && !claim.drop_player_id) {
      await (supabase as any).from('waiver_claims').update({
        status: 'failed_roster',
        processed_at: new Date().toISOString(),
        failure_reason: 'Roster full and no drop player specified.',
      }).eq('id', claim.id)
      await notifyMember(claim.member_id, 'Waiver Claim Failed', `Your claim for ${playerName} failed — roster is full and no drop was specified.`).catch(console.error)
      continue
    }

    if (claim.drop_player_id) {
      const { data: dropRp } = await (supabase as any)
        .from('roster_players')
        .select('id, player_id')
        .eq('member_id', claim.member_id)
        .eq('league_id', claim.league_id)
        .eq('league_season_id', claim.league_season_id)
        .eq('player_id', claim.drop_player_id)
        .maybeSingle()

      if (dropRp) {
        await (supabase as any).from('roster_players').delete().eq('id', dropRp.id)
        const clearsAt = new Date(Date.now() + WAIVER_CLEARANCE_HOURS * 60 * 60 * 1000).toISOString()
        await (supabase as any).from('waiver_wire_log').insert({
          league_id: claim.league_id,
          league_season_id: claim.league_season_id,
          player_id: claim.drop_player_id,
          dropped_by_member_id: claim.member_id,
          clears_at: clearsAt,
        })
        await (supabase as any).from('roster_transactions').insert({
          league_id: claim.league_id,
          league_season_id: claim.league_season_id,
          member_id: claim.member_id,
          player_id: claim.drop_player_id,
          transaction_type: 'waiver_drop',
          related_claim_id: claim.id,
        })
      }
    }

    const { error: addErr } = await (supabase as any).from('roster_players').insert({
      member_id: claim.member_id,
      league_id: claim.league_id,
      league_season_id: claim.league_season_id,
      player_id: claim.player_id,
      acquired_via: 'waiver',
    })

    if (addErr) {
      await (supabase as any).from('waiver_claims').update({
        status: 'failed_roster',
        processed_at: new Date().toISOString(),
        failure_reason: addErr.message,
      }).eq('id', claim.id)
      continue
    }

    await (supabase as any).from('roster_transactions').insert({
      league_id: claim.league_id,
      league_season_id: claim.league_season_id,
      member_id: claim.member_id,
      player_id: claim.player_id,
      transaction_type: 'waiver_add',
      related_claim_id: claim.id,
    })

    await notifyMember(claim.member_id, 'Waiver Claim Succeeded', `${playerName} has been added to your roster.`).catch(console.error)

    await (supabase as any)
      .from('waiver_wire_log')
      .update({ cleared_at: new Date().toISOString(), claimed_by_claim_id: claim.id })
      .eq('id', waiverLog.id)

    const { data: maxRow } = await (supabase as any)
      .from('waiver_priorities')
      .select('priority')
      .eq('league_id', claim.league_id)
      .eq('league_season_id', claim.league_season_id)
      .order('priority', { ascending: false })
      .limit(1)
      .single()

    const newPriority = (maxRow?.priority ?? 0) + 1
    await (supabase as any)
      .from('waiver_priorities')
      .update({ priority: newPriority })
      .eq('member_id', claim.member_id)
      .eq('league_season_id', claim.league_season_id)

    await (supabase as any).from('waiver_claims').update({
      status: 'succeeded',
      processed_at: new Date().toISOString(),
    }).eq('id', claim.id)

    claimedPlayers.add(key)
    console.log(`[process-waivers] Claim ${claim.id} succeeded.`)
  }

  // Clear expired waiver_wire_log entries
  await (supabase as any)
    .from('waiver_wire_log')
    .update({ cleared_at: new Date().toISOString() })
    .is('cleared_at', null)
    .lt('clears_at', new Date().toISOString())

  console.log('[process-waivers] Complete.')
}
