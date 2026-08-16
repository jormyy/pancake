import { spawnSync } from 'node:child_process'

const statusResult = spawnSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8' })
if (statusResult.status !== 0) {
  process.stderr.write(statusResult.stderr)
  process.exit(statusResult.status ?? 1)
}

const status = JSON.parse(statusResult.stdout)
const url = status.API_URL
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('Local Supabase is not running. Run `supabase start` first.')
}

const result = spawnSync('npx', ['expo', 'start', '--web', '--clear'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    EXPO_PUBLIC_SUPABASE_URL: url,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
    EXPO_PUBLIC_API_URL: `${url}/functions/v1/api`,
  },
})

process.exit(result.status ?? 1)
