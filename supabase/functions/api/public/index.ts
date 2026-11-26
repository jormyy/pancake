import { supabase } from '../../_shared/supabase.ts'
import { createLimiter, createPublicHandler } from './handler.ts'
import { createPublicReader } from './reader.ts'

export const handlePublicRoute = createPublicHandler(createPublicReader(supabase as unknown as Parameters<typeof createPublicReader>[0]), createLimiter(), () => new Date(), Deno.env.get('SUPABASE_URL') ?? '')
