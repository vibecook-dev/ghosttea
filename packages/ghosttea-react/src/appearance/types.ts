import type {
  ConfigDiagnostic,
  ConfigDocument,
  ConfigDocumentValidation,
  ConfigSnapshot,
} from "@vibecook/ghosttea-protocol";
import type { GhostteaColorTheme } from "./catalog.js";
import type { TerminalShaderEffect } from "../renderers/types.js";

/** Optional native host capability. Changes are persisted and applied immediately. */
export interface GhostteaBackdropBlurBridge {
  load: () => Promise<boolean>;
  save: (enabled: boolean) => Promise<boolean>;
  subscribe: (listener: (enabled: boolean) => void) => () => void;
}

export interface GhostteaAppearanceUpdate {
  /** Omitted when the user keeps a non-catalog/custom color configuration. */
  theme?: GhostteaColorTheme;
  backgroundOpacity: number;
  backgroundOpacityCells: boolean;
  shaderEffects: TerminalShaderEffect[];
  shaderAnimation: boolean;
}

export interface GhostteaConfigEditorState {
  document: ConfigDocument;
  config: ConfigSnapshot;
}

export interface GhostteaConfigEditorValidation extends ConfigDocumentValidation {
  /**
   * Errors caused by the candidate overlay. Hosts may omit this for backwards
   * compatibility, in which case every error remains blocking.
   */
  blockingErrors?: ConfigDiagnostic[];
}

export type GhostteaConfigEditorSaveResult =
  | {
      status: "saved";
      document: ConfigDocument;
      config: ConfigSnapshot;
    }
  | {
      status: "conflict";
      document: ConfigDocument;
    };

export type GhostteaConfigEditorImportResult =
  | {
      status: "selected";
      name: string;
      contents: string;
      notice?: string;
    }
  | { status: "cancelled" }
  | { status: "unavailable"; message: string };

export type GhostteaConfigEditorExportResult = { status: "saved"; path: string } | { status: "cancelled" };

/** Narrow host capability for editing only Ghosttea's profile-owned overlay. */
export interface GhostteaConfigEditorBridge {
  load: () => Promise<GhostteaConfigEditorState>;
  validate: (contents: string) => Promise<GhostteaConfigEditorValidation>;
  save: (expectedRevision: string, contents: string) => Promise<GhostteaConfigEditorSaveResult>;
  importGhostty: () => Promise<GhostteaConfigEditorImportResult>;
  importFile: () => Promise<GhostteaConfigEditorImportResult>;
  exportFile: (contents: string) => Promise<GhostteaConfigEditorExportResult>;
  /** Open the owned overlay in a trusted external text editor. */
  openExternal?: () => void;
  /** Inform a native host that closing this renderer requires confirmation. */
  setDirty?: (dirty: boolean) => void;
}
