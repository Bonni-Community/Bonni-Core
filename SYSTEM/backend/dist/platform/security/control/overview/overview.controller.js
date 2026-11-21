import { getSystemSecurityPrivacyOverview } from "./overview.service.js";
export async function getSystemSecurityPrivacyOverviewController(_req, res) {
    const overview = await getSystemSecurityPrivacyOverview();
    res.json(overview);
}
