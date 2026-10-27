import { expect, it } from 'vitest'
import { matchupName } from '@/components/player/matchup-name'

it.each([
    ['Austin Reaves', 'A. Reaves'], ['Derrick White', 'D. White'], ['Victor Wembanyama', 'Wembanyama'],
    ['Nickeil Alexander-Walker', 'Alexander'], ['Shai Gilgeous-Alexander', 'Gilgeous-A'],
    ['Gary Trent Jr.', 'G. Trent'], ['Robert Williams III', 'Williams'], ['  LeBron   James  ', 'L. James'],
    ['Nene', 'Nene'], ['', ''], ['Moussa Diabaté', 'M. Diabaté'],
])('caps %s as %s without ellipsis', (name, expected) => {
    expect(matchupName(name)).toBe(expected)
    expect(matchupName(name)).not.toContain('…')
})
