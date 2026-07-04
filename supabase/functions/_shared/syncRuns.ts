import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requiredSecretKey } from './supabase.ts'
import { errorMessage } from './responses.ts'

// sync_runs is not yet in the generated Database types (types/database.ts is
// regenerated from a live schema), so this client is scoped to just the table.
// Fold the table into the shared typed client once the types are regenerated.
type SyncRunsDatabase = {
  public: {
    Tables: {
      sync_runs: {
        Row: {
          id: string
          function_name: string
          started_at: string
          finished_at: string | null
          status: string
          rows_affected: number | null
          error: string | null
        }
        Insert: {
          id?: string
          function_name: string
          started_at?: string
          finished_at?: string | null
          status?: string
          rows_affected?: number | null
          error?: string | null
        }
        Update: {
          finished_at?: string | null
          status?: string
          rows_affected?: number | null
          error?: string | null
        }
        Relationships: []
      }
    }
    Views: { [_ in never]: never }
    Functions: { [_ in never]: never }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}

const syncRuns = createClient<SyncRunsDatabase>(
  Deno.env.get('SUPABASE_URL')!,
  requiredSecretKey(),
  { auth: { persistSession: false } },
)

// Persist a sync_runs row around a scheduled sync so cron health is queryable:
// running on start, then success with rows_affected or failed with the error.
export async function recordSyncRun<T>(
  functionName: string,
  run: () => Promise<{ result: T; rowsAffected: number | null }>,
): Promise<T> {
  const { data: started, error: startError } = await syncRuns
    .from('sync_runs')
    .insert({ function_name: functionName })
    .select('id')
    .single()
  if (startError) throw startError

  try {
    const { result, rowsAffected } = await run()
    await finishSyncRun(started.id, { status: 'success', rows_affected: rowsAffected })
    return result
  } catch (error) {
    // Record the failure but never let the bookkeeping mask the sync error.
    await finishSyncRun(started.id, { status: 'failed', error: errorMessage(error) }).catch(
      (updateError) => console.error(`[${functionName}] could not record failed sync run:`, updateError),
    )
    throw error
  }
}

async function finishSyncRun(
  runId: string,
  fields: { status: 'success' | 'failed'; rows_affected?: number | null; error?: string },
): Promise<void> {
  const { error } = await syncRuns
    .from('sync_runs')
    .update({ finished_at: new Date().toISOString(), ...fields })
    .eq('id', runId)
  if (error) throw error
}
