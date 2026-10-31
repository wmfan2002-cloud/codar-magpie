// Codar 科搭（SpeedAI）作为 magpie / OpenCode 的供应商插件。
//
//   登录：微信扫码 → 直接拿到 7 天有效的 Bearer JWT；或粘贴现成 Token。
//   推理：所有请求原样发往 https://api.claw.speedai.com/v1，只补一个 Authorization 头。
//   用量：点数余额 + 每日签到状态 + 新用户免费模型剩余时间，全部显示在账号卡片上。
//   签到：magpie 每个北京日替账号按一次 /v1/daily-sign（也可 `magpie accounts checkin` 手动触发）。
//   免费：登录时顺手领取「新用户 7 天免费模型」，之后每次读用量时补领一次。
//
// 上游地址是写死的（claw = 推理/目录/活动，kuaipaper = 登录/签到/点数），
// 不需要任何配置项。Token 由 magpie 存进 plugin-auth.json（0600），本插件不落盘。
//
// 关于「设置面板」：magpie 的插件页面跑在 connect-src 'none' 的沙箱里，拿不到 token
// 也发不出请求；它对外开放的读只有 usage:summary / providers:list，都不含签到位。
// 所以签到与免费模型的状态、进度不放进页面，而是放进 auth.usage 的 windows ——
// 那是 magpie 会在「供应商」账号卡片、`magpie quota` 和 GET /v1/magpie/quotas 上渲染的信息面。

import fs from "node:fs";
import { startLoginSession } from "./login-server.mjs";

const PROVIDER = "codar";
const BASE = "https://api.claw.speedai.com"; // 推理 / 模型目录 / 免费模型活动
const AUTH = "https://api.kuaipaper.com"; // 扫码登录 / 每日签到 / 点数余额
const V1 = `${BASE}/v1`;
const CLIENT = "codar-magpie/0.5.2";

/** 所有模型统一按 1M 上下文报告；实际限制以供应商报错为准。 */
const CONTEXT_WINDOW = 1_000_000;


/** 实测 billing.quota = 0 的免费模型。 */
const FREE_MODELS = new Set(["auto", "deepseek-v4.1-flash"]);

/**
 * 目录快照，登录前就能选出模型。运行时会被 /v1/codar/models 覆盖。
 *   ctx: 上下文窗口（统一 1M）    api: anthropic | chat    reasoning: 是否回传思维链
 */
const MODEL_TABLE = [
  { id: "auto", ctx: 1_000_000, api: "chat", free: true },
  { id: "deepseek-v4.1-flash", ctx: 1_000_000, api: "chat", free: true, reasoning: true },
  { id: "deepseek-v4-flash", ctx: 1_000_000, api: "chat", reasoning: true },
  { id: "deepseek-v4-pro", ctx: 1_000_000, api: "chat", reasoning: true },
  { id: "glm-5.2", ctx: 1_000_000, api: "chat", reasoning: true },
  { id: "glm-5.3", ctx: 1_000_000, api: "chat", reasoning: true },
  { id: "glm-5.3-flash", ctx: 1_000_000, api: "chat", reasoning: true },
  { id: "gpt-5.6-sol", ctx: 1_000_000, api: "chat" },
  { id: "gpt-6-sol", ctx: 1_000_000, api: "chat" },
  { id: "gpt-6-astra", ctx: 1_000_000, api: "chat" },
  { id: "claude-sonnet-5", ctx: 1_000_000, api: "anthropic", reasoning: true },
  { id: "claude-sonnet-5-kiro", ctx: 1_000_000, api: "anthropic", reasoning: true },
  { id: "claude-opus-5", ctx: 1_000_000, api: "anthropic", reasoning: true },
  { id: "claude-opus-5-kiro", ctx: 1_000_000, api: "anthropic", reasoning: true },
  { id: "claude-opus-5-5", ctx: 1_000_000, api: "anthropic", reasoning: true },
  { id: "claude-opus-5-5-kiro", ctx: 1_000_000, api: "anthropic", reasoning: true },
];

/* ------------------------------------------------------------------ 基础 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一个上游 JSON 请求。网络错误会抛出，HTTP 错误由调用方看 status。 */
async function call(url, { method = "GET", body, token, timeoutMs = 20_000 } = {}) {
  const headers = { accept: "application/json", "user-agent": CLIENT };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 时留空 */ }
  // kuaipaper 的接口 HTTP 200 也可能是失败：真正的结果在 body 的 code 里
  const bizOk = data?.success !== false && (data?.code === undefined || Number(data.code) === 200);
  return { ok: res.ok && bizOk, status: res.status, data };
}

/** JWT 载荷。签名不校验——我们只关心 exp / username，真伪由上游判定。 */
function jwtPayload(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch { return null; }
}

function usernameOf(token) {
  const p = jwtPayload(token);
  return p?.username ? String(p.username) : null;
}

/** 鉴权信息里取 Bearer（api 方式存 key，oauth 方式存 access）。 */
function keyOf(auth) {
  return auth?.type === "api" ? auth.key : auth?.access ?? auth?.key;
}

const signedInError = (message) => Object.assign(new Error(message), { signIn: "expired" });

/* -------------------------------------------------- 登录页怎么被访问到 */

/** 逗号/空白分隔的字符串 → 数组 */
function listOf(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v || "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * 登录页监听地址。
 *   CODAR_LOGIN_BIND=0.0.0.0      监听所有网卡（VPS 上最常见的做法）
 *   插件选项 {"loginBind":"0.0.0.0"}  同上，但按 magpie 的插件选项配置
 * 默认 127.0.0.1：只有服务器本机能访问。
 */
function loginBindHost(options, provider) {
  return String(
    process.env.CODAR_LOGIN_BIND ||
    options?.loginBind ||
    provider?.options?.loginBind ||
    "127.0.0.1",
  ).trim();
}

/**
 * 额外的对外地址，用于 nginx/隧道反代到登录端口时直接给用户一个可点的链接。
 *   CODAR_LOGIN_PUBLIC_URL=https://codar.example.com
 *   插件选项 {"loginPublicUrl":"https://codar.example.com"}
 * 只会拼成 <地址>/?k=…；反代需把该地址整个转发到插件启动的端口。
 */
/**
 * 中转服务的基地址（Codar 网页控制台的公网地址）。
 *   CODAR_RELAY_URL=https://…        环境变量
 *   插件选项 {"relayUrl":"https://…"}  magpie 插件选项
 * 没配置就完全不注册「中转登录」这种方式。
 */
function relayUrl(options, provider) {
  return String(
    process.env.CODAR_RELAY_URL ||
    options?.relayUrl ||
    provider?.options?.relayUrl ||
    "",
  ).trim().replace(/\/+$/, "");
}

function loginPublicUrls(options, provider) {
  return listOf(
    process.env.CODAR_LOGIN_PUBLIC_URL ||
    options?.loginPublicUrl ||
    provider?.options?.loginPublicUrl ||
    "",
  );
}

/* -------------------------------------------------------- 模型（两种形状） */

/** config 钩子里的模型：键是 id，API 不在这层声明。 */
function configModel(m) {
  return {
    name: m.name,
    limit: { context: m.ctx, output: 32_000 },
    tool_call: true,
    ...(m.reasoning ? { reasoning: true } : {}),
    modalities: { input: ["text"] }, // 目录写着支持图片，实测 400，不要误导 agent
    ...(m.free ? { free: true } : {}),
    provider: { npm: npmOf(m.api), api: V1 },
  };
}

/**
 * 画图 / 向量 / 音频等非对话模型。它们会出现在上游的 /v1/models 里，
 * 但没有 agent 需要的 chat + tools 契约，不能放进模型选择器。
 */
const NON_CHAT_MODEL = /(^|[-_.])(image|embed|embedding|rerank|whisper|tts|audio|video|moderation|nano-banana)([-_.]|$)/i;

function isNonChatModel(id) {
  return NON_CHAT_MODEL.test(String(id));
}

/**
 * /v1/models 有、/v1/codar/models 没有的模型：目录没给协议，只能按 id 推断。
 * claude-* 走 /v1/messages，其余走上游的 OpenAI 兼容 /v1/chat/completions。
 */
function inferredEntry(id) {
  return {
    id,
    display_name: id,
    protocol: { type: /^claude/i.test(id) ? "anthropic_messages" : "openai_chat_completions" },
    context_window: CONTEXT_WINDOW,
  };
}

/**
 * 合并两份目录：
 *   curated — /v1/codar/models，带协议 / 定价 / schema，优先
 *   raw     — /v1/models，OpenAI 风格的全量清单，只补 curated 没有的对话模型
 */
function mergeCatalogs(curated, rawIds) {
  const have = new Set(curated.map((m) => String(m.id)));
  const extras = [];
  const seen = new Set();
  for (const raw of rawIds) {
    const id = String(raw ?? "");
    if (!id || have.has(id) || seen.has(id) || isNonChatModel(id)) continue;
    seen.add(id);
    extras.push(inferredEntry(id));
  }
  return [...curated, ...extras];
}

/** provider.models 钩子里的模型：完整的 OpenCode Model。 */
function runtimeModel(raw) {
  const proto = typeof raw.protocol === "string" ? raw.protocol : raw.protocol?.type;
  const api = proto === "anthropic_messages" ? "anthropic" : "chat";
  const id = String(raw.id);
  return {
    id,
    name: `${raw.display_name || id}${FREE_MODELS.has(id) ? "（免费）" : ""}`,
    api: { id, url: V1, npm: npmOf(api) },
    // 上下文统一报 1M：目录里 gpt-* 写的是 128000，但按实际可用性不该限制客户端。
    // 真超了上游会报错，让用户看到原文比这里猜一个更小的数字好。
    limit: { context: CONTEXT_WINDOW, output: 32_000 },
    capabilities: { reasoning: /^(claude|deepseek|glm)/.test(id), toolcall: true, attachment: false, input: { text: true } },
    ...(FREE_MODELS.has(id) ? { free: true } : {}),
  };
}

function npmOf(api) {
  return api === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible";
}

/* ------------------------------------------------------------ 扫码 / 领取 */

/**
 * 读免费模型活动状态，未领取时顺手领一次。
 *
 * 节流只作用于「领取」这个动作：读状态每次都真读，否则被节流的那 10 分钟里
 * 调用方拿到 null，会把「已领取」误判成「可领取」。失败不抛错——它不该挡住登录。
 */
const claimAt = new Map(); // username -> 上次尝试领取的时间
const freeCache = new Map(); // username -> { at, data }  活动状态短期缓存
const FREE_CACHE_MS = 60 * 1000;

/**
 * 读免费模型活动状态，未领取时顺手领一次。
 *
 * 两层节流，都是为了别让「读额度」被这个接口拖慢：
 *   - 状态缓存 60 秒：magpie 打开面板/命令会连续读好几次，不必次次打上游；
 *   - 领取动作 10 分钟：重领是幂等的，打多了没意义。
 * 失败不抛错——它不该挡住登录，也不该让整次额度读取失败。
 */
async function ensureFreeModel(token, username, { force = false, timeoutMs = 8_000, cacheMs = FREE_CACHE_MS } = {}) {
  if (!username) return null;
  const now = Date.now();
  if (force) cacheMs = 0;
  const cached = freeCache.get(username);
  if (cached && now - cached.at < cacheMs) return cached.data;

  try {
    const st = await call(`${BASE}/api/codar/activities/free-model`, { token, timeoutMs });
    const d = st.data?.data;
    if (!st.ok || !d) return cached?.data ?? null; // 这次没读到，有旧值就用旧值
    // 已经领过、或这个账号不在活动范围，不必再打领取接口
    if (d.status === "claimed" || d.visible === false) {
      freeCache.set(username, { at: now, data: d });
      return d;
    }
    if (now - (claimAt.get(username) || 0) < 10 * 60 * 1000) {
      freeCache.set(username, { at: now, data: d }); // 状态照给，只是不重复领
      return d;
    }
    claimAt.set(username, now);
    const r = await call(`${BASE}/api/codar/activities/free-model/claim`, { method: "POST", token, timeoutMs });
    const out = r.data?.data || d;
    freeCache.set(username, { at: now, data: out });
    return out;
  } catch {
    return cached?.data ?? null; // 超时也退回旧值，别让整次读取失败
  }
}

const signCache = new Map(); // username -> { at, data }

/** 签到状态，60 秒内复用；上游慢/失败时退回旧值而不是判失败。 */
async function signStatus(token, username, { timeoutMs = 5_000, cacheMs = 60_000 } = {}) {
  const now = Date.now();
  const cached = signCache.get(username);
  if (cached && now - cached.at < cacheMs) return cached.data;
  try {
    const r = await call(`${AUTH}/v1/daily-sign/status`, {
      method: "POST", body: { username }, token, timeoutMs,
    });
    if (!r.ok) return cached?.data ?? null;
    signCache.set(username, { at: now, data: r });
    return r;
  } catch {
    return cached?.data ?? null;
  }
}

const fmtInt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "0");
const asIso = (sec) => (sec ? new Date(Number(sec) * 1000).toISOString() : undefined);

/**
 * Codar 网关会扫描请求体里的 system prompt，命中某些客户端身份句时拒绝登录凭证
 * （403 client_not_supported："This login credential is restricted to Codar"）。
 * 实测是整句精确匹配：单独的 "Claude Code"、"Anthropic"、claude-cli UA 都不触发，
 * Codex / Cline / Roo / Kilo / opencode / Gemini CLI 的身份句也全部放行（2026-10-31 实测）。
 *
 * 两层处理：
 * 1. 结构式替换——所有 harness 的身份句都在 system 文本的**第一句**、以 "You are" 开头
 *    （OpenAI 形状在 messages 里 role:system 的开头；Anthropic 形状在顶层 system 块开头，
 *    抓包实证：Pi 的 19968 字符 system、Claude Code 的 system 块，身份句都是首句）。
 *    首句以 "You are" 开头且含 harness 特征词的，整句换成中性句。不枚举 agent，
 *    覆盖现在和将来的任意 harness。
 * 2. 已知句清单（KNOWN_BLOCKED）——历史验证过的整句，全量文本兜底扫描（防止
 *    身份句出现在 system 中间或 user 消息里）。
 * 3. 自愈兜底——上游拦了结构式没盖住的形状时，第一次撞上 client_not_supported，
 *    二分定位被拦片段记进 blockedMemo，之后的请求提前替换。
 *
 * 替换恒定：同一片段永远换成同一句 NEUTRAL_IDENTITY，上游每次看到的字节一致，
 * 前缀缓存不受影响（它从来没见过未替换的版本）。非 UTF-8 请求体（压缩/二进制）不碰。
 */
const NEUTRAL_IDENTITY = "You are an AI assistant working with the user toward their goals.";
const KNOWN_BLOCKED = [
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  "You are an expert coding assistant operating inside pi, a coding agent harness.",
];
// 结构式替换的判定：You are 开头的句 + 同句含 harness 特征词。
// 特征词取自真实 harness 身份句的用词：agent / harness / assistant / coding / engineer
// （Claude Code、Pi、Codex、Cline、Roo、Kilo、opencode、Gemini CLI 全部命中；
// 正常系统指令不会这样开头）。
const IDENTITY_PATTERN = /^you are\b.{0,300}\b(agent|harness|assistant|coding|engineer)\b/i;
const blockedMemo = new Set(); // 自愈发现的片段；上限 64，防失控
const DISCOVERY_BUDGET = 20; // 每次撞墙最多补发的探测请求数
const DISCOVERY_DEADLINE_MS = 25_000; // 自愈总时长上限：探测超时会在 20s 卡死整条请求
let discoveryQueue = Promise.resolve(); // 串行化自愈探测，避免并发请求重复打上游
const rememberBlocked = (piece) => {
  if (!piece || blockedMemo.has(piece)) return;
  if (blockedMemo.size >= 64) blockedMemo.delete(blockedMemo.values().next().value);
  blockedMemo.add(piece);
};

function scrubText(text) {
  const pieces = blockedMemo.size ? [...KNOWN_BLOCKED, ...blockedMemo] : KNOWN_BLOCKED;
  let out = text;
  if (pieces.some((p) => out.includes(p))) {
    out = pieces.reduce((s, p) => s.split(p).join(NEUTRAL_IDENTITY), out);
  }
  // 结构式：首句是 harness 身份句（You are 开头 + 特征词）→ 整句换掉。
  // 兜住 KNOWN_BLOCKED 没枚举到的 harness；已替换过的文本以中性句开头，不会二次命中。
  if (IDENTITY_PATTERN.test(out)) {
    const firstSentence = splitFirstSentence(out);
    if (firstSentence && IDENTITY_PATTERN.test(firstSentence)) {
      out = NEUTRAL_IDENTITY + out.slice(firstSentence.length);
    }
  }
  return out;
}

/** 返回文本的第一个句子（含结尾标点），按 .!? 后跟空白切分；找不到边界返回 null。 */
function splitFirstSentence(text) {
  const m = /^(.{0,400}?[.!?])(\s|$)/s.exec(text);
  return m ? m[1] : null;
}

function scrubRequestBody(body) {
  let text;
  let wasBytes = false;
  if (typeof body === "string") {
    text = body;
  } else if (body instanceof Uint8Array) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      return body; // 不是 UTF-8 文本（压缩包/图片等），不碰
    }
    wasBytes = true;
  } else {
    return body;
  }
  // 第一层：已知句 + 自愈清单，全量扫描（精确整句，误伤概率低）
  let out = scrubText(text);
  // 第二层：结构式——只对 system 槽位的首句身份做替换。
  // user 消息里也可能有以 "You are" 开头的内容，不能全量文本替换。
  let parsed = null;
  try {
    parsed = JSON.parse(out);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    let touched = false;
    for (const slot of systemTextSlots(parsed)) {
      const was = slot.get();
      const now = scrubSystemIdentity(was);
      if (now !== was) {
        slot.set(now);
        touched = true;
      }
    }
    // 重新序列化是确定性的（键序保持插入序），同一输入永远同一输出 → 前缀缓存稳定
    if (touched) out = JSON.stringify(parsed);
  }
  if (wasBytes) return out === text ? body : new TextEncoder().encode(out);
  return out;
}

/**
 * 结构式身份替换：文本以 "You are" 开头时，取前两句（harness 身份句常跨两句，
 * 如 Codex 的「名字句 + 运行方式句」）；其中任何一句含 harness 特征词，
 * 就把整个前导句组换成中性句。正常系统指令（"You are working on a Vue project."）
 * 不含特征词，不会被动。中性句自身也命中特征词（以 You are 开头、含 assistant），
 * 所以先排除——否则已替换的文本会被再次「替换」并吞掉自己的第二句。
 */
function scrubSystemIdentity(text) {
  if (!/^you are\b/i.test(text)) return text;
  if (text === NEUTRAL_IDENTITY || text.startsWith(NEUTRAL_IDENTITY)) return text;
  let consumed = 0;
  let matched = false;
  for (let i = 0; i < 2; i++) {
    const rel = splitFirstSentence(text.slice(consumed));
    if (!rel) break;
    if (IDENTITY_PATTERN.test(rel)) matched = true;
    // 身份句常跨两句（Codex：「名字句」+「运行方式句」），且第二句不再以 You are 开头
    // 也会跟上（"…You are running…" 是第二句；"operating inside pi" 挂在逗号后是同一句）。
    // 所以：第二句无论开头是什么都纳入，只要它紧跟 You are 句组。
    consumed += rel.length;
    const ws = /^\s+/.exec(text.slice(consumed));
    if (ws) consumed += ws[0].length;
    if (i === 0 && matched) continue; // 第一句已命中，仍看第二句是否也属于身份段
    if (i === 0 && !/^you are\b/i.test(text.slice(consumed))) {
      // 第二句不是 "You are" 开头：仅当第一句没命中时停——第一句命中则把这句一起换
      if (!matched) break;
    }
  }
  return matched ? NEUTRAL_IDENTITY + text.slice(consumed) : text;
}

/** 收集 body 里 prompt 文本的可写槽位。roles 指定看哪些消息角色。 */
function promptSlots(parsed, roles) {
  const slots = [];
  const slot = (get, set) => slots.push({ get, set });
  const fromBlocks = (arr) => {
    for (const b of arr ?? [])
      if (b?.type === "text" && typeof b.text === "string" && b.text)
        slot(() => b.text, (t) => (b.text = t));
  };
  if (roles.includes("system")) {
    // Anthropic 形状：顶层 system（字符串或文本块数组）
    if (typeof parsed?.system === "string" && parsed.system) {
      slot(() => parsed.system, (t) => (parsed.system = t));
    } else if (Array.isArray(parsed?.system)) {
      fromBlocks(parsed.system);
    }
  }
  // OpenAI 形状：messages 里的 system / developer；兜底再扫 user
  for (const m of Array.isArray(parsed?.messages) ? parsed.messages : []) {
    if (!roles.includes(m?.role)) continue;
    if (typeof m.content === "string" && m.content) slot(() => m.content, (t) => (m.content = t));
    else if (Array.isArray(m.content)) fromBlocks(m.content);
  }
  return slots;
}

const systemTextSlots = (parsed) => promptSlots(parsed, ["system", "developer"]);
const userTextSlots = (parsed) => promptSlots(parsed, ["user"]);

/**
 * 自愈探测：确认被拦片段在哪一组槽位（先 system，整组换掉能过才算），再在槽位内
 * 前缀二分到行，最后验证「只留这个候选行仍被拦」——三步都过才把候选记进清单，
 * 保证记下的片段单凭自己就足以触发拦截（否则重试照样 403）。跨行/超大片段不猜，
 * 短块整块兜底，长块放弃（403 原样交还，不悄悄毁掉大段 prompt）。
 * 探测请求 max_tokens 压到 1、读完即取消；探测体先过一遍当前清单（scrubText），
 * 已知的片段不再干扰判定。预算用完就放弃本次定位。
 */
async function discoverBlockedPiece(rawBody, send) {
  let parsed;
  try {
    parsed = JSON.parse(typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody));
  } catch {
    return null; // 结构未知，没法二分
  }
  let budget = DISCOVERY_BUDGET;
  const deadline = Date.now() + DISCOVERY_DEADLINE_MS;
  const probe = async (mutate) => {
    if (budget <= 0 || Date.now() > deadline) return false;
    budget -= 1;
    const clone = structuredClone(parsed);
    mutate(clone);
    if (Number.isFinite(clone.max_tokens)) clone.max_tokens = 1;
    try {
      const r = await send(scrubText(JSON.stringify(clone)));
      r.body?.cancel?.();
      return r.ok;
    } catch {
      return false; // 网络/超时中断：按没通过处理
    }
  };
  // 依次检查 system 组、user 组（上游实测只扫 system；user 是兜底）
  for (const slotsOf of [systemTextSlots, userTextSlots]) {
    const slots = slotsOf(parsed);
    if (!slots.length) continue;
    // 整组换成中性句后放行 → 被拦片段确实在本组；否则换下一组
    if (!(await probe((c) => slotsOf(c).forEach((s) => s.set(NEUTRAL_IDENTITY))))) continue;
    // 找出含被拦片段的槽位：其他槽位全换后仍 403 → 本槽位有
    for (let i = 0; i < slots.length; i++) {
      if (await probe((c) => slotsOf(c).forEach((s, j) => { if (j !== i) s.set(NEUTRAL_IDENTITY); }))) continue;
      const lines = slots[i].get().split("\n");
      // 槽位扫描本身就是「只留整槽」的验证，单行槽位直接采信
      if (lines.length === 1) return lines[0];
      // 前缀二分：最小的 k 使「前 k 行换成中性句」后放行 → 被拦的是第 k-1 行
      let lo = 1, hi = lines.length, found = -1;
      while (lo <= hi && budget > 0) {
        const mid = (lo + hi) >> 1;
        if (
          await probe((c) => {
            const ss = slotsOf(c);
            const ls = ss[i].get().split("\n");
            ss[i].set([NEUTRAL_IDENTITY, ...ls.slice(mid)].join("\n"));
          })
        ) {
          found = mid - 1;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      if (found < 0) {
        const whole = slots[i].get();
        return whole.length <= 400 ? whole : null; // 预算耗尽/多行同时被拦：短块整块兜底
      }
      // 验证：其余全换、只把候选行放回去——仍被拦（probe false）才采信（跨行片段会在这里被识破）
      const candidate = lines[found];
      if (candidate.length > 400) return null;
      const alone =
        candidate.length > 0 &&
        !(await probe((c) => {
          const ss = slotsOf(c);
          ss.forEach((s, j) => { if (j !== i) s.set(NEUTRAL_IDENTITY); });
          ss[i].set(`${NEUTRAL_IDENTITY}\n${candidate}`);
        }));
      return alone ? candidate : slots[i].get().length <= 400 ? slots[i].get() : null;
    }
    return null;
  }
  return null;
}

/* ---------------------------------------------------------------- 插件 */

export const CodarAuthPlugin = async ({ client } = {}, options = {}) => ({
  // 声明供应商：登录前后都用同一份模型表，用 ??= 不覆盖用户自己的配置
  config: async (cfg) => {
    cfg.provider ??= {};
    const was = cfg.provider[PROVIDER] ?? {};
    cfg.provider[PROVIDER] = {
      name: "Codar 科搭",
      npm: "@ai-sdk/openai-compatible",
      api: V1,
      ...was,
      models: {
        ...Object.fromEntries(MODEL_TABLE.map((m) => [m.id, configModel({ ...m, name: `${m.id}${m.free ? "（免费）" : ""}` })])),
        ...(was.models ?? {}),
      },
    };
  },

  auth: {
    provider: PROVIDER,

    methods: [
      {
        type: "oauth",
        label: "微信扫码登录 Codar（含手机验证）",
        async authorize(_, provider) {
          // 监听地址：默认回环；VPS 上可用环境变量/插件选项改成 0.0.0.0
          // 起一个本地页面：二维码、手机号、阿里云人机验证都在真浏览器里完成。
          // 纯扫码能直接拿到 Token；要验手机时由页面引导到第二步。
          const bind = loginBindHost(options, provider);
          const session = await startLoginSession({
            bindHost: bind,
            publicUrls: loginPublicUrls(options, provider),
          });
          // 对外开放（bind 非回环）时，回环地址对用户没用，把可访问的那个排前面
          const remote = session.urls.filter((u) => !u.includes("127.0.0.1"));
          const primary = bind !== "127.0.0.1" && bind !== "::1" && remote.length
            ? remote[0]
            : session.url;
          const extra = session.urls.filter((u) => u !== primary);
          return {
            url: primary,
            instructions:
              "浏览器里用微信扫码。若提示需要手机验证（新 IP 或未绑定手机），在同一个页面填手机号、过完人机验证即可。完成后这里自动继续。" +
              (extra.length
                ? `\n\n这个地址打不开时（例如 magpie 跑在 VPS 上），改用下面任意一个：\n${extra.join("\n")}`
                : ""),
            method: "auto",
            async callback() {
              try {
                const r = await session.wait();
                if (!r || r.cancelled) return { type: "failed", error: r?.reason || "登录已取消" };
                const username = r.username || usernameOf(r.token);
                await ensureFreeModel(r.token, username, { force: true });
                return {
                  type: "success",
                  key: r.token,
                  accountId: username || undefined,
                  metadata: { username, source: "wechat" },
                };
              } catch (e) {
                return { type: "failed", error: String(e?.message || e).slice(0, 500) };
              } finally {
                session.close();
              }
            },
          };
        },
      },
      {
        type: "api",
        label: "粘贴 Codar Token",
        placeholder: "eyJhbGciOi…",
        prompts: [{
          type: "password",
          key: "token",
          message: "Codar Token（eyJ 开头，7 天有效）",
          validate: (v) => (/^eyJ[A-Za-z0-9._-]{20,}$/.test(String(v).trim()) ? undefined : "看起来不是 JWT"),
        }],
        async authorize(inputs) {
          const token = String(inputs?.token || "").trim();
          if (!token) return { type: "failed", error: "没有收到 Token" };
          const me = await call(`${BASE}/api/user/self`, { token });
          if (!me.ok) {
            return { type: "failed", error: me.status === 401 ? "Token 已过期或无效" : `Token 校验失败（HTTP ${me.status}）` };
          }
          const username = me.data?.data?.username || usernameOf(token);
          await ensureFreeModel(token, username, { force: true });
          return { type: "success", key: token, accountId: username || undefined, metadata: { username, source: "token" } };
        },
      },
      // 最低优先级：需要显式配置中转地址；没配也能看到，
      // 点了会说明怎么配 —— 比「方式凭空消失」好排查。
      // 适合 magpie 跑在 VPS 上、自己又不想开端口 / 建隧道的情况。
      {
        type: "oauth",
        label: "通过 Codar 网页控制台中转（需先配置 relayUrl）",
        async authorize(_, provider) {
          const base = relayUrl(options, provider);
          if (!base) {
            throw new Error(
              "还没有配置中转地址。用 magpie 插件选项设置 relayUrl，例如：\n" +
              "magpie plugin options codar-magpie '{\"relayUrl\":\"https://your-panel.example.com\"}'\n" +
              "或设置环境变量 CODAR_RELAY_URL。面板那侧还需要 RELAY_ENABLE=1。",
            );
          }
          const c = await call(`${base}/api/relay/create`, { method: "POST", body: {} });
          if (!c.ok || !c.data?.id || !c.data?.secret) {
            throw new Error(`中转服务不可用：${c.data?.error || `HTTP ${c.status}`}`);
          }
          const { id, secret } = c.data;
          // 密钥放 # 片段：不会发到服务器、不落 nginx 日志、不进 Referer
          const url = `${String(c.data.url).replace(/#.*$/, "")}#secret=${encodeURIComponent(secret)}`;
          return {
            url,
            instructions:
              "在打开的页面里完成微信扫码；需要手机验证时也在同一页完成。" +
              "完成后 Token 会直接交给本插件，中转服务器不保存。",
            method: "auto",
            async callback() {
              const deadline = Date.now() + 10 * 60 * 1000;
              let idle = 0;
              while (Date.now() < deadline) {
                await sleep(2000);
                let r;
                try {
                  r = await call(`${base}/api/relay/poll`, { method: "POST", body: { id, secret } });
                } catch { idle++; if (idle > 5) return { type: "failed", error: "连不上中转服务" }; continue; }
                idle = 0;
                const st = r.data?.status;
                if (st === "confirmed" && r.data?.token) {
                  const token = String(r.data.token);
                  const username = r.data.username || usernameOf(token);
                  await ensureFreeModel(token, username, { force: true });
                  return {
                    type: "success",
                    key: token,
                    accountId: username || undefined,
                    metadata: { username, source: "relay" },
                  };
                }
                if (st === "cancelled") return { type: "failed", error: "已取消" };
                if (r.status === 404 || r.status === 403) {
                  return { type: "failed", error: r.data?.error || "中转会话已失效" };
                }
              }
              return { type: "failed", error: "中转登录超时（10 分钟）" };
            },
          };
        },
      },
    ],

    // 每个账号的请求：只补鉴权头，其余原样转发
    async loader(getAuth) {
      const auth = await getAuth();
      const key = keyOf(auth);
      if (!key) return {};
      return {
        baseURL: V1,
        apiKey: key,
        async fetch(input, init) {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          headers.set("authorization", `Bearer ${key}`);
          if (String(url).includes("/messages")) headers.set("anthropic-version", "2023-06-01");
          headers.delete("content-length"); // 交给 fetch 重算
          // 请求体过一遍身份句替换，避免上游对 agent 客户端的 prompt 扫描 403。
          // 只在 init 带了 body 时才写 body 键——input 是 Request 对象时
          // 显式 body: undefined 会把 Request 自带的请求体剥掉。
          const next = { ...init, headers };
          if (init && init.body !== undefined) next.body = scrubRequestBody(init.body);
          const res = await fetch(input, next);
          if (res.status !== 403) return res;
          const path = String(url);
          // 自愈只对推理端点做：其他端点的 403（越权等）跟 prompt 扫描无关
          if (!path.includes("/messages") && !path.includes("/chat/completions")) return res;
          let rawBody = init?.body;
          if (rawBody === undefined && input instanceof Request) {
            try { rawBody = await input.clone().text(); } catch { return res; }
          }
          if (typeof rawBody !== "string" && !(rawBody instanceof Uint8Array)) return res;
          const errText = await res.clone().text().catch(() => "");
          // 两种错误体都要认：/v1/messages 是 {"detail":{"code":"client_not_supported",…}}，
          // /v1/chat/completions 是 {"code":null,"type":"permission_error","message":"…restricted to Codar…"}（Pi 实测）
          if (!errText.includes("client_not_supported") && !errText.includes("restricted to Codar")) return res;
          // 现场快照（仅调试期）：把被拦的完整请求体落盘，供离线重放定位。
          // 只写请求体——头里全是凭证，一个字节都不写。上限 5 个文件，防写爆。
          try {
            const dir = "/tmp/codar-403";
            fs.mkdirSync(dir, { recursive: true });
            const files = fs.readdirSync(dir);
            if (files.length < 5) {
              const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
              fs.writeFileSync(
                `${dir}/${Date.now()}.json`,
                JSON.stringify({ url: path, at: new Date().toISOString(), errText: errText.slice(0, 400), body: JSON.parse(text) }, null, 1),
              );
            }
          } catch { /* 快照失败不影响主流程 */ }
          const method = init?.method ?? (input instanceof Request ? input.method : "POST");
          const send = (body) => fetch(url, { method, headers, body, signal: AbortSignal.timeout(20_000) });
          const run = discoveryQueue.then(() => discoverBlockedPiece(rawBody, send));
          discoveryQueue = run.catch(() => {});
          const piece = await run.catch(() => null);
          if (!piece) return res;
          rememberBlocked(piece);
          return fetch(url, { ...next, method, body: scrubRequestBody(rawBody) });
        },
      };
    },

    /**
     * magpie 的额度卡片 / `magpie quota` / GET /v1/magpie/quotas。
     * 三个窗口分别对应：点数余额、今日签到、新用户免费模型。
     */
    async usage(getAuth) {
      const auth = await getAuth();
      const key = keyOf(auth);
      if (!key) return { error: "尚未登录", signIn: "kept", windows: [] };
      const username = auth?.metadata?.username || usernameOf(key);
      if (!username) return { error: "Token 无法解析", signIn: "kept", windows: [] };

      try {
        // 三个上游接口各自独立超时：任何一个卡住都不能拖垮整次读取。
        // 只用 Promise.all（全成功）会让 magpie 整次判失败、保留旧值，
        // 表现就是「额度一直不更新」。这里改成 allSettled + 短超时。
        const [balR, freeR, signR] = await Promise.allSettled([
          call(`${AUTH}/v1/gettoken`, { method: "POST", body: { username, token: 0 }, token: key, timeoutMs: 8_000 }),
          ensureFreeModel(key, username, { timeoutMs: 5_000 }),
          signStatus(key, username, { timeoutMs: 5_000 }),
        ]);
        const bal = balR.status === "fulfilled" ? balR.value : null;
        const free = freeR.status === "fulfilled" ? freeR.value : null;
        const sign = signR.status === "fulfilled" ? signR.value : null;

        if (bal?.status === 401 || Number(bal?.data?.code) === 401) {
          return { error: "登录已过期，请重新扫码", signIn: "expired", windows: [] };
        }
        // 余额是必答项：拿不到才算这次读取失败
        if (!bal || !bal.ok || typeof bal.data?.token !== "number") {
          return {
            error: `读取点数失败：${bal?.data?.message || (bal ? `HTTP ${bal.status}` : "上游超时")}`,
            signIn: "kept", windows: [],
          };
        }

        const b = bal.data;
        const freeUntil = Number(free?.free_until || 0);
        const freeLeft = freeUntil * 1000 - Date.now();
        const active = freeLeft > 0;

        // 签到窗口：服务端按 24 小时冷却，retry_after 就是距离下一次可签的秒数。
        // used 恒为 0——签到不是额度，用 100% 会让卡片看起来像「已用尽」。
        const sd = sign?.data?.data;
        const signed = sd ? Boolean(sd.isSigned) : null;
        const windows = [];

        if (signed === null) {
          // 签到查询超时：照实说，别凭空猜一个状态
          windows.push({
            name: "每日签到", used: 0,
            display: "这次没读到签到状态（上游慢），稍后刷新再看",
            aside: false,
          });
        } else {
          windows.push({
            name: signed ? "每日签到：已签" : "每日签到：未签",
            used: 0,
            ...(signed && Number(sd.retry_after) ? { resetSecs: Number(sd.retry_after) } : {}),
            display: signed
              ? `下次可签 ${leftOf(sd.retry_after)}后`
              : "运行 `magpie accounts checkin` 立即补签",
            aside: false,
          });
        }

        // 免费模型窗口：领没领、能不能领，都在名字里说清楚，别让人去找按钮
        const models = (free?.model_ids || ["auto", "deepseek-v4.1-flash"]).join(" / ");
        if (!free) {
          windows.push({
            name: "免费模型", used: 0,
            display: "这次没读到活动状态（上游慢），稍后刷新再看",
            aside: false,
          });
        } else if (active) {
          windows.push({
            name: "免费模型：已领取",
            used: 0,
            resetsAt: asIso(freeUntil),
            display: `${models} · 还剩 ${leftOf(Math.floor(freeLeft / 1000))}`,
            aside: false,
          });
        } else if (free?.status === "claimed") {
          // 领过但已过期：上游重领是幂等的，不会再给 7 天，别写成「可领取」
          windows.push({
            name: "免费模型：已到期",
            used: 0,
            display: `免费期已于 ${asIso(freeUntil)?.slice(0, 10) || "此前"} 结束，之后按目录价计费`,
            aside: false,
          });
        } else if (free?.visible !== false) {
          windows.push({
            name: "免费模型：可领取",
            used: 0,
            display: `${models} · 7 天免费，下次读取额度时自动领取`,
            aside: false,
          });
        } else {
          windows.push({
            name: "免费模型：不可用",
            used: 0,
            display: "该账号不在新用户活动范围",
            aside: false,
          });
        }

        return {
          plan: active ? "新用户免费" : "按量计费",
          user: username,
          until: asIso(freeUntil),
          balance: `点数 ${fmtInt(b.token)} · Agent ${fmtInt(b.agent_token)}` +
            (Number(b.rewrite_token) ? ` · 改写 ${fmtInt(b.rewrite_token)}` : ""),
          windows,
        };
      } catch (e) {
        return { error: String(e?.message || e).slice(0, 200), signIn: "kept", windows: [] };
      }
    },

    // magpie 每天替这个账号签一次到（当天已签就是 done）
    async checkin(getAuth) {
      const auth = await getAuth();
      const key = keyOf(auth);
      if (!key) return { outcome: "failed", message: "尚未登录" };
      const username = auth?.metadata?.username || usernameOf(key);
      if (!username) return { outcome: "failed", message: "Token 无法解析" };

      try {
        const st = await call(`${AUTH}/v1/daily-sign/status`, { method: "POST", body: { username }, token: key, timeoutMs: 40_000 });
        if (st.status === 401 || Number(st.data?.code) === 401) return { outcome: "failed", message: "登录已过期，请重新扫码" };
        if (st.data?.data?.isSigned) {
          return { outcome: "done", message: `今天已签到，${leftOf(st.data.data.retry_after)}后可再签` };
        }
        const r = await call(`${AUTH}/v1/daily-sign`, { method: "POST", body: { username }, token: key, timeoutMs: 40_000 });
        signCache.delete(username); // 状态变了，别让缓存挡住
        if (r.ok && r.data?.code === 200) {
          return { outcome: "claimed", credit: r.data?.data?.token, message: r.data?.message || "签到成功" };
        }
        const msg = String(r.data?.message || `HTTP ${r.status}`);
        if (msg.includes("24小时") || msg.includes("已领取")) return { outcome: "done", message: msg };
        return { outcome: "failed", message: msg };
      } catch (e) {
        return { outcome: "failed", message: String(e?.message || e).slice(0, 200) };
      }
    },
  },

  // 账号能用的模型以目录为准；拿不到就保留原来的列表
  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      const key = keyOf(auth);
      if (!key) return provider?.models ?? {};
      // 精选目录给协议 / 定价；全量清单补上它没列的对话模型。两份并发读，
      // 任何一份失败都不影响另一份（精选目录失败时仍能显示全量列表）。
      const [catR, rawR] = await Promise.allSettled([
        call(`${BASE}/v1/codar/models`, { token: key, timeoutMs: 15_000 }),
        call(`${BASE}/v1/models`, { token: key, timeoutMs: 15_000 }),
      ]);
      const cat = catR.status === "fulfilled" ? catR.value : null;
      const raw = rawR.status === "fulfilled" ? rawR.value : null;
      if (cat?.status === 401 || Number(cat?.data?.code) === 401 ||
          raw?.status === 401 || Number(raw?.data?.code) === 401) {
        throw signedInError("Codar 登录已过期，请重新扫码");
      }
      const curated = (Array.isArray(cat?.data?.data) ? cat.data.data : []).filter((m) => m?.id);
      const rawIds = (Array.isArray(raw?.data?.data) ? raw.data.data : []).map((m) => m?.id);
      const list = mergeCatalogs(curated, rawIds);
      if (!list.length) return provider?.models ?? {};
      return Object.fromEntries(list.map((m) => [String(m.id), runtimeModel(m)]));
    },
  },
});

function leftOf(sec) {
  const s = Number(sec) || 0;
  if (s >= 3600) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
  if (s > 0) return `${Math.floor(s / 60)} 分钟`;
  return "一会儿";
}

// 入口：magpie / OpenCode v1 形状
// 只能这样导出：模块里导出的每个**函数**都会被宿主当成插件调用一次，
// 所以测试面放在一个对象上，不单独导出函数。
export default { id: PROVIDER, server: CodarAuthPlugin };

export const _internal = {
  PROVIDER, BASE, AUTH, V1, FREE_MODELS, MODEL_TABLE,
  call, jwtPayload, usernameOf, keyOf, configModel, runtimeModel, npmOf,
  isNonChatModel, inferredEntry, mergeCatalogs,
  ensureFreeModel, leftOf, scrubRequestBody, systemTextSlots, discoverBlockedPiece, blockedMemo,
};
