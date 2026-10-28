import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as tokens from '@/constants/tokens'

export function documentWorkerScript(): string {
    const source = readFileSync('app/+html.tsx', 'utf8')
    const tree = ts.createSourceFile('app/+html.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const declaration = tree.statements.filter(ts.isVariableStatement)
        .flatMap(statement => statement.declarationList.declarations)
        .find(item => ts.isIdentifier(item.name) && item.name.text === 'SW_REGISTER')
    if (!declaration?.initializer) throw new Error('The document worker script is missing.')
    return runInNewContext(`(${declaration.initializer.getText(tree)})`, { ...tokens, process: { env: { NODE_ENV: 'production' } } })
}
