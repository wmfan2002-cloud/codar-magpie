// 纯函数自检，不联网：node test.mjs
import assert from "node:assert/strict";
import { _internal as I } from "./index.mjs";

const fakeJwt = (payload) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

// 常量
assert.equal(I.PROVIDER, "codar");
assert.equal(I.V1, "https://api.claw.speedai.com/v1");
assert.ok(I.FREE_MODELS.has("auto"));

// JWT
const tok = fakeJwt({ exp: 4_000_000_000, username: "wx_test" });
assert.equal(I.jwtPayload(tok).username, "wx_test");
assert.equal(I.usernameOf(tok), "wx_test");
assert.equal(I.jwtPayload("not-a-jwt"), null);
assert.equal(I.usernameOf(undefined), null);

// 鉴权形状：api 存 key，oauth 存 access
assert.equal(I.keyOf({ type: "api", key: "k1" }), "k1");
assert.equal(I.keyOf({ type: "oauth", access: "a1" }), "a1");
assert.equal(I.keyOf({}), undefined);

// 协议分流
assert.equal(I.npmOf("anthropic"), "@ai-sdk/anthropic");
assert.equal(I.npmOf("chat"), "@ai-sdk/openai-compatible");

// config 形状的模型
const cm = I.configModel({ id: "claude-x", name: "claude-x", ctx: 1000, api: "anthropic", free: true });
assert.equal(cm.provider.npm, "@ai-sdk/anthropic");
assert.equal(cm.provider.api, I.V1);
assert.equal(cm.limit.context, 1000);
assert.equal(cm.tool_call, true);
assert.equal(cm.free, true);
assert.deepEqual(cm.modalities.input, ["text"]);

// 运行时形状的模型（目录原始条目，protocol 可能是对象也可能是字符串）
const rm = I.runtimeModel({
  id: "auto", display_name: "auto", context_window: 1_000_000,
  protocol: { type: "openai_chat_completions" },
});
assert.equal(rm.api.npm, "@ai-sdk/openai-compatible");
assert.equal(rm.api.url, I.V1);
assert.equal(rm.api.id, "auto");
assert.equal(rm.free, true);
assert.match(rm.name, /免费/);

const rm2 = I.runtimeModel({ id: "claude-opus-5", protocol: "anthropic_messages", context_window: 200_000 });
assert.equal(rm2.api.npm, "@ai-sdk/anthropic");
assert.equal(rm2.capabilities.reasoning, true);
// 上下文一律 1M：目录里写 200K / 128K 也不采用，超了让上游报错
assert.equal(rm2.limit.context, 1_000_000);
const rm3 = I.runtimeModel({ id: "gpt-6-sol", protocol: "openai_chat_completions", context_window: 128_000 });
assert.equal(rm3.limit.context, 1_000_000);

// 目录里的每个 id 都在静态表里（两边不漂移）
const ids = new Set(I.MODEL_TABLE.map((m) => m.id));
assert.equal(ids.size, 16);
for (const id of ["auto", "claude-opus-5-5", "glm-5.3-flash", "gpt-6-sol"]) assert.ok(ids.has(id), id);

// 时长格式
assert.equal(I.leftOf(3600), "1 小时 0 分");
assert.equal(I.leftOf(90), "1 分钟");
assert.equal(I.leftOf(0), "一会儿");

// 身份句替换（上游对 system prompt 整句匹配触发 403）
const BAD_LINE = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const scrubbed = `{"system":[{"type":"text","text":"${BAD_LINE}"}]}`;
const fixed = `{"system":[{"type":"text","text":"You are an AI assistant working with the user toward their goals."}]}`;
assert.equal(I.scrubRequestBody(scrubbed), fixed, "JSON 字符串里的身份句要被替换");
assert.equal(I.scrubRequestBody(fixed), fixed, "没有命中时原样返回（同一引用/值）");
assert.equal(I.scrubRequestBody("no match here"), "no match here");
assert.ok(I.scrubRequestBody(`pre ${BAD_LINE} mid ${BAD_LINE} post`).split(BAD_LINE).every((p) => p !== BAD_LINE), "多次出现全部替换");
// 部分命中不算命中：整句精确匹配是上游的判定，改一个字上游本来也不拦
assert.equal(I.scrubRequestBody("You are a Claude agent"), "You are a Claude agent");
// Uint8Array 路径：能解出 UTF-8 就替换并回字节
const bytes = new TextEncoder().encode(scrubbed);
const out = I.scrubRequestBody(bytes);
assert.ok(out instanceof Uint8Array, "字节 body 返回字节");
assert.equal(new TextDecoder().decode(out), fixed);
// 非 UTF-8 字节原样放行
const bin = new Uint8Array([0xff, 0xfe, 0x00, 0x9c]);
assert.equal(I.scrubRequestBody(bin), bin);
// undefined / null / 其他类型原样放行
assert.equal(I.scrubRequestBody(undefined), undefined);
assert.equal(I.scrubRequestBody(null), null);
// 只替换目标句，不碰周边内容
const surrounding = `prefix "${BAD_LINE}" suffix`;
assert.equal(
  I.scrubRequestBody(surrounding),
  'prefix "You are an AI assistant working with the user toward their goals." suffix',
);

// 结构式身份替换：harness 身份句在 system 槽位首句（You are 开头 + 特征词）→ 整段换中性句。
// 覆盖不枚举的 harness；user 消息和普通系统指令不动。
const NEUTRAL = "You are an AI assistant working with the user toward their goals.";
const openaiSys = (sys) => JSON.stringify({ messages: [{ role: "system", content: sys }] });
for (const [label, body] of Object.entries({
  "Claude Code 句": openaiSys("You are a coding assistant."),
  "Pi 句": openaiSys("You are an expert coding assistant operating inside pi, a coding agent harness. Rest here."),
  "Codex 两句式": openaiSys("You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI."),
  "Cline engineer 式": openaiSys("You are Cline, a highly skilled software engineer with extensive knowledge."),
  "opencode": openaiSys("You are opencode, an agent that lives in the terminal."),
  "Gemini": openaiSys("You are Gemini CLI, an interactive CLI agent specializing in software engineering tasks."),
  "假想新 harness": openaiSys("You are FooBar, a brand new agent harness nobody listed."),
  "Anthropic system 块": JSON.stringify({ system: [{ type: "text", text: "You are an interactive CLI agent for coding." }, { type: "text", text: "Other." }] }),
  "developer 角色": openaiSys2(),
})) {
  const out = I.scrubRequestBody(body);
  assert.notEqual(out, body, `${label} 应被结构式替换`);
  const text = JSON.parse(out).messages?.[0]?.content ?? JSON.parse(out).system?.[0]?.text;
  assert.ok(text.startsWith(NEUTRAL), `${label} 应以中性句开头`);
}
function openaiSys2() {
  return JSON.stringify({ messages: [{ role: "developer", content: "You are a coding assistant for review." }] });
}
// 不该动的：普通系统指令、中文、中间出现的身份句、user 消息
// （「已替换」要单测：单句的已替换文本经 JSON 重序列化键序不变但字符串会稳定一致，
//   而带后文的已替换文本不应再触发结构式替换）
for (const [label, body] of Object.entries({
  "普通指令": openaiSys("You are working on a Vue project. Use TypeScript."),
  "普通指令2": openaiSys("You are Codex, based on GPT-5. Answer briefly."),
  "中文": openaiSys("你是一个编程助手。请帮用户完成任务。"),
  "中间身份句": openaiSys("Intro.\nYou are an agent harness in the middle."),
  "user 消息": JSON.stringify({ messages: [{ role: "user", content: "You are an agent harness writer." }] }),
  "已替换带后文": openaiSys(`${NEUTRAL} More instructions.`),
})) {
  assert.equal(I.scrubRequestBody(body), body, `${label} 不应被改动`);
}

// ensureFreeModel：节流后仍返回状态（不能返回 null，否则列表会误判成「可领取」）
const origFetch = globalThis.fetch;
let claimCalls = 0;
globalThis.fetch = async (u) => {
  const url = String(u);
  if (url.endsWith("/free-model/claim")) { claimCalls++; return new Response(JSON.stringify({ success: true, data: { status: "claimed", free_until: 4_000_000_000 } }), { status: 200 }); }
  if (url.includes("/free-model")) return new Response(JSON.stringify({ success: true, data: { status: "available", visible: true } }), { status: 200 });
  throw new Error("unexpected " + url);
};
const first = await I.ensureFreeModel("tok", "u1");
const second = await I.ensureFreeModel("tok", "u1"); // 10 分钟内：不重复领，但状态必须还在
assert.ok(first, "第一次要返回状态");
assert.ok(second, "节流后也必须返回状态，不能是 null");
assert.equal(claimCalls, 1, "10 分钟内只应真正领取一次");
globalThis.fetch = origFetch;

console.log("✓ 全部通过");
