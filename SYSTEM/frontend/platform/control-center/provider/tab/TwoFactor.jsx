const EMPTY_TWO_FACTOR = {
  provider: "local",
  configured: true,
  externalProviders: [],
};

function normalizeTwoFactor(settings) {
  const source = settings?.twoFactor || {};
  const externalProviders = Array.isArray(source.externalProviders)
    ? source.externalProviders
    : source.externalProvider
      ? [source.externalProvider]
      : [];
  return {
    ...EMPTY_TWO_FACTOR,
    ...source,
    externalProviders,
  };
}

function Field({ field, value, onChange }) {
  if (field.type === "select") {
    return (
      <label className="cc-system-field">
        <span>{field.label}</span>
        <select value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
          {(field.options || []).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        {field.help ? <small>{field.help}</small> : null}
      </label>
    );
  }

  if (field.type === "checkbox") {
    return (
      <label className="cc-system-field cc-system-field--checkbox">
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.label}</span>
        {field.help ? <small>{field.help}</small> : null}
      </label>
    );
  }

  return (
    <label className="cc-system-field">
      <span>{field.label}</span>
      <input
        type={field.type === "number" ? "number" : field.type === "password" ? "password" : "text"}
        value={value ?? ""}
        placeholder={field.placeholder || ""}
        min={field.min}
        max={field.max}
        onChange={(event) => onChange(field.type === "number" ? Number(event.target.value) : event.target.value)}
      />
      {field.help ? <small>{field.help}</small> : null}
    </label>
  );
}

export { EMPTY_TWO_FACTOR, normalizeTwoFactor };

export default function TwoFactorTab({ twoFactor, onPatch }) {
  const externalProviders = twoFactor.externalProviders || [];
  const selectedExternal = externalProviders.find((provider) => provider.id === twoFactor.provider) || null;
  const externalSelected = Boolean(selectedExternal);
  const values = selectedExternal?.configuration?.values || {};

  function patchExternalValue(name, value) {
    if (!selectedExternal) return;
    onPatch({
      externalProviders: externalProviders.map((provider) => provider.id === selectedExternal.id
        ? {
            ...provider,
            configuration: {
              ...provider.configuration,
              values: { ...values, [name]: value },
            },
          }
        : provider),
    });
  }

  return (
    <div className="cc-system-tab-panel">
      <div className="cc-system-card">
        <div className="cc-system-card__header">
          <div>
            <h2>Zwei-Faktor-Authentifizierung (2FA)</h2>
            <p>Wähle eine Authenticator-App oder einen externen 2FA-Anbieter. Bonni Core verwaltet die sicheren Abfragen, Sperren und Freigaben.</p>
          </div>
          <span className={`cc-system-status ${twoFactor.configured ? "cc-system-status--green" : "cc-system-status--gray"}`}>
            {externalSelected ? `${selectedExternal.label} ${twoFactor.configured ? "bereit" : "unvollständig"}` : "Authenticator-App (TOTP)"}
          </span>
        </div>

        <div className="cc-system-choice-grid">
          <button
            type="button"
            className={!externalSelected ? "cc-system-choice cc-system-choice--active" : "cc-system-choice"}
            onClick={() => onPatch({ provider: "local" })}
          >
            <strong>Authenticator-App (TOTP)</strong>
            <span>Funktioniert unter anderem mit 2FAS, Aegis, FreeOTP, Google Authenticator, Microsoft Authenticator und anderen TOTP-Apps.</span>
          </button>
          {externalProviders.map((external) => (
            <button
              key={external.id}
              type="button"
              className={twoFactor.provider === external.id ? "cc-system-choice cc-system-choice--active" : "cc-system-choice"}
              onClick={() => onPatch({ provider: external.id })}
            >
              <strong>{external.label}</strong>
              <span>Zwei-Faktor-Authentifizierung über das installierte Anbieter-Plugin.</span>
            </button>
          ))}
        </div>
        {!externalProviders.length ? <p className="cc-system-hint">Aktuell ist kein externes 2FA-Anbieter-Plugin installiert. Weitere Anbieter können unabhängig voneinander als Bonni-Plugin ergänzt werden.</p> : null}
      </div>

      {selectedExternal ? selectedExternal.configuration.sections.map((section) => (
        <div className="cc-system-card" key={section.title}>
          <h2>{section.title}</h2>
          {section.description ? <p>{section.description}</p> : null}
          <div className="cc-system-form-grid">
            {section.fields.map((field) => (
              <Field
                key={field.name}
                field={field}
                value={values[field.name]}
                onChange={(value) => patchExternalValue(field.name, value)}
              />
            ))}
          </div>
        </div>
      )) : null}

      {selectedExternal ? <p className="cc-system-hint">Die Einstellungen von {selectedExternal.label} werden im eigenen Plugin-Namensraum gespeichert. Eingegebene Token und Passwörter werden nicht gespeichert.</p> : null}
    </div>
  );
}
