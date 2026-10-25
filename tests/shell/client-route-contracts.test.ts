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

it('never pushes or replaces a tab tree from a root route', () => {
    const violations: string[] = []
    for (const file of files('app').filter(file => file.endsWith('.tsx') && !file.includes('(tabs)') && !file.includes('(auth)') && !file.endsWith('_layout.tsx') && !file.endsWith('+not-found.tsx'))) {
        const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node)) {
                const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : ''
                const href = node.arguments[0]
                const target = href && ts.isObjectLiteralExpression(href) ? href.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'pathname') : href
                const value = target && ts.isPropertyAssignment(target) ? target.initializer : target
                if (['push', 'replace'].includes(name) && value && ts.isStringLiteralLike(value) && /^\/(?:\(tabs\)(?:\/|$)|(?:roster|players|league|trades)(?:[/?]|$))/.test(value.text)) violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
            }
            ts.forEachChild(node, visit)
        }
        visit(source)
    }
    expect(violations).toEqual([])
})
