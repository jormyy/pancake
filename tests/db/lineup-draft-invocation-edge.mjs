const deno=globalThis.Deno
const input=JSON.parse(deno.env.get('ACTION_INPUT'))
const OriginalRequest=globalThis.Request
globalThis.Request=class extends OriginalRequest {
  constructor(resource,options) {
    super(resource,options)
    if(new URL(this.url).pathname.startsWith('/functions/v1/')) {
      this.headers.set('x-pancake-invocation-id',input.invocationKey)
      this.headers.set('x-pancake-work-id',String(input.workItemId))
    }
  }
}
await import('./lineup-draft-http-edge.mjs')
