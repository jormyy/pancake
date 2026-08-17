import { buildAspNetRankingForm } from './form.ts'

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test('builds the ASP.NET ranking form without a document tree', () => {
  const form = buildAspNetRankingForm(`
    <input value="state&amp;value" name="__VIEWSTATE">
    <input name='__EVENTVALIDATION' value='event&#43;value'>
    <select name="ranking"><option value="5">Five</option><option selected value="3">Three</option></select>
    <select name="position"><option value="ALL">All</option></select>
  `)

  expect(form.get('__VIEWSTATE') === 'state&value', 'view state was not decoded')
  expect(form.get('__EVENTVALIDATION') === 'event+value', 'event validation was not decoded')
  expect(form.get('ranking') === '3', 'selected option was not used')
  expect(form.get('position') === 'ALL', 'first option fallback was not used')
})
