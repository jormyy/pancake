import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

assert.match(process.cwd(), /\/lanes\/fable-ui25\/repo$/)
const root = path.resolve('dist')
const contentTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' }
createServer(async (request, response) => {
    try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1:63980')
        let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`)
        assert.ok(file.startsWith(`${root}/`) || file === root)
        if (!(await stat(file).catch(() => null))?.isFile()) file = path.join(root, 'index.html')
        response.setHeader('Content-Type', contentTypes[path.extname(file)] ?? 'application/octet-stream')
        response.setHeader('Cache-Control', 'no-store')
        response.end(await readFile(file))
    } catch {
        response.writeHead(404).end()
    }
}).listen(63980, '127.0.0.1', () => process.stdout.write('Private web server listening on 63980.\n'))
