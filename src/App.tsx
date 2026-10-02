import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, migrateLegacyStorage, type Item, type Status } from "./api";

const codeKey = (c: string) => {
  const m = c.match(/^([A-Za-z]*)(\d*)(.*)$/);
  if (!m) return ["", 0, c] as const;
  return [(m[1] ?? "").toUpperCase(), Number(m[2] || 0), m[3] ?? ""] as const;
};
const byCode = (x: Item, y: Item) => {
  const a = codeKey(x.c), b = codeKey(y.c);
  return (a[0] ?? "").localeCompare(b[0] ?? "") || a[1] - b[1] || (a[2] ?? "").localeCompare(b[2] ?? "");
};
const floorNum = (f: string) => {
  if (/^subsolo para/i.test(f)) return -0.5;
  if (/^subsolo/i.test(f)) return -1;
  if (/^t[ée]rr?e?o/i.test(f)) return /para/i.test(f) ? 0.5 : 0;
  const n = parseInt(f);
  if (isNaN(n)) return 99;
  return /para/i.test(f) ? n + 0.5 : n;
};

// Walking order across the floor plan: Setor 1 → 2 → 3 (center) → 4 → 5
const SALA_ORDER = [10, 11, 12, 9, 8, 7, 6, 4, 3, 5, 2, 1];
const sectorOf = (w: string): { pos: number; label: string } => {
  const s = w.toLowerCase();
  const sala = s.match(/sala (\d+)/);
  if (sala) return { pos: 3 + SALA_ORDER.indexOf(Number(sala[1])) / 100, label: "Setor 3 · Reuniões" };
  if (s.startsWith("impar-1")) return { pos: 1, label: "Setor 1 · Lado Ímpar" };
  if (s === "impar") return { pos: 1.5, label: "Lado Ímpar" };
  if (s.startsWith("impar-2")) return { pos: 2, label: "Setor 2 · Lado Ímpar" };
  if (s.includes("central") && s.includes("impar")) return { pos: 2.8, label: "Setor 3 · Centro (lado ímpar)" };
  if (s.includes("central") && s.includes("par")) return { pos: 3.4, label: "Setor 3 · Centro (lado par)" };
  if (s.startsWith("central") || s.includes("elev") || s.includes("recep")) return { pos: 2.9, label: "Setor 3 · Centro" };
  if (s.startsWith("par-4")) return { pos: 4, label: "Setor 4 · Lado Par" };
  if (s === "par") return { pos: 4.5, label: "Lado Par" };
  if (s.startsWith("par-5") || s.startsWith("par /5")) return { pos: 5, label: "Setor 5 · Lado Par" };
  return { pos: 9, label: "Outros" };
};
const byRoute = (x: Item, y: Item) =>
  x.b.localeCompare(y.b) ||
  floorNum(x.f) - floorNum(y.f) ||
  x.f.localeCompare(y.f) ||
  sectorOf(x.w).pos - sectorOf(y.w).pos ||
  x.a.localeCompare(y.a) ||
  byCode(x, y);

export default function App() {
  const [tab, setTab] = useState<"painel" | "auditoria" | "reposicao">("painel");
  const [base, setBase] = useState<Item[]>([]);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [extra, setExtra] = useState<Item[]>([]);
  const [areaFilters, setAreaFilters] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [building, setBuilding] = useState("");
  const [floor, setFloor] = useState("");

  // Gravações vão uma de cada vez, na ordem em que o usuário fez.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    pending.current++;
    const run = queue.current.then(job, job);
    queue.current = run.catch(() => {}).finally(() => { pending.current--; });
    return run;
  }, []);

  const load = useCallback(async (opts: { force?: boolean; migrate?: boolean } = {}) => {
    if (!opts.force && pending.current > 0) return;
    try {
      if (opts.migrate) await migrateLegacyStorage();
      const s = await api.state();
      setBase(s.base);
      setStatus(s.status);
      setExtra(s.extra);
      setAreaFilters(s.areaFilters);
      setError("");
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao carregar.");
    }
  }, []);

  useEffect(() => { load({ force: true, migrate: true }); }, [load]);

  // Vários aparelhos usam os mesmos arquivos: ao voltar para a aba, recarrega.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [load]);

  const fail = (e: unknown) => {
    setError(`Não foi possível salvar: ${e instanceof Error ? e.message : "erro desconhecido"}`);
    load({ force: true });
  };

  const all = useMemo(() => [...base, ...extra], [base, extra]);
  const buildings = useMemo(() => [...new Set(all.map((i) => i.b))].sort(), [all]);
  const floors = useMemo(
    () => [...new Set(all.filter((i) => !building || i.b === building).map((i) => i.f))].sort((a, b) => floorNum(a) - floorNum(b)),
    [all, building],
  );
  const filtered = useMemo(
    () => all.filter((i) => (!building || i.b === building) && (!floor || i.f === floor)),
    [all, building, floor],
  );

  const setItem = (c: string, s: Status | null) => {
    setStatus((p) => {
      const n = { ...p };
      if (s) n[c] = s; else delete n[c];
      return n;
    });
    enqueue(() => api.setStatus(c, s)).catch(fail);
  };

  const addItem = async (i: Item): Promise<string | null> => {
    try {
      const { item } = await enqueue(() => api.addExtra(i));
      setExtra((p) => [...p, item]);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Erro ao cadastrar.";
    }
  };

  const changeAreaFilters = (names: string[]) => {
    setAreaFilters(names);
    enqueue(() => api.setAreaFilters(names)).catch(fail);
  };

  if (!loaded) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-sm text-center">
          {error ? (
            <>
              <p className="text-sm text-danger">{error}</p>
              <button onClick={() => load({ force: true, migrate: true })} className="mt-4 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground">Tentar novamente</button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-20 md:pb-0">
      <header className="no-print sticky top-0 z-20 border-b bg-primary text-primary-foreground">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-widest opacity-70">Cidade Administrativa</p>
            <h1 className="text-base font-semibold sm:text-lg">Gestão de QR Codes</h1>
          </div>
          <nav className="hidden gap-1 md:flex">
            <Tabs tab={tab} setTab={setTab} />
          </nav>
        </div>
      </header>
      <nav className="no-print fixed inset-x-0 bottom-0 z-20 flex border-t bg-card md:hidden">
        <Tabs tab={tab} setTab={setTab} mobile />
      </nav>

      <main className="mx-auto max-w-6xl px-4 py-5">
        {error && (
          <div className="no-print mb-4 flex items-center justify-between gap-3 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
            <span>{error}</span>
            <button onClick={() => setError("")} className="shrink-0 font-semibold underline">Fechar</button>
          </div>
        )}
        {tab !== "reposicao" && (
          <Filters {...{ buildings, floors, building, floor, setBuilding, setFloor }} />
        )}
        {tab === "painel" && <Dashboard items={filtered} status={status} onGo={setTab} />}
        {tab === "auditoria" && (
          <Audit items={filtered} status={status} setItem={setItem} buildings={buildings}
            areaNames={areaFilters} setAreaNames={changeAreaFilters}
            onAdd={addItem} exists={(c) => all.some((i) => i.c.toUpperCase() === c.toUpperCase())} />
        )}
        {tab === "reposicao" && <Report items={all.filter((i) => status[i.c] === "missing").sort(byCode)} />}
      </main>
    </div>
  );
}

function Tabs({ tab, setTab, mobile }: { tab: string; setTab: (t: any) => void; mobile?: boolean }) {
  const items = [["painel", "Painel"], ["auditoria", "Auditoria"], ["reposicao", "Reposição"]];
  return (
    <>
      {items.map(([k, l]) => (
        <button key={k} onClick={() => setTab(k)}
          className={mobile
            ? `flex-1 py-3 text-sm font-medium ${tab === k ? "text-primary border-t-2 border-primary" : "text-muted-foreground"}`
            : `rounded-md px-4 py-2 text-sm font-medium transition ${tab === k ? "bg-primary-foreground text-primary" : "hover:bg-primary-foreground/10"}`}>
          {l}
        </button>
      ))}
    </>
  );
}

const selectCls = "w-full rounded-lg border bg-card px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

function Filters(p: { buildings: string[]; floors: string[]; building: string; floor: string; setBuilding: (s: string) => void; setFloor: (s: string) => void }) {
  return (
    <div className="no-print mb-5 grid grid-cols-2 gap-3">
      <select className={selectCls} value={p.building} onChange={(e) => { p.setBuilding(e.target.value); p.setFloor(""); }}>
        <option value="">Todos os prédios</option>
        {p.buildings.map((b) => <option key={b}>{b}</option>)}
      </select>
      <select className={selectCls} value={p.floor} onChange={(e) => p.setFloor(e.target.value)}>
        <option value="">Todos os andares</option>
        {p.floors.map((f) => <option key={f}>{f}</option>)}
      </select>
    </div>
  );
}

function Dashboard({ items, status, onGo }: { items: Item[]; status: Record<string, Status>; onGo: (t: any) => void }) {
  const ok = items.filter((i) => status[i.c] === "ok").length;
  const miss = items.filter((i) => status[i.c] === "missing").length;
  const done = ok + miss;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const byB = useMemo(() => {
    const m = new Map<string, { t: number; ok: number; miss: number }>();
    items.forEach((i) => {
      const r = m.get(i.b) || { t: 0, ok: 0, miss: 0 };
      r.t++; if (status[i.c] === "ok") r.ok++; if (status[i.c] === "missing") r.miss++;
      m.set(i.b, r);
    });
    return [...m.entries()].sort((a, b) => b[1].t - a[1].t);
  }, [items, status]);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total de QR Codes" value={items.length} />
        <Stat label="Conferidos" value={done} sub={`${pct}%`} />
        <Stat label="OK" value={ok} tone="success" />
        <Stat label="Faltantes / Danificados" value={miss} tone="danger" />
      </div>
      <div className="rounded-xl border bg-card p-4">
        <div className="mb-2 flex justify-between text-sm"><span className="font-medium">Progresso da auditoria</span><span className="text-muted-foreground">{done} de {items.length}</span></div>
        <div className="flex h-3 overflow-hidden rounded-full bg-muted">
          <div className="bg-success" style={{ width: `${items.length ? (ok / items.length) * 100 : 0}%` }} />
          <div className="bg-danger" style={{ width: `${items.length ? (miss / items.length) * 100 : 0}%` }} />
        </div>
      </div>
      <div className="rounded-xl border bg-card">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Por prédio</h2>
        <ul className="divide-y">
          {byB.map(([b, r]) => (
            <li key={b} className="flex items-center justify-between px-4 py-3 text-sm">
              <span className="font-medium">{b}</span>
              <span className="flex gap-3 tabular-nums">
                <span className="text-muted-foreground">{r.t}</span>
                <span className="text-success">{r.ok} OK</span>
                <span className="text-danger">{r.miss} falt.</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <button onClick={() => onGo("auditoria")} className="w-full rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground">Iniciar auditoria</button>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: number; sub?: string; tone?: "success" | "danger" }) {
  const c = tone === "success" ? "border-l-success" : tone === "danger" ? "border-l-danger" : "border-l-primary";
  return (
    <div className={`rounded-xl border border-l-4 bg-card p-4 ${c}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value.toLocaleString("pt-BR")}{sub && <span className="ml-2 text-sm font-medium text-muted-foreground">{sub}</span>}</p>
    </div>
  );
}

function Audit({ items, status, setItem, buildings, areaNames, setAreaNames, onAdd, exists }: {
  items: Item[]; status: Record<string, Status>; setItem: (c: string, s: Status | null) => void;
  buildings: string[]; areaNames: string[]; setAreaNames: (names: string[]) => void;
  onAdd: (i: Item) => Promise<string | null>; exists: (c: string) => boolean;
}) {
  const [q, setQ] = useState("");
  const [show, setShow] = useState<"all" | "pending" | "ok" | "missing">("all");
  const [limit, setLimit] = useState(50);
  const [adding, setAdding] = useState(false);
  const [areasOpen, setAreasOpen] = useState(false);
  const selectedAreas = useMemo(() => new Set(areaNames), [areaNames]);

  useEffect(() => setLimit(50), [q, show, items, selectedAreas]);

  const areas = useMemo(() => {
    const unique = new Set(items.map((i) => i.a));
    return [...unique].sort();
  }, [items]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter((i) => {
      const st = status[i.c];
      if (show === "pending" && st) return false;
      if (show !== "all" && show !== "pending" && st !== show) return false;
      if (selectedAreas.size > 0 && !selectedAreas.has(i.a)) return false;
      return !s || `${i.c} ${i.a} ${i.w} ${i.t}`.toLowerCase().includes(s);
    }).sort(byRoute);
  }, [items, status, q, show, selectedAreas]);

  const toggleArea = (area: string) => {
    const newSelected = new Set(selectedAreas);
    if (newSelected.has(area)) {
      newSelected.delete(area);
    } else {
      newSelected.add(area);
    }
    setAreaNames([...newSelected]);
  };

  const clearAreas = () => setAreaNames([]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar código, área, ala..." className={selectCls} />
        <button onClick={() => setAdding((v) => !v)} className="shrink-0 rounded-lg border bg-card px-4 text-sm font-medium">{adding ? "Fechar" : "+ Novo"}</button>
      </div>
      {adding && <NewForm buildings={buildings} exists={exists} onAdd={async (i) => { const e = await onAdd(i); if (!e) setAdding(false); return e; }} />}
      <div className="flex gap-2 overflow-x-auto text-sm">
        {([["all", "Todos"], ["pending", "Pendentes"], ["ok", "OK"], ["missing", "Faltantes"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setShow(k)} className={`rounded-full border px-3 py-1.5 whitespace-nowrap ${show === k ? "bg-foreground text-background" : "bg-card"}`}>{l}</button>
        ))}
        <span className="ml-auto self-center whitespace-nowrap text-muted-foreground">{list.length} itens</span>
      </div>
      {areas.length > 0 && (
        <div className="rounded-lg border bg-card">
          <div className="flex min-h-12 items-center justify-between gap-3 px-4 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Filtrar por localização</p>
              {selectedAreas.size > 0 && (
                <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">{selectedAreas.size}</span>
              )}
            </div>
            <button
              type="button"
              aria-expanded={areasOpen}
              onClick={() => setAreasOpen((open) => !open)}
              className="shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium text-foreground"
            >
              {areasOpen ? "Ocultar" : "Mostrar"}
            </button>
          </div>
          {areasOpen && (
            <div className="border-t px-4 py-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {areas.map((area) => (
                  <label key={area} className="flex cursor-pointer items-center gap-2 rounded-md border border-transparent p-2 hover:bg-muted">
                    <input type="checkbox" checked={selectedAreas.has(area)} onChange={() => toggleArea(area)} className="cursor-pointer" />
                    <span className="text-xs">{area}</span>
                  </label>
                ))}
              </div>
              {selectedAreas.size > 0 && (
                <button type="button" onClick={clearAreas} className="mt-3 text-xs text-muted-foreground underline">Limpar filtro</button>
              )}
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">Ordem de rota: Setor 1 → 2 → 3 (centro) → 4 → 5, andar por andar.</p>
      <ul className="space-y-2">
        {list.slice(0, limit).map((i, idx, arr) => {
          const st = status[i.c];
          const prev = arr[idx - 1];
          const label = `${i.b} · ${i.f} — ${sectorOf(i.w).label}`;
          const showHeader = !prev || `${prev.b} · ${prev.f} — ${sectorOf(prev.w).label}` !== label;
          return (
            <li key={i.c} className="space-y-2">
            {showHeader && <p className="sticky top-16 z-10 mt-3 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground">{label}</p>}
            <div className={`flex items-center gap-3 rounded-xl border bg-card p-3 ${st === "ok" ? "border-success/40 bg-success-soft" : st === "missing" ? "border-danger/40 bg-danger-soft" : ""}`}>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-sm font-bold">{i.c}</span>
                  <span className="truncate text-sm font-medium">{i.a}</span>
                </div>
                <p className="truncate text-xs text-muted-foreground">{i.b} · {i.f} · {i.w} · {i.t}</p>
              </div>
              <button aria-label="Presente" onClick={() => setItem(i.c, st === "ok" ? null : "ok")}
                className={`h-11 w-11 shrink-0 rounded-lg border-2 border-success text-lg font-bold ${st === "ok" ? "bg-success text-success-foreground" : "text-success"}`}>✓</button>
              <button aria-label="Ausente" onClick={() => setItem(i.c, st === "missing" ? null : "missing")}
                className={`h-11 w-11 shrink-0 rounded-lg border-2 border-danger text-lg font-bold ${st === "missing" ? "bg-danger text-danger-foreground" : "text-danger"}`}>✕</button>
            </div>
            </li>
          );
        })}
      </ul>
      {list.length > limit && (
        <button onClick={() => setLimit((l) => l + 100)} className="w-full rounded-lg border bg-card py-3 text-sm font-medium">Mostrar mais ({list.length - limit} restantes)</button>
      )}
    </div>
  );
}

function NewForm({ buildings, onAdd, exists }: { buildings: string[]; onAdd: (i: Item) => Promise<string | null>; exists: (c: string) => boolean }) {
  const [f, setF] = useState({ c: "", b: buildings[0] || "", f: "", w: "", t: "A - Piso acarpetado", a: "" });
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const up = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving) return;
        const c = f.c.trim().toUpperCase();
        if (!c || !f.f.trim() || !f.a.trim()) return setErr("Preencha código, andar e área.");
        if (exists(c)) return setErr("Este código já existe.");
        setErr("");
        setSaving(true);
        const message = await onAdd({ ...f, c, f: /^\d+$/.test(f.f.trim()) ? `${f.f.trim()}º andar` : f.f.trim() });
        setSaving(false);
        if (message) setErr(message);
      }}>
      <input className={selectCls} placeholder="Código (ex: A1778)" value={f.c} onChange={up("c")} />
      <select className={selectCls} value={f.b} onChange={up("b")}>{buildings.map((b) => <option key={b}>{b}</option>)}</select>
      <input className={selectCls} placeholder="Andar (ex: 3)" value={f.f} onChange={up("f")} />
      <input className={selectCls} placeholder="Ala (ex: Par-4)" value={f.w} onChange={up("w")} />
      <select className={selectCls} value={f.t} onChange={up("t")}>
        <option>A - Piso acarpetado</option><option>B - Piso frio</option><option>C - Área externa</option>
      </select>
      <input className={selectCls} placeholder="Área (ex: Copa)" value={f.a} onChange={up("a")} />
      {err && <p className="text-sm text-danger sm:col-span-3">{err}</p>}
      <button disabled={saving} className="rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-60 sm:col-span-3">{saving ? "Salvando…" : "Cadastrar QR Code"}</button>
    </form>
  );
}

function Report({ items }: { items: Item[] }) {
  const date = new Date().toLocaleDateString("pt-BR");
  const [view, setView] = useState<"table" | "qrcodes">("table");

  const groupedByFloor = useMemo(() => {
    const grouped = new Map<string, Item[]>();
    items.forEach((item) => {
      const key = `${item.b} · ${item.f}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(item);
    });
    const entries = Array.from(grouped.entries()).sort((a, b) => {
      const [buildingA = "", floorLabelA = ""] = a[0].split(" · ");
      const [buildingB = "", floorLabelB = ""] = b[0].split(" · ");
      const floorA = floorNum(floorLabelA);
      const floorB = floorNum(floorLabelB);
      return buildingA.localeCompare(buildingB) || floorA - floorB;
    });
    return entries;
  }, [items]);

  return (
    <div className="rounded-xl border bg-card p-5 print:border-0 print:p-0">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Cidade Administrativa</p>
          <h2 className="text-lg font-bold">Relatório de Reposição de QR Codes</h2>
          <p className="text-sm text-muted-foreground">Emitido em {date} · {items.length} itens ausentes/danificados</p>
        </div>
        <div className="no-print flex flex-col gap-2">
          {items.length > 0 && (
            <div className="flex gap-2 text-sm">
              <button onClick={() => setView("table")} className={`rounded-lg px-3 py-2 font-medium transition ${view === "table" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>Tabela</button>
              <button onClick={() => setView("qrcodes")} className={`rounded-lg px-3 py-2 font-medium transition ${view === "qrcodes" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>QR Codes</button>
            </div>
          )}
          <button onClick={() => window.print()} className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground">Imprimir / Salvar</button>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Nenhum QR Code marcado como ausente ou danificado.</p>
      ) : view === "table" ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr className="border-b"><th className="py-2 pr-3">Código</th><th className="pr-3">Prédio</th><th className="pr-3">Andar</th><th className="pr-3">Ala</th><th className="pr-3">Área</th><th>Tipo</th></tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.c} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-mono font-bold">{i.c}</td><td className="pr-3">{i.b}</td><td className="pr-3 whitespace-nowrap">{i.f}</td>
                  <td className="pr-3">{i.w}</td><td className="pr-3">{i.a}</td><td className="text-muted-foreground">{i.t}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-8 print:space-y-5">
          {groupedByFloor.map(([floorLabel, floorItems]) => (
            <div key={floorLabel} className="floor-group">
              <h3 className="floor-title mb-6 text-base font-bold print:mb-3">{floorLabel}</h3>
              <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 print:grid-cols-4 print:gap-4">
                {floorItems.sort(byCode).map((item) => (
                  <div key={item.c} className="qr-card flex flex-col items-center gap-2 rounded-lg border bg-white p-4 print:border-black print:p-3">
                    <QRCodeSVG value={item.c} size={120} level="H" marginSize={4} />
                    <p className="text-center font-mono text-sm font-bold">{item.c}</p>
                    <p className="text-center text-xs text-muted-foreground print:text-black">{item.b} | {item.f.replace(/º andar/i, "").trim()} | {item.w}</p>
                    <p className="text-center text-xs text-muted-foreground print:text-black">{item.t} | {item.a}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
