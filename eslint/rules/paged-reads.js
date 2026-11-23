const MAX_ROWS = 1000
const FIX = 'PostgREST caps at max_rows=1000 silently; use fetchAllPages (95105bcc, d9dc6d7d).'
const LARGE_TABLE_BOUNDING_KEYS = {
  players: new Set(['id', 'nba_id', 'sleeper_id', 'sportsdata_id']),
  player_game_stats: new Set(['id', 'game_id']),
  nba_games: new Set(['id', 'nba_game_id', 'game_date', 'week_number']),
  backfill_game_attempts: new Set(['id', 'game_key']),
}
const ROW_BOUNDS = new Set(['range', 'limit', 'single', 'maybeSingle', 'in'])

const methodName = (call) => call.callee.type === 'MemberExpression' && !call.callee.computed ? call.callee.property.name : null
const literal = (node) => node?.type === 'Literal' ? node.value : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined
const isFunction = (node) => node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'
const isLoop = (node) => ['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'].includes(node.type)

function insideLoop(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunction(current)) return false
    if (isLoop(current)) return true
  }
  return false
}

function pageSizedArithmetic(node) {
  if (node?.type !== 'BinaryExpression') return false
  const side = (operand) => (operand.type === 'Literal' && typeof operand.value === 'number' && operand.value >= MAX_ROWS - 1) || pageSizedArithmetic(operand)
  return side(node.left) || side(node.right)
}

function chainAbove(call) {
  const calls = []
  let top = call
  while (top.parent?.type === 'MemberExpression' && top.parent.object === top && top.parent.parent?.type === 'CallExpression' && top.parent.parent.callee === top.parent) {
    top = top.parent.parent
    calls.push(top)
  }
  return { calls, top }
}

function bounded(call, keys) {
  const name = methodName(call)
  if (ROW_BOUNDS.has(name)) return true
  return name === 'eq' && keys.has(literal(call.arguments[0]))
}

function countsOnly(select) {
  const options = select.arguments[1]
  return options?.type === 'ObjectExpression' && options.properties.some((property) => property.type === 'Property' && (property.key.name ?? property.key.value) === 'head' && property.value.value === true)
}

function continuedElsewhere(top) {
  const parent = top.parent
  return (parent.type === 'VariableDeclarator' && parent.init === top) || (parent.type === 'AssignmentExpression' && parent.right === top)
}

module.exports = {
  meta: {
    type: 'problem',
    messages: {
      limit: `.limit({{count}}) still returns at most ${MAX_ROWS} rows. ${FIX}`,
      span: `.range({{from}}, {{to}}) asks for more than ${MAX_ROWS} rows. ${FIX}`,
      loop: `Hand-rolled .range() page loop. ${FIX}`,
      unpaged: `Unpaged read of {{table}} stops at ${MAX_ROWS} rows. ${FIX}`,
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = methodName(node)
        if (name === 'limit') {
          const count = literal(node.arguments[0])
          if (typeof count === 'number' && count > MAX_ROWS) context.report({ node, messageId: 'limit', data: { count } })
          return
        }
        if (name === 'range') {
          const from = literal(node.arguments[0])
          const to = literal(node.arguments[1])
          if (typeof from === 'number' && typeof to === 'number' && to - from + 1 > MAX_ROWS) context.report({ node, messageId: 'span', data: { from, to } })
          else if (insideLoop(node) || node.arguments.some(pageSizedArithmetic)) context.report({ node, messageId: 'loop' })
          return
        }
        if (name !== 'select' || node.callee.object.type !== 'CallExpression' || methodName(node.callee.object) !== 'from') return
        const table = literal(node.callee.object.arguments[0])
        const keys = Object.hasOwn(LARGE_TABLE_BOUNDING_KEYS, table) ? LARGE_TABLE_BOUNDING_KEYS[table] : null
        if (!keys || countsOnly(node)) return
        const { calls, top } = chainAbove(node)
        if (calls.some((call) => bounded(call, keys)) || continuedElsewhere(top)) return
        context.report({ node, messageId: 'unpaged', data: { table } })
      },
    }
  },
}
