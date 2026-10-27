// 登录页：由插件在 127.0.0.1 上提供，magpie 用系统浏览器打开。
//
// 为什么需要这个页面：Codar 在「新 IP 登录」或「未绑手机」时会要求短信验证，
// 而发短信前必须通过阿里云验证码 v4（语义点选 / 滑块）。那是纯浏览器组件，
// 插件宿主（Bun，无 DOM）里做不了，只能交给真实浏览器。
//
// 页面与插件服务同源，所以能直接调 /api/*，不需要 CORS，也不把 Token 交给任何第三方。

export const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 Codar 科搭</title>
<style>
  :root { color-scheme: light dark; --fg:#1d1d1d; --muted:#6b7280; --bg:#fff; --line:#e5e7eb; --accent:#ffb021; --ok:#0e8f6f; --bad:#c2410c; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --muted:#9aa0aa; --bg:#191919; --line:#333; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 22px 40px; font:15px/1.6 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif;
         color:var(--fg); background:var(--bg); }
  h1 { font-size:17px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 20px; }
  .step { border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:14px; }
  .step[hidden] { display:none; }
  .step h2 { font-size:14px; margin:0 0 12px; font-weight:600; }
  #qr-wrap { display:flex; gap:18px; align-items:flex-start; flex-wrap:wrap; }
  #qr-img { width:196px; height:196px; border:1px solid var(--line); border-radius:8px; background:#fff; object-fit:contain; }
  .side { flex:1 1 200px; min-width:180px; }
  .status { font-size:13px; min-height:22px; }
  .status.ok { color:var(--ok); }
  .status.bad { color:var(--bad); }
  label { display:block; font-size:13px; margin:10px 0 4px; color:var(--muted); }
  input { width:100%; padding:9px 11px; font:inherit; color:inherit; background:transparent;
          border:1px solid var(--line); border-radius:7px; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
  button { margin-top:12px; padding:9px 16px; font:inherit; font-size:14px; border:0; border-radius:7px;
           background:var(--accent); color:#1d1d1d; cursor:pointer; font-weight:600; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); font-weight:400; }
  .row { display:flex; gap:10px; align-items:flex-end; }
  .row > label { flex:1; margin:0; }
  .row > label input { margin-top:4px; }
  #cap { margin-top:12px; }
  /* 阿里云验证码弹层默认 position:fixed；放进容器里让它跟文档流走 */
  #cap .captcha4_captcha { position:relative !important; }
  .hint { font-size:12px; color:var(--muted); margin-top:10px; }
  .done { text-align:center; padding:32px 0; }
  .done h2 { font-size:20px; color:var(--ok); margin:0 0 8px; }
</style>
</head>
<body>

<h1>登录 Codar 科搭</h1>
<p class="sub">扫码后如果提示需要手机验证，就在本页完成。全程只连本机服务。</p>

<!-- 第一步：扫码 -->
<section class="step" id="step-qr">
  <h2>第一步 · 微信扫码</h2>
  <div id="qr-wrap">
    <img id="qr-img" alt="微信扫码登录二维码">
    <div class="side">
      <div class="status" id="qr-status">正在生成二维码…</div>
      <button class="ghost" id="btn-reload" type="button">刷新二维码</button>
      <p class="hint">二维码约 5 分钟有效。用微信扫一扫，手机上确认登录。</p>
    </div>
  </div>
</section>

<!-- 第二步：手机验证 -->
<section class="step" id="step-phone" hidden>
  <h2 id="phone-title">第二步 · 手机验证</h2>
  <p class="status" id="phone-reason"></p>

  <label for="phone">手机号</label>
  <input id="phone" inputmode="numeric" maxlength="11" placeholder="11 位手机号" autocomplete="tel">

  <label>人机验证</label>
  <div id="cap"></div>
  <div class="status" id="cap-status">正在加载验证码…</div>

  <button id="btn-send" type="button">发送验证码</button>

  <label for="code">短信验证码</label>
  <input id="code" inputmode="numeric" maxlength="8" placeholder="收到的 6 位验证码" autocomplete="one-time-code">
  <button id="btn-verify" type="button">验证并登录</button>
  <div class="status" id="phone-status"></div>
</section>

<!-- 完成 -->
<section class="step" id="step-done" hidden>
  <div class="done">
    <h2>✓ 登录成功</h2>
    <p class="sub" id="done-user"></p>
    <p class="hint">可以关闭此页面，回到 magpie。</p>
  </div>
</section>

<script>
(function () {
  "use strict";
  var K = new URLSearchParams(location.search).get("k") || "";
  var state = { scene: null, tempToken: null, username: null, flow: "ip_verify", cap: null, capParams: null, timer: null };

  function $(id) { return document.getElementById(id); }
  function setStatus(id, text, kind) {
    var el = $(id); el.textContent = text; el.className = "status" + (kind ? " " + kind : "");
  }
  function api(path, body) {
    var url = path + (path.indexOf("?") >= 0 ? "&" : "?") + "k=" + encodeURIComponent(K);
    var opt = body === undefined ? { credentials: "omit" } : {
      method: "POST", credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
        return d;
      });
    });
  }
  function fail(e) { setStatus("qr-status", "出错了：" + (e.message || e), "bad"); }

  /* ---------------- 第一步：二维码 ---------------- */
  function loadQr() {
    setStatus("qr-status", "正在生成二维码…");
    api("/api/qr", {}).then(function (d) {
      state.scene = d.scene;
      $("qr-img").src = "/api/qr.png?k=" + encodeURIComponent(K) + "&scene=" + encodeURIComponent(d.scene);
      setStatus("qr-status", "等待微信扫码…");
      poll(0);
    }).catch(fail);
  }

  function poll(tries) {
    if (!state.scene) return;
    clearTimeout(state.timer);
    if (tries > 150) { setStatus("qr-status", "二维码已过期，请刷新", "bad"); return; }
    api("/api/status", { scene: state.scene }).then(function (d) {
      var st = String(d.status || "").toLowerCase();

      if (st === "confirmed" || st === "success" || st === "logged_in") return done(d);
      if (st === "ip_verify" || st === "ip_verify_required" || st === "required_ip_verify" ||
          st === "bind_phone" || st === "bind_phone_required" || st === "required_bind_phone") {
        return showPhone(d);
      }
      if (st === "expired" || st === "cancelled" || st === "canceled" || st === "rejected") {
        setStatus("qr-status", "扫码未完成（" + st + "），请刷新二维码重试", "bad"); return;
      }
      setStatus("qr-status", st === "scanned" ? "已扫码，请在手机上确认…" : "等待微信扫码…");
      state.timer = setTimeout(function () { poll(tries + 1); }, 2000);
    }).catch(function (e) {
      setStatus("qr-status", "查询失败：" + (e.message || e) + "，重试中…", "bad");
      state.timer = setTimeout(function () { poll(tries + 1); }, 3000);
    });
  }

  /* ---------------- 第二步：手机验证 ---------------- */
  function showPhone(d) {
    clearTimeout(state.timer);
    state.tempToken = d.temp_token || null;
    state.username = d.username || "";
    state.flow = d.flow || "ip_verify";

    $("step-qr").hidden = true;
    $("step-phone").hidden = false;
    $("phone-title").textContent = state.flow === "bind_phone" ? "第二步 · 绑定手机号" : "第二步 · 手机验证";
    $("phone-reason").textContent = d.message ||
      (state.flow === "bind_phone" ? "这个微信账号还没绑手机号，绑定后才能继续。" : "检测到新 IP 登录，需要短信验证。");
    if (d.phone_tail) $("phone").placeholder = "尾号 " + d.phone_tail + "（请填完整 11 位）";
    initCaptcha();
  }

  function initCaptcha() {
    if (state.cap) return;
    if (typeof window.initAlicom4 !== "function") {
      setStatus("cap-status", "验证码组件未加载，请刷新页面", "bad");
      return;
    }
    window.initAlicom4(
      { captchaId: "bb7f810ecc9f6d21dcf72bcae120c8c5", language: "zh", product: "bind",
        protocol: "https://", https: true, timeout: 15000,
        onError: function (info) {
          var d = (info && info.desc && info.desc.detail) || (info && info.msg) || "";
          setStatus("cap-status", "验证码初始化失败：" + d, "bad");
        } },
      function (obj) {
        state.cap = obj;
        setStatus("cap-status", "正在渲染验证码…");
        try {
          obj.appendTo("#cap")
            .onReady(function () {})
            .onNextReady(function () { setStatus("cap-status", "请在下方方块里完成验证（点选图片 / 拖动滑块）"); })
            .onBoxShow(function () {})
            .onClose(function () {})
            .onError(function (info) { setStatus("cap-status", "验证出错：" + ((info && info.msg) || ""), "bad"); })
            .onSuccess(function () {
              try {
                var r = obj.getValidate();
                var p = {
                  lot_number: r.lot_number || r.geetest_challenge,
                  captcha_output: r.captcha_output || r.geetest_validate,
                  pass_token: r.pass_token || r.geetest_seccode,
                  gen_time: r.gen_time,
                };
                if (!p.lot_number || !p.captcha_output || !p.pass_token || !p.gen_time) throw new Error("参数缺失");
                state.capParams = p;
                setStatus("cap-status", "✓ 人机验证已通过，请点「发送验证码」", "ok");
              } catch (e) { setStatus("cap-status", "验证结果无效：" + e.message, "bad"); }
            });
          // alicom v4 的弹层默认隐藏，需要显式唤出
          setTimeout(function () {
            try {
              if (typeof obj.showCaptcha === "function") obj.showCaptcha();
              else if (typeof obj.showBox === "function") obj.showBox();
            } catch (e) {}
            // 弹层有时挂在 body 上；挪进 #cap，避免压在整页上遮住输入框
            setTimeout(function () {
              var stray = null;
              for (var i = 0; i < document.body.children.length; i++) {
                var el = document.body.children[i];
                if (el !== document.getElementById("cap").parentNode &&
                    /captcha4_captcha/.test(el.className || "") && !document.getElementById("cap").contains(el)) {
                  stray = el;
                }
              }
              if (stray) document.getElementById("cap").appendChild(stray);
            }, 400);
          }, 300);
        } catch (e) { setStatus("cap-status", "验证码渲染失败：" + e.message, "bad"); }
      }
    );
  }

  $("btn-send").addEventListener("click", function () {
    var phone = ($("phone").value || "").trim();
    if (!/^1[3-9]\\d{9}$/.test(phone)) return setStatus("phone-status", "请输入正确的 11 位手机号", "bad");
    if (!state.capParams) return setStatus("phone-status", "请先完成下方的人机验证", "bad");

    var btn = $("btn-send"); btn.disabled = true;
    setStatus("phone-status", "正在发送…");
    api("/api/send-code", {
      scene: state.scene, flow: state.flow, username: state.username,
      temp_token: state.tempToken, phone: phone,
      lot_number: state.capParams.lot_number, captcha_output: state.capParams.captcha_output,
      pass_token: state.capParams.pass_token, gen_time: state.capParams.gen_time,
    }).then(function (d) {
      if (d.temp_token) state.tempToken = d.temp_token;
      setStatus("phone-status", "✓ 验证码已发送，请查看短信", "ok");
      state.capParams = null;               // 一次性
      try { state.cap && state.cap.reset && state.cap.reset(); } catch (e) {}
      setStatus("cap-status", "如需重发，请重新完成人机验证");
      $("code").focus();
    }).catch(function (e) {
      state.capParams = null;
      setStatus("phone-status", "发送失败：" + (e.message || e), "bad");
    }).then(function () { btn.disabled = false; });
  });

  $("btn-verify").addEventListener("click", function () {
    var phone = ($("phone").value || "").trim();
    var code = ($("code").value || "").trim();
    if (!/^1[3-9]\\d{9}$/.test(phone)) return setStatus("phone-status", "请输入正确的 11 位手机号", "bad");
    if (!/^\\d{4,8}$/.test(code)) return setStatus("phone-status", "请输入收到的验证码", "bad");

    var btn = $("btn-verify"); btn.disabled = true;
    setStatus("phone-status", "正在验证…");
    api("/api/verify", {
      scene: state.scene, flow: state.flow, username: state.username,
      temp_token: state.tempToken, phone: phone, code: code,
    }).then(function (d) { done(d); })
      .catch(function (e) { setStatus("phone-status", "验证失败：" + (e.message || e), "bad"); btn.disabled = false; });
  });

  /* ---------------- 完成 ---------------- */
  function done(d) {
    clearTimeout(state.timer);
    $("step-qr").hidden = true;
    $("step-phone").hidden = true;
    $("step-done").hidden = false;
    $("done-user").textContent = d.username ? ("账号：" + d.username) : "";
  }

  $("btn-reload").addEventListener("click", function () {
    clearTimeout(state.timer);
    state.tempToken = null;
    $("step-phone").hidden = true;
    $("step-qr").hidden = false;
    loadQr();
  });

  loadQr();
})();
</script>
<script src="https://static.alicaptcha.com/v4/ct4.js" async></script>
</body>
</html>`;
