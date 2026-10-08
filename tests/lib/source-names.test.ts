import { describe, expect, it } from 'vitest'
import { readableSourceName } from '@/lib/source-names'

describe('readableSourceName', () => {
    it('names known sources the way managers know them', () => {
        expect(readableSourceName('fantasypros_daily')).toBe('FantasyPros')
        expect(readableSourceName('season_avg')).toBe('Season averages')
        expect(readableSourceName('Pancake deterministic pick curve')).toBe('Pancake pick values')
    })

    it('turns unknown ids into words and leaves plain names alone', () => {
        expect(readableSourceName('hashtag_basketball_dynasty')).toBe('Hashtag basketball dynasty')
        expect(readableSourceName('Hashtag Basketball')).toBe('Hashtag Basketball')
    })
})
