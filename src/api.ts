export type Item = { c: string; b: string; f: string; w: string; t: string; a: string };
export type Status = "ok" | "missing";
export type AppState = {
  base: Item[];
  status: Record<string, Status>;
  extra: Item[];
  areaFilters: string[];
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: init?.body ? { "content-type": "application/json" } : undefined,
    });
  } catch {
    throw new Error("Sem conexão com o servidor.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data as T;
}

export const api = {
  state: () => request<AppState>("/api/state"),
  setStatus: (code: string, status: Status | null) =>
    request<{ ok: true }>("/api/status", { method: "POST", body: JSON.stringify({ code, status }) }),
  addExtra: (item: Item) =>
    request<{ item: Item }>("/api/extras", { method: "POST", body: JSON.stringify({ item }) }),
  setAreaFilters: (areaFilters: string[]) =>
    request<{ ok: true }>("/api/settings", { method: "PUT", body: JSON.stringify({ areaFilters }) }),
};

// Dados que versões antigas do app guardavam só no navegador (localStorage).
// Se existirem, são enviados uma vez ao servidor (só acrescenta) e depois apagados do navegador.
const LEGACY_KEYS = ["qr-status-v1", "qr-extra-v1", "qr-area-filters-v2"] as const;

export async function migrateLegacyStorage(): Promise<void> {
  let raw: Record<string, string | null>;
  try {
    raw = Object.fromEntries(LEGACY_KEYS.map((k) => [k, localStorage.getItem(k)]));
  } catch {
    return;
  }
  const parse = (s: string | null | undefined) => {
    try {
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  };
  const status = parse(raw["qr-status-v1"]);
  const extra = parse(raw["qr-extra-v1"]);
  const areaFilters = parse(raw["qr-area-filters-v2"]);
  const hasData =
    (status && Object.keys(status).length > 0) ||
    (Array.isArray(extra) && extra.length > 0) ||
    (Array.isArray(areaFilters) && areaFilters.length > 0);
  if (hasData) {
    await request("/api/import", { method: "POST", body: JSON.stringify({ status, extra, areaFilters }) });
  }
  // Só chega aqui se o envio deu certo (ou não havia nada a enviar).
  for (const k of LEGACY_KEYS) localStorage.removeItem(k);
}
