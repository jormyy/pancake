const ATTRIBUTE_PATTERN = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

export function buildAspNetRankingForm(html: string): URLSearchParams {
  const form = new URLSearchParams()

  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0])
    const name = attributes.get('name')
    if (name) form.set(name, attributes.get('value') ?? '')
  }

  for (const match of html.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/gi)) {
    const openingTag = match[0].match(/^<select\b[^>]*>/i)?.[0]
    if (!openingTag) continue
    const name = parseAttributes(openingTag).get('name')
    if (!name) continue

    const options = [...match[0].matchAll(/<option\b[^>]*>/gi)]
    const selected = options.find((option) => parseAttributes(option[0]).has('selected')) ?? options[0]
    if (selected) form.set(name, parseAttributes(selected[0]).get('value') ?? '')
  }

  return form
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const match of tag.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1].toLowerCase()
    if (name.startsWith('<')) continue
    attributes.set(name, decodeHtmlAttribute(match[2] ?? match[3] ?? match[4] ?? ''))
  }
  return attributes
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (entity, code: string) => {
    if (code[0] === '#') {
      const radix = code[1]?.toLowerCase() === 'x' ? 16 : 10
      const digits = radix === 16 ? code.slice(2) : code.slice(1)
      const point = Number.parseInt(digits, radix)
      return Number.isFinite(point) ? String.fromCodePoint(point) : entity
    }
    return { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' }[code.toLowerCase()] ?? entity
  })
}
