// Re-export canonical Supabase-generated database types from the app types tree.
// Source of truth: /types/database.ts
// (regenerate via `supabase gen types typescript --local > types/database.ts`)
//
// Note: this file is bundled by `supabase functions deploy`, which follows relative
// imports through Deno's resolver. The shared types file is plain TypeScript with
// no runtime imports, so cross-package re-export is safe.
export type { Database, Json } from '../../../types/database.ts'
