import { useEffect, useRef, useState } from "react";

const formatPrice = new Intl.NumberFormat("de-DE", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 });
const blank = { product: "", quantity: "", price: "", recognized: "", lines: [] };
const quantityPattern = /^\d{1,5}(?:[,.]\d{1,4})?$/;
const pricePattern = /^\d{1,7}(?:[,.]\d{1,2})?$/;
const withPrice = position => ({ ...position, price: position.unitPriceCents === null ? "" : formatPrice.format(position.unitPriceCents / 100) });
const money = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const euro = amount => money.format(amount / 100);

function sumPositions(positions, check) {
  const uncertain = new Set(check?.uncertainLines ?? []);
  let goods = 0;
  let complete = Boolean(check?.complete);
  for (const { product, quantity, price, totalCents, lines } of positions) {
    if (!product.trim() && !quantity.trim() && !price.trim()) continue;
    const count = Number(quantity.trim().replace(",", "."));
    const valid = quantityPattern.test(quantity.trim()) && count > 0 && pricePattern.test(price.trim());
    const entered = valid ? Math.round(count * Math.round(Number(price.trim().replace(",", ".")) * 100)) : null;
    const amount = entered ?? totalCents;
    if (!Number.isSafeInteger(amount)) complete = false;
    else goods += amount;
    if (!Number.isSafeInteger(amount) || entered !== null && Number.isSafeInteger(totalCents) && entered !== totalCents) {
      for (const index of lines) uncertain.add(index);
    }
  }
  const calculated = check ? goods + check.depositCents - check.depositReturnCents + check.discountCents : null;
  return { goods, calculated, complete, uncertain };
}

function ReceiptSum({ check, sums, dirty, lineNumbers, onOpen }) {
  if (!check) return null;
  const { goods, calculated, complete, uncertain } = sums;
  const printed = check.printedCents;
  const difference = Number.isSafeInteger(printed) ? printed - calculated : null;
  const matches = difference === 0 && complete && !uncertain.size && !dirty;
  const status = dirty ? "Übernimm den korrigierten Text, um die Summe neu zu prüfen."
    : difference === null ? "Die gedruckte Bonsumme ist nicht eindeutig lesbar."
      : difference > 0 ? `Es fehlen ${euro(difference)} zur Bonsumme.`
        : difference < 0 ? `Die erkannten Beträge liegen ${euro(-difference)} über der Bonsumme.`
          : matches ? "Die Beträge stimmen mit der Bonsumme überein."
            : "Die Beträge ergeben dieselbe Summe. Bitte prüfe die offenen Angaben.";
  return <section className={`store-capture-receipt-review__sum${matches && check.supportedCurrency ? " is-balanced" : ""}`}
    aria-label="Summenprüfung">
    <h4>Summenprüfung</h4>
    {!check.supportedCurrency ? <p>Für diesen Bon wurde eine andere Währung erkannt.</p> : <>
      <dl>
        <div><dt>Waren</dt><dd>{euro(goods)}</dd></div>
        <div><dt>Pfand</dt><dd>{euro(check.depositCents)}</dd></div>
        {check.depositReturnCents !== 0 && <div><dt>Pfandrückgabe</dt><dd>{euro(-check.depositReturnCents)}</dd></div>}
        <div><dt>Rabatte</dt><dd>{euro(check.discountCents)}</dd></div>
        <div><dt>Berechnet</dt><dd>{euro(calculated)}</dd></div>
        <div><dt>Gedruckt</dt><dd>{difference === null ? "Offen" : euro(printed)}</dd></div>
      </dl>
      <p role="status">{status}</p>
      {uncertain.size > 0 && <div className="store-detail-actions">
        {[...uncertain].filter(index => lineNumbers[index]).map(index => <button type="button" key={index}
          onClick={() => onOpen(index)}>Z{lineNumbers[index]} prüfen</button>)}
      </div>}
    </>}
  </section>;
}

export default function CaptureReceiptReview({ result, rows, lineNumbers, lineLocations, lineRequest, onConfirm, onParse, onLocate, onOpen }) {
  const details = useRef(null);
  const inputs = useRef(new Map());
  const originals = new Map(rows.map(({ index, text }) => [index, text]));
  const [positions, setPositions] = useState(() => result.positions.length
    ? result.positions.map(withPrice) : [{ ...blank, index: 32 }]);
  const [edits, setEdits] = useState({});
  const [applied, setApplied] = useState(() => ({ text: [...originals.values()].join("\n"), lines: originals, check: result.check }));
  const used = new Set(positions.map(position => position.index));
  let nextIndex = 32;
  while (used.has(nextIndex)) nextIndex++;
  const corrected = new Map(rows.map(({ index, text }) => [index, edits[index] ?? text]));
  const correctedText = [...corrected.values()].join("\n");
  const dirty = correctedText !== applied.text;
  const located = new Set(lineLocations.map(line => line.index));
  const sums = sumPositions(positions, applied.check);

  useEffect(() => {
    if (!lineRequest) return;
    if (details.current) details.current.open = true;
    inputs.current.get(lineRequest.index)?.focus();
  }, [lineRequest]);

  function update(index, change) {
    setPositions(previous => previous.map(position => position.index === index ? { ...position, ...change } : position));
  }

  async function confirm(position) {
    const { index, lines, recognized, product, quantity, price } = position;
    const saved = await onConfirm({ index, lines, recognized, product: product.trim(), quantity: quantity.trim(),
      unitPriceCents: Math.round(Number(price.trim().replace(",", ".")) * 100) });
    if (saved) update(index, { confirmed: true });
  }

  async function applyText() {
    const response = await onParse(correctedText);
    if (!response) return;
    const indexOf = index => rows[index]?.index;
    setPositions(previous => {
      const reviewed = response.positions.map(raw => {
        const position = { ...raw, lines: raw.lines.map(indexOf).filter(Number.isInteger) };
        const old = previous.find(item => item.lines[0] === position.lines[0]);
        if (old && old.lines.length === position.lines.length
          && position.lines.every((line, index) => old.lines[index] === line && applied.lines.get(line) === corrected.get(line))) {
          return { ...old, index: position.index };
        }
        const original = result.positions.find(item => item.lines[0] === position.lines[0]);
        return withPrice({ ...position, recognized: original?.recognized ?? "" });
      });
      const manual = previous.filter(position => position.index >= 32
        && !reviewed.some(item => item.lines[0] !== undefined && item.lines[0] === position.lines[0]));
      return [...reviewed, ...manual];
    });
    setApplied({ text: correctedText, lines: corrected, check: response.check && { ...response.check,
      uncertainLines: response.check.uncertainLines.map(indexOf).filter(Number.isInteger) } });
  }

  return <section className="store-capture-receipt-review" aria-labelledby="capture-receipt-review-heading">
    <ReceiptSum check={applied.check} sums={sums} dirty={dirty} lineNumbers={lineNumbers} onOpen={onOpen} />
    {rows.some(row => lineNumbers[row.index]) && <details ref={details} className="store-capture-receipt-review__text" open>
      <summary>Bonzeilen abtippen</summary>
      <div className="store-capture-receipt-review__head store-capture-receipt-review__pair" aria-hidden="true">
        <strong>Gelesen</strong><strong>Korrektur</strong>
      </div>
      <div className="store-capture-receipt-review__lines" tabIndex={0} aria-label="Gelesene Bonzeilen und Korrekturen">
        {rows.map(({ text, index, added }) => lineNumbers[index] && (
          <div key={index} className={`store-capture-receipt-review__pair${sums.uncertain.has(index) ? " is-uncertain" : ""}`}>
            <div className="store-capture-receipt-review__transcription">
              <span className="store-capture-receipt-review__line-number">Z{lineNumbers[index]}</span>
              <pre>{added ? "Manuell ergänzt" : text}</pre>
            </div>
            <label className="store-capture-receipt-review__transcription">
              <span className="store-capture-receipt-review__line-number">Z{lineNumbers[index]}</span>
              <input aria-label={`Z${lineNumbers[index]} korrigieren`} value={corrected.get(index)} spellCheck={false}
                ref={element => { if (element) inputs.current.set(index, element); else inputs.current.delete(index); }}
                onFocus={() => onLocate([index])}
                onChange={event => setEdits(previous => ({ ...previous, [index]: event.target.value }))} />
            </label>
          </div>
        ))}
      </div>
      <div className="store-detail-actions">
        <button type="button" disabled={!dirty || correctedText.length > 12000}
          onClick={() => void applyText()}>Positionen aus korrigiertem Text übernehmen</button>
      </div>
    </details>}
    <h4 id="capture-receipt-review-heading">Bonpositionen</h4>
    <p>Vergleiche jede Position mit dem Bon. Rechts kannst du Produkt, Anzahl und Einzelpreis überschreiben.</p>
    <div className="store-capture-receipt-review__head store-capture-receipt-review__pair" aria-hidden="true">
      <strong>Gelesen</strong><strong>Korrektur</strong>
    </div>
    <ol className="store-capture-receipt-review__positions" aria-label="Bonpositionen">
      {positions.map((position, index) => {
        const { product, quantity, price, lines: sourceLines } = position;
        const source = sourceLines.map(line => originals.get(line)).filter(Boolean).join("\n");
        const numbers = sourceLines.filter(line => lineNumbers[line]).map(line => `Z${lineNumbers[line]}`).join(" + ");
        const canSave = product.trim() && quantityPattern.test(quantity.trim()) && Number(quantity.trim().replace(",", ".")) > 0
          && pricePattern.test(price.trim());
        return <li key={position.index} className="store-capture-receipt-review__pair" aria-label={`Position ${index + 1}`}
          onFocus={() => onLocate(sourceLines)}>
          <div className="store-capture-receipt-review__source">
            <strong>Position {index + 1}{numbers ? ` · ${numbers}` : ""}</strong>
            <pre>{source || "Keine passende Bonzeile erkannt."}</pre>
            {sourceLines.some(line => located.has(line)) && <button type="button"
              className="store-capture-receipt-review__locate" onClick={() => onLocate([...sourceLines])}>Im Bon zeigen</button>}
          </div>
          <div className="store-capture-receipt-review__edit">
            <label>Produkt<input maxLength={180} value={product} onChange={event => update(position.index, { product: event.target.value, confirmed: false })} /></label>
            <div className="store-capture-receipt-review__numbers">
              <label>Anzahl<input maxLength={10} inputMode="decimal" value={quantity}
                onChange={event => update(position.index, { quantity: event.target.value, confirmed: false })} /></label>
              <label>Einzelpreis (€)<input maxLength={10} inputMode="decimal" value={price}
                onChange={event => update(position.index, { price: event.target.value, confirmed: false })} /></label>
            </div>
            <div className="store-detail-actions">
              <button type="button" disabled={!canSave || position.confirmed} onClick={() => void confirm(position)}>Als Lernbeispiel speichern</button>
              {position.confirmed && <small role="status">Gespeichert</small>}
            </div>
          </div>
        </li>;
      })}
    </ol>
    {!positions.length && <p>Keine Bonposition erkannt. Du kannst sie von Hand ergänzen.</p>}
    <div className="store-detail-actions">
      <button type="button" disabled={nextIndex >= 64} onClick={() => setPositions(previous => [...previous, { ...blank, index: nextIndex }])}>
        Position ergänzen
      </button>
    </div>
  </section>;
}
