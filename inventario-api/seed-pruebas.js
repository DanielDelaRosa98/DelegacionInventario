/**
 * Script ejecutable para poblar datos de prueba realistas (seed_pruebas.sql)
 * sin borrar usuarios ni catálogos base.
 *
 * Uso:
 *   cd inventario-api
 *   node seed-pruebas.js
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
require("dotenv").config({ path: path.join(__dirname, ".env") });

async function runSeedPruebas() {
  const sqlPath = path.join(__dirname, "..", "database", "seed_pruebas.sql");
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`No se encontró el archivo SQL en: ${sqlPath}`);
  }

  const sqlContent = fs.readFileSync(sqlPath, "utf8");
  const sslOpt = process.env.DB_SSL
    ? { ssl: { rejectUnauthorized: false, minVersion: "TLSv1.2" } }
    : {};

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME,
    user: process.env.DB_USER_OPS || process.env.DB_USER_READ,
    password: process.env.DB_PASS_OPS || process.env.DB_PASS_READ,
    multipleStatements: true,
    ...sslOpt,
  });

  try {
    console.log(`[SEED] Conectado a BD "${process.env.DB_NAME}" en ${process.env.DB_HOST}...`);
    await conn.query(sqlContent);
    console.log("[SEED] Datos de prueba (Almacén, Vales con Firma Digital e Inventario Regional) cargados con éxito.");
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  runSeedPruebas().catch((err) => {
    console.error("[SEED ERROR]:", err.message || err);
    process.exit(1);
  });
}

module.exports = { runSeedPruebas };
