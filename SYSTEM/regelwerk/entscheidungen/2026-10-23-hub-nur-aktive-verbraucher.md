# C071 – Nur aktive Hub-Verbraucher zählen

Datum: 23.10.2026. Eigentümer der Core-Aktivierungsregel: Bonni Core. Bezugsstand: 0.1.20+h-DEV.71.

Mario meldet einen Start ohne ausgewähltes Hub und präzisiert: Stüberl ist der einzige Hub-Verbraucher; Meet ist aktiv, benutzt aber diese Schnittstelle nicht. Marios aktuelle Klarstellung ersetzt die pauschale Regel, die deaktivierte installierte Apps sowie Apps ohne Hub-Vertrag mitzählt. Die ältere Beschreibung in Core und die spätere Stüberl-Verbindungspräzisierung waren widersprüchlich; diese Entscheidung macht die nun verlangte Grenze verbindlich.

Core zählt aktive installierte Apps mit gemeinsam deklariertem core.hub-products und metadata.hubProducts für hub.products/v2. Aktuelle entdeckte Manifeste haben für die Vertragszuordnung Vorrang vor veralteten Registrykopien; der Aktivierungsstatus bleibt aus der Registry. Eine beabsichtigte Aktivierung zählt die Kandidaten-App einmal. Die Installation eines inaktiven Pakets aktiviert es nicht. Zwei aktive Verbraucher benötigen aktiviertes Hub. Apps ohne diesen Vertrag sind von dieser impliziten Voraussetzung nicht betroffen. Explizit im eigenen Manifest verlangte Abhängigkeiten bleiben verbindlich. Core installiert oder aktiviert Hub nicht automatisch.

Der Loader löst den gewählten Einstieg und dessen Version vor der Hub-Prüfung auf. Diagnose und Export erhalten HUB_REQUIRED_FOR_MULTIPLE_APPS, check-hub-policy und die Anzahl der Verbraucher als fest freigegebene technische Felder. Der Datenschutzfilter bleibt geschlossen für beliebige Texte, Zugangsdaten und Geschäftsdaten.

Es werden keine Apps deaktiviert, keine fachlichen Daten gelöscht, keine Hub-Daten umgestellt und keine Datenbankschemas verändert. Stüberls bereits gespeicherte Entscheidung für einen verbundenen Hub-Master wird dadurch nicht auf lokalen Betrieb zurückgesetzt. Beleg: verification/core-dev71 im Paketstamm. Ein vollständiger Start auf Marios Windows-System steht aus.
