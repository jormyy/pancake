const port = Number(Deno.env.get('R5B_PORT'))
const entry = Deno.env.get('R5B_ENTRY')!
const original = Deno.serve.bind(Deno)
// deno-lint-ignore no-explicit-any
;(Deno as any).serve = (first: any, second?: any) =>
  typeof first === 'function' ? original({ port }, first) : original({ port, ...first }, second)
await import(entry)
