import { supabase } from '../_shared/supabase.ts'
import { syncScores } from '../_shared/syncScores.ts'
import { runBounded } from '../_shared/runBounded.ts'

export async function reconcilePlayoffScores(): Promise<void> {
  let afterId: string | undefined
  while (true) {
    let query = supabase.from('leagues').select('id').eq('status', 'playoffs').order('id').limit(100)
    if (afterId) query = query.gt('id', afterId)
    const { data, error } = await query
    if (error) throw error
    if (!data?.length) return
    await runBounded(data.map((league) => async () => {
      await syncScores(league.id, new Date(), { recoverStats: false })
    }), 5)
    if (data.length < 100) return
    afterId = data[data.length - 1].id
  }
}
