if (process.env.TRADE_BACKUP_PATH) await import('../db/trade-production-shaped.mjs')
if (process.env.E2E_TRADE_INCOMING_DESTINATIONS === '1') await import('./trade-incoming-destinations-webkit.mjs')
else await import('./trade-legality-webkit.mjs')
