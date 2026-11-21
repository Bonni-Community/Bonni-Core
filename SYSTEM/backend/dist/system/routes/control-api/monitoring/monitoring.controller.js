import { getSystemMonitoringStatus } from "./monitoring.service.js";
import { getSystemResources } from "./resource.service.js";
export async function getSystemMonitoringStatusController(_req, res) {
    res.json(await getSystemMonitoringStatus());
}
export async function getSystemResourcesController(_req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getSystemResources());
}
