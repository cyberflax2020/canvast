# Contributing to Canvast

## English

Thank you for helping improve Canvast. Keep each change focused, describe the user-visible behavior it affects, and add or update tests for observable behavior.

### Set up the repository

Use Node.js 22.19 or newer, npm, and Python 3 for bundled-skill verification. Install the locked dependency graph:

```bash
npm ci
```

### Validate a change

Run the checks published by this repository:

```bash
npm run typecheck
npm run verify:brand
npm run verify:skills
npm run verify:public
```

`verify:public` checks the repository manifest, distributable payload, links, licenses, and excluded secret paths. It does not make live model calls. Commands outside the scripts listed by `npm run` are not part of this repository's supported contribution workflow.

### Design rules

- Keep Canvas entities and relationships minimal and typed.
- Use explicit state, schemas, parsers, and tool events for semantic decisions. Regular expressions are limited to narrow syntactic or safety boundaries.
- Do not add an external dependency without checking its license and updating `THIRD_PARTY_NOTICES.md`. GPL, AGPL, and source-available licenses are not accepted for distributed product code.
- Never commit credentials, local session data, generated runtime output, or personal absolute paths.
- Keep product-facing text focused on Canvast and substantiate any comparative claim with clearly scoped evidence.

Before submitting a change, review the affected documentation in both languages and confirm that every documented command exists in the repository `package.json`.

## 中文

感谢你参与改进 Canvast。请保持每项变更聚焦，说明它影响的用户可见行为，并为可观察行为新增或更新测试。

### 配置仓库

使用 Node.js 22.19 或更高版本与 npm；内置 skill 校验还需要 Python 3。安装 lockfile 锁定的依赖图：

```bash
npm ci
```

### 验证变更

运行本仓库公开提供的检查：

```bash
npm run typecheck
npm run verify:brand
npm run verify:skills
npm run verify:public
```

`verify:public` 会检查仓库 manifest、可分发 payload、链接、许可证和需要排除的 secret 路径；它不会发起真实模型调用。`npm run` 未列出的命令不属于本仓库支持的贡献流程。

### 设计规则

- 保持 Canvas 实体与关系精简且类型明确。
- 语义决策使用显式状态、schema、parser 和工具事件；正则表达式只限于狭窄的语法或安全边界。
- 添加外部依赖前必须检查许可证并更新 `THIRD_PARTY_NOTICES.md`。分发的产品代码不接受 GPL、AGPL 或 source-available 许可证。
- 不得提交凭据、本地 session 数据、生成的 runtime 输出或个人绝对路径。
- 产品文案聚焦 Canvast 本身；任何比较性结论都必须有边界清晰的证据支持。

提交变更前，请同时审阅受影响文档的中英文内容，并确认每条文档命令都确实存在于仓库 `package.json` 中。
