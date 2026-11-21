import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import CaptureReceiptReview from "./CaptureReceiptReview.jsx";
import CaptureReceiptCrop from "./CaptureReceiptCrop.jsx";
import { encodeRotatedReceipt, encodeTrainingImage, receiptFrame, rotateReceiptCrop } from "./CaptureReceiptImage.js";

const tasks = { photo: "Foto-Fokus", ocr: "Bonmengen (OCR)", code: "Barcode / QR-Code", dictation: "Diktattext" };
const emptyFields = { example: "focus", label: "", printed: "", code: "", heard: "", corrected: "" };
const fullImage = [0, 0, 1, 1];
const imageTypes = ["image/jpeg", "image/png", "image/webp"];
const minZoom = 1;
const maxZoom = 200;
const normalZoom = 100;
const noLines = [];
const upright = { quarter: 0, tilt: 0 };
const maxReceiptPhotos = 4;
const imageUrl = image => "data:" + image.mimeType + ";base64," + image.imageBase64;

async function preparePhoto(file, task) {
  if (file.size > 20_000_000 || (file.type && !imageTypes.includes(file.type))) {
    throw Error("Wähle ein Bild im Format JPG, PNG oder WebP mit höchstens 20 MB.");
  }
  const image = new Image();
  // Use a data URL, which the Core image policy permits for local previews.
  image.src = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    const readFailed = () => reject(Error("Die Bilddatei konnte nicht gelesen werden."));
    reader.onload = () => resolve(reader.result);
    reader.onerror = readFailed;
    reader.onabort = readFailed;
    reader.readAsDataURL(file);
  });
  await image.decode().catch(() => { throw Error("Das Trainingsfoto konnte nicht geöffnet werden."); });
  const { naturalWidth: width, naturalHeight: height } = image;
  if (!width || !height || width * height > 40_000_000) throw Error("Wähle ein Bild mit höchstens 40 Megapixeln.");
  const { canvas, preview, image: prepared } = encodeTrainingImage(image);
  let browserCodes = [];
  if (task === "code" && typeof globalThis.BarcodeDetector === "function") {
    try {
      const codes = await new globalThis.BarcodeDetector().detect(canvas);
      browserCodes = codes.map(code => code.rawValue).slice(0, 10);
    } catch { /* Capture can still read EAN codes itself. */ }
  }
  return { preview: task === "receipt" || task === "ocr" ? image.src : preview,
    width: canvas.width, height: canvas.height, browserCodes, image: prepared };
}

function ImageSelection({ photo, box, corners, observations, disabled, onSelect, onCorners, receipt, receiptPositions,
  lineLocations, lineNumbers, activeLines, frame, orientation, onOrientation, autoFit, onOpenLine, onAddLine }) {
  const start = useRef(null);
  const viewport = useRef(null);
  const photoSurface = useRef(null);
  const zoomAnchor = useRef(null);
  const manualZoom = useRef(false);
  const [draft, setDraft] = useState(null);
  const [zoom, setZoom] = useState(normalZoom);
  const [selecting, setSelecting] = useState(false);
  const [showLines, setShowLines] = useState(true);
  const [addingLine, setAddingLine] = useState(false);
  const current = draft ?? box ?? fullImage;
  const canAddLine = Boolean(onAddLine);
  const turned = Boolean(frame?.angle);
  const tiltLabel = orientation.tilt.toLocaleString("de-DE") + "°";
  const outline = ([x, y, w, h]) => ({ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });

  function zoomTo(percent) {
    manualZoom.current = true;
    const view = viewport.current, surface = photoSurface.current;
    if (!view || !surface?.clientWidth || !surface.clientHeight || percent === zoom) return;
    zoomAnchor.current = {
      x: (view.scrollLeft + view.clientWidth / 2 - surface.offsetLeft) / surface.clientWidth,
      y: view.scrollTop / surface.clientHeight,
    };
    setZoom(percent);
  }

  function fitPhoto() {
    const view = viewport.current;
    if (!view?.clientWidth || !frame) return;
    const style = getComputedStyle(view);
    const limit = parseFloat(style.maxHeight);
    const width = view.offsetWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
      - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (!Number.isFinite(limit) || width <= 0) return;
    setZoom(Math.min(normalZoom, Math.max(minZoom, Math.floor((limit - 4) * frame.width * 100 / (width * frame.height)))));
    view.scrollTo({left: 0, top: 0});
  }

  useLayoutEffect(() => {
    if (autoFit && !manualZoom.current) fitPhoto();
  }, [autoFit, frame?.width, frame?.height]);

  useEffect(() => {
    if (!canAddLine) setAddingLine(false);
  }, [canAddLine]);

  useLayoutEffect(() => {
    if (zoomAnchor.current) {
      const { x, y } = zoomAnchor.current;
      const view = viewport.current, surface = photoSurface.current;
      view.scrollTo({ left: surface.offsetLeft + x * surface.clientWidth - view.clientWidth / 2,
        top: y * surface.clientHeight });
      zoomAnchor.current = null;
    }
  }, [zoom]);

  useEffect(() => {
    if (!showLines || !activeLines.length) return;
    const line = lineLocations.find(item => activeLines.includes(item.index));
    if (!line || !viewport.current || !photoSurface.current) return;
    const view = viewport.current;
    const [x, y, width] = line.box;
    const top = y * photoSurface.current.clientHeight;
    const left = photoSurface.current.offsetLeft + (x + width / 2) * photoSurface.current.clientWidth;
    view.scrollTo({
      top: top < view.scrollTop || top > view.scrollTop + view.clientHeight * 0.85 ? top - view.clientHeight * 0.25 : view.scrollTop,
      left: left < view.scrollLeft || left > view.scrollLeft + view.clientWidth ? left - view.clientWidth / 2 : view.scrollLeft,
    });
  }, [activeLines, lineLocations, showLines]);

  function point(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const clamp = value => Math.min(1, Math.max(0, value));
    return [clamp((event.clientX - rect.left) / rect.width), clamp((event.clientY - rect.top) / rect.height)];
  }

  function rectangle(event) {
    const [x, y] = point(event);
    const { origin: [left, top] } = start.current;
    return [Math.min(x, left), Math.min(y, top), Math.abs(x - left), Math.abs(y - top)];
  }

  function stopDrag() {
    start.current = null;
    setDraft(null);
  }

  function adjust(index, value) {
    const next = [...(box ?? fullImage)];
    next[index] = value;
    next[0] = Math.min(next[0], 1 - next[2]);
    next[1] = Math.min(next[1], 1 - next[3]);
    onSelect(next);
  }

  const preview = (
    <div ref={photoSurface} className={`store-capture-training__preview${!receipt || selecting || addingLine ? " is-selecting" : ""}${turned ? " is-turned" : ""}`}
      style={{ width: receipt ? `${zoom}%` : Math.min(photo.width, 700, 440 * photo.width / photo.height),
        aspectRatio: turned ? `${frame.width} / ${frame.height}` : undefined }}
      onPointerDown={event => {
        if (addingLine && !disabled && event.button === 0 && onAddLine) {
          event.preventDefault();
          onAddLine(point(event));
          setAddingLine(false);
          return;
        }
        if (disabled || start.current || event.button !== 0 || (receipt && !selecting)) return;
        start.current = { id: event.pointerId, origin: point(event) };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => { if (start.current?.id === event.pointerId) setDraft(rectangle(event)); }}
      onPointerUp={event => {
        if (start.current?.id !== event.pointerId) return;
        const selection = rectangle(event);
        stopDrag();
        if (selection[2] >= 0.005 && selection[3] >= 0.005) {
          onSelect(selection);
          if (receipt) setSelecting(false);
        }
      }}
      onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}>
      <img src={photo.preview} alt={receipt ? "Bonfoto" : "Trainingsfoto"} draggable={false}
        style={turned ? { width: `${photo.width / frame.width * 100}%`, height: `${photo.height / frame.height * 100}%`,
          transform: `translate(-50%, -50%) rotate(${frame.angle}deg)` } : undefined} />
      {observations.map(({ box: match }, index) => <span key={index} className="store-capture-training__match" style={outline(match)} aria-hidden="true" />)}
      {showLines && lineLocations.map(({ box: line, index }, i) => index !== null && lineNumbers[index] && <span key={i}
        className={`store-capture-training__bon-line${activeLines.includes(index) ? " is-active" : ""}`}
        style={outline(line)}>
        <button type="button" className="store-capture-training__line-number"
          aria-label={`Z${lineNumbers[index]} im Bon korrigieren`}
          onPointerDown={event => event.stopPropagation()} onClick={() => onOpenLine(index)}>Z{lineNumbers[index]}</button>
      </span>)}
      {onCorners && box && !draft
        ? <CaptureReceiptCrop box={box} corners={corners} photo={photo} surface={photoSurface} disabled={disabled} onChange={onCorners} />
        : (!receipt || box || draft) && <span className="store-capture-training__selection" style={outline(current)} aria-hidden="true" />}
    </div>
  );

  return <div className={receipt ? "store-capture-training__receipt-image" : undefined}>
    {receipt ? <>
      <div className="store-capture-training__viewer-tools store-detail-actions">
        <h4>Bonvorschau</h4>
        {lineLocations.length > 0 && <button type="button" aria-pressed={showLines}
          onClick={() => setShowLines(value => !value)}>Zeilen anzeigen</button>}
        <button type="button" aria-pressed={selecting}
          onClick={() => { setAddingLine(false); setSelecting(value => !value); }}>Ausschnitt markieren</button>
        {onAddLine && <button type="button" aria-pressed={addingLine}
          onClick={() => { setSelecting(false); setShowLines(true); setAddingLine(value => !value); }}>Zeile im Bon ergänzen</button>}
        <div className="store-capture-training__zoom" role="group" aria-label="Bonzoom">
          <button type="button" aria-label="Bon verkleinern" disabled={zoom === minZoom} onClick={() => zoomTo(zoom - 1)}>−</button>
          <input type="range" min={minZoom} max={maxZoom} step={1} value={zoom}
            aria-label="Zoomstufe des Bons" aria-valuetext={`${zoom} %`} onChange={event => zoomTo(event.target.valueAsNumber)} />
          <button type="button" className="store-capture-training__zoom-value" aria-label="Bonzoom zurücksetzen"
            title="Zurück auf 100 %" onClick={() => zoomTo(normalZoom)}>{zoom} %</button>
          <button type="button" aria-label="Bon vergrößern" disabled={zoom === maxZoom} onClick={() => zoomTo(zoom + 1)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M8 10.5h5m-2.5-2.5v5" />
            </svg>
            Lupe
          </button>
        </div>
        {autoFit && <button type="button" onClick={fitPhoto}>Einpassen</button>}
      </div>
      <div className="store-capture-training__orientation store-detail-actions" role="group" aria-label="Bon ausrichten">
        <button type="button" aria-label="Bon 90° nach links drehen" title="90° nach links drehen"
          onClick={() => onOrientation({ ...orientation, quarter: (orientation.quarter + 3) % 4 })}>↶ 90°</button>
        <button type="button" aria-label="Bon 90° nach rechts drehen" title="90° nach rechts drehen"
          onClick={() => onOrientation({ ...orientation, quarter: (orientation.quarter + 1) % 4 })}>↷ 90°</button>
        <div className="store-capture-training__tilt">
          <label>Gerade ausrichten
            <input type="range" min={-45} max={45} step={0.5} value={orientation.tilt}
              aria-valuetext={tiltLabel} onChange={event => onOrientation({ ...orientation, tilt: event.target.valueAsNumber })} />
          </label>
          <button type="button" className="store-capture-training__zoom-value" aria-label="Neigung zurücksetzen"
            title="Neigung auf 0° zurücksetzen" onClick={() => onOrientation({ ...orientation, tilt: 0 })}>{tiltLabel}</button>
        </div>
      </div>
      <div ref={viewport} className={`store-capture-training__viewer${lineLocations.length ? " has-lines" : ""}`}
        role="region" aria-label="Vergrößerbare Bonvorschau" tabIndex={0}>
        {preview}
      </div>
    </> : preview}
    {addingLine && <p role="status">Klicke im Bon auf die Stelle, an der die Zeile fehlt.</p>}
    {onCorners && box && <p id="capture-receipt-corner-help">
      Ziehe die vier Eckgriffe einzeln. Mit Tab und den Pfeiltasten stellst du die Ecken fein ein.
    </p>}
    {(!onCorners || !box || selecting) && <p>{receipt && !selecting
      ? "Stelle die Größe mit dem Regler ein. Im Bild kannst du scrollen."
      : "Ziehe einen Rahmen um den gewünschten Ausschnitt."}</p>}
    {receiptPositions && box && <div className="store-detail-actions">
      <button type="button" onClick={() => onSelect(null)}>Gesamten Bon verwenden</button>
    </div>}
    {(!onCorners || !box) && <details>
      <summary>Ausschnitt mit der Tastatur einstellen</summary>
      <div className="store-capture-training__adjust">
        {[[2, "Breite", 1, 100], [3, "Höhe", 1, 100], [0, "Links", 0, 100 * (1 - current[2])], [1, "Oben", 0, 100 * (1 - current[3])]]
          .map(([index, label, min, max]) => <label key={index}>
            {label} ({Math.round(current[index] * 100)} %)
            <input type="range" min={min} max={Math.round(max)} value={Math.round(current[index] * 100)}
              onChange={event => adjust(index, Number(event.target.value) / 100)} />
          </label>)}
      </div>
    </details>}
  </div>;
}

export default function CaptureTraining({ invoke, onOcrSaved, receiptPositions, receiptCorners, receiptPreparation, receiptAssembly }) {
  const [task, setTask] = useState("photo");
  const [fields, setFields] = useState(emptyFields);
  const [photo, setPhoto] = useState(null);
  const [parts, setParts] = useState(noLines);
  const [joins, setJoins] = useState(noLines);
  const [box, setBox] = useState(null);
  const [corners, setCorners] = useState(null);
  const [cropAngle, setCropAngle] = useState(0);
  const [orientation, setOrientation] = useState(upright);
  const [result, setResult] = useState(null);
  const [extraLines, setExtraLines] = useState(noLines);
  const [lineRequest, setLineRequest] = useState(null);
  const [activeLines, setActiveLines] = useState(noLines);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(null);
  const rotatedPhoto = useRef(null);
  const extraPhotos = useRef(null);
  const receipt = task === "receipt" || task === "ocr";
  const multiPhoto = task === "receipt" && receiptAssembly;
  const frame = receipt ? receiptFrame(photo, (orientation.quarter * 90 + orientation.tilt + 360) % 360) : null;
  const crop = rotateReceiptCrop(box, corners, photo, cropAngle, frame);
  const reviewRows = useMemo(() => {
    if (!result?.text && !extraLines.length) return noLines;
    const originals = (result?.text ?? "").split(/\r?\n/);
    const rows = originals.map((text, index) => ({ text, index }));
    for (const line of [...extraLines].sort((a, b) => b.before - a.before || b.box[1] - a.box[1])) {
      rows.splice(line.before, 0, { index: line.index, text: "", added: true });
    }
    return rows;
  }, [result, extraLines]);
  const lineNumbers = useMemo(() => {
    let number = 0;
    return Object.fromEntries(reviewRows.filter(row => row.added || row.text.trim()).map(row => [row.index, ++number]));
  }, [reviewRows]);
  const lineLocations = useMemo(() => [...(result?.lineLocations ?? noLines), ...extraLines], [result, extraLines]);

  useEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
  }, []);

  function clearReview() {
    setResult(null);
    setExtraLines(noLines);
    setLineRequest(null);
    setActiveLines(noLines);
  }

  async function work(callback) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      return await callback(controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message || "Die Übung konnte nicht verarbeitet werden.");
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function showPhoto(next) {
    setPhoto(next);
    setBox(null);
    setCorners(null);
    setOrientation(upright);
    rotatedPhoto.current = null;
    clearReview();
  }

  function changeTask(event) {
    setTask(event.target.value);
    setFields(emptyFields);
    showPhoto(null);
    setParts(noLines);
    setJoins(noLines);
    setMessage("");
    setError("");
  }

  async function suggestPhoto(prepared, signal) {
    if (task !== "receipt" || !receiptPreparation) return;
    try {
      const suggestion = await invoke({ action: "prepare", task, image: prepared.image }, signal);
      if (signal.aborted) return;
      const { quarter, tilt, corners: points } = suggestion;
      if (!Number.isInteger(quarter) || quarter < 0 || quarter > 3 || !Number.isFinite(tilt) || Math.abs(tilt) > 15) return;
      setOrientation({ quarter, tilt });
      if (receiptCorners && Array.isArray(points) && points.length === 4) {
        const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
        const left = Math.min(...xs), top = Math.min(...ys);
        setBox([left, top, Math.max(...xs) - left, Math.max(...ys) - top]);
        setCorners(points);
        setCropAngle(quarter * 90);
      }
    } catch {
      if (!signal.aborted) setMessage("Du kannst den Ausschnitt und die Ausrichtung von Hand einstellen.");
    }
  }

  function selectPhoto(file) {
    if (!file) return;
    showPhoto(null);
    setParts(noLines);
    setJoins(noLines);
    setFields({ ...emptyFields, example: fields.example });
    void work(async signal => {
      const prepared = { ...await preparePhoto(file, task), fileName: file.name };
      if (signal.aborted) return;
      setPhoto(prepared);
      if (multiPhoto) setParts([prepared]);
      await suggestPhoto(prepared, signal);
    });
  }

  function updateParts(next) {
    setParts(next);
    setJoins(noLines);
    setMessage("");
    setError("");
    showPhoto(next.length === 1 ? next[0] : null);
    if (next.length === 1) void work(signal => suggestPhoto(next[0], signal));
  }

  function addPhotos(files, existing) {
    if (!files.length) return;
    void work(async signal => {
      if (files.length + existing.length > maxReceiptPhotos) throw Error("Wähle bis zu vier Fotos für diesen Bon.");
      const next = [...existing];
      for (const file of files) {
        const prepared = await preparePhoto(file, "receipt");
        if (signal.aborted) return;
        next.push({ ...prepared, fileName: file.name, preview: imageUrl(prepared.image) });
      }
      updateParts(next);
    });
  }

  function assemble() {
    void work(async signal => {
      const response = await invoke({ action: "assemble", task: "receipt", photos: parts.map(part => part.image) }, signal);
      if (signal.aborted) return;
      if (response.state === "review") {
        setJoins(response.joins.filter(join => !join.matchedRows));
        return;
      }
      if (response.state !== "ready" || !response.image?.imageBase64) throw Error("Die Bonfotos konnten nicht zusammengeführt werden.");
      setJoins(noLines);
      const { width, height, mimeType, imageBase64 } = response.image;
      const image = { mimeType, imageBase64 };
      showPhoto({ fileName: parts.length + " Bonfotos", preview: imageUrl(image), width, height, image });
      setMessage(parts.length + " Fotos wurden zu einem Bon zusammengeführt.");
    });
  }

  function edit(field, value, clearResult = false) {
    setFields(previous => ({ ...previous, [field]: value }));
    setMessage("");
    setError("");
    if (clearResult) setResult(null);
  }

  function selectCode(item) {
    setFields(previous => ({ ...previous, code: item.value, label: item.label ?? "" }));
    setMessage("");
    setError("");
  }

  function selectBox(value, printed = "") {
    setBox(value);
    setCorners(null);
    setCropAngle(frame?.angle ?? 0);
    if (task === "ocr") edit("printed", printed);
    if (task === "receipt") clearReview();
    setMessage("");
    setError("");
  }

  function selectCorners(value) {
    setBox(crop.box);
    setCorners(value);
    setCropAngle(frame?.angle ?? 0);
    clearReview();
    setMessage("");
    setError("");
  }

  function changeOrientation(next) {
    if (orientation.quarter === next.quarter && orientation.tilt === next.tilt) return;
    setOrientation(next);
    clearReview();
    setMessage("");
    setError("");
    if (task === "ocr") setFields(previous => ({ ...previous, printed: "" }));
  }

  function openLine(index) {
    setLineRequest({ index });
    setActiveLines([index]);
  }

  function addLine([x, y]) {
    if (!result || extraLines.length >= 32) return;
    const originalCount = result.text.split(/\r?\n/).length;
    const index = originalCount + extraLines.length;
    if (index > 12000) return;
    const guides = (result.lineLocations ?? []).filter(line => line.index !== null)
      .sort((a, b) => a.box[1] - b.box[1]);
    const next = guides.find(line => line.box[1] + line.box[3] / 2 > y);
    const guide = next ?? guides.at(-1);
    const [left, , width, height] = guide?.box ?? [Math.min(x, 0.8), y, Math.min(0.4, 1 - Math.min(x, 0.8)), 0.025];
    const box = [left, Math.max(0, Math.min(1 - height, y - height / 2)), width, height];
    const before = next?.index ?? (guide ? guide.index + 1 : originalCount);
    setExtraLines(previous => [...previous, { index, before, box }]);
    openLine(index);
  }

  async function operation(action, signal, overrides) {
    const { code, corrected, example, heard, label, printed } = fields;
    const base = { action, task };
    let image = photo?.image;
    if (frame?.angle) {
      const cached = rotatedPhoto.current;
      if (cached?.original === photo.image && cached.angle === frame.angle) {
        image = cached.image;
      } else {
        image = await encodeRotatedReceipt(photo, frame);
        if (signal.aborted) return;
        rotatedPhoto.current = { original: photo.image, angle: frame.angle, image };
      }
    }
    if (task === "receipt") return invoke({ ...base, image,
      ...(receiptCorners && crop.corners ? { corners: crop.corners } : { box: crop.box ?? undefined }), ...overrides }, signal);
    if (action === "inspect") {
      if (task === "photo") return invoke({ ...base, image, box: box ?? undefined }, signal);
      if (task === "ocr") return invoke({ ...base, image }, signal);
      if (task === "code") return invoke({ ...base, image, code: code.trim() || undefined, browserCodes: photo?.browserCodes }, signal);
      return invoke({ ...base, heard }, signal);
    }
    if (task === "photo") return invoke({ ...base, image, box: box ?? fullImage, label,
      ...(example === "focus" ? { example } : { example: "package", unit: example }) }, signal);
    if (task === "ocr") return invoke({ ...base, image, box: crop.box, printed }, signal);
    if (task === "code") return invoke({ ...base, code, label }, signal);
    return invoke({ ...base, heard, corrected }, signal);
  }

  function run(action, overrides = {}) {
    return work(async signal => {
      if (action === "inspect" && overrides.text === undefined) {
        clearReview();
      }
      const response = await operation(action, signal, overrides);
      if (signal.aborted) return;
      if (action === "inspect") {
        if (task === "receipt") {
          if (overrides.text !== undefined) return response;
          setResult(response);
        } else {
          setResult(response);
        }
        if (task === "code" && response.codes.length) selectCode(response.codes[0]);
        if (task === "dictation") setFields(previous => ({ ...previous, corrected: response.suggestion }));
        return;
      }
      if (response.accepted === false) throw Error(response.reason || "Wähle einen besser lesbaren Ausschnitt.");
      if (task === "receipt") return true;
      setMessage(response.added ? "Lernbeispiel gespeichert." : "Für diese Eingabe ist bereits ein passendes Lernbeispiel vorhanden.");
      if (task === "ocr" && response.added) onOcrSaved();
    });
  }

  const canInspect = task === "dictation" ? fields.heard.trim() : photo || (task === "code" && fields.code.trim());
  const canSave = result && {
    photo: fields.example === "focus" || fields.label.trim(),
    ocr: crop.box && /^\d{1,5}$/.test(fields.printed),
    code: fields.code.trim() && fields.label.trim(),
    dictation: fields.corrected.trim() && fields.corrected.trim() !== result.suggestion,
  }[task];
  const choices = receiptPositions
    ? { photo: tasks.photo, receipt: "Bonpositionen (OCR)", ocr: "Mengen-Ziffern (OCR)", code: tasks.code, dictation: tasks.dictation }
    : tasks;
  const preview = photo && task !== "code" && <ImageSelection photo={photo} box={crop.box} corners={crop.corners} observations={result?.observations ?? []}
    disabled={busy} onSelect={selectBox} onCorners={task === "receipt" && receiptCorners ? selectCorners : undefined}
    receipt={receipt} receiptPositions={task === "receipt"}
    lineLocations={lineLocations} lineNumbers={lineNumbers} activeLines={activeLines}
    frame={frame} orientation={orientation} onOrientation={changeOrientation}
    autoFit={task === "receipt" && receiptPreparation} onOpenLine={openLine}
    onAddLine={task === "receipt" && result && extraLines.length < 32 ? addLine : undefined} />;
  const inspect = <div className="store-detail-actions store-capture-training__submit">
    <button className="is-primary" type="button" disabled={!canInspect} onClick={() => void run("inspect")}>Auswerten</button>
  </div>;

  return <section className="store-capture-learning__area store-capture-training" aria-labelledby="capture-training-heading" aria-busy={busy}>
    <header className="store-capture-training__intro">
      <h3 id="capture-training-heading">Übung</h3>
      <p>Wähle eine Aufgabe, prüfe die Auswertung und speichere ein bestätigtes Beispiel.</p>
    </header>
    <fieldset disabled={busy} className="store-capture-training__fields">
      <div className="store-capture-training__setup">
        <label>Aufgabe<select value={task} onChange={changeTask}>
          {Object.entries(choices).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        {task === "dictation" ? <label>Erkannter Diktattext<textarea rows={2} value={fields.heard} maxLength={240}
          onChange={event => edit("heard", event.target.value, true)} /></label> : (
          <label>{receipt ? "Bonfoto" : "Trainingsfoto"}
            <span className="store-capture-file-picker">
              <input key={task} type="file" accept={imageTypes.join(",")} multiple={multiPhoto}
                aria-label={receipt ? "Bonfoto auswählen" : "Trainingsfoto auswählen"}
                aria-describedby="capture-training-photo-hint"
                onChange={event => {
                  const input = event.currentTarget;
                  const files = Array.from(input.files);
                  if (multiPhoto && files.length > 1) addPhotos(files, noLines);
                  else selectPhoto(files[0]);
                  input.value = "";
                }} />
              <span className="store-capture-file-picker__action" aria-hidden="true">Foto auswählen</span>
              <span className="store-capture-file-picker__name" title={photo?.fileName}>
                {photo?.fileName || (parts.length ? parts.length + " Fotos gewählt" : "Kein Foto gewählt")}
              </span>
            </span>
            <small id="capture-training-photo-hint">JPG/JPEG, PNG oder WebP · bis 20 MB</small>
          </label>
        )}
      </div>
      {multiPhoto && parts.length > 0 && <div className="store-capture-training__parts">
        <input ref={extraPhotos} type="file" accept={imageTypes.join(",")} capture="environment"
          aria-label="Weiteres Bonfoto auswählen" hidden onChange={event => {
            addPhotos(Array.from(event.currentTarget.files), parts);
            event.currentTarget.value = "";
          }} />
        {parts.length > 1 && <ol aria-label="Bonfotos von oben nach unten">
          {parts.map((part, index) => <li key={index}>
            <img src={imageUrl(part.image)} alt="" />
            <span title={part.fileName}>Foto {index + 1} · {part.fileName}</span>
            <button type="button" disabled={!index} aria-label={"Foto " + (index + 1) + " nach oben"}
              onClick={() => {
                const reordered = [...parts];
                [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
                updateParts(reordered);
              }}>↑</button>
            <button type="button" aria-label={"Foto " + (index + 1) + " entfernen"}
              onClick={() => updateParts(parts.filter((_, partIndex) => partIndex !== index))}>Entfernen</button>
          </li>)}
        </ol>}
        <div className="store-detail-actions">
          <button type="button" disabled={parts.length >= maxReceiptPhotos}
            onClick={() => extraPhotos.current?.click()}>Weiteres Foto zum Bon</button>
          {parts.length > 1 && !photo && <button type="button" className="is-primary" onClick={assemble}>
            Fotos automatisch ausrichten
          </button>}
        </div>
        {parts.length > 1 && !photo && <small>Ordne die Fotos von oben nach unten. Je zwei Fotos sollten zwei bis drei gut lesbare Zeilen gemeinsam haben.</small>}
        {joins.length > 0 && <p role="alert">
          Übergang {joins.map(({ after }) => "Foto " + after + " zu " + (after + 1)).join(", ")} unklar.
          Prüfe die Reihenfolge oder ergänze eine schärfere Aufnahme mit mehr Überlappung.
        </p>}
      </div>}
      {task === "receipt" && photo ? (
        <div className="store-capture-training__workbench">
          {preview}
          <div className="store-capture-training__receipt-result">
            {inspect}
            {busy && <p role="status">Capture verarbeitet die Eingabe …</p>}
            {error && <p role="alert">{error}</p>}
            {result && <CaptureReceiptReview result={result} rows={reviewRows} lineNumbers={lineNumbers} lineLocations={lineLocations}
              lineRequest={lineRequest} onLocate={setActiveLines} onOpen={openLine}
              onConfirm={position => run("confirm", { position })} onParse={text => run("inspect", { text })} />}
          </div>
        </div>
      ) : <>
        {preview}
        {task === "code" && <label>Codeinhalt<input value={fields.code} maxLength={512} onChange={event => edit("code", event.target.value, true)} /></label>}
        {inspect}
      </>}
      {result && task !== "receipt" && <div className="store-capture-training__result">
        <h4>Auswertung</h4>
        {task === "photo" && <>
          <p>{result.observations.length === 1 ? "Capture hat einen Bereich erkannt." :
            result.observations.length ? `Capture hat ${result.observations.length} Bereiche erkannt.` : "Capture hat in diesem Ausschnitt keine Verpackung erkannt."}</p>
          <label>Beispielart<select value={fields.example} onChange={event => edit("example", event.target.value)}>
            <option value="focus">Fokusbereich</option><option value="crate">Kiste</option><option value="piece">Einzelpackung</option>
          </select></label>
        </>}
        {task === "ocr" && <>
          {result.text && <details><summary>Erkannten Bontext anzeigen</summary><pre>{result.text}</pre></details>}
          <p>Wähle einen Vorschlag oder markiere oben die gedruckten Ziffern.</p>
          <div className="store-detail-actions">
            {result.rows.map((row, index) => <button type="button" key={index}
              onClick={() => selectBox(row.box, String(row.suggested ?? row.recognized))}>
              Zeile {row.row} · {row.suggested ?? row.recognized}
            </button>)}
          </div>
          <label>Gedruckte Menge<input inputMode="numeric" maxLength={5} value={fields.printed}
            onChange={event => edit("printed", event.target.value)} /></label>
        </>}
        {task === "code" && (result.codes.length ? <div className="store-detail-actions">
          {result.codes.map(item => <button type="button" key={item.value} aria-pressed={fields.code === item.value}
            onClick={() => selectCode(item)}>{item.value}</button>)}
        </div> : <p>Gib den Codeinhalt ein und werte ihn erneut aus.</p>)}
        {((task === "photo" && fields.example !== "focus") || task === "code") && <label>
          {task === "photo" ? "Name auf der Verpackung" : "Bezeichnung"}
          <input value={fields.label} maxLength={180} onChange={event => edit("label", event.target.value)} />
        </label>}
        {task === "dictation" && <>
          <p>Capture schlägt „{result.suggestion}“ vor.</p>
          <label>Richtige Schreibweise<input value={fields.corrected} maxLength={240}
            onChange={event => edit("corrected", event.target.value)} /></label>
        </>}
        <div className="store-detail-actions">
          <button type="button" disabled={!canSave} onClick={() => run("confirm")}>Als Lernbeispiel speichern</button>
        </div>
      </div>}
    </fieldset>
    {busy && (task !== "receipt" || !photo) && <p role="status">Capture verarbeitet die Eingabe …</p>}
    {message && <p role="status">{message}</p>}
    {error && (task !== "receipt" || !photo) && <p role="alert">{error}</p>}
  </section>;
}
