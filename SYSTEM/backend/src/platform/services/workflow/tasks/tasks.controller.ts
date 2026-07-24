import { Request, Response } from "express";
import { tasksService } from "./tasks.service.js";

export const tasksController = {
  async list(req: Request, res: Response) {
    const result = await tasksService.listTasks(req.query);
    res.json(result);
  },

  async create(req: Request, res: Response) {
    const result = await tasksService.createTask(req.body, req.user);
    res.json(result);
  },

  async complete(req: Request, res: Response) {
    const result = await tasksService.completeTask(req.params.id, req.body, req.user);
    res.json(result);
  },

  async postpone(req: Request, res: Response) {
    const result = await tasksService.postponeTask(req.params.id, req.body, req.user);
    res.json(result);
  },

  async remove(req: Request, res: Response) {
    const result = await tasksService.deleteTask(req.params.id, req.user);
    res.json(result);
  },
};
