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
const ExcelJS = require("exceljs");
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
    "inventario_tabletas",
    "movimientos_tabletas",
    "bitacora_tabletas",
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

// ============================================================================
// v53: RESPALDO AUTOMÁTICO DE BD EN './respaldos_sistema' AL CAMBIAR DE VERSIÓN
// ============================================================================
async function crearRespaldoAutomaticoBD(versionAnterior, nuevaVersion) {
  try {
    const backupDir = path.join(__dirname, "respaldos_sistema");
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const vAntClean = String(versionAnterior || "0").replace(/[^\w.-]+/g, "_");
    const vNueClean = String(nuevaVersion || "53").replace(/[^\w.-]+/g, "_");
    const filename = `backup_v${vAntClean}_to_v${vNueClean}_${timestamp}.json`;
    const filePath = path.join(backupDir, filename);

    const targetTables = [
      "inventario_oficina",
      "almacen_dregcivil",
      "vales_prestamo",
      "vales_prestamo_detalle",
      "pedidos_almacen",
      "solicitudes",
      "detalles_solicitud",
      "solicitudes_detalle",
      "bitacora_movimientos",
      "oficinas",
      "oficinas_regionales",
      "oficialias",
      "usuario",
      "usuarios",
      "regiones",
      "rubros_inventario",
      "productos",
      "sistema_metadata",
      "configuracion_sistema",
      "inventario_tabletas",
      "movimientos_tabletas",
      "bitacora_tabletas"
    ];

    let existingTables = new Set();
    try {
      const [tRows] = await poolRead.query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?`,
        [DB_NAME]
      );
      existingTables = new Set(tRows.map((t) => String(t.TABLE_NAME || "").toLowerCase()));
    } catch (err) {
      console.warn("[WARN] crearRespaldoAutomaticoBD leyendo tablas:", err?.message || err);
    }

    const backupData = {
      metadata: {
        sistema: "Delegación BCS - Control de Inventario",
        tipo: "Respaldo Automático por Cambio de Versión",
        version_anterior: String(versionAnterior || "0"),
        version_nueva: String(nuevaVersion),
        fecha_iso: now.toISOString(),
        timestamp,
        database: DB_NAME,
        tablas_respaldadas: [],
        total_registros: 0
      },
      tables: {}
    };

    for (const tbl of targetTables) {
      if (existingTables.size > 0 && !existingTables.has(tbl.toLowerCase())) {
        continue;
      }
      try {
        const [rows] = await poolRead.query(`SELECT * FROM ${qi(tbl)}`);
        backupData.tables[tbl] = rows;
        backupData.metadata.tablas_respaldadas.push(tbl);
        backupData.metadata.total_registros += rows.length;
      } catch (_) {
        // Omitir si la tabla no existe o no tiene permiso
      }
    }

    fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2), "utf8");
    console.log(`[DRP-v53] Respaldo automático por cambio de versión generado: ${filename} (${backupData.metadata.total_registros} registros)`);
    return { ok: true, filename, filePath, metadata: backupData.metadata };
  } catch (err) {
    console.error("[ERROR] crearRespaldoAutomaticoBD:", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function isModoPruebaGrupalActivo() {
  return false;
}

function canDownloadSolicitudPdf(req) {
  if (!req?.user) return false;
  if (isAdmin(req)) return true;
  const uname = normalizeUser(req.user.username);
  if (["gabrielfiol", "fiol", "encargado", "jorge", "jorgepatron"].includes(uname)) return true;
  return false;
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
    departamento: "Encargado de Archivos y Materiales",
    cargo: "Encargado de Archivos y Materiales",
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
    cargo: "Encargado de Almacén",
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
    departamento: "Encargado de Archivos y Materiales",
    cargo: "Encargado de Archivos y Materiales",
    rubro_id: 1, // ARCHIVO_MATERIALES
    canAlmacen: true,
  },
};

function getUserRubroId(userOrReq) {
  const u = userOrReq?.user ? userOrReq.user : userOrReq;
  if (!u) return null;
  const uname = normalizeUser(u.username);
  if (uname === "admin" || String(u.rol || "").toUpperCase() === "ADMIN") return null;
  if (["luismayoral", "luiseduardo", "luis"].includes(uname)) return 4;
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
  if (u === 'evelia' || u === 'jesus' || u === 'luiseduardo' || u === 'luismayoral' || u === 'luis') return 'ENCARGADO';
  const up = String(r || '').trim().toUpperCase();
  if (up === 'ADMIN' || up === 'ADMINISTRADOR' || up === 'ADMINISTRACION') return 'ADMIN';
  if (up === 'ENCARGADO' || up === 'ENCARGADO DE INVENTARIO' || up === 'ENCARGADO DE ARCHIVOS Y MATERIALES' || up === 'ENCARGADO_REGIONAL') return 'ENCARGADO';
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

function isLuisMayoralUser(userOrReq) {
  const u = userOrReq?.user ? userOrReq.user : userOrReq;
  if (!u) return false;
  if (isAdmin({ user: u })) return false;
  const uname = normalizeUser(u.username);
  if (['luismayoral', 'luiseduardo', 'luis'].includes(uname)) return true;
  const rubId = Number(u.rubro_id || 0);
  return rubId === 4;
}

function isRegionalFullAccess(userOrReq) {
  const u = userOrReq?.user ? userOrReq.user : userOrReq;
  if (!u) return false;
  const uname = normalizeUser(u.username);
  if (uname === 'gabrielfiol' || uname === 'encargado') return false;
  if (isLuisMayoralUser(u)) return false;
  if (isAdmin({ user: u }) || ['admin', 'rodrigo', 'jorge', 'jorgepatron'].includes(uname)) return true;
  if (['evelia', 'jesus'].includes(uname)) return true;
  const rubId = Number(u.rubro_id || 0);
  if ([2, 3].includes(rubId)) return true;
  return false;
}

function isRegionalEnlace(userOrReq) {
  const u = userOrReq?.user ? userOrReq.user : userOrReq;
  if (!u) return false;
  if (isLuisMayoralUser(u)) return false;
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
  if (isLuisMayoralUser(req)) return false;
  return isRegionalFullAccess(req) || isRegionalEnlace(req);
}

function canEditRegional(req) {
  return isRegionalFullAccess(req);
}

function canGeneratePdfRegional(req) {
  return isRegionalFullAccess(req);
}

function isAuditorBlockedUser(req) {
  const u = normalizeUser(req?.user?.username || req?.username || '');
  return ['rodrigo', 'jorge', 'jorgepatron'].includes(u);
}

function canUseCuatroFirmas(userOrReq) {
  const u = userOrReq?.user ? userOrReq.user : userOrReq;
  if (!u) return false;
  const uname = normalizeUser(u.username);
  const role = String(u.rol || u.role || '').toUpperCase();
  if (role === 'ADMIN' || ['admin', 'rodrigo', 'jorge', 'jorgepatron'].includes(uname)) return true;
  if (role === 'ENCARGADO') return true;
  if (['jesus', 'luismayoral', 'luiseduardo', 'luis', 'gabrielfiol', 'fiol', 'encargado', 'evelia'].includes(uname)) return true;
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
  if (isAuditorBlockedUser(req)) return false;
  // Admin y Gabriel Fiol (Encargado de Almacén) pueden gestionar/surtir vales de todos
  return isAdmin(req) || isEncargado(req);
}

function canViewReportes(req) {
  // Gabriel Fiol no debe tener acceso a herramientas de análisis global (reportes y gráficas)
  const u = normalizeUser(req?.user?.username || req?.username);
  if (u === "gabrielfiol" || u === "fiol") return false;
  return isAdmin(req);
}

function canViewTabletas(userOrReq) {
  const u = userOrReq?.user ? userOrReq.user : userOrReq;
  if (!u) return false;
  const uname = normalizeUser(u.username);
  const role = String(u.rol || u.role || "").trim().toUpperCase();
  const fullName = [u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO, u.primer_ap, u.segundo_ap, u.nombre_completo]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  // Gabriel Fiol y demás encargados/usuarios generales NO tienen acceso a Tabletas Digitales
  if (uname === "gabrielfiol" || uname === "fiol" || uname === "encargado" || fullName.includes("fiol")) {
    return false;
  }

  // 1. Admin: Acceso total
  if (role === "ADMIN" || uname === "admin") return true;

  // 2. Luis Eduardo Mayoral Geraldo: Acceso operativo completo
  if (
    ["luiseduardo", "luismayoral"].includes(uname) ||
    fullName.includes("luis eduardo") ||
    fullName.includes("mayoral geraldo")
  ) {
    return true;
  }

  // 3. Jorge Patrón y Rodrigo Molina: Acceso estrictamente de solo lectura
  if (
    ["jorge", "jorgepatron", "rodrigo"].includes(uname) ||
    fullName.includes("jorge luis patron") ||
    fullName.includes("rodrigo molina")
  ) {
    return true;
  }

  return false;
}

function canAccessTabletas(req) {
  return canViewTabletas(req);
}

function canEditTabletas(userOrReq) {
  const u = userOrReq?.user ? userOrReq.user : userOrReq;
  if (!u) return false;
  const uname = normalizeUser(u.username);
  const role = String(u.rol || u.role || "").trim().toUpperCase();
  const fullName = [u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO, u.primer_ap, u.segundo_ap, u.nombre_completo]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (uname === "gabrielfiol" || uname === "fiol" || uname === "encargado" || fullName.includes("fiol")) {
    return false;
  }
  if (["jorge", "jorgepatron", "rodrigo"].includes(uname)) {
    return false;
  }

  // 1. Admin
  if (role === "ADMIN" || uname === "admin") return true;

  // 2. Luis Eduardo Mayoral Geraldo
  if (
    ["luiseduardo", "luismayoral"].includes(uname) ||
    fullName.includes("luis eduardo") ||
    fullName.includes("mayoral geraldo")
  ) {
    return true;
  }

  return false;
}

// ============================================================================
// Helpers de Firma Digital Remota y Evidencia Fotográfica (Tabletas Digitales)
// ============================================================================
function getRegionalSignatureScope(userOrReq) {
  const u = userOrReq?.user ? userOrReq.user : userOrReq;
  if (!u) return null;
  const uname = normalizeUser(u.username);
  if (uname === "loscabos") return "LOS CABOS";
  if (uname === "mulege") return "MULEGE";
  if (uname === "comondu") return "COMONDU";
  return null;
}

function normalizeTabletaForaneaRegion(regionStr) {
  if (!regionStr) return null;
  const normStr = String(regionStr)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!normStr) return null;
  if (normStr === "LA PAZ" || normStr.includes("LA PAZ") || normStr === "DELEGACION" || normStr === "PAM" || normStr === "PCD") {
    return null;
  }
  if (normStr === "LOS CABOS" || normStr.includes("LOS CABOS") || normStr.includes("CABOS")) {
    return "LOS CABOS";
  }
  if (normStr === "MULEGE" || normStr.includes("MULEGE") || normStr.includes("GUERRERO")) {
    return "MULEGE";
  }
  if (normStr === "COMONDU" || normStr.includes("COMONDU") || normStr.includes("LORETO")) {
    return "COMONDU";
  }
  return null;
}

const TABLETAS_EVIDENCIAS_DIR = path.join(__dirname, "uploads", "tabletas_evidencias");
try {
  fs.mkdirSync(TABLETAS_EVIDENCIAS_DIR, { recursive: true });
} catch (errMkEv) {
  console.warn("[WARN] No se pudo crear directorio de evidencias de tabletas:", errMkEv?.message || errMkEv);
}

const TABLETAS_EVIDENCIA_FIELDS = new Set(["foto_ine_frente", "foto_ine_reverso", "foto_entrega"]);
const TABLETAS_EVIDENCIA_ALLOWED_MIMES = new Map([
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);
const TABLETAS_EVIDENCIA_ALLOWED_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const TABLETAS_EVIDENCIA_MAX_BYTES = 3 * 1024 * 1024; // 3 MB por fotografía

function detectImageMagicFormat(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

function cleanupTabletaEvidenciaFiles(filesObj) {
  if (!filesObj || typeof filesObj !== "object") return;
  for (const key of Object.keys(filesObj)) {
    const arr = Array.isArray(filesObj[key]) ? filesObj[key] : [filesObj[key]];
    for (const f of arr) {
      if (f && f.path) {
        try {
          if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        } catch {}
      }
    }
  }
}

async function uploadTabletaEvidenciasMiddleware(req, res, next) {
  const ctype = String(req.headers["content-type"] || "");
  if (!/^multipart\/form-data/i.test(ctype)) {
    req.files = {};
    return next();
  }

  const boundaryMatch = ctype.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (!boundaryMatch) {
    return httpError(res, 400, "Encabezado multipart/form-data sin boundary válido.");
  }
  const boundaryStr = (boundaryMatch[1] || boundaryMatch[2] || "").trim();
  const savedFiles = {};
  const fields = {};

  try {
    fs.mkdirSync(TABLETAS_EVIDENCIAS_DIR, { recursive: true });
    const chunks = [];
    let totalBytes = 0;
    const maxBodyBytes = 12 * 1024 * 1024; // 12 MB máximo total para las 3 fotos + formulario

    for await (const chunk of req) {
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        return httpError(res, 400, "El tamaño total de los archivos supera el límite permitido.");
      }
      chunks.push(chunk);
    }

    const bodyBuf = Buffer.concat(chunks);
    const boundaryBuf = Buffer.from(`--${boundaryStr}`);
    const safeTabId = String(Number(req.params?.id || 0) || "0").replace(/[^0-9]/g, "");

    let pos = bodyBuf.indexOf(boundaryBuf);
    while (pos !== -1) {
      const partStart = pos + boundaryBuf.length;
      if (partStart + 2 <= bodyBuf.length && bodyBuf.subarray(partStart, partStart + 2).toString("ascii") === "--") {
        break;
      }
      const nextPos = bodyBuf.indexOf(boundaryBuf, partStart);
      if (nextPos === -1) break;

      // Saltar CRLF inicial después del boundary
      let headerStart = partStart;
      if (bodyBuf[headerStart] === 0x0d && bodyBuf[headerStart + 1] === 0x0a) {
        headerStart += 2;
      }
      const headerEnd = bodyBuf.indexOf(Buffer.from("\r\n\r\n"), headerStart);
      if (headerEnd === -1 || headerEnd >= nextPos) {
        pos = nextPos;
        continue;
      }

      const headerText = bodyBuf.subarray(headerStart, headerEnd).toString("utf8");
      const contentStart = headerEnd + 4;
      let contentEnd = nextPos;
      if (contentEnd >= 2 && bodyBuf[contentEnd - 2] === 0x0d && bodyBuf[contentEnd - 1] === 0x0a) {
        contentEnd -= 2;
      }
      const partData = bodyBuf.subarray(contentStart, Math.max(contentStart, contentEnd));

      const dispLine = headerText.split(/\r\n/).find((l) => /^content-disposition:/i.test(l)) || "";
      const nameMatch = dispLine.match(/name="([^"]+)"/i);
      const fieldName = nameMatch ? nameMatch[1].trim() : "";
      const filenameMatch = dispLine.match(/filename="([^"]*)"/i);

      if (fieldName) {
        if (filenameMatch) {
          const rawFilename = path.basename(filenameMatch[1] || "");
          if (TABLETAS_EVIDENCIA_FIELDS.has(fieldName) && partData.length > 0) {
            if (partData.length > TABLETAS_EVIDENCIA_MAX_BYTES) {
              cleanupTabletaEvidenciaFiles(savedFiles);
              return httpError(res, 400, `La fotografía (${fieldName}) excede el límite máximo de 3 MB.`);
            }
            const ctLine = headerText.split(/\r\n/).find((l) => /^content-type:/i.test(l)) || "";
            const mime = ctLine.replace(/^content-type:\s*/i, "").split(";")[0].trim().toLowerCase();
            if (!TABLETAS_EVIDENCIA_ALLOWED_MIMES.has(mime)) {
              cleanupTabletaEvidenciaFiles(savedFiles);
              return httpError(res, 400, "Formato de imagen no permitido. Solo se aceptan archivos JPEG, PNG o WEBP.");
            }
            const magic = detectImageMagicFormat(partData);
            if (!magic) {
              cleanupTabletaEvidenciaFiles(savedFiles);
              return httpError(res, 400, "El archivo subido no corresponde a una imagen válida (JPEG, PNG o WEBP).");
            }
            const rawExt = path.extname(rawFilename).toLowerCase();
            const cleanExt = TABLETAS_EVIDENCIA_ALLOWED_EXTS.has(rawExt)
              ? rawExt
              : TABLETAS_EVIDENCIA_ALLOWED_MIMES.get(mime);
            const uniqueName = path.basename(
              `tab_${safeTabId}_${fieldName}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${cleanExt}`
            );
            const destPath = path.join(TABLETAS_EVIDENCIAS_DIR, uniqueName);
            fs.writeFileSync(destPath, partData);
            savedFiles[fieldName] = [{ filename: uniqueName, path: destPath, mimetype: mime, size: partData.length }];
          }
        } else {
          fields[fieldName] = partData.toString("utf8");
        }
      }

      pos = nextPos;
    }

    req.body = { ...(req.body && typeof req.body === "object" ? req.body : {}), ...fields };
    req.files = savedFiles;
    return next();
  } catch (errUp) {
    cleanupTabletaEvidenciaFiles(savedFiles);
    return httpError(res, 400, errUp?.message || "Error al procesar las fotografías adjuntas.");
  }
}

function buildCleanFullName(nombre, ap1, ap2) {
  const n = String(nombre || "").trim();
  const a1 = String(ap1 || "").trim();
  const a2 = String(ap2 || "").trim();
  if (!n) return [a1, a2].filter(Boolean).join(" ").trim();
  const normCmp = (s) =>
    String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  const nNorm = normCmp(n);
  const parts = [n];
  if (a1 && !nNorm.includes(normCmp(a1))) parts.push(a1);
  if (a2 && !nNorm.includes(normCmp(a2))) parts.push(a2);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Matriz de permisos (Reunión 29/10/26)
// ---------------------------------------------------------------------------
// Regiones foráneas (fuera de la Delegación Central de La Paz) habilitadas para firma digital
const REGIONES_FORANEAS = new Set(["LOS_CABOS", "MULEGE", "COMONDU_LORETO"]);

// Usuarios regionales de ejemplo (contraseña inicial: secreta123)
const REGIONAL_ENLACES_EJEMPLO = [
  { username: "loscabos", nombre: "Samir Savin Ruiz", region_clave: "LOS_CABOS", id_oficialia: 30030009, oficialia_nombre: "Enlace Regional Los Cabos" },
  { username: "mulege", nombre: "Diana Ramírez Hernández", region_clave: "MULEGE", id_oficialia: 30030010, oficialia_nombre: "Enlace Regional Mulegé" },
  { username: "comondu", nombre: "Humberto Arce Cordero", region_clave: "COMONDU_LORETO", id_oficialia: 30030011, oficialia_nombre: "Enlace Regional Comondú / Loreto" },
];

// Inventario Regional: canEditRegional definido arriba según matriz estricta (admin y encargados rubro regional)

// Órdenes de material: solo admin y Gabriel Fiol (encargado de almacén) ven TODAS las órdenes
function canSeeAllSolicitudes(req) {
  return isAdmin(req) || isEncargado(req);
}

// Selección de departamento en Nueva Solicitud y Listado: solo admin (Gabriel Fiol solo solicita bajo su propia área)
function canSelectAnyDepartment(req) {
  const uname = normalizeUser(req?.user?.username || req?.username || "");
  if (uname === "gabrielfiol" || uname === "fiol" || uname === "encargado") return false;
  return isAdmin(req);
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
  const baseStatuses = [
    "PENDIENTE",
    "EN_PROCESO",
    "PARA_FIRMAS",
    "COMPLETADA",
    "APROBADA",
    "SURTIDA",
    "ENTREGADA",
    "RECHAZADA",
    "CANCELADA",
    "CANCELADO"
  ];
  if (STATUS_ENUM_CACHE) return STATUS_ENUM_CACHE;
  try {
    const [rows] = await poolRead.query(
      `SELECT COLUMN_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME = 'solicitudes'
         AND COLUMN_NAME = 'status'
       LIMIT 1`,
      [DB_NAME]
    );
    if (rows.length) {
      const m = rows[0].COLUMN_TYPE.match(/enum\((.*)\)/i);
      if (m && m[1]) {
        const vals = m[1].split(",").map((s) => s.trim().replace(/^'/, "").replace(/'$/, ""));
        for (const v of vals) {
          if (v && !baseStatuses.includes(v)) baseStatuses.push(v);
        }
      }
    }
  } catch (_) {}
  STATUS_ENUM_CACHE = baseStatuses;
  return STATUS_ENUM_CACHE;
}
async function normalizeStatus(input) {
  if (input == null) return null;
  const enums = await getStatusEnum();
  const raw = String(input).trim().toUpperCase().replace(/\s+/g, "_");
  const aliasMap = {
    ACEPTADA: "EN_PROCESO",
    EN_PROCESO: "EN_PROCESO",
    PROCESO: "EN_PROCESO",
    PARA_FIRMAS: "PARA_FIRMAS",
    LISTO_FIRMAS: "PARA_FIRMAS",
    FIRMAS: "PARA_FIRMAS",
    COMPLETADA: "COMPLETADA",
    COMPLETADO: "COMPLETADA",
    ENTREGADA: "COMPLETADA",
    ENTREGADO: "COMPLETADA",
    SURTIDO: "SURTIDA",
    CANCELADO: "CANCELADA"
  };
  const mapped = aliasMap[raw] || raw;
  if (enums.includes(mapped)) return mapped;
  const c = canon(mapped);
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

async function getCategoriasNameMap() {
  const map = new Map();
  try {
    const meta = await detectCategorias();
    if (!meta.table || !meta.id || !meta.name) return map;
    const [rows] = await poolRead.query(
      `SELECT ${qi(meta.id)} AS id, ${qi(meta.name)} AS nombre FROM ${qi(meta.table)}`
    );
    for (const r of rows) {
      const idNum = Number(r.id);
      const nom = String(r.nombre || "").trim();
      if (Number.isFinite(idNum) && nom) map.set(idNum, nom);
    }
  } catch (_) {}
  return map;
}

function resolveCategoriaTexto(rawVal, catName, catMap) {
  const nom = String(catName || "").trim();
  if (nom && !/^\d+$/.test(nom)) return nom;
  const raw = String(rawVal ?? "").trim();
  if (!raw) return "GENERAL";
  if (/^\d+$/.test(raw)) {
    const mapped = catMap instanceof Map ? catMap.get(Number(raw)) : "";
    return mapped ? String(mapped).trim() : "GENERAL";
  }
  return raw;
}

function isAssetInSiniestro(row) {
  if (!row || typeof row !== "object") return false;
  const normTxt = (v) =>
    String(v || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase();
  const detTxt =
    row.detalles_vehiculo && typeof row.detalles_vehiculo === "object"
      ? JSON.stringify(row.detalles_vehiculo)
      : String(row.detalles_vehiculo || "");
  const combined = normTxt(
    [row.estatus_uso, row.estado_fisico, row.estado_salida, row.observaciones, row.observaciones_control, detTxt].join(" ")
  );
  return combined.includes("SINIESTRO") || combined.includes("ASEGURADORA") || combined.includes("NO DISPONIBLE");
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

const CATALOGO_LAPAZ_JESUS = [
  { clave: "MOB-001", descripcion: "Sillas grises", aliases: ["sillas grises", "sillas"], total_lapaz: 262, sandra_def: 81, rm_def: 181 },
  { clave: "MOB-002", descripcion: "Mesas grandes", aliases: ["mesas grandes"], total_lapaz: 70, sandra_def: 10, rm_def: 60 },
  { clave: "MOB-003", descripcion: "Sillas negras", aliases: ["sillas negras"], total_lapaz: 21, sandra_def: 0, rm_def: 21 },
  { clave: "MOB-004", descripcion: "Mesas chicas", aliases: ["mesas chicas"], total_lapaz: 8, sandra_def: 3, rm_def: 5 },
  { clave: "MOB-005", descripcion: "Abanicos grandes", aliases: ["abanicos grandes", "abanico grande", "abanico"], total_lapaz: 5, sandra_def: 4, rm_def: 1 },
  { clave: "MOB-006", descripcion: "Abanicos chicos", aliases: ["abanicos chicos", "abanico chico"], total_lapaz: 6, sandra_def: 0, rm_def: 6 },
  { clave: "MOB-007", descripcion: "Coolers", aliases: ["coolers", "cooler"], total_lapaz: 6, sandra_def: 0, rm_def: 6 },
  { clave: "MOB-008", descripcion: "Carpas 3x3", aliases: ["carpas 3x3", "carpa 3x3", "toldo"], total_lapaz: 3, sandra_def: 1, rm_def: 2 },
  { clave: "MOB-009", descripcion: "Carpas 6x4", aliases: ["carpas 6x4", "carpa 6x4"], total_lapaz: 3, sandra_def: 0, rm_def: 3 },
  { clave: "MOB-010", descripcion: "Hieleras", aliases: ["hieleras", "hielera"], total_lapaz: 12, sandra_def: 0, rm_def: 12 },
  { clave: "MOB-011", descripcion: "Sillas periqueras", aliases: ["sillas periqueras", "silla periquera"], total_lapaz: 6, sandra_def: 0, rm_def: 6 },
  { clave: "MOB-012", descripcion: "Mesas periqueras", aliases: ["mesas periqueras", "mesa periquera"], total_lapaz: 2, sandra_def: 0, rm_def: 2 },
  { clave: "MOB-013", descripcion: "Salas lounge", aliases: ["salas lounge", "sala lounge"], total_lapaz: 2, sandra_def: 0, rm_def: 2 },
  { clave: "MOB-014", descripcion: "Mesas de centro", aliases: ["mesas de centro", "mesa de centro"], total_lapaz: 2, sandra_def: 0, rm_def: 2 },
  { clave: "MOB-015", descripcion: "Atril", aliases: ["atril"], total_lapaz: 1, sandra_def: 0, rm_def: 1 },
  { clave: "MOB-016", descripcion: "Planta de luz", aliases: ["planta de luz", "generador"], total_lapaz: 1, sandra_def: 0, rm_def: 1 },
  { clave: "MOB-017", descripcion: "Extensiones eléctricas", aliases: ["extensiones electricas", "extension electrica", "extensiones"], total_lapaz: 8, sandra_def: 0, rm_def: 8 },
  { clave: "MOB-018", descripcion: "Bocinas con tripié", aliases: ["bocinas con tripie", "bocinas", "bocina con tripie"], total_lapaz: 2, sandra_def: 0, rm_def: 2 },
  { clave: "MOB-019", descripcion: "Micrófonos inalámbricos", aliases: ["microfonos inalambricos", "microfono inalambrico", "microfonos"], total_lapaz: 2, sandra_def: 0, rm_def: 2 },
  { clave: "MOB-020", descripcion: "Cafeteras grandes", aliases: ["cafeteras grandes", "cafetera grande", "cafeteras"], total_lapaz: 3, sandra_def: 0, rm_def: 3 },
  { clave: "MOB-021", descripcion: "Archivero", aliases: ["archivero", "archiveros"], total_lapaz: 2, sandra_def: 1, rm_def: 1 },
  { clave: "MOB-022", descripcion: "Diablito", aliases: ["diablito", "diablo"], total_lapaz: 4, sandra_def: 1, rm_def: 3 },
];

function normalizeMobText(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeMobClave(claveRaw, descRaw) {
  const c = String(claveRaw || "").trim().toUpperCase();
  if (c) return c;
  const dNorm = normalizeMobText(descRaw);
  if (dNorm) {
    for (const item of CATALOGO_LAPAZ_JESUS) {
      if (normalizeMobText(item.descripcion) === dNorm || item.aliases.some((a) => normalizeMobText(a) === dNorm)) {
        return item.clave;
      }
    }
  }
  return String(descRaw || "").trim().toUpperCase();
}

// ============================================================================
// LÓGICA DUAL DE INVENTARIO Y RECÁLCULO ESTRICTO POR ID ÚNICO
// - Nunca altera cantidad_propia ni fusiona/agrupa registros con códigos o IDs distintos.
// - Lógica 1 (Préstamos - Jesús [Rubro 3], Evelia [Rubro 2], Luis [Rubro 4]): Modelo de Reserva.
//   Descuenta mediante subconsulta correlacionada estrictamente por ID único (io.id / t.id)
//   los renglones de vales activos NOT IN ('DEVUELTO', 'CANCELADO', 'RECHAZADO').
// - Lógica 2 (Almacén General - Fiol / encargados): Modelo Físico Estricto.
//   SOLO se descuentan solicitudes en estatus final de entrega.
// ============================================================================
async function repararInventarioBodegaDelegacionRM(poolOrConn = poolOps, options = {}) {
  if (!poolOrConn) return { ok: false, error: "Sin conexión a BD" };
  const isPool = typeof poolOrConn.getConnection === "function";
  const conn = isPool ? await poolOrConn.getConnection() : poolOrConn;
  try {
    if (isPool) await conn.beginTransaction();

    // 1a. Rubros 2 y 3 (Evelia - Parque Vehicular, Jesús - Mobiliario):
    // Subconsulta correlacionada ESTRICTAMENTE por io.id (nunca por nombre ni código repetido), sin JOINs duplicadores
    await conn.query(
      `UPDATE inventario_oficina io
       SET
         io.cantidad_prestada_enviada = COALESCE((
           SELECT SUM(COALESCE(vpd.cantidad, 0))
           FROM vales_prestamo_detalle vpd
           WHERE vpd.articulo_id = io.id
             AND COALESCE(vpd.estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')
             AND vpd.vale_id IN (
               SELECT vp.id
               FROM vales_prestamo vp
               WHERE vp.estado NOT IN ('DEVUELTO', 'CANCELADO', 'RECHAZADO')
             )
         ), 0),
         io.cantidad_disponible = GREATEST(
           0,
           CAST(COALESCE(io.cantidad_propia, 0) AS SIGNED) - COALESCE((
             SELECT SUM(COALESCE(vpd.cantidad, 0))
             FROM vales_prestamo_detalle vpd
             WHERE vpd.articulo_id = io.id
               AND COALESCE(vpd.estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')
               AND vpd.vale_id IN (
                 SELECT vp.id
                 FROM vales_prestamo vp
                 WHERE vp.estado NOT IN ('DEVUELTO', 'CANCELADO', 'RECHAZADO')
               )
           ), 0)
         ),
         io.estatus_uso = CASE
           WHEN io.estatus_uso IN ('BAJA', 'SINIESTRO / EN ASEGURADORA', 'NO DISPONIBLE (SINIESTRO)', 'EN_REPARACION') THEN io.estatus_uso
           WHEN COALESCE(io.cantidad_propia, 0) > 0
            AND (
              CAST(COALESCE(io.cantidad_propia, 0) AS SIGNED) - COALESCE((
                SELECT SUM(COALESCE(vpd.cantidad, 0))
                FROM vales_prestamo_detalle vpd
                WHERE vpd.articulo_id = io.id
                  AND COALESCE(vpd.estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')
                  AND vpd.vale_id IN (
                    SELECT vp.id
                    FROM vales_prestamo vp
                    WHERE vp.estado NOT IN ('DEVUELTO', 'CANCELADO', 'RECHAZADO')
                  )
              ), 0)
            ) <= 0
            AND COALESCE((
              SELECT SUM(COALESCE(vpd.cantidad, 0))
              FROM vales_prestamo_detalle vpd
              WHERE vpd.articulo_id = io.id
                AND COALESCE(vpd.estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')
                AND vpd.vale_id IN (
                  SELECT vp.id
                  FROM vales_prestamo vp
                  WHERE vp.estado NOT IN ('DEVUELTO', 'CANCELADO', 'RECHAZADO')
                )
            ), 0) > 0 THEN 'PRESTADO'
           WHEN UPPER(COALESCE(io.estatus_uso, '')) = 'PRESTADO' THEN 'ACTIVO'
           ELSE io.estatus_uso
         END
       WHERE io.rubro_id IN (2, 3)`
    );

    // 1b. Rubro 4 (Luis - Tabletas): Recálculo estricto por ID único (t.id)
    await conn.query(
      `UPDATE inventario_tabletas t
       SET
         t.nombre_resguardante = CASE
           WHEN t.estado_asignacion = 'EN_PRESTAMO_PROVISIONAL'
            AND NOT EXISTS (
              SELECT 1
              FROM vales_prestamo_detalle vpd
              WHERE (vpd.tableta_id = t.id OR vpd.articulo_id = t.id)
                AND COALESCE(vpd.estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')
                AND vpd.vale_id IN (
                  SELECT vp.id
                  FROM vales_prestamo vp
                  WHERE vp.rubro_id = 4 AND vp.estado NOT IN ('DEVUELTO', 'CANCELADO', 'RECHAZADO')
                )
            ) THEN ''
           ELSE t.nombre_resguardante
         END,
         t.estado_asignacion = CASE
           WHEN EXISTS (
             SELECT 1
             FROM vales_prestamo_detalle vpd
             WHERE (vpd.tableta_id = t.id OR vpd.articulo_id = t.id)
               AND COALESCE(vpd.estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')
               AND vpd.vale_id IN (
                 SELECT vp.id
                 FROM vales_prestamo vp
                 WHERE vp.rubro_id = 4 AND vp.estado NOT IN ('DEVUELTO', 'CANCELADO', 'RECHAZADO')
               )
           ) THEN 'EN_PRESTAMO_PROVISIONAL'
           WHEN t.estado_asignacion = 'EN_PRESTAMO_PROVISIONAL' THEN 'DISPONIBLE'
           ELSE t.estado_asignacion
         END`
    ).catch(() => {});

    // 2. Lógica 2 (Almacén General - Fiol / encargados): Modelo Físico Estricto
    const [nonDeliveredWithStockDeducted] = await conn.query(
      `SELECT s.id, s.status
       FROM solicitudes s
       WHERE s.inventario_descontado = 1
         AND UPPER(s.status) NOT IN ('COMPLETADA', 'SURTIDA', 'ENTREGADA', 'ENTREGADO', 'SURTIDO')
       FOR UPDATE`
    ).catch(() => [[]]);

    for (const solRow of nonDeliveredWithStockDeducted || []) {
      const [detRows] = await conn.query(
        `SELECT ds.cantidad_surtida, ds.atendida, ds.cantidad, p.CLAVE AS clave
         FROM detalles_solicitud ds
         LEFT JOIN productos p ON p.ID = ds.producto_id
         WHERE ds.solicitud_id = ?`,
        [solRow.id]
      ).catch(() => [[]]);

      for (const d of detRows || []) {
        const qty = Number(d.cantidad_surtida || d.atendida || d.cantidad || 0);
        if (qty > 0 && d.clave) {
          await conn.query(`UPDATE almacen_dregcivil SET STOCK = STOCK + ? WHERE CLAVE = ?`, [qty, d.clave]).catch(() => {});
          await conn.query(`UPDATE productos SET STOCK = STOCK + ? WHERE CLAVE = ?`, [qty, d.clave]).catch(() => {});
        }
      }
      await conn.query(`UPDATE solicitudes SET inventario_descontado = 0 WHERE id = ?`, [solRow.id]).catch(() => {});
    }

    if (isPool) await conn.commit();
    return { ok: true };
  } catch (err) {
    if (isPool) await conn.rollback().catch(() => {});
    console.warn("[WARN] repararInventarioBodegaDelegacionRM:", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  } finally {
    if (isPool && conn) conn.release();
  }
}

let SCHEMA_MIGRATED = false;
async function ensureSchemaAndUsers() {
  if (SCHEMA_MIGRATED) return true;
  if (!poolOps) return false;
  try {
    // 0. Metadata del sistema y respaldo automático al cambiar de versión
    await poolOps.query(`
      CREATE TABLE IF NOT EXISTS sistema_metadata (
        clave VARCHAR(50) PRIMARY KEY,
        valor VARCHAR(255),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    let versionEnBd = null;
    try {
      const [[metaRow]] = await poolRead.query(
        `SELECT valor FROM sistema_metadata WHERE clave = 'app_version' LIMIT 1`
      );
      versionEnBd = metaRow?.valor ? String(metaRow.valor).trim() : null;
    } catch (_) {}

    const NUEVA_VERSION_STR = "62";
    if (!versionEnBd || versionEnBd !== NUEVA_VERSION_STR) {
      try {
        await crearRespaldoAutomaticoBD(versionEnBd || "pre62", NUEVA_VERSION_STR);
      } catch (bErr) {
        console.warn("[WARN] Error al crear respaldo automático por cambio de versión:", bErr?.message || bErr);
      }
      await poolOps.query(
        `INSERT INTO sistema_metadata (clave, valor) VALUES ('app_version', ?)
         ON DUPLICATE KEY UPDATE valor = ?`,
        [NUEVA_VERSION_STR, NUEVA_VERSION_STR]
      ).catch(() => {});
    }

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
    if (!uColNames.has("departamento_id")) {
      await poolOps.query(`ALTER TABLE usuario ADD COLUMN departamento_id INT(11) DEFAULT NULL`).catch(() => {});
    }
    if (!uColNames.has("licencia")) {
      await poolOps.query(`ALTER TABLE usuario ADD COLUMN licencia VARCHAR(100) DEFAULT NULL`).catch(() => {});
    }
    if (!uColNames.has("vigencia_licencia")) {
      await poolOps.query(`ALTER TABLE usuario ADD COLUMN vigencia_licencia VARCHAR(50) DEFAULT NULL`).catch(() => {});
    }
    await poolOps.query(`ALTER TABLE usuarios ADD COLUMN cargo VARCHAR(150) DEFAULT NULL`).catch(() => {});
    await poolOps.query(`ALTER TABLE usuarios ADD COLUMN licencia VARCHAR(100) DEFAULT NULL`).catch(() => {});
    await poolOps.query(`ALTER TABLE usuarios ADD COLUMN vigencia_licencia VARCHAR(50) DEFAULT NULL`).catch(() => {});
    await poolOps.query(`ALTER TABLE usuario MODIFY COLUMN rol VARCHAR(50) NOT NULL DEFAULT 'USUARIO'`).catch(() => {});
    await poolOps.query(`ALTER TABLE oficialias MODIFY COLUMN oficial_reponsable VARCHAR(150) DEFAULT NULL`).catch(() => {});

    // 1a-v60. Auto-reparación de usuarios con id <= 0 o id IS NULL (ej. Jefatura y RH) sin tocar psw, nombres ni roles
    try {
      const [zeroUsers] = await poolRead.query(
        `SELECT username, ID_OFICIALIA FROM usuario WHERE id <= 0 OR id IS NULL ORDER BY username ASC`
      ).catch(() => [[]]);

      if (Array.isArray(zeroUsers) && zeroUsers.length > 0) {
        const connFix = await poolOps.getConnection();
        try {
          await connFix.query(`SET FOREIGN_KEY_CHECKS = 0`).catch(() => {});
          for (const zu of zeroUsers) {
            const uname = String(zu.username || "").trim();
            if (!uname) continue;
            const [[maxRow]] = await connFix.query(
              `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM usuario WHERE id > 0`
            );
            const nextId = Number(maxRow?.nextId || 1);
            await connFix.query(
              `UPDATE usuario SET id = ? WHERE (id <= 0 OR id IS NULL) AND username = ? LIMIT 1`,
              [nextId, uname]
            );
            await connFix.query(
              `UPDATE usuarios SET id = ? WHERE (id <= 0 OR id IS NULL) AND username = ? LIMIT 1`,
              [nextId, uname]
            ).catch(() => {});
          }
        } finally {
          await connFix.query(`SET FOREIGN_KEY_CHECKS = 1`).catch(() => {});
          connFix.release();
        }
      }

      // Reparar también en tabla espejo 'usuarios' si existiera algún registro rezagado con id <= 0
      const [zeroMirror] = await poolRead.query(
        `SELECT u2.username, u1.id AS main_id
         FROM usuarios u2
         LEFT JOIN usuario u1 ON LOWER(TRIM(u1.username)) = LOWER(TRIM(u2.username)) AND u1.id > 0
         WHERE u2.id <= 0 OR u2.id IS NULL
         ORDER BY u2.username ASC`
      ).catch(() => [[]]);
      if (Array.isArray(zeroMirror) && zeroMirror.length > 0) {
        const connMir = await poolOps.getConnection();
        try {
          await connMir.query(`SET FOREIGN_KEY_CHECKS = 0`).catch(() => {});
          for (const zm of zeroMirror) {
            const uname = String(zm.username || "").trim();
            if (!uname) continue;
            let targetId = Number(zm.main_id || 0);
            if (targetId <= 0) {
              const [[mRow]] = await connMir.query(`SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM usuarios WHERE id > 0`);
              targetId = Number(mRow?.nextId || 1);
            }
            await connMir.query(
              `UPDATE usuarios SET id = ? WHERE (id <= 0 OR id IS NULL) AND username = ? LIMIT 1`,
              [targetId, uname]
            ).catch(() => {});
          }
        } finally {
          await connMir.query(`SET FOREIGN_KEY_CHECKS = 1`).catch(() => {});
          connMir.release();
        }
      }

      // Intentar activar AUTO_INCREMENT en usuario.id de forma silenciosa y segura
      await poolOps.query(`ALTER TABLE usuario MODIFY COLUMN id INT(11) NOT NULL AUTO_INCREMENT`).catch(() => {});
    } catch (errFixId) {
      console.warn("[v60] Aviso al auto-reparar IDs de usuarios:", errFixId?.message || errFixId);
    }

    // 1b. Asegurar Rubros base (Rubro 1: Archivos y Materiales, Rubro 4: Tablets y Starlinks) solo si no existen o faltan valores
    await poolOps.query(
      `UPDATE rubros_inventario
       SET codigo = COALESCE(NULLIF(codigo, ''), 'ARCHIVO_MATERIALES'),
           nombre_rubro = COALESCE(NULLIF(nombre_rubro, ''), 'Archivos y Materiales'),
           encargado_nombre = COALESCE(NULLIF(encargado_nombre, ''), 'Gabriel Adán Fiol Collins'),
           encargado_cargo = COALESCE(NULLIF(encargado_cargo, ''), 'Encargado de Archivos y Materiales')
       WHERE id = 1 AND (encargado_nombre IS NULL OR TRIM(encargado_nombre) = '')`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE rubros_inventario
       SET codigo = COALESCE(NULLIF(codigo, ''), 'TABLETS_STARLINKS'),
           nombre_rubro = COALESCE(NULLIF(nombre_rubro, ''), 'Tablets y Starlinks'),
           encargado_nombre = 'Luis Eduardo Mayoral Geraldo',
           encargado_cargo = 'Encargado de Almacén'
       WHERE id = 4 OR codigo IN ('TABLETS', 'TABLETS_STARLINKS')`
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

    // 1c-2. En la región de Los Cabos (LOS_CABOS), reemplazar oficina pendiente/genérica o insertar formalmente "SADER"
    //       para que las 4 oficinas de Los Cabos sean Guaymitas, Cangrejos, PEC Caribe y SADER (además de su comodín S/A).
    await poolOps.query(
      `UPDATE oficinas_regionales
       SET nombre = 'SADER', municipio = 'San José del Cabo', activo = 1
       WHERE region_id = ? AND (nombre LIKE '%Por definir%' OR nombre LIKE '%Oficina 2%')`,
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
    //         (LOS_CABOS, MULEGE y COMONDU_LORETO) para conservar la sumatoria regional si no existen.
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
      }
    }

    // 1c-ter. Asegurar oficina "Coordinación Regional La Paz" y "RM (Recursos Materiales)" en La Paz si no existen
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
    }

    const [jefOfi] = await poolRead.query(
      `SELECT id FROM oficinas_regionales WHERE (region_id = ? OR region_id = 1) AND UPPER(TRIM(nombre)) = 'JEFATURA' LIMIT 1`,
      [regLaPazId || 1]
    ).catch(() => [[]]);
    if (!jefOfi.length) {
      await poolOps.query(
        `INSERT INTO oficinas_regionales (region_id, municipio, nombre, responsable_oficina, activo)
         VALUES (?, 'La Paz', 'Jefatura', 'Jefatura de Delegación', 1)`,
        [regLaPazId || 1]
      ).catch(() => {});
    }

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

    // v59: Garantizar que estado_fisico y estatus_uso en inventario_oficina soporten estatus largos (SINIESTRO / EN ASEGURADORA)
    try {
      const [statusColMeta] = await poolRead.query(
        `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'inventario_oficina'
           AND LOWER(COLUMN_NAME) IN ('estatus_uso', 'estado_fisico')`,
        [DB_NAME]
      );
      for (const sc of statusColMeta || []) {
        const dt = String(sc.DATA_TYPE || "").toLowerCase();
        const maxLen = Number(sc.CHARACTER_MAXIMUM_LENGTH || 0);
        if (dt === "enum" || maxLen < 60) {
          const defVal = String(sc.COLUMN_NAME).toLowerCase() === "estado_fisico" ? "BUENO" : "ACTIVO";
          await poolOps.query(
            `ALTER TABLE inventario_oficina MODIFY COLUMN ${qi(sc.COLUMN_NAME)} VARCHAR(80) NOT NULL DEFAULT ?`,
            [defVal]
          ).catch(() => {});
        }
      }
    } catch (_) {}

    // v47: Eliminar cualquier índice UNIQUE global únicamente sobre clave_bien en inventario_oficina
    // para permitir que distintas oficinas compartan la misma clave de catálogo (ej. MOB-001 en La Paz y MOB-001 en S/A o Comondú)
    try {
      const [idxRows] = await poolOps.query(
        `SELECT INDEX_NAME, GROUP_CONCAT( LOWER(COLUMN_NAME) ORDER BY SEQ_IN_INDEX SEPARATOR ',' ) AS cols
         FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'inventario_oficina' AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'
         GROUP BY INDEX_NAME`,
        [DB_NAME]
      );
      for (const idx of idxRows || []) {
        const idxName = String(idx.INDEX_NAME || "").trim();
        const cols = String(idx.cols || "").trim();
        if (idxName && (cols === "clave_bien" || (!cols.includes("oficina_id") && cols.includes("clave_bien")))) {
          await poolOps.query(`ALTER TABLE inventario_oficina DROP INDEX \`${idxName.replace(/`/g, "")}\``).catch(() => {});
          console.log(`[v47] Índice único global '${idxName}' eliminado de inventario_oficina.`);
        }
      }
    } catch (errIdx) {
      console.warn("[v47] Aviso al verificar índices de inventario_oficina:", errIdx.message);
    }

    // 1e. Asegurar oficialías para todos los departamentos y enlaces regionales si no existen
    const oficialiasToEnsure = [
      { id: 30030001, nombre: "Recursos Materiales", responsable: "Jorge Luis Patrón Murillo" },
      { id: 30030002, nombre: "Recursos Humanos", responsable: "Jonathan Alain Olachea Noriega" },
      { id: 30030003, nombre: "Informática", responsable: "Víctor Manuel Higuera Ruiz" },
      { id: 30030004, nombre: "Niñas y Niños", responsable: "María de los Ángeles Valenzuela López" },
      { id: 30030005, nombre: "Salud Casa por Casa", responsable: "Juan Carlos Cuadros Espinoza" },
      { id: 30030006, nombre: "Comunicación Social", responsable: "Ericka Peralta Preciado" },
      { id: 30030007, nombre: "Programa de Adulto Mayor", responsable: "Elizabeth Alvarez Trasviña" },
      { id: 30030008, nombre: "Encargado de Archivos y Materiales", responsable: "Gabriel Adán Fiol Collins" },
      { id: 30030009, nombre: "Enlace Regional Los Cabos", responsable: "Samir Savin Ruiz" },
      { id: 30030010, nombre: "Enlace Regional Mulegé", responsable: "Diana Ramírez Hernández" },
      { id: 30030011, nombre: "Enlace Regional Comondú / Loreto", responsable: "Humberto Arce Cordero" },
      { id: 30030012, nombre: "Asuntos Jurídicos", responsable: "Mayra Cruz Salazar Escobosa" },
      { id: 30030013, nombre: "Jóvenes Construyendo el Futuro", responsable: "Juan Daniel Carrera Villaseca" },
      { id: 30030014, nombre: "Programa de Discapacidad", responsable: "Anais Murillo Arce" },
      { id: 30030015, nombre: "Dirección Regional La Paz", responsable: "Sandra Guadalupe Salvatierra Amador" },
      { id: 30030016, nombre: "Jefatura", responsable: "Jefatura de Delegación" },
    ];
    for (const ofi of oficialiasToEnsure) {
      const [ofiExists] = await poolRead.query(
        `SELECT id FROM oficialias WHERE id = ? LIMIT 1`,
        [ofi.id]
      ).catch(() => [[]]);
      if (!ofiExists.length) {
        await poolOps.query(
          `INSERT INTO oficialias (id, id_tipo_oficialia, id_municipio, id_localidad, nombre, activo, oficial_reponsable, id_oficialia)
           VALUES (?, 0, 0, 0, ?, b'1', ?, ?)`,
          [ofi.id, ofi.nombre, ofi.responsable, ofi.id]
        ).catch(() => {});
      }
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
      { name: "firma_solicitante", ddl: "LONGTEXT DEFAULT NULL" },
      { name: "fecha_firma_digital", ddl: "DATETIME DEFAULT NULL" },
      { name: "folio_firma_digital", ddl: "VARCHAR(80) DEFAULT NULL" },
      { name: "archivo_respaldo", ddl: "VARCHAR(255) DEFAULT NULL" },
      { name: "es_prueba", ddl: "TINYINT(1) NOT NULL DEFAULT 0" },
      { name: "inventario_descontado", ddl: "TINYINT(1) NOT NULL DEFAULT 0" },
      { name: "estado", ddl: "VARCHAR(40) DEFAULT NULL" },
    ];
    for (const col of requiredSolCols) {
      if (!sColNames.has(col.name)) {
        await poolOps.query(`ALTER TABLE solicitudes ADD COLUMN ${qi(col.name)} ${col.ddl}`).catch(() => {});
      }
    }
    await poolOps.query(
      `ALTER TABLE solicitudes MODIFY COLUMN status VARCHAR(40) NOT NULL DEFAULT 'PENDIENTE'`
    ).catch(() => {});
    await poolOps.query(
      `UPDATE solicitudes SET estado = status WHERE estado IS NULL OR estado = ''`
    ).catch(() => {});
    STATUS_ENUM_CACHE = null;

    // v61: Asegurar columna cantidad_surtida en detalles_solicitud
    const [dsCols] = await poolRead.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'detalles_solicitud'`,
      [DB_NAME]
    ).catch(() => [[]]);
    const dsColNames = new Set(dsCols.map((c) => String(c.COLUMN_NAME || "").toLowerCase()));
    if (!dsColNames.has("cantidad_surtida")) {
      await poolOps.query(
        `ALTER TABLE detalles_solicitud ADD COLUMN cantidad_surtida INT NULL DEFAULT NULL`
      ).catch(() => {});
    }

    // 3. Crear los 4 usuarios encargados de Inventario Regional SOLO si no existen (Single Source of Truth)
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
      if (!existing.length) {
        // Calcular un ID libre si enc.id estuviera ocupado por otro usuario
        const [idCheck] = await poolRead.query(`SELECT id FROM usuario WHERE id = ? LIMIT 1`, [enc.id]);
        let targetId = Number(enc.id) > 0 ? Number(enc.id) : 0;
        if (idCheck.length || targetId <= 0) {
          const [[maxRow]] = await poolRead.query(`SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM usuario WHERE id > 0`);
          targetId = Number(maxRow?.nextId || 10);
        }
        await poolOps.query(
          `INSERT IGNORE INTO usuario
             (id, username, psw, nombre, PRIMER_APELLIDO, SEGUNDO_APELLIDO, ID_OFICIALIA, OFICIALIA_ID, ACTIVO, rol, FECHA_ALTA, departamento, cargo, rubro_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, b'1', 'ENCARGADO', NOW(), ?, ?, ?)`,
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
            enc.cargo || enc.departamento,
            enc.rubro_id,
          ]
        ).catch(() => {});
      }
    }

    // Asegurar departamento y oficialía de Encargado de Archivos y Materiales si no existe
    const [ofiFiolRows] = await poolRead.query(`SELECT id FROM oficialias WHERE id = 30030008 LIMIT 1`).catch(() => [[]]);
    if (!ofiFiolRows.length) {
      await poolOps.query(
        `INSERT INTO oficialias (id, id_tipo_oficialia, id_municipio, id_localidad, nombre, activo, oficial_reponsable, id_oficialia)
         VALUES (30030008, 0, 0, 0, 'Encargado de Archivos y Materiales', b'1', 'Gabriel Adán Fiol Collins', 30030008)`
      ).catch(() => {});
    }

    await poolOps.query(
      `CREATE TABLE IF NOT EXISTS departamentos (
        id INT(11) NOT NULL PRIMARY KEY,
        nombre VARCHAR(150) NOT NULL,
        responsable VARCHAR(150) DEFAULT NULL,
        activo TINYINT(1) DEFAULT 1
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    ).catch(() => {});

    const [deptoFiolRows] = await poolRead.query(`SELECT id FROM departamentos WHERE id = 30030008 LIMIT 1`).catch(() => [[]]);
    if (!deptoFiolRows.length) {
      await poolOps.query(
        `INSERT INTO departamentos (id, nombre, responsable)
         VALUES (30030008, 'Encargado de Archivos y Materiales', 'Gabriel Adán Fiol Collins')`
      ).catch(() => {});
    }

    // Vincular oficialía inicial de Gabriel Fiol SOLO si no tiene ninguna asignada
    await poolOps.query(
      `UPDATE usuario
       SET ID_OFICIALIA = 30030008,
           OFICIALIA_ID = 30030008,
           departamento_id = COALESCE(departamento_id, 30030008),
           departamento = COALESCE(NULLIF(departamento, ''), 'Encargado de Archivos y Materiales'),
           cargo = COALESCE(NULLIF(cargo, ''), 'Encargado de Archivos y Materiales'),
           rubro_id = COALESCE(rubro_id, 1)
       WHERE username IN ('gabrielfiol', 'fiol', 'encargado') AND (ID_OFICIALIA IS NULL OR ID_OFICIALIA = 0)`
    ).catch(() => {});

    // 4. Asegurar usuarios regionales de prueba: 'loscabos' y 'mulege' (contraseña inicial: secreta123)
    const [[regLosCabos]] = await poolRead.query(`SELECT id FROM regiones WHERE clave = 'LOS_CABOS' LIMIT 1`).catch(() => [[{ id: 2 }]]);
    const [[regMulege]] = await poolRead.query(`SELECT id FROM regiones WHERE clave = 'MULEGE' LIMIT 1`).catch(() => [[{ id: 4 }]]);
    const [[ofiLosCabos]] = await poolRead.query(`SELECT id FROM oficinas_regionales WHERE region_id = ? LIMIT 1`, [regLosCabos?.id || 2]).catch(() => [[{ id: 2 }]]);
    const [[ofiMulege]] = await poolRead.query(`SELECT id FROM oficinas_regionales WHERE region_id = ? LIMIT 1`, [regMulege?.id || 4]).catch(() => [[{ id: 9 }]]);

    const enlacesToEnsure = [
      {
        id: 8,
        username: "loscabos",
        nombre: "Samir",
        primer_ap: "Savin",
        segundo_ap: "Ruiz",
        id_oficialia: 30030009,
        departamento: "Enlace Regional Los Cabos",
        cargo: "Director Regional",
        region_id: regLosCabos?.id || 2,
        oficina_id: ofiLosCabos?.id || 2,
      },
      {
        id: 9,
        username: "mulege",
        nombre: "Diana",
        primer_ap: "Ramírez",
        segundo_ap: "Hernández",
        id_oficialia: 30030010,
        departamento: "Enlace Regional Mulegé",
        cargo: "Director Regional",
        region_id: regMulege?.id || 4,
        oficina_id: ofiMulege?.id || 9,
      },
    ];

    for (const enl of enlacesToEnsure) {
      const [existingEnl] = await poolRead.query(`SELECT id, username, psw, region_id FROM usuario WHERE username = ? LIMIT 1`, [enl.username]);
      if (!existingEnl.length) {
        const [idCheck] = await poolRead.query(`SELECT id FROM usuario WHERE id = ? LIMIT 1`, [enl.id]);
        let targetId = Number(enl.id) > 0 ? Number(enl.id) : 0;
        if (idCheck.length || targetId <= 0) {
          const [[maxRow]] = await poolRead.query(`SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM usuario WHERE id > 0`);
          targetId = Number(maxRow?.nextId || 12);
        }
        await poolOps.query(
          `INSERT IGNORE INTO usuario
             (id, username, psw, nombre, PRIMER_APELLIDO, SEGUNDO_APELLIDO, ID_OFICIALIA, OFICIALIA_ID, ACTIVO, rol, FECHA_ALTA, departamento, cargo, rubro_id, region_id, oficina_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, b'1', 'USUARIO', NOW(), ?, ?, NULL, ?, ?)`,
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
            enl.cargo || "Director Regional",
            enl.region_id,
            enl.oficina_id,
          ]
        ).catch(() => {});
      }
    }

    // 5. Garantizar que todos los usuarios tengan su departamento/oficialía asignado SOLO si no tienen ninguno
    await poolOps.query(
      `UPDATE usuario
       SET ID_OFICIALIA = 30030009, OFICIALIA_ID = 30030009,
           departamento = COALESCE(NULLIF(departamento, ''), 'Enlace Regional Los Cabos')
       WHERE (username = 'loscabos' OR region_id = 2) AND (ID_OFICIALIA IS NULL OR ID_OFICIALIA = 0)`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE usuario
       SET ID_OFICIALIA = 30030010, OFICIALIA_ID = 30030010,
           departamento = COALESCE(NULLIF(departamento, ''), 'Enlace Regional Mulegé')
       WHERE (username = 'mulege' OR region_id = 4) AND (ID_OFICIALIA IS NULL OR ID_OFICIALIA = 0)`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE usuario
       SET ID_OFICIALIA = 30030011, OFICIALIA_ID = 30030011,
           departamento = COALESCE(NULLIF(departamento, ''), 'Enlace Regional Comondú / Loreto')
       WHERE region_id = 3 AND (ID_OFICIALIA IS NULL OR ID_OFICIALIA = 0)`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE usuario
       SET ID_OFICIALIA = 30030001, OFICIALIA_ID = 30030001,
           departamento = COALESCE(NULLIF(departamento, ''), 'Recursos Materiales')
       WHERE username IN ('evelia', 'jesus', 'luiseduardo') AND (ID_OFICIALIA IS NULL OR ID_OFICIALIA = 0)`
    ).catch(() => {});

    // v59: Actualizar únicamente nombres oficiales en BD (SIN modificar psw/contraseñas ni ACTIVO)
    await poolOps.query(
      `UPDATE usuario
       SET nombre = 'Gabriel Adán', PRIMER_APELLIDO = 'Fiol', SEGUNDO_APELLIDO = 'Collins'
       WHERE username IN ('gabrielfiol', 'fiol')`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE usuario
       SET nombre = 'Samir', PRIMER_APELLIDO = 'Savin', SEGUNDO_APELLIDO = 'Ruiz'
       WHERE username = 'loscabos'`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE usuario
       SET nombre = 'Humberto', PRIMER_APELLIDO = 'Arce', SEGUNDO_APELLIDO = 'Cordero'
       WHERE username = 'comondu'`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE usuario
       SET nombre = 'Diana', PRIMER_APELLIDO = 'Ramírez', SEGUNDO_APELLIDO = 'Hernández'
       WHERE username IN ('mulege', 'guerreronegro')`
    ).catch(() => {});

    await poolOps.query(`UPDATE oficialias SET oficial_reponsable = 'Gabriel Adán Fiol Collins' WHERE id = 30030008`).catch(() => {});
    await poolOps.query(`UPDATE departamentos SET responsable = 'Gabriel Adán Fiol Collins' WHERE id = 30030008`).catch(() => {});

    const titularesRegV59 = [
      { clave: "LOS_CABOS", regId: regLosCabosId, ofiId: 30030009, nombre: "Samir Savin Ruiz" },
      { clave: "COMONDU_LORETO", regId: regComonduId, ofiId: 30030011, nombre: "Humberto Arce Cordero" },
      { clave: "MULEGE", regId: regMulegeId, ofiId: 30030010, nombre: "Diana Ramírez Hernández" },
    ];
    for (const tr of titularesRegV59) {
      await poolOps.query(
        `UPDATE regiones SET responsable_regional = ? WHERE clave = ? OR id = ?`,
        [tr.nombre, tr.clave, tr.regId]
      ).catch(() => {});
      await poolOps.query(
        `UPDATE oficialias SET oficial_reponsable = ? WHERE id = ?`,
        [tr.nombre, tr.ofiId]
      ).catch(() => {});
      await poolOps.query(
        `UPDATE departamentos SET responsable = ? WHERE id = ?`,
        [tr.nombre, tr.ofiId]
      ).catch(() => {});
    }

    // 5b. Asegurar usuarios Rodrigo Molina Cosio ('rodrigo') y Jorge Luis Patrón Murillo ('jorge')
    //     SOLO si no existen en la BD
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
        departamento: "Coordinador Operativo de Recursos Materiales",
        cargo: "Coordinador Operativo de Recursos Materiales",
      },
    ];

    for (const dir of directivosEstatalToEnsure) {
      const [existingDir] = await poolRead.query(
        `SELECT id, username, psw FROM usuario WHERE username = ? LIMIT 1`,
        [dir.username]
      ).catch(() => [[]]);

      if (!existingDir || !existingDir.length) {
        const [[maxRow]] = await poolRead.query(`SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM usuario WHERE id > 0`).catch(() => [[{ nextId: 11 }]]);
        const nextId = Number(maxRow?.nextId || 11);
        await poolOps.query(
          `INSERT IGNORE INTO usuario
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
        ).catch(() => {});
      }
    }

    // v58: Rellenar cargo oficial SOLO si está vacío o obsoleto, sin tocar nombre, contraseña (psw) ni estado activo
    await poolOps.query(
      `UPDATE usuario
       SET cargo = 'Coordinador Operativo de Recursos Materiales'
       WHERE (LOWER(TRIM(username)) IN ('jorge', 'jorgepatron'))
         AND (cargo IS NULL OR TRIM(cargo) = '' OR cargo LIKE '%Coordinación%')`
    ).catch(() => {});
    await poolOps.query(
      `UPDATE usuario
       SET cargo = 'Encargado de Almacén'
       WHERE LOWER(TRIM(username)) IN ('luismayoral', 'luiseduardo', 'luis')
         AND (cargo IS NULL OR TRIM(cargo) = '' OR cargo LIKE '%Tablets%')`
    ).catch(() => {});

    // 5c. Creación de usuarios faltantes (Región Comondú y Jefes de Departamento) SOLO si no existen
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
        nombre: "Humberto",
        primer_ap: "Arce",
        segundo_ap: "Cordero",
        rol: "regional",
        id_oficialia: 30030011,
        departamento: "Enlace Regional Comondú / Loreto",
        cargo: "Director Regional",
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
        nombre: "Anais",
        primer_ap: "Murillo",
        segundo_ap: "Arce",
        rol: "departamento",
        id_oficialia: 30030014,
        departamento: "Programa de Discapacidad",
        cargo: "Programa de Discapacidad",
        region_id: regLaPazId,
        oficina_id: ofiLaPazPrincipalId,
      },
      {
        username: "adultomayor",
        nombre: "Elizabeth",
        primer_ap: "Alvarez",
        segundo_ap: "Trasviña",
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
        cargo: "Director Regional",
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

      if (!existingUsr || !existingUsr.length) {
        const [[maxRow]] = await poolRead.query(
          `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM usuario WHERE id > 0`
        ).catch(() => [[{ nextId: 13 }]]);
        const nextId = Number(maxRow?.nextId || 13);
        await poolOps.query(
          `INSERT IGNORE INTO usuario
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
        ).catch(() => {});
      }
    }

    // 5d. Corrección ortográfica puntual (corrige error tipográfico 'Regionall')
    await poolOps.query(
      `UPDATE usuarios SET cargo = 'Director Regional' WHERE cargo LIKE '%Regionall%'`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE usuario SET cargo = 'Director Regional' WHERE cargo LIKE '%Regionall%'`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE inventario_oficina SET resguardante_puesto = 'Director Regional' WHERE resguardante_puesto LIKE '%Regionall%'`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE inventario_oficina
       SET detalles_vehiculo = REPLACE(detalles_vehiculo, 'Coordinadora Regionall', 'Director Regional')
       WHERE detalles_vehiculo LIKE '%Regionall%'`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE vales_prestamo SET recibe_cargo = 'Director Regional' WHERE recibe_cargo LIKE '%Regionall%'`
    ).catch(() => {});

    await poolOps.query(
      `UPDATE vales_prestamo SET solicitante_cargo = 'Director Regional' WHERE solicitante_cargo LIKE '%Regionall%'`
    ).catch(() => {});

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
    if (!vpColNames.has("es_prueba")) {
      await poolOps.query(`ALTER TABLE vales_prestamo ADD COLUMN es_prueba TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {});
    }

    await poolOps.query(
      `CREATE TABLE IF NOT EXISTS vales_prestamo_detalle (
        id INT(11) NOT NULL AUTO_INCREMENT,
        vale_id INT(11) NOT NULL,
        articulo_id INT(11) DEFAULT NULL,
        tableta_id INT(11) DEFAULT NULL,
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

    // v53: Asegurar columnas en vales_prestamo_detalle para persistencia estricta de devoluciones y retornos forzados
    const [vpdCols] = await poolRead.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'vales_prestamo_detalle'`,
      [DB_NAME]
    ).catch(() => [[]]);
    const vpdColNames = new Set(vpdCols.map((c) => String(c.COLUMN_NAME || "").toLowerCase()));
    if (!vpdColNames.has("devuelto")) {
      await poolOps.query(`ALTER TABLE vales_prestamo_detalle ADD COLUMN devuelto TINYINT(1) DEFAULT 0`).catch(() => {});
    }
    if (!vpdColNames.has("cantidad_devuelta")) {
      await poolOps.query(`ALTER TABLE vales_prestamo_detalle ADD COLUMN cantidad_devuelta INT(11) DEFAULT 0`).catch(() => {});
    }
    if (!vpdColNames.has("fecha_devolucion")) {
      await poolOps.query(`ALTER TABLE vales_prestamo_detalle ADD COLUMN fecha_devolucion DATETIME DEFAULT NULL`).catch(() => {});
    }
    if (!vpdColNames.has("tableta_id")) {
      await poolOps.query(`ALTER TABLE vales_prestamo_detalle ADD COLUMN tableta_id INT(11) NULL DEFAULT NULL`).catch(() => {});
    }

    // v53: Asegurar stock_minimo en inventario_oficina para semáforo de inventario regional
    const [ioCols] = await poolRead.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'inventario_oficina'`,
      [DB_NAME]
    ).catch(() => [[]]);
    const ioColNames = new Set(ioCols.map((c) => String(c.COLUMN_NAME || "").toLowerCase()));
    if (!ioColNames.has("stock_minimo")) {
      await poolOps.query(`ALTER TABLE inventario_oficina ADD COLUMN stock_minimo INT(11) DEFAULT 0`).catch(() => {});
    }

    // v44: Bitácora de movimientos del inventario para auditoría
    await poolOps.query(
      `CREATE TABLE IF NOT EXISTS bitacora_movimientos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario VARCHAR(100),
        nombre_usuario VARCHAR(150),
        modulo VARCHAR(50),
        accion VARCHAR(50),
        detalles TEXT,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
        KEY idx_bit_fecha (fecha),
        KEY idx_bit_usuario (usuario),
        KEY idx_bit_modulo (modulo)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    ).catch(() => {});

    // Normalización de claves en inventario regional: forzar mayúsculas y sin espacios
    await poolOps.query(
      `UPDATE inventario_oficina SET clave_bien = UPPER(TRIM(clave_bien)) WHERE clave_bien IS NOT NULL`
    ).catch(() => {});

    // v56: Tablas y semilla del Módulo de Tabletas Digitales (Luis Eduardo Mayoral Geraldo)
    await poolOps.query(
      `CREATE TABLE IF NOT EXISTS inventario_tabletas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        no_resguardo INT NOT NULL UNIQUE,
        imei VARCHAR(30) NOT NULL UNIQUE,
        numero_serie VARCHAR(50) NOT NULL UNIQUE,
        no_caja VARCHAR(20),
        marca VARCHAR(50) DEFAULT 'Compac',
        modelo VARCHAR(50) DEFAULT 'QTab LTE',
        descripcion VARCHAR(100) DEFAULT 'Tablet Compac',
        region ENUM('LA PAZ', 'LOS CABOS', 'COMONDU', 'MULEGE') NOT NULL,
        oficina_programa VARCHAR(80) NOT NULL,
        nombre_resguardante VARCHAR(150) DEFAULT '',
        cargo_resguardante VARCHAR(120) DEFAULT 'Servidor de la nación',
        estatus_fisico VARCHAR(50) DEFAULT 'BUENO',
        tiene_cargador TINYINT(1) DEFAULT 1,
        tiene_caja TINYINT(1) DEFAULT 1,
        observaciones TEXT,
        sin_resguardo_previo TINYINT(1) DEFAULT 0,
        estado_asignacion ENUM('EN_RESGUARDO', 'DEVOLUCION_PENDIENTE', 'DISPONIBLE', 'EN_PRESTAMO_PROVISIONAL') NOT NULL DEFAULT 'EN_RESGUARDO',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    ).catch((errTab) => {
      console.warn("[WARN] CREATE inventario_tabletas:", errTab?.message || errTab);
    });

    // v58: Asegurar estado EN_PRESTAMO_PROVISIONAL en inventario_tabletas existente
    await poolOps.query(
      `ALTER TABLE inventario_tabletas
       MODIFY COLUMN estado_asignacion ENUM('EN_RESGUARDO', 'DEVOLUCION_PENDIENTE', 'DISPONIBLE', 'EN_PRESTAMO_PROVISIONAL') NOT NULL DEFAULT 'EN_RESGUARDO'`
    ).catch(() => {});

    await poolOps.query(
      `CREATE TABLE IF NOT EXISTS movimientos_tabletas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tipo ENUM('DEVOLUCION', 'ASIGNACION') NOT NULL,
        folio VARCHAR(30) NOT NULL,
        tableta_id INT NOT NULL,
        no_resguardo INT NOT NULL,
        region VARCHAR(50),
        oficina_programa VARCHAR(80),
        nombre_persona VARCHAR(150) NOT NULL,
        cargo_persona VARCHAR(120) DEFAULT 'Servidor de la nación',
        tiene_cargador TINYINT(1) DEFAULT 1,
        tiene_caja TINYINT(1) DEFAULT 1,
        estatus_fisico VARCHAR(50) DEFAULT 'BUENO',
        observaciones TEXT,
        estado ENUM('EN_PROCESO', 'CONFIRMADO', 'CANCELADO') DEFAULT 'EN_PROCESO',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        confirmed_at DATETIME NULL,
        KEY idx_movtab_tableta (tableta_id),
        KEY idx_movtab_tipo_estado (tipo, estado)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    ).catch((errMovTab) => {
      console.warn("[WARN] CREATE movimientos_tabletas:", errMovTab?.message || errMovTab);
    });

    // Asegurar columnas idempotentes para Firma Digital Remota y Evidencia Fotográfica en movimientos_tabletas e inventario_tabletas
    try {
      const [movTabCols] = await poolRead.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'movimientos_tabletas'`,
        [DB_NAME]
      );
      const movTabColSet = new Set((movTabCols || []).map((c) => String(c.COLUMN_NAME || "").toLowerCase()));
      const requiredMovTabCols = [
        { name: "estado_firma", ddl: "VARCHAR(30) NOT NULL DEFAULT 'NO_APLICA'" },
        { name: "region_firma_destino", ddl: "VARCHAR(30) NULL" },
        { name: "firma_devolucion_data", ddl: "MEDIUMTEXT NULL" },
        { name: "fecha_firma_digital", ddl: "DATETIME NULL" },
        { name: "folio_firma_digital", ddl: "VARCHAR(64) NULL" },
        { name: "firmado_por_usuario_id", ddl: "INT NULL" },
        { name: "motivo_rechazo_region", ddl: "VARCHAR(255) NULL" },
        { name: "foto_ine_frente", ddl: "VARCHAR(255) NULL" },
        { name: "foto_ine_reverso", ddl: "VARCHAR(255) NULL" },
        { name: "foto_entrega", ddl: "VARCHAR(255) NULL" },
      ];
      for (const col of requiredMovTabCols) {
        if (!movTabColSet.has(col.name.toLowerCase())) {
          await poolOps.query(
            `ALTER TABLE movimientos_tabletas ADD COLUMN ${qi(col.name)} ${col.ddl}`
          ).catch((e) => console.warn(`[WARN] ALTER movimientos_tabletas.${col.name}:`, e?.message || e));
        }
      }

      const [movTabIdxRows] = await poolRead.query(
        `SELECT DISTINCT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'movimientos_tabletas'`,
        [DB_NAME]
      );
      const movTabIdxSet = new Set((movTabIdxRows || []).map((i) => String(i.INDEX_NAME || "").toLowerCase()));
      if (!movTabIdxSet.has("idx_mov_tab_region_firma")) {
        await poolOps.query(
          `CREATE INDEX idx_mov_tab_region_firma ON movimientos_tabletas (region_firma_destino, estado_firma)`
        ).catch((e) => console.warn("[WARN] CREATE INDEX idx_mov_tab_region_firma:", e?.message || e));
      }
      if (!movTabIdxSet.has("idx_mov_tab_tableta")) {
        await poolOps.query(
          `CREATE INDEX idx_mov_tab_tableta ON movimientos_tabletas (tableta_id)`
        ).catch((e) => console.warn("[WARN] CREATE INDEX idx_mov_tab_tableta:", e?.message || e));
      }

      const [invTabCols] = await poolRead.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'inventario_tabletas'`,
        [DB_NAME]
      );
      const invTabColSet = new Set((invTabCols || []).map((c) => String(c.COLUMN_NAME || "").toLowerCase()));
      if (!invTabColSet.has("ultimo_movimiento_asignacion_id")) {
        await poolOps.query(
          `ALTER TABLE inventario_tabletas ADD COLUMN ultimo_movimiento_asignacion_id INT NULL`
        ).catch((e) => console.warn("[WARN] ALTER inventario_tabletas.ultimo_movimiento_asignacion_id:", e?.message || e));
      }
    } catch (errTabSchema) {
      console.warn("[WARN] Migración columnas firma/evidencias tabletas:", errTabSchema?.message || errTabSchema);
    }

    await poolOps.query(
      `CREATE TABLE IF NOT EXISTS bitacora_tabletas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tableta_id INT NULL,
        no_resguardo INT NULL,
        imei VARCHAR(30) NULL,
        numero_serie VARCHAR(50) NULL,
        usuario VARCHAR(80) NOT NULL,
        accion VARCHAR(50) NOT NULL,
        detalles TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_bittab_tableta (tableta_id),
        KEY idx_bittab_accion (accion),
        KEY idx_bittab_usuario (usuario),
        KEY idx_bittab_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    ).catch((errBitTab) => {
      console.warn("[WARN] CREATE bitacora_tabletas:", errBitTab?.message || errBitTab);
    });

    await seedInventarioTabletasIfEmpty().catch((errSeedTab) => {
      console.warn("[WARN] seedInventarioTabletasIfEmpty:", errSeedTab?.message || errSeedTab);
    });

    // v61: Tabla de Configuración Global y Migración Única de Modo Prueba Grupal + Rescate de Vale #3 (Víctor Huerta)
    await poolOps.query(
      `CREATE TABLE IF NOT EXISTS configuracion_sistema (
        clave VARCHAR(64) PRIMARY KEY,
        valor VARCHAR(255) NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    ).catch((errCfg) => {
      console.warn("[WARN] CREATE configuracion_sistema:", errCfg?.message || errCfg);
    });

    await poolOps.query(
      `INSERT IGNORE INTO configuracion_sistema (clave, valor) VALUES
         ('MODO_PRUEBA_GRUPAL', '0'),
         ('MIGRACION_V61_APLICADA', '0'),
         ('MIGRACION_V62_APLICADA', '0'),
         ('MIGRACION_RECALCULO_ID_ESTRICTO_V1', '0'),
         ('MIGRACION_FIX_TABLETAS_Y_MOB024_V1', '0'),
         ('MIGRACION_COORD_PCD_PAM_V1', '0')`
    ).catch(() => {});

    try {
      const [[migRow]] = await poolRead.query(
        `SELECT valor FROM configuracion_sistema WHERE clave = 'MIGRACION_V61_APLICADA' LIMIT 1`
      );
      const migAplicada = String(migRow?.valor || "0").trim() === "1";
      if (!migAplicada) {
        console.log("[v61] Ejecutando migración única: preservando Vale #3 de Víctor Huerta y restaurando inventarios de vales/solicitudes de prueba...");

        // 1. Marcar como es_prueba = 1 todos los vales EXCEPTO el Vale #3 de Víctor Huerta (que se preserva con es_prueba = 0)
        await poolOps.query(
          `UPDATE vales_prestamo
           SET es_prueba = CASE
             WHEN id = 3
               OR LOWER(COALESCE(solicitante_nombre, '')) LIKE '%victor%huerta%'
               OR LOWER(COALESCE(solicitante_nombre, '')) LIKE '%víctor%huerta%'
               OR LOWER(COALESCE(recibe_nombre, '')) LIKE '%victor%huerta%'
               OR LOWER(COALESCE(recibe_nombre, '')) LIKE '%víctor%huerta%'
             THEN 0
             ELSE 1
           END`
        ).catch((e) => console.warn("[v61] UPDATE vales_prestamo es_prueba:", e.message));

        // 2. Marcar las solicitudes previas como es_prueba = 1
        await poolOps.query(
          `UPDATE solicitudes SET es_prueba = 1`
        ).catch((e) => console.warn("[v61] UPDATE solicitudes es_prueba:", e.message));

        // 3. Liberar tabletas que hayan quedado en EN_PRESTAMO_PROVISIONAL por vales de prueba
        await poolOps.query(
          `UPDATE inventario_tabletas t
           SET t.estado_asignacion = 'DISPONIBLE',
               t.region = 'LA PAZ',
               t.oficina_programa = 'Delegación La Paz',
               t.nombre_resguardante = ''
           WHERE t.estado_asignacion = 'EN_PRESTAMO_PROVISIONAL'
             AND NOT EXISTS (
               SELECT 1
               FROM vales_prestamo_detalle vpd
               INNER JOIN vales_prestamo vp ON vp.id = vpd.vale_id
               WHERE (vpd.tableta_id = t.id OR vpd.articulo_id = t.id)
                 AND COALESCE(vp.es_prueba, 0) = 0
                 AND vp.estado NOT IN ('DEVUELTO', 'CANCELADO', 'RECHAZADO')
             )`
        ).catch((e) => console.warn("[v61] Restaurar inventario_tabletas:", e.message));

        // 4. Recalcular inventario_oficina (Rubros 2 y 3) tomando en cuenta ÚNICAMENTE vales reales activos (es_prueba = 0)
        const [activeRealLoans] = await poolRead.query(
          `SELECT vpd.articulo_id, COALESCE(SUM(vpd.cantidad), 0) AS total_prestado
           FROM vales_prestamo_detalle vpd
           INNER JOIN vales_prestamo vp ON vp.id = vpd.vale_id
           WHERE vpd.articulo_id IS NOT NULL
             AND COALESCE(vp.es_prueba, 0) = 0
             AND vp.estado NOT IN ('DEVUELTO', 'CANCELADO', 'RECHAZADO')
           GROUP BY vpd.articulo_id`
        ).catch(() => [[]]);

        const realLoanMap = new Map();
        for (const r of activeRealLoans || []) {
          realLoanMap.set(Number(r.articulo_id), Math.max(0, Number(r.total_prestado || 0)));
        }

        const [allInvRows] = await poolRead.query(
          `SELECT id, cantidad_propia, estatus_uso FROM inventario_oficina`
        ).catch(() => [[]]);

        for (const inv of allInvRows || []) {
          const prestadaReal = realLoanMap.get(Number(inv.id)) || 0;
          const propia = Math.max(0, Number(inv.cantidad_propia || 0));
          const nuevaDisp = Math.max(0, propia - prestadaReal);
          let nuevoEstatus = inv.estatus_uso || "ACTIVO";
          if (String(nuevoEstatus).toUpperCase() === "PRESTADO" && nuevaDisp > 0) {
            nuevoEstatus = "ACTIVO";
          } else if (propia > 0 && nuevaDisp === 0 && prestadaReal > 0) {
            nuevoEstatus = "PRESTADO";
          }
          await poolOps.query(
            `UPDATE inventario_oficina
             SET cantidad_prestada_enviada = ?,
                 cantidad_disponible = ?,
                 estatus_uso = ?
             WHERE id = ?`,
            [prestadaReal, nuevaDisp, nuevoEstatus, inv.id]
          ).catch(() => {});
        }

        await poolOps.query(
          `UPDATE configuracion_sistema SET valor = '1' WHERE clave = 'MIGRACION_V61_APLICADA'`
        ).catch(() => {});
        console.log("[v61] Migración única completada exitosamente.");
      }
    } catch (errMig61) {
      console.warn("[WARN] Migración v61:", errMig61?.message || errMig61);
    }

    // ============================================================================
    // v62: Parche idempotente de estados de prueba (Vales y Solicitudes) y ajuste diferencial de inventario
    // ============================================================================
    try {
      const [[mig62Row]] = await poolRead.query(
        `SELECT valor FROM configuracion_sistema WHERE clave = 'MIGRACION_V62_APLICADA' LIMIT 1`
      ).catch(() => [[]]);
      const mig62Aplicada = String(mig62Row?.valor || "0").trim() === "1";

      if (!mig62Aplicada) {
        console.log("[v62] Aplicando migración única de estados de prueba y ajuste diferencial de inventario...");

        // Consultar antes del UPDATE los deltas exactos de los vales afectados:
        // a) Vales de Rubro 3 (excepto vale #13) que eran de prueba (es_prueba = 1) y pasarán a reales (es_prueba = 0)
        const [rubro3DeltaRows] = await poolRead.query(
          `SELECT vpd.articulo_id, COALESCE(SUM(vpd.cantidad), 0) AS total_cant
           FROM vales_prestamo_detalle vpd
           INNER JOIN vales_prestamo vp ON vp.id = vpd.vale_id
           WHERE vp.rubro_id = 3
             AND vp.id <> 13
             AND COALESCE(vp.es_prueba, 0) = 1
             AND vpd.articulo_id IS NOT NULL
             AND vp.estado NOT IN ('DEVUELTO', 'CANCELADO', 'RECHAZADO')
           GROUP BY vpd.articulo_id`
        ).catch(() => [[]]);

        // b) Vale #13 que pasará a prueba (es_prueba = 1), para devolver su stock al inventario
        const [vale13DeltaRows] = await poolRead.query(
          `SELECT vpd.articulo_id, COALESCE(SUM(vpd.cantidad), 0) AS total_cant
           FROM vales_prestamo_detalle vpd
           INNER JOIN vales_prestamo vp ON vp.id = vpd.vale_id
           WHERE vp.id = 13
             AND COALESCE(vp.es_prueba, 0) = 0
             AND vpd.articulo_id IS NOT NULL
             AND vp.estado NOT IN ('DEVUELTO', 'CANCELADO', 'RECHAZADO')
           GROUP BY vpd.articulo_id`
        ).catch(() => [[]]);

        // 1. Rescatar Solicitud de Almacén #3 (Víctor Manuel Higuera Ruiz)
        await poolOps.query(`UPDATE solicitudes SET es_prueba = 0 WHERE id = 3`).catch(() => {});
        // 2. Vales Provisionales Reales (Jesús / Mobiliario - Rubro 3)
        await poolOps.query(`UPDATE vales_prestamo SET es_prueba = 0 WHERE rubro_id = 3 AND id <> 13`).catch(() => {});
        // 3. Vale Provisional Específico de Prueba (VP-2026-0013 - Víctor / Informática)
        await poolOps.query(`UPDATE vales_prestamo SET es_prueba = 1 WHERE id = 13`).catch(() => {});

        // 4a. Sumar el stock al inventario devolviendo lo del vale #13 (que pasó a es_prueba = 1)
        for (const r13 of vale13DeltaRows || []) {
          const cant = Math.max(0, Number(r13.total_cant || 0));
          const artId = Number(r13.articulo_id || 0);
          if (cant > 0 && artId > 0) {
            await poolOps.query(
              `UPDATE inventario_oficina
               SET cantidad_disponible = LEAST(cantidad_propia, COALESCE(cantidad_disponible, cantidad_propia) + ?),
                   cantidad_prestada_enviada = GREATEST(0, COALESCE(cantidad_prestada_enviada, 0) - ?),
                   estatus_uso = CASE
                     WHEN LEAST(cantidad_propia, COALESCE(cantidad_disponible, cantidad_propia) + ?) > 0
                          AND UPPER(COALESCE(estatus_uso, '')) = 'PRESTADO'
                     THEN 'ACTIVO'
                     ELSE estatus_uso
                   END
               WHERE id = ?`,
              [cant, cant, cant, artId]
            ).catch(() => {});
          }
        }

        // 4b. Descontar del inventario lo de los vales del Rubro 3 que eran de prueba y pasaron a reales (es_prueba = 0)
        for (const r3 of rubro3DeltaRows || []) {
          const cant = Math.max(0, Number(r3.total_cant || 0));
          const artId = Number(r3.articulo_id || 0);
          if (cant > 0 && artId > 0) {
            await poolOps.query(
              `UPDATE inventario_oficina
               SET cantidad_disponible = GREATEST(0, COALESCE(cantidad_disponible, cantidad_propia) - ?),
                   cantidad_prestada_enviada = COALESCE(cantidad_prestada_enviada, 0) + ?,
                   estatus_uso = CASE
                     WHEN GREATEST(0, COALESCE(cantidad_disponible, cantidad_propia) - ?) = 0
                          AND cantidad_propia > 0
                     THEN 'PRESTADO'
                     ELSE estatus_uso
                   END
               WHERE id = ?`,
              [cant, cant, cant, artId]
            ).catch(() => {});
          }
        }

        await poolOps.query(
          `INSERT INTO configuracion_sistema (clave, valor) VALUES ('MIGRACION_V62_APLICADA', '1')
           ON DUPLICATE KEY UPDATE valor = '1'`
        ).catch(() => {});

        console.log("[v62] Migración única v62 y ajuste diferencial de inventario completados.");
      }
    } catch (errV62) {
      console.warn("[WARN] Parche v62:", errV62?.message || errV62);
    }

    // ============================================================================
    // FASE 3: Migración a Producción, Lógica Dual y Cancelación de Prueba #13
    // ============================================================================
    try {
      const [[migFase3Row]] = await poolRead.query(
        `SELECT valor FROM configuracion_sistema WHERE clave = 'MIGRACION_FASE3_PRODUCCION' LIMIT 1`
      ).catch(() => [[]]);
      const migFase3Aplicada = String(migFase3Row?.valor || "0").trim() === "1";

      if (!migFase3Aplicada) {
        console.log("[FASE 3] Aplicando migración a producción y lógica dual...");

        // Desactivar MODO_PRUEBA_GRUPAL en producción
        await poolOps.query(
          `INSERT INTO configuracion_sistema (clave, valor) VALUES ('MODO_PRUEBA_GRUPAL', '0')
           ON DUPLICATE KEY UPDATE valor = '0'`
        ).catch(() => {});

        // Reintegrar stock si la solicitud #13 había sido descontada
        const [sol13Rows] = await poolRead.query(
          `SELECT id, status, inventario_descontado FROM solicitudes WHERE id = 13 LIMIT 1`
        ).catch(() => [[]]);
        if (sol13Rows && sol13Rows.length > 0) {
          const sol13 = sol13Rows[0];
          if (Number(sol13.inventario_descontado || 0) === 1) {
            const [det13] = await poolRead.query(
              `SELECT ds.cantidad_surtida, ds.atendida, ds.cantidad, p.CLAVE AS clave
               FROM detalles_solicitud ds
               LEFT JOIN productos p ON p.ID = ds.producto_id
               WHERE ds.solicitud_id = 13`
            ).catch(() => [[]]);
            for (const d of det13 || []) {
              const qty = Number(d.cantidad_surtida || d.atendida || d.cantidad || 0);
              if (qty > 0 && d.clave) {
                await poolOps.query(`UPDATE almacen_dregcivil SET STOCK = STOCK + ? WHERE CLAVE = ?`, [qty, d.clave]).catch(() => {});
                await poolOps.query(`UPDATE productos SET STOCK = STOCK + ? WHERE CLAVE = ?`, [qty, d.clave]).catch(() => {});
              }
            }
          }
        }

        // Consulta de única vez requerida exactamente para cancelar vales/solicitud de prueba #13
        await poolOps.query(`UPDATE solicitudes SET estado = 'CANCELADO' WHERE id = 13 AND estado != 'CANCELADO'`).catch(() => {});
        await poolOps.query(`UPDATE solicitudes SET status = 'CANCELADA', inventario_descontado = 0 WHERE id = 13 AND status != 'CANCELADA'`).catch(() => {});
        await poolOps.query(`UPDATE vales_prestamo SET estado = 'CANCELADO' WHERE id = 13 AND estado != 'CANCELADO'`).catch(() => {});

        // Ejecutar recálculo de inventario bajo la LÓGICA DUAL
        await repararInventarioBodegaDelegacionRM(poolOps);

        await poolOps.query(
          `INSERT INTO configuracion_sistema (clave, valor) VALUES ('MIGRACION_FASE3_PRODUCCION', '1')
           ON DUPLICATE KEY UPDATE valor = '1'`
        ).catch(() => {});

        console.log("[FASE 3] Migración a producción y recálculo dual de inventario completados exitosamente.");
      }
    } catch (errFase3) {
      console.warn("[WARN] Migración Fase 3:", errFase3?.message || errFase3);
    }

    // Recálculo idempotente estricto por ID único (sin alterar jamás cantidad_propia)
    try {
      const [[migIdRow]] = await poolRead.query(
        `SELECT valor FROM configuracion_sistema WHERE clave = 'MIGRACION_RECALCULO_ID_ESTRICTO_V1' LIMIT 1`
      ).catch(() => [[]]);
      if (String(migIdRow?.valor || "0").trim() !== "1") {
        await repararInventarioBodegaDelegacionRM(poolOps);
        await poolOps.query(
          `INSERT INTO configuracion_sistema (clave, valor) VALUES ('MIGRACION_RECALCULO_ID_ESTRICTO_V1', '1')
           ON DUPLICATE KEY UPDATE valor = '1'`
        ).catch(() => {});
      }
    } catch (errRecalc) {
      console.warn("[WARN] Recálculo estricto por ID:", errRecalc?.message || errRecalc);
    }

    // ========================================================================
    // MIGRACION_FIX_TABLETAS_Y_MOB024_V1:
    // 1. Corregir clasificación de 9 tabletas a EN_RESGUARDO (8 Mulegé y 1 La Paz)
    // 2. Reasignar préstamo de silla MOB-029 a MOB-024 (Mobiliario RM - Jesús)
    // 3. Alta de oficina / departamento "Jefatura"
    // ========================================================================
    try {
      const [[migFixRow]] = await poolRead.query(
        `SELECT valor FROM configuracion_sistema WHERE clave = 'MIGRACION_FIX_TABLETAS_Y_MOB024_V1' LIMIT 1`
      ).catch(() => [[]]);

      if (String(migFixRow?.valor || "0").trim() !== "1") {
        console.log("[MIGRACION] Iniciando MIGRACION_FIX_TABLETAS_Y_MOB024_V1...");

        // 1. TABLETAS: Corregir clasificación de tabletas en EN_PRESTAMO_PROVISIONAL a EN_RESGUARDO
        // si NO están vinculadas a un vale activo en vales_prestamo (rubro 4)
        await poolOps.query(
          `UPDATE inventario_tabletas t
           SET t.estado_asignacion = 'EN_RESGUARDO'
           WHERE t.estado_asignacion = 'EN_PRESTAMO_PROVISIONAL'
             AND NOT EXISTS (
               SELECT 1
               FROM vales_prestamo_detalle vpd
               INNER JOIN vales_prestamo vp ON vp.id = vpd.vale_id
               WHERE (vpd.tableta_id = t.id OR vpd.articulo_id = t.id)
                 AND vp.rubro_id = 4
                 AND vp.estado IN ('PENDIENTE', 'AUTORIZADO_EN_PRESTAMO', 'EN_PRESTAMO')
                 AND COALESCE(vpd.estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')
             )`
        ).catch((err) => console.warn("[WARN] Fix tabletas provisional:", err?.message || err));

        // Si alguna tableta en EN_RESGUARDO quedó con nombre_resguardante vacío tras alguna prueba,
        // restauramos el nombre original desde el archivo Excel fuente si existe
        try {
          const candidatePaths = [
            path.join(__dirname, "Registro_Tabletas_Bienestar (2).xlsx"),
            path.join(__dirname, "Tabletas_inventario.xlsx"),
            "C:/Users/danie/.gemini/antigravity/brain/e63b32a5-942f-4d30-9d7d-1182c0ddbc46/.user_uploaded/media_1794538721890_50f732e9.xlsx",
          ];
          const excelPath = candidatePaths.find((p) => fs.existsSync(p));
          if (excelPath) {
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.readFile(excelPath);
            const ws = wb.getWorksheet("BCS") || wb.worksheets[0];
            if (ws) {
              const excelMap = new Map();
              ws.eachRow((row, rowNumber) => {
                if (rowNumber < 4) return;
                const noResg = parseInt(extractExcelCellText(row.getCell(3).value), 10);
                const rawNombre = extractExcelCellText(row.getCell(4).value);
                const rawReg = extractExcelCellText(row.getCell(2).value);
                if (Number.isInteger(noResg) && noResg > 0 && rawNombre && !RED_RESGUARDOS_TABLETAS.has(noResg)) {
                  const mapped = mapExcelRegionProgramaTableta(rawReg);
                  excelMap.set(noResg, { nombre: rawNombre, region: mapped.region, oficina: mapped.oficina_programa });
                }
              });

              const [blankNameTabs] = await poolRead.query(
                `SELECT id, no_resguardo FROM inventario_tabletas WHERE estado_asignacion = 'EN_RESGUARDO' AND (TRIM(COALESCE(nombre_resguardante, '')) = '' OR nombre_resguardante IS NULL)`
              ).catch(() => [[]]);

              for (const bTab of blankNameTabs || []) {
                const exInfo = excelMap.get(Number(bTab.no_resguardo));
                if (exInfo && exInfo.nombre) {
                  await poolOps.query(
                    `UPDATE inventario_tabletas
                     SET nombre_resguardante = ?,
                         region = COALESCE(NULLIF(region, ''), ?),
                         oficina_programa = COALESCE(NULLIF(oficina_programa, ''), ?)
                     WHERE id = ?`,
                    [exInfo.nombre, exInfo.region, exInfo.oficina, bTab.id]
                  ).catch(() => {});
                }
              }
            }
          }
        } catch (errEx) {
          console.warn("[WARN] Recuperar nombres Excel tabletas:", errEx?.message || errEx);
        }

        // 2. SILLAS: Reasignar préstamo de MOB-029 a MOB-024 (Mobiliario RM, rubro 3)
        try {
          const [sillasRows] = await poolRead.query(
            `SELECT id, clave_bien FROM inventario_oficina WHERE rubro_id = 3 AND (clave_bien IN ('MOB-024', 'MOB-029') OR descripcion LIKE '%MOB-024%' OR descripcion LIKE '%MOB-029%')`
          ).catch(() => [[]]);

          const rowMob24 = (sillasRows || []).find(s => String(s.clave_bien || "").toUpperCase() === "MOB-024");
          const rowMob29 = (sillasRows || []).find(s => String(s.clave_bien || "").toUpperCase() === "MOB-029");

          if (rowMob24) {
            const idMob24 = rowMob24.id;
            const idMob29 = rowMob29 ? rowMob29.id : null;

            let whereClause = `(vpd.clave = 'MOB-029' OR vpd.descripcion LIKE '%MOB-029%'`;
            const queryParams = [idMob24];
            if (idMob29) {
              whereClause += ` OR vpd.articulo_id = ?`;
              queryParams.push(idMob29);
            }
            whereClause += `)`;

            await poolOps.query(
              `UPDATE vales_prestamo_detalle vpd
               INNER JOIN vales_prestamo vp ON vp.id = vpd.vale_id
               SET vpd.articulo_id = ?,
                   vpd.clave = 'MOB-024',
                   vpd.descripcion = REPLACE(REPLACE(vpd.descripcion, 'MOB-029', 'MOB-024'), 'mob-029', 'MOB-024')
               WHERE vp.estado NOT IN ('DEVUELTO', 'CANCELADO', 'RECHAZADO')
                 AND ${whereClause}`,
              queryParams
            ).catch((e) => console.warn("[WARN] Reasignar vale MOB-029 a MOB-024:", e?.message || e));
          }
        } catch (errSillas) {
          console.warn("[WARN] Error procesando cambio de silla MOB-024/029:", errSillas?.message || errSillas);
        }

        // 3. ALTA DE OFICINA / DEPARTAMENTO "JEFATURA"
        try {
          // 3a. Asegurar en oficialias (id: 30030016)
          const [jefOfi] = await poolRead.query(
            `SELECT id FROM oficialias WHERE id = 30030016 OR UPPER(TRIM(nombre)) = 'JEFATURA' LIMIT 1`
          ).catch(() => [[]]);
          if (!jefOfi.length) {
            await poolOps.query(
              `INSERT INTO oficialias (id, id_tipo_oficialia, id_municipio, id_localidad, nombre, activo, oficial_reponsable, id_oficialia)
               VALUES (30030016, 0, 0, 0, 'Jefatura', b'1', 'Jefatura de Delegación', 30030016)`
            ).catch((e) => console.warn("[WARN] Insert oficialia Jefatura:", e?.message || e));
          }

          // 3b. Asegurar en oficinas_regionales para La Paz
          const [jefReg] = await poolRead.query(
            `SELECT id FROM oficinas_regionales WHERE (region_id = 1 OR region_id = ?) AND UPPER(TRIM(nombre)) = 'JEFATURA' LIMIT 1`,
            [regLaPazId || 1]
          ).catch(() => [[]]);
          if (!jefReg.length) {
            await poolOps.query(
              `INSERT INTO oficinas_regionales (region_id, municipio, nombre, responsable_oficina, activo)
               VALUES (?, 'La Paz', 'Jefatura', 'Jefatura de Delegación', 1)`,
              [regLaPazId || 1]
            ).catch((e) => console.warn("[WARN] Insert oficina regional Jefatura:", e?.message || e));
          }
        } catch (errJef) {
          console.warn("[WARN] Alta de Jefatura:", errJef?.message || errJef);
        }

        // Recalcular inventario con la lógica dual
        await repararInventarioBodegaDelegacionRM(poolOps);

        // Registrar migración completada
        await poolOps.query(
          `INSERT INTO configuracion_sistema (clave, valor) VALUES ('MIGRACION_FIX_TABLETAS_Y_MOB024_V1', '1')
           ON DUPLICATE KEY UPDATE valor = '1'`
        ).catch(() => {});

        console.log("[MIGRACION] MIGRACION_FIX_TABLETAS_Y_MOB024_V1 completada exitosamente.");
      }
    } catch (errMigFix) {
      console.warn("[WARN] MIGRACION_FIX_TABLETAS_Y_MOB024_V1:", errMigFix?.message || errMigFix);
    }

    // ========================================================================
    // MIGRACION_COORD_PCD_PAM_V1:
    // Actualizar responsables de Programa de Discapacidad (Anais Murillo Arce)
    // y Programa Adulto Mayor (Elizabeth Alvarez Trasviña) sin tocar psw.
    // ========================================================================
    try {
      const [[migCoordRow]] = await poolRead.query(
        `SELECT valor FROM configuracion_sistema WHERE clave = 'MIGRACION_COORD_PCD_PAM_V1' LIMIT 1`
      ).catch(() => [[]]);

      if (String(migCoordRow?.valor || "0").trim() !== "1") {
        const coordUpdates = [
          {
            username: "discapacidad",
            nombre: "Anais",
            primer_ap: "Murillo",
            segundo_ap: "Arce",
            fullName: "Anais Murillo Arce",
            ofiId: 30030014,
            ofiNombre: "Programa de Discapacidad",
            likePattern: "%DISCAPACIDAD%",
          },
          {
            username: "adultomayor",
            nombre: "Elizabeth",
            primer_ap: "Alvarez",
            segundo_ap: "Trasviña",
            fullName: "Elizabeth Alvarez Trasviña",
            ofiId: 30030007,
            ofiNombre: "Programa de Adulto Mayor",
            likePattern: "%ADULTO MAYOR%",
          },
        ];

        for (const c of coordUpdates) {
          // 1. Actualizar tabla usuario (sin tocar psw)
          await poolOps.query(
            `UPDATE usuario
             SET nombre = ?, PRIMER_APELLIDO = ?, SEGUNDO_APELLIDO = ?
             WHERE LOWER(TRIM(username)) = ?`,
            [c.nombre, c.primer_ap, c.segundo_ap, c.username]
          ).catch((e) => console.warn(`[MIGRACION_COORD_PCD_PAM_V1] usuario ${c.username}:`, e?.message || e));

          // 2. Actualizar tabla espejo usuarios si existe (sin tocar psw/password)
          await poolOps.query(
            `UPDATE usuarios
             SET nombre = ?, PRIMER_APELLIDO = ?, SEGUNDO_APELLIDO = ?
             WHERE LOWER(TRIM(username)) = ?`,
            [c.nombre, c.primer_ap, c.segundo_ap, c.username]
          ).catch(async () => {
            await poolOps.query(
              `UPDATE usuarios SET nombre = ? WHERE LOWER(TRIM(username)) = ?`,
              [c.fullName, c.username]
            ).catch(() => {});
          });

          // 3. Actualizar oficial_reponsable en oficialias
          await poolOps.query(
            `UPDATE oficialias
             SET oficial_reponsable = ?
             WHERE id = ? OR UPPER(TRIM(nombre)) LIKE ?`,
            [c.fullName, c.ofiId, c.likePattern]
          ).catch((e) => console.warn(`[MIGRACION_COORD_PCD_PAM_V1] oficialias ${c.ofiId}:`, e?.message || e));

          // 4. Asegurar y actualizar responsable / oficial_reponsable en departamentos
          await poolOps.query(
            `INSERT INTO departamentos (id, nombre, responsable)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE responsable = VALUES(responsable)`,
            [c.ofiId, c.ofiNombre, c.fullName]
          ).catch(() => {});
          await poolOps.query(
            `UPDATE departamentos
             SET responsable = ?
             WHERE id = ? OR UPPER(TRIM(nombre)) LIKE ?`,
            [c.fullName, c.ofiId, c.likePattern]
          ).catch(() => {});
          await poolOps.query(
            `UPDATE departamentos
             SET oficial_reponsable = ?
             WHERE id = ? OR UPPER(TRIM(nombre)) LIKE ?`,
            [c.fullName, c.ofiId, c.likePattern]
          ).catch(() => {});
        }

        await poolOps.query(
          `INSERT INTO configuracion_sistema (clave, valor) VALUES ('MIGRACION_COORD_PCD_PAM_V1', '1')
           ON DUPLICATE KEY UPDATE valor = '1'`
        ).catch(() => {});

        console.log("[MIGRACION] MIGRACION_COORD_PCD_PAM_V1 completada exitosamente.");
      }
    } catch (errCoord) {
      console.warn("[WARN] MIGRACION_COORD_PCD_PAM_V1:", errCoord?.message || errCoord);
    }

    SCHEMA_MIGRATED = true;
    return true;
  } catch (err) {
    console.warn("[WARN] ensureSchemaAndUsers:", err?.message || err);
    return false;
  }
}

// v44: Registro centralizado de auditoría y movimientos de almacén / inventario
async function registrarBitacora(reqOrUser, modulo, accion, detalles, dbHandle = poolOps) {
  try {
    let username = "SISTEMA";
    let nombreUsuario = "Sistema Automático";
    if (typeof reqOrUser === "string") {
      username = reqOrUser;
      nombreUsuario = reqOrUser;
    } else if (reqOrUser?.user) {
      username = reqOrUser.user.username || reqOrUser.user.usuario || "USUARIO";
      nombreUsuario = reqOrUser.user.nombre || reqOrUser.user.nombre_completo || username;
    } else if (reqOrUser?.username) {
      username = reqOrUser.username;
      nombreUsuario = reqOrUser.nombre || username;
    }

    const conn = dbHandle || poolOps;
    await conn.query(
      `INSERT INTO bitacora_movimientos (usuario, nombre_usuario, modulo, accion, detalles, fecha)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [username, nombreUsuario, String(modulo || "GENERAL").toUpperCase(), String(accion || "ACCION").toUpperCase(), String(detalles || "")]
    );
  } catch (err) {
    console.warn("[WARN] registrarBitacora error:", err?.message || err);
  }
}
const registrarMovimiento = registrarBitacora;

// v44: Lematizador y normalizador de raíces de búsqueda en español (acentos, -ces, vocal+s, -es)
function getSearchTokenRoots(queryStr) {
  if (!queryStr) return [];
  const normalized = String(queryStr)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  if (!normalized) return [];

  const tokens = normalized.split(/\s+/).filter(Boolean);
  const roots = [];

  for (const token of tokens) {
    if (!token) continue;
    const variants = new Set([token]);
    // 1. -ces -> -z / -c (ej: lapices -> lapiz, lapic)
    if (token.endsWith("ces") && token.length > 3) {
      variants.add(token.slice(0, -3) + "z");
      variants.add(token.slice(0, -3) + "c");
    }
    // 2. Consonante + es (ej: plumones -> plumon, papeles -> papel, colores -> color; sobres -> sobre)
    else if (token.length > 3 && /[^aeiou]es$/i.test(token)) {
      variants.add(token.slice(0, -2));
      variants.add(token.slice(0, -1));
    }
    // 3. Vocal + s (ej: sillas -> silla, carpetas -> carpeta, toldos -> toldo)
    else if (token.length > 2 && /[aeiou]s$/i.test(token)) {
      variants.add(token.slice(0, -1));
    }
    roots.push(Array.from(variants));
  }
  return roots;
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

function issueAuthSession(res, u) {
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

  return { token, payload };
}

// ============================================================================
// FASE 3: PROTECCIÓN CONTRA FUERZA BRUTA EN LOGIN (EN MEMORIA)
// Máximo 5 intentos fallidos en una ventana de 15 minutos por IP
// ============================================================================
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) return { allowed: true };
  if (now > record.resetAt) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  if (record.count >= LOGIN_MAX_ATTEMPTS) {
    const remainingMs = record.resetAt - now;
    const remainingMins = Math.max(1, Math.ceil(remainingMs / 60000));
    return { allowed: false, remainingMins };
  }
  return { allowed: true };
}

function recordLoginFailed(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    record.count += 1;
  }
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

async function handleLogin(req, res) {
  const { username, password } = req.body || {};
  // Obtener la IP del cliente (funciona en local, red LAN y tras proxy)
  const clientIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';

  // Verificar límite de intentos fallidos por IP (máximo 5 en 15 minutos)
  const rateLimit = checkLoginRateLimit(clientIp);
  if (!rateLimit.allowed) {
    return res.status(429).json({
      ok: false,
      error: `Demasiados intentos fallidos. Intenta de nuevo en ${rateLimit.remainingMins} minuto(s).`
    });
  }

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
      recordLoginFailed(clientIp);
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
      recordLoginFailed(clientIp);
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
      recordLoginFailed(clientIp);
      if (poolOps) {
        await poolOps.query(
          "INSERT INTO log_accesos (usuario_id, username, ip_address, exito) VALUES (?, ?, ?, FALSE)",
          [u.id, username, clientIp]
        ).catch(() => {});
      }
      return httpError(res, 401, "Usuario o contraseña inválidos");
    }

    // Login exitoso: limpiar contador de intentos fallidos
    clearLoginAttempts(clientIp);

    // Forzar cambio si la contraseña en texto plano coincide con la clave por defecto 'secreta123'
    if (String(password) === "secreta123") {
      return res.json({
        requirePasswordChange: true,
        userId: u.id,
        username: u.username,
      });
    }

    // Registrar inicio de sesión exitoso en la bitácora
    if (poolOps) {
      await poolOps.query(
        "INSERT INTO log_accesos (usuario_id, username, ip_address, exito) VALUES (?, ?, ?, TRUE)",
        [u.id, username, clientIp]
      ).catch(() => {});
    }

    const { token, payload } = issueAuthSession(res, u);
    res.json({ ok: true, token, user: payload });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
}

app.post("/api/auth/login", handleLogin);
app.post("/api/login", handleLogin);

app.post("/api/login/force-change", async (req, res) => {
  const { userId, newPassword } = req.body || {};
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || req.ip || '127.0.0.1';
  const uid = Number(userId);
  const cleanNewPass = String(newPassword || "").trim();

  if (!Number.isFinite(uid) || uid <= 0) {
    return httpError(res, 400, "userId inválido");
  }
  if (!cleanNewPass || cleanNewPass.length < 6) {
    return httpError(res, 400, "La nueva contraseña debe tener al menos 6 caracteres.");
  }
  if (cleanNewPass === "secreta123") {
    return httpError(res, 400, "La nueva contraseña no puede ser 'secreta123'.");
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
        WHERE u.id = ? LIMIT 1`,
        [uid]
      );
      rows = rWithRubro;
    } catch {
      const [rFallback] = await poolRead.query(
        `SELECT u.id, u.username, u.psw, u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO,
        u.ID_OFICIALIA, u.ACTIVO, COALESCE(u.departamento, 'USUARIO') AS rol, u.rubro_id
        FROM usuario u
        WHERE u.id = ? LIMIT 1`,
        [uid]
      );
      rows = rFallback;
    }

    if (!rows.length) {
      return httpError(res, 404, "Usuario no encontrado");
    }

    const u = rows[0];
    if (u.ACTIVO === 0 || u.ACTIVO === false) {
      return httpError(res, 403, "Usuario inactivo");
    }

    const stored = String(u.psw || "");
    const isStillDefault = stored.startsWith("$2")
      ? await bcrypt.compare("secreta123", stored)
      : stored === "secreta123";
    if (!isStillDefault) {
      return httpError(res, 403, "Esta cuenta ya no utiliza la contraseña temporal por defecto.");
    }

    const hashedPassword = await bcrypt.hash(cleanNewPass, 10);
    await poolOps.query("UPDATE usuario SET psw = ? WHERE id = ?", [hashedPassword, u.id]);
    await poolOps.query("UPDATE usuarios SET password = ? WHERE id = ?", [hashedPassword, u.id]).catch(async () => {
      await poolOps.query("UPDATE usuarios SET psw = ? WHERE id = ?", [hashedPassword, u.id]).catch(() => {});
    });

    if (poolOps) {
      await poolOps.query(
        "INSERT INTO log_accesos (usuario_id, username, ip_address, exito) VALUES (?, ?, ?, TRUE)",
        [u.id, u.username, clientIp]
      ).catch(() => {});
    }

    clearLoginAttempts(clientIp);
    const { token, payload } = issueAuthSession(res, u);
    return res.json({ ok: true, token, user: payload });
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
      nombre_completo: buildCleanFullName(r.nombre, r.PRIMER_APELLIDO, r.SEGUNDO_APELLIDO),
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
    const admin = isAdminDemo(req);
    const canAlmacen = hasAlmacenAccess(req);
    const isNormalUser = !admin && !canAlmacen;

    const { q = "", page = 1, limit = 500 } = req.query;
    const off = (Math.max(parseInt(page) || 1, 1) - 1) * (parseInt(limit) || 500);
    const like = `%${q}%`;
    const [rawRows] = await poolRead.query(
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
    const rows = isNormalUser
      ? rawRows.map((r) => ({
          ...r,
          stock: null,
          stock_almacen: null,
          exist_calc: null,
          cantidad_disponible: null,
          existencia: null,
          disponible: true,
        }))
      : rawRows;
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
COALESCE(s.es_prueba, 0) AS es_prueba,
COALESCE(s.inventario_descontado, 0) AS inventario_descontado,
(CASE WHEN (s.firma_solicitante_data IS NOT NULL AND s.firma_solicitante_data <> '') OR (s.firma_solicitante IS NOT NULL AND s.firma_solicitante <> '') THEN 1 ELSE 0 END) AS tiene_firma_digital
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
          u.cargo,
          u.licencia,
          u.vigencia_licencia,
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
          const cleanFull = buildCleanFullName(r.nombre, r.PRIMER_APELLIDO, r.SEGUNDO_APELLIDO) || r.nombre_completo || r.username || "";
          const areaNombre = String(r.oficialia_nombre || r.departamento || cleanFull || r.username || "").trim();
          return {
            ...r,
            nombre_completo: cleanFull,
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
        u.cargo,
        u.licencia,
        u.vigencia_licencia,
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
      const cleanFull = buildCleanFullName(r.nombre, r.PRIMER_APELLIDO, r.SEGUNDO_APELLIDO) || r.nombre_completo || r.username || "";
      const areaNombre = String(r.oficialia_nombre || r.departamento || cleanFull || r.username || "").trim();
      return {
        ...r,
        nombre_completo: cleanFull,
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

// Punto 8: Edición de perfil de usuario exclusiva para Administrador (soporta /api/usuarios/:id, /api/usuarios/:id/perfil y /api/admin/usuarios/:id)
app.put(["/api/usuarios/:id", "/api/usuarios/:id/perfil", "/api/admin/usuarios/:id"], authRequired, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return httpError(res, 403, "Acceso exclusivo para Administración para editar perfiles de usuarios.");
    }
    const rawParamId = Number(req.params.id);
    const userId = Number.isInteger(rawParamId) && rawParamId >= 0 ? rawParamId : 0;

    const {
      username,
      nombre,
      primer_apellido,
      segundo_apellido,
      cargo,
      licencia,
      vigencia_licencia,
      password,
      id_oficialia,
      departamento_id,
      region_id,
      oficina_id,
      rubro_id,
      rol,
      activo
    } = req.body || {};

    const cleanBodyUsername = String(username || "").trim().toLowerCase();
    if (userId <= 0 && !cleanBodyUsername) {
      return httpError(res, 400, "ID de usuario inválido.");
    }

    let existing = null;
    if (userId > 0) {
      const [rowsById] = await poolRead.query(
        `SELECT id, username, rol, nombre, PRIMER_APELLIDO, SEGUNDO_APELLIDO, ID_OFICIALIA, OFICIALIA_ID, departamento_id, region_id, oficina_id
         FROM usuario
         WHERE id = ? OR (id <= 0 AND LOWER(TRIM(username)) = ?)
         ORDER BY (id = ?) DESC
         LIMIT 1`,
        [userId, cleanBodyUsername, userId]
      );
      existing = rowsById && rowsById[0] ? rowsById[0] : null;
    } else if (cleanBodyUsername) {
      const [rowsByUser] = await poolRead.query(
        `SELECT id, username, rol, nombre, PRIMER_APELLIDO, SEGUNDO_APELLIDO, ID_OFICIALIA, OFICIALIA_ID, departamento_id, region_id, oficina_id
         FROM usuario
         WHERE (id = ? OR ((id <= 0 OR id IS NULL) AND LOWER(TRIM(username)) = ?)) OR LOWER(TRIM(username)) = ?
         ORDER BY (id <= 0 OR id IS NULL) DESC
         LIMIT 1`,
        [userId, cleanBodyUsername, cleanBodyUsername]
      );
      existing = rowsByUser && rowsByUser[0] ? rowsByUser[0] : null;
    }
    if (!existing) return httpError(res, 404, "Usuario no encontrado.");

    const existingUsername = String(existing.username || cleanBodyUsername || "").trim();
    let effectiveUserId = Number(existing.id || 0);
    const updates = [];
    const params = [];

    if (effectiveUserId <= 0) {
      const [[{ nextId }]] = await poolOps.query(`SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM usuario WHERE id > 0`);
      effectiveUserId = Number(nextId) || 1;
      updates.push("id = ?");
      params.push(effectiveUserId);
    }

    if (username !== undefined) {
      const cleanUsername = String(username || "").trim().toLowerCase();
      if (cleanUsername && cleanUsername !== String(existing.username || "").toLowerCase()) {
        const [dupU] = await poolRead.query(
          `SELECT id FROM usuario WHERE LOWER(TRIM(username)) = ? AND id <> ? LIMIT 1`,
          [cleanUsername, effectiveUserId]
        );
        if (dupU && dupU.length > 0) {
          return httpError(res, 400, `El nombre de usuario "${cleanUsername}" ya está en uso.`);
        }
        updates.push("username = ?");
        params.push(cleanUsername);
      }
    }

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
    if (cargo !== undefined) {
      updates.push("cargo = ?");
      params.push(cargo ? String(cargo).trim() : null);
    }
    if (licencia !== undefined) {
      updates.push("licencia = ?");
      params.push(licencia ? String(licencia).trim() : null);
    }
    if (vigencia_licencia !== undefined) {
      updates.push("vigencia_licencia = ?");
      params.push(vigencia_licencia ? String(vigencia_licencia).trim() : null);
    }
    if (password && String(password).trim().length > 0) {
      const hashed = await bcrypt.hash(String(password).trim(), 10);
      updates.push("psw = ?");
      params.push(hashed);
    }

    // Departamento / Oficialía
    const rawOfiId = departamento_id !== undefined ? departamento_id : id_oficialia;
    let ofiNombre = null;
    let ofiNum = null;
    if (rawOfiId !== undefined) {
      ofiNum = Number(rawOfiId) || null;
      updates.push("ID_OFICIALIA = ?");
      params.push(ofiNum);
      updates.push("OFICIALIA_ID = ?");
      params.push(ofiNum);
      updates.push("departamento_id = ?");
      params.push(ofiNum);

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

    let finalRegNum = existing.region_id;
    if (region_id !== undefined) {
      const regNum = Number(region_id) || null;
      updates.push("region_id = ?");
      params.push(regNum);
      finalRegNum = regNum;
    }
    let finalOfiRegNum = existing.oficina_id;
    if (oficina_id !== undefined) {
      const ofiRegNum = Number(oficina_id) || null;
      updates.push("oficina_id = ?");
      params.push(ofiRegNum);
      finalOfiRegNum = ofiRegNum;
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

    const origId = Number(existing.id || 0);
    await poolOps.query(
      `UPDATE usuario SET ${updates.join(", ")} WHERE (id = ? AND ? > 0) OR (id <= 0 AND username = ?) LIMIT 1`,
      [...params, origId, origId, existingUsername]
    );

    // Calcular nombre completo limpio (sin duplicar apellidos) para sincronización
    const cleanNombre = nombre !== undefined ? String(nombre || "").trim() : String(existing.nombre || "").trim();
    const cleanAp1 = primer_apellido !== undefined ? String(primer_apellido || "").trim() : String(existing.PRIMER_APELLIDO || "").trim();
    const cleanAp2 = segundo_apellido !== undefined ? String(segundo_apellido || "").trim() : String(existing.SEGUNDO_APELLIDO || "").trim();
    const fullName = buildCleanFullName(cleanNombre, cleanAp1, cleanAp2);
    const cleanCargo = cargo !== undefined ? String(cargo || "").trim() : null;
    const nameWasEdited = nombre !== undefined || primer_apellido !== undefined || segundo_apellido !== undefined;

    // Sincronizar en tabla usuarios si existe
    await poolOps.query(
      `UPDATE usuarios SET ${updates.join(", ")} WHERE (id = ? AND ? > 0) OR (id <= 0 AND username = ?) LIMIT 1`,
      [...params, origId, origId, existingUsername]
    ).catch(async () => {
      if (fullName && nameWasEdited) {
        await poolOps.query(
          `UPDATE usuarios SET nombre = ? WHERE (id = ? AND ? > 0) OR LOWER(TRIM(username)) = LOWER(?) LIMIT 1`,
          [fullName, origId, origId, existingUsername]
        ).catch(() => {});
      }
    });

    // Sincronizar nombre/cargo con oficialias, departamentos, regiones y oficinas si aplica
    const effectiveRolLower = String(rol || existing.rol || "").trim().toLowerCase();
    const isRegionalUser =
      effectiveRolLower === "regional" ||
      ["loscabos", "comondu", "mulege", "guerreronegro", "direccionregional"].includes(existingUsername.toLowerCase());

    if (fullName && (nameWasEdited || rawOfiId !== undefined)) {
      const finalOfiId = ofiNum || existing.ID_OFICIALIA || existing.OFICIALIA_ID || existing.departamento_id || null;
      if (finalOfiId) {
        await poolOps.query(
          `UPDATE oficialias SET oficial_reponsable = ? WHERE id = ?`,
          [fullName, finalOfiId]
        ).catch(() => {});
        await poolOps.query(
          `UPDATE departamentos SET responsable = ? WHERE id = ?`,
          [fullName, finalOfiId]
        ).catch(() => {});
        await poolOps.query(
          `UPDATE departamentos SET oficial_reponsable = ? WHERE id = ?`,
          [fullName, finalOfiId]
        ).catch(() => {});
      }
      if (finalRegNum && isRegionalUser) {
        await poolOps.query(
          `UPDATE regiones SET titular = ?, cargo_titular = COALESCE(?, cargo_titular, 'Director Regional') WHERE id = ?`,
          [fullName, cleanCargo, finalRegNum]
        ).catch(() => {});
      }
      if (finalOfiRegNum && isRegionalUser) {
        await poolOps.query(`UPDATE oficinas_regionales SET responsable = ? WHERE id = ?`, [fullName, finalOfiRegNum]).catch(() => {});
      }
    } else if (cleanCargo && finalRegNum && isRegionalUser) {
      await poolOps.query(`UPDATE regiones SET cargo_titular = ? WHERE id = ?`, [cleanCargo, finalRegNum]).catch(() => {});
    }

    invalidateUserScope(effectiveUserId);

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
        u.cargo,
        u.licencia,
        u.vigencia_licencia,
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
      [effectiveUserId]
    );

    const updatedUser = updatedRows && updatedRows[0] ? {
      ...updatedRows[0],
      nombre_completo: buildCleanFullName(updatedRows[0].nombre, updatedRows[0].PRIMER_APELLIDO, updatedRows[0].SEGUNDO_APELLIDO) || updatedRows[0].nombre_completo || updatedRows[0].username,
      rol: normalizeRol(updatedRows[0].rol, updatedRows[0].username),
      oficialia_nombre: updatedRows[0].oficialia_nombre || updatedRows[0].departamento || null,
      area_nombre: String(updatedRows[0].oficialia_nombre || updatedRows[0].departamento || buildCleanFullName(updatedRows[0].nombre, updatedRows[0].PRIMER_APELLIDO, updatedRows[0].SEGUNDO_APELLIDO) || updatedRows[0].username || "").trim(),
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

// v42/v60: Crear nuevo usuario con asignación explícita de ID consecutivo (CRUD Usuarios - Admin)
app.post(["/api/usuarios", "/api/admin/usuarios"], authRequired, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return httpError(res, 403, "Acceso exclusivo para Administración para crear usuarios.");
    }

    const {
      username,
      password,
      nombre,
      primer_apellido,
      segundo_apellido,
      cargo,
      licencia,
      vigencia_licencia,
      id_oficialia,
      departamento_id,
      region_id,
      oficina_id,
      rubro_id,
      rol,
      activo
    } = req.body || {};

    const cleanUsername = String(username || "").trim().toLowerCase();
    if (!cleanUsername) {
      return httpError(res, 400, "El nombre de usuario (login) es obligatorio.");
    }
    if (!password || String(password).trim().length === 0) {
      return httpError(res, 400, "La contraseña inicial es obligatoria para nuevos usuarios.");
    }
    const cleanNombre = String(nombre || "").trim();
    if (!cleanNombre) {
      return httpError(res, 400, "El nombre es obligatorio.");
    }

    // Verificar si el username ya existe
    const [existRows] = await poolRead.query(
      `SELECT id FROM usuario WHERE LOWER(TRIM(username)) = ? LIMIT 1`,
      [cleanUsername]
    );
    if (existRows && existRows.length > 0) {
      return httpError(res, 400, `El usuario "${cleanUsername}" ya existe en el sistema.`);
    }

    const hashedPassword = await bcrypt.hash(String(password).trim(), 10);
    const rolNorm = normalizeRol(rol || "USUARIO", cleanUsername);

    const rawOfiId = departamento_id !== undefined && departamento_id !== null ? departamento_id : id_oficialia;
    const ofiNum = Number(rawOfiId) || null;
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

    const regNum = region_id !== undefined && region_id !== null && region_id !== "" ? Number(region_id) || null : null;
    const ofiRegNum = oficina_id !== undefined && oficina_id !== null && oficina_id !== "" ? Number(oficina_id) || null : null;
    const rubNum = rubro_id !== undefined && rubro_id !== null && rubro_id !== "" ? Number(rubro_id) || null : null;
    const cleanCargo = cargo ? String(cargo).trim() : null;
    const cleanLic = licencia ? String(licencia).trim() : null;
    const cleanVigLic = vigencia_licencia ? String(vigencia_licencia).trim() : null;
    const cleanAp1 = primer_apellido ? String(primer_apellido).trim() : null;
    const cleanAp2 = segundo_apellido ? String(segundo_apellido).trim() : null;
    const isActivo = activo !== undefined ? (activo ? 1 : 0) : 1;

    // v60: Calcular explícitamente el siguiente ID consecutivo para evitar usuarios con id = 0
    const [[{ nextId }]] = await poolOps.query(
      `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM usuario WHERE id > 0`
    );
    const newUserId = Number(nextId) || 1;

    await poolOps.query(
      `INSERT INTO usuario
         (id, username, psw, nombre, PRIMER_APELLIDO, SEGUNDO_APELLIDO, rol, cargo, licencia, vigencia_licencia,
          ID_OFICIALIA, OFICIALIA_ID, departamento_id, departamento, region_id, oficina_id, rubro_id, ACTIVO)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newUserId,
        cleanUsername,
        hashedPassword,
        cleanNombre,
        cleanAp1,
        cleanAp2,
        rolNorm,
        cleanCargo,
        cleanLic,
        cleanVigLic,
        ofiNum,
        ofiNum,
        ofiNum,
        ofiNombre,
        regNum,
        ofiRegNum,
        rubNum,
        isActivo
      ]
    );

    // Sincronizar en tabla usuarios si existe
    await poolOps.query(
      `INSERT INTO usuarios (id, username, password, nombre, rol, cargo, licencia, vigencia_licencia, ID_OFICIALIA, OFICIALIA_ID, departamento, region_id, oficina_id, rubro_id, ACTIVO)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         username = VALUES(username), password = VALUES(password), nombre = VALUES(nombre),
         rol = VALUES(rol), cargo = VALUES(cargo), licencia = VALUES(licencia), vigencia_licencia = VALUES(vigencia_licencia),
         ID_OFICIALIA = VALUES(ID_OFICIALIA), OFICIALIA_ID = VALUES(OFICIALIA_ID), departamento = VALUES(departamento),
         region_id = VALUES(region_id), oficina_id = VALUES(oficina_id), rubro_id = VALUES(rubro_id), ACTIVO = VALUES(ACTIVO)`,
      [
        newUserId, cleanUsername, hashedPassword, cleanNombre, rolNorm, cleanCargo, cleanLic, cleanVigLic,
        ofiNum, ofiNum, ofiNombre, regNum, ofiRegNum, rubNum, isActivo
      ]
    ).catch(() => {});

    // Sincronizar nombre/cargo con oficialias, departamentos, regiones y oficinas si aplica
    const fullName = buildCleanFullName(cleanNombre, cleanAp1, cleanAp2);
    const isRegionalNew = String(rol || "").trim().toLowerCase() === "regional";
    if (ofiNum && fullName) {
      await poolOps.query(`UPDATE oficialias SET oficial_reponsable = ? WHERE id = ?`, [fullName, ofiNum]).catch(() => {});
      await poolOps.query(`UPDATE departamentos SET responsable = ? WHERE id = ?`, [fullName, ofiNum]).catch(() => {});
      await poolOps.query(`UPDATE departamentos SET oficial_reponsable = ? WHERE id = ?`, [fullName, ofiNum]).catch(() => {});
    }
    if (regNum && isRegionalNew && (cleanCargo || fullName)) {
      await poolOps.query(
        `UPDATE regiones SET titular = ?, cargo_titular = ? WHERE id = ?`,
        [fullName || cleanNombre, cleanCargo || "Director Regional", regNum]
      ).catch(() => {});
    }
    if (ofiRegNum && isRegionalNew && (cleanCargo || fullName)) {
      await poolOps.query(`UPDATE oficinas_regionales SET responsable = ? WHERE id = ?`, [fullName || cleanNombre, ofiRegNum]).catch(() => {});
    }

    return res.status(201).json({
      ok: true,
      message: "Usuario creado exitosamente.",
      id: newUserId,
      user: {
        id: newUserId,
        username: cleanUsername,
        nombre: cleanNombre,
        nombre_completo: fullName,
        rol: rolNorm,
        cargo: cleanCargo,
        licencia: cleanLic,
        vigencia_licencia: cleanVigLic,
        region_id: regNum,
        oficina_id: ofiRegNum,
        rubro_id: rubNum,
        id_oficialia: ofiNum,
        departamento: ofiNombre,
        activo: isActivo
      }
    });
  } catch (e) {
    return httpError(res, e.statusCode || 500, e.message);
  }
});

// v42/v60: Eliminar usuario (CRUD Usuarios - Admin) con soporte de respaldo por username si id = 0
app.delete(["/api/usuarios/:id", "/api/admin/usuarios/:id"], authRequired, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return httpError(res, 403, "Acceso exclusivo para Administración para eliminar usuarios.");
    }
    const rawParamId = Number(req.params.id);
    const userId = Number.isInteger(rawParamId) && rawParamId >= 0 ? rawParamId : 0;
    const targetUsername = String(req.query?.username || req.body?.username || "").trim().toLowerCase();

    if (userId <= 0 && !targetUsername) {
      return httpError(res, 400, "ID de usuario inválido.");
    }

    if ((userId > 0 && Number(req.user?.id) === userId) || (targetUsername && String(req.user?.username || "").trim().toLowerCase() === targetUsername)) {
      return httpError(res, 400, "No puedes eliminar tu propio usuario de sesión activa.");
    }

    let existing = null;
    if (userId > 0) {
      const [rowsById] = await poolRead.query(
        `SELECT id, username FROM usuario WHERE id = ? OR (id <= 0 AND LOWER(TRIM(username)) = ?) ORDER BY (id = ?) DESC LIMIT 1`,
        [userId, targetUsername, userId]
      );
      existing = rowsById && rowsById[0] ? rowsById[0] : null;
    } else if (targetUsername) {
      const [rowsByUser] = await poolRead.query(
        `SELECT id, username FROM usuario WHERE (id = ? AND LOWER(TRIM(username)) = ?) OR LOWER(TRIM(username)) = ? ORDER BY (id <= 0) DESC LIMIT 1`,
        [userId, targetUsername, targetUsername]
      );
      existing = rowsByUser && rowsByUser[0] ? rowsByUser[0] : null;
    }

    if (!existing) {
      return httpError(res, 404, "Usuario no encontrado.");
    }

    const effId = Number(existing.id || 0);
    const effUsername = String(existing.username || targetUsername || "").trim();

    try {
      await poolOps.query(
        `DELETE FROM usuario WHERE (id = ? AND ? > 0) OR (id <= 0 AND username = ?) LIMIT 1`,
        [effId, effId, effUsername]
      );
      await poolOps.query(
        `DELETE FROM usuarios WHERE (id = ? AND ? > 0) OR (id <= 0 AND username = ?) LIMIT 1`,
        [effId, effId, effUsername]
      ).catch(() => {});
    } catch (foreignErr) {
      // Si tiene claves foráneas (pedidos, vales, etc.), desactivar usuario en vez de fallar
      await poolOps.query(
        `UPDATE usuario SET ACTIVO = 0 WHERE (id = ? AND ? > 0) OR (id <= 0 AND username = ?) LIMIT 1`,
        [effId, effId, effUsername]
      );
      await poolOps.query(
        `UPDATE usuarios SET ACTIVO = 0 WHERE (id = ? AND ? > 0) OR (id <= 0 AND username = ?) LIMIT 1`,
        [effId, effId, effUsername]
      ).catch(() => {});
      invalidateUserScope(effId);
      return res.json({
        ok: true,
        message: `El usuario "${existing.username}" tiene registros históricos vinculados y ha sido dado de baja (inactivo) correctamente.`,
        deactivated: true
      });
    }

    invalidateUserScope(effId);
    return res.json({
      ok: true,
      message: `Usuario "${existing.username}" eliminado correctamente.`
    });
  } catch (e) {
    return httpError(res, e.statusCode || 500, e.message);
  }
});

// ============================================================================
// v42: AUTO-ACTUALIZACIÓN Y MONITOR DE SESIONES ACTIVAS (HEARTBEAT)
// ============================================================================
const activeSessions = new Map();

app.post("/api/ping", authRequired, (req, res) => {
  const u = req.user || {};
  const username = String(u.username || "anon").trim().toLowerCase();
  const nombre = u.nombre_completo || [u.nombre, u.primer_apellido, u.segundo_apellido].filter(Boolean).join(" ") || u.nombre || username;
  const rol = normalizeRol(u.rol, username);

  activeSessions.set(username, {
    username,
    nombre,
    rol,
    ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || req.ip || "127.0.0.1",
    timestamp: Date.now()
  });

  return res.json({
    ok: true,
    version: 62,
    timestamp: Date.now(),
    username
  });
});

app.get("/api/system-status", authRequired, (req, res) => {
  const uRol = String(req.user?.rol || "").trim().toUpperCase();
  const uName = String(req.user?.username || "").trim().toLowerCase();
  if (uRol !== "ADMIN" && uName !== "admin") {
    return httpError(res, 403, "Acceso restringido a administradores");
  }

  const now = Date.now();
  const THREE_MINUTES = 3 * 60 * 1000;
  const activeList = [];

  for (const [key, session] of activeSessions.entries()) {
    if (now - session.timestamp <= THREE_MINUTES) {
      activeList.push({
        username: session.username,
        nombre: session.nombre,
        rol: session.rol,
        lastSeen: session.timestamp
      });
    } else {
      activeSessions.delete(key);
    }
  }

  return res.json({
    ok: true,
    version: 62,
    onlineCount: activeList.length,
    activeUsers: activeList
  });
});

// ============================================================================
// v61: CONTROL DE FASE DE PRUEBA GRUPAL Y PURGA DE REGISTROS DE PRUEBA (ADMIN)
// ============================================================================
app.get("/api/admin/modo-prueba", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    const activo = await isModoPruebaGrupalActivo();
    return res.json({ ok: true, modoPruebaGrupal: activo, valor: activo ? "1" : "0" });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

app.put("/api/admin/modo-prueba", authRequired, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return httpError(res, 403, "Solo el Administrador puede cambiar el Modo de Prueba Grupal.");
    }
    await ensureSchemaAndUsers();
    let nuevoValor;
    if (req.body && req.body.activo !== undefined) {
      nuevoValor = Boolean(req.body.activo && String(req.body.activo) !== "0" && String(req.body.activo).toLowerCase() !== "false") ? "1" : "0";
    } else {
      const actual = await isModoPruebaGrupalActivo();
      nuevoValor = actual ? "0" : "1";
    }

    await poolOps.query(
      `INSERT INTO configuracion_sistema (clave, valor) VALUES ('MODO_PRUEBA_GRUPAL', ?)
       ON DUPLICATE KEY UPDATE valor = ?`,
      [nuevoValor, nuevoValor]
    );
    const activo = nuevoValor === "1";
    await registrarBitacora(
      req,
      "SISTEMA",
      activo ? "ACTIVAR_MODO_PRUEBA" : "DESACTIVAR_MODO_PRUEBA",
      `Modo de Prueba Grupal ${activo ? "ACTIVADO (cero afectación a inventarios)" : "DESACTIVADO (Modo Operación Real)"}.`
    );
    return res.json({
      ok: true,
      modoPruebaGrupal: activo,
      valor: nuevoValor,
      message: activo
        ? "🧪 Fase de Prueba Grupal ACTIVADA. Las nuevas solicitudes y vales no descontarán inventario."
        : "✅ Modo Operación Real ACTIVADO. Las solicitudes completadas y vales reales afectarán inventario."
    });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

app.delete("/api/admin/purgar-pruebas", authRequired, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return httpError(res, 403, "Solo el Administrador puede purgar registros de prueba.");
    }
    await ensureSchemaAndUsers();
    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      // Asegurar que el Vale #3 de Víctor Huerta NUNCA sea marcado como prueba antes de borrar
      await conn.query(
        `UPDATE vales_prestamo
         SET es_prueba = 0
         WHERE id = 3
            OR LOWER(COALESCE(solicitante_nombre, '')) LIKE '%victor%huerta%'
            OR LOWER(COALESCE(solicitante_nombre, '')) LIKE '%víctor%huerta%'
            OR LOWER(COALESCE(recibe_nombre, '')) LIKE '%victor%huerta%'
            OR LOWER(COALESCE(recibe_nombre, '')) LIKE '%víctor%huerta%'`
      );

      // 1. Eliminar detalles y cabeceras de solicitudes de prueba
      const [delDetSol] = await conn.query(
        `DELETE ds FROM detalles_solicitud ds
         INNER JOIN solicitudes s ON s.id = ds.solicitud_id
         WHERE COALESCE(s.es_prueba, 0) = 1`
      );
      const [delSol] = await conn.query(
        `DELETE FROM solicitudes WHERE COALESCE(es_prueba, 0) = 1`
      );

      // 2. Eliminar detalles y cabeceras de vales_prestamo de prueba (protegiendo explícitamente el Vale #3 de Víctor Huerta)
      const [delDetVp] = await conn.query(
        `DELETE vpd FROM vales_prestamo_detalle vpd
         INNER JOIN vales_prestamo vp ON vp.id = vpd.vale_id
         WHERE COALESCE(vp.es_prueba, 0) = 1
           AND vp.id <> 3
           AND LOWER(COALESCE(vp.solicitante_nombre, '')) NOT LIKE '%victor%huerta%'
           AND LOWER(COALESCE(vp.solicitante_nombre, '')) NOT LIKE '%víctor%huerta%'`
      );
      const [delVp] = await conn.query(
        `DELETE FROM vales_prestamo
         WHERE COALESCE(es_prueba, 0) = 1
           AND id <> 3
           AND LOWER(COALESCE(solicitante_nombre, '')) NOT LIKE '%victor%huerta%'
           AND LOWER(COALESCE(solicitante_nombre, '')) NOT LIKE '%víctor%huerta%'`
      );

      await conn.commit();

      const solBorradas = Number(delSol?.affectedRows || 0);
      const vpBorrados = Number(delVp?.affectedRows || 0);

      await registrarBitacora(
        req,
        "SISTEMA",
        "PURGAR_PRUEBAS",
        `Purga de registros de prueba ejecutada: ${solBorradas} solicitudes y ${vpBorrados} vales provisionales eliminados (Vale #3 de Víctor Huerta preservado).`
      );

      return res.json({
        ok: true,
        solicitudes_eliminadas: solBorradas,
        detalles_solicitud_eliminados: Number(delDetSol?.affectedRows || 0),
        vales_eliminados: vpBorrados,
        detalles_vales_eliminados: Number(delDetVp?.affectedRows || 0),
        message: `🧹 Purga completada: ${solBorradas} solicitudes de prueba y ${vpBorrados} vales de prueba eliminados. El Vale #3 de Víctor Huerta se conservó intacto.`
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

// ============================================================================
// v44: CONSULTA DE BITÁCORA DE MOVIMIENTOS DEL INVENTARIO (ADMINISTRADOR)
// ============================================================================
app.get("/api/bitacora", authRequired, async (req, res) => {
  try {
    if (!isAdmin(req) && !isAuditorBlockedUser(req)) {
      return httpError(res, 403, "Solo el Administrador o Auditores (Jorge Patrón / Rodrigo Molina) pueden consultar la bitácora de movimientos.");
    }
    const { q = "", fecha = "", modulo = "", limit = 500 } = req.query;
    const lim = Math.min(Math.max(parseInt(limit) || 500, 1), 1000);

    let whereSql = "WHERE 1=1";
    const params = [];

    if (modulo && String(modulo).trim()) {
      whereSql += " AND UPPER(TRIM(modulo)) = ?";
      params.push(String(modulo).trim().toUpperCase());
    }
    if (fecha) {
      whereSql += " AND DATE(fecha) = ?";
      params.push(fecha);
    }
    if (q && q.trim()) {
      const like = `%${q.trim()}%`;
      whereSql += " AND (usuario LIKE ? OR nombre_usuario LIKE ? OR modulo LIKE ? OR accion LIKE ? OR detalles LIKE ?)";
      params.push(like, like, like, like, like);
    }

    params.push(lim);
    const [rows] = await poolRead.query(
      `SELECT id, usuario, nombre_usuario, modulo, accion, detalles, fecha
       FROM bitacora_movimientos
       ${whereSql}
       ORDER BY fecha DESC, id DESC
       LIMIT ?`,
      params
    );
    return res.json({ ok: true, data: rows });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al obtener bitácora");
  }
});

// ============================================================================
// v52: VISOR RÁPIDO DE BITÁCORA - RECUPERACIÓN DE CLAVES HOMOLOGADAS (ADMIN)
// ============================================================================
app.get("/api/ver-bitacora", authRequired, async (req, res) => {
  try {
    const rolNorm = String(req.user?.rol || "").trim().toLowerCase();
    const isUserAdmin = isAdmin(req) || rolNorm === "admin" || String(req.user?.username || "").toLowerCase() === "admin";
    if (!isUserAdmin) {
      return res.status(403).send("<h1>403 Acceso Denegado</h1><p>Solo el Administrador puede consultar este registro de bitácora.</p>");
    }

    const [rows] = await poolRead.query(
      `SELECT * FROM bitacora_movimientos WHERE accion = 'HOMOLOGAR_CLAVES' ORDER BY id DESC LIMIT 500`
    );

    function esc(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    let rowsHtml = "";
    if (!rows || rows.length === 0) {
      rowsHtml = `<tr><td colspan="4" style="text-align:center; padding:16px; color:#64748b;">No hay registros de homologación de claves en la bitácora.</td></tr>`;
    } else {
      rowsHtml = rows.map((r) => {
        const fechaStr = r.fecha ? new Date(r.fecha).toLocaleString("es-MX", { timeZone: "America/Mazatlan" }) : "-";
        const usuarioStr = esc(r.usuario_id || r.usuario || r.nombre_usuario || "admin");
        const accionStr = esc(r.accion || "HOMOLOGAR_CLAVES");
        const detallesStr = esc(r.detalles || "").replace(/\n/g, "<br>");
        return `<tr>
          <td style="white-space:nowrap; vertical-align:top; padding:8px 12px;">${fechaStr}</td>
          <td style="white-space:nowrap; vertical-align:top; padding:8px 12px; font-weight:bold;">${usuarioStr}</td>
          <td style="white-space:nowrap; vertical-align:top; padding:8px 12px;"><span style="background:#e0f2fe; color:#0369a1; padding:2px 6px; border-radius:4px; font-size:12px; font-weight:bold;">${accionStr}</span></td>
          <td style="vertical-align:top; padding:8px 12px; font-family:monospace; font-size:13px; line-height:1.5;">${detallesStr}</td>
        </tr>`;
      }).join("\n");
    }

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Visor de Bitácora - Homologación de Claves</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#f8fafc; color:#1e293b; margin:20px; padding:0; }
    .container { max-width: 1200px; margin: 0 auto; background: #ffffff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 24px; }
    h1 { margin-top:0; font-size: 22px; color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; }
    p.meta { color: #64748b; font-size: 14px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th { background: #f1f5f9; color: #334155; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 12px; text-align: left; border: 1px solid #cbd5e1; }
    td { border: 1px solid #e2e8f0; }
    tr:nth-child(even) { background: #f8fafc; }
    tr:hover { background: #f1f5f9; }
    .btn { display: inline-block; padding: 6px 14px; background: #0284c7; color: #fff; text-decoration: none; border-radius: 6px; font-size: 13px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <h1>📋 Visor de Bitácora: Homologación y Recuperación de Claves</h1>
      <a href="/dashboard.html" class="btn">⬅ Volver al Panel</a>
    </div>
    <p class="meta">Mostrando los últimos 500 registros con acción <b>HOMOLOGAR_CLAVES</b>. Permite identificar qué clave anterior fue reemplazada por la nueva.</p>
    <table border="1">
      <thead>
        <tr>
          <th>fecha</th>
          <th>usuario_id</th>
          <th>accion</th>
          <th>detalles</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  </div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (e) {
    return res.status(500).send(`<h1>Error al consultar bitácora</h1><p>${e.message}</p>`);
  }
});

// ============================================================================
// v42: EXPORTACIÓN Y DESCARGA DE RESPALDO DE BASE DE DATOS (BACKUP DUMP .SQL)
// ============================================================================
app.get("/api/backup-db", authRequired, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return httpError(res, 403, "Acceso denegado: solo el Administrador puede descargar respaldos de base de datos.");
    }

    const conn = await poolRead.getConnection();
    try {
      const [tableRows] = await conn.query(`SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'`);
      const tableKey = Object.keys(tableRows[0] || {})[0];
      const tables = tableRows.map((r) => r[tableKey]).filter(Boolean);

      const now = new Date();
      const isoDate = now.toISOString().replace(/[:.]/g, "-");
      let sqlDump = `-- ====================================================================\n`;
      sqlDump += `-- RESPALDO AUTOMÁTICO DE BASE DE DATOS - SISTEMA DE INVENTARIO V42\n`;
      sqlDump += `-- FECHA DE GENERACIÓN: ${now.toISOString()}\n`;
      sqlDump += `-- GENERADO POR: ${req.user?.username || "admin"}\n`;
      sqlDump += `-- TABLAS TOTALES: ${tables.length}\n`;
      sqlDump += `-- ====================================================================\n\n`;
      sqlDump += `SET NAMES utf8mb4;\n`;
      sqlDump += `SET FOREIGN_KEY_CHECKS = 0;\n`;
      sqlDump += `SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\n\n`;

      for (const table of tables) {
        const [[createRow]] = await conn.query(`SHOW CREATE TABLE \`${table}\``);
        const createTableSql = createRow ? (createRow["Create Table"] || createRow[Object.keys(createRow)[1]]) : "";

        sqlDump += `--\n-- Estructura de tabla para la tabla \`${table}\`\n--\n`;
        sqlDump += `DROP TABLE IF EXISTS \`${table}\`;\n`;
        if (createTableSql) {
          sqlDump += `${createTableSql};\n\n`;
        }

        const [rows] = await conn.query(`SELECT * FROM \`${table}\``);
        if (rows && rows.length > 0) {
          sqlDump += `-- Volcado de datos para la tabla \`${table}\` (${rows.length} registros)\n`;
          const cols = Object.keys(rows[0]);
          const colList = cols.map((c) => `\`${c}\``).join(", ");

          const CHUNK_SIZE = 100;
          for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            const chunk = rows.slice(i, i + CHUNK_SIZE);
            const valuesSql = chunk.map((r) => {
              const vals = cols.map((col) => {
                const val = r[col];
                if (val === null || val === undefined) return "NULL";
                if (Buffer.isBuffer(val)) return `0x${val.toString("hex")}`;
                if (typeof val === "boolean") return val ? "1" : "0";
                if (typeof val === "number") return String(val);
                if (val instanceof Date) {
                  return conn.escape(val.toISOString().slice(0, 19).replace("T", " "));
                }
                return conn.escape(val);
              });
              return `(${vals.join(", ")})`;
            }).join(",\n  ");

            sqlDump += `INSERT INTO \`${table}\` (${colList}) VALUES\n  ${valuesSql};\n`;
          }
          sqlDump += "\n";
        }
      }

      sqlDump += `SET FOREIGN_KEY_CHECKS = 1;\n`;
      sqlDump += `-- FIN DEL RESPALDO V42 --\n`;

      res.setHeader("Content-Type", "application/sql; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="respaldo_inventario_${isoDate}.sql"`);
      return res.send(sqlDump);
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error("[ERROR] Generando respaldo de BD:", e);
    return httpError(res, 500, e.message || "Error al generar respaldo de base de datos.");
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
    let rows = [];
    try {
      const [r] = await poolRead.query(
        `SELECT o.id, o.${qi(nameCol)} AS nombre,
                COALESCE(NULLIF(TRIM(o.oficial_reponsable), ''), NULLIF(TRIM(d.responsable), '')) AS oficial_reponsable
         FROM oficialias o
         LEFT JOIN departamentos d ON d.id = o.id
         WHERE o.activo IS NULL OR o.activo = 1 OR o.activo = b'1'
         ORDER BY o.${qi(nameCol)} ASC
         LIMIT 500`
      );
      rows = r;
    } catch {
      const [r] = await poolRead.query(
        `SELECT id, ${qi(nameCol)} AS nombre, oficial_reponsable
         FROM oficialias
         WHERE activo IS NULL OR activo = 1 OR activo = b'1'
         ORDER BY ${qi(nameCol)} ASC
         LIMIT 500`
      );
      rows = r;
    }

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

app.get(["/api/reportes", "/api/graficas"], authRequired, async (req, res) => {
  const uName = normalizeUser(req.user?.username);
  if (uName === "gabrielfiol" || uName === "fiol" || !canViewReportes(req)) {
    return httpError(res, 403, "No tienes permiso para ver reportes o gráficas");
  }
  return res.json({ ok: true, data: [] });
});

app.get("/api/reportes/oficialias", authRequired, async (req, res) => {
try {
const uName = normalizeUser(req.user?.username);
if (uName === "gabrielfiol" || uName === "fiol" || !canViewReportes(req)) {
  return httpError(res, 403, "No tienes permiso para ver reportes");
}

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
base.firma_solicitante = base.firma_solicitante || base.firma_solicitante_data || null;
base.firma_solicitante_data = base.firma_solicitante_data || base.firma_solicitante || null;
base.tiene_firma_digital = Boolean(base.firma_solicitante || base.firma_solicitante_data || base.folio_firma_digital);
base.es_prueba = Number(base.es_prueba || 0);
base.inventario_descontado = Number(base.inventario_descontado || 0);
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
            d.cantidad, d.cantidad_surtida, d.atendida, d.observaciones
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

const [fallback] = await poolRead.query(
`SELECT d.id AS detalle_id,
d.solicitud_id,
d.producto_id,
p.CLAVE,
p.DESCRIPCION,
p.unidad AS unidad,
p.categoria AS categoria,
d.cantidad,
d.cantidad_surtida,
d.atendida,
d.observaciones
FROM detalles_solicitud d
LEFT JOIN productos p ON p.${await detectProductosPK()} = d.producto_id
WHERE d.solicitud_id = ?
ORDER BY d.id`,
[sid]
);
rows = fallback;

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

// ============================================================================
// FASE 3: DETECCIÓN DE REGIONES FORÁNEAS (FIRMA DIGITAL OBLIGATORIA)
// ============================================================================
function isRegionForaneaObligatoriaFirma(regionStr) {
  if (!regionStr) return false;
  const normStr = String(regionStr)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ");
  return normStr.includes("los cabos") || normStr.includes("mulege") || normStr.includes("comondu");
}

function isAuthenticatedUserRegionalForaneo(req, scope = null) {
  const uRol = normalizeRol(req.user?.rol, req.user?.username);
  const uName = String(req.user?.username || "").trim().toLowerCase();
  if (uRol === "ADMIN" || ["admin", "gabrielfiol", "fiol", "encargado"].includes(uName)) {
    return false;
  }
  if (["loscabos", "mulege", "comondu", "guerreronegro"].includes(uName)) {
    return true;
  }
  const regClave = String(scope?.region_clave || req.user?.region_clave || "").trim().toUpperCase();
  if (["LOS_CABOS", "MULEGE", "COMONDU", "COMONDU_LORETO"].includes(regClave)) {
    return true;
  }
  const regId = Number(scope?.region_id || req.user?.region_id || 0);
  if ([2, 3, 4].includes(regId)) {
    return true;
  }
  const regNombre = String(scope?.region_nombre || req.user?.region_nombre || req.user?.region || "").trim();
  return Boolean(scope?.es_region_foranea || isRegionForaneaObligatoriaFirma(regNombre));
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
  firma_solicitante = null,
  items = [],
} = req.body || {};

let ofi = Number(id_oficialia || 0) || null;
let loc = 0;
let uid = Number(usuario_id || 0) || req.user.id;

const canSelectAny = canSelectAnyDepartment(req);
const uNameNorm = String(req.user?.username || "").toLowerCase().trim();
const isFiolUser = uNameNorm === "gabrielfiol" || uNameNorm === "fiol" || uNameNorm === "encargado";

if (!canSelectAny || isFiolUser) {
  // Regla de Negocio:
  // Si el usuario no es admin o si es gabrielfiol, se ignora cualquier id_oficialia o usuario_id enviado
  // y se fuerza el departamento/oficialía que pertenece a su perfil en la tabla usuario (para Fiol: 30030008).
  uid = req.user.id;
  if (isFiolUser) {
    ofi = 30030008;
    loc = 0;
  } else {
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
  return httpError(res, 403, "No tienes permiso para solicitar materiales a nombre de Encargado de Archivos y Materiales");
}

const scope = await getUserScope(req);
let regionRaw = region_solicitante ? String(region_solicitante).trim() : (scope.region_nombre || "");
if (!canSelectAny && scope.region_nombre) {
  // Para enlaces regionales u otros usuarios, registrar la región asignada a su perfil
  regionRaw = scope.region_nombre;
}
const regionKey = regionRaw.toUpperCase().replace(/[\s\/-]+/g, "_");
const isForanea = scope.es_region_foranea || (isAdmin(req) && REGIONES_FORANEAS.has(regionKey));

const cleanRegion = regionRaw ? regionRaw.slice(0, 50) : "La Paz";
let defaultResponsableNombre = null;
if (!nombre_solicitante_firma || !String(nombre_solicitante_firma).trim()) {
  if (ofi) {
    const [ofiRespRows] = await poolRead.query(
      `SELECT COALESCE(NULLIF(TRIM(o.oficial_reponsable), ''), NULLIF(TRIM(d.responsable), '')) AS resp
       FROM oficialias o
       LEFT JOIN departamentos d ON d.id = o.id
       WHERE o.id = ? LIMIT 1`,
      [ofi]
    ).catch(() => [[]]);
    if (ofiRespRows?.[0]?.resp) {
      defaultResponsableNombre = String(ofiRespRows[0].resp).trim();
    }
  }
  if (!defaultResponsableNombre && uid) {
    const [uFreshRows] = await poolRead.query(
      `SELECT nombre, PRIMER_APELLIDO, SEGUNDO_APELLIDO FROM usuario WHERE id = ? LIMIT 1`,
      [uid]
    ).catch(() => [[]]);
    if (uFreshRows?.[0]) {
      defaultResponsableNombre = buildCleanFullName(
        uFreshRows[0].nombre,
        uFreshRows[0].PRIMER_APELLIDO,
        uFreshRows[0].SEGUNDO_APELLIDO
      );
    }
  }
}
const defaultUserFullName =
  defaultResponsableNombre ||
  req.user?.nombre_completo ||
  buildCleanFullName(req.user?.nombre, req.user?.primer_ap, req.user?.segundo_ap) ||
  req.user?.username ||
  null;
const cleanNombreFirma = nombre_solicitante_firma && String(nombre_solicitante_firma).trim()
  ? String(nombre_solicitante_firma).trim().slice(0, 150)
  : (defaultUserFullName ? String(defaultUserFullName).slice(0, 150) : null);
const rawFirmaInput = firma_solicitante || firma_solicitante_data || null;
const esForaneo = isAuthenticatedUserRegionalForaneo(req, scope);

let cleanFirmaData = null;
if (rawFirmaInput && String(rawFirmaInput).trim()) {
  const trimmed = String(rawFirmaInput).trim();
  if (/^data:image\/(png|jpeg);base64,/i.test(trimmed)) {
    cleanFirmaData = trimmed;
  } else {
    return httpError(res, 400, "Formato de firma inválido. Solo se admiten imágenes en formato PNG o JPEG.");
  }
}

if (esForaneo && !cleanFirmaData) {
  return httpError(res, 400, `La firma digital del solicitante es obligatoria para la región ${cleanRegion}`);
}

const fechaFirma = cleanFirmaData ? new Date() : null;
const folioFirma = cleanFirmaData
  ? buildFolioFirmaDigital(`${uid}|${ofi}|${cleanNombreFirma || ""}|${cleanFirmaData.slice(-64)}`)
  : null;

const conn = await poolOps.getConnection();
try {
  await conn.beginTransaction();
  const esPruebaVal = 0;

  const [rs] = await conn.query(
    `INSERT INTO solicitudes(
       tipo_solicitud, fecha_solicitud, id_oficialia, id_localidad, usuario_id,
       status, observaciones, region_solicitante, nombre_solicitante_firma,
       firma_solicitante_data, firma_solicitante, fecha_firma_digital, folio_firma_digital,
       es_prueba, inventario_descontado
     )
     VALUES (?, NOW(), ?, ?, ?, 'PENDIENTE', ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      tipo_solicitud,
      ofi,
      loc,
      uid,
      observaciones,
      cleanRegion,
      cleanNombreFirma,
      cleanFirmaData,
      cleanFirmaData,
      fechaFirma,
      folioFirma,
      esPruebaVal,
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

    // Permitir solicitar cualquier producto activo independientemente de su existencia actual en almacén (la validación estricta ocurre al surtir/entregar).
    const itemObs = it.observaciones || null;

    await conn.query(
      `INSERT INTO detalles_solicitud (solicitud_id, producto_id, cantidad, cantidad_surtida, atendida, observaciones)
       VALUES (?, ?, ?, NULL, 0, ?)`,
      [solicitudId, prodId, cantidad, itemObs]
    );
  }

  await conn.commit();
  res.json({
    ok: true,
    solicitud_id: solicitudId,
    es_prueba: esPruebaVal,
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

function hasSolicitudModifyPermission(req, ownerUserId) {
  const uRol = String(req.user?.rol || "").trim().toUpperCase();
  const uName = String(req.user?.username || "").trim().toLowerCase();
  const isAuthorizedEncargado = ["gabrielfiol", "fiol", "encargado", "jorge", "jorgepatron"].includes(uName);
  const isOwner = ownerUserId != null && Number(ownerUserId) === Number(req.user?.id);
  return uRol === "ADMIN" || isAuthorizedEncargado || isOwner;
}

// Endpoint para firmar digitalmente una solicitud existente (ej. solicitudes pendientes de firma)
app.post("/api/solicitudes/:id/firma", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return httpError(res, 400, "ID de solicitud inválido");

    const [rows] = await poolRead.query(
      `SELECT id, usuario_id, status, region_solicitante, nombre_solicitante_firma FROM solicitudes WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!rows.length) return httpError(res, 404, "Solicitud no encontrada");

    const sol = rows[0];
    if (!hasSolicitudModifyPermission(req, sol.usuario_id)) {
      return res.status(403).json({ ok: false, error: "Forbidden: No tienes permiso para modificar esta solicitud." });
    }

    const { region_solicitante = null, nombre_solicitante_firma = null, firma_solicitante_data = null, firma_solicitante = null } = req.body || {};
    const cleanRegion = region_solicitante != null && String(region_solicitante).trim() !== ""
      ? String(region_solicitante).trim().slice(0, 50)
      : (sol.region_solicitante || req.user?.region || "");
    const scopeFirma = await getUserScope(req);
    const esForaneo = isAuthenticatedUserRegionalForaneo(req, scopeFirma);

    const rawFirma = firma_solicitante || firma_solicitante_data || null;
    let cleanFirmaData = null;
    if (rawFirma && String(rawFirma).trim()) {
      const trimmed = String(rawFirma).trim();
      if (/^data:image\/(png|jpeg);base64,/i.test(trimmed)) {
        cleanFirmaData = trimmed;
      } else {
        return httpError(res, 400, "Formato de firma inválido. Solo se admiten imágenes en formato PNG o JPEG.");
      }
    }

    if (esForaneo && !cleanFirmaData) {
      return httpError(res, 400, `La firma digital del solicitante es obligatoria para la región ${cleanRegion}`);
    }

    const cleanNombre = nombre_solicitante_firma != null && String(nombre_solicitante_firma).trim() !== ""
      ? String(nombre_solicitante_firma).trim().slice(0, 150)
      : sol.nombre_solicitante_firma;

    const fechaFirma = cleanFirmaData ? new Date() : null;
    const folioFirma = cleanFirmaData
      ? buildFolioFirmaDigital(`${id}|${cleanNombre || ""}|${cleanFirmaData.slice(-64)}`)
      : null;

    await poolOps.query(
      `UPDATE solicitudes
       SET region_solicitante = COALESCE(?, region_solicitante),
           nombre_solicitante_firma = COALESCE(?, nombre_solicitante_firma),
           firma_solicitante_data = ?,
           firma_solicitante = ?,
           fecha_firma_digital = ?,
           folio_firma_digital = ?
       WHERE id = ?`,
      [cleanRegion, cleanNombre, cleanFirmaData, cleanFirmaData, fechaFirma, folioFirma, id]
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
if (!Number.isFinite(solicitudId) || solicitudId <= 0) return httpError(res, 400, "ID de solicitud invalido");

const [solAuthRows] = await poolRead.query(`SELECT id, usuario_id FROM solicitudes WHERE id = ? LIMIT 1`, [solicitudId]);
if (!solAuthRows.length) return httpError(res, 404, "Solicitud no encontrada");
if (!hasSolicitudModifyPermission(req, solAuthRows[0].usuario_id)) {
  return res.status(403).json({ ok: false, error: "Forbidden: No tienes permiso para modificar esta solicitud." });
}

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
if (!Number.isFinite(solicitudId) || solicitudId <= 0) return httpError(res, 400, "ID de solicitud invalido");

const [solAuthRows] = await poolRead.query(`SELECT id, usuario_id FROM solicitudes WHERE id = ? LIMIT 1`, [solicitudId]);
if (!solAuthRows.length) return httpError(res, 404, "Solicitud no encontrada");
if (!hasSolicitudModifyPermission(req, solAuthRows[0].usuario_id)) {
  return res.status(403).json({ ok: false, error: "Forbidden: No tienes permiso para modificar esta solicitud." });
}

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
    if (isAuditorBlockedUser(req)) {
      return httpError(res, 403, "Modo auditoría. No tienes permisos para modificar el estatus de las solicitudes.");
    }
    if (!canManageSolicitudes(req)) {
      return httpError(res, 403, "Solo el Encargado de Almacén o Administrador puede gestionar solicitudes");
    }
    const solicitudId = Number(req.params.id);
    if (!Number.isInteger(solicitudId) || solicitudId <= 0) {
      return httpError(res, 400, "ID de solicitud inválido");
    }

    const rawItems = Array.isArray(req.body) ? req.body : (Array.isArray(req.body?.items) ? req.body.items : []);
    const requestedStatusRaw = !Array.isArray(req.body) ? (req.body?.status || req.body?.nuevo_estado || null) : null;

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      const [solRows] = await conn.query(
        "SELECT id, usuario_id, status, fecha_solicitud, COALESCE(es_prueba, 0) AS es_prueba, COALESCE(inventario_descontado, 0) AS inventario_descontado FROM solicitudes WHERE id = ? FOR UPDATE",
        [solicitudId]
      );
      if (!solRows.length) {
        await conn.rollback();
        return httpError(res, 404, "Solicitud no encontrada");
      }
      const sol = solRows[0];
      if (!hasSolicitudModifyPermission(req, sol.usuario_id)) {
        await conn.rollback();
        return res.status(403).json({ ok: false, error: "Forbidden: No tienes permiso para modificar esta solicitud." });
      }
      const curStatus = String(sol.status || "").toUpperCase();
      if (curStatus === "CANCELADA" || curStatus === "CANCELADO") {
        await conn.rollback();
        return httpError(res, 400, "No se puede procesar una solicitud cancelada");
      }

      let nextStatus = null;
      if (requestedStatusRaw) {
        nextStatus = await normalizeStatus(requestedStatusRaw);
      } else if (curStatus === "PARA_FIRMAS") {
        nextStatus = "COMPLETADA";
      } else {
        nextStatus = "PARA_FIRMAS";
      }

      const pk = await detectProductosPK();
      const [detRows] = await conn.query(
        `SELECT ds.id, ds.solicitud_id, ds.producto_id, ds.cantidad, ds.cantidad_surtida, ds.atendida, ds.observaciones,
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

      const isCurLockedStep3 = ["PARA_FIRMAS", "PASO_3"].includes(curStatus);
      const isNextFinalStep4 = ["COMPLETADA", "SURTIDA", "ENTREGADA", "ENTREGADO", "SURTIDO"].includes(String(nextStatus).toUpperCase());

      // Bloqueo estricto desde el Paso 3: una vez en PARA_FIRMAS, no se permite volver a editar cantidades ni observaciones
      if (isCurLockedStep3 && !isNextFinalStep4) {
        await conn.rollback();
        return httpError(res, 409, "Las cantidades surtidas y observaciones están bloqueadas desde el Paso 3 (PARA FIRMAS) y no pueden modificarse.");
      }

      const plan = [];
      // Si la orden ya está en Paso 3 (PARA_FIRMAS) y avanza al Paso 4 (ENTREGADA/COMPLETADA/SURTIDA),
      // ignorar cualquier payload de modificación y usar estrictamente las cantidades congeladas en BD al cierre del Paso 2.
      const freezeFromDbOnly = isCurLockedStep3 || isNextFinalStep4;
      const itemsToProcess = (!freezeFromDbOnly && rawItems.length)
        ? rawItems
        : detRows.map(d => ({
            detalle_id: d.id,
            cantidad_surtida:
              d.cantidad_surtida !== null && d.cantidad_surtida !== undefined
                ? Number(d.cantidad_surtida)
                : (d.atendida !== null && d.atendida !== undefined ? Number(d.atendida) : Number(d.cantidad || 0)),
            observaciones: d.observaciones
          }));

      for (const item of itemsToProcess) {
        const detId = Number(item.detalle_id || item.id);
        const targetDet = detRows.find(d => Number(d.id) === detId);
        if (!targetDet) continue;

        const nombre = nombreDe(targetDet);
        const cantSolicitada = Number(targetDet.cantidad || 0);
        const rawInputVal = item.cantidad_surtida !== undefined ? item.cantidad_surtida : item.atendida;
        const rawAt = rawInputVal === "" || rawInputVal === null || rawInputVal === undefined ? NaN : Number(rawInputVal);

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

        if (rawAt > 0 && Number(sol.inventario_descontado || 0) === 0 && (!almInfo || curStock < rawAt)) {
          await conn.rollback();
          if (!almInfo || curStock <= 0) {
            return httpError(res, 400, `No hay existencia en inventario para ${nombre} (Existencia actual: 0). Agrega stock en Almacén primero o coloca 0 en cantidad surtida.`);
          } else {
            return httpError(res, 400, `Stock insuficiente para ${nombre}. Solicitado a surtir: ${rawAt}, Existencia disponible: ${curStock}.`);
          }
        }
        plan.push({ item, targetDet, nombre, clave, almInfo, curStock, nextAtendida: rawAt });
      }

      if (!plan.length && detRows.length > 0) {
        await conn.rollback();
        return httpError(res, 400, "Ninguno de los renglones enviados pertenece a esta solicitud.");
      }

      // Actualizar y congelar cantidad_surtida y observaciones en detalles_solicitud ÚNICAMENTE al cerrar el Paso 2 (hacia PARA_FIRMAS)
      if (!isCurLockedStep3 && !isNextFinalStep4) {
        for (const p of plan) {
          const { item, targetDet, nextAtendida } = p;
          const detId = Number(targetDet.id);
          const newObs = item.observaciones !== undefined ? (item.observaciones ? String(item.observaciones).trim() : null) : targetDet.observaciones;
          await conn.query(
            "UPDATE detalles_solicitud SET cantidad_surtida = ?, atendida = ?, observaciones = ? WHERE id = ?",
            [nextAtendida, nextAtendida, newObs, detId]
          );
        }
      }

      // Lógica 2 (Almacén General - Fiol / encargado): Modelo Físico Estricto
      // En producción solo se descuenta stock cuando pasa a estatus final de entrega
      const isFinalDeliveredStatus = ["COMPLETADA", "SURTIDA", "ENTREGADA", "ENTREGADO", "SURTIDO"].includes(String(nextStatus).toUpperCase());
      const shouldDeductNow = isFinalDeliveredStatus && Number(sol.inventario_descontado || 0) === 0;
      let deductedTotal = 0;

      if (shouldDeductNow) {
        for (const p of plan) {
          const { targetDet, clave, almInfo, nextAtendida, item } = p;
          if (nextAtendida > 0 && clave && almInfo) {
            const newStock = Math.max(0, almInfo.stock - nextAtendida);
            almInfo.stock = newStock;
            deductedTotal += nextAtendida;
            await conn.query("UPDATE almacen_dregcivil SET STOCK = ? WHERE ID = ?", [newStock, almInfo.id]);
            try {
              await conn.query("UPDATE productos SET STOCK = GREATEST(0, COALESCE(STOCK, 0) - ?) WHERE CLAVE = ?", [nextAtendida, clave]);
            } catch {}
            try {
              if (targetDet.producto_id) {
                await conn.query("UPDATE almacen_principal SET STOCK = GREATEST(0, COALESCE(STOCK, 0) - ?) WHERE producto_id = ?", [nextAtendida, targetDet.producto_id]);
              }
            } catch {}

            await logMovimiento(conn, {
              tipo: "SALIDA",
              clave,
              cantidad: nextAtendida,
              responsable: req.user?.username || "web",
              destino: "SOLICITUD",
              referencia: `SOL-${solicitudId}`,
              observaciones: item?.observaciones || "Entrega completada de solicitud",
            });
          }
        }
        if (deductedTotal > 0) {
          await syncAlmacenCentralToInventarioRegional(conn).catch(() => {});
        }
      }

      const nextInvDescontado = (shouldDeductNow && deductedTotal > 0) ? 1 : Number(sol.inventario_descontado || 0);
      if (["COMPLETADA", "SURTIDA", "ENTREGADA"].includes(nextStatus)) {
        await conn.query(
          "UPDATE solicitudes SET status = ?, inventario_descontado = ?, fecha_surtido = CURDATE() WHERE id = ?",
          [nextStatus, nextInvDescontado, solicitudId]
        );
      } else {
        await conn.query(
          "UPDATE solicitudes SET status = ?, inventario_descontado = ? WHERE id = ?",
          [nextStatus, nextInvDescontado, solicitudId]
        );
      }

      const itemsBreakdown = plan
        .filter(p => p.nextAtendida > 0)
        .map(p => `${p.nextAtendida}x ${p.nombre || p.clave}`)
        .join(", ");
      await registrarBitacora(
        req,
        "ALMACEN",
        `ORDEN_${nextStatus}`,
        `Orden #${solicitudId} actualizada a ${nextStatus}: ${itemsBreakdown || "Sin artículos"}`,
        conn
      );

      await conn.commit();
      return res.json({
        ok: true,
        status: nextStatus,
        solicitud_id: solicitudId,
        es_prueba: 0,
        inventario_descontado: nextInvDescontado,
      });
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
if (isAuditorBlockedUser(req)) {
  return httpError(res, 403, "Modo auditoría. No tienes permisos para modificar el estatus de las solicitudes.");
}
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
if (isAuditorBlockedUser(req)) {
  return httpError(res, 403, "Modo auditoría. No tienes permisos para modificar el estatus de las solicitudes.");
}
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

const handleSolicitudStatusChange = async (req, res) => {
try {
const id = Number(req.params.id);
if (!Number.isFinite(id) || id <= 0) return httpError(res, 400, "ID invalido");

if (isAuditorBlockedUser(req)) {
  return httpError(res, 403, "Modo auditoría. No tienes permisos para modificar el estatus de las solicitudes.");
}

const [solAuthRows] = await poolRead.query(`SELECT id, usuario_id FROM solicitudes WHERE id = ? LIMIT 1`, [id]);
if (!solAuthRows.length) return httpError(res, 404, "Solicitud no encontrada");
if (!hasSolicitudModifyPermission(req, solAuthRows[0].usuario_id)) {
  return res.status(403).json({ ok: false, error: "Forbidden: No tienes permiso para modificar esta solicitud." });
}

if (!canManageSolicitudes(req)) {
return httpError(res, 403, "No tienes permiso para cambiar el status de la solicitud");
}

const status = req.body?.status || req.body?.estado || req.body?.nuevo_estado || null;
const observaciones = req.body?.observaciones ?? null;
const items = Array.isArray(req.body?.items) ? req.body.items : null;
if (!status) return httpError(res, 400, "status requerido");

if (items && items.length) {
  req.body.status = status;
  return surtirSolicitudHandler(req, res);
}

const result = await updateSolicitudStatusStockAware({
solicitudId: id,
status,
observaciones,
username: req.user?.username || "web",
});

res.json({
  ok: true,
  updated: true,
  id,
  status: result.status,
  restored_qty: result.restoredQty || 0,
  deducted_qty: result.deductedQty || 0,
  inventario_descontado: result.inventarioDescontado ? 1 : 0,
  es_prueba: result.esPrueba ? 1 : 0,
});
} catch (e) {
if (e.statusCode) return httpError(res, e.statusCode, e.message);
return httpError(res, 400, e.message);
}
};

app.patch("/api/solicitudes/:id/status", authRequired, handleSolicitudStatusChange);
app.put("/api/solicitudes/:id/status", authRequired, handleSolicitudStatusChange);
app.patch("/api/solicitudes/:id/estatus", authRequired, handleSolicitudStatusChange);
app.put("/api/solicitudes/:id/estatus", authRequired, handleSolicitudStatusChange);
app.patch("/api/solicitudes/:id/estado", authRequired, handleSolicitudStatusChange);
app.put("/api/solicitudes/:id/estado", authRequired, handleSolicitudStatusChange);

async function deleteOrDiscardSolicitud(req, res, { isDraftDiscard = false } = {}) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return httpError(res, 400, "ID invalido");

  if (isAuditorBlockedUser(req)) {
    return httpError(res, 403, "Modo auditoría. No tienes permisos para modificar el estatus de las solicitudes.");
  }

  const admin = isAdmin(req);
  const canManage = canManageSolicitudes(req);
  if (!isDraftDiscard && !admin) {
    return httpError(res, 403, "Eliminar solo Admin");
  }

  const conn = await poolOps.getConnection();
  try {
    await conn.beginTransaction();
    const [solRows] = await conn.query(
      "SELECT id, usuario_id, status, COALESCE(es_prueba, 0) AS es_prueba, COALESCE(inventario_descontado, 0) AS inventario_descontado FROM solicitudes WHERE id=? LIMIT 1 FOR UPDATE",
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
      `SELECT ds.id, ds.atendida, ds.cantidad_surtida, p.CLAVE AS clave
       FROM detalles_solicitud ds
       LEFT JOIN productos p ON p.${qi(pk)} = ds.producto_id
       WHERE ds.solicitud_id = ?
       FOR UPDATE`,
      [id]
    );

    const totalAtendida = detRows.reduce((acc, r) => acc + (Number(r.cantidad_surtida ?? r.atendida ?? 0) || 0), 0);
    if (isDraftDiscard && totalAtendida > 0 && !admin) {
      await conn.rollback();
      return httpError(res, 409, "No se puede descartar una solicitud ya surtida");
    }

    // En producción se restaura stock si el inventario fue previamente descontado
    const shouldRestoreStock = Number(sol.inventario_descontado || 0) === 1;

    if (shouldRestoreStock) {
      for (const row of detRows) {
        const atendida = Number(row.cantidad_surtida ?? row.atendida ?? 0);
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
`SELECT ds.id, ds.solicitud_id, ds.producto_id, ds.cantidad, ds.cantidad_surtida, ds.atendida, p.CLAVE AS clave, p.DESCRIPCION AS descripcion
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
const [solRows] = await conn.query(
  `SELECT id, status FROM solicitudes WHERE id = ? LIMIT 1 FOR UPDATE`,
  [row.solicitud_id]
);
const parentStatus = String(solRows[0]?.status || "PENDIENTE").trim().toUpperCase();
if (
  [
    "PARA_FIRMAS",
    "PASO_3",
    "COMPLETADA",
    "SURTIDA",
    "SURTIDO",
    "ENTREGADA",
    "ENTREGADO",
    "APROBADA",
    "PASO_4",
    "CANCELADA",
    "CANCELADO",
    "RECHAZADA",
    "RECHAZADO",
  ].includes(parentStatus)
) {
  const err = new Error("Las cantidades surtidas y observaciones están bloqueadas desde el Paso 3 (PARA FIRMAS) y no pueden modificarse.");
  err.statusCode = 409;
  throw err;
}

const prevAtendida = Number(row.cantidad_surtida ?? row.atendida ?? 0);
const rawNext = "cantidad_surtida" in data ? data.cantidad_surtida : ("atendida" in data ? data.atendida : prevAtendida);
const nextAtendida = Number(rawNext);
const cantidadSolicitada = Number(row.cantidad || 0);
if (!Number.isInteger(nextAtendida) || nextAtendida < 0) {
  const err = new Error("La cantidad surtida debe ser un número entero mayor o igual a 0.");
  err.statusCode = 400;
  throw err;
}
if (nextAtendida > cantidadSolicitada) {
  const err = new Error(`La cantidad surtida no puede ser mayor que la solicitada (${cantidadSolicitada})`);
  err.statusCode = 400;
  throw err;
}

// Validar existencia real en almacén cuando cantidad_surtida > 0 (si es 0 se permite siempre)
if (nextAtendida > 0 && row.clave) {
  const [almRows] = await conn.query(
    `SELECT ID, CLAVE, DESCRIPCION, STOCK FROM almacen_dregcivil WHERE CLAVE = ? LIMIT 1 FOR UPDATE`,
    [row.clave]
  );
  const almRow = almRows[0] || null;
  const curStock = almRow ? Number(almRow.STOCK ?? 0) : 0;
  const nombre = row.descripcion || almRow?.DESCRIPCION || row.clave || `renglón ${row.id}`;
  if (!almRow || curStock <= 0) {
    const err = new Error(`No hay existencia en inventario para ${nombre} (Existencia actual: 0). Agrega stock en Almacén primero o coloca 0 en cantidad surtida.`);
    err.statusCode = 400;
    throw err;
  }
  if (nextAtendida > curStock) {
    const err = new Error(`Stock insuficiente para ${nombre}. Solicitado a surtir: ${nextAtendida}, Existencia disponible: ${curStock}.`);
    err.statusCode = 400;
    throw err;
  }
}

// Lógica Físico Estricto (Almacén General Fiol): No se descuenta stock en Paso 1, 2 ni 3.
// El descuento físico únicamente ocurre al avanzar al Paso 4 (ENTREGADA / COMPLETADA / SURTIDA).
const sets = [];
const vals = [];
if ("atendida" in data || "cantidad_surtida" in data) {
sets.push("cantidad_surtida=?", "atendida=?");
vals.push(nextAtendida, nextAtendida);
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
`SELECT id, status, COALESCE(es_prueba, 0) AS es_prueba, COALESCE(inventario_descontado, 0) AS inventario_descontado
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

const sol = solRows[0];
const cancelStatus = await normalizeStatus("CANCELADA").catch(() => "CANCELADA");
const nextStatus = await normalizeStatus(status);
const prevStatus = String(sol.status || "").trim().toUpperCase();

if ((prevStatus === cancelStatus || prevStatus === "CANCELADO") && nextStatus !== cancelStatus) {
const err = new Error("La solicitud cancelada ya no puede volver a otro estatus");
err.statusCode = 409;
throw err;
}

let restoredQty = 0;
let deductedQty = 0;
let nextInvDescontado = Number(sol.inventario_descontado || 0);

const pk = await detectProductosPK();
const nextStatusUpper = String(nextStatus).toUpperCase();
const isStep3ParaFirmas = ["PARA_FIRMAS", "PASO_3"].includes(nextStatusUpper);
const isFinalDelivered = ["COMPLETADA", "SURTIDA", "ENTREGADA", "ENTREGADO", "SURTIDO"].includes(nextStatusUpper);

// Validar stock en tiempo real tanto al pasar a Paso 3 (PARA_FIRMAS) como al entregar en Paso 4 (COMPLETADA/SURTIDA/ENTREGADA)
if ((isStep3ParaFirmas || isFinalDelivered) && nextInvDescontado === 0) {
  const [detRows] = await conn.query(
    `SELECT ds.id, ds.cantidad, ds.cantidad_surtida, ds.atendida, p.CLAVE AS clave, p.DESCRIPCION AS descripcion
     FROM detalles_solicitud ds
     LEFT JOIN productos p ON p.${qi(pk)} = ds.producto_id
     WHERE ds.solicitud_id = ?
     FOR UPDATE`,
    [solicitudId]
  );

  // 1. Validación estricta previa de existencias para cada renglón con cantidad_surtida > 0 (si es 0 se permite siempre)
  const rowsPlan = [];
  for (const row of detRows) {
    const cantSurtir = Number(
      row.cantidad_surtida !== null && row.cantidad_surtida !== undefined
        ? row.cantidad_surtida
        : (row.atendida !== null && row.atendida !== undefined ? row.atendida : (row.cantidad || 0))
    );
    if (!(cantSurtir > 0)) {
      rowsPlan.push({ row, cantSurtir: 0 });
      continue;
    }
    if (!row.clave) {
      const err = new Error("No se pudo resolver la CLAVE del detalle");
      err.statusCode = 400;
      throw err;
    }
    const [almRows] = await conn.query(
      `SELECT ID, CLAVE, DESCRIPCION, STOCK FROM almacen_dregcivil WHERE CLAVE = ? LIMIT 1 FOR UPDATE`,
      [row.clave]
    );
    const almRow = almRows[0] || null;
    const curStock = almRow ? Number(almRow.STOCK ?? 0) : 0;
    const nombre = row.descripcion || almRow?.DESCRIPCION || row.clave || `renglón ${row.id}`;
    if (!almRow || curStock <= 0) {
      const err = new Error(`No hay existencia en inventario para ${nombre} (Existencia actual: 0). Agrega stock en Almacén primero o coloca 0 en cantidad surtida.`);
      err.statusCode = 400;
      throw err;
    }
    if (cantSurtir > curStock) {
      const err = new Error(`Stock insuficiente para ${nombre}. Solicitado a surtir: ${cantSurtir}, Existencia disponible: ${curStock}.`);
      err.statusCode = 400;
      throw err;
    }
    rowsPlan.push({ row, cantSurtir });
  }

  // 2. Descontar del inventario SOLO al completar/entregar (Paso 4) y únicamente renglones con cantSurtir > 0
  if (isFinalDelivered) {
    for (const { row, cantSurtir } of rowsPlan) {
      if (!(cantSurtir > 0)) continue;
      await applySolicitudStockDeltaForClave(conn, {
        clave: row.clave,
        delta: cantSurtir,
        responsable: username,
        referencia: `SOL-${solicitudId}`,
        observaciones: observaciones || "Entrega completada de solicitud",
      });
      deductedQty += cantSurtir;
      await conn.query(
        `UPDATE detalles_solicitud SET cantidad_surtida = COALESCE(cantidad_surtida, ?), atendida = ? WHERE id = ?`,
        [cantSurtir, cantSurtir, row.id]
      );
    }
    if (deductedQty > 0) {
      nextInvDescontado = 1;
    }
  }
}

if (nextStatus === cancelStatus && prevStatus !== cancelStatus) {
  if (nextInvDescontado === 1) {
    const [detRows] = await conn.query(
      `SELECT ds.id, ds.cantidad_surtida, ds.atendida, p.CLAVE AS clave
       FROM detalles_solicitud ds
       LEFT JOIN productos p ON p.${qi(pk)} = ds.producto_id
       WHERE ds.solicitud_id = ?
       FOR UPDATE`,
      [solicitudId]
    );

    for (const row of detRows) {
      const atendida = Number(row.cantidad_surtida ?? row.atendida ?? 0);
      if (!(atendida > 0)) continue;
      if (!row.clave) continue;
      await applySolicitudStockDeltaForClave(conn, {
        clave: row.clave,
        delta: -atendida,
        responsable: username,
        referencia: `SOL-${solicitudId}-CANCEL`,
        observaciones: observaciones || "Cancelacion de solicitud",
      });
      restoredQty += atendida;
    }
    nextInvDescontado = 0;
  }

  await conn.query(
    `UPDATE detalles_solicitud
     SET atendida = 0, cantidad_surtida = 0
     WHERE solicitud_id = ?`,
    [solicitudId]
  );
}

if (["COMPLETADA", "SURTIDA", "ENTREGADA"].includes(nextStatus)) {
  await conn.query(
    `UPDATE solicitudes
     SET status = ?, inventario_descontado = ?, fecha_surtido = CURDATE(), observaciones = COALESCE(?, observaciones)
     WHERE id = ?`,
    [nextStatus, nextInvDescontado, observaciones, solicitudId]
  );
} else {
  await conn.query(
    `UPDATE solicitudes
     SET status = ?, inventario_descontado = ?, observaciones = COALESCE(?, observaciones)
     WHERE id = ?`,
    [nextStatus, nextInvDescontado, observaciones, solicitudId]
  );
}

await conn.commit();
return { status: nextStatus, restoredQty, deductedQty, inventarioDescontado: nextInvDescontado === 1, esPrueba: false };
} catch (e) {
await conn.rollback();
throw e;
} finally {
conn.release();
}
}


async function getNextAlmacenClave(connOrPool = poolRead) {
  let maxNum = 0;
  try {
    const [rows] = await connOrPool.query(`
      SELECT CLAVE
      FROM almacen_dregcivil
      WHERE UPPER(TRIM(CLAVE)) REGEXP '^MAT-[0-9]+$'
      ORDER BY CAST(SUBSTRING(UPPER(TRIM(CLAVE)), 5) AS UNSIGNED) DESC
      LIMIT 1
    `);
    if (rows && rows.length > 0) {
      const m = String(rows[0].CLAVE || "").trim().toUpperCase().match(/^MAT-(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxNum) maxNum = n;
      }
    }
  } catch {}

  try {
    const [pRows] = await connOrPool.query(`
      SELECT CLAVE
      FROM productos
      WHERE UPPER(TRIM(CLAVE)) REGEXP '^MAT-[0-9]+$'
      ORDER BY CAST(SUBSTRING(UPPER(TRIM(CLAVE)), 5) AS UNSIGNED) DESC
      LIMIT 1
    `);
    if (pRows && pRows.length > 0) {
      const m = String(pRows[0].CLAVE || "").trim().toUpperCase().match(/^MAT-(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxNum) maxNum = n;
      }
    }
  } catch {}

  let nextNum = maxNum + 1;
  let candidate = `MAT-${String(nextNum).padStart(3, "0")}`;

  // Verificar en bucle para evitar duplicados concurrentes
  while (true) {
    const [dup] = await connOrPool.query(
      `SELECT ID FROM almacen_dregcivil WHERE UPPER(TRIM(CLAVE)) = ? LIMIT 1`,
      [candidate]
    );
    if (!dup || dup.length === 0) break;
    nextNum++;
    candidate = `MAT-${String(nextNum).padStart(3, "0")}`;
  }

  return candidate;
}

// GET /api/almacen: LECTURA abierta a CUALQUIER usuario autenticado (USUARIO, REGIONAL, ENCARGADO, ADMIN).
// La usa buscarProductos() para llenar el selector de materiales al crear una solicitud.
// Para usuarios sin acceso de almacén se devuelven TODOS los materiales activos (incluyendo STOCK = 0) sin exponer existencias.
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
const catMap = await getCategoriasNameMap();
let nextClave = null;
if (!isNormalUser) {
  try { nextClave = await getNextAlmacenClave(poolRead); } catch { nextClave = null; }
}

let extraWhere = clave ? " AND a.CLAVE = ?" : "";
if (isNormalUser) {
  extraWhere += (hasEstado && almStatusCol ? ` AND (a.${qi(almStatusCol)} IS NULL OR a.${qi(almStatusCol)} = 'ACTIVO')` : "");
}
const extraParam = clave ? [clave] : [];

const unidadExpr = hasUnidad ? "a.UNIDAD" : "p.unidad";
const unidadSelect = `${unidadExpr} AS UNIDAD`;
const joinProductos = "LEFT JOIN productos p ON p.CLAVE = a.CLAVE";
const hasCatJoin = Boolean(meta.table && meta.id && meta.name);
const catJoinSql = hasCatJoin
  ? (catIsNum
      ? `LEFT JOIN ${qi(meta.table)} c ON c.${qi(meta.id)} = a.CATEGORIA`
      : `LEFT JOIN ${qi(meta.table)} c ON (TRIM(CAST(a.CATEGORIA AS CHAR)) REGEXP '^[0-9]+$' AND c.${qi(meta.id)} = CAST(TRIM(CAST(a.CATEGORIA AS CHAR)) AS UNSIGNED))`)
  : "";

const statusSel = hasEstado && almStatusCol ? `a.${qi(almStatusCol)} AS status` : `'ACTIVO' AS status`;
const orderExpr =
orderSafe === "CATEGORIA" && hasCatJoin
? `COALESCE(c.${qi(meta.name).slice(1, -1)}, CAST(a.CATEGORIA AS CHAR))`
: orderSafe === "STATUS" && almStatusCol
? `a.${qi(almStatusCol)}`
: `a.${orderSafe}`;

const tokenGroups = getSearchTokenRoots(q);
let searchWhere = "";
const searchParams = [];

if (tokenGroups.length > 0) {
  const searchTargetExpr = hasCatJoin
    ? `CONCAT_WS(' ', a.CLAVE, a.DESCRIPCION, c.${qi(meta.name).slice(1, -1)}, a.CATEGORIA${hasEstado && almStatusCol ? `, a.${qi(almStatusCol)}` : ""})`
    : `CONCAT_WS(' ', a.CLAVE, a.DESCRIPCION, a.CATEGORIA${hasEstado && almStatusCol ? `, a.${qi(almStatusCol)}` : ""})`;

  const andClauses = [];
  for (const group of tokenGroups) {
    const orClauses = [];
    for (const variant of group) {
      orClauses.push(`${searchTargetExpr} LIKE ?`);
      searchParams.push(`%${variant}%`);
    }
    andClauses.push(`(${orClauses.join(" OR ")})`);
  }
  searchWhere = " AND " + andClauses.join(" AND ");
}

const catNameExpr = hasCatJoin ? `c.${qi(meta.name).slice(1, -1)} AS CATEGORIA_NOMBRE,` : "";
const cols = `a.ID, a.CLAVE, a.DESCRIPCION, a.CATEGORIA, ${catNameExpr} ${unidadSelect}, a.STOCK, a.STOCK AS stock, (a.STOCK > 0) AS disponible, a.STOCK AS existencia, a.STOCK AS cantidad_disponible, p.minimo AS minimo, COALESCE(a.stock_minimo, p.stock_minimo, p.minimo, 0) AS stock_minimo, a.origen_adquisicion, a.observaciones_control, ${statusSel}`;
const [rawRows] = await poolRead.query(
`SELECT ${cols}
FROM almacen_dregcivil a
${joinProductos}
${catJoinSql}
WHERE 1=1 ${searchWhere} ${extraWhere}
ORDER BY ${orderExpr} ${dirSafe}
LIMIT ? OFFSET ?`,
[...searchParams, ...extraParam, lim, off]
);
const rows = rawRows.map((r) => {
  const resolvedCat = resolveCategoriaTexto(r.CATEGORIA, r.CATEGORIA_NOMBRE, catMap);
  const baseRow = {
    ...r,
    CATEGORIA_NOMBRE: resolvedCat,
    CATEGORIA: /^\d+$/.test(String(r.CATEGORIA ?? "").trim()) ? resolvedCat : r.CATEGORIA,
  };
  if (isNormalUser) {
    baseRow.STOCK = null;
    baseRow.stock = null;
    baseRow.existencia = null;
    baseRow.cantidad_disponible = null;
    baseRow.disponible = true;
  }
  return baseRow;
});
return res.json({ ok: true, data: rows, next_clave: nextClave });
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
let manualClave = String(body.CLAVE ?? body.clave ?? body.clave_bien ?? "").trim().toUpperCase();
let CLAVE = manualClave;
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

// v53: Si el campo clave viene vacío, asigna automáticamente la siguiente (MAT-XXX).
// Si el usuario ingresó una clave manual, NUNCA re-asignar automáticamente ni auto-renumerar.
// Si la clave ya existe y no es un reemplazo explícito del administrador, devolver 409 Conflict.
if (!CLAVE) {
  CLAVE = await getNextAlmacenClave(conn);
} else {
  const [checkDup] = await conn.query(
    "SELECT ID FROM almacen_dregcivil WHERE UPPER(TRIM(CLAVE)) = ? LIMIT 1",
    [CLAVE]
  );
  if (checkDup.length > 0 && !replace) {
    await conn.rollback();
    return httpError(res, 409, "⚠️ Error: La clave de producto ingresada ya existe. Por favor asigna una clave diferente.");
  }
}

const [ex] = await conn.query(`SELECT ID, STOCK FROM almacen_dregcivil WHERE CLAVE=? LIMIT 1`, [CLAVE]);

let idAlm = null;
let delta = cantNueva;
if (ex.length) {
  if (!replace) {
    await conn.rollback();
    return httpError(res, 409, "⚠️ Error: La clave de producto ingresada ya existe. Por favor asigna una clave diferente.");
  }
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
await registrarBitacora(
  req,
  'ALMACEN',
  replace ? 'AJUSTE_STOCK' : 'ENTRADA_STOCK',
  `${replace ? 'Ajuste' : 'Entrada'} de stock en "${CLAVE} - ${DESCRIPCION}": ${delta > 0 ? '+' : ''}${delta} (Nuevo stock: ${nuevoStock})`,
  conn
);
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
await registrarBitacora(
  req,
  'ALMACEN',
  'ALTA_PRODUCTO',
  `Alta de nuevo material "${CLAVE} - ${DESCRIPCION}" (Stock inicial: ${cantNueva} ${UNIDAD}, Categoría: ${rawCat})`,
  conn
);
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

async function handleUpdateAlmacen(req, res) {
  const admin = isAdminDemo(req);
  const canAlmacen = hasAlmacenAccess(req);
  if (!admin && !canAlmacen) {
    return httpError(res, 403, "No tienes permiso para editar almacén");
  }

  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return httpError(res, 400, "ID inválido");

    const hasUnidad = await hasAlmacenUnidad();
    const catIsNum = await almCategoriaIsNumeric();
    const almStatusCol = await detectAlmacenStatusCol();

    const allowed = ["CLAVE", "DESCRIPCION", "CATEGORIA", "STOCK", "STOCK_MINIMO", "ORIGEN_ADQUISICION", "OBSERVACIONES_CONTROL"];
    if (hasUnidad) allowed.push("UNIDAD");
    if (almStatusCol) allowed.push(almStatusCol);

    const addStock = req.body.addStock != null && req.body.addStock !== "" ? Number(req.body.addStock) : null;
    if (addStock != null && !Number.isFinite(addStock)) return httpError(res, 400, "addStock debe ser numérico");

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

    if (!("CLAVE" in data)) {
      if (req.body.clave != null && req.body.clave !== "") data.CLAVE = String(req.body.clave).trim().toUpperCase();
      else if (req.body.clave_bien != null && req.body.clave_bien !== "") data.CLAVE = String(req.body.clave_bien).trim().toUpperCase();
    }
    if (!("DESCRIPCION" in data) && req.body.descripcion != null) {
      data.DESCRIPCION = String(req.body.descripcion).trim();
    }
    if (!("CATEGORIA" in data) && req.body.categoria != null) {
      data.CATEGORIA = req.body.categoria;
    }
    if (!("UNIDAD" in data) && req.body.unidad != null) {
      data.UNIDAD = String(req.body.unidad).trim();
    }
    if (!("STOCK" in data) && req.body.stock != null && req.body.stock !== "") {
      data.STOCK = Number(req.body.stock);
    }

    if (Object.keys(data).length === 0 && addStock == null) return httpError(res, 400, "Nada que actualizar");

    const [curRows] = await poolRead.query(`SELECT * FROM almacen_dregcivil WHERE ID=? LIMIT 1`, [id]);
    if (!curRows.length) return httpError(res, 404, "Registro no encontrado");
    const cur = curRows[0];

    if ("STOCK" in data && data.STOCK !== "") {
      const n = Number(data.STOCK);
      if (!Number.isFinite(n)) return httpError(res, 400, "STOCK debe ser numérico");
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
      const val = data.CATEGORIA;
      if (val == null || String(val).trim() === "") {
        delete data.CATEGORIA;
      } else if (catIsNum) {
        data.CATEGORIA = Number.isFinite(Number(val))
          ? Number(val)
          : await resolveCategoriaIdOrCreate(val);
      } else {
        let c = String(val || "").trim().toUpperCase();
        if (c.length > 50) c = c.slice(0, 50);
        data.CATEGORIA = c || null;
      }
    }
    // v44: Restricción de privilegios: Solo ADMIN puede modificar clave o descripción de productos existentes
    if (!admin) {
      delete data.CLAVE;
      delete data.DESCRIPCION;
    }
    if ("CLAVE" in data) {
      data.CLAVE = String(data.CLAVE || "").trim().toUpperCase();
      if (!data.CLAVE) return httpError(res, 400, "CLAVE no puede ir vacía");
    }
    if ("DESCRIPCION" in data) {
      data.DESCRIPCION = String(data.DESCRIPCION || "").trim();
      if (!data.DESCRIPCION) return httpError(res, 400, "DESCRIPCION no puede ir vacía");
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
      const oldClave = String(row.CLAVE || "").trim().toUpperCase();
      const newClave = data.CLAVE ? String(data.CLAVE).trim().toUpperCase() : oldClave;

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
        CLAVE: newClave,
        DESCRIPCION: data.DESCRIPCION || row.DESCRIPCION,
        CATEGORIA: "CATEGORIA" in data ? data.CATEGORIA : row.CATEGORIA,
        UNIDAD: hasUnidad ? ("UNIDAD" in data ? data.UNIDAD : row.UNIDAD) : null,
        ESTADO: almStatusCol ? data[almStatusCol] ?? row[almStatusCol] ?? "ACTIVO" : "ACTIVO",
        stock_minimo: "stock_minimo" in data ? data.stock_minimo : undefined,
        origen_adquisicion: "origen_adquisicion" in data ? data.origen_adquisicion : undefined,
        observaciones_control: "observaciones_control" in data ? data.observaciones_control : undefined,
      });

      if (newClave && oldClave && newClave !== oldClave) {
        await conn.query("UPDATE productos SET CLAVE = ? WHERE CLAVE = ?", [newClave, oldClave]).catch(() => {});
        await conn.query("UPDATE inventario_oficina SET clave_bien = ? WHERE clave_bien = ? AND rubro_id = 1", [newClave, oldClave]).catch(() => {});
        await conn.query("UPDATE movimientos SET clave = ? WHERE clave = ?", [newClave, oldClave]).catch(() => {});
      }

      if (delta !== 0) {
        await logMovimiento(conn, {
          tipo: delta > 0 ? "ENTRADA" : "SALIDA",
          clave: newClave,
          cantidad: Math.abs(delta),
          responsable: req.user?.username || "web",
          destino: "ALMACEN",
          referencia: req.method === "PUT" ? "PUT /almacen/:id" : "PATCH /almacen/:id",
          observaciones: req.body.observaciones || null,
        });
      }

      await syncAlmacenCentralToInventarioRegional(conn).catch(() => {});

      // v44: Registrar en bitácora_movimientos
      const accionBit = addStock != null ? "ENTRADA_STOCK" : ("STOCK" in data ? "AJUSTE_STOCK" : "EDICION_MATERIAL");
      const detStock = addStock != null ? `Entrada +${addStock} unidades` : ("STOCK" in data ? `Stock modificado a ${data.STOCK}` : "Actualización de datos");
      await registrarBitacora(
        req,
        "ALMACEN",
        accionBit,
        `${detStock} en material #${id} (${newClave || oldClave} - ${data.DESCRIPCION || row.DESCRIPCION || ""})`,
        conn
      );

      await conn.commit();
      res.json({ ok: true, updated: true, id, clave: newClave, stock: "STOCK" in data ? data.STOCK : row.STOCK });
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
}

app.patch("/api/almacen/:id", authRequired, handleUpdateAlmacen);
app.put(["/api/almacen/:id", "/api/almacen/:id/actualizar"], authRequired, handleUpdateAlmacen);

// ============================================================================
// v44: REPORTE PDF INSTITUCIONAL DE ALMACÉN GENERAL (TODO O SELECCIONADOS)
// ============================================================================
async function handleAlmacenReportePdf(req, res) {
  try {
    let ids = [];
    if (req.body && Array.isArray(req.body.ids)) {
      ids = req.body.ids.map(Number).filter(n => Number.isFinite(n) && n > 0);
    } else if (req.query && req.query.ids) {
      ids = String(req.query.ids).split(',').map(n => Number(n.trim())).filter(n => Number.isFinite(n) && n > 0);
    }

    const catIsNum = await almCategoriaIsNumeric();
    const meta = await detectCategorias();
    const catMap = await getCategoriasNameMap();
    const hasUnidad = await hasAlmacenUnidad();
    const hasEstado = await hasAlmacenEstado();
    const almStatusCol = await detectAlmacenStatusCol();

    const unidadExpr = hasUnidad ? "a.UNIDAD" : "p.unidad";
    const statusSel = hasEstado && almStatusCol ? `a.${qi(almStatusCol)} AS status` : `'ACTIVO' AS status`;
    const joinProductos = "LEFT JOIN productos p ON p.CLAVE = a.CLAVE";

    let catSelect = "a.CATEGORIA AS categoria_raw, a.CATEGORIA AS categoria_nombre";
    let catJoin = "";
    if (meta.table && meta.id && meta.name) {
      catSelect = `a.CATEGORIA AS categoria_raw, COALESCE(c.${qi(meta.name).slice(1, -1)}, CAST(a.CATEGORIA AS CHAR)) AS categoria_nombre`;
      catJoin = catIsNum
        ? `LEFT JOIN ${qi(meta.table)} c ON c.${qi(meta.id)} = a.CATEGORIA`
        : `LEFT JOIN ${qi(meta.table)} c ON (TRIM(CAST(a.CATEGORIA AS CHAR)) REGEXP '^[0-9]+$' AND c.${qi(meta.id)} = CAST(TRIM(CAST(a.CATEGORIA AS CHAR)) AS UNSIGNED))`;
    }

    let whereSql = "WHERE 1=1";
    const queryParams = [];
    if (ids.length > 0) {
      whereSql += ` AND a.ID IN (${ids.map(() => '?').join(',')})`;
      queryParams.push(...ids);
    }

    const querySql = `
      SELECT a.ID, a.CLAVE, a.DESCRIPCION, ${catSelect},
             COALESCE(${unidadExpr}, 'PIEZA') AS unidad,
             COALESCE(a.STOCK, 0) AS stock,
             ${statusSel}
      FROM almacen_dregcivil a
      ${joinProductos}
      ${catJoin}
      ${whereSql}
      ORDER BY a.CLAVE ASC, a.ID ASC
    `;

    const [rows] = await poolRead.query(querySql, queryParams);

    const isFiltered = ids.length > 0;
    const reportTitle = isFiltered ? "REPORTE DE MATERIALES" : "CATÁLOGO E INVENTARIO GENERAL DE MATERIALES";
    const filename = isFiltered ? `reporte_materiales_${Date.now()}.pdf` : `inventario_general_almacen_${Date.now()}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

    // v56: Definición de documento y márgenes estilo docDefinition [left, top, right, bottom]
    // Se incrementa ampliamente el margen inferior (170 pt) para garantizar que las filas de la
    // tabla nunca colisionen con las firmas fijas ni desborden a una página en blanco.
    const docDefinition = {
      pageSize: "LETTER",
      pageMargins: [36, 30, 36, 170], // [left, top, right, bottom]
    };

    const doc = new PDFDocument({
      size: docDefinition.pageSize,
      margins: {
        top: docDefinition.pageMargins[1],
        bottom: 0, // margen inferior a 0 a nivel de motor para evitar salto fantasma de página en el footer
        left: docDefinition.pageMargins[0],
        right: docDefinition.pageMargins[2]
      },
      autoFirstPage: true,
      bufferPages: true
    });
    doc.pipe(res);

    const pageWidth = doc.page.width;   // 612 pt
    const pageHeight = doc.page.height; // 792 pt
    const leftX = docDefinition.pageMargins[0]; // 36 pt
    const rightLimit = pageWidth - docDefinition.pageMargins[2];  // 576 pt
    const contentWidth = rightLimit - leftX; // 540 pt

    const COLOR_PRIMARY = "#621132";
    const COLOR_SECONDARY = "#4E0D28";
    const COLOR_ACCENT = "#B38E5D";
    const COLOR_SOFT_BG = "#F8FAFC";
    const COLOR_BORDER = "#CBD5E1";

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

    const totalStock = rows.reduce((acc, r) => acc + (Number(r.stock) || 0), 0);
    const nowStr = new Date().toLocaleString("es-MX", { timeZone: "America/Mazatlan", hour12: false });

    function drawHeader() {
      if (logoGobPath && fs.existsSync(logoGobPath)) {
        try { doc.image(logoGobPath, leftX, 20, { fit: [95, 30], align: "left", valign: "top" }); } catch {}
      }
      if (logoBienPath && fs.existsSync(logoBienPath)) {
        try { doc.image(logoBienPath, rightLimit - 85, 20, { fit: [85, 30], align: "right", valign: "top" }); } catch {}
      }

      doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(10)
        .text("SECRETARÍA DE BIENESTAR", leftX, 18, { width: contentWidth, align: "center" });
      doc.fillColor("#1F2937").font("Helvetica-Bold").fontSize(9)
        .text("DELEGACIÓN DE PROGRAMAS PARA EL BIENESTAR EN BAJA CALIFORNIA SUR", leftX, 31, { width: contentWidth, align: "center" });
      doc.fillColor(COLOR_SECONDARY).font("Helvetica-Bold").fontSize(10)
        .text(reportTitle, leftX, 44, { width: contentWidth, align: "center" });

      doc.save();
      doc.moveTo(leftX + 80, 58).lineTo(rightLimit - 80, 58).lineWidth(1).strokeColor(COLOR_ACCENT).stroke();
      doc.restore();

      doc.fillColor("#4B5563").font("Helvetica").fontSize(7.5)
        .text(`Fecha y hora de emisión: ${nowStr} hrs  |  Total de artículos: ${rows.length}  |  Existencia total: ${totalStock.toLocaleString("es-MX")} unidades`, leftX, 62, { width: contentWidth, align: "center" });
    }

    // Column widths: Total = 540 pt
    const colW = { clave: 70, cat: 95, desc: 260, uni: 55, stock: 60 };
    const colX = {
      clave: leftX,
      cat: leftX + colW.clave,
      desc: leftX + colW.clave + colW.cat,
      uni: leftX + colW.clave + colW.cat + colW.desc,
      stock: leftX + colW.clave + colW.cat + colW.desc + colW.uni
    };

    function drawTableHeader(y) {
      doc.save();
      doc.rect(leftX, y, contentWidth, 18).fillColor(COLOR_PRIMARY).fill();
      doc.restore();

      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(7.5);
      doc.text("CLAVE", colX.clave + 4, y + 5, { width: colW.clave - 8, align: "left" });
      doc.text("CATEGORÍA", colX.cat + 4, y + 5, { width: colW.cat - 8, align: "left" });
      doc.text("DESCRIPCIÓN", colX.desc + 4, y + 5, { width: colW.desc - 8, align: "left" });
      doc.text("UNIDAD", colX.uni + 4, y + 5, { width: colW.uni - 8, align: "center" });
      doc.text("EXISTENCIA", colX.stock + 4, y + 5, { width: colW.stock - 8, align: "right" });

      return y + 18;
    }

    drawHeader();
    let currentY = drawTableHeader(76);

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const clave = String(r.CLAVE || "").trim();
      const cat = resolveCategoriaTexto(r.categoria_raw ?? r.CATEGORIA, r.categoria_nombre, catMap).toUpperCase();
      const desc = String(r.DESCRIPCION || "").trim();
      const uni = String(r.unidad || "PIEZA").trim().toUpperCase();
      const stock = Number(r.stock || 0);

      // Estimate height for description
      const descHeight = doc.font("Helvetica").fontSize(7.5).heightOfString(desc, { width: colW.desc - 8 });
      const rowHeight = Math.max(16, descHeight + 6);

      // Reserva de espacio inferior para firmas fijas y pie de página según docDefinition.pageMargins[3]
      const tableBottomLimit = pageHeight - docDefinition.pageMargins[3];
      if (currentY + rowHeight > tableBottomLimit) {
        doc.addPage();
        doc.page.margins.bottom = 0;
        drawHeader();
        currentY = drawTableHeader(76);
      }

      // Zebra background
      if (i % 2 === 1) {
        doc.save();
        doc.rect(leftX, currentY, contentWidth, rowHeight).fillColor(COLOR_SOFT_BG).fill();
        doc.restore();
      }

      // Draw bottom border
      doc.save();
      doc.moveTo(leftX, currentY + rowHeight).lineTo(rightLimit, currentY + rowHeight).lineWidth(0.5).strokeColor(COLOR_BORDER).stroke();
      doc.restore();

      // Draw text
      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(7.5)
        .text(clave, colX.clave + 4, currentY + 4, { width: colW.clave - 8, lineBreak: false });

      doc.fillColor("#374151").font("Helvetica").fontSize(7)
        .text(cat, colX.cat + 4, currentY + 4, { width: colW.cat - 8, lineBreak: false });

      doc.fillColor("#111827").font("Helvetica").fontSize(7.5)
        .text(desc, colX.desc + 4, currentY + 4, { width: colW.desc - 8 });

      doc.fillColor("#374151").font("Helvetica").fontSize(7)
        .text(uni, colX.uni + 4, currentY + 4, { width: colW.uni - 8, align: "center", lineBreak: false });

      const stockColor = stock <= 0 ? "#DC2626" : "#000000";
      doc.fillColor(stockColor).font("Helvetica-Bold").fontSize(7.5)
        .text(stock.toLocaleString("es-MX"), colX.stock + 4, currentY + 4, { width: colW.stock - 8, align: "right" });

      currentY += rowHeight;
    }

    // v56: Bloque de firmas anclado en la zona reservada del footer de la última página
    const sigY = pageHeight - 110;
    const sigW = 200;
    const sig1X = leftX + 40;
    const sig2X = rightLimit - 40 - sigW;

    doc.save();
    doc.moveTo(sig1X, sigY + 20).lineTo(sig1X + sigW, sigY + 20).lineWidth(0.75).strokeColor("#000000").stroke();
    doc.moveTo(sig2X, sigY + 20).lineTo(sig2X + sigW, sigY + 20).lineWidth(0.75).strokeColor("#000000").stroke();
    doc.restore();

    doc.fillColor("#000000").font("Helvetica-Bold").fontSize(7.5);
    doc.text("GABRIEL ADÁN FIOL COLLINS", sig1X, sigY + 24, { width: sigW, align: "center", lineBreak: false });
    doc.text("JORGE LUIS PATRÓN MURILLO", sig2X, sigY + 24, { width: sigW, align: "center", lineBreak: false });

    doc.fillColor("#4B5563").font("Helvetica").fontSize(7);
    doc.text("ENCARGADO DE ARCHIVOS Y MATERIALES", sig1X, sigY + 36, { width: sigW, align: "center", lineBreak: false });
    doc.text("COORDINADOR OPERATIVO DE RECURSOS MATERIALES", sig2X, sigY + 36, { width: sigW, align: "center", lineBreak: false });

    // Pie de página institucional (numeración de páginas asegurando bottom: 0 para evitar salto extra a hoja en blanco)
    const pages = doc.bufferedPageRange();
    for (let pIdx = 0; pIdx < pages.count; pIdx++) {
      doc.switchToPage(pIdx);
      doc.page.margins.bottom = 0;
      doc.fillColor("#6B7280").font("Helvetica").fontSize(7)
        .text(`Página ${pIdx + 1} de ${pages.count}  |  Sistema de Control de Inventario y Resguardo — Delegación BCS`, leftX, pageHeight - 24, { width: contentWidth, align: "center", lineBreak: false });
    }

    doc.end();
  } catch (err) {
    console.error("[ERROR] handleAlmacenReportePdf:", err);
    if (!res.headersSent) {
      return httpError(res, 500, err.message || "Error al generar reporte PDF de almacén");
    }
  }
}

app.post("/api/almacen/reporte-pdf", authRequired, handleAlmacenReportePdf);
app.get("/api/almacen/reporte-pdf", authRequired, handleAlmacenReportePdf);

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
const [dup] = await conn.query("SELECT CLAVE FROM productos WHERE UPPER(TRIM(CLAVE))=UPPER(TRIM(?)) LIMIT 1", [String(CLAVE)]);
if (dup.length) return httpError(res, 409, "⚠️ Error: La clave de producto ingresada ya existe. Por favor asigna una clave diferente.");

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
  const modoPruebaGrupal = await isModoPruebaGrupalActivo();
  const puedePdfSolicitud = canDownloadSolicitudPdf(req);

  res.json({
    ok: true,
    user: req.user?.username || null,
    rol: rol,
    rubro_id: userRubroId,
    scope: scope,
    modoPruebaGrupal: modoPruebaGrupal,
    puedeSeleccionarCualquierDepartamento: puedeSeleccionarDepto,
    permisos: {
      admin: admin,
      encargado: almacenEncargado,
      modoPruebaGrupal: modoPruebaGrupal,
      puedeAccederAlmacen: almacenEncargado,
      puedeEditarAlmacen: almacenEncargado,
      puedeEliminarAlmacen: admin,
      puedeAccederRegional: regionalAccess,
      puedeEditarRegional: puedeEditarReg,
      puedeGenerarPdfRegional: puedePdfReg,
      puedeUsarCuatroFirmas: puedeCuatroFirmas,
      puedeVerInventarioEstatal: canViewInventarioGeneral(req.user),
      puedeVerInventarioGeneral: canViewInventarioGeneral(req.user),
      puedeAccederTabletas: canAccessTabletas(req),
      puedeEditarTabletas: canEditTabletas(req),
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
        puedeSurtir: !isAuditorBlockedUser(req) && canManageSolicitudes(req),
        puedeCancelar: !isAuditorBlockedUser(req) && canManageSolicitudes(req),
        puedeEliminar: !isAuditorBlockedUser(req) && admin,
        puedeDescargarPdf: puedePdfSolicitud,
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
    if (!canDownloadSolicitudPdf(req)) {
      return httpError(res, 403, "Solo el Encargado de Almacén o el Administrador pueden imprimir el Vale PDF de suministros.");
    }
    await assertSolicitudAccess(req, id);

    // 1. Obtener datos de la solicitud, usuario, departamento y encargado del área
    let solicitud;
    {
      const deptoCol = await detectUsuarioDepartamentoCol();
      let r = [];
      try {
        const [rowsPdf] = await poolRead.query(
          `SELECT s.*,
            s.id_oficialia AS id_oficialia,
            u.username,
            u.nombre AS usuario_nombre,
            u.PRIMER_APELLIDO AS usuario_primer_apellido,
            u.SEGUNDO_APELLIDO AS usuario_segundo_apellido,
            ${deptoCol ? `u.${qi(deptoCol)} AS departamento,` : `NULL AS departamento,`}
            CONCAT_WS(' ', u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO) AS nombre_usuario,
            COALESCE(o.nombre, 'Sin Área') AS oficialia_nombre,
            COALESCE(NULLIF(TRIM(o.oficial_reponsable), ''), NULLIF(TRIM(dep.responsable), ''), '') AS encargado_area
          FROM solicitudes s
          LEFT JOIN oficialias o ON o.id = s.id_oficialia
          LEFT JOIN departamentos dep ON dep.id = s.id_oficialia
          LEFT JOIN usuario u ON u.id = s.usuario_id
          WHERE s.id = ? LIMIT 1`,
          [id]
        );
        r = rowsPdf;
      } catch {
        const [rowsPdf] = await poolRead.query(
          `SELECT s.*,
            s.id_oficialia AS id_oficialia,
            u.username,
            u.nombre AS usuario_nombre,
            u.PRIMER_APELLIDO AS usuario_primer_apellido,
            u.SEGUNDO_APELLIDO AS usuario_segundo_apellido,
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
        r = rowsPdf;
      }
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
          d.cantidad, d.cantidad_surtida, d.atendida, d.observaciones
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
    const nombreUsuarioLimpio = buildCleanFullName(
      solicitud.usuario_nombre,
      solicitud.usuario_primer_apellido,
      solicitud.usuario_segundo_apellido
    );
    const solicitaEncargado = String(
      solicitud.nombre_solicitante_firma ||
      solicitud.encargado_area ||
      nombreUsuarioLimpio ||
      solicitud.nombre_usuario ||
      pickUsuarioServer(solicitud) ||
      ""
    ).trim();

    // Datos para las 5 firmas de Vale de Suministro:
    // 1. SOLICITANTE | 2. ENTREGA (Gabriel Adán Fiol Collins) | 3. VALIDA (Jorge Luis Patrón Murillo) | 4. RECIBE | 5. AUTORIZA (Delegada)
    const entregaCargo = process.env.VALE_ENTREGA_CARGO || "ENCARGADO DE ARCHIVOS Y MATERIALES";
    const entregaNombre = process.env.VALE_ENTREGA_NOMBRE || "GABRIEL ADÁN FIOL COLLINS";
    const validaCargo = process.env.VALE_VALIDA_CARGO || "COORDINADOR OPERATIVO DE RECURSOS MATERIALES";
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
      const entVal = item
        ? (item.cantidad_surtida !== null && item.cantidad_surtida !== undefined
            ? Number(item.cantidad_surtida)
            : (Number(item.atendida || 0) > 0 ? Number(item.atendida) : Number(item.cantidad || 0)))
        : 0;
      const entText = item ? String(entVal) : "";

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
    const firmaSolSource = solicitud.firma_solicitante || solicitud.firma_solicitante_data || null;
    const hasDigitalSig = Boolean(firmaSolSource && String(firmaSolSource).includes("base64,"));
    const hasRecibeSig = Boolean(solicitud.firma_recibe_data && String(solicitud.firma_recibe_data).includes("base64,"));

    // Validación específica por región para firma 4 (RECIBE)
    const isMulegeSol = Boolean(
      Number(solicitud.id_oficialia) === 30030010 ||
      Number(solicitud.ID_OFICIALIA) === 30030010 ||
      String(solicitud.username || "").toLowerCase() === "mulege" ||
      /muleg[eé]/i.test(String(solicitud.oficialia_nombre || "")) ||
      /muleg[eé]/i.test(String(solicitud.departamento || "")) ||
      /muleg[eé]/i.test(String(areaNombre || "")) ||
      /muleg[eé]/i.test(String(regionSolicitante || ""))
    );
    const isLosCabosSol = Boolean(
      Number(solicitud.id_oficialia) === 30030009 ||
      Number(solicitud.ID_OFICIALIA) === 30030009 ||
      String(solicitud.username || "").toLowerCase() === "loscabos" ||
      /cabos/i.test(String(solicitud.oficialia_nombre || "")) ||
      /cabos/i.test(String(solicitud.departamento || "")) ||
      /cabos/i.test(String(areaNombre || "")) ||
      /cabos/i.test(String(regionSolicitante || ""))
    );
    const isComonduSol = Boolean(
      Number(solicitud.id_oficialia) === 30030011 ||
      Number(solicitud.ID_OFICIALIA) === 30030011 ||
      String(solicitud.username || "").toLowerCase() === "comondu" ||
      /comond[uú]|loreto/i.test(String(solicitud.oficialia_nombre || "")) ||
      /comond[uú]|loreto/i.test(String(solicitud.departamento || "")) ||
      /comond[uú]|loreto/i.test(String(areaNombre || "")) ||
      /comond[uú]|loreto/i.test(String(regionSolicitante || ""))
    );
    const isRegForaneaSol = isMulegeSol || isLosCabosSol || isComonduSol;
    const titularRegionalSolFallback = isMulegeSol
      ? "DIANA RAMÍREZ HERNÁNDEZ"
      : isLosCabosSol
        ? "SAMIR SAVIN RUIZ"
        : isComonduSol
          ? "HUMBERTO ARCE CORDERO"
          : "";

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
        cargo: isRegForaneaSol ? String(solicitud.recibe_cargo || "Director Regional").trim() : String(solicitud.recibe_cargo || "").trim(),
        nombre: isRegForaneaSol
          ? String(solicitud.recibe_nombre || solicitud.encargado_area || solicitud.nombre_usuario || titularRegionalSolFallback).trim()
          : String(solicitud.recibe_nombre || "Nombre y firma de quien recibe el material").trim(),
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
          const b64Clean = String(firmaSolSource).split("base64,")[1];
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
    const isAdminUser = isAdmin(req) || uName === "admin";
    const isAdminOrDirectivo = isAdminUser || ["jorge", "jorgepatron", "rodrigo"].includes(uName);
    const canSeeRM =
      ((isAdminOrDirectivo || uName === "evelia") && (!effectiveRubroId || effectiveRubroId === 2)) ||
      ((isAdminOrDirectivo || uName === "jesus") && (!effectiveRubroId || effectiveRubroId === 3));
    const isMobiliario = effectiveRubroId === 3 || uName === "jesus";
    const isVehicular =
      effectiveRubroId === 2 ||
      uName === "evelia" ||
      String(req.query?.modulo || "").toLowerCase() === "vehiculos" ||
      String(req.query?.tipo || "").toLowerCase() === "vehiculos";
    const canSeeSA = isAdminUser || isAdminOrDirectivo || isMobiliario || uName === "jesus";

    // v47: Asegurar que exista al menos una oficina S/A (Sin Asignar) cuando el usuario tiene permiso de verla
    const hasAnySA = rows.some((o) => {
      const n = String(o.nombre || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      return n.includes("s/a") || n.includes("sin asignar");
    });
    if (canSeeSA && !hasAnySA && (!hasRegion || regionId === 1)) {
      try {
        await poolOps.query(
          `INSERT INTO oficinas_regionales (region_id, municipio, nombre, responsable_oficina, activo)
           SELECT 1, 'La Paz', 'S/A (Sin Asignar)', 'Pendiente Regional', 1
           FROM DUAL
           WHERE NOT EXISTS (
             SELECT 1 FROM oficinas_regionales
             WHERE LOWER(nombre) LIKE '%s/a%' OR LOWER(nombre) LIKE '%sin asignar%'
           )`
        );
        const [saRows] = await poolRead.query(
          `SELECT o.id, o.region_id, r.nombre AS region_nombre, r.clave AS region_clave,
                  o.municipio, o.nombre, o.responsable_oficina, o.activo, o.created_at
           FROM oficinas_regionales o
           LEFT JOIN regiones r ON r.id = o.region_id
           WHERE (LOWER(o.nombre) LIKE '%s/a%' OR LOWER(o.nombre) LIKE '%sin asignar%')
             AND (? = 0 OR o.region_id = ?)
           ORDER BY o.id ASC`,
          [hasRegion ? 1 : 0, hasRegion ? regionId : 0]
        );
        for (const sr of saRows || []) {
          if (!rows.some((r) => Number(r.id) === Number(sr.id))) rows.push(sr);
        }
      } catch (_) {}
    }

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
      if (isSA) {
        // v55: Ni evelia ni el módulo de vehículos pueden ver o asignar a oficinas S/A
        if (isVehicular || uName === "evelia") return false;
        return canSeeSA;
      }

      // v55: Ni evelia ni el módulo de vehículos pueden ver o asignar a Coordinación Regional La Paz
      const isCoordRegionalLaPaz =
        nombreNorm.includes("coordinacion regional la paz") ||
        nombreNorm.includes("coordinacion regional") ||
        nombreNorm === "coordinacion regional la paz";
      if (isCoordRegionalLaPaz && (isVehicular || uName === "evelia")) {
        return false;
      }

      if (isMobiliario) {
        if (Number(o.id) === 1 || nombreNorm.includes("delegacion la paz")) return false;
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
         AND id NOT IN (1, 4)
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
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'inventario_oficina'`,
      [DB_NAME]
    );
    const colSet = new Set(cols.map((c) => String(c.COLUMN_NAME || "").toLowerCase()));
    const neededCols = [
      { name: "detalles_vehiculo", ddl: "LONGTEXT DEFAULT NULL" },
      { name: "resguardante_nombre", ddl: "VARCHAR(180) DEFAULT NULL" },
      { name: "resguardante_rfc", ddl: "VARCHAR(30) DEFAULT NULL" },
      { name: "resguardante_puesto", ddl: "VARCHAR(150) DEFAULT NULL" },
      { name: "resguardante_adscripcion", ddl: "VARCHAR(180) DEFAULT NULL" },
      { name: "resguardante_programa", ddl: "VARCHAR(180) DEFAULT NULL" },
      { name: "resguardante_licencia", ddl: "VARCHAR(60) DEFAULT NULL" },
      { name: "resguardante_vigencia_licencia", ddl: "VARCHAR(60) DEFAULT NULL" },
    ];
    if (poolOps) {
      for (const col of neededCols) {
        if (!colSet.has(col.name)) {
          await poolOps.query(`ALTER TABLE inventario_oficina ADD COLUMN ${qi(col.name)} ${col.ddl}`).catch(() => {});
        }
      }
    }
    INV_HAS_DETALLES_VEHICULO = colSet.has("detalles_vehiculo") || Boolean(poolOps);
    return INV_HAS_DETALLES_VEHICULO;
  } catch (err) {
    console.warn("[WARN] No se pudo verificar/crear columnas de vehículo/resguardante:", err?.message || err);
  }
  return INV_HAS_DETALLES_VEHICULO;
}

function normalizeRegionalCargo(rawCargo) {
  const s = String(rawCargo || "").trim();
  if (!s) return "";
  return s
    .replace(/Coordinadora?\s+Regionall?(\s+(de\s+)?(Muleg[eé]|Los\s+Cabos|Comond[uú](\s*\/\s*Loreto)?|La\s+Paz))?/gi, "Director Regional")
    .replace(/Coordinadora?\s+Regionall?/gi, "Director Regional");
}

function extractResguardanteFields(body = {}, detallesObj = null, existingRow = null) {
  const detResg = (detallesObj && detallesObj.resguardante && typeof detallesObj.resguardante === "object")
    ? detallesObj.resguardante
    : {};
  const exDet = existingRow && existingRow.detalles_vehiculo ? parseDetallesVehiculo(existingRow.detalles_vehiculo) : null;
  const exResg = (exDet && exDet.resguardante && typeof exDet.resguardante === "object") ? exDet.resguardante : {};

  const pick = (bodyKeys, detKey, colKey, upper = false) => {
    for (const k of bodyKeys) {
      if (body[k] !== undefined && body[k] !== null) {
        const v = String(body[k]).trim();
        return upper ? v.toUpperCase() : v;
      }
    }
    if (detResg[detKey] !== undefined && detResg[detKey] !== null) {
      const v = String(detResg[detKey]).trim();
      return upper ? v.toUpperCase() : v;
    }
    if (existingRow && existingRow[colKey] !== undefined && existingRow[colKey] !== null && String(existingRow[colKey]).trim() !== "") {
      const v = String(existingRow[colKey]).trim();
      return upper ? v.toUpperCase() : v;
    }
    if (exResg[detKey] !== undefined && exResg[detKey] !== null) {
      const v = String(exResg[detKey]).trim();
      return upper ? v.toUpperCase() : v;
    }
    return "";
  };

  return {
    resguardante_nombre: pick(["resguardante_nombre", "nombre_resguardante"], "nombre_completo", "resguardante_nombre", false),
    resguardante_rfc: pick(["resguardante_rfc", "rfc_resguardante"], "rfc", "resguardante_rfc", true),
    resguardante_puesto: normalizeRegionalCargo(pick(["resguardante_puesto", "puesto_resguardante"], "puesto", "resguardante_puesto", false)),
    resguardante_adscripcion: pick(["resguardante_adscripcion", "adscripcion_resguardante"], "adscripcion", "resguardante_adscripcion", false),
    resguardante_programa: pick(["resguardante_programa", "programa_resguardante"], "programa", "resguardante_programa", false),
    resguardante_licencia: pick(["resguardante_licencia", "licencia_resguardante"], "licencia_no", "resguardante_licencia", true),
    resguardante_vigencia_licencia: pick(["resguardante_vigencia_licencia", "vigencia_licencia_resguardante", "resguardante_vigencia"], "vigencia_licencia", "resguardante_vigencia_licencia", false),
  };
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

async function queryRegionalInventory({ region_id, oficina_id, rubro_id, activo_id, forceUngrouped = false, includeBodega = false }) {
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

  // En La Paz (region_id = 1) cuando el usuario tiene acceso a bodega RM (ej. Jesús o Admin),
  // no agrupamos para que pueda ver y transferir individualmente entre RM y Coordinación Regional La Paz.
  const shouldGroup = !hasOficina && hasRegion && !hasActivo && !forceUngrouped && !isParqueVehicular && !(regionId === 1 && includeBodega);

  if (shouldGroup) {
    const [rows] = await poolRead.query(
      `SELECT
         MIN(io.id) AS id,
         io.clave_bien,
         io.descripcion,
         io.marca_modelo,
         GROUP_CONCAT(DISTINCT NULLIF(TRIM(io.numero_serie_placas), '') SEPARATOR ', ') AS numero_serie_placas,
         MAX(io.unidad) AS unidad,
         SUM(io.cantidad_propia) AS cantidad_propia,
         SUM(COALESCE(io.cantidad_disponible, io.cantidad_propia)) AS cantidad_disponible,
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
       COALESCE(io.cantidad_disponible, io.cantidad_propia) AS cantidad_disponible,
       io.cantidad_prestada_recibida,
       io.cantidad_prestada_enviada,
       io.es_bodega_delegacion,
       io.estado_fisico,
       io.estatus_uso,
       io.observaciones,
       io.origen_adquisicion,
       io.observaciones_control,
       ${hasDetCol ? "io.detalles_vehiculo, io.resguardante_nombre, io.resguardante_rfc, io.resguardante_puesto, io.resguardante_adscripcion, io.resguardante_programa, io.resguardante_licencia, io.resguardante_vigencia_licencia" : "NULL AS detalles_vehiculo, NULL AS resguardante_nombre, NULL AS resguardante_rfc, NULL AS resguardante_puesto, NULL AS resguardante_adscripcion, NULL AS resguardante_programa, NULL AS resguardante_licencia, NULL AS resguardante_vigencia_licencia"},
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
       AND (? = 1 OR io.rubro_id != 2 OR (o.nombre NOT LIKE '%S/A%' AND o.nombre NOT LIKE '%Sin Asignar%'))
       AND (io.rubro_id != 3 OR io.oficina_id != 1)
       AND (? = 1 OR COALESCE(io.es_bodega_delegacion, 0) = 0)
     ORDER BY r.id ASC, o.id ASC, io.clave_bien ASC`,
    [
      hasRegion ? 1 : 0, hasRegion ? regionId : 0,
      hasOficina ? 1 : 0, hasOficina ? oficinaId : 0,
      hasRubro ? 1 : 0, hasRubro ? rubroId : 0,
      hasActivo ? 1 : 0, hasActivo ? activoId : 0,
      hasOficina ? 1 : 0,
      includeBodega ? 1 : 0,
    ]
  );
  return {
    grouped: false,
    rows: rows.map((r) => {
      const det = parseDetallesVehiculo(r.detalles_vehiculo);
      const resg = extractResguardanteFields({}, det, r);
      if (det && typeof det === "object") {
        det.resguardante = {
          nombre_completo: resg.resguardante_nombre,
          rfc: resg.resguardante_rfc,
          puesto: resg.resguardante_puesto,
          adscripcion: resg.resguardante_adscripcion,
          programa: resg.resguardante_programa,
          licencia_no: resg.resguardante_licencia,
          vigencia_licencia: resg.resguardante_vigencia_licencia,
        };
      }
      return {
        ...r,
        ...resg,
        detalles_vehiculo: det,
      };
    }),
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
      includeBodega: canEdit,
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

// Alta de un activo en el inventario de una oficina regional (incluye soporte híbrido para PARQUE_VEHICULAR y fusión automática en RM)
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
    const claveBienNorm = String(b.clave_bien ?? "").trim().toUpperCase();
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
    if (!claveBienNorm) return httpError(res, 400, "Clave del bien requerida");
    if (!descripcion) return httpError(res, 400, "Descripción requerida");
    const isAdminEditor = isAdmin(req) || String(req.user?.rol || "").trim().toLowerCase() === "admin";
    if (!Number.isInteger(cantidad) || cantidad < 0) {
      return httpError(res, 400, "La cantidad debe ser un entero mayor o igual a 0");
    }
    if (!["BUENO", "REGULAR", "MALO", "BAJA", "SINIESTRO / EN ASEGURADORA", "NO DISPONIBLE (SINIESTRO)"].includes(estadoFisico)) return httpError(res, 400, "Estado físico inválido");
    if (!["ACTIVO", "PRESTADO", "EN_REPARACION", "BAJA", "SINIESTRO / EN ASEGURADORA", "NO DISPONIBLE (SINIESTRO)"].includes(estatusUso)) return httpError(res, 400, "Estatus de uso inválido");
    if (claveBienNorm.length > 60) return httpError(res, 400, "La clave del bien excede 60 caracteres");
    if (descripcion.length > 255) return httpError(res, 400, "La descripción excede 255 caracteres");
    if (marcaModelo && marcaModelo.length > 150) return httpError(res, 400, "Marca / Modelo excede 150 caracteres");
    if (seriePlacas && seriePlacas.length > 100) return httpError(res, 400, "Serie / Placas excede 100 caracteres");

    const [[ofi]] = await poolRead.query(`SELECT id, nombre FROM oficinas_regionales WHERE id = ? LIMIT 1`, [oficinaId]);
    if (!ofi) return httpError(res, 400, "La oficina seleccionada no existe");
    const [[rub]] = await poolRead.query(`SELECT id FROM rubros_inventario WHERE id = ? LIMIT 1`, [rubroId]);
    if (!rub) return httpError(res, 400, "El rubro seleccionado no existe");

    const destIsRM = /rm\b|recursos materiales/i.test(String(ofi.nombre || ""));
    const esBodegaVal = destIsRM || oficinaId === 1 ? 1 : 0;

    // v53: Bloqueo estricto de claves duplicadas sin auto-renumerar en inventario regional
    const [dupRows] = await poolRead.query(
      `SELECT id FROM inventario_oficina
       WHERE oficina_id = ?
         AND UPPER(TRIM(clave_bien)) = ?
       LIMIT 1`,
      [oficinaId, claveBienNorm]
    );
    if (dupRows && dupRows.length > 0) {
      return httpError(res, 409, "⚠️ Error: La clave de producto ingresada ya existe. Por favor asigna una clave diferente.");
    }

    const resgFields = extractResguardanteFields(b, detallesVehiculoObj, null);
    let finalDetallesObj = detallesVehiculoObj;
    const hasAnyResg = Object.values(resgFields).some((v) => String(v || "").trim() !== "");
    if (finalDetallesObj || hasAnyResg || Number(rubroId) === 2) {
      finalDetallesObj = finalDetallesObj && typeof finalDetallesObj === "object" ? { ...finalDetallesObj } : {};
      finalDetallesObj.resguardante = {
        nombre_completo: resgFields.resguardante_nombre,
        rfc: resgFields.resguardante_rfc,
        puesto: resgFields.resguardante_puesto,
        adscripcion: resgFields.resguardante_adscripcion,
        programa: resgFields.resguardante_programa,
        licencia_no: resgFields.resguardante_licencia,
        vigencia_licencia: resgFields.resguardante_vigencia_licencia,
      };
    }
    const detallesJson = finalDetallesObj ? JSON.stringify(finalDetallesObj) : null;

    let result;
    if (hasDetCol) {
      [result] = await poolOps.query(
        `INSERT INTO inventario_oficina
           (oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas, cantidad_propia, cantidad_disponible, es_bodega_delegacion, estado_fisico, estatus_uso, observaciones, origen_adquisicion, observaciones_control, detalles_vehiculo,
            resguardante_nombre, resguardante_rfc, resguardante_puesto, resguardante_adscripcion, resguardante_programa, resguardante_licencia, resguardante_vigencia_licencia)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          oficinaId, rubroId, claveBienNorm, descripcion, marcaModelo, seriePlacas, cantidad, cantidad, esBodegaVal, estadoFisico, estatusUso, observaciones, origenAdquisicion, observacionesControl, detallesJson,
          resgFields.resguardante_nombre || null,
          resgFields.resguardante_rfc || null,
          resgFields.resguardante_puesto || null,
          resgFields.resguardante_adscripcion || null,
          resgFields.resguardante_programa || null,
          resgFields.resguardante_licencia || null,
          resgFields.resguardante_vigencia_licencia || null,
        ]
      );
    } else {
      [result] = await poolOps.query(
        `INSERT INTO inventario_oficina
           (oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas, cantidad_propia, cantidad_disponible, es_bodega_delegacion, estado_fisico, estatus_uso, observaciones, origen_adquisicion, observaciones_control)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [oficinaId, rubroId, claveBienNorm, descripcion, marcaModelo, seriePlacas, cantidad, cantidad, esBodegaVal, estadoFisico, estatusUso, observaciones, origenAdquisicion, observacionesControl]
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
        [claveBienNorm, descripcion, b.unidad || 'PIEZA', cantidad, origenAdquisicion, observacionesControl]
      ).catch(() => {});
    }

    return res.status(201).json({ ok: true, id: result.insertId });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// Edición directa y permanente de un activo por su ID único en inventario_oficina (sin fusiones ni agrupaciones)
app.put("/api/inventario-regional/:id", authRequired, async (req, res) => {
  try {
    if (!canEditRegional(req)) {
      return httpError(res, 403, "Modo Solo Lectura: solo los encargados de rubro y administración pueden editar bienes del inventario regional.");
    }
    const assignedRubroId = getUserRubroId(req);
    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) return httpError(res, 400, "ID de activo inválido");

    const [[existingAsset]] = await poolRead.query(
      `SELECT * FROM inventario_oficina WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!existingAsset) return httpError(res, 404, "Activo no encontrado");
    if (assignedRubroId && Number(existingAsset.rubro_id) !== Number(assignedRubroId)) {
      return httpError(res, 403, "Solo puedes editar activos del rubro del cual eres encargado.");
    }

    const hasDetCol = await ensureDetallesVehiculoCol();
    const b = req.body || {};
    const oficinaId = Number(b.oficina_id || 0);
    const rubroId = assignedRubroId ? Number(assignedRubroId) : Number(b.rubro_id || 0);
    const claveBienNorm = String(b.clave_bien ?? "").trim().toUpperCase();
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
    if (!claveBienNorm) return httpError(res, 400, "Clave del bien requerida");
    if (!descripcion) return httpError(res, 400, "Descripción requerida");
    const isAdminEditor = isAdmin(req) || String(req.user?.rol || "").trim().toLowerCase() === "admin";
    if (!Number.isInteger(cantidad) || cantidad < 0) {
      return httpError(res, 400, "La cantidad debe ser un entero mayor o igual a 0");
    }
    if (!["BUENO", "REGULAR", "MALO", "BAJA", "SINIESTRO / EN ASEGURADORA", "NO DISPONIBLE (SINIESTRO)"].includes(estadoFisico)) return httpError(res, 400, "Estado físico inválido");
    if (!["ACTIVO", "PRESTADO", "EN_REPARACION", "BAJA", "SINIESTRO / EN ASEGURADORA", "NO DISPONIBLE (SINIESTRO)"].includes(estatusUso)) return httpError(res, 400, "Estatus de uso inválido");

    const [[ofi]] = await poolRead.query(`SELECT id, nombre FROM oficinas_regionales WHERE id = ? LIMIT 1`, [oficinaId]);
    if (!ofi) return httpError(res, 400, "La oficina seleccionada no existe");
    const destIsRM = /rm\b|recursos materiales/i.test(String(ofi.nombre || ""));
    const esBodegaVal = destIsRM || oficinaId === 1 ? 1 : 0;

    // v53: Bloqueo estricto de claves duplicadas sin auto-renumerar en inventario regional (Ediciones)
    const [dupEdit] = await poolRead.query(
      `SELECT id FROM inventario_oficina
       WHERE oficina_id = ?
         AND UPPER(TRIM(clave_bien)) = ?
         AND id <> ?
       LIMIT 1`,
      [oficinaId, claveBienNorm, id]
    );
    if (dupEdit && dupEdit.length > 0) {
      return httpError(res, 409, "⚠️ Error: La clave de producto ingresada ya existe. Por favor asigna una clave diferente.");
    }

    const resgFields = extractResguardanteFields(b, detallesVehiculoObj, existingAsset);
    let finalDetallesObj = detallesVehiculoObj || parseDetallesVehiculo(existingAsset.detalles_vehiculo);
    const hasAnyResg = Object.values(resgFields).some((v) => String(v || "").trim() !== "");
    if (finalDetallesObj || hasAnyResg || Number(rubroId) === 2) {
      finalDetallesObj = finalDetallesObj && typeof finalDetallesObj === "object" ? { ...finalDetallesObj } : {};
      finalDetallesObj.resguardante = {
        nombre_completo: resgFields.resguardante_nombre,
        rfc: resgFields.resguardante_rfc,
        puesto: resgFields.resguardante_puesto,
        adscripcion: resgFields.resguardante_adscripcion,
        programa: resgFields.resguardante_programa,
        licencia_no: resgFields.resguardante_licencia,
        vigencia_licencia: resgFields.resguardante_vigencia_licencia,
      };
    }
    const detallesJson = finalDetallesObj ? JSON.stringify(finalDetallesObj) : null;
    // Calcular prestado activo en BD estrictamente por el ID único del artículo (sin agrupar por nombre o clave)
    const [[prestLiveRow]] = await poolRead.query(
      `SELECT COALESCE(SUM(COALESCE(vpd.cantidad, 0)), 0) AS prestado_activo
       FROM vales_prestamo_detalle vpd
       WHERE vpd.articulo_id = ?
         AND COALESCE(vpd.estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')
         AND vpd.vale_id IN (
           SELECT vp.id
           FROM vales_prestamo vp
           WHERE vp.estado NOT IN ('DEVUELTO', 'CANCELADO', 'RECHAZADO')
         )`,
      [id]
    ).catch(() => [[{ prestado_activo: existingAsset.cantidad_prestada_enviada || 0 }]]);
    const nuevoPrestado = Math.max(0, Number(prestLiveRow?.prestado_activo || 0));
    let nuevaDisponible = Math.max(0, cantidad - nuevoPrestado);
    if (isAdminEditor && b.cantidad_disponible !== undefined && b.cantidad_disponible !== null && b.cantidad_disponible !== "") {
      const dispAdmin = Number(b.cantidad_disponible);
      if (Number.isInteger(dispAdmin) && dispAdmin >= 0) nuevaDisponible = dispAdmin;
    }

    if (hasDetCol) {
      await poolOps.query(
        `UPDATE inventario_oficina
         SET oficina_id = ?, rubro_id = ?, clave_bien = ?, descripcion = ?,
             marca_modelo = ?, numero_serie_placas = ?, cantidad_propia = ?,
             cantidad_disponible = ?, cantidad_prestada_enviada = ?, es_bodega_delegacion = ?,
             estado_fisico = ?, estatus_uso = ?, observaciones = ?,
             origen_adquisicion = ?, observaciones_control = ?, detalles_vehiculo = ?,
             resguardante_nombre = ?, resguardante_rfc = ?, resguardante_puesto = ?,
             resguardante_adscripcion = ?, resguardante_programa = ?,
             resguardante_licencia = ?, resguardante_vigencia_licencia = ?
         WHERE id = ?`,
        [
          oficinaId, rubroId, claveBienNorm, descripcion, marcaModelo, seriePlacas, cantidad, nuevaDisponible, nuevoPrestado, esBodegaVal, estadoFisico, estatusUso, observaciones, origenAdquisicion, observacionesControl, detallesJson,
          resgFields.resguardante_nombre || null,
          resgFields.resguardante_rfc || null,
          resgFields.resguardante_puesto || null,
          resgFields.resguardante_adscripcion || null,
          resgFields.resguardante_programa || null,
          resgFields.resguardante_licencia || null,
          resgFields.resguardante_vigencia_licencia || null,
          id
        ]
      );
    } else {
      await poolOps.query(
        `UPDATE inventario_oficina
         SET oficina_id = ?, rubro_id = ?, clave_bien = ?, descripcion = ?,
             marca_modelo = ?, numero_serie_placas = ?, cantidad_propia = ?,
             cantidad_disponible = ?, cantidad_prestada_enviada = ?, es_bodega_delegacion = ?,
             estado_fisico = ?, estatus_uso = ?, observaciones = ?,
             origen_adquisicion = ?, observaciones_control = ?
         WHERE id = ?`,
        [oficinaId, rubroId, claveBienNorm, descripcion, marcaModelo, seriePlacas, cantidad, nuevaDisponible, nuevoPrestado, esBodegaVal, estadoFisico, estatusUso, observaciones, origenAdquisicion, observacionesControl, id]
      );
    }

    if (oficinaId === 1 && rubroId === 1) {
      await poolOps.query(
        `UPDATE almacen_dregcivil
         SET CLAVE = ?, DESCRIPCION = ?, UNIDAD = ?, STOCK = ?, origen_adquisicion = ?, observaciones_control = ?
         WHERE CLAVE = ?`,
        [claveBienNorm, descripcion, b.unidad || 'PIEZA', cantidad, origenAdquisicion, observacionesControl, String(existingAsset.clave_bien || claveBienNorm)]
      ).catch(() => {});
    }

    await registrarBitacora(
      req,
      "REGIONAL",
      "EDICION_ACTIVO",
      `Edición directa del activo ID #${id} [${claveBienNorm}] "${descripcion}": cantidad_propia ${existingAsset.cantidad_propia} -> ${cantidad}, cantidad_disponible -> ${nuevaDisponible}, prestado_activo=${nuevoPrestado}.`
    );

    return res.json({
      ok: true,
      id,
      cantidad_propia: cantidad,
      cantidad_disponible: nuevaDisponible,
      cantidad_prestada_enviada: nuevoPrestado
    });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// ============================================================================
// v52: ELIMINACIÓN DE ACTIVO DEL INVENTARIO REGIONAL (EXCLUSIVO ADMINISTRADOR)
// ============================================================================
app.delete("/api/inventario-regional/:id", authRequired, async (req, res) => {
  try {
    const rolNorm = String(req.user?.rol || "").trim().toLowerCase();
    const isUserAdmin = isAdmin(req) || rolNorm === "admin" || String(req.user?.username || "").toLowerCase() === "admin";
    if (!isUserAdmin) {
      return httpError(res, 403, "Acceso denegado: solo el Administrador puede eliminar activos del inventario regional.");
    }

    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) {
      return httpError(res, 400, "ID de activo inválido.");
    }

    const [[existing]] = await poolRead.query(
      `SELECT id, clave_bien, descripcion, oficina_id FROM inventario_oficina WHERE id = ? LIMIT 1`,
      [id]
    );

    if (!existing) {
      return httpError(res, 404, "El activo que intentas eliminar no existe.");
    }

    // Desvincular referencias en vales_prestamo_detalle si existen
    await poolOps.query(
      `UPDATE vales_prestamo_detalle SET articulo_id = NULL WHERE articulo_id = ?`,
      [id]
    ).catch(() => {});
    await poolOps.query(
      `UPDATE vales_prestamo_detalle SET inventario_id = NULL WHERE inventario_id = ?`,
      [id]
    ).catch(() => {});

    await poolOps.query(`DELETE FROM inventario_oficina WHERE id = ?`, [id]);

    await registrarBitacora(
      req,
      "REGIONAL",
      "ELIMINAR_REGIONAL",
      `Se eliminó el artículo. Clave: ${existing.clave_bien || "S/C"} - ${existing.descripcion || "Sin descripción"} (ID interno BD: ${id})`
    );

    return res.json({
      ok: true,
      message: `Activo con ID ${id} eliminado exitosamente del inventario regional.`,
      id
    });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al eliminar activo regional");
  }
});

// Forzar Retorno (God Mode Admin): restaura cantidad_disponible = cantidad_propia, limpia préstamos retenidos y pone estatus ACTIVO
async function handleForzarRetornoInventarioRegional(req, res) {
  try {
    const isAdminEditor = isAdmin(req) || String(req.user?.rol || "").trim().toLowerCase() === "admin";
    if (!isAdminEditor) {
      return httpError(res, 403, "Solo el Administrador tiene permisos para forzar el retorno de stock.");
    }
    const id = Number(req.params.id || 0);
    if (!Number.isInteger(id) || id <= 0) {
      return httpError(res, 400, "ID de activo inválido");
    }

    const [[existingAsset]] = await poolRead.query(
      `SELECT * FROM inventario_oficina WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!existingAsset) {
      return httpError(res, 404, "Activo no encontrado en inventario_oficina");
    }

    const colKeys = new Set(Object.keys(existingAsset).map((k) => k.toLowerCase()));
    const setParts = [
      "cantidad_disponible = cantidad_propia",
      "cantidad_prestada_enviada = 0",
      "estatus_uso = 'ACTIVO'"
    ];
    if (colKeys.has("estatus")) {
      setParts.push("estatus = 'Activo'");
    }
    if (colKeys.has("resguardante_provisional")) {
      setParts.push("resguardante_provisional = NULL");
    }
    if (colKeys.has("fecha_prestamo")) {
      setParts.push("fecha_prestamo = NULL");
    }

    await poolOps.query(
      `UPDATE inventario_oficina
       SET ${setParts.join(", ")}
       WHERE id = ?`,
      [id]
    );

    // v53: Actualizar registros abiertos/pendientes de este activo en vales_prestamo_detalle y encabezados
    const [affectedVales] = await poolRead.query(
      `SELECT DISTINCT vale_id
       FROM vales_prestamo_detalle
       WHERE (articulo_id = ? OR inventario_id = ?)
         AND COALESCE(estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')`,
      [id, id]
    ).catch(() => [[]]);

    // Marcar los ítems pendientes de este activo como devueltos
    await poolOps.query(
      `UPDATE vales_prestamo_detalle
       SET estado_devolucion = 'DEVUELTO',
           devuelto = 1,
           cantidad_devuelta = cantidad,
           fecha_devolucion = NOW(),
           observaciones = CONCAT(COALESCE(observaciones, ''), ' [Retorno Forzado por Admin]')
       WHERE (articulo_id = ? OR inventario_id = ?)
         AND COALESCE(estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')`,
      [id, id]
    ).catch(async () => {
      await poolOps.query(
        `UPDATE vales_prestamo_detalle
         SET estado_devolucion = 'DEVUELTO'
         WHERE (articulo_id = ? OR inventario_id = ?)
           AND COALESCE(estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')`,
        [id, id]
      ).catch(() => {});
    });

    // Para cada vale afectado, si todos sus ítems ya están devueltos, actualizar encabezado en vales_prestamo
    if (affectedVales && affectedVales.length > 0) {
      for (const row of affectedVales) {
        const vId = row.vale_id;
        if (!vId) continue;
        const [[pendingCount]] = await poolRead.query(
          `SELECT COUNT(*) AS n
           FROM vales_prestamo_detalle
           WHERE vale_id = ?
             AND COALESCE(estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')`,
          [vId]
        ).catch(() => [[{ n: 0 }]]);

        if (Number(pendingCount?.n || 0) === 0) {
          await poolOps.query(
            `UPDATE vales_prestamo
             SET estado = 'DEVUELTO',
                 fecha_devolucion_real = NOW()
             WHERE id = ?`,
            [vId]
          ).catch(() => {});
        }
      }
    }

    const cantPropia = Number(existingAsset.cantidad_propia ?? 0);
    const cantDispAntes = Number(existingAsset.cantidad_disponible ?? 0);
    const cantPrestAntes = Number(existingAsset.cantidad_prestada_enviada ?? 0);

    await registrarBitacora(
      req,
      "REGIONAL",
      "FORZAR_RETORNO",
      `Forzar Retorno aplicado a [${existingAsset.clave_bien}] ${existingAsset.descripcion} (ID ${id}): disponible ${cantDispAntes} -> ${cantPropia}, prestado ${cantPrestAntes} -> 0, estatus -> ACTIVO. Préstamos en vales cerrados como DEVUELTO.`
    );

    return res.json({
      ok: true,
      id,
      clave_bien: existingAsset.clave_bien,
      cantidad_propia: cantPropia,
      cantidad_disponible: cantPropia,
      cantidad_prestada_enviada: 0,
      estatus_uso: "ACTIVO",
      message: `Stock restaurado exitosamente para ${existingAsset.clave_bien || `#${id}`} (${cantPropia} disponible(s)). Préstamos en vales regularizados.`
    });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al forzar retorno del activo");
  }
}

app.put("/api/inventario-regional/:id/forzar-retorno", authRequired, handleForzarRetornoInventarioRegional);
app.post("/api/inventario-regional/:id/forzar-retorno", authRequired, handleForzarRetornoInventarioRegional);

// ============================================================================
// v47: LEMATIZACIÓN UNIVERSAL, HOMOLOGACIÓN CON RM — LA PAZ Y FUSIÓN AUTOMÁTICA
// ============================================================================
const STOPWORDS_HOMOLOGACION = new Set([
  "de", "del", "la", "las", "el", "los", "en", "con", "para", "por", "un", "una",
  "unos", "unas", "y", "e", "o", "u", "al", "a", "su", "sus", "color", "tipo",
  "marca", "modelo", "pieza", "piezas", "pza", "pzas", "unidad", "unidades"
]);

function normalizeTextBasic(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getCanonicalTokenStem(word) {
  const w = normalizeTextBasic(word);
  if (!w) return "";
  if (/^\d+$/.test(w)) return w;
  const rawRoots = getSearchTokenRoots(w);
  const flatRoots = Array.isArray(rawRoots) ? rawRoots.flat() : [];
  let shortest = w;
  for (const r of flatRoots) {
    if (typeof r === "string" && r.length >= 2 && r.length < shortest.length) {
      shortest = r;
    }
  }
  // Normalizar género en adjetivos/sustantivos comunes (ej. blanca/blanco -> blanc, negra/negro -> negr, ejecutiva/ejecutivo -> ejecutiv, metalica/metalico -> metalic)
  if (shortest.length >= 4 && /[oa]$/.test(shortest)) {
    return shortest.slice(0, -1);
  }
  return shortest;
}

function getTokenRootSetForWord(word) {
  const w = normalizeTextBasic(word);
  if (!w) return new Set();
  const rawRoots = getSearchTokenRoots(w);
  const flatRoots = Array.isArray(rawRoots) ? rawRoots.flat() : [];
  const roots = new Set(flatRoots.filter((r) => typeof r === "string" && r.length > 0));
  roots.add(w);
  const stem = getCanonicalTokenStem(w);
  if (stem) roots.add(stem);
  if (w.endsWith("ces") && w.length > 4) roots.add(w.slice(0, -3) + "z");
  return roots;
}

function extractMeaningfulTokenGroups(desc) {
  const norm = normalizeTextBasic(desc);
  if (!norm) return [];
  const rawTokens = norm.split(" ").filter((t) => t && !STOPWORDS_HOMOLOGACION.has(t));
  return rawTokens.map((t) => ({
    raw: t,
    stem: getCanonicalTokenStem(t),
    roots: getTokenRootSetForWord(t),
  }));
}

function tokensShareRoot(groupA, groupB) {
  if (!groupA || !groupB) return false;
  if (groupA.raw === groupB.raw || (groupA.stem && groupA.stem === groupB.stem)) return true;
  for (const r of groupA.roots) {
    if (r.length >= 3 && groupB.roots.has(r)) return true;
  }
  return false;
}

function areDescriptionsLemmatizedMatch(descA, descB) {
  const normA = normalizeTextBasic(descA);
  const normB = normalizeTextBasic(descB);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  const groupsA = extractMeaningfulTokenGroups(descA);
  const groupsB = extractMeaningfulTokenGroups(descB);
  if (!groupsA.length || !groupsB.length) return false;

  // El sustantivo principal (primer token significativo, ej. silla, escritorio, archivero, mesa, librero, estante) debe compartir raíz
  if (!tokensShareRoot(groupsA[0], groupsB[0])) return false;

  // Verificar que todos los tokens de A tengan equivalente en B y todos los de B tengan equivalente en A
  const allAMatchedInB = groupsA.every((ga) => groupsB.some((gb) => tokensShareRoot(ga, gb)));
  const allBMatchedInA = groupsB.every((gb) => groupsA.some((ga) => tokensShareRoot(gb, ga)));
  if (allAMatchedInB && allBMatchedInA) return true;

  // Si uno es subconjunto estricto del otro (ej. "Escritorio de madera" vs "Escritorio de madera grande")
  // permitir coincidencia solo si no hay números ni colores contradictorios y comparten al menos 2 raíces o el 100% del catálogo
  const COLOR_MODIFIERS = new Set(["gris", "negr", "blanc", "azul", "roj", "verd", "caf", "mader", "metal", " metalic", "plastic", "cromad", "vinil", "piel", "tela"]);
  const numsA = groupsA.filter((g) => /^\d+$/.test(g.raw)).map((g) => g.raw);
  const numsB = groupsB.filter((g) => /^\d+$/.test(g.raw)).map((g) => g.raw);
  if (numsA.length && numsB.length && numsA.join(",") !== numsB.join(",")) return false;

  const colorsA = groupsA.filter((g) => COLOR_MODIFIERS.has(g.stem)).map((g) => g.stem);
  const colorsB = groupsB.filter((g) => COLOR_MODIFIERS.has(g.stem)).map((g) => g.stem);
  if (colorsA.length && colorsB.length) {
    const colorOverlap = colorsA.some((c) => colorsB.includes(c));
    if (!colorOverlap) return false;
  }

  const matchedCountA = groupsA.filter((ga) => groupsB.some((gb) => tokensShareRoot(ga, gb))).length;
  const matchedCountB = groupsB.filter((gb) => groupsA.some((ga) => tokensShareRoot(gb, ga))).length;
  const minLen = Math.min(groupsA.length, groupsB.length);
  const maxLen = Math.max(groupsA.length, groupsB.length);

  if (minLen >= 2 && (allAMatchedInB || allBMatchedInA) && (matchedCountA >= minLen && matchedCountB >= minLen) && minLen / maxLen >= 0.66) {
    return true;
  }

  return false;
}

function hasUniqueSerialNumber(serieVal) {
  const s = String(serieVal ?? "").trim().toUpperCase();
  if (!s) return false;
  const nonSerialValues = new Set([
    "-", "--", "---", "S/N", "SN", "S/N.", "N/A", "NA", "SIN SERIE",
    "SIN NUMERO", "SIN NÚMERO", "SIN NUMERO DE SERIE", "SIN NÚMERO DE SERIE",
    "NINGUNO", "NINGUNA", "LOTE", "NO APLICA", "NULL", "0"
  ]);
  return !nonSerialValues.has(s);
}

function findBestCatalogMatchInLaPaz(item, catalogRows) {
  if (!item || !Array.isArray(catalogRows) || !catalogRows.length) return null;
  const itemClave = String(item.clave_bien || "").trim().toUpperCase();
  const itemDesc = String(item.descripcion || "").trim();
  const itemRubro = Number(item.rubro_id || 0);

  // Filtrar candidatos del mismo rubro cuando esté definido
  const sameRubro = itemRubro
    ? catalogRows.filter((c) => !c.rubro_id || Number(c.rubro_id) === itemRubro)
    : catalogRows;
  const pool = sameRubro.length ? sameRubro : catalogRows;

  // 1. Coincidencia por descripción exacta o lematizada (priorizando coincidencia 100% de tokens)
  const normItemDesc = normalizeTextBasic(itemDesc);
  if (normItemDesc) {
    const exactDescMatch = pool.find((c) => normalizeTextBasic(c.descripcion) === normItemDesc);
    if (exactDescMatch) return exactDescMatch;

    const itemGroups = extractMeaningfulTokenGroups(itemDesc);
    let bestCandidate = null;
    let bestScore = -1;

    for (const cand of pool) {
      if (!areDescriptionsLemmatizedMatch(itemDesc, cand.descripcion)) continue;
      const candGroups = extractMeaningfulTokenGroups(cand.descripcion);
      const bothDirections =
        itemGroups.every((ga) => candGroups.some((gb) => tokensShareRoot(ga, gb))) &&
        candGroups.every((gb) => itemGroups.some((ga) => tokensShareRoot(gb, ga)));
      const score = (bothDirections ? 100 : 50) - Math.abs(itemGroups.length - candGroups.length);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = cand;
      }
    }
    if (bestCandidate) return bestCandidate;
  }

  // 2. Coincidencia por clave base (ej. MOB-001-LC -> MOB-001 o clave exacta)
  if (itemClave) {
    const exactKeyMatch = pool.find((c) => String(c.clave_bien || "").trim().toUpperCase() === itemClave);
    if (exactKeyMatch) return exactKeyMatch;

    const baseMobMatch = itemClave.match(/^(MOB-\d{3})\b/i);
    if (baseMobMatch) {
      const baseMob = baseMobMatch[1].toUpperCase();
      const byBaseMob = pool.find((c) => String(c.clave_bien || "").trim().toUpperCase() === baseMob);
      if (byBaseMob) return byBaseMob;
    }
  }

  return null;
}

// Endpoint de Homologación Universal de Claves y Nombres con RM — La Paz (Exclusivo Admin)
async function handleHomologarClavesInventarioRegional(req, res) {
  try {
    if (!isAdmin(req)) {
      return httpError(res, 403, "Acceso denegado: solo el Administrador puede homologar claves y nombres con La Paz.");
    }

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();

      // 1. Identificar las oficinas de RM (Recursos Materiales) — La Paz
      const [rmOficinas] = await conn.query(
        `SELECT id, nombre, municipio FROM oficinas_regionales
         WHERE LOWER(nombre) LIKE '%rm (recursos materiales)%'
            OR LOWER(nombre) LIKE '%la paz/rm%'
            OR LOWER(TRIM(nombre)) = 'rm'
            OR LOWER(nombre) LIKE '%recursos materiales%'
         ORDER BY id ASC`
      );
      const rmOficinaIds = rmOficinas.map((o) => Number(o.id)).filter((id) => id > 0);

      // 2. Cargar el catálogo maestro actual en RM — La Paz ESTRICTAMENTE para Mobiliario (rubro_id = 3, Inventario de Jesús)
      let rmRows = [];
      if (rmOficinaIds.length > 0) {
        const [rows] = await conn.query(
          `SELECT id, oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas
           FROM inventario_oficina
           WHERE rubro_id = 3
             AND (oficina_id IN (${rmOficinaIds.map(() => "?").join(",")}) OR es_bodega_delegacion = 1)
           ORDER BY id ASC`,
          rmOficinaIds
        );
        rmRows = rows || [];
      } else {
        const [rows] = await conn.query(
          `SELECT id, oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas
           FROM inventario_oficina
           WHERE rubro_id = 3
             AND es_bodega_delegacion = 1
           ORDER BY id ASC`
        );
        rmRows = rows || [];
      }

      // Combinar con el catálogo oficial base de La Paz (CATALOGO_LAPAZ_JESUS) como respaldo
      const masterCatalog = [];
      const seenMasterKeys = new Set();
      for (const r of rmRows) {
        if (Number(r.rubro_id) !== 3) continue;
        const c = String(r.clave_bien || "").trim().toUpperCase();
        const d = String(r.descripcion || "").trim();
        if (!c || !d) continue;
        // Preferir la descripción oficial de CATALOGO_LAPAZ_JESUS si la clave es del catálogo base
        const officialEntry = CATALOGO_LAPAZ_JESUS.find((cat) => cat.clave === c);
        const finalDesc = officialEntry ? officialEntry.descripcion : d;
        masterCatalog.push({
          id: r.id,
          rubro_id: 3,
          clave_bien: c,
          descripcion: finalDesc
        });
        seenMasterKeys.add(`3:${c}`);
      }
      for (const cat of CATALOGO_LAPAZ_JESUS) {
        const k = `3:${cat.clave}`;
        if (!seenMasterKeys.has(k)) {
          masterCatalog.push({
            id: null,
            rubro_id: 3,
            clave_bien: cat.clave,
            descripcion: cat.descripcion
          });
          seenMasterKeys.add(k);
        }
      }

      // 3. Consultar ESTRICTAMENTE los artículos del rubro de Mobiliario (rubro_id = 3) registrados en otras oficinas o en S/A
      const [allOtherRows] = await conn.query(
        `SELECT io.*, o.nombre AS oficina_nombre
         FROM inventario_oficina io
         LEFT JOIN oficinas_regionales o ON o.id = io.oficina_id
         WHERE io.rubro_id = 3
         ORDER BY io.id ASC FOR UPDATE`
      );

      const detalles = [];
      const rmSet = new Set(rmOficinaIds);

      for (const row of allOtherRows) {
        if (Number(row.rubro_id) !== 3) continue;

        // v50: Escudo de número de serie - Proteger claves consecutivas patrimoniales.
        // Si el artículo SÍ TIENE un número de serie válido (no nulo, no vacío, no '-', 'S/N', 'N/A', etc.),
        // se salta (continue) para no destruir sus claves patrimoniales consecutivas (ej. MOB-025, MOB-026).
        // El homologador de claves y descripciones SOLO opera sobre artículos genéricos / por lote sin serie.
        const serieRaw = row.numero_serie_placas || row.serie || row.numero_serie;
        if (hasUniqueSerialNumber(serieRaw)) {
          continue;
        }

        const isRowRM = rmSet.has(Number(row.oficina_id)) && Number(row.es_bodega_delegacion || 0) === 1;
        // Aun si está en RM pero tiene clave/descripción desalineada con CATALOGO_LAPAZ_JESUS o está en otra oficina/S/A:
        const matchedMaster = findBestCatalogMatchInLaPaz(row, masterCatalog);
        if (!matchedMaster) continue;

        const targetClave = String(matchedMaster.clave_bien || "").trim().toUpperCase();
        const targetDesc = String(matchedMaster.descripcion || "").trim();
        const currentClave = String(row.clave_bien || "").trim().toUpperCase();
        const currentDesc = String(row.descripcion || "").trim();

        if (isRowRM && currentClave === targetClave && currentDesc === targetDesc) {
          continue;
        }
        if (currentClave === targetClave && currentDesc === targetDesc) {
          continue;
        }

        await conn.query(
          `UPDATE inventario_oficina
           SET clave_bien = ?, descripcion = ?
           WHERE id = ? AND rubro_id = 3`,
          [targetClave, targetDesc, row.id]
        );

        detalles.push({
          id: row.id,
          oficina_id: row.oficina_id,
          oficina_nombre: row.oficina_nombre || `Oficina #${row.oficina_id}`,
          clave_anterior: row.clave_bien,
          clave_nueva: targetClave,
          descripcion_anterior: row.descripcion,
          descripcion_nueva: targetDesc
        });
      }

      await conn.commit();

      const resumenHomologacion = detalles.length > 0
        ? `Homologación ejecutada (${detalles.length} artículo(s)):\n` +
          detalles.map((d) => `• ID ${d.id} (${d.oficina_nombre}): Clave "${d.clave_anterior}" -> "${d.clave_nueva}" | "${d.descripcion_anterior}" -> "${d.descripcion_nueva}"`).join("\n")
        : "Homologación ejecutada: 0 artículos requerían cambio.";

      await registrarBitacora(
        req,
        "REGIONAL",
        "HOMOLOGAR_CLAVES",
        resumenHomologacion
      );

      return res.json({
        ok: true,
        homologados: detalles.length,
        detalles,
        message: detalles.length > 0
          ? `Se homologaron exitosamente ${detalles.length} artículo(s) con el catálogo maestro de RM — La Paz.`
          : "Todos los artículos susceptibles ya se encuentran homologados con el catálogo de RM — La Paz."
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) {
    return httpError(res, 500, e.message || "Error al homologar claves con La Paz");
  }
}

app.post("/api/inventario-regional/homologar-claves", authRequired, handleHomologarClavesInventarioRegional);

// Transferencia y fusión automática entre oficinas regionales y RM (Recursos Materiales)
async function handleTransferirInventarioRegional(req, res) {
  try {
    if (!canEditRegional(req)) {
      return httpError(res, 403, "Modo Solo Lectura: solo los encargados de rubro y administración pueden transferir activos regionales.");
    }
    const assetId = Number(req.params.id || req.body?.origen_id || req.body?.id || 0);
    if (!Number.isInteger(assetId) || assetId <= 0) {
      return httpError(res, 400, "ID de activo origen inválido.");
    }

    const { oficina_destino_id, motivo } = req.body || {};
    const destOfiId = Number(oficina_destino_id || 0);
    const cantRaw = req.body?.cantidad !== undefined ? req.body.cantidad : req.body?.cantidad_transferir;
    const cantTrans = Number(cantRaw || 0);
    const motivoClean = String(motivo || "").trim();

    if (!Number.isInteger(destOfiId) || destOfiId <= 0) {
      return httpError(res, 400, "Debes seleccionar una oficina de destino válida.");
    }
    if (!Number.isInteger(cantTrans) || cantTrans <= 0) {
      return httpError(res, 400, "La cantidad a transferir debe ser un número entero mayor a 0.");
    }

    const assignedRubroId = getUserRubroId(req);

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

      const [[asset]] = await conn.query(
        `SELECT io.*, o.nombre AS oficina_origen_nombre, r.nombre AS region_origen_nombre
         FROM inventario_oficina io
         INNER JOIN oficinas_regionales o ON o.id = io.oficina_id
         INNER JOIN regiones r ON r.id = o.region_id
         WHERE io.id = ? LIMIT 1 FOR UPDATE`,
        [assetId]
      );
      if (!asset) {
        await conn.rollback();
        return httpError(res, 404, "El activo que intentas transferir no existe.");
      }

      if (assignedRubroId && Number(asset.rubro_id) !== Number(assignedRubroId)) {
        await conn.rollback();
        return httpError(res, 403, "Solo puedes transferir activos pertenecientes a tu rubro asignado.");
      }

      if (Number(asset.oficina_id) === destOfiId) {
        await conn.rollback();
        return httpError(res, 400, "La oficina destino debe ser distinta a la oficina origen actual.");
      }

      const cantPropiaOrigen = Number(asset.cantidad_propia || 0);
      const dispOrigen = Number(asset.cantidad_disponible ?? cantPropiaOrigen);
      const maxTransferible = Math.min(cantPropiaOrigen, dispOrigen);

      if (cantTrans > maxTransferible) {
        await conn.rollback();
        return httpError(res, 400, `Existencia disponible insuficiente. Solo hay ${maxTransferible} unidad(es) disponible(s) para transferir.`);
      }

      const origIsRM =
        /rm\b|recursos materiales/i.test(String(asset.oficina_origen_nombre || "")) ||
        Number(asset.es_bodega_delegacion || 0) === 1;
      const destIsRM = /rm\b|recursos materiales/i.test(String(destOfi.nombre || ""));
      const destEsBodega = destIsRM || destOfiId === 1 ? 1 : 0;

      const fechaStr = new Date().toLocaleDateString("es-MX", { timeZone: "America/Mazatlan" });
      const userStr = req.user?.username || "admin";
      const notaOrigen = `[Transferidas ${cantTrans} u. a ${destOfi.nombre} (${fechaStr}, ${userStr})${motivoClean ? ` - ${motivoClean}` : ""}]`;
      const notaDestino = `[Recibidas ${cantTrans} u. desde ${asset.oficina_origen_nombre} (${fechaStr}, ${userStr})${motivoClean ? ` - ${motivoClean}` : ""}]`;

      const baseClave = String(asset.clave_bien || "").trim().toUpperCase();
      const assetHasUniqueSerial = hasUniqueSerialNumber(asset.numero_serie_placas);

      // Buscar en oficina_destino_id todos los artículos del mismo rubro para evaluar coincidencia por clave_bien o descripción lematizada
      const [destCandidates] = await conn.query(
        `SELECT * FROM inventario_oficina
         WHERE oficina_id = ? AND rubro_id = ? AND id <> ?
         FOR UPDATE`,
        [destOfiId, asset.rubro_id, assetId]
      );

      // v47: Buscar coincidencia en destino por clave_bien exacta O por descripción lematizada
      const matchedCatalogInDest =
        destCandidates.find((r) => String(r.clave_bien || "").trim().toUpperCase() === baseClave) ||
        findBestCatalogMatchInLaPaz(asset, destCandidates) ||
        null;

      // Si el destino es RM — La Paz y existe catálogo base, obtener también la clave y descripción oficial
      const fallbackOfficial = destIsRM ? findBestCatalogMatchInLaPaz(asset, CATALOGO_LAPAZ_JESUS.map((c) => ({
        rubro_id: 3,
        clave_bien: c.clave,
        descripcion: c.descripcion
      }))) : null;

      const officialClave = matchedCatalogInDest
        ? String(matchedCatalogInDest.clave_bien || "").trim().toUpperCase()
        : (fallbackOfficial ? String(fallbackOfficial.clave_bien || "").trim().toUpperCase() : baseClave);
      const officialDescripcion = matchedCatalogInDest
        ? String(matchedCatalogInDest.descripcion || "").trim()
        : (fallbackOfficial ? String(fallbackOfficial.descripcion || "").trim() : String(asset.descripcion || "").trim());

      // Caso A: Artículo por lote / sin número de serie único -> se fusiona con el lote existente en destino (que tampoco tenga serie única distinta)
      // Caso B: Artículo con Número de Serie Único -> conserva su fila individual y su serie intacta, pero actualiza clave_bien y descripcion a las oficiales
      const destExistingForMerge = !assetHasUniqueSerial
        ? (
            destCandidates.find((r) => !hasUniqueSerialNumber(r.numero_serie_placas) && String(r.clave_bien || "").trim().toUpperCase() === officialClave) ||
            (matchedCatalogInDest && !hasUniqueSerialNumber(matchedCatalogInDest.numero_serie_placas) ? matchedCatalogInDest : null)
          )
        : null;

      const nuevaPropiaOrigen = Math.max(0, cantPropiaOrigen - cantTrans);
      const nuevaDispOrigen = Math.max(0, dispOrigen - cantTrans);
      let wasMerged = false;

      if (destExistingForMerge) {
        // CASO A: FUSIONAR CANTIDADES en el registro maestro existente en destino
        wasMerged = true;
        await conn.query(
          `UPDATE inventario_oficina
           SET cantidad_propia = cantidad_propia + ?,
               cantidad_disponible = COALESCE(cantidad_disponible, cantidad_propia) + ?,
               es_bodega_delegacion = ?,
               estatus_uso = 'ACTIVO',
               observaciones = CONCAT_WS(' | ', NULLIF(observaciones, ''), ?)
           WHERE id = ?`,
          [cantTrans, cantTrans, destEsBodega, notaDestino, destExistingForMerge.id]
        );

        if (nuevaPropiaOrigen <= 0 && !origIsRM) {
          // Reasignar cualquier referencia en vales_prestamo_detalle antes de eliminar la fila origen en cero
          await conn.query(
            `UPDATE vales_prestamo_detalle SET articulo_id = ? WHERE articulo_id = ?`,
            [destExistingForMerge.id, assetId]
          );
          await conn.query(
            `UPDATE vales_prestamo_detalle SET inventario_id = ? WHERE inventario_id = ?`,
            [destExistingForMerge.id, assetId]
          ).catch(() => {});
          await conn.query(`DELETE FROM inventario_oficina WHERE id = ?`, [assetId]);
        } else {
          await conn.query(
            `UPDATE inventario_oficina
             SET cantidad_propia = ?,
                 cantidad_disponible = ?,
                 observaciones = CONCAT_WS(' | ', NULLIF(observaciones, ''), ?)
             WHERE id = ?`,
            [nuevaPropiaOrigen, nuevaDispOrigen, notaOrigen, assetId]
          );
        }
      } else {
        // CASO B (con número de serie único) o lote nuevo que aún no existe en destino:
        // Conserva su fila/serie y actualiza clave_bien y descripcion a las oficiales si hubo coincidencia con RM — La Paz
        const cleanDestClave = officialClave || asset.clave_bien;
        const cleanDestDesc = officialDescripcion || asset.descripcion;

        if (nuevaPropiaOrigen <= 0 && !origIsRM) {
          // Mover el registro directamente a la oficina destino
          await conn.query(
            `UPDATE inventario_oficina
             SET oficina_id = ?,
                 clave_bien = ?,
                 descripcion = ?,
                 cantidad_propia = ?,
                 cantidad_disponible = ?,
                 es_bodega_delegacion = ?,
                 observaciones = CONCAT_WS(' | ', NULLIF(observaciones, ''), ?)
             WHERE id = ?`,
            [destOfiId, cleanDestClave, cleanDestDesc, cantTrans, cantTrans, destEsBodega, notaDestino, assetId]
          );
        } else {
          // Restar en origen e insertar nuevo registro en destino
          await conn.query(
            `UPDATE inventario_oficina
             SET cantidad_propia = ?,
                 cantidad_disponible = ?,
                 observaciones = CONCAT_WS(' | ', NULLIF(observaciones, ''), ?)
             WHERE id = ?`,
            [nuevaPropiaOrigen, nuevaDispOrigen, notaOrigen, assetId]
          );

          const hasDetCol = await ensureDetallesVehiculoCol();
          const detallesJson = asset.detalles_vehiculo
            ? (typeof asset.detalles_vehiculo === "string" ? asset.detalles_vehiculo : JSON.stringify(asset.detalles_vehiculo))
            : null;
          if (hasDetCol) {
            await conn.query(
              `INSERT INTO inventario_oficina
                 (oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas,
                  unidad, cantidad_propia, cantidad_disponible, es_bodega_delegacion, estado_fisico, estatus_uso, observaciones,
                  origen_adquisicion, observaciones_control, detalles_vehiculo)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                destOfiId, asset.rubro_id, cleanDestClave, cleanDestDesc,
                asset.marca_modelo, asset.numero_serie_placas, asset.unidad || "PIEZA",
                cantTrans, cantTrans, destEsBodega,
                asset.estado_fisico || "BUENO", asset.estatus_uso || "ACTIVO",
                notaDestino, asset.origen_adquisicion || "COMPRA_DELEGACION",
                asset.observaciones_control || null, detallesJson
              ]
            );
          } else {
            await conn.query(
              `INSERT INTO inventario_oficina
                 (oficina_id, rubro_id, clave_bien, descripcion, marca_modelo, numero_serie_placas,
                  unidad, cantidad_propia, cantidad_disponible, es_bodega_delegacion, estado_fisico, estatus_uso, observaciones,
                  origen_adquisicion, observaciones_control)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                destOfiId, asset.rubro_id, cleanDestClave, cleanDestDesc,
                asset.marca_modelo, asset.numero_serie_placas, asset.unidad || "PIEZA",
                cantTrans, cantTrans, destEsBodega,
                asset.estado_fisico || "BUENO", asset.estatus_uso || "ACTIVO",
                notaDestino, asset.origen_adquisicion || "COMPRA_DELEGACION",
                asset.observaciones_control || null
              ]
            );
          }
        }
      }

      await conn.commit();

      await registrarBitacora(
        req,
        "REGIONAL",
        wasMerged ? "TRANSFERENCIA_FUSION" : "TRANSFERENCIA",
        `Transferencia de ${cantTrans} u. de [${asset.clave_bien} -> ${officialClave}] "${officialDescripcion}" (Serie: ${asset.numero_serie_placas || "S/N"}) desde ${asset.oficina_origen_nombre} hacia ${destOfi.nombre}${wasMerged ? ` (fusionado en ID ${destExistingForMerge.id})` : ""}.`
      );

      return res.json({
        ok: true,
        merged: wasMerged,
        clave_homologada: officialClave,
        descripcion_homologada: officialDescripcion,
        message: wasMerged
          ? `Se transfirieron y fusionaron ${cantTrans} unidad(es) en el registro maestro [${officialClave}] ${officialDescripcion} de ${destOfi.nombre}.`
          : `Se transfirieron ${cantTrans} unidad(es) hacia ${destOfi.nombre} exitosamente (${officialClave} — ${officialDescripcion}).`
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
}

app.post("/api/inventario-regional/transferir", authRequired, handleTransferirInventarioRegional);
app.post("/api/inventario-regional/:id/transferir", authRequired, handleTransferirInventarioRegional);

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
      await ensureDetallesVehiculoCol();
      const [actRows] = await poolRead.query(
        `SELECT * FROM inventario_oficina WHERE id = ? LIMIT 1`,
        [activoId]
      );
      if (actRows.length) {
        if (assignedRubroId && Number(actRows[0].rubro_id) !== Number(assignedRubroId)) {
          return httpError(res, 403, "No tienes permiso para generar el formato PDF de un activo de otro rubro.");
        }
        if (!oficinaId) oficinaId = Number(actRows[0].oficina_id) || null;
        if (!rubroId) rubroId = Number(actRows[0].rubro_id) || null;

        // Si en la petición de PDF se enviaron datos de resguardante, guardarlos en el registro del vehículo
        const sentDetObj = parseDetallesVehiculo(body.detalles_vehiculo);
        const hasResgInBody = [
          "resguardante_nombre", "resguardante_rfc", "resguardante_puesto",
          "resguardante_adscripcion", "resguardante_programa",
          "resguardante_licencia", "resguardante_vigencia_licencia"
        ].some((k) => body[k] !== undefined) || Boolean(sentDetObj && sentDetObj.resguardante);

        if (hasResgInBody && canEditRegional(req)) {
          const mergedResg = extractResguardanteFields(body, sentDetObj, actRows[0]);
          const currentDet = sentDetObj || parseDetallesVehiculo(actRows[0].detalles_vehiculo) || {};
          currentDet.resguardante = {
            nombre_completo: mergedResg.resguardante_nombre,
            rfc: mergedResg.resguardante_rfc,
            puesto: mergedResg.resguardante_puesto,
            adscripcion: mergedResg.resguardante_adscripcion,
            programa: mergedResg.resguardante_programa,
            licencia_no: mergedResg.resguardante_licencia,
            vigencia_licencia: mergedResg.resguardante_vigencia_licencia,
          };
          await poolOps.query(
            `UPDATE inventario_oficina
             SET detalles_vehiculo = ?,
                 resguardante_nombre = ?,
                 resguardante_rfc = ?,
                 resguardante_puesto = ?,
                 resguardante_adscripcion = ?,
                 resguardante_programa = ?,
                 resguardante_licencia = ?,
                 resguardante_vigencia_licencia = ?
             WHERE id = ?`,
            [
              JSON.stringify(currentDet),
              mergedResg.resguardante_nombre || null,
              mergedResg.resguardante_rfc || null,
              mergedResg.resguardante_puesto || null,
              mergedResg.resguardante_adscripcion || null,
              mergedResg.resguardante_programa || null,
              mergedResg.resguardante_licencia || null,
              mergedResg.resguardante_vigencia_licencia || null,
              activoId,
            ]
          ).catch(() => {});
        }
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
    const isSelectedOfiRM = Boolean(oficinaRow && /rm\b|recursos materiales/i.test(String(oficinaRow.nombre || "")));
    const { grouped, rows: items } = await queryRegionalInventory({
      region_id: regionId,
      oficina_id: oficinaId,
      rubro_id: rubroId,
      activo_id: activoId,
      includeBodega: Boolean(isSelectedOfiRM || activoId),
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

    // 1.- Entrega: Dinámicamente desde rubros_inventario o tabla usuario
    let firmaEncargadoNombre = (rubroRow?.encargado_nombre || items[0]?.encargado_nombre || "").trim();
    let firmaEncargadoCargo = (rubroRow?.encargado_cargo || items[0]?.encargado_cargo || "").trim();
    if (!firmaEncargadoNombre && dbRubroId) {
      const [rubroUserRows] = await poolRead.query(
        `SELECT TRIM(CONCAT_WS(' ', NULLIF(nombre, ''), NULLIF(PRIMER_APELLIDO, ''), NULLIF(SEGUNDO_APELLIDO, ''))) AS nc, cargo
         FROM usuario WHERE rubro_id = ? AND ACTIVO = 1 LIMIT 1`,
        [dbRubroId]
      ).catch(() => [[]]);
      if (rubroUserRows.length && rubroUserRows[0].nc) {
        firmaEncargadoNombre = rubroUserRows[0].nc;
        if (rubroUserRows[0].cargo) firmaEncargadoCargo = rubroUserRows[0].cargo;
      }
    }
    if (!firmaEncargadoNombre) {
      firmaEncargadoNombre = "TODOS LOS RUBROS / POR DEFINIR";
      firmaEncargadoCargo = firmaEncargadoCargo || "Encargado de Rubro de Inventario";
    }

    // 2.- Valida: Dinámicamente desde usuario (Recursos Materiales)
    let firmaApruebaNombre = "Jorge Luis Patrón Murillo";
    let firmaApruebaCargo = "Coordinador Operativo de Recursos Materiales";
    const [rmValidaRows] = await poolRead.query(
      `SELECT TRIM(CONCAT_WS(' ', NULLIF(nombre, ''), NULLIF(PRIMER_APELLIDO, ''), NULLIF(SEGUNDO_APELLIDO, ''))) AS nc, cargo
       FROM usuario
       WHERE (username IN ('jorge', 'jorgepatron') OR departamento LIKE '%Recursos Materiales%' OR cargo LIKE '%Recursos Materiales%') AND ACTIVO = 1
       ORDER BY (username = 'jorge') DESC LIMIT 1`
    ).catch(() => [[]]);
    if (rmValidaRows.length && rmValidaRows[0].nc) {
      firmaApruebaNombre = rmValidaRows[0].nc;
      if (rmValidaRows[0].cargo) firmaApruebaCargo = rmValidaRows[0].cargo;
    }

    // 3.- Recibe: Dinámicamente desde usuario (Director Regional de la región) o regiones.responsable_regional
    let firmaRecibeNombre = "";
    let firmaRecibeCargo = "Director Regional";
    if (dbRegionId) {
      const [regUserRows] = await poolRead.query(
        `SELECT TRIM(CONCAT_WS(' ', NULLIF(nombre, ''), NULLIF(PRIMER_APELLIDO, ''), NULLIF(SEGUNDO_APELLIDO, ''))) AS nc, cargo
         FROM usuario
         WHERE region_id = ? AND (rol = 'regional' OR cargo LIKE '%Director Regional%' OR departamento LIKE '%Enlace Regional%') AND ACTIVO = 1
         ORDER BY id ASC LIMIT 1`,
        [dbRegionId]
      ).catch(() => [[]]);
      if (regUserRows.length && regUserRows[0].nc) {
        firmaRecibeNombre = regUserRows[0].nc;
        if (regUserRows[0].cargo) firmaRecibeCargo = regUserRows[0].cargo;
      }
    }
    if (!firmaRecibeNombre && regionRow?.responsable_regional) {
      firmaRecibeNombre = regionRow.responsable_regional;
    }

    // 4.- Autoriza: Titular de la Delegación
    let firmaDelegadaNombre = "Diphna Yanssen Weichselbaum Calderón";
    let firmaDelegadaCargo = "Delegada de Programas para el Bienestar en BCS";

    if (isParqueVehicularRM) {
      // 13 Vehículos RM de Evelia Contreras
      if (!firmaEncargadoNombre || firmaEncargadoNombre === "TODOS LOS RUBROS / POR DEFINIR") {
        firmaEncargadoNombre = "Evelia Contreras Godínez";
        firmaEncargadoCargo = "Encargada de Parque Vehicular / Recursos Materiales";
      }
      firmaApruebaNombre = firmaDelegadaNombre;
      firmaApruebaCargo = firmaDelegadaCargo;
      firmaRecibeNombre = rmValidaRows.length && rmValidaRows[0].nc ? rmValidaRows[0].nc : "Jorge Luis Patrón Murillo";
      firmaRecibeCargo = rmValidaRows.length && rmValidaRows[0].cargo ? rmValidaRows[0].cargo : "Coordinador Operativo de Recursos Materiales";
    } else if (isMobiliarioLaPaz) {
      if (!firmaRecibeNombre) {
        firmaRecibeNombre = "Sandra Guadalupe Salvatierra Amador";
      }
    } else if (isMulegeRegion) {
      if (!firmaRecibeNombre) {
        firmaRecibeNombre = "Diana Ramírez Hernández";
      }
    }

    if (!firmaRecibeNombre) {
      firmaRecibeNombre = "POR CONFIRMAR";
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

    const doc = new PDFDocument({ size: "LETTER", margins: { top: 20, bottom: 18, left: 32, right: 32 } });
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

    // Función auxiliar para dibujar el DOBLE BLOQUE DE 4 FIRMAS (4 de Entrega + 4 de Retorno) en 1 sola hoja:
    // Fila 1 (1. FIRMAS DE ENTREGA / RECEPCIÓN): 1) ENTREGA, 2) RECIBE, 3) VALIDA, 4) AUTORIZA
    // Fila 2 (2. FIRMAS DE RETORNO / DEVOLUCIÓN): 1) ENTREGA / DEVUELVE, 2) RECIBE DE CONFORMIDAD, 3) VALIDA RETORNO, 4) AUTORIZA
    function drawDoubleFourSignatures(startY, signBoxH = 50, customRecibeNombre = null, customRecibeCargo = null, customFolio = null) {
      const gap = 8;
      const boxW = (tableWidth - gap * 3) / 4; // 129 pt cada caja
      const activeFolio = String(customFolio || folio || "S/N");
      const resolvedRecibeNombre = customRecibeNombre || firmaRecibeNombre;
      const rawRecibeCargo = String(customRecibeCargo || firmaRecibeCargo || "Director Regional").trim() || "Director Regional";
      const resolvedRecibeCargo = normalizeRegionalCargo(rawRecibeCargo)
        .replace(/Coordinadora?\s+Regionall?/gi, "Director Regional") || "Director Regional";
      const secHeaderH = 10.5;
      const boxTitleH = 11;

      const drawSignatureRow = (rowTopY, sectionTitle, boxesConfig) => {
        // Barra de título de bloque de firmas
        doc.save();
        doc.rect(leftX, rowTopY, tableWidth, secHeaderH).fillAndStroke(COLOR_PRIMARY, COLOR_SECONDARY);
        doc.restore();
        doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(6.5)
          .text(sectionTitle, leftX + 6, rowTopY + 2.2, { width: tableWidth - 12, align: "left", lineBreak: false });

        const boxesY = rowTopY + secHeaderH;
        const lineY = boxesY + signBoxH - 19;

        doc.save();
        doc.lineWidth(0.6).strokeColor(COLOR_PRIMARY);
        boxesConfig.forEach((b) => {
          doc.rect(b.x, boxesY, boxW, signBoxH).stroke();
          doc.rect(b.x, boxesY, boxW, boxTitleH).fillAndStroke(COLOR_SOFT_BG, COLOR_PRIMARY);
          doc.strokeColor("#000000").moveTo(b.x + 6, lineY).lineTo(b.x + boxW - 6, lineY).stroke();
          doc.strokeColor(COLOR_PRIMARY);
        });
        doc.restore();

        boxesConfig.forEach((b) => {
          doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(6.4)
            .text(b.titulo, b.x + 2, boxesY + 2.2, { width: boxW - 4, align: "center", lineBreak: false });
          doc.fillColor("#000000").font("Helvetica").fontSize(5.6)
            .text(b.cargo, b.x + 3, boxesY + boxTitleH + 1.5, { width: boxW - 6, align: "center" });
          doc.font("Helvetica-Bold").fontSize(6.0)
            .text(b.nombre, b.x + 3, lineY + 2.5, { width: boxW - 6, align: "center" });
        });

        return boxesY + signBoxH;
      };

      // Fila 1: 1. FIRMAS DE ENTREGA / RECEPCIÓN
      const row1Boxes = [
        {
          x: leftX,
          titulo: "ENTREGA:",
          cargo: firmaEncargadoCargo,
          nombre: firmaEncargadoNombre,
        },
        {
          x: leftX + (boxW + gap) * 1,
          titulo: "RECIBE:",
          cargo: resolvedRecibeCargo,
          nombre: resolvedRecibeNombre,
        },
        {
          x: leftX + (boxW + gap) * 2,
          titulo: "VALIDA:",
          cargo: firmaApruebaCargo,
          nombre: firmaApruebaNombre,
        },
        {
          x: leftX + (boxW + gap) * 3,
          titulo: "AUTORIZA:",
          cargo: firmaDelegadaCargo,
          nombre: firmaDelegadaNombre,
        },
      ];

      const afterRow1Y = drawSignatureRow(startY, "1. FIRMAS DE ENTREGA / RECEPCIÓN", row1Boxes);

      // Fila 2: 2. FIRMAS DE RETORNO / DEVOLUCIÓN
      const row2Boxes = [
        {
          x: leftX,
          titulo: "ENTREGA / DEVUELVE:",
          cargo: resolvedRecibeCargo,
          nombre: resolvedRecibeNombre,
        },
        {
          x: leftX + (boxW + gap) * 1,
          titulo: "RECIBE DE CONFORMIDAD:",
          cargo: firmaEncargadoCargo,
          nombre: firmaEncargadoNombre,
        },
        {
          x: leftX + (boxW + gap) * 2,
          titulo: "VALIDA RETORNO:",
          cargo: firmaApruebaCargo,
          nombre: firmaApruebaNombre,
        },
        {
          x: leftX + (boxW + gap) * 3,
          titulo: "AUTORIZA:",
          cargo: firmaDelegadaCargo,
          nombre: firmaDelegadaNombre,
        },
      ];

      const afterRow2Y = drawSignatureRow(afterRow1Y + 5, "2. FIRMAS DE RETORNO / DEVOLUCIÓN", row2Boxes);

      const footerY = afterRow2Y + 4;
      doc.font("Helvetica").fontSize(6.5).fillColor("#333333");
      doc.text(`Folio Formato: ${activeFolio}`, leftX, footerY, { width: 210, align: "left", lineBreak: false });
      doc.text("Delegación Baja California Sur - Control de Inventario Regional", leftX, footerY, { width: tableWidth, align: "right", lineBreak: false });
    }

    // =========================================================================
    // MODO HÍBRIDO ESPECIAL: PARQUE VEHICULAR (Resguardo e Inventario de Unidad)
    // =========================================================================
    if (isParqueVehicular) {
      const vehiclesToRender = items.length > 0 ? items : [null];

      vehiclesToRender.forEach((veh, idx) => {
        if (idx > 0) doc.addPage();

        const det = (veh && veh.detalles_vehiculo && typeof veh.detalles_vehiculo === "object")
          ? veh.detalles_vehiculo
          : {};
        const unidad = det.unidad && typeof det.unidad === "object" ? det.unidad : {};
        const estGen = det.estado_general && typeof det.estado_general === "object" ? det.estado_general : {};
        const chk = det.checklist && typeof det.checklist === "object" ? det.checklist : {};
        const resg = extractResguardanteFields(body, det, veh || {});

        const vRegion = veh?.region_nombre || regionLabel || "";
        const vOficina = veh?.oficina_nombre
          ? (veh.municipio ? `${veh.oficina_nombre} (${veh.municipio})` : veh.oficina_nombre)
          : oficinaLabel;
        const vClave = veh?.clave_bien || "";
        const vDesc = veh?.descripcion || "";

        // 1. Encabezado Institucional con logos oficiales discretos
        if (logoGobPath && fs.existsSync(logoGobPath)) {
          try {
            doc.image(logoGobPath, leftX, 14, { fit: [90, 26], align: "left", valign: "top" });
          } catch {}
        }
        if (logoBienPath && fs.existsSync(logoBienPath)) {
          try {
            doc.image(logoBienPath, rightLimit - 82, 14, { fit: [82, 26], align: "right", valign: "top" });
          } catch {}
        }

        doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(10)
          .text("SECRETARÍA DE BIENESTAR", leftX, 15, { width: tableWidth, align: "center" });
        doc.fillColor("#000000").font("Helvetica-Bold").fontSize(9)
          .text("DELEGACIÓN BAJA CALIFORNIA SUR", leftX, 26.5, { width: tableWidth, align: "center" });
        doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(9)
          .text("FORMATO DE RESGUARDO E INVENTARIO DE PARQUE VEHICULAR", leftX, 38, { width: tableWidth, align: "center" });

        doc.save();
        doc.moveTo(leftX + 110, 49).lineTo(rightLimit - 110, 49).lineWidth(0.9).strokeColor(COLOR_ACCENT).stroke();
        doc.restore();

        // Barra compacta de metadatos del resguardo
        let curY = 53;
        doc.fillColor("#000000").font("Helvetica-Bold").fontSize(7.2).text("REGIÓN:", leftX, curY);
        doc.font("Helvetica").fontSize(7.2).text(vRegion, leftX + 38, curY, { width: 115, lineBreak: false });
        doc.moveTo(leftX + 36, curY + 8.5).lineTo(leftX + 152, curY + 8.5).lineWidth(0.5).strokeColor("#000000").stroke();

        doc.font("Helvetica-Bold").fontSize(7.2).text("OFICINA:", leftX + 158, curY);
        doc.font("Helvetica").fontSize(7.2).text(vOficina, leftX + 196, curY, { width: 145, lineBreak: false });
        doc.moveTo(leftX + 194, curY + 8.5).lineTo(leftX + 340, curY + 8.5).lineWidth(0.5).strokeColor("#000000").stroke();

        doc.font("Helvetica-Bold").fontSize(7.2).text("CLAVE:", leftX + 346, curY);
        doc.font("Helvetica-Bold").fontSize(7.2).text(vClave || "____________", leftX + 378, curY, { width: 72, lineBreak: false });

        doc.font("Helvetica-Bold").fontSize(7.2).text("FECHA:", leftX + 452, curY);
        doc.font("Helvetica").fontSize(7.2).text(fechaTexto, leftX + 485, curY, { width: 55, align: "right", lineBreak: false });

        curY = 66;
        if (isAssetInSiniestro(veh)) {
          doc.save();
          doc.rect(leftX, curY, tableWidth, 12).fillAndStroke("#fff1f2", "#9f1239");
          doc.restore();
          doc.fillColor("#9f1239").font("Helvetica-Bold").fontSize(7.2)
            .text("ESTADO DE LA UNIDAD: NO DISPONIBLE (SINIESTRO / ASEGURADORA)", leftX, curY + 2.5, { width: tableWidth, align: "center", lineBreak: false });
          curY += 13.5;
        }

        // Helper para barra de sección guinda
        const drawSectionBar = (y, title) => {
          const barH = 11.5;
          doc.save();
          doc.rect(leftX, y, tableWidth, barH).fillAndStroke(COLOR_PRIMARY, COLOR_SECONDARY);
          doc.moveTo(leftX, y + barH).lineTo(rightLimit, y + barH).lineWidth(0.7).strokeColor(COLOR_ACCENT).stroke();
          doc.restore();
          doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(7.0)
            .text(title, leftX + 6, y + 2.3, { width: tableWidth - 12, align: "left", lineBreak: false });
          return y + barH;
        };

        // =====================================================================
        // SECCIÓN A: 1. DATOS DEL RESGUARDANTE (Impresos desde el sistema o línea limpia)
        // =====================================================================
        curY = drawSectionBar(curY, "1. DATOS DEL RESGUARDANTE");
        const resgH = 48;
        doc.save();
        doc.lineWidth(0.6).strokeColor("#000000");
        doc.rect(leftX, curY, tableWidth, resgH).stroke();
        doc.restore();

        const rRow1 = curY + 4.5;
        const rRow2 = curY + 15.5;
        const rRow3 = curY + 26.5;
        const rRow4 = curY + 37.5;

        const rNombreVal = String(resg.resguardante_nombre || "").trim();
        const rRfcVal = String(resg.resguardante_rfc || "").trim().toUpperCase();
        const rPuestoVal = normalizeRegionalCargo(String(resg.resguardante_puesto || "").trim())
          .replace(/Coordinadora?\s+Regionall?/gi, "Director Regional");
        const rAdscripcionVal = String(resg.resguardante_adscripcion || vOficina || vRegion || "").trim();
        const rProgramaVal = String(resg.resguardante_programa || "").trim();
        const rLicenciaVal = String(resg.resguardante_licencia || "").trim().toUpperCase();
        const rVigenciaVal = String(resg.resguardante_vigencia_licencia || "").trim();

        doc.fillColor("#000000").font("Helvetica-Bold").fontSize(7.2);
        // Fila 1: Nombre Completo
        doc.text("Nombre Completo:", leftX + 6, rRow1);
        doc.moveTo(leftX + 80, rRow1 + 8).lineTo(rightLimit - 8, rRow1 + 8).lineWidth(0.5).strokeColor("#333333").stroke();
        if (rNombreVal) {
          doc.font("Helvetica").fontSize(7.2).fillColor("#000000")
            .text(rNombreVal, leftX + 83, rRow1, { width: rightLimit - leftX - 94, lineBreak: false });
        }

        // Fila 2: RFC y Puesto
        doc.font("Helvetica-Bold").fontSize(7.2).text("RFC:", leftX + 6, rRow2);
        doc.moveTo(leftX + 28, rRow2 + 8).lineTo(leftX + 255, rRow2 + 8).lineWidth(0.5).strokeColor("#333333").stroke();
        if (rRfcVal) {
          doc.font("Helvetica").fontSize(7.2).fillColor("#000000")
            .text(rRfcVal, leftX + 31, rRow2, { width: 220, lineBreak: false });
        }
        doc.font("Helvetica-Bold").fontSize(7.2).text("Puesto:", leftX + 268, rRow2);
        doc.moveTo(leftX + 300, rRow2 + 8).lineTo(rightLimit - 8, rRow2 + 8).lineWidth(0.5).strokeColor("#333333").stroke();
        if (rPuestoVal) {
          doc.font("Helvetica").fontSize(7.2).fillColor("#000000")
            .text(rPuestoVal, leftX + 303, rRow2, { width: rightLimit - leftX - 314, lineBreak: false });
        }

        // Fila 3: Adscripción / Región y Programa / Operativo
        doc.font("Helvetica-Bold").fontSize(7.2).text("Adscripción / Región:", leftX + 6, rRow3);
        doc.moveTo(leftX + 90, rRow3 + 8).lineTo(leftX + 255, rRow3 + 8).lineWidth(0.5).strokeColor("#333333").stroke();
        if (rAdscripcionVal) {
          doc.font("Helvetica").fontSize(7.0).fillColor("#000000")
            .text(rAdscripcionVal, leftX + 92, rRow3, { width: 161, lineBreak: false });
        }
        doc.font("Helvetica-Bold").fontSize(7.2).text("Programa / Operativo:", leftX + 268, rRow3);
        doc.moveTo(leftX + 354, rRow3 + 8).lineTo(rightLimit - 8, rRow3 + 8).lineWidth(0.5).strokeColor("#333333").stroke();
        if (rProgramaVal) {
          doc.font("Helvetica").fontSize(7.0).fillColor("#000000")
            .text(rProgramaVal, leftX + 356, rRow3, { width: rightLimit - leftX - 366, lineBreak: false });
        }

        // Fila 4: Licencia No. y Vigencia de Licencia
        doc.font("Helvetica-Bold").fontSize(7.2).text("Licencia No.:", leftX + 6, rRow4);
        doc.moveTo(leftX + 58, rRow4 + 8).lineTo(leftX + 255, rRow4 + 8).lineWidth(0.5).strokeColor("#333333").stroke();
        if (rLicenciaVal) {
          doc.font("Helvetica").fontSize(7.2).fillColor("#000000")
            .text(rLicenciaVal, leftX + 61, rRow4, { width: 190, lineBreak: false });
        }
        doc.font("Helvetica-Bold").fontSize(7.2).text("Vigencia de Licencia:", leftX + 268, rRow4);
        doc.moveTo(leftX + 352, rRow4 + 8).lineTo(rightLimit - 8, rRow4 + 8).lineWidth(0.5).strokeColor("#333333").stroke();
        if (rVigenciaVal) {
          doc.font("Helvetica").fontSize(7.2).fillColor("#000000")
            .text(rVigenciaVal, leftX + 355, rRow4, { width: rightLimit - leftX - 365, lineBreak: false });
        }

        curY += resgH + 3;

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

        const drawDataRow = (y, cells, rowH = 15.5) => {
          let x = leftX;
          cells.forEach((cell) => {
            doc.save();
            doc.lineWidth(0.5).strokeColor("#000000");
            doc.rect(x, y, cell.w, rowH).stroke();
            doc.rect(x, y, cell.labelW, rowH).fillAndStroke(COLOR_SOFT_BG, "#000000");
            doc.restore();

            doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(6.6)
              .text(cell.label, x + 3, y + 4.2, { width: cell.labelW - 6, lineBreak: false });
            doc.fillColor("#000000").font("Helvetica").fontSize(7.1)
              .text(cell.val || "-", x + cell.labelW + 4, y + 4.2, { width: cell.w - cell.labelW - 8, lineBreak: false });
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

        curY += 3;

        // =====================================================================
        // SECCIÓN B2: ESTADO GENERAL (B / R / M)
        // =====================================================================
        curY = drawSectionBar(curY, "3. ESTADO GENERAL DEL VEHÍCULO (B = Bueno | R = Regular | M = Malo)");
        const estColW = tableWidth / VEHICULO_ESTADO_ITEMS.length; // 67.5 pt cada una
        const estHeaderH = 11;
        const estValH = 12;

        VEHICULO_ESTADO_ITEMS.forEach((item, i) => {
          const cx = leftX + i * estColW;
          const val = String(estGen[item.key] || "B").trim().toUpperCase();
          doc.save();
          doc.lineWidth(0.5).strokeColor("#000000");
          doc.rect(cx, curY, estColW, estHeaderH).fillAndStroke(COLOR_SOFT_BG, "#000000");
          doc.rect(cx, curY + estHeaderH, estColW, estValH).stroke();
          doc.restore();

          doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(6.0)
            .text(item.label, cx + 2, curY + 2.5, { width: estColW - 4, align: "center", lineBreak: false });

          const bMark = val === "B" || val === "BUENO" ? "[X]B" : "[ ]B";
          const rMark = val === "R" || val === "REGULAR" ? "[X]R" : "[ ]R";
          const mMark = val === "M" || val === "MALO" ? "[X]M" : "[ ]M";
          doc.fillColor("#000000").font("Helvetica-Bold").fontSize(6.1)
            .text(`${bMark}  ${rMark}  ${mMark}`, cx + 1, curY + estHeaderH + 3, { width: estColW - 2, align: "center", lineBreak: false });
        });

        curY += estHeaderH + estValH + 3;

        // =====================================================================
        // SECCIÓN B3: TABLA CHECKLIST DE ACCESORIOS, HERRAMIENTA Y DOCUMENTACIÓN
        // =====================================================================
        curY = drawSectionBar(curY, "4. CHECKLIST DE ACCESORIOS, HERRAMIENTA Y DOCUMENTACIÓN (SÍ / NO)");

        const numCols = 3;
        const colGroupW = tableWidth / numCols; // 180 pt por bloque
        const optW = 24; // 2 opciones (SÍ, NO) * 24 = 48 pt
        const itemLabelW = colGroupW - optW * 2; // 180 - 48 = 132 pt
        const chkHeaderH = 10.5;
        const numRows = Math.ceil(VEHICULO_CHECKLIST_ITEMS.length / numCols); // 14 filas
        const chkRowH = 12.0;

        // Dibujar encabezados de las 3 columnas: únicamente CONCEPTO, SÍ, NO (sin N/A)
        for (let c = 0; c < numCols; c++) {
          const gx = leftX + c * colGroupW;
          doc.save();
          doc.lineWidth(0.5).strokeColor("#000000");
          doc.rect(gx, curY, itemLabelW, chkHeaderH).fillAndStroke(COLOR_SOFT_BG, "#000000");
          doc.rect(gx + itemLabelW, curY, optW, chkHeaderH).fillAndStroke(COLOR_SOFT_BG, "#000000");
          doc.rect(gx + itemLabelW + optW, curY, optW, chkHeaderH).fillAndStroke(COLOR_SOFT_BG, "#000000");
          doc.restore();

          doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(6.0);
          doc.text("CONCEPTO", gx + 3, curY + 2.2, { width: itemLabelW - 6, align: "left", lineBreak: false });
          doc.text("SÍ", gx + itemLabelW, curY + 2.2, { width: optW, align: "center", lineBreak: false });
          doc.text("NO", gx + itemLabelW + optW, curY + 2.2, { width: optW, align: "center", lineBreak: false });
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

              const siBox = isSi ? "[X]" : "[ ]";
              const noBox = isNo ? "[X]" : "[ ]";

              doc.fillColor("#000000").font("Helvetica").fontSize(6.3)
                .text(chkItem.label, gx + 3, ry + 2.6, { width: itemLabelW - 5, lineBreak: false });

              doc.font("Helvetica-Bold").fontSize(6.3).fillColor(isSi ? COLOR_PRIMARY : "#333333");
              doc.text(siBox, gx + itemLabelW, ry + 2.5, { width: optW, align: "center", lineBreak: false });

              doc.font("Helvetica-Bold").fontSize(6.3).fillColor(isNo ? COLOR_PRIMARY : "#333333");
              doc.text(noBox, gx + itemLabelW + optW, ry + 2.5, { width: optW, align: "center", lineBreak: false });
            }
          }
        }
        curY += numRows * chkRowH + 3;

        // =====================================================================
        // SECCIÓN B4: OBSERVACIONES GENERALES DE LA UNIDAD (2 líneas compactas)
        // =====================================================================
        curY = drawSectionBar(curY, "5. OBSERVACIONES GENERALES DE LA UNIDAD");
        const obsH = 22;
        doc.save();
        doc.lineWidth(0.5).strokeColor("#000000");
        doc.rect(leftX, curY, tableWidth, obsH).stroke();

        // 2 líneas guía para notas manuales o impresas
        doc.lineWidth(0.4).strokeColor("#AAAAAA");
        const lineSpacing = obsH / 2.6;
        for (let l = 1; l <= 2; l++) {
          const ly = curY + l * lineSpacing + 1;
          doc.moveTo(leftX + 8, ly).lineTo(rightLimit - 8, ly).stroke();
        }
        doc.restore();
        const vehObsTexto = String(veh?.observaciones || "").trim();
        if (vehObsTexto) {
          doc.fillColor("#000000").font("Helvetica").fontSize(6.6)
            .text(vehObsTexto, leftX + 10, curY + 2.5, { width: tableWidth - 20, height: obsH - 4 });
        }
        curY += obsH + 3;

        // =====================================================================
        // SECCIÓN C: CLÁUSULA LEGAL AL PIE DEL PDF (Antes del doble bloque de firmas)
        // =====================================================================
        const legalH = 44;
        doc.save();
        doc.lineWidth(0.6).strokeColor(COLOR_PRIMARY);
        doc.rect(leftX, curY, tableWidth, legalH).fillAndStroke(COLOR_SOFT_BG, COLOR_PRIMARY);
        doc.rect(leftX, curY, 4, legalH).fill(COLOR_ACCENT);
        doc.restore();

        const clausulaTexto =
          "CLÁUSULA DE RESPONSABILIDAD LEGAL: Con fundamento en los Artículos 78, 80 y 87 del Acuerdo por el que se Establecen las Disposiciones en Materia de Recursos Materiales y Servicios Generales, el servidor público resguardante recibe el vehículo descrito para uso exclusivamente oficial y se compromete a: (1) portar licencia de conducir vigente durante la operación de la unidad; (2) cubrir el pago del deducible de la póliza de seguro o la reparación total de los daños y perjuicios que resulten imputables por negligencia, uso indebido o siniestro bajo su custodia; (3) cubrir por su cuenta las multas e infracciones de tránsito que se generen durante el periodo de asignación; y (4) resguardar y concentrar el vehículo al término de la jornada laboral o comisión oficial en las instalaciones de la Secretaría de Bienestar en Baja California Sur.";

        doc.fillColor("#111111").font("Helvetica").fontSize(6.0)
          .text(clausulaTexto, leftX + 9, curY + 3.5, {
            width: tableWidth - 15,
            align: "justify",
            lineGap: 0.8,
          });

        curY += legalH + 4;

        // =====================================================================
        // SECCIÓN D: DOBLE BLOQUE DE 4 FIRMAS (4 DE ENTREGA + 4 DE RETORNO) EN 1 SOLA HOJA
        // =====================================================================
        const isVehMulege = Boolean(
          isMulegeRegion ||
          Number(veh?.region_id) === 4 ||
          /muleg[eé]/i.test(String(veh?.region_nombre || "")) ||
          /muleg[eé]|santa rosal[ií]a|guerrero negro|vizca[ií]no/i.test(String(veh?.oficina_nombre || "")) ||
          /muleg[eé]|santa rosal[ií]a|guerrero negro|vizca[ií]no/i.test(String(veh?.municipio || ""))
        );
        const vehFolio = String(veh?.folio || (veh?.clave_bien ? `RES-${veh.clave_bien}` : folio));
        const customRecibeNom = rNombreVal
          ? rNombreVal
          : (isVehMulege ? "DIANA RAMÍREZ HERNÁNDEZ" : (isParqueVehicularRM ? "Jorge Luis Patrón Murillo" : null));
        const customRecibeCar = rNombreVal
          ? (rPuestoVal || "Director Regional")
          : (isVehMulege ? "Director Regional" : (isParqueVehicularRM ? "Coordinador Operativo de Recursos Materiales" : null));

        drawDoubleFourSignatures(
          curY,
          49,
          customRecibeNom,
          customRecibeCar,
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

    const minRows = 12;
    const totalRows = Math.max(items.length, minRows);
    const defaultRowH = 16.5;

    for (let i = 0; i < totalRows; i++) {
      const item = items[i] || null;
      const itemSiniestro = item ? isAssetInSiniestro(item) : false;
      const cellText = {
        no: item ? String(i + 1) : "",
        clave: item ? String(item.clave_bien || "").trim() : "",
        desc: item ? String(item.descripcion || "").trim() : "",
        marca: item ? String(item.marca_modelo || "").trim() : "",
        serie: item ? String(item.numero_serie_placas || "").trim() : "",
        cant: item && item.cantidad_propia != null ? String(item.cantidad_propia) : "",
        est: item ? (itemSiniestro ? "NO DISPONIBLE (SINIESTRO / ASEGURADORA)" : String(item.estatus_uso || "").trim()) : "",
        obs: item ? String(item.observaciones || "").trim() : "",
      };

      doc.font("Helvetica").fontSize(7.2);
      let maxTextH = itemSiniestro ? 16 : 9.5;
      regionalCols.forEach((c) => {
        const t = cellText[c.key];
        if ((c.wrap || (itemSiniestro && c.key === "est")) && t) maxTextH = Math.max(maxTextH, doc.heightOfString(t, { width: c.w - 6 }));
      });
      const rowH = Math.max(defaultRowH, maxTextH + 5);

      if (currentY + rowH > pageHeight - 165) {
        doc.addPage();
        drawRegionalHeader();
        currentY = drawRegionalTableHeader(98);
      }

      doc.save();
      doc.lineWidth(0.5).strokeColor("#000000");
      if (itemSiniestro) {
        doc.rect(leftX, currentY, tableWidth, rowH).fillAndStroke("#fff1f2", "#000000");
      } else if (i % 2 === 1) {
        doc.rect(leftX, currentY, tableWidth, rowH).fillAndStroke(COLOR_SOFT_BG, "#000000");
      } else {
        doc.rect(leftX, currentY, tableWidth, rowH).stroke();
      }
      colDividersX.forEach((cx) => {
        doc.moveTo(cx, currentY).lineTo(cx, currentY + rowH).stroke();
      });
      doc.restore();

      if (item) {
        const textY = currentY + 3.5;
        regionalCols.forEach((c) => {
          if (itemSiniestro && c.key === "est") {
            doc.fillColor("#9f1239").font("Helvetica-Bold").fontSize(6.4);
          } else if (itemSiniestro) {
            doc.fillColor("#9f1239").font("Helvetica").fontSize(7.2);
          } else {
            doc.fillColor("#000000").font("Helvetica").fontSize(7.2);
          }
          doc.text(cellText[c.key], c.x + 3, textY, { width: c.w - 6, align: c.align });
        });
      }

      currentY += rowH;
    }

    // 8. Dibujar el doble bloque de 4 firmas (4 de Entrega + 4 de Retorno) en la misma hoja
    const signBoxY = Math.max(currentY + 10, pageHeight - 160);
    drawDoubleFourSignatures(
      signBoxY,
      50,
      isMulegeRegion ? "DIANA RAMÍREZ HERNÁNDEZ" : null,
      isMulegeRegion ? "Director Regional" : null,
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
// ---------------------------------------------------------------------------
// v42: Resolución ESTRICTA de artículos para Vales de Préstamo.
// Nunca se busca ni se actualiza stock por descripción: solo por ID primario
// o por coincidencia exacta de clave (+ oficina en inventario_oficina).
// ---------------------------------------------------------------------------
async function resolveAlmacenRowStrict(conn, { articulo_id, id, clave, clave_bien } = {}) {
  const artId = Number(articulo_id || id || 0) || null;
  if (artId) {
    const [ar] = await conn.query(
      `SELECT ID, CLAVE, DESCRIPCION, STOCK FROM almacen_dregcivil WHERE ID = ? LIMIT 1 FOR UPDATE`,
      [artId]
    );
    if (ar.length) return ar[0];
  }
  const claveNorm = String(clave || clave_bien || "").trim().toUpperCase();
  if (claveNorm) {
    const [ar] = await conn.query(
      `SELECT ID, CLAVE, DESCRIPCION, STOCK FROM almacen_dregcivil
       WHERE UPPER(TRIM(CLAVE)) = ? ORDER BY ID ASC LIMIT 1 FOR UPDATE`,
      [claveNorm]
    );
    if (ar.length) return ar[0];
  }
  return null;
}

async function resolveInventarioOficinaRowStrict(conn, { articulo_id, id, clave, clave_bien, oficina_id } = {}, rubroId = null) {
  const artId = Number(articulo_id || id || 0) || null;
  if (artId) {
    const [rows] = await conn.query(
      `SELECT id, oficina_id, clave_bien, cantidad_propia, cantidad_disponible, cantidad_prestada_enviada, estatus_uso, descripcion
       FROM inventario_oficina WHERE id = ? LIMIT 1 FOR UPDATE`,
      [artId]
    );
    if (rows.length) return rows[0];
  }
  const claveNorm = String(clave_bien || clave || "").trim().toUpperCase();
  const ofiId = Number(oficina_id || 0) || null;
  if (claveNorm && ofiId) {
    const [rows] = await conn.query(
      `SELECT id, oficina_id, clave_bien, cantidad_propia, cantidad_disponible, cantidad_prestada_enviada, estatus_uso, descripcion
       FROM inventario_oficina
       WHERE UPPER(TRIM(clave_bien)) = ? AND oficina_id = ? ${rubroId ? "AND rubro_id = ?" : ""}
       ORDER BY id ASC LIMIT 1 FOR UPDATE`,
      rubroId ? [claveNorm, ofiId, rubroId] : [claveNorm, ofiId]
    );
    if (rows.length) return rows[0];
  }
  return null;
}

app.get("/api/vales-prestamo/catalogo", authRequired, async (req, res) => {
  try {
    const rubroId = Number(req.query?.rubro_id || 2);
    if (rubroId === 1) {
      return httpError(res, 400, "El Rubro 1 (Archivo y Materiales - Gabriel Adán Fiol Collins) no utiliza Vales Provisionales; utiliza Solicitudes de Material.");
    }
    if (![2, 3, 4].includes(rubroId)) {
      return httpError(res, 400, "Rubro inválido para Vales Provisionales (debe ser 2, 3 o 4)");
    }
    if (isLuisMayoralUser(req) && rubroId !== 4) {
      return httpError(res, 403, "Luis Eduardo Mayoral Geraldo solo tiene acceso al catálogo del Rubro 4 (Tabletas Digitales).");
    }

    if (rubroId === 4) {
      const [tabRows] = await poolRead.query(
        `SELECT id, no_resguardo, imei, numero_serie, marca, modelo, descripcion, estatus_fisico, region, oficina_programa, observaciones
         FROM inventario_tabletas
         WHERE estado_asignacion = 'DISPONIBLE'
         ORDER BY no_resguardo ASC`
      );
      const data = tabRows.map((t) => {
        const marca = String(t.marca || "Compac").trim();
        const modelo = String(t.modelo || "QTab LTE").trim();
        const imei = String(t.imei || "").trim();
        const numSerie = String(t.numero_serie || "").trim();
        const descBase = String(t.descripcion || `Tablet ${marca}`).trim();
        return {
          id: t.id,
          tableta_id: t.id,
          articulo_id: t.id,
          no_resguardo: Number(t.no_resguardo),
          imei,
          numero_serie: numSerie,
          clave: `RESG-${t.no_resguardo}`,
          clave_bien: `RESG-${t.no_resguardo}`,
          descripcion: `${descBase} - No. de Resguardo #${t.no_resguardo}`,
          unidad: "PIEZA",
          stock: 1,
          cantidad_disponible: 1,
          cantidad_propia: 1,
          disponible: true,
          existencia: 1,
          marca,
          modelo,
          serie: `IMEI: ${imei || "-"} | Serie: ${numSerie || "-"}`,
          color: "",
          estado_salida: String(t.estatus_fisico || "BUENO").trim() || "BUENO",
          es_tableta: true,
        };
      });
      return res.json({ ok: true, rubro_id: 4, rubro_nombre: "Tabletas Digitales (Luis Eduardo Mayoral Geraldo)", data });
    }

    // Rubros 2 y 3: Inventario de Bodega RM / Delegación La Paz
    const hasDetCol = await ensureDetallesVehiculoCol();
    const [rmRows] = await poolRead.query(
      `SELECT id FROM oficinas_regionales
       WHERE region_id = 1 AND (nombre = 'RM (Recursos Materiales)' OR nombre = 'RM' OR nombre LIKE '%Recursos Materiales%')
       ORDER BY (nombre = 'RM (Recursos Materiales)') DESC, id ASC LIMIT 1`
    ).catch(() => [[]]);
    const rmOfiId = Number(rmRows[0]?.id || 0);

    const whereBodegaClause = rubroId === 3
      ? `(io.oficina_id = ? OR io.es_bodega_delegacion = 1) AND COALESCE(io.es_bodega_delegacion, 0) = 1`
      : `(io.oficina_id = 1 OR io.oficina_id = ? OR io.es_bodega_delegacion = 1)`;

    const [rawRows] = await poolRead.query(
      `SELECT 
         io.id,
         io.oficina_id,
         ofi.nombre AS oficina_nombre,
         io.es_bodega_delegacion,
         io.clave_bien AS clave,
         io.descripcion,
         io.unidad,
         COALESCE(io.cantidad_disponible, io.cantidad_propia) AS stock,
         COALESCE(io.cantidad_disponible, io.cantidad_propia) AS cantidad_disponible,
         io.cantidad_propia,
         (COALESCE(io.cantidad_disponible, io.cantidad_propia) > 0) AS disponible,
         COALESCE(io.cantidad_disponible, io.cantidad_propia) AS existencia,
         io.marca_modelo,
         io.numero_serie_placas AS serie,
         io.estado_fisico AS estado_salida,
         io.estado_fisico,
         io.estatus_uso,
         io.observaciones,
         io.observaciones_control,
         ${hasDetCol ? "io.detalles_vehiculo" : "NULL AS detalles_vehiculo"},
         r.nombre_rubro,
         r.encargado_nombre,
         r.encargado_cargo
       FROM inventario_oficina io
       LEFT JOIN oficinas_regionales ofi ON ofi.id = io.oficina_id
       LEFT JOIN rubros_inventario r ON r.id = io.rubro_id
       WHERE ${whereBodegaClause}
         AND io.rubro_id = ?
         AND COALESCE(io.cantidad_disponible, io.cantidad_propia) > 0
         AND io.estatus_uso NOT IN ('BAJA', 'SINIESTRO / EN ASEGURADORA', 'NO DISPONIBLE (SINIESTRO)')
       ORDER BY io.descripcion ASC`,
      [rmOfiId, rubroId]
    );

    // Excluir cualquier bien o vehículo reportado en Siniestro / Aseguradora / No Disponible
    let rows = rawRows.filter((r) => !isAssetInSiniestro(r));

    // v61: Para Rubro 2 (Parque Vehicular - Evelia), mostrar ÚNICAMENTE los vehículos asignados a Recursos Materiales (RM)
    if (rubroId === 2) {
      rows = rows.filter((r) => {
        if (rmOfiId > 0 && Number(r.oficina_id) === rmOfiId) return true;
        const ofiNom = String(r.oficina_nombre || "").toUpperCase();
        if (ofiNom === "RM" || ofiNom.includes("RECURSOS MATERIALES")) return true;
        let detStr = "";
        if (r.detalles_vehiculo) {
          detStr = typeof r.detalles_vehiculo === "object"
            ? JSON.stringify(r.detalles_vehiculo)
            : String(r.detalles_vehiculo);
        }
        const combined = [
          r.oficina_nombre,
          r.observaciones,
          r.observaciones_control,
          detStr,
        ]
          .join(" ")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toUpperCase();
        return (
          combined.includes("RECURSOS MATERIALES") ||
          /\bRM\b/.test(combined) ||
          combined.includes("PATRON MURILLO")
        );
      });
    }

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
      const stockDisp = Number(r.cantidad_disponible ?? r.stock ?? r.cantidad_propia ?? 0);
      return {
        id: r.id,
        articulo_id: r.id,
        oficina_id: r.oficina_id,
        clave: r.clave,
        clave_bien: r.clave,
        descripcion: r.descripcion,
        unidad: r.unidad || "PIEZA",
        stock: stockDisp,
        cantidad_disponible: stockDisp,
        cantidad_propia: Number(r.cantidad_propia ?? stockDisp),
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
      `SELECT vpd.*,
              t.no_resguardo AS tab_no_resguardo,
              t.imei AS tab_imei,
              t.numero_serie AS tab_numero_serie,
              t.marca AS tab_marca,
              t.modelo AS tab_modelo
       FROM vales_prestamo_detalle vpd
       LEFT JOIN inventario_tabletas t ON t.id = vpd.tableta_id
       WHERE vpd.vale_id = ?
       ORDER BY vpd.id ASC`,
      [id]
    );

    return res.json({ ok: true, data: { ...vale, detalles } });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// 4. Crear nuevo Vale Provisional (Control de Stock Inmediato, con soporte a Modo Prueba Grupal v61)
app.post("/api/vales-prestamo", authRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const rubroId = Number(b.rubro_id || 0);
    if (rubroId === 1) {
      return httpError(res, 400, "El Rubro 1 (Archivo y Materiales - Gabriel Adán Fiol Collins) no permite Vales Provisionales. Utiliza el módulo de Solicitudes de Material.");
    }
    if (![2, 3, 4].includes(rubroId)) return httpError(res, 400, "Rubro inválido para Vales Provisionales (2, 3 o 4)");
    if (isLuisMayoralUser(req) && rubroId !== 4) {
      return httpError(res, 403, "Luis Eduardo Mayoral Geraldo solo puede crear vales provisionales para el Rubro 4 (Tabletas Digitales).");
    }

    let deptoId = Number(b.departamento_id || 0);
    let deptoNombre = String(b.departamento_nombre || "").trim();

    // Regla de Negocio: solo admin puede seleccionar otros departamentos libremente
    const admin = isAdmin(req);
    const userDeptoId = Number(req.user?.id_oficialia || req.user?.oficialia_id || 0);
    const userDeptoNombre = String(req.user?.departamento || req.user?.oficialia_nombre || "").trim();

    if (!admin) {
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

    let recibeNombre = String(b.recibe_nombre || b.nombre_recibe || "").trim();
    let recibeCargo = String(b.recibe_cargo || b.cargo_recibe || "").trim();
    if (tipoFirmas === 2 || !recibeNombre) {
      recibeNombre = solicitanteNombre;
    }
    if (tipoFirmas === 2 || !recibeCargo) {
      recibeCargo = String(b.solicitante_cargo || b.cargo_solicitante || "").trim() || deptoNombre || solicitanteCargo;
    }

    const nowLocal = new Date();
    const todayLocalISO = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, "0")}-${String(nowLocal.getDate()).padStart(2, "0")}`;
    if (fechaSalida < todayLocalISO) {
      return httpError(res, 400, "La fecha de salida no puede ser anterior al día de hoy");
    }

    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return httpError(res, 400, "Debe agregar al menos un bien o material al vale");

    const ENCARGADOS_FIRMA_MAP = {
      1: { nombre: "GABRIEL ADÁN FIOL COLLINS", cargo: "ENCARGADO DE ARCHIVOS Y MATERIALES" },
      2: { nombre: "EVELIA CONTRERAS GODÍNEZ", cargo: "ENCARGADA DE PARQUE VEHICULAR / RECURSOS MATERIALES" },
      3: { nombre: "JESÚS SALVADOR PALACIOS MARTÍNEZ", cargo: "ENCARGADO DE MOBILIARIO / RECURSOS MATERIALES" },
      4: { nombre: "LUIS EDUARDO MAYORAL GERALDO", cargo: "ENCARGADO DE ALMACÉN" },
    };

    let encargadoEntrega = "";
    if (rubroId) {
      const [rubroRowCheck] = await poolRead.query(
        `SELECT encargado_nombre FROM rubros_inventario WHERE id = ? LIMIT 1`,
        [rubroId]
      ).catch(() => [[]]);
      if (rubroRowCheck.length && rubroRowCheck[0].encargado_nombre) {
        encargadoEntrega = rubroRowCheck[0].encargado_nombre;
      } else {
        const [usrRubroCheck] = await poolRead.query(
          `SELECT TRIM(CONCAT_WS(' ', NULLIF(nombre, ''), NULLIF(PRIMER_APELLIDO, ''), NULLIF(SEGUNDO_APELLIDO, ''))) AS nc
           FROM usuario WHERE rubro_id = ? AND ACTIVO = 1 LIMIT 1`,
          [rubroId]
        ).catch(() => [[]]);
        if (usrRubroCheck.length && usrRubroCheck[0].nc) {
          encargadoEntrega = usrRubroCheck[0].nc;
        }
      }
    }
    if (!encargadoEntrega) {
      encargadoEntrega = req.user?.nombre_completo || req.user?.username || ENCARGADOS_FIRMA_MAP[rubroId]?.nombre || "ENCARGADO DE ÁREA";
    }

    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();
      const esPruebaVal = 0;

      // Control de Stock (Modelo de Reserva para Préstamos): Validar y reservar unidades prestadas
      const tabletasAuditList = [];
      if (rubroId === 4) {
        const seenTabIds = new Set();
        const tempHolder = `PRÉSTAMO PROVISIONAL: ${solicitanteNombre}`.slice(0, 150);
        for (const it of items) {
          let tabId = Number(it.tableta_id || it.articulo_id || it.id || 0);
          let tabRow = null;
          if (tabId > 0) {
            const [tRows] = await conn.query(
              `SELECT * FROM inventario_tabletas WHERE id = ? LIMIT 1 FOR UPDATE`,
              [tabId]
            );
            tabRow = tRows[0] || null;
          } else if (it.no_resguardo) {
            const [tRows] = await conn.query(
              `SELECT * FROM inventario_tabletas WHERE no_resguardo = ? LIMIT 1 FOR UPDATE`,
              [Number(it.no_resguardo)]
            );
            tabRow = tRows[0] || null;
          }
          if (!tabRow) {
            await conn.rollback();
            return httpError(res, 404, `No se encontró la tableta seleccionada en el padrón oficial.`);
          }
          if (seenTabIds.has(Number(tabRow.id))) {
            await conn.rollback();
            return httpError(res, 400, `La tableta con Resguardo #${tabRow.no_resguardo} está duplicada en la solicitud.`);
          }
          seenTabIds.add(Number(tabRow.id));

          if (String(tabRow.estado_asignacion || "").toUpperCase() !== "DISPONIBLE") {
            await conn.rollback();
            return httpError(
              res,
              409,
              `La tableta con No. de Resguardo #${tabRow.no_resguardo} (IMEI: ${tabRow.imei}) ya fue ocupada y no está DISPONIBLE (Estado: ${tabRow.estado_asignacion}).`
            );
          }

          await conn.query(
            `UPDATE inventario_tabletas
             SET estado_asignacion = 'EN_PRESTAMO_PROVISIONAL',
                 nombre_resguardante = ?
             WHERE id = ?`,
            [tempHolder, tabRow.id]
          );

          it.tableta_id = tabRow.id;
          it.articulo_id = null;
          it.cantidad = 1;
          it.clave = `RESG-${tabRow.no_resguardo}`;
          it.descripcion = `Tablet Compac - No. de Resguardo #${tabRow.no_resguardo}`;
          it.marca = tabRow.marca || "Compac";
          it.modelo = tabRow.modelo || "QTab LTE";
          it.serie = `IMEI: ${tabRow.imei || "-"} | Serie: ${tabRow.numero_serie || "-"}`;
          it.estado_salida = it.estado_salida || tabRow.estatus_fisico || "BUENO";
          tabletasAuditList.push(tabRow);
        }
      } else {
        for (const it of items) {
          const cant = Math.max(1, Number(it.cantidad) || 1);
          const inv = await resolveInventarioOficinaRowStrict(conn, it, rubroId);
          if (!inv) {
            await conn.rollback();
            return httpError(res, 400, `No se encontró en inventario el bien (ID/clave): ${it.descripcion || it.clave || it.articulo_id}`);
          }
          if (isAssetInSiniestro(inv)) {
            await conn.rollback();
            return httpError(res, 409, `El bien "${inv.descripcion}" no está disponible para préstamo por encontrarse en SINIESTRO / ASEGURADORA.`);
          }
          const dispActual = Number(inv.cantidad_disponible ?? inv.cantidad_propia ?? 0);
          if (dispActual < cant) {
            await conn.rollback();
            return httpError(res, 400, `La cantidad solicitada (${cant}) para "${inv.descripcion}" supera la disponibilidad actual (${dispActual}).`);
          }
          const nuevaDisp = Math.max(0, dispActual - cant);
          const nuevoEstatus = nuevaDisp === 0 ? "PRESTADO" : inv.estatus_uso;
          await conn.query(
            `UPDATE inventario_oficina
             SET cantidad_disponible = ?,
                 cantidad_prestada_enviada = cantidad_prestada_enviada + ?,
                 estatus_uso = ?
             WHERE id = ?`,
            [nuevaDisp, cant, nuevoEstatus, inv.id]
          );
          it.articulo_id = inv.id;
          it.clave = inv.clave_bien || it.clave;
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
            estado, encargado_entrega, usuario_id, observaciones_prestamo, es_prueba)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AUTORIZADO_EN_PRESTAMO', ?, ?, ?, ?)`,
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
          esPruebaVal,
        ]
      );
      const valeId = resIns.insertId;

      for (const it of items) {
        const artId = it.articulo_id ? Number(it.articulo_id) : null;
        const tabId = it.tableta_id ? Number(it.tableta_id) : null;
        const clave = String(it.clave || "").trim() || null;
        const desc = String(it.descripcion || "").trim();
        if (!desc) continue;
        const cant = rubroId === 4 ? 1 : Math.max(1, Number(it.cantidad) || 1);
        const serie = String(it.serie || "").trim() || null;
        const marca = String(it.marca || "").trim() || null;
        const modelo = String(it.modelo || "").trim() || null;
        const color = String(it.color || "").trim() || null;
        const estSal = String(it.estado_salida || "BUEN ESTADO").trim();
        const obs = String(it.observaciones || "").trim() || null;

        await conn.query(
          `INSERT INTO vales_prestamo_detalle
             (vale_id, articulo_id, tableta_id, clave, descripcion, serie, marca, modelo, color, cantidad, estado_salida, estado_devolucion, observaciones)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?)`,
          [valeId, artId, tabId, clave, desc, serie, marca, modelo, color, cant, estSal, obs]
        );
      }

      if (rubroId === 4 && tabletasAuditList.length) {
        const actor = req?.user?.username || req?.user?.nombre || "SISTEMA";
        for (const tabRow of tabletasAuditList) {
          const detMsg = `Vale Provisional ${folio} autorizado/entregado a "${solicitanteNombre}". Operativo: ${operativoNombre}.`;
          await conn.query(
            `INSERT INTO bitacora_tabletas (tableta_id, no_resguardo, imei, numero_serie, usuario, accion, detalles)
             VALUES (?, ?, ?, ?, ?, 'PRESTAMO_PROVISIONAL', ?)`,
            [
              tabRow.id,
              tabRow.no_resguardo,
              tabRow.imei || null,
              tabRow.numero_serie || null,
              String(actor).slice(0, 80),
              detMsg,
            ]
          );
          await registrarBitacora(
            req,
            "TABLETAS",
            "PRESTAMO_PROVISIONAL",
            `Tableta #${tabRow.no_resguardo} (IMEI: ${tabRow.imei || "-"}, Serie: ${tabRow.numero_serie || "-"}) — ${detMsg}`,
            conn
          );
        }
      }

      await conn.commit();
      return res.json({
        ok: true,
        id: valeId,
        folio,
        es_prueba: esPruebaVal,
        message: `Vale Provisional ${folio} generado exitosamente${esPruebaVal ? " (Modo Prueba Grupal: sin afectación a inventario)" : ""}`,
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

// 5. Autorizar entrega de préstamo (soporta POST y PUT)
async function handleAutorizarValePrestamo(req, res) {
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

      // Descontar inventario según el rubro correspondiente (en producción)
      if (vale.rubro_id === 1) {
          for (const item of detalles) {
            const almRow = await resolveAlmacenRowStrict(conn, { articulo_id: item.articulo_id, clave: item.clave });
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
        } else if (Number(vale.rubro_id) === 4) {
          const tempHolder = `PRÉSTAMO PROVISIONAL: ${vale.solicitante_nombre || ""}`.slice(0, 150);
          const actor = req?.user?.username || req?.user?.nombre || "SISTEMA";
          for (const item of detalles) {
            const tabId = Number(item.tableta_id || item.articulo_id || 0);
            if (!tabId) continue;
            const [tRows] = await conn.query(
              `SELECT * FROM inventario_tabletas WHERE id = ? LIMIT 1 FOR UPDATE`,
              [tabId]
            );
            if (!tRows.length) {
              await conn.rollback();
              return httpError(res, 404, `No se encontró la tableta para el detalle: ${item.descripcion}`);
            }
            const tab = tRows[0];
            if (String(tab.estado_asignacion || "").toUpperCase() !== "DISPONIBLE") {
              await conn.rollback();
              return httpError(res, 409, `La tableta #${tab.no_resguardo} (IMEI: ${tab.imei}) ya no está DISPONIBLE (Estado: ${tab.estado_asignacion}).`);
            }
            await conn.query(
              `UPDATE inventario_tabletas
               SET estado_asignacion = 'EN_PRESTAMO_PROVISIONAL',
                   nombre_resguardante = ?
               WHERE id = ?`,
              [tempHolder, tab.id]
            );
            await conn.query(
              `INSERT INTO bitacora_tabletas (tableta_id, no_resguardo, imei, numero_serie, usuario, accion, detalles)
               VALUES (?, ?, ?, ?, ?, 'PRESTAMO_PROVISIONAL', ?)`,
              [
                tab.id,
                tab.no_resguardo,
                tab.imei || null,
                tab.numero_serie || null,
                String(actor).slice(0, 80),
                `Vale Provisional ${vale.folio} autorizado a "${vale.solicitante_nombre}". Operativo: ${vale.operativo_nombre}.`,
              ]
            );
          }
        } else {
          for (const item of detalles) {
            if (!item.articulo_id) continue;
            const [invRows] = await conn.query(
              `SELECT id, cantidad_propia, cantidad_disponible, estatus_uso, estado_fisico, observaciones, descripcion
               FROM inventario_oficina
               WHERE id = ?
               FOR UPDATE`,
              [item.articulo_id]
            );
            if (!invRows.length) {
              await conn.rollback();
              return httpError(res, 400, `No se encontró en inventario el bien: ${item.descripcion}`);
            }
            const inv = invRows[0];
            if (isAssetInSiniestro(inv)) {
              await conn.rollback();
              return httpError(res, 409, `El bien "${inv.descripcion}" no está disponible para préstamo por encontrarse en SINIESTRO / ASEGURADORA.`);
            }
            const dispActual = Number(inv.cantidad_disponible ?? inv.cantidad_propia ?? 0);
            if (dispActual < Number(item.cantidad)) {
              await conn.rollback();
              return httpError(res, 400, `La cantidad solicitada (${item.cantidad}) para "${item.descripcion}" supera la disponibilidad actual (${dispActual}).`);
            }
            const nuevaDisp = Math.max(0, dispActual - Number(item.cantidad));
            const nuevoEstatus = nuevaDisp === 0 ? "PRESTADO" : inv.estatus_uso;
            await conn.query(
              `UPDATE inventario_oficina
               SET cantidad_disponible = ?,
                   cantidad_prestada_enviada = cantidad_prestada_enviada + ?,
                   estatus_uso = ?
               WHERE id = ?`,
              [nuevaDisp, item.cantidad, nuevoEstatus, item.articulo_id]
            );
          }
        }

      const [[rubroInfo]] = await conn.query(`SELECT encargado_nombre FROM rubros_inventario WHERE id = ?`, [vale.rubro_id]);
      const encargadoEntrega = Number(vale.rubro_id) === 4
        ? "Luis Eduardo Mayoral Geraldo"
        : (rubroInfo?.encargado_nombre || req.user?.nombre_completo || req.user?.username);

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
}
app.post("/api/vales-prestamo/:id/autorizar", authRequired, handleAutorizarValePrestamo);
app.put("/api/vales-prestamo/:id/autorizar", authRequired, handleAutorizarValePrestamo);

// 6. Registrar devolución de préstamo (reincorpora stock / tabletas, soporta POST y PUT)
async function handleDevolverValePrestamo(req, res) {
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

      // Reincorporar stock según rubro en devolución (en producción)
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
            const almRowDev = await resolveAlmacenRowStrict(conn, { articulo_id: item.articulo_id, clave: item.clave });
            if (almRowDev) {
              await conn.query(`UPDATE almacen_dregcivil SET STOCK = STOCK + ? WHERE ID = ?`, [item.cantidad, almRowDev.ID]);
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
      } else if (Number(vale.rubro_id) === 4) {
        const actor = req?.user?.username || req?.user?.nombre || "SISTEMA";
        const obsGeneral = String(b.observaciones_devolucion || "").trim() || null;
        for (const item of detalles) {
          const ret = itemMap.get(Number(item.id)) || {};
          const estDev = String(ret.estado_devolucion || item.estado_devolucion || "BUEN ESTADO").trim().toUpperCase();
          const obsDev = ret.observaciones !== undefined ? (String(ret.observaciones || "").trim() || null) : item.observaciones;
          const devFlag = (estDev !== "NO DEVUELTO" && estDev !== "FALTANTE") ? 1 : 0;

          await conn.query(
            `UPDATE vales_prestamo_detalle
             SET estado_devolucion = ?, observaciones = ?, devuelto = ?, cantidad_devuelta = ?, fecha_devolucion = NOW()
             WHERE id = ?`,
            [estDev, obsDev, devFlag, devFlag ? Number(item.cantidad || 1) : 0, item.id]
          );

          const tabId = Number(item.tableta_id || item.articulo_id || 0);
          if (tabId && devFlag) {
            const [[tabRow]] = await conn.query(
              `SELECT id, no_resguardo, imei, numero_serie, estatus_fisico, observaciones FROM inventario_tabletas WHERE id = ? LIMIT 1 FOR UPDATE`,
              [tabId]
            );
            if (tabRow) {
              let mappedFisico = null;
              if (estDev === "CON DAÑOS" || estDev === "DAÑADO" || estDev === "MALO") mappedFisico = "DAÑADO";
              else if (estDev === "INCOMPLETO") mappedFisico = "INCOMPLETO";
              else if (estDev === "REGULAR") mappedFisico = "REGULAR";
              else if (estDev === "BUEN ESTADO" || estDev === "BUENO") mappedFisico = "BUENO";

              const obsTab = obsDev || obsGeneral || null;
              await conn.query(
                `UPDATE inventario_tabletas
                 SET estado_asignacion = 'DISPONIBLE',
                     region = 'LA PAZ',
                     oficina_programa = 'Delegación La Paz',
                     nombre_resguardante = '',
                     estatus_fisico = COALESCE(?, estatus_fisico),
                     observaciones = CASE WHEN ? IS NOT NULL AND TRIM(?) <> '' THEN ? ELSE observaciones END
                 WHERE id = ?`,
                [mappedFisico, obsTab, obsTab, obsTab, tabId]
              );
              await conn.query(
                `INSERT INTO bitacora_tabletas (tableta_id, no_resguardo, imei, numero_serie, usuario, accion, detalles)
                 VALUES (?, ?, ?, ?, ?, 'REINTEGRO_PROVISIONAL', ?)`,
                [
                  tabRow.id,
                  tabRow.no_resguardo,
                  tabRow.imei || null,
                  tabRow.numero_serie || null,
                  String(actor).slice(0, 80),
                  `Devolución registrada en Vale Provisional ${vale.folio} (${estDev}). Reintegrada a DISPONIBLE.${obsTab ? ` Obs: ${obsTab}` : ""}`,
                ]
              );
            }
          }
        }
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
            const [invCur] = await conn.query(
              `SELECT cantidad_propia, cantidad_disponible, cantidad_prestada_enviada FROM inventario_oficina WHERE id = ? FOR UPDATE`,
              [item.articulo_id]
            );
            const cantPropiaActual = Number(invCur[0]?.cantidad_propia || 0);
            const dispActual = Number(invCur[0]?.cantidad_disponible ?? cantPropiaActual);
            const cantDev = Number(item.cantidad || 0);
            const nuevaPropia = cantPropiaActual;
            const nuevaDisp = Math.min(cantPropiaActual, dispActual + cantDev);
            await conn.query(
              `UPDATE inventario_oficina
               SET cantidad_propia = ?,
                   cantidad_disponible = ?,
                   cantidad_prestada_enviada = GREATEST(0, cantidad_prestada_enviada - ?),
                   estatus_uso = 'ACTIVO',
                   estado_fisico = CASE WHEN ? = 'BUEN ESTADO' THEN 'BUENO' WHEN ? = 'REGULAR' THEN 'REGULAR' WHEN ? = 'CON DAÑOS' THEN 'MALO' ELSE estado_fisico END
               WHERE id = ?`,
              [nuevaPropia, nuevaDisp, cantDev, estDev, estDev, estDev, item.articulo_id]
            );
          }
        }
      }

      const [[rubroInfo]] = await conn.query(`SELECT encargado_nombre FROM rubros_inventario WHERE id = ?`, [vale.rubro_id]);
      const encargadoRecibe = Number(vale.rubro_id) === 4
        ? "Luis Eduardo Mayoral Geraldo"
        : (rubroInfo?.encargado_nombre || req.user?.nombre_completo || req.user?.username);

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
}
app.post("/api/vales-prestamo/:id/devolver", authRequired, handleDevolverValePrestamo);
app.put("/api/vales-prestamo/:id/devolver", authRequired, handleDevolverValePrestamo);

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

// 7. Cancelar Vale Provisional (soporta POST y PUT)
async function handleCancelarValePrestamo(req, res) {
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

      // Reintegrar stock al inventario si estaba en préstamo activo (en producción)
      if (vale.estado === "AUTORIZADO_EN_PRESTAMO") {
        const [detalles] = await conn.query(`SELECT * FROM vales_prestamo_detalle WHERE vale_id = ?`, [id]);
        if (vale.rubro_id === 1) {
          for (const item of detalles) {
            const almRowCan = await resolveAlmacenRowStrict(conn, { articulo_id: item.articulo_id, clave: item.clave });
            if (almRowCan) {
              await conn.query(`UPDATE almacen_dregcivil SET STOCK = STOCK + ? WHERE ID = ?`, [item.cantidad, almRowCan.ID]);
            }
          }
          await syncAlmacenCentralToInventarioRegional(conn).catch(() => {});
        } else if (Number(vale.rubro_id) === 4) {
          const actor = req?.user?.username || req?.user?.nombre || "SISTEMA";
          for (const item of detalles) {
            const tabId = Number(item.tableta_id || item.articulo_id || 0);
            if (!tabId) continue;
            const [[tabRow]] = await conn.query(
              `SELECT id, no_resguardo, imei, numero_serie FROM inventario_tabletas WHERE id = ? LIMIT 1 FOR UPDATE`,
              [tabId]
            );
            if (tabRow) {
              await conn.query(
                `UPDATE inventario_tabletas
                 SET estado_asignacion = 'DISPONIBLE',
                     region = 'LA PAZ',
                     oficina_programa = 'Delegación La Paz',
                     nombre_resguardante = ''
                 WHERE id = ?`,
                [tabId]
              );
              await conn.query(
                `INSERT INTO bitacora_tabletas (tableta_id, no_resguardo, imei, numero_serie, usuario, accion, detalles)
                 VALUES (?, ?, ?, ?, ?, 'REINTEGRO_PROVISIONAL', ?)`,
                [
                  tabRow.id,
                  tabRow.no_resguardo,
                  tabRow.imei || null,
                  tabRow.numero_serie || null,
                  String(actor).slice(0, 80),
                  `Vale Provisional ${vale.folio} cancelado. Tableta reintegrada automáticamente a DISPONIBLE.`,
                ]
              );
            }
          }
        } else {
          for (const item of detalles) {
            if (item.articulo_id) {
              // v42: reintegrar a la disponibilidad del registro exacto (por ID), sin inflar la cantidad propia
              await conn.query(
                `UPDATE inventario_oficina
                 SET cantidad_disponible = LEAST(cantidad_propia, COALESCE(cantidad_disponible, cantidad_propia) + ?),
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
}
app.post("/api/vales-prestamo/:id/cancelar", authRequired, handleCancelarValePrestamo);
app.put("/api/vales-prestamo/:id/cancelar", authRequired, handleCancelarValePrestamo);

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
      `SELECT vpd.*,
              t.no_resguardo AS tab_no_resguardo,
              t.imei AS tab_imei,
              t.numero_serie AS tab_numero_serie,
              t.marca AS tab_marca,
              t.modelo AS tab_modelo
       FROM vales_prestamo_detalle vpd
       LEFT JOIN inventario_tabletas t ON t.id = vpd.tableta_id
       WHERE vpd.vale_id = ?
       ORDER BY vpd.id ASC`,
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

    const isRubroTabletas = Number(vale.rubro_id) === 4;
    // 5. Tabla de Bienes Prestados (Ancho = 540 pt)
    const tTop = pY + 24;
    const colNoW = 28;
    const colCantW = 38;
    const colDescW = isRubroTabletas ? 190 : 224;
    const colMarcaW = isRubroTabletas ? 184 : 140;
    const colEstW = isRubroTabletas ? 100 : 110;

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
    const rowH = isRubroTabletas ? 21 : 15.5;

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
        doc.fillColor("#000000").font("Helvetica").fontSize(isRubroTabletas ? 6.6 : 7.2);
        doc.text(String(i + 1), xNo, textY, { width: colNoW, align: "center" });
        doc.text(String(isRubroTabletas ? 1 : (it.cantidad || 1)), xCant, textY, { width: colCantW, align: "center" });

        if (isRubroTabletas) {
          const descTab = it.tab_no_resguardo
            ? `Tablet Compac - No. de Resguardo #${it.tab_no_resguardo}`
            : String(it.descripcion || "Tablet Compac");
          doc.text(descTab, xDesc + 4, textY, { width: colDescW - 8, height: rowH - 5, ellipsis: true });

          const tabMarcaMod = `${it.tab_marca || it.marca || "Compac"} ${it.tab_modelo || it.modelo || "QTab LTE"}`.trim();
          const marcaModSerTab = (it.tab_imei || it.tab_numero_serie)
            ? `${tabMarcaMod} | IMEI: ${it.tab_imei || "-"} | Serie: ${it.tab_numero_serie || "-"}`
            : (it.serie || tabMarcaMod);
          doc.fontSize(6.2).text(marcaModSerTab, xMarca + 4, curY + 3, { width: colMarcaW - 8, height: rowH - 4, ellipsis: true });
          doc.fontSize(6.6).text(String(it.estado_salida || "BUENO"), xEst, textY, { width: colEstW, align: "center" });
        } else {
          doc.text(String(it.descripcion || ""), xDesc + 4, textY, { width: colDescW - 8, lineBreak: false });

          const marcaModSer = [
            [it.marca, it.modelo].filter(Boolean).join(" "),
            it.serie ? `S/N: ${it.serie}` : "",
            it.color ? `(${it.color})` : "",
          ].filter(Boolean).join(" - ") || "N/A";
          doc.text(marcaModSer, xMarca + 4, textY, { width: colMarcaW - 8, lineBreak: false });

          doc.text(String(it.estado_salida || "BUEN ESTADO"), xEst, textY, { width: colEstW, align: "center" });
        }
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
      1: { nombre: "GABRIEL ADÁN FIOL COLLINS", cargo: "ENCARGADO DE ARCHIVOS Y MATERIALES" },
      2: { nombre: "EVELIA CONTRERAS GODÍNEZ", cargo: "ENCARGADA DE PARQUE VEHICULAR / RECURSOS MATERIALES" },
      3: { nombre: "JESÚS SALVADOR PALACIOS MARTÍNEZ", cargo: "ENCARGADO DE MOBILIARIO / RECURSOS MATERIALES" },
      4: { nombre: "LUIS EDUARDO MAYORAL GERALDO", cargo: "ENCARGADO DE ALMACÉN" },
    };

    const fallbackEnc = ENCARGADOS_FIRMA_MAP[Number(vale.rubro_id)] || {
      nombre: "ENCARGADO DE ÁREA",
      cargo: "COORDINADOR OPERATIVO DE RECURSOS MATERIALES",
    };

    const encData = isRubroTabletas
      ? {
          nombre: "LUIS EDUARDO MAYORAL GERALDO",
          cargo: "ENCARGADO DE ALMACÉN",
        }
      : {
          nombre: String(vale.encargado_rubro_nombre || vale.encargado_entrega || fallbackEnc.nombre).toUpperCase(),
          cargo: String(vale.encargado_rubro_cargo || fallbackEnc.cargo).toUpperCase(),
        };

    let validaNombre = "JORGE LUIS PATRÓN MURILLO";
    let validaCargo = "COORDINADOR OPERATIVO DE RECURSOS MATERIALES";
    const [validaUserRows] = await poolRead.query(
      `SELECT TRIM(CONCAT_WS(' ', NULLIF(nombre, ''), NULLIF(PRIMER_APELLIDO, ''), NULLIF(SEGUNDO_APELLIDO, ''))) AS nc, cargo
       FROM usuario
       WHERE (username IN ('jorge', 'jorgepatron') OR departamento LIKE '%Recursos Materiales%' OR cargo LIKE '%Recursos Materiales%') AND ACTIVO = 1
       ORDER BY (username = 'jorge') DESC LIMIT 1`
    ).catch(() => [[]]);
    if (validaUserRows.length && validaUserRows[0].nc) {
      validaNombre = validaUserRows[0].nc.toUpperCase();
      if (validaUserRows[0].cargo) validaCargo = validaUserRows[0].cargo.toUpperCase();
    }

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
        `SELECT * FROM vales_prestamo WHERE estado NOT IN ('DEVUELTO', 'CANCELADO', 'RECHAZADO') FOR UPDATE`
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

      await repararInventarioBodegaDelegacionRM(poolOps).catch(() => {});

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
// RECÁLCULO ESTRICTO DE INVENTARIO POR ID ÚNICO (SIN ALTERAR cantidad_propia)
// ============================================================================
app.post("/api/migracion/consolidar-bodega-rm-jesus", authRequired, async (req, res) => {
  try {
    const uName = normalizeUser(req.user?.username);
    if (!isAdmin(req) && !["jesus", "rodrigo", "jorge", "jorgepatron"].includes(uName)) {
      return httpError(res, 403, "No tienes permisos para recalcular el inventario de Mobiliario RM.");
    }
    const result = await repararInventarioBodegaDelegacionRM(poolOps);
    if (!result.ok) {
      return httpError(res, 500, result.error || "Error al recalcular inventario por ID único");
    }
    return res.json({
      ...result,
      message: "Recálculo estricto por ID único completado sin alterar cantidades propias ni fusionar artículos.",
    });
  } catch (e) {
    console.error("Error en POST /api/migracion/consolidar-bodega-rm-jesus:", e);
    return httpError(res, 500, e.message || "Error al recalcular inventario por ID único");
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
// v53: LISTADO Y DESCARGA DE RESPALDOS (EXCLUSIVO ADMINISTRADOR)
// ============================================================================
app.get("/api/admin/backups", authRequired, async (req, res) => {
  try {
    const rolNorm = String(req.user?.rol || "").trim().toLowerCase();
    const isUserAdmin = isAdmin(req) || rolNorm === "admin" || String(req.user?.username || "").toLowerCase() === "admin";
    if (!isUserAdmin) {
      return httpError(res, 403, "Acceso exclusivo para el Administrador.");
    }

    const backupDir = path.join(__dirname, "respaldos_sistema");
    const dbDir = path.join(backupDir, "base_de_datos");

    const downloadFile = req.query.download || req.query.file;
    if (downloadFile) {
      const safeName = path.basename(String(downloadFile));
      let targetPath = path.join(backupDir, safeName);
      if (!fs.existsSync(targetPath)) {
        targetPath = path.join(dbDir, safeName);
      }
      if (!fs.existsSync(targetPath)) {
        return httpError(res, 404, "El archivo de respaldo solicitado no existe.");
      }
      return res.download(targetPath, safeName);
    }

    const fileList = [];
    const scanDir = (dirPath, subfolder = "") => {
      if (!fs.existsSync(dirPath)) return;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isFile() && (ent.name.endsWith(".json") || ent.name.endsWith(".sql"))) {
          const fullPath = path.join(dirPath, ent.name);
          const stat = fs.statSync(fullPath);
          fileList.push({
            nombre: ent.name,
            subcarpeta: subfolder,
            ruta_relativa: subfolder ? `${subfolder}/${ent.name}` : ent.name,
            tamano_bytes: stat.size,
            tamano_kb: (stat.size / 1024).toFixed(2),
            fecha_modificacion: stat.mtime,
            es_cambio_version: ent.name.startsWith("backup_v")
          });
        }
      }
    };

    scanDir(backupDir, "");
    scanDir(dbDir, "base_de_datos");

    fileList.sort((a, b) => new Date(b.fecha_modificacion) - new Date(a.fecha_modificacion));

    return res.json({
      ok: true,
      total: fileList.length,
      backups: fileList
    });
  } catch (err) {
    return httpError(res, 500, err?.message || "Error al listar respaldos");
  }
});

// ============================================================================
// v53: RESTAURACIÓN DE BASE DE DATOS DESDE RESPALDO JSON (EXCLUSIVO ADMINISTRADOR)
// ============================================================================
app.post("/api/admin/backups/restore", authRequired, async (req, res) => {
  try {
    const rolNorm = String(req.user?.rol || "").trim().toLowerCase();
    const isUserAdmin = isAdmin(req) || rolNorm === "admin" || String(req.user?.username || "").toLowerCase() === "admin";
    if (!isUserAdmin) {
      return httpError(res, 403, "Acceso exclusivo para el Administrador.");
    }

    const body = req.body || {};
    const filename = String(body.filename || body.archivo || "").trim();
    if (!filename) {
      return httpError(res, 400, "Nombre de archivo de respaldo requerido (filename).");
    }

    const safeName = path.basename(filename);
    const backupDir = path.join(__dirname, "respaldos_sistema");
    const dbDir = path.join(backupDir, "base_de_datos");
    let targetPath = path.join(backupDir, safeName);
    if (!fs.existsSync(targetPath)) {
      targetPath = path.join(dbDir, safeName);
    }
    if (!fs.existsSync(targetPath) || !safeName.endsWith(".json")) {
      return httpError(res, 404, "El archivo de respaldo JSON especificado no existe.");
    }

    const rawContent = fs.readFileSync(targetPath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch (parseErr) {
      return httpError(res, 400, `El archivo de respaldo no es un JSON válido: ${parseErr.message}`);
    }

    const tables = parsed.tables || parsed.data || null;
    if (!tables || typeof tables !== "object") {
      return httpError(res, 400, "El formato del respaldo es inválido (no contiene el objeto 'tables').");
    }

    const [dbTables] = await poolRead.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?`,
      [DB_NAME]
    );
    const existingTableSet = new Set(dbTables.map((t) => String(t.TABLE_NAME || "").toLowerCase()));

    const conn = await poolOps.getConnection();
    const restoredSummary = {};
    try {
      await conn.query("SET FOREIGN_KEY_CHECKS = 0;");

      for (const [tbl, rows] of Object.entries(tables)) {
        if (!existingTableSet.has(tbl.toLowerCase())) continue;
        if (!Array.isArray(rows) || rows.length === 0) continue;

        await conn.query(`DELETE FROM ${qi(tbl)}`);

        const cols = Object.keys(rows[0]);
        const placeholders = cols.map(() => "?").join(", ");
        const insertSql = `INSERT INTO ${qi(tbl)} (${cols.map(qi).join(", ")}) VALUES (${placeholders})`;

        for (const r of rows) {
          const vals = cols.map((c) => {
            const v = r[c];
            if (v === null || v === undefined) return null;
            if (typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) {
              return JSON.stringify(v);
            }
            return v;
          });
          await conn.query(insertSql, vals);
        }
        restoredSummary[tbl] = rows.length;
      }

      await conn.query("SET FOREIGN_KEY_CHECKS = 1;");
    } finally {
      conn.release();
    }

    await registrarBitacora(
      req,
      "SISTEMA",
      "RESTAURAR_RESPALDO",
      `Restauración de emergencia ejecutada desde ${safeName}. Tablas restauradas: ${Object.keys(restoredSummary).join(", ")}.`
    );

    return res.json({
      ok: true,
      message: `Base de datos restaurada exitosamente desde ${safeName}.`,
      archivo: safeName,
      tablas_restauradas: restoredSummary
    });
  } catch (err) {
    return httpError(res, 500, err?.message || "Error al restaurar respaldo");
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

    const [[kpiTabletas]] = await poolRead.query(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN t.estado_asignacion IN ('EN_RESGUARDO', 'ASIGNADA') THEN 1 ELSE 0 END), 0) AS en_resguardo,
        COALESCE(SUM(CASE WHEN t.estado_asignacion = 'DEVOLUCION_PENDIENTE' THEN 1 ELSE 0 END), 0) AS devolucion_pendiente,
        COALESCE(SUM(CASE WHEN t.estado_asignacion = 'DISPONIBLE' THEN 1 ELSE 0 END), 0) AS disponibles,
        COALESCE(SUM(CASE WHEN t.estado_asignacion = 'EN_PRESTAMO_PROVISIONAL' AND EXISTS (
          SELECT 1
          FROM vales_prestamo_detalle vpd
          INNER JOIN vales_prestamo vp ON vp.id = vpd.vale_id
          WHERE (vpd.tableta_id = t.id OR vpd.articulo_id = t.id)
            AND vp.rubro_id = 4
            AND vp.estado IN ('PENDIENTE', 'AUTORIZADO_EN_PRESTAMO', 'EN_PRESTAMO')
            AND COALESCE(vpd.estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')
        ) THEN 1 ELSE 0 END), 0) AS en_prestamo_provisional
      FROM inventario_tabletas t
    `).catch(() => [[{ total: 0, en_resguardo: 0, devolucion_pendiente: 0, disponibles: 0, en_prestamo_provisional: 0 }]]);

    const [regionesDistribucion] = await poolRead.query(`
      SELECT 
        r.id AS region_id,
        r.nombre AS region_nombre,
        COUNT(DISTINCT o.id) AS total_oficinas,
        COALESCE(SUM(CASE WHEN io.rubro_id <> 4 THEN io.cantidad_propia ELSE 0 END), 0) AS total_bienes
      FROM regiones r
      LEFT JOIN oficinas_regionales o ON o.region_id = r.id
      LEFT JOIN inventario_oficina io ON io.oficina_id = o.id
      GROUP BY r.id, r.nombre
      ORDER BY r.id ASC
    `);

    const [tabletasRowsAll] = await poolRead.query(`
      SELECT id, no_resguardo, imei, numero_serie, no_caja, marca, modelo, descripcion,
             region, oficina_programa, nombre_resguardante, cargo_resguardante,
             estatus_fisico, estado_asignacion, observaciones
      FROM inventario_tabletas
      ORDER BY no_resguardo ASC
    `).catch(() => [[]]);

    const normRegKey = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
    const matchRegionForTableta = (regStr) => {
      const k = normRegKey(regStr);
      if (!k) return null;
      return regionesDistribucion.find((rd) => {
        const rn = normRegKey(rd.region_nombre);
        if (!rn) return false;
        if (rn.includes(k) || k.includes(rn)) return true;
        if (k === "LORETO" && rn.includes("COMONDU")) return true;
        return false;
      }) || null;
    };

    for (const t of tabletasRowsAll) {
      const mReg = matchRegionForTableta(t.region);
      if (mReg) {
        mReg.total_bienes = Number(mReg.total_bienes || 0) + 1;
      }
    }

    // 2. Consulta de Activos Consolidados con Filtros
    let activosRows = [];
    if (rubId !== 4) {
      let whereRegional = "WHERE io.rubro_id <> 4";
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
      const [regRows] = await poolRead.query(`
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
      activosRows = regRows.map((r) => ({
        ...r,
        detalles_vehiculo: parseDetallesVehiculo(r.detalles_vehiculo)
      }));
    }

    if (!rubId || rubId === 4) {
      const searchLower = search.toLowerCase();
      for (const t of tabletasRowsAll) {
        const mReg = matchRegionForTableta(t.region);
        const tabRegionId = mReg ? Number(mReg.region_id) : 0;
        if (regId > 0 && tabRegionId !== regId) continue;

        const mapped = {
          id: `tab-${t.id}`,
          tableta_id: t.id,
          es_tableta: true,
          clave_bien: `TAB-${String(t.no_resguardo).padStart(3, "0")}`,
          no_resguardo: t.no_resguardo,
          descripcion: `${t.descripcion || "Tablet Compac"} (Resguardo #${t.no_resguardo})${t.nombre_resguardante ? ` — ${t.nombre_resguardante}` : ""}`,
          marca_modelo: `${t.marca || "Compac"} ${t.modelo || "QTab LTE"}`.trim(),
          numero_serie_placas: `IMEI: ${t.imei || "-"} | Serie: ${t.numero_serie || "-"}`,
          imei: t.imei || "",
          numero_serie: t.numero_serie || "",
          unidad: "PIEZA",
          cantidad_propia: 1,
          estado_fisico: t.estatus_fisico || "BUENO",
          estatus_uso: t.estado_asignacion === "DISPONIBLE" ? "DISPONIBLE" : (t.estado_asignacion === "DEVOLUCION_PENDIENTE" ? "EN DEVOLUCIÓN" : "ASIGNADA"),
          estado_asignacion: t.estado_asignacion || "ASIGNADA",
          observaciones: t.observaciones || "",
          origen_adquisicion: "PATRIMONIO TABLETAS",
          detalles_vehiculo: null,
          region_id: tabRegionId,
          region_nombre: t.region || "SIN DEFINIR",
          oficina_id: 0,
          oficina_nombre: t.oficina_programa || "Sin definir",
          municipio: t.region || "",
          rubro_id: 4,
          rubro_codigo: "TABLETAS",
          nombre_rubro: "Tabletas Digitales (Luis Mayoral)",
          encargado_nombre: "Luis Eduardo Mayoral Geraldo",
          nombre_resguardante: t.nombre_resguardante || "Sin asignar"
        };

        if (searchLower) {
          const hay = [
            mapped.clave_bien,
            mapped.no_resguardo,
            mapped.descripcion,
            mapped.marca_modelo,
            mapped.numero_serie_placas,
            mapped.imei,
            mapped.numero_serie,
            mapped.region_nombre,
            mapped.oficina_nombre,
            mapped.nombre_resguardante
          ].join(" ").toLowerCase();
          if (!hay.includes(searchLower)) continue;
        }
        activosRows.push(mapped);
      }
    }

    const totalTablets = Number(kpiTabletas?.total || 0);
    const totalBienesSinRubro4 = Number(kpiRegional?.total_bienes || 0) - Number(kpiRegional?.rubro_tablets || 0);

    return res.json({
      ok: true,
      kpis: {
        total_bienes_estatales: totalBienesSinRubro4 + totalTablets,
        total_vehicular: Number(kpiRegional?.rubro_vehicular || 0),
        total_mobiliario: Number(kpiRegional?.rubro_mobiliario || 0),
        total_tablets: totalTablets,
        tabletas_resumen: {
          total: totalTablets,
          en_resguardo: Number(kpiTabletas?.en_resguardo || 0),
          devolucion_pendiente: Number(kpiTabletas?.devolucion_pendiente || 0),
          disponibles: Number(kpiTabletas?.disponibles || 0)
        },
        total_archivo_materiales: Number(kpiRegional?.rubro_archivo || 0),
        almacen_general_stock: Number(kpiAlmacen?.total_stock_almacen || 0),
        almacen_general_articulos: Number(kpiAlmacen?.total_articulos_almacen || 0),
        distribucion_regiones: regionesDistribucion
      },
      data: activosRows
    });
  } catch (e) {
    return httpError(res, 500, e.message);
  }
});

// ============================================================================
// v56: MÓDULO DE TABLETAS DIGITALES (LUIS EDUARDO MAYORAL GERALDO)
// Semilla automática (276 tabletas), Devolución, Resguardo Personal y PDFs
// ============================================================================
const RED_RESGUARDOS_TABLETAS = new Set([
  253, 254, 255, 256, 257, 258, 259, 260, 264, 265, 266, 267, 268, 269, 270, 271, 274,
]);

function extractExcelCellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) {
      return v.richText.map((t) => String(t?.text || "")).join("").trim();
    }
    if (v.result !== undefined && v.result !== null) return String(v.result).trim();
    if (v.text !== undefined && v.text !== null) return String(v.text).trim();
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

function mapExcelRegionProgramaTableta(rawRegionProg) {
  const key = String(rawRegionProg || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
  if (key === "DELEGACION") return { region: "LA PAZ", oficina_programa: "Delegación La Paz" };
  if (key === "LA PAZ") return { region: "LA PAZ", oficina_programa: "Región La Paz" };
  if (key === "JEFATURA") return { region: "LA PAZ", oficina_programa: "Jefatura" };
  if (key === "PCD") return { region: "LA PAZ", oficina_programa: "PCD - Programa de Discapacidad" };
  if (key === "PAM") return { region: "LA PAZ", oficina_programa: "PAM - Programa Adulto Mayor" };
  if (key === "LOS CABOS") return { region: "LOS CABOS", oficina_programa: "Región Los Cabos" };
  if (key === "COMONDU") return { region: "COMONDU", oficina_programa: "Región Comondú" };
  if (key === "MULEGE") return { region: "MULEGE", oficina_programa: "Región Mulegé" };
  return { region: "LA PAZ", oficina_programa: "Delegación La Paz" };
}

function normalizeTabletaRegionInput(rawRegion, rawOficina) {
  const r = String(rawRegion || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
  const ofi = String(rawOficina || "").trim();
  let region = "LA PAZ";
  if (r.includes("CABOS")) region = "LOS CABOS";
  else if (r.includes("COMONDU") || r.includes("LORETO")) region = "COMONDU";
  else if (r.includes("MULEGE")) region = "MULEGE";
  else if (r.includes("PAZ") || r === "DELEGACION" || r === "PCD" || r === "PAM" || r.includes("JEFATURA")) region = "LA PAZ";

  let oficina_programa = ofi;
  if (!oficina_programa) {
    if (region === "LOS CABOS") oficina_programa = "Región Los Cabos";
    else if (region === "COMONDU") oficina_programa = "Región Comondú";
    else if (region === "MULEGE") oficina_programa = "Región Mulegé";
    else oficina_programa = "Delegación La Paz";
  }
  return { region, oficina_programa };
}

async function seedInventarioTabletasIfEmpty() {
  if (!poolOps || !poolRead) return;
  const [[cntRow]] = await poolRead
    .query(`SELECT COUNT(*) AS total FROM inventario_tabletas`)
    .catch(() => [[{ total: 1 }]]);
  if (Number(cntRow?.total || 0) > 0) return;

  const candidatePaths = [
    path.join(__dirname, "Registro_Tabletas_Bienestar (2).xlsx"),
    path.join(__dirname, "Tabletas_inventario.xlsx"),
    "C:/Users/danie/.gemini/antigravity/brain/e63b32a5-942f-4d30-9d7d-1182c0ddbc46/.user_uploaded/media_1794538721890_50f732e9.xlsx",
  ];
  const excelPath = candidatePaths.find((p) => fs.existsSync(p));
  if (!excelPath) {
    console.warn("[WARN] seedInventarioTabletasIfEmpty: No se encontró el archivo Excel fuente de tabletas.");
    return;
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(excelPath);
  const ws = wb.getWorksheet("BCS") || wb.worksheets[0];
  if (!ws) return;

  const parsedRows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber < 4) return;
    const noResgRaw = extractExcelCellText(row.getCell(3).value);
    const noResguardo = parseInt(noResgRaw, 10);
    if (!Number.isInteger(noResguardo) || noResguardo <= 0) return;

    const rawRegionProg = extractExcelCellText(row.getCell(2).value).toUpperCase();
    const rawNombre = extractExcelCellText(row.getCell(4).value);
    const noCaja = extractExcelCellText(row.getCell(5).value);
    const modelo = extractExcelCellText(row.getCell(6).value) || "QTab LTE";
    const descripcion = extractExcelCellText(row.getCell(7).value) || "Tablet Compac";
    const rawMarca = extractExcelCellText(row.getCell(8).value) || "Compac";
    const imei = extractExcelCellText(row.getCell(9).value);
    const numeroSerie = extractExcelCellText(row.getCell(10).value);
    const rawObs = extractExcelCellText(row.getCell(11).value);

    let marca = rawMarca;
    let estatusFisico = "BUENO";
    let tieneCargador = 1;
    let tieneCaja = 1;
    let observaciones = rawObs;

    if (/da[ñn]ad/i.test(rawMarca)) {
      marca = "Compac";
      estatusFisico = "DAÑADO";
      if (!observaciones) observaciones = "DAÑADA";
      else if (!/da[ñn]ad/i.test(observaciones)) observaciones = `${observaciones} — DAÑADA`;
    }

    const obsUp = observaciones.toUpperCase();
    if (obsUp.includes("NO TIENE CAJA NI CARGADOR")) {
      tieneCaja = 0;
      tieneCargador = 0;
      estatusFisico = "INCOMPLETO";
    } else if (obsUp.includes("SIN CARGADOR") || obsUp.includes("NO CARGADOR")) {
      tieneCargador = 0;
      if (estatusFisico === "BUENO") estatusFisico = "INCOMPLETO";
    }
    if (
      obsUp.includes("DAÑAD") ||
      obsUp.includes("DANAD") ||
      obsUp.includes("NO SIRVE") ||
      obsUp.includes("ESTRELLAD") ||
      obsUp.includes("NO FUNCIONA")
    ) {
      estatusFisico = "DAÑADO";
    }

    const isRedRow = RED_RESGUARDOS_TABLETAS.has(noResguardo);
    let region = "LA PAZ";
    let oficinaPrograma = "Delegación La Paz";
    let nombreResguardante = rawNombre;
    let sinResguardoPrevio = 0;
    let estadoAsignacion = "EN_RESGUARDO";

    if (isRedRow) {
      estadoAsignacion = "DISPONIBLE";
      sinResguardoPrevio = 1;
      region = "LA PAZ";
      oficinaPrograma = "Delegación La Paz";
      nombreResguardante = "";
      const refExcel = `Excel sin resguardo (${rawRegionProg || "N/D"}${rawNombre ? ` - ${rawNombre}` : ""})`;
      observaciones = observaciones ? `${observaciones} | ${refExcel}` : refExcel;
    } else {
      const mapped = mapExcelRegionProgramaTableta(rawRegionProg);
      region = mapped.region;
      oficinaPrograma = mapped.oficina_programa;
    }

    parsedRows.push([
      noResguardo,
      imei || `SIN-IMEI-${noResguardo}`,
      numeroSerie || `SIN-SERIE-${noResguardo}`,
      noCaja || null,
      marca,
      modelo,
      descripcion,
      region,
      oficinaPrograma,
      nombreResguardante,
      "Servidor de la nación",
      estatusFisico,
      tieneCargador,
      tieneCaja,
      observaciones || null,
      sinResguardoPrevio,
      estadoAsignacion,
    ]);
  });

  if (!parsedRows.length) return;

  const conn = await poolOps.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of parsedRows) {
      await conn.query(
        `INSERT INTO inventario_tabletas
           (no_resguardo, imei, numero_serie, no_caja, marca, modelo, descripcion,
            region, oficina_programa, nombre_resguardante, cargo_resguardante,
            estatus_fisico, tiene_cargador, tiene_caja, observaciones,
            sin_resguardo_previo, estado_asignacion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        r
      );
    }
    await conn.commit();
    console.log(`[v56] Semilla inventario_tabletas completada: ${parsedRows.length} tabletas cargadas.`);
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function generateNextTabletaFolio(conn) {
  const [[row]] = await conn.query(
    `SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM movimientos_tabletas`
  );
  const nextNum = Number(row?.next_id || 1);
  return String(nextNum).padStart(6, "0");
}

function renderTabletaFormatoPdf(req, res, { tableta, movimiento = null, modo = "ASIGNACION" }) {
  const isDevolucion = String(modo || "").toUpperCase() === "DEVOLUCION";
  const folioRaw = movimiento?.folio
    ? String(movimiento.folio).trim()
    : String(tableta?.no_resguardo || 1).padStart(6, "0");
  const folioStr = /^\d+$/.test(folioRaw) ? folioRaw.padStart(6, "0") : folioRaw;

  const fechaSource = movimiento?.created_at || new Date();
  const fmtDateMx = (dInput) => {
    const d = dInput instanceof Date ? dInput : new Date(dInput);
    if (isNaN(d.getTime())) {
      const now = new Date();
      return `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`;
    }
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  };
  const fechaStr = fmtDateMx(fechaSource);

  const regionVal = String(movimiento?.region || tableta?.region || "LA PAZ").trim();
  const oficinaVal = String(movimiento?.oficina_programa || tableta?.oficina_programa || "Delegación La Paz").trim();
  const nombrePersona = String(
    movimiento?.nombre_persona || tableta?.nombre_resguardante || "SIN NOMBRE ASIGNADO"
  ).trim();
  const cargoPersona = String(
    movimiento?.cargo_persona || tableta?.cargo_resguardante || "Servidor de la nación"
  ).trim();

  const tieneCargador = movimiento !== null
    ? Number(movimiento.tiene_cargador ?? 1) === 1
    : Number(tableta?.tiene_cargador ?? 1) === 1;
  const tieneCaja = movimiento !== null
    ? Number(movimiento.tiene_caja ?? 1) === 1
    : Number(tableta?.tiene_caja ?? 1) === 1;
  const estatusFisico = String(movimiento?.estatus_fisico || tableta?.estatus_fisico || "BUENO").trim();
  const observaciones = String(movimiento?.observaciones ?? tableta?.observaciones ?? "").trim();

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 24, left: 36, right: 36, bottom: 0 },
    bufferPages: true,
    info: {
      Title: `${isDevolucion ? "Vale de Devolución" : "Resguardo Personal"} Tableta #${tableta.no_resguardo}`,
      Author: "Delegación de Programas para el Desarrollo en Baja California Sur",
    },
  });

  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  doc.on("end", () => {
    const pdfBuf = Buffer.concat(chunks);
    const filenameSafe = isDevolucion
      ? `Vale_Devolucion_Tableta_${tableta.no_resguardo}_Folio_${folioStr}.pdf`
      : `Resguardo_Tableta_${tableta.no_resguardo}_Folio_${folioStr}.pdf`;
    savePdfBackup(pdfBuf, "vales_generados", filenameSafe);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filenameSafe}"`);
    res.send(pdfBuf);
  });

  const COLOR_PRIMARY = "#621132";
  const COLOR_ACCENT = "#B38E5D";
  const COLOR_SOFT_BG = "#F9F2F4";
  const leftX = 36;
  const rightLimit = 576;
  const contentWidth = rightLimit - leftX; // 540 pt
  const pageHeight = 792;

  const logoGobPath = [
    path.join(__dirname, "public", "LogoGobiernoMX.png"),
    path.join(__dirname, "public", "logoGobiernoMx.png"),
    path.join(__dirname, "public", "logoGobiernoMX.png"),
  ].find((p) => fs.existsSync(p)) || null;

  const logoBienPath = [
    path.join(__dirname, "public", "logo.png"),
    path.join(__dirname, "public", "logo.original.png"),
  ].find((p) => fs.existsSync(p)) || null;

  // 1. Encabezado institucional
  if (logoGobPath) {
    try {
      doc.image(logoGobPath, leftX, 20, { fit: [100, 34], align: "left", valign: "top" });
    } catch {}
  }
  if (logoBienPath) {
    try {
      doc.image(logoBienPath, rightLimit - 90, 20, { fit: [90, 34], align: "right", valign: "top" });
    } catch {}
  }

  doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(10.5)
    .text("SECRETARÍA DE BIENESTAR", leftX, 20, { width: contentWidth, align: "center", lineBreak: false });
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(8.5)
    .text("DELEGACIÓN DE PROGRAMAS PARA EL DESARROLLO EN BAJA CALIFORNIA SUR", leftX, 34, { width: contentWidth, align: "center", lineBreak: false });
  doc.fillColor("#4B5563").font("Helvetica-Bold").fontSize(8)
    .text("COORDINACIÓN DE RECURSOS MATERIALES", leftX, 46, { width: contentWidth, align: "center", lineBreak: false });

  doc.save();
  doc.moveTo(leftX, 60).lineTo(rightLimit, 60).lineWidth(1.5).strokeColor(COLOR_ACCENT).stroke();
  doc.restore();

  // Banner del título principal
  const bannerY = 66;
  const bannerTitle = isDevolucion
    ? "VALE DE DEVOLUCIÓN Y ENTREGA DE EQUIPO MÓVIL (TABLETA)"
    : "FORMATO DE RESGUARDO PERSONAL DE EQUIPO MÓVIL (TABLETA)";
  doc.save();
  doc.rect(leftX, bannerY, contentWidth, 20).fill(COLOR_PRIMARY);
  doc.restore();
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(9.5)
    .text(bannerTitle, leftX, bannerY + 5, { width: contentWidth, align: "center", lineBreak: false });

  // 2. Bloque de Datos Generales (Folio, Fecha, Región/Oficina, Persona, Cargo)
  const metaY = 92;
  const metaH = 54;
  doc.save();
  doc.rect(leftX, metaY, contentWidth, metaH).lineWidth(0.7).strokeColor(COLOR_PRIMARY).stroke();
  doc.moveTo(leftX, metaY + 18).lineTo(rightLimit, metaY + 18).lineWidth(0.5).strokeColor("#D1D5DB").stroke();
  doc.moveTo(leftX, metaY + 36).lineTo(rightLimit, metaY + 36).lineWidth(0.5).strokeColor("#D1D5DB").stroke();
  doc.moveTo(leftX + 365, metaY).lineTo(leftX + 365, metaY + 18).lineWidth(0.5).strokeColor("#D1D5DB").stroke();
  doc.moveTo(leftX + 365, metaY + 18).lineTo(leftX + 365, metaY + 36).lineWidth(0.5).strokeColor("#D1D5DB").stroke();
  doc.restore();

  // Fila 1 de metadatos: Región/Programa | FOLIO en rojo
  doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(7.5)
    .text("REGIÓN / OFICINA-PROGRAMA:", leftX + 6, metaY + 5, { lineBreak: false });
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(8)
    .text(`${regionVal} — ${oficinaVal}`, leftX + 132, metaY + 5, { width: 228, lineBreak: false });

  doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8)
    .text("FOLIO:", leftX + 372, metaY + 5, { lineBreak: false });
  doc.fillColor("#B91C1C").font("Helvetica-Bold").fontSize(10)
    .text(folioStr, leftX + 412, metaY + 4, { width: 120, align: "right", lineBreak: false });

  // Fila 2 de metadatos: Nombre de persona | Fecha
  const personaLabel = isDevolucion ? "QUIEN ENTREGA / DEVUELVE:" : "USUARIO RESGUARDANTE:";
  doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(7.5)
    .text(personaLabel, leftX + 6, metaY + 23, { lineBreak: false });
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(8.5)
    .text(nombrePersona.toUpperCase(), leftX + 132, metaY + 23, { width: 228, lineBreak: false });

  doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(7.5)
    .text("FECHA:", leftX + 372, metaY + 23, { lineBreak: false });
  doc.fillColor("#111827").font("Helvetica").fontSize(8.5)
    .text(fechaStr, leftX + 412, metaY + 23, { width: 120, align: "right", lineBreak: false });

  // Fila 3 de metadatos: Cargo y Caja
  doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(7.5)
    .text("CARGO / PUESTO:", leftX + 6, metaY + 41, { lineBreak: false });
  doc.fillColor("#111827").font("Helvetica").fontSize(8)
    .text(cargoPersona, leftX + 132, metaY + 41, { width: 240, lineBreak: false });
  doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(7.5)
    .text("NO. CAJA:", leftX + 372, metaY + 41, { lineBreak: false });
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(8)
    .text(String(tableta.no_caja || "S/N"), leftX + 425, metaY + 41, { width: 107, align: "right", lineBreak: false });

  // 3. Tabla del Bien (6 columnas exactas)
  const tblY = 154;
  const cols = [
    { label: "No. de Resguardo", w: 72, val: String(tableta.no_resguardo) },
    { label: "MODELO", w: 72, val: String(tableta.modelo || "QTab LTE") },
    { label: "DESCRIPCIÓN", w: 110, val: String(tableta.descripcion || "Tablet Compac") },
    { label: "MARCA", w: 66, val: String(tableta.marca || "Compac") },
    { label: "IMEI", w: 105, val: String(tableta.imei || "-") },
    { label: "NUMERO DE SERIE", w: 115, val: String(tableta.numero_serie || "-") },
  ];

  const tblHdrH = 20;
  const tblRowH = 24;
  const tblSubH = 18;

  doc.save();
  doc.rect(leftX, tblY, contentWidth, tblHdrH).fill(COLOR_PRIMARY);
  doc.restore();

  let curX = leftX;
  cols.forEach((c, idx) => {
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(7)
      .text(c.label, curX + 2, tblY + 6, { width: c.w - 4, align: "center", lineBreak: false });
    if (idx > 0) {
      doc.save();
      doc.moveTo(curX, tblY).lineTo(curX, tblY + tblHdrH + tblRowH).lineWidth(0.5).strokeColor("#9CA3AF").stroke();
      doc.restore();
    }
    curX += c.w;
  });

  doc.save();
  doc.rect(leftX, tblY, contentWidth, tblHdrH + tblRowH).lineWidth(0.8).strokeColor(COLOR_PRIMARY).stroke();
  doc.restore();

  curX = leftX;
  cols.forEach((c) => {
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(7.5)
      .text(c.val, curX + 3, tblY + tblHdrH + 7, { width: c.w - 6, align: "center", lineBreak: false });
    curX += c.w;
  });

  // Cintilla de accesorios y estado físico
  const subBarY = tblY + tblHdrH + tblRowH;
  doc.save();
  doc.rect(leftX, subBarY, contentWidth, tblSubH).fillAndStroke(COLOR_SOFT_BG, COLOR_PRIMARY);
  doc.restore();
  doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(7.3)
    .text(
      `INCLUYE CARGADOR: ${tieneCargador ? "SÍ" : "NO"}      |      INCLUYE CAJA ORIGINAL: ${tieneCaja ? "SÍ" : "NO"}      |      ESTADO FÍSICO: ${estatusFisico.toUpperCase()}`,
      leftX + 6,
      subBarY + 5,
      { width: contentWidth - 12, align: "center", lineBreak: false }
    );

  // 4. Cuerpo Central: Obligaciones (ASIGNACION) vs Estado de Devolución (DEVOLUCION)
  const bodyY = subBarY + tblSubH + 10;
  if (!isDevolucion) {
    doc.save();
    doc.rect(leftX, bodyY, contentWidth, 16).fill(COLOR_PRIMARY);
    doc.restore();
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8)
      .text("I. MANIFESTACIONES Y OBLIGACIONES", leftX + 8, bodyY + 4, { width: contentWidth - 16, lineBreak: false });

    const clausulas = [
      "a) Recibo de conformidad el equipo móvil (tableta) descrito en el presente resguardo, el cual es propiedad del Gobierno de México / Secretaría de Bienestar, asignado para el desempeño exclusivo de mis funciones oficiales.",
      "b) Me comprometo a mantener el equipo en óptimas condiciones de funcionamiento, haciendo uso adecuado y responsable del mismo, así como de su cargador, caja y accesorios entregados.",
      "c) Queda estrictamente prohibido instalar aplicaciones ajenas a la operación institucional, alterar el sistema operativo, retirar etiquetas o identificadores patrimoniales o prestar el equipo a terceros no autorizados.",
      "d) En caso de robo, extravío o daño total o parcial ocasionado por negligencia o mal uso, me obligo a reportarlo de inmediato a la Coordinación Operativa de Recursos Materiales y a levantar el acta correspondiente ante la autoridad competente, asumiendo la responsabilidad administrativa o resarcitoria que proceda.",
      "e) El equipo deberá presentarse para revisión física, inventario o actualización técnica cada vez que sea requerido por la Delegación Estatal, la Coordinación Operativa de Recursos Materiales o el Encargado de Almacén.",
      "f) Me obligo a devolver el equipo móvil junto con su caja y accesorios en el momento en que concluya mi comisión, cambie de adscripción, cause baja o me sea solicitado formalmente.",
      "g) Manifiesto haber verificado físicamente que el número de resguardo, marca, modelo, IMEI y número de serie coinciden fielmente con el equipo móvil que recibo en este acto.",
    ];

    const boxH = 290;
    doc.save();
    doc.rect(leftX, bodyY + 16, contentWidth, boxH).lineWidth(0.7).strokeColor(COLOR_PRIMARY).stroke();
    doc.restore();

    let textY = bodyY + 24;
    clausulas.forEach((cl) => {
      doc.fillColor("#1F2937").font("Helvetica").fontSize(7.6)
        .text(cl, leftX + 10, textY, { width: contentWidth - 20, align: "justify", lineGap: 1.5 });
      textY = doc.y + 7;
    });

    if (observaciones) {
      const obsBoxY = bodyY + 16 + boxH + 6;
      doc.save();
      doc.rect(leftX, obsBoxY, contentWidth, 34).fillAndStroke("#FFFBEB", "#D97706");
      doc.restore();
      doc.fillColor("#92400E").font("Helvetica-Bold").fontSize(7.2)
        .text("OBSERVACIONES DEL EQUIPO / RESGUARDO:", leftX + 8, obsBoxY + 5, { lineBreak: false });
      doc.fillColor("#111827").font("Helvetica").fontSize(7.4)
        .text(observaciones.slice(0, 240), leftX + 8, obsBoxY + 15, { width: contentWidth - 16, height: 16 });
    }
  } else {
    doc.save();
    doc.rect(leftX, bodyY, contentWidth, 16).fill(COLOR_PRIMARY);
    doc.restore();
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8)
      .text("ESTADO FÍSICO DE RECEPCIÓN Y VERIFICACIÓN DE ACCESORIOS", leftX + 8, bodyY + 4, { width: contentWidth - 16, lineBreak: false });

    const devBoxH = 250;
    doc.save();
    doc.rect(leftX, bodyY + 16, contentWidth, devBoxH).lineWidth(0.7).strokeColor(COLOR_PRIMARY).stroke();
    doc.restore();

    let dy = bodyY + 28;
    const checks = [
      ["1. ¿Entrega el equipo con cargador original/funcional?:", tieneCargador ? "SÍ — COMPLETO" : "NO — FALTANTE DE CARGADOR"],
      ["2. ¿Entrega el equipo con su caja original identificada?:", tieneCaja ? `SÍ — CAJA NO. ${tableta.no_caja || "S/N"}` : "NO — SIN CAJA"],
      ["3. Estado físico general observado al momento de la devolución:", estatusFisico.toUpperCase()],
      ["4. Origen / Región registrada del equipo devuelto:", `${regionVal} (${oficinaVal})`],
    ];
    checks.forEach(([qTxt, aTxt]) => {
      doc.fillColor("#374151").font("Helvetica-Bold").fontSize(8.2).text(qTxt, leftX + 14, dy, { width: 310, lineBreak: false });
      doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8.5).text(aTxt, leftX + 330, dy, { width: 196, align: "right", lineBreak: false });
      dy += 22;
    });

    dy += 6;
    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(8)
      .text("OBSERVACIONES / FALLAS O DETALLES REPORTADOS EN LA RECEPCIÓN:", leftX + 14, dy, { lineBreak: false });
    dy += 14;
    doc.save();
    doc.rect(leftX + 14, dy, contentWidth - 28, 66).lineWidth(0.5).strokeColor("#9CA3AF").stroke();
    doc.restore();
    doc.fillColor("#111827").font("Helvetica").fontSize(8.2)
      .text(observaciones || "Sin observaciones adicionales al momento de la devolución.", leftX + 20, dy + 8, {
        width: contentWidth - 40,
        height: 52,
      });

    dy += 78;
    doc.fillColor("#1F2937").font("Helvetica").fontSize(8)
      .text(
        "Por medio del presente vale se hace constar la entrega-recepción del equipo móvil descrito arriba para su resguardo, revisión física e ingreso al almacén de la Delegación de Programas para el Desarrollo en Baja California Sur. Una vez validada la recepción física en sistema, el equipo pasará a estatus DISPONIBLE.",
        leftX + 14,
        dy,
        { width: contentWidth - 28, align: "justify", lineGap: 2 }
      );
  }

  // 5. Bloque de 4 Firmas Oficiales al fondo de la misma página
  const topSigY = 588;
  const topSigW = 240;
  const topSigX = leftX + (contentWidth - topSigW) / 2;

  const drawSigBox = ({ x, y, w, h, titulo, nombre, cargo }) => {
    doc.save();
    doc.rect(x, y, w, h).lineWidth(0.6).strokeColor(COLOR_PRIMARY).stroke();
    doc.rect(x, y, w, 12).fillAndStroke(COLOR_SOFT_BG, COLOR_PRIMARY);
    doc.moveTo(x + 10, y + h - 22).lineTo(x + w - 10, y + h - 22).lineWidth(0.5).strokeColor("#111827").stroke();
    doc.restore();

    doc.fillColor(COLOR_PRIMARY).font("Helvetica-Bold").fontSize(6.8)
      .text(titulo, x + 2, y + 3, { width: w - 4, align: "center", lineBreak: false });
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(6.6)
      .text(nombre, x + 4, y + h - 19, { width: w - 8, align: "center", lineBreak: false });
    doc.fillColor("#4B5563").font("Helvetica").fontSize(5.7)
      .text(cargo, x + 4, y + h - 10, { width: w - 8, align: "center", lineBreak: false });
  };

  // Firma Superior Central (AUTORIZA)
  drawSigBox({
    x: topSigX,
    y: topSigY,
    w: topSigW,
    h: 56,
    titulo: "AUTORIZA",
    nombre: "Diphna Yanssen Weichselbaum Calderón",
    cargo: "Delegada de Programas para el Desarrollo en el Estado de BCS",
  });

  // Fila Inferior de 3 Columnas
  const botSigY = 656;
  const botGap = 12;
  const botSigW = (contentWidth - botGap * 2) / 3; // 172 pt cada caja
  const botSigH = 62;

  drawSigBox({
    x: leftX,
    y: botSigY,
    w: botSigW,
    h: botSigH,
    titulo: isDevolucion ? "ENTREGA / DEVUELVE" : "RECIBE DE CONFORMIDAD",
    nombre: nombrePersona,
    cargo: cargoPersona || "Servidor de la nación",
  });

  // Incrustar firma digital remota en Vale de Devolución firmado (estrictamente en 1 sola página)
  if (
    isDevolucion &&
    String(movimiento?.estado_firma || "").toUpperCase() === "FIRMADO" &&
    movimiento?.firma_devolucion_data
  ) {
    try {
      const rawSig = String(movimiento.firma_devolucion_data).trim();
      const b64Match = rawSig.match(/^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/i);
      if (b64Match && b64Match[1]) {
        const sigBuf = Buffer.from(b64Match[1].replace(/\s+/g, ""), "base64");
        doc.image(sigBuf, leftX + 10, botSigY + 13, {
          fit: [botSigW - 20, 26],
          align: "center",
          valign: "center",
        });
      }
      const dFirma = movimiento.fecha_firma_digital ? new Date(movimiento.fecha_firma_digital) : new Date();
      const fechaFirmaTxt = isNaN(dFirma.getTime())
        ? fechaStr
        : `${String(dFirma.getDate()).padStart(2, "0")}/${String(dFirma.getMonth() + 1).padStart(2, "0")}/${dFirma.getFullYear()} ${String(dFirma.getHours()).padStart(2, "0")}:${String(dFirma.getMinutes()).padStart(2, "0")}`;
      const selloTxt = String(movimiento.folio_firma_digital || "").trim();
      doc.fillColor("#166534").font("Helvetica-Bold").fontSize(6)
        .text(
          `Firmado digitalmente el ${fechaFirmaTxt} - Sello: ${selloTxt}`,
          leftX,
          botSigY + botSigH + 4,
          { width: contentWidth, align: "left", lineBreak: false }
        );
    } catch (errSigPdf) {
      console.warn("[WARN] Error incrustando firma digital en PDF de devolución:", errSigPdf?.message || errSigPdf);
    }
  }

  drawSigBox({
    x: leftX + botSigW + botGap,
    y: botSigY,
    w: botSigW,
    h: botSigH,
    titulo: "VALIDA",
    nombre: "Jorge Luis Patrón Murillo",
    cargo: "Coordinador Operativo de Recursos Materiales",
  });

  drawSigBox({
    x: leftX + (botSigW + botGap) * 2,
    y: botSigY,
    w: botSigW,
    h: botSigH,
    titulo: isDevolucion ? "RECIBE EN ALMACÉN" : "ENTREGA",
    nombre: "Luis Eduardo Mayoral Geraldo",
    cargo: "Encargado de Almacén",
  });

  // Pie de página único en 1 hoja (sin desbordamiento)
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.fillColor("#6B7280").font("Helvetica").fontSize(7)
      .text(
        `Folio: ${folioStr}   |   Hoja ${i + 1} de ${pages.count}   |   Delegación de Programas para el Desarrollo en Baja California Sur`,
        leftX,
        pageHeight - 28,
        { width: contentWidth, align: "center", lineBreak: false }
      );
  }

  doc.end();
}

// 1. GET /api/tabletas — Listado con filtros y KPIs globales
app.get("/api/tabletas", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    if (!canViewTabletas(req)) {
      return httpError(res, 403, "Acceso exclusivo para Luis Eduardo Mayoral Geraldo, Recursos Materiales (Jorge Patrón / Rodrigo Molina) y Administración.");
    }

    const { estado_asignacion = "", region = "", oficina_programa = "", q = "", filtro_extra = "" } = req.query || {};

    const [kpiRows] = await poolRead.query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN t.estado_asignacion = 'EN_RESGUARDO' THEN 1 ELSE 0 END) AS en_resguardo,
        SUM(CASE WHEN t.estado_asignacion = 'DEVOLUCION_PENDIENTE' THEN 1 ELSE 0 END) AS devolucion_pendiente,
        SUM(CASE WHEN t.estado_asignacion = 'DISPONIBLE' THEN 1 ELSE 0 END) AS disponibles,
        SUM(CASE WHEN t.estado_asignacion = 'EN_PRESTAMO_PROVISIONAL' AND EXISTS (
          SELECT 1
          FROM vales_prestamo_detalle vpd
          INNER JOIN vales_prestamo vp ON vp.id = vpd.vale_id
          WHERE (vpd.tableta_id = t.id OR vpd.articulo_id = t.id)
            AND vp.rubro_id = 4
            AND vp.estado IN ('PENDIENTE', 'AUTORIZADO_EN_PRESTAMO', 'EN_PRESTAMO')
            AND COALESCE(vpd.estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')
        ) THEN 1 ELSE 0 END) AS en_prestamo_provisional,
        SUM(CASE WHEN t.estado_asignacion = 'EN_RESGUARDO' AND (TRIM(COALESCE(t.nombre_resguardante, '')) = '' OR UPPER(TRIM(t.nombre_resguardante)) = 'RESGUARDO FISICO') THEN 1 ELSE 0 END) AS sin_nombre
      FROM inventario_tabletas t
    `);
    const kpis = {
      total: Number(kpiRows[0]?.total || 0),
      en_resguardo: Number(kpiRows[0]?.en_resguardo || 0),
      devolucion_pendiente: Number(kpiRows[0]?.devolucion_pendiente || 0),
      disponibles: Number(kpiRows[0]?.disponibles || 0),
      en_prestamo_provisional: Number(kpiRows[0]?.en_prestamo_provisional || 0),
      sin_nombre: Number(kpiRows[0]?.sin_nombre || 0),
    };

    let where = "WHERE 1=1";
    const params = [];

    if (estado_asignacion && String(estado_asignacion).trim() !== "") {
      const st = String(estado_asignacion).trim().toUpperCase();
      if (st === "EN_PRESTAMO_PROVISIONAL") {
        where += ` AND t.estado_asignacion = 'EN_PRESTAMO_PROVISIONAL'
                   AND EXISTS (
                     SELECT 1
                     FROM vales_prestamo_detalle vpd
                     INNER JOIN vales_prestamo vp ON vp.id = vpd.vale_id
                     WHERE (vpd.tableta_id = t.id OR vpd.articulo_id = t.id)
                       AND vp.rubro_id = 4
                       AND vp.estado IN ('PENDIENTE', 'AUTORIZADO_EN_PRESTAMO', 'EN_PRESTAMO')
                       AND COALESCE(vpd.estado_devolucion, 'PENDIENTE') NOT IN ('DEVUELTO', 'CANCELADO')
                   )`;
      } else {
        where += " AND t.estado_asignacion = ?";
        params.push(st);
      }
    }
    if (region && String(region).trim() !== "") {
      where += " AND t.region = ?";
      params.push(String(region).trim().toUpperCase());
    }
    if (oficina_programa && String(oficina_programa).trim() !== "") {
      where += " AND t.oficina_programa = ?";
      params.push(String(oficina_programa).trim());
    }
    if (filtro_extra === "SIN_NOMBRE") {
      where += " AND (TRIM(COALESCE(t.nombre_resguardante, '')) = '' OR UPPER(TRIM(t.nombre_resguardante)) IN ('RESGUARDO FISICO', 'NO TIENE TABLETA', 'DELEGACION'))";
    } else if (filtro_extra === "CON_NOMBRE") {
      where += " AND TRIM(COALESCE(t.nombre_resguardante, '')) <> '' AND UPPER(TRIM(t.nombre_resguardante)) NOT IN ('RESGUARDO FISICO', 'NO TIENE TABLETA', 'DELEGACION')";
    } else if (filtro_extra === "DANADAS_INCOMPLETAS") {
      where += " AND (t.estatus_fisico IN ('DAÑADO', 'INCOMPLETO') OR t.tiene_cargador = 0 OR t.tiene_caja = 0)";
    }
    if (q && String(q).trim() !== "") {
      const lk = `%${String(q).trim()}%`;
      where += ` AND (
        CAST(t.no_resguardo AS CHAR) LIKE ? OR
        t.imei LIKE ? OR
        t.numero_serie LIKE ? OR
        t.nombre_resguardante LIKE ? OR
        t.no_caja LIKE ? OR
        t.oficina_programa LIKE ? OR
        t.observaciones LIKE ?
      )`;
      params.push(lk, lk, lk, lk, lk, lk, lk);
    }

    const [rows] = await poolRead.query(
      `SELECT t.*,
              mp.id AS devolucion_mov_id,
              mp.folio AS devolucion_folio,
              mp.nombre_persona AS devolucion_nombre_persona,
              mp.cargo_persona AS devolucion_cargo_persona,
              mp.created_at AS devolucion_fecha,
              COALESCE(mp.estado_firma, 'NO_APLICA') AS devolucion_estado_firma,
              mp.region_firma_destino AS devolucion_region_firma,
              mp.fecha_firma_digital AS devolucion_fecha_firma,
              mp.folio_firma_digital AS devolucion_folio_firma,
              mp.motivo_rechazo_region AS devolucion_motivo_rechazo,
              (mp.firma_devolucion_data IS NOT NULL) AS devolucion_tiene_firma,
              ma.id AS ultimo_asig_mov_id,
              ma.folio AS ultimo_asig_folio,
              CASE WHEN ma.foto_ine_frente IS NOT NULL AND ma.foto_ine_reverso IS NOT NULL AND ma.foto_entrega IS NOT NULL THEN 1 ELSE 0 END AS tiene_evidencias,
              CASE WHEN ma.foto_ine_frente IS NOT NULL AND ma.foto_ine_reverso IS NOT NULL AND ma.foto_entrega IS NOT NULL THEN ma.id ELSE NULL END AS evidencias_mov_id
       FROM inventario_tabletas t
       LEFT JOIN movimientos_tabletas mp
         ON mp.id = (
           SELECT m1.id FROM movimientos_tabletas m1
           WHERE m1.tableta_id = t.id AND m1.tipo = 'DEVOLUCION' AND m1.estado = 'EN_PROCESO'
           ORDER BY m1.id DESC LIMIT 1
         )
       LEFT JOIN movimientos_tabletas ma
         ON ma.id = COALESCE(
           t.ultimo_movimiento_asignacion_id,
           (
             SELECT m2.id FROM movimientos_tabletas m2
             WHERE m2.tableta_id = t.id AND m2.tipo = 'ASIGNACION' AND m2.estado = 'CONFIRMADO'
             ORDER BY m2.id DESC LIMIT 1
           )
         )
       ${where}
       ORDER BY t.no_resguardo ASC`,
      params
    );

    return res.json({ ok: true, kpis, data: rows });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al listar inventario de tabletas");
  }
});

// 1B. GET /api/tabletas/bitacora — Log de movimientos de tabletas (Permite canViewTabletas: Admin, Luis Eduardo, Jorge y Rodrigo)
app.get("/api/tabletas/bitacora", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    if (!canViewTabletas(req)) {
      return httpError(res, 403, "No tienes permiso para consultar la bitácora de tabletas.");
    }
    const q = String(req.query?.q || "").trim();
    const accion = String(req.query?.accion || "").trim().toUpperCase();
    const usuario = String(req.query?.usuario || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 200, 1), 1000);

    let where = "WHERE 1=1";
    const params = [];
    if (accion) {
      where += " AND b.accion = ?";
      params.push(accion);
    }
    if (usuario) {
      where += " AND b.usuario LIKE ?";
      params.push(`%${usuario}%`);
    }
    if (q) {
      where += " AND (CAST(b.no_resguardo AS CHAR) LIKE ? OR b.imei LIKE ? OR b.numero_serie LIKE ? OR b.usuario LIKE ? OR b.detalles LIKE ?)";
      const lk = `%${q}%`;
      params.push(lk, lk, lk, lk, lk);
    }

    const [rows] = await poolRead.query(
      `SELECT b.id, b.tableta_id, b.no_resguardo, b.imei, b.numero_serie, b.usuario, b.accion, b.detalles, b.created_at,
              CASE WHEN b.accion = 'ASIGNAR_RESGUARDO' THEN (
                SELECT m.id FROM movimientos_tabletas m
                WHERE m.tableta_id = b.tableta_id
                  AND m.tipo = 'ASIGNACION'
                  AND m.foto_ine_frente IS NOT NULL
                  AND m.foto_ine_reverso IS NOT NULL
                  AND m.foto_entrega IS NOT NULL
                  AND (b.detalles LIKE CONCAT('%Folio ', m.folio, '%') OR m.created_at <= DATE_ADD(b.created_at, INTERVAL 1 MINUTE))
                ORDER BY (b.detalles LIKE CONCAT('%Folio ', m.folio, '%')) DESC, m.id DESC
                LIMIT 1
              ) ELSE NULL END AS evidencias_mov_id
       FROM bitacora_tabletas b
       ${where}
       ORDER BY b.id DESC
       LIMIT ?`,
      [...params, limit]
    );
    const enriched = (rows || []).map((r) => ({
      ...r,
      tiene_evidencias: Boolean(r.evidencias_mov_id),
    }));
    return res.json({ ok: true, data: enriched });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al consultar la bitácora de tabletas");
  }
});

// ============================================================================
// BLOQUE 2: FIRMA DIGITAL REMOTA DE DEVOLUCIONES DE TABLETAS (REGIONES FORÁNEAS)
// ============================================================================

// GET /api/tabletas/devoluciones/badge — Polling ultraligero cada 60s
app.get("/api/tabletas/devoluciones/badge", authRequired, async (req, res) => {
  try {
    const regScope = getRegionalSignatureScope(req.user);
    const isLuisOrAdmin = canEditTabletas(req);
    if (!regScope && !isLuisOrAdmin) {
      return res.json({ ok: true, total: 0, pendientes: 0, firmadas: 0, rechazadas: 0 });
    }
    await ensureSchemaAndUsers();

    if (regScope) {
      const [[row]] = await poolRead.query(
        `SELECT COUNT(*) AS pendientes
         FROM movimientos_tabletas
         WHERE region_firma_destino = ?
           AND estado_firma = 'PENDIENTE_FIRMA'
           AND estado = 'EN_PROCESO'`,
        [regScope]
      );
      const pendientes = Number(row?.pendientes || 0);
      return res.json({
        ok: true,
        scope: "regional",
        region: regScope,
        pendientes,
        total: pendientes,
      });
    }

    const [[row]] = await poolRead.query(
      `SELECT
         COALESCE(SUM(CASE WHEN m.estado_firma = 'FIRMADO' THEN 1 ELSE 0 END), 0) AS firmadas,
         COALESCE(SUM(CASE WHEN m.estado_firma = 'RECHAZADO' THEN 1 ELSE 0 END), 0) AS rechazadas,
         COALESCE(SUM(CASE WHEN m.estado_firma = 'PENDIENTE_FIRMA' THEN 1 ELSE 0 END), 0) AS pendientes_firma
       FROM movimientos_tabletas m
       INNER JOIN inventario_tabletas t ON t.id = m.tableta_id
       WHERE m.tipo = 'DEVOLUCION'
         AND m.estado = 'EN_PROCESO'
         AND t.estado_asignacion = 'DEVOLUCION_PENDIENTE'`
    );
    const firmadas = Number(row?.firmadas || 0);
    const rechazadas = Number(row?.rechazadas || 0);
    const pendientesFirma = Number(row?.pendientes_firma || 0);
    return res.json({
      ok: true,
      scope: "almacen",
      firmadas,
      rechazadas,
      pendientes_firma: pendientesFirma,
      pendientes: isAdmin(req) ? pendientesFirma : 0,
      total: firmadas + rechazadas,
    });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al consultar alertas de tabletas");
  }
});

// GET /api/tabletas/devoluciones/pendientes-firma — Listado para cuentas regionales (y admin en consulta)
app.get("/api/tabletas/devoluciones/pendientes-firma", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    const regScope = getRegionalSignatureScope(req.user);
    const admin = isAdmin(req);
    if (!regScope && !admin) {
      return httpError(res, 403, "Acceso exclusivo para enlaces regionales (Los Cabos, Mulegé, Comondú) o Administración.");
    }

    // Anti-IDOR estricto: para usuarios regionales la región proviene SIEMPRE de la sesión, jamás de query params.
    let where = "WHERE m.tipo = 'DEVOLUCION' AND m.estado = 'EN_PROCESO' AND m.estado_firma = 'PENDIENTE_FIRMA'";
    const params = [];
    if (regScope) {
      where += " AND m.region_firma_destino = ?";
      params.push(regScope);
    }

    // CRÍTICO NAS: NUNCA seleccionar firma_devolucion_data en endpoints de listado
    const [rows] = await poolRead.query(
      `SELECT
         m.id AS movimiento_id,
         m.folio,
         m.tableta_id,
         m.no_resguardo,
         m.nombre_persona AS nombre_resguardante,
         m.cargo_persona AS cargo_resguardante,
         t.no_caja,
         t.marca,
         t.modelo,
         t.descripcion,
         t.imei,
         t.numero_serie,
         m.tiene_cargador,
         m.tiene_caja,
         m.estatus_fisico,
         m.observaciones,
         m.region_firma_destino,
         m.oficina_programa,
         m.estado_firma,
         m.created_at AS fecha_movimiento,
         (m.firma_devolucion_data IS NOT NULL) AS tiene_firma
       FROM movimientos_tabletas m
       INNER JOIN inventario_tabletas t ON t.id = m.tableta_id
       ${where}
       ORDER BY m.created_at DESC, m.id DESC`,
      params
    );

    return res.json({
      ok: true,
      region_scope: regScope || "TODAS (CONSULTA ADMIN)",
      can_sign: Boolean(regScope),
      data: rows,
    });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al consultar devoluciones pendientes de firma");
  }
});

// POST /api/tabletas/devoluciones/:movimientoId/firmar — Firma digital remota (Solo loscabos, mulege, comondu)
app.post("/api/tabletas/devoluciones/:movimientoId/firmar", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    const regScope = getRegionalSignatureScope(req.user);
    if (!regScope) {
      return httpError(res, 403, "Solo las cuentas regionales autorizadas (Los Cabos, Mulegé, Comondú) pueden firmar devoluciones remotas.");
    }
    const movId = Number(req.params.movimientoId);
    if (!Number.isInteger(movId) || movId <= 0) {
      return httpError(res, 400, "ID de movimiento inválido.");
    }

    const firmaData = String(req.body?.firma_data || "").trim();
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/i.test(firmaData)) {
      return httpError(res, 400, "Firma digital inválida. Debe enviarse en formato PNG Base64 (data:image/png;base64,...).");
    }
    if (Buffer.byteLength(firmaData, "utf8") > 153600) {
      return httpError(res, 400, "La firma digital excede el tamaño máximo permitido de 150 KB.");
    }

    const conn = await poolOps.getConnection();
    let movRow = null;
    let folioFirma = "";
    try {
      await conn.beginTransaction();
      const [[mov]] = await conn.query(
        `SELECT id, tipo, folio, tableta_id, no_resguardo, estado, estado_firma, region_firma_destino, nombre_persona
         FROM movimientos_tabletas
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [movId]
      );
      if (!mov) {
        await conn.rollback();
        return httpError(res, 404, "Movimiento de devolución no encontrado.");
      }
      if (String(mov.region_firma_destino || "").toUpperCase() !== regScope) {
        await conn.rollback();
        return httpError(res, 403, "Forbidden: Esta devolución no corresponde a tu región.");
      }
      if (mov.tipo !== "DEVOLUCION" || mov.estado !== "EN_PROCESO" || mov.estado_firma !== "PENDIENTE_FIRMA") {
        await conn.rollback();
        return httpError(res, 409, `Esta devolución ya no está pendiente de firma (estado actual: ${mov.estado_firma || mov.estado}).`);
      }

      const year = new Date().getFullYear();
      folioFirma = `DEV-TAB-${year}-${String(mov.id).padStart(4, "0")}`;
      movRow = mov;

      // La tableta NO pasa a DISPONIBLE; permanece en DEVOLUCION_PENDIENTE hasta confirmación física en La Paz
      await conn.query(
        `UPDATE movimientos_tabletas
         SET estado_firma = 'FIRMADO',
             firma_devolucion_data = ?,
             fecha_firma_digital = NOW(),
             folio_firma_digital = ?,
             firmado_por_usuario_id = ?
         WHERE id = ?`,
        [firmaData, folioFirma, Number(req.user?.id || 0) || null, mov.id]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    await registrarBitacora(
      req,
      "TABLETAS",
      "FIRMAR_DEVOLUCION_REMOTA",
      `Devolución Folio ${movRow.folio} de Tableta #${movRow.no_resguardo} firmada digitalmente desde región ${regScope} (Sello: ${folioFirma}).`
    );
    await registrarBitacoraTableta(req, {
      tableta_id: movRow.tableta_id,
      no_resguardo: movRow.no_resguardo,
      accion: "FIRMAR_DEVOLUCION_REMOTA",
      detalles: `Firmada digitalmente por región ${regScope} (Folio ${movRow.folio}, Sello ${folioFirma}). Pendiente de recepción física en almacén.`
    });

    return res.json({
      ok: true,
      movimiento_id: movRow.id,
      folio_firma_digital: folioFirma,
      message: `Devolución firmada digitalmente con éxito (Sello: ${folioFirma}). El equipo queda listo para recepción física en almacén.`,
    });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al registrar la firma digital de devolución");
  }
});

// POST /api/tabletas/devoluciones/:movimientoId/rechazar — Reportar error desde región (Solo loscabos, mulege, comondu)
app.post("/api/tabletas/devoluciones/:movimientoId/rechazar", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    const regScope = getRegionalSignatureScope(req.user);
    if (!regScope) {
      return httpError(res, 403, "Solo las cuentas regionales autorizadas (Los Cabos, Mulegé, Comondú) pueden reportar errores en devoluciones.");
    }
    const movId = Number(req.params.movimientoId);
    if (!Number.isInteger(movId) || movId <= 0) {
      return httpError(res, 400, "ID de movimiento inválido.");
    }
    const motivo = String(req.body?.motivo || "").trim();
    if (!motivo) {
      return httpError(res, 400, "Debes describir el motivo del error o corrección requerida.");
    }
    if (motivo.length > 250) {
      return httpError(res, 400, "El motivo no puede exceder 250 caracteres.");
    }

    const conn = await poolOps.getConnection();
    let movRow = null;
    try {
      await conn.beginTransaction();
      const [[mov]] = await conn.query(
        `SELECT id, tipo, folio, tableta_id, no_resguardo, estado, estado_firma, region_firma_destino
         FROM movimientos_tabletas
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [movId]
      );
      if (!mov) {
        await conn.rollback();
        return httpError(res, 404, "Movimiento de devolución no encontrado.");
      }
      if (String(mov.region_firma_destino || "").toUpperCase() !== regScope) {
        await conn.rollback();
        return httpError(res, 403, "Forbidden: Esta devolución no corresponde a tu región.");
      }
      if (mov.tipo !== "DEVOLUCION" || mov.estado !== "EN_PROCESO" || mov.estado_firma !== "PENDIENTE_FIRMA") {
        await conn.rollback();
        return httpError(res, 409, `Esta devolución ya no está pendiente de firma (estado actual: ${mov.estado_firma || mov.estado}).`);
      }

      movRow = mov;
      await conn.query(
        `UPDATE movimientos_tabletas
         SET estado_firma = 'RECHAZADO',
             motivo_rechazo_region = ?
         WHERE id = ?`,
        [motivo, mov.id]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    await registrarBitacora(
      req,
      "TABLETAS",
      "RECHAZAR_DEVOLUCION_REMOTA",
      `Región ${regScope} reportó error en devolución Folio ${movRow.folio} de Tableta #${movRow.no_resguardo}: ${motivo}`
    );
    await registrarBitacoraTableta(req, {
      tableta_id: movRow.tableta_id,
      no_resguardo: movRow.no_resguardo,
      accion: "RECHAZAR_DEVOLUCION_REMOTA",
      detalles: `Rechazada por región ${regScope} (Folio ${movRow.folio}). Motivo: ${motivo}`
    });

    return res.json({
      ok: true,
      movimiento_id: movRow.id,
      message: "Reporte enviado al encargado de tabletas para corrección.",
    });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al reportar error en devolución");
  }
});

// POST /api/tabletas/devoluciones/:movimientoId/cancelar — Cancelar devolución remota (Solo Luis Eduardo y Admin)
app.post("/api/tabletas/devoluciones/:movimientoId/cancelar", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    if (!canEditTabletas(req)) {
      return httpError(res, 403, "Solo el encargado de tabletas o Administración puede cancelar solicitudes de devolución.");
    }
    const movId = Number(req.params.movimientoId);
    if (!Number.isInteger(movId) || movId <= 0) {
      return httpError(res, 400, "ID de movimiento inválido.");
    }

    const conn = await poolOps.getConnection();
    let movRow = null;
    try {
      await conn.beginTransaction();
      const [[mov]] = await conn.query(
        `SELECT id, tipo, folio, tableta_id, no_resguardo, estado, estado_firma, region_firma_destino
         FROM movimientos_tabletas
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [movId]
      );
      if (!mov) {
        await conn.rollback();
        return httpError(res, 404, "Movimiento de devolución no encontrado.");
      }
      if (mov.tipo !== "DEVOLUCION" || !["PENDIENTE_FIRMA", "RECHAZADO"].includes(String(mov.estado_firma || "").toUpperCase())) {
        await conn.rollback();
        return httpError(res, 409, `Solo se pueden cancelar solicitudes en estado PENDIENTE_FIRMA o RECHAZADO (estado actual: ${mov.estado_firma || mov.estado}).`);
      }

      movRow = mov;
      await conn.query(
        `UPDATE movimientos_tabletas
         SET estado = 'CANCELADO',
             estado_firma = 'CANCELADO'
         WHERE id = ?`,
        [mov.id]
      );

      // Regresa la tableta a EN_RESGUARDO sin borrar región, oficina ni resguardante
      await conn.query(
        `UPDATE inventario_tabletas
         SET estado_asignacion = 'EN_RESGUARDO'
         WHERE id = ?`,
        [mov.tableta_id]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    await registrarBitacora(
      req,
      "TABLETAS",
      "CANCELAR_DEVOLUCION_REMOTA",
      `Solicitud de devolución Folio ${movRow.folio} de Tableta #${movRow.no_resguardo} cancelada. Equipo regresado a EN_RESGUARDO.`
    );
    await registrarBitacoraTableta(req, {
      tableta_id: movRow.tableta_id,
      no_resguardo: movRow.no_resguardo,
      accion: "CANCELAR_DEVOLUCION_REMOTA",
      detalles: `Devolución Folio ${movRow.folio} cancelada. Tableta regresada a EN_RESGUARDO.`
    });

    return res.json({
      ok: true,
      movimiento_id: movRow.id,
      message: `Solicitud de devolución cancelada. La Tableta #${movRow.no_resguardo} regresó a En Resguardo.`,
    });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al cancelar solicitud de devolución");
  }
});

// ============================================================================
// BLOQUE 3: CONSULTA SEGURA DE EVIDENCIAS FOTOGRÁFICAS (3 FOTOS)
// ============================================================================
app.get("/api/tabletas/evidencias/:movimientoId/:tipo", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    if (!canViewTabletas(req)) {
      return httpError(res, 403, "Acceso exclusivo para Luis Eduardo Mayoral Geraldo, Recursos Materiales (Jorge Patrón / Rodrigo Molina) y Administración.");
    }
    const movId = Number(req.params.movimientoId);
    if (!Number.isInteger(movId) || movId <= 0) {
      return httpError(res, 400, "ID de movimiento inválido.");
    }
    const tipo = String(req.params.tipo || "").trim().toLowerCase();
    const tipoColMap = {
      ine_frente: "foto_ine_frente",
      ine_reverso: "foto_ine_reverso",
      entrega: "foto_entrega",
    };
    const colName = tipoColMap[tipo];
    if (!colName) {
      return httpError(res, 400, "Tipo de evidencia inválido. Valores permitidos: ine_frente, ine_reverso, entrega.");
    }

    const [[mov]] = await poolRead.query(
      `SELECT id, ${qi(colName)} AS filename FROM movimientos_tabletas WHERE id = ? LIMIT 1`,
      [movId]
    );
    if (!mov || !mov.filename) {
      return httpError(res, 404, "Evidencia fotográfica no encontrada para este movimiento.");
    }

    const safeFile = path.basename(String(mov.filename).trim());
    const baseDir = path.resolve(TABLETAS_EVIDENCIAS_DIR);
    const fullPath = path.resolve(baseDir, safeFile);
    if (!fullPath.startsWith(baseDir + path.sep) || !fs.existsSync(fullPath)) {
      return httpError(res, 404, "El archivo de evidencia no existe en el almacenamiento.");
    }

    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.sendFile(fullPath);
  } catch (e) {
    return httpError(res, 500, e.message || "Error al consultar evidencia fotográfica");
  }
});

async function registrarBitacoraTableta(req, { tableta_id = null, no_resguardo = null, imei = null, numero_serie = null, accion, detalles = "" }) {
  try {
    const usuario = req?.user?.username || req?.user?.nombre || "SISTEMA";
    let tabId = tableta_id ? Number(tableta_id) : null;
    let resg = no_resguardo !== null && no_resguardo !== undefined ? Number(no_resguardo) : null;
    let imeiVal = imei ? String(imei).trim() : null;
    let serieVal = numero_serie ? String(numero_serie).trim() : null;

    if (tabId && (!imeiVal || !serieVal || !resg)) {
      const [[row]] = await poolRead.query(
        `SELECT no_resguardo, imei, numero_serie FROM inventario_tabletas WHERE id = ? LIMIT 1`,
        [tabId]
      ).catch(() => [[]]);
      if (row) {
        if (!resg) resg = Number(row.no_resguardo || 0) || null;
        if (!imeiVal) imeiVal = row.imei || null;
        if (!serieVal) serieVal = row.numero_serie || null;
      }
    }

    await poolOps.query(
      `INSERT INTO bitacora_tabletas (tableta_id, no_resguardo, imei, numero_serie, usuario, accion, detalles)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tabId, resg, imeiVal, serieVal, String(usuario).slice(0, 80), String(accion).slice(0, 50), String(detalles || "")]
    );
  } catch (err) {
    console.warn("[WARN] registrarBitacoraTableta:", err?.message || err);
  }
}

// 1C. POST /api/tabletas — Alta de nueva tableta / activo en inventario_tabletas (Exclusivo Admin y Luis Eduardo)
app.post("/api/tabletas", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    if (!canEditTabletas(req)) {
      return httpError(res, 403, "No tienes permiso para dar de alta nuevas tabletas.");
    }

    const b = req.body || {};
    const imei = String(b.imei || "").trim();
    const numeroSerie = String(b.numero_serie || b.serie || "").trim();
    if (!imei || !numeroSerie) {
      return httpError(res, 400, "El Número de Serie y el IMEI son obligatorios para registrar una nueva tableta.");
    }

    let noResguardo = b.no_resguardo !== undefined && b.no_resguardo !== null && String(b.no_resguardo).trim() !== ""
      ? parseInt(b.no_resguardo, 10)
      : NaN;

    if (!Number.isInteger(noResguardo) || noResguardo <= 0) {
      const [[maxRow]] = await poolRead.query(`SELECT COALESCE(MAX(no_resguardo), 0) + 1 AS next_resg FROM inventario_tabletas`);
      noResguardo = Number(maxRow?.next_resg || 1);
    }

    // Validación estricta de duplicados (no_resguardo, imei, numero_serie)
    const [dups] = await poolRead.query(
      `SELECT id, no_resguardo, imei, numero_serie
       FROM inventario_tabletas
       WHERE no_resguardo = ? OR UPPER(TRIM(imei)) = UPPER(?) OR UPPER(TRIM(numero_serie)) = UPPER(?)
       LIMIT 1`,
      [noResguardo, imei, numeroSerie]
    );
    if (dups.length) {
      const d = dups[0];
      if (Number(d.no_resguardo) === noResguardo) {
        return httpError(res, 409, `⚠️ El No. de Resguardo / Código #${noResguardo} ya pertenece a otra tableta.`);
      }
      if (String(d.imei || "").trim().toUpperCase() === imei.toUpperCase()) {
        return httpError(res, 409, `⚠️ El IMEI "${imei}" ya está registrado en la tableta #${d.no_resguardo}.`);
      }
      return httpError(res, 409, `⚠️ El Número de Serie "${numeroSerie}" ya está registrado en la tableta #${d.no_resguardo}.`);
    }

    const { region, oficina_programa } = normalizeTabletaRegionInput(
      b.region || "LA PAZ",
      b.oficina_programa || "Delegación La Paz"
    );
    const noCaja = String(b.no_caja || "").trim() || null;
    const marca = String(b.marca || "Compac").trim() || "Compac";
    const modelo = String(b.modelo || "QTab LTE").trim() || "QTab LTE";
    const descripcion = String(b.descripcion || `Tablet ${marca}`).trim() || "Tablet Compac";
    const rawEstadoAsig = String(b.estado_asignacion || b.estatus || "DISPONIBLE").trim().toUpperCase();
    const estadoAsignacion = ["DISPONIBLE", "EN_RESGUARDO", "DEVOLUCION_PENDIENTE", "EN_PRESTAMO_PROVISIONAL"].includes(rawEstadoAsig)
      ? rawEstadoAsig
      : "DISPONIBLE";
    const nombreResg = estadoAsignacion === "DISPONIBLE"
      ? ""
      : String(b.nombre_resguardante || "").trim();
    const cargoResg = String(b.cargo_resguardante || "Servidor de la nación").trim() || "Servidor de la nación";
    const rawFisico = String(b.estatus_fisico || "BUENO").trim().toUpperCase();
    const estatusFisico = ["BUENO", "INCOMPLETO", "DAÑADO"].includes(rawFisico) ? rawFisico : "BUENO";
    const tieneCargador = b.tiene_cargador !== undefined ? (Number(b.tiene_cargador) ? 1 : 0) : 1;
    const tieneCaja = b.tiene_caja !== undefined ? (Number(b.tiene_caja) ? 1 : 0) : 1;
    const observaciones = String(b.observaciones || "").trim() || null;

    const [ins] = await poolOps.query(
      `INSERT INTO inventario_tabletas
         (no_resguardo, imei, numero_serie, no_caja, marca, modelo, descripcion,
          region, oficina_programa, nombre_resguardante, cargo_resguardante,
          estatus_fisico, tiene_cargador, tiene_caja, observaciones,
          sin_resguardo_previo, estado_asignacion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        noResguardo,
        imei,
        numeroSerie,
        noCaja,
        marca,
        modelo,
        descripcion,
        region,
        oficina_programa,
        nombreResg,
        cargoResg,
        estatusFisico,
        tieneCargador,
        tieneCaja,
        observaciones,
        estadoAsignacion,
      ]
    );
    const newId = ins.insertId;

    const bitacoraDetalle = `Alta de nueva Tableta #${noResguardo} (${marca} ${modelo}, Serie: ${numeroSerie}, IMEI: ${imei}). Región: ${region} (${oficina_programa}). Estatus inicial: ${estadoAsignacion}. Accesorios: Cargador=${tieneCargador ? "Sí" : "No"}, Caja=${tieneCaja ? "Sí" : "No"}.${observaciones ? ` Obs: ${observaciones}` : ""}`;

    await registrarBitacora(
      req,
      "TABLETAS",
      "ALTA_TABLETA",
      bitacoraDetalle
    );
    await registrarBitacoraTableta(req, {
      tableta_id: newId,
      no_resguardo: noResguardo,
      imei,
      numero_serie: numeroSerie,
      accion: "ALTA_TABLETA",
      detalles: bitacoraDetalle,
    });

    const [[created]] = await poolRead.query(`SELECT * FROM inventario_tabletas WHERE id = ? LIMIT 1`, [newId]);
    return res.status(201).json({
      ok: true,
      id: newId,
      data: created,
      message: `Tableta #${noResguardo} (${marca} ${modelo}) agregada exitosamente con estatus ${estadoAsignacion}.`,
    });
  } catch (e) {
    return httpError(res, e.statusCode || 500, e.message || "Error al agregar nueva tableta");
  }
});

// 2. PUT /api/tabletas/:id — Edición de registro con validación de unicidad (409)
app.put("/api/tabletas/:id", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    if (!canEditTabletas(req)) {
      return httpError(res, 403, "No tienes permiso para editar tabletas.");
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return httpError(res, 400, "ID de tableta inválido.");

    const [[existing]] = await poolRead.query(`SELECT * FROM inventario_tabletas WHERE id = ? LIMIT 1`, [id]);
    if (!existing) return httpError(res, 404, "Tableta no encontrada.");

    const b = req.body || {};
    const adminUser = isAdmin(req);

    // Solo el Administrador puede modificar no_resguardo, imei y numero_serie en registros existentes
    const noResguardo = (adminUser && b.no_resguardo !== undefined) ? parseInt(b.no_resguardo, 10) : existing.no_resguardo;
    if (!Number.isInteger(noResguardo) || noResguardo <= 0) {
      return httpError(res, 400, "El No. de Resguardo debe ser un número entero positivo.");
    }
    const imei = (adminUser && b.imei !== undefined) ? String(b.imei).trim() : existing.imei;
    const numeroSerie = (adminUser && b.numero_serie !== undefined) ? String(b.numero_serie).trim() : existing.numero_serie;
    if (!imei || !numeroSerie) {
      return httpError(res, 400, "IMEI y Número de Serie son obligatorios.");
    }

    // Validación estricta de duplicados (no_resguardo, imei, numero_serie)
    const [dups] = await poolRead.query(
      `SELECT id, no_resguardo, imei, numero_serie
       FROM inventario_tabletas
       WHERE id <> ? AND (no_resguardo = ? OR imei = ? OR numero_serie = ?)
       LIMIT 1`,
      [id, noResguardo, imei, numeroSerie]
    );
    if (dups.length) {
      const d = dups[0];
      if (Number(d.no_resguardo) === noResguardo) {
        return httpError(res, 409, `⚠️ El No. de Resguardo ${noResguardo} ya pertenece a otra tableta.`);
      }
      if (String(d.imei).trim() === imei) {
        return httpError(res, 409, `⚠️ El IMEI "${imei}" ya está registrado en otra tableta (#${d.no_resguardo}).`);
      }
      return httpError(res, 409, `⚠️ El Número de Serie "${numeroSerie}" ya está registrado en otra tableta (#${d.no_resguardo}).`);
    }

    const { region, oficina_programa } = normalizeTabletaRegionInput(
      b.region !== undefined ? b.region : existing.region,
      b.oficina_programa !== undefined ? b.oficina_programa : existing.oficina_programa
    );
    const noCaja = b.no_caja !== undefined ? (String(b.no_caja || "").trim() || null) : existing.no_caja;
    const marca = b.marca !== undefined ? (String(b.marca || "Compac").trim() || "Compac") : existing.marca;
    const modelo = b.modelo !== undefined ? (String(b.modelo || "QTab LTE").trim() || "QTab LTE") : existing.modelo;
    const descripcion = b.descripcion !== undefined ? (String(b.descripcion || "Tablet Compac").trim() || "Tablet Compac") : existing.descripcion;
    const nombreResg = b.nombre_resguardante !== undefined ? String(b.nombre_resguardante || "").trim() : existing.nombre_resguardante;
    const cargoResg = b.cargo_resguardante !== undefined ? (String(b.cargo_resguardante || "Servidor de la nación").trim() || "Servidor de la nación") : existing.cargo_resguardante;
    const estatusFisico = b.estatus_fisico !== undefined ? (String(b.estatus_fisico || "BUENO").trim().toUpperCase()) : existing.estatus_fisico;
    const tieneCargador = b.tiene_cargador !== undefined ? (Number(b.tiene_cargador) ? 1 : 0) : existing.tiene_cargador;
    const tieneCaja = b.tiene_caja !== undefined ? (Number(b.tiene_caja) ? 1 : 0) : existing.tiene_caja;
    const observaciones = b.observaciones !== undefined ? (String(b.observaciones || "").trim() || null) : existing.observaciones;

    await poolOps.query(
      `UPDATE inventario_tabletas
       SET no_resguardo = ?, imei = ?, numero_serie = ?, no_caja = ?,
           marca = ?, modelo = ?, descripcion = ?,
           region = ?, oficina_programa = ?,
           nombre_resguardante = ?, cargo_resguardante = ?,
           estatus_fisico = ?, tiene_cargador = ?, tiene_caja = ?, observaciones = ?
       WHERE id = ?`,
      [
        noResguardo, imei, numeroSerie, noCaja,
        marca, modelo, descripcion,
        region, oficina_programa,
        nombreResg, cargoResg,
        estatusFisico, tieneCargador, tieneCaja, observaciones,
        id,
      ]
    );

    await registrarBitacora(
      req,
      "TABLETAS",
      "EDITAR_TABLETA",
      `Tableta #${noResguardo} (IMEI: ${imei}) actualizada. Resguardante: "${nombreResg || "Sin nombre"}", Región: ${region} (${oficina_programa}).`
    );
    await registrarBitacoraTableta(req, {
      tableta_id: id,
      no_resguardo: noResguardo,
      imei,
      numero_serie: numeroSerie,
      accion: "EDITAR_TABLETA",
      detalles: `Tableta #${noResguardo} actualizada. Resguardante: "${nombreResg || "Sin nombre"}", Región: ${region} (${oficina_programa}), Estatus: ${estatusFisico}.`
    });

    const [[updated]] = await poolRead.query(`SELECT * FROM inventario_tabletas WHERE id = ? LIMIT 1`, [id]);
    return res.json({ ok: true, data: updated, message: `Tableta #${noResguardo} actualizada correctamente.` });
  } catch (e) {
    return httpError(res, e.statusCode || 500, e.message || "Error al actualizar tableta");
  }
});

// 2B. DELETE /api/tabletas/:id — Eliminación de tableta (Restringido a canEditTabletas / Admin)
app.delete("/api/tabletas/:id", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    if (!canEditTabletas(req)) {
      return httpError(res, 403, "No tienes permiso para eliminar tabletas.");
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return httpError(res, 400, "ID de tableta inválido.");

    const [[existing]] = await poolRead.query(`SELECT * FROM inventario_tabletas WHERE id = ? LIMIT 1`, [id]);
    if (!existing) return httpError(res, 404, "Tableta no encontrada.");

    await poolOps.query(`DELETE FROM inventario_tabletas WHERE id = ?`, [id]);

    const detDel = `Tableta #${existing.no_resguardo} (IMEI: ${existing.imei}, Serie: ${existing.numero_serie}) eliminada del padrón.`;
    await registrarBitacora(req, "TABLETAS", "ELIMINAR_TABLETA", detDel);
    await registrarBitacoraTableta(req, {
      tableta_id: id,
      no_resguardo: existing.no_resguardo,
      imei: existing.imei,
      numero_serie: existing.numero_serie,
      accion: "ELIMINAR_TABLETA",
      detalles: detDel,
    });

    return res.json({ ok: true, id, message: `Tableta #${existing.no_resguardo} eliminada correctamente.` });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al eliminar tableta");
  }
});

// 3. POST /api/tabletas/importar-nombres — Importar nombres desde archivo Excel (.xlsx)
app.post("/api/tabletas/importar-nombres", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    if (!canEditTabletas(req)) {
      return httpError(res, 403, "No tienes permiso para importar nombres en tabletas.");
    }

    const ctype = String(req.headers["content-type"] || "").toLowerCase();
    const candidates = []; // { no_resguardo, imei, nombre, cargo }

    if (ctype.includes("multipart/form-data")) {
      const fileData = await parseMultipartSingleFile(req);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(fileData.buffer);
      const ws = wb.getWorksheet("BCS") || wb.worksheets[0];
      if (!ws) return httpError(res, 400, "El archivo Excel no contiene hojas válidas.");

      // Detectar si tiene encabezados estándar en fila 1..3 o formato BCS (col 3=No. Resguardo, col 4=NOMBRE, col 9=IMEI)
      let colResg = 3;
      let colNombre = 4;
      let colImei = 9;
      let colCargo = 0;
      let startRow = 4;

      for (let rIdx = 1; rIdx <= Math.min(5, ws.rowCount); rIdx++) {
        const row = ws.getRow(rIdx);
        const vals = [];
        for (let c = 1; c <= Math.min(15, ws.columnCount || 15); c++) {
          vals.push({ c, txt: extractExcelCellText(row.getCell(c).value).toUpperCase() });
        }
        const fResg = vals.find((x) => x.txt.includes("RESGUARDO"));
        const fNom = vals.find((x) => x.txt === "NOMBRE" || x.txt.includes("RESGUARDANTE"));
        const fImei = vals.find((x) => x.txt.includes("IMEI"));
        const fCargo = vals.find((x) => x.txt.includes("CARGO") || x.txt.includes("PUESTO"));
        if (fNom && (fResg || fImei)) {
          colResg = fResg ? fResg.c : 0;
          colNombre = fNom.c;
          colImei = fImei ? fImei.c : 0;
          colCargo = fCargo ? fCargo.c : 0;
          startRow = rIdx + 1;
          break;
        }
      }

      ws.eachRow((row, rn) => {
        if (rn < startRow) return;
        const noResgVal = colResg ? parseInt(extractExcelCellText(row.getCell(colResg).value), 10) : NaN;
        const imeiVal = colImei ? extractExcelCellText(row.getCell(colImei).value) : "";
        const nomVal = colNombre ? extractExcelCellText(row.getCell(colNombre).value) : "";
        const cargoVal = colCargo ? extractExcelCellText(row.getCell(colCargo).value) : "";
        if (!nomVal) return;
        if (Number.isInteger(noResgVal) || imeiVal) {
          candidates.push({
            no_resguardo: Number.isInteger(noResgVal) ? noResgVal : null,
            imei: imeiVal || null,
            nombre: nomVal,
            cargo: cargoVal || null,
          });
        }
      });
    } else if (req.body?.fileBase64) {
      const b64 = String(req.body.fileBase64).replace(/^data:[^;]+;base64,/, "");
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(b64, "base64"));
      const ws = wb.getWorksheet("BCS") || wb.worksheets[0];
      if (!ws) return httpError(res, 400, "Archivo Excel vacío.");
      ws.eachRow((row, rn) => {
        if (rn < 2) return;
        const noResgVal = parseInt(extractExcelCellText(row.getCell(3).value), 10);
        const nomVal = extractExcelCellText(row.getCell(4).value);
        const imeiVal = extractExcelCellText(row.getCell(9).value);
        if (nomVal && (Number.isInteger(noResgVal) || imeiVal)) {
          candidates.push({ no_resguardo: Number.isInteger(noResgVal) ? noResgVal : null, imei: imeiVal || null, nombre: nomVal, cargo: null });
        }
      });
    } else if (Array.isArray(req.body?.rows)) {
      for (const r of req.body.rows) {
        const nomVal = String(r.nombre || r.nombre_resguardante || "").trim();
        if (!nomVal) continue;
        const noResgVal = parseInt(r.no_resguardo, 10);
        const imeiVal = String(r.imei || "").trim();
        if (Number.isInteger(noResgVal) || imeiVal) {
          candidates.push({
            no_resguardo: Number.isInteger(noResgVal) ? noResgVal : null,
            imei: imeiVal || null,
            nombre: nomVal,
            cargo: String(r.cargo || "").trim() || null,
          });
        }
      }
    } else {
      return httpError(res, 400, "Envía un archivo Excel (.xlsx) o un arreglo de filas válido.");
    }

    if (!candidates.length) {
      return httpError(res, 400, "No se encontraron filas válidas con No. de Resguardo/IMEI y Nombre en el archivo.");
    }

    let actualizados = 0;
    const conn = await poolOps.getConnection();
    try {
      await conn.beginTransaction();
      for (const c of candidates) {
        let targetRows = [];
        if (c.no_resguardo) {
          const [r] = await conn.query(
            `SELECT id, estado_asignacion FROM inventario_tabletas WHERE no_resguardo = ? LIMIT 1`,
            [c.no_resguardo]
          );
          targetRows = r;
        }
        if (!targetRows.length && c.imei) {
          const [r] = await conn.query(
            `SELECT id, estado_asignacion FROM inventario_tabletas WHERE imei = ? LIMIT 1`,
            [c.imei]
          );
          targetRows = r;
        }
        if (targetRows.length) {
          const tId = targetRows[0].id;
          if (c.cargo) {
            await conn.query(
              `UPDATE inventario_tabletas SET nombre_resguardante = ?, cargo_resguardante = ? WHERE id = ?`,
              [c.nombre, c.cargo, tId]
            );
          } else {
            await conn.query(
              `UPDATE inventario_tabletas SET nombre_resguardante = ? WHERE id = ?`,
              [c.nombre, tId]
            );
          }
          actualizados++;
        }
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    await registrarBitacora(
      req,
      "TABLETAS",
      "IMPORTAR_NOMBRES",
      `Importación masiva de nombres desde Excel: ${actualizados} de ${candidates.length} tabletas actualizadas.`
    );
    await registrarBitacoraTableta(req, {
      accion: "IMPORTAR_NOMBRES",
      detalles: `Importación masiva desde Excel: ${actualizados} de ${candidates.length} tabletas actualizadas.`
    });

    return res.json({
      ok: true,
      total_leidos: candidates.length,
      actualizados,
      message: `Importación completada: ${actualizados} tabletas actualizadas correctamente.`,
    });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al importar nombres de Excel");
  }
});

// 4. POST /api/tabletas/:id/generar-devolucion — Inicia devolución (remota para foráneos, PDF inmediato para La Paz)
app.post("/api/tabletas/:id/generar-devolucion", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    if (!canEditTabletas(req)) {
      return httpError(res, 403, "No tienes permiso para generar vales de devolución de tabletas.");
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return httpError(res, 400, "ID de tableta inválido.");

    const b = req.body || {};
    const conn = await poolOps.getConnection();
    let movId = null;
    let folio = "";
    let regionForanea = null;
    try {
      await conn.beginTransaction();
      const [[tab]] = await conn.query(`SELECT * FROM inventario_tabletas WHERE id = ? LIMIT 1 FOR UPDATE`, [id]);
      if (!tab) {
        await conn.rollback();
        return httpError(res, 404, "Tableta no encontrada.");
      }
      if (tab.estado_asignacion !== "EN_RESGUARDO") {
        await conn.rollback();
        return httpError(res, 409, `La tableta #${tab.no_resguardo} no está EN_RESGUARDO (estado actual: ${tab.estado_asignacion}).`);
      }

      regionForanea = normalizeTabletaForaneaRegion(tab.region);

      if (regionForanea) {
        const [dupMov] = await conn.query(
          `SELECT id, estado_firma
           FROM movimientos_tabletas
           WHERE tableta_id = ?
             AND tipo = 'DEVOLUCION'
             AND estado = 'EN_PROCESO'
             AND estado_firma IN ('PENDIENTE_FIRMA', 'FIRMADO')
           LIMIT 1
           FOR UPDATE`,
          [tab.id]
        );
        if (dupMov && dupMov.length > 0) {
          await conn.rollback();
          return httpError(
            res,
            409,
            `Ya existe una solicitud de devolución activa (${dupMov[0].estado_firma}) para la Tableta #${tab.no_resguardo}.`
          );
        }
      }

      const nombrePersona = String(b.nombre_persona || tab.nombre_resguardante || "").trim();
      if (!nombrePersona) {
        await conn.rollback();
        return httpError(res, 400, "Indica el nombre de la persona que entrega/devuelve la tableta.");
      }
      const cargoPersona = String(b.cargo_persona || tab.cargo_resguardante || "Servidor de la nación").trim() || "Servidor de la nación";
      const tieneCargador = b.tiene_cargador !== undefined ? (Number(b.tiene_cargador) ? 1 : 0) : Number(tab.tiene_cargador ?? 1);
      const tieneCaja = b.tiene_caja !== undefined ? (Number(b.tiene_caja) ? 1 : 0) : Number(tab.tiene_caja ?? 1);
      const estatusFisico = String(b.estatus_fisico || tab.estatus_fisico || "BUENO").trim().toUpperCase();
      const observaciones = String(b.observaciones ?? tab.observaciones ?? "").trim() || null;

      const estadoFirmaInit = regionForanea ? "PENDIENTE_FIRMA" : "NO_APLICA";
      const regionDestinoInit = regionForanea || null;

      folio = await generateNextTabletaFolio(conn);
      const [ins] = await conn.query(
        `INSERT INTO movimientos_tabletas
           (tipo, folio, tableta_id, no_resguardo, region, oficina_programa,
            nombre_persona, cargo_persona, tiene_cargador, tiene_caja, estatus_fisico, observaciones, estado,
            estado_firma, region_firma_destino)
         VALUES ('DEVOLUCION', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EN_PROCESO', ?, ?)`,
        [
          folio,
          tab.id,
          tab.no_resguardo,
          tab.region,
          tab.oficina_programa,
          nombrePersona,
          cargoPersona,
          tieneCargador,
          tieneCaja,
          estatusFisico,
          observaciones,
          estadoFirmaInit,
          regionDestinoInit,
        ]
      );
      movId = ins.insertId;

      await conn.query(
        `UPDATE inventario_tabletas
         SET estado_asignacion = 'DEVOLUCION_PENDIENTE',
             tiene_cargador = ?,
             tiene_caja = ?,
             estatus_fisico = ?,
             observaciones = ?
         WHERE id = ?`,
        [tieneCargador, tieneCaja, estatusFisico, observaciones, tab.id]
      );

      await conn.commit();
      await registrarBitacora(
        req,
        "TABLETAS",
        "GENERAR_DEVOLUCION",
        regionForanea
          ? `Devolución Folio ${folio} de Tableta #${tab.no_resguardo} enviada a Firma Digital remota (${regionForanea}). Entrega: ${nombrePersona}.`
          : `Vale de devolución Folio ${folio} generado para Tableta #${tab.no_resguardo} (Entrega: ${nombrePersona}). Estado: DEVOLUCION_PENDIENTE.`
      );
      await registrarBitacoraTableta(req, {
        tableta_id: tab.id,
        no_resguardo: tab.no_resguardo,
        imei: tab.imei,
        numero_serie: tab.numero_serie,
        accion: "GENERAR_DEVOLUCION",
        detalles: regionForanea
          ? `Devolución Folio ${folio} enviada a firma digital remota (${regionForanea}). Entrega: ${nombrePersona}.`
          : `Vale de devolución Folio ${folio} generado (Entrega: ${nombrePersona}). Estado: DEVOLUCION_PENDIENTE.`
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    if (regionForanea) {
      return res.json({
        ok: true,
        requiere_firma_remota: true,
        region_destino: regionForanea,
        movimiento_id: movId,
        folio,
        message: `Devolución Folio ${folio} enviada a Firma Digital remota de la región ${regionForanea}.`,
      });
    }

    return res.json({
      ok: true,
      requiere_firma_remota: false,
      movimiento_id: movId,
      folio,
      pdf_url: `/api/tabletas/movimientos/${movId}/pdf`,
      message: `Vale de devolución Folio ${folio} generado. La tableta está ahora en proceso de devolución.`,
    });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al generar vale de devolución");
  }
});

// 5. PUT /api/tabletas/movimientos/:movId/confirmar-devolucion — Confirma recepción física en almacén
app.put("/api/tabletas/movimientos/:movId/confirmar-devolucion", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    if (!canEditTabletas(req)) {
      return httpError(res, 403, "No tienes permiso para confirmar devoluciones de tabletas.");
    }
    const movId = Number(req.params.movId);
    if (!Number.isInteger(movId) || movId <= 0) return httpError(res, 400, "ID de movimiento inválido.");

    const conn = await poolOps.getConnection();
    let movRow = null;
    try {
      await conn.beginTransaction();
      const [[mov]] = await conn.query(
        `SELECT * FROM movimientos_tabletas WHERE id = ? LIMIT 1 FOR UPDATE`,
        [movId]
      );
      if (!mov) {
        await conn.rollback();
        return httpError(res, 404, "Movimiento de devolución no encontrado.");
      }
      if (mov.tipo !== "DEVOLUCION") {
        await conn.rollback();
        return httpError(res, 400, "El movimiento especificado no corresponde a una devolución.");
      }
      if (mov.estado === "CONFIRMADO") {
        await conn.rollback();
        return httpError(res, 409, "Esta devolución ya fue confirmada previamente.");
      }
      const estFirma = String(mov.estado_firma || "NO_APLICA").toUpperCase();
      if (["PENDIENTE_FIRMA", "RECHAZADO", "CANCELADO"].includes(estFirma)) {
        await conn.rollback();
        return httpError(
          res,
          409,
          `No se puede confirmar la recepción física mientras la firma digital esté en estado ${estFirma}.`
        );
      }
      movRow = mov;

      await conn.query(
        `UPDATE movimientos_tabletas SET estado = 'CONFIRMADO', confirmed_at = NOW() WHERE id = ?`,
        [movId]
      );

      await conn.query(
        `UPDATE inventario_tabletas
         SET estado_asignacion = 'DISPONIBLE',
             nombre_resguardante = '',
             sin_resguardo_previo = 0,
             ultimo_movimiento_asignacion_id = NULL
         WHERE id = ?`,
        [mov.tableta_id]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    await registrarBitacora(
      req,
      "TABLETAS",
      "CONFIRMAR_DEVOLUCION",
      `Recepción física confirmada para Tableta #${movRow.no_resguardo} (Vale Folio ${movRow.folio}). Estado actual: DISPONIBLE.`
    );
    await registrarBitacoraTableta(req, {
      tableta_id: movRow.tableta_id,
      no_resguardo: movRow.no_resguardo,
      accion: "CONFIRMAR_RECIBIDO",
      detalles: `Recepción física confirmada (Vale Folio ${movRow.folio}). Estado actual: DISPONIBLE.`
    });

    return res.json({
      ok: true,
      message: `Recepción física confirmada para Tableta #${movRow.no_resguardo}. Ahora está Disponible en almacén.`,
    });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al confirmar recepción de tableta");
  }
});

// 6. POST /api/tabletas/:id/generar-resguardo — Asigna tableta disponible con 3 fotografías obligatorias y genera Resguardo Personal
app.post(
  "/api/tabletas/:id/generar-resguardo",
  authRequired,
  (req, res, next) => {
    if (!canEditTabletas(req)) {
      return httpError(res, 403, "No tienes permiso para asignar tabletas y generar resguardos.");
    }
    return next();
  },
  uploadTabletaEvidenciasMiddleware,
  async (req, res) => {
    try {
      await ensureSchemaAndUsers();
      if (!canEditTabletas(req)) {
        cleanupTabletaEvidenciaFiles(req.files);
        return httpError(res, 403, "No tienes permiso para asignar tabletas y generar resguardos.");
      }
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        cleanupTabletaEvidenciaFiles(req.files);
        return httpError(res, 400, "ID de tableta inválido.");
      }

      // Validación obligatoria de las 3 fotografías de evidencia
      const fIneFrente = req.files?.foto_ine_frente?.[0] || null;
      const fIneReverso = req.files?.foto_ine_reverso?.[0] || null;
      const fEntrega = req.files?.foto_entrega?.[0] || null;
      if (!fIneFrente || !fIneReverso || !fEntrega) {
        cleanupTabletaEvidenciaFiles(req.files);
        return httpError(
          res,
          400,
          "Debes adjuntar las 3 fotografías obligatorias (INE Frente, INE Reverso y Foto de Entrega) para asignar la tableta."
        );
      }

      const b = req.body || {};
      const nombreResg = String(b.nombre_resguardante || b.nombre_persona || "").trim();
      if (!nombreResg) {
        cleanupTabletaEvidenciaFiles(req.files);
        return httpError(res, 400, "El nombre completo del nuevo resguardante es obligatorio.");
      }
      const cargoResg = String(b.cargo_resguardante || b.cargo_persona || "Servidor de la nación").trim() || "Servidor de la nación";

      const conn = await poolOps.getConnection();
      let movId = null;
      let folio = "";
      let noResguardo = 0;
      try {
        await conn.beginTransaction();
        const [[tab]] = await conn.query(`SELECT * FROM inventario_tabletas WHERE id = ? LIMIT 1 FOR UPDATE`, [id]);
        if (!tab) {
          await conn.rollback();
          cleanupTabletaEvidenciaFiles(req.files);
          return httpError(res, 404, "Tableta no encontrada.");
        }
        if (tab.estado_asignacion !== "DISPONIBLE") {
          await conn.rollback();
          cleanupTabletaEvidenciaFiles(req.files);
          return httpError(res, 409, `La tableta #${tab.no_resguardo} no está DISPONIBLE para asignar (estado actual: ${tab.estado_asignacion}).`);
        }

        const { region, oficina_programa } = normalizeTabletaRegionInput(
          b.region || tab.region,
          b.oficina_programa || tab.oficina_programa
        );
        const tieneCargador = b.tiene_cargador !== undefined ? (Number(b.tiene_cargador) ? 1 : 0) : Number(tab.tiene_cargador ?? 1);
        const tieneCaja = b.tiene_caja !== undefined ? (Number(b.tiene_caja) ? 1 : 0) : Number(tab.tiene_caja ?? 1);
        const estatusFisico = String(b.estatus_fisico || tab.estatus_fisico || "BUENO").trim().toUpperCase();
        const observaciones = b.observaciones !== undefined ? (String(b.observaciones || "").trim() || null) : tab.observaciones;

        folio = await generateNextTabletaFolio(conn);
        noResguardo = tab.no_resguardo;

        const [ins] = await conn.query(
          `INSERT INTO movimientos_tabletas
             (tipo, folio, tableta_id, no_resguardo, region, oficina_programa,
              nombre_persona, cargo_persona, tiene_cargador, tiene_caja, estatus_fisico, observaciones,
              estado, confirmed_at, foto_ine_frente, foto_ine_reverso, foto_entrega)
           VALUES ('ASIGNACION', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMADO', NOW(), ?, ?, ?)`,
          [
            folio,
            tab.id,
            tab.no_resguardo,
            region,
            oficina_programa,
            nombreResg,
            cargoResg,
            tieneCargador,
            tieneCaja,
            estatusFisico,
            observaciones,
            fIneFrente.filename,
            fIneReverso.filename,
            fEntrega.filename,
          ]
        );
        movId = ins.insertId;

        await conn.query(
          `UPDATE inventario_tabletas
           SET estado_asignacion = 'EN_RESGUARDO',
               nombre_resguardante = ?,
               cargo_resguardante = ?,
               region = ?,
               oficina_programa = ?,
               tiene_cargador = ?,
               tiene_caja = ?,
               estatus_fisico = ?,
               observaciones = ?,
               sin_resguardo_previo = 0,
               ultimo_movimiento_asignacion_id = ?
           WHERE id = ?`,
          [
            nombreResg,
            cargoResg,
            region,
            oficina_programa,
            tieneCargador,
            tieneCaja,
            estatusFisico,
            observaciones,
            movId,
            tab.id,
          ]
        );

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        cleanupTabletaEvidenciaFiles(req.files);
        throw err;
      } finally {
        conn.release();
      }

      await registrarBitacora(
        req,
        "TABLETAS",
        "ASIGNAR_RESGUARDO",
        `Resguardo personal Folio ${folio} generado para Tableta #${noResguardo} a favor de "${nombreResg}" (con 3 fotografías de evidencia).`
      );
      await registrarBitacoraTableta(req, {
        tableta_id: id,
        no_resguardo: noResguardo,
        accion: "ASIGNAR_RESGUARDO",
        detalles: `Resguardo personal Folio ${folio} generado a favor de "${nombreResg}" (3 evidencias fotográficas adjuntas).`
      });

      return res.json({
        ok: true,
        movimiento_id: movId,
        folio,
        pdf_url: `/api/tabletas/movimientos/${movId}/pdf`,
        message: `Resguardo personal Folio ${folio} asignado correctamente a ${nombreResg}.`,
      });
    } catch (e) {
      cleanupTabletaEvidenciaFiles(req.files);
      return httpError(res, 500, e.message || "Error al generar resguardo de tableta");
    }
  }
);

// 7. GET /api/tabletas/movimientos/:movId/pdf — PDF oficial de Resguardo Personal o Vale de Devolución
app.get("/api/tabletas/movimientos/:movId/pdf", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    if (getRegionalSignatureScope(req.user)) {
      return httpError(res, 403, "Las cuentas regionales no tienen permiso para descargar archivos PDF.");
    }
    if (!canAccessTabletas(req)) {
      return httpError(res, 403, "No tienes permiso para descargar formatos de tabletas.");
    }
    const movId = Number(req.params.movId);
    if (!Number.isInteger(movId) || movId <= 0) return httpError(res, 400, "ID de movimiento inválido.");

    const [[mov]] = await poolRead.query(`SELECT * FROM movimientos_tabletas WHERE id = ? LIMIT 1`, [movId]);
    if (!mov) return httpError(res, 404, "Movimiento no encontrado.");

    if (String(mov.tipo || "").toUpperCase() === "DEVOLUCION") {
      if (!canEditTabletas(req)) {
        return httpError(res, 403, "Solo el encargado de tabletas o Administración puede descargar Vales de Devolución.");
      }
      const estFirma = String(mov.estado_firma || "NO_APLICA").toUpperCase();
      if (["PENDIENTE_FIRMA", "RECHAZADO", "CANCELADO"].includes(estFirma)) {
        return httpError(
          res,
          409,
          `El Vale de Devolución no puede descargarse mientras su estado de firma sea ${estFirma}.`
        );
      }
    }

    const [[tab]] = await poolRead.query(`SELECT * FROM inventario_tabletas WHERE id = ? LIMIT 1`, [mov.tableta_id]);
    if (!tab) return httpError(res, 404, "Tableta asociada no encontrada.");

    return renderTabletaFormatoPdf(req, res, {
      tableta: tab,
      movimiento: mov,
      modo: mov.tipo,
    });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al generar PDF del movimiento de tableta");
  }
});

// 8. GET /api/tabletas/:id/resguardo-pdf — PDF directo de Resguardo Personal actual de una tableta
app.get("/api/tabletas/:id/resguardo-pdf", authRequired, async (req, res) => {
  try {
    await ensureSchemaAndUsers();
    if (getRegionalSignatureScope(req.user)) {
      return httpError(res, 403, "Las cuentas regionales no tienen permiso para descargar archivos PDF.");
    }
    if (!canAccessTabletas(req)) {
      return httpError(res, 403, "No tienes permiso para descargar formatos de tabletas.");
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return httpError(res, 400, "ID de tableta inválido.");

    const [[tab]] = await poolRead.query(`SELECT * FROM inventario_tabletas WHERE id = ? LIMIT 1`, [id]);
    if (!tab) return httpError(res, 404, "Tableta no encontrada.");

    const [[lastAsig]] = await poolRead.query(
      `SELECT * FROM movimientos_tabletas
       WHERE tableta_id = ? AND tipo = 'ASIGNACION' AND estado = 'CONFIRMADO'
       ORDER BY id DESC LIMIT 1`,
      [tab.id]
    );

    return renderTabletaFormatoPdf(req, res, {
      tableta: tab,
      movimiento: lastAsig || null,
      modo: "ASIGNACION",
    });
  } catch (e) {
    return httpError(res, 500, e.message || "Error al generar PDF de resguardo de tableta");
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
