import { describe, expect, it, vi } from 'vitest'

import {
  measureNavigationTiming,
  measureWorkflowFeedback,
  WORKFLOW_FEEDBACK_IDS,
  WORKFLOW_READY_IDS,
} from './e2e/browser-performance-evidence.mjs'
import budgets from './e2e/performance-budgets.json'

describe('browser performance evidence', () => {
  it('owns a ready and trusted feedback probe for every ranked workflow', () => {
    const workflowIds = budgets.workflows.map((workflow) => workflow.id).sort()
    expect([...WORKFLOW_READY_IDS].sort()).toEqual(workflowIds)
    expect([...WORKFLOW_FEEDBACK_IDS].sort()).toEqual(workflowIds)
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
