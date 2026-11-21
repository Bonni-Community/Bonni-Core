import { getDataClassificationOverview } from "./data-classification.service.js";
export async function getSystemDataClassificationOverviewController(_req, res) {
    res.json(await getDataClassificationOverview());
}
