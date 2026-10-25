import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name)
  return entry.isDirectory() ? sources(file) : /\.(?:mjs|sql|ts)$/.test(file) && !/\.(?:test|db\.test)\.ts$/.test(file) ? [file] : []
})

const parse = (file: string, source: string) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const nodes = (node: ts.Node): ts.Node[] => [node, ...node.getChildren().flatMap(nodes)]
const enclosingFunction = (node: ts.Node): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined => {
  if (!node.parent) return undefined
  return ts.isFunctionDeclaration(node.parent) || ts.isArrowFunction(node.parent) || ts.isFunctionExpression(node.parent)
    ? node.parent : enclosingFunction(node.parent)
}
const functionName = (node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression) =>
  node.name?.getText() ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : undefined)

const assertedNames = (files: ts.SourceFile[]) => {
  const assertions: { file: string, name: string }[] = []
  const helpers = new Map<string, number>()
  const unresolved = (node: ts.Node) => { throw new Error(`Unresolved outbox assertion: ${node.getText()}`) }
  const resolve = (value: ts.Node, origin: ts.Node) => {
    if (ts.isStringLiteralLike(value)) assertions.push({ file: origin.getSourceFile().fileName, name: value.text.split(':')[0] })
    else if (ts.isTemplateExpression(value)) {
      if (value.head.text) assertions.push({ file: origin.getSourceFile().fileName, name: value.head.text.split(':')[0] })
      else resolve(value.templateSpans[0].expression, origin)
    } else if (ts.isIdentifier(value)) {
      const owner = enclosingFunction(origin)
      const index = owner?.parameters.findIndex(parameter => parameter.name.getText() === value.text) ?? -1
      const name = owner && functionName(owner)
      if (name && index >= 0) { helpers.set(name, index); return }
      for (let parent = origin.parent; parent; parent = parent.parent) {
        if (!ts.isForOfStatement(parent) || !ts.isVariableDeclarationList(parent.initializer) || !ts.isArrayLiteralExpression(parent.expression)) continue
        const binding = parent.initializer.declarations[0].name
        if (!ts.isArrayBindingPattern(binding)) continue
        const position = binding.elements.findIndex(element => element.getText() === value.text)
        if (position < 0) continue
        for (const row of parent.expression.elements) {
          if (!ts.isArrayLiteralExpression(row) || !row.elements[position]) unresolved(row)
          else resolve(row.elements[position], origin)
        }
        return
      }
      unresolved(value)
    } else unresolved(value)
  }
  for (const file of files) {
    for (const node of nodes(file)) {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || !['eq', 'like'].includes(node.expression.name.text)) continue
      const [field, value] = node.arguments
      if (!field || !ts.isStringLiteral(field) || !['event_type', 'dedupe_key'].includes(field.text)) continue
      if (!/\.from\(['"]notification_outbox['"]\)/.test(node.expression.expression.getText())) continue
      if (!value) unresolved(node)
      else resolve(value, node)
    }
    if (/\bnotification_outbox\b/.test(file.text)) {
      for (const match of file.text.matchAll(/\bevent_type\s*=\s*'([a-z][a-z0-9_-]*)'/g)) assertions.push({ file: file.fileName, name: match[1] })
    }
  }
  const processed = new Set<string>()
  while (processed.size < helpers.size) {
    for (const [name, index] of helpers) {
      if (processed.has(name)) continue
      processed.add(name)
      for (const file of files) for (const node of nodes(file)) {
        if (ts.isCallExpression(node) && node.expression.getText() === name) {
          if (!node.arguments[index]) unresolved(node)
          else resolve(node.arguments[index], node)
        }
      }
    }
  }
  return assertions
}

const missingProducers = (files: ts.SourceFile[], producers: string) => assertedNames(files).filter(({ name }) =>
  !producers.includes(`'${name}'`) && !producers.includes(`'${name}:`) && !producers.includes(`\`${name}:`))

const producers = [...sources('supabase/sql/functions'), ...sources('supabase/functions')]
  .map(file => readFileSync(file, 'utf8'))
  .filter(source => /\bINSERT\s+INTO\s+(?:public\.)?notification_outbox\b|\bnotif_enqueue\s*\(|\.from\(['"]notification_outbox['"]\)\.(?:insert|upsert)\(/i.test(source)).join('\n')

describe('outbox assertions', () => {
  it('requires a producer for every asserted event or dedupe prefix', () => {
    const files = sources('tests/e2e').filter(file => file.endsWith('.mjs')).map(file => parse(file, readFileSync(file, 'utf8')))
    expect(missingProducers(files, producers)).toEqual([])
  })

  it('rejects nonexistent literal, SQL, template, and cross-file helper event assertions', () => {
    const files = [
      parse('literal.mjs', "db.from('notification_outbox').eq('event_type', 'missing_event')"),
      parse('template.mjs', "db.from('notification_outbox').eq('dedupe_key', `missing_prefix:${id}`)"),
      parse('sql.mjs', "query(`SELECT * FROM notification_outbox WHERE event_type='missing_sql'`)"),
      parse('helper.mjs', "export function recipients(db, event) { return db.from('notification_outbox').eq('event_type', event) }"),
      parse('caller.mjs', "recipients(db, 'missing_helper')"),
    ]
    expect(missingProducers(files, producers).map(({ name }) => name).sort())
      .toEqual(['missing_event', 'missing_helper', 'missing_prefix', 'missing_sql'])
    expect(() => assertedNames([parse('unknown.mjs', "db.from('notification_outbox').eq('event_type', unknown)")])).toThrow('Unresolved outbox assertion')
  })
})
