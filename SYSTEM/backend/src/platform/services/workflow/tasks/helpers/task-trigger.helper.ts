import { TaskTriggerType } from "../types/tasks.types.js";

export function describeTaskTrigger(triggerType: TaskTriggerType): string {
  switch (triggerType) {
    case "TIME":
      return "Zeitgesteuerte Aufgabe";
    case "STOCK_LEVEL":
      return "Aufgabe wegen Lagerbestand";
    case "EVENT":
      return "Aufgabe wegen Event";
    case "SYSTEM":
      return "Systemaufgabe";
    default:
      return "Manuelle Aufgabe";
  }
}
