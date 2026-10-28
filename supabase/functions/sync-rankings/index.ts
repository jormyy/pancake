Deno.serve(() => Response.json({ ok: false, error: 'Ranking sync is retired.' }, { status: 410 }))
