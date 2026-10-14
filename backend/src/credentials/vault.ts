export class CredentialVault {
  private session = new Map<string, string>();
  async set(key: string, token: string, persist: boolean) {
    if (!persist) {
      this.session.set(key, token);
      return "session";
    }
    try {
      const { Entry } = await import("@napi-rs/keyring");
      const entry = new Entry("LeanReview", key, {
        linux: { store: "secret-service" },
      });
      entry.setPassword(token);
      this.session.delete(key);
      return "os";
    } catch {
      throw new Error(
        "OS credential storage is unavailable or locked. Select session-only storage explicitly.",
      );
    }
  }
  async get(key: string, allowPersistent = true) {
    if (this.session.has(key)) return this.session.get(key)!;
    if (!allowPersistent) return null;
    try {
      const { Entry } = await import("@napi-rs/keyring");
      return new Entry("LeanReview", key, {
        linux: { store: "secret-service" },
      }).getPassword();
    } catch {
      return null;
    }
  }
}
