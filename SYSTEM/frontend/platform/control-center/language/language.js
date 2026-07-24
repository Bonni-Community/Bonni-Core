import { controlCenterLabelsDe } from "./labels.de.js";
import { controlCenterLabelsEn } from "./labels.en.js";

export const CONTROL_CENTER_LANGUAGES = {
  de: controlCenterLabelsDe,
  en: controlCenterLabelsEn,
};

export const DEFAULT_CONTROL_CENTER_LANGUAGE = "de";

export function getControlCenterLanguage() {
  return DEFAULT_CONTROL_CENTER_LANGUAGE;
}

export function getControlCenterLabels(language = getControlCenterLanguage()) {
  return CONTROL_CENTER_LANGUAGES[language] || CONTROL_CENTER_LANGUAGES[DEFAULT_CONTROL_CENTER_LANGUAGE];
}

export function labelKind(kind, labels = getControlCenterLabels()) {
  return labels.kinds?.[kind] || kind || labels.common.unknown;
}

export function labelStatus(status, labels = getControlCenterLabels()) {
  return labels.status?.[status] || status || labels.common.unknown;
}

export const controlCenterLabels = getControlCenterLabels();
