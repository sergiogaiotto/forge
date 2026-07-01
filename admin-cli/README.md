# FORGE Admin CLI

Gestão de chaves e emissão de licenças Ed25519 (RF-016/017, ADR-2).

> ⚠️ A **chave privada** (`admin-cli/keys/private.pem`) nunca deve ser versionada nem sair da
> máquina do admin. Só a **chave pública** é embutida no cliente (`src/license/embeddedKey.ts`).
> O diretório `admin-cli/keys/` está no `.gitignore`.

Há dois jeitos de rodar exatamente a mesma lógica (mesmo núcleo `core.mjs`, cripto byte-idêntica):

| Forma | Quando usar | Precisa de Node? |
|-------|-------------|------------------|
| **`forge-keygen.exe`** (standalone SEA) | distribuir para um admin/máquina sem ambiente de dev | **Não** |
| **`node admin-cli/forge-admin.mjs`** (repo) | no ambiente de desenvolvimento | Sim |

Uma licença emitida pelo `.exe` valida no cliente/gateway exatamente como uma emitida pelo CLI de repo.

## Executável standalone (`forge-keygen.exe`)

Empacotado com **Node Single Executable Application (SEA)** — um único binário (~77 MB, com o runtime
Node embutido) que roda no **CMD** sem Node instalado na máquina-alvo.

### Gerar o `.exe`

```powershell
npm run keygen:build-exe
#   → admin-cli/dist/forge-keygen.exe   (não é versionado; dist/ está no .gitignore)
```

Pipeline: `esbuild` (bundle CJS) → blob SEA (`node --experimental-sea-config`) → `postject`
(injeta o blob numa cópia do `node.exe`). No Windows a assinatura Authenticode do `node.exe` fica
inválida após a injeção — **é esperado, o binário roda normalmente**. Assine com o certificado
corporativo se for distribuir amplamente.

### Usar no CMD

```bat
:: chaves ficam ao lado do .exe (forge-keygen.exe\..\keys) — ou use --keys-dir
forge-keygen.exe keygen --key-id ed25519-2026-01
forge-keygen.exe issue  --subject dev@claro.com --org claro --scope codegen,skills --days 365
forge-keygen.exe issue  --subject dev@claro.com --expires-at 2027-01-01 --out licenca.txt
forge-keygen.exe revoke --subject dev@claro.com --reason "desligamento"
forge-keygen.exe --help
forge-keygen.exe --version
```

O `keygen` do `.exe` grava `embeddedKey.ts` ao lado das chaves e **imprime a chave pública/`key_id`**
para você colar em `src/license/embeddedKey.ts` do cliente (o binário standalone não tem o repo por perto).

> Por padrão as chaves vão para a pasta **ao lado do `.exe`**. Se o binário estiver numa pasta protegida
> (ex.: `C:\Program Files\...`), a escrita falha com uma mensagem clara — rode o CMD como Administrador
> ou aponte uma pasta gravável: `forge-keygen.exe keygen --keys-dir %USERPROFILE%\forge-keys`.

## Comandos (idênticos nas duas formas)

```bash
# 1) Gerar o par Ed25519 (uma vez / rotação). Embute a pública no cliente.
node admin-cli/forge-admin.mjs keygen --key-id ed25519-2026-01
#   atalho: npm run keygen

# 2) Emitir uma licença
node admin-cli/forge-admin.mjs issue --subject dev@claro.com --org claro --scope codegen,skills --days 365
#   atalho: npm run license:issue -- --subject dev@claro.com --org claro --days 365

# 3) Revogar (aplicação autoritativa é server-side, no gateway)
node admin-cli/forge-admin.mjs revoke --subject dev@claro.com
#   atalho: npm run license:revoke -- --subject dev@claro.com
```

## Parâmetros

**Globais** (qualquer comando):

| Flag | Efeito |
|------|--------|
| `--keys-dir <dir>` | Diretório das chaves. Default: `admin-cli/keys` (repo) ou ao lado do `.exe` (standalone). |
| `--json` | Saída legível por máquina. |
| `-h`, `--help` / `-v`, `--version` | Ajuda / versão. |

**`keygen`**

| Flag | Default | Efeito |
|------|---------|--------|
| `--key-id <id>` | `ed25519-<ano>-01` | Identificador da chave. |
| `--emit-embedded <arq>` | — | Onde gravar o `embeddedKey.ts` do cliente. |
| `--force` | — | Sobrescreve uma chave privada existente. **IRREVERSÍVEL** (invalida todas as licenças emitidas). |

> Sem `--force`, o `keygen` **recusa** (exit 3) sobrescrever uma `private.pem` existente — a chave é
> irrecuperável. O `embeddedKey.ts` do repo só é atualizado quando as chaves estão no **local padrão**
> (sem `--keys-dir`), para gerar chaves de teste em outra pasta nunca clobberar o cliente.

**`issue`**

| Flag | Default | Efeito |
|------|---------|--------|
| `--subject <email>` | `dev@claro.com` | Titular da licença. |
| `--org <org>` | `claro` | Organização. |
| `--scope <a,b>` | `codegen,skills` | Escopos (separados por vírgula). |
| `--days <n>` | `365` | Validade em dias. |
| `--expires-at <data>` | — | Validade até `YYYY-MM-DD` (sobrepõe `--days`). |
| `--key-id <id>` | o de `keyinfo.json` | `key_id` no payload. |
| `--out <arq>` | — | Também grava o token da licença em arquivo (0600). |

**`revoke`**

| Flag | Efeito |
|------|--------|
| `--subject <email>` | Titular a revogar (obrigatório). |
| `--reason <texto>` | Motivo (opcional). |

**Códigos de saída:** `0` ok · `1` chave ausente · `2` uso inválido · `3` sobrescrita bloqueada (sem `--force`).

## Formato da chave

```
FORGE-<base64url(payload)>.<base64url(assinatura Ed25519)>
```

`payload` = `{ subject, org, scope[], issued_at, expiry, key_id }` (SPEC §6.2). O cliente verifica a
assinatura contra a chave pública embutida e valida `key_id`, `expiry` e `scope`. O gateway repete a
verificação e consulta a lista de revogação (`keys/revocations.json`) — controle autoritativo.

## Rotação de chave

Rode `keygen --force` com um novo `--key-id`, redistribua o cliente (nova pública embutida) e reemita as
licenças. Licenças antigas deixam de validar (key_id divergente).
