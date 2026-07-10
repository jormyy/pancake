/** @param {string} output */
const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  if (!line) throw new Error('Browser performance evaluation returned no output')
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

/** @param {(session: string, args: string[]) => Promise<string>} browser @param {string} session */
export const measureNavigationTiming = async (browser, session) => {
  const output = await browser(session, [
    'eval',
    `(async () => {
      const nav = performance.getEntriesByType('navigation')[0];
      if (!nav) return JSON.stringify(null);
      const resources = performance.getEntriesByType('resource');
      const requests = resources
        .filter((entry) => entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest')
        .map((entry) => entry.duration)
        .filter((duration) => Number.isFinite(duration) && duration >= 0);
      const scripts = resources.filter((entry) =>
        entry.initiatorType === 'script' || /(?:^|\\/)index(?:[.-][^/?]+)?\\.js(?:$|[?#])/.test(entry.name));
      const encodedBytes = scripts.reduce((sum, entry) => sum + Math.max(0, entry.encodedBodySize || entry.decodedBodySize || 0), 0);
      const transferredBytes = scripts.reduce((sum, entry) => sum + Math.max(0, entry.transferSize || 0), 0);
      const compressedBytes = await Promise.all(scripts.map(async (entry) => {
        const response = await fetch(entry.name);
        const body = await response.arrayBuffer();
        if (typeof CompressionStream !== 'function') return body.byteLength;
        const stream = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'));
        return (await new Response(stream).arrayBuffer()).byteLength;
      }));
      return JSON.stringify({
        fullLoadMs: Math.round(nav.loadEventEnd || nav.domContentLoadedEventEnd || nav.responseEnd || 0),
        cachedRequestMs: requests.length > 0 ? Math.round(Math.max(...requests)) : null,
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0),
        responseEndMs: Math.round(nav.responseEnd || 0),
        transferSize: Math.round(nav.transferSize || 0),
        encodedBodySize: Math.round(nav.encodedBodySize || 0),
        webJsEncodedKb: Math.round(compressedBytes.reduce((sum, bytes) => sum + bytes, 0) / 1024 * 10) / 10,
        webJsUncompressedKb: Math.round(encodedBytes / 1024 * 10) / 10,
        webJsTransferKb: Math.round(transferredBytes / 1024 * 10) / 10,
      });
    })()`,
  ])
  return parseEvalJson(output)
}

/**
 * @param {(session: string, args: string[]) => Promise<string>} browser
 * @param {string} session
 * @param {{ inputSelectors?: string[] }} [options]
 */
export const measureVisibleFeedback = async (browser, session, { inputSelectors = [] } = {}) => {
  const output = await browser(session, [
    'eval',
    `(async () => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const selectors = ${JSON.stringify(inputSelectors)};
      const preferredInput = selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
        .find((element) => visible(element) && !element.disabled && !element.readOnly);
      const genericTarget = [...document.querySelectorAll('input, textarea, [role="button"], button, [role="tab"], [tabindex]')]
        .find((element) => visible(element) && element.getAttribute('aria-disabled') !== 'true' && !element.disabled);
      const target = preferredInput || genericTarget;
      if (!target) return JSON.stringify(null);

      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const previous = target.value;
        const numeric = target.type === 'number' || target.inputMode === 'numeric' || target.inputMode === 'decimal';
        const next = numeric ? String(Number(previous || 0) + 1) : previous + 'e2e';
        const prototype = target instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        const started = performance.now();
        target.focus();
        descriptor?.set?.call(target, next);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        const changedImmediately = target.value === next;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const feedbackMs = Math.round((performance.now() - started) * 10) / 10;
        const observed = document.activeElement === target && (changedImmediately || target.value === next);
        descriptor?.set?.call(target, previous);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        return JSON.stringify({ feedbackMs, observed, interaction: 'input-change' });
      }

      const before = getComputedStyle(target);
      const beforeStyle = [before.opacity, before.transform, before.backgroundColor].join('|');
      const previousTabIndex = target.getAttribute('tabindex');
      if (!(target instanceof HTMLButtonElement) && previousTabIndex === null) target.setAttribute('tabindex', '0');
      const eventInit = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' };
      const started = performance.now();
      target.focus();
      target.dispatchEvent(typeof PointerEvent === 'function'
        ? new PointerEvent('pointerdown', eventInit)
        : new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const after = getComputedStyle(target);
      const afterStyle = [after.opacity, after.transform, after.backgroundColor].join('|');
      const feedbackMs = Math.round((performance.now() - started) * 10) / 10;
      const observed = document.activeElement === target || beforeStyle !== afterStyle;
      target.dispatchEvent(typeof PointerEvent === 'function'
        ? new PointerEvent('pointerup', eventInit)
        : new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      if (previousTabIndex === null) target.removeAttribute('tabindex');
      return JSON.stringify({ feedbackMs, observed, interaction: 'pointer-focus' });
    })()`,
  ])
  return parseEvalJson(output)
}
