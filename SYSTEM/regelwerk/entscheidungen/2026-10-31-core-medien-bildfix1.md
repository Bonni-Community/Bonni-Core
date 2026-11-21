# C075-Bildfix1 – größenfeste Medienvalidierung

Der Base64-Validator muss alle Nutzdaten innerhalb seiner eigenen Höchstgrenze ohne Stackfehler prüfen können. Vor der Buffer-Allokation wird die kodierte Länge begrenzt; nach der Dekodierung muss die kanonische Base64-Rückkodierung exakt übereinstimmen. Damit bleiben Alphabet, Padding und ungenutzte Bits geprüft. Die bisherige stackanfällige RegExp entfällt.

Die Änderung ist ein gezielter DEV75-Paketbuild mit separater Buildkennung CORE-BUILDFIX.json. Medienvertrag, Laufzeitversion, Datenbankschema und Berechtigungen bleiben unverändert. Keine neue Freigabe für Fremdmedien und keine Datenübernahme. Nachweise und Grenzen: verification/core-dev75-bildfix1.
