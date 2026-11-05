import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [runDirectory, feature, label] = process.argv.slice(2)
assert.ok(runDirectory && /^[a-z0-9-]+$/.test(feature) && /^[a-z0-9-]+$/.test(label), 'Pass a run directory, feature, and evidence label')
const tools = path.dirname(fileURLToPath(import.meta.url))
const directory = path.join(path.dirname(path.resolve(runDirectory)), feature)
await mkdir(directory, { recursive: true })
const target = path.join(directory, label)
const browser = args => execFileSync('node', [path.join(tools, 'browser.mjs'), runDirectory, ...args], { encoding: 'utf8', timeout: 65000 })
await writeFile(`${target}.txt`, browser(['snapshot']))
await writeFile(`${target}-layout.json`, browser(['eval', `({url:location.href,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,radios:Array.from(document.querySelectorAll('[role=radio]')).map(e=>({label:e.getAttribute('aria-label'),checked:e.getAttribute('aria-checked')})),overflow:Array.from(document.querySelectorAll('body *')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.left< -1||r.right>innerWidth+1)}).slice(0,30).map(e=>({tag:e.tagName,label:e.getAttribute('aria-label'),text:e.textContent?.slice(0,100)}))})`]))
browser(['screenshot', `${target}.png`])
await writeFile(`${target}-database.json`, execFileSync('node', [path.join(tools, 'observe.mjs'), runDirectory], { encoding: 'utf8', timeout: 30000 }))
console.log(target)
