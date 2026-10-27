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
