type StaticManifestValue =
  | null
  | boolean
  | number
  | string
  | StaticManifestValue[]
  | { [key: string]: StaticManifestValue };

class StaticLiteralParser {
  private index = 0;

  constructor(private readonly source: string) {}

  get position() {
    return this.index;
  }

  advance(length: number) {
    this.index += length;
  }

  remaining() {
    return this.source.slice(this.index);
  }

  skipTrivia() {
    while (this.index < this.source.length) {
      const char = this.source[this.index];

      if (/\s/.test(char)) {
        this.index += 1;
        continue;
      }

      if (char === "/" && this.source[this.index + 1] === "/") {
        this.index += 2;
        while (this.index < this.source.length && !["\n", "\r"].includes(this.source[this.index])) {
          this.index += 1;
        }
        continue;
      }

      if (char === "/" && this.source[this.index + 1] === "*") {
        const end = this.source.indexOf("*/", this.index + 2);
        if (end < 0) this.fail("Nicht abgeschlossener Blockkommentar");
        this.index = end + 2;
        continue;
      }

      break;
    }
  }

  parseValue(): StaticManifestValue {
    this.skipTrivia();
    const char = this.source[this.index];

    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"' || char === "'") return this.parseString();
    if (char === "-" || /\d/.test(char || "")) return this.parseNumber();

    const identifier = this.parseIdentifier();
    if (identifier === "true") return true;
    if (identifier === "false") return false;
    if (identifier === "null") return null;

    this.fail(`Nicht erlaubter Wert ${identifier || char || "<Dateiende>"}`);
  }

  private parseObject(): { [key: string]: StaticManifestValue } {
    const result: { [key: string]: StaticManifestValue } = {};
    this.expect("{");
    this.skipTrivia();

    while (this.source[this.index] !== "}") {
      if (this.index >= this.source.length) this.fail("Nicht abgeschlossenes Objekt");

      const char = this.source[this.index];
      const key = char === '"' || char === "'" ? this.parseString() : this.parseIdentifier();
      if (!key) this.fail("Objektschlüssel erwartet");

      this.skipTrivia();
      this.expect(":");
      result[key] = this.parseValue();
      this.skipTrivia();

      if (this.source[this.index] === ",") {
        this.index += 1;
        this.skipTrivia();
        continue;
      }

      if (this.source[this.index] !== "}") this.fail("Komma oder schließende Klammer erwartet");
    }

    this.expect("}");
    return result;
  }

  private parseArray(): StaticManifestValue[] {
    const result: StaticManifestValue[] = [];
    this.expect("[");
    this.skipTrivia();

    while (this.source[this.index] !== "]") {
      if (this.index >= this.source.length) this.fail("Nicht abgeschlossenes Array");

      result.push(this.parseValue());
      this.skipTrivia();

      if (this.source[this.index] === ",") {
        this.index += 1;
        this.skipTrivia();
        continue;
      }

      if (this.source[this.index] !== "]") this.fail("Komma oder schließende Klammer erwartet");
    }

    this.expect("]");
    return result;
  }

  private parseString(): string {
    const quote = this.source[this.index];
    let result = "";
    this.index += 1;

    while (this.index < this.source.length) {
      const char = this.source[this.index];
      this.index += 1;

      if (char === quote) return result;
      if (char === "\n" || char === "\r") this.fail("Zeilenumbruch in Zeichenkette");

      if (char !== "\\") {
        result += char;
        continue;
      }

      const escaped = this.source[this.index];
      this.index += 1;
      const simpleEscapes: Record<string, string> = {
        "\"": "\"",
        "'": "'",
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\v",
        "0": "\0",
      };

      if (escaped in simpleEscapes) {
        result += simpleEscapes[escaped];
        continue;
      }

      if (escaped === "x") {
        result += String.fromCodePoint(this.readHex(2));
        continue;
      }

      if (escaped === "u") {
        if (this.source[this.index] === "{") {
          this.index += 1;
          const end = this.source.indexOf("}", this.index);
          if (end < 0) this.fail("Nicht abgeschlossene Unicode-Escape-Sequenz");
          const raw = this.source.slice(this.index, end);
          if (!/^[0-9a-fA-F]{1,6}$/.test(raw)) this.fail("Ungültige Unicode-Escape-Sequenz");
          result += String.fromCodePoint(Number.parseInt(raw, 16));
          this.index = end + 1;
        } else {
          result += String.fromCodePoint(this.readHex(4));
        }
        continue;
      }

      if (escaped === "\n") continue;
      if (escaped === "\r") {
        if (this.source[this.index] === "\n") this.index += 1;
        continue;
      }

      this.fail(`Nicht unterstützte Escape-Sequenz \\${escaped}`);
    }

    this.fail("Nicht abgeschlossene Zeichenkette");
  }

  private readHex(length: number): number {
    const raw = this.source.slice(this.index, this.index + length);
    if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(raw)) this.fail("Ungültige Hex-Escape-Sequenz");
    this.index += length;
    return Number.parseInt(raw, 16);
  }

  private parseNumber(): number {
    const match = this.remaining().match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) this.fail("Ungültige Zahl");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("Zahl liegt außerhalb des gültigen Bereichs");
    return value;
  }

  private parseIdentifier(): string {
    const match = this.remaining().match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (!match) return "";
    this.index += match[0].length;
    return match[0];
  }

  private expect(value: string) {
    if (!this.source.startsWith(value, this.index)) this.fail(`${value} erwartet`);
    this.index += value.length;
  }

  private fail(message: string): never {
    const before = this.source.slice(0, this.index);
    const line = before.split(/\r?\n/).length;
    const column = this.index - Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r"));
    throw new Error(`${message} (Zeile ${line}, Spalte ${column})`);
  }
}

/**
 * Liest ausschließlich statische Objektliterale aus `manifest.ts`.
 * Der Inhalt wird bewusst nicht importiert oder ausgeführt.
 */
export function parseStaticTypeScriptManifest(source: string): Record<string, unknown> {
  const parser = new StaticLiteralParser(source.replace(/^\uFEFF/, ""));
  parser.skipTrivia();

  const declaration = parser.remaining().match(/^(?:const|let|var)\s+manifest\s*=\s*/);
  if (!declaration) {
    throw new Error("manifest.ts muss mit `const manifest = { ... }` beginnen.");
  }

  parser.advance(declaration[0].length);
  const manifest = parser.parseValue();
  if (!manifest || Array.isArray(manifest) || typeof manifest !== "object") {
    throw new Error("manifest.ts muss ein Objekt exportieren.");
  }

  parser.skipTrivia();
  const tail = parser.remaining();
  if (!/^(?:as\s+const\s*)?;?\s*export\s+default\s+manifest\s*;?\s*$/.test(tail)) {
    throw new Error("Nach dem Manifest sind nur `as const` und `export default manifest` erlaubt.");
  }

  return manifest;
}
