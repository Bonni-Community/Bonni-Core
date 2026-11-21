import logo from "./gourmet-logo.jpg";
import recipe from "./screenshots/gourmet-rezept.jpg";
import calendar from "./screenshots/gourmet-speisekalender.jpg";
import pantry from "./screenshots/gourmet-vorraete.jpg";

export const gourmetStorePresentation = {
  logo,
  description: {
    de: "Gourmet ergänzt die StüberlApp um Kochbücher und Küchenplanung. Du legst Rezepte mit Fotos, Zutaten und Zubereitungsschritten an und rechnest die Mengen auf die gewünschte Portionszahl um. Im Speisekalender stellst du Menüs zusammen und nutzt die Planung als Speisekarte. Gourmet gleicht den Zutatenbedarf mit dem Stüberl-Lager ab und zeigt, welche Mengen verfügbar, vorgemerkt oder noch einzukaufen sind. Fertige Reste kannst du für spätere Mahlzeiten einplanen. Mit Bonni Capture bereitest du Rezepte aus Fotos oder Dateien vor und übernimmst sie nach Prüfung.",
    en: "Gourmet adds cookbooks and kitchen planning to StüberlApp. Create recipes with photos, ingredients and cooking steps, and scale the quantities to the number of servings you need. Combine recipes into menus in the meal calendar and display the plan as a menu. Gourmet compares ingredient requirements with Stüberl inventory to show what is available, earmarked for planned meals or still needs to be bought. Use prepared leftovers in future meals. With Bonni Capture, you can prepare recipes from photos or files and import them after review.",
  },
  screenshots: [
    { src: recipe, de: "Rezeptansicht", en: "Recipe" },
    { src: calendar, de: "Speisekalender", en: "Meal calendar" },
    { src: pantry, de: "Vorräte", en: "Pantry" },
  ],
};

