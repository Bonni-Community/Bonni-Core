import { accessSync, constants as fsConstants, existsSync, readdirSync, statSync, } from "node:fs";
import path from "node:path";
function unquote(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2
        && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
            || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}
function executableNames(tool, platform) {
    return platform === "win32" ? [`${tool}.exe`, tool] : [tool];
}
function isExecutableFile(candidate, platform) {
    try {
        if (!statSync(candidate).isFile())
            return false;
        if (platform !== "win32")
            accessSync(candidate, fsConstants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function executableInDirectory(directory, tool, platform) {
    for (const name of executableNames(tool, platform)) {
        const candidate = path.join(directory, name);
        if (isExecutableFile(candidate, platform))
            return candidate;
    }
    return null;
}
function configuredExecutable(configuredValue, tool, platform) {
    const configured = path.resolve(unquote(configuredValue));
    try {
        const stat = statSync(configured);
        if (stat.isDirectory()) {
            const command = executableInDirectory(configured, tool, platform);
            return command ? { command, directory: true } : null;
        }
        return isExecutableFile(configured, platform) ? { command: configured, directory: false } : null;
    }
    catch {
        return null;
    }
}
function uniqueDirectories(values) {
    const seen = new Set();
    return values.flatMap((value) => {
        const normalized = value ? path.resolve(unquote(value)) : "";
        if (!normalized || seen.has(normalized))
            return [];
        seen.add(normalized);
        return [normalized];
    });
}
function versionParts(value) {
    return value.split(/[^0-9]+/).filter(Boolean).map((part) => Number(part));
}
function newestVersionFirst(left, right) {
    const leftParts = versionParts(left);
    const rightParts = versionParts(right);
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
        const difference = (rightParts[index] || 0) - (leftParts[index] || 0);
        if (difference)
            return difference;
    }
    return right.localeCompare(left);
}
function windowsPostgresBinDirectories(env) {
    const programRoots = uniqueDirectories([
        env.ProgramW6432,
        env.ProgramFiles,
        env.PROGRAMFILES,
        env["ProgramFiles(x86)"],
        env["PROGRAMFILES(X86)"],
    ]);
    const directories = [];
    for (const programRoot of programRoots) {
        const postgresRoot = path.join(programRoot, "PostgreSQL");
        if (!existsSync(postgresRoot))
            continue;
        let versions = [];
        try {
            versions = readdirSync(postgresRoot, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                .sort(newestVersionFirst);
        }
        catch {
            continue;
        }
        directories.push(...versions.map((version) => path.join(postgresRoot, version, "bin")));
    }
    return uniqueDirectories(directories);
}
/**
 * Resolves PostgreSQL client tools without invoking a shell. This is important
 * on Windows where the PostgreSQL installer commonly does not add its `bin`
 * directory to PATH. An explicit PG_DUMP_PATH/PG_RESTORE_PATH is authoritative:
 * a typo must fail visibly instead of silently selecting a different binary.
 */
export function resolvePostgreSqlTool(tool, options = {}) {
    const processEnv = options.env || process.env;
    const platform = options.platform || process.platform;
    const overrideKey = tool === "pg_dump" ? "PG_DUMP_PATH" : "PG_RESTORE_PATH";
    const override = unquote(String(processEnv[overrideKey] || ""));
    if (override) {
        const configured = configuredExecutable(override, tool, platform);
        if (!configured) {
            return {
                ok: false,
                code: "POSTGRESQL_TOOL_CONFIG_INVALID",
                configuredValue: override,
                message: `Der in ${overrideKey} hinterlegte Pfad ist ungültig oder nicht ausführbar.`,
            };
        }
        return {
            ok: true,
            command: configured.command,
            source: configured.directory ? "configured-directory" : "configured-file",
        };
    }
    const configuredBinDirectories = uniqueDirectories([
        processEnv.BONNI_POSTGRES_BIN,
        processEnv.POSTGRES_BIN,
        processEnv.PG_BIN,
        processEnv.PGBIN,
    ]);
    for (const directory of configuredBinDirectories) {
        const command = executableInDirectory(directory, tool, platform);
        if (command)
            return { ok: true, command, source: "configured-directory" };
    }
    const postgresHomes = uniqueDirectories([
        processEnv.POSTGRES_HOME,
        processEnv.PG_HOME,
    ]);
    for (const home of postgresHomes) {
        const command = executableInDirectory(path.join(home, "bin"), tool, platform);
        if (command)
            return { ok: true, command, source: "postgres-home" };
    }
    const pathDirectories = uniqueDirectories(String(processEnv.PATH || processEnv.Path || "")
        .split(platform === "win32" ? ";" : path.delimiter));
    for (const directory of pathDirectories) {
        const command = executableInDirectory(directory, tool, platform);
        if (command)
            return { ok: true, command, source: "path" };
    }
    if (platform === "win32") {
        for (const directory of windowsPostgresBinDirectories(processEnv)) {
            const command = executableInDirectory(directory, tool, platform);
            if (command)
                return { ok: true, command, source: "windows-installation" };
        }
    }
    return {
        ok: false,
        code: "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED",
        message: platform === "win32"
            ? "Das PostgreSQL-Sicherungswerkzeug wurde nicht gefunden. Installiere die PostgreSQL-Clienttools oder hinterlege den vollständigen Pfad zur pg_dump.exe in PG_DUMP_PATH."
            : "Das PostgreSQL-Sicherungswerkzeug wurde nicht gefunden. Installiere die PostgreSQL-Clienttools oder hinterlege den vollständigen Pfad zu pg_dump in PG_DUMP_PATH.",
    };
}
