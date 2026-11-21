import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "../../../system/api/apiClient.js";
import CaptureTraining from "./CaptureTraining.jsx";

const path = "/api/system/runtime/modules/addon.capture/maintenance";
const scope = "receipt-ocr";
const knowledgeSchema = "bonni.capture.receipt-ocr-knowledge/v1";
const maxFileBytes = 1_000_000;

async function readPackages(files) {
  if (!files.length || files.length > 3 || files.some(file => file.size > maxFileBytes)) {
    throw Error("Wähle bis zu drei Capture-Trainingspakete mit höchstens 1 MB pro Datei.");
  }
  return Promise.all(files.map(async file => {
    try {
      return JSON.parse(await file.text());
    } catch {
      throw Error("Eine ausgewählte Wissensdatei enthält kein gültiges JSON.");
    }
  }));
}

function downloadTrainingPackage(data) {
  if (data?.schema !== knowledgeSchema || !Array.isArray(data.samples)) {
    throw Error("Das Capture-Trainingspaket konnte nicht erstellt werden.");
  }
  const blob = new Blob([JSON.stringify(data) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "Capture-Trainingspaket.json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function CaptureLearningModule({ token, view }) {
  const [status, setStatus] = useState(undefined);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const request = useRef(null);
  const fileInput = useRef(null);

  const run = useCallback(async (action, selectedFiles = []) => {
    if (request.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    request.current = controller;
    setBusy(true);
    setMessage("");
    setError("");
    const options = { token, signal, sensitive: true, allowFailover: false, cache: "no-store" };

    async function refreshStatus() {
      const result = await apiRequest(path, options);
      if (result?.schema !== "bonni.module-maintenance/v1") {
        throw Error("Capture konnte den Lernstand nicht liefern.");
      }
      if (!signal.aborted) setStatus(result);
    }

    try {
      if (action === "status") {
        await refreshStatus();
        return;
      }
      const body = action === "import" ? { scope, packages: await readPackages(selectedFiles) } : { scope };
      if (signal.aborted) return;
      const operation = action === "import" ? "configure" : "export";
      const result = await apiRequest(path + "/" + operation, { ...options, method: "POST", body });
      if (signal.aborted) return;

      if (action === "import") {
        setFiles([]);
        if (fileInput.current) fileInput.current.value = "";
        if (result.added === 0) {
          setMessage("Die ausgewählten Muster sind bereits im Lernstand vorhanden.");
        } else {
          setMessage(result.added === 1 ? "1 neues Ziffernmuster ergänzt." : result.added + " neue Ziffernmuster ergänzt.");
        }
        await refreshStatus();
      } else {
        downloadTrainingPackage(result);
        setMessage(result.samples.length + " Ziffernmuster im Trainingspaket.");
      }
    } catch (failure) {
      if (!signal.aborted) setError(failure.message || "Das Trainingspaket konnte nicht verarbeitet werden.");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }, [token]);

  useEffect(() => {
    setStatus(undefined);
    setFiles([]);
    if (fileInput.current) fileInput.current.value = "";
    void run("status");
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [run]);

  const validSelection = files.length > 0 && files.length <= 3
    && files.every(file => file.size <= maxFileBytes);
  const receiptOcr = status?.receiptOcr;

  if (view === "training") {
    const trainingAvailable = status?.training?.schema === "bonni.capture.training/v1";
    return (
      <>
        {trainingAvailable ? (
          <CaptureTraining
            receiptPositions={status.training.receiptPositions === true}
            receiptCorners={status.training.receiptCorners === true}
            receiptPreparation={status.training.receiptPreparation === true}
            receiptAssembly={status.training.receiptAssembly === true}
            invoke={(input, signal) => apiRequest(path + "/configure", {
              token, signal, sensitive: true, allowFailover: false, cache: "no-store", method: "POST",
              body: { scope: "training", ...input },
            })}
            onOcrSaved={() => void run("status")}
          />
        ) : null}
        {!status && !error ? <p role="status">Training wird geladen …</p> : null}
        {status && !trainingAvailable ? <p>Für Übungen benötigst du Bonni Capture DEV19 oder neuer.</p> : null}
        {error ? (
          <div className="store-capture-learning__area">
            <p role="alert">{error}</p>
            <div className="store-detail-actions">
              <button type="button" disabled={busy} onClick={() => void run("status")}>Erneut laden</button>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  const selectedPackages = files.length === 1 ? files[0].name
    : files.length ? `${files.length} Dateien gewählt` : "Keine Datei gewählt";

  return (
    <section className="store-detail-block store-capture-learning" aria-labelledby="capture-learning-heading">
      <header className="store-capture-learning__heading">
        <h2 id="capture-learning-heading">Capture-Lernmodul</h2>
        <p>Lernstand prüfen und Trainingspakete verwalten.</p>
      </header>

      <div className="store-capture-learning__columns" aria-busy={busy}>
        <section className="store-capture-learning__card" aria-labelledby="capture-learning-ocr">
          <h3 id="capture-learning-ocr">OCR-Lernstand</h3>
          <p>Capture liest Text aus Bildern und PDF-Scans. Bestätigte Ziffern dienen als lokale Trainingsmuster.</p>
          {status && !receiptOcr ? <p>Das OCR-Training ist ab Bonni Capture DEV11 verfügbar.</p> : null}
          {receiptOcr ? (
            <>
              <dl className="store-capture-learning__metrics">
                <div><dt>Trainingsmuster</dt><dd>{receiptOcr.trainingDigits}</dd></div>
                <div><dt>Lokale Prüfmuster</dt><dd>{receiptOcr.testDigits}</dd></div>
              </dl>
              {receiptOcr.queued ? <p>Training wartet auf Verarbeitung.</p> : null}
              {receiptOcr.failed ? <p>Training fehlgeschlagen.</p> : null}
              {receiptOcr.candidate ? <p>
                Prüfkandidat mit {receiptOcr.candidate.metrics.digitExamples} Mustern getestet.
                {receiptOcr.candidate.accepted ? " Qualitätsprüfung bestanden." : " Weitere Prüfmuster oder eine höhere Trefferquote sind erforderlich."}
              </p> : null}
            </>
          ) : null}
        </section>

        {receiptOcr ? (
          <section className="store-capture-learning__card" aria-labelledby="capture-learning-packages">
            <h3 id="capture-learning-packages">Trainingspakete</h3>
            <p>Beim Einspielen ergänzt Capture den vorhandenen OCR-Lernstand. Das Gesamtpaket bündelt alle Trainingsmuster in einer JSON-Datei.</p>
            <label className="store-ocr-knowledge__files">
              <span className="store-capture-file-picker">
                <input
                  ref={fileInput} type="file" accept=".json,application/json" multiple disabled={busy}
                  aria-label="Capture-Trainingspakete auswählen" aria-describedby="capture-learning-file-hint"
                  onChange={event => setFiles(Array.from(event.target.files || []))}
                />
                <span className="store-capture-file-picker__action" aria-hidden="true">Dateien wählen</span>
                <span className="store-capture-file-picker__name" title={selectedPackages}>{selectedPackages}</span>
              </span>
              <small id="capture-learning-file-hint">Bis zu 3 JSON-Dateien · je Datei höchstens 1 MB</small>
            </label>
            <div className="store-detail-actions">
              <button type="button" className="is-primary" disabled={busy || !validSelection}
                aria-label="Ausgewählte Trainingspakete einspielen" onClick={() => void run("import", files)}>Einspielen</button>
              <button type="button" disabled={busy || !receiptOcr.trainingDigits}
                onClick={() => void run("export")}>Gesamtpaket herunterladen</button>
            </div>
          </section>
        ) : null}
      </div>

      {busy ? <p role="status">Bitte warten …</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {error ? (
        <div className="store-capture-learning__area">
          <p role="alert">{error}</p>
          {!status || message ? (
            <div className="store-detail-actions">
              <button type="button" disabled={busy} onClick={() => void run("status")}>Erneut laden</button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="store-capture-learning__columns store-capture-learning__features">
        <section className="store-capture-learning__area" aria-labelledby="capture-learning-codes">
          <h3 id="capture-learning-codes">Barcode / QR-Code</h3>
          <p>Capture liest EAN-Barcodes direkt. Für QR-Codes nutzt es die Code-Erkennung des Browsers, sofern sie das Format unterstützt.</p>
        </section>
        <section className="store-capture-learning__area" aria-labelledby="capture-learning-dictation">
          <div className="store-capture-learning__feature-heading">
            <h3 id="capture-learning-dictation">Diktieren</h3>
            <span>Geplant</span>
          </div>
          <p>Gesprochene Eingaben sollen lokal in Text umgewandelt werden.</p>
        </section>
      </div>
    </section>
  );
}
