# Bonni Core auf Unraid im Browser einrichten

Die Unraid-Vorlage liegt im Bonni-Core-ZIP für AMD64. Unraid lädt beim Anlegen das zu diesem Paket gehörende Bonni-Core-Image aus der Registry. Für diesen Schritt braucht der Server Internetzugriff.

1. `my-Bonni-Core.xml` aus dem Bonni-Core-ZIP über den Unraid-Dateimanager in **Flash → config → plugins → dockerMan → templates-user** ablegen.
2. Unter **Docker → Container hinzufügen** die Vorlage **Bonni-Core** auswählen. Den Webport und für eine Ersteinrichtung einen leeren Datenordner wählen. Danach den Container anlegen.
3. Über das Containersymbol **WebUI** öffnen. Den Einrichtungscode aus **Logs** kopieren, das Passwort für **admin** festlegen und die Einrichtung bestätigen.

Bonni zeigt den Startfortschritt an und öffnet anschließend die Anmeldung. Bei einem späteren Neustart erscheint direkt die Anmeldung.

Die Vorlage richtet eine neue Einzelcontainer-Installation ein. Daten einer früheren Compose-Installation müssen gesondert übernommen werden.
