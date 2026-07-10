/** @param {string} output */
const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  if (!line) throw new Error('Browser performance evaluation returned no output')
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

const readyPredicates = {
  'home-live-lineup': `body.includes('Lineup') && document.querySelector('[aria-current="date"]') && !body.includes('Matchup lineup loading')`,
  'lineup-day-change': `body.includes('Lineup') && document.querySelector('[aria-label="Starters"]') && !body.includes('Loading lineup') && !body.includes('Refreshing lineup')`,
  'player-search-filter': `document.querySelector('input[placeholder="Search players..."]') && /\\d+(?: filtered)? players?/.test(body)`,
  'player-detail-open': `location.pathname.startsWith('/player/') && !body.includes('Player not found') && (body.includes('Averages') || body.includes('Game Log'))`,
  'roster-review-manage': `document.querySelector('[aria-label="Set lineup"]') && !body.includes('Loading roster')`,
  'waiver-add-claim': `body.includes('Waiver Claim') && document.querySelector('[aria-label="Submit waiver claim"]') && !body.includes('Loading')`,
  'trade-review-act': `label === 'propose-trade'
    ? document.querySelector('[aria-label="Send trade proposal"]') && !body.includes('Loading trade assets')
    : document.querySelector('[role="heading"][aria-level="1"]')?.textContent?.trim() === 'Trades' && document.querySelector('[role="tablist"]') && !body.includes('Loading trades')`,
  'auction-draft-room': `body.includes('Auction Draft') && (document.querySelector('[aria-label="Increase bid"]') || document.querySelector('[aria-label="Search and nominate a player"]') || document.querySelector('[aria-label="Pause draft"]') || (label === 'draft-room-initial' && document.querySelector('[aria-label="Resume draft"]')))`,
  'rookie-draft-room': `document.querySelector('[aria-label="Show prospects"]') && document.querySelector('[aria-label="Show pick board"]') && !body.includes('Loading prospects')`,
  'dynasty-hub': `document.querySelector('[role="heading"][aria-level="1"]')?.textContent?.trim() === 'Dynasty Hub' && /\\d+ rows? loaded/.test(body)`,
}
export const WORKFLOW_READY_IDS = Object.freeze(Object.keys(readyPredicates))
export const WORKFLOW_FEEDBACK_IDS = Object.freeze([
  'home-live-lineup',
  'lineup-day-change',
  'player-search-filter',
  'player-detail-open',
  'roster-review-manage',
  'waiver-add-claim',
  'trade-review-act',
  'auction-draft-room',
  'rookie-draft-room',
  'dynasty-hub',
])

const worstCaseMeasurementKeys = [
  'feedbackMs',
  'coldFullLoadMs',
  'cachedRequestMs',
  'fullLoadMs',
  'initialWebJsKb',
]

const routeEvidenceKeys = [
  'routeWebJsKb',
  'routeJsEncodedKb',
  'routeJsDecodedKb',
  'routeJsLedger',
  'routeJsEntryCount',
  'routeJsNetworkEntryCount',
  'routeJsCacheHit',
]

export const recordWorkflowMeasurement = (measurements, next) => {
  const existing = measurements.find((measurement) => measurement.id === next.id)
  if (!existing) {
    measurements.push({
      ...next,
      ...(Number.isFinite(next.routeJsEncodedKb) ? { routeEvidenceRoute: next.route } : {}),
    })
    return
  }
  const replaceRouteEvidence = Number.isFinite(next.routeJsEncodedKb) && (
    !Number.isFinite(existing.routeJsEncodedKb) || next.routeJsEncodedKb > existing.routeJsEncodedKb
  )
  for (const key of worstCaseMeasurementKeys) {
    if (Number.isFinite(next[key])) existing[key] = Math.max(Number(existing[key] ?? 0), next[key])
  }
  const existingTimedRequest = Number.isInteger(existing.warmRequestCount) && existing.warmRequestCount > 0 &&
    Number.isFinite(existing.warmCachedRequestMs)
  const nextTimedRequest = Number.isInteger(next.warmRequestCount) && next.warmRequestCount > 0 &&
    Number.isFinite(next.warmCachedRequestMs)
  if (nextTimedRequest && (!existingTimedRequest || next.warmCachedRequestMs > existing.warmCachedRequestMs)) {
    existing.warmCachedRequestMs = next.warmCachedRequestMs
    existing.warmRequestCount = next.warmRequestCount
    existing.warmRequestEvidence = next.warmRequestEvidence
  }
  if (replaceRouteEvidence) {
    for (const key of routeEvidenceKeys) existing[key] = next[key]
    existing.routeEvidenceRoute = next.route
  }
  existing.feedbackObserved = existing.feedbackObserved === true && next.feedbackObserved === true
  existing.feedbackInteraction = `${existing.feedbackInteraction},${next.feedbackInteraction}`
  existing.routes = [...new Set([...(existing.routes ?? [existing.route]), next.route])]
}

export const combineNavigationPhases = (cold, warm) => ({
  ...warm,
  coldFullLoadMs: cold?.fullLoadMs,
  warmCachedRequestMs: warm?.cachedRequestMs,
  warmRequestCount: warm?.requestCount,
  warmRequestEvidence: warm?.requestEvidence,
  fullLoadMs: cold?.fullLoadMs,
  cachedRequestMs: warm?.cachedRequestMs,
})

export const hasRequestTimingEvidence = (timing) => (
  Number.isInteger(timing?.requestCount) && timing.requestCount > 0 &&
    Number.isFinite(timing.cachedRequestMs) && timing.cachedRequestMs >= 0
) || (
  timing?.requestCount === 0 && timing.cachedRequestMs == null &&
    timing.requestEvidence === 'no-fetch-or-xhr-observed'
)

const browserJson = async (browser, session, source) => parseEvalJson(await browser(session, ['eval', source]))

export const summarizeJavaScriptDelivery = (resources, sharedScriptUrls = []) => {
  const scripts = resources.filter((entry) =>
    entry.initiatorType === 'script' || /(?:^|\/)index(?:[.-][^/?]+)?\.js(?:$|[?#])/.test(entry.name));
  const entries = scripts.map((entry) => {
    const name = new URL(entry.name).pathname.split('/').at(-1) || entry.name;
    return {
      url: entry.name,
      name,
      initiator: entry.initiatorType,
      transferSize: Math.round(entry.transferSize || 0),
      encodedBodySize: Math.round(entry.encodedBodySize || 0),
      decodedBodySize: Math.round(entry.decodedBodySize || 0),
    };
  });
  const shared = new Set(sharedScriptUrls);
  const networkEntries = entries.filter((entry) => entry.transferSize > 0 && entry.encodedBodySize > 0);
  const routeEntries = entries.filter((entry) => !shared.has(entry.url));
  const routeNetworkEntries = routeEntries.filter((entry) => entry.transferSize > 0 && entry.encodedBodySize > 0);
  const routeCacheHit = routeEntries.length > 0 && routeNetworkEntries.length === 0
    && routeEntries.every((entry) => entry.transferSize === 0 && entry.decodedBodySize > 0);
  const kb = (bytes) => Math.round(bytes / 1024 * 10) / 10;
  return {
    scriptCount: entries.length,
    scriptUrls: entries.map((entry) => entry.url),
    scriptEntries: entries,
    networkEntryCount: networkEntries.length,
    webJsEncodedKb: kb(networkEntries.reduce((sum, entry) => sum + entry.encodedBodySize, 0)),
    webJsWireKb: kb(networkEntries.reduce((sum, entry) => sum + entry.transferSize, 0)),
    webJsTransferKb: kb(routeNetworkEntries.reduce((sum, entry) => sum + entry.encodedBodySize, 0)),
    routeJsWireKb: kb(routeNetworkEntries.reduce((sum, entry) => sum + entry.transferSize, 0)),
    routeJsEncodedKb: kb(routeEntries.reduce((sum, entry) => sum + entry.encodedBodySize, 0)),
    routeJsDecodedKb: kb(routeEntries.reduce((sum, entry) => sum + entry.decodedBodySize, 0)),
    routeJsLedger: routeEntries.map(({ url, name, transferSize, encodedBodySize, decodedBodySize }) => ({
      url, name, transferSize, encodedBodySize, decodedBodySize,
    })),
    routeJsEntryCount: routeEntries.length,
    routeJsNetworkEntryCount: routeNetworkEntries.length,
    routeJsCacheHit: routeCacheHit,
  };
}

const javascriptDeliveryExpression = (sharedScriptUrls = []) =>
  `(${summarizeJavaScriptDelivery.toString()})(performance.getEntriesByType('resource'), ${JSON.stringify(sharedScriptUrls)})`

/** Captures the current page's actual network-delivered JS and cache evidence. */
export const measureJavaScriptDelivery = (browser, session) =>
  browserJson(browser, session, `(() => JSON.stringify(${javascriptDeliveryExpression()}))()`)

/**
 * @param {(session: string, args: string[]) => Promise<string>} browser
 * @param {string} session
 * @param {string} workflowId
 * @param {string} label
 */
const waitForWorkflowReady = async (browser, session, workflowId, label = '') => {
  const predicate = readyPredicates[workflowId]
  if (!predicate) throw new Error(`No workflow-ready predicate for ${workflowId}`)
  return browserJson(browser, session, `(async () => {
    const deadline = performance.now() + 15000;
    const label = ${JSON.stringify(label)};
    while (performance.now() < deadline) {
      const body = document.body?.innerText || '';
      if (${predicate}) {
        return JSON.stringify({ readyAtMs: performance.now(), bodySample: body.slice(0, 300) });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(${JSON.stringify(`Workflow ${workflowId} did not reach its ready state`)});
  })()`)
}

/**
 * Measures readiness and bytes from the browser's Resource Timing entries. encodedBodySize is
 * the bytes received before content decoding, so it reflects the server's actual compression.
 * @param {(session: string, args: string[]) => Promise<string>} browser
 * @param {string} session
 * @param {{ workflowId: string, label?: string, sharedScriptUrls?: string[] }} options
 */
export const measureNavigationTiming = async (browser, session, { workflowId, label = '', sharedScriptUrls = [] }) => {
  const ready = await waitForWorkflowReady(browser, session, workflowId, label)
  const timing = await browserJson(browser, session, `(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    if (!nav) return JSON.stringify(null);
    const resources = performance.getEntriesByType('resource');
    const requests = resources
      .filter((entry) => entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest')
      .map((entry) => entry.duration)
      .filter((duration) => Number.isFinite(duration) && duration >= 0);
    const delivery = ${javascriptDeliveryExpression(sharedScriptUrls)};
    return JSON.stringify({
      navigationLoadMs: Math.round(nav.loadEventEnd || nav.domContentLoadedEventEnd || nav.responseEnd || 0),
      cachedRequestMs: requests.length > 0 ? Math.round(Math.max(...requests)) : null,
      requestCount: requests.length,
      requestEvidence: requests.length > 0 ? 'fetch-or-xhr-duration' : 'no-fetch-or-xhr-observed',
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0),
      responseEndMs: Math.round(nav.responseEnd || 0),
      transferSize: Math.round(nav.transferSize || 0),
      encodedBodySize: Math.round(nav.encodedBodySize || 0),
      ...delivery,
    });
  })()`)
  return { ...timing, fullLoadMs: Math.round(ready.readyAtMs), readyState: true }
}

const markDynamicTarget = async (browser, session, expression, attribute) => {
  const result = await browserJson(browser, session, `(async () => {
    document.querySelectorAll('[${attribute}]').forEach((node) => node.removeAttribute('${attribute}'));
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const target = ${expression};
      if (target) {
        target.setAttribute('${attribute}', 'true');
        return JSON.stringify({ ok: true, label: target.getAttribute('aria-label') || target.textContent?.trim() || target.tagName });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return JSON.stringify({ ok: false });
  })()`)
  if (!result.ok) {
    const [snapshot, pageState] = await Promise.all([
      browser(session, ['snapshot']).catch((error) => `snapshot unavailable: ${error.message}`),
      browserJson(browser, session, `(() => JSON.stringify({ url: location.href, body: document.body?.innerText ?? '' }))()`)
        .catch((error) => ({ pageStateUnavailable: error.message })),
    ])
    throw new Error(`Workflow feedback target was unavailable: ${expression}\nPage state: ${JSON.stringify(pageState)}\nSnapshot:\n${snapshot}`)
  }
  return result.label
}

const prepareFeedbackObserver = async (browser, session, expectedSource) => browserJson(browser, session, `(() => {
  window.__pancakeWorkflowFeedbackObserver?.disconnect?.();
  window.__pancakeWorkflowFeedback = { startedAt: null, observedAt: null };
  const expected = () => Boolean(${expectedSource});
  const check = () => {
    const state = window.__pancakeWorkflowFeedback;
    if (state?.startedAt != null && state.observedAt == null && expected()) state.observedAt = performance.now();
  };
  const start = (event) => {
    if (!event.isTrusted || window.__pancakeWorkflowFeedback.startedAt != null) return;
    window.__pancakeWorkflowFeedback.startedAt = performance.now();
    queueMicrotask(check);
  };
  window.addEventListener('pointerdown', start, { capture: true, once: true });
  window.addEventListener('keydown', start, { capture: true, once: true });
  window.addEventListener('input', start, { capture: true, once: true });
  window.__pancakeWorkflowFeedbackObserver = new MutationObserver(check);
  window.__pancakeWorkflowFeedbackObserver.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, characterData: true,
  });
  return JSON.stringify({ ok: true, expectedBeforeAction: expected() });
})()`)

const collectFeedback = async (browser, session, interaction, target) => {
  const result = await browserJson(browser, session, `(async () => {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const state = window.__pancakeWorkflowFeedback;
      if (state?.startedAt != null && state.observedAt != null) {
        window.__pancakeWorkflowFeedbackObserver?.disconnect?.();
        return JSON.stringify({ feedbackMs: Math.round((state.observedAt - state.startedAt) * 10) / 10, observed: true });
      }
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    const state = window.__pancakeWorkflowFeedback;
    window.__pancakeWorkflowFeedbackObserver?.disconnect?.();
    return JSON.stringify({
      observed: false,
      state,
      url: location.href,
      body: document.body?.innerText ?? '',
    });
  })()`)
  if (!result.observed) {
    const snapshot = await browser(session, ['snapshot']).catch((error) => `snapshot unavailable: ${error.message}`)
    throw new Error(`${interaction} on ${target} produced no expected application state change\nPage state: ${JSON.stringify(result)}\nSnapshot:\n${snapshot}`)
  }
  return { ...result, interaction, target }
}

const clickMeasuredTarget = async (browser, session, { selector, expected, interaction, target }) => {
  const prepared = await prepareFeedbackObserver(browser, session, expected)
  if (prepared.expectedBeforeAction) throw new Error(`${interaction} expected state was already active`)
  await browser(session, ['click', selector])
  return collectFeedback(browser, session, interaction, target)
}

const typeMeasuredTarget = async (browser, session, { selector, value, expected, interaction, target, clear = false }) => {
  if (clear) await browser(session, ['fill', selector, ''])
  const prepared = await prepareFeedbackObserver(browser, session, expected)
  if (prepared.expectedBeforeAction) throw new Error(`${interaction} expected state was already active`)
  await browser(session, ['type', selector, value])
  return collectFeedback(browser, session, interaction, target)
}

const clickUnmeasured = (browser, session, selector) => browser(session, ['click', selector]).catch(() => {})

/**
 * Runs a workflow-specific, trusted browser action and requires the corresponding app state.
 * @param {(session: string, args: string[]) => Promise<string>} browser
 * @param {string} session
 * @param {{ workflowId: string, label?: string }} options
 */
export const measureWorkflowFeedback = async (browser, session, { workflowId, label = '' }) => {
  if (!WORKFLOW_FEEDBACK_IDS.includes(workflowId)) throw new Error(`No workflow feedback probe for ${workflowId}`)
  if (workflowId === 'home-live-lineup' || workflowId === 'lineup-day-change') {
    await markDynamicTarget(browser, session,
      `document.querySelector('[aria-current="date"]')?.parentElement?.querySelector(':scope > button[aria-label]:not([aria-current])')`,
      'data-e2e-feedback-target')
    const result = await clickMeasuredTarget(browser, session, {
      selector: '[data-e2e-feedback-target="true"]',
      expected: `document.querySelector('[data-e2e-feedback-target="true"]')?.getAttribute('aria-current') === 'date'`,
      interaction: 'lineup-day-select', target: workflowId,
    })
    return result
  }

  if (workflowId === 'player-search-filter') {
    const current = await browserJson(browser, session, `(() => JSON.stringify({ label: document.querySelector('[aria-label^="Availability:"]')?.getAttribute('aria-label') || '' }))()`)
    const option = current.label === 'Availability: Free agents' ? 'Rostered' : 'Free agents'
    await browser(session, ['click', '[aria-label^="Availability:"]'])
    await markDynamicTarget(browser, session,
      `[...document.querySelectorAll('*')].find((node) => node.textContent?.trim() === ${JSON.stringify(option)})?.closest('[role="button"], [tabindex="0"], button')`,
      'data-e2e-feedback-target')
    return clickMeasuredTarget(browser, session, {
      selector: '[data-e2e-feedback-target="true"]',
      expected: `document.querySelector('[aria-label^="Availability:"]')?.getAttribute('aria-label') === ${JSON.stringify(`Availability: ${option}`)}`,
      interaction: 'player-availability-filter', target: option,
    })
  }

  if (workflowId === 'roster-review-manage') {
    const result = await clickMeasuredTarget(browser, session, {
      selector: '[aria-label="Set lineup"]', expected: `location.pathname === '/lineup'`,
      interaction: 'roster-open-lineup', target: 'Set lineup',
    })
    await browser(session, ['back'])
    await waitForWorkflowReady(browser, session, workflowId, label)
    return result
  }

  if (workflowId === 'trade-review-act' && label === 'propose-trade') {
    const result = await clickMeasuredTarget(browser, session, {
      selector: '[aria-label="Use multi-team trade mode"]',
      expected: `document.body.innerText.includes('Pick at least two more teams') && document.querySelectorAll('[aria-label^="Trade with "]').length > 1`,
      interaction: 'trade-mode-change', target: 'Multi-Team',
    })
    await clickUnmeasured(browser, session, '[aria-label="Use 2-team trade mode"]')
    return result
  }

  if (workflowId === 'trade-review-act') {
    return clickMeasuredTarget(browser, session, {
      selector: '[role="tab"][aria-label^="History"]',
      expected: `document.querySelector('[role="tab"][aria-label^="History"]')?.getAttribute('aria-selected') === 'true'`,
      interaction: 'trade-history-tab', target: 'History',
    })
  }

  if (workflowId === 'dynasty-hub') {
    const result = await clickMeasuredTarget(browser, session, {
      selector: '[role="tab"][aria-label^="News"]',
      expected: `document.querySelector('[role="tab"][aria-label^="News"]')?.getAttribute('aria-selected') === 'true'`,
      interaction: 'dynasty-news-tab', target: 'News',
    })
    await clickUnmeasured(browser, session, '[role="tab"][aria-label^="Rankings"]')
    return result
  }

  if (workflowId === 'waiver-add-claim') {
    const selector = '[aria-label="FAAB bid amount"]'
    const current = await browserJson(browser, session, `(() => JSON.stringify({ value: document.querySelector(${JSON.stringify(selector)})?.value ?? '' }))()`)
    const value = current.value === '1' ? '2' : '1'
    const result = await typeMeasuredTarget(browser, session, {
      selector, value,
      expected: `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`,
      interaction: 'waiver-faab-input', target: 'FAAB bid amount',
      clear: true,
    })
    await browser(session, ['fill', selector, '0'])
    return result
  }

  if (workflowId === 'player-detail-open') {
    const target = await markDynamicTarget(browser, session,
      `[...document.querySelectorAll('button, [role="button"], [tabindex="0"]')].find((node) => node.textContent?.trim() === 'Drop')`,
      'data-e2e-feedback-target')
    const result = await clickMeasuredTarget(browser, session, {
      selector: '[data-e2e-feedback-target="true"]',
      expected: `document.querySelector('[role="dialog"]') && document.querySelector('[role="dialog"]')?.textContent?.includes('placed on waivers')`,
      interaction: 'player-drop-confirmation', target,
    })
    await clickUnmeasured(browser, session, '[role="dialog"] [aria-label="Cancel"]')
    return result
  }

  if (workflowId === 'auction-draft-room') {
    const before = await browserJson(browser, session, `(() => JSON.stringify({ label: document.querySelector('[aria-label^="Bid $"]')?.getAttribute('aria-label') }))()`)
    const result = await clickMeasuredTarget(browser, session, {
      selector: '[aria-label="Increase bid"]',
      expected: `document.querySelector('[aria-label^="Bid $"]')?.getAttribute('aria-label') !== ${JSON.stringify(before.label)}`,
      interaction: 'auction-increase-bid', target: 'Increase bid',
    })
    await clickUnmeasured(browser, session, '[aria-label="Decrease bid"]')
    return result
  }

  if (workflowId === 'rookie-draft-room') {
    const result = await clickMeasuredTarget(browser, session, {
      selector: '[aria-label="Show pick board"]',
      expected: `!document.querySelector('input[placeholder^="Search prospects"]') && document.body.innerText.includes('Team') && document.body.innerText.includes('Player')`,
      interaction: 'rookie-pick-board-tab', target: 'Pick Board',
    })
    await clickUnmeasured(browser, session, '[aria-label="Show prospects"]')
    return result
  }

  throw new Error(`Workflow feedback probe did not handle ${workflowId}`)
}
