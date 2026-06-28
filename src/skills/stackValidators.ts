import { DetectedStack } from "../util/stackDetect";
import { SkillValidatorSpec } from "./types";

// Convenções-como-validators: mapeia as ferramentas DETECTADAS no repo (lint/format/tipos) para
// validadores do quality gate, para que o código gerado seja checado contra o ferramental real do
// projeto a cada proposta.
//
// Advisory por padrão (gate:false): rodam e mostram o resultado no cartão da proposta, mas NÃO
// bloqueiam o "Aplicar" — evita travar por um aviso de formatação/estilo. Skills continuam podendo
// definir validadores com gate:true quando o time quiser bloqueio rígido. Ids prefixados com
// "stack:" para nunca colidir com validadores definidos por skills (dedupe é por id).

const PY = [".py"];
const JS = [".js", ".jsx", ".ts", ".tsx"];

const TOOL_VALIDATORS: Record<string, { command: string; appliesTo: string[] }> = {
  ruff: { command: "ruff check {file}", appliesTo: PY },
  flake8: { command: "flake8 {file}", appliesTo: PY },
  black: { command: "black --check {file}", appliesTo: PY },
  isort: { command: "isort --check-only {file}", appliesTo: PY },
  mypy: { command: "mypy {file}", appliesTo: PY },
  pyright: { command: "pyright {file}", appliesTo: PY },
  eslint: { command: "eslint {file}", appliesTo: JS },
  prettier: { command: "prettier --check {file}", appliesTo: [...JS, ".json", ".css", ".md"] },
  // typescript (tsc --noEmit) não é confiável arquivo-a-arquivo (precisa do projeto) — fica de fora.
};

export function validatorsFromStack(s: DetectedStack): SkillValidatorSpec[] {
  const out: SkillValidatorSpec[] = [];
  for (const tool of [...s.lintFormat, ...s.types]) {
    const def = TOOL_VALIDATORS[tool];
    if (def) out.push({ id: `stack:${tool}`, label: tool, command: def.command, gate: false, appliesTo: def.appliesTo });
  }
  return out;
}
