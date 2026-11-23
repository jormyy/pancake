import { expect, it } from 'vitest'
import { LOGO_CHARS, matchupName } from '@/components/player/matchup-name'

it.each([
    ['Austin Reaves', 'A. Reaves'], ['Fred VanVleet', 'F. VanVleet'], ['Derrick White', 'D. White'],
    ['Gary Trent Jr.', 'G. Trent'], ['Robert Williams III', 'R. Williams'], ['  LeBron   James  ', 'L. James'],
    ['Nene', 'Nene'], ['', ''], ['Moussa Diabaté', 'M. Diabaté'], ['Karl-Anthony Towns', 'K. Towns'],
])('formats %s as %s without truncation', (name, expected) => {
    expect(matchupName(name)).toBe(expected)
})

it.each([
    ['Shai Gilgeous-Alexander', 'S. Gilgeous…'], ['Giannis Antetokounmpo', 'G. Antetokoun…'],
    ['Nickeil Alexander-Walker', 'N. Alexander…'], ['Kentavious Caldwell-Pope', 'K. Caldwell…'],
])('keeps the initial and ends %s with an ellipsis past 14 characters: %s', (name, expected) => {
    expect(matchupName(name)).toBe(expected)
    expect(Array.from(matchupName(name)).length).toBeLessThanOrEqual(14)
})

it.each([['Victor Wembanyama', 'V. Wembanyama'], ['Kristaps Porziņģis', 'K. Porziņģis'], ['Jonas Valančiūnas', 'J. Valančiūnas']])('fits %s whole within 14 characters', (name, expected) => {
    expect(matchupName(name)).toBe(expected)
})

it.each([
    ['Victor Wembanyama', 'V. Wembanya…'], ['Jonas Valančiūnas', 'J. Valančiū…'], ['Shai Gilgeous-Alexander', 'S. Gilgeous…'],
    ['Fred VanVleet', 'F. VanVleet'], ['Austin Reaves', 'A. Reaves'],
])('reserves room for the team logo: %s → %s', (name, expected) => {
    expect(matchupName(name, LOGO_CHARS)).toBe(expected)
    expect(Array.from(matchupName(name, LOGO_CHARS)).length).toBeLessThanOrEqual(14 - LOGO_CHARS)
})
