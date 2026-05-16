// Re-export canonical Supabase-generated database types from the backend tree.
// Source of truth: /backend/src/types/database.ts
// (regenerate via `supabase gen types typescript --local > backend/src/types/database.ts`)
//
// Note: this file is bundled by `supabase functions deploy`, which follows relative
// imports through Deno's resolver. The backend types file is plain TypeScript with
// no runtime imports, so cross-package re-export is safe.
export type { Database, Json } from '../../../backend/src/types/database.ts'
