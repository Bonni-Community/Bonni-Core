export const NAVIGATION = {
  AREAS: [
    { key: "MEMBER", label: "Mitglied" },
    { key: "WAREHOUSE", label: "Lagerverwaltung" },
    { key: "CASHIER", label: "Kasse" },
    { key: "ADMIN", label: "Manager" },
    { key: "IT", label: "Technik" },
    { key: "EVENT", label: "Event" }
  ],

  SIDEBAR: {
    MEMBER: [
      { key: "dashboard", label: "Dashboard" },
      { key: "rechnungen", label: "Rechnungen" },
      { key: "vorbestellung", label: "Vorbestellung" },
      { key: "barkeeper", label: "Barkeeper" }
    ],

    WAREHOUSE: [
      { key: "dashboard", label: "Dashboard" },
      { key: "vorschlaege", label: "Einkaufsvorschläge" },
      { key: "lieferungen", label: "Wareneingang" },
      { key: "bestand", label: "Bestand" },
      { key: "inventory", label: "Inventur" }
    ],

    CASHIER: [
      { key: "dashboard", label: "Dashboard" },
      { key: "verkauf", label: "Verkauf" },
      { key: "buchungen", label: "Buchungen" },
      { key: "rechnungen", label: "Rechnungen" }
    ],

    ADMIN: [
      { key: "dashboard", label: "Dashboard" },
      { key: "products", label: "Produkte" },
      { key: "user", label: "Benutzer" },
      { key: "system", label: "System" }
    ],

    IT: [
      { key: "dashboard", label: "Dashboard" },
      { key: "status", label: "Status" },
      { key: "health", label: "Health" },
      { key: "backup", label: "Backup" },
      { key: "diagnose", label: "Diagnose" }
    ],

    EVENT: [
      { key: "dashboard", label: "Dashboard" },
      { key: "planung", label: "Planung" },
      { key: "vorbestellung", label: "Vorbestellung" },
      { key: "teilnehmer", label: "Teilnehmer" }
    ]
  }
};
