import assert from "node:assert/strict";
import { test } from "node:test";
import { FORGE_FENCE, FORGE_FILE_BLOCK_LANG } from "../shared/protocol";
import { detectProseFileEdit } from "../util/proseEdits";

// O SINTOMA DO PRINT: o modelo mostrou o arquivo em cerca comum ```python e pediu, em prosa, para
// "Substituir todo o conteúdo de <path>". Deve DISPARAR o reparo e capturar o caminho para a mensagem.
test("detecta o sintoma do print (cerca comum + 'substituir o conteúdo de <path>')", () => {
  const text = [
    "Aqui está a correção. Adicione o fixture abaixo:",
    "```python",
    "@pytest.fixture",
    "def openai_client_mock(monkeypatch):",
    "    ...",
    "```",
    "",
    "Resumo das ações: Substituir todo o conteúdo de src/adapters/ai/openai_model.py pelo código acima.",
  ].join("\n");
  const sig = detectProseFileEdit(text);
  assert.ok(sig, "deveria disparar o reparo");
  assert.equal(sig?.path, "src/adapters/ai/openai_model.py");
});

// Cerca comum + caminho de arquivo + PISTA de proposta ("segue"/"corrigido"): dispara e captura o caminho.
test("dispara com cerca comum + arquivo + pista de proposta (segue/corrigido)", () => {
  const text = "Segue o config.py corrigido:\n```python\nX = 1\nY = 2\n```";
  const sig = detectProseFileEdit(text);
  assert.ok(sig);
  assert.equal(sig?.path, "config.py");
});

// Menção DIDÁTICA a um arquivo (sem verbo nem pista de proposta) + exemplo de código: NÃO dispara.
// Este é o falso-positivo que a revisão adversarial levantou — o detector agora o descarta.
test("NÃO dispara em menção didática a um arquivo (sem verbo nem pista de proposta)", () => {
  const text = "No projeto, o arquivo settings.py controla a config do Django. Por exemplo:\n```python\nDEBUG = True\nALLOWED_HOSTS = []\n```\nIsso ativa o modo debug.";
  assert.equal(detectProseFileEdit(text), null);
});

// Cerca comum + VERBO de edição, sem caminho: dispara, mas sem path (a reemissão pede o path ao modelo).
test("dispara com cerca comum + verbo de edição, path indefinido quando não há caminho", () => {
  const text = "Substitua o conteúdo do arquivo pela versão corrigida:\n```python\ndef f():\n    return 1\n```";
  const sig = detectProseFileEdit(text);
  assert.ok(sig);
  assert.equal(sig?.path, undefined);
});

// Explicação pura com um exemplo em código, SEM intenção de editar arquivo: NÃO dispara (evita reemissão à toa).
test("NÃO dispara em explicação pura com exemplo de código (sem intenção de arquivo)", () => {
  const text = "Para agrupar no pandas, use groupby:\n```python\ndf.groupby('a').sum()\ndf.head()\n```\nIsso retorna a soma por grupo.";
  assert.equal(detectProseFileEdit(text), null);
});

// Já HÁ um bloco forge-file (proposta aplicável): nada a reparar.
test("NÃO dispara quando já existe um bloco forge-file (proposta aplicável)", () => {
  const text = `Segue o arquivo:\n${FORGE_FENCE}${FORGE_FILE_BLOCK_LANG} path=a.py\nprint("x")\nprint("y")\n${FORGE_FENCE}`;
  assert.equal(detectProseFileEdit(text), null);
});

// Cerca de UMA linha (comando de shell) + intenção: NÃO dispara — exige corpo real (>= 2 linhas não-vazias).
test("NÃO dispara com cerca de comando de shell de uma linha, mesmo com intenção", () => {
  const text = "Rode isto e depois altere o arquivo x.py:\n```bash\npip install requests\n```";
  assert.equal(detectProseFileEdit(text), null);
});

// Intenção de arquivo na prosa, mas SEM nenhuma cerca de código: NÃO dispara (não há o que reemitir).
test("NÃO dispara sem nenhuma cerca de código", () => {
  assert.equal(detectProseFileEdit("Substitua o conteúdo de main.py pela versão nova."), null);
});

// O caminho aparece SÓ DENTRO do código (não na prosa): NÃO dispara — a busca de intenção é só na prosa.
test("NÃO dispara quando o caminho só aparece dentro da cerca (não na prosa)", () => {
  const text = "Veja como fica:\n```python\n# file: config.py\nX = 1\nY = 2\n```\nPronto.";
  assert.equal(detectProseFileEdit(text), null);
});

// Texto vazio: nulo, sem exceção.
test("texto vazio retorna null", () => {
  assert.equal(detectProseFileEdit(""), null);
});
