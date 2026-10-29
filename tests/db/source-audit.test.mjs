import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sourceAudit } from '../../scripts/db-health/source-audit.mjs'

test('write review excludes locks and quoted text and keeps conflict and dynamic paths visible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pancake-source-audit-'))
  try {
    await writeFile(join(directory, 'fixture.sql'), `CREATE FUNCTION fixture() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM sample FOR UPDATE SKIP LOCKED;
  PERFORM id FROM sample FOR NO KEY UPDATE;
  PERFORM id FROM sample FOR KEY SHARE;
  RAISE NOTICE 'UPDATE sample SET value=1';
  -- UPDATE ignored SET value=1;
  UPDATE sample SET value=2 WHERE value IS DISTINCT FROM 2;
  INSERT INTO sample(id,value) VALUES(1,2) ON CONFLICT(id) DO UPDATE SET value=excluded.value;
  EXECUTE 'DELETE FROM sample';
  EXECUTE $command$UPDATE sample SET value=3$command$;
  SELECT * FROM sample;
END;
$$;`)
    const report = sourceAudit(directory)
    assert.equal(report.summary.writeSites, 2)
    assert.equal(report.summary.conflictUpdateSites, 1)
    assert.equal(report.summary.rowLockSites, 3)
    assert.equal(report.summary.functionsWithDynamicSql, 1)
    assert.equal(report.summary.selectStarSites, 1)
    assert.equal(report.functions[0].hasDistinctGate, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a comment or message cannot satisfy timeout or distinctness checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pancake-source-audit-'))
  try {
    await writeFile(join(directory, 'fixture.sql'), `CREATE FUNCTION fixture() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- SET lock_timeout='1s'; IS DISTINCT FROM
  RAISE NOTICE 'SET statement_timeout';
  UPDATE sample SET value=2;
END;
$$;`)
    const report = sourceAudit(directory)
    assert.equal(report.functions[0].hasDistinctGate, false)
    assert.equal(report.functions[0].hasLockTimeout, false)
    assert.equal(report.functions[0].hasStatementTimeout, false)
    assert.equal(report.summary.writeFunctionsWithoutDistinctGate, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
