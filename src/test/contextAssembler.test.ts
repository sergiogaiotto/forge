import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextAssembler } from "../skills/ContextAssembler";
import { SkillMeta } from "../skills/types";

function skill(name: string, description: string): SkillMeta {
  return { name, description, path: `/skills/${name}`, source: "managed", enabled: true, validators: [] };
}

test("assembles system prompt in the specified order (RF-040)", () => {
  const a = new ContextAssembler();
  const out = a.assemble({
    basePrompt: "BASE_PROMPT",
    discoverySkills: [skill("pandas-defensive-pipelines", "DESC_PANDAS")],
    activatedSkills: [{ meta: skill("pandas-defensive-pipelines", "DESC_PANDAS"), body: "ACTIVATED_BODY" }],
    retrievedContext: "RETRIEVED_CTX",
    history: [{ role: "user", content: "prev question" }],
    query: "QUERY_TEXT",
  });

  const sp = out.systemPrompt;
  const iBase = sp.indexOf("BASE_PROMPT");
  const iDisc = sp.indexOf("DESC_PANDAS");
  const iCtx = sp.indexOf("RETRIEVED_CTX");
  const iBody = sp.indexOf("ACTIVATED_BODY");
  assert.ok(iBase >= 0 && iDisc > iBase && iCtx > iDisc && iBody > iCtx, "order must be base → discovery → retrieved → activated body");

  // messages = history + query, query last.
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].content, "prev question");
  assert.equal(out.messages[1].content, "QUERY_TEXT");
  assert.deepEqual(out.activatedSkillNames, ["pandas-defensive-pipelines"]);
});

test("omits empty sections", () => {
  const a = new ContextAssembler();
  const out = a.assemble({
    basePrompt: "BASE",
    discoverySkills: [],
    activatedSkills: [],
    retrievedContext: "",
    history: [],
    query: "Q",
  });
  assert.equal(out.systemPrompt.trim(), "BASE");
  assert.equal(out.messages.length, 1);
});
