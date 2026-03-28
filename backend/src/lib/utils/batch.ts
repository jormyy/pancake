import { supabase } from '../supabase'
import { CONFIG } from '../../config'

/**
 * Upserts rows into a Supabase table in chunks to avoid payload limits.
 * Throws on the first error encountered.
 */
export async function upsertInChunks(
    table: string,
    rows: Record<string, unknown>[],
    onConflict: string,
    chunkSize = CONFIG.UPSERT_CHUNK_SIZE,
): Promise<void> {
    for (let i = 0; i < rows.length; i += chunkSize) {
        const { error } = await (supabase as any)
            .from(table)
            .upsert(rows.slice(i, i + chunkSize), { onConflict })
        if (error) throw error
    }
}

/**
 * Inserts rows into a Supabase table in chunks.
 * Logs errors per chunk but does not throw (mirrors existing behavior).
 */
export async function insertInChunks(
    table: string,
    rows: Record<string, unknown>[],
    chunkSize = CONFIG.UPSERT_CHUNK_SIZE,
): Promise<void> {
    for (let i = 0; i < rows.length; i += chunkSize) {
        const { error } = await (supabase as any)
            .from(table)
            .insert(rows.slice(i, i + chunkSize))
        if (error) console.error(`[batch] Insert error on ${table} (chunk ${i}):`, error.message)
    }
}
