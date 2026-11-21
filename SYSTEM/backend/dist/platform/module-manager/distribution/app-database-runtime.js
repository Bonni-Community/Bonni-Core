import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import pg from 'pg';
import { moduleDatabaseDomain } from '../loader/module-database-runtime.js';
import { registerAppDatabaseClient, normalizePrismaConnectionString } from '../../../core/database/prisma.js';
import { getDataDomainConnectionString } from '../../../core/database/data-domain-routing.js';
import { getDatabaseWriteOrder, getDatabaseTargetConnectionString } from '../../../core/database/database-routing.js';
import { getActiveDatabaseRole } from '../../../core/database/database-context.js';
import { dataDomainForModule } from '../../../core/database/data-domains.js';
import { env } from '../../../core/config/env.js';
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const loaded = new Map();
async function helper() { return import(pathToFileURL(path.join(backendRoot, 'scripts/apps/app-database.mjs')).href); }
function connections(domain) {
    return getActiveDatabaseRole() === 'local'
        ? [getDataDomainConnectionString(domain, 'local', env.LOCAL_DATABASE_URL || '')]
        : getDatabaseWriteOrder().map(target => getDataDomainConnectionString(domain, target, getDatabaseTargetConnectionString(target)));
}
export async function prepareInstalledAppDatabase(appRoot, appId, delegates, manifest) {
    const domain = moduleDatabaseDomain(manifest.key, manifest);
    if (!domain)
        throw new Error('APP_DATABASE_DECLARATION_INVALID');
    const h = await helper(), data = await h.readAppDatabase(appRoot, appId);
    if (data.domain !== domain)
        throw new Error('APP_DATABASE_DOMAIN_DENIED');
    if (data.prismaVersion !== Prisma.prismaVersion.client)
        throw new Error('APP_DATABASE_CORE_VERSION_MISMATCH');
    const generated = await h.loadAppClient(appRoot, data);
    const models = new Set(generated.Prisma.dmmf.datamodel.models.map((m) => m.name[0].toLowerCase() + m.name.slice(1)));
    if (!delegates.length || delegates.some(d => !models.has(d)))
        throw new Error('APP_DATABASE_DELEGATES_MISSING');
    for (const url of new Set(connections(domain))) {
        const client = new pg.Client({ connectionString: normalizePrismaConnectionString(url), connectionTimeoutMillis: 15000 });
        try {
            await client.connect();
            await h.prepareAppSchema({ client, data });
        }
        finally {
            await client.end();
        }
    }
    return data;
}
export async function ensureAppDatabaseRuntime(appRoot, key, manifest, force = false) {
    const declaration = manifest?.metadata?.database;
    if (!declaration || declaration.mode === 'none')
        return;
    if (manifest?.key !== key)
        throw new Error('APP_DATABASE_DECLARATION_INVALID');
    const domain = moduleDatabaseDomain(key, manifest);
    if (!domain)
        return;
    if (!existsSync(path.join(appRoot, 'APP-DATABASE.json'))) {
        // App-owned declarative migrations are fingerprinted and validated before
        // any connection is opened. No privileged client is passed to app code.
        if (!declaration.schemaUpgrade)
            return;
        if (dataDomainForModule(key) !== domain)
            throw new Error('APP_DATABASE_DOMAIN_DENIED');
        const contract = await import(pathToFileURL(path.join(backendRoot, 'scripts/apps/app-schema-contract.mjs')).href);
        const upgrade = await import(pathToFileURL(path.join(backendRoot, 'scripts/apps/app-schema-upgrade.mjs')).href);
        const migration = await contract.readAppSchemaUpgrade(appRoot, key, declaration);
        for (const url of [...new Set(connections(domain))].reverse()) {
            const maintenance = contract.appSchemaUpgradeConnection(url, env.DATABASE_URL, domain);
            const client = new pg.Client({ connectionString: normalizePrismaConnectionString(maintenance), connectionTimeoutMillis: 15000 });
            let phase = 'database-connect';
            try {
                await client.connect();
                phase = 'schema-upgrade';
                const result = await upgrade.upgradeAppSchema(client, migration);
                console.info('[AppSchema] Datenbank-Erweiterung abgeschlossen', result);
            }
            catch (error) {
                if (error instanceof Error) {
                    const value = error;
                    const databaseTarget = getActiveDatabaseRole() === 'local' ? 'local' : getDatabaseWriteOrder().find(target => getDataDomainConnectionString(domain, target, getDatabaseTargetConnectionString(target)) === url) || 'configured';
                    value.diagnostic = { ...value.diagnostic, databaseDomain: domain, databaseTarget, connectionPhase: phase, migrationId: migration.id };
                }
                throw error;
            }
            finally {
                await client.end();
            }
        }
        return;
    }
    const h = await helper(), data = await h.readAppDatabase(appRoot, key.slice(4).toUpperCase());
    if (dataDomainForModule(key) !== domain)
        throw new Error('APP_DATABASE_DOMAIN_DENIED');
    if (data.domain !== domain)
        throw new Error('APP_DATABASE_DOMAIN_DENIED');
    if (!force && loaded.get(key)?.hash === data.modelsSha256)
        return;
    if (data.prismaVersion !== Prisma.prismaVersion.client)
        throw new Error('APP_DATABASE_CORE_VERSION_MISMATCH');
    const client = await h.loadAppClient(appRoot, data);
    await registerAppDatabaseClient(domain, client.PrismaClient, client.Prisma.dmmf.datamodel.models, client.Prisma);
    loaded.set(key, { hash: data.modelsSha256, domain });
}
export async function forgetAppDatabaseRuntime(key) {
    const value = loaded.get(key);
    loaded.delete(key);
    if (value?.domain)
        await registerAppDatabaseClient(value.domain, null, []);
}
