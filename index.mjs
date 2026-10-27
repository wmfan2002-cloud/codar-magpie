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

const PROVIDER = "codar";
const BASE = "https://api.claw.speedai.com"; // 推理 / 模型目录 / 免费模型活动
const AUTH = "https://api.kuaipaper.com"; // 扫码登录 / 每日签到 / 点数余额
const V1 = `${BASE}/v1`;
const CLIENT = "opencode-codar-auth/0.1.0";

/** 实测 billing.quota = 0 的免费模型。 */
const FREE_MODELS = new Set(["auto", "deepseek-v4.1-flash"]);

/**
 * 目录快照，登录前就能选出模型。运行时会被 /v1/codar/models 覆盖。
 *   ctx: 上下文窗口    api: anthropic | chat    reasoning: 是否回传思维链
 */
const MODEL_TABLE = [
  { id: "auto", ctx: 1_000_000, api: "chat", free: true },
  { id: "deepseek-v4.1-flash", ctx: 1_000_000, api: "chat", free: true, reasoning: true },
  { id: "deepseek-v4-flash", ctx: 1_000_000, api: "chat", reasoning: true },
  { id: "deepseek-v4-pro", ctx: 1_000_000, api: "chat", reasoning: true },
  { id: "glm-5.2", ctx: 1_000_000, api: "chat", reasoning: true },
  { id: "glm-5.3", ctx: 1_000_000, api: "chat", reasoning: true },
  { id: "glm-5.3-flash", ctx: 1_000_000, api: "chat", reasoning: true },
  { id: "gpt-5.6-sol", ctx: 128_000, api: "chat" },
  { id: "gpt-6-sol", ctx: 128_000, api: "chat" },
  { id: "gpt-6-astra", ctx: 128_000, api: "chat" },
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

/** provider.models 钩子里的模型：完整的 OpenCode Model。 */
function runtimeModel(raw) {
  const proto = typeof raw.protocol === "string" ? raw.protocol : raw.protocol?.type;
  const api = proto === "anthropic_messages" ? "anthropic" : "chat";
  const id = String(raw.id);
  return {
    id,
    name: `${raw.display_name || id}${FREE_MODELS.has(id) ? "（免费）" : ""}`,
    api: { id, url: V1, npm: npmOf(api) },
    limit: { context: Number(raw.context_window) || 1_000_000, output: 32_000 },
    capabilities: { reasoning: /^(claude|deepseek|glm)/.test(id), toolcall: true, attachment: false, input: { text: true } },
    ...(FREE_MODELS.has(id) ? { free: true } : {}),
  };
}

function npmOf(api) {
  return api === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible";
}

/* ------------------------------------------------------------ 扫码 / 领取 */

const QR_OK = new Set(["confirmed", "success", "logged_in"]);
const QR_BAD = new Set(["expired", "cancelled", "canceled", "rejected"]);
const QR_PHONE = new Set([
  "ip_verify_required", "required_ip_verify", "ip_verify", "require_ip_verify",
  "bind_phone_required", "required_bind_phone", "bind_phone", "require_phone_binding",
]);

/**
 * 生成二维码并等扫码。上游 status 是 15 秒长轮询，所以这里不 sleep，直接连着等。
 * 返回 { token, username } 或抛出可读的错误。
 */
async function wechatScan({ deadlineMs = 5 * 60 * 1000 } = {}) {
  const qr = await call(`${AUTH}/v1/wechat/login/qrcode`, { method: "POST", body: {} });
  const scene = qr.data?.data?.scene;
  const qrUrl = qr.data?.data?.qr_url;
  if (!scene || !qrUrl) throw new Error(`二维码生成失败：${qr.data?.message || `HTTP ${qr.status}`}`);

  const deadline = Date.now() + deadlineMs;
  let unknown = 0;
  while (Date.now() < deadline) {
    let st;
    try {
      st = await call(`${AUTH}/v1/wechat/login/status`, {
        method: "POST", body: { scene }, timeoutMs: 40_000,
      });
    } catch {
      await sleep(2000); // 网络抖动，继续等
      continue;
    }
    const d = st.data?.data || {};
    const status = String(d.status || "").toLowerCase();
    const mode = String(d.mode || "").toLowerCase();

    if (QR_OK.has(status) && d.token) {
      return { token: String(d.token), username: d.username ? String(d.username) : usernameOf(d.token) };
    }
    if (QR_BAD.has(status)) throw new Error(`扫码未完成（${status}），请重试`);
    if (QR_PHONE.has(status) || QR_PHONE.has(mode)) {
      throw new Error("该账号需要手机号验证（新 IP 或未绑手机）。请在 Codar 网页控制台完成这次登录，再用「粘贴 Token」方式添加账号。");
    }
    // 场景失效是上游用件内 code 404 表达的，不是 HTTP 404
    if (!st.ok && Number(st.data?.code) === 404) throw new Error("二维码已失效，请重新登录");
    if (status === "pending" || status === "waiting" || status === "scanned" || !status) {
      unknown = 0;
      continue;
    }
    if (++unknown > 5) throw new Error(`扫码状态无法识别：${status}`);
  }
  throw new Error("扫码超时（5 分钟），请重试");
}

/**
 * 读免费模型活动状态，未领取时顺手领一次。
 *
 * 节流只作用于「领取」这个动作：读状态每次都真读，否则被节流的那 10 分钟里
 * 调用方拿到 null，会把「已领取」误判成「可领取」。失败不抛错——它不该挡住登录。
 */
const claimAt = new Map(); // username -> 上次尝试领取的时间
async function ensureFreeModel(token, username, { force = false } = {}) {
  if (!username) return null;
  try {
    const st = await call(`${BASE}/api/codar/activities/free-model`, { token });
    const d = st.data?.data;
    if (!st.ok || !d) return null;
    // 已经领过、或这个账号不在活动范围，不必再打领取接口
    if (d.status === "claimed" || d.visible === false) return d;

    const now = Date.now();
    if (!force && now - (claimAt.get(username) || 0) < 10 * 60 * 1000) return d; // 状态照给，只是不重复领
    claimAt.set(username, now);
    const r = await call(`${BASE}/api/codar/activities/free-model/claim`, { method: "POST", token });
    return r.data?.data || d;
  } catch { return null; }
}

const fmtInt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "0");
const asIso = (sec) => (sec ? new Date(Number(sec) * 1000).toISOString() : undefined);

/* ---------------------------------------------------------------- 插件 */

export const CodarAuthPlugin = async ({ client } = {}) => ({
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
        label: "微信扫码登录 Codar",
        async authorize() {
          const qr = await call(`${AUTH}/v1/wechat/login/qrcode`, { method: "POST", body: {} });
          const url = qr.data?.data?.qr_url;
          const scene = qr.data?.data?.scene;
          if (!url || !scene) throw new Error(`二维码生成失败：${qr.data?.message || `HTTP ${qr.status}`}`);
          return {
            url,
            instructions: "用微信扫描打开的二维码，手机上点确认。这里会自动继续（5 分钟内有效）。",
            method: "auto",
            async callback() {
              try {
                const { token, username } = await wechatScan();
                await ensureFreeModel(token, username, { force: true });
                return {
                  type: "success",
                  key: token,
                  accountId: username || undefined,
                  metadata: { username, source: "wechat" },
                };
              } catch (e) {
                return { type: "failed", error: String(e?.message || e).slice(0, 500) };
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
          return fetch(input, { ...init, headers });
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
        const [bal, free, sign] = await Promise.all([
          call(`${AUTH}/v1/gettoken`, { method: "POST", body: { username, token: 0 }, token: key, timeoutMs: 30_000 }),
          ensureFreeModel(key, username).catch(() => null),
          call(`${AUTH}/v1/daily-sign/status`, { method: "POST", body: { username }, token: key, timeoutMs: 40_000 })
            .catch(() => null),
        ]);

        if (bal.status === 401 || Number(bal.data?.code) === 401) {
          return { error: "登录已过期，请重新扫码", signIn: "expired", windows: [] };
        }
        if (!bal.ok || typeof bal.data?.token !== "number") {
          return { error: `读取点数失败：${bal.data?.message || `HTTP ${bal.status}`}`, signIn: "kept", windows: [] };
        }

        const b = bal.data;
        const freeUntil = Number(free?.free_until || 0);
        const freeLeft = freeUntil * 1000 - Date.now();
        const active = freeLeft > 0;

        // 签到窗口：服务端按 24 小时冷却，retry_after 就是距离下一次可签的秒数。
        // used 恒为 0——签到不是额度，用 100% 会让卡片看起来像「已用尽」。
        const sd = sign?.data?.data;
        const signed = Boolean(sd?.isSigned);
        const windows = [];

        windows.push({
          name: signed ? "每日签到：已签" : "每日签到：未签",
          used: 0,
          ...(signed && Number(sd.retry_after) ? { resetSecs: Number(sd.retry_after) } : {}),
          display: signed
            ? `下次可签 ${leftOf(sd.retry_after)}后`
            : "运行 `magpie accounts checkin` 立即补签",
          aside: false,
        });

        // 免费模型窗口：领没领、能不能领，都在名字里说清楚，别让人去找按钮
        const models = (free?.model_ids || ["auto", "deepseek-v4.1-flash"]).join(" / ");
        if (active) {
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
      let cat;
      try {
        cat = await call(`${BASE}/v1/codar/models`, { token: key, timeoutMs: 15_000 });
      } catch {
        return provider?.models ?? {};
      }
      if (cat.status === 401 || Number(cat.data?.code) === 401) throw signedInError("Codar 登录已过期，请重新扫码");
      const list = Array.isArray(cat.data?.data) ? cat.data.data : null;
      if (!list?.length) return provider?.models ?? {};
      return Object.fromEntries(list.filter((m) => m?.id).map((m) => [String(m.id), runtimeModel(m)]));
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
  wechatScan, ensureFreeModel, leftOf,
};
