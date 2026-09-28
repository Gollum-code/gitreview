# 467. gitreview（GitHub 代码审查辅助）— 完整方案

> 目标：`gitreview` GitHub 审查辅助：拉 PR 变更 → 本地 diff/检查（lint 变更/安全/风险）→ 审查评论生成（LLM）→ 推送评论；审查工作流
> 定位：GitHub 代码审查辅助 CLI：拉取 PR 变更 → 本地对变更做 lint/安全检查 → LLM 生成审查评论（问题/建议，带位置）→ 推送回 GitHub（评论/建议）；本地审查工作流（结合 CI 能力）

---

## 一、定位

`gitreview` — GitHub 代码审查辅助 CLI：拉取 PR 变更 → 本地对**变更代码**做 lint/安全/风险检查 → LLM 生成**审查评论**（问题/建议，定位到文件行）→ 推送回 GitHub（评论/inline）；本地审查工作流（复用 48/prereview、258/lintgrep 能力）。比纯 LLM review 结合真实 lint 与文件定位。

## 二、为什么要做（机会证据）

1. PR 审查要在本地结合 lint/安全分析再评论，纯 LLM 无实际检查、手推评论累。
2. 现有（prereview/48 本地、PR bot 云端）缺"本地 lint + LLM + 推送评论"整合。
3. 需求真实（审查效率/质量），技术中等（拉取 + 分析 + 评论）。

## 三、目标用户

- 开源/团队（审查自动化）
- 需要 lint+AI 审查的人
- 审查工作流

## 四、技术架构

```
gitreview CLI (Node)
  ├─ 拉取：PR（GitHub API 变更/diff）
  ├─ 检查：对变更 lint（复用）+ 安全/风险（复用 48/258）
  ├─ 生成：LLM 审查评论（问题/建议，定位 文件:行）
  ├─ 推送：评论回 GitHub（inline/review 注释，token）
  ├─ 过滤：只评新增/变更、去重、忽略已有
  └─ 报告：推送结果
```

## 五、MVP 功能清单

| 模块 | 工具 |
|---|---|
| 拉取 | PR diff |
| 检查 | lint/安全（变更） |
| 生成 | LLM 评论 |
| 推送 | GitHub 评论 |
| 过滤 | 新增/去重 |
| 报告 | 推送结果 |
| 认证 | token 本地 |

## 六、Roadmap

| 阶段 | 时间 | 交付 |
|---|---|---|
| M1 | 3 周 | 拉取 + 本地 lint + 报告 |
| M2 | 2 周 | LLM 评论 + 推送 |
| M3 | 1 周 | 过滤/去重 + token 安全 |

## 七、关键难点

| 难点 | 应对 |
|---|---|
| 变更定位（inline） | diff 映射 |
| LLM 评论质量 | 注入 lint + 上下文 |
| API 认证/限流 | token + 缓存 |

## 八、竞品分析

| 工具 | 局限 | 差异 |
|---|---|---|
| prereview(48) | 本地 pre-commit | PR 评论推送 |
| PR bot 云 | 云端 | 本地 + lint |

## 九、拿星策略

- 标签：`code-review` `github` `cli` `llm`
- README 卖点：「本地 lint+AI 审查 PR，评论自动推回 GitHub」
- 演示：拉 PR → lint/AI 评论 → 推送 GIF
- 发 r/codereview r/github + 中文审查圈

## 十、目录结构（MVP）

```
gitreview/
├─ src/
│  ├─ main.ts
│  ├─ fetch.rs        # PR diff
│  ├─ check.ts        # lint/安全
│  ├─ llm.ts          # 评论生成
│  ├─ push.ts         # GitHub 评论
│  ├─ filter.ts       # 去重/过滤
│  └─ auth.ts         # token
├─ tests/
├─ README.md
└─ package.json
```

## 十一、风险
- 变更定位（diff 映射）
- LLM 评论质量
- API 认证/限流
- 竞品 PR bot 本地化（靠 lint 结合 + 本地差异化）