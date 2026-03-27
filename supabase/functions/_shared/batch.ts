import { supabase } from './supabase.ts'

const CHUNK_SIZE = 500

export async function upsertInChunks(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  chunkSize = CHUNK_SIZE,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await (supabase as any)
      .from(table)
      .upsert(rows.slice(i, i + chunkSize), { onConflict })
    if (error) throw error
  }
}

export async function insertInChunks(
  table: string,
  rows: Record<string, unknown>[],
  chunkSize = CHUNK_SIZE,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await (supabase as any)
      .from(table)
      .insert(rows.slice(i, i + chunkSize))
    if (error) console.error(`[batch] Insert error on ${table} (chunk ${i}):`, error.message)
  }
}
