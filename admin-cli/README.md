# FORGE Admin CLI

Gestão de chaves e emissão de licenças Ed25519 (RF-016/017, ADR-2).

> ⚠️ A **chave privada** (`admin-cli/keys/private.pem`) nunca deve ser versionada nem sair da
> máquina do admin. Só a **chave pública** é embutida no cliente (`src/license/embeddedKey.ts`).
> O diretório `admin-cli/keys/` está no `.gitignore`.

## Comandos

```bash
# 1) Gerar o par Ed25519 (uma vez). Embute a pública no cliente.
node admin-cli/forge-admin.mjs keygen --key-id ed25519-2026-01
#   atalho: npm run keygen

# 2) Emitir uma licença
node admin-cli/forge-admin.mjs issue --subject dev@claro.com --org claro --scope codegen,skills --days 365
#   atalho: npm run license:issue -- --subject dev@claro.com --org claro --days 365

# 3) Revogar (a aplicação é server-side, no gateway)
node admin-cli/forge-admin.mjs revoke --subject dev@claro.com
```

## Formato da chave

```
FORGE-<base64url(payload)>.<base64url(assinatura Ed25519)>
```

`payload` = `{ subject, org, scope[], issued_at, expiry, key_id }` (SPEC §6.2). O cliente verifica a
assinatura contra a chave pública embutida e valida `key_id`, `expiry` e `scope`. O gateway repete a
verificação e consulta a lista de revogação (`keys/revocations.json`) — controle autoritativo.

## Rotação de chave

Rode `keygen` com um novo `--key-id`, redistribua o cliente (nova pública embutida) e reemita as
licenças. Licenças antigas deixam de validar (key_id divergente).
