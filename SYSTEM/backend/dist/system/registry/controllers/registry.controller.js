import { getSystemRegistry, runSystemRegistrySyncTool, syncSystemRegistry, } from "./registry.service.js";
export async function getRegistryController(_req, res) {
    res.json(await getSystemRegistry());
}
export async function syncRegistryController(_req, res) {
    res.json(await syncSystemRegistry());
}
export async function runRegistrySyncToolController(_req, res) {
    res.json(await runSystemRegistrySyncTool());
}
