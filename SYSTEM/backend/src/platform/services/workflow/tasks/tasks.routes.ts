import { Router } from "express";
import { tasksController } from "./tasks.controller.js";

const router = Router();

router.get("/", tasksController.list);
router.post("/", tasksController.create);
router.patch("/:id/complete", tasksController.complete);
router.patch("/:id/postpone", tasksController.postpone);
router.delete("/:id", tasksController.remove);

export default router;
