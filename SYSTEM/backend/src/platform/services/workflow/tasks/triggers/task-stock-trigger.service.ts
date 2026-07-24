// Erstellt Aufgaben, wenn Lagerbestand niedrig ist
export class TaskStockTriggerService {
  async createLowStockTask(stockItemId: string) {
    return {
      title: "Bestand niedrig",
      triggerType: "STOCK_LEVEL",
      stockItemId,
      createdAt: new Date(),
    };
  }
}

export const taskStockTriggerService = new TaskStockTriggerService();
