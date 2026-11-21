import { env } from "../../core/config/env.js";
const startedAt = new Date();
export function getSystemRuntimeConfig() {
    const effectiveVersion = env.BONNI_CORE_IMAGE_VERSION || env.SYSTEM_VERSION;
    return {
        slotName: env.SYSTEM_SLOT_NAME,
        slotRole: env.SYSTEM_SLOT_ROLE,
        version: effectiveVersion,
        imageVersion: env.BONNI_CORE_IMAGE_VERSION || null,
        updateProbeMode: env.SYSTEM_UPDATE_PROBE_MODE,
        emergencyHoldDays: env.SYSTEM_EMERGENCY_HOLD_DAYS,
        bootKeyRequired: env.SYSTEM_BOOT_KEY_REQUIRED,
        startedAt,
        pid: process.pid,
    };
}
export function getRuntimeSurfaceLabel() {
    const runtime = getSystemRuntimeConfig();
    return `${runtime.slotName}:${runtime.slotRole}:${runtime.version}`;
}
