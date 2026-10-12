import crypto from "node:crypto";
import { spawn } from "node:child_process";

const ROLE_PATTERN = /^bonni_candidate_[a-f0-9]{24}$/u;
const DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const ROLE_MARKER_PREFIX = "bonni-development-test-role/v1:";
const MAX_OUTPUT_BYTES = 256_000;
const MAX_ERROR_BYTES = 12_000;

export class DevelopmentTestDatabaseRoleError extends Error {
  constructor(code, detail = "", cause = undefined) {
    super(detail ? `${code}:${detail}` : code, cause ? { cause } : undefined);
    this.name = "DevelopmentTestDatabaseRoleError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", cause = undefined) {
  throw new DevelopmentTestDatabaseRoleError(code, detail, cause);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseDatabaseUrl(raw, label) {
  const text = String(raw || "").trim();
  if (!text) fail("DEVELOPMENT_TEST_DATABASE_ROLE_DATABASE_URL_REQUIRED", label);
  let connection;
  try {
    connection = new URL(text);
  } catch (error) {
    fail("DEVELOPMENT_TEST_DATABASE_ROLE_DATABASE_URL_INVALID", label, error);
  }
  if (!new Set(["postgres:", "postgresql:"]).has(connection.protocol)) {
    fail("DEVELOPMENT_TEST_DATABASE_ROLE_DATABASE_URL_INVALID", "postgresql-required");
  }
  let databaseName;
  try {
    databaseName = decodeURIComponent(connection.pathname.replace(/^\//u, ""));
  } catch (error) {
    fail("DEVELOPMENT_TEST_DATABASE_ROLE_DATABASE_URL_INVALID", "database-name", error);
  }
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    fail("DEVELOPMENT_TEST_DATABASE_ROLE_DATABASE_NAME_INVALID", label);
  }
  return { connection, databaseName };
}

function assertDatabaseName(value, label = "candidate") {
  const databaseName = String(value || "").trim();
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    fail("DEVELOPMENT_TEST_DATABASE_ROLE_DATABASE_NAME_INVALID", label);
  }
  return databaseName;
}

function assertRoleName(value) {
  const roleName = String(value || "").trim();
  if (!ROLE_PATTERN.test(roleName)) {
    fail("DEVELOPMENT_TEST_DATABASE_ROLE_NAME_INVALID");
  }
  return roleName;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll("\"", "\"\"")}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeCommandError(error) {
  return String(error?.message || error || "unknown")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/postgres(?:ql)?:\/\/[^\s@/]+:[^\s@/]+@/giu, "postgresql://***:***@")
    .slice(0, 2_000);
}

function postgresEnvironment(baseEnvironment, rawUrl, databaseName, passwordOverride = undefined) {
  const { connection } = parseDatabaseUrl(rawUrl, "postgres-command");
  const environment = { ...(baseEnvironment || {}) };
  for (const key of [
    "DATABASE_URL",
    "SOURCE_DATABASE_URL",
    "TARGET_DATABASE_URL",
    "PGDATABASE",
    "PGHOST",
    "PGHOSTADDR",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGPASSFILE",
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGOPTIONS",
    "PGREQUIRESSL",
    "PGSSLMODE",
    "PGSSLROOTCERT",
    "PGSSLCERT",
    "PGSSLKEY",
    "PGCHANNELBINDING",
    "PGTARGETSESSIONATTRS",
  ]) delete environment[key];
  if (connection.hostname) environment.PGHOST = connection.hostname;
  if (connection.port) environment.PGPORT = connection.port;
  if (connection.username) environment.PGUSER = decodeURIComponent(connection.username);
  if (passwordOverride !== undefined) {
    environment.PGPASSWORD = String(passwordOverride);
  } else if (connection.password) {
    environment.PGPASSWORD = decodeURIComponent(connection.password);
  }
  environment.PGDATABASE = databaseName;
  environment.PGCONNECT_TIMEOUT = String(baseEnvironment?.PGCONNECT_TIMEOUT || "10");
  const parameterMap = {
    sslmode: "PGSSLMODE",
    sslrootcert: "PGSSLROOTCERT",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
    channel_binding: "PGCHANNELBINDING",
    target_session_attrs: "PGTARGETSESSIONATTRS",
  };
  for (const [parameter, environmentKey] of Object.entries(parameterMap)) {
    const value = connection.searchParams.get(parameter);
    if (value) environment[environmentKey] = value;
  }
  return environment;
}

function connectionFingerprint(rawUrl, expectedDatabaseName = undefined) {
  const { connection, databaseName } = parseDatabaseUrl(rawUrl, "candidate-runtime");
  const expected = expectedDatabaseName === undefined
    ? databaseName
    : assertDatabaseName(expectedDatabaseName);
  if (databaseName !== expected) fail("DEVELOPMENT_TEST_DATABASE_ROLE_DATABASE_NAME_MISMATCH");
  const parameters = [...connection.searchParams.entries()]
    .filter(([key]) => !/password|secret|token/iu.test(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    ));
  return sha256(stableStringify({
    protocol: connection.protocol,
    host: connection.hostname.toLowerCase(),
    port: connection.port || "5432",
    username: decodeURIComponent(connection.username || ""),
    databaseName,
    parameters,
  }));
}

export function deriveCandidateDatabaseRoleName(candidateDatabaseName) {
  const databaseName = assertDatabaseName(candidateDatabaseName);
  return `bonni_candidate_${sha256(`${ROLE_MARKER_PREFIX}${databaseName}`).slice(0, 24)}`;
}

function roleMarker(roleName, databaseName) {
  return `${ROLE_MARKER_PREFIX}${assertRoleName(roleName)}:${assertDatabaseName(databaseName)}`;
}

function candidateUrlWithRole(rawUrl, databaseName, roleName, password) {
  const { connection, databaseName: currentDatabaseName } = parseDatabaseUrl(rawUrl, "candidate-base");
  const expectedDatabaseName = assertDatabaseName(databaseName);
  if (currentDatabaseName !== expectedDatabaseName) {
    fail("DEVELOPMENT_TEST_DATABASE_ROLE_DATABASE_NAME_MISMATCH");
  }
  const candidate = new URL(connection.href);
  candidate.pathname = `/${encodeURIComponent(expectedDatabaseName)}`;
  candidate.username = assertRoleName(roleName);
  candidate.password = String(password);
  candidate.hash = "";
  return candidate.toString();
}

function roleProvisionSql(roleName, databaseName, password) {
  const role = quoteIdentifier(roleName);
  const database = quoteIdentifier(databaseName);
  const roleLiteral = quoteLiteral(roleName);
  const databaseLiteral = quoteLiteral(databaseName);
  const markerLiteral = quoteLiteral(roleMarker(roleName, databaseName));
  const passwordLiteral = quoteLiteral(password);
  return [
    "DO $bonni_role$",
    "DECLARE existing_comment text;",
    "BEGIN",
    `SELECT obj_description(oid, 'pg_authid') INTO existing_comment FROM pg_roles WHERE rolname = ${roleLiteral};`,
    `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleLiteral}) THEN`,
    `  IF existing_comment IS DISTINCT FROM ${markerLiteral} THEN RAISE EXCEPTION 'BONNI_CANDIDATE_ROLE_COLLISION'; END IF;`,
    `  EXECUTE ${quoteLiteral(`ALTER ROLE ${role} LOGIN PASSWORD ${passwordLiteral}`)};`,
    "ELSE",
    `  EXECUTE ${quoteLiteral(`CREATE ROLE ${role} LOGIN PASSWORD ${passwordLiteral}`)};`,
    "END IF;",
    `EXECUTE ${quoteLiteral(`COMMENT ON ROLE ${role} IS ${markerLiteral}`)};`,
    "END $bonni_role$;",
    `ALTER DATABASE ${database} OWNER TO ${role};`,
    `GRANT CONNECT ON DATABASE ${database} TO ${role};`,
    `SELECT ${databaseLiteral} AS database_name;`,
  ].join("\n");
}

function rolePrivilegesSql(roleName) {
  const role = quoteIdentifier(roleName);
  const roleLiteral = quoteLiteral(roleName);
  return [
    "DO $bonni_privileges$",
    "DECLARE schema_name text;",
    "BEGIN",
    "FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' LOOP",
    `  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', schema_name, ${roleLiteral});`,
    `  EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I TO %I', schema_name, ${roleLiteral});`,
    `  EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I TO %I', schema_name, ${roleLiteral});`,
    `  EXECUTE format('GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I TO %I', schema_name, ${roleLiteral});`,
    "END LOOP;",
    "END $bonni_privileges$;",
  ].join("\n");
}

function candidateProbeSql() {
  return "SELECT current_user || E'\\t' || current_database();";
}

function runPostgresSqlCommand({ command, args, environment, input }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-MAX_OUTPUT_BYTES);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-MAX_ERROR_BYTES);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve({ code: 0, stdout });
      else reject(new Error(stderr.trim() || `${command}:exit-${code ?? "signal"}:${signal || ""}`));
    });
    child.stdin.end(String(input || ""), "utf8");
  });
}

async function executeSql({ runner, label, command, args, environment, input }) {
  try {
    return await runner({ command, args, environment, input, label });
  } catch (error) {
    fail("DEVELOPMENT_TEST_DATABASE_ROLE_POSTGRES_COMMAND_FAILED", `${label}:${safeCommandError(error)}`, error);
  }
}

function postgresTool(options, environment) {
  return String(options?.tools?.psql || environment?.PSQL_PATH || "psql");
}

function psqlArgs(databaseName) {
  return [
    "--no-psqlrc",
    "--no-password",
    "--no-align",
    "--tuples-only",
    "--set=ON_ERROR_STOP=1",
    `--dbname=${assertDatabaseName(databaseName)}`,
  ];
}

function maintenanceDatabase(sourceDatabaseName) {
  return sourceDatabaseName === "postgres" ? "template1" : "postgres";
}

function assertCandidateHost(connection) {
  const host = String(connection.hostname || "").toLowerCase();
  if (!new Set(["127.0.0.1", "::1", "[::1]", "localhost"]).has(host)) {
    fail("DEVELOPMENT_TEST_DATABASE_ROLE_CANDIDATE_HOST_INVALID");
  }
}

export function candidateDatabaseConnectionFingerprint(rawUrl, expectedDatabaseName) {
  return connectionFingerprint(rawUrl, expectedDatabaseName);
}

export async function provisionCandidateDatabaseRole(options = {}) {
  const environment = options.environment || process.env;
  const base = parseDatabaseUrl(options.candidateDatabaseUrl, "candidate-base");
  const candidateDatabaseName = assertDatabaseName(options.candidateDatabaseName);
  if (base.databaseName !== candidateDatabaseName) {
    fail("DEVELOPMENT_TEST_DATABASE_ROLE_DATABASE_NAME_MISMATCH");
  }
  assertCandidateHost(base.connection);
  const roleName = deriveCandidateDatabaseRoleName(candidateDatabaseName);
  const password = crypto.randomBytes(48).toString("base64url");
  const source = parseDatabaseUrl(options.sourceDatabaseUrl, "source");
  const psql = postgresTool(options, environment);
  const runner = options.commandRunner || runPostgresSqlCommand;
  const maintenance = maintenanceDatabase(source.databaseName);
  const maintenanceEnvironment = postgresEnvironment(environment, options.sourceDatabaseUrl, maintenance);
  const adminSql = roleProvisionSql(roleName, candidateDatabaseName, password);
  await executeSql({
    runner,
    label: "provision-candidate-role",
    command: psql,
    args: psqlArgs(maintenance),
    environment: maintenanceEnvironment,
    input: adminSql,
  });
  const candidateAdminEnvironment = postgresEnvironment(
    environment,
    options.sourceDatabaseUrl,
    candidateDatabaseName,
  );
  await executeSql({
    runner,
    label: "grant-candidate-role",
    command: psql,
    args: psqlArgs(candidateDatabaseName),
    environment: candidateAdminEnvironment,
    input: rolePrivilegesSql(roleName),
  });
  const candidateDatabaseUrl = candidateUrlWithRole(
    options.candidateDatabaseUrl,
    candidateDatabaseName,
    roleName,
    password,
  );
  const candidateEnvironment = postgresEnvironment(
    environment,
    candidateDatabaseUrl,
    candidateDatabaseName,
  );
  const verification = await executeSql({
    runner,
    label: "verify-candidate-role-login",
    command: psql,
    args: psqlArgs(candidateDatabaseName),
    environment: candidateEnvironment,
    input: candidateProbeSql(),
  });
  const expectedProbe = `${roleName}\t${candidateDatabaseName}`;
  const probeLines = String(verification?.stdout || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!probeLines.includes(expectedProbe)) {
    fail("DEVELOPMENT_TEST_DATABASE_ROLE_LOGIN_VERIFICATION_FAILED");
  }
  return Object.freeze({
    roleName,
    candidateDatabaseName,
    candidateDatabaseUrl,
    connectionSha256: connectionFingerprint(candidateDatabaseUrl, candidateDatabaseName),
    marker: roleMarker(roleName, candidateDatabaseName),
  });
}

export async function cleanupCandidateDatabaseRole(options = {}) {
  const environment = options.environment || process.env;
  const candidateDatabaseName = assertDatabaseName(options.candidateDatabaseName);
  const roleName = deriveCandidateDatabaseRoleName(candidateDatabaseName);
  const source = parseDatabaseUrl(options.sourceDatabaseUrl, "source");
  const psql = postgresTool(options, environment);
  const runner = options.commandRunner || runPostgresSqlCommand;
  const maintenance = maintenanceDatabase(source.databaseName);
  const maintenanceEnvironment = postgresEnvironment(environment, options.sourceDatabaseUrl, maintenance);
  const role = quoteIdentifier(roleName);
  const roleLiteral = quoteLiteral(roleName);
  const markerLiteral = quoteLiteral(roleMarker(roleName, candidateDatabaseName));
  const databaseLiteral = quoteLiteral(candidateDatabaseName);
  const sql = [
    "DO $bonni_cleanup$",
    "DECLARE existing_comment text;",
    "BEGIN",
    `IF EXISTS (SELECT 1 FROM pg_database WHERE datname = ${databaseLiteral}) THEN`,
    "  RAISE EXCEPTION 'BONNI_CANDIDATE_DATABASE_STILL_EXISTS';",
    "END IF;",
    `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleLiteral}) THEN`,
    `  SELECT obj_description(oid, 'pg_authid') INTO existing_comment FROM pg_roles WHERE rolname = ${roleLiteral};`,
    `  IF existing_comment IS DISTINCT FROM ${markerLiteral} THEN RAISE EXCEPTION 'BONNI_CANDIDATE_ROLE_COLLISION'; END IF;`,
    `  EXECUTE ${quoteLiteral(`DROP ROLE ${role}`)};`,
    "END IF;",
    "END $bonni_cleanup$;",
  ].join("\n");
  await executeSql({
    runner,
    label: "cleanup-candidate-role",
    command: psql,
    args: psqlArgs(maintenance),
    environment: maintenanceEnvironment,
    input: sql,
  });
  return Object.freeze({ roleName, candidateDatabaseName, status: "cleaned" });
}
