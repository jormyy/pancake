import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }
export function startTradeLegalServer(directory) {
    const root = path.resolve(directory)
    return createServer(async (request, response) => {
        try {
            const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
            let file = path.join(root, pathname)
            if (!file.startsWith(`${root}/`) && file !== root) throw new Error('Invalid path')
            if (!path.extname(file)) file = path.join(root, 'index.html')
            if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html')
            response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' })
            response.end(await readFile(file))
        } catch {
            response.writeHead(404).end()
        }
    }).listen(61480, '127.0.0.1', () => console.log('Trade verification server ready'))
}
