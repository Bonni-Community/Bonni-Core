import { linuxReference } from "./terminalLinuxReference.js";

export const terminalHelpNotesPath = "/bonni-befehle.txt";

const sections = [
  {
    key: "dateien", title: "Dateien und Ordner im Backup-Bereich", commands: [
      ["ls [-a] [-l] [Ordner]", "-a zeigt auch versteckte Einträge. -l zeigt Typ, Größe und Änderungszeit.", "ls -la /sicherungen"],
      ["cd [Ordner]", "Ordner wechseln. Ohne Ordner geht es zurück zu /.", "cd .."],
      ["pwd", "Aktuellen Ordner anzeigen."],
      ["mkdir [-p] <Ordner>", "Ordner anlegen. -p legt fehlende Elternordner an.", "mkdir -p /sicherungen/monat"],
      ["rmdir [-p] <Ordner>", "Leere Ordner löschen. -p geht weiter zu den leeren Elternordnern.", "rmdir -p ./probe/unterordner"],
      ["touch <Datei>", "Eine Textdatei anlegen.", "touch /probe.txt"],
      ["cat <Datei>", "Eine Textdatei anzeigen.", `cat ${terminalHelpNotesPath}`],
      ["nano <Datei>", "Eine Textdatei bearbeiten.", `nano ${terminalHelpNotesPath}`],
      ["rm [-r] [-f] <Pfad>", "Textdatei löschen. -r löscht Ordner mit Inhalt dauerhaft. -f akzeptiert fehlende Ziele.", "rm -rf ./testkopie"],
      ["cp [-R] <Quelle> <Ziel>", "Kopieren. -R nimmt Unterordner und Dateien mit. Vorhandene Ziele sind geschützt.", "cp -R /probe /testkopie"],
      ["backup create [Ordner]", "Ein Backup im gewählten Ordner erstellen.", "backup create /sicherungen"],
    ],
  },
  {
    key: "text", title: "Text und Ausgabe", commands: [
      ["echo [Text]", "Text ausgeben.", 'echo "Test" | tee test.txt'],
      ["grep -F [-i] <Suchtext>", "Hinter | nach festem Text filtern. -i ignoriert die Großschreibung.", 'journalctl -n 50 | grep -Fi "Fehler"'],
      ["sort [-r] [-n] [-u] [Datei]", "Zeilen sortieren. -r kehrt die Reihenfolge um, -n sortiert nach führenden Zahlen, -u lässt gleiche Sortierwerte einmal stehen.", "ls -a | sort -r"],
      ["cut -f <Felder> [-d <Trennzeichen>] [Datei]", "Felder auswählen. -d setzt das Trennzeichen. Standard ist Tab.", "cut -d ',' -f 2 /produkte.csv"],
      ["cut -b <Bytepositionen> [Datei]", "Bytes einer UTF-8-Zeile nach Position auswählen. Wähle vollständige Zeichenbytes.", "cat /werte.txt | cut -b 1-3"],
      ["cut -c <Zeichenpositionen> [Datei]", "Zeichen ab Position 1 auswählen. Listen und Bereiche sind möglich.", "cat /werte.txt | cut -c 1,3-5"],
      ["Befehl | tee [-a] <Dateiname>", "Ausgabe zugleich anzeigen und als Textdatei im Backup-Bereich speichern. -a hängt an.", "journalctl -p err -n 20 | tee -a /fehler.txt"],
    ],
  },
  {
    key: "system", title: "System und Protokolle", commands: [
      ["ping [bonni-core]", "Backend und Datenbank von Bonni Core prüfen.", "ping bonni-core"],
      ["systemctl status [bonni-core|Paket-ID]", "Zustand von Core oder eines Pakets anzeigen.", "systemctl status app.stueberlapp"],
      ["systemctl start <Paket-ID>", "Ein Bonni-Paket aktivieren.", "systemctl start addon.hub"],
      ["systemctl stop <Paket-ID>", "Ein Bonni-Paket deaktivieren.", "systemctl stop addon.hub"],
      ["journalctl [-u Einheit] [-p Stufe] [-n Anzahl] [-r]", "Das Bonni-Diagnosejournal lesen. -n begrenzt die Anzahl auf 1 bis 100.", "journalctl -u bonni-core -p err -n 20"],
      ["diagnose errors [Paket-ID]", "Die jüngsten Diagnosefehler anzeigen.", "diagnose errors app.stueberlapp"],
      ["diagnose show <Fehler-ID>", "Details zu einer vollständigen Fehler-ID aus dem Live-Terminal anzeigen.", "diagnose show b319e4df-1e39-4571-ace7-f6ad9b420195"],
      ["diagnose test", "Einen markierten Testfehler ins Diagnosejournal schreiben."],
    ],
  },
  {
    key: "pakete", title: "Bonni-Pakete", commands: [
      ["apt list [--installed] [Suchbegriff]", "Pakete finden. --installed zeigt installierte Pakete.", "apt list --installed stueberl"],
      ["apt install <Paket-ID>", "Ein vorhandenes Bonni-Paket installieren.", "apt install addon.hub"],
      ["apt install ./<Dateiname.zip> [--dev]", "Ein signiertes ZIP aus UPDATE installieren. --dev bestätigt ein DEV-Paket."],
      ["apt remove [-y] <Paket-ID>", "Ein Paket deinstallieren. -y bestätigt die Deinstallation.", "apt remove addon.hub"],
    ],
  },
  {
    key: "benutzer", title: "Benutzer und Rechte", commands: [
      ["whoami", "Den aktuell angemeldeten Bonni-Login anzeigen."],
      ["getent passwd [Login]", "Bonni-Benutzer anzeigen.", "getent passwd demo"],
      ["id [Login]", "Bonni-Konto und Zugriffe anzeigen.", "id demo"],
      ['useradd -c "Anzeigename" <Login>', "Ein Bonni-Konto anlegen.", 'useradd -c "Testmitglied" demo'],
      ["usermod -L|-U <Login>", "Ein Bonni-Konto sperren (-L) oder entsperren (-U).", "usermod -L demo"],
      ["userdel <Login|me>", "Einen Löschantrag öffnen."],
      ['user rights <Login> {"moduleAccess":[…]}', "Die vollständigen Modulrechte ersetzen."],
      ["user deletions", "Löschliste und Antrags-IDs anzeigen."],
      ["user purge <Antrags-ID> --endgueltig", "Einen freigegebenen Löschantrag sofort ausführen."],
    ],
  },
  {
    key: "produkte", title: "Produkte in der StüberlApp", commands: [
      ["product list [Suchbegriff]", "Produkte finden.", "product list Spezi"],
      ['product create {"sku":"SPEZI-033","name":"Spezi","price":1.5}', "Ein Produkt anlegen."],
      ['product update <Produkt-ID> {"price":1.6}', "Ein Produkt ändern."],
      ["product archive <Produkt-ID> --confirm", "Ein Produkt archivieren."],
      ["product import", "Produkte aus einer Textdatei anlegen."],
    ],
  },
  {
    key: "terminal", title: "Bedienung", commands: [
      ["help [Befehl|Bereich]", "Syntax und Beispiele nachschlagen.", "help journalctl"],
      ["help linux [Bereich|Befehl]", "Linux-Befehle nachschlagen.", "help linux benutzer"],
      ["help notizen", "Die selbst geschriebenen Befehlsnotizen lesen.", `nano ${terminalHelpNotesPath}`],
      ["clear", "Die Ausgabe leeren."],
      ["sudo <Befehl>", "Einen unterstützten Befehl mit deinen Bonni-Berechtigungen verwenden."],
      ["&&", "Befehle verketten. Der nächste startet nach Erfolg des vorherigen.", "cd / && ls"],
    ],
  },
];

function commandHelp(topic) {
  return sections.flatMap(({ commands }) => commands).filter(([syntax]) => (
    syntax === topic || syntax.startsWith(`${topic} `) || (topic === "tee" && syntax.startsWith("Befehl | tee "))
  ));
}

function linuxHelp(topic) {
  if (!topic) {
    return [
      "Linux-Referenz",
      "help linux <Bereich> öffnet eine Befehlsgruppe.",
      "help <Befehl> zeigt, wie du ihn in Bonni verwendest, falls verfügbar.",
      "",
      ...Object.entries(linuxReference).map(([group, commands]) => `${group.padEnd(10)} ${Object.keys(commands).join(" · ")}`),
    ].join("\n");
  }
  if (Object.hasOwn(linuxReference, topic)) {
    return [`Linux-Referenz · ${topic}`, "", ...Object.entries(linuxReference[topic]).map(([command, description]) => (
      `${command.padEnd(10)} ${description}${commandHelp(command).length ? "  ·  In Bonni verfügbar" : ""}`
    ))].join("\n");
  }
  for (const commands of Object.values(linuxReference)) {
    if (Object.hasOwn(commands, topic)) {
      return [
        `Linux-Referenz · ${topic}`,
        commands[topic],
        commandHelp(topic).length && `Bonni-Variante mit help ${topic} nachschlagen.`,
      ].filter(Boolean).join("\n");
    }
  }
  throw new Error(`Unbekannter Hilfebegriff ${topic}. Tippe help für die Übersicht.`);
}

export function formatTerminalHelp(topic) {
  if (!topic) {
    return [
      "Bonni-Terminal · Befehlsübersicht",
      "help <Befehl> oder help <Bereich> zeigt Syntax und Beispiele.",
      "",
      ...sections.map(({ key, commands }) => {
        const names = new Set(commands.map(([syntax]) => syntax.startsWith("Befehl | tee ") ? "tee" : syntax.split(" ", 1)[0]));
        return `${key.padEnd(10)} ${[...names].join(" · ")}`;
      }),
      "",
      "help linux · Linux-Befehle nachschlagen",
      "help notizen · Eigene Befehle lesen",
      `nano ${terminalHelpNotesPath} · Eigene Befehle notieren`,
    ].join("\n");
  }
  if (topic === "linux" || topic.startsWith("linux ")) return linuxHelp(topic.slice(5).trim());
  const section = sections.find(({ key }) => key === topic);
  if (section) {
    return [section.title, "", ...section.commands.map(([syntax, description]) => `${syntax} · ${description}`)].join("\n");
  }
  const commands = commandHelp(topic);
  if (!commands.length) return linuxHelp(topic);
  return commands.map(([syntax, description, example]) => [
    syntax,
    `  ${description}`,
    example && `  Beispiel  ${example}`,
  ].filter(Boolean).join("\n")).join("\n\n");
}
