# Bonni Core – Lizenzhinweis

Dieser Ordner gehört zu Bonni Core und enthält die Lizenzhinweise der mitgelieferten Drittanbieter-Abhängigkeiten.

Für Bonni Core selbst ist in der öffentlichen Testversion noch keine Projektlizenz erklärt. Dieser Hinweis erteilt keine zusätzlichen Nutzungsrechte. Vor einer produktiven öffentlichen Freigabe muss die Projektlizenz bewusst festgelegt werden.

## Übergang von 0.1.20 auf 0.1.20+c

Ein Lizenznachweis für Bonni Core 0.1.20 darf nicht nachträglich aus den
Abhängigkeiten oder Dateien von 0.1.20+c erzeugt werden. Der sichere
Update-Bootstrap enthält deshalb einen versionsgebundenen Receipt, der aus den
exakten 0.1.20-Lockfiles und dem unveränderten 0.1.20-Abhängigkeitsstand erzeugt
und mit seinem vollständigen Dateibaum geprüft wurde. Erst danach übernimmt er
den Nachweis in den zentralen Katalog.

Fehlt dieser gebundene Nachweis oder weicht eine Datei beziehungsweise ein Hash
ab, bricht die Einrichtung mit
`CORE_LICENSE_PREDECESSOR_EVIDENCE_MISSING:0.1.20` beziehungsweise einem
Integritätsfehler ab. Bonni Core leitet den Vorgängerbeleg nicht aus der neuen
Version ab und erfindet weiterhin keine Projektlizenz.
