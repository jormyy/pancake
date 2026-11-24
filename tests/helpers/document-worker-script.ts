import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as tokens from '@/constants/tokens'

export function documentWorkerScript(): string {
    const source = readFileSync('app/+html.tsx', 'utf8')
    const tree = ts.createSourceFile('app/+html.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const declarations = tree.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations)
    const declaration = declarations.find(item => ts.isIdentifier(item.name) && item.name.text === 'SW_REGISTER')
    if (!declaration?.initializer) throw new Error('The document worker script is missing.')
    const context: Record<string, unknown> = { ...tokens, process: { env: { NODE_ENV: 'production' } } }
    for (const helper of declarations) {
        if (!ts.isIdentifier(helper.name) || !helper.initializer || !ts.isArrowFunction(helper.initializer)) continue
        context[helper.name.text] = runInNewContext(ts.transpile(`(${helper.initializer.getText(tree)})`, { target: ts.ScriptTarget.ES2022 }), context)
    }
    return runInNewContext(`(${declaration.initializer.getText(tree)})`, context)
}
