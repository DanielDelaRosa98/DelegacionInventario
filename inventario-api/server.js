const express = require("express");
const mysql = require("mysql2/promise");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const path = require("path");
const PDFDocument = require("pdfkit");
const fs = require("fs");
require("dotenv").config();

function failEnv(msg) { console.error(msg); process.exit(1); }
const REQUIRED_ENV = [
  "DB_HOST",
  "DB_NAME",
  "DB_USER_READ",
  "DB_PASS_READ",
  "JWT_SECRET",
];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  failEnv(`Faltan variables de entorno requeridas: ${missingEnv.join(", ")}`);
}
const HAS_OPS_CREDS = Boolean(process.env.DB_USER_OPS && process.env.DB_PASS_OPS);
if (!HAS_OPS_CREDS) {
  console.warn("[WARN] Faltan DB_USER_OPS/DB_PASS_OPS. Operaciones de escritura fallarAn.");
}
if (process.env.DB_SSL) {
  console.warn("[WARN] DB_SSL activo con rejectUnauthorized:false. Assalo solo en entornos internos.");
}

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan("tiny"));

app.use(
helmet({
contentSecurityPolicy: false,
crossOriginOpenerPolicy: false,
hsts: false,
})
);

const allowed = (
process.env.CORS_ORIGIN ||
"http://localhost:8080," +
"http://127.0.0.1:8080," +
"http://127.0.0.1:5500," +
"http://localhost:5500," +
"http://10.77.2.70:5500," +
"http://10.77.2.70:8080," +
"http://10.77.2.70"
)
.split(",")
.map((s) => s.trim())
.filter(Boolean);

function isAllowedOrigin(origin) {
if (!origin) return true;
if (allowed.includes(origin)) return true;
try {
  const url = new URL(origin);
  const host = String(url.hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "10.77.2.70";
} catch {
  return false;
}
}

const corsConfig = {
origin(origin, cb) {
if (isAllowedOrigin(origin)) return cb(null, true);
return cb(new Error("Not allowed by CORS: " + origin));
},
credentials: true,
methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsConfig));
app.options("*", cors(corsConfig));

const DB_NAME = process.env.DB_NAME;
const common = {
host: process.env.DB_HOST,
port: process.env.DB_PORT || 3306,
database: DB_NAME,
waitForConnections: true,
};
const sslOpt = process.env.DB_SSL
? { ssl: { rejectUnauthorized: false, minVersion: "TLSv1.2" } }
: {};

const poolRead = mysql.createPool({
...common,
user: process.env.DB_USER_READ,
password: process.env.DB_PASS_READ,
connectionLimit: 10,
...sslOpt,
});
const poolOps = mysql.createPool({
...common,
user: process.env.DB_USER_OPS,
password: process.env.DB_PASS_OPS,
connectionLimit: 5,
...sslOpt,
});

const httpError = (res, code, msg) => res.status(code).json({ ok: false, error: msg });

const cookieSecure =
  (process.env.COOKIE_SECURE || "").toLowerCase() === "true" ||
  (process.env.NODE_ENV || "").toLowerCase() === "production";

function safeIdent(allowed, candidate, fallback) {
const up = String(candidate || "").toUpperCase();
return allowed.includes(up) ? up : fallback || allowed[0];
}
const qi = (s) => "`" + String(s || "").replace(/`/g, "") + "`";
const canon = (s) => String(s || "").toUpperCase().replace(/[_\s]/g, "");

const CATEGORY_MAXLEN = Math.max(parseInt(process.env.CATEGORY_MAXLEN || "20", 10) || 20, 1);
function clampCategoria(cat) {
let s = String(cat ?? "").trim().toUpperCase();
if (!s) throw new Error("categoria requerida");
if (s.length > CATEGORY_MAXLEN) s = s.slice(0, CATEGORY_MAXLEN);
return s;
}

function normalizeUser(u) {
return String(u || "")
.trim()
.toLowerCase()
.replace(/[\s\.-]+/g, "_");
}

// Roles: ADMIN (Nivel 3), ENCARGADO (Nivel 2), USUARIO (Nivel 1)
function isAdmin(req) {
  return req.user?.rol === 'ADMIN';
}

function isEncargado(req) {
  return req.user?.rol === 'ENCARGADO';
}

function canManageAlmacen(req) {
  // Tanto Admin como Encargado pueden gestionar inventario y agregar productos
  return isAdmin(req) || isEncargado(req);
}

function canManageSolicitudes(req) {
  // Admin y Encargado pueden gestionar/surtir vales de todos
  return isAdmin(req) || isEncargado(req);
}

function canViewReportes(req) {
  // Admin y Encargado tienen acceso a reportes de consumo
  return isAdmin(req) || isEncargado(req);
}

// Mantenemos estos alias por compatibilidad con funciones internas que ya existen más abajo en tu código
function isAdminDemo(req) {
  return isAdmin(req);
}
function hasAlmacenAccess(req) {
  return canManageAlmacen(req);
}

function ensureEntradaAllowed(req, delta, { isNew = false, viaAddStock = false } = {}) {
const d = Number(delta || 0);
if (isNew) {
if (isAdminDemo(req)) return;
if (hasAlmacenAccess(req)) return;
}
if (d > 0 && !isNew) {
if (isAdminDemo(req)) return;
if (hasAlmacenAccess(req) && viaAddStock) return;
const err = new Error("Entradas bloqueadas. Solo admin o usuarios de almacAn usando addStock.");
err.statusCode = 403;
throw err;
}
}

let PROD_PK_REAL = null;
let PROD_HAS_UNIDAD = true;
let PROD_HAS_CATEGORIA = true;
let PROD_STATUS_COL = null;
let PROD_CAT_NUMERIC = null;

async function detectProductosPK() {
if (PROD_PK_REAL) return PROD_PK_REAL;
const [rows] = await poolRead.query(
`SELECT COLUMN_NAME, EXTRA
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=? AND TABLE_NAME='productos'`,
[DB_NAME]
);
const names = new Set(rows.map((r) => r.COLUMN_NAME));
if (names.has("producto_id")) PROD_PK_REAL = "producto_id";
else if (names.has("ID")) PROD_PK_REAL = "ID";
else {
const [pk] = await poolRead.query(
`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=? AND TABLE_NAME='productos' AND EXTRA LIKE '%auto_increment%' LIMIT 1`,
[DB_NAME]
);
PROD_PK_REAL = pk[0]?.COLUMN_NAME || "producto_id";
}
PROD_HAS_UNIDAD = names.has("unidad") || names.has("UNIDAD");
PROD_HAS_CATEGORIA = names.has("categoria") || names.has("CATEGORIA");
return PROD_PK_REAL;
}
async function mapProdPKAliasSelect() {
const pk = await detectProductosPK();
return `${qi(pk)} AS producto_id`;
}
async function detectProductosStatusCol() {
if (PROD_STATUS_COL !== null) return PROD_STATUS_COL;
const [rows] = await poolRead.query(
`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=? AND TABLE_NAME='productos'`,
[DB_NAME]
);
const low = rows.map((r) => r.COLUMN_NAME.toLowerCase());
if (low.includes("status")) PROD_STATUS_COL = rows[low.indexOf("status")].COLUMN_NAME;
else if (low.includes("estado")) PROD_STATUS_COL = rows[low.indexOf("estado")].COLUMN_NAME;
else PROD_STATUS_COL = null;
return PROD_STATUS_COL;
}
async function productosCategoriaIsNumeric() {
if (PROD_CAT_NUMERIC !== null) return PROD_CAT_NUMERIC;
const [rows] = await poolRead.query(
`SELECT DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=? AND TABLE_NAME='productos' AND COLUMN_NAME IN ('categoria','CATEGORIA')
LIMIT 1`,
[DB_NAME]
);
const dt = (rows[0]?.DATA_TYPE || "").toLowerCase();
PROD_CAT_NUMERIC = ["int", "bigint", "mediumint", "smallint", "tinyint", "decimal", "double", "float"].includes(dt);
return PROD_CAT_NUMERIC;
}
async function prodIdFromClave(conn, clave) {
const pk = await detectProductosPK();
const [r] = await conn.query(`SELECT ${qi(pk)} AS id FROM productos WHERE CLAVE=? ORDER BY ${qi(pk)} ASC LIMIT 1`, [clave]);
return r[0]?.id || null;
}

let STATUS_ENUM_CACHE = null;
async function getStatusEnum() {
if (STATUS_ENUM_CACHE) return STATUS_ENUM_CACHE;
const [rows] = await poolRead.query(
`SELECT COLUMN_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = ?
AND TABLE_NAME = 'solicitudes'
AND COLUMN_NAME = 'status'
LIMIT 1`,
[DB_NAME]
);
if (!rows.length) {
STATUS_ENUM_CACHE = ["PENDIENTE", "APROBADA", "SURTIDA", "RECHAZADA", "CANCELADA"];
return STATUS_ENUM_CACHE;
}
const m = rows[0].COLUMN_TYPE.match(/enum\((.*)\)/i);
let vals = [];
if (m && m[1]) vals = m[1].split(",").map((s) => s.trim().replace(/^'/, "").replace(/'$/, ""));
STATUS_ENUM_CACHE = vals.length ? vals : ["PENDIENTE", "APROBADA", "SURTIDA", "RECHAZADA", "CANCELADA"];
return STATUS_ENUM_CACHE;
}
async function normalizeStatus(input) {
if (input == null) return null;
const enums = await getStatusEnum();
const raw = String(input).trim();
if (enums.includes(raw)) return raw;
const c = canon(raw);
for (const e of enums) {
if (canon(e) === c) return e;
}
throw new Error(`status invalido. Usa: ${enums.join(", ")}`);
}

let ALM_HAS_ESTADO = null;
async function hasAlmacenEstado() {
if (ALM_HAS_ESTADO !== null) return ALM_HAS_ESTADO;
const [r] = await poolRead.query(
`SELECT COUNT(*) AS n
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=? AND TABLE_NAME='almacen_dregcivil' AND COLUMN_NAME IN ('ESTADO','status','STATUS')`,
[DB_NAME]
);
ALM_HAS_ESTADO = (r[0]?.n || 0) > 0;
return ALM_HAS_ESTADO;
}
let ALM_STATUS_COL = null;
async function detectAlmacenStatusCol() {
if (ALM_STATUS_COL !== null) return ALM_STATUS_COL;
const [rows] = await poolRead.query(
`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=? AND TABLE_NAME='almacen_dregcivil'`,
[DB_NAME]
);
const low = rows.map((r) => r.COLUMN_NAME.toLowerCase());
if (low.includes("status")) ALM_STATUS_COL = rows[low.indexOf("status")].COLUMN_NAME;
else if (low.includes("estado")) ALM_STATUS_COL = rows[low.indexOf("estado")].COLUMN_NAME;
else ALM_STATUS_COL = null;
return ALM_STATUS_COL;
}
let ALM_CAT_NUMERIC = null;
async function almCategoriaIsNumeric() {
if (ALM_CAT_NUMERIC !== null) return ALM_CAT_NUMERIC;
const [rows] = await poolRead.query(
`SELECT DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=? AND TABLE_NAME='almacen_dregcivil' AND COLUMN_NAME='CATEGORIA' LIMIT 1`,
[DB_NAME]
);
const dt = (rows[0]?.DATA_TYPE || "").toLowerCase();
ALM_CAT_NUMERIC = ["int", "bigint", "mediumint", "smallint", "tinyint", "decimal", "double", "float"].includes(dt);
return ALM_CAT_NUMERIC;
}
let ALM_HAS_UNIDAD = null;
async function hasAlmacenUnidad() {
if (ALM_HAS_UNIDAD !== null) return ALM_HAS_UNIDAD;
try {
const [r] = await poolRead.query(
`SELECT COUNT(*) AS n
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=? AND TABLE_NAME='almacen_dregcivil' AND COLUMN_NAME='UNIDAD'`,
[DB_NAME]
);
ALM_HAS_UNIDAD = (r[0]?.n || 0) > 0;
} catch {
ALM_HAS_UNIDAD = false;
}
return ALM_HAS_UNIDAD;
}

let CAT_META = null;
async function detectCategorias() {
if (CAT_META) return CAT_META;
const envTable = process.env.CAT_TABLE;
const envIdCol = process.env.CAT_ID_COL;
const envNameCol = process.env.CAT_NAME_COL;
if (envTable && envIdCol && envNameCol) {
CAT_META = { table: envTable, id: envIdCol, name: envNameCol };
return CAT_META;
}
const candidates = [
{ table: "categorias", id: "id", name: "nombre" },
{ table: "categoria", id: "id", name: "nombre" },
{ table: "CATEGORIAS", id: "ID", name: "NOMBRE" },
{ table: "CATALOGO_CATEGORIAS", id: "ID", name: "NOMBRE" },
];
for (const c of candidates) {
const [t] = await poolRead.query(
`SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA=? AND TABLE_NAME=?`,
[DB_NAME, c.table]
);
if ((t[0]?.n || 0) > 0) {
const [cols] = await poolRead.query(
`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=? AND TABLE_NAME=?`,
[DB_NAME, c.table]
);
const names = new Set(cols.map((x) => x.COLUMN_NAME));
if (names.has(c.id) && names.has(c.name)) {
CAT_META = c;
return CAT_META;
}
const [meta] = await poolRead.query(
`SELECT COLUMN_NAME, DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=? AND TABLE_NAME=?
ORDER BY ORDINAL_POSITION`,
[DB_NAME, c.table]
);
if (meta.length >= 2) {
const idcol = meta[0].COLUMN_NAME;
const namecol =
meta.find((m) => ["varchar", "text", "char"].includes((m.DATA_TYPE || "").toLowerCase()))?.COLUMN_NAME ||
meta[1].COLUMN_NAME;
CAT_META = { table: c.table, id: idcol, name: namecol };
return CAT_META;
}
}
}
CAT_META = { table: null, id: null, name: null };
return CAT_META;
}
async function resolveCategoriaId(input) {
if (input === null || input === undefined || input === "") throw new Error("CATEGORIA requerida");
const n = Number(input);
if (Number.isFinite(n)) return n;
const nombre = String(input).trim();
const meta = await detectCategorias();
if (!meta.table || !meta.id || !meta.name) {
throw new Error("CatAlogo de categorAas no disponible");
}
const [r] = await poolRead.query(
`SELECT ${qi(meta.id)} AS id
FROM ${qi(meta.table)}
WHERE UPPER(${qi(meta.name)}) = UPPER(?)
LIMIT 1`,
[nombre]
);
if (!r.length) throw new Error(`CategorAa no encontrada: ${nombre}`);
return r[0].id;
}
async function resolveCategoriaIdOrCreate(raw) {
const catIsNum = await almCategoriaIsNumeric();
if (!catIsNum) return clampCategoria(raw);
try {
return await resolveCategoriaId(raw);
} catch (err) {
const meta = await detectCategorias();
if (!meta.table || !meta.id || !meta.name) throw err;
const nombre = String(raw || "").trim();
if (!nombre) throw err;
const [ins] = await poolOps.query(`INSERT INTO ${qi(meta.table)} (${qi(meta.name)}) VALUES (?)`, [nombre.toUpperCase()]);
return ins.insertId;
}
}

function authRequired(req, res, next) {
const token =
req.cookies?.token || (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null);
if (!token) return httpError(res, 401, "No autenticado");
try {
req.user = jwt.verify(token, process.env.JWT_SECRET);
next();
} catch {
return httpError(res, 401, "Token invalido");
}
}

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  // Obtener la IP del cliente (funciona en local, red LAN y tras proxy)
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || req.ip || '127.0.0.1';

  if (!username || !password) {
    return httpError(res, 400, "username y password requeridos");
  }

  try {
    const [rows] = await poolRead.query(
      `SELECT u.id, u.username, u.psw, u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO,
      u.ID_OFICIALIA, u.ACTIVO, COALESCE(u.rol, 'USUARIO') AS rol
      FROM usuario u
      WHERE u.username = ? LIMIT 1`,
      [username]
    );

    if (!rows.length) {
      if (poolOps) {
        await poolOps.query(
          "INSERT INTO log_accesos (username, ip_address, exito) VALUES (?, ?, FALSE)",
          [username, clientIp]
        ).catch(() => {});
      }
      return httpError(res, 401, "Usuario o contraseña inválidos");
    }

    const u = rows[0];

    if (u.ACTIVO === 0 || u.ACTIVO === false) {
      return httpError(res, 403, "Usuario inactivo");
    }

    const stored = u.psw || "";
    let ok = false;

    if (stored.startsWith("$2")) {
      ok = await bcrypt.compare(password, stored);
    } else {
      ok = stored === password;
      if (ok && HAS_OPS_CREDS && poolOps) {
        try {
          const hash = await bcrypt.hash(password, 10);
          await poolOps.query("UPDATE usuario SET psw=? WHERE id=?", [hash, u.id]);
        } catch (err) {
          console.warn("[WARN] No se pudo actualizar hash de contraseña:", err?.message || err);
        }
      }
    }

    if (!ok) {
      if (poolOps) {
        await poolOps.query(
          "INSERT INTO log_accesos (usuario_id, username, ip_address, exito) VALUES (?, ?, ?, FALSE)",
          [u.id, username, clientIp]
        ).catch(() => {});
      }
      return httpError(res, 401, "Usuario o contraseña inválidos");
    }

    // Registrar inicio de sesión exitoso en la bitácora
    if (poolOps) {
      await poolOps.query(
        "INSERT INTO log_accesos (usuario_id, username, ip_address, exito) VALUES (?, ?, ?, TRUE)",
        [u.id, username, clientIp]
      ).catch(() => {});
    }

    // Datos que viajan dentro del token JWT
    const payload = {
      id: u.id,
      username: u.username,
      nombre: u.nombre,
      primer_ap: u.PRIMER_APELLIDO,
      segundo_ap: u.SEGUNDO_APELLIDO,
      id_oficialia: u.ID_OFICIALIA,
      rol: u.rol || 'USUARIO'
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "8h" });
    res.cookie("token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure,
      maxAge: 8 * 60 * 60 * 1000
    });

    res.json({ ok: true, token, user: payload });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

app.get("/api/auth/me", authRequired, (req, res) => res.json({ ok: true, user: req.user }));
app.post("/api/auth/logout", (req, res) => {
res.clearCookie("token", { httpOnly: true, sameSite: "lax", secure: cookieSecure });
res.json({ ok: true });
});

app.get("/api/stock", authRequired, async (req, res) => {
try {
const { q = "", page = 1, limit = 500 } = req.query;
const off = (Math.max(parseInt(page) || 1, 1) - 1) * (parseInt(limit) || 500);
const like = `%${q}%`;
try {
const sql = `
SELECT producto_id, CLAVE, DESCRIPCION, categoria, unidad,
minimo, maximo, stock_producto, stock_almacen, exist_calc,
diff_prod_vs_calc, diff_alm_vs_calc, estado AS status
FROM v_stock
WHERE (? = '' OR CLAVE LIKE ? OR DESCRIPCION LIKE ? OR categoria LIKE ?)
ORDER BY CLAVE
LIMIT ? OFFSET ?`;
const [rows] = await poolRead.query(sql, [q, like, like, like, parseInt(limit) || 500, off]);
return res.json({ ok: true, data: rows });
} catch {
const pkSelect = await mapProdPKAliasSelect();
const prodStatusCol = await detectProductosStatusCol();
const statusSel = prodStatusCol ? `p.${qi(prodStatusCol)} AS status` : `NULL AS status`;
const statusWhere = prodStatusCol ? `, p.${qi(prodStatusCol)}` : "";
const [rows] = await poolRead.query(
`SELECT ${pkSelect}, p.CLAVE, p.DESCRIPCION,
${PROD_HAS_CATEGORIA ? "p.categoria" : "NULL AS categoria"},
${PROD_HAS_UNIDAD ? "p.unidad" : "NULL AS unidad"},
p.minimo, p.maximo,
0 AS stock_producto,
(SELECT COALESCE(SUM(a.STOCK),0) FROM almacen_dregcivil a WHERE a.CLAVE=p.CLAVE) AS stock_almacen,
(SELECT COALESCE(SUM(a.STOCK),0) FROM almacen_dregcivil a WHERE a.CLAVE=p.CLAVE) AS exist_calc,
0 AS diff_prod_vs_calc,
0 AS diff_alm_vs_calc,
${statusSel}
FROM productos p
WHERE (?='' OR CONCAT_WS(' ', p.CLAVE, p.DESCRIPCION, ${PROD_HAS_CATEGORIA ? "p.categoria" : '""'}, ${
PROD_HAS_UNIDAD ? "p.unidad" : '""'
}${statusWhere}) LIKE ?)
ORDER BY p.CLAVE
LIMIT ? OFFSET ?`,
[q, like, parseInt(limit) || 500, off]
);
return res.json({ ok: true, data: rows });
}
} catch (e) {
return httpError(res, 500, e.message);
}
});


app.get("/api/solicitudes", authRequired, async (req, res) => {
try {
const { q = "", status = "", page = 1, limit = 50, usuario_id = "", oficialia_id = "" } = req.query;
const lim = Math.max(parseInt(limit) || 50, 1);
const off = (Math.max(parseInt(page) || 1, 1) - 1) * lim;
const like = `%${q}%`;
const st = (status || "").trim();
const stCanon = canon(st);
const filterCancel = stCanon === "CANCELADA" || stCanon === "CANCELADO";
const canAllUsers = canManageSolicitudes(req);
const uidRaw = String(usuario_id || "").trim();
const uidFilter = canAllUsers
? (uidRaw ? Number(uidRaw) : null)
: Number(req.user?.id || 0) || null;
const useUidFilter = Number.isFinite(uidFilter) && uidFilter > 0;
const ofiRaw = String(oficialia_id || "").trim();
const ofiFilter = canAllUsers
? (ofiRaw ? Number(ofiRaw) : null)
: Number(req.user?.id_oficialia || 0) || null;
const useOfiFilter = Number.isFinite(ofiFilter) && ofiFilter > 0;

const sqlVista = `
SELECT id, fecha_solicitud, tipo_solicitud, status,
usuario_id, id_oficialia, id_localidad,
username, nombre_usuario, observaciones
FROM v_solicitudes_resumen
WHERE (? = '' OR CONCAT_WS(' ',
id, tipo_solicitud, status, observaciones,
username, nombre_usuario, id_oficialia, id_localidad
) LIKE ?)
AND (? = 0 OR status IN (?, ?))
AND (? = 0 OR usuario_id = ?)
AND (? = 0 OR id_oficialia = ?)
ORDER BY id DESC
LIMIT ? OFFSET ?`;
try {
const [rows] = await poolRead.query(sqlVista, [
q, like,
st ? 1 : 0, filterCancel ? "CANCELADA" : st, filterCancel ? "CANCELADO" : st,
useUidFilter ? 1 : 0, uidFilter || 0,
useOfiFilter ? 1 : 0, ofiFilter || 0,
lim, off
]);

const userIds = rows.map(r => r.usuario_id ?? r.USUARIO_ID ?? null).filter(Boolean);
const userMap = await buildUserMap(userIds).catch(()=>({}));

const ofiIds = rows.map(r => r.id_oficialia ?? r.ID_OFICIALIA ?? null).filter(Boolean);
const ofiMap = await buildOficialiaMap(ofiIds).catch(()=>({}));

const filled = rows.map(r => {
const uid = Number(r.usuario_id ?? r.USUARIO_ID ?? null);
const u = userMap[uid];
const ofiId = r.id_oficialia ?? r.ID_OFICIALIA ?? null;
return {
...r,
username: r.username ?? u?.username ?? null,
nombre_usuario: r.nombre_usuario ?? u?.fullname ?? r.username ?? null,
oficialia_nombre: ofiMap[ofiId] ?? null,
};
});

return res.json({ ok: true, data: filled });
} catch {

const sqlFallback = `
SELECT s.id, s.fecha_solicitud, s.tipo_solicitud, s.status,
s.usuario_id, s.id_oficialia, s.id_localidad,
u.username,
CONCAT_WS(' ', u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO) AS nombre_usuario,
s.observaciones
FROM solicitudes s
LEFT JOIN usuario u ON u.id = s.usuario_id
WHERE (? = '' OR CONCAT_WS(' ',
s.id, s.tipo_solicitud, s.status, s.observaciones,
u.username, u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO,
s.id_oficialia, s.id_localidad
) LIKE ?)
AND (? = 0 OR s.status IN (?, ?))
AND (? = 0 OR s.usuario_id = ?)
AND (? = 0 OR s.id_oficialia = ?)
ORDER BY s.id DESC
LIMIT ? OFFSET ?`;
const [rows2] = await poolRead.query(sqlFallback, [
q, like,
st ? 1 : 0, filterCancel ? "CANCELADA" : st, filterCancel ? "CANCELADO" : st,
useUidFilter ? 1 : 0, uidFilter || 0,
useOfiFilter ? 1 : 0, ofiFilter || 0,
lim, off
]);

const userIds2 = rows2.map(r => r.usuario_id ?? r.USUARIO_ID ?? null).filter(Boolean);
const userMap2 = await buildUserMap(userIds2).catch(()=>({}));

const ofiIds2 = rows2.map(r => r.id_oficialia ?? r.ID_OFICIALIA ?? null).filter(Boolean);
const ofiMap2 = await buildOficialiaMap(ofiIds2).catch(()=>({}));

const filled2 = rows2.map(r => {
const uid = Number(r.usuario_id ?? r.USUARIO_ID ?? null);
const u = userMap2[uid];
const ofiId = r.id_oficialia ?? r.ID_OFICIALIA ?? null;
return {
...r,
username: r.username ?? u?.username ?? null,
nombre_usuario: r.nombre_usuario ?? u?.fullname ?? r.username ?? null,
oficialia_nombre: ofiMap2[ofiId] ?? null,
};
});
return res.json({ ok: true, data: filled2 });
}
} catch (e) {
return httpError(res, 500, e.message);
}
});

app.get("/api/logs/accesos", authRequired, async (req, res) => {
  if (req.user?.rol !== 'ADMIN') {
    return httpError(res, 403, "Acceso denegado: solo el Administrador puede consultar los accesos");
  }

  try {
    const limit = Math.max(parseInt(req.query.limit) || 100, 1);
    const [rows] = await poolRead.query(
      `SELECT id, usuario_id, username, ip_address, fecha_acceso, exito
       FROM log_accesos
       ORDER BY fecha_acceso DESC
       LIMIT ?`,
      [limit]
    );
    return res.json({ ok: true, data: rows });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

app.get("/api/oficialias", authRequired, async (req, res) => {
try {
const canAllUsers = canManageSolicitudes(req);
const nameCol = await detectOficialiaNameCol();
if (!nameCol) return res.json({ ok: true, data: [] });
if (canAllUsers) {
const [rows] = await poolRead.query(
`SELECT id, ${qi(nameCol)} AS nombre
FROM oficialias
ORDER BY ${qi(nameCol)} ASC
LIMIT 500`
);
return res.json({ ok: true, data: rows });
}
const ownOfi = Number(req.user?.id_oficialia || 0);
if (!Number.isFinite(ownOfi) || ownOfi <= 0) return res.json({ ok: true, data: [] });
const [rows] = await poolRead.query(
`SELECT id, ${qi(nameCol)} AS nombre
FROM oficialias
WHERE id = ?
LIMIT 1`,
[ownOfi]
);
return res.json({ ok: true, data: rows });
} catch (e) {
return httpError(res, 500, e.message);
}
});

app.get("/api/reportes/oficialias", authRequired, async (req, res) => {
try {
if (!canViewReportes(req)) return httpError(res, 403, "No tienes permiso para ver reportes");

const rawOficialiaId = String(req.query.oficialia_id || "").trim();
const selectedOficialiaId = rawOficialiaId && Number.isFinite(Number(rawOficialiaId)) && Number(rawOficialiaId) > 0 ? Number(rawOficialiaId) : null;
const fecha = String(req.query.fecha || "").trim();
const fechaInicio = String(req.query.fecha_inicio || "").trim();
const fechaFin = String(req.query.fecha_fin || "").trim();
const hasFecha = /^\d{4}-\d{2}-\d{2}$/.test(fecha);
const hasFechaInicio = /^\d{4}-\d{2}-\d{2}$/.test(fechaInicio);
const hasFechaFin = /^\d{4}-\d{2}-\d{2}$/.test(fechaFin);
const addDateFilters = (parts, params) => {
if (hasFecha) {
parts.push("DATE(s.fecha_solicitud) = ?");
params.push(fecha);
return;
}
if (hasFechaInicio) {
parts.push("DATE(s.fecha_solicitud) >= ?");
params.push(fechaInicio);
}
if (hasFechaFin) {
parts.push("DATE(s.fecha_solicitud) <= ?");
params.push(fechaFin);
}
};
const prodPk = await detectProductosPK();
const reportWhereParts = ["COALESCE(s.status, '') NOT IN ('CANCELADA', 'CANCELADO')"];
const reportParams = [];
addDateFilters(reportWhereParts, reportParams);
const reportWhere = `WHERE ${reportWhereParts.join(" AND ")}`;

const [rows] = await poolRead.query(
`SELECT
  s.id_oficialia AS oficialia_id,
  COUNT(DISTINCT s.id) AS solicitudes_count,
  COALESCE(SUM(d.cantidad), 0) AS cantidad_solicitada,
  COALESCE(SUM(d.atendida), 0) AS cantidad_atendida
FROM solicitudes s
LEFT JOIN detalles_solicitud d ON d.solicitud_id = s.id
${reportWhere}
GROUP BY s.id_oficialia
ORDER BY solicitudes_count DESC, cantidad_solicitada DESC, s.id_oficialia ASC`,
reportParams
);

const oficialiaMap = await buildOficialiaMap(rows.map((r) => r.oficialia_id));
const oficialias = rows.map((r) => ({
oficialia_id: Number(r.oficialia_id || 0),
oficialia_nombre: oficialiaMap[Number(r.oficialia_id || 0)] || `Oficialia ${r.oficialia_id}`,
solicitudes_count: Number(r.solicitudes_count || 0),
cantidad_solicitada: Number(r.cantidad_solicitada || 0),
cantidad_atendida: Number(r.cantidad_atendida || 0),
}));

const summaryTarget = selectedOficialiaId
? oficialias.find((r) => r.oficialia_id === selectedOficialiaId) || null
: oficialias.reduce((acc, r) => {
    acc.solicitudes_count += Number(r.solicitudes_count || 0);
    acc.cantidad_solicitada += Number(r.cantidad_solicitada || 0);
    acc.cantidad_atendida += Number(r.cantidad_atendida || 0);
    return acc;
  }, {
    oficialia_id: null,
    oficialia_nombre: "Todas",
    solicitudes_count: 0,
    cantidad_solicitada: 0,
    cantidad_atendida: 0,
  });

const productWhereParts = ["COALESCE(s.status, '') NOT IN ('CANCELADA', 'CANCELADO')"];
const productParams = [];
if (selectedOficialiaId) {
productWhereParts.push("s.id_oficialia = ?");
productParams.push(selectedOficialiaId);
}
addDateFilters(productWhereParts, productParams);
const productWhere = productWhereParts.length ? `WHERE ${productWhereParts.join(" AND ")}` : "";
const [productRows] = await poolRead.query(
`SELECT
  p.CLAVE,
  p.DESCRIPCION,
  COUNT(DISTINCT s.id) AS solicitudes_count,
  COALESCE(SUM(d.cantidad), 0) AS cantidad_solicitada,
  COALESCE(SUM(d.atendida), 0) AS cantidad_atendida
FROM solicitudes s
JOIN detalles_solicitud d ON d.solicitud_id = s.id
LEFT JOIN productos p ON p.${qi(prodPk)} = d.producto_id
${productWhere}
GROUP BY d.producto_id, p.CLAVE, p.DESCRIPCION
ORDER BY cantidad_solicitada DESC, cantidad_atendida DESC, p.CLAVE ASC`,
productParams
);

const productos = productRows.map((r) => ({
clave: r.CLAVE || null,
descripcion: r.DESCRIPCION || null,
solicitudes_count: Number(r.solicitudes_count || 0),
cantidad_solicitada: Number(r.cantidad_solicitada || 0),
cantidad_atendida: Number(r.cantidad_atendida || 0),
}));

const [solicitudRows] = await poolRead.query(
`SELECT
  s.usuario_id,
  s.id_oficialia,
  CONCAT_WS(' ', u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO) AS nombre_usuario,
  COUNT(DISTINCT s.id) AS solicitudes_count,
  MAX(s.fecha_solicitud) AS ultima_fecha,
  COALESCE(SUM(d.cantidad), 0) AS cantidad_solicitada,
  COALESCE(SUM(d.atendida), 0) AS cantidad_atendida
FROM solicitudes s
LEFT JOIN usuario u ON u.id = s.usuario_id
LEFT JOIN detalles_solicitud d ON d.solicitud_id = s.id
${productWhere}
GROUP BY s.usuario_id, s.id_oficialia, u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO
ORDER BY cantidad_solicitada DESC, solicitudes_count DESC, nombre_usuario ASC
LIMIT 300`,
productParams
);

const solicitudes = solicitudRows.map((r) => ({
usuario_id: Number(r.usuario_id || 0) || null,
id_oficialia: Number(r.id_oficialia || 0) || null,
oficialia_nombre: oficialiaMap[Number(r.id_oficialia || 0)] || null,
nombre_usuario: r.nombre_usuario || null,
solicitudes_count: Number(r.solicitudes_count || 0),
ultima_fecha: r.ultima_fecha || null,
cantidad_solicitada: Number(r.cantidad_solicitada || 0),
cantidad_atendida: Number(r.cantidad_atendida || 0),
}));

const [inconsistenciaRows] = await poolRead.query(
`SELECT
  s.usuario_id,
  s.id_oficialia,
  u.ID_OFICIALIA AS usuario_oficialia_id,
  CONCAT_WS(' ', u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO) AS nombre_usuario,
  COUNT(DISTINCT s.id) AS solicitudes_count,
  MAX(s.fecha_solicitud) AS ultima_fecha,
  COALESCE(SUM(d.cantidad), 0) AS cantidad_solicitada,
  COALESCE(SUM(d.atendida), 0) AS cantidad_atendida
FROM solicitudes s
LEFT JOIN usuario u ON u.id = s.usuario_id
LEFT JOIN detalles_solicitud d ON d.solicitud_id = s.id
${productWhere ? `${productWhere} AND s.id_oficialia <> u.ID_OFICIALIA` : "WHERE s.id_oficialia <> u.ID_OFICIALIA"}
GROUP BY s.usuario_id, s.id_oficialia, u.ID_OFICIALIA, u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO
ORDER BY ultima_fecha DESC, nombre_usuario ASC
LIMIT 200`,
productParams
);

const inconsistenciaMap = await buildOficialiaMap(
[
  ...inconsistenciaRows.map((r) => r.id_oficialia),
  ...inconsistenciaRows.map((r) => r.usuario_oficialia_id),
].filter(Boolean)
);

const inconsistencias = inconsistenciaRows.map((r) => ({
usuario_id: Number(r.usuario_id || 0) || null,
nombre_usuario: r.nombre_usuario || null,
solicitudes_count: Number(r.solicitudes_count || 0),
ultima_fecha: r.ultima_fecha || null,
cantidad_solicitada: Number(r.cantidad_solicitada || 0),
cantidad_atendida: Number(r.cantidad_atendida || 0),
oficialia_solicitud_id: Number(r.id_oficialia || 0) || null,
oficialia_solicitud_nombre: inconsistenciaMap[Number(r.id_oficialia || 0)] || null,
oficialia_usuario_id: Number(r.usuario_oficialia_id || 0) || null,
oficialia_usuario_nombre: inconsistenciaMap[Number(r.usuario_oficialia_id || 0)] || null,
}));

const byMost = oficialias.slice().sort((a, b) =>
  Number(b.solicitudes_count || 0) - Number(a.solicitudes_count || 0) ||
  Number(b.cantidad_solicitada || 0) - Number(a.cantidad_solicitada || 0) ||
  String(a.oficialia_nombre || "").localeCompare(String(b.oficialia_nombre || ""))
);

const topProducto = productos[0] || null;
const scopeLabel = selectedOficialiaId && summaryTarget
? (summaryTarget.oficialia_nombre || `Oficialia ${selectedOficialiaId}`)
: "Todas";

return res.json({
ok: true,
data: {
selected_oficialia_id: selectedOficialiaId,
summary: {
...(summaryTarget || {
  oficialia_id: selectedOficialiaId,
  oficialia_nombre: selectedOficialiaId ? `Oficialia ${selectedOficialiaId}` : "Todas",
  solicitudes_count: 0,
  cantidad_solicitada: 0,
  cantidad_atendida: 0,
}),
scope_label: scopeLabel,
top_producto_nombre: topProducto ? [topProducto.clave, topProducto.descripcion].filter(Boolean).join(" - ") : null,
},
rankings: {
mas_pide: byMost[0] || null,
},
oficialias,
productos,
solicitudes,
inconsistencias,
},
});
} catch (e) {
return httpError(res, 500, e.message);
}
});


let OFI_NAME_COL = null;
async function detectOficialiaNameCol() {
if (OFI_NAME_COL !== null) return OFI_NAME_COL;
const [cols] = await poolRead.query(
`SELECT COLUMN_NAME, DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=? AND TABLE_NAME='oficialias'`,
[DB_NAME]
);
if (!cols.length) {
OFI_NAME_COL = null;
return OFI_NAME_COL;
}
const byUpper = new Map(cols.map((c) => [c.COLUMN_NAME.toUpperCase(), c]));
if (byUpper.has("NOMBRE")) {
OFI_NAME_COL = byUpper.get("NOMBRE").COLUMN_NAME;
return OFI_NAME_COL;
}
const textish = cols.find((c) => ["varchar", "text", "char"].includes((c.DATA_TYPE || "").toLowerCase()));
OFI_NAME_COL = textish ? textish.COLUMN_NAME : null;
return OFI_NAME_COL;
}
let USER_DEPTO_COL = null;
async function detectUsuarioDepartamentoCol() {
if (USER_DEPTO_COL !== null) return USER_DEPTO_COL;
const [cols] = await poolRead.query(
`SELECT COLUMN_NAME, DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=? AND TABLE_NAME='usuario'`,
[DB_NAME]
);
if (!cols.length) {
USER_DEPTO_COL = null;
return USER_DEPTO_COL;
}
const byUpper = new Map(cols.map((c) => [c.COLUMN_NAME.toUpperCase(), c]));
if (byUpper.has("DEPARTAMENTO")) {
USER_DEPTO_COL = byUpper.get("DEPARTAMENTO").COLUMN_NAME;
return USER_DEPTO_COL;
}
const textish = cols.find((c) => ["varchar", "text", "char"].includes(String(c.DATA_TYPE || "").toLowerCase()) && String(c.COLUMN_NAME || "").toUpperCase().includes("DEP"));
USER_DEPTO_COL = textish ? textish.COLUMN_NAME : null;
return USER_DEPTO_COL;
}
async function getOficialiaNombre(id) {
const n = Number(id);
if (!Number.isFinite(n)) return null;
const nameCol = await detectOficialiaNameCol();
if (!nameCol) return null;
const [r] = await poolRead.query(`SELECT ${qi(nameCol)} AS nombre FROM oficialias WHERE id=? LIMIT 1`, [n]);
return r[0]?.nombre || null;
}
function pickUsuarioServer(d) {
  const nombre = [d.nombre, d.PRIMER_APELLIDO, d.SEGUNDO_APELLIDO].filter(Boolean).join(' ').trim();
  return nombre || d.nombre_usuario || d.username || '-';
}

async function buildCategoriaMap(ids) {
const meta = await detectCategorias();
if (!meta.table || !meta.id || !meta.name) return {};
const uniq = [...new Set(ids.filter((n) => Number.isFinite(n)))];
if (!uniq.length) return {};
const [rows] = await poolRead.query(
`SELECT ${qi(meta.id)} AS id, ${qi(meta.name)} AS nombre
FROM ${qi(meta.table)}
WHERE ${qi(meta.id)} IN (${uniq.map(() => "?").join(",")})`,
uniq
);
const map = {};
for (const r of rows) map[Number(r.id)] = r.nombre;
return map;
}
async function attachCategoriaNombre(rows) {
const numericIds = [];
for (const r of rows) {
const v = r.categoria ?? r.CATEGORIA ?? null;
const n = Number(v);
if (Number.isFinite(n)) numericIds.push(n);
}
const cmap = await buildCategoriaMap(numericIds);
return rows.map((r) => {
const v = r.categoria ?? r.CATEGORIA ?? null;
let nombre = "";
let catId = null;
if (v == null || v === "") {
nombre = "";
catId = null;
} else if (Number.isFinite(Number(v))) {
catId = Number(v);
nombre = cmap[catId] || "";
} else {
nombre = String(v);
catId = null;
}
return {
...r,
unidad: r.unidad ?? r.UNIDAD ?? null,

categoria: nombre,

categoria_id: catId,
CATEGORIA_ID: catId,
categoria_nombre: nombre,
CATEGORIA_NOMBRE: nombre,
};
});
}

async function buildUserMap(ids){
const uniq = [...new Set((ids||[]).map(v => Number(v)).filter(n => Number.isFinite(n)))];
if (!uniq.length) return {};
const [rows] = await poolRead.query(
`SELECT id, username, CONCAT_WS(' ', nombre, PRIMER_APELLIDO, SEGUNDO_APELLIDO) AS fullname
FROM usuario WHERE id IN (${uniq.map(()=>'?').join(',')})`, uniq);
const map = {};
for (const r of rows) map[Number(r.id)] = { username: r.username, fullname: r.fullname };
return map;
}

async function buildOficialiaMap(ids) {
const uniq = [...new Set((ids || []).map((v) => Number(v)).filter((n) => Number.isFinite(n)))];
if (!uniq.length) return {};
const nameCol = await detectOficialiaNameCol();
if (!nameCol) return {};
const [rows] = await poolRead.query(
`SELECT id, ${qi(nameCol)} AS nombre FROM oficialias WHERE id IN (${uniq.map(() => "?").join(",")})`,
uniq
);
const map = {};
for (const r of rows) map[Number(r.id)] = r.nombre;
return map;
}


app.get("/api/solicitudes/:id", authRequired, async (req, res) => {
try {
const id = Number(req.params.id);
if (!Number.isFinite(id)) return httpError(res, 400, "ID invalido");

let row = null;
let requireFallback = true;
try {
  const [rows] = await poolRead.query("SELECT * FROM v_solicitudes_resumen WHERE id = ? LIMIT 1", [id]);
  if (rows.length) {
    row = rows[0];
    const fullName = [row.nombre, row.PRIMER_APELLIDO, row.SEGUNDO_APELLIDO].filter(Boolean).join(" ").trim();
    row.nombre_completo = row.nombre_completo || row.NOMBRE_COMPLETO || fullName || null;
    row.nombre_usuario = row.nombre_usuario || row.NOMBRE_USUARIO || row.username || row.USERNAME || null;
    row.solicitante =
      row.solicitante ||
      row.SOLICITANTE ||
      row.nombre_solicitante ||
      row.NOMBRE_SOLICITANTE ||
      row.nombre_usuario ||
      row.nombre_completo ||
      fullName ||
      null;
    if (!row.username || !row.nombre_usuario) {
      const [u] = await poolRead.query(
        `SELECT u.username, u.ID_OFICIALIA AS id_oficialia,
        u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO,
        CONCAT_WS(' ', u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO) AS nombre_usuario
        FROM usuario u WHERE u.id = ? LIMIT 1`,
        [row.usuario_id ?? row.USUARIO_ID ?? null]
      );
      if (u.length) {
        row.username = row.username ?? u[0].username ?? null;
        row.nombre_usuario = row.nombre_usuario ?? u[0].nombre_usuario ?? null;
        row.id_oficialia = row.id_oficialia ?? row.ID_OFICIALIA ?? u[0].id_oficialia ?? null;
        row.nombre = row.nombre ?? u[0].nombre ?? null;
        row.PRIMER_APELLIDO = row.PRIMER_APELLIDO ?? u[0].PRIMER_APELLIDO ?? null;
        row.SEGUNDO_APELLIDO = row.SEGUNDO_APELLIDO ?? u[0].SEGUNDO_APELLIDO ?? null;
      }
    }
    if (row.username && row.nombre_usuario) {
      requireFallback = false;
    }
    const ofiId = row.id_oficialia ?? row.ID_OFICIALIA ?? null;
    const ofiNombre = await getOficialiaNombre(ofiId);
    row.oficialia_nombre = row.oficialia_nombre ?? ofiNombre ?? null;
    row.usuario = {
      id: row.usuario_id ?? row.USUARIO_ID ?? null,
      username: row.username ?? null,
      nombre_completo: row.nombre_usuario ?? pickUsuarioServer(row),
      id_oficialia: ofiId,
      oficialia_nombre: ofiNombre ?? null,
    };
  }
} catch {
  requireFallback = true;
}

if (!row || requireFallback) {
const nameCol = await detectOficialiaNameCol();
const [r2] = await poolRead.query(
`SELECT s.*,
u.username,
u.ID_OFICIALIA AS id_oficialia,
u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO,
${nameCol ? `(SELECT ${qi(nameCol)} FROM oficialias WHERE id = u.ID_OFICIALIA LIMIT 1)` : `NULL`} AS oficialia_nombre,
CONCAT_WS(' ', u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO) AS nombre_usuario
FROM solicitudes s
LEFT JOIN usuario u ON u.id = s.usuario_id
WHERE s.id = ? LIMIT 1`,
[id]
);
if (!r2.length) return httpError(res, 404, "Solicitud no encontrada");
const base = r2[0];
base.oficialia_nombre = base.oficialia_nombre ?? (await getOficialiaNombre(base.id_oficialia ?? base.ID_OFICIALIA ?? null));
base.usuario = {
id: base.usuario_id ?? base.USUARIO_ID ?? null,
username: base.username ?? null,
nombre_completo: base.nombre_usuario ?? pickUsuarioServer(base),
id_oficialia: base.id_oficialia ?? base.ID_OFICIALIA ?? null,
oficialia_nombre: base.oficialia_nombre ?? null,
};
return res.json({ ok: true, data: base });
}

return res.json({ ok: true, data: row });
} catch (e) {
return httpError(res, 500, e.message);
}
});


app.get("/api/solicitudes/:id/detalle", authRequired, async (req, res) => {
try {
const sid = Number(req.params.id);
if (!Number.isFinite(sid)) return httpError(res, 400, "ID invalido");

let rows = [];
let useFallback = false;

try {
const [vrows] = await poolRead.query(
"SELECT * FROM v_solicitudes_detalle WHERE solicitud_id = ? ORDER BY detalle_id",
[sid]
);
if (vrows.length) {
const hasCat = "categoria" in vrows[0] || "CATEGORIA" in vrows[0];
const hasUni = "unidad" in vrows[0] || "UNIDAD" in vrows[0];
if (!hasCat || !hasUni) {
useFallback = true;
} else {
rows = vrows.map((r) => ({
...r,
categoria: r.categoria ?? r.CATEGORIA ?? null,
unidad: r.unidad ?? r.UNIDAD ?? null,
}));
}
} else {
useFallback = true;
}
} catch {
useFallback = true;
}

if (useFallback) {
const [fallback] = await poolRead.query(
`SELECT d.id AS detalle_id,
d.solicitud_id,
d.producto_id,
p.CLAVE,
p.DESCRIPCION,
p.unidad AS unidad,
p.categoria AS categoria,
d.cantidad,
d.atendida,
d.observaciones
FROM detalles_solicitud d
LEFT JOIN productos p ON p.${await detectProductosPK()} = d.producto_id
WHERE d.solicitud_id = ?
ORDER BY d.id`,
[sid]
);
rows = fallback;
}

const enriched = await attachCategoriaNombre(rows);
return res.json({ ok: true, data: enriched });
} catch (e) {
return httpError(res, 500, e.message);
}
});

app.post("/api/solicitudes", authRequired, async (req, res) => {
try {
const { usuario_id, tipo_solicitud = "CONSUMIBLES", observaciones = null } = req.body || {};
const uid = usuario_id || req.user.id;
const [u] = await poolRead.query(
`SELECT u.id, u.username, u.ID_OFICIALIA AS ofi, o.id_localidad AS loc
FROM usuario u JOIN oficialias o ON o.id=u.ID_OFICIALIA
WHERE u.id=? LIMIT 1`,
[uid]
);
if (!u.length) return httpError(res, 400, "Usuario no vAlido o sin oficialAa/localidad");
const { ofi, loc } = u[0];
const [rs] = await poolOps.query(
`INSERT INTO solicitudes(tipo_solicitud, fecha_solicitud, id_oficialia, id_localidad, usuario_id, status, observaciones)
VALUES (?, NOW(), ?, ?, ?, 'PENDIENTE', ?)`,
[tipo_solicitud, ofi, loc, uid, observaciones]
);
res.json({ ok: true, solicitud_id: rs.insertId });
} catch (e) {
return httpError(res, 400, e.message);
}
});

app.post("/api/solicitudes/:id/detalles", authRequired, async (req, res) => {
try {
const solicitudId = Number(req.params.id);
const { producto_id, cantidad, observaciones = null } = req.body || {};
if (!Number.isFinite(solicitudId)) return httpError(res, 400, "ID de solicitud invalido");
if (!producto_id || !(Number(cantidad) > 0))
return httpError(res, 400, "producto_id y cantidad (>0) son requeridos");

const conn = await poolOps.getConnection();
try {
await conn.beginTransaction();

const clave = await claveFromProductoId(conn, Number(producto_id));
if (!clave) {
await conn.rollback();
return httpError(res, 400, "Producto no encontrado por producto_id");
}

const [rs] = await conn.query(
`INSERT INTO detalles_solicitud (solicitud_id, producto_id, cantidad, atendida, observaciones)
VALUES (?,?,?,?,?)`,
[solicitudId, Number(producto_id), Number(cantidad), 0, observaciones]
);

await conn.commit();
res.json({ ok: true, detalle_id: rs.insertId, solicitud_id: solicitudId });
} catch (e) {
await conn.rollback();
if (e.statusCode) return httpError(res, e.statusCode, e.message);
return httpError(res, 400, e.message);
} finally {
conn.release();
}
} catch (e) {
return httpError(res, 400, e.message);
}
});

app.post("/api/solicitudes/:id/detalles/by-clave", authRequired, async (req, res) => {
try {
const solicitudId = Number(req.params.id);
const { clave, cantidad, observaciones = null } = req.body || {};
if (!Number.isFinite(solicitudId)) return httpError(res, 400, "ID de solicitud invalido");
if (!clave || !(Number(cantidad) > 0)) return httpError(res, 400, "clave y cantidad (>0) requeridos");

const conn = await poolOps.getConnection();
try {
await conn.beginTransaction();

const pk = await detectProductosPK();
const claveClean = String(clave).trim();
const almStatusCol = await detectAlmacenStatusCol();
const almHasUnidad = await hasAlmacenUnidad();
const unidadSel = almHasUnidad ? "UNIDAD" : "NULL AS UNIDAD";
const statusSel = almStatusCol ? `${qi(almStatusCol)} AS ESTADO` : "NULL AS ESTADO";
const [rAlm] = await conn.query(
  `SELECT CLAVE, DESCRIPCION, CATEGORIA, ${unidadSel}, ${statusSel}
   FROM almacen_dregcivil
   WHERE CLAVE=?
   ORDER BY ID ASC
   LIMIT 1`,
  [claveClean]
);

let prodId = null;
if (rAlm.length) {
  prodId = await upsertProductoFromAlmacen(conn, {
    CLAVE: rAlm[0].CLAVE,
    DESCRIPCION: rAlm[0].DESCRIPCION,
    CATEGORIA: rAlm[0].CATEGORIA,
    UNIDAD: rAlm[0].UNIDAD,
    ESTADO: rAlm[0].ESTADO || "ACTIVO",
  });
} else {
  const [rProd] = await conn.query(
    `SELECT ${qi(pk)} AS producto_id FROM productos WHERE CLAVE=? ORDER BY ${qi(pk)} ASC LIMIT 1`,
    [claveClean]
  );
  prodId = rProd[0]?.producto_id || null;
}

if (!prodId) {
  await conn.rollback();
  return httpError(res, 400, "Producto no encontrado por CLAVE");
}

const [ins] = await conn.query(
`INSERT INTO detalles_solicitud (solicitud_id, producto_id, cantidad, atendida, observaciones)
VALUES (?,?,?,?,?)`,
[solicitudId, prodId, Number(cantidad), 0, observaciones]
);

await conn.commit();
res.json({ ok: true, detalle_id: ins.insertId, solicitud_id: solicitudId });
} catch (e) {
await conn.rollback();
if (e.statusCode) return httpError(res, e.statusCode, e.message);
return httpError(res, 400, e.message);
} finally {
conn.release();
}
} catch (e) {
if (e.statusCode) return httpError(res, e.statusCode, e.message);
return httpError(res, 400, e.message);
}
});

app.patch("/api/solicitudes/:id/detalles/:detalleId", authRequired, async (req, res) => {
try {
const solicitudId = Number(req.params.id);
const detalleId = Number(req.params.detalleId);
if (!Number.isFinite(solicitudId) || !Number.isFinite(detalleId)) {
return httpError(res, 400, "IDs invalidos");
}
const data = {};
if ("atendida" in req.body) {
const n = Number(req.body.atendida);
if (!Number.isFinite(n) || n < 0) return httpError(res, 400, "atendida invAlida");
data.atendida = n;
}
if ("observaciones" in req.body) data.observaciones = req.body.observaciones ?? null;
if (Object.keys(data).length === 0) return httpError(res, 400, "Nada que actualizar");
await updateDetalleSolicitudStockAware({
detalleId,
solicitudId,
data,
username: req.user?.username || "web",
});
res.json({ ok: true, updated: true, detalle_id: detalleId, solicitud_id: solicitudId });
} catch (e) {
if (e.statusCode) return httpError(res, e.statusCode, e.message);
return httpError(res, 400, e.message);
}
});

app.patch("/api/detalles/:id", authRequired, async (req, res) => {
try {
const detalleId = Number(req.params.id);
if (!Number.isFinite(detalleId)) return httpError(res, 400, "ID invalido");
const data = {};
if ("atendida" in req.body) {
const n = Number(req.body.atendida);
if (!Number.isFinite(n) || n < 0) return httpError(res, 400, "atendida invAlida");
data.atendida = n;
}
if ("observaciones" in req.body) data.observaciones = req.body.observaciones ?? null;
if (Object.keys(data).length === 0) return httpError(res, 400, "Nada que actualizar");
await updateDetalleSolicitudStockAware({
detalleId,
data,
username: req.user?.username || "web",
});
res.json({ ok: true, updated: true, detalle_id: detalleId });
} catch (e) {
return httpError(res, 400, e.message);
}
});

app.patch("/api/solicitudes/:id/status", authRequired, async (req, res) => {
try {
if (!canManageSolicitudes(req)) {
return httpError(res, 403, "No tienes permiso para cambiar el status de la solicitud");
}

const id = Number(req.params.id);
if (!Number.isFinite(id)) return httpError(res, 400, "ID invalido");

const { status, observaciones = null } = req.body || {};
if (!status) return httpError(res, 400, "status requerido");

const result = await updateSolicitudStatusStockAware({
solicitudId: id,
status,
observaciones,
username: req.user?.username || "web",
});

res.json({ ok: true, updated: true, id, status: result.status, restored_qty: result.restoredQty || 0 });
} catch (e) {
if (e.statusCode) return httpError(res, e.statusCode, e.message);
return httpError(res, 400, e.message);
}
});


let MOV_TIPO_COL = null;
async function detectMovTipoCol() {
if (MOV_TIPO_COL !== null) return MOV_TIPO_COL;
const [rows] = await poolRead.query(
`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=? AND TABLE_NAME='movimientos_inventario'`,
[DB_NAME]
);
const low = rows.map((r) => r.COLUMN_NAME.toLowerCase());
if (low.includes("tipo_movimiento")) MOV_TIPO_COL = rows[low.indexOf("tipo_movimiento")].COLUMN_NAME;
else if (low.includes("tipo")) MOV_TIPO_COL = rows[low.indexOf("tipo")].COLUMN_NAME;
else if (low.includes("movimiento")) MOV_TIPO_COL = rows[low.indexOf("movimiento")].COLUMN_NAME;
else MOV_TIPO_COL = "TIPO_MOVIMIENTO";
return MOV_TIPO_COL;
}

let MOV_ID_COL = null;
async function detectMovIdCol() {
if (MOV_ID_COL !== null) return MOV_ID_COL;
const [rows] = await poolRead.query(
`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=? AND TABLE_NAME='movimientos_inventario'`,
[DB_NAME]
);
const low = rows.map((r) => r.COLUMN_NAME.toLowerCase());
if (low.includes("id")) MOV_ID_COL = rows[low.indexOf("id")].COLUMN_NAME;
else if (low.includes("ID")) MOV_ID_COL = rows[low.indexOf("ID")].COLUMN_NAME;
else MOV_ID_COL = rows[0]?.COLUMN_NAME || "id";
return MOV_ID_COL;
}

async function upsertProductoFromAlmacen(conn, { CLAVE, DESCRIPCION, CATEGORIA, UNIDAD, ESTADO = "ACTIVO" }) {
const pk = await detectProductosPK();
const prodStatusCol = await detectProductosStatusCol();
const prodCatNumeric = await productosCategoriaIsNumeric();
let categoriaValue = CATEGORIA ?? null;
if (PROD_HAS_CATEGORIA && categoriaValue != null && categoriaValue !== "") {
categoriaValue = prodCatNumeric
? await resolveCategoriaIdOrCreateForCatalog(categoriaValue)
: String(categoriaValue).trim().toUpperCase().slice(0, 50) || null;
}
const [p] = await conn.query(`SELECT ${qi(pk)} AS id FROM productos WHERE CLAVE=? ORDER BY ${qi(pk)} ASC LIMIT 1`, [CLAVE]);
if (p.length) {
const sets = [`DESCRIPCION = COALESCE(?, DESCRIPCION)`];
const vals = [DESCRIPCION || null];
if (PROD_HAS_CATEGORIA) {
sets.push(`categoria = COALESCE(?, categoria)`);
vals.push(categoriaValue ?? null);
}
if (PROD_HAS_UNIDAD) {
sets.push(`unidad = COALESCE(?, unidad)`);
vals.push(UNIDAD ?? null);
}
if (prodStatusCol) {
sets.push(`${qi(prodStatusCol)} = COALESCE(?, ${qi(prodStatusCol)})`);
vals.push(ESTADO || "ACTIVO");
}
await conn.query(`UPDATE productos SET ${sets.join(", ")} WHERE CLAVE=?`, [...vals, CLAVE]);
return p[0].id;
} else {
const cols = ["CLAVE", "DESCRIPCION"];
const vals = [CLAVE, DESCRIPCION || ""];
if (PROD_HAS_CATEGORIA) {
cols.push("categoria");
vals.push(categoriaValue || null);
}
if (PROD_HAS_UNIDAD) {
cols.push("unidad");
vals.push(UNIDAD || null);
}
const prodStatusCol2 = await detectProductosStatusCol();
if (prodStatusCol2) {
cols.push(prodStatusCol2);
vals.push(ESTADO || "ACTIVO");
}
const [ins] = await conn.query(
`INSERT INTO productos (${cols.map(qi).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
vals
);
return ins.insertId;
}
}

async function logMovimiento(
conn,
{ tipo, clave, cantidad, responsable, destino = null, referencia = null, observaciones = null }
) {
const tipoCol = await detectMovTipoCol();
let T = String(tipo || "").toUpperCase();
if (T !== "ENTRADA" && T !== "SALIDA") T = Number(cantidad) >= 0 ? "ENTRADA" : "SALIDA";
const CANT = Math.abs(Number(cantidad || 0));
if (!clave || !(CANT > 0)) return;

const producto_id = await prodIdFromClave(conn, clave);
await conn.query(
`INSERT INTO movimientos_inventario
(producto_id, ${qi(tipoCol)}, CANTIDAD, FECHA, RESPONSABLE, DESTINO, REFERENCIA, OBSERVACIONES)
VALUES (?, ?, ?, NOW(), ?, ?, ?, ?)`,
[producto_id, T, CANT, responsable || "web", destino, referencia, observaciones]
);
}


async function claveFromProductoId(conn, productoId) {
const pk = await detectProductosPK();
const [r] = await conn.query(`SELECT CLAVE FROM productos WHERE ${qi(pk)}=? LIMIT 1`, [productoId]);
return r[0]?.CLAVE || null;
}
async function reduceStockForClave(conn, { clave, cantidad, responsable, referencia, observaciones }) {
const n = Number(cantidad || 0);
if (!(n > 0)) return;

const [rows] = await conn.query(`SELECT ID, STOCK FROM almacen_dregcivil WHERE CLAVE=? FOR UPDATE`, [clave]);
if (!rows.length) {
const err = new Error("No existe en almacAn la CLAVE: " + clave);
err.statusCode = 400;
throw err;
}

const cur = Number(rows[0].STOCK || 0);
if (cur < n) {
const err = new Error(`Stock insuficiente para ${clave}. Disponible: ${cur}, requerido: ${n}`);
err.statusCode = 409;
throw err;
}

const nuevo = cur - n;
await conn.query(`UPDATE almacen_dregcivil SET STOCK=? WHERE ID=?`, [nuevo, rows[0].ID]);

await logMovimiento(conn, {
tipo: "SALIDA",
clave,
cantidad: n,
responsable,
destino: "SOLICITUD",
referencia,
observaciones,
});

return nuevo;
}

async function applySolicitudStockDeltaForClave(conn, { clave, delta, responsable, referencia, observaciones }) {
const n = Number(delta || 0);
if (!n) return;
if (n > 0) {
return reduceStockForClave(conn, {
clave,
cantidad: n,
responsable,
referencia,
observaciones,
});
}

const regreso = Math.abs(n);
const [rows] = await conn.query(`SELECT ID, STOCK FROM almacen_dregcivil WHERE CLAVE=? FOR UPDATE`, [clave]);
if (!rows.length) {
const err = new Error("No existe en almacAn la CLAVE: " + clave);
err.statusCode = 400;
throw err;
}

const nuevo = Number(rows[0].STOCK || 0) + regreso;
await conn.query(`UPDATE almacen_dregcivil SET STOCK=? WHERE ID=?`, [nuevo, rows[0].ID]);
await logMovimiento(conn, {
tipo: "ENTRADA",
clave,
cantidad: regreso,
responsable,
destino: "SOLICITUD",
referencia,
observaciones,
});
return nuevo;
}

async function updateDetalleSolicitudStockAware({ detalleId, solicitudId = null, data, username }) {
const conn = await poolOps.getConnection();
try {
await conn.beginTransaction();

const pk = await detectProductosPK();
const whereSolicitud = solicitudId == null ? "" : " AND ds.solicitud_id=?";
const params = solicitudId == null ? [detalleId] : [detalleId, solicitudId];
const [rows] = await conn.query(
`SELECT ds.id, ds.solicitud_id, ds.producto_id, ds.cantidad, ds.atendida, p.CLAVE AS clave
FROM detalles_solicitud ds
LEFT JOIN productos p ON p.${qi(pk)} = ds.producto_id
WHERE ds.id=?${whereSolicitud}
LIMIT 1
FOR UPDATE`,
params
);
if (!rows.length) {
const err = new Error(solicitudId == null ? "Detalle no encontrado" : "Detalle no encontrado para esa solicitud");
err.statusCode = 404;
throw err;
}

const row = rows[0];
const prevAtendida = Number(row.atendida || 0);
const nextAtendida = "atendida" in data ? Number(data.atendida) : prevAtendida;
const cantidadSolicitada = Number(row.cantidad || 0);
if (nextAtendida > cantidadSolicitada) {
const err = new Error(`Atendida no puede ser mayor que solicitada (${cantidadSolicitada})`);
err.statusCode = 400;
throw err;
}
const deltaAtendida = nextAtendida - prevAtendida;

if (deltaAtendida !== 0) {
if (!row.clave) {
const err = new Error("No se pudo resolver la CLAVE del detalle");
err.statusCode = 400;
throw err;
}
await applySolicitudStockDeltaForClave(conn, {
clave: row.clave,
delta: deltaAtendida,
responsable: username,
referencia: `SOL-${row.solicitud_id}`,
observaciones: "observaciones" in data ? data.observaciones : null,
});
}

const sets = [];
const vals = [];
if ("atendida" in data) {
sets.push("atendida=?");
vals.push(nextAtendida);
}
if ("observaciones" in data) {
sets.push("observaciones=?");
vals.push(data.observaciones);
}
vals.push(detalleId);
if (solicitudId != null) vals.push(solicitudId);

await conn.query(
`UPDATE detalles_solicitud
SET ${sets.join(", ")}
WHERE id=?${solicitudId == null ? "" : " AND solicitud_id=?"}`,
vals
);

const approvedStatus = await normalizeStatus("APROBADA").catch(() => "APROBADA");
await conn.query(
`UPDATE solicitudes
SET status=?
WHERE id=?`,
[approvedStatus, row.solicitud_id]
);

await conn.commit();
} catch (e) {
await conn.rollback();
throw e;
} finally {
conn.release();
}
}
async function resolveCategoriaIdOrCreateForCatalog(raw) {
if (raw === null || raw === undefined || raw === "") return null;
const n = Number(raw);
if (Number.isFinite(n)) return n;
try {
  return await resolveCategoriaId(raw);
} catch (err) {
  const meta = await detectCategorias();
  if (!meta.table || !meta.id || !meta.name) throw err;
  const nombre = String(raw || "").trim();
  if (!nombre) throw err;
  const [ins] = await poolOps.query(`INSERT INTO ${qi(meta.table)} (${qi(meta.name)}) VALUES (?)`, [nombre.toUpperCase()]);
  return ins.insertId;
}
}

async function updateSolicitudStatusStockAware({ solicitudId, status, observaciones = null, username }) {
const conn = await poolOps.getConnection();
try {
await conn.beginTransaction();

const [solRows] = await conn.query(
`SELECT id, status
FROM solicitudes
WHERE id=?
LIMIT 1
FOR UPDATE`,
[solicitudId]
);
if (!solRows.length) {
const err = new Error("Solicitud no encontrada");
err.statusCode = 404;
throw err;
}

const cancelStatus = await normalizeStatus("CANCELADA").catch(() => "CANCELADA");
const nextStatus = await normalizeStatus(status);
const prevStatus = String(solRows[0].status || "").trim().toUpperCase();

if (prevStatus === cancelStatus && nextStatus !== cancelStatus) {
const err = new Error("La solicitud cancelada ya no puede volver a otro estatus");
err.statusCode = 409;
throw err;
}

let restoredQty = 0;
if (nextStatus === cancelStatus && prevStatus !== cancelStatus) {
const pk = await detectProductosPK();
const [detRows] = await conn.query(
`SELECT ds.id, ds.atendida, p.CLAVE AS clave
FROM detalles_solicitud ds
LEFT JOIN productos p ON p.${qi(pk)} = ds.producto_id
WHERE ds.solicitud_id = ?
AND COALESCE(ds.atendida, 0) > 0
FOR UPDATE`,
[solicitudId]
);

for (const row of detRows) {
const atendida = Number(row.atendida || 0);
if (!(atendida > 0)) continue;
if (!row.clave) {
const err = new Error("No se pudo resolver la CLAVE del detalle");
err.statusCode = 400;
throw err;
}
await applySolicitudStockDeltaForClave(conn, {
clave: row.clave,
delta: -atendida,
responsable: username,
referencia: `SOL-${solicitudId}-CANCEL`,
observaciones: observaciones || "Cancelacion de solicitud",
});
restoredQty += atendida;
}

if (detRows.length) {
await conn.query(
`UPDATE detalles_solicitud
SET atendida = 0
WHERE solicitud_id = ?
AND COALESCE(atendida, 0) > 0`,
[solicitudId]
);
}
}

await conn.query(
`UPDATE solicitudes
SET status = ?, observaciones = COALESCE(?, observaciones)
WHERE id = ?`,
[nextStatus, observaciones, solicitudId]
);

await conn.commit();
return { status: nextStatus, restoredQty };
} catch (e) {
await conn.rollback();
throw e;
} finally {
conn.release();
}
}


app.get("/api/almacen", authRequired, async (req, res) => {
try {
const admin = isAdminDemo(req);
const canAlmacen = hasAlmacenAccess(req);

if (!admin && !canAlmacen) {
return httpError(res, 403, "No tienes acceso al inventario");
}

const { q = "", order = "CLAVE", page = 1, limit = 500, clave = "" } = req.query;
const lim = Math.max(parseInt(limit) || 500, 1);
const off = (Math.max(parseInt(page) || 1, 1) - 1) * lim;
const like = `%${q}%`;
const allowed = ["ID", "CLAVE", "DESCRIPCION", "CATEGORIA", "STOCK", "STATUS"];
const orderUpper = String(order || "CLAVE").toUpperCase();
const orderSafe = safeIdent(allowed, orderUpper, "CLAVE");
const dirSafe = "ASC"; 

const hasEstado = await hasAlmacenEstado();
const almStatusCol = await detectAlmacenStatusCol();
const hasUnidad = await hasAlmacenUnidad();
const catIsNum = await almCategoriaIsNumeric();
const meta = await detectCategorias();

const extraWhere = clave ? " AND a.CLAVE = ?" : "";
const extraParam = clave ? [clave] : [];

const unidadExpr = hasUnidad ? "a.UNIDAD" : "p.unidad";
const unidadSelect = `${unidadExpr} AS UNIDAD`;
const joinProductos = "LEFT JOIN productos p ON p.CLAVE = a.CLAVE";

const statusSel = hasEstado && almStatusCol ? `a.${qi(almStatusCol)} AS status` : `'ACTIVO' AS status`;
const orderExpr =
orderSafe === "CATEGORIA" && catIsNum && meta.table
? `c.${qi(meta.name).slice(1, -1)}`
: orderSafe === "STATUS" && almStatusCol
? `a.${qi(almStatusCol)}`
: `a.${orderSafe}`;

if (catIsNum && meta.table) {
const cols = `a.ID, a.CLAVE, a.DESCRIPCION, a.CATEGORIA, c.${qi(meta.name).slice(1, -1)} AS CATEGORIA_NOMBRE, ${unidadSelect}, a.STOCK, p.minimo AS minimo, ${statusSel}`;
const [rows] = await poolRead.query(
`SELECT ${cols}
FROM almacen_dregcivil a
${joinProductos}
LEFT JOIN ${qi(meta.table)} c ON c.${qi(meta.id)} = a.CATEGORIA
WHERE (?='' OR CONCAT_WS(' ', a.CLAVE, a.DESCRIPCION, c.${qi(meta.name).slice(1, -1)}${
hasEstado && almStatusCol ? `, a.${qi(almStatusCol)}` : ""
}) LIKE ?)
${extraWhere}
ORDER BY ${orderExpr} ${dirSafe}
LIMIT ? OFFSET ?`,
[q, like, ...extraParam, lim, off]
);
return res.json({ ok: true, data: rows });
} else {
const cols = `a.ID, a.CLAVE, a.DESCRIPCION, a.CATEGORIA, ${unidadSelect}, a.STOCK, p.minimo AS minimo, ${statusSel}`;
const [rows] = await poolRead.query(
`SELECT ${cols}
FROM almacen_dregcivil a
${joinProductos}
WHERE (?='' OR CONCAT_WS(' ', a.CLAVE, a.DESCRIPCION, a.CATEGORIA${
hasEstado && almStatusCol ? `, a.${qi(almStatusCol)}` : ""
}) LIKE ?)
${extraWhere}
ORDER BY ${orderExpr} ${dirSafe}
LIMIT ? OFFSET ?`,
[q, like, ...extraParam, lim, off]
);
return res.json({ ok: true, data: rows });
}
} catch (e) {
res.status(500).json({ ok: false, error: e.message });
}
});

app.post("/api/almacen", authRequired, async (req, res) => {
const admin = isAdminDemo(req);
const canAlm = hasAlmacenAccess(req);

if (!admin && !canAlm) {
return httpError(res, 403, "No tienes permiso para crear en almacAn");
}

const replace = admin && String(req.query.replace || "") === "1";

const body = req.body || {};
try {
const CLAVE = String(body.CLAVE ?? body.clave ?? "").trim();
const DESCRIPCION = String(body.DESCRIPCION ?? body.descripcion ?? "").trim();
const cantNueva = Number(body.STOCK ?? body.stock ?? 0);
const hasUnidad = await hasAlmacenUnidad();
const almStatusCol = await detectAlmacenStatusCol();

if (!CLAVE || !DESCRIPCION) return httpError(res, 400, "CLAVE y DESCRIPCION son requeridos");

const catIsNum = await almCategoriaIsNumeric();
let CATEGORIA;
if (catIsNum) {
if (body.CATEGORIA != null || body.categoria != null) {
CATEGORIA = await resolveCategoriaIdOrCreate(body.CATEGORIA ?? body.categoria);
} else {
CATEGORIA = null;
}
} else {
let c = String(body.CATEGORIA ?? body.categoria ?? "").trim().toUpperCase();
if (c.length > 50) c = c.slice(0, 50);
CATEGORIA = c || null;
}

const UNIDAD = hasUnidad ? body.UNIDAD ?? body.unidad ?? null : body.unidad ?? null;
const STATUS_IN = admin
? String(body.status ?? body.STATUS ?? body.estado ?? body.ESTADO ?? "ACTIVO").toUpperCase()
: "ACTIVO";

const conn = await poolOps.getConnection();
try {
await conn.beginTransaction();

const [ex] = await conn.query(`SELECT ID, STOCK FROM almacen_dregcivil WHERE CLAVE=? LIMIT 1`, [CLAVE]);

let idAlm = null;
let delta = cantNueva;
if (ex.length) {
const stockActual = Number(ex[0].STOCK || 0);
let nuevoStock = replace ? cantNueva : stockActual + cantNueva;

const deltaTmp = replace ? nuevoStock - stockActual : cantNueva;
ensureEntradaAllowed(req, deltaTmp, { isNew: false, viaAddStock: !replace });

const baseSets = hasUnidad
? `DESCRIPCION=?, CATEGORIA=?, UNIDAD=?, STOCK=?`
: `DESCRIPCION=?, CATEGORIA=?, STOCK=?`;
const sets = almStatusCol ? `${baseSets}, ${qi(almStatusCol)}=?` : baseSets;
const params = hasUnidad
? almStatusCol
? [DESCRIPCION, CATEGORIA, UNIDAD, nuevoStock, STATUS_IN, ex[0].ID]
: [DESCRIPCION, CATEGORIA, UNIDAD, nuevoStock, ex[0].ID]
: almStatusCol
? [DESCRIPCION, CATEGORIA, nuevoStock, STATUS_IN, ex[0].ID]
: [DESCRIPCION, CATEGORIA, nuevoStock, ex[0].ID];

await conn.query(`UPDATE almacen_dregcivil SET ${sets} WHERE ID=?`, params);
idAlm = ex[0].ID;
delta = replace ? nuevoStock - stockActual : cantNueva;
} else {
ensureEntradaAllowed(req, cantNueva, { isNew: true, viaAddStock: false });

let sql, params;
if (hasUnidad && almStatusCol) {
sql = `INSERT INTO almacen_dregcivil (CLAVE, DESCRIPCION, CATEGORIA, UNIDAD, STOCK, ${qi(
almStatusCol
)}) VALUES (?,?,?,?,?,?)`;
params = [CLAVE, DESCRIPCION, CATEGORIA, UNIDAD, cantNueva, STATUS_IN];
} else if (!hasUnidad && almStatusCol) {
sql = `INSERT INTO almacen_dregcivil (CLAVE, DESCRIPCION, CATEGORIA, STOCK, ${qi(almStatusCol)}) VALUES (?,?,?,?,?)`;
params = [CLAVE, DESCRIPCION, CATEGORIA, cantNueva, STATUS_IN];
} else if (hasUnidad && !almStatusCol) {
sql = `INSERT INTO almacen_dregcivil (CLAVE, DESCRIPCION, CATEGORIA, UNIDAD, STOCK) VALUES (?,?,?,?,?)`;
params = [CLAVE, DESCRIPCION, CATEGORIA, UNIDAD, cantNueva];
} else {
sql = `INSERT INTO almacen_dregcivil (CLAVE, DESCRIPCION, CATEGORIA, STOCK) VALUES (?,?,?,?)`;
params = [CLAVE, DESCRIPCION, CATEGORIA, cantNueva];
}
const [rs] = await conn.query(sql, params);
idAlm = rs.insertId;
}

await upsertProductoFromAlmacen(conn, { CLAVE, DESCRIPCION, CATEGORIA, UNIDAD, ESTADO: STATUS_IN });

if (Number(delta || 0) !== 0) {
await logMovimiento(conn, {
tipo: delta > 0 ? "ENTRADA" : "SALIDA",
clave: CLAVE,
cantidad: Math.abs(delta),
responsable: req.user?.username || "web",
destino: "ALMACEN",
referencia: replace ? "POST /almacen?replace=1" : "POST /almacen",
observaciones: body.observaciones || null,
});
}

await conn.commit();
res.json({ ok: true, id: idAlm });
} catch (e) {
await conn.rollback();
if (e.statusCode) return httpError(res, e.statusCode, e.message);
return httpError(res, 400, e.message);
} finally {
conn.release();
}
} catch (e) {
return httpError(res, 400, e.message);
}
});

app.patch("/api/almacen/:id", authRequired, async (req, res) => {
const admin = isAdminDemo(req);
const canAlmacen = hasAlmacenAccess(req);
if (!admin && !canAlmacen) {
return httpError(res, 403, "No tienes permiso para editar almacAn");
}

try {
const id = Number(req.params.id);
if (!Number.isFinite(id)) return httpError(res, 400, "ID invalido");

const hasUnidad = await hasAlmacenUnidad();
const catIsNum = await almCategoriaIsNumeric();
const almStatusCol = await detectAlmacenStatusCol();

const allowed = ["CLAVE", "DESCRIPCION", "CATEGORIA", "STOCK"];
if (hasUnidad) allowed.push("UNIDAD");
if (almStatusCol) allowed.push(almStatusCol);

const addStock = req.body.addStock != null && req.body.addStock !== "" ? Number(req.body.addStock) : null;
if (addStock != null && !Number.isFinite(addStock)) return httpError(res, 400, "addStock debe ser numArico");

const data = {};
for (const k of Object.keys(req.body || {})) {
const ku = k.toUpperCase();
if (allowed.includes(ku) || ku === (almStatusCol || "").toUpperCase()) {
data[ku] = req.body[k];
}
if (ku === "STATUS" || ku === "ESTADO") {
if (almStatusCol) data[almStatusCol.toUpperCase()] = String(req.body[k] || "ACTIVO").toUpperCase();
}
}

if (canAlmacen && !admin) {
const touchingOther = Object.keys(data).some((k) => !["STOCK", (almStatusCol || "").toUpperCase()].includes(k));
if (touchingOther) {
return httpError(res, 403, "EdiciAn bloqueada: solo puedes modificar stock con addStock");
}
if ("STOCK" in data && addStock == null) {
return httpError(res, 403, "Usa addStock para modificar existencias");
}
}

if (Object.keys(data).length === 0 && addStock == null) return httpError(res, 400, "Nada que actualizar");

const [curRows] = await poolRead.query(`SELECT * FROM almacen_dregcivil WHERE ID=? LIMIT 1`, [id]);
if (!curRows.length) return httpError(res, 404, "Registro no encontrado");
const cur = curRows[0];

if ("STOCK" in data && data.STOCK !== "") {
const n = Number(data.STOCK);
if (!Number.isFinite(n)) return httpError(res, 400, "STOCK debe ser numArico");
data.STOCK = n;
}
if ("CATEGORIA" in data) {
if (catIsNum) {
const val = data.CATEGORIA;
data.CATEGORIA =
val == null || val === ""
? null
: Number.isFinite(Number(val))
? Number(val)
: await resolveCategoriaIdOrCreate(val);
} else {
let c = String(data.CATEGORIA || "").trim().toUpperCase();
if (c.length > 50) c = c.slice(0, 50);
data.CATEGORIA = c || null;
}
}
if ("CLAVE" in data) {
data.CLAVE = String(data.CLAVE || "").trim();
if (!data.CLAVE) return httpError(res, 400, "CLAVE no puede ir vacAa");
}
if ("DESCRIPCION" in data) {
data.DESCRIPCION = String(data.DESCRIPCION || "").trim();
if (!data.DESCRIPCION) return httpError(res, 400, "DESCRIPCION no puede ir vacAa");
}
if (hasUnidad && "UNIDAD" in data) {
data.UNIDAD = data.UNIDAD == null || data.UNIDAD === "" ? null : String(data.UNIDAD).toUpperCase().slice(0, 20);
}

const conn = await poolOps.getConnection();
try {
await conn.beginTransaction();

const [rowx] = await conn.query(`SELECT * FROM almacen_dregcivil WHERE ID=? FOR UPDATE`, [id]);
if (!rowx.length) {
await conn.rollback();
return httpError(res, 404, "Registro no encontrado");
}
const row = rowx[0];

let delta = 0;
const isAdd = addStock != null;
if (isAdd) {
delta = Number(addStock);
data.STOCK = Number(row.STOCK || 0) + delta;
} else if ("STOCK" in data) {
delta = Number(data.STOCK) - Number(row.STOCK || 0);
}

ensureEntradaAllowed(req, delta, { isNew: false, viaAddStock: isAdd });

const fields = [];
const values = [];
for (const k of Object.keys(data)) {
fields.push(`${k}=?`);
values.push(data[k]);
}
if (fields.length) {
await conn.query(`UPDATE almacen_dregcivil SET ${fields.join(", ")} WHERE ID=?`, [...values, id]);
}

await upsertProductoFromAlmacen(conn, {
CLAVE: data.CLAVE || row.CLAVE,
DESCRIPCION: data.DESCRIPCION || row.DESCRIPCION,
CATEGORIA: "CATEGORIA" in data ? data.CATEGORIA : row.CATEGORIA,
UNIDAD: hasUnidad ? ("UNIDAD" in data ? data.UNIDAD : row.UNIDAD) : null,
ESTADO: almStatusCol ? data[almStatusCol] ?? row[almStatusCol] ?? "ACTIVO" : "ACTIVO",
});

if (delta !== 0) {
await logMovimiento(conn, {
tipo: delta > 0 ? "ENTRADA" : "SALIDA",
clave: data.CLAVE || row.CLAVE,
cantidad: Math.abs(delta),
responsable: req.user?.username || "web",
destino: "ALMACEN",
referencia: "PATCH /almacen/:id",
observaciones: req.body.observaciones || null,
});
}

await conn.commit();
res.json({ ok: true, updated: true, id, stock: "STOCK" in data ? data.STOCK : row.STOCK });
} catch (e) {
await conn.rollback();
if (e.statusCode) return httpError(res, e.statusCode, e.message);
throw e;
} finally {
conn.release();
}
} catch (e) {
return httpError(res, 400, e.message);
}
});

app.delete("/api/almacen/:id", authRequired, async (req, res) => {
if (!isAdminDemo(req)) {
return httpError(res, 403, "Eliminar de almacAn bloqueado para tu rol");
}

try {
const id = Number(req.params.id);
if (!Number.isFinite(id)) return httpError(res, 400, "ID invalido");

const hasEstado = await hasAlmacenEstado();
const almStatusCol = await detectAlmacenStatusCol();
const hard = String(req.query.hard || "") === "1";

const conn = await poolOps.getConnection();
try {
await conn.beginTransaction();

const [cur] = await conn.query(`SELECT CLAVE FROM almacen_dregcivil WHERE ID=? LIMIT 1`, [id]);
const clave = cur[0]?.CLAVE || null;

if (!hard && hasEstado && almStatusCol) {
const [rs] = await conn.query(`UPDATE almacen_dregcivil SET ${qi(almStatusCol)}='INACTIVO' WHERE ID=?`, [id]);
if (clave) {
const prodStatusCol = await detectProductosStatusCol();
if (prodStatusCol) await conn.query(`UPDATE productos SET ${qi(prodStatusCol)}='INACTIVO' WHERE CLAVE=?`, [clave]);
}
await conn.commit();
return res.json({ ok: true, deleted: rs.affectedRows > 0, soft: true });
} else {
const [rs] = await conn.query(`DELETE FROM almacen_dregcivil WHERE ID=?`, [id]);
if (clave) {
try {
await conn.query(`DELETE FROM productos WHERE CLAVE=?`, [clave]);
} catch (e) {
const prodStatusCol = await detectProductosStatusCol();
if (prodStatusCol) await conn.query(`UPDATE productos SET ${qi(prodStatusCol)}='INACTIVO' WHERE CLAVE=?`, [clave]);
}
}
await conn.commit();
return res.json({ ok: true, deleted: rs.affectedRows > 0, hard: true });
}
} catch (e) {
await conn.rollback();
throw e;
} finally {
conn.release();
}
} catch (e) {
return httpError(res, 400, e.message);
}
});


app.get("/api/productos", authRequired, async (req, res) => {
if (!isAdminDemo(req)) {
return httpError(res, 403, "No tienes permiso para ver productos");
}
try {
const { q = "", page = 1, limit = 100, order = "CLAVE" } = req.query;
const lim = Math.max(parseInt(limit) || 100, 1);
const off = (Math.max(parseInt(page) || 1, 1) - 1) * lim;
const like = `%${q}%`;

const orderSafe = ["CLAVE", "DESCRIPCION", "categoria", "unidad", "minimo", "maximo", "status"].includes(
String(order)
)
? String(order)
: "CLAVE";
const dirSafe = "ASC"; 

const pkSelect = await mapProdPKAliasSelect();
const prodStatusCol = await detectProductosStatusCol();
const statusSel = prodStatusCol ? `p.${qi(prodStatusCol)} AS status` : `NULL AS status`;
const statusWhere = prodStatusCol ? `, p.${qi(prodStatusCol)}` : "";
const orderExpr = orderSafe === "status" ? (prodStatusCol ? `p.${qi(prodStatusCol)}` : `p.CLAVE`) : `p.${orderSafe}`;

const [rows] = await poolRead.query(
`SELECT ${pkSelect}, p.CLAVE, p.DESCRIPCION,
${PROD_HAS_CATEGORIA ? "p.categoria" : "NULL AS categoria"},
${PROD_HAS_UNIDAD ? "p.unidad" : "NULL AS unidad"},
p.minimo, p.maximo, ${statusSel}
FROM productos p
WHERE (?='' OR CONCAT_WS(' ', p.CLAVE, p.DESCRIPCION, ${PROD_HAS_CATEGORIA ? "p.categoria" : '""'}, ${
PROD_HAS_UNIDAD ? "p.unidad" : '""'
}${statusWhere}) LIKE ?)
ORDER BY ${orderExpr} ${dirSafe}
LIMIT ? OFFSET ?`,
[q, like, lim, off]
);
return res.json({ ok: true, data: rows });
} catch (e) {
return httpError(res, 500, e.message);
}
});

app.get("/api/productos/historial/:clave", authRequired, async (req, res) => {
const admin = isAdminDemo(req);
const canAlmacen = hasAlmacenAccess(req);
if (!admin && !canAlmacen) {
return httpError(res, 403, "No tienes permiso para ver historial");
}
try {
const clave = String(req.params.clave || "").trim();
if (!clave) return httpError(res, 400, "CLAVE requerida");
const prodPk = await detectProductosPK();
const movIdCol = await detectMovIdCol();
const tipoCol = await detectMovTipoCol();
const [rows] = await poolRead.query(
`SELECT
  m.${qi(movIdCol)} AS id,
  m.producto_id,
  m.${qi(tipoCol)} AS tipo,
  m.CANTIDAD AS cantidad,
  m.FECHA AS fecha,
  m.RESPONSABLE AS responsable,
  m.DESTINO AS destino,
  m.REFERENCIA AS referencia,
  m.OBSERVACIONES AS observaciones,
  p.CLAVE,
  p.DESCRIPCION
FROM movimientos_inventario m
LEFT JOIN productos p ON p.${qi(prodPk)} = m.producto_id
WHERE p.CLAVE = ?
ORDER BY m.FECHA DESC, m.${qi(movIdCol)} DESC
LIMIT 200`,
[clave]
);
res.json({ ok: true, data: rows });
} catch (e) {
res.status(500).json({ ok: false, error: e.message });
}
});

app.get("/api/productos/:id", authRequired, async (req, res) => {
if (!isAdminDemo(req)) {
return httpError(res, 403, "No tienes permiso para ver productos");
}
try {
const id = req.params.id;
const pk = await detectProductosPK();
const prodStatusCol = await detectProductosStatusCol();
const statusSel = prodStatusCol ? `p.${qi(prodStatusCol)} AS status` : `NULL AS status`;
const [r1] = await poolRead.query(
`SELECT ${qi(pk)} AS producto_id, CLAVE, DESCRIPCION,
${PROD_HAS_CATEGORIA ? "categoria" : "NULL AS categoria"},
${PROD_HAS_UNIDAD ? "unidad" : "NULL AS unidad"},
minimo, maximo, ${statusSel}
FROM productos p WHERE ${qi(pk)}=? LIMIT 1`,
[id]
);
if (r1.length) return res.json({ ok: true, data: r1[0] });
return httpError(res, 404, "Producto no encontrado");
} catch (e) {
return httpError(res, 500, e.message);
}
});

app.get("/api/productos/clave/:clave", authRequired, async (req, res) => {
if (!isAdminDemo(req)) {
return httpError(res, 403, "No tienes permiso para ver productos");
}
try {
const clave = String(req.params.clave);
const pk = await detectProductosPK();
const prodStatusCol = await detectProductosStatusCol();
const statusSel = prodStatusCol ? `p.${qi(prodStatusCol)} AS status` : `NULL AS status`;
const [r1] = await poolRead.query(
`SELECT ${qi(pk)} AS producto_id, CLAVE, DESCRIPCION,
${PROD_HAS_CATEGORIA ? "categoria" : "NULL AS categoria"},
${PROD_HAS_UNIDAD ? "unidad" : "NULL AS unidad"},
minimo, maximo, ${statusSel}
FROM productos p WHERE CLAVE=? LIMIT 1`,
[clave]
);
if (r1.length) return res.json({ ok: true, data: r1[0] });
return httpError(res, 404, "Producto no encontrado");
} catch (e) {
return httpError(res, 500, e.message);
}
});

app.post("/api/productos", authRequired, async (req, res) => {
const admin = isAdminDemo(req);
const canAlm = hasAlmacenAccess(req);
if (!admin && !canAlm) {
return httpError(res, 403, "No tienes permiso para crear productos");
}

try {
let { CLAVE, DESCRIPCION, categoria = null, unidad = null, minimo = null, maximo = null, status = "ACTIVO" } =
req.body || {};
if (!CLAVE || !DESCRIPCION) return httpError(res, 400, "CLAVE y DESCRIPCION son requeridos");

if (PROD_HAS_CATEGORIA && categoria != null && categoria !== "") {
  categoria = await productosCategoriaIsNumeric()
    ? await resolveCategoriaIdOrCreateForCatalog(categoria)
    : String(categoria).trim().toUpperCase().slice(0, 50);
} else {
  categoria = null;
}
unidad = unidad ? String(unidad).trim().toUpperCase() : null;
if (unidad && unidad.length > 20) unidad = unidad.slice(0, 20);

const minN = minimo === "" || minimo == null ? null : Number(minimo);
const maxN = maximo === "" || maximo == null ? null : Number(maximo);

const conn = await poolOps.getConnection();
try {
const [dup] = await conn.query("SELECT CLAVE FROM productos WHERE CLAVE=? LIMIT 1", [String(CLAVE)]);
if (dup.length) return httpError(res, 409, "La CLAVE ya existe");

const cols = ["CLAVE", "DESCRIPCION", "minimo", "maximo"];
const vals = [String(CLAVE), String(DESCRIPCION), minN, maxN];
if (PROD_HAS_CATEGORIA) {
cols.splice(2, 0, "categoria");
vals.splice(2, 0, categoria);
}
if (PROD_HAS_UNIDAD) {
cols.splice(PROD_HAS_CATEGORIA ? 3 : 2, 0, "unidad");
vals.splice(PROD_HAS_CATEGORIA ? 3 : 2, 0, unidad);
}
const prodStatusCol = await detectProductosStatusCol();
const statusToUse = admin ? String(status || "ACTIVO").toUpperCase() : "ACTIVO";
if (prodStatusCol) {
cols.push(prodStatusCol);
vals.push(statusToUse);
}

const [rs] = await conn.query(
`INSERT INTO productos (${cols.map(qi).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
vals
);
return res.json({ ok: true, producto_id: rs.insertId, table: "productos" });
} finally {
conn.release();
}
} catch (e) {
return httpError(res, 400, e.message);
}
});

app.patch("/api/productos/:id", authRequired, async (req, res) => {
if (!isAdminDemo(req)) {
return httpError(res, 403, "No tienes permiso para editar productos");
}
try {
const id = req.params.id;
const prodStatusCol = await detectProductosStatusCol();
const allowed = ["CLAVE", "DESCRIPCION", "categoria", "unidad", "minimo", "maximo", "status"];
if (prodStatusCol && !allowed.includes(prodStatusCol)) allowed.push(prodStatusCol);

const data = {};
for (const k of Object.keys(req.body || {})) {
if (allowed.includes(k) || (prodStatusCol && k === prodStatusCol)) data[k] = req.body[k];
if ((k === "estado" || k === "ESTADO") && prodStatusCol) data[prodStatusCol] = req.body[k];
}

if (Object.keys(data).length === 0) return httpError(res, 400, "Nada que actualizar");

if ("minimo" in data && data.minimo !== "") data.minimo = Number(data.minimo);
if ("maximo" in data && data.maximo !== "") data.maximo = Number(data.maximo);
if (data.minimo === "") data.minimo = null;
if (data.maximo === "") data.maximo = null;

if ("categoria" in data && data.categoria) {
data.categoria = await productosCategoriaIsNumeric()
  ? await resolveCategoriaIdOrCreateForCatalog(data.categoria)
  : String(data.categoria).trim().toUpperCase().slice(0, 50);
}
if ("unidad" in data && data.unidad) {
data.unidad = String(data.unidad).trim().toUpperCase();
if (data.unidad.length > 20) data.unidad = data.unidad.slice(0, 20);
}

if ("status" in data && prodStatusCol) {
data[prodStatusCol] = String(data.status || "ACTIVO").toUpperCase();
delete data.status;
}

const fields = Object.keys(data).map((k) => `${k}=?`);
const values = Object.values(data);
const pk = await detectProductosPK();

const [rs] = await poolOps.query(`UPDATE productos SET ${fields.join(", ")} WHERE ${qi(pk)}=?`, [...values, id]);
return res.json({ ok: rs.affectedRows > 0, updated: rs.affectedRows > 0, table: "productos" });
} catch (e) {
return httpError(res, 400, e.message);
}
});

app.delete("/api/productos/:id", authRequired, async (req, res) => {
if (!isAdminDemo(req)) {
return httpError(res, 403, "No tienes permiso para eliminar productos");
}
try {
const id = req.params.id;
const hard = String(req.query.hard || "") === "1";
const pk = await detectProductosPK();
const prodStatusCol = await detectProductosStatusCol();
if (hard) {
try {
const [rs] = await poolOps.query(`DELETE FROM productos WHERE ${qi(pk)}=?`, [id]);
return res.json({ ok: true, deleted: rs.affectedRows > 0, hard: true, table: "productos" });
} catch (e) {
if (prodStatusCol) {
await poolOps.query(`UPDATE productos SET ${qi(prodStatusCol)}='INACTIVO' WHERE ${qi(pk)}=?`, [id]);
return res.json({ ok: true, deleted: true, hard: false, table: "productos" });
}
return httpError(res, 400, e.message);
}
} else {
if (!prodStatusCol) return httpError(res, 400, "Columna de status/estado no encontrada en productos");
const [rs] = await poolOps.query(`UPDATE productos SET ${qi(prodStatusCol)}='INACTIVO' WHERE ${qi(pk)}=?`, [id]);
return res.json({ ok: true, deleted: rs.affectedRows > 0, hard: false, table: "productos" });
}
} catch (e) {
return httpError(res, 400, e.message);
}
});


app.get("/api/categorias", authRequired, async (req, res) => {
try {
const { q = "" } = req.query;
const like = `%${q}%`;
const meta = await detectCategorias();
if (!meta.table || !meta.id || !meta.name) return res.json({ ok: true, data: [] });
const [rows] = await poolRead.query(
`SELECT ${qi(meta.id)} AS id, ${qi(meta.name)} AS nombre
FROM ${qi(meta.table)}
WHERE (?='' OR ${qi(meta.name)} LIKE ?)
ORDER BY ${qi(meta.name)} ASC
LIMIT 500`,
[q, like]
);
res.json({ ok: true, data: rows });
} catch (e) {
res.status(500).json({ ok: false, error: e.message });
}
});

app.post("/api/lookup/unidad-categoria", authRequired, async (req, res) => {
try {
const claves = Array.isArray(req.body?.claves) ? req.body.claves : [];
const uniq = [...new Set(claves.map((c) => String(c || "").trim()).filter(Boolean))];
if (!uniq.length) return res.json({ ok: true, data: {} });
const [rows] = await poolRead.query(
`SELECT CLAVE,
${PROD_HAS_UNIDAD ? "unidad" : "NULL AS unidad"},
${PROD_HAS_CATEGORIA ? "categoria" : "NULL AS categoria"}
FROM productos WHERE CLAVE IN (${uniq.map(() => "?").join(",")})`,
uniq
);
const out = {};
for (const r of rows) {
out[r.CLAVE] = { unidad: r.unidad || "", categoria: r.categoria || "" };
}
res.json({ ok: true, data: out });
} catch (e) {
return httpError(res, 400, e.message);
}
});

app.get("/api/umedida/:clave", authRequired, async (req, res) => {
try {
const clave = (req.params.clave || "").trim();
if (!clave) return res.json({ ok: true, data: null });
const [rows] = await poolRead.query(
`SELECT p.CLAVE, ${PROD_HAS_UNIDAD ? "p.unidad" : "NULL"} AS DescUnidad FROM productos p WHERE p.CLAVE=? LIMIT 1`,
[clave]
);
res.json({ ok: true, data: rows[0] || null });
} catch (e) {
return httpError(res, 500, e.message);
}
});
app.get("/api/umedida", authRequired, async (req, res) => {
try {
const clave = (req.query.clave || "").trim();
if (!clave) return res.json({ ok: true, data: [] });
const [rows] = await poolRead.query(
`SELECT p.CLAVE, ${PROD_HAS_UNIDAD ? "p.unidad" : "NULL"} AS DescUnidad FROM productos p WHERE p.CLAVE=? LIMIT 1`,
[clave]
);
return res.json({ ok: true, data: rows || [] });
} catch (e) {
return httpError(res, 500, e.message);
}
});
app.get("/api/umedida/by-clave", authRequired, async (req, res) => {
try {
const clave = (req.query.clave || "").trim();
if (!clave) return res.json({ ok: true, data: [] });
const [rows] = await poolRead.query(
`SELECT p.CLAVE, ${PROD_HAS_UNIDAD ? "p.unidad" : "NULL"} AS DescUnidad FROM productos p WHERE p.CLAVE=? LIMIT 1`,
[clave]
);
return res.json({ ok: true, data: rows || [] });
} catch (e) {
return httpError(res, 500, e.message);
}
});

app.get("/api/ui-config", authRequired, (req, res) => {
  const rol = req.user?.rol || 'USUARIO';
  const admin = rol === 'ADMIN';
  const encargado = rol === 'ENCARGADO';

  res.json({
    ok: true,
    user: req.user?.username || null,
    rol: rol,
    permisos: {
      admin: admin,
      encargado: encargado,
      puedeAccederAlmacen: admin || encargado,
      puedeEditarAlmacen: admin || encargado,
      puedeEliminarAlmacen: admin, 
      reportes: {
        acceso: admin || encargado,
      },
      solicitudes: {
        puedeCrear: true, 
        puedeSurtir: admin || encargado,
        puedeCancelar: admin || encargado,
        puedeEliminar: admin,
      },
      verLogs: admin
    }
  });
});


app.get("/api/solicitudes/:id/pdf", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return httpError(res, 400, "ID invalido");

    // 1. Obtener datos de la solicitud, usuario, departamento y encargado del área
    let solicitud;
    {
      const deptoCol = await detectUsuarioDepartamentoCol();
      const [r] = await poolRead.query(
        `SELECT s.*, u.username,
          u.ID_OFICIALIA AS id_oficialia,
          ${deptoCol ? `u.${qi(deptoCol)} AS departamento,` : `NULL AS departamento,`}
          CONCAT_WS(' ', u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO) AS nombre_usuario,
          o.nombre AS oficialia_nombre,
          o.oficial_reponsable AS encargado_area
        FROM solicitudes s
        LEFT JOIN usuario u ON u.id = s.usuario_id
        LEFT JOIN oficialias o ON o.id = COALESCE(s.id_oficialia, u.ID_OFICIALIA)
        WHERE s.id = ? LIMIT 1`,
        [id]
      );
      if (!r.length) return httpError(res, 404, "Solicitud no encontrada");
      solicitud = r[0];
      if (!solicitud.oficialia_nombre) {
        solicitud.oficialia_nombre = await getOficialiaNombre(solicitud.id_oficialia ?? solicitud.ID_OFICIALIA ?? null);
      }
    }

    // 2. Obtener los artículos solicitados
    let detalles = [];
    {
      const [rows] = await poolRead.query(
        `SELECT d.id AS detalle_id, d.solicitud_id, d.producto_id,
          p.CLAVE, p.DESCRIPCION, p.unidad AS unidad, p.categoria AS categoria,
          d.cantidad, d.atendida, d.observaciones
        FROM detalles_solicitud d
        LEFT JOIN productos p ON p.${await detectProductosPK()} = d.producto_id
        WHERE d.solicitud_id = ?
        ORDER BY d.id`,
        [id]
      );
      detalles = await attachCategoriaNombre(rows);
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="vale_suministro_${id}.pdf"`);

    const doc = new PDFDocument({ size: "LETTER", margin: 36 });
    doc.pipe(res);

    const pageWidth = doc.page.width;   // 612 pt
    const pageHeight = doc.page.height; // 792 pt
    const leftX = 36;
    const rightLimit = pageWidth - 36;  // 576 pt
    const tableWidth = rightLimit - leftX; // 540 pt

    // Formatear fecha DD/MM/YYYY
    const fmtDate = (d) => {
      const dt = d ? new Date(d) : new Date();
      if (isNaN(dt.getTime())) return String(d || "");
      const day = String(dt.getDate()).padStart(2, "0");
      const month = String(dt.getMonth() + 1).padStart(2, "0");
      const year = dt.getFullYear();
      return `${day}/${month}/${year}`;
    };

    // Variables dinámicas del Vale
    const areaNombre = String(solicitud.oficialia_nombre || solicitud.departamento || "General").trim();
    const paraUtilizarseEn = String(solicitud.observaciones || "").trim();
    const fechaTexto = fmtDate(solicitud.fecha_solicitud);

    // Datos para la firma "SOLICITA:"
    const solicitaDepto = /^departamento/i.test(areaNombre)
      ? areaNombre
      : `Departamento de ${areaNombre}`;
    const solicitaEncargado = String(
      solicitud.encargado_area || solicitud.nombre_usuario || pickUsuarioServer(solicitud) || ""
    ).trim();

    // Datos para la firma "AUTORIZA:"
    const autorizaCargo = process.env.VALE_AUTORIZA_CARGO || "Delegada de programas en BCS";
    const autorizaNombre = process.env.VALE_AUTORIZA_NOMBRE || "Yanssen Weichselbaum Calderon";

    // Función para dibujar el encabezado institucional
    function drawValeHeader() {
      const logoPath = path.join(__dirname, "public", "logo.png");
      if (fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, leftX, 32, { fit: [130, 50], align: "left", valign: "top" });
        } catch {}
      }

      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(11)
        .text("SECRETARÍA DE BIENESTAR", leftX, 38, { width: tableWidth, align: "center" });
      doc.font("Helvetica-Bold").fontSize(10)
        .text("DELEGACIÓN FEDERAL BAJA CALIFORNIA SUR", leftX, 53, { width: tableWidth, align: "center" });
      doc.font("Helvetica-Bold").fontSize(11)
        .text("VALE DE SUMINISTRO", leftX, 74, { width: tableWidth, align: "center" });

      // Bloque superior derecho: FECHA REC. y RECURSOS MATERIALES
      doc.font("Helvetica-Bold").fontSize(8.5)
        .text("FECHA REC.___________________", 370, 92, { width: 206, align: "right" });
      doc.font("Helvetica-Bold").fontSize(8.5)
        .text("RECURSOS MATERIALES", 370, 106, { width: 206, align: "center" });

      // Fila AREA
      const yArea = 106;
      doc.font("Helvetica-Bold").fontSize(9).text("AREA:", leftX, yArea);
      doc.font("Helvetica").fontSize(9.5).text(areaNombre, leftX + 38, yArea);
      doc.moveTo(leftX + 35, yArea + 11).lineTo(350, yArea + 11).lineWidth(0.6).strokeColor("#000000").stroke();

      // Fila PARA UTILIZARSE EN y FECHA
      const yUso = 124;
      doc.font("Helvetica-Bold").fontSize(9).text("PARA UTILIZARSE EN:", leftX, yUso);
      doc.font("Helvetica").fontSize(9).text(paraUtilizarseEn, leftX + 110, yUso, { width: 240, lineBreak: false });
      doc.moveTo(leftX + 108, yUso + 11).lineTo(350, yUso + 11).lineWidth(0.6).strokeColor("#000000").stroke();

      doc.font("Helvetica-Bold").fontSize(9).text("FECHA:", 395, yUso);
      doc.font("Helvetica").fontSize(9.5).text(fechaTexto, 440, yUso, { width: 120, align: "center" });
      doc.moveTo(438, yUso + 11).lineTo(rightLimit, yUso + 11).lineWidth(0.6).strokeColor("#000000").stroke();
    }

    // Configuración de columnas de la tabla (Total = 540 pt)
    const colNoW = 35;
    const colDescW = 285;
    const colUniW = 70;
    const colSolW = 75;
    const colEntW = 75;

    const xNo = leftX;
    const xDesc = xNo + colNoW;
    const xUni = xDesc + colDescW;
    const xSol = xUni + colUniW;
    const xEnt = xSol + colSolW;

    function drawTableHeader(topY) {
      const h1 = 15;
      const h2 = 15;
      const totalH = h1 + h2;

      doc.save();
      doc.lineWidth(0.8).strokeColor("#000000");

      // Contorno exterior del encabezado
      doc.rect(leftX, topY, tableWidth, totalH).stroke();

      // Líneas verticales del encabezado
      doc.moveTo(xDesc, topY).lineTo(xDesc, topY + totalH).stroke();
      doc.moveTo(xUni, topY).lineTo(xUni, topY + totalH).stroke();
      doc.moveTo(xSol, topY).lineTo(xSol, topY + totalH).stroke();
      doc.moveTo(xEnt, topY + h1).lineTo(xEnt, topY + totalH).stroke();

      // Línea horizontal que divide CANTIDAD de SOLICITADA / ENTREGADA
      doc.moveTo(xSol, topY + h1).lineTo(rightLimit, topY + h1).stroke();
      doc.restore();

      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8.5);
      doc.text("No.", xNo, topY + 11, { width: colNoW, align: "center" });
      doc.text("DESCRIPCIÓN DEL ARTÍCULO", xDesc, topY + 11, { width: colDescW, align: "center" });
      doc.text("UNIDAD", xUni, topY + 11, { width: colUniW, align: "center" });
      doc.text("CANTIDAD", xSol, topY + 4, { width: colSolW + colEntW, align: "center" });

      doc.fontSize(8);
      doc.text("SOLICITADA", xSol, topY + h1 + 4, { width: colSolW, align: "center" });
      doc.text("ENTREGADA", xEnt, topY + h1 + 4, { width: colEntW, align: "center" });

      return topY + totalH;
    }

    // Dibujar encabezado del vale y encabezado de tabla
    drawValeHeader();
    let currentY = drawTableHeader(148);

    // Completar hasta un mínimo de 18 renglones para mantener la cuadrícula física del formato
    const minRows = 18;
    const totalRows = Math.max(detalles.length, minRows);
    const defaultRowH = 19;

    for (let i = 0; i < totalRows; i++) {
      const item = detalles[i] || null;
      const descText = item ? String(item.DESCRIPCION || "").trim() : "";
      const uniText = item ? String(item.unidad || "").trim() : "";
      const solText = item && item.cantidad != null ? String(item.cantidad) : "";
      // Si ya tiene cantidad atendida > 0 o el estatus es SURTIDA/APROBADA la muestra; si está PENDIENTE y en 0, deja el espacio para llenado o muestra el valor
      const entVal = item ? Number(item.atendida || 0) : 0;
      const entText = item && (entVal > 0 || ["SURTIDA", "ENTREGADA"].includes(String(solicitud.status || "").toUpperCase()))
        ? String(entVal)
        : "";

      doc.font("Helvetica").fontSize(8.5);
      const descH = descText ? doc.heightOfString(descText, { width: colDescW - 8 }) : 10;
      const rowH = Math.max(defaultRowH, descH + 6);

      // Si excede el límite antes de las firmas, crear nueva página
      if (currentY + rowH > pageHeight - 165) {
        doc.addPage();
        drawValeHeader();
        currentY = drawTableHeader(148);
      }

      doc.save();
      doc.lineWidth(0.5).strokeColor("#000000");
      doc.rect(leftX, currentY, tableWidth, rowH).stroke();
      doc.moveTo(xDesc, currentY).lineTo(xDesc, currentY + rowH).stroke();
      doc.moveTo(xUni, currentY).lineTo(xUni, currentY + rowH).stroke();
      doc.moveTo(xSol, currentY).lineTo(xSol, currentY + rowH).stroke();
      doc.moveTo(xEnt, currentY).lineTo(xEnt, currentY + rowH).stroke();
      doc.restore();

      if (item) {
        const textY = currentY + 5;
        doc.fillColor("#000000").font("Helvetica").fontSize(8.5);
        doc.text(String(i + 1), xNo, textY, { width: colNoW, align: "center" });
        doc.text(descText, xDesc + 4, textY, { width: colDescW - 8, align: "left" });
        doc.text(uniText, xUni + 2, textY, { width: colUniW - 4, align: "center" });
        doc.text(solText, xSol + 2, textY, { width: colSolW - 4, align: "center" });
        doc.text(entText, xEnt + 2, textY, { width: colEntW - 4, align: "center" });
      }

      currentY += rowH;
    }

    // 3. Dibujar las 3 cajas de firma al pie (SOLICITA, AUTORIZA, RECIBE)
    const signBoxY = Math.max(currentY + 18, pageHeight - 145);
    const signBoxH = 78;
    const gap = 12;
    const boxW = (tableWidth - gap * 2) / 3; // 172 pt cada caja

    const xBox1 = leftX;
    const xBox2 = leftX + boxW + gap;
    const xBox3 = leftX + (boxW + gap) * 2;

    doc.save();
    doc.lineWidth(0.7).strokeColor("#000000");
    doc.rect(xBox1, signBoxY, boxW, signBoxH).stroke();
    doc.rect(xBox2, signBoxY, boxW, signBoxH).stroke();
    doc.rect(xBox3, signBoxY, boxW, signBoxH).stroke();

    // Líneas de firma dentro de cada caja
    const lineY = signBoxY + 48;
    doc.moveTo(xBox1 + 12, lineY).lineTo(xBox1 + boxW - 12, lineY).stroke();
    doc.moveTo(xBox2 + 12, lineY).lineTo(xBox2 + boxW - 12, lineY).stroke();
    doc.moveTo(xBox3 + 12, lineY).lineTo(xBox3 + boxW - 12, lineY).stroke();
    doc.restore();

    // Textos Caja 1: SOLICITA (Dinámico por departamento y encargado)
    doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8)
      .text("SOLICITA:", xBox1 + 4, signBoxY + 6, { width: boxW - 8, align: "center" });
    doc.font("Helvetica").fontSize(7.5)
      .text(solicitaDepto, xBox1 + 4, signBoxY + 17, { width: boxW - 8, align: "center" });
    doc.font("Helvetica-Bold").fontSize(7.5)
      .text(solicitaEncargado, xBox1 + 4, lineY + 5, { width: boxW - 8, align: "center" });

    // Textos Caja 2: AUTORIZA (Delegada)
    doc.font("Helvetica-Bold").fontSize(8)
      .text("AUTORIZA:", xBox2 + 4, signBoxY + 6, { width: boxW - 8, align: "center" });
    doc.font("Helvetica").fontSize(7.5)
      .text(autorizaCargo, xBox2 + 4, signBoxY + 17, { width: boxW - 8, align: "center" });
    doc.font("Helvetica-Bold").fontSize(7.5)
      .text(autorizaNombre, xBox2 + 4, lineY + 5, { width: boxW - 8, align: "center" });

    // Textos Caja 3: RECIBE (Conformidad)
    doc.font("Helvetica-Bold").fontSize(8)
      .text("RECIBE:", xBox3 + 4, signBoxY + 6, { width: boxW - 8, align: "center" });
    doc.font("Helvetica").fontSize(7.5)
      .text("NOMBRE, FECHA Y FIRMA", xBox3 + 4, signBoxY + 17, { width: boxW - 8, align: "center" });
    doc.font("Helvetica").fontSize(7.2)
      .text("Recibí de conformidad: SI (   )  NO (   )", xBox3 + 4, lineY + 6, { width: boxW - 8, align: "center" });

    // 4. Pie de página institucional
    const footerY = signBoxY + signBoxH + 10;
    doc.font("Helvetica").fontSize(7.5).fillColor("#333333");
    doc.text(`Folio Solicitud: #${id}`, leftX, footerY, { width: 150, align: "left" });
    doc.text("Hoja 1 De 1", leftX, footerY, { width: tableWidth, align: "center" });
    doc.text("Delegación de BIENESTAR en Baja California Sur", leftX, footerY + 10, { width: tableWidth, align: "center" });

    doc.end();
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

const STATIC_DIR = path.join(__dirname, "public");
app.use(express.static(STATIC_DIR));
app.get("/__ping", (req, res) => res.send("OK"));

const DEFAULT_PORT = Number(process.env.PORT) || 8080;

function startOnce(port) {
return new Promise((resolve, reject) => {
const server = app.listen(port, async () => {
try {
await detectProductosPK();
await detectProductosStatusCol();
await detectAlmacenStatusCol();
} catch (e) {
}
console.log(`API en puerto ${port}`);
resolve(server);
});

server.on('error', (err) => {
reject(err);
});
});
}

(async () => {
let port = DEFAULT_PORT;
const maxRetries = 5;
for (let i = 0; i < maxRetries; i++) {
try {
await startOnce(port);

return;
} catch (err) {
if (err && err.code === 'EADDRINUSE') {
console.error(`Puerto ${port} en uso. Intentando puerto ${port + 1}...`);
port++;

await new Promise((r) => setTimeout(r, 200));
continue;
}
console.error('Error al iniciar servidor:', err && err.stack ? err.stack : err);
process.exit(1);
}
}
console.error(`No fue posible iniciar el servidor tras ${maxRetries} intentos (puertos ocupados).`);
process.exit(1);
})();

process.on('unhandledRejection', (reason) => {
console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
console.error('Uncaught Exception:', err && err.stack ? err.stack : err);

});
