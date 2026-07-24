# Jobs / Scheduler

Pfad:

```txt
src/modules/helper/jobs
```

Die Jobs werden nicht dauerhaft im Backend-Prozess gestartet, sondern per Crontab aufgerufen.
Der Cron startet nur den Runner, die eigentliche Fachlogik bleibt im Backend.

## Befehle

```bash
npm run jobs:run
npm run jobs:run -- daily
npm run jobs:run -- bierdeckel:auto-finalize
npm run jobs:run -- bierdeckel:event-recheck
npm run jobs:run -- len:due
npm run jobs:run -- len:overdue
npm run jobs:run -- len:auto-charge
npm run jobs:run -- accounting:settlement
npm run jobs:run -- accounting:balance
```

## Fachregeln

- Bierdeckel: nach 14 Tagen ohne Widerspruch automatisch finalisieren.
- Bierdeckel: Events innerhalb der Prüfzeit erneut prüfen.
- Len: nach 14 Tagen fällig markieren.
- Len: nach 3 Monaten überfällig markieren.
- Len: beschädigt/verloren/überfällig später automatisch über Accounting belasten.
- Accounting: später automatische Verrechnung und Saldo-Cache.

## Locking

Jeder Job nutzt eine einfache Lock-Datei unter `/tmp/stueberl-job-locks`.
Damit laufen dieselben Jobs nicht doppelt parallel.
