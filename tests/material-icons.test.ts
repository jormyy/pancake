import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { collectMaterialIconNames } = require('../assets/fonts/collect-icons.js') as {
    collectMaterialIconNames: (root: string, files: string[]) => Record<string, number>
}
const root = process.cwd()
const directory = mkdtempSync(path.join(root, 'tests/.material-icons-'))
const scan = (source: string) => {
    const file = path.join(directory, 'fixture.tsx')
    writeFileSync(file, source)
    return Object.keys(collectMaterialIconNames(root, [file]))
}

afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('MaterialIcons source discovery', () => {
    it('ignores cache keys, style values, and unrelated data strings', () => {
        expect(scan(`
            import Icons from '@expo/vector-icons/MaterialIcons'
            const cache = { key: 'support', resource: 'inventory', icon: 'default' }
            const style = { cursor: 'default', display: 'block' }
            export const Page = () => <Icons name="home" style={style} />
        `)).toEqual(['home'])
    }, 30_000)

    it('keeps wrapper props, typed lookup values, aliases, and conditional names', () => {
        expect(scan(`
            import { ComponentProps } from 'react'
            import { MaterialIcons as Icon } from '@expo/vector-icons'
            type Name = ComponentProps<typeof Icon>['name']
            function Button({ icon = 'info' }: { icon?: Name }) { return <Icon name={icon} /> }
            function Nav({ name = 'alarm' }: { name?: Name }) { return <Icon name={name} /> }
            function selected(): Name { return 'visibility' }
            const items: { icon: Name; label: string }[] = [{ icon: 'settings', label: 'inventory' }]
            const up = true
            const movement = up ? 'trending-up' : 'trending-down'
            export const Page = () => <>
                <Button icon={up ? 'check' : 'close'} />
                <Nav name="home" />
                {items.map(item => <Button icon={item.icon} />)}
                <Icon name={movement} />
                <Icon name={selected()} />
            </>
        `)).toEqual(['alarm', 'check', 'close', 'home', 'info', 'settings', 'trending-down', 'trending-up', 'visibility'])
    }, 30_000)

    it('retains genuine glyphs that also occur as unrelated words', () => {
        expect(scan(`
            import * as Icons from '@expo/vector-icons'
            const props = { name: 'alarm' as const }
            export const Page = () => <><Icons.MaterialIcons name="support" /><Icons.MaterialIcons {...props} /></>
        `)).toEqual(['alarm', 'support'])
    }, 30_000)

    it('rejects an unbounded computed MaterialIcons name', () => {
        expect(() => scan(`
            import Icon from '@expo/vector-icons/MaterialIcons'
            export const Page = ({ input }: { input: any }) => <Icon name={input} />
        `)).toThrow('literal name choices')
    }, 30_000)
})
