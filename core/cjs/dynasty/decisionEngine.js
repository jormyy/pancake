"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DYNASTY_STRATEGY_WEIGHTS = exports.DYNASTY_STRATEGIES = void 0;
exports.valueDynastyAsset = valueDynastyAsset;
exports.valueDynastyAssets = valueDynastyAssets;
exports.analyzeDynastyTrade = analyzeDynastyTrade;
const formula_1 = require("../scoring/formula");
exports.DYNASTY_STRATEGIES = ['overall', 'contend', 'rebuild'];
exports.DYNASTY_STRATEGY_WEIGHTS = {
    overall: { production: 0.35, projection: 0.25, market: 0.25, age: 0.15 },
    contend: { production: 0.50, projection: 0.30, market: 0.15, age: 0.05 },
    rebuild: { production: 0.20, projection: 0.20, market: 0.30, age: 0.30 },
};
const EMPTY_COMPONENTS = {
    production: 0,
    projection: 0,
    market: 0,
    age: 0,
    healthMultiplier: 1,
    movementMultiplier: 1,
    replacement: 0,
    rosterSlot: 0,
    package: 0,
    shortTermPoints: 0,
    longTermValue: 0,
};
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value) => Math.round(value);
const roundOne = (value) => Math.round(value * 10) / 10;
function normalizedAge(age) {
    if (!finite(age))
        return 0.5;
    if (age <= 19)
        return 0.90;
    if (age <= 22)
        return 1 - Math.abs(22 - age) * 0.03;
    return clamp(1 - (age - 22) * 0.075, 0.08, 1);
}
function normalizedRank(rank) {
    if (!finite(rank) || rank < 1)
        return 0.45;
    return clamp(1 - (rank - 1) / 499, 0.02, 1);
}
function healthMultiplier(status) {
    const value = status?.trim().toUpperCase() ?? '';
    if (!value || value === 'ACTIVE' || value === 'HEALTHY')
        return 1;
    if (value.includes('OUT') || value === 'O')
        return 0.88;
    if (value.includes('IR'))
        return 0.90;
    if (value.includes('DOUBTFUL') || value === 'D')
        return 0.92;
    if (value.includes('QUESTIONABLE') || value.includes('DAY') || value === 'Q')
        return 0.96;
    return 0.98;
}
function movementMultiplier(movement) {
    if (!finite(movement))
        return 1;
    return 1 + clamp(movement / 100, -0.04, 0.04);
}
function fantasyPoints(stats, direct, settings) {
    if (stats)
        return (0, formula_1.calculateFantasyPoints)(stats, settings);
    return finite(direct) ? direct : null;
}
function valuePlayer(context, asset) {
    const productionPoints = fantasyPoints(asset.productionStats, asset.productionFantasyPoints, context.scoringSettings);
    const projectionPoints = fantasyPoints(asset.projectionStats, asset.projectionFantasyPoints, context.scoringSettings);
    const production = finite(productionPoints) ? clamp(productionPoints / 65, 0, 1.15) : 0.45;
    const projection = finite(projectionPoints) ? clamp(projectionPoints / 65, 0, 1.15) : production;
    const market = normalizedRank(asset.dynastyRank);
    const age = normalizedAge(asset.age);
    const health = healthMultiplier(asset.healthStatus);
    const movement = movementMultiplier(asset.rankMovement);
    const replacementValue = clamp(context.replacementValue ?? 180, 0, 500);
    const values = Object.fromEntries(exports.DYNASTY_STRATEGIES.map((strategy) => {
        const weights = exports.DYNASTY_STRATEGY_WEIGHTS[strategy];
        const raw = 1000 * (production * weights.production +
            projection * weights.projection +
            market * weights.market +
            age * weights.age);
        return [strategy, round(clamp(raw * health * movement, 0, 1000))];
    }));
    const missingInputs = [
        !finite(productionPoints) ? 'current production' : null,
        !finite(projectionPoints) ? 'projection' : null,
        !finite(asset.dynastyRank) ? 'dynasty rank' : null,
        !finite(asset.age) ? 'age' : null,
    ].filter((value) => value != null);
    const confidence = clamp(1 - missingInputs.length * 0.13 - (asset.sources?.some((source) => !source.fetchedAt) ? 0.05 : 0), 0.35, 1);
    return {
        assetId: asset.id,
        kind: asset.kind,
        label: asset.label,
        values,
        ranges: {},
        components: {
            production: round(production * 1000),
            projection: round(projection * 1000),
            market: round(market * 1000),
            age: round(age * 1000),
            healthMultiplier: health,
            movementMultiplier: movement,
            replacement: Math.max(0, values.overall - replacementValue),
            rosterSlot: 0,
            package: 0,
            shortTermPoints: roundOne(productionPoints ?? projectionPoints ?? 0),
            longTermValue: values.rebuild,
        },
        sources: asset.sources ?? [],
        confidence: roundOne(confidence),
        missingInputs,
        assumptions: [
            'Current production and projection use the active league scoring settings.',
            'Health changes value by no more than 12%.',
            'Rank movement changes value by no more than 4%.',
        ],
    };
}
const PICK_BASE = [0, 680, 420, 250, 140];
function pickSlotMultiplier(slot, teams) {
    const boundedTeams = clamp(Math.trunc(teams), 4, 30);
    const boundedSlot = clamp(Math.trunc(slot), 1, boundedTeams);
    const progress = (boundedSlot - 1) / Math.max(1, boundedTeams - 1);
    return 1.30 - progress * 0.58;
}
function pickValue(asset, strategy, context, slot) {
    const roundIndex = clamp(Math.trunc(asset.round), 1, 4);
    const base = PICK_BASE[roundIndex];
    const distance = Math.max(0, Math.trunc(asset.seasonYear - context.seasonYear));
    const decay = strategy === 'contend' ? 0.84 : strategy === 'rebuild' ? 0.95 : 0.90;
    const strategyFactor = strategy === 'contend' ? 0.88 : strategy === 'rebuild' ? 1.08 : 1;
    return round(clamp(base * Math.pow(decay, distance) * pickSlotMultiplier(slot, asset.teams) * strategyFactor, 0, 1000));
}
function valuePick(context, asset) {
    const teams = clamp(Math.trunc(asset.teams), 4, 30);
    const knownSlot = finite(asset.slot) && asset.slot >= 1 && asset.slot <= teams ? Math.trunc(asset.slot) : null;
    const values = {};
    const ranges = {};
    for (const strategy of exports.DYNASTY_STRATEGIES) {
        if (knownSlot != null) {
            values[strategy] = pickValue(asset, strategy, context, knownSlot);
        }
        else {
            const early = pickValue(asset, strategy, context, 1);
            const late = pickValue(asset, strategy, context, teams);
            ranges[strategy] = { low: Math.min(early, late), high: Math.max(early, late) };
            values[strategy] = round((early + late) / 2);
        }
    }
    const distance = Math.max(0, asset.seasonYear - context.seasonYear);
    const confidence = clamp(0.94 - distance * 0.06 - (knownSlot == null ? 0.16 : 0), 0.45, 0.94);
    return {
        assetId: asset.id,
        kind: asset.kind,
        label: asset.label,
        values,
        ranges,
        components: {
            ...EMPTY_COMPONENTS,
            projection: values.contend,
            age: values.rebuild,
            shortTermPoints: 0,
            longTermValue: values.rebuild,
        },
        sources: asset.sources ?? [],
        confidence: roundOne(confidence),
        missingInputs: knownSlot == null ? ['pick slot'] : [],
        assumptions: [
            `Pick value decays from season ${context.seasonYear}.`,
            knownSlot == null ? `The range uses slots 1 through ${teams}.` : `The value uses known slot ${knownSlot}.`,
        ],
    };
}
function valueFaab(asset) {
    const budget = finite(asset.budget) && asset.budget > 0 ? asset.budget : 100;
    const amount = clamp(finite(asset.amount) ? asset.amount : 0, 0, budget);
    const quality = clamp(finite(asset.freeAgentQuality) ? asset.freeAgentQuality : 0.5, 0, 1);
    const overall = round((amount / budget) * (45 + quality * 105));
    const values = {
        overall,
        contend: round(overall * 1.15),
        rebuild: round(overall * 0.85),
    };
    return {
        assetId: asset.id,
        kind: asset.kind,
        label: asset.label,
        values,
        ranges: {},
        components: { ...EMPTY_COMPONENTS, production: values.contend, longTermValue: values.rebuild },
        sources: asset.sources ?? [],
        confidence: asset.budget > 0 ? 0.9 : 0.65,
        missingInputs: asset.budget > 0 ? [] : ['FAAB budget'],
        assumptions: ['FAAB value scales with league budget and available free-agent quality.'],
    };
}
function valueRosterSlot(asset) {
    const slotValue = round(clamp(asset.replacementValue, 0, 500) * asset.count * 0.18);
    const values = { overall: slotValue, contend: round(slotValue * 1.1), rebuild: round(slotValue * 0.9) };
    return {
        assetId: asset.id,
        kind: asset.kind,
        label: asset.label,
        values,
        ranges: {},
        components: { ...EMPTY_COMPONENTS, rosterSlot: slotValue, longTermValue: values.rebuild },
        sources: asset.sources ?? [],
        confidence: 0.85,
        missingInputs: [],
        assumptions: ['A roster slot uses 18% of the league replacement value.'],
    };
}
function valueDynastyAsset(context, asset) {
    if (asset.kind === 'player')
        return valuePlayer(context, asset);
    if (asset.kind === 'pick')
        return valuePick(context, asset);
    if (asset.kind === 'faab')
        return valueFaab(asset);
    return valueRosterSlot(asset);
}
function valueDynastyAssets(context, assets) {
    return assets.map((asset) => valueDynastyAsset(context, asset));
}
function packagePenalty(values) {
    const positive = values.filter((value) => value > 0).sort((left, right) => right - left);
    if (positive.length < 2)
        return 0;
    const strongest = positive[0];
    const weakTotal = positive.slice(1).reduce((total, value) => total + value, 0);
    return round(Math.max(0, weakTotal - strongest * 0.6) * 0.25);
}
function uniqueSources(results) {
    const map = new Map();
    for (const result of results) {
        for (const source of result.sources)
            map.set(`${source.name}:${source.fetchedAt ?? ''}`, source);
    }
    return [...map.values()];
}
function analyzeDynastyTrade(context, strategy, routes) {
    const results = routes.map((route) => valueDynastyAsset(context, route.asset));
    const memberIds = [...new Set(routes.flatMap((route) => [route.fromMemberId, route.toMemberId]))].sort();
    const replacementValue = clamp(context.replacementValue ?? 180, 0, 500);
    const teams = memberIds.map((memberId) => {
        const sentIndexes = routes.flatMap((route, index) => route.fromMemberId === memberId ? [index] : []);
        const receivedIndexes = routes.flatMap((route, index) => route.toMemberId === memberId ? [index] : []);
        const sentValues = sentIndexes.map((index) => results[index].values[strategy]);
        const receivedValues = receivedIndexes.map((index) => results[index].values[strategy]);
        const sentPenalty = packagePenalty(sentValues);
        const receivedPenalty = packagePenalty(receivedValues);
        const valuesSent = Math.max(0, sentValues.reduce((total, value) => total + Math.max(0, value), 0) - sentPenalty);
        const valuesReceived = Math.max(0, receivedValues.reduce((total, value) => total + Math.max(0, value), 0) - receivedPenalty);
        const sentPlayers = sentIndexes.filter((index) => routes[index].asset.kind === 'player').length;
        const receivedPlayers = receivedIndexes.filter((index) => routes[index].asset.kind === 'player').length;
        const slotDelta = sentPlayers - receivedPlayers;
        const rosterSlotEffect = round(slotDelta * replacementValue * 0.18);
        const replacementEffect = slotDelta > 0 ? round(slotDelta * replacementValue * 0.08) : 0;
        const shortTermPoints = roundOne(receivedIndexes.reduce((total, index) => total + results[index].components.shortTermPoints, 0) -
            sentIndexes.reduce((total, index) => total + results[index].components.shortTermPoints, 0));
        const longTermValue = round(receivedIndexes.reduce((total, index) => total + results[index].components.longTermValue, 0) -
            sentIndexes.reduce((total, index) => total + results[index].components.longTermValue, 0));
        return {
            memberId,
            valuesSent,
            valuesReceived,
            shortTermPoints,
            longTermValue,
            packageEffect: sentPenalty - receivedPenalty,
            replacementEffect,
            rosterSlotEffect,
            impact: round(valuesReceived - valuesSent + rosterSlotEffect + replacementEffect),
        };
    });
    const confidence = results.length === 0
        ? 0
        : roundOne(results.reduce((total, result) => total + result.confidence, 0) / results.length);
    return {
        strategy,
        teams,
        assets: results,
        sources: uniqueSources(results),
        confidence,
        missingInputs: [...new Set(results.flatMap((result) => result.missingInputs))],
        assumptions: [...new Set(results.flatMap((result) => result.assumptions))],
    };
}
