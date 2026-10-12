# Bonni Core – Lizenzhinweis

Dieser Ordner gehört zu Bonni Core und enthält die Lizenzhinweise der mitgelieferten Drittanbieter-Abhängigkeiten.

Für Bonni Core selbst ist in der öffentlichen Testversion noch keine Projektlizenz erklärt. Dieser Hinweis erteilt keine zusätzlichen Nutzungsrechte. Vor einer produktiven öffentlichen Freigabe muss die Projektlizenz bewusst festgelegt werden.

## Übergang von 0.1.20 auf 0.1.20+a

Ein Lizenznachweis für Bonni Core 0.1.20 darf nicht nachträglich aus den
Abhängigkeiten oder Dateien von 0.1.20+a erzeugt werden. Beide Stände sind nur
dann gemeinsam im zentralen Katalog zulässig, wenn für 0.1.20 bereits ein
echter, anhand seines Dateibaums prüfbarer Receipt vorhanden ist.

Fehlt dieser Nachweis beim ersten Versionswechsel, bricht die Einrichtung mit
`CORE_LICENSE_PREDECESSOR_EVIDENCE_MISSING:0.1.20` ab. Damit bleibt als offener
Migrationspunkt die kontrollierte Erzeugung des 0.1.20-Receipts aus dem
unveränderten originalen 0.1.20-Build. Bonni Core leitet diesen Nachweis bewusst
nicht aus der neuen Version ab und erfindet keine Projektlizenz.
