# Changelog

## Unreleased

### P0（必须优先）

- 将 AI API Key 迁移到 VS Code SecretStorage；Webview 不下发/不存储明文 Key
- 对来自 Webview 的文件路径做 workspace root 越界校验，避免误删/任意路径访问（checkout untracked 删除、openDiff 等）
- 统一错误信息脱敏与日志策略，避免回显敏感配置与超长响应片段

### P1（高优先）

- 拆分超大文件 extension.ts：分离 Webview 协议、UI 生成、Action handlers、Git/AI 服务层
- 增强 AI 调用稳定性：超时与重试策略、可取消一致性、流式解析健壮性（异常 chunk/半行/非 SSE）
- 增强 Git 操作可靠性：更清晰的 preflight 信息、失败回滚与安全分支/安全 stash 策略统一
- 增加回归测试：路径校验、危险操作确认流程、提示词拼装/截断策略、JSON 解析容错

### P2（中优先）

- 上下文选择器：staged/workingTree、仅选中文件、忽略大文件/lockfile/二进制、最大文件数与最大上下文阈值
- 生成逻辑“先摘要后补充”：优先 diff summary + 关键 hunks，降低成本与超时风险
- PR 工作流增强：根据 origin URL 自动识别 GitHub/GitLab/Bitbucket；baseRef 探测更稳健
- CHANGELOG 增量更新：读取已有 CHANGELOG，仅更新 Unreleased，而非每次全量重写
- 结果应用方式可选：填入 SCM 输入框 / 复制 / 打开 Commit 编辑器并支持二次改写
- 成本与可观测性：近 N 次请求的耗时/失败率/估算 tokens（字符数）展示与阈值告警

### P3（低优先 / 探索）

- 变更自动拆分：给出 2–5 条提交计划（每条的文件集合 + commit message 草案）
- PR Review 助手：根据 diff 给出风险点、测试建议、review checklist 与潜在回归清单
