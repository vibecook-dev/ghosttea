import { useEffect, useState } from "react";
import type { GhostteaBackdropBlurBridge } from "./types.js";

export function BackdropBlurControl({ bridge }: { bridge: GhostteaBackdropBlurBridge }) {
  const [enabled, setEnabled] = useState<boolean>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    let changed = false;
    const unsubscribe = bridge.subscribe((value) => {
      changed = true;
      if (active) setEnabled(value);
    });
    void bridge.load().then(
      (value) => {
        if (active && !changed) setEnabled(value);
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  const save = async (value: boolean): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      setEnabled(await bridge.save(value));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <label className="appearance-check">
        <input
          type="checkbox"
          role="switch"
          checked={enabled ?? false}
          disabled={enabled === undefined || saving}
          onChange={(event) => void save(event.currentTarget.checked)}
          aria-describedby="backdrop-blur-help"
        />
        <span>Background blur{saving ? " · Saving…" : ""}</span>
      </label>
      <p className="appearance-help" id="backdrop-blur-help">
        Softens the desktop behind your window. Saves immediately for all windows in this profile. Lower Background
        opacity and click Apply to reveal more of the blur.
      </p>
      {error ? (
        <p className="appearance-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
