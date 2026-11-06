const express = require("express");
const mysql = require("mysql2/promise");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const path = require("path");
const crypto = require("crypto");
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

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
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
  "http://localhost:3000," +
  "http://127.0.0.1:3000," +
  "http://192.168.1.123," +
  "http://192.168.1.123:3000," +
  "https://delinventariobcs.synology.me," +
  "https://delinventariobcs.synology.me:8443"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowed.includes(String(origin).toLowerCase())) return true;
  try {
    const url = new URL(origin);
    const host = String(url.hostname || "").toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "192.168.1.123" ||
      host === "10.77.2.70" ||
      host === "delinventariobcs.synology.me"
    );
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

// Las respuestas de la API nunca se cachean (stock y estatus siempre en tiempo real)
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

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

// ============================================================================
// RECUPERACIÓN ANTE DESASTRES (DRP) Y RESPALDO AUTOMÁTICO DE PDFs Y BD
// ============================================================================
const BACKUP_ROOT_DIR = process.env.BACKUP_ROOT_DIR || path.join(__dirname, "respaldos_sistema");
const BACKUP_DIRS = {
  ordenes_material: path.join(BACKUP_ROOT_DIR, "pdfs_generados", "ordenes_material"),
  vales_provisionales: path.join(BACKUP_ROOT_DIR, "pdfs_generados", "vales_provisionales"),
  resguardos_regionales: path.join(BACKUP_ROOT_DIR, "pdfs_generados", "resguardos_regionales"),
  resguardos_vehiculares: path.join(BACKUP_ROOT_DIR, "pdfs_generados", "resguardos_vehiculares"),
  pdfs_subidos_firmados: path.join(BACKUP_ROOT_DIR, "pdfs_subidos_firmados"),
  pdfs_firmados: path.join(BACKUP_ROOT_DIR, "pdfs_firmados"),
  base_de_datos: path.join(BACKUP_ROOT_DIR, "base_de_datos"),
};

function ensureBackupDirectories() {
  try {
    Object.values(BACKUP_DIRS).forEach((dirPath) => {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    });
  } catch (err) {
    console.warn("[WARN] Error creando directorios DRP:", err?.message || err);
  }
}
ensureBackupDirectories();

function getBackupDateStr(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const dateObj = d instanceof Date && !isNaN(d.getTime()) ? d : new Date();
  return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
}

function sanitizeBackupFileName(name) {
  return String(name || "documento")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function savePdfBackup(pdfDocOrBuffer, categorySubfolder, filename) {
  try {
    ensureBackupDirectories();
    const targetDir = BACKUP_DIRS[categorySubfolder] || path.join(BACKUP_ROOT_DIR, categorySubfolder);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    let cleanFilename = sanitizeBackupFileName(filename);
    if (!cleanFilename.toLowerCase().endsWith(".pdf")) {
      cleanFilename += ".pdf";
    }
    const targetPath = path.join(targetDir, cleanFilename);

    if (Buffer.isBuffer(pdfDocOrBuffer)) {
      fs.writeFileSync(targetPath, pdfDocOrBuffer);
      return targetPath;
    } else if (pdfDocOrBuffer && typeof pdfDocOrBuffer.pipe === "function") {
      const ws = fs.createWriteStream(targetPath);
      ws.on("error", (err) => {
        console.warn(`[WARN] Error stream respaldo PDF (${cleanFilename}):`, err?.message || err);
      });
      pdfDocOrBuffer.pipe(ws);
      return targetPath;
    }
  } catch (err) {
    console.warn(`[WARN] savePdfBackup (${categorySubfolder}/${filename}):`, err?.message || err);
  }
  return null;
}

async function exportDatabaseSnapshot() {
  ensureBackupDirectories();
  const dbDir = BACKUP_DIRS.base_de_datos;

  const targetTables = [
    "usuario",
    "usuarios",
    "oficialias",
    "regiones",
    "oficinas_regionales",
    "rubros_inventario",
    "almacen_dregcivil",
    "productos",
    "inventario_oficina",
    "solicitudes",
    "detalles_solicitud",
    "solicitudes_detalle",
    "vales_prestamo",
    "vales_prestamo_detalle",
    "formatos_inventario_regional",
  ];

  let tableSet = new Set();
  try {
    const [existing] = await poolRead.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?`,
      [DB_NAME]
    );
    tableSet = new Set(existing.map((t) => String(t.TABLE_NAME || "").toLowerCase()));
  } catch (err) {
    console.warn("[WARN] No se pudo leer INFORMATION_SCHEMA.TABLES:", err?.message || err);
  }

  const dateStr = getBackupDateStr();
  const timestamp = new Date().toISOString();
  const snapshot = {
    metadata: {
      sistema: "Delegación BCS - Control de Inventario",
      proposito: "Recuperación ante Desastres (DRP) / Sincronización NAS",
      timestamp,
      fecha: dateStr,
      database: DB_NAME,
      tablas_incluidas: [],
      total_registros: 0,
    },
    tables: {},
  };

  for (const tbl of targetTables) {
    if (tableSet.size > 0 && !tableSet.has(tbl.toLowerCase())) {
      continue;
    }
    try {
      const [rows] = await poolRead.query(`SELECT * FROM ${qi(tbl)}`);
      snapshot.tables[tbl] = rows;
      snapshot.metadata.tablas_incluidas.push(tbl);
      snapshot.metadata.total_registros += rows.length;
    } catch {
      // Ignorar tablas inexistentes
    }
  }

  const jsonContent = JSON.stringify(snapshot, null, 2);
  const latestJsonPath = path.join(dbDir, "backup_db_latest.json");
  const datedJsonPath = path.join(dbDir, `backup_db_${dateStr}.json`);

  fs.writeFileSync(latestJsonPath, jsonContent, "utf8");
  fs.writeFileSync(datedJsonPath, jsonContent, "utf8");

  // Generar script SQL para levantamiento directo si el NAS o la BD fallan
  let sqlDump = `-- ====================================================================\n`;
  sqlDump += `-- RESPALDO CONSOLIDADO DRP - SISTEMA DE INVENTARIO BIENESTAR BCS\n`;
  sqlDump += `-- Generado: ${timestamp}\n`;
  sqlDump += `-- Base de datos: ${DB_NAME}\n`;
  sqlDump += `-- Tablas respaldadas: ${snapshot.metadata.tablas_incluidas.join(", ")}\n`;
  sqlDump += `-- Total registros: ${snapshot.metadata.total_registros}\n`;
  sqlDump += `-- ====================================================================\n\n`;
  sqlDump += `SET FOREIGN_KEY_CHECKS = 0;\n\n`;

  for (const [tbl, rows] of Object.entries(snapshot.tables)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const colNames = Object.keys(rows[0]).map((c) => `\`${c}\``).join(", ");
    sqlDump += `-- Tabla \`${tbl}\`: ${rows.length} registros\n`;
    for (const r of rows) {
      const valList = Object.values(r).map((val) => {
        if (val === null || val === undefined) return "NULL";
        if (typeof val === "number" || typeof val === "boolean") return String(val);
        if (val instanceof Date) return `'${val.toISOString().slice(0, 19).replace("T", " ")}'`;
        if (Buffer.isBuffer(val)) return `X'${val.toString("hex")}'`;
        return `'${String(val).replace(/'/g, "''").replace(/\\/g, "\\\\")}'`;
      }).join(", ");
      sqlDump += `INSERT INTO \`${tbl}\` (${colNames}) VALUES (${valList}) ON DUPLICATE KEY UPDATE id=id;\n`;
    }
    sqlDump += `\n`;
  }
  sqlDump += `SET FOREIGN_KEY_CHECKS = 1;\n`;

  const latestSqlPath = path.join(dbDir, "backup_db_latest.sql");
  const datedSqlPath = path.join(dbDir, `backup_db_${dateStr}.sql`);
  fs.writeFileSync(latestSqlPath, sqlDump, "utf8");
  fs.writeFileSync(datedSqlPath, sqlDump, "utf8");

  console.log(`[DRP] Snapshot de BD generado: ${snapshot.metadata.total_registros} registros respaldados en ${latestJsonPath}`);
  return {
    ok: true,
    metadata: snapshot.metadata,
    archivos: [
      latestJsonPath,
      datedJsonPath,
      latestSqlPath,
      datedSqlPath,
    ],
  };
}

// Mapa de los 4 encargados del Inventario Regional y su rubro exclusivo
const REGIONAL_ENCARGADOS_MAP = {
  gabrielfiol: {
    id: 4,
    username: "gabrielfiol",
    nombre: "Gabriel Adan",
    primer_ap: "Fiol",
    segundo_ap: "Collins",
    id_oficialia: 30030008,
    rol: "ENCARGADO",
    departamento: "ENCARGADO",
    rubro_id: 1, // ARCHIVO_MATERIALES
    canAlmacen: true,
  },
  evelia: {
    id: 5,
    username: "evelia",
    nombre: "Evelia",
    primer_ap: "Contreras",
    segundo_ap: "Godinez",
    id_oficialia: 30030001,
    rol: "ENCARGADO",
    departamento: "ENCARGADO_REGIONAL",
    rubro_id: 2, // PARQUE_VEHICULAR
    canAlmacen: false,
  },
  jesus: {
    id: 6,
    username: "jesus",
    nombre: "Jesus Salvador",
    primer_ap: "Palacios",
    segundo_ap: "Martinez",
    id_oficialia: 30030001,
    rol: "ENCARGADO",
    departamento: "ENCARGADO_REGIONAL",
    rubro_id: 3, // MOBILIARIO
    canAlmacen: false,
  },
  luiseduardo: {
    id: 7,
    username: "luiseduardo",
    nombre: "Luis Eduardo",
    primer_ap: "Mayoral",
    segundo_ap: "Geraldo",
    id_oficialia: 30030001,
    rol: "ENCARGADO",
    departamento: "ENCARGADO_REGIONAL",
    rubro_id: 4, // TABLETS_STARLINKS
    canAlmacen: false,
  },
  encargado: {
    id: 2,
    username: "encargado",
    nombre: "Gabriel Adan",
    primer_ap: "Fiol",
    segundo_ap: "Collins",
    id_oficialia: 30030008,
    rol: "ENCARGADO",
    departamento: "Encargado de Inventario",
    rubro_id: 1, // ARCHIVO_MATERIALES
    canAlmacen: true,
  },
};

function getUserRubroId(userOrReq) {
  const u = userOrReq?.user ? userOrReq.user : userOrReq;
  if (!u) return null;
  const uname = normalizeUser(u.username);
  if (uname === "admin" || String(u.rol || "").toUpperCase() === "ADMIN") return null;
  const dbRubro = Number(u.rubro_id || 0);
  if (Number.isInteger(dbRubro) && dbRubro > 0) return dbRubro;
  const mapped = REGIONAL_ENCARGADOS_MAP[uname];
  return mapped ? mapped.rubro_id : null;
}

// Roles: ADMIN (Nivel 3), ENCARGADO (Nivel 2), USUARIO (Nivel 1)
function normalizeRol(r, username = '') {
  const u = normalizeUser(username);
  if (u === 'admin') return 'ADMIN';
  if (u === 'gabrielfiol' || u === 'encargado' || u === 'rodrigo' || u === 'jorge' || u === 'jorgepatron') return 'ENCARGADO';
  if (u === 'evelia' || u === 'jesus' || u === 'luiseduardo') return 'ENCARGADO';
  const up = String(r || '').trim().toUpperCase();
  if (up === 'ADMIN' || up === 'ADMINISTRADOR' || up === 'ADMINISTRACION') return 'ADMIN';
  if (up === 'ENCARGADO' || up === 'ENCARGADO DE INVENTARIO' || up === 'ENCARGADO_REGIONAL') return 'ENCARGADO';
  if (up === 'USUARIO' || up === 'USER' || up === 'REGIONAL' || up === 'DEPARTAMENTO') return 'USUARIO';
  return 'USUARIO';
}

function isAdmin(req) {
  return normalizeRol(req.user?.rol, req.user?.username) === 'ADMIN';
}

function isRegionalEncargado(req) {
  const rubId = getUserRubroId(req);
  return Number.isInteger(rubId) && rubId > 0;
}

function isRegionalFullAccess(userOrReq) {
  const u = userOrReq?.user ? userOrReq.user : userOrReq;
  if (!u) return false;
  const uname = normalizeUser(u.username);
  if (uname === 'gabrielfiol' || uname === 'encargado') return false;
  if (isAdmin({ user: u }) || ['admin', 'rodrigo', 'jorge', 'jorgepatron'].includes(uname)) return true;
  if (['evelia', 'jesus', 'luiseduardo', 'luis'].includes(uname)) return true;
  const rubId = Number(u.rubro_id || 0);
  if ([2, 3, 4].includes(rubId)) return true;
  return false;
}

function isRegionalEnlace(userOrReq) {
  const u = userOrReq?.user ? userOrReq.user : userOrReq;
  if (!u) return false;
  const uname = normalizeUser(u.username);
  if (uname === 'gabrielfiol' || uname === 'encargado') return false;
  const role = String(u.rol || u.role || '').toUpperCase();
  if (role === 'REGIONAL') return true;
  if (['lapaz', 'sandra', 'loscabos', 'comondu', 'mulege'].includes(uname)) return true;
  const depto = String(u.departamento || '').toLowerCase();
  const cargo = String(u.cargo || '').toLowerCase();
  if (depto.includes('enlace regional') || cargo.includes('regional')) return true;
  return false;
}

function canAccessRegional(req) {
  if (!req?.user) return false;
  const uname = normalizeUser(req.user?.username);
  if (uname === 'gabrielfiol' || uname === 'encargado') return false;
  return isRegionalFullAccess(req) || isRegionalEnlace(req);
}

function canEditRegional(req) {
  return isRegionalFullAccess(req);
}

function canGeneratePdfRegional(req) {
  return isRegionalFullAccess(req);
}

function canUseCuatroFirmas(userOrReq) {
  const u = userOrReq?.user ? userOrReq.user : userOrReq;
  if (!u) return false;
  const uname = normalizeUser(u.username);
  const role = String(u.rol || u.role || '').toUpperCase();
  if (role === 'ADMIN' || ['admin', 'rodrigo', 'jorge', 'jorgepatron'].includes(uname)) return true;
  if (role === 'REGIONAL' || isRegionalEnlace(u)) return true;
  if (['jesus', 'luiseduardo', 'luis', 'gabrielfiol', 'fiol', 'encargado', 'evelia'].includes(uname)) return true;
  const rubId = Number(u.rubro_id || 0);
  if ([1, 2, 3, 4].includes(rubId)) return true;
  return false;
}

function isEncargado(req) {
  const uname = normalizeUser(req.user?.username);
  if (uname === 'evelia' || uname === 'jesus' || uname === 'luiseduardo') {
    return false;
  }
  return (
    normalizeRol(req.user?.rol, req.user?.username) === 'ENCARGADO' ||
    uname === 'gabrielfiol' ||
    uname === 'encargado' ||
    uname === 'rodrigo' ||
    uname === 'jorge' ||
    uname === 'jorgepatron'
  );
}

function canViewInventarioGeneral(user) {
  if (!user) return false;
  const u = user.user ? user.user : user;
  const uname = String(u.username || '').toLowerCase().trim();
  const role = String(u.rol || u.role || '').toLowerCase().trim();
  return (
    role === 'admin' ||
    uname === 'admin' ||
    uname === 'rodrigo' ||
    uname === 'jorge' ||
    uname === 'jorgepatron'
  );
}

function canAccessInventarioEstatal(req) {
  return canViewInventarioGeneral(req?.user || req);
}

function canManageAlmacen(req) {
  // Admin y Gabriel Fiol (Encargado de Almacén/Archivo) pueden gestionar inventario y agregar productos
  return isAdmin(req) || isEncargado(req);
}

function canManageSolicitudes(req) {
  // Admin y Gabriel Fiol (Encargado de Almacén) pueden gestionar/surtir vales de todos
  return isAdmin(req) || isEncargado(req);
}

function canViewReportes(req) {
  // Admin y Gabriel Fiol (Encargado de Almacén) tienen acceso a reportes de consumo
  return isAdmin(req) || isEncargado(req);
}

// ---------------------------------------------------------------------------
// Matriz de permisos (Reunión 29/10/26)
// ---------------------------------------------------------------------------
// Regiones foráneas (fuera de la Delegación Central de La Paz) habilitadas para firma digital
const REGIONES_FORANEAS = new Set(["LOS_CABOS", "MULEGE", "COMONDU_LORETO"]);

// Usuarios regionales de ejemplo (contraseña inicial: secreta123)
const REGIONAL_ENLACES_EJEMPLO = [
  { username: "loscabos", nombre: "Enlace Regional Los Cabos", region_clave: "LOS_CABOS", id_oficialia: 30030009, oficialia_nombre: "Enlace Regional Los Cabos" },
  { username: "mulege", nombre: "Diana Ramirez Hernandez", region_clave: "MULEGE", id_oficialia: 30030010, oficialia_nombre: "Enlace Regional Mulegé" },
  { username: "comondu", nombre: "Enlace Regional Comondú / Loreto", region_clave: "COMONDU_LORETO", id_oficialia: 30030011, oficialia_nombre: "Enlace Regional Comondú / Loreto" },
];

// Inventario Regional: canEditRegional definido arriba según matriz estricta (admin y encargados rubro regional)

// Órdenes de material: solo admin y Gabriel Fiol (encargado de almacén) ven TODAS las órdenes
function canSeeAllSolicitudes(req) {
  return isAdmin(req) || isEncargado(req);
}

// Selección de departamento en Nueva Solicitud y Listado: solo admin y Gabriel Fiol
function canSelectAnyDepartment(req) {
  return isAdmin(req) || isEncargado(req);
}

// Alcance (región / oficina / departamento) leído directamente de BD con caché corta,
// para que los cambios hechos por el admin se reflejen sin volver a iniciar sesión.
const USER_SCOPE_CACHE = new Map();
const USER_SCOPE_TTL_MS = 30 * 1000;
let LA_PAZ_REGION_CACHE = null;

async function getLaPazRegion() {
  if (LA_PAZ_REGION_CACHE) return LA_PAZ_REGION_CACHE;
  try {
    const [[r]] = await poolRead.query(`SELECT id, clave, nombre FROM regiones WHERE clave = 'LA_PAZ' LIMIT 1`);
    if (r) LA_PAZ_REGION_CACHE = r;
  } catch {}
  return LA_PAZ_REGION_CACHE;
}

function invalidateUserScope(userId) {
  if (userId == null) USER_SCOPE_CACHE.clear();
  else USER_SCOPE_CACHE.delete(Number(userId));
}

async function getUserScope(req) {
  const uid = Number(req.user?.id || 0);
  const cached = USER_SCOPE_CACHE.get(uid);
  if (cached && Date.now() - cached.ts < USER_SCOPE_TTL_MS) return cached.data;

  let row = null;
  try {
    const [rows] = await poolRead.query(
      `SELECT u.id, u.ID_OFICIALIA AS oficialia_id, u.region_id, u.oficina_id,
              r.clave AS region_clave, r.nombre AS region_nombre
         FROM usuario u
         LEFT JOIN regiones r ON r.id = u.region_id
        WHERE u.id = ? LIMIT 1`,
      [uid]
    );
    row = rows[0] || null;
  } catch {
    // Columnas region_id/oficina_id aún no migradas: usar datos del token
    row = { id: uid, oficialia_id: req.user?.id_oficialia ?? null, region_id: null, oficina_id: null };
  }

  let regionId = Number(row?.region_id || 0) || null;
  let regionClave = row?.region_clave ? String(row.region_clave).toUpperCase() : null;
  let regionNombre = row?.region_nombre || null;
  let regionAsignadaExplicita = Boolean(regionId);

  // Usuarios de departamento sin región asignada pertenecen a la Delegación Central (La Paz)
  if (!regionId) {
    const lp = await getLaPazRegion();
    if (lp) {
      regionId = Number(lp.id);
      regionClave = String(lp.clave).toUpperCase();
      regionNombre = lp.nombre;
    }
  }

  const data = {
    user_id: uid,
    oficialia_id: Number(row?.oficialia_id || req.user?.id_oficialia || 0) || null,
    oficina_id: Number(row?.oficina_id || 0) || null,
    region_id: regionId,
    region_clave: regionClave,
    region_nombre: regionNombre,
    region_asignada: regionAsignadaExplicita,
    es_region_foranea: Boolean(regionClave && REGIONES_FORANEAS.has(regionClave)),
  };
  USER_SCOPE_CACHE.set(uid, { ts: Date.now(), data });
  return data;
}

// Verifica que el usuario pueda consultar una solicitud específica (regla B)
async function assertSolicitudAccess(req, solicitudId) {
  if (canSeeAllSolicitudes(req)) return true;
  const scope = await getUserScope(req);
  const [[sol]] = await poolRead.query(
    `SELECT id, usuario_id, id_oficialia FROM solicitudes WHERE id = ? LIMIT 1`,
    [Number(solicitudId)]
  );
  if (!sol) return true; // el endpoint responderá 404
  const own = Number(sol.usuario_id) === Number(req.user?.id);
  const sameOfi = scope.oficialia_id && Number(sol.id_oficialia) === Number(scope.oficialia_id);
  if (own || sameOfi) return true;
  const err = new Error("No tienes permiso para consultar órdenes de otro departamento o región.");
  err.statusCode = 403;
  throw err;
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

// Sincronización estricta del inventario de Gabriel Fiol:
// El inventario de materiales y suministros es UNO SOLO (almacen_dregcivil).
// En inventario_oficina (oficina_id = 1, rubro_id = 1 / Archivo y Materiales) se refleja
// exactamente la existencia real del almacén central de la Delegación.
async function syncAlmacenCentralToInventarioRegional(dbHandle = poolOps) {
  if (!dbHandle) return;
  try {
    const [almRows] = await dbHandle.query(
      `SELECT ID, CLAVE, DESCRIPCION, UNIDAD, STOCK, origen_adquisicion, observaciones_control, ESTADO
       FROM almacen_dregcivil`
    ).catch(() => [[]]);
    if (!almRows || !almRows.length) return;

    const [invRows] = await dbHandle.query(
      `SELECT id, clave_bien FROM inventario_oficina WHERE oficina_id = 1 AND rubro_id = 1`
    ).catch(() => [[]]);
    const existingMap = new Map();
    for (const r of invRows) {
      if (r.clave_bien) existingMap.set(String(r.clave_bien).trim().toUpperCase(), r.id);
    }

    for (const a of almRows) {
      const clave = String(a.CLAVE || "").trim().toUpperCase();
      if (!clave) continue;
      const stock = Math.max(0, Number(a.STOCK) || 0);
      const desc = String(a.DESCRIPCION || "").trim();
      const unidad = String(a.UNIDAD || "PIEZA").trim().toUpperCase();
      const origen = a.origen_adquisicion || "COMPRA_DELEGACION";
      const obsControl = a.observaciones_control || null;
      const estatusUso = (a.ESTADO === "INACTIVO" || stock === 0) ? "ACTIVO" : "ACTIVO";

      if (existingMap.has(clave)) {
        const invId = existingMap.get(clave);
        await dbHandle.query(
          `UPDATE inventario_oficina
           SET descripcion = ?,
               unidad = ?,
               cantidad_propia = ?,
               origen_adquisicion = ?,
               observaciones_control = ?
           WHERE id = ?`,
          [desc, unidad, stock, origen, obsControl, invId]
        ).catch(() => {});
      } else {
        await dbHandle.query(
          `INSERT INTO inventario_oficina
             (oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas,
              unidad, cantidad_propia, cantidad_prestada_recibida, cantidad_prestada_enviada,
              estado_fisico, estatus_uso, origen_adquisicion, observaciones_control, observaciones)
           VALUES
             (1, 1, ?, ?, 'N/A', 'N/A', ?, ?, 0, 0, 'BUENO', ?, ?, ?, 'Sincronizado de Almacén General')`,
          [clave, desc, unidad, stock, estatusUso, origen, obsControl]
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.warn("[WARN] syncAlmacenCentralToInventarioRegional:", err?.message || err);
  }
}

let SCHEMA_MIGRATED = false;
async function ensureSchemaAndUsers() {
  if (SCHEMA_MIGRATED) return true;
  if (!poolOps) return false;
  try {
    // 1. Asegurar columnas rubro_id, region_id, oficina_id en tabla usuario
    const [uCols] = await poolRead.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'usuario'`,
      [DB_NAME]
    );
    const uColNames = new Set(uCols.map((c) => String(c.COLUMN_NAME || "").toLowerCase()));
    if (!uColNames.has("rubro_id")) {
      await poolOps.query(`ALTER TABLE usuario ADD COLUMN rubro_id INT(11) DEFAULT NULL`).catch(() => {});
    }
    if (!uColNames.has("region_id")) {
      await poolOps.query(`ALTER TABLE usuario ADD COLUMN region_id INT(11) DEFAULT NULL`).catch(() => {});
    }
    if (!uColNames.has("oficina_id")) {
      await poolOps.query(`ALTER TABLE usuario ADD COLUMN oficina_id INT(11) DEFAULT NULL`).catch(() => {});
    }
    if (!uColNames.has("cargo")) {
      await poolOps.query(`ALTER TABLE usuario ADD COLUMN cargo VARCHAR(150) DEFAULT NULL`).catch(() => {});
    }
    await poolOps.query(`ALTER TABLE usuario MODIFY COLUMN rol VARCHAR(50) NOT NULL DEFAULT 'USUARIO'`).catch(() => {});
    await poolOps.query(`ALTER TABLE oficialias MODIFY COLUMN oficial_reponsable VARCHAR(150) DEFAULT NULL`).catch(() => {});

    // 1b. Actualizar Rubro 4 a TABLETS_STARLINKS (Tablets y Starlinks - Luis Eduardo)
    await poolOps.query(
      `UPDATE rubros_inventario
       SET codigo = 'TABLETS_STARLINKS',
           nombre_rubro = 'Tablets y Starlinks',
           encargado_nombre = 'Luis Eduardo Mayoral Geraldo',
           encargado_cargo = 'Encargado de Tablets y Starlinks'
       WHERE id = 4`
    ).catch(() => {});

    // 1c. Asegurar regiones base e IDs por clave
    const [regCatalogRows] = await poolRead.query(
      `SELECT id, clave, nombre FROM regiones`
    ).catch(() => [[]]);
    const regByClave = {};
    for (const r of regCatalogRows) {
      if (r.clave) regByClave[String(r.clave).toUpperCase()] = Number(r.id);
    }
    const regLaPazId = regByClave.LA_PAZ || 1;
    const regLosCabosId = regByClave.LOS_CABOS || 2;
    const regComonduId = regByClave.COMONDU_LORETO || 3;
    const regMulegeId = regByClave.MULEGE || 4;

    // 1c-1. Asegurar nueva oficina "Guerrero Negro" en la región MULEGE
    const [gnRows] = await poolRead.query(
      `SELECT id FROM oficinas_regionales WHERE (nombre = 'Guerrero Negro' OR nombre LIKE '%Guerrero Negro%') LIMIT 1`
    ).catch(() => [[]]);
    if (!gnRows.length) {
      await poolOps.query(
        `INSERT INTO oficinas_regionales (region_id, municipio, nombre, activo)
         VALUES (?, 'Mulegé', 'Guerrero Negro', 1)`,
        [regMulegeId]
      ).catch(() => {});
    }

    // 1c-2. En la región de Los Cabos (LOS_CABOS), reemplazar cuarta oficina pendiente/genérica o insertar formalmente "SADER"
    //       para que las 4 oficinas de Los Cabos sean Guaymitas, Cangrejos, PEC Caribe y SADER (además de su comodín S/A).
    await poolOps.query(
      `UPDATE oficinas_regionales
       SET nombre = 'SADER', municipio = 'San José del Cabo', activo = 1
       WHERE region_id = ? AND (nombre LIKE '%Por definir%' OR nombre LIKE '%Oficina 2%' OR id = 3)`,
      [regLosCabosId]
    ).catch(() => {});

    const losCabosOficinasRequeridas = [
      { nombre: "Guaymitas", municipio: "San José del Cabo" },
      { nombre: "SADER", municipio: "San José del Cabo" },
      { nombre: "PEC Caribe", municipio: "Cabo San Lucas" },
      { nombre: "Cangrejos", municipio: "Cabo San Lucas" },
    ];
    for (const ofiLc of losCabosOficinasRequeridas) {
      const [lcCheck] = await poolRead.query(
        `SELECT id FROM oficinas_regionales WHERE region_id = ? AND UPPER(TRIM(nombre)) = UPPER(?) LIMIT 1`,
        [regLosCabosId, ofiLc.nombre]
      ).catch(() => [[]]);
      if (!lcCheck.length) {
        await poolOps.query(
          `INSERT INTO oficinas_regionales (region_id, municipio, nombre, activo)
           VALUES (?, ?, ?, 1)`,
          [regLosCabosId, ofiLc.municipio, ofiLc.nombre]
        ).catch(() => {});
      }
    }

    // 1c-bis. Asegurar oficina comodín "S/A (Sin Asignar)" en La Paz y en cada una de las regiones foráneas
    //         (LOS_CABOS, MULEGE y COMONDU_LORETO) para conservar la sumatoria regional.
    const regionesSaConfig = [
      { region_id: regLaPazId, municipio: "La Paz" },
      { region_id: regLosCabosId, municipio: "Los Cabos" },
      { region_id: regComonduId, municipio: "Comondú / Loreto" },
      { region_id: regMulegeId, municipio: "Mulegé" },
    ];
    for (const saCfg of regionesSaConfig) {
      const [saRegRows] = await poolRead.query(
        `SELECT id FROM oficinas_regionales WHERE region_id = ? AND nombre = 'S/A (Sin Asignar)' LIMIT 1`,
        [saCfg.region_id]
      ).catch(() => [[]]);
      if (!saRegRows.length) {
        await poolOps.query(
          `INSERT INTO oficinas_regionales (region_id, municipio, nombre, responsable_oficina, activo)
           VALUES (?, ?, 'S/A (Sin Asignar)', 'Por asignar', 1)`,
          [saCfg.region_id, saCfg.municipio]
        ).catch(() => {});
      } else {
        await poolOps.query(
          `UPDATE oficinas_regionales SET municipio = ?, activo = 1 WHERE id = ?`,
          [saCfg.municipio, saRegRows[0].id]
        ).catch(() => {});
      }
    }

    // 1c-ter. Asegurar oficina "Coordinación Regional La Paz" y "RM (Recursos Materiales)" en La Paz
    const [cRegLp] = await poolRead.query(
      `SELECT id FROM oficinas_regionales WHERE region_id = ? AND (nombre = 'Coordinación Regional La Paz' OR nombre = 'Coordinacion Regional La Paz' OR nombre LIKE '%Coordinación Regional%') LIMIT 1`,
      [regLaPazId]
    ).catch(() => [[]]);
    if (!cRegLp.length) {
      await poolOps.query(
        `INSERT INTO oficinas_regionales (region_id, municipio, nombre, responsable_oficina, activo)
         VALUES (?, 'La Paz', 'Coordinación Regional La Paz', 'Sandra Gpe. Salvatierra Amador', 1)`,
        [regLaPazId]
      ).catch(() => {});
    } else {
      await poolOps.query(
        `UPDATE oficinas_regionales SET nombre = 'Coordinación Regional La Paz', responsable_oficina = 'Sandra Gpe. Salvatierra Amador', municipio = 'La Paz', activo = 1 WHERE id = ?`,
        [cRegLp[0].id]
      ).catch(() => {});
    }

    const [rmOfi] = await poolRead.query(
      `SELECT id FROM oficinas_regionales WHERE region_id = ? AND (nombre = 'RM (Recursos Materiales)' OR nombre = 'RM' OR nombre LIKE '%Recursos Materiales%') LIMIT 1`,
      [regLaPazId]
    ).catch(() => [[]]);
    if (!rmOfi.length) {
      await poolOps.query(
        `INSERT INTO oficinas_regionales (region_id, municipio, nombre, responsable_oficina, activo)
         VALUES (?, 'La Paz', 'RM (Recursos Materiales)', 'Jorge Luis Patrón Murillo', 1)`,
        [regLaPazId]
      ).catch(() => {});
    } else {
      await poolOps.query(
        `UPDATE oficinas_regionales SET nombre = 'RM (Recursos Materiales)', responsable_oficina = 'Jorge Luis Patrón Murillo', municipio = 'La Paz', activo = 1 WHERE id = ?`,
        [rmOfi[0].id]
      ).catch(() => {});
    }

    // 1c-cuat. Limpieza automática de vehículos (rubro_id = 2) asignados a oficinas comodín "S/A" o "Sin Asignar"
    await poolOps.query(
      `DELETE io FROM inventario_oficina io
       JOIN oficinas_regionales ofi ON io.oficina_id = ofi.id
       WHERE io.rubro_id = 2
         AND (ofi.nombre LIKE '%S/A%' OR ofi.nombre LIKE '%Sin Asignar%')
         AND io.id NOT IN (SELECT DISTINCT articulo_id FROM vales_prestamo_detalle WHERE articulo_id IS NOT NULL);`
    ).catch(() => {});

    // 1d. Asegurar columnas origen_adquisicion, observaciones_control y stock_minimo en productos y almacén
    const [prodCols] = await poolRead.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'productos'`,
      [DB_NAME]
    ).catch(() => [[]]);
    const prodColNames = new Set(prodCols.map((c) => String(c.COLUMN_NAME || "").toLowerCase()));
    if (!prodColNames.has("origen_adquisicion")) {
      await poolOps.query(`ALTER TABLE productos ADD COLUMN origen_adquisicion ENUM('COMPRA_DELEGACION','POR_CONTRATO','OTRO') NOT NULL DEFAULT 'COMPRA_DELEGACION'`).catch(() => {});
    }
    if (!prodColNames.has("observaciones_control")) {
      await poolOps.query(`ALTER TABLE productos ADD COLUMN observaciones_control TEXT DEFAULT NULL`).catch(() => {});
    }
    if (!prodColNames.has("stock_minimo")) {
      await poolOps.query(`ALTER TABLE productos ADD COLUMN stock_minimo INT(11) DEFAULT 0`).catch(() => {});
    }

    const [almCols] = await poolRead.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'almacen_dregcivil'`,
      [DB_NAME]
    ).catch(() => [[]]);
    const almColNames = new Set(almCols.map((c) => String(c.COLUMN_NAME || "").toLowerCase()));
    if (!almColNames.has("origen_adquisicion")) {
      await poolOps.query(`ALTER TABLE almacen_dregcivil ADD COLUMN origen_adquisicion ENUM('COMPRA_DELEGACION','POR_CONTRATO','OTRO') NOT NULL DEFAULT 'COMPRA_DELEGACION'`).catch(() => {});
    }
    if (!almColNames.has("observaciones_control")) {
      await poolOps.query(`ALTER TABLE almacen_dregcivil ADD COLUMN observaciones_control TEXT DEFAULT NULL`).catch(() => {});
    }
    if (!almColNames.has("stock_minimo")) {
      await poolOps.query(`ALTER TABLE almacen_dregcivil ADD COLUMN stock_minimo INT(11) DEFAULT 0`).catch(() => {});
    }

    const [invCols] = await poolRead.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'inventario_oficina'`,
      [DB_NAME]
    ).catch(() => [[]]);
    const invColNames = new Set(invCols.map((c) => String(c.COLUMN_NAME || "").toLowerCase()));
    if (!invColNames.has("origen_adquisicion")) {
      await poolOps.query(`ALTER TABLE inventario_oficina ADD COLUMN origen_adquisicion ENUM('COMPRA_DELEGACION','POR_CONTRATO','OTRO') NOT NULL DEFAULT 'COMPRA_DELEGACION'`).catch(() => {});
    }
    if (!invColNames.has("observaciones_control")) {
      await poolOps.query(`ALTER TABLE inventario_oficina ADD COLUMN observaciones_control TEXT DEFAULT NULL`).catch(() => {});
    }
    if (!invColNames.has("cantidad_disponible")) {
      await poolOps.query(`ALTER TABLE inventario_oficina ADD COLUMN cantidad_disponible INT(11) NOT NULL DEFAULT 0`).catch(() => {});
      await poolOps.query(`UPDATE inventario_oficina SET cantidad_disponible = cantidad_propia WHERE cantidad_disponible = 0 AND cantidad_propia > 0`).catch(() => {});
    }
    if (!invColNames.has("es_bodega_delegacion")) {
      await poolOps.query(`ALTER TABLE inventario_oficina ADD COLUMN es_bodega_delegacion TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {});
    }
    if (!invColNames.has("marca")) {
      await poolOps.query(`ALTER TABLE inventario_oficina ADD COLUMN marca VARCHAR(100) DEFAULT NULL`).catch(() => {});
    }
    if (!invColNames.has("modelo")) {
      await poolOps.query(`ALTER TABLE inventario_oficina ADD COLUMN modelo VARCHAR(100) DEFAULT NULL`).catch(() => {});
    }
    if (!invColNames.has("color")) {
      await poolOps.query(`ALTER TABLE inventario_oficina ADD COLUMN color VARCHAR(50) DEFAULT NULL`).catch(() => {});
    }
    if (!invColNames.has("serie")) {
      await poolOps.query(`ALTER TABLE inventario_oficina ADD COLUMN serie VARCHAR(100) DEFAULT NULL`).catch(() => {});
    }
    if (!invColNames.has("numero_serie")) {
      await poolOps.query(`ALTER TABLE inventario_oficina ADD COLUMN numero_serie VARCHAR(100) DEFAULT NULL`).catch(() => {});
    }
    if (!invColNames.has("placas")) {
      await poolOps.query(`ALTER TABLE inventario_oficina ADD COLUMN placas VARCHAR(50) DEFAULT NULL`).catch(() => {});
    }
    if (!invColNames.has("anio")) {
      await poolOps.query(`ALTER TABLE inventario_oficina ADD COLUMN anio INT(11) DEFAULT NULL`).catch(() => {});
    }
    if (!invColNames.has("municipio")) {
      await poolOps.query(`ALTER TABLE inventario_oficina ADD COLUMN municipio VARCHAR(100) DEFAULT NULL`).catch(() => {});
    }

    // 1e. Asegurar oficialías para todos los departamentos y enlaces regionales si no existen
    const oficialiasToEnsure = [
      { id: 30030001, nombre: "Recursos Materiales", responsable: "Jorge Luis Patrón Murillo" },
      { id: 30030002, nombre: "Recursos Humanos", responsable: "Jonathan Alain Olachea Noriega" },
      { id: 30030003, nombre: "Informática", responsable: "Víctor Manuel Higuera Ruiz" },
      { id: 30030004, nombre: "Niñas y Niños", responsable: "María de los Ángeles Valenzuela López" },
      { id: 30030005, nombre: "Salud Casa por Casa", responsable: "Juan Carlos Cuadros Espinoza" },
      { id: 30030006, nombre: "Comunicación Social", responsable: "Ericka Peralta Preciado" },
      { id: 30030007, nombre: "Programa de Adulto Mayor", responsable: "Elizabeth González Wendy" },
      { id: 30030008, nombre: "Encargado de Inventario", responsable: "Gabriel Adan Fiol Collins" },
      { id: 30030009, nombre: "Enlace Regional Los Cabos", responsable: "Enlace Regional Los Cabos" },
      { id: 30030010, nombre: "Enlace Regional Mulegé", responsable: "Diana Ramirez Hernandez" },
      { id: 30030011, nombre: "Enlace Regional Comondú / Loreto", responsable: "Enlace Regional Comondú / Loreto" },
      { id: 30030012, nombre: "Asuntos Jurídicos", responsable: "Mayra Cruz Salazar Escobosa" },
      { id: 30030013, nombre: "Jóvenes Construyendo el Futuro", responsable: "Juan Daniel Carrera Villaseca" },
      { id: 30030014, nombre: "Programa de Discapacidad", responsable: "Olga Camarillo Martínez" },
      { id: 30030015, nombre: "Dirección Regional La Paz", responsable: "Sandra Guadalupe Salvatierra Amador" },
    ];
    for (const ofi of oficialiasToEnsure) {
      await poolOps.query(
        `INSERT INTO oficialias (id, id_tipo_oficialia, id_municipio, id_localidad, nombre, activo, oficial_reponsable, id_oficialia)
         VALUES (?, 0, 0, 0, ?, b'1', ?, ?)
         ON DUPLICATE KEY UPDATE
           nombre = VALUES(nombre),
           activo = b'1',
           oficial_reponsable = VALUES(oficial_reponsable),
           id_oficialia = VALUES(id_oficialia)`,
        [ofi.id, ofi.nombre, ofi.responsable, ofi.id]
      ).catch(() => {});
    }

    // 2. Asegurar columnas de firma digital regional en tabla solicitudes
    const [sCols] = await poolRead.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'solicitudes'`,
      [DB_NAME]
    );
    const sColNames = new Set(sCols.map((c) => String(c.COLUMN_NAME || "").toLowerCase()));
    const requiredSolCols = [
      { name: "region_solicitante", ddl: "VARCHAR(50) DEFAULT NULL" },
      { name: "nombre_solicitante_firma", ddl: "VARCHAR(150) DEFAULT NULL" },
      { name: "firma_solicitante_data", ddl: "LONGTEXT DEFAULT NULL" },
      { name: "fecha_firma_digital", ddl: "DATETIME DEFAULT NULL" },
      { name: "folio_firma_digital", ddl: "VARCHAR(80) DEFAULT NULL" },
      { name: "archivo_respaldo", ddl: "VARCHAR(255) DEFAULT NULL" },
    ];
    for (const col of requiredSolCols) {
      if (!sColNames.has(col.name)) {
        await poolOps.query(`ALTER TABLE solicitudes ADD COLUMN ${qi(col.name)} ${col.ddl}`).catch(() => {});
      }
    }

    // 3. Crear o vincular los 4 usuarios encargados de Inventario Regional (contraseña inicial: secreta123)
    const defaultHash = await bcrypt.hash("secreta123", 10);
    const encargadosToEnsure = [
      REGIONAL_ENCARGADOS_MAP.gabrielfiol,
      REGIONAL_ENCARGADOS_MAP.evelia,
      REGIONAL_ENCARGADOS_MAP.jesus,
      REGIONAL_ENCARGADOS_MAP.luiseduardo,
    ];

    for (const enc of encargadosToEnsure) {
      const [existing] = await poolRead.query(
        `SELECT id, username, psw, rubro_id FROM usuario WHERE username = ? LIMIT 1`,
        [enc.username]
      );
      if (existing.length) {
        const row = existing[0];
        const hasValidPass = row.psw && String(row.psw).trim().length > 0;
        await poolOps.query(
          `UPDATE usuario
           SET nombre = COALESCE(NULLIF(nombre, ''), ?),
               PRIMER_APELLIDO = COALESCE(NULLIF(PRIMER_APELLIDO, ''), ?),
               SEGUNDO_APELLIDO = COALESCE(NULLIF(SEGUNDO_APELLIDO, ''), ?),
               ID_OFICIALIA = COALESCE(ID_OFICIALIA, ?),
               OFICIALIA_ID = COALESCE(OFICIALIA_ID, ?),
               ACTIVO = b'1',
               rol = 'ENCARGADO',
               departamento = COALESCE(NULLIF(departamento, ''), ?),
               rubro_id = ?,
               psw = ?
           WHERE id = ?`,
          [
            enc.nombre,
            enc.primer_ap,
            enc.segundo_ap,
            enc.id_oficialia,
            enc.id_oficialia,
            enc.departamento,
            enc.rubro_id,
            hasValidPass ? row.psw : defaultHash,
            row.id,
          ]
        ).catch(() => {});
      } else {
        // Calcular un ID libre si enc.id estuviera ocupado por otro usuario
        const [idCheck] = await poolRead.query(`SELECT id FROM usuario WHERE id = ? LIMIT 1`, [enc.id]);
        let targetId = enc.id;
        if (idCheck.length) {
          const [[maxRow]] = await poolRead.query(`SELECT COALESCE(MAX(id), 10) + 1 AS next_id FROM usuario`);
          targetId = Number(maxRow?.next_id || 10);
        }
        await poolOps.query(
          `INSERT INTO usuario
             (id, username, psw, nombre, PRIMER_APELLIDO, SEGUNDO_APELLIDO, ID_OFICIALIA, OFICIALIA_ID, ACTIVO, rol, FECHA_ALTA, departamento, rubro_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, b'1', 'ENCARGADO', NOW(), ?, ?)`,
          [
            targetId,
            enc.username,
            defaultHash,
            enc.nombre,
            enc.primer_ap,
            enc.segundo_ap,
            enc.id_oficialia,
            enc.id_oficialia,
            enc.departamento,
            enc.rubro_id,
          ]
        ).catch(() => {});
      }
    }

    // Vincular también usuario 'encargado' si existe con rubro_id = 1
    await poolOps.query(`UPDATE usuario SET rubro_id = 1 WHERE username = 'encargado' AND rubro_id IS NULL`).catch(() => {});

    // 4. Asegurar usuarios regionales de prueba: 'loscabos' y 'mulege' (contraseña inicial: secreta123)
    const [[regLosCabos]] = await poolRead.query(`SELECT id FROM regiones WHERE clave = 'LOS_CABOS' LIMIT 1`).catch(() => [[{ id: 2 }]]);
    const [[regMulege]] = await poolRead.query(`SELECT id FROM regiones WHERE clave = 'MULEGE' LIMIT 1`).catch(() => [[{ id: 4 }]]);
    const [[ofiLosCabos]] = await poolRead.query(`SELECT id FROM oficinas_regionales WHERE region_id = ? LIMIT 1`, [regLosCabos?.id || 2]).catch(() => [[{ id: 2 }]]);
    const [[ofiMulege]] = await poolRead.query(`SELECT id FROM oficinas_regionales WHERE region_id = ? LIMIT 1`, [regMulege?.id || 4]).catch(() => [[{ id: 9 }]]);

    const enlacesToEnsure = [
      {
        id: 8,
        username: "loscabos",
        nombre: "Enlace Regional",
        primer_ap: "Los Cabos",
        segundo_ap: "",
        id_oficialia: 30030009,
        departamento: "Enlace Regional Los Cabos",
        region_id: regLosCabos?.id || 2,
        oficina_id: ofiLosCabos?.id || 2,
      },
      {
        id: 9,
        username: "mulege",
        nombre: "Diana Ramirez Hernandez",
        primer_ap: "Ramirez",
        segundo_ap: "Hernandez",
        id_oficialia: 30030010,
        departamento: "Enlace Regional Mulegé",
        region_id: regMulege?.id || 4,
        oficina_id: ofiMulege?.id || 9,
      },
    ];

    for (const enl of enlacesToEnsure) {
      const [existingEnl] = await poolRead.query(`SELECT id, username, psw, region_id FROM usuario WHERE username = ? LIMIT 1`, [enl.username]);
      if (existingEnl.length) {
        const row = existingEnl[0];
        const hasValidPass = row.psw && String(row.psw).trim().length > 0;
        await poolOps.query(
          `UPDATE usuario
           SET nombre = ?,
               PRIMER_APELLIDO = ?,
               SEGUNDO_APELLIDO = ?,
               ID_OFICIALIA = ?,
               OFICIALIA_ID = ?,
               ACTIVO = b'1',
               rol = 'USUARIO',
               departamento = ?,
               region_id = ?,
               oficina_id = ?,
               psw = ?
           WHERE id = ?`,
          [
            enl.nombre,
            enl.primer_ap,
            enl.segundo_ap,
            enl.id_oficialia,
            enl.id_oficialia,
            enl.departamento,
            enl.region_id,
            enl.oficina_id,
            hasValidPass ? row.psw : defaultHash,
            row.id,
          ]
        ).catch(() => {});
      } else {
        const [idCheck] = await poolRead.query(`SELECT id FROM usuario WHERE id = ? LIMIT 1`, [enl.id]);
        let targetId = enl.id;
        if (idCheck.length) {
          const [[maxRow]] = await poolRead.query(`SELECT COALESCE(MAX(id), 12) + 1 AS next_id FROM usuario`);
          targetId = Number(maxRow?.next_id || 12);
        }
        await poolOps.query(
          `INSERT INTO usuario
             (id, username, psw, nombre, PRIMER_APELLIDO, SEGUNDO_APELLIDO, ID_OFICIALIA, OFICIALIA_ID, ACTIVO, rol, FECHA_ALTA, departamento, rubro_id, region_id, oficina_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, b'1', 'USUARIO', NOW(), ?, NULL, ?, ?)`,
          [
            targetId,
            enl.username,
            defaultHash,
            enl.nombre,
            enl.primer_ap,
            enl.segundo_ap,
            enl.id_oficialia,
            enl.id_oficialia,
            enl.departamento,
            enl.region_id,
            enl.oficina_id,
          ]
        ).catch(() => {});
      }
    }

    // 5. Garantizar que todos los usuarios tengan su departamento/oficialía asignado en la BD
    await poolOps.query(
      `UPDATE usuario
       SET ID_OFICIALIA = 30030009, OFICIALIA_ID = 30030009, departamento = 'Enlace Regional Los Cabos'
       WHERE (username = 'loscabos' OR region_id = 2) AND (ID_OFICIALIA IS NULL OR ID_OFICIALIA = 0)`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE usuario
       SET ID_OFICIALIA = 30030010, OFICIALIA_ID = 30030010, departamento = 'Enlace Regional Mulegé'
       WHERE (username = 'mulege' OR region_id = 4) AND (ID_OFICIALIA IS NULL OR ID_OFICIALIA = 0)`
    ).catch(() => {});

    // Asegurar formalización de Diana Ramirez Hernandez como enlace regional de Mulegé en usuario, oficialias y regiones
    await poolOps.query(
      `UPDATE usuario
       SET nombre = 'Diana Ramirez Hernandez', PRIMER_APELLIDO = 'Ramirez', SEGUNDO_APELLIDO = 'Hernandez'
       WHERE username = 'mulege'`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE oficialias
       SET oficial_reponsable = 'Diana Ramirez Hernandez'
       WHERE id = 30030010`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE regiones
       SET responsable_regional = 'Diana Ramirez Hernandez'
       WHERE clave = 'MULEGE' OR id = 4`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE usuario
       SET ID_OFICIALIA = 30030011, OFICIALIA_ID = 30030011, departamento = 'Enlace Regional Comondú / Loreto'
       WHERE region_id = 3 AND (ID_OFICIALIA IS NULL OR ID_OFICIALIA = 0)`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE usuario
       SET ID_OFICIALIA = 30030001, OFICIALIA_ID = 30030001, departamento = 'Recursos Materiales'
       WHERE username IN ('evelia', 'jesus', 'luiseduardo') AND (ID_OFICIALIA IS NULL OR ID_OFICIALIA = 0)`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE usuario
       SET ID_OFICIALIA = 30030001, OFICIALIA_ID = 30030001, departamento = 'Recursos Materiales'
       WHERE (ID_OFICIALIA IS NULL OR ID_OFICIALIA = 0) AND username NOT IN ('rodrigo')`
    ).catch(() => {});

    // 5b. Asegurar usuarios Rodrigo Molina Cosio ('rodrigo') y Jorge Luis Patrón Murillo ('jorge')
    //     con contraseña inicial homologada ('secreta123' encriptada con bcrypt, igual que los demás encargados)
    const directivosEstatalToEnsure = [
      {
        username: "rodrigo",
        nombre: "Rodrigo",
        primer_ap: "Molina",
        segundo_ap: "Cosio",
        id_oficialia: 30030001,
        departamento: "Enlace del programa 'La Clínica es Nuestra'",
        cargo: "Enlace del programa 'La Clínica es Nuestra'",
      },
      {
        username: "jorge",
        nombre: "Jorge Luis",
        primer_ap: "Patrón",
        segundo_ap: "Murillo",
        id_oficialia: 30030001,
        departamento: "Encargado de Recursos Materiales",
        cargo: "Encargado de Recursos Materiales",
      },
    ];

    for (const dir of directivosEstatalToEnsure) {
      const [existingDir] = await poolRead.query(
        `SELECT id, username, psw FROM usuario WHERE username = ? LIMIT 1`,
        [dir.username]
      ).catch(() => [[]]);

      if (existingDir && existingDir.length) {
        await poolOps.query(
          `UPDATE usuario
           SET nombre = ?,
               PRIMER_APELLIDO = ?,
               SEGUNDO_APELLIDO = ?,
               ID_OFICIALIA = COALESCE(ID_OFICIALIA, ?),
               OFICIALIA_ID = COALESCE(OFICIALIA_ID, ?),
               ACTIVO = b'1',
               rol = 'ENCARGADO',
               departamento = ?,
               cargo = ?,
               psw = ?
           WHERE username = ?`,
          [
            dir.nombre,
            dir.primer_ap,
            dir.segundo_ap,
            dir.id_oficialia,
            dir.id_oficialia,
            dir.departamento,
            dir.cargo,
            defaultHash,
            dir.username,
          ]
        ).catch(async () => {
          await poolOps.query(
            `UPDATE usuario
             SET nombre = ?,
                 PRIMER_APELLIDO = ?,
                 SEGUNDO_APELLIDO = ?,
                 ID_OFICIALIA = COALESCE(ID_OFICIALIA, ?),
                 OFICIALIA_ID = COALESCE(OFICIALIA_ID, ?),
                 ACTIVO = b'1',
                 rol = 'ENCARGADO',
                 departamento = ?,
                 psw = ?
             WHERE username = ?`,
            [
              dir.nombre,
              dir.primer_ap,
              dir.segundo_ap,
              dir.id_oficialia,
              dir.id_oficialia,
              dir.departamento,
              defaultHash,
              dir.username,
            ]
          ).catch(() => {});
        });
      } else {
        const [[maxRow]] = await poolRead.query(`SELECT COALESCE(MAX(id), 10) + 1 AS next_id FROM usuario`).catch(() => [[{ next_id: 11 }]]);
        const nextId = Number(maxRow?.next_id || 11);
        await poolOps.query(
          `INSERT INTO usuario
             (id, username, psw, nombre, PRIMER_APELLIDO, SEGUNDO_APELLIDO, ID_OFICIALIA, OFICIALIA_ID, ACTIVO, rol, FECHA_ALTA, departamento, cargo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, b'1', 'ENCARGADO', NOW(), ?, ?)`,
          [
            nextId,
            dir.username,
            defaultHash,
            dir.nombre,
            dir.primer_ap,
            dir.segundo_ap,
            dir.id_oficialia,
            dir.id_oficialia,
            dir.departamento,
            dir.cargo,
          ]
        ).catch(async () => {
          await poolOps.query(
            `INSERT INTO usuario
               (id, username, psw, nombre, PRIMER_APELLIDO, SEGUNDO_APELLIDO, ID_OFICIALIA, OFICIALIA_ID, ACTIVO, rol, FECHA_ALTA, departamento)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, b'1', 'ENCARGADO', NOW(), ?)`,
            [
              nextId,
              dir.username,
              defaultHash,
              dir.nombre,
              dir.primer_ap,
              dir.segundo_ap,
              dir.id_oficialia,
              dir.id_oficialia,
              dir.departamento,
            ]
          ).catch(() => {});
        });
      }
    }

    // Actualización explícita del cargo y departamento de Rodrigo Molina Cosio
    await poolOps.query(
      `UPDATE usuario 
       SET departamento = 'Enlace del programa \\'La Clínica es Nuestra\\'', 
           cargo = 'Enlace del programa \\'La Clínica es Nuestra\\'' 
       WHERE username = 'rodrigo'`
    ).catch(async () => {
      await poolOps.query(
        `UPDATE usuario 
         SET departamento = 'Enlace del programa \\'La Clínica es Nuestra\\'' 
         WHERE username = 'rodrigo'`
      ).catch(() => {});
    });

    await poolOps.query(
      `UPDATE usuarios 
       SET departamento = 'Enlace del programa \\'La Clínica es Nuestra\\'', 
           cargo = 'Enlace del programa \\'La Clínica es Nuestra\\'' 
       WHERE username = 'rodrigo'`
    ).catch(async () => {
      await poolOps.query(
        `UPDATE usuarios 
         SET departamento = 'Enlace del programa \\'La Clínica es Nuestra\\'' 
         WHERE username = 'rodrigo'`
      ).catch(() => {});
    });

    // 5c. Creación de usuarios faltantes (Región Comondú y Jefes de Departamento) sin duplicar
    //     NOTA: No se crea usuario para Recursos Humanos porque ya existe (id_oficialia 30030002).
    const [[ofiComonduRow]] = await poolRead.query(
      `SELECT id FROM oficinas_regionales WHERE region_id = ? AND nombre <> 'S/A (Sin Asignar)' ORDER BY id ASC LIMIT 1`,
      [regComonduId]
    ).catch(() => [[{ id: 6 }]]);
    const ofiComonduId = ofiComonduRow?.id || 6;

    const [[ofiLaPazRow]] = await poolRead.query(
      `SELECT id FROM oficinas_regionales WHERE region_id = ? AND nombre <> 'S/A (Sin Asignar)' ORDER BY id ASC LIMIT 1`,
      [regLaPazId]
    ).catch(() => [[{ id: 1 }]]);
    const ofiLaPazPrincipalId = ofiLaPazRow?.id || 1;

    const missingUsersToEnsure = [
      // Enlace Regional Faltante (rol: 'regional')
      {
        username: "comondu",
        nombre: "Enlace Regional Comondú / Loreto",
        primer_ap: "",
        segundo_ap: "",
        rol: "regional",
        id_oficialia: 30030011,
        departamento: "Enlace Regional Comondú / Loreto",
        cargo: "Enlace Regional Comondú / Loreto",
        region_id: regComonduId,
        oficina_id: ofiComonduId,
      },
      // Usuarios de Departamentos (rol: 'departamento')
      {
        username: "informatica",
        nombre: "Víctor Manuel Higuera Ruiz",
        primer_ap: "Higuera",
        segundo_ap: "Ruiz",
        rol: "departamento",
        id_oficialia: 30030003,
        departamento: "Informática",
        cargo: "Informática",
        region_id: regLaPazId,
        oficina_id: ofiLaPazPrincipalId,
      },
      {
        username: "comunicacionsocial",
        nombre: "Ericka Peralta Preciado",
        primer_ap: "Peralta",
        segundo_ap: "Preciado",
        rol: "departamento",
        id_oficialia: 30030006,
        departamento: "Comunicación Social",
        cargo: "Comunicación Social",
        region_id: regLaPazId,
        oficina_id: ofiLaPazPrincipalId,
      },
      {
        username: "saludcasaporcasa",
        nombre: "Juan Carlos Cuadros Espinoza",
        primer_ap: "Cuadros",
        segundo_ap: "Espinoza",
        rol: "departamento",
        id_oficialia: 30030005,
        departamento: "Salud Casa por Casa",
        cargo: "Salud Casa por Casa",
        region_id: regLaPazId,
        oficina_id: ofiLaPazPrincipalId,
      },
      {
        username: "asuntosjuridicos",
        nombre: "Mayra Cruz Salazar Escobosa",
        primer_ap: "Salazar",
        segundo_ap: "Escobosa",
        rol: "departamento",
        id_oficialia: 30030012,
        departamento: "Asuntos Jurídicos",
        cargo: "Asuntos Jurídicos",
        region_id: regLaPazId,
        oficina_id: ofiLaPazPrincipalId,
      },
      {
        username: "ninasyninos",
        nombre: "María de los Ángeles Valenzuela López",
        primer_ap: "Valenzuela",
        segundo_ap: "López",
        rol: "departamento",
        id_oficialia: 30030004,
        departamento: "Niñas y Niños",
        cargo: "Niñas y Niños",
        region_id: regLaPazId,
        oficina_id: ofiLaPazPrincipalId,
      },
      {
        username: "jovenes",
        nombre: "Juan Daniel Carrera Villaseca",
        primer_ap: "Carrera",
        segundo_ap: "Villaseca",
        rol: "departamento",
        id_oficialia: 30030013,
        departamento: "Jóvenes Construyendo el Futuro",
        cargo: "Jóvenes Construyendo el Futuro",
        region_id: regLaPazId,
        oficina_id: ofiLaPazPrincipalId,
      },
      {
        username: "discapacidad",
        nombre: "Olga Camarillo Martínez",
        primer_ap: "Camarillo",
        segundo_ap: "Martínez",
        rol: "departamento",
        id_oficialia: 30030014,
        departamento: "Programa de Discapacidad",
        cargo: "Programa de Discapacidad",
        region_id: regLaPazId,
        oficina_id: ofiLaPazPrincipalId,
      },
      {
        username: "adultomayor",
        nombre: "Elizabeth González Wendy",
        primer_ap: "González",
        segundo_ap: "Wendy",
        rol: "departamento",
        id_oficialia: 30030007,
        departamento: "Programa de Adulto Mayor",
        cargo: "Programa de Adulto Mayor",
        region_id: regLaPazId,
        oficina_id: ofiLaPazPrincipalId,
      },
      {
        username: "direccionregional",
        nombre: "Sandra Guadalupe Salvatierra Amador",
        primer_ap: "Salvatierra",
        segundo_ap: "Amador",
        rol: "departamento",
        id_oficialia: 30030015,
        departamento: "Dirección Regional La Paz",
        cargo: "Dirección Regional La Paz",
        region_id: regLaPazId,
        oficina_id: ofiLaPazPrincipalId,
      },
    ];

    for (const usr of missingUsersToEnsure) {
      // Verificar existencia previa antes de insertar para evitar duplicados
      const [existingUsr] = await poolRead.query(
        `SELECT id, username, psw FROM usuario WHERE username = ? LIMIT 1`,
        [usr.username]
      ).catch(() => [[]]);

      if (existingUsr && existingUsr.length) {
        const row = existingUsr[0];
        const hasValidPass = row.psw && String(row.psw).trim().length > 0;
        await poolOps.query(
          `UPDATE usuario
           SET nombre = ?,
               PRIMER_APELLIDO = ?,
               SEGUNDO_APELLIDO = ?,
               ID_OFICIALIA = ?,
               OFICIALIA_ID = ?,
               ACTIVO = b'1',
               rol = ?,
               departamento = ?,
               cargo = ?,
               region_id = ?,
               oficina_id = ?,
               psw = ?
           WHERE id = ?`,
          [
            usr.nombre,
            usr.primer_ap,
            usr.segundo_ap,
            usr.id_oficialia,
            usr.id_oficialia,
            usr.rol,
            usr.departamento,
            usr.cargo,
            usr.region_id,
            usr.oficina_id,
            hasValidPass ? row.psw : defaultHash,
            row.id,
          ]
        ).catch(async () => {
          await poolOps.query(
            `UPDATE usuario
             SET nombre = ?,
                 PRIMER_APELLIDO = ?,
                 SEGUNDO_APELLIDO = ?,
                 ID_OFICIALIA = ?,
                 OFICIALIA_ID = ?,
                 ACTIVO = b'1',
                 rol = 'USUARIO',
                 departamento = ?,
                 region_id = ?,
                 oficina_id = ?,
                 psw = ?
             WHERE id = ?`,
            [
              usr.nombre,
              usr.primer_ap,
              usr.segundo_ap,
              usr.id_oficialia,
              usr.id_oficialia,
              usr.departamento,
              usr.region_id,
              usr.oficina_id,
              hasValidPass ? row.psw : defaultHash,
              row.id,
            ]
          ).catch(() => {});
        });
      } else {
        const [[maxRow]] = await poolRead.query(
          `SELECT COALESCE(MAX(id), 12) + 1 AS next_id FROM usuario`
        ).catch(() => [[{ next_id: 13 }]]);
        const nextId = Number(maxRow?.next_id || 13);
        await poolOps.query(
          `INSERT INTO usuario
             (id, username, psw, nombre, PRIMER_APELLIDO, SEGUNDO_APELLIDO, ID_OFICIALIA, OFICIALIA_ID, ACTIVO, rol, FECHA_ALTA, departamento, cargo, rubro_id, region_id, oficina_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, b'1', ?, NOW(), ?, ?, NULL, ?, ?)`,
          [
            nextId,
            usr.username,
            defaultHash,
            usr.nombre,
            usr.primer_ap,
            usr.segundo_ap,
            usr.id_oficialia,
            usr.id_oficialia,
            usr.rol,
            usr.departamento,
            usr.cargo,
            usr.region_id,
            usr.oficina_id,
          ]
        ).catch(async () => {
          await poolOps.query(
            `INSERT INTO usuario
               (id, username, psw, nombre, PRIMER_APELLIDO, SEGUNDO_APELLIDO, ID_OFICIALIA, OFICIALIA_ID, ACTIVO, rol, FECHA_ALTA, departamento, rubro_id, region_id, oficina_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, b'1', 'USUARIO', NOW(), ?, NULL, ?, ?)`,
            [
              nextId,
              usr.username,
              defaultHash,
              usr.nombre,
              usr.primer_ap,
              usr.segundo_ap,
              usr.id_oficialia,
              usr.id_oficialia,
              usr.departamento,
              usr.region_id,
              usr.oficina_id,
            ]
          ).catch(() => {});
        });
      }
    }

    // 6. Asegurar tablas de Vales Provisionales (Préstamo de Material/Equipo para Operativos)
    await poolOps.query(
      `CREATE TABLE IF NOT EXISTS vales_prestamo (
        id INT(11) NOT NULL AUTO_INCREMENT,
        folio VARCHAR(30) NOT NULL,
        rubro_id INT(11) NOT NULL,
        departamento_id INT(11) NOT NULL,
        departamento_nombre VARCHAR(150) DEFAULT NULL,
        solicitante_nombre VARCHAR(150) NOT NULL,
        solicitante_cargo VARCHAR(150) DEFAULT NULL,
        solicitante_telefono VARCHAR(50) DEFAULT NULL,
        operativo_nombre VARCHAR(255) NOT NULL,
        lugar_comision VARCHAR(255) NOT NULL,
        fecha_salida DATE NOT NULL,
        fecha_devolucion_estimada DATE DEFAULT NULL,
        tipo_firmas TINYINT(1) NOT NULL DEFAULT 2,
        es_indefinido TINYINT(1) NOT NULL DEFAULT 0,
        recibe_nombre VARCHAR(180) DEFAULT NULL,
        recibe_cargo VARCHAR(180) DEFAULT NULL,
        fecha_devolucion_real DATETIME DEFAULT NULL,
        estado ENUM('SOLICITADO','AUTORIZADO_EN_PRESTAMO','DEVUELTO','CANCELADO') NOT NULL DEFAULT 'SOLICITADO',
        encargado_entrega VARCHAR(150) DEFAULT NULL,
        encargado_recibe_devolucion VARCHAR(150) DEFAULT NULL,
        observaciones_prestamo TEXT DEFAULT NULL,
        observaciones_devolucion TEXT DEFAULT NULL,
        usuario_id INT(11) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY ux_vales_folio (folio),
        KEY idx_vales_rubro (rubro_id),
        KEY idx_vales_depto (departamento_id),
        KEY idx_vales_usuario (usuario_id),
        KEY idx_vales_estado (estado)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    ).catch(() => {});

    // Modificaciones aditivas y seguras para vales_prestamo en producción
    await poolOps.query(`ALTER TABLE vales_prestamo MODIFY COLUMN fecha_devolucion_estimada DATE NULL`).catch(() => {});

    const [vpCols] = await poolRead.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'vales_prestamo'`,
      [DB_NAME]
    ).catch(() => [[]]);
    const vpColNames = new Set(vpCols.map((c) => String(c.COLUMN_NAME || "").toLowerCase()));

    if (!vpColNames.has("tipo_firmas")) {
      await poolOps.query(`ALTER TABLE vales_prestamo ADD COLUMN tipo_firmas TINYINT(1) NOT NULL DEFAULT 2`).catch(() => {});
    }
    if (!vpColNames.has("es_indefinido")) {
      await poolOps.query(`ALTER TABLE vales_prestamo ADD COLUMN es_indefinido TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {});
    }
    if (!vpColNames.has("recibe_nombre")) {
      await poolOps.query(`ALTER TABLE vales_prestamo ADD COLUMN recibe_nombre VARCHAR(180) DEFAULT NULL`).catch(() => {});
    }
    if (!vpColNames.has("recibe_cargo")) {
      await poolOps.query(`ALTER TABLE vales_prestamo ADD COLUMN recibe_cargo VARCHAR(180) DEFAULT NULL`).catch(() => {});
    }
    if (!vpColNames.has("fecha_devolucion_real")) {
      await poolOps.query(`ALTER TABLE vales_prestamo ADD COLUMN fecha_devolucion_real DATETIME DEFAULT NULL`).catch(() => {});
    }
    if (!vpColNames.has("archivo_pdf_firmado")) {
      await poolOps.query(`ALTER TABLE vales_prestamo ADD COLUMN archivo_pdf_firmado VARCHAR(255) DEFAULT NULL`).catch(() => {});
    }

    await poolOps.query(
      `CREATE TABLE IF NOT EXISTS vales_prestamo_detalle (
        id INT(11) NOT NULL AUTO_INCREMENT,
        vale_id INT(11) NOT NULL,
        articulo_id INT(11) DEFAULT NULL,
        clave VARCHAR(60) DEFAULT NULL,
        descripcion VARCHAR(255) NOT NULL,
        serie VARCHAR(100) DEFAULT NULL,
        marca VARCHAR(100) DEFAULT NULL,
        modelo VARCHAR(100) DEFAULT NULL,
        color VARCHAR(50) DEFAULT NULL,
        cantidad INT(11) NOT NULL DEFAULT 1,
        estado_salida VARCHAR(100) NOT NULL DEFAULT 'BUEN ESTADO',
        estado_devolucion VARCHAR(100) NOT NULL DEFAULT 'PENDIENTE',
        observaciones TEXT DEFAULT NULL,
        PRIMARY KEY (id),
        KEY idx_vpd_vale (vale_id),
        KEY idx_vpd_art (articulo_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    ).catch(() => {});

    // Sincronizar Almacén General (Gabriel Fiol) con Inventario Regional Delegación La Paz Rubro 1
    await syncAlmacenCentralToInventarioRegional(poolOps);

    SCHEMA_MIGRATED = true;
    return true;
  } catch (err) {
    console.warn("[WARN] ensureSchemaAndUsers:", err?.message || err);
    return false;
  }
}

function authRequired(req, res, next) {
const token =
req.cookies?.token || (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null);
if (!token) return httpError(res, 401, "No autenticado");
try {
req.user = jwt.verify(token, process.env.JWT_SECRET);
if (req.user) {
  req.user.rol = normalizeRol(req.user.rol, req.user.username);
  req.user.rubro_id = getUserRubroId(req.user);
  req.user.region_id = req.user.region_id || null;
  req.user.oficina_id = req.user.oficina_id || null;
}
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
    await ensureSchemaAndUsers();

    let rows = [];
    try {
      const [rWithRubro] = await poolRead.query(
        `SELECT u.id, u.username, u.psw, u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO,
        u.ID_OFICIALIA, u.ACTIVO, COALESCE(u.departamento, u.rol, 'USUARIO') AS rol, u.rubro_id,
        u.region_id, u.oficina_id
        FROM usuario u
        WHERE u.username = ? LIMIT 1`,
        [username]
      );
      rows = rWithRubro;
    } catch {
      const [rFallback] = await poolRead.query(
        `SELECT u.id, u.username, u.psw, u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO,
        u.ID_OFICIALIA, u.ACTIVO, COALESCE(u.departamento, 'USUARIO') AS rol, u.rubro_id
        FROM usuario u
        WHERE u.username = ? LIMIT 1`,
        [username]
      );
      rows = rFallback;
    }

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

    const resolvedRubroId = getUserRubroId({
      username: u.username,
      rol: normalizeRol(u.rol, u.username),
      rubro_id: u.rubro_id,
    });

    const deptoId = u.ID_OFICIALIA || null;
    const canSelectAny = canSelectAnyDepartment({ user: { username: u.username, rol: u.rol } });

    // Datos que viajan dentro del token JWT
    const payload = {
      id: u.id,
      username: u.username,
      nombre: u.nombre,
      primer_ap: u.PRIMER_APELLIDO,
      segundo_ap: u.SEGUNDO_APELLIDO,
      id_oficialia: deptoId,
      departamento_id: deptoId,
      departamento: u.departamento || null,
      cargo: u.cargo || u.departamento || null,
      rol: normalizeRol(u.rol, u.username),
      rubro_id: resolvedRubroId,
      region_id: u.region_id || null,
      oficina_id: u.oficina_id || null,
      puede_seleccionar_cualquier_departamento: canSelectAny,
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

app.get("/api/auth/me", authRequired, async (req, res) => {
  try {
    const uid = Number(req.user?.id || 0);
    let r;
    try {
      const [rows] = await poolRead.query(
        `SELECT u.id, u.username, u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO,
                u.ID_OFICIALIA, u.OFICIALIA_ID, u.departamento, u.cargo, u.rol, u.rubro_id,
                u.region_id, u.oficina_id,
                o.nombre AS oficialia_nombre,
                r.nombre AS region_nombre,
                ofi.nombre AS oficina_nombre
         FROM usuario u
         LEFT JOIN oficialias o ON o.id = COALESCE(u.ID_OFICIALIA, u.OFICIALIA_ID)
         LEFT JOIN regiones r ON r.id = u.region_id
         LEFT JOIN oficinas_regionales ofi ON ofi.id = u.oficina_id
         WHERE u.id = ? LIMIT 1`,
        [uid]
      );
      if (!rows.length) return res.json({ ok: true, user: req.user });
      r = rows[0];
    } catch {
      const [rows] = await poolRead.query(
        `SELECT u.id, u.username, u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO,
                u.ID_OFICIALIA, u.OFICIALIA_ID, u.departamento, u.rol, u.rubro_id,
                u.region_id, u.oficina_id,
                o.nombre AS oficialia_nombre,
                r.nombre AS region_nombre,
                ofi.nombre AS oficina_nombre
         FROM usuario u
         LEFT JOIN oficialias o ON o.id = COALESCE(u.ID_OFICIALIA, u.OFICIALIA_ID)
         LEFT JOIN regiones r ON r.id = u.region_id
         LEFT JOIN oficinas_regionales ofi ON ofi.id = u.oficina_id
         WHERE u.id = ? LIMIT 1`,
        [uid]
      );
      if (!rows.length) return res.json({ ok: true, user: req.user });
      r = rows[0];
    }
    const userRole = normalizeRol(r.rol, r.username);
    const resolvedRubroId = getUserRubroId({
      username: r.username,
      rol: userRole,
      rubro_id: r.rubro_id,
    });
    const deptoId = r.ID_OFICIALIA || r.OFICIALIA_ID || null;
    const deptoNombre = (r.username === 'rodrigo' && r.departamento)
      ? r.departamento
      : (r.oficialia_nombre || r.departamento || null);
    const cargoNombre = r.cargo || r.departamento || deptoNombre;

    const enrichedUser = {
      ...req.user,
      id: r.id,
      username: r.username,
      nombre: r.nombre,
      primer_ap: r.PRIMER_APELLIDO,
      segundo_ap: r.SEGUNDO_APELLIDO,
      nombre_completo: [r.nombre, r.PRIMER_APELLIDO, r.SEGUNDO_APELLIDO].filter(Boolean).join(" "),
      rol: userRole,
      rubro_id: resolvedRubroId,
      id_oficialia: deptoId,
      departamento_id: deptoId,
      oficialia_nombre: deptoNombre,
      departamento_nombre: deptoNombre,
      departamento: deptoNombre,
      cargo: cargoNombre,
      region_id: r.region_id || null,
      region_nombre: r.region_nombre || null,
      oficina_id: r.oficina_id || null,
      oficina_nombre: r.oficina_nombre || null,
      puede_seleccionar_cualquier_departamento: canSelectAnyDepartment(req),
    };
    return res.json({ ok: true, user: enrichedUser });
  } catch (err) {
    return res.json({ ok: true, user: req.user });
  }
});
app.post("/api/auth/logout", (req, res) => {
res.clearCookie("token", { httpOnly: true, sameSite: "lax", secure: cookieSecure });
res.json({ ok: true });
});

app.get("/api/stock", authRequired, async (req, res) => {
  try {
    const { q = "", page = 1, limit = 500 } = req.query;
    const off = (Math.max(parseInt(page) || 1, 1) - 1) * (parseInt(limit) || 500);
    const like = `%${q}%`;
    const [rows] = await poolRead.query(
      `SELECT 
         a.ID AS id,
         a.ID AS producto_id,
         a.CLAVE,
         a.DESCRIPCION,
         a.CATEGORIA AS categoria,
         a.UNIDAD AS unidad,
         a.STOCK AS stock,
         a.STOCK AS stock_almacen,
         a.STOCK AS exist_calc,
         a.STOCK AS cantidad_disponible,
         a.STOCK AS existencia,
         (a.STOCK > 0) AS disponible,
         COALESCE(a.stock_minimo, 0) AS minimo,
         COALESCE(a.stock_minimo, 0) AS stock_minimo,
         0 AS maximo,
         0 AS stock_producto,
         0 AS diff_prod_vs_calc,
         0 AS diff_alm_vs_calc,
         a.ESTADO AS status
       FROM almacen_dregcivil a
       WHERE (? = '' OR a.CLAVE LIKE ? OR a.DESCRIPCION LIKE ? OR a.CATEGORIA LIKE ?)
         AND (a.ESTADO IS NULL OR a.ESTADO = 'ACTIVO')
       ORDER BY a.DESCRIPCION ASC
       LIMIT ? OFFSET ?`,
      [q, like, like, like, parseInt(limit) || 500, off]
    );
    return res.json({ ok: true, data: rows });
  } catch (e) {
    return httpError(res, e.statusCode || 500, e.message);
  }
});


app.get("/api/solicitudes", authRequired, async (req, res) => {
try {
await ensureSchemaAndUsers();
const { q = "", status = "", page = 1, limit = 50, usuario_id = "", oficialia_id = "" } = req.query;
const lim = Math.max(parseInt(limit) || 50, 1);
const off = (Math.max(parseInt(page) || 1, 1) - 1) * lim;
const like = `%${q}%`;
const st = (status || "").trim();
const stCanon = canon(st);
const filterCancel = stCanon === "CANCELADA" || stCanon === "CANCELADO";
const userRole = normalizeRol(req.user?.rol, req.user?.username);
const scope = await getUserScope(req);
const seeAll = canSeeAllSolicitudes(req);

const uidFilter = usuario_id ? Number(usuario_id) : 0;
const useUidFilter = uidFilter > 0;
const ofiFilter = oficialia_id ? Number(oficialia_id) : 0;
const useOfiFilter = ofiFilter > 0;

let scopeWhere = "";
const scopeParams = [];
if (!seeAll) {
  // Regla B (29/10/26): Solo admin y Gabriel Fiol ven todas las solicitudes.
  // Los demás usuarios solo ven las de su oficialía/departamento o las creadas por ellos.
  if (scope.oficialia_id) {
    scopeWhere = "AND (s.usuario_id = ? OR s.id_oficialia = ?)";
    scopeParams.push(Number(req.user?.id || 0), Number(scope.oficialia_id));
  } else {
    scopeWhere = "AND s.usuario_id = ?";
    scopeParams.push(Number(req.user?.id || 0));
  }
} else {
  if (userRole === "ENCARGADO") {
    scopeWhere = "AND (s.id_oficialia IS NULL OR s.id_oficialia != 30030000)";
  } else if (userRole === "USUARIO") {
    scopeWhere = "AND (s.id_oficialia IS NULL OR (s.id_oficialia != 30030000 AND s.id_oficialia != 30030008))";
  }
}

const sqlMain = `
SELECT s.id, s.fecha_solicitud, s.tipo_solicitud, s.status,
s.usuario_id, s.id_oficialia, s.id_localidad,
u.username,
CONCAT_WS(' ', u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO) AS nombre_usuario,
s.observaciones,
s.region_solicitante,
s.nombre_solicitante_firma,
s.fecha_firma_digital,
s.folio_firma_digital,
(CASE WHEN s.firma_solicitante_data IS NOT NULL AND s.firma_solicitante_data <> '' THEN 1 ELSE 0 END) AS tiene_firma_digital
FROM solicitudes s
LEFT JOIN usuario u ON u.id = s.usuario_id
WHERE (? = '' OR CONCAT_WS(' ',
s.id, s.tipo_solicitud, s.status, s.observaciones,
s.region_solicitante, s.nombre_solicitante_firma, s.folio_firma_digital,
u.username, u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO,
s.id_oficialia, s.id_localidad
) LIKE ?)
AND (? = 0 OR s.status IN (?, ?))
AND (? = 0 OR s.usuario_id = ?)
AND (? = 0 OR s.id_oficialia = ?)
${scopeWhere}
ORDER BY s.id DESC
LIMIT ? OFFSET ?`;

try {
const [rows] = await poolRead.query(sqlMain, [
q, like,
st ? 1 : 0, filterCancel ? "CANCELADA" : st, filterCancel ? "CANCELADO" : st,
useUidFilter ? 1 : 0, uidFilter || 0,
useOfiFilter ? 1 : 0, ofiFilter || 0,
...scopeParams,
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
tiene_firma_digital: Boolean(r.tiene_firma_digital || r.folio_firma_digital),
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
${scopeWhere}
ORDER BY s.id DESC
LIMIT ? OFFSET ?`;
const [rows2] = await poolRead.query(sqlFallback, [
q, like,
st ? 1 : 0, filterCancel ? "CANCELADA" : st, filterCancel ? "CANCELADO" : st,
useUidFilter ? 1 : 0, uidFilter || 0,
useOfiFilter ? 1 : 0, ofiFilter || 0,
...scopeParams,
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
return httpError(res, e.statusCode || 500, e.message);
}
});

app.get("/api/usuarios", authRequired, async (req, res) => {
  try {
    const reqRol = normalizeRol(req.user?.rol, req.user?.username);
    const admin = reqRol === "ADMIN";
    const encargado = reqRol === "ENCARGADO";
    const includeInactive = String(req.query.include_inactive || "") === "1";
    const nameCol = await detectOficialiaNameCol();
    const deptoCol = await detectUsuarioDepartamentoCol();
    const ofiSelect = nameCol ? `o.${qi(nameCol)} AS oficialia_nombre,` : `NULL AS oficialia_nombre,`;
    const deptoSelect = deptoCol ? `u.${qi(deptoCol)} AS departamento,` : `NULL AS departamento,`;

    if (admin || encargado) {
      const [rows] = await poolRead.query(
        `SELECT u.id, u.username, u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO,
          COALESCE(u.ACTIVO, 1) AS activo,
          COALESCE(u.rol, 'USUARIO') AS rol,
          u.ID_OFICIALIA AS id_oficialia,
          u.region_id,
          u.oficina_id,
          u.rubro_id,
          r.nombre AS region_nombre,
          oreg.nombre AS oficina_nombre,
          rub.nombre_rubro AS rubro_nombre,
          ${ofiSelect}
          ${deptoSelect}
          CONCAT_WS(' ', u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO) AS nombre_completo
        FROM usuario u
        LEFT JOIN oficialias o ON o.id = u.ID_OFICIALIA
        LEFT JOIN regiones r ON r.id = u.region_id
        LEFT JOIN oficinas_regionales oreg ON oreg.id = u.oficina_id
        LEFT JOIN rubros_inventario rub ON rub.id = u.rubro_id
        WHERE (${includeInactive ? "1=1" : "COALESCE(u.ACTIVO, 1) <> 0"})
        ORDER BY oficialia_nombre ASC, nombre_completo ASC, u.username ASC
        LIMIT 500`
      );
      const mapped = rows
        .map((r) => {
          const rolNorm = normalizeRol(r.rol, r.username);
          const areaNombre = String(r.oficialia_nombre || r.departamento || r.nombre_completo || r.username || "").trim();
          return {
            ...r,
            rol: rolNorm,
            oficialia_nombre: r.oficialia_nombre || r.departamento || null,
            area_nombre: areaNombre,
          };
        })
        .filter((r) => {
          if (admin) return true;
          // ENCARGADO: mostrar su propia área (ENCARGADO) y las áreas de USUARIO
          return r.rol === "ENCARGADO" || r.rol === "USUARIO" || Number(r.id) === Number(req.user?.id);
        });
      return res.json({ ok: true, data: mapped });
    }

    const [rows] = await poolRead.query(
      `SELECT u.id, u.username, u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO,
        COALESCE(u.ACTIVO, 1) AS activo,
        COALESCE(u.rol, 'USUARIO') AS rol,
        u.ID_OFICIALIA AS id_oficialia,
        u.region_id,
        u.oficina_id,
        u.rubro_id,
        r.nombre AS region_nombre,
        oreg.nombre AS oficina_nombre,
        rub.nombre_rubro AS rubro_nombre,
        ${ofiSelect}
        ${deptoSelect}
        CONCAT_WS(' ', u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO) AS nombre_completo
      FROM usuario u
      LEFT JOIN oficialias o ON o.id = u.ID_OFICIALIA
      LEFT JOIN regiones r ON r.id = u.region_id
      LEFT JOIN oficinas_regionales oreg ON oreg.id = u.oficina_id
      LEFT JOIN rubros_inventario rub ON rub.id = u.rubro_id
      WHERE u.id = ?
      LIMIT 1`,
      [Number(req.user?.id || 0)]
    );
    const mapped = rows.map((r) => {
      const rolNorm = normalizeRol(r.rol, r.username);
      const areaNombre = String(r.oficialia_nombre || r.departamento || r.nombre_completo || r.username || "").trim();
      return {
        ...r,
        rol: rolNorm,
        oficialia_nombre: r.oficialia_nombre || r.departamento || null,
        area_nombre: areaNombre,
      };
    });
    return res.json({ ok: true, data: mapped });
  } catch (e) {
    return httpError(res, e.statusCode || 500, e.message);
  }
});

// Punto 8: Edición de perfil de usuario exclusiva para Administrador (soporta /api/usuarios/:id y /api/usuarios/:id/perfil)
app.put(["/api/usuarios/:id", "/api/usuarios/:id/perfil"], authRequired, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return httpError(res, 403, "Acceso exclusivo para Administración para editar perfiles de usuarios.");
    }
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return httpError(res, 400, "ID de usuario inválido.");
    }

    const {
      nombre,
      primer_apellido,
      segundo_apellido,
      password,
      id_oficialia,
      departamento_id,
      region_id,
      oficina_id,
      rubro_id,
      rol,
      activo
    } = req.body || {};

    const [[existing]] = await poolRead.query(`SELECT id, username FROM usuario WHERE id = ? LIMIT 1`, [userId]);
    if (!existing) return httpError(res, 404, "Usuario no encontrado.");

    const updates = [];
    const params = [];

    if (nombre !== undefined) {
      updates.push("nombre = ?");
      params.push(String(nombre || "").trim());
    }
    if (primer_apellido !== undefined) {
      updates.push("PRIMER_APELLIDO = ?");
      params.push(String(primer_apellido || "").trim());
    }
    if (segundo_apellido !== undefined) {
      updates.push("SEGUNDO_APELLIDO = ?");
      params.push(String(segundo_apellido || "").trim());
    }
    if (password && String(password).trim().length > 0) {
      const hashed = await bcrypt.hash(String(password).trim(), 10);
      updates.push("psw = ?");
      params.push(hashed);
    }

    // Departamento / Oficialía
    const rawOfiId = departamento_id !== undefined ? departamento_id : id_oficialia;
    if (rawOfiId !== undefined) {
      const ofiNum = Number(rawOfiId) || null;
      updates.push("ID_OFICIALIA = ?");
      params.push(ofiNum);
      updates.push("OFICIALIA_ID = ?");
      params.push(ofiNum);

      let ofiNombre = null;
      if (ofiNum) {
        const nameCol = await detectOficialiaNameCol();
        const [ofiRows] = await poolRead.query(
          `SELECT ${nameCol ? qi(nameCol) : "nombre"} AS nombre FROM oficialias WHERE id = ? LIMIT 1`,
          [ofiNum]
        ).catch(() => [[]]);
        if (ofiRows && ofiRows.length) {
          ofiNombre = ofiRows[0].nombre;
        }
      }
      updates.push("departamento = ?");
      params.push(ofiNombre);
    }

    if (region_id !== undefined) {
      const regNum = Number(region_id) || null;
      updates.push("region_id = ?");
      params.push(regNum);
    }
    if (oficina_id !== undefined) {
      const ofiRegNum = Number(oficina_id) || null;
      updates.push("oficina_id = ?");
      params.push(ofiRegNum);
    }
    if (rubro_id !== undefined) {
      const rubNum = Number(rubro_id) || null;
      updates.push("rubro_id = ?");
      params.push(rubNum);
    }
    if (rol !== undefined) {
      const rolNorm = normalizeRol(rol, existing.username);
      updates.push("rol = ?");
      params.push(rolNorm);
    }
    if (activo !== undefined) {
      updates.push("ACTIVO = ?");
      params.push(activo ? 1 : 0);
    }

    if (updates.length === 0) {
      return httpError(res, 400, "No se proporcionaron datos para actualizar.");
    }

    params.push(userId);
    await poolOps.query(`UPDATE usuario SET ${updates.join(", ")} WHERE id = ?`, params);
    invalidateUserScope(userId);

    // Recuperar el objeto completo del usuario actualizado con JOIN a oficialías y regiones
    const nameCol = await detectOficialiaNameCol();
    const deptoCol = await detectUsuarioDepartamentoCol();
    const ofiSelect = nameCol ? `o.${qi(nameCol)} AS oficialia_nombre,` : `NULL AS oficialia_nombre,`;
    const deptoSelect = deptoCol ? `u.${qi(deptoCol)} AS departamento,` : `NULL AS departamento,`;

    const [updatedRows] = await poolRead.query(
      `SELECT u.id, u.username, u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO,
        COALESCE(u.ACTIVO, 1) AS activo,
        COALESCE(u.rol, 'USUARIO') AS rol,
        u.ID_OFICIALIA AS id_oficialia,
        u.region_id,
        u.oficina_id,
        u.rubro_id,
        r.nombre AS region_nombre,
        oreg.nombre AS oficina_nombre,
        rub.nombre_rubro AS rubro_nombre,
        ${ofiSelect}
        ${deptoSelect}
        CONCAT_WS(' ', u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO) AS nombre_completo
      FROM usuario u
      LEFT JOIN oficialias o ON o.id = u.ID_OFICIALIA
      LEFT JOIN regiones r ON r.id = u.region_id
      LEFT JOIN oficinas_regionales oreg ON oreg.id = u.oficina_id
      LEFT JOIN rubros_inventario rub ON rub.id = u.rubro_id
      WHERE u.id = ?
      LIMIT 1`,
      [userId]
    );

    const updatedUser = updatedRows && updatedRows[0] ? {
      ...updatedRows[0],
      rol: normalizeRol(updatedRows[0].rol, updatedRows[0].username),
      oficialia_nombre: updatedRows[0].oficialia_nombre || updatedRows[0].departamento || null,
      area_nombre: String(updatedRows[0].oficialia_nombre || updatedRows[0].departamento || updatedRows[0].nombre_completo || updatedRows[0].username || "").trim(),
    } : null;

    return res.json({
      ok: true,
      message: "Perfil de usuario actualizado exitosamente.",
      user: updatedUser,
      data: updatedUser
    });
  } catch (e) {
    return httpError(res, e.statusCode || 500, e.message);
  }
});

app.get("/api/logs/accesos", authRequired, async (req, res) => {
  if (!isAdmin(req)) {
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

async function handleGetOficialias(req, res) {
  try {
    const nameCol = await detectOficialiaNameCol();
    if (!nameCol) return res.json({ ok: true, data: [] });
    const [rows] = await poolRead.query(
      `SELECT id, ${qi(nameCol)} AS nombre, oficial_reponsable
       FROM oficialias
       WHERE activo IS NULL OR activo = 1 OR activo = b'1'
       ORDER BY ${qi(nameCol)} ASC
       LIMIT 500`
    );

    const canSelectAny = canSelectAnyDepartment(req);
    let filtered = rows;

    if (canSelectAny) {
      const userRole = normalizeRol(req.user?.rol, req.user?.username);
      if (userRole === 'ADMIN') {
        filtered = rows;
      } else {
        // gabrielfiol / encargado
        filtered = rows.filter(r => {
          const id = Number(r.id || 0);
          const name = String(r.nombre || '').trim().toLowerCase();
          return id !== 30030000 && !name.includes('administrador') && !name.includes('direccion estatal');
        });
      }
    } else {
      // Regla de Negocio 1 & 3:
      // Los demás usuarios (incluyendo evelia, jesus, luiseduardo, loscabos, mulege)
      // SOLO ven su propio departamento asignado
      const scope = await getUserScope(req);
      let userOfiId = Number(scope?.oficialia_id || req.user?.id_oficialia || req.user?.departamento_id || 0);
      if (!userOfiId) {
        const uName = String(req.user?.username || '').toLowerCase();
        const regId = Number(scope?.region_id || req.user?.region_id || 0);
        if (uName === 'loscabos' || regId === 2) userOfiId = 30030009;
        else if (uName === 'mulege' || regId === 4) userOfiId = 30030010;
        else if (regId === 3) userOfiId = 30030011;
        else userOfiId = 30030001;
      }
      filtered = rows.filter(r => Number(r.id) === userOfiId);
      if (!filtered.length && userOfiId) {
        filtered = [{
          id: userOfiId,
          nombre: req.user?.oficialia_nombre || req.user?.departamento || `Departamento ${userOfiId}`,
          oficial_reponsable: req.user?.nombre_completo || req.user?.username || null
        }];
      }
    }

    return res.json({ ok: true, data: filtered });
  } catch (e) {
    return httpError(res, e.statusCode || 500, e.message);
  }
}

app.get("/api/oficialias", authRequired, handleGetOficialias);
app.get("/api/departamentos", authRequired, handleGetOficialias);

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
return httpError(res, e.statusCode || 500, e.message);
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
await ensureSchemaAndUsers();
const id = Number(req.params.id);
if (!Number.isFinite(id)) return httpError(res, 400, "ID invalido");
await assertSolicitudAccess(req, id);

const nameCol = await detectOficialiaNameCol();
const [r2] = await poolRead.query(
`SELECT s.*,
s.id_oficialia AS id_oficialia,
u.username,
u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO,
${nameCol ? `(SELECT ${qi(nameCol)} FROM oficialias WHERE id = s.id_oficialia LIMIT 1)` : `NULL`} AS oficialia_nombre,
CONCAT_WS(' ', u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO) AS nombre_usuario
FROM solicitudes s
LEFT JOIN usuario u ON u.id = s.usuario_id
WHERE s.id = ? LIMIT 1`,
[id]
);
if (!r2.length) return httpError(res, 404, "Solicitud no encontrada");
const base = r2[0];
base.oficialia_nombre = base.oficialia_nombre ?? (await getOficialiaNombre(base.id_oficialia ?? base.ID_OFICIALIA ?? null));
base.tiene_firma_digital = Boolean(base.firma_solicitante_data || base.folio_firma_digital);
base.usuario = {
id: base.usuario_id ?? base.USUARIO_ID ?? null,
username: base.username ?? null,
nombre_completo: base.nombre_usuario ?? pickUsuarioServer(base),
id_oficialia: base.id_oficialia ?? base.ID_OFICIALIA ?? null,
oficialia_nombre: base.oficialia_nombre ?? null,
};

// Adjuntar detalles con stock en tiempo real desde la BD
try {
  const [detRows] = await poolRead.query(
    `SELECT d.id AS detalle_id, d.id, d.solicitud_id, d.producto_id,
            p.CLAVE, p.DESCRIPCION, p.unidad, p.categoria,
            d.cantidad, d.atendida, d.observaciones
     FROM detalles_solicitud d
     LEFT JOIN productos p ON p.${await detectProductosPK()} = d.producto_id
     WHERE d.solicitud_id = ?
     ORDER BY d.id`,
    [id]
  );
  const enrichedDet = await attachCategoriaNombre(detRows);
  const claves = Array.from(new Set(enrichedDet.map(r => r.CLAVE || r.sku).filter(Boolean)));
  const stockMap = new Map();
  if (claves.length) {
    const [stockRows] = await poolRead.query(
      `SELECT CLAVE, STOCK FROM almacen_dregcivil WHERE CLAVE IN (?)`,
      [claves]
    );
    stockRows.forEach(sr => stockMap.set(String(sr.CLAVE || '').trim().toUpperCase(), Number(sr.STOCK ?? 0)));
  }
  enrichedDet.forEach(r => {
    r.CLAVE = r.CLAVE || r.sku || '';
    r.DESCRIPCION = r.DESCRIPCION || r.producto || '';
    const c = String(r.CLAVE).trim().toUpperCase();
    const st = stockMap.has(c) ? stockMap.get(c) : 0;
    r.stock_almacen = st;
    r.stock_actual = st;
  });
  base.detalles = enrichedDet;
} catch (errDet) {
  base.detalles = [];
}

return res.json({ ok: true, data: base });
} catch (e) {
return httpError(res, e.statusCode || 500, e.message);
}
});


app.get("/api/solicitudes/:id/detalle", authRequired, async (req, res) => {
try {
const sid = Number(req.params.id);
if (!Number.isFinite(sid)) return httpError(res, 400, "ID invalido");
await assertSolicitudAccess(req, sid);

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
CLAVE: r.CLAVE ?? r.sku ?? null,
DESCRIPCION: r.DESCRIPCION ?? r.producto ?? null,
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
const claves = Array.from(new Set(enriched.map(r => r.CLAVE || r.sku).filter(Boolean)));
if (claves.length) {
  const [stockRows] = await poolRead.query(
    `SELECT CLAVE, STOCK FROM almacen_dregcivil WHERE CLAVE IN (?)`,
    [claves]
  );
  const stockMap = new Map();
  stockRows.forEach(sr => stockMap.set(String(sr.CLAVE || '').trim().toUpperCase(), Number(sr.STOCK ?? 0)));
  enriched.forEach(r => {
    r.CLAVE = r.CLAVE || r.sku || '';
    r.DESCRIPCION = r.DESCRIPCION || r.producto || '';
    const c = String(r.CLAVE).trim().toUpperCase();
    const st = stockMap.has(c) ? stockMap.get(c) : 0;
    r.stock_almacen = st;
    r.stock_actual = st;
  });
} else {
  enriched.forEach(r => {
    r.CLAVE = r.CLAVE || r.sku || '';
    r.DESCRIPCION = r.DESCRIPCION || r.producto || '';
    r.stock_almacen = 0;
    r.stock_actual = 0;
  });
}
return res.json({ ok: true, data: enriched });
} catch (e) {
return httpError(res, e.statusCode || 500, e.message);
}
});

async function resolveProductoIdByClaveOrId(conn, { producto_id = null, clave = null }) {
  if (producto_id && Number.isFinite(Number(producto_id))) {
    return Number(producto_id);
  }
  if (!clave) return null;
  const claveClean = String(clave).trim();
  const pk = await detectProductosPK();
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

  if (rAlm.length) {
    return await upsertProductoFromAlmacen(conn, {
      CLAVE: rAlm[0].CLAVE,
      DESCRIPCION: rAlm[0].DESCRIPCION,
      CATEGORIA: rAlm[0].CATEGORIA,
      UNIDAD: rAlm[0].UNIDAD,
      ESTADO: rAlm[0].ESTADO || "ACTIVO",
    });
  }

  const [rProd] = await conn.query(
    `SELECT ${qi(pk)} AS producto_id FROM productos WHERE CLAVE=? ORDER BY ${qi(pk)} ASC LIMIT 1`,
    [claveClean]
  );
  return rProd[0]?.producto_id || null;
}

function buildFolioFirmaDigital(seedStr = "") {
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const hashPart = crypto
    .createHash("sha256")
    .update(`${seedStr}|${now.toISOString()}|${Math.random()}`)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  return `FIRMA-BCS-${datePart}-${hashPart}`;
}

app.post("/api/solicitudes", authRequired, async (req, res) => {
try {
await ensureSchemaAndUsers();
const {
  usuario_id,
  id_oficialia,
  tipo_solicitud = "CONSUMIBLES",
  observaciones = null,
  region_solicitante = null,
  nombre_solicitante_firma = null,
  firma_solicitante_data = null,
  items = [],
} = req.body || {};

let ofi = Number(id_oficialia || 0) || null;
let loc = 0;
let uid = Number(usuario_id || 0) || req.user.id;

const canSelectAny = canSelectAnyDepartment(req);

if (!canSelectAny) {
  // Regla de Negocio 1 & 3:
  // Si el usuario no es admin ni gabrielfiol, se ignora cualquier id_oficialia o usuario_id enviado
  // y se fuerza el departamento/oficialía que pertenece a su perfil en la tabla usuario.
  uid = req.user.id;
  const [uRows] = await poolRead.query(
    `SELECT u.id, u.ID_OFICIALIA, u.OFICIALIA_ID, u.departamento, u.region_id, u.oficina_id,
            o.id AS ofi_id, o.id_localidad
     FROM usuario u
     LEFT JOIN oficialias o ON o.id = COALESCE(u.ID_OFICIALIA, u.OFICIALIA_ID)
     WHERE u.id = ? LIMIT 1`,
    [req.user.id]
  );
  const uProfile = uRows[0] || {};
  ofi = Number(uProfile.ofi_id || uProfile.ID_OFICIALIA || uProfile.OFICIALIA_ID || req.user?.id_oficialia || req.user?.departamento_id || 0) || null;
  loc = Number(uProfile.id_localidad || 0);

  if (!ofi) {
    const regId = Number(uProfile.region_id || req.user?.region_id || 0);
    const uName = String(req.user?.username || "").toLowerCase();
    if (uName === "loscabos" || regId === 2) ofi = 30030009;
    else if (uName === "mulege" || regId === 4) ofi = 30030010;
    else if (regId === 3) ofi = 30030011;
    else ofi = 30030001;
  }
} else {
  if (!ofi && usuario_id && Number(usuario_id) >= 1000) {
    ofi = Number(usuario_id);
    uid = req.user.id;
  }

  if (ofi) {
    const [o] = await poolRead.query(
      `SELECT id, id_localidad FROM oficialias WHERE id=? LIMIT 1`,
      [ofi]
    );
    if (o.length) {
      ofi = o[0].id;
      loc = o[0].id_localidad || 0;
    } else {
      ofi = null;
    }
  }

  if (!ofi) {
    const [u] = await poolRead.query(
      `SELECT u.id, u.username, u.ID_OFICIALIA AS ofi, o.id_localidad AS loc
       FROM usuario u LEFT JOIN oficialias o ON o.id=u.ID_OFICIALIA
       WHERE u.id=? LIMIT 1`,
      [uid]
    );
    if (u.length && u[0].ofi) {
      ofi = u[0].ofi;
      loc = u[0].loc || 0;
    }
  }

  if (!ofi) {
    const [u] = await poolRead.query(
      `SELECT u.id, u.ID_OFICIALIA AS ofi, o.id_localidad AS loc
       FROM usuario u LEFT JOIN oficialias o ON o.id=u.ID_OFICIALIA
       WHERE u.id=? LIMIT 1`,
      [req.user.id]
    );
    if (u.length && u[0].ofi) {
      ofi = u[0].ofi;
      loc = u[0].loc || 0;
    } else {
      const [firstOfi] = await poolRead.query(`SELECT id, id_localidad FROM oficialias LIMIT 1`);
      if (firstOfi.length) {
        ofi = firstOfi[0].id;
        loc = firstOfi[0].id_localidad || 0;
      } else {
        return httpError(res, 400, "Usuario no válido o sin oficialía/localidad");
      }
    }
  }
}

const userRole = normalizeRol(req.user?.rol, req.user?.username);
if (userRole !== 'ADMIN' && (ofi === 30030000 || String(ofi) === '30030000')) {
  return httpError(res, 403, "No tienes permiso para solicitar materiales a nombre de Administración");
}
if (userRole === 'USUARIO' && (ofi === 30030008 || String(ofi) === '30030008')) {
  return httpError(res, 403, "No tienes permiso para solicitar materiales a nombre de Encargado de Inventario");
}

const scope = await getUserScope(req);
let regionRaw = region_solicitante ? String(region_solicitante).trim() : (scope.region_nombre || "");
if (!canSelectAny && scope.region_nombre) {
  // Para enlaces regionales u otros usuarios, registrar la región asignada a su perfil
  regionRaw = scope.region_nombre;
}
const regionKey = regionRaw.toUpperCase().replace(/[\s\/-]+/g, "_");
const isForanea = scope.es_region_foranea || (isAdmin(req) && REGIONES_FORANEAS.has(regionKey));

const cleanRegion = regionRaw ? regionRaw.slice(0, 50) : null;
const cleanNombreFirma = isForanea && nombre_solicitante_firma ? String(nombre_solicitante_firma).trim().slice(0, 150) : null;
const cleanFirmaData = isForanea && firma_solicitante_data && String(firma_solicitante_data).trim().startsWith("data:image/")
  ? String(firma_solicitante_data).trim()
  : null;
const fechaFirma = cleanFirmaData ? new Date() : null;
const folioFirma = cleanFirmaData
  ? buildFolioFirmaDigital(`${uid}|${ofi}|${cleanNombreFirma || ""}|${cleanFirmaData.slice(-64)}`)
  : null;

const conn = await poolOps.getConnection();
try {
  await conn.beginTransaction();

  const [rs] = await conn.query(
    `INSERT INTO solicitudes(
       tipo_solicitud, fecha_solicitud, id_oficialia, id_localidad, usuario_id,
       status, observaciones, region_solicitante, nombre_solicitante_firma,
       firma_solicitante_data, fecha_firma_digital, folio_firma_digital
     )
     VALUES (?, NOW(), ?, ?, ?, 'PENDIENTE', ?, ?, ?, ?, ?, ?)`,
    [
      tipo_solicitud,
      ofi,
      loc,
      uid,
      observaciones,
      cleanRegion,
      cleanNombreFirma,
      cleanFirmaData,
      fechaFirma,
      folioFirma,
    ]
  );
  const solicitudId = rs.insertId;

  const itemsArray = Array.isArray(items) ? items : [];
  for (const it of itemsArray) {
    const cantidad = Number(it.cantidad || 0);
    if (!(cantidad > 0)) continue;
    const prodId = await resolveProductoIdByClaveOrId(conn, {
      producto_id: it.producto_id,
      clave: it.clave
    });
    if (!prodId) {
      throw new Error(`Producto no encontrado para clave: ${it.clave || it.producto_id || 'desconocida'}`);
    }

    // Validar disponibilidad real en almacén
    if (tipo_solicitud === "CONSUMIBLES" || !tipo_solicitud) {
      let almRow = null;
      if (it.clave) {
        const [ar] = await conn.query(`SELECT CLAVE, DESCRIPCION, STOCK FROM almacen_dregcivil WHERE CLAVE = ? LIMIT 1`, [it.clave]);
        if (ar.length) almRow = ar[0];
      }
      if (!almRow && prodId) {
        const [pr] = await conn.query(`SELECT CLAVE, DESCRIPCION FROM productos WHERE id = ? LIMIT 1`, [prodId]);
        if (pr.length && pr[0].CLAVE) {
          const [ar] = await conn.query(`SELECT CLAVE, DESCRIPCION, STOCK FROM almacen_dregcivil WHERE CLAVE = ? LIMIT 1`, [pr[0].CLAVE]);
          if (ar.length) almRow = ar[0];
        }
      }
      if (almRow && Number(almRow.STOCK || 0) < cantidad) {
        throw new Error(`La cantidad solicitada para "${almRow.DESCRIPCION}" supera la disponibilidad actual.`);
      }
    }

    const rawAtendida = Number(it.atendida || 0);
    const atendida = Number.isFinite(rawAtendida) && rawAtendida > 0 ? rawAtendida : 0;
    const itemObs = it.observaciones || null;

    await conn.query(
      `INSERT INTO detalles_solicitud (solicitud_id, producto_id, cantidad, atendida, observaciones)
       VALUES (?, ?, ?, ?, ?)`,
      [solicitudId, prodId, cantidad, atendida, itemObs]
    );
  }

  await conn.commit();
  res.json({
    ok: true,
    solicitud_id: solicitudId,
    folio_firma_digital: folioFirma,
    fecha_firma_digital: fechaFirma,
  });
} catch (err) {
  await conn.rollback();
  throw err;
} finally {
  conn.release();
}
} catch (e) {
return httpError(res, 400, e.message);
}
});

// Endpoint para firmar digitalmente una solicitud existente (ej. solicitudes pendientes de firma)
app.post("/api/solicitudes/:id/firma", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return httpError(res, 400, "ID de solicitud inválido");

    const { region_solicitante = null, nombre_solicitante_firma = null, firma_solicitante_data = null } = req.body || {};
    const cleanFirmaData = firma_solicitante_data && String(firma_solicitante_data).trim().startsWith("data:image/")
      ? String(firma_solicitante_data).trim()
      : null;

    if (!cleanFirmaData) {
      return httpError(res, 400, "Se requiere dibujar o adjuntar la firma digital en formato PNG.");
    }

    const [rows] = await poolRead.query(`SELECT id, status, region_solicitante, nombre_solicitante_firma FROM solicitudes WHERE id = ? LIMIT 1`, [id]);
    if (!rows.length) return httpError(res, 404, "Solicitud no encontrada");

    const sol = rows[0];
    const cleanRegion = region_solicitante != null && String(region_solicitante).trim() !== ""
      ? String(region_solicitante).trim().slice(0, 50)
      : sol.region_solicitante;
    const cleanNombre = nombre_solicitante_firma != null && String(nombre_solicitante_firma).trim() !== ""
      ? String(nombre_solicitante_firma).trim().slice(0, 150)
      : sol.nombre_solicitante_firma;

    const fechaFirma = new Date();
    const folioFirma = buildFolioFirmaDigital(`${id}|${cleanNombre || ""}|${cleanFirmaData.slice(-64)}`);

    await poolOps.query(
      `UPDATE solicitudes
       SET region_solicitante = COALESCE(?, region_solicitante),
           nombre_solicitante_firma = COALESCE(?, nombre_solicitante_firma),
           firma_solicitante_data = ?,
           fecha_firma_digital = ?,
           folio_firma_digital = ?
       WHERE id = ?`,
      [cleanRegion, cleanNombre, cleanFirmaData, fechaFirma, folioFirma, id]
    );

    return res.json({
      ok: true,
      id,
      folio_firma_digital: folioFirma,
      fecha_firma_digital: fechaFirma,
      nombre_solicitante_firma: cleanNombre,
      region_solicitante: cleanRegion,
    });
  } catch (e) {
    return httpError(res, 500, e.message);
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

const [arRows] = await conn.query(`SELECT CLAVE, DESCRIPCION, STOCK FROM almacen_dregcivil WHERE CLAVE = ? LIMIT 1`, [clave]);
if (arRows.length && Number(arRows[0].STOCK || 0) < Number(cantidad)) {
  await conn.rollback();
  return httpError(res, 400, `La cantidad solicitada para "${arRows[0].DESCRIPCION}" supera la disponibilidad actual.`);
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
  `SELECT CLAVE, DESCRIPCION, CATEGORIA, STOCK, ${unidadSel}, ${statusSel}
   FROM almacen_dregcivil
   WHERE CLAVE=?
   ORDER BY ID ASC
   LIMIT 1`,
  [claveClean]
);

if (rAlm.length && Number(rAlm[0].STOCK || 0) < Number(cantidad)) {
  await conn.rollback();
  return httpError(res, 400, `La cantidad solicitada para "${rAlm[0].DESCRIPCION}" supera la disponibilidad actual.`);
}

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

async function surtirSolicitudHandler(req, res) {
  try {
    if (!canManageSolicitudes(req)) {
      return httpError(res, 403, "Solo el Encargado de Almacén o Administrador puede surtir solicitudes");
    }
    const solicitudId = Number(req.params.id);
    if (!Number.isInteger(solicitudId) || solicitudId <= 0) {
      return httpError(res, 400, "ID de solicitud inválido");
    }

    const rawItems = Array.isArray(req.body) ? req.body : (Array.isArray(req.body?.items) ? req.body.items : []);
    if (!rawItems.length) {
      return httpError(res, 400, "No se enviaron renglones para surtir");
    }

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      const [solRows] = await conn.query(
        "SELECT id, status, fecha_solicitud FROM solicitudes WHERE id = ? FOR UPDATE",
        [solicitudId]
      );
      if (!solRows.length) {
        await conn.rollback();
        return httpError(res, 404, "Solicitud no encontrada");
      }
      const sol = solRows[0];
      const curStatus = String(sol.status || "").toUpperCase();
      if (curStatus === "CANCELADA") {
        await conn.rollback();
        return httpError(res, 400, "No se puede surtir una solicitud cancelada");
      }

      const pk = await detectProductosPK();
      const [detRows] = await conn.query(
        `SELECT ds.id, ds.solicitud_id, ds.producto_id, ds.cantidad, ds.atendida, ds.observaciones,
                p.CLAVE AS clave, p.DESCRIPCION AS descripcion
         FROM detalles_solicitud ds
         LEFT JOIN productos p ON p.${qi(pk)} = ds.producto_id
         WHERE ds.solicitud_id = ?
         FOR UPDATE`,
        [solicitudId]
      );

      // Bloquear y consultar existencias en almacén (tiempo real)
      const claves = Array.from(new Set(detRows.map(r => r.clave).filter(Boolean)));
      const stockMap = new Map();
      if (claves.length) {
        const [almRows] = await conn.query(
          `SELECT ID, CLAVE, DESCRIPCION, STOCK FROM almacen_dregcivil WHERE CLAVE IN (?) FOR UPDATE`,
          [claves]
        );
        almRows.forEach(a => {
          stockMap.set(String(a.CLAVE || '').trim().toUpperCase(), { id: a.ID, stock: Number(a.STOCK ?? 0), desc: a.DESCRIPCION });
        });
      }

      const nombreDe = (det) => {
        const c = det.clave ? String(det.clave).trim().toUpperCase() : "";
        return det.descripcion || stockMap.get(c)?.desc || det.clave || `renglón ${det.id}`;
      };

      // 1) Validar TODOS los renglones antes de tocar el inventario
      const plan = [];
      for (const item of rawItems) {
        const detId = Number(item.detalle_id || item.id);
        const targetDet = detRows.find(d => Number(d.id) === detId);
        if (!targetDet) continue;

        const nombre = nombreDe(targetDet);
        const cantSolicitada = Number(targetDet.cantidad || 0);
        const prevAtendida = Number(targetDet.atendida || 0);
        const rawAt = item.atendida === "" || item.atendida === null || item.atendida === undefined ? NaN : Number(item.atendida);

        if (!Number.isInteger(rawAt) || rawAt < 0) {
          await conn.rollback();
          return httpError(res, 400, `Cantidad a surtir inválida para ${nombre}. Usa 0 si no se surtirá este artículo.`);
        }
        if (rawAt > cantSolicitada) {
          await conn.rollback();
          return httpError(res, 400, `La cantidad a surtir (${rawAt}) no puede superar la cantidad solicitada (${cantSolicitada}) para ${nombre}.`);
        }

        const clave = targetDet.clave ? String(targetDet.clave).trim() : null;
        const claveKey = clave ? clave.toUpperCase() : null;
        const almInfo = claveKey ? stockMap.get(claveKey) : null;
        const curStock = almInfo ? almInfo.stock : 0;
        const delta = rawAt - prevAtendida;

        if (delta > 0 && (!almInfo || curStock < delta)) {
          await conn.rollback();
          if (curStock <= 0) {
            return httpError(res, 400, `No hay stock disponible para ${nombre} (Existencia actual: 0)`);
          } else {
            return httpError(res, 400, `Stock insuficiente para ${nombre}. Solicitado a surtir: ${rawAt}, Existencia disponible: ${curStock}`);
          }
        }
        plan.push({ item, targetDet, nombre, clave, almInfo, curStock, delta, nextAtendida: rawAt });
      }

      if (!plan.length) {
        await conn.rollback();
        return httpError(res, 400, "Ninguno de los renglones enviados pertenece a esta solicitud.");
      }

      // 2) Si todo queda en 0, bloquear el surtido con un mensaje claro
      if (plan.every(p => p.nextAtendida === 0)) {
        await conn.rollback();
        return httpError(res, 400, "No hay stock disponible para surtir esta solicitud (todas las cantidades a surtir están en 0).");
      }

      // 3) Aplicar movimientos de inventario y actualizar renglones
      for (const p of plan) {
        const { item, targetDet, clave, almInfo, delta, nextAtendida } = p;
        const detId = Number(targetDet.id);

        if (delta !== 0 && clave && almInfo) {
          if (delta > 0) {
            const newStock = almInfo.stock - delta;
            almInfo.stock = newStock;
            await conn.query("UPDATE almacen_dregcivil SET STOCK = ? WHERE ID = ?", [newStock, almInfo.id]);
            try {
              await conn.query("UPDATE productos SET STOCK = GREATEST(0, COALESCE(STOCK, 0) - ?) WHERE CLAVE = ?", [delta, clave]);
            } catch {}
            try {
              if (targetDet.producto_id) {
                await conn.query("UPDATE almacen_principal SET STOCK = GREATEST(0, COALESCE(STOCK, 0) - ?) WHERE producto_id = ?", [delta, targetDet.producto_id]);
              }
            } catch {}

            await logMovimiento(conn, {
              tipo: "SALIDA",
              clave,
              cantidad: delta,
              responsable: req.user?.username || "web",
              destino: "SOLICITUD",
              referencia: `SOL-${solicitudId}`,
              observaciones: item.observaciones || "Surtido de solicitud",
            });
          } else {
            const regreso = Math.abs(delta);
            const newStock = almInfo.stock + regreso;
            almInfo.stock = newStock;
            await conn.query("UPDATE almacen_dregcivil SET STOCK = ? WHERE ID = ?", [newStock, almInfo.id]);
            try {
              await conn.query("UPDATE productos SET STOCK = COALESCE(STOCK, 0) + ? WHERE CLAVE = ?", [regreso, clave]);
            } catch {}
            try {
              if (targetDet.producto_id) {
                await conn.query("UPDATE almacen_principal SET STOCK = COALESCE(STOCK, 0) + ? WHERE producto_id = ?", [regreso, targetDet.producto_id]);
              }
            } catch {}

            await logMovimiento(conn, {
              tipo: "ENTRADA",
              clave,
              cantidad: regreso,
              responsable: req.user?.username || "web",
              destino: "SOLICITUD",
              referencia: `SOL-${solicitudId}-AJUSTE`,
              observaciones: "Ajuste de cantidad atendida",
            });
          }
        }

        const newObs = item.observaciones !== undefined ? (item.observaciones ? String(item.observaciones).trim() : null) : targetDet.observaciones;
        await conn.query(
          "UPDATE detalles_solicitud SET atendida = ?, observaciones = ? WHERE id = ?",
          [nextAtendida, newObs, detId]
        );
      }

      const surtidaStatus = await normalizeStatus("SURTIDA").catch(() => "SURTIDA");
      await conn.query(
        "UPDATE solicitudes SET status = ?, fecha_surtido = CURDATE() WHERE id = ?",
        [surtidaStatus, solicitudId]
      );

      // Sincronizar Almacén Central con Inventario Regional Delegación La Paz Rubro 1
      await syncAlmacenCentralToInventarioRegional(conn).catch(() => {});

      await conn.commit();
      return res.json({ ok: true, status: surtidaStatus, solicitud_id: solicitudId });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    if (e.statusCode) return httpError(res, e.statusCode, e.message);
    return httpError(res, 400, e.message);
  }
}

// Surtir solicitud: se aceptan POST y PUT (el frontend usa POST); PATCH /detalles se conserva por compatibilidad
app.post("/api/solicitudes/:id/surtir", authRequired, surtirSolicitudHandler);
app.put("/api/solicitudes/:id/surtir", authRequired, surtirSolicitudHandler);
app.patch("/api/solicitudes/:id/detalles", authRequired, surtirSolicitudHandler);

app.patch("/api/solicitudes/:id/detalles/:detalleId", authRequired, async (req, res) => {
try {
if (!canManageSolicitudes(req)) {
return httpError(res, 403, "Solo el Encargado o Administrador puede modificar la cantidad atendida");
}
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
if (!canManageSolicitudes(req)) {
return httpError(res, 403, "Solo el Encargado o Administrador puede modificar la cantidad atendida");
}
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

async function deleteOrDiscardSolicitud(req, res, { isDraftDiscard = false } = {}) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return httpError(res, 400, "ID invalido");

  const admin = isAdmin(req);
  const canManage = canManageSolicitudes(req);
  if (!isDraftDiscard && !admin) {
    return httpError(res, 403, "Eliminar solo Admin");
  }

  const conn = await poolOps.getConnection();
  try {
    await conn.beginTransaction();
    const [solRows] = await conn.query(
      "SELECT id, usuario_id, status FROM solicitudes WHERE id=? LIMIT 1 FOR UPDATE",
      [id]
    );
    if (!solRows.length) {
      await conn.rollback();
      return res.json({ ok: true, deleted: false });
    }
    const sol = solRows[0];

    if (isDraftDiscard && !canManage && Number(sol.usuario_id) !== Number(req.user?.id)) {
      await conn.rollback();
      return httpError(res, 403, "No puedes descartar una solicitud de otro usuario");
    }

    const pk = await detectProductosPK();
    const [detRows] = await conn.query(
      `SELECT ds.id, ds.atendida, p.CLAVE AS clave
       FROM detalles_solicitud ds
       LEFT JOIN productos p ON p.${qi(pk)} = ds.producto_id
       WHERE ds.solicitud_id = ?
       FOR UPDATE`,
      [id]
    );

    const totalAtendida = detRows.reduce((acc, r) => acc + (Number(r.atendida || 0) || 0), 0);
    if (isDraftDiscard && totalAtendida > 0 && !admin) {
      await conn.rollback();
      return httpError(res, 409, "No se puede descartar una solicitud ya surtida");
    }

    for (const row of detRows) {
      const atendida = Number(row.atendida || 0);
      if (atendida > 0 && row.clave) {
        await applySolicitudStockDeltaForClave(conn, {
          clave: row.clave,
          delta: -atendida,
          responsable: req.user?.username || "web",
          referencia: `SOL-${id}-DEL`,
          observaciones: "Eliminacion de solicitud",
        });
      }
    }

    await conn.query("DELETE FROM detalles_solicitud WHERE solicitud_id = ?", [id]);
    const [delRes] = await conn.query("DELETE FROM solicitudes WHERE id = ?", [id]);
    await conn.commit();
    return res.json({ ok: true, deleted: delRes.affectedRows > 0, id });
  } catch (e) {
    await conn.rollback();
    if (e.statusCode) return httpError(res, e.statusCode, e.message);
    return httpError(res, 400, e.message);
  } finally {
    conn.release();
  }
}

app.delete("/api/solicitudes/:id", authRequired, async (req, res) => {
  const isDraft = String(req.query.draft || "") === "1";
  return deleteOrDiscardSolicitud(req, res, { isDraftDiscard: isDraft });
});

app.post("/api/solicitudes/:id/discard", authRequired, async (req, res) => {
  return deleteOrDiscardSolicitud(req, res, { isDraftDiscard: true });
});

// Helper para parsear un único archivo multipart sin requerir dependencias externas
async function parseMultipartSingleFile(req, maxBytes = 25 * 1024 * 1024) {
  const ctype = req.headers["content-type"] || "";
  const match = ctype.match(/boundary=([^\s;]+)/i);
  if (!match) throw new Error("Encabezado Content-Type sin boundary multipart válido");
  let boundaryStr = match[1].replace(/^["']|["']$/g, "");

  const chunks = [];
  let totalLen = 0;
  for await (const chunk of req) {
    totalLen += chunk.length;
    if (totalLen > maxBytes) throw new Error("El archivo excede el tamaño máximo permitido (25MB)");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const boundaryBuf = Buffer.from(`--${boundaryStr}`);

  const bIndex = body.indexOf(boundaryBuf);
  if (bIndex === -1) throw new Error("Formato multipart inválido");

  const headerStart = bIndex + boundaryBuf.length;
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
  if (headerEnd === -1) throw new Error("Encabezados de archivo no encontrados");

  const headerStr = body.slice(headerStart, headerEnd).toString("utf8");
  const fnMatch = headerStr.match(/filename="?([^"\r\n]+)"?/i);
  const originalFilename = fnMatch ? fnMatch[1].trim() : "respaldo.pdf";
  const ctMatch = headerStr.match(/content-type:\s*([^\r\n;]+)/i);
  const contentType = ctMatch ? ctMatch[1].trim().toLowerCase() : "application/pdf";

  const fileStart = headerEnd + 4;
  const nextBoundaryBuf = Buffer.from(`\r\n--${boundaryStr}`);
  let fileEnd = body.indexOf(nextBoundaryBuf, fileStart);
  if (fileEnd === -1) fileEnd = body.indexOf(boundaryBuf, fileStart);
  if (fileEnd === -1 || fileEnd < fileStart) throw new Error("Contenido del archivo no encontrado");

  const fileBuffer = body.slice(fileStart, fileEnd);
  return { originalFilename, contentType, buffer: fileBuffer };
}

// Subir PDF / Imagen de vale firmado como respaldo de una solicitud
app.post("/api/solicitudes/:id/respaldo", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return httpError(res, 400, "ID de solicitud inválido");
    await assertSolicitudAccess(req, id);

    const fileData = await parseMultipartSingleFile(req);
    if (!fileData || !fileData.buffer || fileData.buffer.length === 0) {
      return httpError(res, 400, "No se recibió ningún archivo");
    }

    const extOriginal = path.extname(fileData.originalFilename || "").toLowerCase();
    const ext = [".pdf", ".png", ".jpg", ".jpeg"].includes(extOriginal) ? extOriginal : ".pdf";
    const filename = `respaldo_sol_${id}_${Date.now()}${ext}`;

    const uploadsDir = path.join(__dirname, "public", "uploads", "respaldos");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const targetPath = path.join(uploadsDir, filename);
    fs.writeFileSync(targetPath, fileData.buffer);

    // DRP: Guardar copia en el repositorio de respaldos sincronizado
    const cleanOrigName = path.basename(fileData.originalFilename || `vale_firmado${ext}`);
    savePdfBackup(fileData.buffer, "pdfs_subidos_firmados", `Firmado_Solicitud_${id}_${cleanOrigName}`);

    await poolOps.query("UPDATE solicitudes SET archivo_respaldo = ? WHERE id = ?", [filename, id]);

    return res.json({
      ok: true,
      archivo: filename,
      message: "Vale firmado guardado en el servidor.",
    });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al subir respaldo firmado");
  }
});

// Ver / Descargar PDF o imagen de vale firmado guardado
app.get("/api/solicitudes/:id/respaldo", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return httpError(res, 400, "ID de solicitud inválido");
    await assertSolicitudAccess(req, id);

    const [rows] = await poolRead.query("SELECT archivo_respaldo FROM solicitudes WHERE id = ? LIMIT 1", [id]);
    if (!rows.length || !rows[0].archivo_respaldo) {
      return httpError(res, 404, "No existe archivo de respaldo guardado para esta solicitud.");
    }

    const filename = path.basename(rows[0].archivo_respaldo);
    const filePath = path.join(__dirname, "public", "uploads", "respaldos", filename);
    if (!fs.existsSync(filePath)) {
      return httpError(res, 404, "El archivo de respaldo físico no se encuentra en el servidor.");
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeMap = {
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
    };
    const ctype = mimeMap[ext] || "application/octet-stream";
    res.setHeader("Content-Type", ctype);
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    return res.sendFile(filePath);
  } catch (e) {
    return httpError(res, 500, e.message);
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

async function upsertProductoFromAlmacen(conn, { CLAVE, DESCRIPCION, CATEGORIA, UNIDAD, ESTADO = "ACTIVO", stock_minimo = null, origen_adquisicion = null, observaciones_control = null }) {
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
if (stock_minimo !== null && stock_minimo !== undefined) {
sets.push(`stock_minimo = ?`);
vals.push(Number(stock_minimo) || 0);
}
if (origen_adquisicion) {
sets.push(`origen_adquisicion = ?`);
vals.push(String(origen_adquisicion));
}
if (observaciones_control !== null && observaciones_control !== undefined) {
sets.push(`observaciones_control = ?`);
vals.push(observaciones_control ? String(observaciones_control).trim() : null);
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
if (stock_minimo !== null && stock_minimo !== undefined) {
cols.push("stock_minimo");
vals.push(Number(stock_minimo) || 0);
}
if (origen_adquisicion) {
cols.push("origen_adquisicion");
vals.push(String(origen_adquisicion));
}
if (observaciones_control !== null && observaciones_control !== undefined) {
cols.push("observaciones_control");
vals.push(observaciones_control ? String(observaciones_control).trim() : null);
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

await syncAlmacenCentralToInventarioRegional(conn).catch(() => {});

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
await syncAlmacenCentralToInventarioRegional(conn).catch(() => {});
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


async function getNextAlmacenClave(connOrPool = poolRead) {
  const [almRows] = await connOrPool.query("SELECT CLAVE FROM almacen_dregcivil WHERE CLAVE IS NOT NULL");
  let prodRows = [];
  try {
    const [pRows] = await connOrPool.query("SELECT CLAVE FROM productos WHERE CLAVE IS NOT NULL");
    prodRows = pRows;
  } catch {}
  let maxNum = 0;
  for (const r of [...almRows, ...prodRows]) {
    const c = String(r.CLAVE || "").trim().toUpperCase();
    const m = c.match(/^CL-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxNum) maxNum = n;
    }
  }
  return `CL-${String(maxNum + 1).padStart(3, "0")}`;
}

// GET /api/almacen: LECTURA abierta a CUALQUIER usuario autenticado (USUARIO, REGIONAL, ENCARGADO, ADMIN).
// La usa buscarProductos() para llenar el selector de materiales al crear una solicitud.
// Para usuarios sin acceso de almacén solo se devuelven materiales activos con existencia (STOCK > 0).
// Las rutas de escritura (POST/PATCH/DELETE) siguen restringidas a admin / encargados de almacén.
app.get("/api/almacen", authRequired, async (req, res) => {
try {
const admin = isAdminDemo(req);
const canAlmacen = hasAlmacenAccess(req);
const isNormalUser = !admin && !canAlmacen;

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
let nextClave = null;
if (!isNormalUser) {
  try { nextClave = await getNextAlmacenClave(poolRead); } catch { nextClave = null; }
}

let extraWhere = clave ? " AND a.CLAVE = ?" : "";
if (isNormalUser) {
  extraWhere += " AND a.STOCK > 0" + (hasEstado && almStatusCol ? ` AND (a.${qi(almStatusCol)} IS NULL OR a.${qi(almStatusCol)} = 'ACTIVO')` : "");
}
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
const cols = `a.ID, a.CLAVE, a.DESCRIPCION, a.CATEGORIA, c.${qi(meta.name).slice(1, -1)} AS CATEGORIA_NOMBRE, ${unidadSelect}, a.STOCK, a.STOCK AS stock, (a.STOCK > 0) AS disponible, a.STOCK AS existencia, a.STOCK AS cantidad_disponible, p.minimo AS minimo, COALESCE(a.stock_minimo, p.stock_minimo, p.minimo, 0) AS stock_minimo, a.origen_adquisicion, a.observaciones_control, ${statusSel}`;
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
return res.json({ ok: true, data: rows, next_clave: nextClave });
} else {
const cols = `a.ID, a.CLAVE, a.DESCRIPCION, a.CATEGORIA, ${unidadSelect}, a.STOCK, a.STOCK AS stock, (a.STOCK > 0) AS disponible, a.STOCK AS existencia, a.STOCK AS cantidad_disponible, p.minimo AS minimo, COALESCE(a.stock_minimo, p.stock_minimo, p.minimo, 0) AS stock_minimo, a.origen_adquisicion, a.observaciones_control, ${statusSel}`;
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
return res.json({ ok: true, data: rows, next_clave: nextClave });
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
let CLAVE = String(body.CLAVE ?? body.clave ?? "").trim().toUpperCase();
const DESCRIPCION = String(body.DESCRIPCION ?? body.descripcion ?? "").trim();
const rawStock = body.STOCK ?? body.stock;
const cantNueva = Number(rawStock);
const rawCat = body.CATEGORIA ?? body.categoria;
const rawUni = String(body.UNIDAD ?? body.unidad ?? "").trim();
const rawMin = body.stock_minimo ?? body.STOCK_MINIMO ?? 0;
const stockMinimo = Math.max(Number(rawMin) || 0, 0);
const rawOrigen = String(body.origen_adquisicion ?? body.ORIGEN_ADQUISICION ?? "COMPRA_DELEGACION").trim().toUpperCase();
const origenAdquisicion = ["COMPRA_DELEGACION", "POR_CONTRATO", "OTRO"].includes(rawOrigen) ? rawOrigen : "COMPRA_DELEGACION";
const observacionesControl = body.observaciones_control !== undefined && body.observaciones_control !== null
  ? (String(body.observaciones_control).trim() || null)
  : null;
const hasUnidad = await hasAlmacenUnidad();
const almStatusCol = await detectAlmacenStatusCol();

if (
  !DESCRIPCION ||
  rawCat == null ||
  String(rawCat).trim() === "" ||
  !rawUni ||
  rawStock === undefined ||
  rawStock === null ||
  String(rawStock).trim() === "" ||
  !Number.isFinite(cantNueva) ||
  cantNueva < 0
) {
  return httpError(res, 400, "Falta agregar información: completa todos los campos");
}

const catIsNum = await almCategoriaIsNumeric();
let CATEGORIA;
if (catIsNum) {
  CATEGORIA = await resolveCategoriaIdOrCreate(rawCat);
} else {
  let c = String(rawCat).trim().toUpperCase();
  if (c.length > 50) c = c.slice(0, 50);
  CATEGORIA = c || null;
}

const UNIDAD = rawUni.toUpperCase().slice(0, 20);
const STATUS_IN = admin
? String(body.status ?? body.STATUS ?? body.estado ?? body.ESTADO ?? "ACTIVO").toUpperCase()
: "ACTIVO";

const conn = await poolOps.getConnection();
try {
await conn.beginTransaction();

if (!CLAVE) {
  CLAVE = await getNextAlmacenClave(conn);
} else if (!replace) {
  const [dupCheck] = await conn.query("SELECT ID FROM almacen_dregcivil WHERE CLAVE=? LIMIT 1", [CLAVE]);
  if (dupCheck.length) {
    CLAVE = await getNextAlmacenClave(conn);
  }
}

const [ex] = await conn.query(`SELECT ID, STOCK FROM almacen_dregcivil WHERE CLAVE=? LIMIT 1`, [CLAVE]);

let idAlm = null;
let delta = cantNueva;
if (ex.length) {
const stockActual = Number(ex[0].STOCK || 0);
let nuevoStock = replace ? cantNueva : stockActual + cantNueva;

const deltaTmp = replace ? nuevoStock - stockActual : cantNueva;
ensureEntradaAllowed(req, deltaTmp, { isNew: false, viaAddStock: !replace });

const baseSets = hasUnidad
? `DESCRIPCION=?, CATEGORIA=?, UNIDAD=?, STOCK=?, stock_minimo=?, origen_adquisicion=?, observaciones_control=?`
: `DESCRIPCION=?, CATEGORIA=?, STOCK=?, stock_minimo=?, origen_adquisicion=?, observaciones_control=?`;
const sets = almStatusCol ? `${baseSets}, ${qi(almStatusCol)}=?` : baseSets;
const params = hasUnidad
? almStatusCol
? [DESCRIPCION, CATEGORIA, UNIDAD, nuevoStock, stockMinimo, origenAdquisicion, observacionesControl, STATUS_IN, ex[0].ID]
: [DESCRIPCION, CATEGORIA, UNIDAD, nuevoStock, stockMinimo, origenAdquisicion, observacionesControl, ex[0].ID]
: almStatusCol
? [DESCRIPCION, CATEGORIA, nuevoStock, stockMinimo, origenAdquisicion, observacionesControl, STATUS_IN, ex[0].ID]
: [DESCRIPCION, CATEGORIA, nuevoStock, stockMinimo, origenAdquisicion, observacionesControl, ex[0].ID];

await conn.query(`UPDATE almacen_dregcivil SET ${sets} WHERE ID=?`, params);
idAlm = ex[0].ID;
delta = replace ? nuevoStock - stockActual : cantNueva;
} else {
ensureEntradaAllowed(req, cantNueva, { isNew: true, viaAddStock: false });

let sql, params;
if (hasUnidad && almStatusCol) {
sql = `INSERT INTO almacen_dregcivil (CLAVE, DESCRIPCION, CATEGORIA, UNIDAD, STOCK, stock_minimo, origen_adquisicion, observaciones_control, ${qi(
almStatusCol
)}) VALUES (?,?,?,?,?,?,?,?,?)`;
params = [CLAVE, DESCRIPCION, CATEGORIA, UNIDAD, cantNueva, stockMinimo, origenAdquisicion, observacionesControl, STATUS_IN];
} else if (!hasUnidad && almStatusCol) {
sql = `INSERT INTO almacen_dregcivil (CLAVE, DESCRIPCION, CATEGORIA, STOCK, stock_minimo, origen_adquisicion, observaciones_control, ${qi(almStatusCol)}) VALUES (?,?,?,?,?,?,?,?)`;
params = [CLAVE, DESCRIPCION, CATEGORIA, cantNueva, stockMinimo, origenAdquisicion, observacionesControl, STATUS_IN];
} else if (hasUnidad && !almStatusCol) {
sql = `INSERT INTO almacen_dregcivil (CLAVE, DESCRIPCION, CATEGORIA, UNIDAD, STOCK, stock_minimo, origen_adquisicion, observaciones_control) VALUES (?,?,?,?,?,?,?,?)`;
params = [CLAVE, DESCRIPCION, CATEGORIA, UNIDAD, cantNueva, stockMinimo, origenAdquisicion, observacionesControl];
} else {
sql = `INSERT INTO almacen_dregcivil (CLAVE, DESCRIPCION, CATEGORIA, STOCK, stock_minimo, origen_adquisicion, observaciones_control) VALUES (?,?,?,?,?,?,?)`;
params = [CLAVE, DESCRIPCION, CATEGORIA, cantNueva, stockMinimo, origenAdquisicion, observacionesControl];
}
const [rs] = await conn.query(sql, params);
idAlm = rs.insertId;
}

await upsertProductoFromAlmacen(conn, {
  CLAVE,
  DESCRIPCION,
  CATEGORIA,
  UNIDAD,
  ESTADO: STATUS_IN,
  stock_minimo: stockMinimo,
  origen_adquisicion: origenAdquisicion,
  observaciones_control: observacionesControl
});

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
res.json({ ok: true, id: idAlm, clave: CLAVE });
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

const allowed = ["CLAVE", "DESCRIPCION", "CATEGORIA", "STOCK", "STOCK_MINIMO", "ORIGEN_ADQUISICION", "OBSERVACIONES_CONTROL"];
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
const touchingOther = Object.keys(data).some((k) => !["STOCK", "STOCK_MINIMO", "ORIGEN_ADQUISICION", "OBSERVACIONES_CONTROL", (almStatusCol || "").toUpperCase()].includes(k));
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
if ("STOCK_MINIMO" in data) {
  data.stock_minimo = Math.max(Number(data.STOCK_MINIMO) || 0, 0);
  delete data.STOCK_MINIMO;
}
if ("ORIGEN_ADQUISICION" in data) {
  const ro = String(data.ORIGEN_ADQUISICION || "").toUpperCase();
  data.origen_adquisicion = ["COMPRA_DELEGACION", "POR_CONTRATO", "OTRO"].includes(ro) ? ro : "COMPRA_DELEGACION";
  delete data.ORIGEN_ADQUISICION;
}
if ("OBSERVACIONES_CONTROL" in data) {
  data.observaciones_control = data.OBSERVACIONES_CONTROL ? String(data.OBSERVACIONES_CONTROL).trim() : null;
  delete data.OBSERVACIONES_CONTROL;
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
stock_minimo: "stock_minimo" in data ? data.stock_minimo : undefined,
origen_adquisicion: "origen_adquisicion" in data ? data.origen_adquisicion : undefined,
observaciones_control: "observaciones_control" in data ? data.observaciones_control : undefined,
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
return httpError(res, e.statusCode || 500, e.message);
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
return httpError(res, e.statusCode || 500, e.message);
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
return httpError(res, e.statusCode || 500, e.message);
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
return httpError(res, e.statusCode || 500, e.message);
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
return httpError(res, e.statusCode || 500, e.message);
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
return httpError(res, e.statusCode || 500, e.message);
}
});

app.get("/api/ui-config", authRequired, async (req, res) => {
  const rol = normalizeRol(req.user?.rol, req.user?.username);
  const admin = isAdmin(req);
  const almacenEncargado = canManageAlmacen(req);
  const regionalAccess = canAccessRegional(req);
  const userRubroId = getUserRubroId(req);
  const scope = await getUserScope(req);
  const puedeEditarReg = canEditRegional(req);
  const puedePdfReg = canGeneratePdfRegional(req);
  const puedeSeleccionarDepto = canSelectAnyDepartment(req);
  const puedeCuatroFirmas = canUseCuatroFirmas(req);

  res.json({
    ok: true,
    user: req.user?.username || null,
    rol: rol,
    rubro_id: userRubroId,
    scope: scope,
    puedeSeleccionarCualquierDepartamento: puedeSeleccionarDepto,
    permisos: {
      admin: admin,
      encargado: almacenEncargado,
      puedeAccederAlmacen: almacenEncargado,
      puedeEditarAlmacen: almacenEncargado,
      puedeEliminarAlmacen: admin,
      puedeAccederRegional: regionalAccess,
      puedeEditarRegional: puedeEditarReg,
      puedeGenerarPdfRegional: puedePdfReg,
      puedeUsarCuatroFirmas: puedeCuatroFirmas,
      puedeVerInventarioEstatal: canViewInventarioGeneral(req.user),
      puedeVerInventarioGeneral: canViewInventarioGeneral(req.user),
      puedeVerTodasSolicitudes: canSeeAllSolicitudes(req),
      puedeSeleccionarCualquierDepartamento: puedeSeleccionarDepto,
      gestionarUsuarios: admin,
      regionalRubroId: userRubroId,
      es_region_foranea: scope.es_region_foranea,
      region_id: scope.region_id,
      region_nombre: scope.region_nombre,
      oficina_id: scope.oficina_id,
      oficialia_id: scope.oficialia_id,
      reportes: {
        acceso: canViewReportes(req),
      },
      solicitudes: {
        puedeCrear: true,
        puedeSurtir: canManageSolicitudes(req),
        puedeCancelar: canManageSolicitudes(req),
        puedeEliminar: admin,
        puedeSeleccionarCualquierDepartamento: puedeSeleccionarDepto,
      },
      verLogs: admin,
    },
  });
});


app.get("/api/solicitudes/:id/pdf", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return httpError(res, 400, "ID invalido");
    await assertSolicitudAccess(req, id);

    // 1. Obtener datos de la solicitud, usuario, departamento y encargado del área
    let solicitud;
    {
      const deptoCol = await detectUsuarioDepartamentoCol();
      const [r] = await poolRead.query(
        `SELECT s.*,
          s.id_oficialia AS id_oficialia,
          u.username,
          ${deptoCol ? `u.${qi(deptoCol)} AS departamento,` : `NULL AS departamento,`}
          CONCAT_WS(' ', u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO) AS nombre_usuario,
          COALESCE(o.nombre, 'Sin Área') AS oficialia_nombre,
          COALESCE(o.oficial_reponsable, '') AS encargado_area
        FROM solicitudes s
        LEFT JOIN oficialias o ON o.id = s.id_oficialia
        LEFT JOIN usuario u ON u.id = s.usuario_id
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

    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 20, bottom: 20, left: 36, right: 36 },
      autoFirstPage: true
    });
    doc.pipe(res);

    // DRP: Respaldo automático de la orden generada
    const fechaBackup = getBackupDateStr(solicitud.fecha_solicitud ? new Date(solicitud.fecha_solicitud) : new Date());
    savePdfBackup(doc, "ordenes_material", `Orden_Folio_${id}_${fechaBackup}.pdf`);

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
    const regionSolicitante = String(solicitud.region_solicitante || "").trim();
    const areaDisplay = regionSolicitante ? `${areaNombre} (${regionSolicitante})` : areaNombre;
    const paraUtilizarseEn = String(solicitud.observaciones || "").trim();
    const fechaTexto = fmtDate(solicitud.fecha_solicitud);

    // Datos para la firma 1: "SOLICITANTE"
    const solicitaDeptoBase = /^departamento/i.test(areaNombre)
      ? areaNombre
      : `Departamento de ${areaNombre}`;
    const solicitaDepto = regionSolicitante
      ? `${solicitaDeptoBase} - ${regionSolicitante}`
      : solicitaDeptoBase;
    const solicitaEncargado = String(
      solicitud.nombre_solicitante_firma || solicitud.encargado_area || solicitud.nombre_usuario || pickUsuarioServer(solicitud) || ""
    ).trim();

    // Datos para las 5 firmas de Vale de Suministro:
    // 1. SOLICITANTE | 2. ENTREGA (Gabriel Fiol) | 3. VALIDA (Jorge Luis Patrón Murillo) | 4. RECIBE | 5. AUTORIZA (Delegada)
    const entregaCargo = process.env.VALE_ENTREGA_CARGO || "ENCARGADO DE ALMACÉN / RECURSOS MATERIALES";
    const entregaNombre = process.env.VALE_ENTREGA_NOMBRE || "GABRIEL FIOL";
    const validaCargo = process.env.VALE_VALIDA_CARGO || "ENCARGADO DE RECURSOS MATERIALES";
    const validaNombre = process.env.VALE_VALIDA_NOMBRE || "JORGE LUIS PATRÓN MURILLO";
    const autorizaCargo = process.env.VALE_AUTORIZA_CARGO || "DELEGADA DE PROGRAMAS PARA EL BIENESTAR EN BCS";
    const autorizaNombre = process.env.VALE_AUTORIZA_NOMBRE || "DIPHNA YANSSEN WEICHSELBAUM CALDERÓN";

    const COLOR_PRIMARY = "#621132";
    const COLOR_SECONDARY = "#4E0D28";
    const COLOR_ACCENT = "#B38E5D";
    const COLOR_SOFT_BG = "#F9F2F4";

    const logoGobPath = [
      path.join(__dirname, "public", "LogoGobiernoMX.png"),
      path.join(__dirname, "public", "logoGobiernoMx.png"),
      path.join(__dirname, "public", "logoGobiernoMX.png"),
      path.join(__dirname, "public", "logogobiernomx.png")
    ].find(p => fs.existsSync(p)) || null;

    const logoBienPath = [
      path.join(__dirname, "public", "logo.png"),
      path.join(__dirname, "public", "logo.original.png")
    ].find(p => fs.existsSync(p)) || null;

    // Función para dibujar el encabezado institucional
    function drawValeHeader() {
      // 1. Logos oficiales en esquinas superiores (discretos y sin empalmarse)
      if (logoGobPath && fs.existsSync(logoGobPath)) {
        try {
          doc.image(logoGobPath, leftX, 16, { fit: [95, 30], align: "left", valign: "top" });
        } catch {}
      }
      if (logoBienPath && fs.existsSync(logoBienPath)) {
        try {
          doc.image(logoBienPath, rightLimit - 85, 16, { fit: [85, 30], align: "right", valign: "top" });
        } catch {}
      }

      // Títulos institucionales centrados
      doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(10.5)
        .text("SECRETARÍA DE BIENESTAR", leftX, 16, { width: tableWidth, align: "center" });
      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(9.5)
        .text("DELEGACIÓN BAJA CALIFORNIA SUR", leftX, 29, { width: tableWidth, align: "center" });
      doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(10.5)
        .text("VALE DE SUMINISTRO", leftX, 43, { width: tableWidth, align: "center" });

      doc.save();
      doc.moveTo(leftX + 130, 56).lineTo(rightLimit - 130, 56).lineWidth(1).strokeColor(COLOR_ACCENT).stroke();
      doc.restore();

      // Bloque superior derecho: FECHA REC. y RECURSOS MATERIALES
      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8)
        .text("FECHA REC.___________________", 370, 60, { width: 206, align: "right" });
      doc.font("Helvetica-Bold").fontSize(8)
        .text("RECURSOS MATERIALES", 370, 72, { width: 206, align: "center" });

      // Fila AREA
      const yArea = 72;
      doc.font("Helvetica-Bold").fontSize(8.5).text("AREA:", leftX, yArea);
      doc.font("Helvetica").fontSize(8.5).text(areaDisplay, leftX + 38, yArea, { width: 310, lineBreak: false });
      doc.moveTo(leftX + 35, yArea + 10).lineTo(350, yArea + 10).lineWidth(0.5).strokeColor("#000000").stroke();

      // Fila PARA UTILIZARSE EN y FECHA
      const yUso = 88;
      doc.font("Helvetica-Bold").fontSize(8.5).text("PARA UTILIZARSE EN:", leftX, yUso);
      doc.font("Helvetica").fontSize(8.5).text(paraUtilizarseEn, leftX + 106, yUso, { width: 242, lineBreak: false });
      doc.moveTo(leftX + 104, yUso + 10).lineTo(350, yUso + 10).lineWidth(0.5).strokeColor("#000000").stroke();

      doc.font("Helvetica-Bold").fontSize(8.5).text("FECHA:", 395, yUso);
      doc.font("Helvetica").fontSize(8.5).text(fechaTexto, 440, yUso, { width: 120, align: "center" });
      doc.moveTo(438, yUso + 10).lineTo(rightLimit, yUso + 10).lineWidth(0.5).strokeColor("#000000").stroke();
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
      const h1 = 12;
      const h2 = 12;
      const totalH = h1 + h2;

      doc.save();
      doc.lineWidth(0.8).strokeColor(COLOR_SECONDARY);

      // Contorno exterior con fondo guinda institucional
      doc.rect(leftX, topY, tableWidth, totalH).fillAndStroke(COLOR_PRIMARY, COLOR_SECONDARY);

      // Líneas divisorias doradas
      doc.strokeColor(COLOR_ACCENT).lineWidth(0.7);
      doc.moveTo(xDesc, topY).lineTo(xDesc, topY + totalH).stroke();
      doc.moveTo(xUni, topY).lineTo(xUni, topY + totalH).stroke();
      doc.moveTo(xSol, topY).lineTo(xSol, topY + totalH).stroke();
      doc.moveTo(xEnt, topY + h1).lineTo(xEnt, topY + totalH).stroke();

      // Línea horizontal que divide CANTIDAD de SOLICITADA / ENTREGADA
      doc.moveTo(xSol, topY + h1).lineTo(rightLimit, topY + h1).stroke();
      doc.restore();

      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8);
      doc.text("No.", xNo, topY + 7, { width: colNoW, align: "center" });
      doc.text("DESCRIPCIÓN DEL ARTÍCULO", xDesc, topY + 7, { width: colDescW, align: "center" });
      doc.text("UNIDAD", xUni, topY + 7, { width: colUniW, align: "center" });
      doc.text("CANTIDAD", xSol, topY + 2, { width: colSolW + colEntW, align: "center" });

      doc.fontSize(7.5);
      doc.text("SOLICITADA", xSol, topY + h1 + 2, { width: colSolW, align: "center" });
      doc.text("ENTREGADA", xEnt, topY + h1 + 2, { width: colEntW, align: "center" });

      return topY + totalH;
    }

    // Dibujar encabezado del vale y encabezado de tabla
    drawValeHeader();
    let currentY = drawTableHeader(104);

    // Completar hasta un mínimo de 14 renglones para mantener la cuadrícula física del formato sin desbordar
    const minRows = 14;
    const totalRows = Math.max(detalles.length, minRows);
    const defaultRowH = 17;

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

      doc.font("Helvetica").fontSize(8);
      const descH = descText ? doc.heightOfString(descText, { width: colDescW - 8 }) : 9;
      const rowH = Math.max(defaultRowH, descH + 5);

      // Si excede el límite antes de las firmas (155 pt para firmas y pie de página), crear nueva página
      if (currentY + rowH > pageHeight - 155) {
        doc.addPage();
        drawValeHeader();
        currentY = drawTableHeader(104);
      }

      doc.save();
      doc.lineWidth(0.5).strokeColor("#000000");
      if (i % 2 === 1) {
        doc.rect(leftX, currentY, tableWidth, rowH).fillAndStroke(COLOR_SOFT_BG, "#000000");
      } else {
        doc.rect(leftX, currentY, tableWidth, rowH).stroke();
      }
      doc.moveTo(xDesc, currentY).lineTo(xDesc, currentY + rowH).stroke();
      doc.moveTo(xUni, currentY).lineTo(xUni, currentY + rowH).stroke();
      doc.moveTo(xSol, currentY).lineTo(xSol, currentY + rowH).stroke();
      doc.moveTo(xEnt, currentY).lineTo(xEnt, currentY + rowH).stroke();
      doc.restore();

      if (item) {
        const textY = currentY + 4;
        doc.fillColor("#000000").font("Helvetica").fontSize(8);
        doc.text(String(i + 1), xNo, textY, { width: colNoW, align: "center" });
        doc.text(descText, xDesc + 4, textY, { width: colDescW - 8, align: "left" });
        doc.text(uniText, xUni + 2, textY, { width: colUniW - 4, align: "center" });
        doc.text(solText, xSol + 2, textY, { width: colSolW - 4, align: "center" });
        doc.text(entText, xEnt + 2, textY, { width: colEntW - 4, align: "center" });
      }

      currentY += rowH;
    }

    // 3. Dibujar las 5 cajas de firma al pie en el nuevo orden institucional (2 filas):
    // Fila 1 (3 columnas): 1.- SOLICITANTE | 2.- ENTREGA | 3.- VALIDA
    // Fila 2 (2 columnas de medio ancho): 4.- RECIBE | 5.- AUTORIZA
    const signBoxH = 50;
    const rowGap = 5;
    const row1Y = Math.max(currentY + 8, 638);
    const row2Y = row1Y + signBoxH + rowGap;

    const gap1 = 8;
    const boxW1 = (tableWidth - gap1 * 2) / 3; // ~174.66 pt cada caja

    const gap2 = 12;
    const boxW2 = (tableWidth - gap2) / 2; // 264 pt cada caja

    const row1LineY = row1Y + 33;
    const row2LineY = row2Y + 33;

    const fechaFirmaFmt = solicitud.fecha_firma_digital ? fmtDate(solicitud.fecha_firma_digital) : fechaTexto;
    const folio = solicitud.folio_firma_digital || `SOL-${id}`;
    const selloFirmaTxt = folio;
    const hasDigitalSig = Boolean(solicitud.firma_solicitante_data && String(solicitud.firma_solicitante_data).includes("base64,"));
    const hasRecibeSig = Boolean(solicitud.firma_recibe_data && String(solicitud.firma_recibe_data).includes("base64,"));

    // Validación específica Mulegé para firma 4 (RECIBE)
    const isMulegeSol = Boolean(
      Number(solicitud.id_oficialia) === 30030010 ||
      Number(solicitud.ID_OFICIALIA) === 30030010 ||
      String(solicitud.username || "").toLowerCase() === "mulege" ||
      /muleg[eé]/i.test(String(solicitud.oficialia_nombre || "")) ||
      /muleg[eé]/i.test(String(solicitud.departamento || "")) ||
      /muleg[eé]/i.test(String(areaNombre || "")) ||
      /muleg[eé]/i.test(String(regionSolicitante || ""))
    );

    const valeBoxes = [
      // Fila 1: 3 columnas (SOLICITANTE, ENTREGA, VALIDA)
      {
        x: leftX,
        y: row1Y,
        w: boxW1,
        h: signBoxH,
        lineY: row1LineY,
        titulo: "1.- SOLICITANTE",
        cargo: solicitaDepto,
        nombre: solicitaEncargado || "Nombre y firma del solicitante",
        isSolicitante: true,
      },
      {
        x: leftX + (boxW1 + gap1) * 1,
        y: row1Y,
        w: boxW1,
        h: signBoxH,
        lineY: row1LineY,
        titulo: "2.- ENTREGA",
        cargo: entregaCargo,
        nombre: entregaNombre,
      },
      {
        x: leftX + (boxW1 + gap1) * 2,
        y: row1Y,
        w: boxW1,
        h: signBoxH,
        lineY: row1LineY,
        titulo: "3.- VALIDA",
        cargo: validaCargo,
        nombre: validaNombre,
      },
      // Fila 2: 2 columnas de medio ancho (RECIBE, AUTORIZA)
      {
        x: leftX,
        y: row2Y,
        w: boxW2,
        h: signBoxH,
        lineY: row2LineY,
        titulo: "4.- RECIBE",
        cargo: isMulegeSol ? "Enlace Regional Mulegé" : String(solicitud.recibe_cargo || "").trim(),
        nombre: isMulegeSol ? "Diana Ramirez Hernandez" : String(solicitud.recibe_nombre || "Nombre y firma de quien recibe el material").trim(),
        isRecibe: true,
      },
      {
        x: leftX + boxW2 + gap2,
        y: row2Y,
        w: boxW2,
        h: signBoxH,
        lineY: row2LineY,
        titulo: "5.- AUTORIZA",
        cargo: autorizaCargo,
        nombre: autorizaNombre,
      },
    ];

    doc.save();
    doc.lineWidth(0.6).strokeColor(COLOR_PRIMARY);
    valeBoxes.forEach((b) => {
      doc.rect(b.x, b.y, b.w, b.h).stroke();
      doc.rect(b.x, b.y, b.w, 11).fillAndStroke(COLOR_SOFT_BG, COLOR_PRIMARY);
      doc.strokeColor("#000000").lineWidth(0.5).moveTo(b.x + 8, b.lineY).lineTo(b.x + b.w - 8, b.lineY).stroke();
      doc.strokeColor(COLOR_PRIMARY);
    });
    doc.restore();

    valeBoxes.forEach((b) => {
      // 1. Encabezado de la firma
      doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(7.2)
        .text(b.titulo, b.x + 2, b.y + 2, { width: b.w - 4, align: "center" });

      // 2. Cargo / departamento
      if (b.cargo) {
        doc.fillColor("#333333").font("Helvetica").fontSize(5.6)
          .text(b.cargo, b.x + 3, b.y + 12.5, { width: b.w - 6, align: "center", lineBreak: false });
      }

      // 3. Firma digital si existe (Solicitante o Recibe)
      if (b.isSolicitante && hasDigitalSig) {
        try {
          const b64Clean = String(solicitud.firma_solicitante_data).split("base64,")[1];
          if (b64Clean) {
            const sigBuf = Buffer.from(b64Clean, "base64");
            doc.image(sigBuf, b.x + 10, b.y + 15, {
              fit: [b.w - 20, 17],
              align: "center",
              valign: "bottom",
            });
          }
        } catch (sigErr) {
          console.warn("[WARN] No se pudo incrustar firma digital en PDF:", sigErr?.message || sigErr);
        }
      } else if (b.isRecibe && hasRecibeSig) {
        try {
          const b64Clean = String(solicitud.firma_recibe_data).split("base64,")[1];
          if (b64Clean) {
            const sigBuf = Buffer.from(b64Clean, "base64");
            doc.image(sigBuf, b.x + 10, b.y + 15, {
              fit: [b.w - 20, 17],
              align: "center",
              valign: "bottom",
            });
          }
        } catch (sigErr) {
          console.warn("[WARN] No se pudo incrustar firma de recepción en PDF:", sigErr?.message || sigErr);
        }
      }

      // 4. Nombre del titular o responsable
      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(6.5)
        .text(b.nombre, b.x + 3, b.lineY + 2.5, { width: b.w - 6, align: "center", lineBreak: false });

      // 5. Sello y folio digital si aplica
      if (b.isSolicitante && (hasDigitalSig || solicitud.folio_firma_digital)) {
        doc.fillColor("#15803d").font("Helvetica").fontSize(4.6)
          .text(
            `Firmado digitalmente el ${fechaFirmaFmt} | Sello: ${selloFirmaTxt}`,
            b.x + 2,
            b.lineY + 9.8,
            { width: b.w - 4, align: "center", lineBreak: false }
          );
      }
    });

    // 4. Pie de página institucional
    const footerY = row2Y + signBoxH + 4;
    doc.font("Helvetica").fontSize(7).fillColor("#333333");
    doc.text(`Folio Solicitud: #${id}`, leftX, footerY, { width: 150, align: "left" });
    doc.text("Hoja 1 De 1", leftX, footerY, { width: tableWidth, align: "center" });
    doc.text("Delegación Baja California Sur", leftX, footerY + 8, { width: tableWidth, align: "center" });

    doc.end();
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// ============================================================================
// FASE B: CONTROL DE INVENTARIO REGIONAL (Módulo Aislado)
// ============================================================================

app.get("/api/regiones", authRequired, async (req, res) => {
  try {
    const [rows] = await poolRead.query(
      `SELECT id, clave, nombre, responsable_regional, activo, created_at
       FROM regiones
       WHERE activo IS NULL OR activo = 1
       ORDER BY id ASC`
    );
    return res.json({ ok: true, data: rows });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

app.get("/api/oficinas", authRequired, async (req, res) => {
  try {
    const regionId = Number(req.query?.region_id || 0);
    const hasRegion = Number.isFinite(regionId) && regionId > 0;
    const [rows] = await poolRead.query(
      `SELECT o.id, o.region_id, r.nombre AS region_nombre, r.clave AS region_clave,
              o.municipio, o.nombre, o.responsable_oficina, o.activo, o.created_at
       FROM oficinas_regionales o
       LEFT JOIN regiones r ON r.id = o.region_id
       WHERE (o.activo IS NULL OR o.activo = 1)
         AND (? = 0 OR o.region_id = ?)
       ORDER BY o.region_id ASC, o.id ASC`,
      [hasRegion ? 1 : 0, hasRegion ? regionId : 0]
    );

    const uName = normalizeUser(req.user?.username);
    const effectiveRubroId = Number(req.query?.rubro_id || getUserRubroId(req) || 0);
    const canSeeRM =
      (isAdmin(req) || ["evelia", "jorge", "jorgepatron", "rodrigo"].includes(uName)) &&
      (!effectiveRubroId || effectiveRubroId === 2);
    const isMobiliario = effectiveRubroId === 3 || uName === "jesus";
    const isVehicular = effectiveRubroId === 2 || uName === "evelia";

    const filteredRows = rows.filter((o) => {
      const nombreNorm = String(o.nombre || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      const isRM =
        nombreNorm.includes("rm (recursos materiales)") ||
        nombreNorm.includes("la paz/rm") ||
        nombreNorm === "rm";
      if (isRM && !canSeeRM) return false;

      const isSA = nombreNorm.includes("s/a") || nombreNorm.includes("sin asignar");

      if (isVehicular) {
        if (isSA) return false;
      }

      if (isMobiliario) {
        if (isRM) return false;
        if (Number(o.id) === 1 || nombreNorm.includes("delegacion la paz")) return false;
        if (isSA) return false;
      }
      return true;
    });

    return res.json({ ok: true, data: filteredRows });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

app.get("/api/rubros", authRequired, async (req, res) => {
  try {
    if (!canAccessRegional(req)) {
      return httpError(res, 403, "Acceso exclusivo para los encargados de Inventario Regional y Administración.");
    }
    const assignedRubroId = getUserRubroId(req);
    const [rows] = await poolRead.query(
      `SELECT id, codigo, nombre_rubro, encargado_nombre, encargado_cargo, activo
       FROM rubros_inventario
       WHERE (activo IS NULL OR activo = 1)
         AND id != 1
         AND (? = 0 OR id = ?)
       ORDER BY id ASC`,
      [assignedRubroId ? 1 : 0, assignedRubroId || 0]
    );
    return res.json({ ok: true, data: rows, assigned_rubro_id: assignedRubroId });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

let INV_HAS_DETALLES_VEHICULO = false;
async function ensureDetallesVehiculoCol() {
  if (INV_HAS_DETALLES_VEHICULO) return true;
  try {
    const [cols] = await poolRead.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'inventario_oficina' AND COLUMN_NAME = 'detalles_vehiculo'
       LIMIT 1`,
      [DB_NAME]
    );
    if (cols.length) {
      INV_HAS_DETALLES_VEHICULO = true;
      return true;
    }
    if (poolOps) {
      await poolOps.query(
        `ALTER TABLE inventario_oficina ADD COLUMN detalles_vehiculo LONGTEXT DEFAULT NULL AFTER observaciones`
      );
      INV_HAS_DETALLES_VEHICULO = true;
      return true;
    }
  } catch (err) {
    console.warn("[WARN] No se pudo verificar/crear columna detalles_vehiculo:", err?.message || err);
  }
  return INV_HAS_DETALLES_VEHICULO;
}

function parseDetallesVehiculo(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const VEHICULO_ESTADO_ITEMS = [
  { key: "estado_mecanico", label: "Estado Mecánico" },
  { key: "estado_electrico", label: "Estado Eléctrico" },
  { key: "estado_carroceria", label: "Estado de Carrocería" },
  { key: "llanta_1", label: "Llanta 1" },
  { key: "llanta_2", label: "Llanta 2" },
  { key: "llanta_3", label: "Llanta 3" },
  { key: "llanta_4", label: "Llanta 4" },
  { key: "llanta_5", label: "Llanta 5" },
];

const VEHICULO_CHECKLIST_ITEMS = [
  { key: "llaves_encendido", label: "Llaves de encendido" },
  { key: "llave_repuesto", label: "Llave de repuesto" },
  { key: "control_remoto_alarma", label: "Control remoto alarma" },
  { key: "radio", label: "Radio" },
  { key: "bocinas", label: "Bocinas" },
  { key: "espejo_retrovisor", label: "Espejo retrovisor" },
  { key: "espejo_lat_derecho", label: "Espejo lat. derecho" },
  { key: "espejo_lat_izquierdo", label: "Espejo lat. izquierdo" },
  { key: "encendedor", label: "Encendedor" },
  { key: "aire_acondicionado", label: "Aire acondicionado" },
  { key: "tarjeta_circulacion", label: "Tarjeta de circulación" },
  { key: "poliza_seguro", label: "Póliza de seguro" },
  { key: "manuales", label: "Manuales" },
  { key: "placa_delantera", label: "Placa delantera" },
  { key: "placa_trasera", label: "Placa trasera" },
  { key: "viseras", label: "Viseras" },
  { key: "claxon", label: "Claxon" },
  { key: "asientos", label: "Asientos" },
  { key: "manijas", label: "Manijas" },
  { key: "tapetes", label: "Tapetes" },
  { key: "llave_cruz", label: "Llave de cruz" },
  { key: "llave_l", label: "Llave L" },
  { key: "dado_seguridad", label: "Dado de seguridad" },
  { key: "reflejantes", label: "Reflejantes" },
  { key: "gato", label: "Gato" },
  { key: "extintor", label: "Extintor" },
  { key: "cables_pasa_corriente", label: "Cables pasa corriente" },
  { key: "herramienta", label: "Herramienta" },
  { key: "llanta_refaccion", label: "Llanta de refacción" },
  { key: "golpes", label: "Golpes" },
  { key: "rayones", label: "Rayones" },
  { key: "emblemas", label: "Emblemas" },
  { key: "faros", label: "Faros" },
  { key: "calaveras", label: "Calaveras" },
  { key: "tumba_burros", label: "Tumba burros" },
  { key: "tira_remolque", label: "Tira remolque" },
  { key: "biseles", label: "Biseles" },
  { key: "tapones_llantas", label: "Tapones de llantas" },
  { key: "tapon_gasolina", label: "Tapón de gasolina" },
  { key: "brazos_limpiadores", label: "Brazos limpiadores" },
  { key: "bayoneta_aceite", label: "Bayoneta de aceite" },
  { key: "bayoneta_transmision", label: "Bayoneta de transmisión" },
];

async function queryRegionalInventory({ region_id, oficina_id, rubro_id, activo_id, forceUngrouped = false }) {
  const hasDetCol = await ensureDetallesVehiculoCol();
  const regionId = Number(region_id || 0);
  const oficinaId = Number(oficina_id || 0);
  const rubroId = Number(rubro_id || 0);
  const activoId = Number(activo_id || 0);

  const hasRegion = Number.isFinite(regionId) && regionId > 0;
  const hasOficina = Number.isFinite(oficinaId) && oficinaId > 0;
  const hasRubro = Number.isFinite(rubroId) && rubroId > 0;
  const hasActivo = Number.isFinite(activoId) && activoId > 0;

  // Verificar si el rubro filtrado es PARQUE_VEHICULAR (los vehículos no deben agruparse para permitir editar/imprimir cada unidad)
  let isParqueVehicular = false;
  if (hasRubro) {
    try {
      const [[rub]] = await poolRead.query(`SELECT codigo FROM rubros_inventario WHERE id = ? LIMIT 1`, [rubroId]);
      if (String(rub?.codigo || "").trim().toUpperCase() === "PARQUE_VEHICULAR") {
        isParqueVehicular = true;
      }
    } catch {}
  }

  if (!hasOficina && hasRegion && !hasActivo && !forceUngrouped && !isParqueVehicular) {
    const [rows] = await poolRead.query(
      `SELECT
         MIN(io.id) AS id,
         io.clave_bien,
         io.descripcion,
         io.marca_modelo,
         GROUP_CONCAT(DISTINCT NULLIF(TRIM(io.numero_serie_placas), '') SEPARATOR ', ') AS numero_serie_placas,
         MAX(io.unidad) AS unidad,
         SUM(io.cantidad_propia) AS cantidad_propia,
         SUM(io.cantidad_prestada_recibida) AS cantidad_prestada_recibida,
         SUM(io.cantidad_prestada_enviada) AS cantidad_prestada_enviada,
         MAX(io.estado_fisico) AS estado_fisico,
         io.estatus_uso,
         COUNT(DISTINCT io.oficina_id) AS total_oficinas,
         GROUP_CONCAT(DISTINCT NULLIF(TRIM(io.observaciones), '') SEPARATOR ' | ') AS observaciones,
         MAX(io.origen_adquisicion) AS origen_adquisicion,
         GROUP_CONCAT(DISTINCT NULLIF(TRIM(io.observaciones_control), '') SEPARATOR ' | ') AS observaciones_control,
         ${hasDetCol ? "MAX(io.detalles_vehiculo)" : "NULL"} AS detalles_vehiculo,
         MAX(r.id) AS region_id,
         MAX(r.nombre) AS region_nombre,
         MAX(r.responsable_regional) AS responsable_regional,
         NULL AS oficina_id,
         GROUP_CONCAT(DISTINCT o.nombre SEPARATOR ', ') AS oficina_nombre,
         MAX(io.rubro_id) AS rubro_id,
         MAX(ru.codigo) AS rubro_codigo,
         MAX(ru.nombre_rubro) AS nombre_rubro,
         MAX(ru.encargado_nombre) AS encargado_nombre,
         MAX(ru.encargado_cargo) AS encargado_cargo
       FROM inventario_oficina io
       INNER JOIN oficinas_regionales o ON o.id = io.oficina_id
       INNER JOIN regiones r ON r.id = o.region_id
       LEFT JOIN rubros_inventario ru ON ru.id = io.rubro_id
       WHERE o.region_id = ?
         AND io.rubro_id != 1
         AND (? = 0 OR io.rubro_id = ?)
         AND (io.rubro_id != 2 OR (o.nombre NOT LIKE '%S/A%' AND o.nombre NOT LIKE '%Sin Asignar%'))
         AND COALESCE(io.es_bodega_delegacion, 0) = 0
       GROUP BY io.clave_bien, io.descripcion, io.marca_modelo, io.estatus_uso
       ORDER BY io.clave_bien ASC, io.descripcion ASC`,
      [regionId, hasRubro ? 1 : 0, hasRubro ? rubroId : 0]
    );
    return {
      grouped: true,
      rows: rows.map((r) => ({ ...r, detalles_vehiculo: parseDetallesVehiculo(r.detalles_vehiculo) })),
    };
  }

  const [rows] = await poolRead.query(
    `SELECT
       io.id,
       io.oficina_id,
       o.nombre AS oficina_nombre,
       o.municipio,
       r.id AS region_id,
       r.nombre AS region_nombre,
       r.responsable_regional,
       io.rubro_id,
       ru.codigo AS rubro_codigo,
       ru.nombre_rubro,
       ru.encargado_nombre,
       ru.encargado_cargo,
       io.clave_bien,
       io.descripcion,
       io.marca_modelo,
       io.numero_serie_placas,
       io.unidad,
       io.cantidad_propia,
       io.cantidad_prestada_recibida,
       io.cantidad_prestada_enviada,
       io.estado_fisico,
       io.estatus_uso,
       io.observaciones,
       io.origen_adquisicion,
       io.observaciones_control,
       ${hasDetCol ? "io.detalles_vehiculo" : "NULL AS detalles_vehiculo"},
       io.updated_at
     FROM inventario_oficina io
     INNER JOIN oficinas_regionales o ON o.id = io.oficina_id
     INNER JOIN regiones r ON r.id = o.region_id
     LEFT JOIN rubros_inventario ru ON ru.id = io.rubro_id
     WHERE io.rubro_id != 1
       AND (? = 0 OR o.region_id = ?)
       AND (? = 0 OR io.oficina_id = ?)
       AND (? = 0 OR io.rubro_id = ?)
       AND (? = 0 OR io.id = ?)
       AND (io.rubro_id != 2 OR (o.nombre NOT LIKE '%S/A%' AND o.nombre NOT LIKE '%Sin Asignar%'))
       AND COALESCE(io.es_bodega_delegacion, 0) = 0
     ORDER BY r.id ASC, o.id ASC, io.clave_bien ASC`,
    [
      hasRegion ? 1 : 0, hasRegion ? regionId : 0,
      hasOficina ? 1 : 0, hasOficina ? oficinaId : 0,
      hasRubro ? 1 : 0, hasRubro ? rubroId : 0,
      hasActivo ? 1 : 0, hasActivo ? activoId : 0,
    ]
  );
  return {
    grouped: false,
    rows: rows.map((r) => ({ ...r, detalles_vehiculo: parseDetallesVehiculo(r.detalles_vehiculo) })),
  };
}

app.get("/api/inventario-regional", authRequired, async (req, res) => {
  try {
    if (!canAccessRegional(req)) {
      return httpError(res, 403, "No tienes acceso al módulo de Inventario Regional.");
    }
    const assignedRubroId = getUserRubroId(req);
    const scope = await getUserScope(req);
    const canEdit = canEditRegional(req);
    const canPdf = canGeneratePdfRegional(req);
    let { region_id, oficina_id, rubro_id, activo_id } = req.query || {};

    // Regla A (29/10/26): Si el usuario NO es encargado de rubro ni admin,
    // solo puede consultar los registros de su propia región asignada en modo lectura.
    if (!canEdit) {
      region_id = scope.region_id;
    }

    const effectiveRubroId = assignedRubroId || rubro_id;
    const { grouped, rows } = await queryRegionalInventory({
      region_id,
      oficina_id,
      rubro_id: effectiveRubroId,
      activo_id,
    });
    return res.json({
      ok: true,
      grouped,
      assigned_rubro_id: assignedRubroId,
      puedeEditar: canEdit,
      puedeGenerarPdf: canPdf,
      region_asignada_id: !canEdit ? scope.region_id : null,
      data: rows
    });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// Alta de un activo en el inventario de una oficina regional (incluye soporte híbrido para PARQUE_VEHICULAR)
app.post("/api/inventario-regional", authRequired, async (req, res) => {
  try {
    if (!canEditRegional(req)) {
      return httpError(res, 403, "Modo Solo Lectura: solo los encargados de rubro y administración pueden agregar bienes al inventario regional.");
    }
    const assignedRubroId = getUserRubroId(req);
    const hasDetCol = await ensureDetallesVehiculoCol();
    const b = req.body || {};
    const oficinaId = Number(b.oficina_id || 0);
    const rubroId = assignedRubroId ? Number(assignedRubroId) : Number(b.rubro_id || 0);
    if (assignedRubroId && b.rubro_id && Number(b.rubro_id) !== Number(assignedRubroId)) {
      return httpError(res, 403, "Solo puedes agregar activos del rubro asignado a tu usuario.");
    }
    const claveBien = String(b.clave_bien ?? "").trim();
    const descripcion = String(b.descripcion ?? "").trim();
    let marcaModelo = String(b.marca_modelo ?? "").trim() || null;
    let seriePlacas = String(b.numero_serie_placas ?? "").trim() || null;
    const cantidadRaw = b.cantidad_propia ?? b.cantidad;
    const cantidad = cantidadRaw === undefined || cantidadRaw === null || cantidadRaw === ""
      ? 1
      : Number(cantidadRaw);
    const estadoFisico = String(b.estado_fisico || "BUENO").trim().toUpperCase();
    const estatusUso = String(b.estatus_uso || "ACTIVO").trim().toUpperCase();
    const observaciones = b.observaciones != null && String(b.observaciones).trim() !== ""
      ? String(b.observaciones).trim()
      : null;
    const rawOrigen = String(b.origen_adquisicion || "COMPRA_DELEGACION").trim().toUpperCase();
    const origenAdquisicion = ["COMPRA_DELEGACION", "POR_CONTRATO", "OTRO"].includes(rawOrigen) ? rawOrigen : "COMPRA_DELEGACION";
    const observacionesControl = b.observaciones_control != null && String(b.observaciones_control).trim() !== ""
      ? String(b.observaciones_control).trim()
      : null;
    const detallesVehiculoObj = parseDetallesVehiculo(b.detalles_vehiculo);

    if (detallesVehiculoObj && detallesVehiculoObj.unidad) {
      const u = detallesVehiculoObj.unidad;
      if (!marcaModelo) {
        marcaModelo = [u.marca, u.tipo, u.modelo].map((x) => String(x || "").trim()).filter(Boolean).join(" ").slice(0, 150) || null;
      }
      if (!seriePlacas) {
        seriePlacas = [u.placas, u.serie_vin].map((x) => String(x || "").trim()).filter(Boolean).join(" / ").slice(0, 100) || null;
      }
    }

    if (!Number.isInteger(oficinaId) || oficinaId <= 0) return httpError(res, 400, "Oficina requerida");
    if (!Number.isInteger(rubroId) || rubroId <= 0) return httpError(res, 400, "Rubro requerido");
    if (!claveBien) return httpError(res, 400, "Clave del bien requerida");
    if (!descripcion) return httpError(res, 400, "Descripción requerida");
    if (!Number.isInteger(cantidad) || cantidad < 1) return httpError(res, 400, "La cantidad debe ser un entero mayor o igual a 1");
    if (!["BUENO", "REGULAR", "MALO", "BAJA"].includes(estadoFisico)) return httpError(res, 400, "Estado físico inválido");
    if (!["ACTIVO", "PRESTADO", "EN_REPARACION", "BAJA"].includes(estatusUso)) return httpError(res, 400, "Estatus de uso inválido");
    if (claveBien.length > 60) return httpError(res, 400, "La clave del bien excede 60 caracteres");
    if (descripcion.length > 255) return httpError(res, 400, "La descripción excede 255 caracteres");
    if (marcaModelo && marcaModelo.length > 150) return httpError(res, 400, "Marca / Modelo excede 150 caracteres");
    if (seriePlacas && seriePlacas.length > 100) return httpError(res, 400, "Serie / Placas excede 100 caracteres");

    const [[ofi]] = await poolRead.query(`SELECT id FROM oficinas_regionales WHERE id = ? LIMIT 1`, [oficinaId]);
    if (!ofi) return httpError(res, 400, "La oficina seleccionada no existe");
    const [[rub]] = await poolRead.query(`SELECT id FROM rubros_inventario WHERE id = ? LIMIT 1`, [rubroId]);
    if (!rub) return httpError(res, 400, "El rubro seleccionado no existe");

    const detallesJson = detallesVehiculoObj ? JSON.stringify(detallesVehiculoObj) : null;

    let result;
    if (hasDetCol) {
      [result] = await poolOps.query(
        `INSERT INTO inventario_oficina
           (oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas, cantidad_propia, estado_fisico, estatus_uso, observaciones, origen_adquisicion, observaciones_control, detalles_vehiculo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [oficinaId, rubroId, claveBien, descripcion, marcaModelo, seriePlacas, cantidad, estadoFisico, estatusUso, observaciones, origenAdquisicion, observacionesControl, detallesJson]
      );
    } else {
      [result] = await poolOps.query(
        `INSERT INTO inventario_oficina
           (oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas, cantidad_propia, estado_fisico, estatus_uso, observaciones, origen_adquisicion, observaciones_control)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [oficinaId, rubroId, claveBien, descripcion, marcaModelo, seriePlacas, cantidad, estadoFisico, estatusUso, observaciones, origenAdquisicion, observacionesControl]
      );
    }

    if (oficinaId === 1 && rubroId === 1) {
      await poolOps.query(
        `INSERT INTO almacen_dregcivil (CLAVE, DESCRIPCION, UNIDAD, STOCK, origen_adquisicion, observaciones_control, ESTADO)
         VALUES (?, ?, ?, ?, ?, ?, 'ACTIVO')
         ON DUPLICATE KEY UPDATE
           DESCRIPCION = VALUES(DESCRIPCION),
           UNIDAD = VALUES(UNIDAD),
           STOCK = VALUES(STOCK),
           origen_adquisicion = VALUES(origen_adquisicion),
           observaciones_control = VALUES(observaciones_control)`,
        [claveBien, descripcion, b.unidad || 'PIEZA', cantidad, origenAdquisicion, observacionesControl]
      ).catch(() => {});
    }

    return res.status(201).json({ ok: true, id: result.insertId });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// Edición de un activo en el inventario regional (incluye datos y checklist de PARQUE_VEHICULAR)
app.put("/api/inventario-regional/:id", authRequired, async (req, res) => {
  try {
    if (!canEditRegional(req)) {
      return httpError(res, 403, "Modo Solo Lectura: solo los encargados de rubro y administración pueden editar bienes del inventario regional.");
    }
    const assignedRubroId = getUserRubroId(req);
    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return httpError(res, 400, "ID de activo inválido");

    if (assignedRubroId) {
      const [[existingAsset]] = await poolRead.query(
        `SELECT id, rubro_id FROM inventario_oficina WHERE id = ? LIMIT 1`,
        [id]
      );
      if (!existingAsset) return httpError(res, 404, "Activo no encontrado");
      if (Number(existingAsset.rubro_id) !== Number(assignedRubroId)) {
        return httpError(res, 403, "Solo puedes editar activos del rubro del cual eres encargado.");
      }
    }

    const hasDetCol = await ensureDetallesVehiculoCol();
    const b = req.body || {};
    const oficinaId = Number(b.oficina_id || 0);
    const rubroId = assignedRubroId ? Number(assignedRubroId) : Number(b.rubro_id || 0);
    const claveBien = String(b.clave_bien ?? "").trim();
    const descripcion = String(b.descripcion ?? "").trim();
    let marcaModelo = String(b.marca_modelo ?? "").trim() || null;
    let seriePlacas = String(b.numero_serie_placas ?? "").trim() || null;
    const cantidadRaw = b.cantidad_propia ?? b.cantidad;
    const cantidad = cantidadRaw === undefined || cantidadRaw === null || cantidadRaw === ""
      ? 1
      : Number(cantidadRaw);
    const estadoFisico = String(b.estado_fisico || "BUENO").trim().toUpperCase();
    const estatusUso = String(b.estatus_uso || "ACTIVO").trim().toUpperCase();
    const observaciones = b.observaciones != null && String(b.observaciones).trim() !== ""
      ? String(b.observaciones).trim()
      : null;
    const rawOrigen = String(b.origen_adquisicion || "COMPRA_DELEGACION").trim().toUpperCase();
    const origenAdquisicion = ["COMPRA_DELEGACION", "POR_CONTRATO", "OTRO"].includes(rawOrigen) ? rawOrigen : "COMPRA_DELEGACION";
    const observacionesControl = b.observaciones_control != null && String(b.observaciones_control).trim() !== ""
      ? String(b.observaciones_control).trim()
      : null;
    const detallesVehiculoObj = parseDetallesVehiculo(b.detalles_vehiculo);

    if (detallesVehiculoObj && detallesVehiculoObj.unidad) {
      const u = detallesVehiculoObj.unidad;
      if (!marcaModelo) {
        marcaModelo = [u.marca, u.tipo, u.modelo].map((x) => String(x || "").trim()).filter(Boolean).join(" ").slice(0, 150) || null;
      }
      if (!seriePlacas) {
        seriePlacas = [u.placas, u.serie_vin].map((x) => String(x || "").trim()).filter(Boolean).join(" / ").slice(0, 100) || null;
      }
    }

    if (!Number.isInteger(oficinaId) || oficinaId <= 0) return httpError(res, 400, "Oficina requerida");
    if (!Number.isInteger(rubroId) || rubroId <= 0) return httpError(res, 400, "Rubro requerido");
    if (!claveBien) return httpError(res, 400, "Clave del bien requerida");
    if (!descripcion) return httpError(res, 400, "Descripción requerida");
    if (!Number.isInteger(cantidad) || cantidad < 1) return httpError(res, 400, "La cantidad debe ser un entero mayor o igual a 1");
    if (!["BUENO", "REGULAR", "MALO", "BAJA"].includes(estadoFisico)) return httpError(res, 400, "Estado físico inválido");
    if (!["ACTIVO", "PRESTADO", "EN_REPARACION", "BAJA"].includes(estatusUso)) return httpError(res, 400, "Estatus de uso inválido");

    const detallesJson = detallesVehiculoObj ? JSON.stringify(detallesVehiculoObj) : null;

    if (hasDetCol) {
      await poolOps.query(
        `UPDATE inventario_oficina
         SET oficina_id = ?, rubro_id = ?, clave_bien = ?, descripcion = ?,
             marca_modelo = ?, numero_serie_placas = ?, cantidad_propia = ?,
             estado_fisico = ?, estatus_uso = ?, observaciones = ?,
             origen_adquisicion = ?, observaciones_control = ?, detalles_vehiculo = ?
         WHERE id = ?`,
        [oficinaId, rubroId, claveBien, descripcion, marcaModelo, seriePlacas, cantidad, estadoFisico, estatusUso, observaciones, origenAdquisicion, observacionesControl, detallesJson, id]
      );
    } else {
      await poolOps.query(
        `UPDATE inventario_oficina
         SET oficina_id = ?, rubro_id = ?, clave_bien = ?, descripcion = ?,
             marca_modelo = ?, numero_serie_placas = ?, cantidad_propia = ?,
             estado_fisico = ?, estatus_uso = ?, observaciones = ?,
             origen_adquisicion = ?, observaciones_control = ?
         WHERE id = ?`,
        [oficinaId, rubroId, claveBien, descripcion, marcaModelo, seriePlacas, cantidad, estadoFisico, estatusUso, observaciones, origenAdquisicion, observacionesControl, id]
      );
    }

    if (oficinaId === 1 && rubroId === 1) {
      await poolOps.query(
        `UPDATE almacen_dregcivil
         SET CLAVE = ?, DESCRIPCION = ?, UNIDAD = ?, STOCK = ?, origen_adquisicion = ?, observaciones_control = ?
         WHERE CLAVE = ?`,
        [claveBien, descripcion, b.unidad || 'PIEZA', cantidad, origenAdquisicion, observacionesControl, claveBien]
      ).catch(() => {});
    }

    return res.json({ ok: true, id });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// Punto 5: Transferencia de inventario entre oficinas regionales
app.post("/api/inventario-regional/:id/transferir", authRequired, async (req, res) => {
  try {
    if (!canEditRegional(req)) {
      return httpError(res, 403, "Modo Solo Lectura: solo los encargados de rubro y administración pueden transferir activos regionales.");
    }
    const assetId = Number(req.params.id || 0);
    if (!Number.isInteger(assetId) || assetId <= 0) {
      return httpError(res, 400, "ID de activo inválido.");
    }

    const { oficina_destino_id, motivo } = req.body || {};
    const destOfiId = Number(oficina_destino_id || 0);
    const cantRaw = req.body?.cantidad_transferir !== undefined ? req.body.cantidad_transferir : req.body?.cantidad;
    const cantTrans = Number(cantRaw || 0);
    const motivoClean = String(motivo || "").trim();

    if (!Number.isInteger(destOfiId) || destOfiId <= 0) {
      return httpError(res, 400, "Debes seleccionar una oficina de destino válida.");
    }
    if (!Number.isInteger(cantTrans) || cantTrans <= 0) {
      return httpError(res, 400, "La cantidad a transferir debe ser un número entero mayor a 0.");
    }

    const assignedRubroId = getUserRubroId(req);

    const [[asset]] = await poolRead.query(
      `SELECT io.*, o.nombre AS oficina_origen_nombre, r.nombre AS region_origen_nombre
       FROM inventario_oficina io
       INNER JOIN oficinas_regionales o ON o.id = io.oficina_id
       INNER JOIN regiones r ON r.id = o.region_id
       WHERE io.id = ? LIMIT 1`,
      [assetId]
    );
    if (!asset) return httpError(res, 404, "El activo que intentas transferir no existe.");

    if (assignedRubroId && Number(asset.rubro_id) !== Number(assignedRubroId)) {
      return httpError(res, 403, "Solo puedes transferir activos pertenecientes a tu rubro asignado.");
    }

    if (Number(asset.oficina_id) === destOfiId) {
      return httpError(res, 400, "La oficina destino debe ser distinta a la oficina origen actual.");
    }

    const cantActual = Number(asset.cantidad_propia || 0);
    if (cantTrans > cantActual) {
      return httpError(res, 400, `Existencia insuficiente. Solo hay ${cantActual} unidades disponibles.`);
    }

    const [[destOfi]] = await poolRead.query(
      `SELECT o.id, o.nombre, r.nombre AS region_nombre
       FROM oficinas_regionales o
       INNER JOIN regiones r ON r.id = o.region_id
       WHERE o.id = ? LIMIT 1`,
      [destOfiId]
    );
    if (!destOfi) return httpError(res, 400, "La oficina de destino seleccionada no existe.");

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();
      const fechaStr = new Date().toLocaleDateString("es-MX", { timeZone: "America/Mazatlan" });
      const userStr = req.user?.username || "admin";

      if (cantTrans === cantActual) {
        const notaTrans = `[Transferido de ${asset.oficina_origen_nombre} a ${destOfi.nombre} (${fechaStr}, ${userStr})${motivoClean ? ` - ${motivoClean}` : ""}]`;
        await conn.query(
          `UPDATE inventario_oficina
           SET oficina_id = ?,
               observaciones = CONCAT_WS(' | ', NULLIF(observaciones, ''), ?)
           WHERE id = ?`,
          [destOfiId, notaTrans, assetId]
        );
      } else {
        const notaOrigen = `[Transferidas ${cantTrans} u. a ${destOfi.nombre} (${fechaStr}, ${userStr})${motivoClean ? ` - ${motivoClean}` : ""}]`;
        await conn.query(
          `UPDATE inventario_oficina
           SET cantidad_propia = cantidad_propia - ?,
               observaciones = CONCAT_WS(' | ', NULLIF(observaciones, ''), ?)
           WHERE id = ?`,
          [cantTrans, notaOrigen, assetId]
        );

        const [destExisting] = await conn.query(
          `SELECT id, cantidad_propia FROM inventario_oficina
           WHERE oficina_id = ? AND rubro_id = ? AND clave_bien = ? AND descripcion = ? LIMIT 1`,
          [destOfiId, asset.rubro_id, asset.clave_bien, asset.descripcion]
        );
        const notaDestino = `[Recibidas ${cantTrans} u. desde ${asset.oficina_origen_nombre} (${fechaStr}, ${userStr})${motivoClean ? ` - ${motivoClean}` : ""}]`;

        if (destExisting.length) {
          await conn.query(
            `UPDATE inventario_oficina
             SET cantidad_propia = cantidad_propia + ?,
                 observaciones = CONCAT_WS(' | ', NULLIF(observaciones, ''), ?)
             WHERE id = ?`,
            [cantTrans, notaDestino, destExisting[0].id]
          );
        } else {
          const hasDetCol = await ensureDetallesVehiculoCol();
          const detallesJson = asset.detalles_vehiculo
            ? (typeof asset.detalles_vehiculo === "string" ? asset.detalles_vehiculo : JSON.stringify(asset.detalles_vehiculo))
            : null;
          if (hasDetCol) {
            await conn.query(
              `INSERT INTO inventario_oficina
                 (oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas,
                  cantidad_propia, estado_fisico, estatus_uso, observaciones,
                  origen_adquisicion, observaciones_control, detalles_vehiculo)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                destOfiId, asset.rubro_id, asset.clave_bien, asset.descripcion,
                asset.marca_modelo, asset.numero_serie_placas, cantTrans,
                asset.estado_fisico || "BUENO", asset.estatus_uso || "ACTIVO",
                notaDestino, asset.origen_adquisicion || "COMPRA_DELEGACION",
                asset.observaciones_control || null, detallesJson
              ]
            );
          } else {
            await conn.query(
              `INSERT INTO inventario_oficina
                 (oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas,
                  cantidad_propia, estado_fisico, estatus_uso, observaciones,
                  origen_adquisicion, observaciones_control)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                destOfiId, asset.rubro_id, asset.clave_bien, asset.descripcion,
                asset.marca_modelo, asset.numero_serie_placas, cantTrans,
                asset.estado_fisico || "BUENO", asset.estatus_uso || "ACTIVO",
                notaDestino, asset.origen_adquisicion || "COMPRA_DELEGACION",
                asset.observaciones_control || null
              ]
            );
          }
        }
      }

      await conn.commit();
      return res.json({
        ok: true,
        message: `Se transfirieron ${cantTrans} unidad(es) hacia ${destOfi.nombre} exitosamente.`
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

async function handleInventarioRegionalFormatos(req, res) {
  try {
    if (!canGeneratePdfRegional(req)) {
      return httpError(res, 403, "No tienes permisos para descargar el PDF de resguardo regional");
    }
    const assignedRubroId = getUserRubroId(req);
    const body = req.body || {};
    let regionId = Number(body.region_id ?? req.query?.region_id ?? 0) || null;
    let oficinaId = Number(body.oficina_id ?? req.query?.oficina_id ?? 0) || null;
    let rubroId = assignedRubroId
      ? Number(assignedRubroId)
      : (Number(body.rubro_id ?? req.query?.rubro_id ?? 0) || null);
    const activoId = Number(body.activo_id ?? req.query?.activo_id ?? req.params?.id ?? 0) || null;
    const observaciones = body.observaciones ? String(body.observaciones).trim() : null;

    if (Number(rubroId) === 1) {
      return httpError(res, 400, "El Rubro 1 (Archivo y Materiales) no pertenece a Inventario Regional.");
    }

    if (assignedRubroId && body.rubro_id && Number(body.rubro_id) !== Number(assignedRubroId)) {
      return httpError(res, 403, "Solo puedes generar formatos PDF de tu rubro asignado.");
    }

    // Validación estricta: no se permite generar el formato general (todos los filtros en "Todos")
    if (!regionId && !oficinaId && !rubroId && !activoId) {
      return res.status(400).json({ error: "Para generar el formato PDF, debes filtrar por al menos una Región o Rubro." });
    }

    // Si se solicitó un activo específico (ej. botón "Resguardo PDF" de un vehículo), recuperar su oficina/región/rubro
    if (activoId) {
      const [actRows] = await poolRead.query(
        `SELECT oficina_id, rubro_id FROM inventario_oficina WHERE id = ? LIMIT 1`,
        [activoId]
      );
      if (actRows.length) {
        if (assignedRubroId && Number(actRows[0].rubro_id) !== Number(assignedRubroId)) {
          return httpError(res, 403, "No tienes permiso para generar el formato PDF de un activo de otro rubro.");
        }
        if (!oficinaId) oficinaId = Number(actRows[0].oficina_id) || null;
        if (!rubroId) rubroId = Number(actRows[0].rubro_id) || null;
      }
    }

    // 1. Obtener datos de Oficina si fue seleccionada
    let oficinaRow = null;
    if (oficinaId) {
      const [ofRows] = await poolRead.query(
        `SELECT id, region_id, municipio, nombre, responsable_oficina
         FROM oficinas_regionales WHERE id = ? LIMIT 1`,
        [oficinaId]
      );
      if (ofRows.length) {
        oficinaRow = ofRows[0];
        if (!regionId) regionId = Number(oficinaRow.region_id) || null;
      }
    }

    // 2. Obtener datos de Región (para firma "Recibe")
    let regionRow = null;
    if (regionId) {
      const [regRows] = await poolRead.query(
        `SELECT id, clave, nombre, responsable_regional
         FROM regiones WHERE id = ? LIMIT 1`,
        [regionId]
      );
      if (regRows.length) regionRow = regRows[0];
    }

    // 3. Obtener datos de Rubro (para firma "Entrega")
    let rubroRow = null;
    if (rubroId) {
      const [rubRows] = await poolRead.query(
        `SELECT id, codigo, nombre_rubro, encargado_nombre, encargado_cargo
         FROM rubros_inventario WHERE id = ? LIMIT 1`,
        [rubroId]
      );
      if (rubRows.length) rubroRow = rubRows[0];
    }

    // 4. Obtener los registros del inventario según el filtro actual
    const { grouped, rows: items } = await queryRegionalInventory({
      region_id: regionId,
      oficina_id: oficinaId,
      rubro_id: rubroId,
      activo_id: activoId,
    });

    // Determinar si el formato corresponde a PARQUE_VEHICULAR
    const isParqueVehicular =
      String(rubroRow?.codigo || "").trim().toUpperCase() === "PARQUE_VEHICULAR" ||
      (items.length > 0 && items.every((it) => String(it.rubro_codigo || "").trim().toUpperCase() === "PARQUE_VEHICULAR"));

    // 6. Asegurar IDs válidos para las llaves foráneas NOT NULL de formatos_inventario_regional
    let dbRegionId = regionRow?.id || (items[0]?.region_id ? Number(items[0].region_id) : null);
    if (!dbRegionId) {
      const [rFirst] = await poolRead.query(`SELECT id FROM regiones ORDER BY id ASC LIMIT 1`);
      dbRegionId = rFirst[0]?.id || 1;
    }

    let dbRubroId = rubroRow?.id || (items[0]?.rubro_id ? Number(items[0].rubro_id) : null);
    if (!dbRubroId) {
      const [ruFirst] = await poolRead.query(`SELECT id FROM rubros_inventario ORDER BY id ASC LIMIT 1`);
      dbRubroId = ruFirst[0]?.id || 1;
    }

    const regionLabel = regionRow ? regionRow.nombre : (items[0]?.region_nombre || "Todas las Regiones");
    const oficinaLabel = oficinaRow
      ? `${oficinaRow.nombre} (${oficinaRow.municipio})`
      : (regionRow ? "Concentrado Regional (Todas las oficinas)" : "Todas las Oficinas");
    const rubroLabel = rubroRow ? rubroRow.nombre_rubro : (items[0]?.nombre_rubro || "Todos los Rubros");

    // Detección de casos institucionales específicos para asignación de firmas
    const isMobiliario = Number(dbRubroId) === 3 || String(rubroRow?.codigo || "").trim().toUpperCase() === "MOBILIARIO" || (items.length > 0 && items.every(it => Number(it.rubro_id) === 3 || String(it.rubro_codigo || "").toUpperCase() === "MOBILIARIO"));
    const isLaPazRegion = Number(dbRegionId) === 1 || Number(regionId) === 1 || String(regionRow?.clave || "").toUpperCase() === "LA_PAZ" || /la paz/i.test(String(regionLabel || ""));
    const isMobiliarioLaPaz = isMobiliario && isLaPazRegion;

    const isRMOffice = /rm\b|recursos materiales/i.test(String(oficinaLabel || oficinaRow?.nombre || "")) || (items.length > 0 && items.some(it => /rm\b|recursos materiales/i.test(String(it.oficina_nombre || ""))));
    const isParqueVehicularRM = (isParqueVehicular || Number(dbRubroId) === 2 || String(rubroRow?.codigo || "").trim().toUpperCase() === "PARQUE_VEHICULAR") && isRMOffice;

    // Validación específica Mulegé para firma 3 (RECIBE)
    const isMulegeRegion = Boolean(
      String(regionRow?.clave || "").toUpperCase() === "MULEGE" ||
      Number(dbRegionId) === 4 ||
      Number(regionId) === 4 ||
      /muleg[eé]/i.test(String(regionLabel || regionRow?.nombre || "")) ||
      /muleg[eé]|santa rosal[ií]a|guerrero negro|vizca[ií]no/i.test(String(oficinaLabel || oficinaRow?.nombre || "")) ||
      (Array.isArray(items) && items.some(it =>
        String(it?.region_clave || "").toUpperCase() === "MULEGE" ||
        Number(it?.region_id) === 4 ||
        /muleg[eé]/i.test(String(it?.region_nombre || "")) ||
        /muleg[eé]|santa rosal[ií]a|guerrero negro|vizca[ií]no/i.test(String(it?.oficina_nombre || ""))
      ))
    );

    // 5. Resolver los 4 bloques de firma dinámicos en orden:
    // 1.- Entrega | 2.- Valida | 3.- Recibe | 4.- Autoriza
    let firmaEncargadoNombre = rubroRow?.encargado_nombre || items[0]?.encargado_nombre || "TODOS LOS RUBROS / POR DEFINIR";
    let firmaEncargadoCargo = rubroRow?.encargado_cargo || items[0]?.encargado_cargo || "Encargado de Rubro de Inventario";

    let firmaApruebaNombre = "Jorge Luis Patrón Murillo";
    let firmaApruebaCargo = "Coordinador Operativo de Recursos Materiales";

    const defaultRecibeNombre = regionRow?.responsable_regional || items[0]?.responsable_regional || "POR CONFIRMAR";
    const defaultRecibeCargo = regionRow
      ? `Responsable Regional (${regionRow.nombre})`
      : "Responsable Regional / Resguardante";

    let firmaRecibeNombre = defaultRecibeNombre;
    let firmaRecibeCargo = defaultRecibeCargo;

    let firmaDelegadaNombre = "Diphna Yanssen Weichselbaum Calderón";
    let firmaDelegadaCargo = "Delegada de Programas para el Desarrollo en BCS";

    if (isParqueVehicularRM) {
      // 13 Vehículos RM de Evelia Contreras
      firmaEncargadoNombre = "Evelia Contreras Godínez";
      firmaEncargadoCargo = "Encargada de Parque Vehicular / Recursos Materiales";
      firmaApruebaNombre = "Diphna Yanssen Weichselbaum Calderón";
      firmaApruebaCargo = "Delegada de Programas para el Bienestar en BCS";
      firmaRecibeNombre = "Jorge Luis Patrón Murillo";
      firmaRecibeCargo = "Encargado de Recursos Materiales";
      firmaDelegadaNombre = "Diphna Yanssen Weichselbaum Calderón";
      firmaDelegadaCargo = "Delegada de Programas para el Bienestar en BCS";
    } else if (isMobiliarioLaPaz) {
      // Mobiliario La Paz de Jesús Salvador Palacios (Coordinación Regional La Paz)
      firmaEncargadoNombre = "JESÚS SALVADOR PALACIOS MARTÍNEZ";
      firmaEncargadoCargo = "ENCARGADO DE MOBILIARIO / RECURSOS MATERIALES";
      firmaApruebaNombre = "JORGE LUIS PATRÓN MURILLO";
      firmaApruebaCargo = "ENCARGADO DE RECURSOS MATERIALES";
      firmaRecibeNombre = "SANDRA GPE. SALVATIERRA AMADOR";
      firmaRecibeCargo = "DIRECTORA REGIONAL DE LA PAZ";
      firmaDelegadaNombre = "DIPHNA YANSSEN WEICHSELBAUM CALDERÓN";
      firmaDelegadaCargo = "DELEGADA DE PROGRAMAS PARA EL BIENESTAR EN BCS";
    } else if (isMulegeRegion) {
      firmaRecibeNombre = "Diana Ramirez Hernandez";
      firmaRecibeCargo = "Responsable Regional (Mulegé)";
    }

    // Generar o resolver marcas de tiempo y folio ANTES de usarlos en snapshot y encabezados
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, "0");
    const datePart = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
    const timePart = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
    const randPart = String(Math.floor(100 + Math.random() * 900));
    const defaultFolio = `REG-${datePart}-${timePart}-${randPart}`;
    const vehiculo = items[0] || {};
    const folio = String(body.folio || req.query?.folio || vehiculo.folio || defaultFolio).trim() || defaultFolio;

    const tituloFormato = (
      isParqueVehicular
        ? `RESGUARDO DE PARQUE VEHICULAR - ${regionLabel.toUpperCase()}`
        : `CONTROL DE INVENTARIO REGIONAL - ${regionLabel.toUpperCase()}`
    ).slice(0, 200);
    const creadoPor = String(req.user?.username || req.user?.nombre || req.user?.id || "sistema").slice(0, 100);

    const snapshotPayload = {
      folio,
      generated_at: now.toISOString(),
      filters: {
        region_id: regionId,
        oficina_id: oficinaId,
        rubro_id: rubroId,
        activo_id: activoId,
        grouped,
      },
      region: regionRow,
      oficina: oficinaRow,
      rubro: rubroRow,
      firmas: {
        entrega: { orden: 1, nombre: firmaEncargadoNombre, cargo: firmaEncargadoCargo },
        valida: { orden: 2, nombre: firmaApruebaNombre, cargo: firmaApruebaCargo },
        recibe: { orden: 3, nombre: firmaRecibeNombre, cargo: firmaRecibeCargo },
        autoriza: { orden: 4, nombre: firmaDelegadaNombre, cargo: firmaDelegadaCargo },
      },
      total_items: items.length,
      items,
    };

    // Guardar snapshot en formatos_inventario_regional
    await poolOps.query(
      `INSERT INTO formatos_inventario_regional
        (folio, region_id, oficina_id, rubro_id, titulo_formato,
         firma_encargado_nombre, firma_encargado_cargo,
         firma_delegada_nombre, firma_delegada_cargo,
         firma_aprueba_nombre, firma_aprueba_cargo,
         firma_recibe_nombre, firma_recibe_cargo,
         snapshot_json, observaciones, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        folio,
        dbRegionId,
        oficinaRow ? oficinaRow.id : null,
        dbRubroId,
        tituloFormato,
        firmaEncargadoNombre,
        firmaEncargadoCargo,
        firmaDelegadaNombre,
        firmaDelegadaCargo,
        firmaApruebaNombre,
        firmaApruebaCargo,
        firmaRecibeNombre,
        firmaRecibeCargo,
        JSON.stringify(snapshotPayload),
        observaciones,
        creadoPor,
      ]
    );

    // 7. Generar PDF con PDFKit
    res.setHeader("Content-Type", "application/pdf");
    const pdfFilename = isParqueVehicular
      ? `resguardo_parque_vehicular_${folio}.pdf`
      : `formato_inventario_regional_${folio}.pdf`;
    res.setHeader("Content-Disposition", `inline; filename="${pdfFilename}"`);

    const doc = new PDFDocument({ size: "LETTER", margin: 32 });
    doc.pipe(res);

    // DRP: Respaldo automático del resguardo vehicular o regional
    const subfolder = isParqueVehicular ? "resguardos_vehiculares" : "resguardos_regionales";
    const rubroName = rubroRow?.codigo || rubroRow?.nombre_rubro || "RUBRO";
    const oficinaName = oficinaRow?.nombre || regionRow?.nombre || "GENERAL";
    const fechaBackup = getBackupDateStr(now);
    savePdfBackup(doc, subfolder, `Resguardo_${rubroName}_${oficinaName}_${fechaBackup}.pdf`);

    const pageWidth = doc.page.width;   // 612 pt
    const pageHeight = doc.page.height; // 792 pt
    const leftX = 36;
    const rightLimit = pageWidth - 36;  // 576 pt
    const tableWidth = rightLimit - leftX; // 540 pt

    const COLOR_PRIMARY = "#621132";
    const COLOR_SECONDARY = "#4E0D28";
    const COLOR_ACCENT = "#B38E5D";
    const COLOR_SOFT_BG = "#F9F2F4";

    const logoGobPath = [
      path.join(__dirname, "public", "LogoGobiernoMX.png"),
      path.join(__dirname, "public", "logoGobiernoMx.png"),
      path.join(__dirname, "public", "logoGobiernoMX.png"),
      path.join(__dirname, "public", "logogobiernomx.png")
    ].find(p => fs.existsSync(p)) || null;

    const logoBienPath = [
      path.join(__dirname, "public", "logo.png"),
      path.join(__dirname, "public", "logo.original.png")
    ].find(p => fs.existsSync(p)) || null;

    const fechaTexto = `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()}`;

    // Función auxiliar para dibujar los 4 bloques de firma en el orden institucional:
    // 1.- ENTREGA | 2.- VALIDA | 3.- RECIBE | 4.- AUTORIZA
    function drawFourSignatures(signBoxY, signBoxH = 82, customRecibeNombre = null, customRecibeCargo = null, customFolio = null) {
      const gap = 8;
      const boxW = (tableWidth - gap * 3) / 4; // 129 pt cada caja
      const lineY = signBoxY + signBoxH - 30;
      const activeFolio = String(customFolio || folio || "S/N");

      const boxes = [
        {
          x: leftX,
          titulo: "ENTREGA:",
          cargo: firmaEncargadoCargo,
          nombre: firmaEncargadoNombre,
        },
        {
          x: leftX + (boxW + gap) * 1,
          titulo: "VALIDA:",
          cargo: firmaApruebaCargo,
          nombre: firmaApruebaNombre,
        },
        {
          x: leftX + (boxW + gap) * 2,
          titulo: "RECIBE:",
          cargo: customRecibeCargo || firmaRecibeCargo,
          nombre: customRecibeNombre || firmaRecibeNombre,
        },
        {
          x: leftX + (boxW + gap) * 3,
          titulo: "AUTORIZA:",
          cargo: firmaDelegadaCargo,
          nombre: firmaDelegadaNombre,
        },
      ];

      doc.save();
      doc.lineWidth(0.7).strokeColor(COLOR_PRIMARY);
      boxes.forEach((b) => {
        doc.rect(b.x, signBoxY, boxW, signBoxH).stroke();
        doc.rect(b.x, signBoxY, boxW, 13).fillAndStroke(COLOR_SOFT_BG, COLOR_PRIMARY);
        doc.strokeColor("#000000").moveTo(b.x + 8, lineY).lineTo(b.x + boxW - 8, lineY).stroke();
        doc.strokeColor(COLOR_PRIMARY);
      });
      doc.restore();

      boxes.forEach((b) => {
        doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(7.4)
          .text(b.titulo, b.x + 4, signBoxY + 3, { width: boxW - 8, align: "center" });
        doc.fillColor("#000000").font("Helvetica").fontSize(6.3)
          .text(b.cargo, b.x + 4, signBoxY + 15, { width: boxW - 8, align: "center" });
        doc.font("Helvetica-Bold").fontSize(6.6)
          .text(b.nombre, b.x + 4, lineY + 4, { width: boxW - 8, align: "center" });
      });

      const footerY = signBoxY + signBoxH + 6;
      doc.font("Helvetica").fontSize(7).fillColor("#333333");
      doc.text(`Folio Formato: ${activeFolio}`, leftX, footerY, { width: 210, align: "left", lineBreak: false });
      doc.text("Delegación Baja California Sur - Control de Inventario Regional", leftX, footerY, { width: tableWidth, align: "right", lineBreak: false });
    }

    // =========================================================================
    // MODO HÍBRIDO ESPECIAL: PARQUE VEHICULAR (Resguardo e Inventario de Unidad)
    // =========================================================================
    if (isParqueVehicular) {
      const vehiclesToRender = items.length > 0 ? items : [null];
      const logoPath = path.join(__dirname, "public", "logo.png");

      vehiclesToRender.forEach((veh, idx) => {
        if (idx > 0) doc.addPage();

        const det = (veh && veh.detalles_vehiculo && typeof veh.detalles_vehiculo === "object")
          ? veh.detalles_vehiculo
          : {};
        const unidad = det.unidad && typeof det.unidad === "object" ? det.unidad : {};
        const estGen = det.estado_general && typeof det.estado_general === "object" ? det.estado_general : {};
        const chk = det.checklist && typeof det.checklist === "object" ? det.checklist : {};

        const vRegion = veh?.region_nombre || regionLabel || "";
        const vOficina = veh?.oficina_nombre
          ? (veh.municipio ? `${veh.oficina_nombre} (${veh.municipio})` : veh.oficina_nombre)
          : oficinaLabel;
        const vClave = veh?.clave_bien || "";
        const vDesc = veh?.descripcion || "";

        // 1. Encabezado Institucional con logos oficiales discretos
        if (logoGobPath && fs.existsSync(logoGobPath)) {
          try {
            doc.image(logoGobPath, leftX, 16, { fit: [95, 30], align: "left", valign: "top" });
          } catch {}
        }
        if (logoBienPath && fs.existsSync(logoBienPath)) {
          try {
            doc.image(logoBienPath, rightLimit - 85, 16, { fit: [85, 30], align: "right", valign: "top" });
          } catch {}
        }

        doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(10.5)
          .text("SECRETARÍA DE BIENESTAR", leftX, 18, { width: tableWidth, align: "center" });
        doc.fillColor("#000000").font("Helvetica-Bold").fontSize(9.5)
          .text("DELEGACIÓN BAJA CALIFORNIA SUR", leftX, 31, { width: tableWidth, align: "center" });
        doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(9.5)
          .text("FORMATO DE RESGUARDO E INVENTARIO DE PARQUE VEHICULAR", leftX, 44, { width: tableWidth, align: "center" });

        doc.save();
        doc.moveTo(leftX + 110, 56).lineTo(rightLimit - 110, 56).lineWidth(1).strokeColor(COLOR_ACCENT).stroke();
        doc.restore();

        // Barra compacta de metadatos del resguardo
        let curY = 61;
        doc.fillColor("#000000").font("Helvetica-Bold").fontSize(7.5).text("REGIÓN:", leftX, curY);
        doc.font("Helvetica").fontSize(7.5).text(vRegion, leftX + 38, curY, { width: 115, lineBreak: false });
        doc.moveTo(leftX + 36, curY + 9).lineTo(leftX + 152, curY + 9).lineWidth(0.5).strokeColor("#000000").stroke();

        doc.font("Helvetica-Bold").fontSize(7.5).text("OFICINA:", leftX + 158, curY);
        doc.font("Helvetica").fontSize(7.5).text(vOficina, leftX + 196, curY, { width: 145, lineBreak: false });
        doc.moveTo(leftX + 194, curY + 9).lineTo(leftX + 340, curY + 9).lineWidth(0.5).strokeColor("#000000").stroke();

        doc.font("Helvetica-Bold").fontSize(7.5).text("CLAVE:", leftX + 346, curY);
        doc.font("Helvetica-Bold").fontSize(7.5).text(vClave || "____________", leftX + 378, curY, { width: 72, lineBreak: false });

        doc.font("Helvetica-Bold").fontSize(7.5).text("FECHA:", leftX + 452, curY);
        doc.font("Helvetica").fontSize(7.5).text(fechaTexto, leftX + 485, curY, { width: 55, align: "right", lineBreak: false });

        curY = 77;

        // Helper para barra de sección guinda
        const drawSectionBar = (y, title) => {
          const barH = 13;
          doc.save();
          doc.rect(leftX, y, tableWidth, barH).fillAndStroke(COLOR_PRIMARY, COLOR_SECONDARY);
          doc.moveTo(leftX, y + barH).lineTo(rightLimit, y + barH).lineWidth(0.8).strokeColor(COLOR_ACCENT).stroke();
          doc.restore();
          doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(7.5)
            .text(title, leftX + 6, y + 3, { width: tableWidth - 12, align: "left", lineBreak: false });
          return y + barH;
        };

        // =====================================================================
        // SECCIÓN A: DATOS DEL RESGUARDANTE (En blanco para llenado manual)
        // =====================================================================
        curY = drawSectionBar(curY, "1. DATOS DEL RESGUARDANTE (PARA LLENADO MANUAL EN PAPEL)");
        const resgH = 54;
        doc.save();
        doc.lineWidth(0.6).strokeColor("#000000");
        doc.rect(leftX, curY, tableWidth, resgH).stroke();
        doc.restore();

        const rRow1 = curY + 6;
        const rRow2 = curY + 18;
        const rRow3 = curY + 30;
        const rRow4 = curY + 42;

        doc.fillColor("#000000").font("Helvetica-Bold").fontSize(7.5);
        // Fila 1: Nombre Completo
        doc.text("Nombre Completo:", leftX + 6, rRow1);
        doc.moveTo(leftX + 80, rRow1 + 8).lineTo(rightLimit - 8, rRow1 + 8).lineWidth(0.5).strokeColor("#333333").stroke();

        // Fila 2: RFC y Puesto
        doc.text("RFC:", leftX + 6, rRow2);
        doc.moveTo(leftX + 28, rRow2 + 8).lineTo(leftX + 255, rRow2 + 8).lineWidth(0.5).strokeColor("#333333").stroke();
        doc.text("Puesto:", leftX + 268, rRow2);
        doc.moveTo(leftX + 300, rRow2 + 8).lineTo(rightLimit - 8, rRow2 + 8).lineWidth(0.5).strokeColor("#333333").stroke();

        // Fila 3: Adscripción / Región y Programa / Operativo
        doc.text("Adscripción / Región:", leftX + 6, rRow3);
        doc.moveTo(leftX + 90, rRow3 + 8).lineTo(leftX + 255, rRow3 + 8).lineWidth(0.5).strokeColor("#333333").stroke();
        doc.text("Programa / Operativo:", leftX + 268, rRow3);
        doc.moveTo(leftX + 354, rRow3 + 8).lineTo(rightLimit - 8, rRow3 + 8).lineWidth(0.5).strokeColor("#333333").stroke();

        // Fila 4: Licencia No. y Vigencia de Licencia
        doc.text("Licencia No.:", leftX + 6, rRow4);
        doc.moveTo(leftX + 58, rRow4 + 8).lineTo(leftX + 255, rRow4 + 8).lineWidth(0.5).strokeColor("#333333").stroke();
        doc.text("Vigencia de Licencia:", leftX + 268, rRow4);
        doc.moveTo(leftX + 352, rRow4 + 8).lineTo(rightLimit - 8, rRow4 + 8).lineWidth(0.5).strokeColor("#333333").stroke();

        curY += resgH + 4;

        // =====================================================================
        // SECCIÓN B1: DATOS DE LA UNIDAD (Capturados en el sistema)
        // =====================================================================
        curY = drawSectionBar(curY, `2. DATOS DE LA UNIDAD VEHICULAR${vDesc ? ` — ${vDesc.toUpperCase()}` : ""}`);

        const uMarca = String(unidad.marca || veh?.marca_modelo || "").trim();
        const uTipo = String(unidad.tipo || "").trim();
        const uModelo = String(unidad.modelo || "").trim();
        const uColor = String(unidad.color || "").trim();
        const uPlacas = String(unidad.placas || veh?.numero_serie_placas || "").trim();
        const uSerie = String(unidad.serie_vin || "").trim();
        const uCilindros = String(unidad.cilindros || "").trim();
        const uPoliza = String(unidad.poliza_seguro || "").trim();
        const uOdometro = String(unidad.odometro_km || "").trim();
        const uGasolina = String(unidad.nivel_gasolina || "").trim();

        const drawDataRow = (y, cells, rowH = 18) => {
          let x = leftX;
          cells.forEach((cell) => {
            doc.save();
            doc.lineWidth(0.5).strokeColor("#000000");
            doc.rect(x, y, cell.w, rowH).stroke();
            doc.rect(x, y, cell.labelW, rowH).fillAndStroke(COLOR_SOFT_BG, "#000000");
            doc.restore();

            doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(6.8)
              .text(cell.label, x + 3, y + 5, { width: cell.labelW - 6, lineBreak: false });
            doc.fillColor("#000000").font("Helvetica").fontSize(7.4)
              .text(cell.val || "-", x + cell.labelW + 4, y + 5, { width: cell.w - cell.labelW - 8, lineBreak: false });
            x += cell.w;
          });
          return y + rowH;
        };

        curY = drawDataRow(curY, [
          { label: "MARCA:", labelW: 38, w: 135, val: uMarca },
          { label: "TIPO:", labelW: 32, w: 135, val: uTipo },
          { label: "MODELO:", labelW: 42, w: 135, val: uModelo },
          { label: "COLOR:", labelW: 38, w: 135, val: uColor },
        ]);

        curY = drawDataRow(curY, [
          { label: "PLACAS:", labelW: 40, w: 150, val: uPlacas },
          { label: "NÚM. SERIE (VIN):", labelW: 72, w: 255, val: uSerie },
          { label: "CILINDROS:", labelW: 50, w: 135, val: uCilindros },
        ]);

        const gasLevels = ["Vacío", "1/4", "1/2", "3/4", "Lleno"];
        const gasDisplay = gasLevels.map((lvl) => {
          const active = uGasolina.toLowerCase() === lvl.toLowerCase();
          return active ? `[X] ${lvl}` : `[ ] ${lvl}`;
        }).join("  ");

        curY = drawDataRow(curY, [
          { label: "PÓLIZA SEGURO:", labelW: 66, w: 165, val: uPoliza },
          { label: "ODÓMETRO (KM):", labelW: 68, w: 135, val: uOdometro ? `${uOdometro} km` : "-" },
          { label: "GASOLINA:", labelW: 48, w: 240, val: uGasolina ? gasDisplay : "Vacío [ ] 1/4 [ ] 1/2 [ ] 3/4 [ ] Lleno [ ]" },
        ]);

        curY += 4;

        // =====================================================================
        // SECCIÓN B2: ESTADO GENERAL (B / R / M)
        // =====================================================================
        curY = drawSectionBar(curY, "3. ESTADO GENERAL DEL VEHÍCULO (B = Bueno | R = Regular | M = Malo)");
        const estColW = tableWidth / VEHICULO_ESTADO_ITEMS.length; // 67.5 pt cada una
        const estHeaderH = 12;
        const estValH = 13;

        VEHICULO_ESTADO_ITEMS.forEach((item, i) => {
          const cx = leftX + i * estColW;
          const val = String(estGen[item.key] || "B").trim().toUpperCase();
          doc.save();
          doc.lineWidth(0.5).strokeColor("#000000");
          doc.rect(cx, curY, estColW, estHeaderH).fillAndStroke(COLOR_SOFT_BG, "#000000");
          doc.rect(cx, curY + estHeaderH, estColW, estValH).stroke();
          doc.restore();

          doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(6.2)
            .text(item.label, cx + 2, curY + 3, { width: estColW - 4, align: "center", lineBreak: false });

          const bMark = val === "B" || val === "BUENO" ? "[X]B" : "[ ]B";
          const rMark = val === "R" || val === "REGULAR" ? "[X]R" : "[ ]R";
          const mMark = val === "M" || val === "MALO" ? "[X]M" : "[ ]M";
          doc.fillColor("#000000").font("Helvetica-Bold").fontSize(6.3)
            .text(`${bMark}  ${rMark}  ${mMark}`, cx + 1, curY + estHeaderH + 3.5, { width: estColW - 2, align: "center", lineBreak: false });
        });

        curY += estHeaderH + estValH + 4;

        // =====================================================================
        // SECCIÓN B3: TABLA CHECKLIST DE ACCESORIOS, HERRAMIENTA Y DOCUMENTACIÓN
        // =====================================================================
        curY = drawSectionBar(curY, "4. CHECKLIST DE ACCESORIOS, HERRAMIENTA Y DOCUMENTACIÓN (SÍ / NO)");

        const numCols = 3;
        const colGroupW = tableWidth / numCols; // 180 pt por bloque
        const optW = 24; // 2 opciones (SÍ, NO) * 24 = 48 pt
        const itemLabelW = colGroupW - optW * 2; // 180 - 48 = 132 pt
        const chkHeaderH = 11;
        const numRows = Math.ceil(VEHICULO_CHECKLIST_ITEMS.length / numCols); // 14 filas
        const chkRowH = 13.5;

        // Dibujar encabezados de las 3 columnas: únicamente CONCEPTO, SÍ, NO (sin N/A)
        for (let c = 0; c < numCols; c++) {
          const gx = leftX + c * colGroupW;
          doc.save();
          doc.lineWidth(0.5).strokeColor("#000000");
          doc.rect(gx, curY, itemLabelW, chkHeaderH).fillAndStroke(COLOR_SOFT_BG, "#000000");
          doc.rect(gx + itemLabelW, curY, optW, chkHeaderH).fillAndStroke(COLOR_SOFT_BG, "#000000");
          doc.rect(gx + itemLabelW + optW, curY, optW, chkHeaderH).fillAndStroke(COLOR_SOFT_BG, "#000000");
          doc.restore();

          doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(6.2);
          doc.text("CONCEPTO", gx + 3, curY + 2.5, { width: itemLabelW - 6, align: "left", lineBreak: false });
          doc.text("SÍ", gx + itemLabelW, curY + 2.5, { width: optW, align: "center", lineBreak: false });
          doc.text("NO", gx + itemLabelW + optW, curY + 2.5, { width: optW, align: "center", lineBreak: false });
        }
        curY += chkHeaderH;

        for (let r = 0; r < numRows; r++) {
          const ry = curY + r * chkRowH;
          for (let c = 0; c < numCols; c++) {
            const idxItem = c * numRows + r;
            const gx = leftX + c * colGroupW;
            const chkItem = VEHICULO_CHECKLIST_ITEMS[idxItem] || null;

            doc.save();
            doc.lineWidth(0.4).strokeColor("#000000");
            if (r % 2 === 1) {
              doc.rect(gx, ry, colGroupW, chkRowH).fillAndStroke("#FCF9FA", "#000000");
            } else {
              doc.rect(gx, ry, colGroupW, chkRowH).stroke();
            }
            doc.moveTo(gx + itemLabelW, ry).lineTo(gx + itemLabelW, ry + chkRowH).stroke();
            doc.moveTo(gx + itemLabelW + optW, ry).lineTo(gx + itemLabelW + optW, ry + chkRowH).stroke();
            doc.restore();

            if (chkItem) {
              const rawVal = String(chk[chkItem.key] || "").trim().toUpperCase();
              const isSi = rawVal === "SI" || rawVal === "SÍ" || rawVal === "YES" || rawVal === "1";
              const isNo = rawVal === "NO" || rawVal === "0";

              // Si es SÍ -> [X] SÍ y [ ] NO
              // Si es NO -> [ ] SÍ y [X] NO
              // Si es N/A o vacío -> [ ] SÍ y [ ] NO (para llenado manual)
              const siBox = isSi ? "[X]" : "[ ]";
              const noBox = isNo ? "[X]" : "[ ]";

              doc.fillColor("#000000").font("Helvetica").fontSize(6.5)
                .text(chkItem.label, gx + 3, ry + 3.2, { width: itemLabelW - 5, lineBreak: false });

              doc.font("Helvetica-Bold").fontSize(6.6).fillColor(isSi ? COLOR_PRIMARY : "#333333");
              doc.text(siBox, gx + itemLabelW, ry + 3, { width: optW, align: "center", lineBreak: false });

              doc.font("Helvetica-Bold").fontSize(6.6).fillColor(isNo ? COLOR_PRIMARY : "#333333");
              doc.text(noBox, gx + itemLabelW + optW, ry + 3, { width: optW, align: "center", lineBreak: false });
            }
          }
        }
        curY += numRows * chkRowH + 4;

        // =====================================================================
        // SECCIÓN B4: OBSERVACIONES GENERALES DE LA UNIDAD (Llenado a mano)
        // =====================================================================
        curY = drawSectionBar(curY, "5. OBSERVACIONES GENERALES DE LA UNIDAD (NOTAS MANUALES)");
        const obsH = 34;
        doc.save();
        doc.lineWidth(0.5).strokeColor("#000000");
        doc.rect(leftX, curY, tableWidth, obsH).stroke();

        // 3 líneas guía en blanco para que el encargado escriba apuntes específicos a mano
        doc.lineWidth(0.4).strokeColor("#AAAAAA");
        const lineSpacing = obsH / 4;
        for (let l = 1; l <= 3; l++) {
          const ly = curY + l * lineSpacing;
          doc.moveTo(leftX + 8, ly).lineTo(rightLimit - 8, ly).stroke();
        }
        doc.restore();
        curY += obsH + 4;

        // =====================================================================
        // SECCIÓN C: CLÁUSULA LEGAL AL PIE DEL PDF (Antes de las 4 firmas)
        // =====================================================================
        const legalH = 54;
        doc.save();
        doc.lineWidth(0.6).strokeColor(COLOR_PRIMARY);
        doc.rect(leftX, curY, tableWidth, legalH).fillAndStroke(COLOR_SOFT_BG, COLOR_PRIMARY);
        doc.rect(leftX, curY, 4, legalH).fill(COLOR_ACCENT);
        doc.restore();

        const clausulaTexto =
          "CLÁUSULA DE RESPONSABILIDAD LEGAL: Con fundamento en los Artículos 78, 80 y 87 del Acuerdo por el que se Establecen las Disposiciones en Materia de Recursos Materiales y Servicios Generales, el servidor público resguardante recibe el vehículo descrito para uso exclusivamente oficial y se compromete a: (1) portar licencia de conducir vigente durante la operación de la unidad; (2) cubrir el pago del deducible de la póliza de seguro o la reparación total de los daños y perjuicios que resulten imputables por negligencia, uso indebido o siniestro bajo su custodia; (3) cubrir por su cuenta las multas e infracciones de tránsito que se generen durante el periodo de asignación; y (4) resguardar y concentrar el vehículo al término de la jornada laboral o comisión oficial en las instalaciones de la Secretaría de Bienestar en Baja California Sur.";

        doc.fillColor("#111111").font("Helvetica").fontSize(6.5)
          .text(clausulaTexto, leftX + 9, curY + 4.5, {
            width: tableWidth - 15,
            align: "justify",
            lineGap: 1.1,
          });

        curY += legalH + 6;

        // =====================================================================
        // SECCIÓN D: 4 FIRMAS (1. ENTREGA, 2. VALIDA, 3. RECIBE, 4. AUTORIZA)
        // =====================================================================
        const isVehMulege = Boolean(
          isMulegeRegion ||
          Number(veh?.region_id) === 4 ||
          /muleg[eé]/i.test(String(veh?.region_nombre || "")) ||
          /muleg[eé]|santa rosal[ií]a|guerrero negro|vizca[ií]no/i.test(String(veh?.oficina_nombre || "")) ||
          /muleg[eé]|santa rosal[ií]a|guerrero negro|vizca[ií]no/i.test(String(veh?.municipio || ""))
        );
        const vehFolio = String(veh?.folio || (veh?.clave_bien ? `RES-${veh.clave_bien}` : folio));
        drawFourSignatures(
          curY,
          78,
          isVehMulege ? "Diana Ramirez Hernandez" : (isParqueVehicularRM ? "Jorge Luis Patrón Murillo" : null),
          isVehMulege ? "Responsable Regional (Mulegé)" : (isParqueVehicularRM ? "Encargado de Recursos Materiales" : null),
          vehFolio
        );
      });

      doc.end();
      return;
    }

    // =========================================================================
    // FORMATO TABULAR ESTÁNDAR DE INVENTARIO REGIONAL (Otros Rubros)
    // =========================================================================
    function drawRegionalHeader() {
      if (logoGobPath && fs.existsSync(logoGobPath)) {
        try {
          doc.image(logoGobPath, leftX, 16, { fit: [95, 30], align: "left", valign: "top" });
        } catch {}
      }
      if (logoBienPath && fs.existsSync(logoBienPath)) {
        try {
          doc.image(logoBienPath, rightLimit - 85, 16, { fit: [85, 30], align: "right", valign: "top" });
        } catch {}
      }

      doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(10.5)
        .text("SECRETARÍA DE BIENESTAR", leftX, 18, { width: tableWidth, align: "center" });
      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(9.5)
        .text("DELEGACIÓN BAJA CALIFORNIA SUR", leftX, 31, { width: tableWidth, align: "center" });
      doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(10)
        .text("FORMATO DE CONTROL Y RESGUARDO DE INVENTARIO REGIONAL", leftX, 44, { width: tableWidth, align: "center" });

      doc.save();
      doc.moveTo(leftX + 100, 56).lineTo(rightLimit - 100, 56).lineWidth(1.2).strokeColor(COLOR_ACCENT).stroke();
      doc.restore();

      // Bloque de datos de filtro / encabezado
      const metaY1 = 66;
      const metaY2 = 80;

      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8).text("REGIÓN:", leftX, metaY1);
      doc.font("Helvetica").fontSize(8).text(regionLabel, leftX + 42, metaY1, { width: 160, lineBreak: false });
      doc.moveTo(leftX + 40, metaY1 + 9).lineTo(leftX + 200, metaY1 + 9).lineWidth(0.5).strokeColor("#000000").stroke();

      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8).text("OFICINA:", leftX + 210, metaY1);
      doc.font("Helvetica").fontSize(8).text(oficinaLabel, leftX + 254, metaY1, { width: 170, lineBreak: false });
      doc.moveTo(leftX + 252, metaY1 + 9).lineTo(leftX + 425, metaY1 + 9).lineWidth(0.5).strokeColor("#000000").stroke();

      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8).text("FECHA:", leftX + 435, metaY1);
      doc.font("Helvetica").fontSize(8).text(fechaTexto, leftX + 472, metaY1, { width: 68, align: "center" });
      doc.moveTo(leftX + 470, metaY1 + 9).lineTo(rightLimit, metaY1 + 9).lineWidth(0.5).strokeColor("#000000").stroke();

      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8).text("RUBRO:", leftX, metaY2);
      doc.font("Helvetica").fontSize(8).text(rubroLabel, leftX + 42, metaY2, { width: 280, lineBreak: false });
      doc.moveTo(leftX + 40, metaY2 + 9).lineTo(leftX + 325, metaY2 + 9).lineWidth(0.5).strokeColor("#000000").stroke();

      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8).text("FOLIO:", leftX + 335, metaY2);
      doc.font("Helvetica").fontSize(7.5).text(folio, leftX + 370, metaY2, { width: 168, align: "center", lineBreak: false });
      doc.moveTo(leftX + 368, metaY2 + 9).lineTo(rightLimit, metaY2 + 9).lineWidth(0.5).strokeColor("#000000").stroke();
    }

    const showSerie = String(rubroRow?.codigo || "").trim().toUpperCase() === "PARQUE_VEHICULAR";
    const colSerieW = 70;
    const regionalCols = [
      { key: "no",    label: "No.",            w: 24,                               align: "center", wrap: false },
      { key: "clave", label: "CLAVE BIEN",     w: 64,                               align: "left",   wrap: true  },
      { key: "desc",  label: "DESCRIPCIÓN",    w: showSerie ? 148 : 148 + colSerieW, align: "left",   wrap: true  },
      { key: "marca", label: "MARCA / MODELO", w: 74,                               align: "left",   wrap: true  },
      ...(showSerie
        ? [{ key: "serie", label: "SERIE / PLACAS", w: colSerieW, align: "left", wrap: true }]
        : []),
      { key: "cant",  label: "CANT.",          w: 36,                               align: "center", wrap: false },
      { key: "est",   label: "ESTATUS",        w: 50,                               align: "center", wrap: false },
      { key: "obs",   label: "OBSERVACIONES",  w: 74,                               align: "left",   wrap: true  },
    ];
    {
      let cx = leftX;
      regionalCols.forEach((c) => { c.x = cx; cx += c.w; });
    }
    const colDividersX = regionalCols.slice(1).map((c) => c.x);

    function drawRegionalTableHeader(topY) {
      const h = 22;
      doc.save();
      doc.lineWidth(0.8).strokeColor(COLOR_SECONDARY).fillColor(COLOR_PRIMARY);
      doc.rect(leftX, topY, tableWidth, h).fillAndStroke(COLOR_PRIMARY, COLOR_SECONDARY);
      doc.strokeColor(COLOR_ACCENT).lineWidth(0.6);
      colDividersX.forEach((cx) => {
        doc.moveTo(cx, topY).lineTo(cx, topY + h).stroke();
      });
      doc.restore();

      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(7.2);
      regionalCols.forEach((c) => {
        doc.text(c.label, c.x + 2, topY + 7, { width: c.w - 4, align: "center" });
      });

      return topY + h;
    }

    drawRegionalHeader();
    let currentY = drawRegionalTableHeader(98);

    const minRows = 15;
    const totalRows = Math.max(items.length, minRows);
    const defaultRowH = 18;

    for (let i = 0; i < totalRows; i++) {
      const item = items[i] || null;
      const cellText = {
        no: item ? String(i + 1) : "",
        clave: item ? String(item.clave_bien || "").trim() : "",
        desc: item ? String(item.descripcion || "").trim() : "",
        marca: item ? String(item.marca_modelo || "").trim() : "",
        serie: item ? String(item.numero_serie_placas || "").trim() : "",
        cant: item && item.cantidad_propia != null ? String(item.cantidad_propia) : "",
        est: item ? String(item.estatus_uso || "").trim() : "",
        obs: item ? String(item.observaciones || "").trim() : "",
      };

      doc.font("Helvetica").fontSize(7.5);
      let maxTextH = 10;
      regionalCols.forEach((c) => {
        const t = cellText[c.key];
        if (c.wrap && t) maxTextH = Math.max(maxTextH, doc.heightOfString(t, { width: c.w - 6 }));
      });
      const rowH = Math.max(defaultRowH, maxTextH + 6);

      if (currentY + rowH > pageHeight - 120) {
        doc.addPage();
        drawRegionalHeader();
        currentY = drawRegionalTableHeader(98);
      }

      doc.save();
      doc.lineWidth(0.5).strokeColor("#000000");
      if (i % 2 === 1) {
        doc.rect(leftX, currentY, tableWidth, rowH).fillAndStroke(COLOR_SOFT_BG, "#000000");
      } else {
        doc.rect(leftX, currentY, tableWidth, rowH).stroke();
      }
      colDividersX.forEach((cx) => {
        doc.moveTo(cx, currentY).lineTo(cx, currentY + rowH).stroke();
      });
      doc.restore();

      if (item) {
        const textY = currentY + 4;
        doc.fillColor("#000000").font("Helvetica").fontSize(7.5);
        regionalCols.forEach((c) => {
          doc.text(cellText[c.key], c.x + 3, textY, { width: c.w - 6, align: c.align });
        });
      }

      currentY += rowH;
    }

    // 8. Dibujar los 4 bloques de firma fijos al pie en orden: 1. ENTREGA, 2. VALIDA, 3. RECIBE, 4. AUTORIZA
    const signBoxY = Math.max(currentY + 16, pageHeight - 145);
    drawFourSignatures(
      signBoxY,
      86,
      isMulegeRegion ? "Diana Ramirez Hernandez" : null,
      isMulegeRegion ? "Responsable Regional (Mulegé)" : null,
      folio
    );

    doc.end();
  } catch (e) {
    return httpError(res, 500, e.message);
  }
}

app.post("/api/inventario-regional/formatos", authRequired, handleInventarioRegionalFormatos);
app.get("/api/inventario-regional/formatos", authRequired, handleInventarioRegionalFormatos);
app.get("/api/inventario-regional/:id/pdf", authRequired, handleInventarioRegionalFormatos);

// Endpoint para ejecutar la semilla de datos de prueba (seed_pruebas.sql) sin borrar usuarios ni catálogos
app.post("/api/admin/seed-pruebas", authRequired, async (req, res) => {
  try {
    if (!isAdmin(req) && !canManageAlmacen(req)) {
      return httpError(res, 403, "Solo el Administrador o Encargado puede ejecutar la carga de datos de prueba.");
    }
    await ensureSchemaAndUsers();
    const { runSeedPruebas } = require("./seed-pruebas");
    await runSeedPruebas();
    return res.json({ ok: true, message: "Datos de prueba cargados correctamente desde seed_pruebas.sql" });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al ejecutar seed_pruebas.sql");
  }
});

// ============================================================================
// MÓDULO: VALES PROVISIONALES (Préstamo de Material/Equipo para Operativos)
// ============================================================================

// 1. Catálogo disponible para préstamo según el rubro
app.get("/api/vales-prestamo/catalogo", authRequired, async (req, res) => {
  try {
    const rubroId = Number(req.query?.rubro_id || 1);
    if (![1, 2, 3, 4].includes(rubroId)) {
      return httpError(res, 400, "Rubro inválido (debe ser del 1 al 4)");
    }

    if (rubroId === 1) {
      // Gabriel Fiol: Almacén Central (almacen_dregcivil)
      const [rows] = await poolRead.query(
        `SELECT 
           ID AS id,
           CLAVE AS clave,
           DESCRIPCION AS descripcion,
           UNIDAD AS unidad,
           STOCK AS stock,
           STOCK AS cantidad_disponible,
           (STOCK > 0) AS disponible,
           STOCK AS existencia,
           '' AS marca,
           '' AS modelo,
           '' AS serie,
           '' AS color,
           'BUEN ESTADO' AS estado_salida
         FROM almacen_dregcivil
         WHERE (ESTADO IS NULL OR ESTADO = 'ACTIVO') AND STOCK > 0
         ORDER BY DESCRIPCION ASC`
      );
      return res.json({ ok: true, rubro_id: 1, rubro_nombre: "Archivo y Materiales", data: rows });
    }

    // Rubros 2, 3, 4: Inventario Delegación La Paz (oficina_id = 1)
    const hasDetCol = await ensureDetallesVehiculoCol();
    const [rows] = await poolRead.query(
      `SELECT 
         io.id,
         io.clave_bien AS clave,
         io.descripcion,
         io.unidad,
         io.cantidad_propia AS stock,
         io.cantidad_disponible,
         (io.cantidad_propia > 0) AS disponible,
         io.cantidad_propia AS existencia,
         io.marca_modelo,
         io.numero_serie_placas AS serie,
         io.estado_fisico AS estado_salida,
         ${hasDetCol ? "io.detalles_vehiculo" : "NULL AS detalles_vehiculo"},
         r.nombre_rubro,
         r.encargado_nombre,
         r.encargado_cargo
       FROM inventario_oficina io
       LEFT JOIN rubros_inventario r ON r.id = io.rubro_id
       WHERE (io.oficina_id = 1 OR io.es_bodega_delegacion = 1) 
         AND io.rubro_id = ?
         AND io.cantidad_propia > 0
         AND io.estatus_uso <> 'BAJA'
       ORDER BY io.descripcion ASC`,
      [rubroId]
    );

    const data = rows.map((r) => {
      let marca = "";
      let modelo = "";
      let color = "";
      let serie = r.serie || "";
      if (r.marca_modelo) {
        const parts = String(r.marca_modelo).split(" ");
        marca = parts[0] || "";
        modelo = parts.slice(1).join(" ") || "";
      }
      if (r.detalles_vehiculo) {
        const v = parseDetallesVehiculo(r.detalles_vehiculo);
        if (v && v.unidad) {
          marca = v.unidad.marca || marca;
          modelo = [v.unidad.tipo, v.unidad.modelo].filter(Boolean).join(" ") || modelo;
          color = v.unidad.color || color;
          serie = [v.unidad.placas, v.unidad.serie_vin].filter(Boolean).join(" / ") || serie;
        }
      }
      return {
        id: r.id,
        clave: r.clave,
        descripcion: r.descripcion,
        unidad: r.unidad || "PIEZA",
        stock: r.stock,
        marca,
        modelo,
        serie,
        color,
        estado_salida: r.estado_salida || "BUENO",
      };
    });

    return res.json({ ok: true, rubro_id: rubroId, data });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// 2. Listado de Vales Provisionales con filtros y orden de fechas
app.get("/api/vales-prestamo", authRequired, async (req, res) => {
  try {
    const { estado, rubro_id, departamento_id, tipo_firmas } = req.query || {};
    const admin = isAdmin(req);
    const userRubro = getUserRubroId(req);
    const isFiol = canManageAlmacen(req);

    let filterClause = "WHERE 1=1";
    const params = [];

    // Si es encargado de rubro (y no admin), restringir a su rubro por defecto si no especifica otro
    if (!admin && userRubro) {
      filterClause += " AND vp.rubro_id = ?";
      params.push(userRubro);
    } else if (rubro_id && Number(rubro_id) > 0) {
      filterClause += " AND vp.rubro_id = ?";
      params.push(Number(rubro_id));
    }

    // Si es usuario regular (no admin y no encargado), solo ve sus propios vales o los de su departamento
    if (!admin && !userRubro && !isFiol) {
      const uId = Number(req.user?.id || 0);
      const ofiId = Number(req.user?.id_oficialia || req.user?.oficialia_id || 0);
      filterClause += " AND (vp.usuario_id = ? OR vp.departamento_id = ?)";
      params.push(uId, ofiId);
    }

    if (estado && estado !== "TODOS") {
      filterClause += " AND vp.estado = ?";
      params.push(estado.trim().toUpperCase());
    }

    if (tipo_firmas && (tipo_firmas === "2" || tipo_firmas === "4" || Number(tipo_firmas) === 2 || Number(tipo_firmas) === 4)) {
      filterClause += " AND vp.tipo_firmas = ?";
      params.push(Number(tipo_firmas));
    }

    if (departamento_id && Number(departamento_id) > 0) {
      filterClause += " AND vp.departamento_id = ?";
      params.push(Number(departamento_id));
    }

    const [rows] = await poolRead.query(
      `SELECT 
         vp.*,
         r.nombre_rubro,
         r.encargado_nombre AS encargado_rubro_nombre,
         r.encargado_cargo AS encargado_rubro_cargo,
         COALESCE(o.nombre, vp.departamento_nombre, 'General') AS oficialia_nombre,
         (SELECT COUNT(*) FROM vales_prestamo_detalle vpd WHERE vpd.vale_id = vp.id) AS total_articulos,
         (SELECT SUM(vpd.cantidad) FROM vales_prestamo_detalle vpd WHERE vpd.vale_id = vp.id) AS total_piezas
       FROM vales_prestamo vp
       LEFT JOIN rubros_inventario r ON r.id = vp.rubro_id
       LEFT JOIN oficialias o ON o.id = vp.departamento_id
       ${filterClause}
       ORDER BY 
         CASE 
           WHEN vp.estado = 'SOLICITADO' THEN 1 
           WHEN vp.estado = 'AUTORIZADO_EN_PRESTAMO' THEN 2 
           ELSE 3 
         END,
         vp.fecha_devolucion_estimada ASC,
         vp.id DESC`,
      params
    );

    return res.json({ ok: true, data: rows });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// 3. Detalle de un Vale Provisional por ID
app.get("/api/vales-prestamo/:id", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return httpError(res, 400, "ID inválido");

    const [valeRows] = await poolRead.query(
      `SELECT 
         vp.*,
         r.nombre_rubro,
         r.encargado_nombre AS encargado_rubro_nombre,
         r.encargado_cargo AS encargado_rubro_cargo,
         COALESCE(o.nombre, vp.departamento_nombre, 'General') AS oficialia_nombre
       FROM vales_prestamo vp
       LEFT JOIN rubros_inventario r ON r.id = vp.rubro_id
       LEFT JOIN oficialias o ON o.id = vp.departamento_id
       WHERE vp.id = ? LIMIT 1`,
      [id]
    );
    if (!valeRows.length) return httpError(res, 404, "Vale no encontrado");
    const vale = valeRows[0];

    const [detalles] = await poolRead.query(
      `SELECT * FROM vales_prestamo_detalle WHERE vale_id = ? ORDER BY id ASC`,
      [id]
    );

    return res.json({ ok: true, data: { ...vale, detalles } });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// 4. Crear nuevo Vale Provisional (Control de Stock Inmediato)
app.post("/api/vales-prestamo", authRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const rubroId = Number(b.rubro_id || 0);
    if (![1, 2, 3, 4].includes(rubroId)) return httpError(res, 400, "Rubro inválido (1 a 4)");

    let deptoId = Number(b.departamento_id || 0);
    let deptoNombre = String(b.departamento_nombre || "").trim();

    // Regla de Negocio: no admin ni gabrielfiol no pueden seleccionar otros departamentos
    const admin = isAdmin(req);
    const isFiol = canManageAlmacen(req);
    const userDeptoId = Number(req.user?.id_oficialia || req.user?.oficialia_id || 0);
    const userDeptoNombre = String(req.user?.departamento || req.user?.oficialia_nombre || "").trim();

    if (!admin && !isFiol) {
      deptoId = userDeptoId || deptoId;
      deptoNombre = userDeptoNombre || deptoNombre;
    }

    if (!deptoId) {
      deptoId = userDeptoId || 30030001;
    }

    const solicitanteNombre = String(b.solicitante_nombre || "").trim();
    if (!solicitanteNombre) return httpError(res, 400, "Nombre del solicitante requerido");

    const solicitanteCargo = String(b.solicitante_cargo || "").trim() || "Responsable de Operativo";
    const solicitanteTelefono = String(b.solicitante_telefono || "").trim() || null;
    const operativoNombre = String(b.operativo_nombre || "").trim();
    if (!operativoNombre) return httpError(res, 400, "Nombre del operativo o evento requerido");

    const lugarComision = String(b.lugar_comision || "").trim();
    if (!lugarComision) return httpError(res, 400, "Lugar de comisión requerido");

    const fechaSalida = b.fecha_salida ? String(b.fecha_salida).slice(0, 10) : null;
    if (!fechaSalida) return httpError(res, 400, "Fecha de salida requerida");

    let tipoFirmas = Number(b.tipo_firmas) === 4 ? 4 : 2;
    if (tipoFirmas === 4 && !canUseCuatroFirmas(req)) {
      tipoFirmas = 2;
    }
    const rawFechaDev = b.fecha_devolucion_estimada ? String(b.fecha_devolucion_estimada).slice(0, 10) : null;
    let esIndefinido = false;
    let fechaDevolucionEstimada = null;

    if (tipoFirmas === 4) {
      if (rawFechaDev && b.es_indefinido !== 1 && b.es_indefinido !== true && b.es_indefinido !== "1") {
        if (rawFechaDev < fechaSalida) {
          return httpError(res, 400, "La fecha estimada de devolución no puede ser anterior a la fecha de salida");
        }
        fechaDevolucionEstimada = rawFechaDev;
        esIndefinido = false;
      } else {
        fechaDevolucionEstimada = null;
        esIndefinido = true;
      }
    } else {
      // 2 Firmas: Obligatoria
      if (!rawFechaDev) {
        return httpError(res, 400, "Fecha estimada de devolución requerida para vales provisionales (2 firmas)");
      }
      if (rawFechaDev < fechaSalida) {
        return httpError(res, 400, "La fecha estimada de devolución no puede ser anterior a la fecha de salida");
      }
      fechaDevolucionEstimada = rawFechaDev;
      esIndefinido = false;
    }

    const recibeNombre = String(b.recibe_nombre || "").trim() || solicitanteNombre;
    const recibeCargo = String(b.recibe_cargo || "").trim() || solicitanteCargo;

    const nowLocal = new Date();
    const todayLocalISO = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, "0")}-${String(nowLocal.getDate()).padStart(2, "0")}`;
    if (fechaSalida < todayLocalISO) {
      return httpError(res, 400, "La fecha de salida no puede ser anterior al día de hoy");
    }

    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return httpError(res, 400, "Debe agregar al menos un bien o material al vale");

    const ENCARGADOS_FIRMA_MAP = {
      1: { nombre: "GABRIEL ADÁN FIOL COLLINS", cargo: "ENCARGADO DE INVENTARIO / RECURSOS MATERIALES" },
      2: { nombre: "EVELIA CONTRERAS GODÍNEZ", cargo: "ENCARGADA DE PARQUE VEHICULAR / RECURSOS MATERIALES" },
      3: { nombre: "JESÚS SALVADOR PALACIOS MARTÍNEZ", cargo: "ENCARGADO DE MOBILIARIO / RECURSOS MATERIALES" },
      4: { nombre: "LUIS EDUARDO MAYORAL GERALDO", cargo: "ENCARGADO DE TABLETS Y STARLINKS / RECURSOS MATERIALES" },
    };
    const encargadoEntrega = ENCARGADOS_FIRMA_MAP[rubroId]?.nombre || req.user?.nombre_completo || req.user?.username;

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      // Control de Stock: Validar y descontar inmediatamente las unidades prestadas
      if (rubroId === 1) {
        for (const it of items) {
          const artId = it.articulo_id ? Number(it.articulo_id) : null;
          const clave = String(it.clave || "").trim() || null;
          const cant = Math.max(1, Number(it.cantidad) || 1);
          let almRow = null;
          if (artId) {
            const [ar] = await conn.query(`SELECT ID, CLAVE, DESCRIPCION, STOCK FROM almacen_dregcivil WHERE ID = ? FOR UPDATE`, [artId]);
            if (ar.length) almRow = ar[0];
          }
          if (!almRow && clave) {
            const [ar] = await conn.query(`SELECT ID, CLAVE, DESCRIPCION, STOCK FROM almacen_dregcivil WHERE CLAVE = ? FOR UPDATE`, [clave]);
            if (ar.length) almRow = ar[0];
          }
          if (!almRow) {
            await conn.rollback();
            return httpError(res, 400, `No se encontró en almacén el artículo: ${it.descripcion}`);
          }
          if (Number(almRow.STOCK || 0) < cant) {
            await conn.rollback();
            return httpError(res, 400, `La cantidad solicitada para "${almRow.DESCRIPCION}" supera la disponibilidad actual.`);
          }
          await conn.query(`UPDATE almacen_dregcivil SET STOCK = STOCK - ? WHERE ID = ?`, [cant, almRow.ID]);
        }
      } else {
        for (const it of items) {
          const artId = it.articulo_id ? Number(it.articulo_id) : null;
          const cant = Math.max(1, Number(it.cantidad) || 1);
          if (!artId) continue;
          const [invRows] = await conn.query(
            `SELECT id, cantidad_propia, estatus_uso, descripcion FROM inventario_oficina WHERE id = ? AND (oficina_id = 1 OR es_bodega_delegacion = 1) FOR UPDATE`,
            [artId]
          );
          if (!invRows.length) {
            await conn.rollback();
            return httpError(res, 400, `No se encontró en inventario el bien: ${it.descripcion}`);
          }
          const inv = invRows[0];
          if (Number(inv.cantidad_propia || 0) < cant) {
            await conn.rollback();
            return httpError(res, 400, `La cantidad solicitada para "${inv.descripcion}" supera la disponibilidad actual.`);
          }
          const nuevaCant = Number(inv.cantidad_propia) - cant;
          const nuevoEstatus = nuevaCant === 0 ? "PRESTADO" : inv.estatus_uso;
          await conn.query(
            `UPDATE inventario_oficina
             SET cantidad_propia = ?,
                 cantidad_disponible = ?,
                 cantidad_prestada_enviada = cantidad_prestada_enviada + ?,
                 estatus_uso = ?
             WHERE id = ?`,
            [nuevaCant, nuevaCant, cant, nuevoEstatus, artId]
          );
        }
      }

      const [[maxRow]] = await conn.query(`SELECT MAX(id) AS max_id FROM vales_prestamo FOR UPDATE`);
      const nextId = (Number(maxRow?.max_id) || 0) + 1;
      const year = new Date().getFullYear();
      const folio = `VP-${year}-${String(nextId).padStart(4, "0")}`;

      const [resIns] = await conn.query(
        `INSERT INTO vales_prestamo
           (folio, rubro_id, departamento_id, departamento_nombre, solicitante_nombre, solicitante_cargo,
            solicitante_telefono, operativo_nombre, lugar_comision, fecha_salida, fecha_devolucion_estimada,
            tipo_firmas, es_indefinido, recibe_nombre, recibe_cargo,
            estado, encargado_entrega, usuario_id, observaciones_prestamo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AUTORIZADO_EN_PRESTAMO', ?, ?, ?)`,
        [
          folio,
          rubroId,
          deptoId,
          deptoNombre,
          solicitanteNombre,
          solicitanteCargo,
          solicitanteTelefono,
          operativoNombre,
          lugarComision,
          fechaSalida,
          fechaDevolucionEstimada,
          tipoFirmas,
          esIndefinido ? 1 : 0,
          recibeNombre,
          recibeCargo,
          encargadoEntrega,
          req.user?.id || 1,
          String(b.observaciones_prestamo || "").trim() || null,
        ]
      );
      const valeId = resIns.insertId;

      for (const it of items) {
        const artId = it.articulo_id ? Number(it.articulo_id) : null;
        const clave = String(it.clave || "").trim() || null;
        const desc = String(it.descripcion || "").trim();
        if (!desc) continue;
        const cant = Math.max(1, Number(it.cantidad) || 1);
        const serie = String(it.serie || "").trim() || null;
        const marca = String(it.marca || "").trim() || null;
        const modelo = String(it.modelo || "").trim() || null;
        const color = String(it.color || "").trim() || null;
        const estSal = String(it.estado_salida || "BUEN ESTADO").trim();
        const obs = String(it.observaciones || "").trim() || null;

        await conn.query(
          `INSERT INTO vales_prestamo_detalle
             (vale_id, articulo_id, clave, descripcion, serie, marca, modelo, color, cantidad, estado_salida, estado_devolucion, observaciones)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?)`,
          [valeId, artId, clave, desc, serie, marca, modelo, color, cant, estSal, obs]
        );

        if (rubroId === 1) {
          await logMovimiento(conn, {
            tipo: "SALIDA",
            clave: clave,
            cantidad: cant,
            responsable: req.user?.username || "web",
            destino: "VALE_PRESTAMO",
            referencia: folio,
            observaciones: `Préstamo operativo: ${operativoNombre}`,
          });
        }
      }

      if (rubroId === 1) {
        await syncAlmacenCentralToInventarioRegional(conn).catch(() => {});
      }

      await conn.commit();
      return res.json({ ok: true, id: valeId, folio, message: `Vale Provisional ${folio} generado exitosamente` });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// 5. Autorizar entrega de préstamo
app.post("/api/vales-prestamo/:id/autorizar", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return httpError(res, 400, "ID inválido");

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      const [valeRows] = await conn.query(
        `SELECT * FROM vales_prestamo WHERE id = ? FOR UPDATE`,
        [id]
      );
      if (!valeRows.length) {
        await conn.rollback();
        return httpError(res, 404, "Vale no encontrado");
      }
      const vale = valeRows[0];
      if (vale.estado === "AUTORIZADO_EN_PRESTAMO") {
        await conn.rollback();
        return res.json({ ok: true, id, estado: "AUTORIZADO_EN_PRESTAMO", message: "El vale ya se encuentra en préstamo activo." });
      }
      if (vale.estado !== "SOLICITADO") {
        await conn.rollback();
        return httpError(res, 400, `El vale se encuentra en estado ${vale.estado}, no puede ser autorizado`);
      }

      const admin = isAdmin(req);
      const userRubro = getUserRubroId(req);
      const isFiol = canManageAlmacen(req);
      const isEncargadoDeEsteRubro = (userRubro && Number(userRubro) === Number(vale.rubro_id)) || (vale.rubro_id === 1 && isFiol);

      if (!admin && !isEncargadoDeEsteRubro) {
        await conn.rollback();
        return httpError(res, 403, "Solo el Administrador o el Encargado del rubro correspondiente pueden autorizar la entrega de este vale.");
      }

      const [detalles] = await conn.query(
        `SELECT * FROM vales_prestamo_detalle WHERE vale_id = ? FOR UPDATE`,
        [id]
      );

      // Descontar inventario según el rubro correspondiente
      if (vale.rubro_id === 1) {
        for (const item of detalles) {
          let artId = item.articulo_id;
          let almRow = null;
          if (artId) {
            const [ar] = await conn.query(`SELECT ID, CLAVE, DESCRIPCION, STOCK FROM almacen_dregcivil WHERE ID = ? FOR UPDATE`, [artId]);
            if (ar.length) almRow = ar[0];
          }
          if (!almRow && item.clave) {
            const [ar] = await conn.query(`SELECT ID, CLAVE, DESCRIPCION, STOCK FROM almacen_dregcivil WHERE CLAVE = ? FOR UPDATE`, [item.clave]);
            if (ar.length) almRow = ar[0];
          }
          if (!almRow) {
            await conn.rollback();
            return httpError(res, 400, `No se encontró en almacén el artículo: ${item.descripcion}`);
          }
          if (Number(almRow.STOCK || 0) < Number(item.cantidad)) {
            await conn.rollback();
            return httpError(res, 400, `La cantidad solicitada para "${item.descripcion}" supera la disponibilidad actual.`);
          }
          await conn.query(`UPDATE almacen_dregcivil SET STOCK = STOCK - ? WHERE ID = ?`, [item.cantidad, almRow.ID]);
          await logMovimiento(conn, {
            tipo: "SALIDA",
            clave: almRow.CLAVE,
            cantidad: item.cantidad,
            responsable: req.user?.username || "web",
            destino: "VALE_PRESTAMO",
            referencia: vale.folio,
            observaciones: `Préstamo operativo: ${vale.operativo_nombre}`,
          });
        }
        await syncAlmacenCentralToInventarioRegional(conn).catch(() => {});
      } else {
        for (const item of detalles) {
          if (!item.articulo_id) continue;
          const [invRows] = await conn.query(
            `SELECT id, cantidad_propia, estatus_uso, descripcion FROM inventario_oficina WHERE id = ? AND (oficina_id = 1 OR es_bodega_delegacion = 1) FOR UPDATE`,
            [item.articulo_id]
          );
          if (!invRows.length) {
            await conn.rollback();
            return httpError(res, 400, `No se encontró en inventario el bien: ${item.descripcion}`);
          }
          const inv = invRows[0];
          if (Number(inv.cantidad_propia || 0) < Number(item.cantidad)) {
            await conn.rollback();
            return httpError(res, 400, `La cantidad solicitada para "${item.descripcion}" supera la disponibilidad actual.`);
          }
          const nuevaCant = Number(inv.cantidad_propia) - Number(item.cantidad);
          const nuevoEstatus = nuevaCant === 0 ? "PRESTADO" : inv.estatus_uso;
          await conn.query(
            `UPDATE inventario_oficina
             SET cantidad_propia = ?,
                 cantidad_disponible = ?,
                 cantidad_prestada_enviada = cantidad_prestada_enviada + ?,
                 estatus_uso = ?
             WHERE id = ?`,
            [nuevaCant, nuevaCant, item.cantidad, nuevoEstatus, item.articulo_id]
          );
        }
      }

      const [[rubroInfo]] = await conn.query(`SELECT encargado_nombre FROM rubros_inventario WHERE id = ?`, [vale.rubro_id]);
      const encargadoEntrega = rubroInfo?.encargado_nombre || req.user?.nombre_completo || req.user?.username;

      await conn.query(
        `UPDATE vales_prestamo
         SET estado = 'AUTORIZADO_EN_PRESTAMO',
             encargado_entrega = ?
         WHERE id = ?`,
        [encargadoEntrega, id]
      );

      await conn.commit();
      return res.json({ ok: true, id, estado: "AUTORIZADO_EN_PRESTAMO", message: "Vale autorizado y bienes entregados en préstamo." });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// 6. Registrar devolución de préstamo (reincorpora stock)
app.post("/api/vales-prestamo/:id/devolver", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return httpError(res, 400, "ID inválido");

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      const [valeRows] = await conn.query(
        `SELECT * FROM vales_prestamo WHERE id = ? FOR UPDATE`,
        [id]
      );
      if (!valeRows.length) {
        await conn.rollback();
        return httpError(res, 404, "Vale no encontrado");
      }
      const vale = valeRows[0];
      if (vale.estado !== "AUTORIZADO_EN_PRESTAMO") {
        await conn.rollback();
        return httpError(res, 400, `El vale se encuentra en estado ${vale.estado}, solo se pueden devolver vales autorizados`);
      }

      const admin = isAdmin(req);
      const userRubro = getUserRubroId(req);
      const isFiol = canManageAlmacen(req);
      const isEncargadoDeEsteRubro = (userRubro && Number(userRubro) === Number(vale.rubro_id)) || (vale.rubro_id === 1 && isFiol);

      if (!admin && !isEncargadoDeEsteRubro) {
        await conn.rollback();
        return httpError(res, 403, "Solo el Administrador o el Encargado del rubro pueden registrar la devolución de este vale.");
      }

      const b = req.body || {};
      const returnedItems = Array.isArray(b.items) ? b.items : [];
      const itemMap = new Map();
      returnedItems.forEach((it) => {
        if (it.id) itemMap.set(Number(it.id), it);
      });

      const [detalles] = await conn.query(
        `SELECT * FROM vales_prestamo_detalle WHERE vale_id = ? FOR UPDATE`,
        [id]
      );

      // Reincorporar stock según rubro
      if (vale.rubro_id === 1) {
        for (const item of detalles) {
          const ret = itemMap.get(Number(item.id)) || {};
          const estDev = String(ret.estado_devolucion || item.estado_devolucion || "BUEN ESTADO").trim().toUpperCase();
          const obsDev = ret.observaciones !== undefined ? String(ret.observaciones).trim() : item.observaciones;

          await conn.query(
            `UPDATE vales_prestamo_detalle SET estado_devolucion = ?, observaciones = ? WHERE id = ?`,
            [estDev, obsDev, item.id]
          );

          if (estDev !== "NO DEVUELTO" && estDev !== "FALTANTE") {
            let artId = item.articulo_id;
            if (artId) {
              await conn.query(`UPDATE almacen_dregcivil SET STOCK = STOCK + ? WHERE ID = ?`, [item.cantidad, artId]);
            } else if (item.clave) {
              await conn.query(`UPDATE almacen_dregcivil SET STOCK = STOCK + ? WHERE CLAVE = ?`, [item.cantidad, item.clave]);
            }
            await logMovimiento(conn, {
              tipo: "ENTRADA",
              clave: item.clave,
              cantidad: item.cantidad,
              responsable: req.user?.username || "web",
              destino: "VALE_DEVOLUCION",
              referencia: `${vale.folio}-DEV`,
              observaciones: `Devolución vale: ${estDev}`,
            });
          }
        }
        await syncAlmacenCentralToInventarioRegional(conn).catch(() => {});
      } else {
        for (const item of detalles) {
          const ret = itemMap.get(Number(item.id)) || {};
          const estDev = String(ret.estado_devolucion || item.estado_devolucion || "BUEN ESTADO").trim().toUpperCase();
          const obsDev = ret.observaciones !== undefined ? String(ret.observaciones).trim() : item.observaciones;

          await conn.query(
            `UPDATE vales_prestamo_detalle SET estado_devolucion = ?, observaciones = ? WHERE id = ?`,
            [estDev, obsDev, item.id]
          );

          if (item.articulo_id && estDev !== "NO DEVUELTO" && estDev !== "FALTANTE") {
            const [invCur] = await conn.query(`SELECT cantidad_propia FROM inventario_oficina WHERE id = ? FOR UPDATE`, [item.articulo_id]);
            const nuevaCantDev = Number(invCur[0]?.cantidad_propia || 0) + Number(item.cantidad || 0);
            await conn.query(
              `UPDATE inventario_oficina
               SET cantidad_propia = ?,
                   cantidad_disponible = ?,
                   cantidad_prestada_enviada = GREATEST(0, cantidad_prestada_enviada - ?),
                   estatus_uso = 'ACTIVO',
                   estado_fisico = CASE WHEN ? = 'BUEN ESTADO' THEN 'BUENO' WHEN ? = 'REGULAR' THEN 'REGULAR' WHEN ? = 'CON DAÑOS' THEN 'MALO' ELSE estado_fisico END
               WHERE id = ?`,
              [nuevaCantDev, nuevaCantDev, item.cantidad, estDev, estDev, estDev, item.articulo_id]
            );
          }
        }
      }

      const [[rubroInfo]] = await conn.query(`SELECT encargado_nombre FROM rubros_inventario WHERE id = ?`, [vale.rubro_id]);
      const encargadoRecibe = rubroInfo?.encargado_nombre || req.user?.nombre_completo || req.user?.username;

      const rawFechaDevReal = b.fecha_devolucion_real ? String(b.fecha_devolucion_real).slice(0, 10) : null;
      const fechaDevRealSQL = rawFechaDevReal ? `${rawFechaDevReal} 12:00:00` : null;

      let pdfFirmadoFileName = null;
      if (b.pdf_base64) {
        try {
          const base64Data = String(b.pdf_base64).replace(/^data:application\/pdf;base64,/, "").trim();
          if (base64Data) {
            const pdfBuffer = Buffer.from(base64Data, "base64");
            const pdfsDir = BACKUP_DIRS.pdfs_firmados || path.join(BACKUP_ROOT_DIR, "pdfs_firmados");
            if (!fs.existsSync(pdfsDir)) fs.mkdirSync(pdfsDir, { recursive: true });
            pdfFirmadoFileName = `vale_firmado_${id}_${Date.now()}.pdf`;
            fs.writeFileSync(path.join(pdfsDir, pdfFirmadoFileName), pdfBuffer);
          }
        } catch (pdfErr) {
          console.warn("[WARN] Error guardando PDF firmado de vale:", pdfErr?.message || pdfErr);
        }
      }

      await conn.query(
        `UPDATE vales_prestamo
         SET estado = 'DEVUELTO',
             fecha_devolucion_real = COALESCE(?, NOW()),
             encargado_recibe_devolucion = ?,
             observaciones_devolucion = ?,
             archivo_pdf_firmado = COALESCE(?, archivo_pdf_firmado)
         WHERE id = ?`,
        [fechaDevRealSQL, encargadoRecibe, String(b.observaciones_devolucion || "").trim() || null, pdfFirmadoFileName, id]
      );

      await conn.commit();
      return res.json({
        ok: true,
        id,
        estado: "DEVUELTO",
        archivo_pdf_firmado: pdfFirmadoFileName,
        message: "Devolución registrada e inventario reincorporado exitosamente."
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// 6b. Subir o reemplazar PDF firmado de un Vale de Préstamo (ej. después de ser devuelto)
app.post("/api/vales-prestamo/:id/subir-pdf-firmado", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return httpError(res, 400, "ID inválido");

    const [rows] = await poolRead.query(`SELECT * FROM vales_prestamo WHERE id = ?`, [id]);
    if (!rows.length) return httpError(res, 404, "Vale no encontrado");
    const vale = rows[0];

    const admin = isAdmin(req);
    const userRubro = getUserRubroId(req);
    const isFiol = canManageAlmacen(req);
    const isEncargadoDeEsteRubro = (userRubro && Number(userRubro) === Number(vale.rubro_id)) || (vale.rubro_id === 1 && isFiol);

    if (!admin && !isEncargadoDeEsteRubro) {
      return httpError(res, 403, "Solo el Administrador o el Encargado del rubro pueden adjuntar el documento firmado.");
    }

    const b = req.body || {};
    if (!b.pdf_base64) {
      return httpError(res, 400, "Se requiere el archivo PDF firmado en base64");
    }

    const base64Data = String(b.pdf_base64).replace(/^data:application\/pdf;base64,/, "").trim();
    const pdfBuffer = Buffer.from(base64Data, "base64");
    const pdfsDir = BACKUP_DIRS.pdfs_firmados || path.join(BACKUP_ROOT_DIR, "pdfs_firmados");
    if (!fs.existsSync(pdfsDir)) fs.mkdirSync(pdfsDir, { recursive: true });
    const pdfFileName = `vale_firmado_${id}_${Date.now()}.pdf`;
    fs.writeFileSync(path.join(pdfsDir, pdfFileName), pdfBuffer);

    await poolOps.query(`UPDATE vales_prestamo SET archivo_pdf_firmado = ? WHERE id = ?`, [pdfFileName, id]);
    return res.json({
      ok: true,
      archivo_pdf_firmado: pdfFileName,
      message: "PDF firmado subido y respaldado exitosamente en el servidor."
    });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// 6c. Ver / Descargar PDF Firmado de Vale de Préstamo
app.get("/api/vales-prestamo/:id/pdf-firmado", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return httpError(res, 400, "ID inválido");

    const [rows] = await poolRead.query(`SELECT id, folio, archivo_pdf_firmado FROM vales_prestamo WHERE id = ?`, [id]);
    if (!rows.length) return httpError(res, 404, "Vale no encontrado");
    const vale = rows[0];

    if (!vale.archivo_pdf_firmado) {
      return httpError(res, 404, "Este vale aún no cuenta con un PDF firmado registrado.");
    }

    const filename = path.basename(vale.archivo_pdf_firmado);
    const pdfsDir = BACKUP_DIRS.pdfs_firmados || path.join(BACKUP_ROOT_DIR, "pdfs_firmados");
    const filePath = path.join(pdfsDir, filename);

    if (!fs.existsSync(filePath)) {
      return httpError(res, 404, "El archivo PDF firmado no fue encontrado físicamente en el servidor.");
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="vale_firmado_${vale.folio}.pdf"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// 7. Cancelar Vale Provisional
app.post("/api/vales-prestamo/:id/cancelar", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return httpError(res, 400, "ID inválido");

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      const [valeRows] = await conn.query(`SELECT * FROM vales_prestamo WHERE id = ? FOR UPDATE`, [id]);
      if (!valeRows.length) {
        await conn.rollback();
        return httpError(res, 404, "Vale no encontrado");
      }
      const vale = valeRows[0];

      if (vale.estado === "DEVUELTO" || vale.estado === "CANCELADO") {
        await conn.rollback();
        return httpError(res, 400, `No se puede cancelar un vale en estado ${vale.estado}`);
      }

      const admin = isAdmin(req);
      const userRubro = getUserRubroId(req);
      const isOwner = Number(vale.usuario_id) === Number(req.user?.id);
      if (!admin && !isOwner && !(userRubro && Number(userRubro) === Number(vale.rubro_id))) {
        await conn.rollback();
        return httpError(res, 403, "No tienes permisos para cancelar este vale");
      }

      // Reintegrar stock al inventario si estaba en préstamo activo
      if (vale.estado === "AUTORIZADO_EN_PRESTAMO") {
        const [detalles] = await conn.query(`SELECT * FROM vales_prestamo_detalle WHERE vale_id = ?`, [id]);
        if (vale.rubro_id === 1) {
          for (const item of detalles) {
            if (item.articulo_id) {
              await conn.query(`UPDATE almacen_dregcivil SET STOCK = STOCK + ? WHERE ID = ?`, [item.cantidad, item.articulo_id]);
            } else if (item.clave) {
              await conn.query(`UPDATE almacen_dregcivil SET STOCK = STOCK + ? WHERE CLAVE = ?`, [item.cantidad, item.clave]);
            }
          }
          await syncAlmacenCentralToInventarioRegional(conn).catch(() => {});
        } else {
          for (const item of detalles) {
            if (item.articulo_id) {
              await conn.query(
                `UPDATE inventario_oficina
                 SET cantidad_propia = cantidad_propia + ?,
                     cantidad_prestada_enviada = GREATEST(0, cantidad_prestada_enviada - ?),
                     estatus_uso = 'ACTIVO'
                 WHERE id = ?`,
                [item.cantidad, item.cantidad, item.articulo_id]
              );
            }
          }
        }
      }

      await conn.query(`UPDATE vales_prestamo SET estado = 'CANCELADO' WHERE id = ?`, [id]);
      await conn.commit();
      return res.json({ ok: true, id, estado: "CANCELADO", message: "Vale provisional cancelado e inventario reintegrado correctamente" });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// 8. Generar Vale Provisional Oficial en PDF (Exactamente 1 Hoja Carta Vertical)
app.get("/api/vales-prestamo/:id/pdf", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return httpError(res, 400, "ID inválido");

    const [valeRows] = await poolRead.query(
      `SELECT 
         vp.*,
         r.nombre_rubro,
         r.encargado_nombre AS encargado_rubro_nombre,
         r.encargado_cargo AS encargado_rubro_cargo,
         COALESCE(o.nombre, vp.departamento_nombre, 'General') AS oficialia_nombre
       FROM vales_prestamo vp
       LEFT JOIN rubros_inventario r ON r.id = vp.rubro_id
       LEFT JOIN oficialias o ON o.id = vp.departamento_id
       WHERE vp.id = ? LIMIT 1`,
      [id]
    );
    if (!valeRows.length) return httpError(res, 404, "Vale no encontrado");
    const vale = valeRows[0];

    const [detalles] = await poolRead.query(
      `SELECT * FROM vales_prestamo_detalle WHERE vale_id = ? ORDER BY id ASC`,
      [id]
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="vale_provisional_${vale.folio}.pdf"`);

    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 20, bottom: 20, left: 36, right: 36 },
      autoFirstPage: true,
    });
    doc.pipe(res);

    // DRP: Respaldo automático del vale provisional generado
    const folioClean = String(vale.folio || id).replace(/[\\/:*?"<>|]+/g, "_");
    const fechaBackup = getBackupDateStr(vale.created_at ? new Date(vale.created_at) : new Date());
    savePdfBackup(doc, "vales_provisionales", `Vale_Provisional_${folioClean}_${fechaBackup}.pdf`);

    const pageWidth = doc.page.width;   // 612 pt
    const pageHeight = doc.page.height; // 792 pt
    const leftX = 36;
    const rightLimit = pageWidth - 36;  // 576 pt
    const tableWidth = rightLimit - leftX; // 540 pt

    const COLOR_PRIMARY = "#621132";
    const COLOR_SECONDARY = "#4E0D28";
    const COLOR_ACCENT = "#B38E5D";
    const COLOR_SOFT_BG = "#F9F2F4";

    const logoGobPath = [
      path.join(__dirname, "public", "LogoGobiernoMX.png"),
      path.join(__dirname, "public", "logoGobiernoMx.png"),
      path.join(__dirname, "public", "logoGobiernoMX.png"),
      path.join(__dirname, "public", "logogobiernomx.png"),
    ].find((p) => fs.existsSync(p)) || null;

    const logoBienPath = [
      path.join(__dirname, "public", "logo.png"),
      path.join(__dirname, "public", "logo.original.png"),
    ].find((p) => fs.existsSync(p)) || null;

    const fmtDate = (d) => {
      if (!d) return "";
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return String(d);
      const day = String(dt.getDate()).padStart(2, "0");
      const month = String(dt.getMonth() + 1).padStart(2, "0");
      const year = dt.getFullYear();
      return `${day}/${month}/${year}`;
    };

    // 1. Logos oficiales
    if (logoGobPath && fs.existsSync(logoGobPath)) {
      try {
        doc.image(logoGobPath, leftX, 16, { fit: [95, 28], align: "left", valign: "top" });
      } catch {}
    }
    if (logoBienPath && fs.existsSync(logoBienPath)) {
      try {
        doc.image(logoBienPath, rightLimit - 85, 16, { fit: [85, 28], align: "right", valign: "top" });
      } catch {}
    }

    // 2. Encabezado institucional
    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(10)
      .text("SECRETARÍA DE BIENESTAR", leftX, 15, { width: tableWidth, align: "center" });
    doc.fillColor("#000000").font("Helvetica-Bold").fontSize(9)
      .text("DELEGACIÓN BAJA CALIFORNIA SUR", leftX, 27, { width: tableWidth, align: "center" });
    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(10)
      .text("VALE PROVISIONAL DE PRÉSTAMO DE MATERIAL Y EQUIPO", leftX, 40, { width: tableWidth, align: "center" });

    doc.save();
    doc.moveTo(leftX + 80, 53).lineTo(rightLimit - 80, 53).lineWidth(1).strokeColor(COLOR_ACCENT).stroke();
    doc.restore();

    // 3. Cuadro de datos del Operativo y Solicitante
    const boxY = 57;
    const boxH = 80;
    doc.save();
    doc.rect(leftX, boxY, tableWidth, boxH).lineWidth(0.8).strokeColor(COLOR_ACCENT).fillAndStroke(COLOR_SOFT_BG, COLOR_ACCENT);
    doc.restore();

    const deptoNombre = String(vale.oficialia_nombre || vale.departamento_nombre || "General").trim();
    const solNombre = String(vale.solicitante_nombre || "").trim();
    const solCargo = String(vale.solicitante_cargo || "Responsable de Operativo").trim();
    const solTel = String(vale.solicitante_telefono || "S/N").trim();
    const opNombre = String(vale.operativo_nombre || "").trim();
    const lugCom = String(vale.lugar_comision || "").trim();
    const fSalida = fmtDate(vale.fecha_salida);
    const isIndefinido = Boolean(vale.es_indefinido === 1 || !vale.fecha_devolucion_estimada);
    const fDevEst = isIndefinido ? "TIEMPO INDEFINIDO" : fmtDate(vale.fecha_devolucion_estimada);
    const rubroNombre = String(vale.nombre_rubro || "Materiales").toUpperCase();
    const folioStr = String(vale.folio || `VP-${id}`);

    // Fila 1: Folio, Fecha Emisión, Rubro
    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8.5).text("FOLIO:", leftX + 8, boxY + 6);
    doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8.5).text(folioStr, leftX + 46, boxY + 6, { width: 110 });

    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8.5).text("FECHA EMISIÓN:", leftX + 165, boxY + 6);
    doc.fillColor("#000000").font("Helvetica").fontSize(8.5).text(fmtDate(vale.created_at), leftX + 248, boxY + 6, { width: 80 });

    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8.5).text("RUBRO:", leftX + 335, boxY + 6);
    doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8).text(rubroNombre, leftX + 382, boxY + 6, { width: 150 });

    // Fila 2: Solicitante, Cargo, Teléfono
    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8).text("SOLICITANTE:", leftX + 8, boxY + 22);
    doc.fillColor("#000000").font("Helvetica").fontSize(8).text(solNombre, leftX + 75, boxY + 22, { width: 195 });

    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8).text("CARGO:", leftX + 275, boxY + 22);
    doc.fillColor("#000000").font("Helvetica").fontSize(8).text(solCargo, leftX + 320, boxY + 22, { width: 135 });

    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8).text("TEL:", leftX + 460, boxY + 22);
    doc.fillColor("#000000").font("Helvetica").fontSize(8).text(solTel, leftX + 485, boxY + 22, { width: 48 });

    // Fila 3: Área / Depto, Operativo / Evento
    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8).text("ÁREA / DEPTO:", leftX + 8, boxY + 38);
    doc.fillColor("#000000").font("Helvetica").fontSize(8).text(deptoNombre, leftX + 80, boxY + 38, { width: 190 });

    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8).text("OPERATIVO / COMISIÓN:", leftX + 275, boxY + 38);
    doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8).text(opNombre, leftX + 395, boxY + 38, { width: 138 });

    // Fila 4: Lugar Comisión, Fechas
    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8).text("LUGAR COMISIÓN:", leftX + 8, boxY + 54);
    doc.fillColor("#000000").font("Helvetica").fontSize(8).text(lugCom, leftX + 96, boxY + 54, { width: 174 });

    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8).text("FECHA SALIDA:", leftX + 275, boxY + 54);
    doc.fillColor("#000000").font("Helvetica").fontSize(8).text(fSalida, leftX + 348, boxY + 54, { width: 65 });

    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8).text("F. DEV. ESTIMADA:", leftX + 418, boxY + 54);
    if (isIndefinido) {
      doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(7).text("TIEMPO INDEFINIDO", leftX + 492, boxY + 54, { width: 78 });
    } else {
      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8).text(fDevEst, leftX + 495, boxY + 54, { width: 70 });
    }

    // Fila 5: Estatus del Vale, Modalidad y Fecha Devolución Real (si aplica)
    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8).text("ESTADO DEL VALE:", leftX + 8, boxY + 68);
    const estColor = vale.estado === "DEVUELTO" ? "#15803d" : (vale.estado === "AUTORIZADO_EN_PRESTAMO" ? "#1d4ed8" : "#b45309");
    doc.fillColor(estColor).font("Helvetica-Bold").fontSize(8).text(vale.estado, leftX + 98, boxY + 68, { width: 140 });

    const isCuatroFirmas = Number(vale.tipo_firmas) === 4 || Number(vale.es_indefinido) === 1;
    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(7.5).text("MODALIDAD:", leftX + 245, boxY + 68);
    doc.fillColor("#333333").font("Helvetica").fontSize(7.2).text(
      isCuatroFirmas ? "REGIONAL / ESPECIAL (4 FIRMAS)" : "PROVISIONAL DELEGACIÓN (2 FIRMAS)",
      leftX + 305, boxY + 68, { width: 155 }
    );

    if (vale.fecha_devolucion_real) {
      doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(7.5).text("DEVUELTO EL:", leftX + 460, boxY + 68);
      doc.fillColor("#15803d").font("Helvetica-Bold").fontSize(7.5).text(fmtDate(vale.fecha_devolucion_real), leftX + 524, boxY + 68, { width: 50 });
    }

    // 4. Párrafo formal de recepción
    const pY = boxY + boxH + 7;
    const parrafoTexto = isIndefinido
      ? "Por medio del presente documento, hago constar que recibo en calidad de RESGUARDO / ASIGNACIÓN TEMPORAL POR TIEMPO INDEFINIDO para uso exclusivo en el operativo/comisión arriba descrita, los bienes y/o materiales que a continuación se detallan, comprometiéndome a su debido cuidado, custodia y conservación:"
      : "Por medio del presente documento, hago constar que recibo en calidad de PRÉSTAMO TEMPORAL para uso exclusivo en el operativo/comisión arriba descrita, los bienes y/o materiales que a continuación se detallan, comprometiéndome a su debido cuidado, resguardo y devolución íntegra en la fecha pactada:";
    doc.fillColor("#333333").font("Helvetica-Oblique").fontSize(7.5).text(
      parrafoTexto,
      leftX, pY, { width: tableWidth, align: "justify", lineGap: 1 }
    );

    // 5. Tabla de Bienes Prestados (Ancho = 540 pt)
    const tTop = pY + 24;
    const colNoW = 28;
    const colCantW = 38;
    const colDescW = 224;
    const colMarcaW = 140;
    const colEstW = 110;

    const xNo = leftX;
    const xCant = xNo + colNoW;
    const xDesc = xCant + colCantW;
    const xMarca = xDesc + colDescW;
    const xEst = xMarca + colMarcaW;

    // Header de la tabla
    const thH = 16;
    doc.save();
    doc.rect(leftX, tTop, tableWidth, thH).fillAndStroke(COLOR_PRIMARY, COLOR_SECONDARY);
    doc.strokeColor(COLOR_ACCENT).lineWidth(0.6);
    doc.moveTo(xCant, tTop).lineTo(xCant, tTop + thH).stroke();
    doc.moveTo(xDesc, tTop).lineTo(xDesc, tTop + thH).stroke();
    doc.moveTo(xMarca, tTop).lineTo(xMarca, tTop + thH).stroke();
    doc.moveTo(xEst, tTop).lineTo(xEst, tTop + thH).stroke();
    doc.restore();

    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(7.5);
    doc.text("NO.", xNo, tTop + 4, { width: colNoW, align: "center" });
    doc.text("CANT.", xCant, tTop + 4, { width: colCantW, align: "center" });
    doc.text("DESCRIPCIÓN DEL BIEN / MATERIAL", xDesc + 4, tTop + 4, { width: colDescW - 8, align: "left" });
    doc.text("MARCA / MODELO / SERIE", xMarca + 4, tTop + 4, { width: colMarcaW - 8, align: "left" });
    doc.text("ESTADO DE SALIDA", xEst, tTop + 4, { width: colEstW, align: "center" });

    let curY = tTop + thH;
    const minRows = isCuatroFirmas ? 5 : 3;
    const totalRows = Math.max(detalles.length, minRows);
    const rowH = 15.5;

    for (let i = 0; i < totalRows; i++) {
      const it = detalles[i] || null;
      const zebra = i % 2 === 1;

      doc.save();
      doc.lineWidth(0.5).strokeColor("#CCCCCC");
      if (zebra) {
        doc.rect(leftX, curY, tableWidth, rowH).fillAndStroke(COLOR_SOFT_BG, "#CCCCCC");
      } else {
        doc.rect(leftX, curY, tableWidth, rowH).stroke();
      }
      doc.moveTo(xCant, curY).lineTo(xCant, curY + rowH).stroke();
      doc.moveTo(xDesc, curY).lineTo(xDesc, curY + rowH).stroke();
      doc.moveTo(xMarca, curY).lineTo(xMarca, curY + rowH).stroke();
      doc.moveTo(xEst, curY).lineTo(xEst, curY + rowH).stroke();
      doc.restore();

      if (it) {
        const textY = curY + 4;
        doc.fillColor("#000000").font("Helvetica").fontSize(7.2);
        doc.text(String(i + 1), xNo, textY, { width: colNoW, align: "center" });
        doc.text(String(it.cantidad || 1), xCant, textY, { width: colCantW, align: "center" });
        doc.text(String(it.descripcion || ""), xDesc + 4, textY, { width: colDescW - 8, lineBreak: false });

        const marcaModSer = [
          [it.marca, it.modelo].filter(Boolean).join(" "),
          it.serie ? `S/N: ${it.serie}` : "",
          it.color ? `(${it.color})` : "",
        ].filter(Boolean).join(" - ") || "N/A";
        doc.text(marcaModSer, xMarca + 4, textY, { width: colMarcaW - 8, lineBreak: false });

        doc.text(String(it.estado_salida || "BUEN ESTADO"), xEst, textY, { width: colEstW, align: "center" });
      }

      curY += rowH;
    }

    // 6. Cuadro destacado "NOTA DE RESPONSABILIDAD"
    const respY = curY + 6;
    const respH = 34;
    doc.save();
    doc.rect(leftX, respY, tableWidth, respH).lineWidth(0.8).strokeColor(COLOR_ACCENT).fillAndStroke(COLOR_SOFT_BG, COLOR_ACCENT);
    doc.restore();

    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(7.2)
      .text("NOTA DE RESPONSABILIDAD:", leftX + 8, respY + 4);
    doc.fillColor("#222222").font("Helvetica").fontSize(6.8).text(
      "IMPORTANTE: El solicitante es civil y administrativamente responsable de la custodia, conservación y buen uso del material o equipo asignado. En caso de daño, extravío o robo imputable a negligencia, se procederá conforme a la normatividad aplicable para el deslinde de responsabilidades.",
      leftX + 8, respY + 14, { width: tableWidth - 16, align: "justify", lineGap: 0.5 }
    );

    // Observaciones si existen (compactas)
    let signStartY = respY + respH + 8;
    if (vale.observaciones_prestamo) {
      doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(6.8).text("OBSERVACIONES:", leftX, signStartY);
      doc.fillColor("#444444").font("Helvetica").fontSize(6.8).text(String(vale.observaciones_prestamo).slice(0, 180), leftX + 76, signStartY, { width: tableWidth - 76 });
      signStartY += 12;
    }

    // 7. Sección de Firmas (4 Firmas en 1 fila vs 4 Cuadros en 2x2 Salida/Regreso)
    const ENCARGADOS_FIRMA_MAP = {
      1: { nombre: "GABRIEL ADÁN FIOL COLLINS", cargo: "ENCARGADO DE INVENTARIO / RECURSOS MATERIALES" },
      2: { nombre: "EVELIA CONTRERAS GODÍNEZ", cargo: "ENCARGADA DE PARQUE VEHICULAR / RECURSOS MATERIALES" },
      3: { nombre: "JESÚS SALVADOR PALACIOS MARTÍNEZ", cargo: "ENCARGADO DE MOBILIARIO / RECURSOS MATERIALES" },
      4: { nombre: "LUIS EDUARDO MAYORAL GERALDO", cargo: "ENCARGADO DE TABLETS Y STARLINKS / RECURSOS MATERIALES" },
    };
    const encData = ENCARGADOS_FIRMA_MAP[Number(vale.rubro_id)] || {
      nombre: (vale.encargado_rubro_nombre || vale.encargado_entrega || "ENCARGADO DE ÁREA").toUpperCase(),
      cargo: (vale.encargado_rubro_cargo || "ENCARGADO DE RECURSOS MATERIALES").toUpperCase(),
    };

    const validaNombre = "JORGE LUIS PATRÓN MURILLO";
    const validaCargo = "ENCARGADO DE RECURSOS MATERIALES";

    const recibeNombre = String(vale.recibe_nombre || solNombre || "RESPONSABLE RECEPTOR").toUpperCase();
    const recibeCargo = String(vale.recibe_cargo || solCargo || deptoNombre || "RESPONSABLE / ENLACE RECEPTOR").toUpperCase();

    const autorizaNombre = "DIPHNA YANSSEN WEICHSELBAUM CALDERÓN";
    const autorizaCargo = "DELEGADA DE PROGRAMAS PARA EL BIENESTAR EN BCS";

    if (isCuatroFirmas) {
      const signBoxH = 65;
      const signBoxY = Math.max(signStartY + 4, 668);
      const lineY = signBoxY + signBoxH - 24;
      const gap = 8;
      const boxW = (tableWidth - gap * 3) / 4; // ~129 pt
      const boxes = [
        { x: leftX, titulo: "1.- ENTREGA", cargo: encData.cargo, nombre: encData.nombre },
        { x: leftX + (boxW + gap) * 1, titulo: "2.- VALIDA", cargo: validaCargo, nombre: validaNombre },
        { x: leftX + (boxW + gap) * 2, titulo: "3.- RECIBE", cargo: recibeCargo, nombre: recibeNombre },
        { x: leftX + (boxW + gap) * 3, titulo: "4.- AUTORIZA", cargo: autorizaCargo, nombre: autorizaNombre },
      ];

      doc.save();
      doc.lineWidth(0.6).strokeColor(COLOR_PRIMARY);
      boxes.forEach((b) => {
        doc.rect(b.x, signBoxY, boxW, signBoxH).stroke();
        doc.rect(b.x, signBoxY, boxW, 13).fillAndStroke(COLOR_SOFT_BG, COLOR_PRIMARY);
        doc.strokeColor("#000000").moveTo(b.x + 8, lineY).lineTo(b.x + boxW - 8, lineY).stroke();
        doc.strokeColor(COLOR_PRIMARY);
      });
      doc.restore();

      boxes.forEach((b) => {
        doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(7.5)
          .text(b.titulo, b.x + 2, signBoxY + 3, { width: boxW - 4, align: "center", lineBreak: false });
        doc.fillColor("#000000").font("Helvetica").fontSize(5.6)
          .text(b.cargo, b.x + 2, signBoxY + 15, { width: boxW - 4, align: "center", lineGap: 0.6 });
        doc.font("Helvetica-Bold").fontSize(6.2)
          .text(b.nombre, b.x + 2, lineY + 3, { width: boxW - 4, align: "center", lineGap: 0.6 });
      });
    } else {
      // MODALIDAD INTERNA (2 FIRMAS): 4 CUADROS EN 2 COLUMNAS X 2 RENGLONES (SALIDA Y REGRESO)
      const boxW = (tableWidth - 14) / 2; // ~263 pt
      const signBoxH = 46;
      const row1Y = Math.max(signStartY + 4, 630);
      const row1LineY = row1Y + signBoxH - 14;
      const row2Y = row1Y + signBoxH + 6;
      const row2LineY = row2Y + signBoxH - 14;

      const boxes2x2 = [
        // Renglón 1: Salida
        {
          x: leftX,
          y: row1Y,
          lineY: row1LineY,
          titulo: "1.- ENTREGA (SALIDA)",
          cargo: encData.cargo,
          nombre: encData.nombre,
        },
        {
          x: leftX + boxW + 14,
          y: row1Y,
          lineY: row1LineY,
          titulo: "2.- RECIBE DE CONFORMIDAD (SALIDA)",
          cargo: recibeCargo,
          nombre: recibeNombre,
        },
        // Renglón 2: Regreso
        {
          x: leftX,
          y: row2Y,
          lineY: row2LineY,
          titulo: "3.- ENTREGA / DEVUELVE (REGRESO)",
          cargo: recibeCargo,
          nombre: recibeNombre,
        },
        {
          x: leftX + boxW + 14,
          y: row2Y,
          lineY: row2LineY,
          titulo: "4.- RECIBE DEVOLUCIÓN (REGRESO)",
          cargo: encData.cargo,
          nombre: encData.nombre,
        },
      ];

      doc.save();
      doc.lineWidth(0.6).strokeColor(COLOR_PRIMARY);
      boxes2x2.forEach((b) => {
        doc.rect(b.x, b.y, boxW, signBoxH).stroke();
        doc.rect(b.x, b.y, boxW, 11).fillAndStroke(COLOR_SOFT_BG, COLOR_PRIMARY);
        doc.strokeColor("#000000").lineWidth(0.5).moveTo(b.x + 8, b.lineY).lineTo(b.x + boxW - 8, b.lineY).stroke();
        doc.strokeColor(COLOR_PRIMARY);
      });
      doc.restore();

      boxes2x2.forEach((b) => {
        doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(6.8)
          .text(b.titulo, b.x + 2, b.y + 2, { width: boxW - 4, align: "center", lineBreak: false });
        doc.fillColor("#333333").font("Helvetica").fontSize(5.6)
          .text(b.cargo, b.x + 2, b.y + 12, { width: boxW - 4, align: "center", lineBreak: false });
        doc.fillColor("#000000").font("Helvetica-Bold").fontSize(6.6)
          .text(b.nombre, b.x + 2, b.lineY + 2.5, { width: boxW - 4, align: "center", lineBreak: false });
      });
    }

    // Pie de página
    const footY = 746;
    doc.font("Helvetica").fontSize(6.5).fillColor("#666666");
    doc.text(`Folio: ${folioStr}  |  Estatus: ${vale.estado}`, leftX, footY, { width: 200, align: "left" });
    doc.text("Página 1 de 1", leftX, footY, { width: tableWidth, align: "center" });
    doc.text("Delegación de Programas para el Bienestar en Baja California Sur", leftX, footY, { width: tableWidth, align: "right" });

    doc.end();
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// ============================================================================
// ENDPOINT TEMPORAL DE MIGRACIÓN: PARQUE VEHICULAR (Evelia - Rubro 2)
// ============================================================================
app.post("/api/migracion/vehiculos", authRequired, async (req, res) => {
  try {
    if (!canEditRegional(req) && !isAdmin(req)) {
      return httpError(res, 403, "Solo el Administrador o la Encargada de Parque Vehicular pueden ejecutar la migración de vehículos.");
    }

    const rawList = Array.isArray(req.body)
      ? req.body
      : (Array.isArray(req.body?.vehiculos)
          ? req.body.vehiculos
          : (Array.isArray(req.body?.data) ? req.body.data : []));

    if (!rawList.length) {
      return httpError(res, 400, "No se recibió la lista de vehículos para migrar.");
    }

    const hasDetCol = await ensureDetallesVehiculoCol();
    const conn = await poolOps.getConnection();

    try {
      await conn.beginTransaction();

      // 1. Asegurar y obtener el ID de la oficina "S/A (Sin Asignar)" y la única oficina de "La Paz"
      let [saOfiRows] = await conn.query(
        `SELECT id FROM oficinas_regionales WHERE nombre = 'S/A (Sin Asignar)' LIMIT 1 FOR UPDATE`
      );
      let oficinaSaId = saOfiRows[0]?.id || null;

      if (!oficinaSaId) {
        const [[defaultReg]] = await conn.query(
          `SELECT id FROM regiones WHERE clave = 'LA_PAZ' OR id = 1 ORDER BY id ASC LIMIT 1`
        );
        const regSaId = defaultReg?.id || 1;
        const [insOfi] = await conn.query(
          `INSERT INTO oficinas_regionales (region_id, municipio, nombre, responsable_oficina, activo)
           VALUES (?, 'S/A', 'S/A (Sin Asignar)', 'Por asignar', 1)`,
          [regSaId]
        );
        oficinaSaId = insOfi.insertId;
      }

      const [laPazOfiRows] = await conn.query(
        `SELECT o.id, o.nombre
         FROM oficinas_regionales o
         LEFT JOIN regiones r ON r.id = o.region_id
         WHERE o.nombre <> 'S/A (Sin Asignar)'
           AND (
             o.id = 1
             OR UPPER(o.municipio) LIKE '%LA PAZ%'
             OR UPPER(o.nombre) LIKE '%LA PAZ%'
             OR UPPER(r.clave) = 'LA_PAZ'
           )
         ORDER BY (o.id = 1) DESC, o.id ASC
         LIMIT 1`
      );
      const oficinaLaPazId = laPazOfiRows[0]?.id || 1;
      const oficinaLaPazNombre = laPazOfiRows[0]?.nombre || "La Paz";

      // 2. Limpiar estrictamente SOLO el Parque Vehicular (rubro_id = 2)
      await conn.query(`DELETE FROM inventario_oficina WHERE rubro_id = 2`);

      // 3. Insertar los 24 vehículos: "LA PAZ" a la única oficina de La Paz; el resto a "S/A (Sin Asignar)"
      let insertados = 0;
      let asignadosLaPaz = 0;
      let asignadosSa = 0;
      for (const item of rawList) {
        const marca = String(item.marca || item.descripcion || "").trim();
        const descripcion = String(item.descripcion || marca).trim();
        const color = String(item.color || "").trim();
        const serie = String(item.serie || item.serie_vin || "").trim();
        const placas = String(item.placas || item.clave || "").trim();
        const modelo = String(item.modelo || item.anio || "").trim();
        const obsMunicipio = String(item.observaciones || item.municipio || "").trim();
        const rawMunCheck = `${item.municipio || ""} ${obsMunicipio}`.toUpperCase();
        const isLaPaz = /\bLA\s+PAZ\b/.test(rawMunCheck);
        const targetOficinaId = isLaPaz ? oficinaLaPazId : oficinaSaId;

        // Usar placas como clave_bien (columna NOT NULL, sin numeración de Excel)
        const claveBien = (placas || serie || "S/P").slice(0, 60);
        const marcaModelo = [marca, modelo, color ? `(${color})` : ""].filter(Boolean).join(" ").slice(0, 150) || null;
        const seriePlacas = [placas, serie].filter(Boolean).join(" / ").slice(0, 100) || null;
        const observaciones = obsMunicipio || null;

        const detallesVehiculoObj = {
          unidad: {
            marca,
            tipo: marca,
            modelo,
            color,
            placas,
            serie_vin: serie,
            cilindros: "",
            poliza_seguro: "",
            odometro_km: "",
            nivel_gasolina: "",
          },
          estado_general: {
            estado_mecanico: "B",
            estado_electrico: "B",
            estado_carroceria: "B",
            llanta_1: "B",
            llanta_2: "B",
            llanta_3: "B",
            llanta_4: "B",
            llanta_5: "B",
          },
          checklist: {},
        };

        const detallesJson = JSON.stringify(detallesVehiculoObj);

        if (hasDetCol) {
          await conn.query(
            `INSERT INTO inventario_oficina
               (oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas,
                unidad, cantidad_propia, estado_fisico, estatus_uso, observaciones,
                origen_adquisicion, detalles_vehiculo)
             VALUES (?, 2, ?, ?, ?, ?, 'UNIDAD', 1, 'BUENO', 'ACTIVO', ?, 'COMPRA_DELEGACION', ?)`,
            [targetOficinaId, claveBien, descripcion, marcaModelo, seriePlacas, observaciones, detallesJson]
          );
        } else {
          await conn.query(
            `INSERT INTO inventario_oficina
               (oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas,
                unidad, cantidad_propia, estado_fisico, estatus_uso, observaciones, origen_adquisicion)
             VALUES (?, 2, ?, ?, ?, ?, 'UNIDAD', 1, 'BUENO', 'ACTIVO', ?, 'COMPRA_DELEGACION')`,
            [targetOficinaId, claveBien, descripcion, marcaModelo, seriePlacas, observaciones]
          );
        }
        insertados++;
        if (isLaPaz) asignadosLaPaz++;
        else asignadosSa++;
      }

      await conn.commit();
      return res.json({
        ok: true,
        total_insertados: insertados,
        asignados_la_paz: asignadosLaPaz,
        asignados_sin_asignar: asignadosSa,
        oficina_la_paz_id: oficinaLaPazId,
        oficina_la_paz_nombre: oficinaLaPazNombre,
        oficina_sa_id: oficinaSaId,
        oficina_nombre: "S/A (Sin Asignar)",
        message: `Migración completada (${insertados} vehículos): ${asignadosLaPaz} asignados a "${oficinaLaPazNombre}" y ${asignadosSa} en "S/A (Sin Asignar)".`,
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    return httpError(res, 500, e.message || "Error al ejecutar migración de vehículos");
  }
});

// ============================================================================
// ENDPOINT DE LIMPIEZA DE INVENTARIO DE GABRIEL FIOL (Archivo y Materiales)
// ============================================================================
app.post("/api/migracion/limpiar-fiol", authRequired, async (req, res) => {
  try {
    const uName = normalizeUser(req.user?.username);
    if (!isAdmin(req) && uName !== "gabrielfiol" && uName !== "rodrigo" && uName !== "jorge") {
      return httpError(res, 403, "No tienes permisos para ejecutar la limpieza del inventario de Archivo y Materiales.");
    }

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      // a) Borrar el stock principal del almacén central
      const [delAlmacen] = await conn.query(`DELETE FROM almacen_dregcivil;`);

      // b) Borrar la sincronización regional de materiales (rubro_id = 1), respetando rubros 2, 3 y 4
      const [delRegional] = await conn.query(`DELETE FROM inventario_oficina WHERE rubro_id = 1;`);

      await conn.commit();
      return res.json({
        ok: true,
        almacen_eliminados: Number(delAlmacen?.affectedRows || 0),
        regional_rubro1_eliminados: Number(delRegional?.affectedRows || 0),
        message: `Inventario de Archivo y Materiales (Gabriel Fiol) vaciado correctamente (${Number(delAlmacen?.affectedRows || 0)} registros de almacén central y ${Number(delRegional?.affectedRows || 0)} de inventario regional rubro 1 eliminados).`,
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    return httpError(res, 500, e.message || "Error al limpiar el inventario de Archivo y Materiales");
  }
});

// ============================================================================
// ENDPOINT DE MIGRACIÓN: ARCHIVO Y MATERIALES (Gabriel Fiol - Rubro 1)
// ============================================================================
app.post("/api/migracion/materiales-fiol", authRequired, async (req, res) => {
  try {
    const uName = normalizeUser(req.user?.username);
    if (!isAdmin(req) && uName !== "gabrielfiol" && uName !== "rodrigo" && uName !== "jorge" && uName !== "jorgepatron") {
      return httpError(res, 403, "No tienes permisos para ejecutar la migración de Materiales.");
    }

    const items = Array.isArray(req.body)
      ? req.body
      : (Array.isArray(req.body?.materiales)
          ? req.body.materiales
          : (Array.isArray(req.body?.items) ? req.body.items : []));

    if (!items.length) {
      return httpError(res, 400, "Se requiere un arreglo de materiales para migrar.");
    }

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("SET FOREIGN_KEY_CHECKS = 0;");

      // 1. Limpiar catálogo anterior de Almacén Central e Inventario Oficina Rubro 1
      await conn.query("DELETE FROM almacen_dregcivil;");
      await conn.query("DELETE FROM inventario_oficina WHERE rubro_id = 1;");

      // 2. Insertar los artículos oficiales
      let insertados = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const descripcion = String(it.descripcion || "").trim();
        if (!descripcion) continue;
        const categoria = String(it.categoria || "Material de Oficina").trim();
        const stock = Math.max(0, Number(it.stock ?? it.cantidad ?? 0));
        const unidad = String(it.unidad || "Piezas").trim();
        const clave = String(it.clave || `MAT-${String(i + 1).padStart(3, "0")}`).trim().toUpperCase();

        await conn.query(
          `INSERT INTO almacen_dregcivil
             (CLAVE, DESCRIPCION, CATEGORIA, UNIDAD, STOCK, origen_adquisicion, ESTADO)
           VALUES (?, ?, ?, ?, ?, 'COMPRA_DELEGACION', 'ACTIVO')`,
          [clave, descripcion, categoria, unidad, stock]
        );

        try {
          await upsertProductoFromAlmacen(conn, {
            CLAVE: clave,
            DESCRIPCION: descripcion,
            CATEGORIA: categoria,
            UNIDAD: unidad,
            ESTADO: "ACTIVO"
          });
        } catch (_) {}

        insertados++;
      }

      // 3. Sincronizar hacia inventario_oficina (rubro 1, oficina 1 / Delegación La Paz)
      await syncAlmacenCentralToInventarioRegional(conn);

      await conn.query("SET FOREIGN_KEY_CHECKS = 1;");
      await conn.commit();

      return res.json({
        ok: true,
        total_insertados: insertados,
        message: `Migración de Archivo y Materiales completada exitosamente (${insertados} artículos oficiales cargados y sincronizados).`,
      });
    } catch (err) {
      try { await conn.query("SET FOREIGN_KEY_CHECKS = 1;"); } catch (_) {}
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    return httpError(res, 500, e.message || "Error al ejecutar migración de materiales");
  }
});

// ============================================================================
// ENDPOINT DE MIGRACIÓN DE MOBILIARIO DE JESÚS (rubro_id = 3)
// ============================================================================
app.post("/api/migracion/mobiliario", authRequired, async (req, res) => {
  try {
    const uName = normalizeUser(req.user?.username);
    if (!isAdmin(req) && uName !== "jesus" && uName !== "rodrigo" && uName !== "jorge" && uName !== "jorgepatron") {
      return httpError(res, 403, "No tienes permisos para ejecutar la migración de Mobiliario.");
    }

    const items = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      return httpError(res, 400, "Se requiere un arreglo de artículos de mobiliario para migrar.");
    }

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      // 1. Limpiar únicamente el rubro de Mobiliario de Jesús (rubro_id = 3)
      const [delResult] = await conn.query(`DELETE FROM inventario_oficina WHERE rubro_id = 3;`);

      // 2. Obtener IDs de regiones
      const [regRows] = await conn.query(`SELECT id, clave, nombre FROM regiones`);
      const regByClave = {};
      for (const r of regRows) {
        if (r.clave) regByClave[String(r.clave).toUpperCase()] = Number(r.id);
      }
      const regLaPazId = regByClave.LA_PAZ || 1;
      const regLosCabosId = regByClave.LOS_CABOS || 2;
      const regComonduId = regByClave.COMONDU_LORETO || 3;
      const regMulegeId = regByClave.MULEGE || 4;

      // 3. Resolver la única oficina activa de La Paz (excluyendo comodín S/A)
      let oficinaLaPazId = null;
      let oficinaLaPazNombre = "Delegación La Paz";
      const [lpRows] = await conn.query(
        `SELECT o.id, o.nombre
         FROM oficinas_regionales o
         LEFT JOIN regiones r ON r.id = o.region_id
         WHERE o.activo = 1
           AND o.nombre <> 'S/A (Sin Asignar)'
           AND (r.clave = 'LA_PAZ' OR UPPER(o.municipio) = 'LA PAZ' OR o.region_id = ?)
         ORDER BY o.id ASC
         LIMIT 1`,
        [regLaPazId]
      );
      if (lpRows.length) {
        oficinaLaPazId = Number(lpRows[0].id);
        oficinaLaPazNombre = lpRows[0].nombre || "Delegación La Paz";
      } else {
        const [insLp] = await conn.query(
          `INSERT INTO oficinas_regionales (region_id, municipio, nombre, responsable_oficina, activo)
           VALUES (?, 'La Paz', 'Delegación La Paz', NULL, 1)`,
          [regLaPazId]
        );
        oficinaLaPazId = Number(insLp.insertId);
      }

      // 4. Resolver o crear la oficina comodín "S/A (Sin Asignar)" de cada región foránea
      const getOrCreateRegionalSaOficina = async (regionId, municipioLabel) => {
        const [rows] = await conn.query(
          `SELECT id FROM oficinas_regionales WHERE region_id = ? AND nombre = 'S/A (Sin Asignar)' LIMIT 1`,
          [regionId]
        );
        if (rows.length) {
          return Number(rows[0].id);
        }
        const [ins] = await conn.query(
          `INSERT INTO oficinas_regionales (region_id, municipio, nombre, responsable_oficina, activo)
           VALUES (?, ?, 'S/A (Sin Asignar)', 'Por asignar', 1)`,
          [regionId, municipioLabel]
        );
        return Number(ins.insertId);
      };

      const saOficinaByRegion = {
        LOS_CABOS: await getOrCreateRegionalSaOficina(regLosCabosId, "Los Cabos"),
        MULEGE: await getOrCreateRegionalSaOficina(regMulegeId, "Mulegé"),
        COMONDU_LORETO: await getOrCreateRegionalSaOficina(regComonduId, "Comondú / Loreto"),
      };

      let insertados = 0;
      let asignadosLaPaz = 0;
      let asignadosRegionesSa = 0;
      let idx = 1;

      for (const raw of items) {
        const descripcion = String(raw.descripcion || raw.articulo || raw.nombre || "").trim();
        const cantidad = Number(raw.cantidad !== undefined ? raw.cantidad : raw.cantidad_propia);
        if (!descripcion || !Number.isFinite(cantidad) || cantidad <= 0) {
          continue;
        }

        const municipioRaw = String(raw.municipio || raw.region || "").trim().toUpperCase();
        const municipioNorm = municipioRaw
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim();

        let targetOficinaId = oficinaLaPazId;
        let observaciones = "";

        if (municipioNorm === "LA PAZ" || municipioNorm === "LA_PAZ") {
          targetOficinaId = oficinaLaPazId;
          observaciones = raw.observaciones
            ? String(raw.observaciones).trim()
            : `Región: LA PAZ - Asignado a ${oficinaLaPazNombre}`;
          asignadosLaPaz++;
        } else if (municipioNorm === "LOS CABOS" || municipioNorm === "LOS_CABOS") {
          targetOficinaId = saOficinaByRegion.LOS_CABOS;
          observaciones = `Región: ${municipioRaw || "LOS CABOS"} - Oficina pendiente de asignar`;
          asignadosRegionesSa++;
        } else if (municipioNorm === "MULEGE") {
          targetOficinaId = saOficinaByRegion.MULEGE;
          observaciones = `Región: ${municipioRaw || "MULEGE"} - Oficina pendiente de asignar`;
          asignadosRegionesSa++;
        } else if (municipioNorm === "COMONDU" || municipioNorm === "COMONDU / LORETO" || municipioNorm === "COMONDU_LORETO") {
          targetOficinaId = saOficinaByRegion.COMONDU_LORETO;
          observaciones = `Región: ${municipioRaw || "COMONDU"} - Oficina pendiente de asignar`;
          asignadosRegionesSa++;
        } else {
          targetOficinaId = saOficinaByRegion.LOS_CABOS;
          observaciones = `Región: ${municipioRaw || "POR DEFINIR"} - Oficina pendiente de asignar`;
          asignadosRegionesSa++;
        }

        const claveBien = String(raw.clave_bien || `MOB-${String(idx).padStart(3, "0")}`).trim();
        idx++;

        await conn.query(
          `INSERT INTO inventario_oficina
             (oficina_id, rubro_id, clave_bien, descripcion, unidad, cantidad_propia, estado_fisico, estatus_uso, observaciones, origen_adquisicion)
           VALUES (?, 3, ?, ?, 'PIEZA', ?, 'BUENO', 'ACTIVO', ?, 'COMPRA_DELEGACION')`,
          [targetOficinaId, claveBien, descripcion, cantidad, observaciones]
        );
        insertados++;
      }

      await conn.commit();
      return res.json({
        ok: true,
        eliminados_previos: Number(delResult?.affectedRows || 0),
        total_insertados: insertados,
        asignados_la_paz: asignadosLaPaz,
        asignados_sin_asignar_regional: asignadosRegionesSa,
        oficina_la_paz_id: oficinaLaPazId,
        oficina_la_paz_nombre: oficinaLaPazNombre,
        oficinas_sa_regionales: saOficinaByRegion,
        message: `Migración de Mobiliario completada (${insertados} registros insertados en rubro 3): ${asignadosLaPaz} en "${oficinaLaPazNombre}" (La Paz) y ${asignadosRegionesSa} en oficinas "S/A (Sin Asignar)" de sus respectivas regiones.`,
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    return httpError(res, 500, e.message || "Error al ejecutar migración de mobiliario");
  }
});

// ============================================================================
// ENDPOINT DE MIGRACIÓN: MOBILIARIO FORÁNEO DE JESÚS (rubro_id = 3)
// ============================================================================
app.post("/api/migracion/mobiliario-foraneos", authRequired, async (req, res) => {
  try {
    const uName = normalizeUser(req.user?.username);
    if (!isAdmin(req) && uName !== "jesus" && uName !== "rodrigo" && uName !== "jorge" && uName !== "jorgepatron") {
      return httpError(res, 403, "No tienes permisos para ejecutar la carga de Mobiliario Foráneo.");
    }

    const items = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      return httpError(res, 400, "Se requiere un arreglo de artículos de mobiliario foráneo para cargar.");
    }

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      // 1. Obtener IDs de regiones
      const [regRows] = await conn.query(`SELECT id, clave, nombre FROM regiones`);
      const regByClave = {};
      for (const r of regRows) {
        if (r.clave) regByClave[String(r.clave).toUpperCase()] = Number(r.id);
      }
      const regLosCabosId = regByClave.LOS_CABOS || 2;
      const regComonduId = regByClave.COMONDU_LORETO || regByClave.COMONDU || 3;
      const regMulegeId = regByClave.MULEGE || 4;

      // 2. Verificar existencia de la columna cantidad_disponible en inventario_oficina
      const [invCols] = await conn.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventario_oficina'`
      ).catch(() => [[]]);
      const invColNames = new Set(invCols.map((c) => String(c.COLUMN_NAME || "").toLowerCase()));
      if (!invColNames.has("cantidad_disponible")) {
        await conn.query(
          `ALTER TABLE inventario_oficina ADD COLUMN cantidad_disponible INT(11) NOT NULL DEFAULT 0`
        ).catch(() => {});
        invColNames.add("cantidad_disponible");
      }
      const hasCantidadDisponible = invColNames.has("cantidad_disponible");

      // 3. Cache y helper para obtener el ID de la oficina comodín "S/A (Sin Asignar)" de cada región
      const saCache = {};
      const getSaOficinaId = async (regionId, municipioLabel) => {
        if (saCache[regionId]) return saCache[regionId];

        const [rows] = await conn.query(
          `SELECT id FROM oficinas_regionales WHERE region_id = ? AND (nombre LIKE '%S/A%' OR nombre LIKE '%Sin Asignar%') LIMIT 1`,
          [regionId]
        );
        if (rows.length) {
          saCache[regionId] = Number(rows[0].id);
          return saCache[regionId];
        }

        const [ins] = await conn.query(
          `INSERT INTO oficinas_regionales (region_id, municipio, nombre, responsable_oficina, activo)
           VALUES (?, ?, 'S/A (Sin Asignar)', 'Por asignar', 1)`,
          [regionId, municipioLabel]
        );
        saCache[regionId] = Number(ins.insertId);
        return saCache[regionId];
      };

      // Precargar oficinas comodín S/A para cada región foránea
      await getSaOficinaId(regLosCabosId, "Los Cabos");
      await getSaOficinaId(regComonduId, "Comondú / Loreto");
      await getSaOficinaId(regMulegeId, "Mulegé");

      let insertados = 0;
      const resumenPorRegion = {
        LOS_CABOS: 0,
        MULEGE: 0,
        COMONDU: 0,
      };

      // Contador correlativo para clave_bien única
      const [countRow] = await conn.query(
        `SELECT COUNT(*) AS total FROM inventario_oficina WHERE rubro_id = 3`
      );
      let idx = Number(countRow[0]?.total || 0) + 1;

      for (const raw of items) {
        const descripcion = String(raw.descripcion || raw.articulo || raw.nombre || "").trim();
        const cantidad = Number(raw.cantidad !== undefined ? raw.cantidad : raw.cantidad_propia);
        if (!descripcion || !Number.isFinite(cantidad) || cantidad <= 0) {
          continue;
        }

        const municipioRaw = String(raw.municipio || raw.region || "").trim();
        const municipioNorm = municipioRaw
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim()
          .toUpperCase();

        let targetRegionId = regLosCabosId;
        let regionKey = "LOS_CABOS";
        let municipioLabel = "Los Cabos";

        if (municipioNorm.includes("CABOS")) {
          targetRegionId = regLosCabosId;
          regionKey = "LOS_CABOS";
          municipioLabel = "Los Cabos";
        } else if (municipioNorm.includes("MULEGE")) {
          targetRegionId = regMulegeId;
          regionKey = "MULEGE";
          municipioLabel = "Mulegé";
        } else if (municipioNorm.includes("COMONDU") || municipioNorm.includes("LORETO")) {
          targetRegionId = regComonduId;
          regionKey = "COMONDU";
          municipioLabel = "Comondú / Loreto";
        }

        const targetOficinaId = await getSaOficinaId(targetRegionId, municipioLabel);
        const observaciones = "Región: " + (raw.municipio || municipioLabel) + " - Oficina pendiente de asignar (Carga Inicial)";
        const claveBien = String(raw.clave_bien || `MOB-FOR-${String(idx).padStart(3, "0")}`).trim();
        idx++;

        if (hasCantidadDisponible) {
          await conn.query(
            `INSERT INTO inventario_oficina
               (oficina_id, rubro_id, clave_bien, descripcion, unidad, cantidad_propia, cantidad_disponible, estado_fisico, estatus_uso, observaciones, origen_adquisicion)
             VALUES (?, 3, ?, ?, 'PIEZA', ?, ?, 'BUENO', 'ACTIVO', ?, 'COMPRA_DELEGACION')`,
            [targetOficinaId, claveBien, descripcion, cantidad, cantidad, observaciones]
          );
        } else {
          await conn.query(
            `INSERT INTO inventario_oficina
               (oficina_id, rubro_id, clave_bien, descripcion, unidad, cantidad_propia, estado_fisico, estatus_uso, observaciones, origen_adquisicion)
             VALUES (?, 3, ?, ?, 'PIEZA', ?, 'BUENO', 'ACTIVO', ?, 'COMPRA_DELEGACION')`,
            [targetOficinaId, claveBien, descripcion, cantidad, observaciones]
          );
        }

        insertados++;
        if (resumenPorRegion[regionKey] !== undefined) {
          resumenPorRegion[regionKey]++;
        }
      }

      await conn.commit();

      return res.json({
        ok: true,
        total_insertados: insertados,
        resumen_por_region: resumenPorRegion,
        oficinas_sa_asignadas: saCache,
        message: `Carga de Mobiliario Foráneo completada exitosamente: ${insertados} artículos registrados en Rubro 3 sin alterar el inventario existente. (Los Cabos: ${resumenPorRegion.LOS_CABOS}, Mulegé: ${resumenPorRegion.MULEGE}, Comondú: ${resumenPorRegion.COMONDU}).`,
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error("Error en POST /api/migracion/mobiliario-foraneos:", e);
    return httpError(res, 500, e.message || "Error al procesar la carga de mobiliario foráneo");
  }
});

// ============================================================================
// MIGRACIÓN: REESTRUCTURAR MOBILIARIO DE LA PAZ (BODEGA CENTRAL vs REGIONAL LA PAZ)
// ============================================================================
app.post("/api/migracion/reestructurar-regional-lapaz-jesus", authRequired, async (req, res) => {
  try {
    const uName = normalizeUser(req.user?.username);
    if (!isAdmin(req) && uName !== "jesus" && uName !== "rodrigo" && uName !== "jorge" && uName !== "jorgepatron") {
      return httpError(res, 403, "No tienes permisos para reestructurar el inventario de Mobiliario.");
    }

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      // 1. Obtener la región de La Paz
      const [regRows] = await conn.query(`SELECT id FROM regiones WHERE clave = 'LA_PAZ' OR id = 1 ORDER BY id ASC LIMIT 1`);
      const regLaPazId = regRows[0]?.id || 1;

      // 2. Marcar inventario previo de Mobiliario (rubro 3) en oficina La Paz / Delegación como Bodega Central
      const [updBodega] = await conn.query(
        `UPDATE inventario_oficina
         SET es_bodega_delegacion = 1
         WHERE rubro_id = 3
           AND (oficina_id = 1 OR oficina_id IN (
             SELECT id FROM oficinas_regionales 
             WHERE region_id = ? AND nombre NOT LIKE '%Coordinación Regional%' AND nombre NOT LIKE '%Coordinacion Regional%'
           ))`,
        [regLaPazId]
      );

      // 3. Asegurar formalmente la oficina "Coordinación Regional La Paz" asignada a la región 1 (La Paz)
      let [ofiCoordRows] = await conn.query(
        `SELECT id FROM oficinas_regionales
         WHERE region_id = ? AND (nombre = 'Coordinación Regional La Paz' OR nombre = 'Coordinacion Regional La Paz' OR nombre LIKE '%Coordinación Regional%')
         LIMIT 1 FOR UPDATE`,
        [regLaPazId]
      );
      let coordLaPazId = ofiCoordRows[0]?.id || null;

      if (!coordLaPazId) {
        const [insOfi] = await conn.query(
          `INSERT INTO oficinas_regionales (region_id, municipio, nombre, responsable_oficina, activo)
           VALUES (?, 'La Paz', 'Coordinación Regional La Paz', 'Sandra Gpe. Salvatierra Amador', 1)`,
          [regLaPazId]
        );
        coordLaPazId = insOfi.insertId;
      } else {
        await conn.query(
          `UPDATE oficinas_regionales
           SET nombre = 'Coordinación Regional La Paz',
               responsable_oficina = 'Sandra Gpe. Salvatierra Amador',
               municipio = 'La Paz',
               activo = 1
           WHERE id = ?`,
          [coordLaPazId]
        );
      }

      // 4. Si la Coordinación Regional ya tenía artículos de prueba en rubro 3, borrar solo aquellos sin vales activos
      await conn.query(
        `DELETE FROM inventario_oficina
         WHERE oficina_id = ?
           AND rubro_id = 3
           AND id NOT IN (SELECT DISTINCT articulo_id FROM vales_prestamo_detalle WHERE articulo_id IS NOT NULL)`,
        [coordLaPazId]
      );

      // 5. Insertar los 7 artículos oficiales
      const articulosOficiales = [
        { clave_bien: "MOB-LP-01", descripcion: "Sillas", cantidad: 81, unidad: "PZA" },
        { clave_bien: "MOB-LP-02", descripcion: "Mesas grandes", cantidad: 10, unidad: "PZA" },
        { clave_bien: "MOB-LP-03", descripcion: "Mesas chicas", cantidad: 3, unidad: "PZA" },
        { clave_bien: "MOB-LP-04", descripcion: "Abanico", cantidad: 4, unidad: "PZA" },
        { clave_bien: "MOB-LP-05", descripcion: "Toldo", cantidad: 1, unidad: "PZA" },
        { clave_bien: "MOB-LP-06", descripcion: "Diablo", cantidad: 1, unidad: "PZA" },
        { clave_bien: "MOB-LP-07", descripcion: "Archivero", cantidad: 1, unidad: "PZA" },
      ];

      for (const it of articulosOficiales) {
        await conn.query(
          `INSERT INTO inventario_oficina
             (oficina_id, rubro_id, clave_bien, descripcion, unidad, cantidad_propia, cantidad_disponible, estado_fisico, estatus_uso, observaciones, es_bodega_delegacion, origen_adquisicion)
           VALUES (?, 3, ?, ?, ?, ?, ?, 'BUENO', 'ACTIVO', NULL, 0, 'COMPRA_DELEGACION')`,
          [coordLaPazId, it.clave_bien, it.descripcion, it.unidad, it.cantidad, it.cantidad]
        );
      }

      await conn.commit();
      return res.json({
        ok: true,
        bodega_actualizados: Number(updBodega?.affectedRows || 0),
        oficina_coordinacion_id: coordLaPazId,
        articulos_insertados: articulosOficiales.length,
        message: `Reestructuración de Mobiliario completada exitosamente. Se preservó el inventario existente como Bodega Central (${updBodega?.affectedRows || 0} registros con es_bodega_delegacion=1) y se cargaron los 7 artículos oficiales en la Coordinación Regional La Paz (a cargo de Sandra Gpe. Salvatierra Amador).`,
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error("Error en POST /api/migracion/reestructurar-regional-lapaz-jesus:", e);
    return httpError(res, 500, e.message || "Error al reestructurar mobiliario de La Paz");
  }
});

// ============================================================================
// MIGRACIÓN ATÓMICA: RESET DE VALES PROVISIONALES (CON REINTEGRO DE STOCK) Y
// REESTRUCTURACIÓN REGIONAL DE JESÚS EN LA PAZ (DESCUENTO DE BODEGA -> REGIONAL)
// ============================================================================
app.post("/api/migracion/reset-vales-y-reestructurar-jesus", authRequired, async (req, res) => {
  try {
    const uName = normalizeUser(req.user?.username);
    if (!isAdmin(req) && !["jesus", "rodrigo", "jorge", "jorgepatron"].includes(uName)) {
      return httpError(res, 403, "No tienes permisos para ejecutar el reset de vales y reestructuración de mobiliario.");
    }

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      // ----------------------------------------------------------------------
      // PARTE 1: REINTEGRO DE STOCK DE VALES ACTIVOS Y LIMPIEZA DE VALES
      // ----------------------------------------------------------------------
      const [[countValesRow]] = await conn.query(`SELECT COUNT(*) AS total FROM vales_prestamo`);
      const totalValesEliminados = Number(countValesRow?.total || 0);

      const [valesActivos] = await conn.query(
        `SELECT * FROM vales_prestamo WHERE estado NOT IN ('DEVUELTO', 'CANCELADO') FOR UPDATE`
      );

      let totalPiezasReintegradas = 0;
      let huboReintegroRubro1 = false;

      for (const vale of valesActivos) {
        const [detalles] = await conn.query(
          `SELECT * FROM vales_prestamo_detalle WHERE vale_id = ? FOR UPDATE`,
          [vale.id]
        );
        for (const item of detalles) {
          const cant = Math.max(0, Number(item.cantidad || 0));
          if (cant <= 0) continue;

          if (Number(vale.rubro_id) === 1) {
            let updated = false;
            if (item.articulo_id) {
              const [rUpd] = await conn.query(
                `UPDATE almacen_dregcivil SET STOCK = STOCK + ? WHERE ID = ?`,
                [cant, item.articulo_id]
              );
              updated = Number(rUpd?.affectedRows || 0) > 0;
            }
            if (!updated && item.clave) {
              const [rUpd] = await conn.query(
                `UPDATE almacen_dregcivil SET STOCK = STOCK + ? WHERE CLAVE = ?`,
                [cant, item.clave]
              );
              updated = Number(rUpd?.affectedRows || 0) > 0;
            }
            if (updated) {
              totalPiezasReintegradas += cant;
              huboReintegroRubro1 = true;
            }
          } else {
            let invRow = null;
            if (item.articulo_id) {
              const [rows] = await conn.query(
                `SELECT id, cantidad_propia FROM inventario_oficina WHERE id = ? FOR UPDATE`,
                [item.articulo_id]
              );
              if (rows.length) invRow = rows[0];
            }
            if (!invRow && item.clave) {
              const [rows] = await conn.query(
                `SELECT id, cantidad_propia FROM inventario_oficina
                 WHERE clave_bien = ? AND rubro_id = ?
                 ORDER BY es_bodega_delegacion DESC, id ASC LIMIT 1 FOR UPDATE`,
                [item.clave, vale.rubro_id]
              );
              if (rows.length) invRow = rows[0];
            }
            if (invRow) {
              const nuevaPropia = Number(invRow.cantidad_propia || 0) + cant;
              await conn.query(
                `UPDATE inventario_oficina
                 SET cantidad_propia = ?,
                     cantidad_disponible = ?,
                     cantidad_prestada_enviada = GREATEST(0, cantidad_prestada_enviada - ?),
                     estatus_uso = 'ACTIVO'
                 WHERE id = ?`,
                [nuevaPropia, nuevaPropia, cant, invRow.id]
              );
              totalPiezasReintegradas += cant;
            }
          }
        }
      }

      if (huboReintegroRubro1) {
        await syncAlmacenCentralToInventarioRegional(conn).catch(() => {});
      }

      // Eliminar todos los detalles y encabezados de vales provisionales
      await conn.query(`DELETE FROM vales_prestamo_detalle`);
      await conn.query(`DELETE FROM vales_prestamo`);

      // Asegurar que ningún bien quede con cantidad_prestada_enviada residual tras vaciar vales
      await conn.query(
        `UPDATE inventario_oficina
         SET cantidad_prestada_enviada = 0,
             cantidad_disponible = cantidad_propia,
             estatus_uso = CASE WHEN estatus_uso = 'PRESTADO' THEN 'ACTIVO' ELSE estatus_uso END
         WHERE cantidad_prestada_enviada > 0 OR cantidad_disponible <> cantidad_propia OR estatus_uso = 'PRESTADO'`
      );

      // ----------------------------------------------------------------------
      // PARTE 2: LIMPIEZA REGIONAL DE JESÚS EN LA PAZ Y TRASPASO DESDE BODEGA
      // ----------------------------------------------------------------------
      const [regRows] = await conn.query(`SELECT id FROM regiones WHERE clave = 'LA_PAZ' OR id = 1 ORDER BY id ASC LIMIT 1`);
      const regLaPazId = regRows[0]?.id || 1;

      // Garantizar que el inventario general de Jesús en Delegación La Paz (oficina_id = 1) tenga es_bodega_delegacion = 1
      await conn.query(
        `UPDATE inventario_oficina
         SET es_bodega_delegacion = 1
         WHERE rubro_id = 3 AND oficina_id = 1`
      );

      // Asegurar oficina "Coordinación Regional La Paz" a cargo de SANDRA GPE. SALVATIERRA AMADOR
      const [coordRows] = await conn.query(
        `SELECT id FROM oficinas_regionales
         WHERE region_id = ? AND nombre IN ('Coordinación Regional La Paz', 'Coordinacion Regional La Paz')
         ORDER BY id ASC LIMIT 1`,
        [regLaPazId]
      );
      let coordLaPazId = coordRows[0]?.id || null;
      if (!coordLaPazId) {
        const [insCoord] = await conn.query(
          `INSERT INTO oficinas_regionales (region_id, municipio, nombre, responsable_oficina, activo)
           VALUES (?, 'La Paz', 'Coordinación Regional La Paz', 'SANDRA GPE. SALVATIERRA AMADOR', 1)`,
          [regLaPazId]
        );
        coordLaPazId = insCoord.insertId;
      } else {
        await conn.query(
          `UPDATE oficinas_regionales
           SET nombre = 'Coordinación Regional La Paz',
               responsable_oficina = 'SANDRA GPE. SALVATIERRA AMADOR',
               activo = 1
           WHERE id = ?`,
          [coordLaPazId]
        );
      }

      // Idempotencia: si ya existían registros en regional de La Paz creados con 'TRASPASO_DESDE_BODEGA_JESUS',
      // devolver su cantidad a la Bodega General de Jesús antes de limpiarlos para no descontar doble
      const [prevTraspasos] = await conn.query(
        `SELECT id, clave_bien, descripcion, cantidad_propia
         FROM inventario_oficina
         WHERE rubro_id = 3
           AND COALESCE(es_bodega_delegacion, 0) = 0
           AND observaciones_control = 'TRASPASO_DESDE_BODEGA_JESUS'
           AND oficina_id IN (SELECT id FROM oficinas_regionales WHERE region_id = ?)
         FOR UPDATE`,
        [regLaPazId]
      );
      for (const prev of prevTraspasos) {
        const cantPrev = Math.max(0, Number(prev.cantidad_propia || 0));
        if (cantPrev <= 0) continue;
        const [bodegaMatch] = await conn.query(
          `SELECT id, cantidad_propia FROM inventario_oficina
           WHERE rubro_id = 3 AND es_bodega_delegacion = 1
             AND (UPPER(TRIM(clave_bien)) = UPPER(TRIM(?)) OR LOWER(TRIM(descripcion)) = LOWER(TRIM(?)))
           ORDER BY id ASC LIMIT 1 FOR UPDATE`,
          [prev.clave_bien || "", prev.descripcion || ""]
        );
        if (bodegaMatch.length) {
          const restaurada = Number(bodegaMatch[0].cantidad_propia || 0) + cantPrev;
          await conn.query(
            `UPDATE inventario_oficina
             SET cantidad_propia = ?, cantidad_disponible = ?
             WHERE id = ?`,
            [restaurada, restaurada, bodegaMatch[0].id]
          );
        }
      }

      // Limpiar todos los registros regionales previos de Mobiliario (rubro_id = 3) en La Paz que no sean bodega general
      const [delRegional] = await conn.query(
        `DELETE FROM inventario_oficina
         WHERE rubro_id = 3
           AND COALESCE(es_bodega_delegacion, 0) = 0
           AND oficina_id IN (SELECT id FROM oficinas_regionales WHERE region_id = ?)`,
        [regLaPazId]
      );

      // Los 7 artículos exactos a descontar del Inventario General de Jesús y cargar en Coordinación Regional La Paz
      const articulosTraspaso = [
        { clave_bien: "MOB-001", descripcion: "Sillas grises", aliases: ["sillas grises", "sillas"], cantidad: 81 },
        { clave_bien: "MOB-002", descripcion: "Mesas grandes", aliases: ["mesas grandes"], cantidad: 10 },
        { clave_bien: "MOB-004", descripcion: "Mesas chicas", aliases: ["mesas chicas"], cantidad: 3 },
        { clave_bien: "MOB-005", descripcion: "Abanicos grandes", aliases: ["abanico grande", "abanicos grandes", "abanico"], cantidad: 4 },
        { clave_bien: "MOB-008", descripcion: "Carpas 3x3", aliases: ["carpas 3x3", "carpa 3x3", "toldo"], cantidad: 1 },
        { clave_bien: "MOB-022", descripcion: "Diablito", aliases: ["diablito", "diablo"], cantidad: 1 },
        { clave_bien: "MOB-021", descripcion: "Archivero", aliases: ["archivero"], cantidad: 1 },
      ];

      const resumenTraspaso = [];

      for (const it of articulosTraspaso) {
        const [bodegaRows] = await conn.query(
          `SELECT id, clave_bien, descripcion, cantidad_propia, cantidad_disponible
           FROM inventario_oficina
           WHERE rubro_id = 3 AND es_bodega_delegacion = 1
             AND (
               UPPER(TRIM(clave_bien)) = UPPER(TRIM(?))
               OR LOWER(TRIM(descripcion)) IN (?)
             )
           ORDER BY (UPPER(TRIM(clave_bien)) = UPPER(TRIM(?))) DESC, id ASC
           LIMIT 1 FOR UPDATE`,
          [it.clave_bien, [it.descripcion.toLowerCase(), ...it.aliases], it.clave_bien]
        );

        let stockAntes = null;
        let stockDespues = null;

        if (bodegaRows.length) {
          const bRow = bodegaRows[0];
          stockAntes = Number(bRow.cantidad_propia || 0);
          stockDespues = Math.max(0, stockAntes - it.cantidad);
          await conn.query(
            `UPDATE inventario_oficina
             SET cantidad_propia = ?,
                 cantidad_disponible = ?
             WHERE id = ?`,
            [stockDespues, stockDespues, bRow.id]
          );
        }

        await conn.query(
          `INSERT INTO inventario_oficina
             (oficina_id, rubro_id, clave_bien, descripcion, unidad, cantidad_propia, cantidad_disponible,
              estado_fisico, estatus_uso, observaciones, observaciones_control, es_bodega_delegacion, origen_adquisicion)
           VALUES (?, 3, ?, ?, 'PZA', ?, ?, 'BUENO', 'ACTIVO', NULL, 'TRASPASO_DESDE_BODEGA_JESUS', 0, 'COMPRA_DELEGACION')`,
          [coordLaPazId, it.clave_bien, it.descripcion, it.cantidad, it.cantidad]
        );

        resumenTraspaso.push({
          clave_bien: it.clave_bien,
          descripcion: it.descripcion,
          cantidad_traspasada: it.cantidad,
          bodega_antes: stockAntes,
          bodega_despues: stockDespues,
        });
      }

      await conn.commit();

      // Reiniciar contadores AUTO_INCREMENT para que los folios VP-2026-0001 arranquen limpios desde 1
      await conn.query(`ALTER TABLE vales_prestamo_detalle AUTO_INCREMENT = 1`).catch(() => {});
      await conn.query(`ALTER TABLE vales_prestamo AUTO_INCREMENT = 1`).catch(() => {});

      return res.json({
        ok: true,
        vales_eliminados: totalValesEliminados,
        vales_activos_reintegrados: valesActivos.length,
        piezas_reintegradas: totalPiezasReintegradas,
        regional_eliminados: Number(delRegional?.affectedRows || 0),
        oficina_coordinacion_id: coordLaPazId,
        articulos_traspasados: resumenTraspaso.length,
        detalle_traspaso: resumenTraspaso,
        message: `Proceso completado: ${totalValesEliminados} vales eliminados (${totalPiezasReintegradas} piezas devueltas a su inventario original) y 7 artículos descontados de la Bodega General de Jesús y asignados a Coordinación Regional La Paz (a cargo de SANDRA GPE. SALVATIERRA AMADOR).`,
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error("Error en POST /api/migracion/reset-vales-y-reestructurar-jesus:", e);
    return httpError(res, 500, e.message || "Error al ejecutar reset de vales y reestructuración de mobiliario");
  }
});

// ============================================================================
// MIGRACIÓN: CARGA / ACTUALIZACIÓN PARQUE VEHICULAR RECURSOS MATERIALES (EVELIA)
// ============================================================================
app.post("/api/migracion/vehiculos-rm-lapaz", authRequired, async (req, res) => {
  try {
    const uName = normalizeUser(req.user?.username);
    if (!isAdmin(req) && uName !== "evelia" && uName !== "rodrigo" && uName !== "jorge" && uName !== "jorgepatron") {
      return httpError(res, 403, "No tienes permisos para cargar el parque vehicular de Recursos Materiales.");
    }

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      const [regRows] = await conn.query(`SELECT id FROM regiones WHERE clave = 'LA_PAZ' OR id = 1 ORDER BY id ASC LIMIT 1`);
      const regLaPazId = regRows[0]?.id || 1;

      // Buscar o crear formalmente la oficina "RM (Recursos Materiales)" en La Paz
      let [rmOfiRows] = await conn.query(
        `SELECT id FROM oficinas_regionales
         WHERE region_id = ? AND (nombre = 'RM (Recursos Materiales)' OR nombre = 'RM' OR nombre LIKE '%Recursos Materiales%')
         LIMIT 1 FOR UPDATE`,
        [regLaPazId]
      );
      let rmOficinaId = rmOfiRows[0]?.id || null;

      if (!rmOficinaId) {
        const [insRm] = await conn.query(
          `INSERT INTO oficinas_regionales (region_id, municipio, nombre, responsable_oficina, activo)
           VALUES (?, 'La Paz', 'RM (Recursos Materiales)', 'Jorge Luis Patrón Murillo', 1)`,
          [regLaPazId]
        );
        rmOficinaId = insRm.insertId;
      } else {
        await conn.query(
          `UPDATE oficinas_regionales
           SET nombre = 'RM (Recursos Materiales)',
               responsable_oficina = 'Jorge Luis Patrón Murillo',
               municipio = 'La Paz',
               activo = 1
           WHERE id = ?`,
          [rmOficinaId]
        );
      }

      // Limpiar los vehículos erróneos previos en la oficina RM (rubro_id = 2)
      const [delResult] = await conn.query(
        `DELETE FROM inventario_oficina WHERE oficina_id = ? AND rubro_id = 2;`,
        [rmOficinaId]
      );

      const hasDetCol = await ensureDetallesVehiculoCol();

      const vehiculosRMDefault = [
        { clave_bien: "DAH 9934", marca: "MG", modelo: "MG 5", color: "GRIS OXFORD", serie: "LSJA36E91PZ039853", placas: "DAH 9934", municipio: "La Paz/RM", anio: 2023 },
        { clave_bien: "CF 54458", marca: "MG", modelo: "MG 5", color: "NEGRO BRILLANTE", serie: "LSJA36E95PZ045171", placas: "CF 54458", municipio: "La Paz/RM", anio: 2023 },
        { clave_bien: "DAH 9930", marca: "MG", modelo: "MG 5", color: "NEGRO BRILLANTE", serie: "LSJA36E9XPZ046879", placas: "DAH 9930", municipio: "La Paz/RM", anio: 2023 },
        { clave_bien: "DAH 9940", marca: "MG", modelo: "MG 5", color: "ROJO MANCHESTER", serie: "LSJA36E93PZ045251", placas: "DAH 9940", municipio: "La Paz/RM", anio: 2023 },
        { clave_bien: "CF 54452", marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDTXNG407431", placas: "CF 54452", municipio: "La Paz/RM", anio: 2022 },
        { clave_bien: "CF 54461", marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDTXNG414105", placas: "CF 54461", municipio: "La Paz/RM", anio: 2022 },
        { clave_bien: "CF 54470", marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDT6NG407409", placas: "CF 54470", municipio: "La Paz/RM", anio: 2022 },
        { clave_bien: "CF 54399", marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDT5NG407093", placas: "CF 54399", municipio: "La Paz/RM", anio: 2022 },
        { clave_bien: "CF 61041", marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDT1NG414381", placas: "CF 61041", municipio: "La Paz/RM", anio: 2022 },
        { clave_bien: "CF 54491", marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDT4NG430851", placas: "CF 54491", municipio: "La Paz/RM", anio: 2022 },
        { clave_bien: "CF 54473", marca: "TOYOTA", modelo: "HILUX", color: "BLANCO", serie: "MR0CX3DD2N1332838", placas: "CF 54473", municipio: "La Paz/RM", anio: 2022 },
        { clave_bien: "CF 54486", marca: "RAM", modelo: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT4NG406611", placas: "CF 54486", municipio: "La Paz/RM", anio: 2022 },
        { clave_bien: "DAH 9928", marca: "NISSAN", modelo: "URVAN", color: "BLANCO", serie: "JN1BE6DS6P9081474", placas: "DAH 9928", municipio: "La Paz/RM", anio: 2023 }
      ];

      const rawList = Array.isArray(req.body)
        ? req.body
        : (Array.isArray(req.body?.vehiculos)
            ? req.body.vehiculos
            : (Array.isArray(req.body?.data) ? req.body.data : []));

      const listToProcess = rawList.length > 0 ? rawList : vehiculosRMDefault;

      let insertCount = 0;
      for (const v of listToProcess) {
        const claveBien = String(v.clave_bien || v.placas || "").trim();
        const marca = String(v.marca || "").trim();
        const modelo = String(v.modelo || "").trim();
        const anio = v.anio ? Number(v.anio) : null;
        const color = String(v.color || "").trim();
        const serie = String(v.serie || "").trim();
        const placas = String(v.placas || claveBien).trim();
        const municipio = String(v.municipio || "La Paz/RM").trim();

        const descripcion = [marca, modelo, anio].filter(Boolean).join(" ").trim();
        const marcaModelo = [marca, modelo].filter(Boolean).join(" ").trim();
        const seriePlacas = [placas, serie].filter(Boolean).join(" / ").trim();

        const detallesVehiculoObj = {
          unidad: {
            marca,
            tipo: marca,
            modelo: [modelo, anio].filter(Boolean).join(" "),
            color,
            placas,
            serie_vin: serie,
            cilindros: "",
            poliza_seguro: "",
            odometro_km: "",
            nivel_gasolina: "",
          },
          estado_general: {
            estado_mecanico: "B",
            estado_electrico: "B",
            estado_carroceria: "B",
            llanta_1: "B",
            llanta_2: "B",
            llanta_3: "B",
            llanta_4: "B",
            llanta_5: "B",
          },
          checklist: {},
        };
        const detallesJson = JSON.stringify(detallesVehiculoObj);

        await conn.query(
          `INSERT INTO inventario_oficina
             (oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas,
              marca, modelo, color, serie, numero_serie, placas, anio, municipio,
              unidad, cantidad_propia, cantidad_disponible, estado_fisico, estatus_uso, observaciones,
              origen_adquisicion ${hasDetCol ? ", detalles_vehiculo" : ""})
           VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNIDAD', 1, 1, 'BUENO', 'ACTIVO', NULL, 'COMPRA_DELEGACION' ${hasDetCol ? ", ?" : ""})`,
          hasDetCol
            ? [rmOficinaId, claveBien, descripcion, marcaModelo, seriePlacas, marca, modelo, color, serie, serie, placas, anio, municipio, detallesJson]
            : [rmOficinaId, claveBien, descripcion, marcaModelo, seriePlacas, marca, modelo, color, serie, serie, placas, anio, municipio]
        );
        insertCount++;
      }

      await conn.commit();
      return res.json({
        ok: true,
        oficina_rm_id: rmOficinaId,
        vehiculos_eliminados: Number(delResult?.affectedRows || 0),
        vehiculos_procesados: insertCount,
        message: `Carga de los 13 vehículos oficiales de Recursos Materiales completada exitosamente en la oficina "RM (Recursos Materiales)" (La Paz). Se limpiaron ${delResult?.affectedRows || 0} registros erróneos previos y se insertaron ${insertCount} unidades oficiales reales.`,
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error("Error en POST /api/migracion/vehiculos-rm-lapaz:", e);
    return httpError(res, 500, e.message || "Error al procesar vehículos RM");
  }
});

// ============================================================================
// MIGRACIÓN: VEHÍCULOS FORÁNEOS DE EVELIA CON MATCH DE OFICINAS (SIN CREAR NUEVAS)
// ============================================================================
app.post("/api/migracion/vehiculos-foraneos-evelia", authRequired, async (req, res) => {
  try {
    const uName = normalizeUser(req.user?.username);
    if (!isAdmin(req) && !["evelia", "rodrigo", "jorge", "jorgepatron"].includes(uName)) {
      return httpError(res, 403, "No tienes permisos para ejecutar la migración de vehículos foráneos.");
    }

    const vehiculosForaneosDefault = [
      // LOS CABOS
      { marca: "MG", modelo: "MG 5", color: "BLANCO YORK", serie: "LSJA36E91PZ039626", placas: "DAH 99-46", municipio: "LOS CABOS", oficina: "CANGREJOS", anio: 2023 },
      { marca: "MG", modelo: "MG 5", color: "ROJO MANCHESTER", serie: "LSJA36E95PZ045493", placas: "DAH 9938", municipio: "LOS CABOS", oficina: "CANGREJOS", anio: 2023 },
      { marca: "RAM", modelo: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT7NG430255", placas: "CF 54488", municipio: "LOS CABOS", oficina: "PEC", anio: 2022 },
      { marca: "RAM", modelo: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT8NG406675", placas: "CF 54492", municipio: "LOS CABOS", oficina: "SADER", anio: 2022 },
      { marca: "RAM", modelo: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT5NG406620", placas: "CF 54485", municipio: "LOS CABOS", oficina: "SADER", anio: 2022 },
      { marca: "NISSAN", modelo: "FRONTIER", color: "BLANCO", serie: "3N6AD33A4PK828180", placas: "CF 61040", municipio: "LOS CABOS", oficina: "GUAYMITAS", anio: 2023 },
      // MULEGÉ
      { marca: "MG", modelo: "MG 5", color: "NEGRO BRILLANTE", serie: "LSJA36E9XPZ040290", placas: "DAH 99-43", municipio: "MULEGÉ", oficina: "SANTA ROSALIA", anio: 2023 },
      { marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDT3NG414236", placas: "CF 54400", municipio: "MULEGE", oficina: "SANTA ROSALÍA", anio: 2022 },
      { marca: "TOYOTA", modelo: "TOYOTA HILUX", color: "BLANCO", serie: "MR0CX3DD0N1333065", placas: "CF 54435", municipio: "MULEGE", oficina: "VILLA ALBERTO ALVARADO", anio: 2022 },
      { marca: "RAM", modelo: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT4NG406740", placas: "CF 54487", municipio: "MULEGE", oficina: "GUERRERO NEGRO", anio: 2022 },
      // COMONDÚ
      { marca: "MG", modelo: "MG 5", color: "ROJO MANCHESTER", serie: "LSJA36E9XPZ044193", placas: "DAH 9941", municipio: "COMONDU", oficina: "CD CONSTITUCIÓN", anio: 2023 },
      { marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDTXNG407364", placas: "CF 54460", municipio: "COMONDU", oficina: "LORETO", anio: 2022 },
      { marca: "TOYOTA", modelo: "TOYOTA HILUX", color: "BLANCO", serie: "MR0CX3DD3N1332900", placas: "CF 54479", municipio: "COMONDU", oficina: "CD CONSTITUCIÓN", anio: 2022 },
      { marca: "RAM", modelo: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT4NG413641", placas: "CF 54471", municipio: "COMONDU", oficina: "CD CONSTITUCIÓN", anio: 2022 },
      { marca: "NISSAN", modelo: "FRONTIER", color: "BLANCO", serie: "3N6AD33A6PK828150", placas: "CF 61042", municipio: "COMONDU", oficina: "CD CONSTITUCIÓN", anio: 2023 },
    ];

    const rawList = Array.isArray(req.body)
      ? req.body
      : (Array.isArray(req.body?.vehiculos)
          ? req.body.vehiculos
          : (Array.isArray(req.body?.data) ? req.body.data : []));
    const listToProcess = rawList.length > 0 ? rawList : vehiculosForaneosDefault;

    const hasDetCol = await ensureDetallesVehiculoCol();
    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      // Paso A (Limpieza): Eliminar todos los vehículos (rubro_id = 2) en oficinas comodín "S/A" o "Sin Asignar"
      // de las regiones foráneas (Los Cabos = 2, Comondú = 3, Mulegé = 4). La Paz (region_id = 1) se ignora por completo.
      const [delSaResult] = await conn.query(
        `DELETE io FROM inventario_oficina io
         JOIN oficinas_regionales ofi ON io.oficina_id = ofi.id
         WHERE io.rubro_id = 2
           AND ofi.region_id IN (2, 3, 4)
           AND (ofi.nombre LIKE '%S/A%' OR ofi.nombre LIKE '%Sin Asignar%');`
      );

      let insertCount = 0;
      let updateCount = 0;
      const asignaciones = [];

      // Paso B (Inserción con match de oficina existente sin crear oficinas nuevas)
      for (const item of listToProcess) {
        const munRaw = String(item.municipio || "").trim();
        const munNorm = munRaw
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toUpperCase();

        let regionId = 0;
        if (munNorm.includes("CABOS")) {
          regionId = 2;
        } else if (munNorm.includes("COMONDU") || munNorm.includes("COMODU") || munNorm.includes("LORETO")) {
          regionId = 3;
        } else if (munNorm.includes("MULEGE")) {
          regionId = 4;
        }
        if (![2, 3, 4].includes(regionId)) continue;

        const ofiRaw = String(item.oficina || "").trim();
        let resolvedOficinaId = null;
        let resolvedOficinaNombre = null;

        // 1) Match directo requerido por LIKE '%oficina%'
        const [likeRows] = await conn.query(
          `SELECT id, nombre FROM oficinas_regionales WHERE region_id = ? AND nombre LIKE ? LIMIT 1`,
          [regionId, `%${ofiRaw}%`]
        );
        if (likeRows.length) {
          resolvedOficinaId = Number(likeRows[0].id);
          resolvedOficinaNombre = likeRows[0].nombre;
        }

        // 2) Fallback de equivalencias sobre oficinas existentes (ej. "CD CONSTITUCIÓN" -> "Ciudad Constitución",
        //    "VILLA ALBERTO ALVARADO" -> "Vizcaíno"), SIN hacer INSERT en oficinas_regionales
        if (!resolvedOficinaId) {
          const ofiNorm = ofiRaw
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toUpperCase();
          let altTerm = "";
          if (ofiNorm.includes("CONSTITUCION")) altTerm = "Constituci";
          else if (ofiNorm.includes("VILLA ALBERTO") || ofiNorm.includes("ALVARADO") || ofiNorm.includes("VIZCAINO")) altTerm = "Vizca";
          else if (ofiNorm.includes("SANTA ROSALIA")) altTerm = "Santa Rosal";
          else if (ofiNorm.includes("GUERRERO NEGRO")) altTerm = "Guerrero Negro";
          else if (ofiNorm.includes("PEC")) altTerm = "PEC";
          else if (ofiNorm.includes("SADER")) altTerm = "SADER";
          else if (ofiNorm.includes("CANGREJOS")) altTerm = "Cangrejos";
          else if (ofiNorm.includes("GUAYMITAS")) altTerm = "Guaymitas";
          else if (ofiNorm.includes("LORETO")) altTerm = "Loreto";

          if (altTerm) {
            const [altRows] = await conn.query(
              `SELECT id, nombre FROM oficinas_regionales WHERE region_id = ? AND nombre LIKE ? LIMIT 1`,
              [regionId, `%${altTerm}%`]
            );
            if (altRows.length) {
              resolvedOficinaId = Number(altRows[0].id);
              resolvedOficinaNombre = altRows[0].nombre;
            }
          }
        }

        // 3) Si aún no hay coincidencia, usar la sede regional activa existente (excluyendo S/A), NUNCA crear oficina nueva
        if (!resolvedOficinaId) {
          const [defaultRows] = await conn.query(
            `SELECT id, nombre FROM oficinas_regionales
             WHERE region_id = ?
               AND nombre NOT LIKE '%S/A%'
               AND nombre NOT LIKE '%Sin Asignar%'
             ORDER BY id ASC LIMIT 1`,
            [regionId]
          );
          if (defaultRows.length) {
            resolvedOficinaId = Number(defaultRows[0].id);
            resolvedOficinaNombre = defaultRows[0].nombre;
          }
        }

        if (!resolvedOficinaId) continue;

        const marca = String(item.marca || "").trim();
        const modelo = String(item.modelo || "").trim();
        const color = String(item.color || "").trim();
        const serie = String(item.serie || "").trim();
        const placas = String(item.placas || "").trim();
        const anio = item.anio ? Number(item.anio) : null;
        const municipio = munRaw;

        const claveBien = placas;
        const descripcion = `${marca} ${modelo}`.trim();
        const marcaModelo = `${marca} ${modelo}`.trim();
        const seriePlacas = [placas, serie].filter(Boolean).join(" / ").trim();

        const detallesVehiculoObj = {
          unidad: {
            marca,
            tipo: marca,
            modelo: [modelo, anio].filter(Boolean).join(" "),
            color,
            placas,
            serie_vin: serie,
            cilindros: "",
            poliza_seguro: "",
            odometro_km: "",
            nivel_gasolina: "",
          },
          estado_general: {
            estado_mecanico: "B",
            estado_electrico: "B",
            estado_carroceria: "B",
            llanta_1: "B",
            llanta_2: "B",
            llanta_3: "B",
            llanta_4: "B",
            llanta_5: "B",
          },
          checklist: {},
        };
        const detallesJson = JSON.stringify(detallesVehiculoObj);

        // Verificar si ya existe un vehículo (rubro_id = 2) con esa misma clave_bien (placas) o serie para hacer UPSERT limpio
        const [existRows] = await conn.query(
          `SELECT id FROM inventario_oficina
           WHERE rubro_id = 2 AND (clave_bien = ? OR (serie IS NOT NULL AND serie <> '' AND serie = ?))
           ORDER BY id ASC LIMIT 1 FOR UPDATE`,
          [claveBien, serie]
        );

        if (existRows.length) {
          const existId = Number(existRows[0].id);
          await conn.query(
            `UPDATE inventario_oficina
             SET oficina_id = ?,
                 rubro_id = 2,
                 clave_bien = ?,
                 descripcion = ?,
                 marca_modelo = ?,
                 numero_serie_placas = ?,
                 marca = ?,
                 modelo = ?,
                 color = ?,
                 serie = ?,
                 numero_serie = ?,
                 placas = ?,
                 anio = ?,
                 municipio = ?,
                 unidad = 'UNIDAD',
                 cantidad_propia = 1,
                 cantidad_disponible = 1,
                 estado_fisico = 'BUENO',
                 estatus_uso = 'ACTIVO',
                 observaciones = NULL
                 ${hasDetCol ? ", detalles_vehiculo = ?" : ""}
             WHERE id = ?`,
            hasDetCol
              ? [resolvedOficinaId, claveBien, descripcion, marcaModelo, seriePlacas, marca, modelo, color, serie, serie, placas, anio, municipio, detallesJson, existId]
              : [resolvedOficinaId, claveBien, descripcion, marcaModelo, seriePlacas, marca, modelo, color, serie, serie, placas, anio, municipio, existId]
          );
          updateCount++;
        } else {
          await conn.query(
            `INSERT INTO inventario_oficina
               (oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas,
                marca, modelo, color, serie, numero_serie, placas, anio, municipio,
                unidad, cantidad_propia, cantidad_disponible, estado_fisico, estatus_uso, observaciones,
                origen_adquisicion ${hasDetCol ? ", detalles_vehiculo" : ""})
             VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNIDAD', 1, 1, 'BUENO', 'ACTIVO', NULL, 'COMPRA_DELEGACION' ${hasDetCol ? ", ?" : ""})`,
            hasDetCol
              ? [resolvedOficinaId, claveBien, descripcion, marcaModelo, seriePlacas, marca, modelo, color, serie, serie, placas, anio, municipio, detallesJson]
              : [resolvedOficinaId, claveBien, descripcion, marcaModelo, seriePlacas, marca, modelo, color, serie, serie, placas, anio, municipio]
          );
          insertCount++;
        }

        asignaciones.push({
          placas: claveBien,
          descripcion,
          region_id: regionId,
          oficina_solicitada: ofiRaw,
          oficina_id: resolvedOficinaId,
          oficina_asignada: resolvedOficinaNombre,
        });
      }

      await conn.commit();
      return res.json({
        ok: true,
        vehiculos_sa_eliminados: Number(delSaResult?.affectedRows || 0),
        vehiculos_insertados: insertCount,
        vehiculos_actualizados: updateCount,
        total_procesados: insertCount + updateCount,
        asignaciones,
        message: `Migración de vehículos foráneos de Evelia completada: ${Number(delSaResult?.affectedRows || 0)} vehículos en S/A foráneas eliminados y ${insertCount + updateCount} vehículos foráneos asignados a sus oficinas existentes (${insertCount} nuevos, ${updateCount} actualizados).`,
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error("Error en POST /api/migracion/vehiculos-foraneos-evelia:", e);
    return httpError(res, 500, e.message || "Error al migrar vehículos foráneos de Evelia");
  }
});

// ============================================================================
// UTILERÍA: LIMPIAR VEHÍCULOS S/A (SIN ASIGNAR) - EVELIA / RUBRO 2
// ============================================================================
app.post("/api/utilerias/limpiar-sa-vehiculos", authRequired, async (req, res) => {
  try {
    const uName = normalizeUser(req.user?.username);
    if (!isAdmin(req) && uName !== "evelia" && uName !== "rodrigo" && uName !== "jorge" && uName !== "jorgepatron") {
      return httpError(res, 403, "Acceso exclusivo para Administración y Encargada de Parque Vehicular.");
    }

    const [delResult] = await poolOps.query(
      `DELETE io FROM inventario_oficina io
       JOIN oficinas_regionales ofi ON io.oficina_id = ofi.id
       WHERE io.rubro_id = 2
         AND (ofi.nombre LIKE '%S/A%' OR ofi.nombre LIKE '%Sin Asignar%')
         AND io.id NOT IN (SELECT DISTINCT articulo_id FROM vales_prestamo_detalle WHERE articulo_id IS NOT NULL);`
    );

    return res.json({
      ok: true,
      eliminados: Number(delResult?.affectedRows || 0),
      message: `Se eliminaron ${Number(delResult?.affectedRows || 0)} vehículos asignados a oficinas S/A o Sin Asignar en todas las regiones.`
    });
  } catch (err) {
    console.error("Error en POST /api/utilerias/limpiar-sa-vehiculos:", err);
    return httpError(res, 500, err.message || "Error al limpiar vehículos S/A");
  }
});

// ============================================================================
// DRP: ENDPOINT DE RESPALDO MANUAL DE BASE DE DATOS
// ============================================================================
app.post("/api/admin/respaldo-manual", authRequired, async (req, res) => {
  try {
    if (!isAdmin(req) && !canViewInventarioGeneral(req.user)) {
      return httpError(res, 403, "Acceso exclusivo para administradores.");
    }
    const result = await exportDatabaseSnapshot();
    return res.json({
      ok: true,
      message: "Respaldo manual de base de datos generado exitosamente en el servidor.",
      detalles: result,
    });
  } catch (err) {
    return httpError(res, 500, err?.message || "Error al generar respaldo manual de base de datos");
  }
});

// ============================================================================
// PANEL DE INVENTARIO ESTATAL CONSOLIDADO (Exclusivo Rodrigo Molina, Jorge Patrón y Admin)
// ============================================================================
app.get("/api/inventario-estatal/consolidado", authRequired, async (req, res) => {
  try {
    if (!canViewInventarioGeneral(req.user)) {
      return httpError(res, 403, "Acceso exclusivo para Rodrigo Molina Cosio, Jorge Luis Patrón Murillo y Administración.");
    }
    const { q = "", region_id = "", rubro_id = "" } = req.query || {};
    const regId = Number(region_id || 0);
    const rubId = Number(rubro_id || 0);
    const search = String(q || "").trim();

    // 1. KPIs Globales de Todo el Estado
    const [[kpiRegional]] = await poolRead.query(`
      SELECT 
        COUNT(*) AS total_registros,
        COALESCE(SUM(cantidad_propia), 0) AS total_bienes,
        COALESCE(SUM(CASE WHEN rubro_id = 1 THEN cantidad_propia ELSE 0 END), 0) AS rubro_archivo,
        COALESCE(SUM(CASE WHEN rubro_id = 2 THEN cantidad_propia ELSE 0 END), 0) AS rubro_vehicular,
        COALESCE(SUM(CASE WHEN rubro_id = 3 THEN cantidad_propia ELSE 0 END), 0) AS rubro_mobiliario,
        COALESCE(SUM(CASE WHEN rubro_id = 4 THEN cantidad_propia ELSE 0 END), 0) AS rubro_tablets
      FROM inventario_oficina
    `);

    const [[kpiAlmacen]] = await poolRead.query(`
      SELECT 
        COUNT(*) AS total_articulos_almacen,
        COALESCE(SUM(STOCK), 0) AS total_stock_almacen
      FROM almacen_dregcivil
    `);

    const [regionesDistribucion] = await poolRead.query(`
      SELECT 
        r.id AS region_id,
        r.nombre AS region_nombre,
        COUNT(DISTINCT o.id) AS total_oficinas,
        COALESCE(SUM(io.cantidad_propia), 0) AS total_bienes
      FROM regiones r
      LEFT JOIN oficinas_regionales o ON o.region_id = r.id
      LEFT JOIN inventario_oficina io ON io.oficina_id = o.id
      GROUP BY r.id, r.nombre
      ORDER BY r.id ASC
    `);

    // 2. Consulta de Activos Consolidados con Filtros
    let whereRegional = "WHERE 1=1";
    const paramsRegional = [];
    if (regId > 0) {
      whereRegional += " AND o.region_id = ?";
      paramsRegional.push(regId);
    }
    if (rubId > 0) {
      whereRegional += " AND io.rubro_id = ?";
      paramsRegional.push(rubId);
    }
    if (search) {
      whereRegional += " AND (io.clave_bien LIKE ? OR io.descripcion LIKE ? OR io.marca_modelo LIKE ? OR io.numero_serie_placas LIKE ? OR o.nombre LIKE ? OR r.nombre LIKE ?)";
      const lk = `%${search}%`;
      paramsRegional.push(lk, lk, lk, lk, lk, lk);
    }

    const hasDetCol = await ensureDetallesVehiculoCol();
    const [activosRows] = await poolRead.query(`
      SELECT 
        io.id,
        io.clave_bien,
        io.descripcion,
        io.marca_modelo,
        io.numero_serie_placas,
        io.unidad,
        io.cantidad_propia,
        io.estado_fisico,
        io.estatus_uso,
        io.observaciones,
        io.origen_adquisicion,
        ${hasDetCol ? "io.detalles_vehiculo" : "NULL AS detalles_vehiculo"},
        r.id AS region_id,
        r.nombre AS region_nombre,
        o.id AS oficina_id,
        o.nombre AS oficina_nombre,
        o.municipio,
        ru.id AS rubro_id,
        ru.codigo AS rubro_codigo,
        ru.nombre_rubro,
        ru.encargado_nombre
      FROM inventario_oficina io
      INNER JOIN oficinas_regionales o ON o.id = io.oficina_id
      INNER JOIN regiones r ON r.id = o.region_id
      LEFT JOIN rubros_inventario ru ON ru.id = io.rubro_id
      ${whereRegional}
      ORDER BY r.id ASC, o.nombre ASC, io.clave_bien ASC
    `, paramsRegional);

    return res.json({
      ok: true,
      kpis: {
        total_bienes_estatales: Number(kpiRegional?.total_bienes || 0),
        total_vehicular: Number(kpiRegional?.rubro_vehicular || 0),
        total_mobiliario: Number(kpiRegional?.rubro_mobiliario || 0),
        total_tablets: Number(kpiRegional?.rubro_tablets || 0),
        total_archivo_materiales: Number(kpiRegional?.rubro_archivo || 0),
        almacen_general_stock: Number(kpiAlmacen?.total_stock_almacen || 0),
        almacen_general_articulos: Number(kpiAlmacen?.total_articulos_almacen || 0),
        distribucion_regiones: regionesDistribucion
      },
      data: activosRows.map(r => ({
        ...r,
        detalles_vehiculo: parseDetallesVehiculo(r.detalles_vehiculo)
      }))
    });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

const STATIC_DIR = path.join(__dirname, "public");
app.use(
  express.static(STATIC_DIR, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    },
  })
);
app.get("/__ping", (req, res) => res.send("OK"));

// Cualquier ruta /api no encontrada responde en JSON (nunca HTML crudo "Cannot POST ...")
app.use("/api", (req, res) => {
  return httpError(res, 404, `Ruta de API no encontrada: ${req.method} ${req.originalUrl.split("?")[0]}`);
});

// Manejador global de errores: siempre JSON para /api
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err?.statusCode || err?.status) || 500;
  if (String(req.originalUrl || "").startsWith("/api")) {
    return httpError(res, status, err?.message || "Error interno del servidor");
  }
  return res.status(status).send(err?.message || "Error interno del servidor");
});

const DEFAULT_PORT = Number(process.env.PORT) || 8080;

function startOnce(port) {
return new Promise((resolve, reject) => {
const server = app.listen(port, '0.0.0.0', async () => {
  try {
    ensureBackupDirectories();
    await detectProductosPK();
    await detectProductosStatusCol();
    await detectAlmacenStatusCol();
    await ensureDetallesVehiculoCol();
    await ensureSchemaAndUsers();
    // DRP: Snapshot inicial de la base de datos para recuperación ante desastres
    exportDatabaseSnapshot().catch((err) => console.warn("[WARN] Snapshot inicial BD:", err?.message || err));
    // Si inventario_oficina está vacío y existe seed_pruebas.sql, poblar datos de prueba automáticamente
    const [[invCount]] = await poolRead.query(`SELECT COUNT(*) AS n FROM inventario_oficina`).catch(() => [[{ n: 1 }]]);
    if (Number(invCount?.n || 0) === 0) {
      const { runSeedPruebas } = require("./seed-pruebas");
      await runSeedPruebas().catch((err) => console.warn("[WARN] Auto-seed pruebas:", err?.message || err));
    }
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

// DRP: Programar respaldo periódico de la base de datos cada 12 horas
setInterval(() => {
  exportDatabaseSnapshot().catch((err) => console.warn("[WARN] Respaldo automático BD (12h):", err?.message || err));
}, 12 * 60 * 60 * 1000);

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
