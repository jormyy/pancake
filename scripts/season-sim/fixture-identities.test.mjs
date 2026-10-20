import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixtureNbaId } from './fixture-identities.mjs'

test('the independent final oracle accepts only the reviewed source identity occurrence', () => {
  assert.equal(fixtureNbaId('0022500622', { personId: 196295686, name: 'Dillon Jones' }), '1641794')
  assert.throws(() => fixtureNbaId('other-game', { personId: 196295686, name: 'Dillon Jones' }), /Unreviewed/)
  assert.throws(() => fixtureNbaId('0022500622', { personId: 196295686, name: 'Different Person' }), /name mismatch/)
  assert.equal(fixtureNbaId('0022500622', { personId: 99999, name: 'Dillon Jones' }), '99999')
})
