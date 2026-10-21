import assert from 'node:assert/strict'
import { basename, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

// Every post runner executes from <lane root>/repo on the mini. Turn 11 moved
// the lane root to lanes/claude-post; the retired lanes/post root stays valid.
export const lane = dirname(process.cwd())
assert.equal(dirname(lane), resolve(homedir(), 'pancake-t_4ba51e0d/lanes'))
assert.ok(['post', 'claude-post'].includes(basename(lane)), `Unexpected post lane root ${lane}`)
assert.equal(process.cwd(), resolve(lane, 'repo'))
