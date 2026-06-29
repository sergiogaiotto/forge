import * as vscode from "vscode";
import { log } from "../util/logger";

// Wrapper fino e auditado sobre o SecretStorage do VSCode. Toda credencial que a
// extensão persiste (token de sessão, apiKey de provider, credenciais de MCP) passa
// por aqui e SOMENTE por aqui — nunca pelo settings.json, nunca em disco (RF-014/024, RNF-001).
export class SecretsStore {
  static readonly KEY_SESSION_TOKEN = "forge.session.token";
  static readonly KEY_LICENSE = "forge.license.key";
  static readonly KEY_LANGFUSE_SECRET = "forge.observability.langfuse.secretKey";
  static readonly providerApiKey = (id: string) => `forge.provider.${id}.apiKey`;
  static readonly mcpCredential = (ref: string) => `forge.mcp.${ref}`;

  /** Definido quando o SecretStorage não tem um backend forte (Linux sem keyring). RNF-003. */
  private weakBackendWarned = false;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async set(ref: string, value: string): Promise<void> {
    await this.secrets.store(ref, value);
    await this.verifyBackend(ref, value);
  }

  async get(ref: string): Promise<string | undefined> {
    return this.secrets.get(ref);
  }

  async delete(ref: string): Promise<void> {
    await this.secrets.delete(ref);
  }

  // RNF-003: se um segredo armazenado não puder ser lido de volta, a plataforma
  // provavelmente não possui um keyring seguro. Sinalizamos isso em vez de presumir confidencialidade.
  private async verifyBackend(ref: string, expected: string): Promise<void> {
    try {
      const roundtrip = await this.secrets.get(ref);
      if (roundtrip !== expected && !this.weakBackendWarned) {
        this.weakBackendWarned = true;
        log.warn("SecretStorage round-trip mismatch — keyring may be unavailable.");
        void vscode.window.showWarningMessage(
          "FORGE: o armazenamento seguro de credenciais não parece disponível neste sistema (keyring ausente). " +
            "As credenciais podem não estar protegidas. Configure um keyring (ex.: gnome-keyring/libsecret) antes de usar em produção."
        );
      }
    } catch (err) {
      log.warn("SecretStorage verifyBackend failed", err);
    }
  }
}
