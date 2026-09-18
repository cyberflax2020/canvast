# macOS Public Notarization / macOS 公开分发公证

> Optional distribution hardening: this workflow is not required for Canvast
> project completion. Mandatory delivery uses the source-bound internal/ad-hoc
> App, clean-unpack or equivalent target-environment execution, privacy checks,
> real-model acceptance, and final package verification.
>
> 可选分发增强：本流程不是 Canvast 项目完成的必需条件。强制交付标准是当前源码
> 绑定的 internal/ad-hoc App、干净解包或等价目标环境运行、隐私检查、真实模型验收
> 和最终包验证。

`scripts/build-macos-app.sh` produces either an ad-hoc internal App or a
Developer ID signed **pre-notarization** App. It never submits credentials,
contacts Apple's notarization service, staples a ticket, or claims public
distribution.

`scripts/build-macos-app.sh` 仅生成内部使用的 ad-hoc App，或已使用 Developer ID
签名的**公证前** App。它不会提交凭据、访问 Apple 公证服务、装订票据，也不会宣称
产物已满足公开分发要求。

## Public Transaction / 公开分发事务

Use exactly one explicit credential mechanism:

只使用一种显式凭据机制：

```bash
npm run macos:notarize -- \
  --input-app dist/Canvast.app \
  --output-zip release-output/Canvast.app.zip \
  --expected-team-id ABCDE12345 \
  --expected-signer-cn "Developer ID Application: Example Corp (ABCDE12345)" \
  --keychain-profile canvast-notary
```

Or use an App Store Connect API key file:

也可以使用 App Store Connect API key 文件：

```bash
npm run macos:notarize -- \
  --input-app dist/Canvast.app \
  --output-zip release-output/Canvast.app.zip \
  --expected-team-id ABCDE12345 \
  --expected-signer-cn "Developer ID Application: Example Corp (ABCDE12345)" \
  --api-key-file /secure/AuthKey_KEYID.p8 \
  --api-key-id KEYID \
  --api-issuer 00000000-0000-0000-0000-000000000000
```

The command copies the signed App into an isolated same-filesystem transaction,
verifies its Developer ID signature, submits a temporary ZIP with
`xcrun notarytool submit --wait`, requires an `Accepted` receipt, staples and
validates the copied App, runs the public verifier and Gatekeeper assessment,
creates a fresh final ZIP, then verifies that ZIP through clean extraction.
Only then is the ZIP published. An existing output is never overwritten.

命令会把已签名 App 复制到同一文件系统上的隔离事务目录，先验证 Developer ID
签名，再通过 `xcrun notarytool submit --wait` 提交临时 ZIP，并强制要求
`Accepted` 回执。随后对副本执行票据装订与验证、公开分发校验和 Gatekeeper
评估，再重新创建最终 ZIP，并通过洁净解包重复验证。全部成功后才发布 ZIP；
已有输出绝不会被覆盖。

Credential values are accepted only through the command arguments above.
Common Apple credential environment variables are removed from the
`notarytool` process, tool output is not echoed, and receipt files remain only
inside the temporary transaction.

凭据值仅允许通过上述命令参数传入。脚本会从 `notarytool` 进程中移除常见 Apple
凭据环境变量，不回显工具输出，回执文件也只存在于临时事务目录。

Public notarization requires network access and valid Apple credentials. Run it
only as an explicit release operation; normal build and test commands remain
offline.

公开公证需要网络和有效 Apple 凭据。只能把它作为显式发布操作执行；普通构建和
测试命令保持离线。
