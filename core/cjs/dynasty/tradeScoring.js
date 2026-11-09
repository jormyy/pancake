"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRADE_FORMULA_VERSION = void 0;
exports.curveTradeValue = curveTradeValue;
exports.compareTradeTotals = compareTradeTotals;
exports.scoreTradeSides = scoreTradeSides;
exports.valueDynastyAsset = valueDynastyAsset;
exports.analyzeDynastyTrade = analyzeDynastyTrade;
exports.TRADE_FORMULA_VERSION = 'onenumber-trade-curve-v6';
const TRADE_SCORING = {
    exponent: 5,
    fairnessTolerance: 0.05,
    faabBase: 45,
    faabQuality: 105,
};
const validValue = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const decimal = (value) => Number(value.toFixed(6));
const sum = (values) => decimal(values.reduce((total, value) => total + value, 0));
function curveTradeValue(value) {
    return validValue(value) && value <= 1000 ? 1000 * (value / 1000) ** TRADE_SCORING.exponent : 0;
}
function compareTradeTotals(totals) {
    const largest = Math.max(0, ...totals.map(Math.abs));
    const gap = totals.length ? Math.max(...totals) - Math.min(...totals) : 0;
    const gapPercent = largest ? gap / largest * 100 : 0;
    return { gapPercent, fair: gapPercent <= TRADE_SCORING.fairnessTolerance * 100 + 1e-9 };
}
function scoreTradeSides(sent, received, rosterSlotEffect = 0, sentFaab = 0, receivedFaab = 0) {
    const valuesSent = sum([...sent.map(curveTradeValue), sentFaab]);
    const valuesReceived = sum([...received.map(curveTradeValue), receivedFaab]);
    const adjustedReceived = decimal(valuesReceived + rosterSlotEffect);
    const netValue = decimal(adjustedReceived - valuesSent);
    const comparison = compareTradeTotals([valuesSent, adjustedReceived]);
    return { valuesSent, valuesReceived, adjustedReceived, netValue, packageEffect: 0, ...comparison,
        impact: comparison.fair ? 0 : netValue };
}
function valueDynastyAsset(_context, asset) {
    let value = 0;
    let missing = [];
    let assumptions = [];
    const ranges = {};
    if (asset.kind === 'player') {
        if (validValue(asset.tradeValue) && asset.tradeValue <= 1000)
            value = asset.tradeValue;
        else
            missing = ['imported player value'];
    }
    else if (asset.kind === 'pick') {
        const bands = asset.valueBands;
        if (bands && Object.values(bands).every(value => validValue(value) && value <= 1000)) {
            const known = asset.slot != null && asset.slot >= 1 && asset.slot <= asset.teams;
            value = !known ? bands.mid : asset.slot <= Math.ceil(asset.teams / 3) ? bands.early
                : asset.slot <= Math.ceil(asset.teams * 2 / 3) ? bands.mid : bands.late;
            if (!known) {
                missing = ['pick slot'];
                for (const strategy of ['overall', 'contend', 'rebuild'])
                    ranges[strategy] = { low: bands.late, high: bands.early };
            }
        }
        else
            missing = ['imported pick value'];
    }
    else if (asset.kind === 'faab') {
        if (Number.isFinite(asset.budget) && asset.budget > 0) {
            const quality = Number.isFinite(asset.freeAgentQuality) ? Math.min(1, Math.max(0, asset.freeAgentQuality)) : 0.5;
            value = Math.round(Math.max(0, asset.amount) / asset.budget * (TRADE_SCORING.faabBase + quality * TRADE_SCORING.faabQuality));
        }
        else
            missing = ['FAAB budget'];
        assumptions = ['FAAB uses amount / budget × (45 + 105 × free-agent quality); a missing budget gives zero value.'];
    }
    if (missing.some(name => name.startsWith('imported')))
        assumptions.push('Assets without imported values contribute zero; no age, health, rank, or scoring formula replaces them.');
    const values = { overall: value, contend: value, rebuild: value };
    return {
        assetId: asset.id, kind: asset.kind, label: asset.label, values, ranges,
        components: { production: 0, projection: 0, market: value, age: 0, healthMultiplier: 1, movementMultiplier: 1,
            replacement: 0, rosterSlot: 0, package: 0,
            shortTermPoints: asset.kind === 'player' ? asset.productionFantasyPoints ?? asset.projectionFantasyPoints ?? 0 : 0,
            longTermValue: value },
        sources: asset.sources ?? [], confidence: missing.length ? 0.5 : 1, missingInputs: missing, assumptions,
    };
}
function analyzeDynastyTrade(context, strategy, routes) {
    const seen = new Set();
    for (const route of routes) {
        if (!route.fromMemberId || !route.toMemberId || route.fromMemberId === route.toMemberId)
            throw new Error('Each asset must move between two different teams.');
        const identity = `${route.asset.kind}:${route.asset.id}`;
        if (!route.asset.id || seen.has(identity))
            throw new Error('Each trade asset must appear exactly once.');
        seen.add(identity);
    }
    const assets = routes.map(route => valueDynastyAsset(context, route.asset));
    const teams = [...new Set(routes.flatMap(route => [route.fromMemberId, route.toMemberId]))].sort().map(memberId => {
        const sent = assets.filter((_, index) => routes[index].fromMemberId === memberId);
        const received = assets.filter((_, index) => routes[index].toMemberId === memberId);
        const roster = context.rosters?.find(team => team.memberId === memberId);
        let openRosterSpots = 0;
        let cutValue = 0;
        if (roster) {
            const after = roster.players.filter(player => !routes.some(route => route.fromMemberId === memberId && route.asset.kind === 'player' && route.asset.id === player.playerId));
            for (const route of routes.filter(route => route.toMemberId === memberId && route.asset.kind === 'player')) {
                const original = context.rosters?.flatMap(team => team.players).find(player => player.playerId === route.asset.id);
                after.push({ playerId: route.asset.id, tradeValue: valueDynastyAsset(context, route.asset).values.overall,
                    location: original?.location === 'taxi' ? 'taxi' : route.destination ?? 'active' });
            }
            for (const location of ['active', 'ir', 'taxi']) {
                const values = after.filter(player => player.location === location).map(player => curveTradeValue(player.tradeValue ?? 0)).sort((a, b) => a - b);
                cutValue += sum(values.slice(0, Math.max(0, values.length - roster.limits[location])));
                if (location === 'active')
                    openRosterSpots = Math.max(0, roster.limits.active - values.length);
            }
        }
        const rosterSlotEffect = decimal(-cutValue);
        const score = scoreTradeSides(sent.filter(asset => asset.kind !== 'faab').map(asset => asset.values.overall), received.filter(asset => asset.kind !== 'faab').map(asset => asset.values.overall), rosterSlotEffect, sum(sent.filter(asset => asset.kind === 'faab').map(asset => asset.values.overall)), sum(received.filter(asset => asset.kind === 'faab').map(asset => asset.values.overall)));
        return { memberId, valuesSent: score.valuesSent, valuesReceived: score.valuesReceived,
            shortTermPoints: decimal(sum(received.map(asset => asset.components.shortTermPoints)) - sum(sent.map(asset => asset.components.shortTermPoints))),
            longTermValue: decimal(score.valuesReceived - score.valuesSent), packageEffect: score.packageEffect,
            replacementEffect: 0, rosterSlotEffect, netValue: score.netValue, adjustedValue: score.adjustedReceived,
            openRosterSpots, rosterCutValue: cutValue, gapPercent: score.gapPercent, fair: score.fair, impact: score.impact };
    });
    if (teams.length === 2) {
        const comparison = compareTradeTotals(teams.map(team => team.adjustedValue));
        for (const team of teams)
            Object.assign(team, comparison, { impact: comparison.fair ? 0 : team.netValue });
    }
    return {
        strategy, teams, assets,
        sources: [...new Map(assets.flatMap(asset => asset.sources).map(source => [`${source.name}:${source.fetchedAt}`, source])).values()],
        confidence: assets.length ? decimal(sum(assets.map(asset => asset.confidence)) / assets.length) : 0,
        missingInputs: [...new Set(assets.flatMap(asset => asset.missingInputs))],
        assumptions: [...new Set(assets.flatMap(asset => asset.assumptions)),
            `Player and pick totals use 1000 × (source value / 1000)^${TRADE_SCORING.exponent}. FAAB retains its existing value.`,
            'Open roster spots add no value; excess players cost their lowest curved values.',
            `Fair means the adjusted package totals differ by at most ${TRADE_SCORING.fairnessTolerance * 100}% of the larger total.`],
    };
}
