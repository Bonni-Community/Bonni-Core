class StaticLiteralParser {
    source;
    index = 0;
    bindings = new Map();
    constructor(source) {
        this.source = source;
    }
    get position() {
        return this.index;
    }
    advance(length) {
        this.index += length;
    }
    remaining() {
        return this.source.slice(this.index);
    }
    bind(name, value) {
        if (this.bindings.has(name))
            this.fail(`Doppelte Deklaration ${name}`);
        this.bindings.set(name, cloneStaticValue(value));
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
                if (end < 0)
                    this.fail("Nicht abgeschlossener Blockkommentar");
                this.index = end + 2;
                continue;
            }
            break;
        }
    }
    parseValue() {
        this.skipTrivia();
        const char = this.source[this.index];
        let value;
        if (char === "{")
            value = this.parseObject();
        else if (char === "[")
            value = this.parseArray();
        else if (char === '"' || char === "'")
            value = this.parseString();
        else if (char === "-" || /\d/.test(char || ""))
            value = this.parseNumber();
        else {
            const identifier = this.parseIdentifier();
            if (identifier === "true")
                value = true;
            else if (identifier === "false")
                value = false;
            else if (identifier === "null")
                value = null;
            else if (this.bindings.has(identifier))
                value = cloneStaticValue(this.bindings.get(identifier));
            else
                this.fail(`Nicht erlaubter Wert ${identifier || char || "<Dateiende>"}`);
        }
        this.skipTrivia();
        if (this.source.startsWith(".sort()", this.index)) {
            if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
                this.fail(".sort() ist nur für statische Zeichenkettenlisten erlaubt");
            }
            this.index += ".sort()".length;
            value = [...value].sort((left, right) => String(left).localeCompare(String(right), "en"));
        }
        return value;
    }
    parseObject() {
        const result = {};
        this.expect("{");
        this.skipTrivia();
        while (this.source[this.index] !== "}") {
            if (this.index >= this.source.length)
                this.fail("Nicht abgeschlossenes Objekt");
            const char = this.source[this.index];
            const key = char === '"' || char === "'" ? this.parseString() : this.parseIdentifier();
            if (!key)
                this.fail("Objektschlüssel erwartet");
            this.skipTrivia();
            this.expect(":");
            result[key] = this.parseValue();
            this.skipTrivia();
            if (this.source[this.index] === ",") {
                this.index += 1;
                this.skipTrivia();
                continue;
            }
            if (this.source[this.index] !== "}")
                this.fail("Komma oder schließende Klammer erwartet");
        }
        this.expect("}");
        return result;
    }
    parseArray() {
        const result = [];
        this.expect("[");
        this.skipTrivia();
        while (this.source[this.index] !== "]") {
            if (this.index >= this.source.length)
                this.fail("Nicht abgeschlossenes Array");
            if (this.source.startsWith("...", this.index)) {
                this.index += 3;
                const spread = this.parseValue();
                if (!Array.isArray(spread))
                    this.fail("Array-Spread benötigt eine statische Liste");
                result.push(...spread);
            }
            else {
                result.push(this.parseValue());
            }
            this.skipTrivia();
            if (this.source[this.index] === ",") {
                this.index += 1;
                this.skipTrivia();
                continue;
            }
            if (this.source[this.index] !== "]")
                this.fail("Komma oder schließende Klammer erwartet");
        }
        this.expect("]");
        return result;
    }
    parseString() {
        const quote = this.source[this.index];
        let result = "";
        this.index += 1;
        while (this.index < this.source.length) {
            const char = this.source[this.index];
            this.index += 1;
            if (char === quote)
                return result;
            if (char === "\n" || char === "\r")
                this.fail("Zeilenumbruch in Zeichenkette");
            if (char !== "\\") {
                result += char;
                continue;
            }
            const escaped = this.source[this.index];
            this.index += 1;
            const simpleEscapes = {
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
                    if (end < 0)
                        this.fail("Nicht abgeschlossene Unicode-Escape-Sequenz");
                    const raw = this.source.slice(this.index, end);
                    if (!/^[0-9a-fA-F]{1,6}$/.test(raw))
                        this.fail("Ungültige Unicode-Escape-Sequenz");
                    result += String.fromCodePoint(Number.parseInt(raw, 16));
                    this.index = end + 1;
                }
                else {
                    result += String.fromCodePoint(this.readHex(4));
                }
                continue;
            }
            if (escaped === "\n")
                continue;
            if (escaped === "\r") {
                if (this.source[this.index] === "\n")
                    this.index += 1;
                continue;
            }
            this.fail(`Nicht unterstützte Escape-Sequenz \\${escaped}`);
        }
        this.fail("Nicht abgeschlossene Zeichenkette");
    }
    readHex(length) {
        const raw = this.source.slice(this.index, this.index + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(raw))
            this.fail("Ungültige Hex-Escape-Sequenz");
        this.index += length;
        return Number.parseInt(raw, 16);
    }
    parseNumber() {
        const match = this.remaining().match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
        if (!match)
            this.fail("Ungültige Zahl");
        this.index += match[0].length;
        const value = Number(match[0]);
        if (!Number.isFinite(value))
            this.fail("Zahl liegt außerhalb des gültigen Bereichs");
        return value;
    }
    parseIdentifier() {
        const match = this.remaining().match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
        if (!match)
            return "";
        this.index += match[0].length;
        return match[0];
    }
    expect(value) {
        if (!this.source.startsWith(value, this.index))
            this.fail(`${value} erwartet`);
        this.index += value.length;
    }
    fail(message) {
        const before = this.source.slice(0, this.index);
        const line = before.split(/\r?\n/).length;
        const column = this.index - Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r"));
        throw new Error(`${message} (Zeile ${line}, Spalte ${column})`);
    }
}
function cloneStaticValue(value) {
    if (Array.isArray(value))
        return value.map(cloneStaticValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneStaticValue(entry)]));
    }
    return value;
}
/**
 * Liest ausschließlich statische Objektliterale aus `manifest.ts`.
 * Der Inhalt wird bewusst nicht importiert oder ausgeführt.
 */
export function parseStaticTypeScriptManifest(source) {
    const parser = new StaticLiteralParser(source.replace(/^\uFEFF/, ""));
    let manifest;
    while (true) {
        parser.skipTrivia();
        const declaration = parser.remaining().match(/^const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*/);
        if (!declaration)
            break;
        parser.advance(declaration[0].length);
        const value = parser.parseValue();
        parser.skipTrivia();
        const constAssertion = parser.remaining().match(/^as\s+const\b/);
        if (constAssertion) {
            parser.advance(constAssertion[0].length);
            parser.skipTrivia();
        }
        if (parser.remaining().startsWith(";"))
            parser.advance(1);
        parser.bind(declaration[1], value);
        if (declaration[1] === "manifest")
            manifest = value;
    }
    if (!manifest || Array.isArray(manifest) || typeof manifest !== "object") {
        throw new Error("manifest.ts muss `const manifest = { ... }` deklarieren.");
    }
    parser.skipTrivia();
    const tail = parser.remaining();
    if (!/^export\s+default\s+manifest\s*;?\s*$/.test(tail)) {
        throw new Error("Nach den statischen Deklarationen ist nur `export default manifest` erlaubt.");
    }
    return manifest;
}
