import assert from "node:assert/strict";
import { test } from "node:test";
import { parseImageDataUrl, parseTesseractLangs, pickOcrLangs } from "../util/ocr";

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
