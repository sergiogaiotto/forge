// Detecção de app-servidor Python (FastAPI/ASGI) para o "Executar" subir o servidor com o comando CERTO
// (`uvicorn <modulo>:<app>`) em vez de `python arquivo.py` — que só instancia o app e sai (exit 0) sem
// servir, então nada abre no browser. Funções PURAS/testáveis; o RunService faz o glue com o terminal
// integrado e o vscode.env.openExternal.
import * as path from "node:path";

export interface ServerRunPlan {
  module: string; // módulo Python pontilhado a partir da raiz do workspace (ex.: "src.composition_root")
  appVar: string; // nome da variável do app ASGI declarada no arquivo (ex.: "app")
  selfRun: boolean; // o arquivo sobe o servidor sozinho (chama uvicorn.run) — basta executá-lo
  port: number; // porta a servir (lida do conteúdo quando declarada; senão o default)
}

export const DEFAULT_SERVER_PORT = 8000;

// Converte um caminho relativo .py em módulo Python pontilhado (src/composition_root.py -> src.composition_root).
export function pythonModulePath(relPath: string): string {
  return relPath
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\.py$/i, "")
    .replace(/\/+/g, ".");
}

// Porta declarada no conteúdo do arquivo (uvicorn.run(..., port=8123) ou "--port 8123"); null se não houver.
// Só dígitos plausíveis de porta (1–65535) contam — evita capturar um número qualquer.
export function extractPort(content: string): number | null {
  const m = content.match(/\bport\s*=\s*(\d{1,5})\b/i) ?? content.match(/--port[=\s]+(\d{1,5})\b/i);
  if (!m) return null;
  const p = Number(m[1]);
  return p >= 1 && p <= 65535 ? p : null;
}

// Deteta um app-servidor Python no CONTEÚDO do arquivo, em dois padrões:
//  (1) módulo que DEFINE o app: `<var> = FastAPI(` — sobe com `uvicorn <modulo>:<var>`;
//  (2) entrypoint que RODA o servidor sozinho: uma chamada `uvicorn.run(` (tipicamente num bloco
//      `if __name__ == "__main__":`), mesmo importando o app de outro módulo — basta executar o arquivo.
// Comentários não casam (a linha não pode ter `#` antes do gatilho). Retorna null se não for servidor. Puro.
export function detectFastApiServer(relPath: string, content: string, defaultPort = DEFAULT_SERVER_PORT): ServerRunPlan | null {
  if (!/\.py$/i.test(relPath)) return null;
  // app em NÍVEL DE MÓDULO (coluna 0): um `app = FastAPI()` INDENTADO (app-factory dentro de def) não é
  // servível por `uvicorn <modulo>:app` sem --factory, então não conta como módulo-que-define-o-app.
  const app = content.match(/(?:^|\n)([A-Za-z_]\w*)[ \t]*=[ \t]*FastAPI[ \t]*\(/);
  // "roda sozinho": chama `uvicorn.run(` (fora de comentário) E importa uvicorn — o `import` evita casar
  // um `uvicorn.run(app)` que aparece só em docstring/string de um arquivo que não é entrypoint.
  const callsRun = /(?:^|\n)[ \t]*[^#\n]*\buvicorn\.run[ \t]*\(/.test(content);
  const importsUvicorn = /(?:^|\n)[ \t]*(?:import[ \t]+uvicorn\b|from[ \t]+uvicorn\b)/.test(content);
  const selfRun = callsRun && importsUvicorn;
  if (!app && !selfRun) return null;
  return { module: pythonModulePath(relPath), appVar: app ? app[1] : "app", selfRun, port: extractPort(content) ?? defaultPort };
}

// Torna o caminho do interpretador SEGURO como PRIMEIRO token do comando no terminal, em QUALQUER shell:
// prefere o caminho RELATIVO ao cwd do terminal (a raiz do workspace) quando ele não tem espaço e tem
// separador — assim NÃO precisa de aspas. Uma linha começando por `"..."` no PowerShell (shell padrão do
// VS Code no Windows) é uma STRING literal, não invocação: o servidor nunca subiria. O ws pode ter espaço
// (ex.: C:\Users\João Silva\proj); o relativo (.venv/Scripts/python.exe) não. Só cai no absoluto (que o
// chamador cita) quando o relativo escaparia o ws, mudaria de drive ou teria espaço (venv externo, raro).
export function shellSafePython(python: string, ws: string): string {
  if (!python || !ws || !/[\\/]/.test(python)) return python; // "python"/"python3" sem path já são seguros
  const rel = path.relative(ws, python);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !/\s/.test(rel) && /[\\/]/.test(rel)) {
    return rel.split(path.sep).join("/"); // barra normal serve em cmd e PowerShell no Windows
  }
  return python;
}

// Monta o comando para SUBIR o servidor. Se o arquivo roda o servidor sozinho (uvicorn.run), executa o
// próprio arquivo; senão, `<python> -m uvicorn <modulo>:<app> --port <porta>`. Cita caminhos com espaço.
// `python` é o interpretador do venv quando existe (o mesmo do Preparar ambiente/Testes).
export function buildServerCommand(python: string, plan: ServerRunPlan, absFile: string): string {
  const q = (p: string) => (/\s/.test(p) ? `"${p}"` : p);
  const py = q(python);
  if (plan.selfRun) return `${py} ${q(absFile)}`;
  return `${py} -m uvicorn ${plan.module}:${plan.appVar} --port ${plan.port}`;
}

// Extrai a 1ª URL http(s) de uma linha de saída do servidor ("Uvicorn running on http://127.0.0.1:8000").
// Normaliza 0.0.0.0 para 127.0.0.1 (o wildcard de bind não é endereçável no browser). Tira pontuação final.
export function extractServerUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s"'<>()]+/i);
  if (!m) return null;
  return m[0].replace(/[.,;]+$/, "").replace("://0.0.0.0", "://127.0.0.1");
}

// URL de fallback (host local + porta do plano) para abrir no browser quando não capturamos a linha do servidor.
export function fallbackUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}
