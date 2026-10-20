import { guardTarget, summarize } from './profile.ts'

Deno.test('target guards reject hosted, wrong-port, IPv6, and userinfo redirects before connecting', () => {
  for (const value of ['https://example.com:56321', 'http://127.0.0.1:54321', 'http://[::1]:56321', 'http://localhost@host.test:56321']) {
    let failed = false
    try { guardTarget(value, '56321') } catch { failed = true }
    if (!failed) throw Error(`Unsafe target accepted: ${value}`)
  }
  for (const value of ['http://127.0.0.1:56321','http://localhost:56321']) guardTarget(value, '56321')
  guardTarget('postgresql://postgres:local@127.0.0.1:56322/postgres', '56322')
})

Deno.test('summary retains cold outliers and uses nearest-rank p95', () => {
  const result = summarize([4,1,100,2,3])
  if (JSON.stringify(result) !== JSON.stringify({ median: 3,p95: 100,min: 1,max: 100,count: 5 })) throw Error('Outlier lost')
  if (summarize([]) !== null) throw Error('Empty samples must stay unknown')
})

Deno.test('only the published rankings selector permits an external POST', async () => {
  const {providerReadAllowed}=await import('./profile-handlers.ts')
  const form={method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'view=POINT_5'}
  if (!providerReadAllowed(new Request('https://hashtagbasketball.com/fantasy-basketball-dynasty-rankings',form))) throw Error('Published selector rejected')
  for (const url of ['https://example.test/fantasy-basketball-dynasty-rankings','https://hashtagbasketball.com/account']) {
    if (providerReadAllowed(new Request(url,form))) throw Error('External write permitted')
  }
  if (providerReadAllowed(new Request('https://example.test',{headers:{authorization:'private'}}))) throw Error('Credential-bearing request permitted')
})
