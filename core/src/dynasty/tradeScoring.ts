import type { DynastyAsset, DynastyAssetResult, DynastyEngineContext, DynastyStrategy, DynastyTradeAnalysis, DynastyTradeRoute } from './decisionEngine'

export const TRADE_FORMULA_VERSION = 'onenumber-trade-v1'
const TRADE_SCORING = {
  fairnessTolerance: 0.05,
  consolidationPerPiece: 0.15,
  consolidationPieceLimit: 3,
  closeTopTolerance: 0.10,
  strongThirdMinimum: 0.50,
  thirdPieceCredit: 0.25,
  faabBase: 45,
  faabQuality: 105,
} as const

const validValue = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const decimal = (value: number) => Number(value.toFixed(6))
const sum = (values: number[]) => decimal(values.reduce((total, value) => total + value, 0))

export function scoreTradeSides(sent: number[], received: number[]) {
  const left = sent.filter(value => validValue(value) && value > 0).sort((a, b) => b - a)
  const right = received.filter(value => validValue(value) && value > 0).sort((a, b) => b - a)
  const best = Math.max(left[0] ?? 0, right[0] ?? 0)
  let sentBonus = 0
  let receivedBonus = 0
  if (left.length < right.length && (left[0] ?? 0) > (right[0] ?? 0)) {
    sentBonus = best * TRADE_SCORING.consolidationPerPiece * Math.min(TRADE_SCORING.consolidationPieceLimit, right.length - left.length)
  }
  if (right.length < left.length && (right[0] ?? 0) > (left[0] ?? 0)) {
    receivedBonus = best * TRADE_SCORING.consolidationPerPiece * Math.min(TRADE_SCORING.consolidationPieceLimit, left.length - right.length)
  }
  if (best > 0 && Math.abs((left[0] ?? 0) - (right[0] ?? 0)) <= best * TRADE_SCORING.closeTopTolerance) {
    const third = Math.max(left[1] ?? 0, right[1] ?? 0)
    if (third >= best * TRADE_SCORING.strongThirdMinimum) {
      if ((left[1] ?? 0) > (right[1] ?? 0)) sentBonus += third * TRADE_SCORING.thirdPieceCredit
      if ((right[1] ?? 0) > (left[1] ?? 0)) receivedBonus += third * TRADE_SCORING.thirdPieceCredit
    }
  }
  const valuesSent = sum(left)
  const valuesReceived = sum(right)
  const adjustedSent = decimal(valuesSent + sentBonus)
  const adjustedReceived = decimal(valuesReceived + receivedBonus)
  const difference = decimal(Math.abs(adjustedSent - adjustedReceived))
  const fair = difference <= decimal(Math.max(adjustedSent, adjustedReceived) * TRADE_SCORING.fairnessTolerance)
  return { valuesSent, valuesReceived, packageEffect: decimal(receivedBonus - sentBonus), fair,
    impact: fair ? 0 : decimal(adjustedReceived - adjustedSent) }
}

export function valueDynastyAsset(_context: DynastyEngineContext, asset: DynastyAsset): DynastyAssetResult {
  let value = 0
  let missing: string[] = []
  let assumptions: string[] = []
  const ranges: DynastyAssetResult['ranges'] = {}
  if (asset.kind === 'player') {
    if (validValue(asset.tradeValue) && asset.tradeValue <= 1000) value = asset.tradeValue
    else missing = ['imported player value']
  } else if (asset.kind === 'pick') {
    const bands = asset.valueBands
    if (bands && Object.values(bands).every(value => validValue(value) && value <= 1000)) {
      const known = asset.slot != null && asset.slot >= 1 && asset.slot <= asset.teams
      value = !known ? bands.mid : asset.slot! <= Math.ceil(asset.teams / 3) ? bands.early
        : asset.slot! <= Math.ceil(asset.teams * 2 / 3) ? bands.mid : bands.late
      if (!known) {
        missing = ['pick slot']
        for (const strategy of ['overall', 'contend', 'rebuild'] as const) ranges[strategy] = { low: bands.late, high: bands.early }
      }
    } else missing = ['imported pick value']
  } else if (asset.kind === 'faab') {
    if (Number.isFinite(asset.budget) && asset.budget > 0) {
      const quality = Number.isFinite(asset.freeAgentQuality) ? Math.min(1, Math.max(0, asset.freeAgentQuality)) : 0.5
      value = Math.round(Math.max(0, asset.amount) / asset.budget * (TRADE_SCORING.faabBase + quality * TRADE_SCORING.faabQuality))
    } else missing = ['FAAB budget']
    assumptions = ['FAAB uses amount / budget × (45 + 105 × free-agent quality); a missing budget gives zero value.']
  }
  if (missing.some(name => name.startsWith('imported'))) assumptions.push('Assets without imported values contribute zero; no age, health, rank, or scoring formula replaces them.')
  const values = { overall: value, contend: value, rebuild: value }
  return {
    assetId: asset.id, kind: asset.kind, label: asset.label, values, ranges,
    components: { production: 0, projection: 0, market: value, age: 0, healthMultiplier: 1, movementMultiplier: 1,
      replacement: 0, rosterSlot: 0, package: 0,
      shortTermPoints: asset.kind === 'player' ? asset.productionFantasyPoints ?? asset.projectionFantasyPoints ?? 0 : 0,
      longTermValue: value },
    sources: asset.sources ?? [], confidence: missing.length ? 0.5 : 1, missingInputs: missing, assumptions,
  }
}

export function analyzeDynastyTrade(context: DynastyEngineContext, strategy: DynastyStrategy, routes: DynastyTradeRoute[]): DynastyTradeAnalysis {
  const seen = new Set<string>()
  for (const route of routes) {
    if (!route.fromMemberId || !route.toMemberId || route.fromMemberId === route.toMemberId) throw new Error('Each asset must move between two different teams.')
    const identity = `${route.asset.kind}:${route.asset.id}`
    if (!route.asset.id || seen.has(identity)) throw new Error('Each trade asset must appear exactly once.')
    seen.add(identity)
  }
  const assets = routes.map(route => valueDynastyAsset(context, route.asset))
  const teams = [...new Set(routes.flatMap(route => [route.fromMemberId, route.toMemberId]))].sort().map(memberId => {
    const sent = assets.filter((_, index) => routes[index].fromMemberId === memberId)
    const received = assets.filter((_, index) => routes[index].toMemberId === memberId)
    const score = scoreTradeSides(sent.map(asset => asset.values.overall), received.map(asset => asset.values.overall))
    return { memberId, valuesSent: score.valuesSent, valuesReceived: score.valuesReceived,
      shortTermPoints: decimal(sum(received.map(asset => asset.components.shortTermPoints)) - sum(sent.map(asset => asset.components.shortTermPoints))),
      longTermValue: decimal(score.valuesReceived - score.valuesSent), packageEffect: score.packageEffect,
      replacementEffect: 0, rosterSlotEffect: 0, impact: score.impact }
  })
  return {
    strategy, teams, assets,
    sources: [...new Map(assets.flatMap(asset => asset.sources).map(source => [`${source.name}:${source.fetchedAt}`, source])).values()],
    confidence: assets.length ? decimal(sum(assets.map(asset => asset.confidence)) / assets.length) : 0,
    missingInputs: [...new Set(assets.flatMap(asset => asset.missingInputs))],
    assumptions: [...new Set(assets.flatMap(asset => asset.assumptions)),
      'Totals sum imported values. Package effects include consolidation and strong-third-piece credit.',
      'Impact is zero when adjusted totals differ by at most 5% of the larger total.'],
  }
}
