// Detecção de dependências Python a partir do CÓDIGO (sem manifesto): varre os imports dos .py,
// filtra a stdlib e os módulos locais do próprio projeto, e mapeia import → pacote PyPI (a tabela
// cobre os casos em que o nome difere: sklearn→scikit-learn, cv2→opencv-python…). Alimenta o
// "Preparar ambiente" quando não há requirements.txt/pyproject — e o INCREMENTO quando há.
// Funções puras (I/O fica no Controller) — testáveis sem VS Code.

// Módulos top-level da stdlib do Python 3 (sys.stdlib_module_names, os relevantes p/ import scan).
// Um import daqui NUNCA vira pacote pip — a omissão de um módulo raro custaria um `pip install`
// inútil (falha visível no cartão), então a lista é ampla de propósito.
const STDLIB = new Set([
  "abc", "aifc", "argparse", "array", "ast", "asyncio", "atexit", "audioop", "base64", "bdb", "binascii",
  "bisect", "builtins", "bz2", "calendar", "cgi", "cgitb", "chunk", "cmath", "cmd", "code", "codecs",
  "codeop", "collections", "colorsys", "compileall", "concurrent", "configparser", "contextlib",
  "contextvars", "copy", "copyreg", "cProfile", "crypt", "csv", "ctypes", "curses", "dataclasses",
  "datetime", "dbm", "decimal", "difflib", "dis", "doctest", "email", "encodings", "ensurepip", "enum",
  "errno", "faulthandler", "fcntl", "filecmp", "fileinput", "fnmatch", "fractions", "ftplib", "functools",
  "gc", "getopt", "getpass", "gettext", "glob", "graphlib", "grp", "gzip", "hashlib", "heapq", "hmac",
  "html", "http", "idlelib", "imaplib", "imghdr", "imp", "importlib", "inspect", "io", "ipaddress",
  "itertools", "json", "keyword", "linecache", "locale", "logging", "lzma", "mailbox", "mailcap",
  "marshal", "math", "mimetypes", "mmap", "modulefinder", "msilib", "msvcrt", "multiprocessing",
  "netrc", "nis", "nntplib", "ntpath", "numbers", "operator", "optparse", "os", "ossaudiodev",
  "pathlib", "pdb", "pickle", "pickletools", "pipes", "pkgutil", "platform", "plistlib", "poplib",
  "posix", "posixpath", "pprint", "profile", "pstats", "pty", "pwd", "py_compile", "pyclbr", "pydoc",
  "queue", "quopri", "random", "re", "readline", "reprlib", "resource", "rlcompleter", "runpy", "sched",
  "secrets", "select", "selectors", "shelve", "shlex", "shutil", "signal", "site", "smtplib", "sndhdr",
  "socket", "socketserver", "spwd", "sqlite3", "ssl", "stat", "statistics", "string", "stringprep",
  "struct", "subprocess", "sunau", "symtable", "sys", "sysconfig", "syslog", "tabnanny", "tarfile",
  "telnetlib", "tempfile", "termios", "test", "textwrap", "threading", "time", "timeit", "tkinter",
  "token", "tokenize", "tomllib", "trace", "traceback", "tracemalloc", "tty", "turtle", "turtledemo",
  "types", "typing", "unicodedata", "unittest", "urllib", "uu", "uuid", "venv", "warnings", "wave",
  "weakref", "webbrowser", "winreg", "winsound", "wsgiref", "xdrlib", "xml", "xmlrpc", "zipapp",
  "zipfile", "zipimport", "zlib", "zoneinfo", "__future__", "_thread",
  // stdlib removida em 3.12/3.13 mas comum em código legado — `pip install distutils` FALHA
  // (sem distribuição instalável) e derrubaria o preparo inteiro (comando encadeado com &&).
  "distutils", "lib2to3", "asyncore", "asynchat", "smtpd",
]);

// Imports que NUNCA viram pacote pip mesmo não sendo stdlib: namespaces cujo pacote real depende do
// submódulo/serviço (google.cloud.storage → google-cloud-storage etc.) — melhor não emitir nada do
// que instalar o pacote errado silenciosamente (confirmado: "google" no PyPI ≠ google.cloud).
const SKIP_IMPORTS = new Set(["google", "google.cloud", "google.colab"]);

// import → nome do pacote no PyPI quando DIFEREM. Fallback: o próprio nome do import.
const PYPI_BY_IMPORT: Record<string, string> = {
  sklearn: "scikit-learn",
  cv2: "opencv-python",
  PIL: "Pillow",
  yaml: "PyYAML",
  bs4: "beautifulsoup4",
  dotenv: "python-dotenv",
  fitz: "PyMuPDF",
  Crypto: "pycryptodome",
  dateutil: "python-dateutil",
  jwt: "PyJWT",
  psycopg2: "psycopg2-binary",
  win32com: "pywin32",
  win32api: "pywin32",
  pptx: "python-pptx",
  docx: "python-docx",
  magic: "python-magic",
  serial: "pyserial",
  usb: "pyusb",
  OpenSSL: "pyOpenSSL",
  cairosvg: "CairoSVG",
  kafka: "kafka-python",
  MySQLdb: "mysqlclient",
  attr: "attrs",
  githubkit: "githubkit",
  jose: "python-jose",
  socks: "PySocks",
  websocket: "websocket-client",
  zmq: "pyzmq",
  Levenshtein: "python-Levenshtein",
  snowflake: "snowflake-connector-python",
  airflow: "apache-airflow",
  pyspark: "pyspark",
  // Namespace google.* preservado em 2 segmentos pelo scanner (o topo sozinho não identifica o pacote).
  "google.protobuf": "protobuf",
  "google.generativeai": "google-generativeai",
};

// Remove o CONTEÚDO de literais de string (aspas TRIPLAS """…""" / '''…''' E de UMA linha "…" / '…', com
// escape), preservando a estrutura de linhas e o código FORA das strings. Sem isso, um `import x` /
// `from x import y` DENTRO de uma string — mensagem de erro, texto de ajuda, exemplo em prosa, docstring —
// seria lido como import de verdade. Isso alimenta a reconciliação de dependências (P4), que MERGEIA o
// resultado num requirements.txt legítimo — logo um `x = "…; from tensorflow import k"` injetaria o pacote
// ERRADO. Escapes (\") não fecham a string; strings de uma linha não cruzam \n (salvo continuação `\`).
// Achado da revisão adversarial (vetores `from`-em-string e `import … #`-em-string).
function stripStringLiterals(src: string): string[] {
  const s = src ?? "";
  const lines: string[] = [];
  let cur = "";
  let quote: string | null = null; // delimitador aberto: '"', "'", '"""' ou "'''"
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") {
        // Escape: NÃO fecha a string; pula o próximo char. Preserva a quebra numa continuação de linha.
        if (s[i + 1] === "\n") {
          lines.push(cur);
          cur = "";
        }
        i += 2;
        continue;
      }
      if (s.startsWith(quote, i)) {
        i += quote.length;
        quote = null;
        continue;
      }
      if (ch === "\n") {
        lines.push(cur); // conteúdo da string descartado, mas a quebra (triplas) é preservada
        cur = "";
      }
      i += 1;
      continue;
    }
    if (ch === "#") {
      // Comentário Python: o resto da linha não é código nem abre string. Pula até o \n (deixado para o ramo
      // abaixo fechar a linha). SEM isto, uma aspa ímpar num comentário (`# don't forget`, `# it's fine`)
      // abriria uma string-fantasma que engoliria todos os imports seguintes — requirements incompleto
      // (regressão pega na revisão). Um `#` DENTRO de uma string já foi tratado no ramo `quote` acima.
      const nl = s.indexOf("\n", i);
      if (nl < 0) break; // comentário até o fim do arquivo
      i = nl; // preserva o \n para o ramo de quebra de linha abaixo
      continue;
    }
    if (ch === "\\" && (s[i + 1] === "\n" || (s[i + 1] === "\r" && s[i + 2] === "\n"))) {
      // Continuação de linha explícita em CÓDIGO (`\` no fim da linha): junta as linhas físicas num só
      // statement lógico — NÃO emite quebra. SEM isto, `import a, \\<nl> b` seria lido como duas linhas e os
      // módulos continuados (`b`) sumiriam do scan (sub-detecção → requirements incompleto). Achado da revisão.
      i += s[i + 1] === "\r" ? 3 : 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = s.startsWith(ch + ch + ch, i) ? ch + ch + ch : ch;
      i += quote.length;
      continue;
    }
    if (ch === "\n") {
      lines.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  lines.push(cur);
  return lines;
}

// Extrai os módulos TOP-LEVEL importados de fontes Python. Cobre `import a`, `import a.b as c`,
// `import a, b`, `from a.b import x`, statements separados por `;`; ignora imports RELATIVOS
// (`from . import x`) — sempre locais — e o conteúdo de docstrings/strings triplas. O namespace
// `google.*` é preservado em DOIS segmentos (o topo sozinho não identifica o pacote PyPI).
// Dedup preservando a ordem de primeira aparição.
export function scanPythonImports(sources: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (name: string) => {
    const parts = name.trim().split(".");
    const key = parts[0] === "google" && parts.length > 1 ? `google.${parts[1]}` : parts[0];
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  };
  for (const src of sources) {
    for (const line of stripStringLiterals(src)) {
      // `import os; import requests` — cada statement é avaliado separadamente.
      for (const stmt of line.split(";")) {
        const im = stmt.match(/^\s*import\s+([A-Za-z_][\w.]*(?:\s+as\s+\w+)?(?:\s*,\s*[A-Za-z_][\w.]*(?:\s+as\s+\w+)?)*)\s*(?:#.*)?$/);
        if (im) {
          for (const part of im[1].split(",")) add(part.replace(/\s+as\s+\w+\s*$/, ""));
          continue;
        }
        const from = stmt.match(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/);
        if (from) add(from[1]); // `from .x import y` não casa ([A-Za-z_] exige não-relativo)
      }
    }
  }
  return out;
}

// Converte imports em pacotes pip: remove stdlib, módulos LOCAIS do projeto (arquivos/pacotes do
// próprio workspace) e namespaces ambíguos (SKIP_IMPORTS), aplica a tabela PyPI e deduplica
// (case-insensitive). Imports dotted (google.x) sem mapeamento explícito são DESCARTADOS —
// nome dotted nunca é nome de pacote pip válido.
export function mapImportsToPackages(imports: string[], localModules: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const im of imports) {
    if (STDLIB.has(im) || localModules.has(im) || SKIP_IMPORTS.has(im)) continue;
    const mapped = PYPI_BY_IMPORT[im];
    if (!mapped && im.includes(".")) continue;
    const pkg = mapped ?? im;
    const key = pkg.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(pkg);
    }
  }
  return out;
}

// Nomes de pacote já declarados num requirements.txt, NORMALIZADOS (minúsculas, `-`≡`_`, sem extras
// `pkg[x]`, sem pins `==1.2`, sem comentários/opções `-r`/`--index-url`) — para comparação robusta.
export function parseRequirementNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    // Requisito por URL direta ou VCS (git+https://…): o nome confiável vem do fragmento #egg=;
    // sem ele, ignora a linha — extrair "git"/"https" como nome quebraria a idempotência do merge.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(line) || /^(git|hg|svn|bzr)\+/i.test(line)) {
      const egg = line.match(/#egg=([A-Za-z0-9][A-Za-z0-9._-]*)/i);
      if (egg) names.add(normalizePkg(egg[1]));
      continue;
    }
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (m) names.add(normalizePkg(m[1]));
  }
  return names;
}

function normalizePkg(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

// Especificadores de dependência JÁ FIXADOS num requirements.txt (linha por linha, sem comentários,
// sem opções `-r`/`--index-url`, sem in-line comment `pkg==1.2  # nota`), preservando o pin exato
// (`fastapi==0.110.0`). Alimenta o prompt do Modo Projeto: dar ao modelo as versões REAIS do workspace
// evita que ele alucine outra lib/versão para o mesmo fim (drift de dependência do print). Cap por
// orçamento — um requirements gigante não deve inchar o prompt. Puro/testável.
export function parsePinnedRequirements(content: string, max = 40): string[] {
  const out: string[] = [];
  for (const raw of (content ?? "").split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    // Remove comentário in-line (` # …`) preservando um `#` colado ao token (raro em specs).
    const hash = line.indexOf(" #");
    if (hash !== -1) line = line.slice(0, hash).trim();
    if (line) out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

// Acrescenta ao requirements.txt os pacotes AUSENTES (uma linha por pacote, sem pin — o pip resolve a
// versão), preservando TODO o conteúdo existente (pins, comentários, ordem). Idempotente: pacotes já
// declarados (mesmo com pin/extra/caixa diferente) não são re-adicionados.
export function mergeRequirements(existing: string, packages: string[]): { content: string; added: string[] } {
  const declared = parseRequirementNames(existing);
  const added = packages.filter((p) => !declared.has(normalizePkg(p)));
  if (added.length === 0) return { content: existing, added };
  const base = existing.length > 0 && !existing.endsWith("\n") ? existing + "\n" : existing;
  return { content: base + added.join("\n") + "\n", added };
}

// Gera um requirements.txt do zero a partir dos pacotes detectados (cabeçalho explica a origem).
export function renderRequirements(packages: string[]): string {
  return ["# Gerado pelo FORGE a partir dos imports do código — revise e ajuste pins se necessário.", ...packages].join("\n") + "\n";
}

// RECONCILIAÇÃO pré-entrega (P4): confere se o requirements.txt GERADO declara os pacotes que o código
// gerado de fato IMPORTA. O DoD (P2) garante que o manifesto EXISTE; esta função garante que está CORRETO —
// o gap que faz "instala e roda" falhar (o modelo importa fastapi mas esquece de listar). Devolve o
// manifesto ACRESCIDO dos ausentes (via mergeRequirements: idempotente, preserva pins/comentários). PURO.
//   `pyFiles`: os .py gerados (path + content) — o CONTENT alimenta o scan de imports.
//   `projectPaths`: TODOS os caminhos do projeto (propostas + já aplicados) — usados SÓ para montar o
//     conjunto de módulos LOCAIS (basename dos .py + segmentos de diretório), para NÃO tratar um módulo do
//     próprio projeto como pacote pip (ex.: `from adapters import x` num layout src/ — "adapters" existe no
//     PyPI e viraria um install errado). Só paths, sem I/O — cobre também os arquivos de rodadas anteriores.
//   `manifestContent`: o conteúdo do requirements.txt gerado.
// Herda o conservadorismo de mapImportsToPackages: descarta stdlib, locais, namespaces ambíguos e dotted
// sem mapeamento — nunca adiciona um pacote "adivinhado". Pior caso: um `pip install` extra visível.
export function reconcileRequirements(
  pyFiles: { path: string; content: string }[],
  projectPaths: string[],
  manifestContent: string
): { content: string; added: string[] } {
  const local = new Set<string>();
  for (const raw of projectPaths) {
    const segs = (raw ?? "").replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter(Boolean);
    if (!segs.length) continue;
    const base = segs[segs.length - 1];
    if (/\.py$/i.test(base)) local.add(base.replace(/\.py$/i, "")); // nome do módulo (order.py → order)
    for (const seg of segs.slice(0, -1)) local.add(seg); // diretórios são pacotes locais (src/adapters/…)
  }
  const detected = mapImportsToPackages(scanPythonImports(pyFiles.map((f) => (f.content ?? "").slice(0, 16_000))), local);
  return mergeRequirements(manifestContent, detected);
}
