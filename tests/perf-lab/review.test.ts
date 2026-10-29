import { expect, it } from 'vitest'
import { renderReview } from '../../scripts/perf-lab/review.mjs'

it('pairs first and settled images and preserves failed or missing captures', () => {
  const html = renderReview([{ id: 'screen<&', source: '123456789', passed: false, images: { first: { file: 'first.png' }, failure: { file: 'failure.png' } } }])
  expect(html).toContain('screen&lt;&amp; · content failed · 12345678')
  expect(html).toContain('href="first.png"')
  expect(html).toContain('href="failure.png"')
  expect(html).toContain('<h3>Settled</h3><p>Not captured</p>')
})

it('rejects image paths outside the review directory', () => {
  expect(() => renderReview([{ id: 'screen', source: '123456789', passed: true, images: { first: { file: '../first.png' } } }])).toThrow('Review images')
})
