import { strict as assert } from 'node:assert'
import { sourceBirthdate, sourceYearsExperience } from '../_shared/playerSourceDetails.ts'
import samples from './experience-fixtures.json' with { type: 'json' }

Deno.test('ten sampled ESPN players map to completed seasons', () => {
  assert.equal(samples.length, 10)
  for (const sample of samples) {
    assert.equal(sourceYearsExperience({ experience: { years: sample.sourceYears } }, sample.seasonYear), sample.expectedCompleted, sample.name)
    if (sample.debutYear !== null) assert.equal(sourceYearsExperience({ debutYear: sample.debutYear }, sample.seasonYear), sample.expectedCompleted, sample.name)
  }
})

Deno.test('birthdates keep their calendar day and reject invalid dates', () => {
  assert.equal(sourceBirthdate('1998-09-02T07:00Z'), '1998-09-02')
  assert.equal(sourceBirthdate('2000-02-29'), '2000-02-29')
  for (const value of ['2025-02-29', '2000-13-01', '1899-12-31', '9999-01-01', null]) assert.equal(sourceBirthdate(value), null)
})
