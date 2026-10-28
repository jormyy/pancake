import { analyzeDynastyTrade as analyzeImportedTrade, valueDynastyAsset as valueImportedAsset, TRADE_FORMULA_VERSION } from './tradeScoring'
import type { ScoringSettings, StatLine } from '../scoring/types'

export type DynastyStrategy = 'overall' | 'contend' | 'rebuild'

export const DYNASTY_TRADE_MODEL_VERSION = TRADE_FORMULA_VERSION
export const analyzeDynastyTrade = analyzeImportedTrade

export const DYNASTY_STRATEGIES: DynastyStrategy[] = ['overall', 'contend', 'rebuild']

export type DynastySource = {
    name: string
    fetchedAt: string | null
}

type AssetBase = {
    id: string
    label: string
    sources?: DynastySource[]
    tradeValue?: number | null
}

export type DynastyPlayerAsset = AssetBase & {
    kind: 'player'
    age: number | null
    dynastyRank: number | null
    marketRanks?: Partial<Record<DynastyStrategy, number | null>>
    rankMovement: number | null
    healthStatus: string | null
    productionStats?: StatLine | null
    projectionStats?: StatLine | null
    productionFantasyPoints?: number | null
    projectionFantasyPoints?: number | null
    isRookie?: boolean
}

export type DynastyPickAsset = AssetBase & {
    kind: 'pick'
    seasonYear: number
    round: number
    slot: number | null
    teams: number
    valueBands?: { early: number; mid: number; late: number } | null
}

export type DynastyFaabAsset = AssetBase & {
    kind: 'faab'
    amount: number
    budget: number
    freeAgentQuality: number
}

export type DynastyRosterSlotAsset = AssetBase & {
    kind: 'rosterSlot'
    count: number
    replacementValue: number
}

export type DynastyAsset = DynastyPlayerAsset | DynastyPickAsset | DynastyFaabAsset | DynastyRosterSlotAsset

export type DynastyEngineContext = {
    leagueId: string
    seasonYear: number
    scoringSettings: ScoringSettings
    replacementValue?: number
}

export type DynastyValueRange = {
    low: number
    high: number
}

export type DynastyAssetComponents = {
    production: number
    projection: number
    market: number
    age: number
    healthMultiplier: number
    movementMultiplier: number
    replacement: number
    rosterSlot: number
    package: number
    shortTermPoints: number
    longTermValue: number
}

export type DynastyAssetResult = {
    assetId: string
    kind: DynastyAsset['kind']
    label: string
    values: Record<DynastyStrategy, number>
    ranges: Partial<Record<DynastyStrategy, DynastyValueRange>>
    components: DynastyAssetComponents
    sources: DynastySource[]
    confidence: number
    missingInputs: string[]
    assumptions: string[]
}

export type DynastyTradeRoute = {
    fromMemberId: string
    toMemberId: string
    asset: DynastyAsset
}

export type DynastyTradeTeamResult = {
    memberId: string
    valuesSent: number
    valuesReceived: number
    shortTermPoints: number
    longTermValue: number
    packageEffect: number
    replacementEffect: number
    rosterSlotEffect: number
    impact: number
}

export type DynastyTradeAnalysis = {
    strategy: DynastyStrategy
    teams: DynastyTradeTeamResult[]
    assets: DynastyAssetResult[]
    sources: DynastySource[]
    confidence: number
    missingInputs: string[]
    assumptions: string[]
}

export const valueDynastyAsset = valueImportedAsset

export function valueDynastyAssets(context: DynastyEngineContext, assets: DynastyAsset[]): DynastyAssetResult[] {
    return assets.map((asset) => valueDynastyAsset(context, asset))
}
