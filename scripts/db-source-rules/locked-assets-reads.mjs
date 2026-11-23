const LOCKED_ASSETS_READERS = new Set([
  'private.locked_assets',
  'private.roster_action_blocks',
  'private.pre_tipoff_policy_input_fingerprint',
  'public.view_claims',
  'public.view_roster',
])

const LOCKED_ASSETS_CALL = /\bprivate\s*\.\s*"?locked_assets"?\s*\(/i

const stripLineComments = (definition) => definition.replace(/--[^\n]*/g, '')

/** @param {{ definitions: Map<string, string> }} input */
export default function lockedAssetsReads({ definitions }) {
  return [...definitions]
    .filter(([key, definition]) => !LOCKED_ASSETS_READERS.has(key.replace(/\(.*$/, ''))
      && LOCKED_ASSETS_CALL.test(stripLineComments(definition)))
    .map(([key]) => `${key} reads private.locked_assets() to decide what a hold blocks; route through private.assert_roster_action_allowed (or private.roster_action_blocks for set reads) and change the cell in private.roster_action_policy`)
}
