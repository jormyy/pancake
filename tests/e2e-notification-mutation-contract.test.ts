import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import ts from 'typescript'

test('notification mutation operators match current implementation sources', () => {
  const file = 'scripts/mutation/notif/round3.ts'
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find(node => node.name.getText(source) === 'targets')
  assert.ok(declaration?.initializer)
  const targets: { id: string, file: string, original: string, kind: string }[] = JSON.parse(declaration.initializer.getText(source))
  assert.ok(targets.length > 0)
  const missing = targets.filter(target => !readFileSync(target.kind === 'edge' ? target.file : `supabase/sql/functions/by-name/${target.file}`, 'utf8').includes(target.original))
  assert.deepEqual(missing.map(target => target.id), [])
})
