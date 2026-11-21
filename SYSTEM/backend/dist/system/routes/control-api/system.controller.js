import { getSystemStatus } from "./system.service.js";
export function getSystemStatusController(_req, res) {
    res.json(getSystemStatus());
}
