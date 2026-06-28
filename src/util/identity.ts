import * as os from "node:os";

// Login do usuário do sistema operacional. Metadado secundário de
// observabilidade (a identidade principal é o e-mail — ver resolveEmailIdentity).
export function osLogin(): string {
  try {
    const u = os.userInfo().username;
    if (u && u.trim()) return u.trim();
  } catch {
    /* alguns ambientes não expõem userInfo — cai no fallback abaixo */
  }
  return (process.env.USERNAME || process.env.USER || process.env.LOGNAME || "unknown").trim();
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value: string | undefined | null): boolean {
  return !!value && EMAIL_RE.test(value.trim());
}

export type EmailSource = "license" | "manual" | "none";

export interface EmailIdentity {
  /** E-mail resolvido (identidade para o Langfuse), ou null se ainda falta informar. */
  email: string | null;
  /** true quando o dev DEVE informar o e-mail no setup (não há coleta automática). */
  emailRequired: boolean;
  source: EmailSource;
}

/**
 * Resolve a identidade (e-mail) do dev (RF-063):
 *  - usa o e-mail informado manualmente, se houver;
 *  - senão, usa o `subject` da licença quando ele é um e-mail válido — desde que
 *    o admin não force a coleta manual (`requireEmail`);
 *  - caso contrário, sinaliza que o e-mail é obrigatório no setup inicial.
 */
export function resolveEmailIdentity(opts: {
  subject?: string | null;
  manualEmail?: string | null;
  requireEmail: boolean;
}): EmailIdentity {
  const manual = isEmail(opts.manualEmail) ? opts.manualEmail!.trim() : null;
  if (manual) return { email: manual, emailRequired: false, source: "manual" };

  const subjectIsEmail = isEmail(opts.subject);
  const needsManual = opts.requireEmail || !subjectIsEmail;
  if (!needsManual && subjectIsEmail) {
    return { email: opts.subject!.trim(), emailRequired: false, source: "license" };
  }
  return { email: null, emailRequired: true, source: "none" };
}
