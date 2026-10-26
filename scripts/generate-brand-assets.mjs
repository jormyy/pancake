import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = new URL('../', import.meta.url)
const svg = await readFile(new URL('assets/images/pancake-mark.svg', root), 'utf8')
const exports = [
    { path: 'assets/images/pancake_logo.png', size: 150, opaque: false },
    { path: 'assets/images/pancake_logo@2x.png', size: 300, opaque: false },
    { path: 'assets/images/pancake_logo@3x.png', size: 450, opaque: false },
    { path: 'assets/images/favicon.png', size: 64, opaque: false },
    { path: 'assets/images/icon.png', size: 1024, opaque: true },
    { path: 'public/boot-logo.png', size: 128, opaque: false },
    { path: 'public/apple-touch-icon.png', size: 180, opaque: true },
    { path: 'public/pwa-192.png', size: 192, opaque: true },
    { path: 'public/pwa-512.png', size: 512, opaque: true },
    { path: 'public/pwa-512-maskable.png', size: 512, opaque: true },
]
const browser = await chromium.launch()
try {
    const page = await browser.newPage()
    for (const { path, size, opaque } of exports) {
        const png = await page.evaluate(async ({ svg, size, opaque }) => {
            const image = new Image()
            image.src = `data:image/svg+xml;base64,${btoa(svg)}`
            await image.decode()
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = size
            const context = canvas.getContext('2d')
            if (opaque) {
                context.fillStyle = '#E9DFD2'
                context.fillRect(0, 0, size, size)
            }
            context.drawImage(image, 0, 0, size, size)
            return canvas.toDataURL('image/png').split(',')[1]
        }, { svg, size, opaque })
        await writeFile(new URL(path, root), Buffer.from(png, 'base64'))
        console.log(fileURLToPath(new URL(path, root)))
    }
} finally {
    await browser.close()
}
