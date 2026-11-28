import { browser } from './trade-browser-harness.mjs'

export async function confirmTradeAcceptance(options) {
  const { session, page, press = (button) => button.click(), browserCall = browser, timeoutMs = 10000 } = options
  const deadline = Date.now() + timeoutMs
  do {
    if (page) {
      const dialog = page.getByRole('dialog', { name: 'Accept trade?', exact: true })
      if (await dialog.isVisible()) {
        await press(dialog.getByRole('button', { name: 'Accept', exact: true }))
        return true
      }
      const review = page.getByTestId('trade-confirm-accept')
      if (await review.isVisible?.() && await review.isEnabled?.()) {
        await press(review)
        return true
      }
    } else {
      const output = await browserCall(session, ['eval', `(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')].find((node) =>
          document.getElementById(node.getAttribute('aria-labelledby'))?.textContent === 'Accept trade?');
        if (dialog && dialog.getBoundingClientRect().width > 0) return true;
        const review = document.querySelector('[data-testid="trade-confirm-accept"]');
        return review && review.getBoundingClientRect().width > 0 && review.getAttribute('aria-disabled') !== 'true' ? 'review' : false;
      })()`])
      const state = output.trim().replace(/^"|"$/g, '')
      if (state === 'true') {
        await browserCall(session, ['scrollintoview', '[role="dialog"] [aria-label="Accept"]'])
        await browserCall(session, ['click', '[role="dialog"] [aria-label="Accept"]'])
        return true
      }
      if (state === 'review') {
        await browserCall(session, ['click', '[data-testid="trade-confirm-accept"]'])
        return true
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error('Trade acceptance confirmation did not appear.')
}
