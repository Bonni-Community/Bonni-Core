export class AuthAppShell {
  async boot() {
    return { shell: "core-auth", bootedAt: new Date() };
  }
}

export const authAppShell = new AuthAppShell();
