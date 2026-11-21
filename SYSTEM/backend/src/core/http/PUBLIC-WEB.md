# core.public-web / bonni.public-web/v1

Allgemeiner, nur lesender Core-Port für ausdrücklich deklarierende Module. `readPage(url)` liefert `{url, contentType, text}`. Gourmet DEV.8 nutzt ihn ausschließlich über seine authentifizierte Verwaltungsroute. Rezeptauswertung und Speichern sind keine Core-Aufgaben.

HTTP(S) ausschließlich Standardports, keine URL-Zugangsdaten, keine Bonni-Cookies, keine Authentifizierungsheader, keine Proxy-Umgebungsvariablen und keine Skriptausführung. Lokale/reservierte Adressen und gemischte öffentliche/private DNS-Antworten werden abgelehnt. Der geprüfte DNS-Satz wird an der tatsächlichen Socket-Auflösung festgeschrieben. Alle Weiterleitungen werden erneut geprüft; kein HTTPS-Downgrade. Grenze: vier Weiterleitungen, insgesamt zwölf Sekunden und 750.000 rohe Antwortbytes. Angefordert wird unkomprimierter HTML-/XHTML-/Klartext, abweichende Kodierung wird abgelehnt. Rückgaben enthalten keine Core-Sitzungsdaten.

Abonnierende Module müssen eigene Rechte, Vorschau und Lastbegrenzung vorsehen. Gourmet erlaubt höchstens drei gleichzeitige Webabrufe, einen je Konto und mindestens 500 ms zwischen Starts. Fehler sind für die Oberfläche unterscheidbar, keine internen DNS-/Verbindungsdetails werden als Erfolg ausgegeben. Kontrollierte DNS-/HTTP-Tests stehen im Gourmet-ZIP unter `verification/gourmet-dev8/source-import.test.mjs`.
