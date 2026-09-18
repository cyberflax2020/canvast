import SwiftUI
import CanvastAppCore

struct CanvastSettingsView: View {
  @EnvironmentObject private var model: CanvastDesktopModel
  @Environment(\.canvastLocalizer) private var localizer
  @State private var confirmCredentialRevocation = false
  let automaticallyReloadSettings: Bool
  let rendersStaticFields: Bool

  init(automaticallyReloadSettings: Bool = true, rendersStaticFields: Bool = false) {
    self.automaticallyReloadSettings = automaticallyReloadSettings
    self.rendersStaticFields = rendersStaticFields
  }

  private var providerActionTitle: String {
    let configured = model.state.runtimeStatus.model.provider
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let draft = model.settingsDraft.provider
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !configured.isEmpty, configured.caseInsensitiveCompare(draft) != .orderedSame else {
      return localizer.text("Apply Provider", "应用服务商配置")
    }
    return localizer.text("Switch Provider", "切换服务商")
  }

  private var latestSettingsAction: DesktopActionSnapshot? {
    [
      model.actionSnapshot(.saveSettings),
      model.actionSnapshot(.testProviderConnection),
      model.actionSnapshot(.applyProviderSettings),
      model.actionSnapshot(.revokeProviderCredential),
    ]
    .compactMap { $0 }
    .sorted { left, right in
      if left.isActive != right.isActive { return left.isActive }
      return left.updatedAt > right.updatedAt
    }
    .first
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        header
        workspaceSection
        providerSection
        operationSection
      }
      .padding(24)
    }
    .frame(minWidth: 620, idealWidth: 680, minHeight: 580, idealHeight: 680)
    .onAppear {
      if automaticallyReloadSettings {
        model.reloadSettings()
      }
    }
    .confirmationDialog(
      localizer.text("Revoke this provider credential?", "要撤销此服务商凭据吗？"),
      isPresented: $confirmCredentialRevocation,
      titleVisibility: .visible
    ) {
      Button(localizer.text("Revoke Credential", "撤销凭据"), role: .destructive) {
        model.revokeProviderCredential()
      }
    } message: {
      Text(localizer.text(
        "The API key will be removed from Keychain and cleared from the current App configuration.",
        "API 密钥将从 Keychain 中移除，并从当前应用配置中清除。"
      ))
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(localizer.text("Settings", "设置"))
        .font(.title2.bold())
      Text(localizer.text(
        "Configure the project workspace, local runtime, model provider, and app language used by Canvast.",
        "配置 Canvast 使用的项目工作区、本地运行时、模型服务商和应用语言。"
      ))
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
  }

  private var workspaceSection: some View {
    SettingsSection(localizer.text("Workspace & Runtime", "工作区与运行时"), systemImage: "folder.badge.gearshape") {
      SettingsPathField(
        title: localizer.text("Workspace directory", "工作区目录"),
        prompt: localizer.text("Choose the project Canvast should open", "选择 Canvast 要打开的项目"),
        text: $model.settingsDraft.workspacePath,
        chooseLabel: localizer.text("Choose", "选择"),
        choose: model.chooseWorkspace,
        rendersStaticField: rendersStaticFields
      )

      Divider()

      SettingsPathField(
        title: localizer.text("Development runtime fallback", "开发运行时回退目录"),
        prompt: localizer.text("Optional path to an unpacked Canvast runtime", "可选：未封装 Canvast 运行时目录"),
        text: $model.settingsDraft.developmentRuntimePath,
        chooseLabel: localizer.text("Choose", "选择"),
        choose: model.chooseDevelopmentRuntime,
        clear: model.clearDevelopmentRuntime,
        rendersStaticField: rendersStaticFields
      )

      Text(localizer.text(
        "The signed runtime bundled with the app remains preferred. This explicit directory is used only when a bundled runtime is unavailable.",
        "应用内置的签名运行时仍然优先。只有在内置运行时不可用时，才会使用这里指定的目录。"
      ))
        .font(.caption)
        .foregroundStyle(.secondary)

      SettingsStatusRow(
        title: localizer.text("Runtime", "运行时"),
        value: humanized(model.runtimeAvailability.state.rawValue, localizer: localizer),
        detail: runtimeAvailabilityDetail,
        color: runtimeAvailabilityColor,
        systemImage: runtimeAvailabilityIcon
      )
    }
  }

  private var providerSection: some View {
    SettingsSection(localizer.text("Provider", "服务商"), systemImage: "network") {
      VStack(alignment: .leading, spacing: 6) {
        Text(localizer.text("App language", "应用语言"))
          .font(.subheadline.weight(.medium))
        Picker(localizer.text("Language", "语言"), selection: $model.settingsDraft.languagePreference) {
          ForEach(CanvastAppLanguagePreference.allCases) { preference in
            Text(languagePreferenceLabel(preference)).tag(preference)
          }
        }
        .pickerStyle(.segmented)
        .onChange(of: model.settingsDraft.languagePreference) { preference in
          model.applyLanguagePreference(preference)
        }
        Text(localizer.text(
          "Language changes apply immediately and are stored in app settings.",
          "语言切换会立即生效，并写入应用设置。"
        ))
        .font(.caption)
        .foregroundStyle(.secondary)
      }

      Divider()

      SettingsTextField(
        title: localizer.text("Provider", "服务商"),
        prompt: localizer.text("Provider identifier", "服务商标识"),
        text: $model.settingsDraft.provider,
        rendersStaticField: rendersStaticFields
      )
      SettingsTextField(
        title: localizer.text("Model", "模型"),
        prompt: localizer.text("Model identifier", "模型标识"),
        text: $model.settingsDraft.model,
        rendersStaticField: rendersStaticFields
      )
      SettingsTextField(
        title: localizer.text("Base URL", "服务地址"),
        prompt: "https://api.example.com/v1",
        text: $model.settingsDraft.baseURL,
        rendersStaticField: rendersStaticFields
      )

      VStack(alignment: .leading, spacing: 6) {
        Text(localizer.text("API key", "API 密钥"))
          .font(.subheadline.weight(.medium))
        apiKeyField
        Text(localizer.text(
          "Save stores this key in the system Keychain. Canvast reads it only for provider-backed actions such as sending prompts, testing the connection, applying provider settings, or exporting Canvas; conversation management uses the workspace and does not read the secret.",
          "保存后密钥会写入系统 Keychain。Canvast 只会在发送提示词、测试连接、应用服务商配置或导出画布等依赖服务商的操作中读取它；会话管理只使用工作区，不读取密钥。"
        ))
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      SettingsStatusRow(
        title: localizer.text("Authentication", "认证"),
        value: model.providerAuthStatus.isAuthenticated
          ? localizer.text("Configured", "已配置")
          : localizer.text("Not configured", "未配置"),
        detail: localizer.text("Source:", "来源：") + " \(authSourceText)",
        color: model.providerAuthStatus.isAuthenticated ? .green : .orange,
        systemImage: model.providerAuthStatus.isAuthenticated ? "key.fill" : "key.slash"
      )
    }
  }

  private var operationSection: some View {
    SettingsSection(localizer.text("Apply & Verify", "应用与验证"), systemImage: "checkmark.seal") {
      HStack(spacing: 10) {
        Button(localizer.text("Save", "保存")) { model.saveSettings() }
          .buttonStyle(.borderedProminent)
          .disabled(model.isActionLocked(.saveSettings))

        Button(localizer.text("Test Connection", "测试连接")) { model.testProviderConnection() }
          .buttonStyle(.bordered)
          .disabled(model.isActionLocked(.testProviderConnection))

        Button(providerActionTitle) { model.applyProviderSettings() }
          .buttonStyle(.bordered)
          .disabled(model.isActionLocked(.applyProviderSettings))

        Button(localizer.text("Revoke Credential", "撤销凭据"), role: .destructive) {
          confirmCredentialRevocation = true
        }
        .buttonStyle(.bordered)
        .disabled(
          !model.providerAuthStatus.isAuthenticated
            || model.isActionLocked(.revokeProviderCredential)
        )

        Spacer()
      }

      if !model.connectionTestStatus.isEmpty {
        Text(model.connectionTestStatus)
          .font(.caption)
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
      }

      VStack(spacing: 8) {
        SettingsLifecycleRow(
          title: localizer.text("Save settings", "保存设置"), snapshot: model.actionSnapshot(.saveSettings)
        )
        SettingsLifecycleRow(
          title: localizer.text("Test connection", "测试连接"), snapshot: model.actionSnapshot(.testProviderConnection)
        )
        SettingsLifecycleRow(
          title: localizer.text("Apply provider", "应用服务商配置"), snapshot: model.actionSnapshot(.applyProviderSettings)
        )
        SettingsLifecycleRow(
          title: localizer.text("Revoke credential", "撤销凭据"),
          snapshot: model.actionSnapshot(.revokeProviderCredential)
        )
      }

      LifecycleInspectorCard(snapshot: latestSettingsAction)
    }
  }

  @ViewBuilder
  private var apiKeyField: some View {
    if rendersStaticFields {
      SettingsStaticField(
        value: model.settingsDraft.apiKey,
        prompt: localizer.text("Enter or replace the provider API key", "输入或替换服务商 API 密钥"),
        isSecret: true
      )
    } else {
      SecureField(localizer.text("Enter or replace the provider API key", "输入或替换服务商 API 密钥"), text: $model.settingsDraft.apiKey)
        .textFieldStyle(.roundedBorder)
        .privacySensitive()
    }
  }

  private var runtimeAvailabilityDetail: String {
    let source = model.runtimeAvailability.source.trimmingCharacters(in: .whitespacesAndNewlines)
    return source.isEmpty
      ? model.runtimeAvailability.message
      : localizer.text("\(model.runtimeAvailability.message) Source: \(source).", "\(model.runtimeAvailability.message) 来源：\(source)。")
  }

  private var authSourceText: String {
    model.providerAuthStatus.source.map { humanized($0.rawValue, localizer: localizer) }
      ?? localizer.dynamic("none")
  }

  private var runtimeAvailabilityColor: Color {
    switch model.runtimeAvailability.state.rawValue {
    case "checking": return .blue
    case "ready": return .green
    case "missing": return .orange
    default: return .red
    }
  }

  private var runtimeAvailabilityIcon: String {
    switch model.runtimeAvailability.state.rawValue {
    case "checking": return "clock.arrow.circlepath"
    case "ready": return "checkmark.circle.fill"
    case "missing": return "exclamationmark.triangle.fill"
    default: return "xmark.octagon.fill"
    }
  }

  private func languagePreferenceLabel(_ preference: CanvastAppLanguagePreference) -> String {
    switch preference {
    case .system: return localizer.text("System", "系统")
    case .english: return localizer.text("English", "English")
    case .simplifiedChinese: return localizer.text("Simplified Chinese", "简体中文")
    }
  }
}

private struct SettingsSection<Content: View>: View {
  @Environment(\.canvastLocalizer) private var localizer
  let title: String
  let systemImage: String
  let content: Content

  init(_ title: String, systemImage: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.systemImage = systemImage
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Label(title, systemImage: systemImage)
        .font(.headline)
      content
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(.separator.opacity(0.55)))
  }
}

private struct SettingsPathField: View {
  @Environment(\.canvastLocalizer) private var localizer
  let title: String
  let prompt: String
  @Binding var text: String
  let chooseLabel: String
  let choose: () -> Void
  var clear: (() -> Void)? = nil
  var rendersStaticField = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.subheadline.weight(.medium))
      HStack(spacing: 8) {
        if rendersStaticField {
          SettingsStaticField(value: text, prompt: prompt)
        } else {
          TextField(prompt, text: $text)
            .textFieldStyle(.roundedBorder)
        }
        if let clear {
          Button(localizer.text("Clear", "清空"), action: clear)
        }
        Button(chooseLabel, action: choose)
      }
    }
  }
}

private struct SettingsTextField: View {
  let title: String
  let prompt: String
  @Binding var text: String
  var rendersStaticField = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.subheadline.weight(.medium))
      if rendersStaticField {
        SettingsStaticField(value: text, prompt: prompt)
      } else {
        TextField(prompt, text: $text)
          .textFieldStyle(.roundedBorder)
      }
    }
  }
}

private struct SettingsStaticField: View {
  let value: String
  let prompt: String
  var isSecret = false

  private var displayText: String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return prompt }
    return isSecret ? String(repeating: "•", count: min(max(trimmed.count, 8), 24)) : trimmed
  }

  var body: some View {
    Text(displayText)
      .font(.body)
      .foregroundStyle(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .secondary : .primary)
      .frame(maxWidth: .infinity, minHeight: 21, alignment: .leading)
      .padding(.horizontal, 6)
      .padding(.vertical, 4)
      .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 5))
      .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color(nsColor: .separatorColor).opacity(0.85)))
  }
}

private struct SettingsStatusRow: View {
  let title: String
  let value: String
  let detail: String
  let color: Color
  let systemImage: String

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: systemImage)
        .foregroundStyle(color)
        .frame(width: 18)
      VStack(alignment: .leading, spacing: 3) {
        HStack {
          Text(title).font(.subheadline.weight(.medium))
          StatusBadge(text: value, color: color)
        }
        Text(detail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }
      Spacer(minLength: 0)
    }
  }
}

private struct SettingsLifecycleRow: View {
  let title: String
  let snapshot: DesktopActionSnapshot?

  var body: some View {
    HStack {
      Text(title)
        .font(.caption)
        .foregroundStyle(.secondary)
      Spacer()
      LifecycleStateBadge(snapshot: snapshot)
    }
    .padding(.vertical, 2)
  }
}
