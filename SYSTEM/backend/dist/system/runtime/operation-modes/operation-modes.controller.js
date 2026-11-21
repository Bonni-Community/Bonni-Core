import { getOperationModesStatus } from "./operation-modes.service.js";
export async function getOperationModesStatusController(_req, res, next) {
    try {
        res.json(await getOperationModesStatus());
    }
    catch (error) {
        next(error);
    }
}
