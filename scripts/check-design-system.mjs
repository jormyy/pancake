import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const metricKind = name => name === 'fontSize' ? 'font' : name === 'lineHeight' ? 'lineHeight'
    : name === 'letterSpacing' ? 'tracking' : /^border.*Radius$/.test(name) ? 'radius'
        : /^(?:(?:padding|margin)(?:Top|Bottom|Left|Right|Start|End|Horizontal|Vertical)?|gap|rowGap|columnGap|top|bottom|left|right|inset)$/.test(name) ? 'spacing' : null
const cssMetric = /\b(padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|gap|row-gap|column-gap|font(?:-size)?|line-height|letter-spacing|border(?:-[a-z]+)?-radius|top|bottom|left|right)\s*:\s*([^;{}'"\n]+)/g
const rawColor = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|color)\s*\(/i
const colorProperty = /(?:color|fill|stroke|background)$/i
const semanticColor = /^(?:inherit|initial|unset|revert|none|currentColor|var\(|url\()/i

export function scanDesignSystem(source, file = 'app/fixture.tsx') {
    if (!/^(?:app|components)\//.test(file) || file.startsWith('components/ui/')) return []
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const violations = new Map()
    const bindings = new Map()
    const register = (node, kind, property, value = node.getText(tree), start = node.getStart(tree), end = node.end) => {
        const { line } = tree.getLineAndCharacterOfPosition(start)
        violations.set(`${start}:${end}`, { file, line: line + 1, kind, property, value, start, end })
    }
    const collect = node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer)
        ts.forEachChild(node, collect)
    }
    collect(tree)
    const numbers = (node, kind, property, seen = new Set()) => {
        if (ts.isObjectLiteralExpression(node)) return
        if (ts.isConditionalExpression(node)) {
            numbers(node.whenTrue, kind, property, seen)
            numbers(node.whenFalse, kind, property, seen)
            return
        }
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return
        if (ts.isBinaryExpression(node) && ['<', '>', '<=', '>=', '===', '!==', '==', '!='].includes(node.operatorToken.getText(tree))) return
        if (ts.isNumericLiteral(node) || ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
            if (ts.isBinaryExpression(node.parent) && [ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken].includes(node.parent.operatorToken.kind)) {
                const other = node.parent.left === node ? node.parent.right : node.parent.left
                if (!ts.isNumericLiteral(other) && !(ts.isPrefixUnaryExpression(other) && ts.isNumericLiteral(other.operand))) return
            }
            register(node, kind, property)
            return
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return
        if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /(?:\d(?:px|rem|em|%)|^-?\d+(?:\.\d+)?$)/.test(node.text)) { register(node, kind, property); return }
        if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text)) {
            numbers(bindings.get(node.text), kind, property, new Set([...seen, node.text]))
            return
        }
        ts.forEachChild(node, child => numbers(child, kind, property, seen))
    }
    const visit = node => {
        if (ts.isPropertyAssignment(node) || ts.isJsxAttribute(node)) {
            const name = ts.isComputedPropertyName(node.name) ? node.name.expression : node.name
            const property = ts.isStringLiteralLike(name) ? name.text : name.getText(tree)
            const kind = metricKind(property)
            if (kind && node.initializer) numbers(node.initializer, kind, property)
            if (colorProperty.test(property) && node.initializer) {
                const checkColor = (child, seen = new Set()) => {
                    if (ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) {
                        const object = ts.isIdentifier(child.expression) ? bindings.get(child.expression.text) : null
                        if (object && ts.isObjectLiteralExpression(object)) {
                            for (const item of object.properties) if (ts.isPropertyAssignment(item)) checkColor(item.initializer, seen)
                        }
                        return
                    }
                    if (ts.isConditionalExpression(child)) { checkColor(child.whenTrue, seen); checkColor(child.whenFalse, seen); return }
                    if (ts.isStringLiteralLike(child) && !semanticColor.test(child.text)) register(child, 'color', property)
                    if (ts.isIdentifier(child) && bindings.has(child.text) && !seen.has(child.text)) {
                        checkColor(bindings.get(child.text), new Set([...seen, child.text]))
                        return
                    }
                    ts.forEachChild(child, nested => checkColor(nested, seen))
                }
                checkColor(node.initializer)
            }
        }
        if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && rawColor.test(node.text)) register(node, 'color', 'color')
        if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
            const css = node.getText(tree).replace(/\$\{[^}]*\}/g, value => ' '.repeat(value.length))
            for (const match of css.matchAll(cssMetric)) {
                const property = match[1]
                for (const literal of match[2].matchAll(/(?<![\w.-])-?\d+(?:\.\d+)?(?:px|rem|em)?\b/g)) {
                    const start = node.getStart(tree) + match.index + match[0].indexOf(match[2]) + literal.index
                    register(node, 'css', property, literal[0], start, start + literal[0].length)
                }
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(tree)
    return [...violations.values()].sort((a, b) => a.start - b.start)
}

export function designSystemViolations(root = process.cwd()) {
    const files = ['app', 'components'].flatMap(folder => readdirSync(path.join(root, folder), { recursive: true })
        .map(file => `${folder}/${file}`)).filter(file => /\.tsx?$/.test(file) && !file.startsWith('components/ui/')).sort()
    return files.flatMap(file => scanDesignSystem(readFileSync(path.join(root, file), 'utf8'), file))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const violations = designSystemViolations()
    if (violations.length) {
        for (const item of violations) console.error(`${item.file}:${item.line} ${item.property}: ${item.value} requires a shared token`)
        process.exitCode = 1
    } else console.log('Design system conformance passes for app/** and components/**')
}
