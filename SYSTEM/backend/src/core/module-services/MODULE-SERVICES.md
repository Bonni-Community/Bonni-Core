# Allgemeine Modulschnittstellen

Port bonni.module-services/v1, benötigt core.module-services. Ein Manifest deklariert metadata.moduleServices.provides [{id,version,operations}] und/oder consumes [{provider,id,version,operations,permission}]. permission muss im Manifest bereitgestellt oder angefordert sein. Core interpretiert keine fachlichen Nutzdaten. Die Quelle des jeweiligen Anbieter-Vertrags ist dessen Modul.

Register wird nur während der gestaffelten Modulregistrierung zugelassen. Alle angebotenen Dienste müssen vor Veröffentlichung registriert sein. Erst der synchrone Veröffentlichungscommit aktiviert Anbieter und Verbraucher. Vor dem Entladen werden ihre Fähigkeiten widerrufen. Ein Aufruf nach Deaktivierung oder eine dann eintreffende Antwort wird abgewiesen. Verbraucher dürfen nach Anbieter-Neuladen dieselbe deklarierte Schnittstelle erneut verwenden.

invoke(provider,id,version,operation,input) verlangt eine aktuelle verifizierte Benutzeridentität und die deklarierte Berechtigung. Der Anbieter erhält nur bestätigte sourceModule/actorAccountId und assertActive(), keine frei gesetzten Herkunftskennungen oder Zugangsdaten. JSON-Eingaben werden begrenzt und kopiert, Ergebnisse kopiert. Aufträge ohne aktuellen Benutzerkontext werden nicht als Benutzer ausgegeben; angenommene Hintergrundarbeit besitzt das zuständige Anbietermodul.

Der Port ist eine Fähigkeit innerhalb der gemeinsamen vertrauenswürdigen Node-Laufzeit, keine Isolation gegen bösartigen installierten Modulcode. Fachliche Eingabevalidierung, dauerhafte Quittungen, Konflikte und Wiederholungen definiert der jeweilige Anbieter. 401: keine verifizierte Identität; 403: fehlende Deklaration/Berechtigung; 409: inkompatibler Anbieter; 503: nicht aktiver Partner. Keine automatische Ersatzimplementierung.

## Mitgliederbereich

Eine App meldet Menüpunkte unter `metadata.memberNavigation` an. Jeder Eintrag
hat `section`, `label` und `profiles`. Zum Manifest gehört ein Moduldienst
`memberArea` in der Version `bonni.member-area/v1` mit den Operationen
`status` und `confirmPrivacy`.

`status` liefert `{ enabled: false }` oder
`{ enabled: true, sections, privacy: { version, text, acknowledged } }`.
Die App ermittelt die freigeschalteten Abschnitte und die gültige Bestätigung
für `context.actorAccountId`. Core blendet nur die Beiträge dieser App aus,
wenn sie ihren Mitgliederbereich abschaltet oder ihr Status fehlt.

`privacy.translations.en` kann zusätzlich die englische Fassung desselben
Hinweises liefern. `confirmPrivacy` bekommt die angebotene `version` und die
gewählte Sprache als `language` mit dem Wert `de` oder `en`. Die App prüft
diese Version erneut, speichert die Bestätigung für das Konto und meldet einen
Versionskonflikt mit 409. Der Aufruf ist für dieselbe Version wiederholbar.
Core lädt die Fachansicht mit `memberSection`, sobald `status` die Bestätigung
meldet. Die App prüft ihre Voraussetzungen weiterhin auf ihren Fachrouten.
Eine Bestätigung gilt nur für die App, die sie entgegengenommen hat.
