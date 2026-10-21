import assert from'node:assert/strict'
import test from'node:test'
import{readFile}from'node:fs/promises'

test('owner token registration uses the authenticated product route and keeps outside users separate',async()=>{
  const source=await readFile(new URL('./push-evidence.mjs',import.meta.url),'utf8')
  assert.match(source,/c\.api\(user,'\/profile\/push-token'/)
  assert.match(source,/c\.api\(outside,'\/profile\/push-token'/)
  assert.doesNotMatch(source,/UPDATE profiles|register_push_token_atomic/)
})
