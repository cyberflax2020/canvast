# Security Policy

## English

### Reporting a vulnerability

Do not open a public issue for vulnerabilities, credential exposure, sandbox escape, unsafe command execution, or permission bypass. Use GitHub's private vulnerability reporting ("Report a vulnerability" under the repository's Security tab) to open a private advisory with the maintainers. If you are reading an extracted package and cannot identify that channel, ask your distributor for its private security contact before sending sensitive details.

Include the affected version, reproduction steps, expected impact, and whether any credential or user data may have been exposed. Do not include live credentials in the report.

### Supported versions

Security fixes target the latest released version and the current default branch. Earlier versions are not supported.

### Security boundaries

Canvast can execute tools, access configured model providers, and write project files. Users should review requested permissions, use least-privilege credentials, and keep `.env`, `.canvast-secrets/`, session data, runtime output, and generated reports containing project data outside published repositories.

In a repository checkout, `npm run verify:public` detects common credential forms and personal absolute paths. In an extracted npm package, use `npm run typecheck` and `npm run verify:skills`; review files manually before sharing them. Automated checks are defense in depth rather than a guarantee.

## 中文

### 报告安全漏洞

请勿为漏洞、凭据泄露、沙箱逃逸、不安全命令执行或权限绕过提交公开 issue。请使用 GitHub 的私密漏洞报告功能（仓库 Security 标签页下的 "Report a vulnerability"）与维护者开立私密 advisory。若你使用的是解压后的 package，且无法确认该渠道，请先向分发方索取私密安全联系方式，再发送敏感细节。

报告中请包含受影响版本、复现步骤、预期影响，以及是否可能暴露凭据或用户数据。请勿在报告中提供仍然有效的凭据。

### 支持的版本

安全修复面向最新发布版本与当前默认分支，早期版本不在支持范围内。

### 安全边界

Canvast 可以执行工具、访问已配置的模型服务并写入项目文件。用户应检查申请的权限、使用最小权限凭据，并确保 `.env`、`.canvast-secrets/`、session 数据、runtime 输出和含项目数据的生成报告不进入公开仓库。

在仓库 checkout 中，`npm run verify:public` 会检测常见凭据形式和个人绝对路径。解压后的 npm package 请运行 `npm run typecheck` 与 `npm run verify:skills`，并在共享文件前人工检查。自动化检查只是纵深防御，并非绝对保证。
