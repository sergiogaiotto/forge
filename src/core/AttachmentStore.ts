// Lista de ANEXOS pendentes do chat — arquivos do workspace, seleção do editor/terminal, OCR de print e
// resultados de busca que o dev anexa ANTES de enviar. Extraído do Controller (god-object 4157L) para uma
// unidade PURA e testável: a coleta vscode-específica (showQuickPick / workspace.fs / editor / terminal /
// tesseract) fica no Controller e chama `add()`; a LÓGICA DE ESTADO — cap de conteúdo, janela deslizante de
// 8, consumo-no-envio, snapshot dos chips e a contagem para o /contexto — mora aqui, com invariantes que o
// god-object nunca teve teste. `onChange` dispara o Controller a re-postar os chips na webview.
export type AttachmentKind = "workspace" | "upload" | "selection" | "search";
export interface Attachment {
  id: string;
  label: string;
  kind: AttachmentKind;
  content: string;
}
// Metadado enviado à webview (sem o `content` — o chip só mostra label/bytes/kind).
export interface AttachmentChip {
  id: string;
  label: string;
  bytes: number;
  kind: AttachmentKind;
}

const CONTENT_CAP = 16000; // por-anexo: conteúdo maior é truncado (evita estourar o contexto com um só arquivo)
const MAX_ITEMS = 8; // só os 8 mais recentes sobrevivem (janela deslizante)

export class AttachmentStore {
  private items: Attachment[] = [];
  private seq = 0;

  // onChange: chamado quando a lista MUDA (add/remove/clear efetivos) para o dono re-postar os chips.
  constructor(private readonly onChange: () => void) {}

  // Adiciona um anexo: capa o conteúdo, mantém só os MAX_ITEMS mais recentes, notifica. Idempotente no cap.
  add(label: string, kind: AttachmentKind, content: string): void {
    const capped = content.length > CONTENT_CAP ? content.slice(0, CONTENT_CAP) + "\n… (truncado)" : content;
    this.items.push({ id: `att_${++this.seq}`, label, kind, content: capped });
    if (this.items.length > MAX_ITEMS) this.items = this.items.slice(-MAX_ITEMS);
    this.onChange();
  }

  // Remove pelo id. Só notifica se algo saiu (remover um id inexistente é no-op silencioso).
  remove(id: string): void {
    const before = this.items.length;
    this.items = this.items.filter((a) => a.id !== id);
    if (this.items.length !== before) this.onChange();
  }

  // Esvazia a lista. Só notifica se havia algo (evita post espúrio).
  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.onChange();
  }

  // Consome os anexos NO ENVIO: devolve o bloco de contexto pt-BR já formatado (ou "" se vazio) e ESVAZIA a
  // lista SEM notificar (o chamador re-posta os chips após montar o prompt — anexos são consumidos no envio).
  consumeAsContext(): string {
    if (this.items.length === 0) return "";
    const att = this.items.map((a) => `### Anexo: ${a.label}\n\`\`\`\n${a.content}\n\`\`\``).join("\n\n");
    this.items = [];
    return `Anexos fornecidos pelo usuário:\n${att}\n\n`;
  }

  // Snapshot dos CHIPS para a webview (metadados; `bytes` é o tamanho do conteúdo JÁ capado).
  chips(): AttachmentChip[] {
    return this.items.map((a) => ({ id: a.id, label: a.label, bytes: a.content.length, kind: a.kind }));
  }

  count(): number {
    return this.items.length;
  }

  // Conteúdos crus (para a estimativa de tokens do /contexto).
  contents(): string[] {
    return this.items.map((a) => a.content);
  }
}
