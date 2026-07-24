export class CoreAuthenticationService {
  async status() {
    return {
      layer: "system/auth/authentication",
      responsibility: "technische Login-, Token- und Session-Schicht",
      checkedAt: new Date(),
    };
  }
}

export const coreAuthenticationService = new CoreAuthenticationService();
