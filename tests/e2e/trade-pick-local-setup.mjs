import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

export function privateTradePickEnvironment(status) {
    assert.equal(status.API_URL, 'http://127.0.0.1:59621')
    assert.equal(new URL(status.DB_URL).hostname, '127.0.0.1')
    assert.equal(new URL(status.DB_URL).port, '59622')
    return {
        EXPO_PUBLIC_SUPABASE_URL: status.API_URL,
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.ANON_KEY,
        EXPO_PUBLIC_API_URL: `${status.API_URL}/functions/v1/api`,
        SUPABASE_DB_URL: status.DB_URL,
        PANCAKE_SUPABASE_SECRET_KEY: status.SERVICE_ROLE_KEY,
        PANCAKE_EDGE_INTERNAL_TOKEN: 'fable-c1-local-only',
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    const env = privateTradePickEnvironment(status)
    writeFileSync('.env', Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 })
    execFileSync('psql', [status.DB_URL, '-v', 'ON_ERROR_STOP=1', '-c', `
    INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change)
    SELECT '00000000-0000-0000-0000-000000000000',user_id,'authenticated','authenticated',id::text || '@example.test',extensions.crypt('Fable-picks-local-2026', extensions.gen_salt('bf')),now(),'{"provider":"email","providers":["email"]}','{}',now(),now(),'','','',''
    FROM public.league_members ON CONFLICT(id) DO NOTHING;
    INSERT INTO public.profiles(id,username,display_name) SELECT user_id, 'pick_' || replace(id::text,'-',''),team_name FROM public.league_members ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name;
    `], { stdio: 'inherit' })
    if (process.argv.includes('--build')) execFileSync('npx', ['expo', 'export', '--platform', 'web', '--clear'], {
        stdio: 'inherit', env: { ...process.env, ...env, EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1', CI: '1' },
    })
}
