import { BINDINGS } from "./inputBindings";

export interface ControlRow {
  keyLabel: string;
  actionLabel: string;
}

/** 設定画面に表示する操作説明行を構築する。advancedFlight=true で高度な飛行系操作も含める。 */
export function buildControlRows(advancedFlight = false): ControlRow[] {
  return BINDINGS.filter((b) => b.visible !== false)
    .filter((b) => !b.advancedOnly || advancedFlight)
    .map((b) => ({
      keyLabel: b.keyLabel + (b.mouseLabel ? ` / ${b.mouseLabel}` : ""),
      actionLabel: b.actionLabel,
    }));
}

export function renderControlRowsHtml(rows: ControlRow[]): string {
  return rows
    .map((r) => `<div class="row"><span class="k">${r.keyLabel}</span><span class="a">${r.actionLabel}</span></div>`)
    .join("");
}
