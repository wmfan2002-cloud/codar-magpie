// 本地登录服务：只在 127.0.0.1 上监听（随机端口 + 一次性 key）。
//
// 为什么需要它：Codar 的手机验证要先过阿里云验证码 v4（语义点选），
// 那是纯浏览器组件 —— 插件宿主（Bun）里没有 DOM，magpie 的插件页面又是
// connect-src 'none' 的沙箱，连请求都发不出。所以只能起一个真页面：
//   magpie 打开 http://127.0.0.1:<port>/?k=<key>  →  用户在浏览器里扫码 / 验手机
//
// 安全边界：
//   - 只 bind 127.0.0.1，外网无法访问；
//   - 每个登录流程一个 24 字节随机 key，不对就 403；
//   - 不记日志、不打印 Token；拿到 Token 立即关闭服务（或 10 分钟超时）。

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { LOGIN_PAGE } from "./login-page.mjs";

const AUTH = "https://api.kuaipaper.com";
const CLIENT = "codar-magpie/0.3.0";

const QR_OK = new Set(["confirmed", "success", "logged_in"]);
const QR_IP = new Set(["ip_verify_required", "required_ip_verify", "ip_verify", "require_ip_verify"]);
const QR_BIND = new Set([
  "bind_phone_required", "required_bind_phone", "bind_phone", "require_phone_binding",
]);

/** 上游 JSON 请求。HTTP 200 也可能是失败——真正的结果在 body.code 里。 */
async function post(path, body, { token, timeoutMs = 45_000 } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json", "user-agent": CLIENT };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${AUTH}${path}`, {
    method: "POST", headers, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  const bizOk = data?.success !== false && (data?.code === undefined || Number(data.code) === 200);
  return { ok: res.ok && bizOk, status: res.status, data };
}

/** 定长比较，防止按字节提前返回泄露 key 前缀。 */
function sameKey(given, expected) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const sendJson = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length, "cache-control": "no-store",
  });
  res.end(buf);
};

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  let size = 0;
  req.on("data", (c) => { size += c.length; if (size < 1e6) chunks.push(c); });
  req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); } });
  req.on("error", () => resolve({}));
});

/**
 * 起一个登录会话。
 *
 * @param {object} opts
 * @param {number} [opts.timeoutMs] 会话存活时间，默认 10 分钟
 * @param {string} [opts.bindHost]  监听地址。默认 127.0.0.1（仅本机）；
 *                                  在 VPS 上设 0.0.0.0 好从自己的电脑打开。
 * @param {string[]} [opts.publicUrls] 额外对外的可达地址前缀，例如
 *                                  ["https://codar.example.com"]（nginx 反代到这个端口）
 *                                  或 ["http://1.2.3.4:PORT"]。
 * @returns {Promise<{url: string, urls: string[], port: number,
 *   wait: () => Promise<{token, username}|{cancelled}>, close: () => void}>}
 */
export async function startLoginSession({
  timeoutMs = 10 * 60 * 1000,
  bindHost = process.env.CODAR_LOGIN_BIND || "127.0.0.1",
  publicUrls = [],
} = {}) {
  const key = randomBytes(24).toString("hex");
  const scenes = new Map(); // scene -> { qrUrl, tempToken, username, flow }

  let settle;
  const result = new Promise((r) => { settle = r; });
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(expiry);
    try { server.close(); } catch { /* ignore */ }
  };

  async function handler(req, res) {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      // 只认带 key 的请求。key 是 48 位十六进制，不可猜；
      // 对外开放时这是唯一凭据，所以比较用等长定长方式，避免时序侧信道。
      if (!sameKey(url.searchParams.get("k"), key)) return sendJson(res, 403, { error: "bad key" });

      /* ---- 页面 ---- */
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = Buffer.from(LOGIN_PAGE);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "content-length": html.length,
          "cache-control": "no-store", "referrer-policy": "no-referrer",
        });
        return res.end(html);
      }

      /* ---- 二维码图片（代理上游，避开跨域/防盗链）---- */
      if (req.method === "GET" && url.pathname === "/api/qr.png") {
        const st = scenes.get(String(url.searchParams.get("scene") || ""));
        if (!st) return sendJson(res, 404, { error: "二维码已失效" });
        const img = await fetch(st.qrUrl, { signal: AbortSignal.timeout(20_000) });
        if (!img.ok) return sendJson(res, 502, { error: "二维码图片加载失败" });
        const buf = Buffer.from(await img.arrayBuffer());
        res.writeHead(200, {
          "content-type": img.headers.get("content-type") || "image/jpeg",
          "content-length": buf.length, "cache-control": "no-store",
        });
        return res.end(buf);
      }

      if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readBody(req);

      /* ---- 生成二维码 ---- */
      if (url.pathname === "/api/qr") {
        const qr = await post("/v1/wechat/login/qrcode", {});
        const d = qr.data?.data;
        if (!d?.scene || !d?.qr_url) return sendJson(res, 502, { error: qr.data?.message || "二维码生成失败" });
        scenes.set(d.scene, { qrUrl: d.qr_url, tempToken: null, username: null, flow: "ip_verify" });
        return sendJson(res, 200, { scene: d.scene });
      }

      /* ---- 轮询扫码状态 ---- */
      if (url.pathname === "/api/status") {
        const scene = String(body.scene || "");
        const st = scenes.get(scene);
        if (!st) return sendJson(res, 404, { error: "二维码已失效，请刷新" });

        const r = await post("/v1/wechat/login/status", { scene });
        const d = r.data?.data || {};
        const status = String(d.status || "").toLowerCase();
        const mode = String(d.mode || "").toLowerCase();

        if (QR_OK.has(status) && d.token) {
          scenes.delete(scene);
          settle({ token: String(d.token), username: d.username ? String(d.username) : null });
          return sendJson(res, 200, { status: "confirmed", username: d.username || null });
        }

        const wantsPhone = QR_IP.has(status) || QR_IP.has(mode) || QR_BIND.has(status) || QR_BIND.has(mode);
        if (wantsPhone) {
          const flow = (QR_BIND.has(status) || QR_BIND.has(mode)) ? "bind_phone" : "ip_verify";
          st.tempToken = String(d.token || d.tempToken || d.temp_token || "");
          st.username = String(d.username || "");
          st.flow = flow;
          return sendJson(res, 200, {
            status: flow, flow, temp_token: st.tempToken, username: st.username,
            phone_tail: d.phone || null,
            message: d.message || (flow === "bind_phone"
              ? "这个微信账号还没绑手机号，绑定后才能继续"
              : "检测到新 IP 登录，需要手机验证"),
          });
        }

        if (!r.ok && Number(r.data?.code) === 404) {
          scenes.delete(scene);
          return sendJson(res, 200, { status: "expired" });
        }
        return sendJson(res, 200, { status: status || "pending", username: d.username || null });
      }

      /* ---- 发送短信验证码 ---- */
      if (url.pathname === "/api/send-code") {
        const st = scenes.get(String(body.scene || ""));
        if (!st) return sendJson(res, 404, { error: "二维码已失效，请刷新" });

        const phone = String(body.phone || "").trim();
        const username = String(body.username || st.username || "");
        const flow = String(body.flow || st.flow || "ip_verify");
        const tempToken = String(st.tempToken || body.temp_token || "");

        if (!/^1[3-9]\d{9}$/.test(phone)) return sendJson(res, 400, { error: "手机号格式不正确" });
        if (!username) return sendJson(res, 400, { error: "缺少用户名，请刷新二维码" });
        if (!tempToken) return sendJson(res, 400, { error: "临时令牌已失效，请刷新二维码" });
        for (const k of ["lot_number", "captcha_output", "pass_token", "gen_time"]) {
          if (!String(body[k] || "")) return sendJson(res, 400, { error: "人机验证参数缺失：" + k });
        }

        // 两种场景的 name/type 完全不同，混用会让上游的验证码校验失败：
        //   ip_verify  → name = username, type = "ip_verify"（需 Bearer）
        //   bind_phone → name = "user",   type = "bind_phone"（无需 Bearer）
        const r = await post("/v1/verification-code", {
          phone,
          name: flow === "ip_verify" ? username : "user",
          type: flow,
          lot_number: String(body.lot_number),
          captcha_output: String(body.captcha_output),
          pass_token: String(body.pass_token),
          gen_time: String(body.gen_time),
        }, { token: tempToken, timeoutMs: 60_000 });

        const d = r.data || {};
        const rotated = String(d.data?.tempToken || d.data?.temp_token || d.tempToken || d.temp_token || "");
        if (rotated) st.tempToken = rotated;
        if (!r.ok) {
          const detail = [d.message, d.data?.message, d.code ? `code=${d.code}` : "", `http=${r.status}`]
            .filter(Boolean).join(" · ");
          return sendJson(res, r.status >= 500 ? 502 : 400, { error: detail || "发送验证码失败" });
        }
        return sendJson(res, 200, { ok: true, message: d.message || "验证码已发送", temp_token: rotated || tempToken });
      }

      /* ---- 提交验证码，换 JWT ---- */
      if (url.pathname === "/api/verify") {
        const scene = String(body.scene || "");
        const st = scenes.get(scene);
        if (!st) return sendJson(res, 404, { error: "二维码已失效，请刷新" });

        const phone = String(body.phone || "").trim();
        const code = String(body.code || "").trim();
        const username = String(body.username || st.username || "");
        const flow = String(body.flow || st.flow || "ip_verify");
        if (!/^1[3-9]\d{9}$/.test(phone)) return sendJson(res, 400, { error: "手机号格式不正确" });
        if (!/^\d{4,8}$/.test(code)) return sendJson(res, 400, { error: "验证码格式不正确" });
        if (!username) return sendJson(res, 400, { error: "缺少用户名，请刷新二维码" });

        const useBind = flow === "bind_phone";
        const attempt = (tk) => post(
          useBind ? "/v1/bind-phone" : "/v1/user/verify_ip",
          { username, phone, code },
          { token: useBind ? undefined : tk, timeoutMs: 60_000 },
        );

        // 以服务端记录的最新临时令牌为准（发短信时上游可能轮换过），
        // 页面带来的 body.temp_token 可能已过期。
        let tempToken = String(st.tempToken || body.temp_token || "");
        let r = await attempt(tempToken);

        // 首次失败时重新轮询二维码换临时令牌再试一次（与面板逻辑一致）
        if (!r.ok) {
          const again = await post("/v1/wechat/login/status", { scene });
          const dd = again.data?.data || {};
          const fresh = String(dd.token || dd.tempToken || dd.temp_token || "");
          if (fresh && fresh !== tempToken) {
            tempToken = fresh;
            st.tempToken = fresh;
            r = await attempt(tempToken);
          }
        }

        const d = r.data || {};
        if (!r.ok) {
          const detail = [d.message, d.data?.message, d.code ? `code=${d.code}` : "", `http=${r.status}`]
            .filter(Boolean).join(" · ");
          return sendJson(res, r.status >= 500 ? 502 : 400, { error: detail || "验证失败" });
        }
        const jwt = String(d.data?.token || d.token || "");
        if (!jwt) return sendJson(res, 502, { error: "验证成功但上游未返回 Token" });

        scenes.delete(scene);
        settle({ token: jwt, username: username || null });
        return sendJson(res, 200, { status: "confirmed", username: username || null });
      }

      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      try { sendJson(res, 502, { error: String(e?.message || e) }); } catch { /* ignore */ }
    }
  }

  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bindHost, resolve);
  });

  const { port } = server.address();
  const expiry = setTimeout(() => {
    settle({ cancelled: true, reason: "登录超时（10 分钟），请重试" });
  }, timeoutMs);
  expiry.unref?.();

  // 回环地址总是可用（服务器本机 curl / 端口转发）；
  // 非回环监听时再补上对外地址，方便在 VPS 上从自己的电脑直接打开。
  const urls = [`http://127.0.0.1:${port}/?k=${key}`];
  if (bindHost !== "127.0.0.1" && bindHost !== "::1") {
    urls.push(`http://<服务器地址>:${port}/?k=${key}`);
  }
  for (const base of publicUrls) {
    urls.push(`${String(base).replace(/\/+$/, "")}/?k=${key}`);
  }

  return {
    url: urls[0],
    urls,
    port,
    bindHost,
    wait: () => result.then((v) => { close(); return v; }),
    close,
  };
}
