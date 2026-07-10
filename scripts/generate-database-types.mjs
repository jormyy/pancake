import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'

const target = 'types/database.ts'
const aliases = `
export type LeagueStatus = Database["public"]["Enums"]["league_status"]
export type LeagueMemberRole = Database["public"]["Enums"]["league_member_role"]
export type DraftType = Database["public"]["Enums"]["draft_type"]
export type DraftStatus = Database["public"]["Enums"]["draft_status"]
export type NominationStatus = Database["public"]["Enums"]["nomination_status"]
export type RosterSlotType = Database["public"]["Enums"]["roster_slot_type"]
export type NBAPosition = Database["public"]["Enums"]["nba_position"]
export type WaiverClaimStatus = Database["public"]["Enums"]["waiver_claim_status"]
export type TradeStatus = Database["public"]["Enums"]["trade_status"]
export type TradeSide = Database["public"]["Enums"]["trade_side"]
export type VetoType = Database["public"]["Enums"]["veto_type"]
export type MatchupType = Database["public"]["Enums"]["matchup_type"]
export type RpsChoice = Database["public"]["Enums"]["rps_choice"]
export type RpsStatus = Database["public"]["Enums"]["rps_status"]

export type Profile = Database["public"]["Tables"]["profiles"]["Row"]
export type League = Database["public"]["Tables"]["leagues"]["Row"]
export type LeagueMember = Database["public"]["Tables"]["league_members"]["Row"]
export type LeagueSeason = Database["public"]["Tables"]["league_seasons"]["Row"]
export type Player = Database["public"]["Tables"]["players"]["Row"]
export type RosterPlayer = Database["public"]["Tables"]["roster_players"]["Row"]
export type WeeklyLineup = Database["public"]["Tables"]["weekly_lineups"]["Row"]
export type PlayerGameStats = Database["public"]["Tables"]["player_game_stats"]["Row"]
export type Matchup = Database["public"]["Tables"]["matchups"]["Row"]
export type Draft = Database["public"]["Tables"]["drafts"]["Row"]
export type DraftPick = Database["public"]["Tables"]["draft_picks"]["Row"]
`

/** @type {Map<string, Set<string>>} */
const nullableRpcArguments = new Map([
  ['activate_roster_player_with_lineup_atomic', new Set([
    'p_free_action',
    'p_free_roster_player_id',
    'p_slot_type',
  ])],
])

/** @typedef {{ start: number, end: number, text: string }} TextReplacement */

/** @param {string} generated */
const applyRpcArgumentOverrides = (generated) => {
  const sourceFile = ts.createSourceFile(target, generated, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  /** @type {TextReplacement[]} */
  const replacements = []
  const matched = new Set()
  /** @param {import('typescript').Node} node @param {string[]} propertyPath */
  const visit = (node, propertyPath = []) => {
    const name = ts.isPropertySignature(node) && node.name ? node.name.getText(sourceFile).replaceAll(/["']/g, '') : null
    const nextPath = name ? [...propertyPath, name] : propertyPath
    if (ts.isPropertySignature(node) && node.type && propertyPath.at(-1) === 'Args') {
      const rpcName = propertyPath.at(-2)
      const expectedArguments = rpcName ? nullableRpcArguments.get(rpcName) : undefined
      if (name && expectedArguments?.has(name)) {
        const matchKey = `${rpcName}.${name}`
        const typeText = node.type.getText(sourceFile)
        replacements.push({
          start: node.type.getStart(sourceFile),
          end: node.type.getEnd(),
          text: typeText.includes('null') ? typeText : `${typeText} | null`,
        })
        matched.add(matchKey)
      }
    }
    ts.forEachChild(node, (child) => visit(child, nextPath))
  }
  visit(sourceFile)

  const expected = [...nullableRpcArguments].flatMap(([rpcName, argumentsSet]) =>
    [...argumentsSet].map((argument) => `${rpcName}.${argument}`))
  const missing = expected.filter((key) => !matched.has(key))
  if (missing.length > 0 || matched.size !== expected.length) {
    throw new Error(`Database type overrides did not match exactly once: ${missing.join(', ') || 'duplicate match'}`)
  }
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce((text, replacement) =>
      text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end), generated)
}

const generated = execFileSync('supabase', ['gen', 'types', 'typescript', '--local'], { encoding: 'utf8' })
const contents = applyRpcArgumentOverrides(generated).trimEnd() + `\n\n${aliases.trim()}\n`

if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== contents) {
    console.error(`${target} is stale; run npm run generate:database-types`)
    process.exitCode = 1
  }
} else {
  writeFileSync(target, contents)
}
