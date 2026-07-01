import assert from "node:assert/strict";
import { test } from "node:test";
import { parseImageDataUrl, parseTesseractLangs, pickOcrLangs, resolveTesseractCmd, tesseractCandidates } from "../util/ocr";

test("parseImageDataUrl extrai mime/ext/base64 e normaliza jpeg→jpg", () => {
  const png = parseImageDataUrl("data:image/png;base64,iVBORw0KGgo=");
  assert.deepEqual(png, { mime: "image/png", ext: "png", base64: "iVBORw0KGgo=" });
  const jpg = parseImageDataUrl("data:image/jpeg;base64,/9j/4AAQSkZJRg==");
  assert.equal(jpg?.ext, "jpg");
  assert.equal(jpg?.mime, "image/jpeg");
  // tolera espaços/quebras no base64 (alguns clipboards inserem)
  assert.equal(parseImageDataUrl("data:image/png;base64,iVBO\n Rw0K\tGgo=")?.base64, "iVBORw0KGgo=");
});

test("parseImageDataUrl rejeita não-imagem e entradas inválidas", () => {
  assert.equal(parseImageDataUrl("data:text/plain;base64,aGVsbG8="), null); // não é imagem
  assert.equal(parseImageDataUrl("iVBORw0KGgo="), null); // sem prefixo data:
  assert.equal(parseImageDataUrl("data:image/png;base64,"), null); // base64 vazio
  assert.equal(parseImageDataUrl(""), null);
});

test("pickOcrLangs escolhe os desejados disponíveis, na ordem pedida", () => {
  assert.deepEqual(pickOcrLangs(["eng", "por", "spa"]), ["por", "eng"]); // ambos → por+eng
  assert.deepEqual(pickOcrLangs(["eng", "deu"]), ["eng"]); // só eng
  assert.deepEqual(pickOcrLangs(["deu", "spa"]), []); // nenhum → sem -l (default)
  assert.deepEqual(pickOcrLangs([]), []);
});

test("parseTesseractLangs ignora o cabeçalho e linhas vazias", () => {
  const out = "List of available languages (3):\neng\npor\nosd\n";
  assert.deepEqual(parseTesseractLangs(out), ["eng", "por", "osd"]);
  assert.deepEqual(parseTesseractLangs(""), []);
});

test("tesseractCandidates monta os locais padrão do Windows (inclui o por-usuário)", () => {
  const cands = tesseractCandidates({
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    USERPROFILE: "C:\\Users\\me",
  });
  assert.ok(cands.includes("C:\\Program Files\\Tesseract-OCR\\tesseract.exe"));
  assert.ok(cands.includes("C:\\Users\\me\\AppData\\Local\\Programs\\Tesseract-OCR\\tesseract.exe"), "inclui o caminho por-usuário (sem admin)");
  assert.ok(cands.includes("C:\\Users\\me\\scoop\\apps\\tesseract\\current\\tesseract.exe"));
  // sem env vars (ex.: mac/linux) → lista vazia → cai no PATH
  assert.deepEqual(tesseractCandidates({}), []);
});

test("resolveTesseractCmd: config explícita vence; senão 1º que existe; senão 'tesseract' no PATH", () => {
  const exists = (p: string) => p === "C:\\Users\\me\\AppData\\Local\\Programs\\Tesseract-OCR\\tesseract.exe";
  const cands = [
    "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
    "C:\\Users\\me\\AppData\\Local\\Programs\\Tesseract-OCR\\tesseract.exe",
  ];
  // config explícita é respeitada como-está (mesmo que o fileExists não a valide)
  assert.equal(resolveTesseractCmd("D:\\portable\\tesseract.exe", cands, exists), "D:\\portable\\tesseract.exe");
  // sem config → primeiro candidato que EXISTE (o por-usuário, aqui)
  assert.equal(resolveTesseractCmd("", cands, exists), "C:\\Users\\me\\AppData\\Local\\Programs\\Tesseract-OCR\\tesseract.exe");
  // sem config e nenhum existe → fallback no PATH
  assert.equal(resolveTesseractCmd("  ", cands, () => false), "tesseract");
});
