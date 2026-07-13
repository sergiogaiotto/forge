// Resolução do ferramental TypeScript para o gate do Modo Projeto (P4) — análogo ao pythonEnv (venv/mypy).
// Puro/testável: o I/O (existsSync, spawn) fica no Controller; aqui só caminhos e comandos.

// tsc do WORKSPACE via o entrypoint JS (node_modules/typescript/lib/tsc.js). Rodamos `node <tsc.js>` em vez
// do wrapper .bin/tsc(.cmd) porque o execFile (sem shell) não invoca um .cmd de forma confiável no Windows —
// `node` é um .exe resolvido pelo PATH. Vazio = o workspace não tem typescript instalado (gate consultivo).
export function findWorkspaceTscJs(workspaceRoot: string | undefined, exists: (p: string) => boolean): string | undefined {
  if (!workspaceRoot) return undefined;
  const p = workspaceRoot.replace(/[\\/]+$/, "") + "/node_modules/typescript/lib/tsc.js";
  return exists(p) ? p : undefined;
}

// Instala o typescript como devDependency no workspace (best-effort, como o mypy no venv). Não usado por
// padrão (não poluímos o projeto do dev sem pedir); reservado para uma futura opção de auto-instalar.
export function buildTscInstall(pkgManager = "npm"): string {
  return `${pkgManager} install --save-dev typescript`;
}

// ---- Smoke test TS (P4): resolução do RUNNER de teste da suíte GERADA -----------------------------------
export type NodeTestRunner = "vitest" | "jest";

// Detecta o runner que o projeto GERADO usa, a partir do package.json (deps/scripts) e, como fallback, dos
// imports das suítes. vitest ganha do jest quando ambos aparecem (mais moderno, sem transform frágil). PURO.
// Sem sinal → undefined (o smoke degrada para advisory: "nenhum runner suportado"). O jest com TS depende de
// ts-jest no workspace — notoriamente frágil por versão; o classificador trata isso como AMBIENTE, não falha.
export function detectNodeTestRunner(pkgJson: string | undefined, testFileContents: string[]): NodeTestRunner | undefined {
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; scripts?: Record<string, unknown> };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if ("vitest" in deps) return "vitest";
      if ("jest" in deps) return "jest";
      const testScript = String(pkg.scripts?.test ?? "");
      if (/\bvitest\b/.test(testScript)) return "vitest";
      if (/\bjest\b/.test(testScript)) return "jest";
    } catch {
      /* package.json inválido → cai para os imports das suítes */
    }
  }
  const joined = testFileContents.join("\n");
  // Casa `import … from 'vitest'`, `import 'vitest'` (side-effect) e `require('vitest')`.
  if (/(?:from|import)\s*['"]vitest['"]|require\(\s*['"]vitest['"]/.test(joined)) return "vitest";
  if (/(?:from|import)\s*['"]@jest\/globals['"]|require\(\s*['"]@jest\/globals['"]/.test(joined)) return "jest";
  return undefined;
}

// Resolve o entrypoint JS do runner no node_modules do WORKSPACE, rodado via `node <entry>` (NUNCA o
// wrapper .bin/*.cmd — o execFile sem shell não invoca .cmd de forma confiável no Windows; `node` é um .exe
// do PATH — a MESMA armadilha do gate TS). Vazio = o runner não está instalado no workspace (smoke advisory).
export function findWorkspaceTestRunner(
  workspaceRoot: string | undefined,
  runner: NodeTestRunner,
  exists: (p: string) => boolean
): { entry: string; args: string[] } | undefined {
  if (!workspaceRoot) return undefined;
  const nm = workspaceRoot.replace(/[\\/]+$/, "") + "/node_modules";
  if (runner === "vitest") {
    const entry = nm + "/vitest/vitest.mjs";
    return exists(entry) ? { entry, args: ["run", "--no-color"] } : undefined;
  }
  const entry = nm + "/jest/bin/jest.js";
  return exists(entry) ? { entry, args: ["--ci", "--colors=false"] } : undefined;
}

// tsconfig MÍNIMO materializado na árvore temp para o `tsc --noEmit`: checa sintaxe + contrato interno, mas
// TOLERANTE a deps ausentes (sem node_modules no temp). strict:false e skipLibCheck reduzem falso-positivo;
// moduleResolution:node resolve os imports RELATIVOS do próprio projeto; noEmit não escreve nada.
export function buildGateTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        noEmit: true,
        skipLibCheck: true,
        moduleResolution: "node",
        module: "ESNext",
        target: "ES2020",
        strict: false,
        noImplicitAny: false,
        esModuleInterop: true,
        allowJs: false,
        jsx: "react-jsx",
        resolveJsonModule: true,
        forceConsistentCasingInFileNames: false,
      },
      include: ["**/*.ts", "**/*.tsx"],
    },
    null,
    2
  );
}
