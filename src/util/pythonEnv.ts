// Resolve o interpretador Python do PROJETO (venv) para rodar a suíte de testes no ambiente certo.
// Sem isto, "pytest -q" é executado pelo shell e pega o pytest do PATH global — que pode não existir
// (ModuleNotFoundError) ou ser de outro ambiente. Rodar "<venv>/python -m pytest" elimina o problema.
import * as path from "node:path";

// Caminhos candidatos do interpretador de um venv na raiz do workspace, em ordem de preferência.
export function venvPythonCandidates(workspaceRoot: string, isWindows: boolean): string[] {
  const rel = isWindows ? ["Scripts", "python.exe"] : ["bin", "python"];
  return [".venv", "venv", ".env"].map((d) => path.join(workspaceRoot, d, ...rel));
}

// Primeiro interpretador de venv que existe, ou undefined. `exists` é injetável (testes). VIRTUAL_ENV
// (venv ativado no ambiente do VS Code) tem prioridade sobre os diretórios convencionais.
export function findVenvPython(
  workspaceRoot: string,
  isWindows: boolean,
  exists: (p: string) => boolean,
  virtualEnv?: string
): string | undefined {
  if (virtualEnv) {
    const p = isWindows ? path.join(virtualEnv, "Scripts", "python.exe") : path.join(virtualEnv, "bin", "python");
    if (exists(p)) return p;
  }
  return venvPythonCandidates(workspaceRoot, isWindows).find(exists);
}

// Monta o comando de "Preparar ambiente" (venv + dependências) para um projeto Python. Se já existe
// um venv (venvPython), só instala; senão cria `.venv` e instala. Encadeia com `&&` — executado via
// exec/spawn com shell (cmd.exe no Windows), onde `&&` é válido (evita o PowerShell do terminal).
//   install="requirements" → pip install -r requirements.txt
//   install="editable"     → pip install -e .   (pyproject.toml INSTALÁVEL: tem [build-system]/[project])
//   install="none"         → só cria o venv e atualiza o pip (pyproject só-de-ferramentas / sem deps
//                            declaradas instaláveis; evita o erro do `-e .` sem backend de build).
export function buildVenvSetupCommand(o: {
  isWindows: boolean;
  venvPython: string | undefined; // caminho do interpretador se o venv já existe
  install: "requirements" | "editable" | "none";
}): string {
  const q = (p: string) => (/\s/.test(p) ? `"${p}"` : p);
  const py = o.isWindows ? "python" : "python3";
  const venvPy = o.isWindows ? ".venv\\Scripts\\python" : ".venv/bin/python";
  const interp = o.venvPython ? q(o.venvPython) : venvPy;
  const installStep =
    o.install === "requirements" ? ` && ${interp} -m pip install -r requirements.txt` : o.install === "editable" ? ` && ${interp} -m pip install -e .` : "";
  if (o.venvPython) {
    // venv já existe: atualiza o pip e (se houver) instala as deps — sem recriar o venv.
    return `${interp} -m pip install --upgrade pip${installStep}`;
  }
  return `${py} -m venv .venv && ${venvPy} -m pip install --upgrade pip${installStep}`;
}

// Monta o comando de teste usando o interpretador do venv quando o comando é pytest. Cobre:
//   "pytest -q"           → `"<venv>" -m pytest -q`
//   "python -m pytest -q" → `"<venv>" -m pytest -q`  (python/python3 SEM caminho — nome nu)
// Um "python" com caminho absoluto (ex.: /usr/bin/python3 -m pytest) ou wrapper (poetry/pipenv/uv run
// pytest) é RESPEITADO como está — o admin já escolheu o interpretador. Sem venv, devolve o original.
export function resolveTestCommand(configuredCommand: string, venvPython: string | undefined): string {
  const cmd = configuredCommand.trim();
  if (!venvPython) return cmd;
  const q = /\s/.test(venvPython) ? `"${venvPython}"` : venvPython;
  const bare = cmd.match(/^pytest\b(.*)$/i);
  if (bare) return `${q} -m pytest${bare[1]}`;
  // "python -m pytest ..." com python/python3 sem caminho (sem barra) — substitui o interpretador.
  const viaModule = cmd.match(/^python3?\s+-m\s+pytest\b(.*)$/i);
  if (viaModule) return `${q} -m pytest${viaModule[1]}`;
  return cmd;
}
