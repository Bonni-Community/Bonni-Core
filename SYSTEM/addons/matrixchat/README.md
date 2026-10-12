# MatrixChat Add-on für Bonni Core

MatrixChat erweitert Bonni Core um einen ein- und ausklappbaren Matrix-Chat-Dock.
Es ist ausdrücklich **keine App**: Es erscheint nicht unter „Meine Apps“, erhält
keine App-Route und benötigt keine App-Zuweisung für Benutzer.

Bonni Core übernimmt Installation, Aktivierung und die Einbettung in den
Shell-Slot `chat-dock`. Die Anmeldung am Matrix-Homeserver erfolgt direkt im
Browser; Matrix-Passwort und Access-Token werden nicht an das Bonni-Backend
gesendet.

## Modulvertrag

```text
Kind: addon
Key: addon.matrixchat
Version: 0.2.1
Shell-Slot: chat-dock
```

Der Dock wird für angemeldete Bonni-Benutzer eingeblendet, sobald das Add-on im
Control Center installiert und aktiviert ist. Add-on- und technische
Zugriffsrechte bleiben davon getrennt und werden nicht als App-Freigabe
behandelt.

## Funktionsumfang

- Matrix-Anmeldung per Benutzername und Passwort
- Raumliste mit Suche, Einladungen und ungelesenen Nachrichten
- Beitreten über Raum-ID oder Alias
- Textnachrichten mit lokaler Sendeanzeige
- grundlegende Ende-zu-Ende-Verschlüsselung über Matrix Rust Crypto
- sicherer Bonni-Kontextkanal für `addon.matrixchat`
- kompakte, responsive Dock-Oberfläche
- kein Launcher-Eintrag und keine App-Benutzerzuweisung

## Konfiguration

Die Laufzeitkonfiguration liegt unter:

```text
frontend/public/matrix-config.json
```

Beispiel:

```json
{
  "defaultHomeserver": "https://matrix.example.org",
  "allowHomeserverEdit": false,
  "allowedHomeservers": ["https://matrix.example.org"]
}
```

`defaultHomeserver` darf leer bleiben. Dann trägt der Benutzer seinen
Homeserver selbst ein. Eine leere `allowedHomeservers`-Liste erlaubt jeden
gültigen HTTPS-Homeserver. Unverschlüsseltes HTTP ist nur für `localhost`
zulässig.

Der Matrix-Homeserver muss CORS für die Bonni-Core-Origin erlauben. In der
Produktion sollten Bonni Core und Matrix ausschließlich über HTTPS erreichbar
sein.

## Bauen

```bash
cd addons/matrixchat/frontend
npm ci
npm test
npm run build
```

Bonni Core erwartet anschließend:

```text
addons/matrixchat/frontend/dist/index.html
```

## Installieren

1. Den Ordner `matrixchat` unter `System/addons/` ablegen.
2. Das mitgelieferte Bonni-Core-Frontend mit Chat-Dock-Unterstützung verwenden.
3. Im Control Center `addon.matrixchat` installieren und aktivieren.
4. Die Bonni-Core-Oberfläche neu laden; der Chat-Schalter erscheint unten
   rechts.

Eine `moduleAccess`-Zuweisung vom Typ `app` ist nicht vorgesehen. Das Add-on
wird global durch Installation und Aktivierung gesteuert.

## Sicherheitsgrenzen

- Die Matrix-Sitzung liegt ausschließlich im Browser-Speicher der gemeinsamen
  Bonni-Core-Origin. Ohne „Angemeldet bleiben“ wird `sessionStorage`, andernfalls
  `localStorage` verwendet.
- Der Rust-Crypto-Speicher wird mit einem aus der Gerätesitzung abgeleiteten
  Schlüssel verschlüsselt. Da installierte Bonni-Pakete dieselbe Web-Origin
  teilen, dürfen nur vertrauenswürdige Pakete installiert werden.
- Das Matrix-Passwort wird nie gespeichert.
- Verschlüsselte Räume werden unterstützt, aber Geräteverifikation,
  Wiederherstellung über Sicherheitsschlüssel und Schlüssel-Backup besitzen
  noch keine eigene Oberfläche.
- Matrix-SSO, Anhänge, Anrufe, Reaktionen, Threads und Nachrichtenbearbeitung
  sind noch nicht Teil dieser Version.
- Für echtes Single Sign-on zwischen Bonni Core und Matrix ist zusätzlich eine
  serverseitige Identity-/Token-Brücke erforderlich. Ein Matrix-Admin-Token darf
  niemals an dieses Frontend ausgeliefert werden.

## Entwicklung

`npm run dev` zeigt den Dock-Inhalt im Vite-Entwicklungsmodus auch ohne
Bonni-Host. Der Produktions-Build akzeptiert nur den Bonni-Core-Kontext für
`addon.matrixchat`.
