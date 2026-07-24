type ExternalJobResult = {
  skipped?: boolean;
  ok?: boolean;
  reason?: string;
  application: string;
  targetEnv: string;
  target?: string;
};

export async function postExternalApplicationJob(application: string, targetEnv: string, path: string): Promise<ExternalJobResult | unknown> {
  const baseUrl = process.env[targetEnv]?.replace(/\/$/, "");
  if (!baseUrl) {
    return { skipped: true, reason: "APPLICATION_BACKEND_NOT_CONNECTED", application, targetEnv };
  }

  const target = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const response = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "system-workflow" }) });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: response.ok, application, targetEnv, target, response: text };
  }
}
