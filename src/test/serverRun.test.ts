import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import {
  buildServerCommand,
  detectFastApiServer,
  extractPort,
  extractServerUrl,
  fallbackUrl,
  pythonModulePath,
  shellSafePython,
} from "../util/serverRun";

test("pythonModulePath: rel .py -> módulo pontilhado (barra e contra-barra, sem ./ inicial)", () => {
  assert.equal(pythonModulePath("src/composition_root.py"), "src.composition_root");
  assert.equal(pythonModulePath("src\\adapters\\api\\router.py"), "src.adapters.api.router");
  assert.equal(pythonModulePath("./main.py"), "main");
  assert.equal(pythonModulePath("app.py"), "app");
});

test("extractPort: lê port= e --port; ignora número não-porta; null quando ausente", () => {
  assert.equal(extractPort('uvicorn.run(app, host="127.0.0.1", port=8123)'), 8123);
  assert.equal(extractPort("cmd --port 9000 outra coisa"), 9000);
  assert.equal(extractPort("nada de porta aqui"), null);
  assert.equal(extractPort("port=70000"), null); // fora da faixa
});

test("detectFastApiServer: módulo que DEFINE o app (uvicorn modulo:app) vs entrypoint que RODA sozinho", () => {
  // (1) composition_root.py define o app, não roda sozinho -> uvicorn src.composition_root:app
  const wired = "from fastapi import FastAPI\napp = FastAPI(title='x')\n";
  const plan = detectFastApiServer("src/composition_root.py", wired);
  assert.ok(plan);
  assert.equal(plan!.module, "src.composition_root");
  assert.equal(plan!.appVar, "app");
  assert.equal(plan!.selfRun, false);
  assert.equal(plan!.port, 8000); // default

  // (2) main.py IMPORTA o app e chama uvicorn.run no __main__ -> executa o próprio arquivo (selfRun)
  const entry = 'from src.composition_root import app\nif __name__ == "__main__":\n    import uvicorn\n    uvicorn.run("main:app", port=9001, reload=True)\n';
  const p2 = detectFastApiServer("main.py", entry);
  assert.ok(p2);
  assert.equal(p2!.selfRun, true);
  assert.equal(p2!.appVar, "app"); // sem `= FastAPI(` local, cai no default
  assert.equal(p2!.port, 9001);

  // define o app COM nome custom E roda sozinho
  const custom = "api = FastAPI()\nif __name__ == \"__main__\":\n    import uvicorn; uvicorn.run(api, port=8080)\n";
  const p3 = detectFastApiServer("app.py", custom);
  assert.equal(p3!.appVar, "api");
  assert.equal(p3!.selfRun, true);
  assert.equal(p3!.port, 8080);

  // comentado NÃO casa (nem `= FastAPI(` nem `uvicorn.run(`)
  assert.equal(detectFastApiServer("x.py", "# app = FastAPI()\n# uvicorn.run(app)\n"), null);
  // domínio puro NÃO casa
  assert.equal(detectFastApiServer("domain.py", "class Order:\n    pass\n"), null);
  // não-.py NÃO casa mesmo com FastAPI no texto
  assert.equal(detectFastApiServer("README.md", "app = FastAPI()"), null);

  // RESSALVA #2 da revisão: `uvicorn.run(` em DOCSTRING sem `import uvicorn` NÃO vira servidor (falso-positivo)
  assert.equal(detectFastApiServer("helper.py", '"""Rode com uvicorn.run(app) em produção."""\ndef f():\n    pass\n'), null);
  // RESSALVA #3: `app = FastAPI()` INDENTADO (app-factory) não é servível por uvicorn modulo:app -> não detecta o app
  assert.equal(detectFastApiServer("factory.py", "def make():\n    app = FastAPI()\n    return app\n"), null);
});

test("shellSafePython: relativo (sem aspas) quando sob o ws; absoluto quando externo; bare intacto", () => {
  // cross-platform: constrói caminhos absolutos reais e testa os INVARIANTES (não strings fixas de SO).
  const ws = path.resolve("forge-safepy-ws");
  const venv = path.join(ws, ".venv", "Scripts", "python.exe");
  const safe = shellSafePython(venv, ws);
  assert.ok(!path.isAbsolute(safe), "venv sob o ws -> caminho RELATIVO (não precisa de aspas)");
  assert.ok(!safe.includes("\\"), "normaliza separador para barra");
  assert.ok(/python/.test(safe));
  // interpretador "pelado" (sem separador) já é seguro em qualquer shell
  assert.equal(shellSafePython("python", ws), "python");
  assert.equal(shellSafePython("python3", ws), "python3");
  // venv FORA do ws (o relativo começaria com ..) -> mantém o absoluto (o chamador cita)
  const outside = path.resolve("forge-safepy-other", "env", "python.exe");
  assert.equal(shellSafePython(outside, ws), outside);
});

test("buildServerCommand: uvicorn quando define o app; roda o arquivo quando é entrypoint; cita espaços", () => {
  const plan = { module: "src.composition_root", appVar: "app", selfRun: false, port: 8000 };
  assert.equal(buildServerCommand("python", plan, "/ws/src/composition_root.py"), "python -m uvicorn src.composition_root:app --port 8000");
  // venv com espaço no caminho é citado
  const venv = "C:\\Users\\João Silva\\.venv\\Scripts\\python.exe";
  assert.equal(
    buildServerCommand(venv, plan, "C:\\ws\\src\\composition_root.py"),
    `"${venv}" -m uvicorn src.composition_root:app --port 8000`
  );
  // entrypoint que roda sozinho: executa o próprio arquivo
  const mainPlan = { module: "main", appVar: "app", selfRun: true, port: 8080 };
  assert.equal(buildServerCommand("python", mainPlan, "/ws/main.py"), "python /ws/main.py");
});

test("extractServerUrl: pega a URL da linha do uvicorn; 0.0.0.0 -> 127.0.0.1; sem URL -> null", () => {
  assert.equal(extractServerUrl("INFO: Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)"), "http://127.0.0.1:8000");
  assert.equal(extractServerUrl("Uvicorn running on http://0.0.0.0:8080."), "http://127.0.0.1:8080");
  assert.equal(extractServerUrl("compilando..."), null);
});

test("fallbackUrl: host local + porta", () => {
  assert.equal(fallbackUrl(8000), "http://127.0.0.1:8000");
  assert.equal(fallbackUrl(8123), "http://127.0.0.1:8123");
});
