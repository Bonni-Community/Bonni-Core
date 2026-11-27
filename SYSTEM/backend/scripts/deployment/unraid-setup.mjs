import {randomBytes, timingSafeEqual} from 'node:crypto';
import {unraidSetupView} from './unraid-setup-view.mjs';

export function validAdminPassword(password) {
  return typeof password === 'string' && /^[A-Za-z0-9._@%+!:=-]{8,512}$/.test(password)
    && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password)
    && /[._@%+!:=-]/.test(password) && !/change.?me|example|default|password|passwort|admin|postgres/i.test(password);
}

export function unraidSetup({logo, designSource, version, hostDataPath, savePassword, onSetup, onError, token = randomBytes(32).toString('hex')}) {
  const {html, csp} = unraidSetupView(designSource, version, hostDataPath);
  const headers = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': csp,
  };
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
