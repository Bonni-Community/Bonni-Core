import {createHash} from 'node:crypto';

const script = `
const form = document.querySelector('form');
const code = form.elements.code;
const password = form.elements.password;
const confirmation = form.elements.confirm;
const next = document.querySelector('#next');
const back = document.querySelector('#back');
const message = document.querySelector('#error');
const status = document.querySelector('#status');
const steps = [...form.querySelectorAll('[data-step]')];
const progress = [...document.querySelectorAll('#steps li')];
const poses = [...document.querySelectorAll('[data-pose]')];
const stages = {
  accepted: 'Die Einrichtung wurde übernommen.',
  database: 'Die Datenbank wird vorbereitet.',
  account: 'Das Admin-Konto wird angelegt.',
  startup: 'Bonni Core wird gestartet.',
};

let current = 0;
let submitting = false;
let installing = false;

const token = location.hash.slice(1);
if (token) history.replaceState(null, '', location.pathname);
if (/^[a-f0-9]{64}$/.test(token)) code.value = token;

function showStep(index, focus = true) {
  current = index;
  steps.forEach((step, position) => { step.hidden = position !== index; });
  progress.forEach((step, position) => {
    if (position === Math.min(index, 3)) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
  poses.forEach((pose, position) => { pose.hidden = position !== Math.min(index, 3); });
  back.hidden = index === 0;
  next.textContent = index === 3 ? 'Einrichtung starten' : 'Weiter';
  form.querySelector('.actions').hidden = index === 4;
  message.textContent = '';
  if (focus) steps[index].querySelector('h1').focus();
}

async function waitUntilReady() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      const ready = await fetch('/runtime-proxy/active-health', {cache: 'no-store'});
      if (ready.ok) {
        location.replace('/');
        return;
      }
      const response = await fetch('/api/setup/status', {cache: 'no-store'});
      if (response.ok) {
        const {phase} = await response.json();
        if (Object.hasOwn(stages, phase)) status.textContent = stages[phase];
      }
    } catch { /* The container can briefly be unavailable during start. */ }
  }
  status.textContent = 'Der Start dauert länger als erwartet. Die Meldungen findest du in Unraid unter Docker → Bonni-Core → Protokolle.';
}

function showProgress(phase) {
  if (installing) return;
  installing = true;
  form.reset();
  showStep(4);
  status.textContent = stages[phase];
  void waitUntilReady();
}

back.addEventListener('click', () => showStep(current - 1));
document.querySelector('#reveal').addEventListener('change', event => {
  password.type = confirmation.type = event.target.checked ? 'text' : 'password';
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submitting || installing) return;
  if (current === 0) {
    code.value = code.value.trim();
    if (code.reportValidity()) showStep(1);
    return;
  }
  if (current === 1) {
    showStep(2);
    return;
  }
  if (current === 2) {
    if (!password.reportValidity() || !confirmation.reportValidity()) return;
    if (password.value !== confirmation.value) {
      message.textContent = 'Die Passwörter stimmen nicht überein.';
      confirmation.focus();
      return;
    }
    showStep(3);
    return;
  }

  submitting = true;
  next.disabled = back.disabled = true;
  message.textContent = '';
  try {
    const response = await fetch('/api/setup', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Bonni-Setup': code.value},
      body: JSON.stringify({password: password.value}),
    });
    if (response.status === 403) {
      showStep(0);
      message.textContent = 'Der Einrichtungscode ist ungültig. Bitte kopiere den aktuellen Code aus den Protokollen.';
      code.focus();
    } else if (response.status === 400) {
      showStep(2);
      message.textContent = 'Wähle mindestens 8 Zeichen mit Großbuchstaben, Kleinbuchstaben, Zahl und Sonderzeichen.';
      password.focus();
    } else if (response.status === 202) {
      showProgress('accepted');
    } else {
      message.textContent = response.status === 409
        ? 'Die Einrichtung wird bereits verarbeitet. Lade diese Seite erneut.'
        : 'Die Einrichtung konnte nicht gespeichert werden. Prüfe die Protokolle des Containers.';
    }
  } catch {
    message.textContent = 'Die Verbindung wurde unterbrochen. Lade diese Seite erneut.';
  } finally {
    submitting = false;
    next.disabled = back.disabled = false;
  }
});

showStep(0, false);
fetch('/api/setup/status', {cache: 'no-store'})
  .then(response => response.ok ? response.json() : null)
  .then(result => {
    if (result && Object.hasOwn(stages, result.phase)) showProgress(result.phase);
  })
  .catch(() => {});
`;

const poseDescriptions = [
  ['pose-pruefung', 'Bonni untersucht eine Festplatte mit einer Lupe.'],
  ['pose-speicherort', 'Bonni räumt eine Kiste ins Lagerregal.'],
  ['pose-admin', 'Bonni notiert Angaben auf einem Klemmbrett.'],
  ['pose-zusammenfassung', 'Bonni stellt das Ergebnis auf einer Anzeige dar.'],
];

const setupStyles = `
.brand-hexagon, .brand-hexagon-inner {
  display: grid;
  place-items: center;
  clip-path: polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%);
}
.brand-hexagon { width: 44px; height: 44px; padding: 1px; background: #ffa954; }
.brand-hexagon-inner { width: 100%; height: 100%; background: #fff; }
.brand-hexagon .brand-logo { width: 100%; height: 100%; }
@media (min-width: 761px) {
  .rail { align-self: stretch; display: flex; flex-direction: column; }
  .rail .helper { margin-top: auto; }
  .rail .steps { margin-bottom: 24px; }
}
@media (max-width: 760px) {
  .brand-hexagon { width: 36px; height: 36px; }
  .storage-path { flex-wrap: wrap; gap: 4px 14px; }
}
`;

function storageRows(hostDataPath) {
  const escaped = hostDataPath?.startsWith('/')
    ? hostDataPath.replace(/[&<>]/g, value => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[value])
    : null;
  const host = escaped ? `<code>${escaped}</code>` : 'Unter „Bonni-Core → Bearbeiten“ prüfen';
  return `<div class="datum storage-path"><dt>Datenordner auf Unraid</dt><dd>${host}</dd></div>
        <div class="datum storage-path"><dt>Pfad im Container</dt><dd><code>/bonni-data</code></dd></div>`;
}

export function unraidSetupView(designSource, version, hostDataPath) {
  const baseStyles = /<style>([\s\S]*?)<\/style>/.exec(designSource)?.[1].replace(/\r\n?/g, '\n');
  if (!baseStyles) throw Error('UNRAID_SETUP_STYLES_MISSING');
  const stylesheet = baseStyles + setupStyles;
  const paths = storageRows(hostDataPath);
  const illustrations = poseDescriptions.map(([id, description], index) => {
    const src = new RegExp(`<img id="${id}"[^>]* src="(data:image/(?:png|webp);base64,[A-Za-z0-9+/=]+)"`).exec(designSource)?.[1];
    if (!src) throw Error('UNRAID_SETUP_ILLUSTRATION_MISSING: ' + id);
    return `<img data-pose="${index}" src="${src}" width="216" height="205" alt="${description}"${index ? ' hidden' : ''}>`;
  }).join('');
  const versionText = /^\d+\.\d+\.\d+(?:[+-][a-z])?$/.test(version) ? `v${version}` : '–';
  const hash = value => createHash('sha256').update(value).digest('base64');
  const csp = `default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(stylesheet)}'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`;
  const html = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bonni Core einrichten</title>
  <style>${stylesheet}</style>
</head>
<body>
<header><div class="bar"><div class="brand"><span class="brand-hexagon" aria-hidden="true"><span class="brand-hexagon-inner"><img class="brand-logo" src="/bonni-logo.png" alt="" width="44" height="44"></span></span>Bonni Core</div><span class="small-label">Ersteinrichtung</span></div></header>
<main class="layout">
  <aside class="rail" aria-label="Einrichtungsschritte">
    <h2>Bonni einrichten</h2>
    <ol id="steps" class="steps"><li aria-current="step">Prüfung</li><li>Speicherort</li><li>Admin-Konto</li><li>Zusammenfassung</li></ol>
    <div class="helper"><div class="helper-art">${illustrations}</div></div>
  </aside>
  <form class="card" novalidate>
    <section data-step="0">
      <h1 tabindex="-1">System prüfen</h1>
      <dl class="rows">
        <div class="datum"><dt>NAS-System</dt><dd>Unraid</dd></div>
        <div class="datum"><dt>Architektur</dt><dd>AMD64</dd></div>
        <div class="datum"><dt>Bonni Core</dt><dd>${versionText}</dd></div>
      </dl>
      <div class="field note">
        <label for="setup-code">Einrichtungscode</label>
        <input id="setup-code" name="code" type="password" autocomplete="off" spellcheck="false" pattern="[a-f0-9]{64}" maxlength="64" required aria-describedby="code-hint">
        <small id="code-hint">Den Code findest du in Unraid unter Docker → Bonni-Core → Protokolle.</small>
      </div>
    </section>
    <section data-step="1" hidden>
      <h1 tabindex="-1">Speicherort prüfen</h1>
      <dl class="rows">${paths}</dl>
      <p class="note">Im Datenordner auf Unraid speichert Bonni die Datenbank und die Einstellungen. Den Ordner findest du unter Docker → Bonni-Core → Bearbeiten.</p>
    </section>
    <section data-step="2" hidden>
      <h1 tabindex="-1">Admin-Konto anlegen</h1>
      <p class="intro">Mit dem Benutzernamen <strong>admin</strong> meldest du dich nach der Einrichtung an.</p>
      <div class="fields">
        <div class="field">
          <label for="password">Admin-Passwort</label>
          <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="512" required aria-describedby="password-hint">
          <small id="password-hint">Mindestens 8 Zeichen mit Groß- und Kleinbuchstaben, einer Zahl und einem Sonderzeichen aus ._@%+!:=-.</small>
        </div>
        <div class="field">
          <label for="confirmation">Passwort wiederholen</label>
          <input id="confirmation" name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="512" required>
        </div>
      </div>
      <label class="inline"><input id="reveal" type="checkbox"> Passwörter anzeigen</label>
    </section>
    <section data-step="3" hidden>
      <h1 tabindex="-1">Einrichtung überprüfen</h1>
      <dl class="rows">
        ${paths}
        <div class="datum"><dt>Datenbank</dt><dd>PostgreSQL im Bonni-Core-Container</dd></div>
        <div class="datum"><dt>Anmeldung</dt><dd>admin</dd></div>
      </dl>
      <p class="note">Nach der Einrichtung öffnet sich die Anmeldung automatisch.</p>
    </section>
    <section data-step="4" hidden>
      <h1 tabindex="-1">Bonni wird eingerichtet</h1>
      <p id="status" class="intro" role="status"></p>
    </section>
    <p id="error" class="error" role="alert"></p>
    <div class="actions"><button id="back" type="button" hidden>Zurück</button><button id="next" type="submit" class="primary">Weiter</button></div>
  </form>
</main>
<script>${script}</script>
</body>
</html>`;
  return {html, csp};
}
