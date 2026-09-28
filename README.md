# gitreview

GitHub 代码审查辅助 CLI：**拉取 PR 变更 → 本地 lint/安全检查 → LLM 生成审查评论 → 推送回 GitHub**（inline 评论 / review）。本地审查工作流，结合真实 lint 与文件定位。

> 本地 lint + AI 审查 PR，评论自动推回 GitHub。

## 特性

- 🔄 **拉取**：GitHub API 拉取 PR 元数据 + 完整 unified diff（无需本地克隆）
- 🔍 **检查**：对**变更行**做内置 lint/安全检查（密钥泄露、危险执行、SQL 拼接、调试残留、TODO…），也支持接入外部 lint 命令（eslint 等）
- 🧠 **生成**：LLM 结合 diff + lint 结果生成带文件行号的审查评论（OpenAI 兼容端点）；支持**多模型对比**（`--models`）
- 📍 **定位**：评论定位到 `文件:行`（新增行），过滤掉未变更的历史代码；可选精确到 **diff position**
- ⚙️ **过滤**：仅新增/变更行、扩展名与忽略路径过滤、正文去重、跳过 GitHub 已有评论、数量上限
- 🧩 **自定义规则**：config 里写正则即新增检查规则，无需改代码
- 📤 **推送**：一次 `POST /pulls/{n}/reviews` 提交全部 inline 评论，自动处理限流重试
- 📄 **报告**：文本/Markdown 报告 + `--json` 机器可读输出 + 可作 CI 退出码（error 级别存在时退出 1）
- 🔐 **认证**：`--token` > `GITHUB_TOKEN`/`GH_TOKEN` > `~/.gitreview/config.json` > `gh auth token`

## 安装

```bash
# 本地开发运行
npm install
npm run build          # 产物输出到 dist/
node bin/gitreview.mjs --help

# 直接运行源码（无需构建）
npx tsx src/main.ts --help

# 全局安装
npm link               # 之后可直接用 gitreview 命令
```

要求 Node.js ≥ 18.17（内置 fetch）。

## 快速开始

```bash
# 1. 保存 GitHub token（可选，只读公开 PR 可省略）
gitreview auth ghp_xxxxxxxx

# 2. 审查一个 PR（dry-run 预览，不推送）
gitreview --repo tj/commander.js --pr 2624 --dry-run

# 3. 推送审查评论回 GitHub
gitreview --repo tj/commander.js --pr 2624

# 4. 在 PR 分支目录里自动推断 repo 与 PR 号（分支名形如 "123" / "pr/123"）
gitreview          # 自动推断 --repo owner/repo --pr 123

# 5. 看一眼演示（dry-run 一个公开 PR）
npm run demo
```

示例输出（`--dry-run`）：

```
============================================================
gitreview 审查报告 — tj/commander.js #2624
「Use node:util stripVTControlCharacters instead of own code」
============================================================

PR:      https://github.com/tj/commander.js/pull/2624
状态:    closed  分支 release/15.x -> refactor/2486-use-node-strip-vt-control-characters
变更:    4 文件 / +62 -86 行
检查:    lint+安全 findings 0 条（error:0 warning:0 info:0）
评论:    推送 0 / 跳过 0   LLM: 启用
推送:    DRY-RUN（未实际推送）
```

## CLI 命令

```
用法: gitreview [选项]

选项:
  -r, --repo <owner/repo>      目标仓库（默认从 git remote origin 检测）
  -p, --pr <number>            PR 编号（默认从分支名 "123"/"pr/123" 或 CI GITHUB_REF 检测）
  -t, --token <token>          GitHub token
  -c, --config <path>          配置文件（默认 gitreview.config.json）
  --path <path>                只审查指定路径，可多次使用
  -d, --dry-run                生成评论并打印，不推送 GitHub
  --no-llm                     跳过 LLM，仅本地 lint/安全检查
  --skip-existing              忽略 GitHub 上已存在的评论
  --max-comments <n>           最多推送的评论条数
  --min-severity <level>       error | warning | info
  --report-out <path>          报告写出路径
  --format <text|markdown>     报告格式（默认 text）
  --json                       以 JSON 输出机器可读结果（便于 CI 状态检查）
  --model <name>               LLM 模型（覆盖配置 llm.model）
  --models <a,b,...>           多模型对比模式：多个模型各生成一套评论并合并去重
  -h, --help                   帮助

子命令:
  gitreview auth <token>        保存 token 到 ~/.gitreview/config.json（权限 600）
  gitreview auth-status         查看 token 配置状态
  gitreview auth-logout         删除本地 token
  gitreview rules               列出内置检查规则
```

## 配置

项目根目录 `gitreview.config.json`（或 `~/.gitreview/config.json` 作为用户级配置），字段与默认值：

```jsonc
{
  "checks": {
    "enabled": ["secret", "debug", "todo", "dangerous", "sql-injection", "trailing"],
    "maxPerFile": 50,
    "customRules": [
      { "id": "no-broad-catch", "severity": "warning",
        "pattern": "catch\\s*\\(\\s*\\)", "message": "空 catch 会静默吞掉错误",
        "extensions": [".ts", ".js"] }
    ]
  },
  "filter": {
    "maxComments": 50,
    "extensions": [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".rb", ".php", ".sh"],
    "ignorePaths": ["**/dist/**", "**/vendor/**", "**/node_modules/**", "**/package-lock.json"],
    "minSeverity": "info",
    "skipExisting": true
  },
  "lints": [
    { "match": "**/*.ts", "command": "npx eslint {files}" }
  ],
  "llm": {
    "enabled": true,
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKeyEnv": "OPENAI_API_KEY",
    "models": []
  },
  "push": { "event": "COMMENT", "body": "🤖 gitreview 自动审查结果", "position": false },
  "report": { "format": "text", "outPath": "gitreview-report" }
}
```

### 自定义规则（`checks.customRules`）

在配置里写正则即新增检查规则，无需改代码。每条规则对**新增行**做 `RegExp(pattern, flags)` 匹配：

| 字段 | 说明 |
|---|---|
| `id` | 规则 ID（出现在评论里） |
| `severity` | `error` / `warning` / `info` |
| `pattern` | JS 正则源码，如 `catch\\s*\\(\\s*\\)` |
| `message` | 命中后输出的评论正文 |
| `flags` | 可选正则 flag，如 `"i"` |
| `extensions` | 可选，只对这些扩展名生效，如 `[".ts", ".js"]` |

### 多模型对比（`--models`）

`gitreview --models gpt-4o-mini,claude-3-5-sonnet` 用多个模型各生成一套评论，再按 `文件:行` 合并去重：
同一行多模型共识 → 合并成一条评论；不同行各自保留。评论带 `model` 归因，报告中标注来源，JSON 输出含 `model` 字段。优先级：`--models` > `--model` > `config.llm.models` > `config.llm.model`。

### diff position 精确模式

默认用现代 API 的 `line`+`side` 定位。若需传统 diff 偏移定位，设 `"push": { "position": true }`，评论按 1-based diff 偏移（含删除行累计）推送 `position`。

### `--json` 机器可读输出

```bash
gitreview --repo tj/commander.js --pr 2624 --json --dry-run
```

stdout 输出结构化的 JSON（`ok` / `exitCode` / `repo` / `pr` / `files` / `findings` / `comments`（含 `file`/`line`/`position`/`severity`/`source`/`model`/`body`）/ `push` / `stats`），可直接在 CI 里做 status check。进度日志仍在 stderr。

### 外部 lint

`lints` 数组：命令中用 `{files}` 占位替换为匹配的变更文件列表；输出按 `path:line:col: message`（eslint 风格）或 `path:line: message` 解析为 finding。`match` 是 glob，`extensions` 按扩展名过滤。

### LLM

默认读 `OPENAI_API_KEY` 并调用 OpenAI 兼容的 `/v1/chat/completions`。接入其他供应商只需改 `baseUrl` + `apiKeyEnv`（Anthropic/OpenRouter/本地 ollama 的 OpenAI 兼容端点均可）。未配置 key 时自动降级为仅本地 lint 评论。

### CI 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 无 error 级评论，或全部成功推送 |
| 1 | 存在 error 级（阻塞）发现 |
| 2 | 运行错误（配置/GitHub/LLM） |
| 3 | 推送失败 |

## 工作流（结合 CI）

```yaml
# .github/workflows/review.yml（示例）
on:
  pull_request:
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm install -g gitreview
      - run: gitreview --repo ${{ github.event.pull_request.base.repo.full_name }} --pr ${{ github.event.pull_request.number }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## 内置检查规则

| 规则 | 严重级别 | 说明 |
|---|---|---|
| `secret` | error | 疑似 API 密钥/凭据/私钥硬编码 |
| `dangerous` | error | eval / new Function / shell 命令注入 / XSS |
| `sql-injection` | error | SQL 语句字符串拼接 |
| `debug` | warning | console.log / print / fmt.Print 调试输出 |
| `todo` | info | TODO / FIXME / XXX 遗留标记 |
| `trailing` | info | 行尾空白 |

## 开发

```bash
npm test            # node:test 单元测试
npm run typecheck   # tsc --noEmit
npm run build       # 构建到 dist/
```

## 目录结构

```
gitreview/
├─ src/
│  ├─ main.ts        # CLI 入口与工作流编排
│  ├─ auth.ts        # token 解析/登录/存储
│  ├─ fetch.ts       # GitHub API 客户端（PR/diff/评论/限流）
│  ├─ diff.ts        # unified diff 解析与行号映射
│  ├─ check.ts       # 内置 lint/安全检查 + 外部 lint 钩子
│  ├─ llm.ts         # LLM 评论生成与 JSON 解析
│  ├─ filter.ts      # 去重/过滤（新增行、路径、已有评论）
│  ├─ push.ts        # 推送 review inline 评论
│  ├─ report.ts      # 文本/Markdown 报告
│  └─ config.ts      # 配置合并与加载
├─ tests/            # node:test 单元测试
├─ bin/gitreview.mjs # 可执行入口
└─ gitreview.config.json
```

## Roadmap

| 阶段 | 交付 |
|---|---|
| M1 | 拉取 + 本地 lint + 报告 ✅ |
| M2 | LLM 评论 + 推送 ✅ |
| M3 | 过滤/去重 + token 安全 ✅（skipExisting 去重、600 权限存储、限流重试） |
| 后续 | 评论按 hunk position 的精确定位、自定义规则插件、多模型对比 |

## License

MIT
