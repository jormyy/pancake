import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('interactive accessibility contracts', () => {
    it('announces season choices and their selected state', () => {
        const seasonSelector = source('components/player/SeasonSelector.tsx')
        expect(seasonSelector).toContain('accessibilityLabel={`Show ${seasonLabel(year)} season`}')
        expect(seasonSelector).toContain('accessibilityState={{ selected: active }}')
    })

    it('names roster rows and nested roster actions', () => {
        const roster = source('app/(tabs)/roster.tsx')
        expect(roster).toContain('accessibilityLabel={`Open ${item.players.display_name}`}')
        expect(roster).toContain("accessibilityLabel={`${item.is_on_ir ? 'Activate' : 'Move to IR'} ${item.players.display_name}`}")
        expect(roster).toContain('accessibilityLabel={`Move ${item.players.display_name} to taxi`}')
    })

    it('names the icon-only profile photo action and exposes busy state', () => {
        const profile = source('app/(tabs)/profile.tsx')
        expect(profile).toContain('accessibilityLabel="Change profile photo"')
        expect(profile).toContain('busy: avatarUploading')
    })
})
