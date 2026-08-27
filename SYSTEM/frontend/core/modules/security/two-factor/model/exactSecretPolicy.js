export const LOCAL_PASSWORD_MAX_LENGTH = 512;
export const ENROLLMENT_PASSWORD_MAX_LENGTH = 80;

const FORBIDDEN_CONTROL_CHARACTERS = /[\r\n\0]/;

export function countUnicodeCodePoints(value) {
  return typeof value === "string" ? [...value].length : 0;
}

export function hasLoneSurrogate(value) {
  if (typeof value !== "string") return true;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) return true;
  }
  return false;
}

export function hasExactUtf8RoundTrip(value) {
  if (typeof value !== "string" || hasLoneSurrogate(value)) return false;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value;
  } catch {
    return false;
  }
}

export function validateExactSecret(value, {
  label = "Passwort",
  maxLength = LOCAL_PASSWORD_MAX_LENGTH,
} = {}) {
  if (typeof value !== "string" || value.length === 0) {
    return `${label} ist erforderlich.`;
  }
  if (countUnicodeCodePoints(value) > maxLength) {
    return `${label} darf hoechstens ${maxLength} Zeichen enthalten.`;
  }
  if (FORBIDDEN_CONTROL_CHARACTERS.test(value)) {
    return `${label} darf keine Zeilenumbrueche oder Nullzeichen enthalten.`;
  }
  if (!hasExactUtf8RoundTrip(value)) {
    return `${label} enthaelt eine ungueltige Unicode-Zeichenfolge.`;
  }
  return "";
}

export function hasForbiddenSecretControls(value) {
  return typeof value === "string" && FORBIDDEN_CONTROL_CHARACTERS.test(value);
}

export function secretInputWouldBeInvalid(value, maxLength = LOCAL_PASSWORD_MAX_LENGTH) {
  return (
    typeof value !== "string"
    || countUnicodeCodePoints(value) > maxLength
    || hasForbiddenSecretControls(value)
    || !hasExactUtf8RoundTrip(value)
  );
}
