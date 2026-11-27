import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';

const script = `
const form = document.querySelector('form');
const status = document.querySelector('#status');
const steps = [...form.querySelectorAll('fieldset')];
const progress = [...document.querySelectorAll('#steps li')];
const code = form.elements.code;
const password = form.elements.password;
const confirmation = form.elements.confirm;
const submit = form.querySelector('[type=submit]');
const token = location.hash.slice(1);
if (token) history.replaceState(null, '', location.pathname);
let current = 0;

function showStep(index) {
  current = index;
  steps.forEach((step, position) => {
    step.hidden = position !== index;
    step.disabled = position !== index;
    if (position === index) progress[position].setAttribute('aria-current', 'step');
    else progress[position].removeAttribute('aria-current');
  });
  (steps[index].querySelector('input') || steps[index].querySelector('legend')).focus();
}

if (/^[a-f0-9]{64}$/.test(token)) code.value = token;
document.querySelector('#next').addEventListener('click', () => advance());
document.querySelector('#review').addEventListener('click', () => advance());
for (const button of document.querySelectorAll('[data-back]')) {
  button.addEventListener('click', () => { status.textContent = ''; showStep(current - 1); });
}

function advance() {
  status.textContent = '';
  if (current === 0 && code.reportValidity()) showStep(1);
  else if (current === 1 && password.reportValidity() && confirmation.reportValidity()) {
    if (password.value !== confirmation.value) {
      status.textContent = 'Die Passwörter stimmen nicht überein.';
      confirmation.focus();
      return;
    }
    showStep(2);
  }
}

const phases = {
  accepted: 'Die Einrichtung wurde übernommen.',
  database: 'Datenbank wird vorbereitet.',
  account: 'Das Admin-Konto wird angelegt.',
  startup: 'Bonni Core wird gestartet.',
};
async function waitUntilReady() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      const ready = await fetch('/runtime-proxy/active-health', {cache: 'no-store'});
      if (ready.ok) { location.replace('/'); return; }
      const response = await fetch('/api/setup/status', {cache: 'no-store'});
      if (response.ok) {
        const phase = (await response.json()).phase;
        if (Object.hasOwn(phases, phase)) status.textContent = phases[phase];
      }
    } catch { /* The container may be restarting. */ }
  }
  status.textContent = 'Der Start dauert länger als erwartet. Prüfe unter Unraid → Docker → Bonni Core die Logs.';
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (current < 2) { advance(); return; }
  if (submit.disabled) return;
  submit.disabled = true;
  const back = steps[2].querySelector('[data-back]');
  back.disabled = true;
  try {
    const response = await fetch('/api/setup', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Bonni-Setup': code.value.trim()},
      body: JSON.stringify({password: password.value}),
    });
    if (response.status === 403) {
      status.textContent = 'Der Einrichtungscode ist ungültig. Kopiere den aktuellen Code aus den Bonni-Core-Logs.';
      showStep(0);
    } else if (response.status === 400) {
      status.textContent = 'Verwende mindestens 8 Zeichen mit Großbuchstaben, Kleinbuchstaben, Zahl und Sonderzeichen.';
      showStep(1);
    } else if (response.ok) {
      form.reset();
      form.hidden = true;
      status.textContent = phases.accepted;
      await waitUntilReady();
      return;
    } else {
      status.textContent = 'Die Einrichtung konnte nicht übernommen werden. Prüfe die Bonni-Core-Logs.';
      submit.disabled = false;
      return;
    }
  } catch {
    status.textContent = 'Die Verbindung wurde unterbrochen. Prüfe die Bonni-Core-Logs.';
  } finally {
    submit.disabled = false;
    back.disabled = false;
  }
});
fetch('/api/setup/status', {cache: 'no-store'}).then(response => response.ok ? response.json() : null).then(result => {
  if (result && Object.hasOwn(phases, result.phase)) {
    form.reset();
    form.hidden = true;
    status.textContent = phases[result.phase];
    void waitUntilReady();
  }
}).catch(() => {});
showStep(0);
`;
const stylesheet = `
:root{color-scheme:dark;font:16px system-ui;background:#141414;color:#f4f2ef}
main{max-width:34rem;margin:8vh auto;padding:1.5rem}
img{width:64px;height:64px;object-fit:contain}
fieldset{border:0;padding:0;margin:1.5rem 0}
legend{font-size:1.15rem;font-weight:700;padding:0}
ol{display:flex;flex-wrap:wrap;gap:.45rem 1.7rem;padding-left:1.4rem;color:#bab4ad}
li[aria-current=step]{color:#f8a752;font-weight:700}
label,input{display:block;width:100%;box-sizing:border-box}
label{margin:1rem 0}
input,button{font:inherit;padding:.75rem;border-radius:.35rem;margin-top:.35rem}
input{border:1px solid #777;background:#242424;color:inherit}
button{border:0;background:#f8a752;color:#20170e;font-weight:bold;cursor:pointer}
button[data-back]{background:transparent;border:1px solid #777;color:inherit;margin-right:.5rem}
button:disabled{opacity:.55}
`;
const html = `<!doctype html><html lang="de"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bonni Core einrichten</title><style>${stylesheet}</style>
<main><img alt="" src="/bonni-logo.png"><h1>Bonni Core einrichten</h1>
<ol id="steps" aria-label="Einrichtungsschritte"><li>Einrichtungscode</li><li>Admin-Konto</li><li>Start</li></ol>
<form novalidate>
<fieldset><legend tabindex="-1">Einrichtungscode</legend>
<p>Öffne unter Unraid → Docker → Bonni Core die Logs und kopiere den Einrichtungscode hierher.</p>
<label>Code
<input name="code" type="password" autocomplete="off" spellcheck="false" pattern="[a-f0-9]{64}" maxlength="64" required></label>
<button type="button" id="next">Weiter</button></fieldset>
<fieldset hidden disabled><legend tabindex="-1">Admin-Konto</legend>
<p>Benutzername <strong>admin</strong></p><label>Passwort
<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="512" required></label>
<label>Passwort wiederholen
<input name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="512" required></label>
<button type="button" data-back>Zurück</button><button type="button" id="review">Weiter</button></fieldset>
<fieldset hidden disabled><legend tabindex="-1">Bonni Core starten</legend>
<p>Bonni legt die Datenbank im Datenordner an, der in Unraid für diesen Container hinterlegt ist. Danach öffnet sich die Anmeldung automatisch.</p>
<button type="button" data-back>Zurück</button><button type="submit">Einrichtung starten</button>
</fieldset></form><p id="status" role="status"></p></main>
<script>${script}</script></html>`;

const hash = text => createHash('sha256').update(text).digest('base64');
const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(stylesheet)}'; img-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
};

export function validAdminPassword(password) {
  return typeof password === 'string' && /^[A-Za-z0-9._@%+!:=-]{8,512}$/.test(password)
    && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password)
    && /[._@%+!:=-]/.test(password) && !/change.?me|example|default|password|passwort|admin|postgres/i.test(password);
}

export function unraidSetup({logo, savePassword, onSetup, onError, token = randomBytes(32).toString('hex')}) {
  let claimed = false;
  let phase = 'waiting';
  const send = (res, status, type, body = '') => {
    res.writeHead(status, {...headers, 'Content-Type': type});
    res.end(body);
  };
  async function request(req, res) {
    if (req.method === 'GET' && req.url === '/') {
      return send(res, 200, 'text/html; charset=utf-8', html);
    }
    if (req.method === 'GET' && req.url === '/api/setup/status') {
      return send(res, 200, 'application/json', JSON.stringify({phase}));
    }
    if (req.method === 'GET' && req.url === '/bonni-logo.png') return send(res, 200, 'image/png', logo);
    if (req.method !== 'POST' || req.url !== '/api/setup') return send(res, 503, 'text/plain');

    const access = req.headers['x-bonni-setup'];
    if (!/^[a-f0-9]{64}$/.test(access ?? '') || !timingSafeEqual(Buffer.from(access), Buffer.from(token))
      || req.headers.origin !== `http://${req.headers.host}`
      || req.headers['content-type'] !== 'application/json') return send(res, 403, 'text/plain');
    if (claimed) return send(res, 409, 'text/plain');

    let data;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) return send(res, 413, 'text/plain');
        chunks.push(chunk);
      }
      data = JSON.parse(Buffer.concat(chunks));
    } catch {
      return send(res, 400, 'text/plain');
    }
    if (!data || Object.keys(data).join() !== 'password' || !validAdminPassword(data.password)) {
      return send(res, 400, 'text/plain');
    }
    if (claimed) return send(res, 409, 'text/plain');
    claimed = true;
    try {
      await savePassword(data.password);
    } catch (error) {
      claimed = false;
      onError(error);
      return send(res, 500, 'text/plain');
    }
    phase = 'accepted';
    send(res, 202, 'text/plain');
    onSetup();
  }
  return {token, request, setPhase(value) { phase = value; }};
}
