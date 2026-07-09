export function standingsPointMetricLabels(showPa: boolean, showMaxPf: boolean) {
    const labels = ['PF']
    if (showMaxPf) labels.push('MAX PF')
    if (showPa) labels.push('PA')
    return labels
}
