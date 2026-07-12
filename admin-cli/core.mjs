// FORGE admin — núcleo compartilhado (RF-016/017, ADR-2).
// Lógica pura de keygen/issue/revoke SEM I/O de descoberta de caminho: os entries
// (forge-admin.mjs no repo, forge-keygen.mjs no .exe standalone) injetam os paths.
// A CRIPTOGRAFIA aqui é byte-idêntica à do CLI original — licenças emitidas pelo
// .exe validam exatamente como as emitidas por `npm run license:issue`.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { buildManifest, verifyManifest } from "./integrity.mjs";

export const VERSION = "1.0.0";

export const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Parser de flags no estilo `--chave valor` (idêntico ao original).
 * `--flag` sem valor vira "true". Preserva a semântica existente.
 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      // Um token iniciado por "-" (curto ou longo) é sempre uma flag, nunca o valor —
      // assim `--force -v` mantém --force booleana e processa -v (nossos valores não começam com "-").
      const val = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : "true";
      out[key] = val;
    } else if (argv[i] === "-h") {
      out.help = "true";
    } else if (argv[i] === "-v") {
      out.version = "true";
    }
  }
  return out;
}

export function rawPublicKeyB64(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64");
}

/**
 * Resolve o keys-dir efetivo: `--keys-dir <dir>` (relativo ao cwd) sobrepõe o default do entry.
 * Guarda `!== "true"` (como todos os outros valores) para que `--keys-dir` SEM valor não vire
 * um diretório literal "true" — o que gravaria a chave privada num lugar inesperado.
 */
export function resolveKeysDir(args, defaultKeysDir) {
  return args["keys-dir"] && args["keys-dir"] !== "true"
    ? path.resolve(String(args["keys-dir"]))
    : defaultKeysDir;
}

const EMBEDDED_HEADER =
  "// GERADO AUTOMATICAMENTE pelo FORGE admin (keygen).\n" +
  "// Contém APENAS a chave PÚBLICA Ed25519 — seguro distribuir no cliente.\n" +
  "// A chave privada nunca sai da máquina do admin (ADR-2).\n";

function renderEmbedded(pubB64, keyId) {
  return (
    EMBEDDED_HEADER +
    `export const EMBEDDED_PUBLIC_KEY_B64 = ${JSON.stringify(pubB64)};\n` +
    `export const EMBEDDED_KEY_ID = ${JSON.stringify(keyId)};\n`
  );
}

/**
 * Gera o par Ed25519. Escreve private.pem (0600) e keyinfo.json no keysDir e emite o
 * embeddedKey.ts. `defaultEmbeddedTarget` = caminho do repo quando existe (modo dev) ou
 * null (standalone → grava embeddedKey.ts ao lado das chaves). `--emit-embedded` sobrepõe.
 *
 * SEGURANÇA: recusa sobrescrever uma chave privada existente sem `--force` — a chave privada
 * é irrecuperável e sobrescrevê-la invalida TODAS as licenças já emitidas.
 */
export function keygen({ args, keysDir, defaultEmbeddedTarget, io }) {
  const keyId = args["key-id"] && args["key-id"] !== "true" ? String(args["key-id"]) : `ed25519-${new Date().getFullYear()}-01`;
  const privPath = path.join(keysDir, "private.pem");

  if (fs.existsSync(privPath) && args.force !== "true") {
    io.err(`✗ Já existe uma chave privada em ${privPath}.`);
    io.err("  Sobrescrever INVALIDA todas as licenças emitidas e é IRREVERSÍVEL (a chave não é versionada).");
    io.err("  Se tem certeza (rotação de chave), rode de novo com --force.");
    return 3;
  }

  fs.mkdirSync(keysDir, { recursive: true });
  hardenDir(keysDir, io);

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const pubB64 = rawPublicKeyB64(publicKey);

  fs.writeFileSync(privPath, privPem, { mode: 0o600 });
  hardenFile(privPath, io); // reendurece a chave também na rotação (--force) e aplica ACL no Windows
  fs.writeFileSync(path.join(keysDir, "keyinfo.json"), JSON.stringify({ keyId, publicKeyB64: pubB64 }, null, 2));

  // Onde gravar o embeddedKey.ts do cliente:
  //  1) --emit-embedded <path>  (explícito)
  //  2) caminho do repo — SOMENTE quando as chaves estão no local padrão (sem --keys-dir),
  //     para nunca clobberar o embeddedKey.ts do cliente ao gerar chaves de teste em outra pasta
  //  3) ao lado das chaves (standalone, ou quando --keys-dir foi informado)
  let embeddedTarget;
  if (args["emit-embedded"] && args["emit-embedded"] !== "true") {
    embeddedTarget = path.resolve(String(args["emit-embedded"]));
  } else if (!args["keys-dir"] && defaultEmbeddedTarget && fs.existsSync(path.dirname(defaultEmbeddedTarget))) {
    embeddedTarget = defaultEmbeddedTarget;
  } else {
    embeddedTarget = path.join(keysDir, "embeddedKey.ts");
  }
  fs.mkdirSync(path.dirname(embeddedTarget), { recursive: true });
  fs.writeFileSync(embeddedTarget, renderEmbedded(pubB64, keyId));

  if (args.json === "true") {
    io.out(JSON.stringify({ ok: true, keyId, publicKeyB64: pubB64, privateKeyPath: privPath, embeddedKeyPath: embeddedTarget }, null, 2));
    return 0;
  }

  io.out("✓ Par de chaves Ed25519 gerado.");
  io.out(`  key_id:        ${keyId}`);
  io.out(`  chave pública: ${pubB64}`);
  io.out(`  chave privada: ${privPath}  (NÃO versionar / NÃO compartilhar)`);
  io.out(`  embeddedKey →  ${embeddedTarget}`);
  io.out("");
  io.out("Próximo: emita uma licença com");
  io.out(`  issue --subject dev@claro.com --org claro --scope codegen,skills --days 365`);
  return 0;
}

/** Emite uma licença assinada. Formato: FORGE-<b64url(payload)>.<b64url(sig)> (SPEC §6.2). */
export function issue({ args, keysDir, io }) {
  const infoPath = path.join(keysDir, "keyinfo.json");
  const privPath = path.join(keysDir, "private.pem");
  if (!fs.existsSync(privPath) || !fs.existsSync(infoPath)) {
    io.err(`✗ Chave privada não encontrada em ${keysDir}. Rode 'keygen' primeiro (ou aponte --keys-dir).`);
    return 1;
  }
  const { keyId } = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  const privateKey = crypto.createPrivateKey(fs.readFileSync(privPath, "utf8"));

  const now = Math.floor(Date.now() / 1000);

  // Janela de validade: --expires-at YYYY-MM-DD tem prioridade sobre --days.
  let expiry;
  if (args["expires-at"] && args["expires-at"] !== "true") {
    const t = Date.parse(`${args["expires-at"]}T23:59:59Z`);
    if (Number.isNaN(t)) {
      io.err(`✗ --expires-at inválido: '${args["expires-at"]}' (use YYYY-MM-DD).`);
      return 2;
    }
    expiry = Math.floor(t / 1000);
  } else {
    const daysRaw = String(args.days ?? "365");
    // Inteiro estrito: rejeita '10abc' (parseInt aceitaria como 10) e '5.9'.
    if (!/^\d+$/.test(daysRaw) || parseInt(daysRaw, 10) <= 0) {
      io.err(`✗ --days inválido: '${args.days}' (use um inteiro positivo).`);
      return 2;
    }
    expiry = now + parseInt(daysRaw, 10) * 86400;
  }

  const scope = String(args.scope || "codegen,skills").split(",").map((s) => s.trim()).filter(Boolean);
  // FinOps (#12): teto AUTORITATIVO de tokens/dia por subject, ASSINADO na licença. 0/ausente = ilimitado.
  const budgetRaw = String(args.budget ?? "0");
  if (!/^\d+$/.test(budgetRaw)) {
    io.err(`✗ --budget inválido: '${args.budget}' (use um inteiro de tokens/dia; 0 = ilimitado).`);
    return 2;
  }
  const budget = parseInt(budgetRaw, 10);
  const payload = {
    subject: args.subject && args.subject !== "true" ? String(args.subject) : "dev@claro.com",
    org: args.org && args.org !== "true" ? String(args.org) : "claro",
    scope,
    issued_at: now,
    expiry,
    key_id: args["key-id"] && args["key-id"] !== "true" ? String(args["key-id"]) : keyId,
    // budget só entra no payload quando > 0 — mantém as licenças "ilimitadas" byte-idênticas às antigas.
    ...(budget > 0 ? { budget } : {}),
  };

  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.from(payloadB64, "utf8"), privateKey);
  const key = `FORGE-${payloadB64}.${b64url(sig)}`;

  if (args.out && args.out !== "true") {
    const outPath = path.resolve(String(args.out));
    fs.writeFileSync(outPath, key + "\n", { mode: 0o600 });
    hardenFile(outPath, io); // a licença é um bearer token — restringe ao usuário atual
  }

  if (args.json === "true") {
    io.out(JSON.stringify({ ok: true, license: key, ...payload, expiry_iso: new Date(expiry * 1000).toISOString().slice(0, 10) }, null, 2));
    return 0;
  }

  io.out("✓ Licença emitida:\n");
  io.out(key);
  io.out("");
  io.out(`  subject: ${payload.subject} | org: ${payload.org} | scope: ${scope.join("+")}`);
  io.out(`  budget:  ${budget > 0 ? `${budget} tokens/dia` : "ilimitado"}`);
  io.out(`  key_id:  ${payload.key_id}`);
  io.out(`  expira em: ${new Date(expiry * 1000).toISOString().slice(0, 10)}`);
  if (args.out && args.out !== "true") io.out(`  gravada em: ${path.resolve(String(args.out))}`);
  return 0;
}

/** Adiciona um subject à lista de revogação (aplicação autoritativa é server-side, no gateway). */
export function revoke({ args, keysDir, io }) {
  const subject = args.subject && args.subject !== "true" ? String(args.subject) : "";
  if (!subject) {
    io.err("✗ informe --subject");
    return 2;
  }
  fs.mkdirSync(keysDir, { recursive: true });
  const revPath = path.join(keysDir, "revocations.json");
  const list = fs.existsSync(revPath) ? JSON.parse(fs.readFileSync(revPath, "utf8")) : [];
  const entry = { subject, revokedAt: Math.floor(Date.now() / 1000) };
  if (args.reason && args.reason !== "true") entry.reason = String(args.reason);
  list.push(entry);
  fs.writeFileSync(revPath, JSON.stringify(list, null, 2));

  if (args.json === "true") {
    io.out(JSON.stringify({ ok: true, revoked: subject, path: revPath, count: list.length }, null, 2));
    return 0;
  }
  io.out(`✓ ${subject} adicionado à lista de revogação (${revPath}).`);
  io.out("  Sincronize esse arquivo com o gateway para aplicação autoritativa.");
  return 0;
}

/**
 * Endurece o diretório de chaves. No Windows, modos POSIX são ignorados pelo fs, então
 * aplicamos ACL via icacls (best-effort): concede só ao usuário atual, remove herança.
 * Falha não é fatal — apenas registra um aviso.
 */
function currentWinUser() {
  return process.env.USERNAME
    ? `${process.env.USERDOMAIN || process.env.COMPUTERNAME || "."}\\${process.env.USERNAME}`
    : null;
}

function hardenDir(dir, io) {
  try { fs.chmodSync(dir, 0o700); } catch { /* no-op fora de POSIX */ }
  if (process.platform !== "win32") return;
  const user = currentWinUser();
  if (!user) {
    // Não silenciar: sem USERNAME não dá para endurecer a ACL — o admin precisa saber.
    io.err("  aviso: USERNAME indefinido — não endureci a ACL do diretório de chaves. Proteja-o manualmente (icacls).");
    return;
  }
  try {
    const r = spawnSync("icacls", [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], { stdio: "ignore" });
    if (r.status !== 0) io.err("  aviso: não foi possível endurecer a ACL do diretório de chaves (icacls). Proteja-o manualmente.");
  } catch {
    io.err("  aviso: não foi possível endurecer a ACL do diretório de chaves. Proteja-o manualmente.");
  }
}

/**
 * Endurece um ARQUIVO sensível (chave privada, licença emitida via --out): 0600 em POSIX;
 * ACL só-usuário no Windows (onde o mode POSIX é ignorado). Idempotente e best-effort —
 * aplicado inclusive na rotação (--force), onde {mode} do writeFileSync não reendurece um
 * arquivo pré-existente, e para o arquivo --out, que pode cair fora do keysDir endurecido.
 */
function hardenFile(file, io) {
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ignora modos POSIX */ }
  if (process.platform !== "win32") return;
  const user = currentWinUser();
  if (!user) return; // no fluxo de keygen o aviso já saiu em hardenDir
  try {
    const r = spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
    if (r.status !== 0) io.err(`  aviso: não foi possível endurecer a ACL de ${file}. Proteja-o manualmente.`);
  } catch { /* best-effort */ }
}

/**
 * Gera o manifesto de integridade `<file>.integrity.json` (SHA-256 + assinatura Ed25519 dos bytes do
 * .vsix, se a chave privada do admin estiver disponível). O admin PUBLICA esse manifesto ao lado do
 * .vsix; o destinatário verifica com `verify-vsix` antes de instalar.
 */
export function signVsix({ args, keysDir, io }) {
  const file = args.file && args.file !== "true" ? path.resolve(String(args.file)) : "";
  if (!file) {
    io.err("✗ informe --file <caminho-do-.vsix>");
    return 2;
  }
  if (!fs.existsSync(file)) {
    io.err(`✗ arquivo não encontrado: ${file}`);
    return 1;
  }
  const bytes = fs.readFileSync(file);
  const fileName = path.basename(file);
  // Versão: extrai de forge-<ver>.vsix quando possível (só rótulo do manifesto).
  const vm = /-(\d+\.\d+\.\d+)\.vsix$/.exec(fileName);
  const version = vm ? vm[1] : null;

  // Assinatura é OPCIONAL: sem private.pem, gera só o hash (integridade) e avisa.
  const privPath = path.join(keysDir, "private.pem");
  const infoPath = path.join(keysDir, "keyinfo.json");
  let signer;
  if (fs.existsSync(privPath) && fs.existsSync(infoPath)) {
    const { keyId } = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    signer = { privateKeyPem: fs.readFileSync(privPath, "utf8"), keyId };
  }
  const manifest = buildManifest({ fileName, version, bytes, signer });
  const outPath = file + ".integrity.json";
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");

  if (args.json === "true") {
    io.out(JSON.stringify({ ok: true, manifest: outPath, signed: !!manifest.signature, ...manifest }, null, 2));
    return 0;
  }
  io.out(`✓ Manifesto de integridade gerado: ${outPath}`);
  io.out(`  sha256: ${manifest.sha256}`);
  io.out(`  size:   ${manifest.size} bytes`);
  if (manifest.signature) {
    io.out(`  assinado com a chave ${manifest.keyId} (proveniência garantida).`);
  } else {
    io.err("  ⚠ SEM assinatura (chave privada ausente em " + keysDir + "): só a integridade (hash) está garantida.");
    io.err("    Rode este comando na máquina do admin (com private.pem) para assinar antes de publicar.");
  }
  io.out("  Publique o .integrity.json ao lado do .vsix; o destinatário verifica com 'verify-vsix'.");
  return 0;
}

/**
 * Verifica um .vsix contra seu manifesto (`<file>.integrity.json` por padrão) e a chave pública.
 * A pública vem de --pubkey <b64>, senão do keyinfo.json do keysDir. Integridade (hash) sempre;
 * proveniência (assinatura) quando o manifesto está assinado.
 */
export function verifyVsix({ args, keysDir, io, embeddedKeyPath }) {
  const file = args.file && args.file !== "true" ? path.resolve(String(args.file)) : "";
  if (!file) {
    io.err("✗ informe --file <caminho-do-.vsix>");
    return 2;
  }
  if (!fs.existsSync(file)) {
    io.err(`✗ arquivo não encontrado: ${file}`);
    return 1;
  }
  const manifestPath = args.manifest && args.manifest !== "true" ? path.resolve(String(args.manifest)) : file + ".integrity.json";
  if (!fs.existsSync(manifestPath)) {
    io.err(`✗ manifesto não encontrado: ${manifestPath} (gere com 'sign-vsix')`);
    return 1;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    io.err(`✗ manifesto ilegível: ${e.message}`);
    return 1;
  }
  // Chave pública, em ordem de precedência: --pubkey → keyinfo.json do keys-dir → chave EMBUTIDA no
  // cliente (src/license/embeddedKey.ts). O fallback embutido é o que permite verificar a proveniência
  // num checkout do repo SEM --pubkey — é a MESMA chave que o cliente confia para validar licenças.
  let publicKeyB64 = args.pubkey && args.pubkey !== "true" ? String(args.pubkey) : "";
  if (!publicKeyB64) {
    const infoPath = path.join(keysDir, "keyinfo.json");
    if (fs.existsSync(infoPath)) publicKeyB64 = JSON.parse(fs.readFileSync(infoPath, "utf8")).publicKeyB64 || "";
  }
  if (!publicKeyB64 && embeddedKeyPath && fs.existsSync(embeddedKeyPath)) {
    const m = /EMBEDDED_PUBLIC_KEY_B64\s*=\s*"([^"]+)"/.exec(fs.readFileSync(embeddedKeyPath, "utf8"));
    if (m) publicKeyB64 = m[1];
  }
  const requireSignature = args.strict === "true" || args["require-signature"] === "true";
  const bytes = fs.readFileSync(file);
  const r = verifyManifest({ bytes, manifest, publicKeyB64: publicKeyB64 || undefined, requireSignature });

  if (args.json === "true") {
    io.out(JSON.stringify({ ...r, file: path.basename(file), manifest: path.basename(manifestPath) }, null, 2));
    return r.ok ? 0 : 1;
  }
  if (r.ok && r.provenance === "signed") {
    io.out(`✓ ${path.basename(file)}: íntegro E assinado pela chave do admin.`);
  } else if (r.ok && r.provenance === "unsigned") {
    io.out(`✓ ${path.basename(file)}: íntegro (hash confere).`);
    io.err("  ⚠ manifesto SEM assinatura — a proveniência (veio do admin?) não foi verificada. Use --strict para EXIGIR assinatura.");
  } else {
    io.err(`✗ ${path.basename(file)}: FALHOU — ${r.reason}`);
  }
  return r.ok ? 0 : 1;
}

export function helpText(bin) {
  return [
    `FORGE admin CLI — gestão de chaves Ed25519 e emissão de licenças (v${VERSION})`,
    "",
    "USO:",
    `  ${bin} <comando> [opções]`,
    "",
    "COMANDOS:",
    "  keygen       Gera o par Ed25519 (uma vez / rotação). Emite a chave pública embutida.",
    "  issue        Emite uma licença assinada.",
    "  revoke       Adiciona um subject à lista de revogação.",
    "  sign-vsix    Gera o manifesto de integridade (SHA-256 + assinatura) de um .vsix.",
    "  verify-vsix  Verifica a integridade/proveniência de um .vsix contra seu manifesto.",
    "  help         Mostra esta ajuda.  version  Mostra a versão.",
    "",
    "GLOBAIS:",
    "  --keys-dir <dir>   Diretório das chaves (default: ao lado do executável).",
    "  --json             Saída legível por máquina.",
    "  -h, --help         Ajuda.   -v, --version   Versão.",
    "",
    "keygen:",
    "  --key-id <id>          Identificador da chave (default: ed25519-<ano>-01).",
    "  --emit-embedded <arq>  Onde gravar o embeddedKey.ts do cliente.",
    "  --force                Sobrescreve uma chave privada existente (IRREVERSÍVEL).",
    "",
    "issue:",
    "  --subject <email>      Titular da licença.",
    "  --org <org>            Organização (default: claro).",
    "  --scope <a,b>          Escopos separados por vírgula (default: codegen,skills).",
    "  --budget <n>           Teto de tokens/dia por subject (FinOps, autoritativo). 0 = ilimitado (default).",
    "  --days <n>             Validade em dias (default: 365).",
    "  --expires-at <data>    Validade até YYYY-MM-DD (sobrepõe --days).",
    "  --key-id <id>          key_id no payload (default: o de keyinfo.json).",
    "  --out <arq>            Também grava o token da licença em arquivo.",
    "",
    "revoke:",
    "  --subject <email>      Titular a revogar.  --reason <texto>  Motivo (opcional).",
    "",
    "sign-vsix / verify-vsix:",
    "  --file <arq.vsix>      O pacote a assinar/verificar (obrigatório).",
    "  --manifest <arq>       Manifesto a verificar (default: <file>.integrity.json).",
    "  --pubkey <b64>         Chave pública (default: keyinfo.json do keys-dir; senão a embutida no cliente).",
    "  --strict               (verify) EXIGE assinatura válida — sem ela, falha (exit≠0). Use em CI/release.",
    "",
    "EXEMPLOS:",
    `  ${bin} keygen --key-id ed25519-2026-01`,
    `  ${bin} issue --subject dev@claro.com --org claro --scope codegen,skills --days 365`,
    `  ${bin} issue --subject dev@claro.com --expires-at 2027-01-01 --out licenca.txt`,
    `  ${bin} revoke --subject dev@claro.com --reason "desligamento"`,
    `  ${bin} sign-vsix --file forge-2.9.0.vsix`,
    `  ${bin} verify-vsix --file forge-2.9.0.vsix`,
  ].join("\n");
}

/**
 * Dispatcher compartilhado. `ctx`:
 *   - defaultKeysDir: string          (resolvido pelo entry: repo ou ao lado do .exe)
 *   - defaultEmbeddedTarget: string|null
 *   - bin: string                     (nome exibido na ajuda)
 *   - io: { out(msg), err(msg) }
 * Retorna o código de saída (0 = ok).
 */
export function runCli(argv, ctx) {
  const io = ctx.io;
  // Varre TODO o argv por flags globais (--help/-h/--version/-v em qualquer posição,
  // inclusive como primeiro token: `forge-keygen.exe --version`).
  const global = parseArgs(argv);
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;

  if (cmd === "version" || global.version === "true") {
    io.out(VERSION);
    return 0;
  }
  if (!cmd || cmd === "help" || global.help === "true") {
    io.out(helpText(ctx.bin));
    return 0;
  }

  const args = parseArgs(argv.slice(1));
  const keysDir = resolveKeysDir(args, ctx.defaultKeysDir);
  try {
    switch (cmd) {
      case "keygen":
        return keygen({ args, keysDir, defaultEmbeddedTarget: ctx.defaultEmbeddedTarget, io });
      case "issue":
        return issue({ args, keysDir, io });
      case "revoke":
        return revoke({ args, keysDir, io });
      case "sign-vsix":
        return signVsix({ args, keysDir, io });
      case "verify-vsix":
        return verifyVsix({ args, keysDir, io, embeddedKeyPath: ctx.defaultEmbeddedTarget });
      default:
        io.err(`✗ comando desconhecido: ${cmd}\n`);
        io.out(helpText(ctx.bin));
        return 2;
    }
  } catch (e) {
    // Caminho comum no .exe standalone posto em pasta protegida (ex.: C:\Program Files).
    if (e && (e.code === "EPERM" || e.code === "EACCES" || e.code === "EROFS")) {
      io.err(`✗ sem permissão de escrita em ${keysDir} (${e.code}).`);
      io.err("  Rode o terminal como Administrador, ou aponte uma pasta gravável:");
      io.err("    --keys-dir %USERPROFILE%\\forge-keys");
      return 1;
    }
    throw e;
  }
}
