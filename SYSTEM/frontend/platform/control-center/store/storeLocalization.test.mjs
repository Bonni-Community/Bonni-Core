import test from "node:test";
import assert from "node:assert/strict";

import {
  STORE_LANGUAGES,
  STORE_LANGUAGE_MODE_AUTO,
  STORE_LANGUAGE_STORAGE_KEY,
  detectControlCenterLanguage,
  localizedStoreDescription,
  localizedStoreShortDescription,
  readStoreLanguageMode,
  resolveStoreLanguage,
  saveStoreLanguageMode,
  storeLanguageDirection,
  storeSupportInfo,
} from "./storeLocalization.js";

function memoryStorage(values = {}) {
  const data = new Map(Object.entries(values));
  return {
    getItem(key) {
      return data.get(key) || null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

test("store exposes exactly 49 unique selectable languages", () => {
  assert.equal(STORE_LANGUAGES.length, 49);
  assert.equal(new Set(STORE_LANGUAGES.map(({ code }) => code)).size, 49);
  assert.equal(STORE_LANGUAGES[0].code, "de");
});

test("automatic language prefers the language stored by the Control Center", () => {
  const storage = memoryStorage({ "bonni.control-center.country": "Germany" });
  assert.equal(detectControlCenterLanguage({ storage, navigatorLanguages: ["en-US"] }), "de");
  assert.equal(resolveStoreLanguage({ mode: STORE_LANGUAGE_MODE_AUTO, storage, navigatorLanguages: ["en-US"] }), "de");
  assert.equal(detectControlCenterLanguage({ storage: memoryStorage(), controlCenterLanguage: "de", navigatorLanguages: ["en-US"] }), "de");
  assert.equal(detectControlCenterLanguage({ storage: memoryStorage(), controlCenterLanguage: "fr", navigatorLanguages: ["de-DE"] }), "fr");
  assert.equal(detectControlCenterLanguage({ storage: memoryStorage(), documentLanguage: "", navigatorLanguages: [] }), "en");
});

test("manual Store selection is persisted and overrides automatic language", () => {
  const storage = memoryStorage({ "bonni.control-center.country": "DE" });
  assert.equal(saveStoreLanguageMode("fr-FR", storage), "fr");
  assert.equal(readStoreLanguageMode(storage), "fr");
  assert.equal(resolveStoreLanguage({ mode: readStoreLanguageMode(storage), storage }), "fr");
  assert.equal(storage.getItem(STORE_LANGUAGE_STORAGE_KEY), "fr");
});

test("manifest translation falls back from selected language to English and legacy description", () => {
  const module = {
    description: "Ausführliche deutsche Beschreibung.",
    metadata: {
      store: {
        shortDescription: "Kurzer Alttext.",
        translations: {
          de: "Deutsche Kurzbeschreibung.",
          en: { shortDescription: "English short description.", description: "English long description." },
        },
      },
    },
  };

  assert.equal(localizedStoreShortDescription(module, "en"), "English short description.");
  assert.equal(localizedStoreDescription(module, "en"), "English long description.");
  assert.equal(localizedStoreShortDescription(module, "fr"), "English short description.");
  assert.equal(localizedStoreDescription(module, "fr"), "English long description.");
  assert.equal(localizedStoreDescription({ description: "Alttext" }, "de"), "Alttext");
  assert.equal(
    localizedStoreDescription({ description: "Alttext" }, "fr"),
    "This package has not supplied an English description yet.",
  );
  assert.equal(
    localizedStoreDescription({ description: "English legacy text", metadata: { store: { defaultLanguage: "en" } } }, "fr"),
    "English legacy text",
  );
});

test("translations are also read from a nested installed manifest", () => {
  const module = {
    manifest: {
      metadata: {
        store: {
          translations: {
            "zh-TW": "安全連接 Bonni Core。",
          },
        },
      },
    },
  };

  assert.equal(localizedStoreShortDescription(module, "zh-Hant"), "安全連接 Bonni Core。");
  assert.equal(storeLanguageDirection("ar"), "rtl");
  assert.equal(storeLanguageDirection("de"), "ltr");
});

test("support routing stays attached to the extension manifest", () => {
  const module = {
    key: "bridge.example",
    metadata: {
      store: {
        support: {
          scope: "extension",
          extensionKey: "bridge.example",
          independentlySupported: true,
        },
      },
    },
  };

  assert.deepEqual(storeSupportInfo(module), {
    scope: "extension",
    extensionKey: "bridge.example",
    independentlySupported: true,
    url: "",
    email: "",
  });
});
