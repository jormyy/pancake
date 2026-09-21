import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const expoRequire = createRequire(require.resolve('@expo/metro-config/package.json'))
const { transformCssModuleWeb } = expoRequire('./build/transform-worker/css-modules')
const generate = expoRequire('@babel/generator').default
const transformer = require('../scripts/stable-css-transformer.js')
const upstream = expoRequire('./babel-transformer')

const options = {
  projectRoot: process.cwd(),
  platform: 'web',
  dev: false,
  minify: true,
  type: 'module',
  customTransformOptions: { routerRoot: 'app' },
}
const compile = (src: string, filename = 'control.module.css', implementation = transformer) => (
  generate(implementation.transform({ src, filename, options }).ast).code as string
)
const evaluate = (code: string) => {
  const module = { exports: {} }
  runInNewContext(code, { module })
  return module.exports
}

describe('stable generated CSS exports', () => {
  it('emits the same JavaScript for opposite export-map insertion orders', () => {
    const maps = ['alpha', 'beta', 'gamma'].map((name) => [name, `scoped_${name}`])
    const source = (entries: string[][]) => {
      const styles = Object.fromEntries(entries)
      const native = Object.fromEntries(entries.map(([key, value]) => [key, { $$css: true, _: value }]))
      return `module.exports=Object.assign(${JSON.stringify(styles)},{unstable_styles:${JSON.stringify(native)}},{})`
    }
    const left = source(maps)
    const right = source([...maps].reverse())
    // This control must differ without the fix; source order reaches the bundle.
    expect(compile(left, 'control.module.css', upstream)).not.toBe(compile(right, 'control.module.css', upstream))
    expect(compile(left)).toBe(compile(right))
    expect(evaluate(compile(left))).toEqual(evaluate(left))
  })

  it('preserves real compiler classes and composition order', async () => {
    const src = '.beta{color:red}.alpha{color:blue}.gamma{composes:beta alpha;--accent:green}'
    const css = await transformCssModuleWeb({ src, filename: 'control.module.css', options })
    const before = evaluate(css.output)
    const code = compile(css.output)
    expect(evaluate(code)).toEqual(before)
    expect(Reflect.get(before, 'gamma')).toMatch(/_gamma \S+_beta \S+_alpha$/)
  })

  it('leaves ordinary JavaScript object ordering unchanged', () => {
    const src = 'module.exports=Object.assign({z:1,a:2},{unstable_styles:{z:3,a:4}},{})'
    expect(compile(src, 'ordinary.js')).toBe(compile(src, 'ordinary.js', upstream))
    expect(Object.keys(evaluate(compile(src, 'ordinary.js')))).toEqual(['z', 'a', 'unstable_styles'])
  })

  it.each(['{...other}', '{[key]:1}', '{get alpha(){return 1}}'])('rejects unexpected generated map %s', (map) => {
    expect(() => compile(`module.exports=Object.assign(${map},{unstable_styles:{}},{})`)).toThrow('Unexpected generated CSS export map')
  })

  it('uses the transformer in the real Metro configuration', () => {
    const config = require('../metro.config.js')
    expect(config.transformer.babelTransformerPath).toBe(require.resolve('../scripts/stable-css-transformer.js'))
  })
})
