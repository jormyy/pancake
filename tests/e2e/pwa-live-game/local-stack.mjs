import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { command } from '../../../scripts/perf-lab/process.mjs'
import { labRoot, project, json } from './common.mjs'
import { sql, restoreBackup, networkFenceSql } from './database.mjs'
import { batchBackupInserts } from '../ui-polish-backup.mjs'

function privateConfig(source, migrations = false) {
    return source.replace(/^project_id = .*$/m, `project_id = "${project}"`)
        .replace(/\b543(\d\d)\b/g, '649$1').replace('inspector_port = 8083', 'inspector_port = 64983')
        .replace(/(\[db.migrations\][\s\S]*?enabled = )(?:true|false)/, `$1${migrations}`)
        .replace(/(\[db.seed\][\s\S]*?enabled = )(?:true|false)/, '$1false')
}

export async function withLocalDatabase(action) {
    const config = 'supabase/config.toml'
    const original = (await command('git', ['show', 'HEAD:supabase/config.toml'])).stdout
    assert.equal(await readFile(config, 'utf8'), original, 'Refuse to replace a modified local stack config')
    const existing = await command('docker', ['ps', '-aq', '--filter', `label=com.supabase.cli.project=${project}`])
    assert.equal(existing.stdout.trim(), '', 'This project already has containers')
    await mkdir(labRoot, { recursive: true })
    const receipt = { started: new Date().toISOString(), project, host: 'local Mac Docker Desktop', concurrentOtherLanes: false, cleanup: false }
    let attempted = false
    let network = false
    try {
        await writeFile(config, privateConfig(original))
        await command('docker', ['network', 'create', '--label', `com.supabase.cli.project=${project}`, project])
        network = true
        attempted = true
        console.log('Starting local project pt4bafablec1 on 649xx.')
        await command('supabase', ['start', '--network-id', project, '-x', 'studio,imgproxy,vector,logflare,supavisor,edge-runtime,postgres-meta,mailpit'], { timeout: 300000 })
        await command('docker', ['update', '--cpus=2', '--memory=1g', '--memory-swap=1g', `supabase_db_${project}`])
        for (const setting of ["shared_buffers='224MB'", "effective_cache_size='384MB'", "cron.launch_active_jobs='off'", "auto_explain.log_min_duration='-1'", "log_statement='none'", "log_min_duration_statement='-1'"]) await sql(`ALTER SYSTEM SET ${setting};`)
        await command('docker', ['restart', `supabase_db_${project}`])
        for (let attempt = 0; attempt < 120; attempt++) {
            if ((await command('docker', ['exec', `supabase_db_${project}`, 'pg_isready', '-U', 'postgres'], { allowFailure: true })).code === 0) break
            await delay(500)
        }
        await sql(networkFenceSql)
        const attestation = JSON.parse(await readFile('tests/e2e/db-security-catalog-attestations.json', 'utf8')).preMigration
        const migrations = (await readdir('supabase/migrations')).filter(file => /^\d{14}_[a-z0-9_]+\.sql$/.test(file) && file.slice(0, 14) <= attestation.version).sort()
        assert.equal(migrations.length, attestation.count)
        const baseline = path.join(labRoot, 'schema-baseline')
        await mkdir(path.join(baseline, 'supabase/migrations'), { recursive: true })
        try {
            await writeFile(path.join(baseline, 'supabase/config.toml'), privateConfig(original, true))
            for (const file of migrations) await cp(path.join('supabase/migrations', file), path.join(baseline, 'supabase/migrations', file))
            console.log('Applying the backup schema baseline.')
            await command('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', baseline], { timeout: 300000 })
        } finally { await rm(baseline, { recursive: true, force: true }) }
        const backup = path.join(labRoot, 'backup')
        await mkdir(backup, { recursive: true })
        const source = path.join(homedir(), 'Documents/pancake-db-backup-2026-10-28')
        for (const file of ['schema.sql', 'data.sql']) await cp(path.join(source, file), path.join(backup, file))
        await writeFile(path.join(backup, 'data.sql'), batchBackupInserts(await readFile(path.join(backup, 'data.sql'), 'utf8'), 50))
        console.log('Restoring the private production-shaped backup.')
        receipt.backup = await restoreBackup(backup)
        await rm(backup, { recursive: true, force: true })
        await writeFile(config, privateConfig(original, true))
        console.log('Applying the remaining committed migrations.')
        await command('supabase', ['migration', 'up', '--local', '--include-all'], { timeout: 300000 })
        await sql(networkFenceSql)
        await sql('SELECT cron.unschedule(jobid) FROM cron.job;')
        await sql("ALTER SYSTEM SET pg_stat_statements.track='all';")
        await sql('SELECT pg_reload_conf();')
        await command('docker', ['restart', `supabase_rest_${project}`, `supabase_auth_${project}`, `supabase_realtime_${project}`])
        await delay(2000)
        receipt.limits = JSON.parse(await sql("SELECT json_build_object('shared_buffers',current_setting('shared_buffers'),'effective_cache_size',current_setting('effective_cache_size'))"))
        receipt.containerLimits = JSON.parse((await command('docker', ['inspect', '--format', '{{json .HostConfig}}', `supabase_db_${project}`])).stdout)
        receipt.containerLimits = { cpus: receipt.containerLimits.NanoCpus / 1e9, memory: receipt.containerLimits.Memory }
        assert.deepEqual(receipt.containerLimits, { cpus: 2, memory: 1073741824 })
        assert.deepEqual(receipt.limits, { shared_buffers: '224MB', effective_cache_size: '384MB' })
        await json(path.join(labRoot, 'local-stack.json'), receipt)
        await action()
    } catch (error) { receipt.failure = error.message; throw error }
    finally {
        const failures = []
        if (attempted) {
            try { await command('supabase', ['stop', '--project-id', project, '--no-backup'], { timeout: 120000 }) } catch (error) { failures.push(error.message) }
        }
        if (network) {
            const removal = await command('docker', ['network', 'rm', project], { allowFailure: true })
            if (removal.code && !removal.stderr.includes('not found')) failures.push(removal.stderr)
        }
        await writeFile(config, original)
        await rm(path.join(labRoot, 'backup'), { recursive: true, force: true })
        await rm(path.join(labRoot, 'seed'), { recursive: true, force: true })
        await rm(path.join(labRoot, 'ready.json'), { force: true })
        receipt.cleanup = failures.length === 0
        receipt.cleanupErrors = failures
        receipt.finished = new Date().toISOString()
        await json(path.join(labRoot, 'local-stack.json'), receipt)
        if (failures.length) throw new Error(`Private cleanup failed: ${failures.join('; ')}`)
    }
}
