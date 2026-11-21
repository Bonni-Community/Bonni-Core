# Bonni Matrix-Verwaltung 0.1

Diese Werkzeuge betreiben einen eigenen Synapse- und PostgreSQL-Container und bieten eine kleine, authentifizierte Verwaltungsschnittstelle für Bonni Core. Synapse ist die Matrix-Serversoftware; ein zweites Matrix-Serverprogramm wird nicht benötigt. Container und Daten liegen außerhalb von Core. Das Schließen oder Neustarten von Core führt keinen Stoppbefehl für diese Dienste aus.

## In Core

**Administration → Schnittstellen → Matrix / Synapse** zeigt:

- Serverstatus, Synapse-Version und Datenbankstatus.
- Start, Stopp und Neustart.
- Konfiguration von öffentlicher Serveradresse, freigegebenen Partner-Servern und maximaler Dateigröße.
- Suche nach stabilen Synapse-Releases und ausdrücklich bestätigte Aktualisierung.
- Getrennte Freigaben für Status, Betrieb, Konfiguration und Updates.

Standardmäßig sind alle Freigaben aus und es werden keine Verbindungen aufgenommen. Der Bereich erfordert die vorhandene Core-Berechtigung `SYSTEM_ADMIN`. Verbindungsänderungen, Konfigurationsänderungen und Betriebsaktionen verwenden die bestehende aktuelle Core-2FA-Bestätigung. Status- und Update-Suche benötigen ihre jeweilige Freigabe, verändern aber keinen laufenden Container.

Die Freigaben wirken erst nach dem Speichern. Ein Entziehen stoppt Synapse nicht und bricht einen bereits bestätigten Vorgang im unabhängigen Verwaltungsdienst nicht ab. Für eine vollständige technische Entziehung des Zugangs kann die Administration zusätzlich den Steuerungsschlüssel auf dem Verwaltungsrechner austauschen.

## Voraussetzungen und einmalige Einrichtung

- Ein eigener Rechner mit Node.js 22 oder neuer, Docker Engine beziehungsweise Docker Desktop für Linux-Container und Docker Compose v2.
- Ein dauerhaft gewählter Matrix-Servername und eine dazu passende HTTPS-Auslieferung. Den Identitätsnamen eines eingerichteten Servers später nicht umbenennen.
- Ein eigener Ordner für Matrix-Daten. Bestehende fremd verwaltete Installationen werden nicht automatisch übernommen.

Das gesamte Verzeichnis `ops/matrix-server` beispielsweise nach `/opt/bonni-matrix-tools` kopieren. Die Werkzeuge werden unter dem Dienstbenutzer ausgeführt, der später den Matrix-Server verwaltet. Dieser Benutzer benötigt Docker-Rechte. Nur der unabhängige Verwaltungsdienst erhält diese Rechte; Core bekommt weder den Docker-Socket noch eine allgemeine Docker-Befehlsschnittstelle.

Zuerst vorbereiten, mit den eigenen Domainnamen:

```sh
node /opt/bonni-matrix-tools/cli.mjs init \
  --directory /srv/bonni-matrix \
  --server-name matrix.verein.example \
  --public-url https://matrix.verein.example
```

Die Vorbereitung erzeugt noch keine Container. Sie legt eigene Datenordner und zufällige Verwaltungs- und Datenbankschlüssel an. Ein vorhandener nicht leerer Ordner wird abgewiesen. Serverversion und lokaler Client-Port können über `--version 1.165.0` beziehungsweise `--client-port 18008` gesetzt werden. Die ausgelieferte Version wurde am 14.11.2026 gegen die stabile Synapse-Veröffentlichung 1.165.0 abgeglichen.

Danach ausdrücklich installieren und starten:

```sh
node /opt/bonni-matrix-tools/cli.mjs install --directory /srv/bonni-matrix
```

Dabei werden die vorgesehenen Images geladen beziehungsweise gebaut, die Synapse-Konfiguration erzeugt und die beiden eigenen Container gestartet. Datenbank und Synapse verwenden `restart: unless-stopped`. Die PostgreSQL-Hauptversion ist fest auf 17 eingestellt. Die Core-Oberfläche aktualisiert Synapse; ein PostgreSQL-Hauptversionswechsel ist eine gesonderte Datenbankwartung.

Anschließend den eigenen HTTPS-Reverseproxy auf `127.0.0.1:18008` einrichten und die Matrix-Clientpfade sowie `/_synapse/client/` weiterleiten. Die Admin-API wird für die Messenger-Oberfläche nicht öffentlich benötigt. Die Synapse-Erweiterung für lokales Mitgliederverzeichnis und private Föderationsfreigaben ist enthalten. Registrierung und Gastzugang starten geschlossen. Eine leere Partnerliste sperrt Föderation vollständig.

Den ersten Matrix-Administrator einmalig interaktiv anlegen:

```sh
cd /srv/bonni-matrix
docker compose --project-name bonni-matrix --env-file runtime.env --file compose.yaml \
  exec synapse register_new_matrix_user -a -c /data/homeserver.yaml http://localhost:8008
```

Matrix-Kennwörter werden bei diesem Schritt interaktiv eingegeben. Sie gehören nicht in die Core-Steuerungsfelder. Weitere pseudonyme Konten und die Einrichtung der persönlichen Schlüsselsicherung beschreibt das Messenger-Paket 0.3.0.

## Verwaltungsdienst starten und mit Core verbinden

```sh
node /opt/bonni-matrix-tools/cli.mjs serve --directory /srv/bonni-matrix
```

Der Verwaltungsdienst hört standardmäßig ausschließlich auf `127.0.0.1:18090`. Er läuft als eigener Prozess, getrennt von Core und Synapse. Für Linux liegt die anpassbare systemd-Vorlage `bonni-matrix-manager.service` bei. Sie enthält ausdrücklich keine Abhängigkeit von einem Core-Dienst. Unter Windows kann der gleiche Node-Aufruf unabhängig von Core über den vorgesehenen Dienst- beziehungsweise Autostartmechanismus gestartet werden.

In Core eintragen:

- Verwaltungsadresse: `http://127.0.0.1:18090`, wenn beide Prozesse denselben Host verwenden.
- Installationskennung: `bonni-matrix`, sofern bei `init` keine andere gewählt wurde.
- Steuerungsschlüssel: Inhalt der privaten Datei `/srv/bonni-matrix/control.key` ohne Zeilenumbruch.
- Gewünschte Freigaben auswählen und mit der bestehenden Core-2FA speichern.

Der Steuerungsschlüssel wird nicht in Browser-Speicher geschrieben und nicht wieder ausgegeben. Core speichert ihn mit dem vorhandenen `MODULE_PRIVATE_DATA_SECRET` verschlüsselt. Ein Wechsel von Verwaltungsadresse oder Installationskennung übernimmt keinen alten Schlüssel.

Bei einem anderen Host oder bei Core in einem eigenen Container muss die Verwaltungsadresse bewusst erreichbar gemacht werden. Dazu den Verwaltungsdienst nur im vorgesehenen Verwaltungsnetz bereitstellen, gegebenenfalls über einen eigenen HTTPS-Reverseproxy. Die exakte Origin muss auf dem Core-Host in `MATRIX_MANAGER_ALLOWED_ORIGINS` stehen. Es gibt keine freie URL-Weiterleitung und keine Umleitung zu anderen Verwaltungsservern. Der Verwaltungsport gehört nicht ungeschützt ins Internet; HMAC ist kein Ersatz für einen passenden Netzaufbau.

## Was ein Update macht

1. Nur eine zuvor abgefragte stabile Version aus `element-hq/synapse` wird akzeptiert. Vorab-Versionen und andere Image-Quellen sind nicht vorgesehen.
2. Das neue Image wird in einem eigenen Versions-Tag vorbereitet. Der alte lokale Versions-Tag bleibt bestehen.
3. Synapse wird kontrolliert angehalten. Die eigene PostgreSQL-Datenbank wird mit `pg_dump` gesichert und die Sicherung mit `pg_restore --list` geprüft. Konfiguration, Signaturschlüssel und Serverdateien werden zusätzlich archiviert und geprüft. Erst danach wird der neue Stand aktiviert.
4. Ein zuvor laufender Dienst wird gestartet und auf Matrix-API sowie registrierte Bonni-Servererweiterung geprüft. Ein vorher angehaltener Server bleibt angehalten; die Laufprüfung erfolgt beim nächsten bestätigten Start.
5. Schlägt der Start fehl, wird versucht, Datenbank, Serverdateien und vorherige Version aus der gerade erzeugten Sicherung wiederherzustellen. Eine fehlgeschlagene Wiederherstellung bleibt als solcher Zustand sichtbar und sperrt weitere Änderungen.

Ein bloßes Zurückschalten des Images gegen eine bereits veränderte Datenbank wird nicht als Wiederherstellung behandelt. Scheitert die Vorbereitung oder die Sicherung, wird keine neue Serverversion aktiviert. Vorhandene Sicherungen bleiben im privaten Verzeichnis `backups`; es werden keine automatischen Löschungen vorgenommen.

Die Hintergrundarbeit gehört dem Verwaltungsdienst. Ein Verlust der Core-Verbindung beendet sie nicht. Wird der Verwaltungsdienst selbst während einer Änderung beendet, markiert er den unterbrochenen Vorgang beim nächsten Start zur administrativen Prüfung. Er setzt Datenbankänderungen nicht blind fort.

## Manuelle Wiederherstellung

Den Verwaltungsdienst zunächst anhalten und den aktuellen Zustand prüfen. Eine vorhandene vollständige Sicherung kann mit ihrer angezeigten Kennung wiederhergestellt werden:

```sh
node /opt/bonni-matrix-tools/cli.mjs recover \
  --directory /srv/bonni-matrix \
  --backup-id DIE_ANGEZEIGTE_SICHERUNGSKENNUNG
```

Das ersetzt ausschließlich die eigene Matrix-Datenbank und die zugehörigen Serverdateien durch die gewählte Sicherung. Anschließend den Verwaltungsdienst wieder starten. Bei einem vor der vollständigen Sicherung unterbrochenen Vorgang ohne Sicherungskennung ist eine manuelle Prüfung durch die Administration erforderlich.

Die Serversicherung ersetzt nicht die persönliche verschlüsselte Nachrichtenschlüsselsicherung der Benutzer. Wiederherstellungsschlüssel und private Matrix-Geräteschlüssel werden von dieser Verwaltungsoberfläche nicht abgefragt.

## Prüfgrenzen

Die Core-Oberfläche und ihre Bestätigungsabläufe wurden mit echten React-Komponenten in happy-dom geprüft. Core und Verwalter wurden über tatsächliche lokale HTTP-Aufrufe mit signierten Nachrichten, dauerhafter Replay-Abwehr und kontrollierten Docker-Befehlsports getestet. Die Befehlsfolge für Backup, Aktualisierung und Wiederherstellung ist getestet; ein echter Docker-Daemon stand in der Entwicklungsumgebung nicht zur Verfügung. Die beiliegende Synapse-Erweiterung wurde zusätzlich an einem echten lokalen Synapse 1.165.0 mit drei SDK-Clients geprüft.

Vor einem produktiven Update den vollständigen Docker-Stack und eine Wiederherstellung auf dem vorgesehenen Testrechner abnehmen. Das Paket hat auf deinem Rechner noch keine Container installiert oder gestartet.
