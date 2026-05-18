// Re-export canonical Supabase-generated database types from the backend tree.
// Source of truth: /backend/src/types/database.ts
// (regenerate via `supabase gen types typescript --local > backend/src/types/database.ts`)
export * from '../backend/src/types/database'
export type { Json } from '../backend/src/types/database'
