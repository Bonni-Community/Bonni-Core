import { normalizeHomeserver, normalizeMatrixSession } from "./matrixSession.js";

export async function loginWithMatrixPassword({ homeserver, username, password }) {
  const sdk = await import("matrix-js-sdk");
  const baseUrl = normalizeHomeserver(homeserver);
  const user = String(username || "").trim();

  if (!user) throw new Error("Bitte Matrix-Benutzername oder Matrix-ID angeben.");
  if (!password) throw new Error("Bitte das Matrix-Passwort angeben.");

  const loginClient = sdk.createClient({ baseUrl });
  const response = await loginClient.loginRequest({
    type: "m.login.password",
    identifier: {
      type: "m.id.user",
      user,
    },
    password,
    initial_device_display_name: "Bonni Core MatrixChat",
    refresh_token: true,
  });

  const session = normalizeMatrixSession({
    homeserver: baseUrl,
    accessToken: response.access_token,
    userId: response.user_id,
    deviceId: response.device_id,
    refreshToken: response.refresh_token,
  });

  if (!session) throw new Error("Der Homeserver hat keine vollständige Sitzung geliefert.");
  return session;
}
