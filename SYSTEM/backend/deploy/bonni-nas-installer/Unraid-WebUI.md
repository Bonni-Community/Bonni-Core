# Bonni Core auf Unraid im Browser einrichten

## Installation mit einem Befehl

Lege die kurze Startdatei `bonnicore-install.sh` und das offizielle AMD64-Release-ZIP unentpackt in `appdata`. Öffne das Webterminal von Unraid und kopiere die folgende Zeile.

```bash
bash /mnt/user/appdata/bonnicore-install.sh
```

Für die Weitergabe als eine einzige Datei kann die Startdatei mit `--einzeldatei` das vorhandene ZIP unter `Unraid/bonnicore-install.sh` einbetten. Die erzeugte Datei allein wird dann in `appdata` abgelegt und mit demselben kurzen Befehl gestartet.

Für den direkten Aufruf aus einem AMD64-Release-ZIP gilt die folgende Zeile. Passe bei einer anderen Release-Version den ZIP-Dateinamen an.

```bash
( set -e; zip=/mnt/user/appdata/64-Bit-Bonni-Core-v0.1.21-AMD64.zip; teil=${zip##*/}; installer=$(mktemp); trap 'rm -f -- "$installer"' EXIT; unzip -p "$zip" "${teil%.zip}/bonnicore-install.sh" > "$installer"; bash "$installer" --unraid-zip "$zip" )
```

Der Installer entpackt das Core-Image, prüft dessen Prüfsumme, lädt es in Docker und startet einen Container namens `Bonni-Core`. Das Image kommt aus dem ZIP. Die WebUI nutzt Port `4000` und der Datenordner liegt unter `/mnt/user/appdata/bonni-core-unraid`. Eine frühere Installation mit abweichender Konfiguration wird erkannt und bleibt bestehen.

Unter **Docker → Bonni-Core → WebUI** öffnet sich der Assistent mit **Prüfung**, **Speicherort**, **Admin-Konto** und **Zusammenfassung**. Für den ersten Schritt den Einrichtungscode aus **Protokolle** kopieren.

Bonni zeigt den Startfortschritt an und öffnet anschließend die Anmeldung. Bei einem späteren Neustart erscheint direkt die Anmeldung.

## Installation über die Unraid-Vorlage

Alternativ `my-Bonni-Core.xml` aus dem AMD64-ZIP in **Flash → config → plugins → dockerMan → templates-user** ablegen und unter **Docker → Container hinzufügen** auswählen. Dieser Weg lädt das Image aus der Registry und benötigt Internetzugriff. Daten einer früheren Compose-Installation müssen gesondert übernommen werden.
