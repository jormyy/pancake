SELECT cron.schedule('league-inventory-hint-drain','30 seconds','SELECT private.flush_league_inventory_hints(1000)');
