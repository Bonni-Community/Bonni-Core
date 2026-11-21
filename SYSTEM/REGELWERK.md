> Aktueller Entwicklungsstand: Bonni-Core DEV75-Loeschzyklus1. Gemeinsamer Löschzyklus mit den oben genannten drei Paketen; bekannte Grenzen in START-CORE-DEV75-LOESCHZYKLUS1.md.

> Aktueller Build: DEV75-KontorAuto1 (02.11.2026). Die Statusabfrage am moduleServices-Port ist ausschließlich auf deklarierte Partner begrenzt und liefert nur installed/enabled. Fachliche Finanzentscheidungen und Einstellungen verbleiben in den Apps. Geraete1 bleibt enthalten. Anleitung: START-CORE-DEV75-KONTORAUTO1.md im Paketstamm.

# Bonni Core – eigenes Regelwerk

**Stand:** 01.11.2026 · **Dokumentrevision:** 12 · **Bezugsstand:** `0.1.20+h-DEV.75`

Die für alle Module geltenden Regeln stehen im [allgemeinen Regelwerk](regelwerk/ALLGEMEIN.md). Dieses Dokument beschreibt Core selbst. Hub-Produktbegriffe und Stüberl-Fachabläufe gehören in die jeweiligen Modulregelwerke.

Aktuell: Core DEV75-Geraete1 / Stüberl DEV102; bestehende Capture-DEV7-/Gourmet-DEV35-Bindungen bleiben erhalten. Die aktuelle Hub-Verbraucherregel und die Fortschreibungen unten sind maßgeblich; die folgenden älteren Versionsabschnitte bleiben historische Nachweise.

## Zweck und Verantwortung

Core stellt die gemeinsame Laufzeit, Identität, Rechte, Modulverwaltung, geprüfte Kommunikationswege und verwaltete Datenbankverbindungen bereit. Apps und Add-ons liefern ihre eigene Fachlogik und bleiben getrennte, versionierte Pakete. Core vermittelt deklarierte Fähigkeiten; es wird dadurch nicht Eigentümer der über diese Fähigkeiten verwalteten Produkt- oder Finanzdaten.

Manifeste bestimmen angeforderte Fähigkeiten, Installationsvoraussetzungen und technische Einstiegspunkte. Deklarierte Fähigkeiten ersetzen keine Benutzerberechtigung. Das Starten, Deaktivieren und Entladen muss die Verwendbarkeit der Fähigkeiten entsprechend begrenzen. Datenbankschemas werden durch die reguläre Core-Vorbereitung integriert; Module erhalten ausschließlich den freigegebenen Zugriff.

## Aktuelle Hub-Verbraucherregel – DEV71

Eine aktive StüberlApp darf ohne Hub laufen, auch wenn Meet oder andere Apps ohne Hub-Vertrag gleichzeitig aktiv sind. Core zählt nur aktive installierte Apps, die core.hub-products und metadata.hubProducts für hub.products/v2 deklarieren. Add-ons, Plug-ins, Endgeräte und deaktivierte Verbraucher zählen nicht mit. Die Aktivierung eines zweiten solchen Verbrauchers verlangt aktiviertes Hub. Solange zwei aktive Verbraucher bestehen, kann Hub nicht deaktiviert oder entfernt werden. Eine unbeteiligte App wird durch diese implizite Hub-Prüfung nicht gesperrt. Die aktuelle Manifestdeklaration bestimmt die Vertragsbeteiligung; die Registry bestimmt den Aktivierungszustand.

Diese Klarstellung ersetzt die ältere pauschale Zählung installierter Apps. [Entscheidung C071](regelwerk/entscheidungen/2026-10-23-hub-nur-aktive-verbraucher.md). Eine fehlgeschlagene Registry-Abfrage darf weiterhin nicht als leere Installation behandelt werden. Es gibt keine automatische Hub-Installation und keine automatische Umstellung bestehender Hub-Daten.

## Verbindungen und maßgebliche Beschreibungen

| Verbindung | Dokumenteigentümer und Regelwerk |
|---|---|
| Core ↔ Hub | `addon.hub`: [Verbindungsregelwerk](addons/hub/regelwerk/verbindungen/bonni-core.md) |
| Core ↔ StüberlApp | `app.stueberlapp`: [Verbindungsregelwerk](app/stueberlapp/regelwerk/verbindungen/bonni-core.md) |

Die Partnerpakete sind nicht Teil dieses Core-Pakets. Die Links gelten im zusammengesetzten SYSTEM. Neue Partner ergänzen ihr Verbindungsregelwerk nach dem allgemeinen Standard. Core hält hierfür Verweise und seine allgemeinen Dienstverträge vor, keine zweite Kopie der Partner-Fachregeln.

## Stand und Grenzen

Diese Fassung ordnet vorhandene Verantwortlichkeiten und die DEV64-Regel ein. Sie ist keine vollständige Neubeschreibung aller bestehenden Core-Dienste und keine zusätzliche Laufzeitänderung. Die technischen Quellen bleiben unter `backend/src/core`, den Manifesten und den vorhandenen Schnittstellentests. Prüfungen des gelieferten Codes sind in der Paket-Anleitung und `verification/results` beschrieben; für diese Dokumentationsänderung wurden keine zusätzlichen Laufzeittests behauptet.

| Revision | Datum | Änderung |
|---|---|---|
| 1 | 19.10.2026 | Core-Beschreibung vom allgemeinen Regelwerk getrennt und Partnerverbindungen verlinkt. |

## Fortschreibung DEV65

Core vermittelt Hubs v2-Vertrag und vier genaue Rechte für Produkte und Bestand. Die Schema-Vorbereitung führt vom jeweiligen Modul gelieferte, wiederholbar sichere SQL-Dateien unter `prisma/upgrades` im assemblierten Datenbereich vor dem Prisma-Abgleich aus. Fachliche Tabellenänderungen stehen in diesen Moduldateien. Core führt je Datei eine Transaktion aus und bricht bei Fehlern ab. Das ist eine Vorbereitung bei gestopptem System, kein Recht für Module auf freie SQL-Ausführung zur Laufzeit. Die Vorbereitung beider Datenbankziele ist kein verteilter atomarer Commit.

Grund: Reines Schema-Push könnte eine fachliche Umbenennung als Löschen/Neuanlegen behandeln. Explizite modul-eigene Upgrades erhalten Daten und beschreiben die Absicht. Diese Dateien müssen beibehalten werden, solange ältere unterstützte Stände aufrüstbar sind. Signaturen und Typen gehören weiterhin Hub.

| Revision | Datum | Änderung |
|---|---|---|
| 2 | 19.10.2026 | Vermittlung von Hub v2 und modul-eigene Schema-Upgrades ergänzt; keine Änderung der Mehr-App-Regel. |


## Getrennter Gourmet-Basiszweig – 21.10.2026

Auftrag: neue fertige Entwicklungsgrundlage und getrennte ZIPs. Technische Umsetzung durch den Bearbeiter: `0.1.20-gourmet.1+h-DEV.65` basiert auf den verfügbaren DEV65-Quellen und ergänzt den tatsächlich geprüften Gourmet-Anschluss. Es ist keine Wiederherstellung des verlorenen DEV68 und kein allgemeines Update darüber. Stüberl DEV47 und Gourmet DEV.7 verlangen genau diesen Zweig.

Core bereitet die isolierte Gourmet-Domäne mit eigener Rolle, eingeschränkten Delegates und deklarativen Addon-Schemaaufträgen vor. Modulbau und Routenwiederherstellung erkennen Add-ons. Die statische, deklarierte Gourmet-Erweiterung kann im undurchsichtigen Stüberl-Frame laden; API-Rechte und übrige CSP bleiben erhalten. Der tatsächliche optionale Hub-Installationsstatus wird für Stüberls lokalen Produktweg bereitgestellt.

Diese Basis ist ohne Hub geprüft. Die oben historisch beschriebenen Hub-Regeln aus DEV65 werden hier nicht als vollständige DEV68-Koordination ausgegeben. Der separat gelieferte Hub DEV.02 gehört zu seinem ursprünglichen Core/Host-Stand; er ist kein Partner dieser Basis. Gourmet benötigt ihn nicht. Partnerverbindung: [Gourmet ↔ Core](add-on/gourmet/regelwerk/verbindungen/bonni-core.md), Eigentümer Gourmet. Dort stehen Zuständigkeiten, Bestätigung, Rechte, Fehler und aktueller Nachweis.


## Fortschreibung DEV66 – 21.10.2026

Ausdrücklicher Nutzerauftrag: Die bisher als Gourmet-Basis 1 bezeichnete Ausgabe wird als **Bonni Core `0.1.20+h-DEV.66`** geführt. DEV65 ist vollständig die Core-Grundlage; die zuvor geprüften Gourmet-Ergänzungen bleiben enthalten. Die vorstehende technische Kennung `0.1.20-gourmet.1+h-DEV.65` beschreibt den Vorgänger und wird durch DEV66 abgelöst. Es werden keine Inhalte eines nicht verfügbaren späteren Core-Stands behauptet.

Diese Fortschreibung ändert die Versionskennung, zugehörige Paketangaben und die exakten Core-Bindungen in Stüberl DEV47 und Gourmet DEV.7. Fachlogik, Datenbankschemas, Berechtigungen und die Mehr-App-Regel bleiben erhalten. Die drei Bestandteile werden weiterhin als getrennte ZIPs geliefert. Hub DEV.02 bleibt ein unveränderter älterer Bestandsstand außerhalb dieser geprüften Kombination; Gourmet benötigt Hub nicht.

Der vollständige gemeinsame Ablaufnachweis des Vorgängers bleibt mit seiner ursprünglichen Versionskennung erhalten. Die zusätzlichen Versions-, Partner- und Buildprüfungen für DEV66 stehen in `verification/core-dev66` des Core-Pakets.


### Andockkorrektur mit Stüberl DEV48

Die aktuelle geprüfte DEV66-Kombination verwendet Stüberl DEV48 und Gourmet DEV.7. Der Core-Initialisierer verlangt nun DEV48. Die Korrektur der 20 fehlenden Gourmet-RPC-Freigaben liegt im Stüberl-Paket; Core-Dienste, Rechte, Schemas und Core-Versionskennung bleiben erhalten. Der vollständige aktuelle Lauf liegt im Gourmet-Paket unter `verification/gourmet-dev7/results/integration.json`. Die früheren DEV66-Versionsprüfungen bleiben als Nachweise ihres damaligen Host-Standes erhalten.


## Fortschreibung DEV67 – lokaler Gourmet-Import, 21.10.2026

Core DEV67 führt die vorhandene DEV66-Basis fort. Die koordinierte Kombination ist Stüberl DEV49 und Gourmet DEV.8, weiterhin als getrennte Pakete. Core liefert den allgemeinen, deklarierten Port `core.public-web` / `bonni.public-web/v1` für öffentliche HTML-/Textseiten; Gourmet besitzt die Rezeptauswertung. Core sendet keine Sitzungsdaten und prüft URL, DNS, tatsächliches Socketziel und jedes Weiterleitungsziel mit Größen-/Zeitgrenzen. Lokale Ziele sind gesperrt. Vertrag: `backend/src/core/http/PUBLIC-WEB.md`.

Nur der statische Gourmet-Einstieg erhält die für lokale Worker/WASM nötigen CSP- und Builddatei-Ausnahmen. API-Rechte, iframe-Isolation und Medienhoheit bleiben erhalten. Der Core-Initialisierer verlangt exakt Stüberl DEV49 und Gourmet DEV.8. Aktuelle Nachweise: `verification/core-dev67` und im getrennten Gourmet-ZIP `verification/gourmet-dev8`. Keine neuen Fachschemas. Kein Hub-Update und kein signiertes Produktionsrelease.


## Fortschreibung DEV68 – allgemeine Moduldateien, 23.10.2026

Core ergänzt den deklarierten Port core.files / bonni.files/v1. Er besitzt keine Rezept-, Lebensmittel- oder Tippsemantik. Byte-Dateien sind je Modul an die kanonische dauerhafte Ablage gebunden. Relative Pfade, Größen und Symlinks werden geprüft; ein dauerhafter Journalzustand wird vor dem nächsten Portzugriff beendet. Die bereits bestehende Sperre für Datenbank-/Dateigesamtsicherungen schützt diese Operationen mit. Gourmet DEV25 definiert seine eigenen Rezeptordner und Tippdateien. Die aktuelle getrennte Partnerkombination ist Stüberl DEV52 / Gourmet DEV25; der historische Basisinitialisierer bleibt unverändert auf seiner alten Kombination fixiert.


## Fortschreibung DEV69 – allgemeine Kamera und fortsetzbare Bildübertragung

Core stellt einen begrenzten Kamera-/Fotoablagekanal im vertrauenswürdigen Browserursprung bereit. Isolierte Module bekommen dadurch weder allow-same-origin noch Zugangsdaten. Aufnahmen werden konto-/modulgebunden in IndexedDB gespeichert, anhand des aktuellen Modulvertrags übertragen und erst nach passender dauerhafter Empfangsquittung aus dem lokalen Bildspeicher entfernt. Menüwechsel und erneutes Öffnen einer Fachansicht beenden angenommene Übertragungen nicht. Kontoänderungen erneuern Kanal und iframe; Token werden nicht in Fotoeinträgen gespeichert. Core besitzt keine Artikel-, Bon-, Lager- oder Erkennungssemantik. Stüberl DEV54 ist Verbraucher, Gourmet DEV27 verwendet dessen begrenzte Fensteraktion. [Allgemeiner Vertrag](frontend/system/feature-modules/MEDIA-QUEUE.md). Aktuelle Nachweise verification/core-dev69 sowie im getrennten Gourmet-DEV27-Paket. Der geschlossene Browser garantiert keinen laufenden Upload; offene Aufträge werden bei erneutem aktivem, angemeldetem Betrieb fortgesetzt.


## Fortschreibung DEV70 – allgemeine Modulschnittstellen

Core vermittelt bonni.module-services/v1 mit expliziten Anbieter-/Verbraucherdeklarationen, Vertragsversion, Operationen, verifizierter Quell-App und Benutzerberechtigung. Aktivierung und Widerruf folgen dem vorhandenen Laufzeit-Lebenszyklus. Der Port enthält keine Capture-, Artikel-, Rezept- oder Belegfachlogik. frontend.localProcessing erweitert ausschließlich die statische Worker-/WASM-Policy des deklarierenden Moduls; vorhandene Frame- und API-Schutzregeln bleiben erhalten. Capture besitzt seine Erkennungsdateien und Rohaufträge. Maßgebliche Verbindung: [Capture ↔ Core](add-on/capture/regelwerk/verbindungen/bonni-core.md), Eigentümer Capture. Aktuelle getrennte Kombination: Core DEV70, Capture DEV.1, Stüberl DEV56 und Gourmet DEV28. Frühere Zuständigkeitsangaben für Stüberl-OCR beschreiben den damaligen Stand.

## Fortschreibung DEV71 – Verbraucherprüfung und Diagnose

Marios bestätigte Kombination Stüberl + Meet ohne Hub wird durch die deklarierte Verbraucherzählung zugelassen. Der Loader berichtet bereits vor der Hub-Prüfung die Version des tatsächlich gewählten Einstiegs. Exakte Hub-Codes und neue Loaderphasen bleiben im bestehenden Datenschutzfilter sichtbar. Aktuelle Nachweise: verification/core-dev71. Partnerbindungen: Stüberl DEV57, Capture DEV.2, Gourmet DEV29; alle getrennt. Kein Datenbankschemawechsel.

## Fortschreibung DEV72 – deklarierte Erstinitialisierung leerer App-Bereiche

Ein App-Schema-Plan darf mit bootstrap: empty-schema ausdrücklich einen fehlenden oder nach Katalogprüfung leeren eigenen Bereich initialisieren. Ohne diese Angabe bleibt ein vorhandener Datenbankbestand Voraussetzung. Ein belegter Bereich ohne vollständige Anker sowie alte Ankertabellen in public werden angehalten; Core setzt keine vorhandenen Geschäftsdaten zurück. DDL kommt ausschließlich aus dem validierten, fingerprintgebundenen App-Vertrag. Identität, Datenbankziel, Schema-Isolation, Rollen, Sperre und Migrationsledger bleiben Core-Aufgaben. Die Erstinitialisierung ist transaktional. [Entscheidung C072](regelwerk/entscheidungen/2026-10-23-leere-app-datenbank-initialisieren.md). Stüberl bindet Plan v8; v7 bleibt unverändert. Hub-Regel C071 und Capture-Zuständigkeit gelten weiter. Aktuelle Nachweise: verification/core-dev72 sowie verification/stueberl-dev58 im Stüberl-Paket.

## Fortschreibung DEV73 – Datenbereich und Bibliotheken ohne App-Seite

Core registriert den optionalen Datenbereich capture mit eigener Laufzeit-/Eigentümerrolle und aus Capture assemblierten Modellen. Der eingeschränkte Modulzugriff, Datenbankrouting und Fehler bei fehlender Vorbereitung gelten auch dort; andere Module können diese Domäne nicht deklarieren. Die JSON-Notablage wird für Capture nicht als erfolgreiche Datenbankbestätigung verwendet.

Die statische Modulauslieferung unterstützt deklarierte Programmbibliotheken ohne eigenen HTML-Einstieg oder Navigation. Capture kann seine eingebetteten Werkzeuge anbieten und bleibt ohne eigene App-Seite. Die globale RPC-Obergrenze entspricht mit 48 MiB dem vorhandenen Moduldiensttransport; nur die ausdrücklich deklarierten Importvorbereitungsrouten erhalten bis 45 MiB. Sonstige kleine Routen behalten ihre Grenzen.

Keine Capture-Erkennungs-/Rezept-/Belegfachlogik wird in Core implementiert. Die maßgeblichen Verträge und Datenmodelle gehören Capture. Kombination: Core DEV73 / Capture DEV.4 / Stüberl DEV59 / Gourmet DEV31. Aktuelle Nachweise im Capture-Paket unter verification/capture-dev4; historische Nachweise bleiben ihren damaligen Ständen zugeordnet.

Die Zusammenführung erhält die Hub-Verbraucherregel C071 und die deklarierte Erstinitialisierung C072 einschließlich Stüberl-Plan v8. Maßgeblich ist die gemeinsame Kombination Core DEV73 / Capture DEV.4 / Stüberl DEV59 / Gourmet DEV31.

### Historische Abgrenzung der separaten DEV72-Startkorrektur

Die neuere Capture-DEV.2-Ausgabe mit Datenbank und erweiterten Importverträgen bleibt unberührt. Ein vorheriger Capture-DEV.3-Kandidat wurde nicht freigegeben. Die neue Capture-Erweiterung ist in dieser gezielten Startkorrektur nicht zusammengeführt oder als kompatibel bestätigt. Für den gemeldeten Betrieb Stüberl + Meet wird Capture nicht benötigt; dessen Eingabefunktion bleibt getrennt von manuell nutzbaren Fachabläufen. Aktueller Nachweis dieser Korrektur: 90 gezielte Testeinträge, 1 historische Hub-Prüfung ausgelassen.

Diese Abgrenzung betrifft die vorangegangene, getrennte Startkorrektur. In Core DEV73 / Capture DEV.4 / Stüberl DEV59 / Gourmet DEV31 sind beide beauftragten Änderungen zusammengeführt und gemeinsam mit 110 Testeinträgen sowie sechs Browserabläufen geprüft. Der nicht freigegebene DEV.3-Kandidat wird nicht verwendet. Die vollständigen Grenzen stehen im aktuellen START-AKTUELL.txt.

## Fortschreibung DEV74 – Allgemeine Erweiterungsverwaltung und Capture-Schema

Module können die allgemeine maintenance-Schnittstelle bonni.module-maintenance/v1 mit control:true deklarieren. Der Core-Store zeigt deren freigegebene Verwaltung an. status/configure/export verlangen verifiziertes SYSTEM_ADMIN, aktive Anbieter und ausdrücklich deklarierte Operationen. Kein Datei-/Wissensimport über diese Schnittstelle. Core implementiert keine Lebensmittel-, Lern- oder ZIP-Fachlogik.

Der eingeschränkte deklarative Schema-Vertrag unterstützt Capture ausschließlich als Eigentümer der Domäne capture sowie den benötigten Datentyp DOUBLE PRECISION. SQL-Suffixe, fremde Domänen, Dateifingerprints, Eigentümerbindung und bestehende Datenbankschutzregeln bleiben geprüft. Capture besitzt seine fünf Modelle und den gebundenen Erweiterungsplan. C071 und C072 einschließlich Stüberl-Plan v8 bleiben erhalten. Kombination Core DEV74 / Capture DEV.6 / Stüberl DEV62 / Gourmet DEV34.


## Fortschreibung DEV75 – geprüfte Fehlerkorrekturen

C075 bindet Benachrichtigungen an verifizierte Konten/Rollen und ergänzt persönliche Empfängerzustände. Der Request-Validator übergibt geparste Werte; Layout-/404-/Paketfehler werden korrigiert. Bestehende Daten bleiben erhalten. Entscheidung und Grenzen: [C075](regelwerk/entscheidungen/2026-10-29-core-fehlerkorrekturen.md). Aktuelle Nachweise: verification/core-dev75. Gemeinsame Kombination Core DEV75 / Capture DEV7 / Stüberl DEV63 / Gourmet DEV35. Die vorherigen Abschnitte dokumentieren ihre jeweiligen Entwicklungsstände.

## Fortschreibung DEV75-Diagnose1 – 01.11.2026

Core besitzt ein gemeinsames technisches Journal und seine Bereichsfilter: Alle, System einschließlich Hub, StüberlApp, KontorApp, Messenger, HocketApp. Apps liefern optionale, eng begrenzte Diagnoseereignisse; sie liefern keine Dateiinhalte, freie fachliche Texte oder Zugangsdaten. Core setzt Modul-/Bereichszuordnung, geprüfte Identität, Rate, Aufbewahrung und SYSTEM_ADMIN-Lesegrenze durch. Browsermeldungen bleiben als solche erkennbar und beweisen keine serverseitige Speicherung. Zufällige Vorgangs-IDs verbinden Schritte, ohne Produkt- oder Personenkennungen zu protokollieren. Fehler beim Beobachten dürfen keine Fachanfrage verändern. Die bisherige geschützte Fehlerkontextansicht bleibt erhalten.

Stüberl DEV88 instrumentiert die Bildauswahl, RPC-Übertragung und tatsächliche Anzeige. Der erste Klick bedeutet angeforderte Auswahl, nicht nachgewiesener Betriebssystemdialog. Eine Vorschau bestätigt kein gespeichertes Bild. Die Laufzeitkennung DEV75 bleibt wegen bestehender exakter Partnerbindungen bestehen; der kompatible optionale Ausbau ist über CORE-BUILDFIX.json als Diagnose1 unterscheidbar. Nachweise und Grenzen: verification/core-dev75-diagnose1.

## C076 – Optionale Mitgliedergeräte, DEV75-Geraete1

Core ist Eigentümer von Browsercredentials, persönlichen Sitzungen und Gerätesperren. Ein ausdrücklich optierendes Modul erhält den optionalen Mitglieder-Geräteport `bonni.member-devices/v1`. Administrative Liste und Aktionen verlangen verifizierten Core-Administrator und MFA-Sitzungsnachweis; App-Profilrechte allein genügen nicht. Zielmitglied, persönliches Konto und freigegebener Modulzugang werden vor der Änderung und innerhalb der Transaktion geprüft.

Browsercredential ist zufällig, HttpOnly, SameSite Strict und bei HTTPS Secure. Beide Auth-Routen verwenden eng begrenzte Cookiepfade und denselben Wert. Hash statt Credential wird in bestehenden SystemSetting-/Session-Strukturen gespeichert. Keine IP-/Fingerprint-Identifikation und keine Tokenanzeige im Modul. Ein neuer Browser muss sich regulär authentifizieren.

Abmelden beendet Sitzungen; Sperren verhindert zusätzlich die Wiederanmeldung desselben gespeicherten Browserzugangs dieses Kontos; Freigeben stellt keine Sitzung wieder her. Eindeutiger gebundener Aktionsbeleg und Sperr-/Sitzungsänderung werden gemeinsam transaktional gespeichert; Konflikte/Fehler dürfen keine Teiländerung hinterlassen. Ältere Sitzungen ohne Credentialzuordnung sind nur abmeldbar. Keine neue Prisma-Struktur oder Schemaänderung.
