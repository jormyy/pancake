const message = 'Read roster location and limits through lib/roster-capacity (rosterLocation/partitionRoster/rosterLimits); inline is_on_ir/is_on_taxi checks counted taxi players as active in PR #5.'
const names = 'is_on_ir|is_on_taxi|roster_size|ir_slots|taxi_slots'

module.exports = {
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'hooks/**/*.{ts,tsx}', 'contexts/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    ignores: ['lib/roster-capacity.ts', 'lib/league.ts', 'lib/commissioner-settings-draft.ts'],
    restrictedSyntax: [
        `MemberExpression[property.name=/^(${names})$/]:not(AssignmentExpression > MemberExpression.left)`,
        `MemberExpression[computed=true][property.value=/^(${names})$/]:not(AssignmentExpression > MemberExpression.left)`,
        `ObjectPattern > Property[key.name=/^(${names})$/]`,
        `ObjectPattern > Property[key.value=/^(${names})$/]`,
        `MemberExpression[computed=true][property.type="TemplateLiteral"][property.expressions.length=0][property.quasis.0.value.cooked=/^(${names})$/]:not(AssignmentExpression > MemberExpression.left)`,
    ].map(selector => ({ selector, message })),
}
