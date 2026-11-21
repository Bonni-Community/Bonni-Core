# core.files – bonni.files/v1

Nur bei deklariertem dependsOn core.files liefert der Modullader services.files. Der Port besitzt transaction(callback); dessen kurzlebige Sitzung besitzt read, list, write und remove für modulinterne relative Bytepfade. Rückgabewerte werden kopiert, Sitzungen nach dem Callback geschlossen. Keine freien Hostpfade und keine fremden Moduldateien.

Ablage: resolvePersistentStorageRoot()/modules/<moduleKey>/content. Kein zusätzlicher Datenpfad neben der Sicherung. Die bestehende persistente Snapshot-Sperre serialisiert Sicherungen und die hier journalisierten Änderungen. Maximale Datei 32 MiB, Schreibbatch 512 MiB / 20.000 Änderungen, Inventar 50.000 Dateien. Pfade mit Traversierung, Backslash, Doppelpunkt, versteckten Segmenten oder Symlinks werden abgewiesen.

Änderungen werden zunächst separat geschrieben und synchronisiert. Ein SHA-256-Journal legt den Commit fest; nach Unterbrechung beendet der nächste Zugriff diesen Commit, bevor ein Callback liest. Der Anwendungsport zeigt keine halbe Transaktion. Dies ist keine Behauptung, dass externe unkoordinierte Dateizugriffe einen atomaren Betriebssystem-Mehrdatei-Rename sehen. Beschädigte Journale scheitern geschlossen und brauchen eine vollständige Sicherung/Wiederherstellung. Vorhandene Core-Regeln für verwaiste Snapshot-Sperren gelten weiter.

Der Core-Port speichert generische Bytes. Datenschema, Indexaufbau, Löschmarker, Medienzuordnungen und Versionierungsregeln sind Modulverantwortung. Der Prüfparameter rootOverride wird nur im Prüfrahmen benutzt.
