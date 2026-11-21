import { getSystemOverview } from "./overview.service.js";
export async function getOverviewController(_req, res) {
    res.json(await getSystemOverview());
}
