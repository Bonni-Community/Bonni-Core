/**
 * Express 5 kann einen Routenparameter als Zeichenkette oder Zeichenkettenliste
 * typisieren. Bonni-Routen verwenden immer genau den ersten Wert.
 */
export function readRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return value ?? "";
}
