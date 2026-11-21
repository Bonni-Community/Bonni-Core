import { getAuthSettingsOverview, getSystemSettingsOverview, } from "./settings.service.js";
export async function getSettingsController(_req, res, next) {
    try {
        res.json(await getSystemSettingsOverview());
    }
    catch (error) {
        next(error);
    }
}
export async function getAuthSettingsController(_req, res, next) {
    try {
        res.json({ ok: true, area: "settings/auth", auth: await getAuthSettingsOverview() });
    }
    catch (error) {
        next(error);
    }
}
