import { supabase } from '../_shared/supabase.ts'
import type { ForecastContext } from './compute.ts'

export async function loadForecastContext(matchupId: string): Promise<ForecastContext> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: dates, error: prepareError } = await supabase.rpc('prepare_matchup_forecast_inputs', { p_matchup_id: matchupId })
    if (prepareError) throw prepareError
    for (const date of dates as string[]) {
      const { error } = await supabase.rpc('prepare_matchup_forecast_inputs', { p_matchup_id: matchupId, p_game_date: date })
      if (error) throw error
    }
    const { data, error } = await supabase.rpc('get_prepared_matchup_forecast_context', { p_matchup_id: matchupId })
    if (error?.code === 'PT409' && attempt < 2) continue
    if (error) throw error
    if (!data) throw new Error('Matchup context is unavailable.')
    return data as unknown as ForecastContext
  }
  throw new Error('Forecast inputs keep changing.')
}
