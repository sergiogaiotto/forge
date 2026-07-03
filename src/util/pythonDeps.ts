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

// Remove o conteúdo DENTRO de strings triplas ("""…"""/'''…''') das linhas de um fonte — docstrings
// trazem "import x" ilustrativo que NÃO é código (falso positivo confirmado em revisão adversarial).
// Rastreio simples de abre/fecha por linha; o que sobra fora das triplas é preservado na posição.
function stripTripleStrings(src: string): string[] {
  const out: string[] = [];
  let open: '"""' | "'''" | null = null;
  for (const line of src.split("\n")) {
    let result = "";
    let i = 0;
    while (i < line.length) {
      if (open) {
        const close = line.indexOf(open, i);
        if (close < 0) {
          i = line.length;
          break;
        }
        i = close + 3;
        open = null;
      } else {
        const dq = line.indexOf('"""', i);
        const sq = line.indexOf("'''", i);
        const idx = dq < 0 ? sq : sq < 0 ? dq : Math.min(dq, sq);
        if (idx < 0) {
          result += line.slice(i);
          break;
        }
        result += line.slice(i, idx);
        open = idx === dq ? '"""' : "'''";
        i = idx + 3;
      }
    }
    out.push(result);
  }
  return out;
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
    for (const line of stripTripleStrings(src)) {
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
