import logo from "./stueberlapp-logo.jpg";
import barkeeper from "./screenshots/barkeeper.jpg";
import warehouse from "./screenshots/lager.jpg";
import cashbook from "./screenshots/kassenbuch.jpg";

export const stueberlStorePresentation = {
  logo,
  description: {
    de: "Die StüberlApp organisiert das Vereinsstüberl. An der Theke buchst du Getränke und Speisen per Strichliste oder auf persönlichen Bierdeckeln. Je nach Betriebsart verwaltest du Wareneingang, Bestand, Inventur, Guthaben und Rechnungen. Das Kassenbuch zeigt Einnahmen und Ausgaben, die Lagerstatistik Verbrauch und Nachkaufbedarf. Buchungen für Einsätze, Übungen und Veranstaltungen erfasst du getrennt.",
    en: "StüberlApp helps clubs run their bar. Record food and drinks on a tally sheet or individual tabs. Depending on your setup, manage incoming goods, stock, inventory counts, balances and invoices. The cashbook shows income and expenses, and stock reports show consumption and restocking needs. Track orders for operations, training and events separately.",
  },
  screenshots: [
    { src: barkeeper, de: "Barkeeper", en: "Bartender" },
    { src: warehouse, de: "Lagerbestand", en: "Stock overview" },
    { src: cashbook, de: "Kassenbuch", en: "Cashbook" },
  ],
};
