import { bootWithoutKeyDecisionSchema, developerBootModeSchema, initializeMasterKeyStorageSchema, loadMasterKeyFromFileSchema, } from "./master-key.schemas.js";
import { decideBootWithoutKey, getMasterKeyControlStatus, initializeMasterKeyStorage, listMasterKeyStorageLocations, loadMasterKey, setDeveloperBootMode, } from "./master-key.service.js";
export function getMasterKeyStatusController(_req, res) {
    res.json(getMasterKeyControlStatus());
}
export function listMasterKeyStorageLocationsController(_req, res) {
    res.json(listMasterKeyStorageLocations());
}
export function bootWithoutKeyDecisionController(req, res) {
    const input = bootWithoutKeyDecisionSchema.parse(req.body);
    res.json(decideBootWithoutKey(input));
}
export function loadMasterKeyController(req, res) {
    const input = loadMasterKeyFromFileSchema.parse(req.body);
    res.json(loadMasterKey(input));
}
export function initializeMasterKeyStorageController(req, res) {
    const input = initializeMasterKeyStorageSchema.parse(req.body);
    res.json(initializeMasterKeyStorage(input));
}
export function setDeveloperBootModeController(req, res) {
    const input = developerBootModeSchema.parse(req.body);
    res.json(setDeveloperBootMode(input));
}
