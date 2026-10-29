import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const pattern = /<(style|script)([^>]*)>([\s\S]*?)<\/\1>/g

const compactScript = async code => {
  const config = require('expo/metro-config').getDefaultConfig(process.cwd())
  const minifier = require(config.transformer.minifierPath)
  return (await minifier({ code, filename: 'document.js', reserved: [],
    config: { compress: true, mangle: true, output: { comments: false, inline_script: true } } })).code
}

const compactStyle = async code => {
  const config = require('expo/metro-config').getDefaultConfig(process.cwd())
  const result = await require(config.transformerPath).transform(config.transformer, process.cwd(), 'document.css', Buffer.from(code), {
    dev: false, minify: true, platform: 'web', type: 'module', customTransformOptions: {},
  })
  return result.output[0].data.css.code
}

async function htmlFiles(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? htmlFiles(file) : entry.name.endsWith('.html') ? [file] : []
  }))).flat()
}

export async function compactDocumentAssets(root) {
  const documents = await Promise.all((await htmlFiles(path.join(root, 'dist'))).map(async file => ({ file, html: await readFile(file, 'utf8') })))
  const shared = new Map()
  for (const { html } of documents) {
    for (const match of html.matchAll(pattern)) {
      const [, kind, attributes, source] = match
      if (kind !== 'script' || source.length < 1024 || /\bsrc\s*=/.test(attributes) || source.includes('__EXPO_ROUTER_HYDRATE__')) continue
      if (/\btype\s*=/.test(attributes)) continue
      const item = shared.get(match[0]) ?? { attributes, source, count: 0 }
      item.count++
      shared.set(match[0], item)
    }
  }
  const replacements = new Map()
  for (const [original, { attributes, source, count }] of shared) {
    if (count < 2) continue
    const extension = 'js'
    const compact = await compactScript(source)
    const digest = createHash('sha256').update(compact).digest('hex').slice(0, 32)
    const url = `/assets/document/${digest}.${extension}`
    await mkdir(path.join(root, 'dist/assets/document'), { recursive: true })
    await writeFile(path.join(root, 'dist', url), compact)
    replacements.set(original, `<script${attributes} src="${url}"></script>`)
  }
  for (const { html } of documents) {
    for (const match of html.matchAll(pattern)) {
      const [original, kind, attributes, source] = match
      if (kind !== 'style' || replacements.has(original)) continue
      if (!attributes.includes('expo-generated-fonts') && !/\[data-auth-(?:hero|scroll)\]/.test(source)) continue
      replacements.set(original, `<style${attributes}>${await compactStyle(source)}</style>`)
    }
  }
  for (const { file, html } of documents) {
    await writeFile(file, html.replace(pattern, original => replacements.get(original) ?? original))
  }
}
