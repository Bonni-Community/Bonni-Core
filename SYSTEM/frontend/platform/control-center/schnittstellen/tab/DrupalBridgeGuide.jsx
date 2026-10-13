import { useId, useState } from "react";

const INSTALL = `vendor/bin/drush en bonni_web_bridge -y
# Für einen Drupal-Commerce-Shop zusätzlich:
vendor/bin/drush en bonni_web_bridge_commerce -y
vendor/bin/drush updatedb -y
vendor/bin/drush cache:rebuild`;

const SECRET = `mkdir -p /srv/bonni-secrets
openssl rand -hex 32 > /srv/bonni-secrets/drupal.key`;

const SETTINGS = `$settings['bonni_web_bridge'] = [
  'enabled' => TRUE,
  'siteId' => 'mein-verein-drupal',
  'secretFile' => '/srv/bonni-secrets/drupal.key',
  'webEnabled' => TRUE,
  'shopEnabled' => TRUE,
];`;

const CATALOG = `$settings['bonni_web_bridge']['catalog'] = [
  'enabled' => TRUE,
  'storeId' => 1,
  'productType' => 'default',
  'variationType' => 'default',
  'ownerId' => 1,
];`;

const HISTORY = String.raw`vendor/bin/drush php:eval 'echo json_encode(\Drupal\bonni_web_bridge_commerce\OrderHistory::batch("2026-09-01", "2026-09-30", 0, 25), JSON_THROW_ON_ERROR) . PHP_EOL;'`;

function Command({ children }) {
  return <pre tabIndex={0}><code>{children}</code></pre>;
}

export default function DrupalBridgeGuide() {
  const [open, setOpen] = useState(false);
  const guideId = useId();
  return <section className="cc-system-card cc-web-bridge-guide" aria-labelledby={`${guideId}-title`}>
    <div className="cc-system-card__header">
      <div>
        <h2 id={`${guideId}-title`}>Drupal Bridge – Anleitung</h2>
        <p>Installation, Verbindung, Produkte und Bestellungen. Die Anleitung ist in Bonni Core gespeichert und auch ohne Internet lesbar.</p>
      </div>
      <button type="button" className="cc-settings-action-button" aria-expanded={open} aria-controls={guideId} onClick={() => setOpen(current => !current)}>
        {open ? "Anleitung schließen" : "Anleitung öffnen"}
      </button>
    </div>
    <div id={guideId} className="cc-web-bridge-guide__sections" hidden={!open}>
      <p>Gilt für die Drupal Bridge 0.2.0 und den Commerce-Adapter 0.2.0. Bonni Core läuft lokal, Drupal auf dem öffentlichen Webserver. Bonni baut die HTTPS-Verbindung auf; eine Portfreigabe zum lokalen Core ist dafür nicht nötig.</p>

      <details open>
        <summary>1. Drupal Bridge installieren oder aktualisieren</summary>
        <ol>
          <li>Das Paket <strong>Bonni-Drupal-Web-Bridge-0.2.0.zip</strong> aus dem CMS-Ordner des Core-DEV-Pakets entpacken.</li>
          <li>Den Ordner <code>bonni_web_bridge</code> nach <code>web/modules/custom/</code> auf dem Drupal-Server kopieren. Für einen Drupal-Commerce-Shop zusätzlich <code>bonni_web_bridge_commerce</code> kopieren. Den Pfad bei einer anderen Projektstruktur anpassen.</li>
          <li>Bei einem Update die bisherigen Modulordner ersetzen. Im Drupal-Projektverzeichnis die Module aktivieren, Datenbankupdates ausführen und den Cache leeren:</li>
        </ol>
        <Command>{INSTALL}</Command>
        <p>Die Bridge ist für Drupal 10.3/11 vorgesehen. Für den Shop muss Drupal Commerce mit Produkt- und Bestellmodul eingerichtet sein. Der Commerce-Adapter verwendet einen eigenen Store sowie passende Produkt- und Variantentypen.</p>
        <p>Ohne Drush lässt sich das Basismodul über Drupals Erweiterungsverwaltung aktivieren. Bei einem Update müssen auch die Drupal-Datenbankupdates ausgeführt werden.</p>
      </details>

      <details>
        <summary>2. Verbindungsschlüssel und Drupal-Einstellungen</summary>
        <p>Auf dem Drupal-Server eine Schlüsseldatei außerhalb des öffentlichen Web-Verzeichnisses erzeugen. Das folgende Beispiel erzeugt einen neuen Schlüssel; bei einem Update den vorhandenen Schlüssel behalten.</p>
        <Command>{SECRET}</Command>
        <p>Datei und Verzeichnis so berechtigen, dass der PHP-Prozess die Datei lesen kann und Unbefugte keinen Zugriff haben. Besitzer und Gruppe an den Server anpassen. Der Schlüssel besteht aus genau 64 kleinen Hex-Zeichen.</p>
        <p>In <code>sites/default/settings.php</code> ergänzen. Site-ID und Dateipfad sind Beispiele. Ohne Commerce-Shop <code>shopEnabled</code> auf <code>FALSE</code> setzen.</p>
        <Command>{SETTINGS}</Command>
        <p>Anschließend den Drupal-Cache leeren. Für die Ausgabe der Überschrift und des Texts im Drupal-Blocklayout den Block „Bonni – öffentliche Web-Inhalte“ platzieren.</p>
      </details>

      <details>
        <summary>3. Drupal mit Bonni Core verbinden</summary>
        <ol>
          <li>Hier im Drupal-Reiter die öffentliche Website-Adresse mit <code>https://</code> eintragen. Liegt Drupal in einem Unterverzeichnis, dieses in die Adresse aufnehmen.</li>
          <li>Dieselbe Site-ID und den Inhalt der Schlüsseldatei als Verbindungsschlüssel eintragen.</li>
          <li>„Verbindung aktivieren“ und die gewünschten Funktionen wählen: Web-Inhalte übertragen und gegebenenfalls Shop-Bestellungen abholen.</li>
          <li>Mit „Mit Zwei-Faktor-Authentifizierung (2FA) speichern“ bestätigen. Dafür muss die Zwei-Faktor-Authentifizierung im Core eingerichtet sein.</li>
          <li>„Gespeicherte Verbindung prüfen“ und anschließend „Jetzt synchronisieren“ auswählen. Die Prüfung verwendet die gespeicherten Einstellungen.</li>
        </ol>
        <p>Im Labor manuell synchronisieren. Die automatische Abholung läuft im aktiven Produktiv-Core, wenn sie eingeschaltet ist. Pro Durchlauf werden höchstens 25 Bestellmeldungen abgeholt. Bei einem Verbindungsfehler bleiben unbestätigte Meldungen im Drupal-Shop gespeichert und können später abgeholt werden.</p>
        <p>Drupal und TYPO3 verwenden jeweils einen eigenen Schlüssel. Nach einem Wechsel von Adresse oder Site-ID einen neuen Schlüssel hinterlegen und die Web-Inhalte erneut bewusst freigeben.</p>
      </details>

      <details>
        <summary>4. Produkte im Drupal-Commerce-Shop veröffentlichen</summary>
        <p>Für echte Shop-Artikel in <code>settings.php</code> zusätzlich den Katalogimport einschalten:</p>
        <Command>{CATALOG}</Command>
        <p>Store-ID, Eigentümerkonto, Produkttyp und Variantentyp an den eigenen Shop anpassen. Der Variantentyp muss zum Produkttyp gehören und darf keine Produktattribute wie Größe oder Farbe haben. Zusätzliche Pflichtfelder müssen erfüllt sein. Die Beschreibung wird als Klartext mit dem Drupal-Textformat <code>plain_text</code> gespeichert.</p>
        <ol>
          <li>In Bonni „Öffentliche Web-Inhalte“ öffnen und „Shop-Artikel hinzufügen“ wählen.</li>
          <li>Artikelnummer, Name, Beschreibung, Preis mit Dezimalpunkt (zum Beispiel <code>19.90</code>) und Währung (zum Beispiel <code>EUR</code>) eintragen.</li>
          <li>„Im Shop verfügbar“ aktivieren. Neue Artikel sind zunächst nicht verfügbar.</li>
          <li>„Für die Website freigeben und übertragen“ auswählen.</li>
        </ol>
        <p>Die Freigabe ersetzt den gesamten Bonni-Katalog dieser Website. Beim Bearbeiten bleibt die Artikel-ID erhalten; wiederholte Übertragungen aktualisieren denselben Artikel. Entfernte oder nicht verfügbare Bonni-Artikel werden ausgeblendet. Bereits bestehende manuelle Shop-Artikel werden nicht übernommen; eine fremde Artikelnummer wird abgewiesen.</p>
        <p>Eine belegte Artikelnummer kann nach Entfernen aus der Freigabe nicht sofort einem neuen Artikel zugewiesen werden. Bestehende Bestellpositionen bleiben erhalten. „Verfügbar“ steuert die Veröffentlichung, keine Lagerreservierung. Steuern, Versand und Zahlung werden weiterhin in Drupal Commerce eingerichtet.</p>
      </details>

      <details>
        <summary>5. Neue und ältere Bestellungen abholen</summary>
        <p>Nach Aktivierung des Commerce-Adapters werden abgeschickte Bestellungen und spätere Änderungen bereitgestellt. Entwürfe werden nicht übertragen. Im Core „Shop-Bestellungen abholen“ aktivieren und synchronisieren.</p>
        <p>Für ältere Bestellungen im Drupal-Projektverzeichnis den Nachimport ausführen. Beispiel: September 2026, erstes Paket mit höchstens 25 Bestellungen.</p>
        <Command>{HISTORY}</Command>
        <p>Die Ausgabe enthält <code>examined</code> (geprüft), <code>queued</code> (bereitgestellt), <code>after</code> (Fortsetzungsmarke) und <code>hasMore</code> (weitere vorhanden). Bei <code>hasMore=true</code> denselben Datumsbereich erneut verwenden und die <code>0</code> als dritten Parameter durch den erhaltenen <code>after</code>-Wert ersetzen.</p>
        <p>Beide Kalendertage sind enthalten; maßgeblich ist der Abschickzeitpunkt in UTC. Bei einem Fehler das Paket mit derselben Fortsetzungsmarke wiederholen. Unveränderte, bereits bereitgestellte Bestellstände erzeugen keine neue Meldung. Änderungen können neue Meldungen erzeugen.</p>
        <p>Anschließend in Bonni synchronisieren. Der Nachimport liefert den aktuellen Bestellstand, keine vollständige Historie aller Statusänderungen. Der Bestelleingang bestätigt das lokale Speichern; die Weitergabe an Fach-Apps und die Verbuchung in Kontor sind noch nicht angeschlossen.</p>
      </details>

      <details>
        <summary>6. Einrichtung prüfen und Fehler beheben</summary>
        <ol>
          <li>Einen Testartikel zweimal übertragen. Anschließend Preis und Verfügbarkeit ändern. Es soll derselbe Drupal-Artikel aktualisiert werden.</li>
          <li>Eine Testbestellung abschicken und zweimal synchronisieren. Eine unveränderte Meldung darf nicht doppelt im Core ankommen.</li>
          <li>Einen kleinen historischen Datumsbereich zweimal bereitstellen und abholen. Unveränderte Bestellstände sollen keine zusätzlichen Meldungen erzeugen.</li>
        </ol>
        <p>Bei Verbindungsproblemen Website-Adresse, HTTPS, Site-ID, Schlüsseldatei, Dateiberechtigungen, aktivierte Module und Serverzeit prüfen. Bei einer ausstehenden Produktfreigabe das Drupal-Protokoll <code>bonni_web_bridge</code> ansehen:</p>
        <dl>
          <dt><code>BRIDGE_CATALOG_CONFIGURATION</code></dt><dd>Store oder Typen fehlen oder passen nicht zusammen.</dd>
          <dt><code>BRIDGE_CATALOG_ATTRIBUTES_UNSUPPORTED</code></dt><dd>Der Variantentyp verwendet Produktattribute.</dd>
          <dt><code>BRIDGE_CATALOG_DUPLICATE</code></dt><dd>Die Freigabe enthält doppelte Artikelnummern oder Bonni-IDs.</dd>
          <dt><code>BRIDGE_CATALOG_SKU_CONFLICT</code></dt><dd>Die Artikelnummer gehört bereits zu einer anderen Variante.</dd>
          <dt><code>BRIDGE_CATALOG_MAPPING</code></dt><dd>Ein zugeordneter Artikel fehlt oder seine Variantenstruktur wurde geändert.</dd>
          <dt><code>BRIDGE_CATALOG_VARIATION_INVALID</code> / <code>BRIDGE_CATALOG_PRODUCT_INVALID</code></dt><dd>Pflichtfelder oder andere Drupal-Feldprüfungen sind nicht erfüllt.</dd>
          <dt><code>BRIDGE_CATALOG_BUSY</code></dt><dd>Ein anderer Katalogabgleich läuft. Später erneut synchronisieren.</dd>
        </dl>
      </details>
    </div>
  </section>;
}
