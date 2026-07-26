/** localStorage に保存するキャンペーン進捗。 */
export interface SaveData {
  missionId: string;
  totalKills: number;
  /** クリア済みミッションID。 */
  cleared: string[];
  updatedAt: number;
}

const KEY = "multidommander.save.v1";

/** キャンペーン進捗の永続化 (localStorage)。失敗しても致命的でないよう握りつぶす。 */
export const SaveManager = {
  load(): SaveData | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const data = JSON.parse(raw) as SaveData;
      if (typeof data.missionId !== "string") return null;
      return data;
    } catch {
      return null;
    }
  },

  save(data: SaveData): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      // storage 無効時は無視。
    }
  },

  clear(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // 無視。
    }
  },
};
