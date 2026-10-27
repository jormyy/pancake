import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
export default defineConfig({
    root,
    resolve: { extensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.mjs', '.js', '.ts', '.jsx', '.tsx', '.json'], alias: [
        { find: 'react-native-safe-area-context', replacement: path.join(root, 'tests/lib/timeline/browser/safe-area.ts') },
        { find: '@/lib/supabase', replacement: path.join(root, 'tests/lib/timeline/browser/supabase.ts') },
        { find: /^react-native$/, replacement: 'react-native-web' },
        { find: '@', replacement: root },
    ] },
    server: { host: '127.0.0.1', port: 59931, strictPort: true },
})
