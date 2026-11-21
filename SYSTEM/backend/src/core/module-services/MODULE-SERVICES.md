# Allgemeine Modulschnittstellen

Port bonni.module-services/v1, benötigt core.module-services. Ein Manifest deklariert metadata.moduleServices.provides [{id,version,operations}] und/oder consumes [{provider,id,version,operations,permission}]. permission muss im Manifest bereitgestellt oder angefordert sein. Core interpretiert keine fachlichen Nutzdaten. Die Quelle des jeweiligen Anbieter-Vertrags ist dessen Modul.

Register wird nur während der gestaffelten Modulregistrierung zugelassen. Alle angebotenen Dienste müssen vor Veröffentlichung registriert sein. Erst der synchrone Veröffentlichungscommit aktiviert Anbieter und Verbraucher. Vor dem Entladen werden ihre Fähigkeiten widerrufen. Ein Aufruf nach Deaktivierung oder eine dann eintreffende Antwort wird abgewiesen. Verbraucher dürfen nach Anbieter-Neuladen dieselbe deklarierte Schnittstelle erneut verwenden.

invoke(provider,id,version,operation,input) verlangt eine aktuelle verifizierte Benutzeridentität und die deklarierte Berechtigung. Der Anbieter erhält nur bestätigte sourceModule/actorAccountId und assertActive(), keine frei gesetzten Herkunftskennungen oder Zugangsdaten. JSON-Eingaben werden begrenzt und kopiert, Ergebnisse kopiert. Aufträge ohne aktuellen Benutzerkontext werden nicht als Benutzer ausgegeben; angenommene Hintergrundarbeit besitzt das zuständige Anbietermodul.

Der Port ist eine Fähigkeit innerhalb der gemeinsamen vertrauenswürdigen Node-Laufzeit, keine Isolation gegen bösartigen installierten Modulcode. Fachliche Eingabevalidierung, dauerhafte Quittungen, Konflikte und Wiederholungen definiert der jeweilige Anbieter. 401: keine verifizierte Identität; 403: fehlende Deklaration/Berechtigung; 409: inkompatibler Anbieter; 503: nicht aktiver Partner. Keine automatische Ersatzimplementierung.
