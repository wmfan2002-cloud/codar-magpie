# opencode-codar-auth

把 **Codar 科搭（SpeedAI）** 接进 magpie / OpenCode：微信扫码登录一次，16 个模型就能被所有 agent 用，
附带点数余额、每日签到和新用户免费模型领取。

> 非官方插件。登录用的是 Codar 自己的扫码接口，Token 存在 magpie 的 `plugin-auth.json`（权限 600）。

## 安装

```bash
# 本地文件夹（开发时最方便：改完重开插件即生效）
magpie plugin add ~/codar-ai-client/magpie-plugin

# 或 npm / git（发布之后）
magpie plugin add opencode-codar-auth
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
| **微信扫码登录** | 打开二维码页面，微信扫码并确认，插件自动轮询直到拿到 Token（5 分钟有效） |
| **粘贴 Codar Token** | 已经有 `eyJ…` 开头的 JWT（比如从网页控制台复制的），直接粘贴，插件会先调 `/api/user/self` 校验 |

**关于手机号验证**：Codar 在「新 IP 登录」或「微信账号未绑手机」时会要求短信验证，而那一步必须过阿里云
人机验证（浏览器里的验证码组件），插件里做不了。遇到这种情况，插件会明确提示：先去 Codar 网页控制台
完成这一次登录，再用「粘贴 Token」方式加进来。之后正常使用不受影响。

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

目录来自 `GET /v1/codar/models`（登录后每次刷新，取不到就用内置快照）。协议按目录里的
`protocol` 分流，和官方客户端一致：

| 模型 | API | 备注 |
|---|---|---|
| `auto` / `deepseek-v4.1-flash` | Chat Completions | **免费档**（实测 `billing.quota = 0`） |
| `deepseek-v4-flash` / `deepseek-v4-pro` | Chat Completions | 回传思维链 |
| `glm-5.2` / `glm-5.3` / `glm-5.3-flash` | Chat Completions | 回传思维链 |
| `gpt-5.6-sol` / `gpt-6-sol` / `gpt-6-astra` | Chat Completions | 128K 上下文 |
| `claude-*` 全系列 | Anthropic Messages | 原生协议，带 `anthropic-version` |

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
