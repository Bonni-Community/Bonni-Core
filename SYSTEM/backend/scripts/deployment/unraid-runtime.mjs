import {spawn} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';

import {createRuntimeProxy} from './proxy.mjs';
import {unraidSetup, validAdminPassword} from './unraid-setup.mjs';

const data = '/bonni-data';
const stateFile = path.join(data, 'installation.json');
const postgres = path.join(data, 'postgres');
const bootstrapSecrets = '/tmp/bonni-postgres';
const postgresBin = '/usr/local/pgsql/bin';
const databasePort = 5432;
const publicPort = 4000;
const activePort = 4100;
const emergencyPort = 4199;
const version = process.env.BONNI_CORE_IMAGE_VERSION;
const activeUser = {uid: 1000, gid: 1000};
const postgresUser = {uid: 1001, gid: 1001};
const emergencyUser = {uid: 1002, gid: 1000};
const dataVersion = 1;
const hexSecret = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f-]{36}$/;
const secret = () => randomBytes(32).toString('hex');
const children = new Set();
const stopping = new AbortController();

function start(command, args, {env = {}, user = {}, ...options} = {}) {
  const child = spawn(command, args, {
    cwd: '/app/backend',
    env: {PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: process.env.TZ, ...env},
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
    ...user,
    ...options,
  });
  const task = {child, done: false};
  children.add(task);
  task.exit = new Promise(resolve => {
    child.once('error', () => resolve(1));
    child.once('close', (code, signal) => resolve(code ?? signal));
  }).then(result => {
    task.done = true;
    children.delete(task);
    return result;
  });
  return task;
}

async function run(command, args, options) {
  const result = await start(command, args, options).exit;
  if (result !== 0) throw Error(`START_FAILED: ${path.basename(command)} (${result})`);
}

async function directory(name, mode, user = {uid: 0, gid: 0}) {
  await fs.mkdir(name, {mode}).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const stat = await fs.lstat(name);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('UNRAID_DATA_PATH_INVALID');
  if (stat.uid !== user.uid || stat.gid !== user.gid) await fs.chown(name, user.uid, user.gid);
  if ((stat.mode & 0o777) !== mode) await fs.chmod(name, mode);
}

async function loadState() {
  const handle = await fs.open(stateFile, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o077) || stat.size > 8192) {
      throw Error('UNRAID_STATE_FILE_INVALID');
    }
    const state = JSON.parse(await handle.readFile('utf8'));
    if (!state || state.format !== dataVersion || state.version !== version
      || !['initializing', 'ready'].includes(state.phase)
      || !['postgres', 'active', 'emergency', 'master', 'jwt', 'module', 'gateway'].every(key => hexSecret.test(state[key]))
      || !['serial', 'organization', 'site', 'node'].every(key => uuid.test(state[key]))
      || (state.phase === 'initializing' && !validAdminPassword(state.admin))) {
      throw Error('UNRAID_STATE_INVALID_OR_DIFFERENT_IMAGE_VERSION');
    }
    return state;
  } finally {
    await handle.close();
  }
}

async function saveState(state) {
  const temporary = await fs.mkdtemp(path.join(data, '.state-'));
  try {
    const handle = await fs.open(path.join(temporary, 'state'), 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(state) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(path.join(temporary, 'state'), stateFile);
    const parent = await fs.open(data);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await fs.rm(temporary, {recursive: true, force: true});
  }
}

async function initializePostgres(state) {
  const stat = await fs.lstat(postgres).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat) {
    if (!stat.isDirectory() || stat.uid !== postgresUser.uid
      || (await fs.readFile(path.join(postgres, 'PG_VERSION'), 'utf8')).trim() !== '16') {
      throw Error('UNRAID_POSTGRES_DATA_INVALID');
    }
    return;
  }
  if (state.phase !== 'initializing') throw Error('UNRAID_POSTGRES_DATA_MISSING');
  const temporary = await fs.mkdtemp(path.join(data, '.postgres-'));
  const passwordDirectory = await fs.mkdtemp(path.join(bootstrapSecrets, '.password-'));
  const passwordFile = path.join(passwordDirectory, 'password');
  try {
    await fs.chown(temporary, postgresUser.uid, postgresUser.gid);
    await fs.chown(passwordDirectory, postgresUser.uid, postgresUser.gid);
    await fs.writeFile(passwordFile, state.postgres + '\n', {flag: 'wx', mode: 0o600});
    await fs.chown(passwordFile, postgresUser.uid, postgresUser.gid);
    await run(path.join(postgresBin, 'initdb'), [
      '-D', temporary, '--locale=C', '--encoding=UTF8', '--auth=scram-sha-256',
      '--username=postgres', `--pwfile=${passwordFile}`,
    ], {user: postgresUser});
    await fs.rename(temporary, postgres);
  } finally {
    await fs.rm(passwordDirectory, {recursive: true, force: true});
    await fs.rm(temporary, {recursive: true, force: true});
  }
}

async function waitUntil(probe, deadline, label) {
  while (!stopping.signal.aborted && Date.now() < deadline) {
    if (await probe()) return;
    await delay(500);
  }
  throw Error(label);
}

async function prepareDatabase(state, server) {
  let connection;
  await waitUntil(async () => {
    if (server.done) throw Error('UNRAID_POSTGRES_STOPPED');
    const client = new pg.Client({
      host: '127.0.0.1', port: databasePort, user: 'postgres', password: state.postgres,
      database: 'postgres', connectionTimeoutMillis: 1000,
    });
    try {
      await client.connect();
      connection = client;
      return true;
    } catch {
      await client.end().catch(() => {});
      return false;
    }
  }, Date.now() + 60_000, 'UNRAID_POSTGRES_NOT_READY');

  try {
    if (state.phase === 'ready') return;
    // Only generated hex secrets are interpolated. Each initialization step can
    // safely be retried after a power loss without replacing existing data.
    for (const [name, password] of [['bonni', state.active], ['bonni_readonly', state.emergency]]) {
      const exists = await connection.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
      if (exists.rowCount === 0) await connection.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`);
    }
    await connection.query('GRANT pg_read_all_data TO bonni_readonly');
    await connection.query("ALTER ROLE bonni_readonly SET default_transaction_read_only = on");
    const exists = await connection.query('SELECT 1 FROM pg_database WHERE datname = $1', ['bonni_core']);
    if (exists.rowCount === 0) await connection.query('CREATE DATABASE bonni_core OWNER bonni');
  } finally {
    await connection.end();
  }
}

function applicationEnv(state, runtimeRoot) {
  return {
    NODE_ENV: 'production',
    BONNI_DEPLOYMENT_MODE: 'unraid-single-container',
    SYSTEM_VERSION: version,
    BONNI_CORE_IMAGE_VERSION: version,
    BONNI_PROJECT_ROOT: '/app',
    BONNI_PRODUCT_ROOT: data,
    RUN_SYSTEM_ROOT: runtimeRoot,
    BONNI_STORAGE_ROOT: path.join(data, 'storage'),
    BONNI_LOG_ROOT: path.join(runtimeRoot, 'logs'),
    BONNI_LICENSE_ROOT: path.join(data, 'run-system/storage/licenses'),
    BONNI_CORE_LICENSE_SEED_ROOT: '/app/licenses',
    BONNI_CORE_LICENSE_PREDECESSOR_SEED_ROOT: '/app/license-predecessors',
    BONNI_MODULE_PACKAGE_ROOT: path.join(data, 'extensions'),
    BONNI_UPDATE_STATE_ROOT: path.join(data, 'update'),
    FRONTEND_DIST_ROOT: '/app/public',
    MEDIA_STORAGE_ROOT: path.join(data, 'storage/media'),
    MASTER_KEY: state.master,
    JWT_SECRET: state.jwt,
    BONNI_SERIAL: state.serial,
    BONNI_ORGANIZATION_ID: state.organization,
    BONNI_TENANT_ID: state.organization,
    BONNI_SITE_ID: state.site,
    BONNI_NODE_ID: state.node,
    EXPRESS_TRUST_PROXY_HOPS: '1',
    SYSTEM_SERVER_BIND: '127.0.0.1',
    LOCAL_AUTH_BIND: '127.0.0.1',
    LOCAL_AUTH_PORT: '4101',
  };
}

function supervise(label, command, args, options) {
  const launch = () => {
    const task = start(command, args, options);
    void task.exit.then(async () => {
      if (stopping.signal.aborted) return;
      console.error(`[Bonni] ${label} beendet. Neustart in fünf Sekunden.`);
      await delay(5_000, undefined, {signal: stopping.signal}).catch(() => {});
      if (!stopping.signal.aborted) launch();
    });
  };
  launch();
}

async function isReady(port, route = '/api/health/ready') {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {signal: AbortSignal.timeout(1500)});
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  let state = await loadState();
  if (!state) {
    const existing = await fs.readdir(data);
    if (existing.some(name => name !== 'lost+found' && !/^\.state-[a-zA-Z0-9]{6}$/.test(name))) {
      throw Error('UNRAID_REQUIRES_EMPTY_NEW_DATA_DIRECTORY');
    }
  }
  let proxy;
  const connections = new Set();
  let startInstallation;
  const accepted = new Promise(resolve => { startInstallation = resolve; });
  const setup = state ? null : unraidSetup({
    logo: await fs.readFile(new URL('./bonni-unraid.png', import.meta.url)),
    designSource: await fs.readFile(new URL('./unraid-setup-design.html', import.meta.url), 'utf8'),
    version,
    async savePassword(admin) {
      const next = {
        format: dataVersion, version, phase: 'initializing', admin,
        postgres: secret(), active: secret(), emergency: secret(),
        master: secret(), jwt: secret(), module: secret(), gateway: secret(),
        serial: randomUUID(), organization: randomUUID(), site: randomUUID(), node: randomUUID(),
      };
      await saveState(next);
      state = next;
    },
    onSetup: startInstallation,
    onError: () => console.error('[Bonni] Einrichtung konnte nicht dauerhaft gespeichert werden.'),
  });
  const web = createServer({requestTimeout: 10_000, headersTimeout: 8_000}, (req, res) => {
    if (proxy) {
      proxy.emit('request', req, res);
    } else if (setup) {
      void setup.request(req, res);
    } else {
      res.writeHead(503, {'Retry-After': '3'});
      res.end('Bonni Core wird gestartet.');
    }
  });
  web.on('upgrade', (req, socket, head) => {
    if (proxy) proxy.emit('upgrade', req, socket, head);
    else socket.destroy();
  });
  web.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  await new Promise((resolve, reject) => {
    web.once('error', reject);
    web.listen(publicPort, '0.0.0.0', resolve);
  });
  stopping.signal.addEventListener('abort', () => {
    web.close();
    for (const socket of connections) socket.destroy();
    startInstallation();
  }, {once: true});
  if (setup) {
    console.log('[Bonni] Öffne in Unraid unter Docker die WebUI von Bonni Core.');
    console.log(`[Bonni] Einrichtungscode: ${setup.token}`);
    await accepted;
    if (stopping.signal.aborted) return;
  }

  setup?.setPhase('database');
  await directory(data, 0o711);
  await directory(bootstrapSecrets, 0o700, postgresUser);
  await initializePostgres(state);
  const database = start(path.join(postgresBin, 'postgres'), [
    '-D', postgres, '-h', '127.0.0.1', '-k', '', '-p', String(databasePort),
  ], {user: postgresUser});
  database.signal = 'SIGINT';
  void database.exit.then(() => {
    if (!stopping.signal.aborted) {
      console.error('[Bonni] PostgreSQL wurde unerwartet beendet.');
      process.exitCode = 1;
      stopping.abort();
    }
  });
  await prepareDatabase(state, database);

  const runSystem = path.join(data, 'run-system');
  const readOnlySystem = path.join(data, 'emergency');
  for (const name of ['run-system', 'storage', 'extensions', 'update']) {
    await directory(path.join(data, name), 0o750, activeUser);
  }
  await directory(readOnlySystem, 0o750, emergencyUser);
  await directory(path.join(runSystem, 'system'), 0o750, activeUser);
  await directory(path.join(runSystem, 'system/emergency'), 0o750, activeUser);
  const activeUrl = `postgresql://bonni:${state.active}@127.0.0.1:${databasePort}/bonni_core?schema=public`;
  const emergencyUrl = `postgresql://bonni_readonly:${state.emergency}@127.0.0.1:${databasePort}/bonni_core?schema=public`;
  const activeEnv = {
    ...applicationEnv(state, runSystem),
    DATABASE_URL: activeUrl, PORT: String(activePort), SYSTEM_SLOT_NAME: 'backend-active',
    SYSTEM_SLOT_ROLE: 'active', MODULE_PRIVATE_DATA_SECRET: state.module,
    BONNI_GATEWAY_INTERNAL_SECRET: state.gateway,
  };
  if (state.phase === 'initializing') {
    setup?.setPhase('account');
    await run('node', ['scripts/runtime/bootstrap-production-database.mjs'], {
      user: activeUser, env: {
        ...activeEnv, SYSTEM_SLOT_ROLE: 'installer',
        BONNI_BOOTSTRAP_FIRST_INSTALL_ONLY: 'true', BONNI_BOOTSTRAP_ADMIN_PASSWORD: state.admin,
      },
    });
    const {admin, ...completed} = state;
    state = {...completed, phase: 'ready'};
    await saveState(state);
  }
  if (stopping.signal.aborted) return;

  setup?.setPhase('startup');
  const emergencyEnv = {
    ...applicationEnv(state, readOnlySystem),
    DATABASE_URL: emergencyUrl, PORT: String(emergencyPort), SYSTEM_SLOT_NAME: 'backend-emergency',
    SYSTEM_SLOT_ROLE: 'emergency', SYSTEM_RUNTIME_SOURCE: 'json',
    TIMECAPSULE_EMERGENCY_MODE: 'true', RUNCONTAINER_ROOT: path.join(runSystem, 'system'),
  };
  const activeOptions = {user: activeUser, env: activeEnv};
  for (const script of [
    'scripts/backup/restore-pending.mjs',
    'scripts/runtime/local-source-update-start-gate.mjs',
    'scripts/runtime/seed-core-license-catalog.mjs',
    'scripts/maintenance/cleanup-stale-technical-data.mjs',
    'scripts/auth/ensure-jwt-secret.mjs',
  ]) {
    if (stopping.signal.aborted) return;
    await run('node', [script], activeOptions);
  }
  if (stopping.signal.aborted) return;
  supervise('Backend 1', 'node', ['dist/system/server/run-server.js'], activeOptions);
  supervise('Backend 2', 'node', ['dist/system/server/redundant-server.js'], {
    user: emergencyUser, env: emergencyEnv,
  });
  await waitUntil(async () => await isReady(activePort) && await isReady(emergencyPort),
    Date.now() + 180_000, 'UNRAID_BACKENDS_NOT_READY');
  proxy = createRuntimeProxy({
    active: {hostname: '127.0.0.1', port: activePort},
    emergency: {hostname: '127.0.0.1', port: emergencyPort},
  });
  web.requestTimeout = 300_000;
  web.headersTimeout = 60_000;
  console.log('[Bonni] Bonni Core ist bereit.');
  if (!stopping.signal.aborted) {
    await new Promise(resolve => stopping.signal.addEventListener('abort', resolve, {once: true}));
  }
}

async function stop(task) {
  if (task.done) return;
  const signal = name => {
    if (!task.child.pid) return;
    try {
      process.kill(task.signal ? task.child.pid : -task.child.pid, name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  signal(task.signal ?? 'SIGTERM');
  const timeout = setTimeout(() => signal('SIGKILL'), 25_000);
  try {
    await task.exit;
  } finally {
    clearTimeout(timeout);
  }
}

if (process.argv.includes('--health')) {
  process.exitCode = await isReady(publicPort, '/runtime-proxy/active-health')
    && await isReady(publicPort, '/runtime-proxy/emergency-health') ? 0 : 1;
} else {
  process.once('SIGTERM', () => stopping.abort());
  process.once('SIGINT', () => stopping.abort());
  try {
    await main();
  } catch (error) {
    if (!stopping.signal.aborted) {
      console.error('[Bonni] Start fehlgeschlagen:', error.code ?? error.message);
      process.exitCode = 1;
    }
  } finally {
    stopping.abort();
    const running = [...children];
    await Promise.all(running.filter(task => !task.signal).map(stop));
    await Promise.all(running.filter(task => task.signal).map(stop));
  }
}
