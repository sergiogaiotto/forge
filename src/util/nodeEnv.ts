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
