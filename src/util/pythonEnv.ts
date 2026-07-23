// Resolve o interpretador Python do PROJETO (venv) para rodar a suíte de testes no ambiente certo.
// Sem isto, "pytest -q" é executado pelo shell e pega o pytest do PATH global — que pode não existir
// (ModuleNotFoundError) ou ser de outro ambiente. Rodar "<venv>/python -m pytest" elimina o problema.
import * as path from "node:path";

export type PrepareOnRunPolicy = "ask" | "always" | "never";
export type PythonRunPreflightAction = "none" | "ask" | "prepare";

// Decide se um Run precisa preparar o ambiente. O pre-flight automatico e conservador:
// so arquivos Python/notebooks com requirements.txt entram; Poetry/uv/Conda e projetos sem manifesto
// seguem seus fluxos proprios em vez de serem silenciosamente convertidos para pip + .venv.
export function pythonRunPreflightAction(input: {
  filePath: string;
  hasProjectVenv: boolean;
  hasRequirements: boolean;
  policy: PrepareOnRunPolicy;
}): PythonRunPreflightAction {
  const ext = path.extname(input.filePath).toLowerCase();
  if (
    (ext !== ".py" && ext !== ".pyw" && ext !== ".ipynb") ||
    input.hasProjectVenv ||
    !input.hasRequirements ||
    input.policy === "never"
  ) {
    return "none";
  }
  return input.policy === "always" ? "prepare" : "ask";
}

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

// Raiz e comando de ativacao de um venv a partir do interpretador encontrado. A escolha considera o
// shell, nao apenas o SO: Windows pode estar em PowerShell, cmd ou Git Bash; PowerShell tambem existe
// em macOS/Linux. O caminho e sempre citado para suportar workspaces com espacos.
export function venvRootFromPython(venvPython: string): string {
  return path.dirname(path.dirname(venvPython));
}

export function buildVenvActivationCommand(input: {
  venvPython: string;
  shellPath: string;
  isWindows: boolean;
}): string {
  const root = venvRootFromPython(input.venvPython);
  const shell = path.basename(input.shellPath).toLowerCase();
  const q = (p: string) => `"${p.replace(/"/g, '\\"')}"`;
  const forPosixShell = (p: string): string => {
    if (!input.isWindows) return p;
    const normalized = p.replace(/\\/g, "/");
    const drive = normalized.match(/^([A-Za-z]):\/(.*)$/);
    return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : normalized;
  };

  if (shell.includes("powershell") || shell === "pwsh" || shell === "pwsh.exe") {
    const script = path.join(root, input.isWindows ? "Scripts" : "bin", "Activate.ps1");
    return `& ${q(script)}`;
  }
  if (input.isWindows && (shell === "cmd" || shell === "cmd.exe")) {
    return q(path.join(root, "Scripts", "activate.bat"));
  }
  if (shell.includes("fish")) {
    return `source ${q(forPosixShell(path.join(root, input.isWindows ? "Scripts" : "bin", "activate.fish")))}`;
  }
  if (shell.includes("csh") || shell.includes("tcsh")) {
    return `source ${q(forPosixShell(path.join(root, input.isWindows ? "Scripts" : "bin", "activate.csh")))}`;
  }
  // bash/zsh/sh e Git Bash no Windows entendem source; o venv do Windows traz Scripts/activate.
  return `source ${q(forPosixShell(path.join(root, input.isWindows ? "Scripts" : "bin", "activate")))}`;
}

export function buildPythonDiagnosticsCommand(venvPython: string): string {
  const q = (p: string) => (/\s/.test(p) ? `"${p}"` : p);
  const py = q(venvPython);
  const probe = [
    "import os, platform, site, sys",
    'print("Python:", sys.version.replace("\\n", " "))',
    'print("Executavel:", sys.executable)',
    'print("VIRTUAL_ENV:", os.environ.get("VIRTUAL_ENV") or "(nao exportado; interpretador direto)")',
    'print("Plataforma:", platform.platform())',
    'print("Site-packages:", ", ".join(site.getsitepackages()))',
  ].join("\n");
  // Base64 evita a divergencia de quoting entre cmd.exe e shells POSIX no `python -c`.
  const encoded = Buffer.from(probe, "utf8").toString("base64");
  return `${py} -c "import base64;exec(base64.b64decode('${encoded}'))" && ${py} -m pip --version && ${py} -m pip check`;
}

export function buildIpykernelProbe(venvPython: string): string {
  const interp = /\s/.test(venvPython) ? `"${venvPython}"` : venvPython;
  return `${interp} -c "import ipykernel; print(ipykernel.__version__)"`;
}

export function buildIpykernelInstall(venvPython: string): string {
  const interp = /\s/.test(venvPython) ? `"${venvPython}"` : venvPython;
  return `${interp} -m pip install ipykernel`;
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

// Reescreve o comando do "Executar" para usar o interpretador do VENV quando o comando começa com
// `python`/`python3` NU (sem caminho). Sem isto o Executar roda o python do PATH e toma
// ModuleNotFoundError mesmo com o ambiente preparado (raiz do print do dev). Um interpretador com
// caminho (ex.: /usr/bin/python3) ou outro executável é respeitado como está.
export function resolvePythonRunCommand(command: string, venvPython: string | undefined): string {
  const cmd = command.trim();
  if (!venvPython) return cmd;
  // (?=\s|$): o nome tem que TERMINAR ali — `python3.11`/`python-config` (interpretador versionado/
  // suffixado escolhido pelo admin) passam intactos; `\b` sozinho os corromperia (`<venv>.11`).
  const m = cmd.match(/^python3?(?=\s|$)(.*)$/i);
  if (!m) return cmd;
  const q = /\s/.test(venvPython) ? `"${venvPython}"` : venvPython;
  return `${q}${m[1]}`;
}

// O comando de teste é da família pytest? (pytest nu ou python -m pytest — os casos que o pré-flight
// de instalação sabe curar; wrappers poetry/uv gerenciam o próprio ambiente e ficam de fora.)
export function isPytestCommand(command: string): boolean {
  return /^pytest\b/i.test(command.trim()) || /^python3?\s+-m\s+pytest\b/i.test(command.trim());
}

// Escolha do comando de teste ciente da STACK: um override explícito do admin SEMPRE vence; com o
// default intocado ("pytest -q") num projeto Node (vitest/jest detectados) E um script `test` REAL
// no package.json, usa `npm test` — sem o script, `npm test` falharia com "Missing script" e o
// cartão viraria um falso "testes falharam" (confirmado em revisão adversarial).
export function chooseTestCommand(
  configured: string,
  defaultCommand: string,
  stackTests: string | undefined,
  hasNpmTestScript: boolean
): string {
  if (configured.trim() !== defaultCommand.trim()) return configured;
  if ((stackTests === "vitest" || stackTests === "jest") && hasNpmTestScript) return "npm test";
  return configured;
}

// Pré-flight: comando que testa se o pytest EXISTE no ambiente onde os testes VÃO RODAR. Com venv,
// proba o interpretador do venv (`<venv> -m pytest`); SEM venv, proba `pytest --version` — o mesmo
// binário do PATH que resolveTestCommand executará (probar `python -m pytest` divergiria: pytest
// via pipx/scoop funciona no shell sem ser módulo do python do PATH — falso "ausente" confirmado).
export function buildPytestProbe(venvPython: string | undefined): string {
  if (!venvPython) return "pytest --version";
  const interp = /\s/.test(venvPython) ? `"${venvPython}"` : venvPython;
  return `${interp} -m pytest --version`;
}

// Instalação do pytest num venv EXISTENTE (nunca global). O caso sem venv não passa por aqui:
// o Controller cria o ambiente completo (venv + dependências do projeto) via prepareEnv antes —
// um .venv contendo SÓ pytest rodaria a suíte num interpretador pelado (ModuleNotFoundError geral).
export function buildPytestInstall(venvPython: string): string {
  const interp = /\s/.test(venvPython) ? `"${venvPython}"` : venvPython;
  return `${interp} -m pip install pytest`;
}

// Instalação do mypy num venv EXISTENTE (nunca global). O gate workspace-wide do Modo Projeto usa mypy
// para pegar o DRIFT de contrato cross-file (import/atributo fantasma) que o compileall — só sintaxe —
// não vê. Sem mypy no venv o gate fica "parcial" e NÃO bloqueia; instalá-lo é o que faz o gate morder.
// Best-effort: se falhar (offline/sem índice pip), a degradação segura do gate ("parcial") é preservada.
export function buildMypyInstall(venvPython: string): string {
  const interp = /\s/.test(venvPython) ? `"${venvPython}"` : venvPython;
  return `${interp} -m pip install mypy`;
}

// Instalação do bandit (SAST) num venv EXISTENTE (nunca global). O gate de segurança do Modo Projeto usa o
// bandit para pegar vulnerabilidades por AST (senha hardcoded, eval, cripto fraca) que compileall/mypy não
// veem. Sem bandit no venv o gate de segurança fica consultivo (não bloqueia). Best-effort, como o mypy:
// se falhar (offline/sem índice pip), a degradação segura (segurança consultiva) é preservada.
export function buildBanditInstall(venvPython: string): string {
  const interp = /\s/.test(venvPython) ? `"${venvPython}"` : venvPython;
  return `${interp} -m pip install bandit`;
}

// Instalação do ruff num venv EXISTENTE (nunca global). O gate de IMPORTS MORTOS (F-18) do Modo Projeto usa
// o ruff (regra F401) para listar imports não usados no Python gerado. SEMPRE advisory — sem ruff no venv o
// gate de imports mortos fica consultivo (não bloqueia). Best-effort, como o mypy/bandit: falhar (offline)
// preserva a degradação segura.
export function buildRuffInstall(venvPython: string): string {
  const interp = /\s/.test(venvPython) ? `"${venvPython}"` : venvPython;
  return `${interp} -m pip install ruff`;
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
