import { describe, expect, it, vi } from 'vitest'

import {
  measureNavigationTiming,
  measureWorkflowFeedback,
  recordWorkflowMeasurement,
  summarizeJavaScriptDelivery,
  WORKFLOW_FEEDBACK_IDS,
  WORKFLOW_READY_IDS,
} from './e2e/browser-performance-evidence.mjs'
import budgets from './e2e/performance-budgets.json'

describe('browser performance evidence', () => {
  it('summarizes transferred route bytes and cached route evidence executable in Node', () => {
    const common = {
      name: 'http://localhost/_expo/static/js/web/__common-hash.js',
      initiatorType: 'script', transferSize: 310390, encodedBodySize: 310090, decodedBodySize: 1626236,
    }
    const route = {
      name: 'http://localhost/_expo/static/js/web/players-hash.js',
      initiatorType: 'script', transferSize: 12300, encodedBodySize: 12000, decodedBodySize: 40000,
    }

    expect(summarizeJavaScriptDelivery([common, route])).toMatchObject({
      networkEntryCount: 2,
      webJsEncodedKb: 314.5,
      webJsTransferKb: 11.7,
      routeJsEntryCount: 1,
      routeJsNetworkEntryCount: 1,
      routeJsCacheHit: false,
    })
    expect(summarizeJavaScriptDelivery([
      { ...common, transferSize: 0, encodedBodySize: common.decodedBodySize },
      { ...route, transferSize: 0, encodedBodySize: route.decodedBodySize },
    ])).toMatchObject({
      networkEntryCount: 0,
      webJsEncodedKb: 0,
      webJsTransferKb: 0,
      routeJsDecodedKb: 39.1,
      routeJsEntryCount: 1,
      routeJsNetworkEntryCount: 0,
      routeJsCacheHit: true,
    })
  })

  it('owns a ready and trusted feedback probe for every ranked workflow', () => {
    const workflowIds = budgets.workflows.map((workflow) => workflow.id).sort()
    expect([...WORKFLOW_READY_IDS].sort()).toEqual(workflowIds)
    expect([...WORKFLOW_FEEDBACK_IDS].sort()).toEqual(workflowIds)
  })

  it('merges repeated workflow routes using worst-case network and cache evidence', () => {
    const measurements = [{
      id: 'trade-review-act', route: '/trades', routeWebJsKb: 0,
      routeJsCacheHit: true, routeJsDecodedKb: 40, routeJsEntryCount: 1, routeJsNetworkEntryCount: 0,
      feedbackMs: 5, cachedRequestMs: 10, fullLoadMs: 100,
      feedbackObserved: true, feedbackInteraction: 'history',
    }]
    recordWorkflowMeasurement(measurements, {
      id: 'trade-review-act', route: '/propose-trade', routeWebJsKb: 240,
      routeJsCacheHit: false, routeJsDecodedKb: 80, routeJsEntryCount: 2, routeJsNetworkEntryCount: 1,
      feedbackMs: 8, cachedRequestMs: 20, fullLoadMs: 200,
      feedbackObserved: true, feedbackInteraction: 'mode',
    })

    expect(measurements).toEqual([expect.objectContaining({
      routeWebJsKb: 240,
      routeJsCacheHit: false,
      routeJsDecodedKb: 80,
      routeJsEntryCount: 2,
      routeJsNetworkEntryCount: 1,
      routes: ['/trades', '/propose-trade'],
    })])
  })

  it('gates fullLoadMs on workflow readiness rather than the navigation load event', async () => {
    const browser = vi.fn(async (_session: string, args: string[]) => {
      const source = args[1]
      if (source.includes('const deadline')) return JSON.stringify({ readyAtMs: 432.4 })
      return JSON.stringify({
        navigationLoadMs: 25,
        cachedRequestMs: 12,
        scriptCount: 3,
        webJsEncodedKb: 650,
        webJsTransferKb: 20,
      })
    })

    await expect(measureNavigationTiming(browser, 'session', {
      workflowId: 'dynasty-hub',
      label: 'dynasty',
    })).resolves.toMatchObject({ fullLoadMs: 432, navigationLoadMs: 25, readyState: true })
  })

  it('uses a browser click and requires the workflow-specific selected state', async () => {
    const browser = vi.fn(async (_session: string, args: string[]) => {
      if (args[0] === 'click') return ''
      const source = args[1]
      if (source.includes('expectedBeforeAction')) return JSON.stringify({ ok: true, expectedBeforeAction: false })
      if (source.includes('const deadline')) return JSON.stringify({ feedbackMs: 18.2, observed: true })
      throw new Error(`Unexpected browser command: ${args.join(' ')}`)
    })

    await expect(measureWorkflowFeedback(browser, 'session', { workflowId: 'trade-review-act', label: 'trades' }))
      .resolves.toMatchObject({ feedbackMs: 18.2, observed: true, interaction: 'trade-history-tab' })
    expect(browser).toHaveBeenCalledWith('session', ['click', '[role="tab"][aria-label^="History"]'])
  })
})
