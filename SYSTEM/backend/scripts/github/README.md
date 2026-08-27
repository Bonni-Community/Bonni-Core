# Lokale GitHub-Pakete

Die GitHub-Pakete werden zentral im Ordner `SYSTEM/backend` erstellt:

```powershell
cd SYSTEM/backend
npm run github -- core kontor stueberl hocket
```

Die fertigen ZIP-Dateien und `github-packages.json` liegen anschließend direkt
im Produkt-Hauptordner `GITHUB` (direkt neben `SYSTEM`). Der Befehl veröffentlicht nichts, legt keinen
Git-Tag an und meldet Apps, deren Quellordner noch nicht vorhanden ist, als
übersprungen.

Einzelne Komponenten können separat ausgewählt werden:

```powershell
npm run github -- core
npm run github -- kontor
npm run github -- all
```

Eine Prüfung ohne Dateien zu schreiben ist ebenfalls möglich:

```powershell
npm run github -- --dry-run core kontor
```

Die von npm unterstützte Form lautet `npm run github -- ...`. Ein eigener
Befehl im Format `npm github ...` lässt sich in einer `package.json` nicht
definieren.

## Inhalt und Sicherheit

- Jede ausgewählte, vorhandene Komponente erhält ein eigenes, reproduzierbares
  Quellcode-ZIP mit kurzem Hauptordner.
- Veraltete ZIPs, die laut dem vorherigen `github-packages.json` von diesem
  Generator stammen und seitdem unverändert sind, werden entfernt. Fremde oder
  nachträglich veränderte Dateien im Ordner `GITHUB` bleiben erhalten.
- Abhängigkeiten und Build-Ausgaben wie `node_modules`, `dist`, `build` und
  `coverage` werden nicht übernommen.
- Lokale Umgebungsdateien, Schlüssel, Datenbanken, Logs, Backups, Uploads und
  Laufzeitdaten werden ausgeschlossen. `.env.example` bleibt als Vorlage
  enthalten.
- Jeder Ordner mit dem Namen `SIGNATUR` wird unabhängig von der Schreibweise
  vollständig ausgeschlossen. Der private Release-Schlüssel gehört damit nie
  in ein GitHub-Quellpaket.
- Unmittelbar vor dem Schreiben werden die tatsächlichen ZIP-Einträge nochmals
  auf private PEM-Marker und sensible Schlüsseldateiendungen geprüft. Ein Fund
  bricht den gesamten Paketlauf ab; es bleibt kein Teilpaket dieses Laufs zurück.
- Symbolische Links, spezielle Dateien, unsichere Windows-Pfade und zu große
  Pakete werden abgewiesen.
- `GITHUB` enthält ausschließlich lokale Bereitstellungsartefakte. Es findet
  weder ein Upload noch ein Zugriff auf GitHub statt.
