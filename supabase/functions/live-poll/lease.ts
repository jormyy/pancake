export async function renewLivePollLease(renew: (timeoutMs: number) => Promise<boolean>, deadline = Date.now() + 15300): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Live lease renewal deadline passed')
    try {
      return await renew(Math.min(5000, remaining))
    } catch (error) {
      const failure = error as { message?: string; code?: string; status?: number } | null
      const temporary = failure && (['502', '503', '504'].includes(failure.code ?? '')
        || [502, 503, 504].includes(failure.status ?? 0)
        || failure.message === 'An invalid response was received from the upstream server')
      if (!temporary || attempt >= 2 || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, Math.min(100 * 2 ** attempt, deadline - Date.now())))
    }
  }
}
