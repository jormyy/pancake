import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { SHELL_BACK_HEADER_ROUTES } from '@/constants/navigation'

const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])

it('keeps every modal screen inside the shell back header routes', () => {
    const missing = files('app/(modals)').filter(file => file.endsWith('.tsx') && /<ModalScreen[\s>]/.test(readFileSync(file, 'utf8')))
        .map(file => `/${file.split('/').at(-1)!.replace('.tsx', '')}`)
        .filter(route => !SHELL_BACK_HEADER_ROUTES.some(value => value === route))
    expect(missing).toEqual([])
})

const tabNames = new Set(files('app/(tabs)').filter(file => file.endsWith('.tsx') && !file.endsWith('_layout.tsx'))
    .map(file => file.split('/').at(-1)!.replace('.tsx', '')).map(name => name === 'index' ? '' : name))

function tabTreeViolations(file: string, text: string): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const constants = new Map<string, ts.Expression>()
    const collect = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer)
        ts.forEachChild(node, collect)
    }
    collect(source)
    const targetValue = (expression: ts.Expression | undefined): string | null => {
        if (!expression) return null
        if (ts.isIdentifier(expression)) {
            const value = constants.get(expression.text)
            return value && value !== expression ? targetValue(value) : null
        }
        if (ts.isObjectLiteralExpression(expression)) {
            const pathname = expression.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'pathname')
            return pathname && ts.isPropertyAssignment(pathname) ? targetValue(pathname.initializer) : null
        }
        return ts.isStringLiteralLike(expression) ? expression.text : null
    }
    const isTab = (target: string | null) => target !== null && (/^\/\(tabs\)(?:[/?#]|$)/.test(target)
        || tabNames.has(target.split(/[?#]/)[0].replace(/^\//, '').replace(/\/$/, '')))
    const violations: string[] = []
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
            const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : ''
            if (['push', 'replace'].includes(name) && isTab(targetValue(node.arguments[0]))) violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
        }
        if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
            if (['Redirect', 'Link'].includes(node.tagName.getText(source)) && !node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'dismissTo')) {
                const href = node.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'href')
                if (href && ts.isJsxAttribute(href)) {
                    const value = href.initializer && ts.isJsxExpression(href.initializer) ? href.initializer.expression : href.initializer
                    if (isTab(targetValue(value))) violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
                }
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    return violations
}

it('never pushes, replaces or redirects a tab tree from a root screen or shared client code', () => {
    const roots = ['app', 'hooks', 'components'].flatMap(files).filter(file => /\.tsx?$/.test(file)
        && !file.includes('(tabs)') && !file.includes('(auth)') && !file.endsWith('_layout.tsx'))
    expect(roots.flatMap(file => tabTreeViolations(file, readFileSync(file, 'utf8')))).toEqual([])
})

it.each([
    ['hooks/use-draft-room-launcher.ts', `const NO_DRAFT_ROUTE = '/draft'; router.push(NO_DRAFT_ROUTE)`],
    ['app/(modals)/draft-room.tsx', `<Redirect href="/draft" />`],
    ['app/+not-found.tsx', `router.replace('/')`],
    ...[...tabNames].flatMap(name => [
        ['components/entry.tsx', `<Link href="/${name}" />`],
        ['hooks/entry.ts', `router.push({ pathname: '/${name}' })`],
    ]),
])('rejects an unsafe tab entry in %s: %s', (file, text) => {
    expect(tabTreeViolations(file, text)).toHaveLength(1)
})
