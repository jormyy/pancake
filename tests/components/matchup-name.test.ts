import { expect, it } from 'vitest'
import { matchupName } from '@/components/player/matchup-name'

it.each([
    ['Austin Reaves', 'A. Reaves'], ['Fred VanVleet', 'F. VanVleet'], ['Giannis Antetokounmpo', 'Antetokounmpo'], ['Derrick White', 'D. White'], ['Victor Wembanyama', 'Wembanyama'],
    ['Nickeil Alexander-Walker', 'Alexander-Walker'], ['Shai Gilgeous-Alexander', 'Gilgeous-Alexander'],
    ['Gary Trent Jr.', 'G. Trent'], ['Robert Williams III', 'R. Williams'], ['  LeBron   James  ', 'L. James'],
    ['Nene', 'Nene'], ['', ''], ['Moussa Diabaté', 'M. Diabaté'],
])('formats %s as %s without truncation', (name, expected) => {
    expect(matchupName(name)).toBe(expected)
    expect(matchupName(name)).not.toContain('…')
})
