# Allgemeines Bonni-Regelwerk

**Stand:** 19.10.2026 · **Dokumentrevision:** 2 · **Geltung:** Bonni Core sowie alle Apps, Add-ons und ihre Verbindungen.

Dieses Dokument ist die gemeinsame Grundlage. Jede App und jedes Add-on erhält zusätzlich eine eigene Beschreibung und für jede konkrete Verbindung ein eigenes Verbindungsregelwerk. Damit bleiben Zweck, Datenhoheit und Zusammenarbeit auch für spätere Entwickler ohne Kenntnis des ursprünglichen Gesprächs nachvollziehbar.

## A01 – Drei Ebenen mit klaren Zuständigkeiten

| Ebene | Inhalt | Maßgeblicher Ablageort |
|---|---|---|
| Allgemeines Regelwerk | Gemeinsame Architektur- und Dokumentationsregeln | `SYSTEM/regelwerk/ALLGEMEIN.md` im Core-Paket |
| Eigenes Regelwerk | Zweck, Begriffe, Daten, interne Regeln und Grenzen genau einer App oder eines Add-ons | `REGELWERK.md` im jeweiligen Modulverzeichnis; bei Core `SYSTEM/REGELWERK.md` |
| Verbindungsregelwerk | Zusammenarbeit genau zweier benannter Partner, Datenwege, Rechte, Fehlerfälle und tatsächlicher Integrationsstand | `regelwerk/verbindungen/<partner>.md` beim dokumentierten Eigentümer dieser Verbindung |

Ein eigenes Regelwerk muss das Modul für sich verständlich beschreiben. Besondere Abläufe mit einem anderen Modul stehen im Verbindungsregelwerk. Technische Verträge und Schemas bleiben als präzise Ergänzungen erhalten und werden verlinkt.

## A02 – Eine maßgebliche Quelle pro Regel

Jede Regel hat einen erkennbaren Eigentümer. Das anbietende Modul definiert die Bedeutung seiner Daten und seine Schnittstelle. Der Verbraucher passt seine Anbindung daran an. Insbesondere legt Hub die gemeinsamen Produktbegriffe fest; StüberlApp und andere Verbraucher führen in Hub keine Ersatzfelder oder gleichbedeutenden Parallelmodelle ein.

Das Verbindungsregelwerk beschreibt die Anwendung der Anbietervorgaben durch den konkreten Partner. Es ändert diese Vorgaben nicht nebenbei. Allgemeine Regeln gelten für alle Module. Ein Widerspruch wird als offene Abweichung benannt und an der verantwortlichen Quelle geklärt; es gibt keinen stillschweigenden Vorrang nach Dateidatum oder eine zweite Wahrheit in einer Kopie.

## A03 – Verbindungen werden einmal beschrieben

Für ein Partnerpaar gibt es eine maßgebliche fachliche Beschreibung mit beiden Modulkennungen und benanntem Dokumenteigentümer. Bei einer Anbieter-Verbraucher-Verbindung liegt sie grundsätzlich beim Verbraucher. Die andere Seite führt einen Verweis in ihrem eigenen Regelwerk. Bei gleichberechtigten Partnern wird ein Eigentümer ausdrücklich benannt.

Für StüberlApp ↔ Hub liegt die Beschreibung in StüberlApp unter `regelwerk/verbindungen/hub.md`; Hub verweist darauf. Für Hub ↔ Core liegt sie im Hub-Paket. Mehrere technische Teilverträge derselben Verbindung werden dort gemeinsam eingeordnet. Technisch erzeugte Vertragskopien sind zulässig, wenn Quelle und Übereinstimmung klar sind; sie sind keine unabhängig gepflegten Regelwerke.

## A04 – Mindestinhalt

Jedes eigene Regelwerk enthält Modulkennung, Zweck, Datenhoheit, feste Begriffe, Bedienkonzept, Verbindungsverzeichnis, tatsächlichen Stand, offene Aufgaben und Änderungsnachweis.

Jedes Verbindungsregelwerk enthält Partner und Dokumenteigentümer, Zweck, Richtung und Verantwortung der Daten, technische Vertragsquellen, Rechte, verbindliche Bestätigung, Wiederholung und Konflikte, Verhalten bei Ausfall oder fehlendem Partner, Auswirkungen auf die Oberfläche und den geprüften beziehungsweise offenen Umsetzungsstand.

## A05 – Eigenständigkeit und Datenhoheit

Apps und Add-ons haben eigene Pakete und Versionen. Die Nutzung von Core-Diensten macht ihre Fachlogik nicht zum Eigentum von Core. „Unabhängig von einer anderen App“ bedeutet nicht automatisch einen eigenen Server ohne Core.

Core stellt die gemeinsame Laufzeit, verifizierte Identität und zugelassene Fähigkeiten bereit. Ein Modul greift auf fremde Daten ausschließlich über dafür vorgesehene Verträge zu. Ein App-Zugang oder eine fehlende eigene Oberfläche ersetzt keine fachliche Berechtigung.

## A06 – Eindeutige Bestätigung je Vorgang

Jeder Vertrag benennt, wer einen Vorgang verbindlich bestätigt. Ein lokaler Entwurf, ein dauerhaft angenommener Auftrag, eine fachlich ausgeführte Buchung und eine Zahlung sind unterschiedliche Zustände. Fehlende Antworten werden nicht als Erfolg ausgegeben; Wiederholungen und konkurrierende Änderungen benötigen ein definiertes Verfahren.

Die Stüberl-Bestellablage und eine Hub-Produktänderung haben unterschiedliche Bestätigungsregeln. Einzelheiten stehen in den jeweiligen Regelwerken. Ein Verfahren darf nicht unbemerkt auf einen anderen Vertrag übertragen werden.

## A07 – Wahrheit über den Entwicklungsstand

Fachlich beschlossen, technisch umgesetzt und tatsächlich geprüft werden getrennt ausgewiesen. Dokumentation führt keine Migration aus und aktiviert keine Funktion. Eine bekannte Abweichung wird sichtbar beschrieben, bis sie behoben ist. Beispiele begrenzen den Anwendungsbereich nur dann, wenn dies ausdrücklich festgelegt ist.

Laufzeitversion, Vertragsversion und Dokumentrevision sind getrennte Angaben. Eine reine Dokumentationsänderung muss keine neue Laufzeitversion erzeugen. Brechende Schnittstellenänderungen und Datenübernahmen benötigen eine ausdrückliche technische Behandlung.

## A08 – Auffindbarkeit und Fortschreibung

Die README jedes Moduls verweist auf sein eigenes Regelwerk. Dieses verweist auf das allgemeine Regelwerk und listet seine Verbindungen auf. In einem getrennten Quellpaket dürfen Links auf optionale Partner fehlen, solange Ziel und benötigtes Partnerpaket erklärt sind; es wird keine zweite inhaltliche Kopie mitgeliefert.

Vor einer Änderung werden die betroffenen allgemeinen, eigenen und verbindungsspezifischen Regeln gelesen. Entscheidungen werden an ihrer maßgeblichen Stelle mit Datum, Grund und Umsetzungsstand fortgeschrieben. Die bisherige Entscheidung bleibt im Änderungsnachweis nachvollziehbar. Vorhandene Detaildokumente werden verlinkt und bei Widersprüchen ausdrücklich eingeordnet.

Für wesentliche Entscheidungen wird zusätzlich ein Entscheidungsnachweis geführt: Datum, fachlicher Auftraggeber und technischer Bearbeiter, Ausgangsproblem, gewählte Lösung, Grund, betrachtete Alternativen und deren Ablehnung, betroffene Module/Verträge, Folgen einer späteren Änderung sowie Umsetzungs- und Prüfstand. Wer eine Lösung technisch auswählt, darf sie nicht nachträglich als ausdrücklich vom Auftraggeber vorgegeben ausgeben.

Spätere Entscheidungen verweisen auf die ersetzte Entscheidung. Frühere Begründungen bleiben erhalten; ein weiterer Entwickler muss nachvollziehen können, warum ein Verhalten entstand und welche Abhängigkeiten eine Änderung berührt. Ein Regelwerk beschreibt den jeweils gültigen Stand, der Entscheidungsnachweis seine Entstehung.

## Verzeichnis des aktuellen Arbeitsstands

| Modul | Eigenes Regelwerk | Maßgebliche Verbindungsregelwerke |
|---|---|---|
| Bonni Core | [Core](../REGELWERK.md) | Verweise auf die Verbraucherregelwerke im Core-Regelwerk |
| `addon.hub` | [Hub](../addons/hub/REGELWERK.md) | [Hub ↔ Core](../addons/hub/regelwerk/verbindungen/bonni-core.md) |
| `app.stueberlapp` | [StüberlApp](../app/stueberlapp/REGELWERK.md) | [Stüberl ↔ Core](../app/stueberlapp/regelwerk/verbindungen/bonni-core.md), [Stüberl ↔ Hub](../app/stueberlapp/regelwerk/verbindungen/hub.md), [Stüberl ↔ Kontor](../app/stueberlapp/regelwerk/verbindungen/kontor.md) |

Hub und Stüberl werden separat geliefert. Kontors eigenes Regelwerk ist hier noch nicht vorhanden; der Verweis beschreibt zunächst den in Stüberl vorliegenden Verbindungsstand. Für weitere Apps und Add-ons gilt dieselbe Struktur; ihre Beschreibung wird beim jeweiligen Modul ergänzt und nicht als bereits erstellt ausgegeben.

Vorlagen: [eigenes Regelwerk](VORLAGE-MODUL.md) und [Verbindungsregelwerk](VORLAGE-VERBINDUNG.md).

| Revision | Datum | Änderung |
|---|---|---|
| 1 | 19.10.2026 | Auf Marios Vorgabe allgemeine Regeln, eigene Modulbeschreibungen und partnerbezogene Verbindungsregeln getrennt; eindeutige Dokumenteigentümer und Verweise festgelegt. |
| 2 | 19.10.2026 | Marios Anforderung zur langfristigen Nachvollziehbarkeit ergänzt: Verantwortliche, Alternativen, Änderungsfolgen und Bezüge auf ersetzte Entscheidungen. |
