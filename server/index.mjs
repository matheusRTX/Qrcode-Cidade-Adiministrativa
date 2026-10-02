// Servidor sem dependências: serve o app (dist/) e grava tudo em arquivos JSON.
//
//   data/qrcodes.json   lista base de QR Codes (você edita à mão, se quiser)
//   data/status.json    { "A1": "ok", "A2": "missing", ... }
//   data/extras.json    QR Codes cadastrados pelo app
//   data/settings.json  { "areaFilters": [...] }
//
// Variáveis: PORT (3000), HOST (0.0.0.0), DATA_DIR (./data)

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const DIST = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY = 5 * 1024 * 1024;

const FILES = {
  base: { file: path.join(DATA_DIR, "qrcodes.json"), fallback: () => [] },
  status: { file: path.join(DATA_DIR, "status.json"), fallback: () => ({}) },
  extras: { file: path.join(DATA_DIR, "extras.json"), fallback: () => [] },
  settings: { file: path.join(DATA_DIR, "settings.json"), fallback: () => ({ areaFilters: [] }) },
};

const STATUSES = new Set(["ok", "missing"]);
const ITEM_KEYS = ["c", "b", "f", "w", "t", "a"];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- leitura / escrita de JSON ----------

async function readJson(key) {
  const { file, fallback } = FILES[key];
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return fallback();
    throw e;
  }
  if (!text.trim()) return fallback();
  try {
    return JSON.parse(text);
  } catch {
    // Não sobrescreve um arquivo corrompido: melhor falhar do que perder dados.
    throw new HttpError(500, `Arquivo inválido: ${path.basename(file)}`);
  }
}

// Escrita atômica: grava num .tmp e renomeia, então nunca sobra arquivo pela metade.
async function writeJson(key, value) {
  const { file } = FILES[key];
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

// Uma operação por vez, para dois celulares não pisarem um no outro.
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

// ---------- validação ----------

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function cleanItem(raw) {
  if (!isObj(raw)) throw new HttpError(400, "Item inválido.");
  const item = {};
  for (const k of ITEM_KEYS) {
    const v = raw[k];
    if (typeof v !== "string") throw new HttpError(400, `Campo "${k}" inválido.`);
    item[k] = v.trim().slice(0, 200);
  }
  item.c = item.c.toUpperCase();
  if (!item.c || !item.f || !item.a) throw new HttpError(400, "Preencha código, andar e área.");
  return item;
}

const hasCode = (list, code) => list.some((i) => String(i.c).toUpperCase() === code.toUpperCase());

// ---------- rotas da API ----------

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/state") {
    const [base, status, extra, settings] = await Promise.all([
      readJson("base"),
      readJson("status"),
      readJson("extras"),
      readJson("settings"),
    ]);
    return send(res, 200, {
      base,
      status,
      extra,
      areaFilters: Array.isArray(settings.areaFilters) ? settings.areaFilters : [],
    });
  }

  if (route === "POST /api/status") {
    const body = await readBody(req);
    const code = typeof body.code === "string" ? body.code : "";
    const value = body.status;
    if (!code) throw new HttpError(400, "Código ausente.");
    if (value !== null && !STATUSES.has(value)) throw new HttpError(400, "Status inválido.");
    return withLock(async () => {
      const [base, extras, status] = await Promise.all([readJson("base"), readJson("extras"), readJson("status")]);
      if (!hasCode(base, code) && !hasCode(extras, code)) throw new HttpError(404, "Código não encontrado.");
      if (value === null) delete status[code];
      else status[code] = value;
      await writeJson("status", status);
      send(res, 200, { ok: true });
    });
  }

  if (route === "POST /api/extras") {
    const item = cleanItem((await readBody(req)).item);
    return withLock(async () => {
      const [base, extras] = await Promise.all([readJson("base"), readJson("extras")]);
      if (hasCode(base, item.c) || hasCode(extras, item.c)) throw new HttpError(409, "Este código já existe.");
      extras.push(item);
      await writeJson("extras", extras);
      send(res, 201, { item });
    });
  }

  if (route === "PUT /api/settings") {
    const body = await readBody(req);
    if (!Array.isArray(body.areaFilters) || !body.areaFilters.every((a) => typeof a === "string")) {
      throw new HttpError(400, "areaFilters inválido.");
    }
    return withLock(async () => {
      const settings = await readJson("settings");
      settings.areaFilters = body.areaFilters;
      await writeJson("settings", settings);
      send(res, 200, { ok: true });
    });
  }

  // Importa dados que estavam só no navegador (localStorage). Só acrescenta, nunca sobrescreve.
  if (route === "POST /api/import") {
    const body = await readBody(req);
    return withLock(async () => {
      const [base, extras, status, settings] = await Promise.all([
        readJson("base"),
        readJson("extras"),
        readJson("status"),
        readJson("settings"),
      ]);
      let addedExtras = 0;
      let addedStatus = 0;

      for (const raw of Array.isArray(body.extra) ? body.extra : []) {
        let item;
        try {
          item = cleanItem(raw);
        } catch {
          continue;
        }
        if (hasCode(base, item.c) || hasCode(extras, item.c)) continue;
        extras.push(item);
        addedExtras++;
      }
      if (isObj(body.status)) {
        for (const [code, value] of Object.entries(body.status)) {
          if (!STATUSES.has(value) || code in status) continue;
          if (!hasCode(base, code) && !hasCode(extras, code)) continue;
          status[code] = value;
          addedStatus++;
        }
      }
      let filters = false;
      if (
        Array.isArray(body.areaFilters) &&
        body.areaFilters.every((a) => typeof a === "string") &&
        (!Array.isArray(settings.areaFilters) || settings.areaFilters.length === 0)
      ) {
        settings.areaFilters = body.areaFilters;
        filters = body.areaFilters.length > 0;
      }

      if (addedExtras) await writeJson("extras", extras);
      if (addedStatus) await writeJson("status", status);
      if (filters) await writeJson("settings", settings);
      send(res, 200, { addedExtras, addedStatus });
    });
  }

  throw new HttpError(404, "Rota não encontrada.");
}

// ---------- utilitários HTTP ----------

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Corpo muito grande.");
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!isObj(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, "JSON inválido.");
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

async function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, "URL inválida.");
  }
  let file = path.join(DIST, rel);
  if (file !== DIST && !file.startsWith(DIST + path.sep)) throw new HttpError(403, "Acesso negado.");

  let stat = await fs.stat(file).catch(() => null);
  if (stat?.isDirectory()) {
    file = path.join(file, "index.html");
    stat = await fs.stat(file).catch(() => null);
  }
  if (!stat) {
    // Rota do app (SPA): devolve o index.html. Arquivo com extensão que não existe é 404.
    if (path.extname(rel)) throw new HttpError(404, "Não encontrado.");
    file = path.join(DIST, "index.html");
    stat = await fs.stat(file).catch(() => null);
    if (!stat) throw new HttpError(503, 'App não compilado. Rode "npm run build" primeiro.');
  }

  const ext = path.extname(file).toLowerCase();
  const immutable = file.startsWith(path.join(DIST, "assets") + path.sep);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") return res.end();
  res.end(await fs.readFile(file));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Método não permitido.");
    await serveStatic(req, res, url);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (res.headersSent) return res.end();
    const message = e instanceof HttpError ? e.message : "Erro interno.";
    if (req.url?.startsWith("/api/")) send(res, status, { error: message });
    else {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(message);
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Gestão de QR Codes em http://localhost:${PORT}  (dados em ${DATA_DIR})`);
});
