import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanupPreviousSeed } from './e2e/seed-league.mjs'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const previousState = {
  leagueId: 'league-1',
  users: [{ id: 'user-1' }, { id: 'user-2' }],
}

const createAdmin = (userFailure: { message: string } | null = null) => {
  const deleteUser = vi.fn(async (userId: string) => ({
    error: userId === 'user-2' ? userFailure : null,
  }))
  const from = vi.fn((table: string) => {
    if (table === 'trades') {
      return {
        update: vi.fn(() => ({
          eq: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
        })),
      }
    }
    if (table === 'leagues') {
      return { delete: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })) }
    }
    throw new Error(`unexpected table ${table}`)
  })
  return { admin: { auth: { admin: { deleteUser } }, from }, deleteUser, from }
}

const createStatePath = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pancake-seed-cleanup-'))
  tempDirs.push(root)
  const statePath = path.join(root, 'state.json')
  await writeFile(statePath, JSON.stringify(previousState))
  return statePath
}

describe('repeated E2E seed cleanup', () => {
  it('deletes the previous league before users and removes ownership state', async () => {
    const statePath = await createStatePath()
    const { admin, deleteUser, from } = createAdmin()

    await cleanupPreviousSeed(admin, statePath)

    expect(from).toHaveBeenCalledWith('trades')
    expect(from).toHaveBeenCalledWith('leagues')
    expect(deleteUser).toHaveBeenCalledTimes(2)
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains ownership state when cleanup fails so the next run can retry', async () => {
    const statePath = await createStatePath()
    const { admin } = createAdmin({ message: 'delete failed' })

    await expect(cleanupPreviousSeed(admin, statePath)).rejects.toThrow('Previous E2E seed cleanup failed')

    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(previousState)
  })
})
