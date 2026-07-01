import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProjectIntent } from "../util/projectIntent";

const gen = (t: string) => assert.equal(classifyProjectIntent(t), "generate", `esperava generate: ${JSON.stringify(t)}`);
const chat = (t: string) => assert.equal(classifyProjectIntent(t), "chat", `esperava chat: ${JSON.stringify(t)}`);

test("logs/erros colados terminando em pergunta → chat (o bug do ponto 7)", () => {
  const pasted = [
    "[AVISO] Chave Fernet gerada automaticamente. Defina a variável de ambiente FERNET_KEY para persistência.",
    "INFO:     Started server process [27288]",
    "INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)",
    'INFO:     127.0.0.1:51867 - "GET / HTTP/1.1" 404 Not Found',
    "",
    "o que aconteceu?",
  ].join("\n");
  chat(pasted);
});

test("pedido claro de criar projeto → generate", () => {
  gen("crie uma aplicação para gerenciamento de senhas");
  gen("Gere um projeto Python hexagonal de gerenciador de tarefas");
  gen("construa uma API REST com FastAPI");
  gen("build a CLI todo app in Go");
  gen("write a Python script that parses CSV");
});

test("verbo/pedido de geração vence a interrogação (pergunta que é, na verdade, um pedido) → generate", () => {
  gen("pode criar um gerenciador de senhas?");
  gen("me ajuda a gerar um projeto novo?");
  gen("poderia fazer um app de notas?");
  gen("quero criar um dashboard de vendas");
});

test("propostas de artefato como pergunta → generate", () => {
  gen("Que tal um gerenciador de tarefas em Python?");
  gen("Pode ser um dashboard de vendas?");
  gen("e se a gente montar um blog em FastAPI?");
});

// REGRESSÃO (revisão adversarial): briefs legítimos que MENCIONAM vocabulário de erro/HTTP/servidor
// no domínio NÃO podem ser sequestrados para o chat — o verbo de geração no início vence.
test("briefs que citam ERROR/Exception/uvicorn/HTTP no domínio ainda são generate", () => {
  gen("crie um app que trata ERROR de rede");
  gen("Construa uma lib Python que lança Exception customizada de validação");
  gen("Crie um projeto FastAPI servido por uvicorn");
  gen("Monte um deploy com gunicorn e nginx");
  gen("crie uma API que trata Exception e retorna ERROR 500");
  gen("crie um endpoint GET /users que devolve 404 Not Found quando ausente");
  gen("implemente retry quando a resposta for 500 Internal Server Error");
  gen("crie um handler de Exception para o FastAPI");
  gen("crie um serviço que logue INFO: no startup");
});

// REGRESSÃO (2ª verificação adversarial): brief que COMEÇA com pedido de gerar mas inclui uma linha
// de EXEMPLO de log/erro abaixo (comum em briefs de logging/observabilidade/parser) → ainda generate.
// O pedido no início vence o STRONG_LOG da linha interna.
test("brief que começa com pedido + linha de log de exemplo embaixo → generate", () => {
  gen("Crie um serviço de logging\n2024-06-30 12:00:01 INFO request handled");
  gen("Construa uma API de validação\nValueError: valor inválido");
  gen('Desenvolva um dashboard de acesso\n"GET /api/users HTTP/1.1" 200 1234');
  gen("Crie um app CLI de disco\n[AVISO] disco quase cheio");
  gen("Faça um script de build\nnpm ERR! missing script: build");
});

// REGRESSÃO: pedidos educados com prefixo de cortesia ("você poderia", "tem como", "seria possível",
// "dá pra") + verbo de geração → generate (mesma família de "pode/poderia/consegue").
test("pedidos com cortesia + verbo de geração → generate", () => {
  gen("você poderia desenvolver um MVP?");
  gen("tem como criar um bot?");
  gen("seria possível gerar os testes?");
  gen("dá pra fazer um app disso?");
});

test("perguntas/diagnósticos sem pedido de gerar → chat", () => {
  chat("o que aconteceu?");
  chat("por que deu 404?");
  chat("como faço para rodar o projeto?"); // "faço" NÃO é verbo de geração
  chat("o que é arquitetura hexagonal?");
  chat("não entendi esse erro de conexão recusada");
  chat("me explica esse log de timeout");
});

// REGRESSÃO: perguntas informativas que CONTÊM um verbo de geração no meio ainda são chat (o verbo
// só vence quando o pedido está no INÍCIO da frase — "como criar…?" é pergunta, não pedido).
test("perguntas informativas com verbo de geração no meio → chat", () => {
  chat("como criar um projeto FastAPI?");
  chat("o que significa construir um MVP?");
  chat("qual a melhor forma de implementar cache?");
});

test("stack traces (Python nu, Node sem parênteses) são diagnóstico → chat", () => {
  chat("ValueError: invalid literal for int() with base 10");
  chat("KeyError: 'user_id'");
  chat("ConnectionRefusedError: [Errno 111] Connection refused");
  chat("TypeError: Cannot read properties of undefined (reading 'id')\n    at /app/src/index.js:12:20");
  chat('Traceback (most recent call last):\n  File "x.py", line 3, in <module>');
  chat("npm ERR! code ELIFECYCLE");
});

test("brief curto sem verbo/pergunta e vazio caem no default do Modo Projeto → generate", () => {
  gen("gerenciador de senhas em Python");
  gen("app que mostra onde estão os itens do estoque"); // "onde" no meio não é pergunta
  gen("");
  gen("   ");
});
