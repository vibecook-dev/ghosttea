import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConfigSnapshot } from "@vibecook/ghosttea-protocol";
import { GHOSTTY_COLOR_THEMES, colorThemeFromRenderer, findMatchingColorTheme } from "./catalog.js";
import { GHOSTTEA_SHADER_OPTIONS, UNAVAILABLE_UPSTREAM_SHADERS, isGhostteaShaderEffect } from "./shaders.js";
import { AdvancedConfigSettings } from "./AdvancedConfigSettings.js";
import { BackdropBlurControl } from "./BackdropBlurControl.js";
import type { GhostteaAppearanceUpdate, GhostteaBackdropBlurBridge, GhostteaConfigEditorBridge } from "./types.js";
import type { TerminalShaderEffect } from "../renderers/types.js";

export interface AppearanceDraftState {
  themeName: string | null;
  opacity: number;
  opacityCells: boolean;
  effects: TerminalShaderEffect[];
  animation: boolean;
}

export function appearanceDraftFromConfig(config: ConfigSnapshot): AppearanceDraftState {
  return {
    themeName: findMatchingColorTheme(config.renderer)?.name ?? null,
    opacity: config.renderer.backgroundOpacity ?? 1,
    opacityCells: config.renderer.backgroundOpacityCells ?? false,
    effects:
      config.renderer.shaderEffects?.filter(isGhostteaShaderEffect) ??
      (config.renderer.postProcess === "better-crt" ? ["ghosttea:better-crt"] : []),
    animation: config.renderer.customShaderAnimation ?? false,
  };
}

export function sameAppearanceDraft(left: AppearanceDraftState, right: AppearanceDraftState): boolean {
  return (
    left.themeName === right.themeName &&
    left.opacity === right.opacity &&
    left.opacityCells === right.opacityCells &&
    left.animation === right.animation &&
    left.effects.length === right.effects.length &&
    left.effects.every((effect, index) => effect === right.effects[index])
  );
}

export interface AppearanceSettingsProps {
  config: ConfigSnapshot;
  onClose: () => void;
  onSave?: (update: GhostteaAppearanceUpdate) => Promise<void>;
  configEditor?: GhostteaConfigEditorBridge;
  backdropBlur?: GhostteaBackdropBlurBridge;
  onPreview: (config: ConfigSnapshot | undefined) => void;
}

export function AppearanceSettings({
  config,
  onClose,
  onSave,
  configEditor,
  backdropBlur,
  onPreview,
}: AppearanceSettingsProps) {
  const [section, setSection] = useState<"appearance" | "advanced">(onSave ? "appearance" : "advanced");
  const [advancedOpened, setAdvancedOpened] = useState(!onSave);
  const [advancedDirty, setAdvancedDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [observedConfig, setObservedConfig] = useState(config);
  const [observedPropRevision, setObservedPropRevision] = useState(config.revision);
  const initialAppearance = appearanceDraftFromConfig(config);
  const [appearanceBaseline, setAppearanceBaseline] = useState(initialAppearance);
  const [appearanceBaselineRevision, setAppearanceBaselineRevision] = useState(config.revision);
  const matchedTheme = findMatchingColorTheme(observedConfig.renderer);
  const currentTheme = colorThemeFromRenderer(observedConfig.renderer);
  const [themeName, setThemeName] = useState<string | null>(initialAppearance.themeName);
  const [query, setQuery] = useState("");
  const [opacity, setOpacity] = useState(initialAppearance.opacity);
  const [opacityCells, setOpacityCells] = useState(initialAppearance.opacityCells);
  const [effects, setEffects] = useState<TerminalShaderEffect[]>(initialAppearance.effects);
  const [animation, setAnimation] = useState(initialAppearance.animation);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const appearanceDraft = useMemo<AppearanceDraftState>(
    () => ({ themeName, opacity, opacityCells, effects, animation }),
    [animation, effects, opacity, opacityCells, themeName],
  );
  const appearanceDirty = !sameAppearanceDraft(appearanceDraft, appearanceBaseline);
  const appearanceStale = appearanceDirty && observedConfig.revision !== appearanceBaselineRevision;
  const selectedTheme = themeName ? GHOSTTY_COLOR_THEMES.find((theme) => theme.name === themeName) : undefined;
  const previewTheme = selectedTheme ?? currentTheme;
  const filteredThemes = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return GHOSTTY_COLOR_THEMES.slice(0, 80);
    return GHOSTTY_COLOR_THEMES.filter((theme) => theme.name.toLocaleLowerCase().includes(normalized)).slice(0, 120);
  }, [query]);
  const resetAppearanceToConfig = useCallback((nextConfig: ConfigSnapshot): void => {
    const next = appearanceDraftFromConfig(nextConfig);
    setThemeName(next.themeName);
    setOpacity(next.opacity);
    setOpacityCells(next.opacityCells);
    setEffects(next.effects);
    setAnimation(next.animation);
    setAppearanceBaseline(next);
    setAppearanceBaselineRevision(nextConfig.revision);
  }, []);
  const acknowledgeLatestAppearanceBase = (): void => {
    setAppearanceBaseline(appearanceDraftFromConfig(observedConfig));
    setAppearanceBaselineRevision(observedConfig.revision);
  };
  const selectSection = (next: "appearance" | "advanced"): void => {
    if ((next === "advanced" && appearanceDirty) || (next === "appearance" && advancedDirty)) return;
    if (next === "advanced") setAdvancedOpened(true);
    setSection(next);
  };
  const requestClose = useCallback((): void => {
    if (advancedDirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }, [advancedDirty, onClose]);

  // React preserves this dialog across daemon config notifications. Reconcile
  // a clean appearance draft during render (the guarded previous-prop pattern)
  // so a newer snapshot cannot be overwritten by stale form state. A dirty
  // draft keeps its old baseline and therefore becomes an explicit conflict.
  if (config.revision !== observedPropRevision) {
    setObservedPropRevision(config.revision);
    setObservedConfig(config);
  } else if (observedConfig.revision !== appearanceBaselineRevision && !appearanceDirty) {
    resetAppearanceToConfig(observedConfig);
  }

  useEffect(() => {
    configEditor?.setDirty?.(advancedDirty);
  }, [advancedDirty, configEditor]);

  useEffect(
    () => () => {
      configEditor?.setDirty?.(false);
    },
    [configEditor],
  );

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (confirmDiscard) {
        setConfirmDiscard(false);
        return;
      }
      requestClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [confirmDiscard, requestClose]);

  const toggleEffect = (id: TerminalShaderEffect): void => {
    setEffects((current) => (current.includes(id) ? current.filter((effect) => effect !== id) : [...current, id]));
  };
  const moveEffect = (id: TerminalShaderEffect, offset: -1 | 1): void => {
    setEffects((current) => {
      const index = current.indexOf(id);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };
  const save = async (): Promise<void> => {
    if (!onSave || appearanceStale) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSave({
        ...(selectedTheme ? { theme: selectedTheme } : {}),
        backgroundOpacity: opacity,
        backgroundOpacityCells: opacityCells,
        shaderEffects: effects,
        shaderAnimation: animation,
      });
      requestClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="appearance-settings-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && requestClose()}
    >
      <section className="appearance-settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header>
          <div>
            <h1 id="settings-title">Settings</h1>
            <p>Profile-wide terminal appearance and Ghostty-compatible configuration.</p>
          </div>
          <button type="button" className="appearance-close" onClick={requestClose} aria-label="Close settings">
            ×
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-sidebar" aria-label="Settings sections">
            {onSave ? (
              <button
                type="button"
                className={section === "appearance" ? "is-selected" : ""}
                aria-current={section === "appearance" ? "page" : undefined}
                disabled={advancedDirty}
                title={advancedDirty ? "Save or revert the Advanced draft before switching sections" : undefined}
                onClick={() => selectSection("appearance")}
              >
                <span>Appearance</span>
                <small>Themes &amp; shaders</small>
              </button>
            ) : null}
            {configEditor ? (
              <button
                type="button"
                className={section === "advanced" ? "is-selected" : ""}
                aria-current={section === "advanced" ? "page" : undefined}
                disabled={appearanceDirty}
                title={appearanceDirty ? "Apply or cancel Appearance changes before switching sections" : undefined}
                onClick={() => selectSection("advanced")}
              >
                <span>Advanced</span>
                <small>Ghostty config</small>
              </button>
            ) : null}
            {appearanceDirty ? (
              <p className="settings-sidebar-note">Apply or cancel Appearance edits to switch.</p>
            ) : null}
            {advancedDirty ? (
              <p className="settings-sidebar-note">Save or revert the Advanced draft to switch.</p>
            ) : null}
          </nav>

          <div className="settings-content">
            <div className={`settings-page appearance-settings-page${section === "appearance" ? " is-active" : ""}`}>
              {appearanceStale ? (
                <div className="config-conflict appearance-config-stale" role="alert">
                  <div>
                    <strong>The configuration changed while Appearance had pending edits.</strong>
                    <p>Choose whether to reload the current values or explicitly rebase your pending appearance.</p>
                  </div>
                  <span>
                    <button type="button" onClick={() => resetAppearanceToConfig(observedConfig)}>
                      Reload current values
                    </button>
                    <button type="button" onClick={acknowledgeLatestAppearanceBase}>
                      Keep my pending edits
                    </button>
                  </span>
                </div>
              ) : null}
              <div className="appearance-settings-grid">
                <section className="appearance-panel">
                  <h2>
                    Color theme <span>{GHOSTTY_COLOR_THEMES.length}</span>
                  </h2>
                  <input
                    className="appearance-search"
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    placeholder="Search Ghostty themes"
                    aria-label="Search Ghostty themes"
                    autoFocus={section === "appearance"}
                  />
                  <div className="appearance-theme-list" role="listbox" aria-label="Color themes">
                    {!matchedTheme ? (
                      <ThemeChoice
                        theme={currentTheme}
                        selected={themeName === null}
                        onSelect={() => setThemeName(null)}
                      />
                    ) : null}
                    {selectedTheme && !filteredThemes.some((theme) => theme.name === selectedTheme.name) ? (
                      <ThemeChoice theme={selectedTheme} selected onSelect={() => setThemeName(selectedTheme.name)} />
                    ) : null}
                    {filteredThemes.map((theme) => (
                      <ThemeChoice
                        key={theme.name}
                        theme={theme}
                        selected={theme.name === selectedTheme?.name}
                        onSelect={() => setThemeName(theme.name)}
                      />
                    ))}
                  </div>
                </section>

                <section className="appearance-panel appearance-details">
                  <h2>Preview</h2>
                  <div
                    className="appearance-preview"
                    style={{ color: previewTheme.foreground, background: previewTheme.background }}
                  >
                    <div className="appearance-preview-dots">
                      {previewTheme.palette.slice(1, 7).map((color, index) => (
                        <i key={`${color}-${index}`} style={{ background: color }} />
                      ))}
                    </div>
                    <code>
                      <span style={{ color: previewTheme.palette[2] }}>ghosttea</span>{" "}
                      <span style={{ color: previewTheme.palette[4] }}>~/projects</span> $ cargo test
                      <br />
                      All systems steeping.
                    </code>
                    <i
                      className="appearance-preview-cursor"
                      style={{ color: previewTheme.cursorText, background: previewTheme.cursor }}
                    >
                      _
                    </i>
                  </div>

                  <label className="appearance-range">
                    <span>
                      Background opacity <output>{Math.round(opacity * 100)}%</output>
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={opacity}
                      onChange={(event) => setOpacity(event.currentTarget.valueAsNumber)}
                    />
                  </label>
                  <label className="appearance-check">
                    <input
                      type="checkbox"
                      checked={opacityCells}
                      onChange={(event) => setOpacityCells(event.currentTarget.checked)}
                    />
                    <span>Apply opacity to explicit cell backgrounds</span>
                  </label>
                  {backdropBlur ? (
                    <BackdropBlurControl bridge={backdropBlur} />
                  ) : (
                    <p className="appearance-help">
                      Desktop transparency and background blur depend on your operating system and app host.
                    </p>
                  )}

                  <h2>Shader stack</h2>
                  <p className="appearance-help">
                    Effects run top-to-bottom. Animated effects repaint while this window is focused.
                  </p>
                  <div className="appearance-shader-list">
                    {[...GHOSTTEA_SHADER_OPTIONS]
                      .sort((left, right) => {
                        const leftIndex = effects.indexOf(left.id);
                        const rightIndex = effects.indexOf(right.id);
                        if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
                        if (leftIndex >= 0) return -1;
                        if (rightIndex >= 0) return 1;
                        return 0;
                      })
                      .map((shader) => {
                        const stackIndex = effects.indexOf(shader.id);
                        return (
                          <div key={shader.id} className="appearance-shader">
                            <label>
                              <input
                                type="checkbox"
                                checked={stackIndex >= 0}
                                onChange={() => toggleEffect(shader.id)}
                              />
                              <span>
                                <strong>
                                  {stackIndex >= 0 ? `${stackIndex + 1}. ` : ""}
                                  {shader.name}
                                </strong>
                                <small>{shader.description}</small>
                                <em>{shader.license}</em>
                              </span>
                            </label>
                            {stackIndex >= 0 ? (
                              <span className="appearance-shader-order" aria-label={`Reorder ${shader.name}`}>
                                <button
                                  type="button"
                                  disabled={stackIndex === 0}
                                  onClick={() => moveEffect(shader.id, -1)}
                                  aria-label={`Move ${shader.name} up`}
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  disabled={stackIndex === effects.length - 1}
                                  onClick={() => moveEffect(shader.id, 1)}
                                  aria-label={`Move ${shader.name} down`}
                                >
                                  ↓
                                </button>
                              </span>
                            ) : null}
                          </div>
                        );
                      })}
                  </div>
                  <label className="appearance-check">
                    <input
                      type="checkbox"
                      checked={animation}
                      onChange={(event) => setAnimation(event.currentTarget.checked)}
                    />
                    <span>Animate shader stack</span>
                  </label>
                  <details className="appearance-unavailable">
                    <summary>
                      {UNAVAILABLE_UPSTREAM_SHADERS.length} upstream shaders awaiting redistribution clearance
                    </summary>
                    <p>{UNAVAILABLE_UPSTREAM_SHADERS.join(", ")}</p>
                  </details>
                </section>
              </div>
              {error ? (
                <p className="appearance-error" role="alert">
                  {error}
                </p>
              ) : null}
              <footer>
                <button type="button" onClick={requestClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="appearance-save"
                  disabled={saving || appearanceStale}
                  onClick={() => void save()}
                >
                  {saving ? "Applying…" : "Apply"}
                </button>
              </footer>
            </div>

            {configEditor && advancedOpened ? (
              <div className={`settings-page advanced-settings-page${section === "advanced" ? " is-active" : ""}`}>
                <AdvancedConfigSettings
                  config={observedConfig}
                  editor={configEditor}
                  onClose={requestClose}
                  onDirtyChange={setAdvancedDirty}
                  onPreview={onPreview}
                  onSaved={setObservedConfig}
                />
              </div>
            ) : null}
          </div>
        </div>

        {confirmDiscard ? (
          <div className="config-discard-backdrop" role="presentation">
            <section role="alertdialog" aria-modal="true" aria-labelledby="config-discard-title">
              <h2 id="config-discard-title">Discard the unsaved config draft?</h2>
              <p>Your live preview will be reverted. Changes not already being saved have not been written to disk.</p>
              <footer>
                <button type="button" onClick={() => setConfirmDiscard(false)} autoFocus>
                  Keep editing
                </button>
                <button
                  type="button"
                  className="config-discard-action"
                  onClick={() => {
                    setAdvancedDirty(false);
                    onPreview(undefined);
                    onClose();
                  }}
                >
                  Discard draft
                </button>
              </footer>
            </section>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ThemeChoice({
  theme,
  selected,
  onSelect,
}: {
  theme: (typeof GHOSTTY_COLOR_THEMES)[number];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={selected ? "is-selected" : ""}
      onClick={onSelect}
    >
      <span className="appearance-swatches" style={{ background: theme.background }}>
        {theme.palette.slice(1, 5).map((color, index) => (
          <i key={`${color}-${index}`} style={{ background: color }} />
        ))}
      </span>
      <span>{theme.name}</span>
    </button>
  );
}
