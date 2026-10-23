import { FilterSelect } from '@/components/ui'

type Props = {
    seasons: number[]
    selectedSeason: number
    onSelect: (season: number) => void
}

export function SeasonSelector({ seasons, selectedSeason, onSelect }: Props) {
    if (seasons.length <= 1) return null

    return (
        <FilterSelect
            label="Season"
            value={String(selectedSeason)}
            options={seasons.map(year => ({ key: String(year), label: `${year - 1}–${String(year).slice(2)}` }))}
            onChange={value => onSelect(Number(value))}
        />
    )
}
