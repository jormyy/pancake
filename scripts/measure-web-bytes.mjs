import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { load } from 'cheerio'
import ts from 'typescript'

const sourceTree = source => ts.createSourceFile('bundle.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)

const moduleBodies = source => {
  const ast = sourceTree(source)
  return ast.statements.flatMap(statement => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return []
    const call = statement.expression
    if (!ts.isIdentifier(call.expression) || call.expression.text !== '__d') return []
    const body = call.arguments[0]
    if (!body || !ts.isFunctionExpression(body) && !ts.isArrowFunction(body)) return []
    const id = call.arguments[1]
    return [{ id: id && ts.isNumericLiteral(id) ? Number(id.text) : id && ts.isStringLiteral(id) ? id.text : undefined,
      hash: createHash('sha256').update(source.slice(body.getStart(ast), body.end)).digest('hex'),
      raw: Buffer.byteLength(source.slice(statement.getStart(ast), statement.end)) }]
  })
}

export function byteSizes(bytes) {
  return { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length,
    br: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length }
}

export function documentAssets(html) {
  const $ = load(html)
  const urls = new Set()
  $('script[src],link[rel="stylesheet"],link[rel="preload"],img[src]').each((_, element) => {
    const url = $(element).attr('src') ?? $(element).attr('href')
    if (url?.startsWith('/') && !url.startsWith('//')) urls.add(url.split('?')[0])
  })
  return [...urls].sort()
}

const walk = async (root, prefix = '') => (await Promise.all((await readdir(path.join(root, prefix), { withFileTypes: true }))
  .map(entry => entry.isDirectory() ? walk(root, path.join(prefix, entry.name)) : path.join(prefix, entry.name)))).flat().sort()

export async function measureExport(root, moduleFile) {
  const files = await walk(root)
  const records = new Map()
  for (const file of files) {
    const bytes = await readFile(path.join(root, file))
    records.set(`/${file}`, { ...byteSizes(bytes), sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  const routes = []
  for (const file of files.filter(file => file.endsWith('.html'))) {
    const html = await readFile(path.join(root, file), 'utf8')
    const $ = load(html)
    const assets = documentAssets(html)
    for (let index = 0; index < assets.length; index++) {
      const asset = assets[index]
      assert.ok(records.has(asset), `Missing document asset: ${asset}`)
      if (!asset.endsWith('.css')) continue
      const css = await readFile(path.join(root, asset), 'utf8')
      for (const [, raw] of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        if (/^(data:|https?:|\/\/)/.test(raw)) continue
        const url = new URL(raw, `http://local${asset}`).pathname
        if (!assets.includes(url)) assets.push(url)
      }
    }
    const total = { raw: 0, gzip: 0, br: 0 }
    for (const url of [`/${file}`, ...assets]) {
      assert.ok(records.has(url), `Missing dependency: ${url}`)
      for (const key of Object.keys(total)) total[key] += records.get(url)[key]
    }
    routes.push({ route: `/${file}`.replace(/\/index\.html$/, '/').replace(/\.html$/, ''), html: records.get(`/${file}`),
      inlineStyleRaw: $('style').toArray().reduce((sum, element) => sum + Buffer.byteLength($(element).html() ?? ''), 0),
      inlineScriptRaw: $('script:not([src])').toArray().reduce((sum, element) => sum + Buffer.byteLength($(element).html() ?? ''), 0),
      assets, documentTotal: total })
  }
  const modules = moduleFile ? (await readFile(moduleFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const names = new Map(modules.filter(row => row.environment === 'client').map(row => [row.id, row.path]))
  const bundles = []
  if (moduleFile) {
    const functions = new Map()
    const codeRows = await readFile(`${moduleFile}.code`, 'utf8').catch(() => '')
    for (const line of codeRows.trim().split('\n').filter(Boolean)) {
      const row = JSON.parse(line)
      for (const body of moduleBodies(row.code)) functions.set(body.hash, row.path)
    }
    for (const file of files.filter(file => file.endsWith('.js') && file.startsWith('_expo/'))) {
      const source = await readFile(path.join(root, file), 'utf8')
      const rows = moduleBodies(source).map(({ id, hash, raw }) => ({ id, raw,
        path: functions.get(hash) ?? names.get(id) ?? `unknown:${id}`, sourceMatched: functions.has(hash) }))
        .sort((a, b) => b.raw - a.raw)
      bundles.push({ file, documentReferenced: routes.some(route => route.assets.includes(`/${file}`)), ...records.get(`/${file}`), moduleCount: rows.length, modules: rows })
    }
  }
  const worker = await readFile(path.join(root, 'sw.js'), 'utf8')
  const declarations = sourceTree(worker).statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
  const declaration = declarations.find(node => ts.isIdentifier(node.name) && node.name.text === 'PRECACHE_URLS')
  assert.ok(declaration?.initializer && ts.isArrayLiteralExpression(declaration.initializer))
  const precache = [...declaration.initializer.elements].map(node => {
    assert.ok(ts.isStringLiteral(node))
    return node.text
  })
  const precacheTotal = { raw: 0, gzip: 0, br: 0 }
  for (const url of precache) for (const key of Object.keys(precacheTotal)) precacheTotal[key] += records.get(url === '/' ? '/index.html' : url)[key]
  return { version: 1, compression: { gzip: 9, brotli: 11 }, routes, files: Object.fromEntries(records),
    bundles: bundles.sort((a, b) => b.raw - a.raw), precache, precacheTotal }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root = 'dist', output = 'web-bytes.json', moduleFile] = process.argv.slice(2)
  const report = await measureExport(path.resolve(root), moduleFile)
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ routes: report.routes.length, files: Object.keys(report.files).length, precache: report.precacheTotal }))
}
