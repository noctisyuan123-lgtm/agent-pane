/** Per-model effort / Fast prefs (independent across models). */

export type EffortLevel = "low" | "medium" | "high";

export type ModelEffortPref = {
  effort: EffortLevel;
  fast: boolean;
};

const STORAGE_KEY = "agent-pane-effort-by-model";

export function defaultEffortFor(modelId: string): ModelEffortPref {
  // Composer / *-fast models default to Fast; others Medium
  if (/composer|fast/i.test(modelId)) {
    return { effort: "medium", fast: true };
  }
  return { effort: "medium", fast: false };
}

export function loadEffortMap(): Record<string, ModelEffortPref> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<ModelEffortPref>>;
    const out: Record<string, ModelEffortPref> = {};
    for (const [id, v] of Object.entries(parsed)) {
      if (!v || typeof v !== "object") continue;
      const effort =
        v.effort === "low" || v.effort === "high" || v.effort === "medium"
          ? v.effort
          : "medium";
      out[id] = { effort, fast: Boolean(v.fast) };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveEffortMap(map: Record<string, ModelEffortPref>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function getEffortFor(modelId: string): ModelEffortPref {
  const map = loadEffortMap();
  return map[modelId] ?? defaultEffortFor(modelId);
}

export function setEffortFor(
  modelId: string,
  pref: ModelEffortPref
): void {
  const map = loadEffortMap();
  map[modelId] = pref;
  saveEffortMap(map);
  // Legacy global keys — keep in sync for older paths
  localStorage.setItem("agent-pane-effort", pref.effort);
  localStorage.setItem("agent-pane-effort-fast", pref.fast ? "1" : "0");
}

/** Seed map from legacy global keys once (first run after upgrade). */
export function migrateLegacyEffort(currentModelId: string): void {
  const map = loadEffortMap();
  if (Object.keys(map).length > 0) return;
  const raw = localStorage.getItem("agent-pane-effort") || "medium";
  const effort: EffortLevel =
    raw === "low" || raw === "high" || raw === "medium" ? raw : "medium";
  const fast = localStorage.getItem("agent-pane-effort-fast") === "1";
  map[currentModelId] = { effort, fast };
  saveEffortMap(map);
}

export function effortLabelFor(pref: ModelEffortPref): string {
  if (pref.fast) return "Fast";
  if (pref.effort === "low") return "Low";
  if (pref.effort === "high") return "High";
  return "Medium";
}
