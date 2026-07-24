import { z } from "zod";

export const settingSchema = z.object({
  body: z.object({
    key: z.string().min(1),
    valueJson: z.unknown(),
    category: z.string().optional(),
    description: z.string().optional()
  })
});

export const toggleFeatureSchema = z.object({
  body: z.object({
    enabled: z.boolean().optional()
  })
});

export const createDeviceSchema = z.object({
  body: z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    type: z.enum([
      "BAR_TABLET",
      "KITCHEN_TABLET",
      "ROOM_DISPLAY",
      "PRINTER_STATION",
      "POS",
      "OTHER"
    ]),
    roomId: z.string().optional(),
    ipAddress: z.string().optional(),
    note: z.string().optional()
  })
});

export const createRoomSchema = z.object({
  body: z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    capacity: z.number().int().positive().optional(),
    note: z.string().optional()
  })
});

export const createPrinterSchema = z.object({
  body: z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    type: z.enum([
      "KITCHEN",
      "BAR",
      "INVOICE",
      "LABEL",
      "OTHER"
    ]),
    ipAddress: z.string().optional(),
    deviceId: z.string().optional(),
    roomId: z.string().optional()
  })
});
