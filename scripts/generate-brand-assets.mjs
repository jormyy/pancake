import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = new URL('../', import.meta.url)
const svg = await readFile(new URL('assets/images/pancake-mark.svg', root), 'utf8')
const exports = [
    ['assets/images/pancake_logo.png', 150, false],
    ['assets/images/pancake_logo@2x.png', 300, false],
    ['assets/images/pancake_logo@3x.png', 450, false],
    ['assets/images/favicon.png', 64, false],
    ['assets/images/icon.png', 1024, true],
    ['public/boot-logo.png', 128, false],
    ['public/apple-touch-icon.png', 180, true],
    ['public/pwa-192.png', 192, true],
    ['public/pwa-512.png', 512, true],
    ['public/pwa-512-maskable.png', 512, true],
]
const browser = await chromium.launch()
try {
    const page = await browser.newPage()
    for (const [path, size, opaque] of exports) {
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
