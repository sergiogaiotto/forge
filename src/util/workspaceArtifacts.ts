const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

const ENV_PATTERNS = [
  /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g,
  /\bprocess\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
  /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)\b/g,
  /\bos\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /\bos\.environ(?:\.get\(\s*|\[\s*)["']([A-Z][A-Z0-9_]*)["']/g,
  /\bSystem\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /\bEnvironment\.GetEnvironmentVariable\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /\bstd::env::var\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /\bENV\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
  /\bgetenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /\$\{([A-Z][A-Z0-9_]*)(?::[-?][^}]*)?\}/g,
];

export function extractEnvVariableNames(sources: readonly string[]): string[] {
  const names = new Set<string>();
  for (const source of sources) {
    for (const pattern of ENV_PATTERNS) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
        if (ENV_NAME.test(match[1])) names.add(match[1]);
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function eolOf(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

export function mergeEnvExample(existing: string | undefined, names: readonly string[]): {
  content: string;
  added: string[];
} {
  const cleanNames = [...new Set(names.filter((name) => ENV_NAME.test(name)))].sort((a, b) => a.localeCompare(b));
  const current = existing ?? "";
  const present = new Set(
    current
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/)?.[1])
      .filter((name): name is string => !!name)
  );
  const added = cleanNames.filter((name) => !present.has(name));
  if (existing !== undefined && added.length === 0) return { content: existing, added };

  const eol = eolOf(current);
  const header = "# Variaveis detectadas no codigo. Preencha localmente; nunca versionar segredos.";
  const block = added.map((name) => `${name}=`).join(eol);
  if (!current.trim()) return { content: `${header}${eol}${block}${block ? eol : ""}`, added };
  const separator = current.endsWith("\n") || current.endsWith("\r") ? "" : eol;
  return { content: `${current}${separator}${block}${block ? eol : ""}`, added };
}

export interface GitignoreStack {
  python?: boolean;
  node?: boolean;
  java?: boolean;
  dotnet?: boolean;
}

export function recommendedGitignoreEntries(stack: GitignoreStack): string[] {
  const entries = [
    "# Secrets and local configuration",
    ".env",
    ".env.*",
    "!.env.example",
    "",
    "# Operating system",
    ".DS_Store",
    "Thumbs.db",
  ];
  if (stack.python) {
    entries.push(
      "",
      "# Python",
      ".venv/",
      "venv/",
      "__pycache__/",
      "*.py[cod]",
      ".pytest_cache/",
      ".mypy_cache/",
      ".ruff_cache/",
      ".coverage",
      "htmlcov/"
    );
  }
  if (stack.node) {
    entries.push("", "# Node", "node_modules/", "dist/", "coverage/", ".vite/");
  }
  if (stack.java) {
    entries.push("", "# Java", ".gradle/", "target/", "build/", "*.class");
  }
  if (stack.dotnet) {
    entries.push("", "# .NET", "bin/", "obj/");
  }
  return entries;
}

function comparableGitignoreLine(line: string): string {
  return line.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function mergeGitignore(existing: string | undefined, recommended: readonly string[]): {
  content: string;
  added: string[];
} {
  const current = existing ?? "";
  const present = new Set(
    current
      .split(/\r?\n/)
      .map(comparableGitignoreLine)
      .filter((line) => line && !line.startsWith("#"))
  );
  const added = recommended.filter((line) => {
    const comparable = comparableGitignoreLine(line);
    return comparable && !comparable.startsWith("#") && !present.has(comparable);
  });
  if (existing !== undefined && added.length === 0) return { content: existing, added };

  const eol = eolOf(current);
  // Arquivo novo recebe as secoes organizadas. Num arquivo existente, acrescenta apenas os padroes
  // ausentes sob um cabecalho unico; assim nao duplica "# Python"/"# Node" sem conteudo.
  const blockLines = existing === undefined || !current.trim() ? [...recommended] : ["# Added by FORGE", ...added];
  while (blockLines[0] === "") blockLines.shift();
  while (blockLines.at(-1) === "") blockLines.pop();
  const block = blockLines.join(eol);
  if (!current.trim()) return { content: `${block}${eol}`, added };
  const separator = current.endsWith("\n") || current.endsWith("\r") ? eol : `${eol}${eol}`;
  return { content: `${current}${separator}${block}${eol}`, added };
}
