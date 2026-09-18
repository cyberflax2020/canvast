import SwiftUI
import CanvastAppCore

struct SandboxGrantManagementView: View {
  let grants: [DesktopSandboxGrant]
  let hasInspectedSandbox: Bool
  let revision: Int?
  let revocationReceipt: DesktopSandboxRevocationReceipt?
  let isRevoking: Bool
  let revoke: (DesktopSandboxGrant) -> Void

  @State private var searchText = ""
  @State private var pendingRevocation: DesktopSandboxGrant?
  @Environment(\.canvastLocalizer) private var localizer

  private var filteredGrants: [DesktopSandboxGrant] {
    SandboxGrantSearch.filtered(grants, query: searchText)
  }

  var body: some View {
    Panel(localizer.text("Active sandbox grants", "活动中的沙箱授权"), systemImage: "key.horizontal") {
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 10) {
          TextField(localizer.text("Search grant id, target, scope, or reason", "搜索授权 ID、目标、范围或原因"), text: $searchText)
            .textFieldStyle(.roundedBorder)
          StatusBadge(
            text: localizer.language == .english
              ? "\(filteredGrants.count) of \(grants.count)"
              : "\(filteredGrants.count) / \(grants.count)",
            color: filteredGrants.isEmpty ? .secondary : .blue
          )
        }

        revocationAvailability
        if let revocationReceipt {
          revocationReceiptView(revocationReceipt)
        }

        if !hasInspectedSandbox {
          EmptyState(
            title: localizer.text("Grant state not loaded", "授权状态未加载"),
            detail: localizer.text("Select Inspect above to load the live session and project grants.", "点击上方“检查”以加载实时会话和项目授权。"),
            systemImage: "arrow.clockwise"
          )
        } else if grants.isEmpty {
          EmptyState(
            title: localizer.text("No active grants", "没有活动授权"),
            detail: localizer.text("The inspected runtime reported no session or project grants.", "检查到的运行时未报告任何会话或项目授权。"),
            systemImage: "key.slash"
          )
        } else if filteredGrants.isEmpty {
          EmptyState(
            title: localizer.text("No matching grants", "没有匹配的授权"),
            detail: localizer.text("Try a grant id, path, command fingerprint, scope, kind, date, or reason.", "可以尝试授权 ID、路径、命令指纹、范围、类型、日期或原因。"),
            systemImage: "magnifyingglass"
          )
        } else {
          LazyVStack(alignment: .leading, spacing: 10) {
            ForEach(filteredGrants) { grant in
              grantRow(grant)
            }
          }
        }
      }
    }
  }

  private var revocationAvailability: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "info.circle")
        .foregroundStyle(.blue)
      Text(SandboxGrantRevocationCapability.current.message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
  }

  private func grantRow(_ grant: DesktopSandboxGrant) -> some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        ScrollableMonospacedText(
          value: grant.value,
          font: .subheadline.weight(.semibold).monospaced(),
          color: .primary
        )
        Spacer(minLength: 8)
        StatusBadge(text: humanized(grant.scope), color: grant.scope == "project" ? .purple : .blue)
        StatusBadge(text: SandboxGrantSearch.kindTitle(grant.kind), color: .secondary)
      }

      LazyVGrid(
        columns: [GridItem(.adaptive(minimum: 180), spacing: 10)],
        alignment: .leading, spacing: 8
      ) {
        grantDetail(localizer.text("Grant ID", "授权 ID"), grant.id)
        grantDetail(localizer.dynamic("created"), grant.createdAt.isEmpty ? localizer.dynamic("not_recorded") : grant.createdAt)
        grantDetail(localizer.dynamic("reason"), displayReason(grant.reason))
      }

      HStack {
        Button(localizer.text("Revoke", "撤销"), role: .destructive) {
          pendingRevocation = grant
        }
          .disabled(isRevoking || revision == nil)
          .help(SandboxGrantRevocationCapability.current.message)
        Text(localizer.text(
          "Revocation changes subsequent authorization only.",
          "撤销仅影响后续鉴权。"
        ))
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(nsColor: .textBackgroundColor).opacity(0.55), in: RoundedRectangle(cornerRadius: 9))
    .overlay(RoundedRectangle(cornerRadius: 9).stroke(.separator.opacity(0.45)))
    .confirmationDialog(
      localizer.text("Revoke this sandbox grant?", "撤销此沙箱授权？"),
      isPresented: Binding(
        get: { pendingRevocation?.id == grant.id },
        set: { if !$0 { pendingRevocation = nil } }
      ),
      titleVisibility: .visible,
      presenting: pendingRevocation
    ) { selected in
      Button(localizer.text("Revoke grant", "撤销授权"), role: .destructive) {
        pendingRevocation = nil
        revoke(selected)
      }
      Button(localizer.dynamic("cancel"), role: .cancel) {
        pendingRevocation = nil
      }
    } message: { selected in
      Text(localizer.text(
        "Future authorization checks will stop using \(selected.value). Already-started operations will not be terminated.",
        "后续鉴权将不再使用 \(selected.value)。已启动的操作不会被终止。"
      ))
    }
  }

  private func revocationReceiptView(_ receipt: DesktopSandboxRevocationReceipt) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "checkmark.shield")
        .foregroundStyle(.green)
      VStack(alignment: .leading, spacing: 3) {
        Text(localizer.text("Grant revoked", "授权已撤销"))
          .font(.caption.weight(.semibold))
        Text(localizer.text(
          "Revision \(receipt.revision). Already-started operations were not terminated.",
          "版本 \(receipt.revision)。已启动的操作未被终止。"
        ))
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
  }

  private func grantDetail(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label).font(.caption2).foregroundStyle(.secondary)
      ScrollableMonospacedText(value: value)
    }
  }

  private func displayReason(_ reason: String?) -> String {
    guard let reason, !reason.isEmpty else { return localizer.dynamic("not_recorded") }
    return reason
  }
}

enum SandboxGrantSearch {
  static func filtered(_ grants: [DesktopSandboxGrant], query: String) -> [DesktopSandboxGrant] {
    let terms = query
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
      .split(whereSeparator: \.isWhitespace)
      .map(String.init)
    guard !terms.isEmpty else { return grants }
    return grants.filter { grant in
      let searchable = [
        grant.id, grant.scope, grant.kind, kindTitle(grant.kind), grant.value,
        grant.createdAt, grant.reason ?? "",
      ].joined(separator: " " ).lowercased()
      return terms.allSatisfy(searchable.contains)
    }
  }

  static func kindTitle(_ kind: String) -> String {
    let localizer = CanvastLocalizationRuntime.localizer
    switch kind {
    case "read_path": return localizer.text("Read path", "读取路径")
    case "write_path": return localizer.text("Write path", "写入路径")
    case "command": return localizer.dynamic("command")
    case "profile": return localizer.dynamic("profile")
    default: return humanized(kind, localizer: localizer)
    }
  }
}

struct SandboxGrantRevocationCapability: Equatable {
  let isAvailable: Bool
  let actionKind: String?
  let message: String

  static var current: SandboxGrantRevocationCapability {
    .init(
      isAvailable: true,
      actionKind: CanvastDesktopActionKind.revokeSandboxAccess.rawValue,
      message: CanvastLocalizationRuntime.localizer.text(
        "Revocation applies to subsequent authorization checks and does not terminate already-started operations.",
        "撤销对后续鉴权生效，不会终止已启动的操作。"
      )
    )
  }
}
