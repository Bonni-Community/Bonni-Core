import { prisma } from "../../../../core/core.js";

export async function listSettings() {
  return prisma.systemSetting.findMany({
    orderBy: { key: "asc" }
  });
}

export async function upsertSetting(data: {
  key: string;
  valueJson: unknown;
  category?: string;
  description?: string;
}) {
  return prisma.systemSetting.upsert({
    where: { key: data.key },
    update: { value: data.valueJson as object },
    create: {
      key: data.key,
      value: data.valueJson as object
    }
  });
}

export async function listFeatures() {
  return prisma.featureFlag.findMany({
    orderBy: { key: "asc" }
  });
}

export async function toggleFeature(key: string, enabled?: boolean) {
  const existing = await prisma.featureFlag.findUnique({ where: { key } });

  if (!existing) {
    return prisma.featureFlag.create({
      data: { key, enabled: enabled ?? true }
    });
  }

  return prisma.featureFlag.update({
    where: { key },
    data: { enabled: enabled ?? !existing.enabled }
  });
}

export async function listDevices() {
  return prisma.device.findMany({
    include: { room: true },
    orderBy: { label: "asc" }
  });
}

export async function createDevice(data: {
  key: string;
  label: string;
  type: string;
  roomId?: string;
  ipAddress?: string;
  note?: string;
}) {
  return prisma.device.create({
    data: {
      key: data.key,
      label: data.label,
      type: data.type,
      roomId: data.roomId,
      ipAddress: data.ipAddress,
      note: data.note,
      active: true
    }
  });
}

export async function listRooms() {
  return prisma.room.findMany({
    orderBy: { name: "asc" }
  });
}

export async function createRoom(data: {
  key: string;
  label: string;
  capacity?: number;
  note?: string;
}) {
  return prisma.room.create({
    data: {
      name: data.label,
      capacity: data.capacity
    }
  });
}

export async function listPrinters() {
  return prisma.printer.findMany({
    orderBy: { name: "asc" }
  });
}

export async function createPrinter(data: {
  key: string;
  label: string;
  type: string;
  ipAddress?: string;
  deviceId?: string;
  roomId?: string;
}) {
  return prisma.printer.create({
    data: {
      key: data.key,
      name: data.label,
      type: data.type,
      active: true
    }
  });
}

export async function enableMaintenanceMode() {
  return prisma.featureFlag.upsert({
    where: { key: "SYSTEM_MAINTENANCE" },
    update: { enabled: true },
    create: { key: "SYSTEM_MAINTENANCE", enabled: true }
  });
}

export async function disableMaintenanceMode() {
  return prisma.featureFlag.upsert({
    where: { key: "SYSTEM_MAINTENANCE" },
    update: { enabled: false },
    create: { key: "SYSTEM_MAINTENANCE", enabled: false }
  });
}

export async function createBackup(createdByAccountId?: string) {
  return prisma.systemBackup.create({
    data: {
      status: "DONE",
      createdByAccountId,
      startedAt: new Date(),
      finishedAt: new Date(),
      filePath: `/backups/backup-${Date.now()}.zip`
    }
  });
}

export async function listBackups() {
  return prisma.systemBackup.findMany({
    orderBy: { createdAt: "desc" }
  });
}

export async function seedDemoData() {
  const featureFlags = [
    "KITCHEN_ENABLED",
    "PREORDER_ENABLED",
    "TABS_ENABLED",
    "CHRISTMAS_MODE"
  ];

  for (const key of featureFlags) {
    await prisma.featureFlag.upsert({
      where: { key },
      update: {},
      create: { key, enabled: true }
    });
  }

  return { success: true, seeded: featureFlags.length };
}
