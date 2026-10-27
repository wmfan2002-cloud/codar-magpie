# codar-magpie

把 **Codar 科搭（SpeedAI）** 接进 magpie / OpenCode：微信扫码登录一次，16 个模型就能被所有 agent 用，
附带点数余额、每日签到和新用户免费模型领取。

> 非官方插件。登录用的是 Codar 自己的扫码接口，Token 存在 magpie 的 `plugin-auth.json`（权限 600）。

## 安装

```bash
# 本地文件夹（开发时最方便：改完重开插件即生效）
magpie plugin add ~/codar-ai-client/magpie-plugin

# 或 npm / git（发布之后）
magpie plugin add codar-magpie
magpie plugin add github:<owner>/<repo>
```

应用里：打开「插件」→「添加插件」→ 填文件夹路径 → 在 Codar 那一行登录。

## 登录

```bash
magpie plugin login codar
```

两种方式：

| 方式 | 说明 |
|---|---|
| **微信扫码登录（含手机验证）** | 打开一个本地登录页，微信扫码；需要手机验证时在同一个页面完成 |
| **粘贴 Codar Token** | 已经有 `eyJ…` 开头的 JWT（比如从网页控制台复制的），直接粘贴，插件会先调 `/api/user/self` 校验 |

### 手机验证是怎么做的

Codar 在「新 IP 登录」或「微信账号未绑手机」时会拦下来要短信验证，而发短信前必须先过
**阿里云验证码 v4**。那是纯浏览器组件（语义点选 / 滑块），插件宿主里没有 DOM，magpie 的插件页面
又跑在 `connect-src 'none'` 的沙箱里，所以两种环境都做不了。

做法和社区里同样需要浏览器登录的插件一致：**插件在 `127.0.0.1` 上起一个临时页面**，
magpie 用系统浏览器打开它，用户在里面扫码、填手机号、过验证码。

```
magpie ──打开──▶ http://127.0.0.1:<随机端口>/?k=<48位随机key>
                   ├ 第一步 微信扫码          （二维码图片由本机代理，不跨域）
                   ├ 第二步 手机验证          （手机号 + 阿里云 captcha4 + 短信码）
                   └ 完成                      → 插件拿到 JWT，交给 magpie 保存
```

**安全边界**：只 bind `127.0.0.1`（公网不可达）；每个登录流程一个随机 key，不对就 403；
不写任何日志、不打印 Token；拿到 Token 或 10 分钟超时后立即关闭服务。

页面里的两种验证流程与网页控制台 `web/server.mjs` 完全一致（同一套上游接口、同样的
`name`/`type` 组合、同样在失败时重轮询换临时令牌）：

| 场景 | 判定 | 发短信 | 提交 |
|---|---|---|---|
| 新 IP | `IP_VERIFY_REQUIRED` / `mode=IP_VERIFY` | `POST /v1/verification-code` `{name: <username>, type: "ip_verify"}` | `POST /v1/user/verify_ip`（需临时令牌） |
| 未绑手机 | `BIND_PHONE_REQUIRED` / `mode=BIND_PHONE` | `POST /v1/verification-code` `{name: "user", type: "bind_phone"}` | `POST /v1/bind-phone`（无需 Bearer） |

Token 是上游签发的 HS256 JWT，**7 天有效**。到期后上游返回 401，magpie 会把账号标成需要重新登录，
点一下重新扫码即可。

## 用起来

```bash
magpie plugin                    # codar (Codar 科搭, 16 models)  signed in
magpie provider test codar auto  # 发一个最小请求验证链路
magpie quota                     # 点数余额 + 免费期
magpie models                    # agent 能选的模型
```

agent 里用 `<供应商>/<模型>` 指代，例如 `codar/auto`、`codar/claude-sonnet-5-kiro`。

### 模型与协议

目录来自 `GET /v1/codar/models`（登录后每次刷新，取不到就用内置快照）。模型 id 以目录为准，
协议按目录里的 `protocol` 字段分流，和官方客户端一致：

| 模型 | API | 备注 |
|---|---|---|
| `auto` / `deepseek-v4.1-flash` | Chat Completions | **免费档**（实测 `billing.quota = 0`） |
| `deepseek-v4-flash` / `deepseek-v4-pro` | Chat Completions | 回传思维链 |
| `glm-5.2` / `glm-5.3` / `glm-5.3-flash` | Chat Completions | 回传思维链 |
| `gpt-5.6-sol` / `gpt-6-sol` / `gpt-6-astra` | Chat Completions | — |
| `claude-sonnet-5` / `claude-opus-5` / `claude-opus-5-5`（及各自的 `-kiro` 档） | Anthropic Messages | 原生协议，带 `anthropic-version` |

**上下文窗口统一报 1M。** 目录里 `gpt-5.6-sol` / `gpt-6-sol` / `gpt-6-astra` 写的是
`context_window: 128000`，但插件不拿它去限制客户端：agent 侧看到的一律是 1,000,000，
免得客户端提前截断上下文。**真超了上游会直接报错**，让用户看到厂商原话，比这里猜一个
更小的数字更可靠。

所有模型都声明 `tool_call`，实际工具调用由上游完成。**图片输入不要用**：目录写着支持，
但实测返回 400，插件里已经统一声明成纯文本。

### 用量（`auth.usage`）

账号卡片、`magpie quota`、`magpie accounts` 和 `GET /v1/magpie/quotas` 都会显示：

```
codar · 新用户免费 · until Nov 3 · API key …g1us  subscription
  每日签到：已签 0% (下次可签 12 小时 20 分后) ↻12h20m tomorrow 04:54
  免费模型：已领取 0% (deepseek-v4.1-flash / auto · 还剩 156 小时 20 分) ↻6d12h Nov 3 04:53
  点数 2,500 · Agent 1,563 left
```

| 字段 / 窗口 | 内容 |
|---|---|
| `plan` | 领了免费模型 → 「新用户免费」；否则「按量计费」 |
| `until` | 免费期结束时间（`free_until`） |
| `balance` | `/v1/gettoken` 的三个桶（通用点数 / Agent / 改写） |
| **每日签到：已签 / 未签** | 已签带下次可签倒计时（服务端 `retry_after`）；未签提示怎么补签 |
| **免费模型：已领取** | 适用模型 id + 剩余时长 |
| **免费模型：已到期** | 免费期已过（上游重领幂等，不会再给 7 天），之后按目录价 |
| **免费模型：可领取** | 还没领，下次读取额度时自动领 |
| **免费模型：不可用** | 该账号不在新用户活动范围 |

> 签到窗口的 `used` 恒为 `0`：签到不是额度，显示成 100% 会让人以为「已经用尽」。
> 进度条无意义的地方一律用 `display` 文本承载，状态写在窗口**名字**里，一眼能看到。

### 每日签到（`auth.checkin`）

插件的 `auth.checkin` 钩子存在，magpie 会在每个北京日替账号按一次：

```
POST /v1/daily-sign/status {username}   # 已签 → done
POST /v1/daily-sign        {username}   # 未签 → claimed
```

手动立即签一次（不需要等定时任务）：

```bash
magpie accounts checkin          # 全部账号
magpie accounts checkin --json   # {"outcome":"done","msg":"今天已签到，12 小时 25 分后可再签","by":"plugin:codar",…}
```

24 小时冷却由服务端控制，重复调用只会得到 `done`。

### 新用户免费模型

登录成功后自动执行一次：

```
GET  /api/codar/activities/free-model          # 看状态
POST /api/codar/activities/free-model/claim    # 没领就领
```

领取是幂等的，重复调用不会延期，也不会报错。之后每次读用量时会再补一次（同一个账号 10 分钟内只试一次）；
登录时则强制跳过节流，保证刚绑定就领。所以哪怕注册时活动还没开，下次打开面板也能补上。
领取状态和到期时间会显示在上面那个「新用户免费模型」窗口里。

### 为什么没有「领取」按钮

（登录页不受这个限制——它是插件自己起的回环页面，不是 magpie 的插件页面。）

magpie 的插件页面跑在 `sandbox="allow-scripts"` + `connect-src 'none'` 的 iframe 里：
**发不出任何网络请求**，也拿不到账号 Token（`magpie.read` 只开放 `usage:summary` 和 `providers:list`，
文档明确写着「没有任何读取会给出密钥、账号、登录信息」）。

所以在界面上做一个「点一下领取」的按钮是不可能的。领取是**自动**的：

1. 登录成功（扫码或粘贴 Token）时立刻领一次，不受节流影响；
2. 之后每次 magpie 读额度（打开供应商页、`magpie quota`、`GET /v1/magpie/quotas`）时补领，
   同一账号 10 分钟内最多真正打一次领取接口；
3. 读状态每次都真读 —— 节流只挡「领取」这个动作，不挡「显示状态」，
   否则被节流的窗口里会误报成「可领取」。

领取状态通过上面的 `免费模型：…` 窗口显示，四种状态一目了然。

## 上游地址

写死在代码里，没有配置项：

| 用途 | 地址 |
|---|---|
| 推理 / 模型目录 / 免费模型活动 | `https://api.claw.speedai.com`（请求发往 `/v1`） |
| 扫码登录 / 每日签到 / 点数余额 | `https://api.kuaipaper.com` |

## 凭据

- Token 由 magpie 保管在 `~/.config/magpie/plugin-auth.json`（0600），插件本身不落盘、不打印。
- 插件不在日志里输出 Token；`usage` 出错只回显上游的 `message`。
- 想清掉登录：`magpie plugin logout codar`。

## 排障

| 现象 | 处理 |
|---|---|
| `401` / 账号被标「需要重新登录」 | JWT 过期（7 天）→ `magpie plugin login codar` 重扫 |
| 扫码页打开是二维码图片 | 正常，直接用微信扫 |
| 登录时提示要手机号验证 | 新 IP 或未绑手机，去网页控制台完成一次，再用「粘贴 Token」 |
| `No available channel for model 'X'` | 模型名大小写敏感，用 `magpie models` 里的精确 id |
| 免费额度突然开始扣点 | 免费期过了（`magpie quota` 看 until），换 `-kiro` 档或 `glm-5.3-flash` |
| 插件没出现 | `magpie plugin` 看加载错误；文件夹插件改完要在应用里关掉再打开 |

## 开发

```bash
node test.mjs              # 纯函数自检，不联网
node --check index.mjs     # 语法
```

入口只导出 `default { id, server }` 和 `_internal`（测试用），避免宿主把辅助函数当插件调用。

## License

MIT
