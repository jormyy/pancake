const path = require('node:path')
const { readFileSync, readdirSync } = require('node:fs')
const ts = require('typescript')

const sourceDirectories = ['app', 'components', 'constants', 'hooks', 'lib', 'contexts']
const iconProps = new Set(['icon', 'leftIcon', 'rightIcon', 'iconLeft', 'iconRight'])

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(file) : /\.tsx?$/.test(entry.name) ? [file] : []
  })
}

function collectMaterialIconNames(root, files = sourceDirectories.flatMap(directory => sourceFiles(path.join(root, directory)))) {
  const glyphFile = require.resolve('@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/MaterialIcons.json', { paths: [root] })
  const glyphs = JSON.parse(readFileSync(glyphFile, 'utf8'))
  const configFile = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
  const program = ts.createProgram(files, { ...config.options, noEmit: true, skipLibCheck: true })
  const checker = program.getTypeChecker()
  const names = new Set()
  const allGlyphs = Object.keys(glyphs).length

  const literalNames = type => {
    const value = checker.getNonNullableType(type)
    const parts = value.isUnion() ? value.types : [value]
    return parts.every(part => part.isStringLiteral() && glyphs[part.value] !== undefined)
      ? parts.map(part => part.value) : null
  }
  const addType = type => {
    const values = literalNames(type)
    if (!values) return false
    if (values.length < allGlyphs) values.forEach(name => names.add(name))
    return true
  }
  const addValue = node => {
    if (ts.isStringLiteralLike(node)) {
      if (glyphs[node.text] === undefined) throw new Error(`Unknown MaterialIcons name: ${node.text}`)
      names.add(node.text)
      return true
    }
    if (ts.isJsxExpression(node)) return !node.expression || addValue(node.expression)
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return addValue(node.expression)
    if (ts.isConditionalExpression(node)) return addValue(node.whenTrue) && addValue(node.whenFalse)
    if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true
    return addType(checker.getTypeAtLocation(node))
  }

  for (const file of files) {
    const source = program.getSourceFile(file)
    const components = new Set()
    const namespaces = new Set()
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const module = statement.moduleSpecifier.text
      const clause = statement.importClause
      if (module === '@expo/vector-icons/MaterialIcons' && clause?.name) components.add(clause.name.text)
      if (module !== '@expo/vector-icons') continue
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) namespaces.add(clause.namedBindings.name.text)
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const specifier of clause.namedBindings.elements) {
          if ((specifier.propertyName ?? specifier.name).text === 'MaterialIcons') components.add(specifier.name.text)
        }
      }
    }
    const isMaterialIcons = tag => ts.isIdentifier(tag) ? components.has(tag.text)
      : ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression)
        && namespaces.has(tag.expression.text) && tag.name.text === 'MaterialIcons'
    const inspect = node => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const material = isMaterialIcons(node.tagName)
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxSpreadAttribute(attribute)) {
            if (material) {
              const type = checker.getTypeAtLocation(attribute.expression)
              const name = type.getProperty('name')
              if (name && !addType(checker.getTypeOfSymbolAtLocation(name, attribute))) {
                throw new Error(`MaterialIcons spread needs literal name choices: ${file}`)
              }
            }
            continue
          }
          const prop = attribute.name.getText(source)
          if (!attribute.initializer || !iconProps.has(prop) && prop !== 'name') continue
          const symbol = checker.getSymbolAtLocation(attribute.name)
          const expression = ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : attribute.initializer
          const contextual = expression && checker.getContextualType(expression)
          const values = contextual ? literalNames(contextual) : symbol && literalNames(checker.getTypeOfSymbolAtLocation(symbol, attribute))
          const direct = material && prop === 'name'
          if (!direct && (!values || prop === 'name' && values.length !== allGlyphs)) continue
          if (!addValue(attribute.initializer)) throw new Error(`Icon prop needs literal name choices: ${file}:${prop}`)
        }
      }
      if (ts.isPropertyAssignment(node) && iconProps.has(node.name.getText(source).replace(/^['"]|['"]$/g, ''))) {
        const contextual = checker.getContextualType(node.parent)
        const property = contextual?.getProperty(node.name.getText(source).replace(/^['"]|['"]$/g, ''))
        if (property && literalNames(checker.getTypeOfSymbolAtLocation(property, node))) addValue(node.initializer)
      }
      if (ts.isBindingElement(node) && node.initializer) {
        const values = literalNames(checker.getTypeAtLocation(node.name))
        if (values && (iconProps.has((node.propertyName ?? node.name).getText(source)) || values.length === allGlyphs)) addValue(node.initializer)
      }
      if (ts.isReturnStatement(node) && node.expression) {
        let parent = node.parent
        while (parent && !ts.isFunctionLike(parent)) parent = parent.parent
        if (parent?.type && literalNames(checker.getTypeFromTypeNode(parent.type))?.length === allGlyphs) {
          if (!addValue(node.expression)) throw new Error(`Icon return needs literal name choices: ${file}`)
        }
      }
      ts.forEachChild(node, inspect)
    }
    inspect(source)
  }
  return Object.fromEntries([...names].sort().map(name => [name, glyphs[name]]))
}

module.exports = { collectMaterialIconNames }

if (require.main === module) {
  process.stdout.write(JSON.stringify(collectMaterialIconNames(path.resolve(path.dirname(module.filename), '../..')), null, 2) + '\n')
}
