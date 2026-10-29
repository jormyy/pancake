import { expect, it } from 'vitest'
import { diskUsage, parseDiskUsage } from '../../scripts/perf-lab/disk.mjs'

it('records VM free space from only the private database container', async () => {
  const calls: unknown[] = []
  const result = await diskUsage(async (...args: unknown[]) => {
    calls.push(args)
    return { stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1000 210 790 21% /etc/hostname\n' }
  })
  expect(calls).toEqual([['docker', ['exec', 'supabase_db_pt4bafablelab', 'df', '-Pk', '/var/lib/postgresql/data'], { timeout: 10000 }]])
  expect(result).toEqual({ totalBytes: 1024000, usedBytes: 215040, availableBytes: 808960, percent: 21 })
  expect(() => parseDiskUsage('not a disk result')).toThrow('Invalid VM disk usage')
})
