import * as os from "node:os";

// Login do usuário do sistema operacional. Usado como identidade para a
// observabilidade (vira o `userId` do trace no Langfuse). Captura local, sem
// rede e sem prompt de autenticação — coerente com a operação in-network.
export function osLogin(): string {
  try {
    const u = os.userInfo().username;
    if (u && u.trim()) return u.trim();
  } catch {
    /* alguns ambientes não expõem userInfo — cai no fallback abaixo */
  }
  return (process.env.USERNAME || process.env.USER || process.env.LOGNAME || "unknown").trim();
}
