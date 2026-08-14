# Core

`src/core` ist die technische Basis-Schicht des Backends.

Hier liegen nur Dinge, die unabhängig vom System von mehreren Bereichen gebraucht werden:

- config/env
- database/prisma access
- logger
- errors
- http middleware
- events
- shared types
- utils

`src/system` bleibt die Steuerzentrale für Registry, Installer, Rechte, Runtime und System-Oberfläche.
