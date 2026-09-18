import Foundation
import CanvastAppCore

enum DesktopUIActionID: String, CaseIterable, Identifiable {
  case refreshWorkspace
  case setRuntimeMode
  case setThinkingLevel
  case previewRun
  case startRun
  case stopRun
  case clearConsole
  case sendRequestControl
  case createPlan
  case createTask
  case approvePlan
  case completePlan
  case updatePlan
  case updateTask
  case launchAgent
  case launchWorkflow
  case startNewSession
  case loadSessionCatalog
  case openSession
  case renameSession
  case deleteSession
  case loadSessionTranscript
  case runProjectPreflight
  case createProjectSession
  case openProjectSession
  case reinitializeProject
  case retireProject
  case inspectResume
  case chooseResume
  case claimResume
  case rebindResume
  case retireResume
  case reconcileResume
  case restartProjectRuntime
  case inspectProjectScope
  case rebindProjectScope
  case inspectSandbox
  case setSandboxProfile
  case grantSandboxAccess
  case revokeSandboxAccess
  case setPermissionMode
  case selectCanvasTask
  case selectCanvasPlan
  case exportCanvas
  case refreshCanvas
  case filterCanvasSnapshot
  case reloadPersistedSnapshot
  case saveSettings
  case testProviderConnection
  case applyProviderSettings
  case revokeProviderCredential

  var id: String { rawValue }
}

enum DesktopActionRegistry {
  static let controlRegistrations: [DesktopUIControlRegistration] = [
    execution("workbench.toolbar.refresh", "CanvastWorkbenchView.swift", "Button", "Refresh", .refreshWorkspace),
    execution("workbench.toolbar.mode", "CanvastWorkbenchView.swift", "Picker", "Live mode", .setRuntimeMode),
    execution("workbench.toolbar.thinking", "CanvastWorkbenchView.swift", "Picker", "Thinking", .setThinkingLevel),
    navigation("workbench.sidebar.workspace", "CanvastWorkbenchView.swift", "Button", "Workspace"),
    navigation("workbench.sidebar.currentRun", "CanvastWorkbenchView.swift", "Button", "Current run"),
    navigation("workbench.inspector.clearSelection", "CanvastWorkbenchView.swift", "Button", "Clear Canvas selection"),
    execution("workbench.inspector.activeTask", "CanvastWorkbenchView.swift", "Button", "Use as Active Task", .selectCanvasTask),
    execution("workbench.inspector.activePlan", "CanvastWorkbenchView.swift", "Button", "Use as Active Plan", .selectCanvasPlan),
    edit("workbench.inspector.prepare", "CanvastWorkbenchView.swift", "Button", "Prepare in Run Console"),
    edit("workbench.inspector.copy", "CanvastWorkbenchView.swift", "Button", "Copy command"),
    navigation("workbench.inspector.edge", "CanvastWorkbenchView.swift", "Button", "Open connected node"),

    execution("run.preview", "RunConsoleView.swift", "Button", "Preview", .previewRun),
    execution("run.start", "RunConsoleView.swift", "Button", "Run", .startRun),
    execution("run.stop", "RunConsoleView.swift", "Button", "Stop", .stopRun),
    execution("run.clear", "RunConsoleView.swift", "Button", "Clear", .clearConsole),
    edit("run.control.policy", "RunConsoleView.swift", "Picker", "Request policy"),
    edit("run.control.draft", "RunConsoleView.swift", "TextField", "Control request"),
    execution("run.control.submit", "RunConsoleView.swift", "Button", "Send Control", .sendRequestControl),
    execution("run.control.return", "RunConsoleView.swift", "Submit", "Send Control", .sendRequestControl),
    edit("run.prompt", "RunConsoleView.swift", "TextEditor", "Prompt"),
    edit("run.timeout", "RunConsoleView.swift", "Stepper", "Timeout"),
    edit("run.followOutput", "RunConsoleView.swift", "Toggle", "Follow output"),

    execution("planning.refresh", "TaskPlanView.swift", "Button", "Refresh", .refreshWorkspace),
    edit("planning.newTitle", "TaskPlanView.swift", "TextField", "Plan or task title"),
    execution("planning.createPlan", "TaskPlanView.swift", "Button", "Create Plan", .createPlan),
    execution("planning.createTask", "TaskPlanView.swift", "Button", "Create Task", .createTask),
    edit("planning.lifecycleNote", "TaskPlanView.swift", "TextField", "Lifecycle note"),
    edit("planning.search", "TaskPlanView.swift", "TextField", "Search plans and tasks"),
    edit("planning.showCompleted", "TaskPlanView.swift", "Toggle", "Show completed"),
    execution("planning.approve", "TaskPlanView.swift", "Button", "Approve Current Plan", .approvePlan),
    execution("planning.complete", "TaskPlanView.swift", "Button", "Complete Current Plan", .completePlan),
    execution("planning.activePlan", "TaskPlanView.swift", "Button", "Use as Active Plan", .selectCanvasPlan),
    execution("planning.activeTask", "TaskPlanView.swift", "Button", "Use as Active Task", .selectCanvasTask),
    edit("planning.plan.status", "PlanUpdateControlsView.swift", "Picker", "Target status"),
    execution("planning.plan.update", "PlanUpdateControlsView.swift", "Button", "Request Plan Update", .updatePlan),
    execution("planning.task.inProgress", "TaskPlanView.swift", "Button", "Mark In Progress", .updateTask),
    execution("planning.task.completed", "TaskPlanView.swift", "Button", "Mark Completed", .updateTask),
    navigation("planning.showOnCanvas", "TaskPlanView.swift", "Button", "Show on Canvas"),
    navigation("planning.item.select", "TaskPlanView.swift", "Button", "Select plan or task"),
    navigation("planning.trace.select", "TaskPlanView.swift", "Button", "Open persisted plan on Canvas"),
    edit("planning.prepareStatus", "TaskPlanView.swift", "Button", "Prepare status request"),

    execution("tools.refresh", "ToolsContextSessionsView.swift", "Button", "Refresh", .refreshWorkspace),
    navigation("tools.section", "ToolsContextSessionsView.swift", "Picker", "Workspace section"),
    edit("tools.search", "ToolsContextSessionsView.swift", "TextField", "Search capabilities"),
    navigation("tools.feature.select", "ToolsContextSessionsView.swift", "Button", "Capability card"),
    edit("tools.prepare", "ToolsContextSessionsView.swift", "Button", "Prepare in Run Console"),
    edit("tools.copyCommand", "ToolsContextSessionsView.swift", "Button", "Copy TUI command"),
    edit("context.prepareReview", "ToolsContextSessionsView.swift", "Button", "Prepare Context Review"),
    edit("sessions.copyProjectPath", "ToolsContextSessionsView.swift", "Button", "Copy Project Path"),
    edit("sessions.copyStatePath", "ToolsContextSessionsView.swift", "Button", "Copy State Path"),
    edit("sessions.search", "SessionWorkspaceView.swift", "TextField", "Search sessions"),
    navigation("sessions.item.select", "SessionWorkspaceView.swift", "Button", "Conversation"),
    execution("sessions.new", "SessionWorkspaceView.swift", "Button", "New Chat", .startNewSession),
    execution("sessions.catalog", "SessionWorkspaceView.swift", "Button", "Refresh History", .loadSessionCatalog),
    execution("sessions.open", "SessionWorkspaceView.swift", "Button", "Open Conversation", .openSession),
    execution("sessions.rename", "SessionWorkspaceView.swift", "Button", "Rename Conversation", .renameSession),
    execution("sessions.delete", "SessionWorkspaceView.swift", "Button", "Delete Conversation", .deleteSession),
    execution("sessions.transcript", "SessionWorkspaceView.swift", "Button", "Load Transcript", .loadSessionTranscript),
    edit("sessions.process.toggle", "SessionWorkspaceView.swift", "Toggle", "Process"),
    edit("sessions.composer.policy", "SessionWorkspaceView.swift", "Picker", "Request policy"),
    edit("sessions.composer.draft", "SessionWorkspaceView.swift", "TextEditor", "Conversation message"),
    execution("sessions.composer.run", "SessionWorkspaceView.swift", "Button", "Send", .startRun),
    execution("sessions.composer.control.submit", "SessionWorkspaceView.swift", "Button", "Send", .sendRequestControl),
    execution("project.preflight", "ProjectLifecycleView.swift", "Button", "Run Project Safety Check", .runProjectPreflight),
    execution("project.create", "ProjectLifecycleView.swift", "Button", "Create Project Session", .createProjectSession),
    execution("project.open", "ProjectLifecycleView.swift", "Button", "Open Project Session", .openProjectSession),
    execution("project.reinitialize", "ProjectLifecycleView.swift", "Button", "Reinitialize Project", .reinitializeProject),
    execution("project.delete", "ProjectLifecycleView.swift", "Button", "Retire Project", .retireProject),
    execution("resume.inspect", "SessionContinuityView.swift", "Button", "Inspect Candidate", .inspectResume),
    execution("resume.choose", "SessionContinuityView.swift", "Button", "Select Candidate", .chooseResume),
    execution("resume.claim", "SessionContinuityView.swift", "Button", "Resume Candidate", .claimResume),
    execution("resume.rebind", "SessionContinuityView.swift", "Button", "Repair Binding", .rebindResume),
    execution("resume.retire", "SessionContinuityView.swift", "Button", "Retire Candidate", .retireResume),
    execution("resume.reconcile", "SessionContinuityView.swift", "Button", "Refresh Resume State", .reconcileResume),
    execution("sessions.restart", "ToolsContextSessionsView.swift", "Button", "Restart Project Runtime", .restartProjectRuntime),
    execution("sessions.reload", "ToolsContextSessionsView.swift", "Button", "Reload Persisted State", .refreshWorkspace),
    execution("sessions.inspectScope", "ToolsContextSessionsView.swift", "Button", "Inspect Scope", .inspectProjectScope),
    navigation("sessions.rebindDialog", "ToolsContextSessionsView.swift", "Button", "Rebind to Current Project"),
    execution("sessions.rebindConfirm", "ToolsContextSessionsView.swift", "Button", "Confirm Rebind", .rebindProjectScope),
    edit("sessions.stateRecord.copyPath", "ToolsContextSessionsView.swift", "Button", "Copy persisted-state path"),
    edit("context.attachment.copyPlaceholder", "ToolsContextSessionsView.swift", "Button", "Copy attachment placeholder"),

    execution("safety.refresh", "SafetyPermissionsView.swift", "Button", "Refresh", .refreshWorkspace),
    execution("safety.inspect", "SafetyPermissionsView.swift", "Button", "Inspect", .inspectSandbox),
    edit("safety.profile", "SafetyPermissionsView.swift", "Picker", "Profile"),
    execution("safety.applyProfile", "SafetyPermissionsView.swift", "Button", "Apply Profile", .setSandboxProfile),
    navigation("safety.fullAccess.openConfirmation", "SafetyPermissionsView.swift", "Button", "Open full-access confirmation"),
    execution("safety.fullAccess.confirm", "SafetyPermissionsView.swift", "Button", "Request Full Access", .setSandboxProfile),
    edit("safety.grant.target", "SafetyPermissionsView.swift", "Picker", "Target"),
    edit("safety.grant.value", "SafetyPermissionsView.swift", "TextField", "Grant value"),
    edit("safety.grant.access", "SafetyPermissionsView.swift", "Picker", "Access"),
    edit("safety.grant.scope", "SafetyPermissionsView.swift", "Picker", "Scope"),
    edit("safety.grant.reason", "SafetyPermissionsView.swift", "TextField", "Reason"),
    execution("safety.grant.submit", "SafetyPermissionsView.swift", "Button", "Grant Explicit Access", .grantSandboxAccess),
    edit("safety.grants.search", "SandboxGrantManagementView.swift", "TextField", "Search active grants"),
    execution("safety.grants.revoke", "SandboxGrantManagementView.swift", "Button", "Revoke grant", .revokeSandboxAccess),
    execution("safety.stopRun", "SafetyPermissionsView.swift", "Button", "Stop Active Run", .stopRun),
    execution("safety.permission.ask", "SafetyPermissionsView.swift", "Button", "Set Ask Every Time", .setPermissionMode),
    execution("safety.permission.auto", "SafetyPermissionsView.swift", "Button", "Set Automatic", .setPermissionMode),
    edit("safety.history.search", "SafetyPermissionsView.swift", "TextField", "Search permission decisions"),
    edit("safety.history.risk", "SafetyPermissionsView.swift", "Picker", "Risk filter"),
    edit("safety.history.decision", "SafetyPermissionsView.swift", "Picker", "Decision filter"),
    edit("safety.history.prepare", "SafetyPermissionsView.swift", "Button", "Prepare an audit request"),
    edit("safety.history.copyRationale", "SafetyPermissionsView.swift", "Button", "Copy rationale"),
    edit("safety.preparePermissionAudit", "SafetyPermissionsView.swift", "Button", "Prepare Permission Audit"),

    execution("orchestration.refresh", "AgentsWorkflowView.swift", "Button", "Refresh", .refreshWorkspace),
    edit("orchestration.search", "AgentsWorkflowView.swift", "TextField", "Search agents and workflows"),
    edit("orchestration.goal", "AgentsWorkflowView.swift", "TextField", "Agent task or workflow goal"),
    execution("orchestration.launchAgent", "AgentsWorkflowView.swift", "Button", "Launch Agent", .launchAgent),
    execution("orchestration.launchWorkflow", "AgentsWorkflowView.swift", "Button", "Launch Workflow", .launchWorkflow),
    navigation("orchestration.showOnCanvas", "AgentsWorkflowView.swift", "Button", "Show on Canvas"),
    navigation("orchestration.item.select", "AgentsWorkflowView.swift", "Button", "Select agent or workflow"),
    navigation("orchestration.persisted.select", "AgentsWorkflowView.swift", "Button", "Open persisted agent run on Canvas"),

    edit("canvas.search", "CanvasGraphView.swift", "TextField", "Search node id, title, or details"),
    edit("canvas.type", "CanvasGraphView.swift", "Picker", "Type"),
    navigation("canvas.zoomIn", "CanvasGraphView.swift", "Button", "Zoom in"),
    navigation("canvas.zoomOut", "CanvasGraphView.swift", "Button", "Zoom out"),
    navigation("canvas.fit", "CanvasGraphView.swift", "Button", "Fit"),
    navigation("canvas.focus", "CanvasGraphView.swift", "Button", "Focus or Show All"),
    navigation("canvas.surface.select", "CanvasGraphView.swift", "SpatialTapGesture", "Select or clear node"),
    navigation("canvas.surface.pan", "CanvasGraphView.swift", "DragGesture", "Pan graph"),
    navigation("canvas.surface.zoom", "CanvasGraphView.swift", "MagnificationGesture", "Zoom graph"),
    execution("canvas.activeTask", "CanvasGraphView.swift", "Button", "Use as Active Task", .selectCanvasTask),
    execution("canvas.activePlan", "CanvasGraphView.swift", "Button", "Use as Active Plan", .selectCanvasPlan),
    execution("canvas.export", "CanvasExportView.swift", "Button", "Export", .exportCanvas),
    execution("canvas.refresh", "CanvasGraphView.swift", "Button", "Refresh", .refreshCanvas),

    execution("app.refresh", "CanvastApp.swift", "Button", "Refresh Workspace", .refreshWorkspace),
    execution("app.mode", "CanvastApp.swift", "Button", "Switch To Enhanced/Standard", .setRuntimeMode),
    execution("app.run", "CanvastApp.swift", "Button", "Run", .startRun),
    execution("app.stop", "CanvastApp.swift", "Button", "Stop Run", .stopRun),

    execution("settings.save", "CanvastSettingsView.swift", "Button", "Save", .saveSettings),
    execution(
      "settings.testConnection", "CanvastSettingsView.swift", "Button",
      "Test Connection", .testProviderConnection
    ),
    execution(
      "settings.applyProvider", "CanvastSettingsView.swift", "Button",
      "Apply Provider", .applyProviderSettings
    ),
    execution(
      "settings.revokeCredential", "CanvastSettingsView.swift", "Button",
      "Revoke Credential", .revokeProviderCredential
    ),

    lifecycleExecution("lifecycle.retry", "WorkspaceComponents.swift", "Button", "Retry"),
    lifecycleExecution("lifecycle.cancel", "WorkspaceComponents.swift", "Button", "Cancel"),
    lifecycleExecution("lifecycle.rollback", "WorkspaceComponents.swift", "Button", "Rollback"),
    lifecycleExecution("lifecycle.reconcile", "WorkspaceComponents.swift", "Button", "Refresh State"),
    lifecycleExecution("lifecycle.confirmSucceeded", "WorkspaceComponents.swift", "Button", "Confirm Succeeded"),
    lifecycleExecution("lifecycle.confirmFailed", "WorkspaceComponents.swift", "Button", "Confirm Failed"),
  ]

  private static func execution(
    _ site: String, _ file: String, _ control: String, _ label: String, _ actionID: DesktopUIActionID
  ) -> DesktopUIControlRegistration {
    .init(site: site, file: file, control: control, label: label, controlKind: .execution, actionBinding: .fixed(actionID))
  }

  private static func lifecycleExecution(
    _ site: String, _ file: String, _ control: String, _ label: String
  ) -> DesktopUIControlRegistration {
    .init(
      site: site, file: file, control: control, label: label,
      controlKind: .execution, actionBinding: .currentLifecycleAction
    )
  }

  private static func edit(
    _ site: String, _ file: String, _ control: String, _ label: String
  ) -> DesktopUIControlRegistration {
    .init(site: site, file: file, control: control, label: label, controlKind: .edit)
  }

  private static func navigation(
    _ site: String, _ file: String, _ control: String, _ label: String
  ) -> DesktopUIControlRegistration {
    .init(site: site, file: file, control: control, label: label, controlKind: .navigation)
  }

  static func spec(for id: DesktopUIActionID) -> DesktopActionSpec {
    switch id {
    case .refreshWorkspace:
      return .init(
        id: id, title: "Refresh workspace", transport: .localUI, lockScope: "persisted.state",
        defaultTimeoutSeconds: 10, retryPolicy: .idempotent, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Workspace refresh timed out before state reload completed.",
        duplicateMessage: "Workspace refresh is already running."
      )
    case .setRuntimeMode:
      return .init(
        id: id, title: "Set runtime mode", transport: .desktopDispatcher, lockScope: "runtime.configuration",
        defaultTimeoutSeconds: 30, retryPolicy: .afterDefinitiveFailure, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Runtime mode change timed out before the desktop dispatcher replied.",
        duplicateMessage: "A runtime mode change is already in progress."
      )
    case .setThinkingLevel:
      return .init(
        id: id, title: "Set thinking level", transport: .nativeRPC, lockScope: "runtime.configuration",
        defaultTimeoutSeconds: 30, retryPolicy: .afterDefinitiveFailure, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Thinking level update timed out before the runtime replied.",
        duplicateMessage: "A thinking level update is already in progress."
      )
    case .previewRun:
      return .init(
        id: id, title: "Preview run", transport: .localUI, lockScope: "run.configuration",
        defaultTimeoutSeconds: 10, retryPolicy: .idempotent, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Run preview timed out while preparing the launch plan.",
        duplicateMessage: "Run preview is already being prepared."
      )
    case .startRun:
      return .init(
        id: id, title: "Start run", transport: .nativeRPC, lockScope: "run.configuration",
        defaultTimeoutSeconds: 30, retryPolicy: .never, cancelCapability: .activeRunAbort, rollbackCapability: .none,
        timeoutMessage: "Run start timed out before the RPC host accepted the prompt.",
        duplicateMessage: "A run is already active or starting."
      )
    case .stopRun:
      return .init(
        id: id, title: "Stop run", transport: .nativeRPC, lockScope: "run.stop",
        defaultTimeoutSeconds: 20, retryPolicy: .never, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Run stop timed out before the runtime acknowledged abort.",
        duplicateMessage: "A run stop request is already in progress."
      )
    case .clearConsole:
      return .init(
        id: id, title: "Clear console", transport: .localUI, lockScope: "console.clear",
        defaultTimeoutSeconds: nil, retryPolicy: .idempotent, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Console clear did not complete in time.",
        duplicateMessage: "Console clear is already in progress."
      )
    case .sendRequestControl:
      return .init(
        id: id, title: "Send request control", transport: .desktopDispatcher, lockScope: "runtime.requestControl",
        defaultTimeoutSeconds: 30, retryPolicy: .afterDefinitiveFailure, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Request control timed out before the runtime queue acknowledged it.",
        duplicateMessage: "A request control action is already in progress."
      )
    case .createPlan:
      return .init(
        id: id, title: "Create plan", transport: .desktopDispatcher, lockScope: "planning.mutate",
        defaultTimeoutSeconds: 30, retryPolicy: .afterDefinitiveFailure, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Plan creation timed out before a structured result arrived.",
        duplicateMessage: "Another planning mutation is already running."
      )
    case .createTask:
      return .init(
        id: id, title: "Create task", transport: .desktopDispatcher, lockScope: "planning.mutate",
        defaultTimeoutSeconds: 30, retryPolicy: .never, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Task creation timed out before a structured result arrived.",
        duplicateMessage: "Another planning mutation is already running."
      )
    case .approvePlan:
      return .init(
        id: id, title: "Approve current plan", transport: .desktopDispatcher, lockScope: "planning.mutate",
        defaultTimeoutSeconds: 30, retryPolicy: .afterDefinitiveFailure, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Plan approval timed out before the runtime replied.",
        duplicateMessage: "Another plan lifecycle action is already in progress."
      )
    case .completePlan:
      return .init(
        id: id, title: "Complete current plan", transport: .desktopDispatcher, lockScope: "planning.mutate",
        defaultTimeoutSeconds: 30, retryPolicy: .afterDefinitiveFailure, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Plan completion timed out before the runtime replied.",
        duplicateMessage: "Another plan lifecycle action is already in progress."
      )
    case .updatePlan:
      return .init(
        id: id, title: "Update plan", transport: .desktopDispatcher, lockScope: "planning.mutate",
        defaultTimeoutSeconds: 30, retryPolicy: .afterDefinitiveFailure, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Plan update timed out before the runtime replied.",
        duplicateMessage: "Another planning mutation is already running."
      )
    case .updateTask:
      return .init(
        id: id, title: "Update task", transport: .desktopDispatcher, lockScope: "planning.mutate",
        defaultTimeoutSeconds: 30, retryPolicy: .afterDefinitiveFailure, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Task update timed out before the runtime replied.",
        duplicateMessage: "Another planning mutation is already running."
      )
    case .launchAgent:
      return .init(
        id: id, title: "Launch agent", transport: .desktopDispatcher, lockScope: "orchestration.launch",
        defaultTimeoutSeconds: 900, retryPolicy: .never, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Agent launch timed out before the dispatcher returned a structured result.",
        duplicateMessage: "Another orchestration launch is already in progress."
      )
    case .launchWorkflow:
      return .init(
        id: id, title: "Launch workflow", transport: .desktopDispatcher, lockScope: "orchestration.launch",
        defaultTimeoutSeconds: 900, retryPolicy: .never, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Workflow launch timed out before the dispatcher returned a structured result.",
        duplicateMessage: "Another orchestration launch is already in progress."
      )
    case .startNewSession:
      return .init(
        id: id, title: "Start new session", transport: .desktopDispatcher, lockScope: "session.control",
        defaultTimeoutSeconds: 20, retryPolicy: .never, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "New session timed out before the runtime acknowledged it.",
        duplicateMessage: "Another session control action is already in progress."
      )
    case .loadSessionCatalog:
      return sessionSpec(
        id, title: "Load session history", timeout: 20, retry: .idempotent,
        duplicate: "Session history is already loading."
      )
    case .openSession:
      return sessionSpec(
        id, title: "Open session", timeout: 30, retry: .never,
        duplicate: "Another session control action is already in progress."
      )
    case .renameSession:
      return sessionSpec(
        id, title: "Rename session", timeout: 30, retry: .never,
        duplicate: "Another session control action is already in progress."
      )
    case .deleteSession:
      return sessionSpec(
        id, title: "Delete session", timeout: 30, retry: .never,
        duplicate: "Another session control action is already in progress."
      )
    case .loadSessionTranscript:
      return sessionSpec(
        id, title: "Load session transcript", timeout: 20, retry: .idempotent,
        duplicate: "A session transcript is already loading."
      )
    case .runProjectPreflight:
      return .init(
        id: id, title: "Run project safety check", transport: .desktopDispatcher, lockScope: "project.lifecycle",
        defaultTimeoutSeconds: 30, retryPolicy: .idempotent, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Project safety check timed out before the runtime replied.",
        duplicateMessage: "A project lifecycle action is already in progress."
      )
    case .createProjectSession:
      return .init(
        id: id, title: "Create project session", transport: .desktopDispatcher, lockScope: "project.lifecycle",
        defaultTimeoutSeconds: 60, retryPolicy: .never, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Project create timed out before a structured receipt arrived.",
        duplicateMessage: "A project lifecycle action is already in progress."
      )
    case .openProjectSession:
      return .init(
        id: id, title: "Open project session", transport: .desktopDispatcher, lockScope: "project.lifecycle",
        defaultTimeoutSeconds: 60, retryPolicy: .never, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Project open timed out before a structured receipt arrived.",
        duplicateMessage: "A project lifecycle action is already in progress."
      )
    case .reinitializeProject:
      return .init(
        id: id, title: "Reinitialize project", transport: .desktopDispatcher, lockScope: "project.lifecycle",
        defaultTimeoutSeconds: 60, retryPolicy: .never, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Project reinitialize timed out before a structured receipt arrived.",
        duplicateMessage: "A project lifecycle action is already in progress."
      )
    case .retireProject:
      return .init(
        id: id, title: "Retire project", transport: .desktopDispatcher, lockScope: "project.lifecycle",
        defaultTimeoutSeconds: 60, retryPolicy: .never, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Project retirement timed out before a structured receipt arrived.",
        duplicateMessage: "A project lifecycle action is already in progress."
      )
    case .inspectResume:
      return resumeSpec(id, title: "Inspect resume candidate", timeout: 20, retry: .idempotent)
    case .chooseResume:
      return resumeSpec(id, title: "Select resume candidate", timeout: 20, retry: .afterDefinitiveFailure)
    case .claimResume:
      return resumeSpec(id, title: "Resume interrupted work", timeout: 30, retry: .never)
    case .rebindResume:
      return resumeSpec(id, title: "Repair resume binding", timeout: 30, retry: .never)
    case .retireResume:
      return resumeSpec(id, title: "Retire resume candidate", timeout: 30, retry: .never)
    case .reconcileResume:
      return resumeSpec(id, title: "Refresh resume state", timeout: 20, retry: .idempotent)
    case .restartProjectRuntime:
      return .init(
        id: id, title: "Restart project runtime", transport: .desktopDispatcher, lockScope: "session.control",
        defaultTimeoutSeconds: 30, retryPolicy: .never, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Project runtime restart timed out before reload completed.",
        duplicateMessage: "Another session control action is already in progress."
      )
    case .inspectProjectScope:
      return .init(
        id: id, title: "Inspect project scope", transport: .desktopDispatcher, lockScope: "project.scope",
        defaultTimeoutSeconds: 20, retryPolicy: .idempotent, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Project scope inspection timed out before the runtime replied.",
        duplicateMessage: "A project scope action is already in progress."
      )
    case .rebindProjectScope:
      return .init(
        id: id, title: "Rebind project scope", transport: .desktopDispatcher, lockScope: "project.scope",
        defaultTimeoutSeconds: 30, retryPolicy: .never, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Project scope rebind timed out before the runtime replied.",
        duplicateMessage: "A project scope action is already in progress."
      )
    case .inspectSandbox:
      return .init(
        id: id, title: "Inspect sandbox", transport: .desktopDispatcher, lockScope: "safety.configuration",
        defaultTimeoutSeconds: 20, retryPolicy: .idempotent, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Sandbox inspection timed out before the runtime replied.",
        duplicateMessage: "A sandbox action is already in progress."
      )
    case .setSandboxProfile:
      return .init(
        id: id, title: "Set sandbox profile", transport: .desktopDispatcher, lockScope: "safety.configuration",
        defaultTimeoutSeconds: 30, retryPolicy: .afterDefinitiveFailure, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Sandbox profile change timed out before the runtime replied.",
        duplicateMessage: "A sandbox action is already in progress."
      )
    case .grantSandboxAccess:
      return .init(
        id: id, title: "Grant sandbox access", transport: .desktopDispatcher, lockScope: "safety.configuration",
        defaultTimeoutSeconds: 30, retryPolicy: .never, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Sandbox grant timed out before the runtime replied.",
        duplicateMessage: "A sandbox grant action is already in progress."
      )
    case .revokeSandboxAccess:
      return .init(
        id: id,
        titleEnglish: "Revoke sandbox grant",
        titleSimplifiedChinese: "撤销沙箱授权",
        transport: .desktopDispatcher,
        lockScope: "safety.configuration",
        defaultTimeoutSeconds: 30,
        retryPolicy: .never,
        cancelCapability: .none,
        rollbackCapability: .none,
        timeoutEnglish: "Sandbox revoke timed out. Inspect live grants to reconcile; do not resend the revoke.",
        timeoutSimplifiedChinese: "沙箱撤销已超时。请检查实时授权以对账，不要重复发送撤销。",
        duplicateEnglish: "Another sandbox configuration action is already in progress.",
        duplicateSimplifiedChinese: "另一个沙箱配置操作正在进行中。"
      )
    case .setPermissionMode:
      return .init(
        id: id, title: "Set permission mode", transport: .desktopDispatcher, lockScope: "safety.configuration",
        defaultTimeoutSeconds: 20, retryPolicy: .afterDefinitiveFailure, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Permission mode change timed out before the runtime replied.",
        duplicateMessage: "A permission mode action is already in progress."
      )
    case .selectCanvasTask:
      return .init(
        id: id, title: "Select canvas task", transport: .desktopDispatcher, lockScope: "canvas.scope",
        defaultTimeoutSeconds: 20, retryPolicy: .afterDefinitiveFailure, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Canvas task selection timed out before the runtime replied.",
        duplicateMessage: "A canvas scope action is already in progress."
      )
    case .selectCanvasPlan:
      return .init(
        id: id, title: "Select canvas plan", transport: .desktopDispatcher, lockScope: "canvas.scope",
        defaultTimeoutSeconds: 20, retryPolicy: .afterDefinitiveFailure, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Canvas plan selection timed out before the runtime replied.",
        duplicateMessage: "A canvas scope action is already in progress."
      )
    case .exportCanvas:
      return .init(
        id: id, title: "Export canvas", transport: .desktopDispatcher, lockScope: "canvas.export",
        defaultTimeoutSeconds: 120, retryPolicy: .afterDefinitiveFailure,
        cancelCapability: .localTask, rollbackCapability: .none,
        timeoutMessage: "Canvas export timed out before a structured receipt arrived.",
        duplicateMessage: "A Canvas export is already in progress."
      )
    case .refreshCanvas:
      return .init(
        id: id, title: "Refresh canvas", transport: .localUI, lockScope: "persisted.state",
        defaultTimeoutSeconds: 10, retryPolicy: .idempotent, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Canvas refresh timed out before state reload completed.",
        duplicateMessage: "Canvas refresh is already in progress."
      )
    case .filterCanvasSnapshot:
      return .init(
        id: id, title: "Filter local snapshot", transport: .localUI, lockScope: nil,
        defaultTimeoutSeconds: nil, retryPolicy: .never, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Local filter update timed out.",
        duplicateMessage: "The same local filter update is already in progress."
      )
    case .reloadPersistedSnapshot:
      return .init(
        id: id, title: "Reload persisted snapshot", transport: .localUI, lockScope: "persisted.state",
        defaultTimeoutSeconds: 10, retryPolicy: .idempotent, cancelCapability: .none, rollbackCapability: .none,
        timeoutMessage: "Persisted snapshot reload timed out before state refresh completed.",
        duplicateMessage: "Another workspace reload is already in progress."
      )
    case .saveSettings:
      return .init(
        id: id, title: "Save settings", transport: .localUI, lockScope: "settings.configuration",
        defaultTimeoutSeconds: 15, retryPolicy: .idempotent, cancelCapability: .localTask,
        rollbackCapability: .none,
        timeoutMessage: "Settings save timed out before local storage completed.",
        duplicateMessage: "Another settings operation is already in progress."
      )
    case .testProviderConnection:
      return .init(
        id: id, title: "Test provider connection", transport: .localUI,
        lockScope: "settings.configuration", defaultTimeoutSeconds: 20,
        retryPolicy: .idempotent, cancelCapability: .localTask, rollbackCapability: .none,
        timeoutMessage: "Provider connection test timed out.",
        duplicateMessage: "Another settings operation is already in progress."
      )
    case .applyProviderSettings:
      return .init(
        id: id, title: "Apply provider settings", transport: .localUI,
        lockScope: "settings.configuration", defaultTimeoutSeconds: 20,
        retryPolicy: .idempotent, cancelCapability: .localTask, rollbackCapability: .none,
        timeoutMessage: "Provider switch timed out before configuration was applied.",
        duplicateMessage: "Another settings operation is already in progress."
      )
    case .revokeProviderCredential:
      return .init(
        id: id, title: "Revoke provider credential", transport: .localUI,
        lockScope: "settings.configuration", defaultTimeoutSeconds: 15,
        retryPolicy: .idempotent, cancelCapability: .localTask, rollbackCapability: .none,
        timeoutMessage: "Credential revocation timed out before Keychain removal completed.",
        duplicateMessage: "Another settings operation is already in progress."
      )
    }
  }

  static let actionableUIActionIDs: Set<DesktopUIActionID> = Set(
    controlRegistrations.compactMap { $0.controlKind == .execution ? $0.actionID : nil }
  )

  private static func sessionSpec(
    _ id: DesktopUIActionID, title: String, timeout: Int, retry: DesktopActionRetryPolicy, duplicate: String
  ) -> DesktopActionSpec {
    .init(
      id: id, title: title, transport: .desktopDispatcher, lockScope: "session.control",
      defaultTimeoutSeconds: timeout, retryPolicy: retry, cancelCapability: .none, rollbackCapability: .none,
      timeoutMessage: "\(title) timed out before the runtime returned a structured result.",
      duplicateMessage: duplicate
    )
  }

  private static func resumeSpec(
    _ id: DesktopUIActionID, title: String, timeout: Int, retry: DesktopActionRetryPolicy
  ) -> DesktopActionSpec {
    .init(
      id: id, title: title, transport: .desktopDispatcher, lockScope: "resume.control",
      defaultTimeoutSeconds: timeout, retryPolicy: retry, cancelCapability: .none, rollbackCapability: .none,
      timeoutMessage: "\(title) timed out before the runtime returned a structured result.",
      duplicateMessage: "Another resume operation is already in progress."
    )
  }
}
