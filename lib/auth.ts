import { supabase } from '@/lib/supabase'

export async function signUp(
  email: string,
  password: string,
  username: string,
  displayName: string,
) {
  const { data, error } = await supabase.auth.signUp({ email, password })
  if (error) throw error

  const { error: profileError } = await supabase.from('profiles').insert({
    id: data.user!.id,
    username,
    display_name: displayName,
  })

  if (profileError) throw profileError

  return data
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

export async function getProfile(userId: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()
  if (error) throw error
  return data
}

export async function updateProfile(userId: string, updates: { display_name?: string }) {
  const { error } = await supabase
    .from('profiles')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', userId)
  if (error) throw error
}
