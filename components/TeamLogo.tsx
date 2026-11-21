import { useState } from 'react'
import { Image, Text, type StyleProp, type TextStyle } from 'react-native'

// ESPN serves PNG logos (the NBA CDN only has SVG, which native Image can't draw).
const ESPN_CODES: Record<string, string> = {
    ATL: 'atl', BOS: 'bos', BKN: 'bkn', CHA: 'cha', CHI: 'chi', CLE: 'cle', DAL: 'dal', DEN: 'den', DET: 'det', GSW: 'gs',
    HOU: 'hou', IND: 'ind', LAC: 'lac', LAL: 'lal', MEM: 'mem', MIA: 'mia', MIL: 'mil', MIN: 'min', NOP: 'no', NYK: 'ny',
    OKC: 'okc', ORL: 'orl', PHI: 'phi', PHX: 'phx', POR: 'por', SAC: 'sac', SAS: 'sa', TOR: 'tor', UTA: 'utah', WAS: 'wsh',
}

export function teamLogoUrl(team: string | null | undefined): string | null {
    const code = team ? ESPN_CODES[team.trim().toUpperCase()] : undefined
    return code ? `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nba/500/${code}.png&w=64&h=64` : null
}

/** A team's logo at text size; falls back to the abbreviation when the team is unknown or the image fails. */
export function TeamLogo({ team, size, textStyle }: { team: string; size: number; textStyle?: StyleProp<TextStyle> }) {
    const uri = teamLogoUrl(team)
    const [failed, setFailed] = useState(false)
    if (!uri || failed) return <Text style={textStyle} numberOfLines={1}>{team}</Text>
    return <Image source={{ uri }} style={{ width: size, height: size, flexShrink: 0 }} resizeMode="contain"
        accessibilityRole="image" accessibilityLabel={team} testID="team-logo" onError={() => setFailed(true)} />
}
