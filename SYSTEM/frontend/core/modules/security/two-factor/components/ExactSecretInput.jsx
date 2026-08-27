import React, { useCallback, useLayoutEffect, useRef, useState } from "react";

import {
  LOCAL_PASSWORD_MAX_LENGTH,
  secretInputWouldBeInvalid,
} from "../model/exactSecretPolicy.js";

export default function ExactSecretInput({
  value,
  onChange,
  onValidityChange,
  inputRef,
  label,
  maxLength = LOCAL_PASSWORD_MAX_LENGTH,
  autoComplete = "off",
  autoFocus = false,
  disabled = false,
  className = "bonni-2fa-field",
  inputClassName = "",
  inputType = "password",
  placeholder = "",
  required = true,
}) {
  const [inputError, setInputError] = useState("");
  const secretNodeRef = useRef(null);
  const externalRef = useRef(inputRef);
  externalRef.current = inputRef;

  const setSecretNode = useCallback((node) => {
    if (!node && secretNodeRef.current) secretNodeRef.current.value = "";
    secretNodeRef.current = node;
    const target = externalRef.current;
    if (typeof target === "function") target(node);
    else if (target && typeof target === "object") target.current = node;
  }, []);

  useLayoutEffect(() => () => {
    if (secretNodeRef.current) secretNodeRef.current.value = "";
  }, []);

  function invalidate() {
    setInputError(`${label} enthaelt unzulaessige Zeichen oder ist zu lang.`);
    onChange("");
    onValidityChange?.(false);
  }

  function accept(nextValue) {
    if (nextValue && secretInputWouldBeInvalid(nextValue, maxLength)) {
      invalidate();
      return;
    }
    setInputError("");
    onChange(nextValue);
    onValidityChange?.(true);
  }

  function prospectiveValue(event, inserted) {
    const start = Number.isInteger(event.currentTarget?.selectionStart)
      ? event.currentTarget.selectionStart
      : value.length;
    const end = Number.isInteger(event.currentTarget?.selectionEnd)
      ? event.currentTarget.selectionEnd
      : start;
    return `${value.slice(0, start)}${inserted}${value.slice(end)}`;
  }

  function guardInsertedText(event) {
    const inserted = event.data;
    if (typeof inserted === "string" && secretInputWouldBeInvalid(prospectiveValue(event, inserted), maxLength)) {
      event.preventDefault();
      invalidate();
    }
  }

  function guardPaste(event) {
    const pasted = event.clipboardData?.getData("text");
    if (typeof pasted === "string" && secretInputWouldBeInvalid(prospectiveValue(event, pasted), maxLength)) {
      event.preventDefault();
      invalidate();
    }
  }

  return (
    <label className={className}>
      <span>{label}</span>
      <input
        ref={setSecretNode}
        className={inputClassName}
        type={inputType}
        value={value}
        onInput={(event) => accept(event.currentTarget.value)}
        onChange={(event) => accept(event.target.value)}
        onBeforeInput={guardInsertedText}
        onPaste={guardPaste}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={Boolean(inputError)}
        required={required}
      />
      {inputError ? <small className="bonni-2fa-field__error" role="alert">{inputError}</small> : null}
    </label>
  );
}
