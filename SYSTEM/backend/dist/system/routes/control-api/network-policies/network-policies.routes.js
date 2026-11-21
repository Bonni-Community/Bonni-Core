import { Router } from "express";
import { listNetworkObservationsController, listNetworkPoliciesController, updateNetworkPolicyController, } from "./network-policies.controller.js";
export const systemNetworkPoliciesRouter = Router();
systemNetworkPoliciesRouter.get("/", listNetworkPoliciesController);
systemNetworkPoliciesRouter.get("/observations", listNetworkObservationsController);
systemNetworkPoliciesRouter.put("/:moduleKey", updateNetworkPolicyController);
