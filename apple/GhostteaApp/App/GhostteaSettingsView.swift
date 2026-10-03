import Foundation
import GhostteaAppearance
import GhostteaCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct GhostteaSettingsView: View {
  @EnvironmentObject private var configuration: GhostteaConfigurationModel

  var body: some View {
    NavigationStack {
      List {
        Section("Terminal") {
          NavigationLink {
            GhostteaAppearanceSettingsView()
          } label: {
            Label("Appearance", systemImage: "paintpalette")
          }
          NavigationLink {
            GhostteaAdvancedConfigView()
          } label: {
            Label("Advanced Ghostty config", systemImage: "doc.text")
          }
        }

        Section {
          Text(
            "These device settings own the appearance of direct SSH and shared terminals, including colors, opacity, and shaders. Shared sessions still use the desktop for terminal content, scrollback, selection state and copy, and control."
          )
          .font(.footnote)
          .foregroundStyle(.secondary)
        }

        if let message = configuration.message {
          Section { Label(message, systemImage: "checkmark.circle").foregroundStyle(.green) }
        }
        if let error = configuration.errorMessage {
          Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
        }
        if let error = configuration.documentAccessError {
          Section { Label(error, systemImage: "lock.trianglebadge.exclamationmark") }
        }
      }
      .navigationTitle("Settings")
    }
    // Attach persistence controls to the stack so they remain available on
    // Appearance, theme-picker, and Advanced destinations.
    .toolbar {
      ToolbarItemGroup(placement: .topBarTrailing) {
        if configuration.isDirty {
          Button("Revert", role: .cancel) { configuration.revert() }
        }
        Button(configuration.isSaving ? "Saving…" : "Save") {
          Task { await configuration.save() }
        }
        .disabled(!configuration.canSave)
      }
    }
    .confirmationDialog(
      "The config changed on disk",
      isPresented: Binding(
        get: { configuration.conflict != nil },
        set: { presented in
          if !presented { configuration.dismissConflict() }
        })
    ) {
      Button("Use disk version") {
        configuration.adoptConflict(keepDraft: false)
      }
      Button("Keep my draft on latest revision") {
        configuration.adoptConflict(keepDraft: true)
      }
      Button("Cancel", role: .cancel) { configuration.dismissConflict() }
    } message: {
      Text("Nothing was overwritten. Choose which content should use the latest disk revision.")
    }
  }
}

private struct GhostteaAppearanceSettingsView: View {
  @EnvironmentObject private var configuration: GhostteaConfigurationModel

  var body: some View {
    Form {
      Section("Color theme") {
        NavigationLink {
          GhostteaThemePickerView()
        } label: {
          HStack {
            Text("Theme")
            Spacer()
            Text(configuration.appearance.theme?.name ?? "Custom")
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
        if let theme = configuration.appearance.theme {
          HStack(spacing: 4) {
            ForEach(Array(theme.palette.prefix(8).enumerated()), id: \.offset) { _, value in
              RoundedRectangle(cornerRadius: 3)
                .fill(Color(ghostteaHex: value))
                .frame(height: 22)
            }
          }
          .accessibilityLabel("Theme color preview")
        }
      }

      Section("Transparency") {
        HStack {
          Text("Background opacity")
          Slider(
            value: Binding(
              get: { configuration.appearance.backgroundOpacity },
              set: { value in update { $0.backgroundOpacity = value } }),
            in: 0...1,
            step: 0.01)
          Text(
            configuration.appearance.backgroundOpacity,
            format: .percent.precision(.fractionLength(0))
          )
          .monospacedDigit()
          .frame(width: 44, alignment: .trailing)
        }
        Toggle(
          "Apply opacity to explicit cell backgrounds",
          isOn: Binding(
            get: { configuration.appearance.backgroundOpacityCells },
            set: { value in update { $0.backgroundOpacityCells = value } }))
        Text(
          "On iOS, transparency reveals Ghosttea's decorative SwiftUI backdrop behind the terminal layer; the app window itself remains opaque."
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }

      Section("Readability") {
        Toggle(
          "Restyle dark apps under light themes",
          isOn: Binding(
            get: { configuration.appearance.lightAdaptation == .auto },
            set: { value in update { $0.lightAdaptation = value ? .auto : .off } }))
        Picker(
          "Minimum text contrast",
          selection: Binding(
            get: { configuration.appearance.minimumContrast },
            set: { value in update { $0.minimumContrast = value } })
        ) {
          ForEach(contrastChoices, id: \.self) { ratio in
            Text(contrastLabel(ratio)).tag(ratio)
          }
        }
        Text(
          "Apps that paint their own dark background are redrawn as a light design when a light theme is active. Text below the minimum contrast against its background is lightened or darkened, keeping its hue; 4.5:1 is the WCAG AA level for body text."
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }

      if !configuration.appearance.shaderEffects.isEmpty {
        Section("Shader order") {
          ForEach(configuration.appearance.shaderEffects, id: \.self) { id in
            Label(shaderName(id), systemImage: "line.3.horizontal")
          }
          .onMove { source, destination in
            update { $0.shaderEffects.move(fromOffsets: source, toOffset: destination) }
          }
        }
      }

      Section("Built-in shaders") {
        ForEach(GhostteaShaderOption.available) { shader in
          Toggle(
            isOn: Binding(
              get: { configuration.appearance.shaderEffects.contains(shader.id) },
              set: { selected in
                update {
                  if selected, !$0.shaderEffects.contains(shader.id) {
                    $0.shaderEffects.append(shader.id)
                  } else if !selected {
                    $0.shaderEffects.removeAll { $0 == shader.id }
                  }
                }
              })
          ) {
            VStack(alignment: .leading, spacing: 2) {
              Text(shader.name)
              Text("\(shader.description) · \(shader.license)")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          }
        }
        Toggle(
          "Animate shaders",
          isOn: Binding(
            get: { configuration.appearance.shaderAnimation },
            set: { value in update { $0.shaderAnimation = value } })
        )
        .disabled(
          !GhostteaShaderOption.available.contains {
            $0.animated && configuration.appearance.shaderEffects.contains($0.id)
          })
        DisclosureGroup("Other ghostty-shaders ports") {
          Text(
            GhostteaShaderOption.unavailableUpstreamNames.joined(separator: ", ")
              + ". These remain disabled until their redistribution terms permit bundling."
          )
          .font(.caption)
          .foregroundStyle(.secondary)
        }
      }
      GhostteaSettingsFeedbackView()
    }
    .disabled(!configuration.isDocumentEditable)
    .navigationTitle("Appearance")
    .toolbar { EditButton() }
  }

  private func update(_ mutation: (inout GhostteaAppearanceSelection) -> Void) {
    var selection = configuration.appearance
    mutation(&selection)
    configuration.applyAppearance(selection)
  }

  /// The offered ratios, plus a hand-edited one so the picker can show it.
  private var contrastChoices: [Double] {
    let current = configuration.appearance.minimumContrast
    let choices = GhostteaAppearanceSelection.minimumContrastChoices
    return choices.contains(current) ? choices : (choices + [current]).sorted()
  }

  private func contrastLabel(_ ratio: Double) -> String {
    ratio > 1 ? "\(ratio.formatted(.number.precision(.fractionLength(0...2)))):1" : "Off"
  }

  private func shaderName(_ id: String) -> String {
    GhostteaShaderOption.available.first { $0.id == id }?.name ?? id
  }
}

private struct GhostteaThemePickerView: View {
  @EnvironmentObject private var configuration: GhostteaConfigurationModel
  @State private var search = ""

  private var themes: [GhostteaColorTheme] {
    guard !search.isEmpty else { return GhostteaThemeCatalog.themes }
    return GhostteaThemeCatalog.themes.filter {
      $0.name.localizedCaseInsensitiveContains(search)
    }
  }

  var body: some View {
    List {
      ForEach(themes) { theme in
        Button {
          var selection = configuration.appearance
          selection.theme = theme
          configuration.applyAppearance(selection)
        } label: {
          HStack(spacing: 12) {
            HStack(spacing: 2) {
              ForEach(Array(theme.palette.prefix(4).enumerated()), id: \.offset) { _, value in
                Rectangle().fill(Color(ghostteaHex: value)).frame(width: 8, height: 28)
              }
            }
            .clipShape(RoundedRectangle(cornerRadius: 4))
            Text(theme.name).foregroundStyle(.primary)
            Spacer()
            if configuration.appearance.theme?.name == theme.name {
              Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
            }
          }
        }
      }
      GhostteaSettingsFeedbackView()
    }
    .disabled(!configuration.isDocumentEditable)
    .navigationTitle("Color themes")
    .searchable(text: $search, prompt: "Search 602 themes")
  }
}

private struct GhostteaAdvancedConfigView: View {
  private enum Mode: String, CaseIterable {
    case raw = "Raw config"
    case friendly = "Friendly"
  }
  private enum ImportKind {
    case ghostty
    case raw
  }

  @EnvironmentObject private var configuration: GhostteaConfigurationModel
  @State private var mode = Mode.raw
  @State private var importsFile = false
  @State private var importKind = ImportKind.raw
  @State private var pendingImport: (URL, ImportKind)?
  @State private var exportsFile = false

  var body: some View {
    Form {
      Picker("Editor", selection: $mode) {
        ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
      }
      .pickerStyle(.segmented)

      if mode == .raw { rawEditor } else { friendlyEditor }

      Section("Validation") {
        LabeledContent("Status", value: validationLabel)
        LabeledContent("Document", value: configuration.document.exists ? "On disk" : "New file")
        Text(configuration.document.path)
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
        ForEach(Array(configuration.diagnostics.enumerated()), id: \.offset) { _, diagnostic in
          VStack(alignment: .leading, spacing: 2) {
            Label(
              diagnostic.message,
              systemImage: diagnostic.severity == .error
                ? "xmark.octagon"
                : diagnostic.severity == .warning
                  ? "exclamationmark.triangle" : "info.circle")
            if let source = diagnostic.source {
              Text(source + (diagnostic.line.map { ":\($0)" } ?? ""))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            }
          }
        }
      }
      GhostteaSettingsFeedbackView()
    }
    .disabled(!configuration.isDocumentEditable)
    .navigationTitle("Ghostty config")
    .fileImporter(
      isPresented: $importsFile,
      allowedContentTypes: [.plainText, .data],
      allowsMultipleSelection: false
    ) { result in
      if case .success(let urls) = result, let url = urls.first {
        pendingImport = (url, importKind)
      }
    }
    .confirmationDialog(
      "Import configuration",
      isPresented: Binding(get: { pendingImport != nil }, set: { if !$0 { pendingImport = nil } })
    ) {
      Button("Replace draft") { performImport(append: false) }
      Button("Append to draft") { performImport(append: true) }
      Button("Cancel", role: .cancel) { pendingImport = nil }
    } message: {
      Text(
        pendingImport?.1 == .ghostty
          ? "Ghosttea will project supported Ghostty values into a portable draft."
          : "Raw import preserves the selected UTF-8 text exactly.")
    }
    .fileExporter(
      isPresented: $exportsFile,
      document: GhostteaConfigFile(contents: configuration.rawDraft),
      contentType: .plainText,
      defaultFilename: "config.ghostty"
    ) { configuration.reportExport($0) }
  }

  private var rawEditor: some View {
    Section {
      HStack {
        Button("Import from Ghostty") {
          importKind = .ghostty
          importsFile = true
        }
        Button("Import file") {
          importKind = .raw
          importsFile = true
        }
        Button("Export") { exportsFile = true }
      }
      .buttonStyle(.borderless)

      TextEditor(
        text: Binding(
          get: { configuration.rawDraft },
          set: { value in configuration.editRaw(value) })
      )
      .font(.system(.body, design: .monospaced))
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled()
      .frame(minHeight: 360)
      .accessibilityLabel("Ghostty profile configuration")

      Text(
        "Validation runs after every edit. The last valid view-owned appearance previews immediately; save uses an exact revision check. \(configuration.byteCount.formatted()) / 65,536 bytes."
      )
      .font(.caption)
      .foregroundStyle(.secondary)
    } header: {
      Text("Profile override")
    }
  }

  private var friendlyEditor: some View {
    Group {
      friendlyColors
      Section("Opacity") {
        Slider(
          value: friendlyBinding(\.backgroundOpacity, section: .opacity),
          in: 0...1,
          step: 0.01)
        Toggle(
          "Transparent explicit cell backgrounds",
          isOn: friendlyBinding(\.backgroundOpacityCells, section: .opacity))
      }
      Section("Terminal") {
        TextField(
          "Scrollback bytes",
          value: friendlyBinding(\.scrollbackLimit, section: .scrollback),
          format: .number
        )
        .keyboardType(.numberPad)
        TextField(
          "Font size",
          value: friendlyBinding(\.fontSize, section: .typography),
          format: .number
        )
        .keyboardType(.decimalPad)
        TextField(
          "Font families (comma separated)",
          text: Binding(
            get: { configuration.friendly.fontFamilies.joined(separator: ", ") },
            set: { text in
              var values = configuration.friendly
              values.fontFamilies = text.split(separator: ",").map {
                $0.trimmingCharacters(in: .whitespaces)
              }
              configuration.updateFriendly(values, section: .typography)
            }))
      }
      Section("Padding") {
        HStack {
          numericPaddingField("Left", axis: \.paddingX, index: 0)
          numericPaddingField("Right", axis: \.paddingX, index: 1)
        }
        HStack {
          numericPaddingField("Top", axis: \.paddingY, index: 0)
          numericPaddingField("Bottom", axis: \.paddingY, index: 1)
        }
      }
      Section("Keybindings") {
        Toggle(
          "Clear default keybindings",
          isOn: friendlyBinding(\.clearKeybindings, section: .keybindings))
        TextEditor(
          text: Binding(
            get: { configuration.friendly.keybindings.joined(separator: "\n") },
            set: { text in
              var values = configuration.friendly
              values.keybindings = text.components(separatedBy: .newlines).filter { !$0.isEmpty }
              configuration.updateFriendly(values, section: .keybindings)
            })
        )
        .font(.system(.body, design: .monospaced))
        .frame(minHeight: 120)
      }
      Section {
        Button("Reset friendly overrides", role: .destructive) {
          configuration.resetFriendlyOverrides()
        }
        .disabled(configuration.friendlySections.isEmpty)
      } footer: {
        Text(
          "Friendly changes generate a visible managed block in the same raw draft. Unknown keys, comments, ordering, and includes outside that block are preserved."
        )
      }
    }
  }

  private var friendlyColors: some View {
    Section("Colors") {
      colorField("Foreground", keyPath: \.foreground)
      colorField("Background", keyPath: \.background)
      colorField("Cursor", keyPath: \.cursor)
      colorField("Cursor text", keyPath: \.cursorText)
      colorField("Selection", keyPath: \.selectionBackground)
      colorField("Selection text", keyPath: \.selectionForeground)
    }
  }

  private var validationLabel: String {
    switch configuration.validationState {
    case .idle: "Not validated"
    case .validating: "Validating…"
    case .valid: "Valid · live preview"
    case .invalid: "Needs attention"
    }
  }

  private func friendlyBinding<Value>(
    _ keyPath: WritableKeyPath<GhostteaFriendlyConfigValues, Value>,
    section: GhostteaFriendlyConfigSection
  ) -> Binding<Value> {
    Binding(
      get: { configuration.friendly[keyPath: keyPath] },
      set: { value in
        var values = configuration.friendly
        values[keyPath: keyPath] = value
        configuration.updateFriendly(values, section: section)
      })
  }

  private func colorField(
    _ label: String,
    keyPath: WritableKeyPath<GhostteaFriendlyConfigValues, String>
  ) -> some View {
    HStack {
      ColorPicker(
        label,
        selection: Binding(
          get: { Color(ghostteaHex: configuration.friendly[keyPath: keyPath]) },
          set: { color in
            guard let hex = color.ghostteaHex else { return }
            var values = configuration.friendly
            values[keyPath: keyPath] = hex
            configuration.updateFriendly(values, section: .colors)
          }),
        supportsOpacity: false)
      Text(configuration.friendly[keyPath: keyPath])
        .font(.caption.monospaced())
        .foregroundStyle(.secondary)
    }
  }

  private func numericPaddingField(
    _ label: String,
    axis: WritableKeyPath<GhostteaFriendlyConfigValues, [Double]>,
    index: Int
  ) -> some View {
    TextField(
      label,
      value: Binding(
        get: { configuration.friendly[keyPath: axis][index] },
        set: { value in
          var values = configuration.friendly
          while values[keyPath: axis].count < 2 { values[keyPath: axis].append(2) }
          values[keyPath: axis][index] = max(0, value)
          configuration.updateFriendly(values, section: .padding)
        }),
      format: .number
    )
    .keyboardType(.decimalPad)
  }

  private func performImport(append: Bool) {
    guard let (url, kind) = pendingImport else { return }
    pendingImport = nil
    Task {
      switch kind {
      case .ghostty:
        await configuration.importGhosttyProjection(from: url, append: append)
      case .raw:
        await configuration.importRawFile(from: url, append: append)
      }
    }
  }
}

private struct GhostteaSettingsFeedbackView: View {
  @EnvironmentObject private var configuration: GhostteaConfigurationModel

  var body: some View {
    if let message = configuration.message {
      Section { Label(message, systemImage: "checkmark.circle").foregroundStyle(.green) }
    }
    if let error = configuration.errorMessage {
      Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
    }
    if let error = configuration.documentAccessError {
      Section { Label(error, systemImage: "lock.trianglebadge.exclamationmark") }
    }
  }
}

private struct GhostteaConfigFile: FileDocument {
  static var readableContentTypes: [UTType] { [.plainText] }
  let contents: String

  init(contents: String) { self.contents = contents }

  init(configuration: ReadConfiguration) throws {
    guard let data = configuration.file.regularFileContents,
      let contents = String(data: data, encoding: .utf8)
    else { throw CocoaError(.fileReadInapplicableStringEncoding) }
    self.contents = contents
  }

  func fileWrapper(configuration _: WriteConfiguration) throws -> FileWrapper {
    FileWrapper(regularFileWithContents: Data(contents.utf8))
  }
}

extension Color {
  fileprivate init(ghostteaHex: String) {
    let value = ghostteaHex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    let parsed = UInt64(value, radix: 16) ?? 0
    self.init(
      red: Double((parsed >> 16) & 0xff) / 255,
      green: Double((parsed >> 8) & 0xff) / 255,
      blue: Double(parsed & 0xff) / 255)
  }

  fileprivate var ghostteaHex: String? {
    let color = UIColor(self)
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0
    guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return nil }
    return String(
      format: "#%02x%02x%02x",
      Int((red * 255).rounded()),
      Int((green * 255).rounded()),
      Int((blue * 255).rounded()))
  }
}
