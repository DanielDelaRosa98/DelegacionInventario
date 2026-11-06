-- =============================================================================
-- Esquema completo para Sistema de Inventario y Resguardo Regional (BCS)
-- Compatible con MariaDB 10.11+ (Synology NAS / Docker) y MySQL 8.0+
-- Sin registros de "Órdenes de Material" ni de "Inventario".
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- Eliminar vistas si existen
DROP VIEW IF EXISTS `v_stock`;
DROP VIEW IF EXISTS `v_solicitudes_resumen`;
DROP VIEW IF EXISTS `v_solicitudes_inconsistentes`;
DROP VIEW IF EXISTS `v_solicitudes_detalle`;
DROP VIEW IF EXISTS `v_pendientes_por_usuario`;
DROP VIEW IF EXISTS `v_pendientes_por_oficialia`;

-- Eliminar tablas si existen (orden inverso de dependencias)
DROP TABLE IF EXISTS `formatos_inventario_regional`;
DROP TABLE IF EXISTS `prestamos_inventario`;
DROP TABLE IF EXISTS `inventario_oficina`;
DROP TABLE IF EXISTS `oficinas_regionales`;
DROP TABLE IF EXISTS `rubros_inventario`;
DROP TABLE IF EXISTS `regiones`;
DROP TABLE IF EXISTS `detalles_solicitud`;
DROP TABLE IF EXISTS `solicitudes`;
DROP TABLE IF EXISTS `movimientos_inventario`;
DROP TABLE IF EXISTS `almacen_principal`;
DROP TABLE IF EXISTS `almacen_dregcivil`;
DROP TABLE IF EXISTS `productos`;
DROP TABLE IF EXISTS `log_accesos`;
DROP TABLE IF EXISTS `usuario`;
DROP TABLE IF EXISTS `oficialias`;
DROP TABLE IF EXISTS `umedida`;
DROP TABLE IF EXISTS `categorias`;

-- =============================================================================
-- 1. CATÁLOGOS BASE Y AUTENTICACIÓN
-- =============================================================================

-- Tabla: categorias
CREATE TABLE `categorias` (
  `idcategoria` int(11) NOT NULL AUTO_INCREMENT,
  `descCategoria` varchar(100) DEFAULT NULL,
  PRIMARY KEY (`idcategoria`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: umedida
CREATE TABLE `umedida` (
  `idUnidad` int(11) NOT NULL,
  `DescUnidad` varchar(50) NOT NULL,
  PRIMARY KEY (`idUnidad`),
  UNIQUE KEY `uq_umedida_desc` (`DescUnidad`),
  UNIQUE KEY `uq_umedida_d` (`DescUnidad`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: oficialias (Departamentos / Áreas solicitantes)
CREATE TABLE `oficialias` (
  `id` int(11) NOT NULL DEFAULT 0,
  `id_tipo_oficialia` smallint(6) NOT NULL,
  `id_municipio` int(11) NOT NULL,
  `id_localidad` int(11) DEFAULT NULL,
  `id_renapo` smallint(6) DEFAULT NULL,
  `nombre` varchar(255) NOT NULL,
  `activo` bit(1) DEFAULT NULL,
  `direccion` varchar(100) DEFAULT NULL,
  `telefono` varchar(20) DEFAULT NULL,
  `oficial_reponsable` varchar(50) DEFAULT NULL,
  `id_oficialia` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ofi_id_loc` (`id`,`id_localidad`),
  UNIQUE KEY `uq_ofi_id_loc2` (`id`,`id_localidad`),
  KEY `idx_oficialias_tipo` (`id_tipo_oficialia`),
  KEY `idx_oficialias_id_tipo_oficialia` (`id_tipo_oficialia`),
  KEY `idx_oficialias_id_localidad` (`id_localidad`),
  KEY `idx_ofi_tipo_loc` (`id_tipo_oficialia`,`id_localidad`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: usuario
CREATE TABLE `usuario` (
  `id` int(11) unsigned NOT NULL DEFAULT 0,
  `username` varchar(255) DEFAULT NULL,
  `psw` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `nombre` varchar(255) DEFAULT NULL,
  `PRIMER_APELLIDO` varchar(255) DEFAULT NULL,
  `SEGUNDO_APELLIDO` varchar(255) DEFAULT NULL,
  `ID_OFICIALIA` int(11) DEFAULT NULL,
  `OFICIALIA_ID` int(11) DEFAULT NULL,
  `ACTIVO` bit(1) DEFAULT NULL,
  `rol` enum('ADMIN','ENCARGADO','USUARIO') NOT NULL DEFAULT 'USUARIO',
  `FECHA_ALTA` datetime DEFAULT NULL,
  `usuario_id` int(11) unsigned DEFAULT NULL,
  `departamento` varchar(255) DEFAULT NULL,
  `rubro_id` int(11) DEFAULT NULL,
  `region_id` int(11) DEFAULT NULL,
  `oficina_id` int(11) DEFAULT NULL,
  UNIQUE KEY `uq_usuario_id_ofi` (`id`,`OFICIALIA_ID`),
  UNIQUE KEY `uq_usuario_id_ofi2` (`id`,`OFICIALIA_ID`),
  UNIQUE KEY `uq_usuario_id_ofi_ok` (`id`,`ID_OFICIALIA`),
  KEY `idx_usuario_id` (`id`),
  KEY `idx_usuario_region` (`region_id`),
  KEY `idx_usuario_oficina` (`oficina_id`),
  KEY `FK_usuario_usuario` (`usuario_id`),
  KEY `fk_usuario_oficialia_pk2` (`OFICIALIA_ID`),
  KEY `fk_usuario_id_oficialia_pk` (`ID_OFICIALIA`),
  CONSTRAINT `fk_usuario_id_oficialia_pk` FOREIGN KEY (`ID_OFICIALIA`) REFERENCES `oficialias` (`id`),
  CONSTRAINT `fk_usuario_oficialia_pk` FOREIGN KEY (`OFICIALIA_ID`) REFERENCES `oficialias` (`id`),
  CONSTRAINT `fk_usuario_oficialia_pk2` FOREIGN KEY (`OFICIALIA_ID`) REFERENCES `oficialias` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: log_accesos (Bitácora de inicios de sesión)
CREATE TABLE `log_accesos` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `usuario_id` int(11) DEFAULT NULL,
  `username` varchar(50) NOT NULL,
  `ip_address` varchar(45) NOT NULL,
  `fecha_acceso` datetime DEFAULT CURRENT_TIMESTAMP,
  `exito` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `idx_usuario_id` (`usuario_id`),
  KEY `idx_fecha_acceso` (`fecha_acceso`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- 2. INVENTARIO DE CONSUMIBLES Y ÓRDENES DE MATERIAL (SOLICITUDES)
-- =============================================================================

-- Tabla: productos
CREATE TABLE `productos` (
  `ID` int(11) unsigned NOT NULL AUTO_INCREMENT,
  `CLAVE` varchar(10) NOT NULL,
  `DESCRIPCION` varchar(255) NOT NULL,
  `PARTIDA` varchar(30) DEFAULT NULL,
  `CATEGORIA` int(11) NOT NULL,
  `MINIMO` int(11) DEFAULT 0,
  `stock_minimo` int(11) DEFAULT 0,
  `MAXIMO` int(11) DEFAULT 0,
  `UNIDAD` varchar(50) DEFAULT NULL,
  `PRECIO` decimal(10,2) DEFAULT NULL,
  `STOCK` int(11) DEFAULT 0,
  `origen_adquisicion` enum('COMPRA_DELEGACION','POR_CONTRATO','OTRO') NOT NULL DEFAULT 'COMPRA_DELEGACION',
  `observaciones_control` text DEFAULT NULL,
  `Status` varchar(50) DEFAULT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `unq_clave_categoria` (`CLAVE`,`CATEGORIA`) USING BTREE,
  KEY `idx_productos_ID` (`ID`),
  KEY `idx_prod_clave_cat` (`CLAVE`,`CATEGORIA`) USING BTREE,
  KEY `fk_prod_categoria` (`CATEGORIA`),
  CONSTRAINT `fk_prod_categoria` FOREIGN KEY (`CATEGORIA`) REFERENCES `categorias` (`idcategoria`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: almacen_dregcivil
CREATE TABLE `almacen_dregcivil` (
  `ID` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `CLAVE` varchar(20) DEFAULT NULL,
  `DESCRIPCION` varchar(500) DEFAULT NULL,
  `CATEGORIA_ID` int(10) unsigned DEFAULT NULL,
  `CATEGORIA` varchar(50) DEFAULT NULL,
  `UNIDAD` varchar(20) DEFAULT NULL,
  `STOCK` int(11) DEFAULT NULL,
  `stock_minimo` int(11) DEFAULT 0,
  `origen_adquisicion` enum('COMPRA_DELEGACION','POR_CONTRATO','OTRO') NOT NULL DEFAULT 'COMPRA_DELEGACION',
  `observaciones_control` text DEFAULT NULL,
  `ESTADO` enum('ACTIVO','INACTIVO') NOT NULL DEFAULT 'ACTIVO',
  PRIMARY KEY (`ID`),
  UNIQUE KEY `ux_clave` (`CLAVE`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: almacen_principal
CREATE TABLE `almacen_principal` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `producto_id` int(11) unsigned NOT NULL,
  `DescAlmacen` varchar(100) NOT NULL DEFAULT 'Principal',
  `STOCK` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `CATALOGO_ID` (`producto_id`) USING BTREE,
  CONSTRAINT `fk_almacen_catalogo` FOREIGN KEY (`producto_id`) REFERENCES `productos` (`ID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: movimientos_inventario
CREATE TABLE `movimientos_inventario` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `producto_id` int(11) unsigned NOT NULL,
  `TIPO_MOVIMIENTO` enum('ENTRADA','SALIDA') NOT NULL,
  `CANTIDAD` int(11) NOT NULL,
  `FECHA` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `RESPONSABLE` varchar(100) DEFAULT NULL,
  `DESTINO` varchar(100) DEFAULT NULL,
  `REFERENCIA` varchar(255) DEFAULT NULL,
  `OBSERVACIONES` text DEFAULT NULL,
  PRIMARY KEY (`ID`),
  KEY `idx_mov_cat_fecha` (`producto_id`,`FECHA`) USING BTREE,
  CONSTRAINT `fk_mov_cat` FOREIGN KEY (`producto_id`) REFERENCES `productos` (`ID`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: solicitudes (Órdenes de Material)
CREATE TABLE `solicitudes` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `tipo_solicitud` varchar(50) NOT NULL,
  `fecha_solicitud` date NOT NULL,
  `id_oficialia` int(11) NOT NULL,
  `id_localidad` int(11) NOT NULL,
  `status` enum('PENDIENTE','APROBADA','SURTIDA','RECHAZADA','CANCELADA') NOT NULL DEFAULT 'PENDIENTE',
  `fecha_surtido` date DEFAULT NULL,
  `observaciones` varchar(500) DEFAULT NULL,
  `archivo_respaldo` varchar(255) DEFAULT NULL,
  `region_solicitante` varchar(50) DEFAULT NULL,
  `nombre_solicitante_firma` varchar(150) DEFAULT NULL,
  `firma_solicitante_data` longtext DEFAULT NULL,
  `fecha_firma_digital` datetime DEFAULT NULL,
  `folio_firma_digital` varchar(80) DEFAULT NULL,
  `creado_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actualizado_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `usuario_id` int(11) unsigned NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_sol_tipo` (`tipo_solicitud`),
  KEY `idx_sol_fecha` (`fecha_solicitud`),
  KEY `idx_sol_status` (`status`),
  KEY `idx_solicitudes_id` (`id`),
  KEY `fk_sol_localidad` (`id_localidad`),
  KEY `fk_sol_oficialia` (`id_oficialia`) USING BTREE,
  KEY `idx_sol_oficialia` (`id_oficialia`) USING BTREE,
  KEY `idx_sol_ofi_loc` (`id_oficialia`,`id_localidad`),
  KEY `idx_sol_idofi_loc` (`id_oficialia`,`id_localidad`),
  KEY `idx_sol_idofi_loc2` (`id_oficialia`,`id_localidad`),
  KEY `fk_sol_usuario_ofi_ok` (`usuario_id`,`id_oficialia`),
  CONSTRAINT `fk_sol_ofi_id_loc` FOREIGN KEY (`id_oficialia`, `id_localidad`) REFERENCES `oficialias` (`id`, `id_localidad`),
  CONSTRAINT `fk_sol_usuario` FOREIGN KEY (`usuario_id`) REFERENCES `usuario` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: detalles_solicitud
CREATE TABLE `detalles_solicitud` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `solicitud_id` bigint(20) unsigned NOT NULL,
  `producto_id` int(11) unsigned NOT NULL,
  `cantidad` int(11) NOT NULL,
  `atendida` int(11) NOT NULL DEFAULT 0,
  `observaciones` varchar(300) DEFAULT NULL,
  `creado_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actualizado_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_det_sol` (`solicitud_id`),
  KEY `idx_det_prod` (`producto_id`),
  CONSTRAINT `fk_det_prod` FOREIGN KEY (`producto_id`) REFERENCES `productos` (`ID`),
  CONSTRAINT `fk_det_sol` FOREIGN KEY (`solicitud_id`) REFERENCES `solicitudes` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- 3. FASE B: INVENTARIO REGIONAL, PRÉSTAMOS Y FORMATOS PDF
-- =============================================================================

-- Tabla: regiones
CREATE TABLE `regiones` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `clave` varchar(30) NOT NULL,
  `nombre` varchar(100) NOT NULL,
  `responsable_regional` varchar(150) DEFAULT 'POR CONFIRMAR',
  `activo` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `clave` (`clave`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: oficinas_regionales
CREATE TABLE `oficinas_regionales` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `region_id` int(11) NOT NULL,
  `municipio` varchar(80) NOT NULL,
  `nombre` varchar(120) NOT NULL,
  `responsable_oficina` varchar(150) DEFAULT NULL,
  `activo` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_oficina_region` (`region_id`),
  CONSTRAINT `fk_oficina_region` FOREIGN KEY (`region_id`) REFERENCES `regiones` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: rubros_inventario
CREATE TABLE `rubros_inventario` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `codigo` varchar(40) NOT NULL,
  `nombre_rubro` varchar(120) NOT NULL,
  `encargado_nombre` varchar(150) NOT NULL,
  `encargado_cargo` varchar(150) NOT NULL,
  `activo` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `codigo` (`codigo`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: inventario_oficina
CREATE TABLE `inventario_oficina` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `oficina_id` int(11) NOT NULL,
  `rubro_id` int(11) NOT NULL,
  `clave_bien` varchar(60) NOT NULL,
  `descripcion` varchar(255) NOT NULL,
  `marca_modelo` varchar(150) DEFAULT NULL,
  `numero_serie_placas` varchar(100) DEFAULT NULL,
  `unidad` varchar(40) DEFAULT 'PIEZA',
  `cantidad_propia` int(11) NOT NULL DEFAULT 1,
  `cantidad_prestada_recibida` int(11) NOT NULL DEFAULT 0,
  `cantidad_prestada_enviada` int(11) NOT NULL DEFAULT 0,
  `estado_fisico` enum('BUENO','REGULAR','MALO','BAJA') DEFAULT 'BUENO',
  `estatus_uso` enum('ACTIVO','PRESTADO','EN_REPARACION','BAJA') DEFAULT 'ACTIVO',
  `origen_adquisicion` enum('COMPRA_DELEGACION','POR_CONTRATO','OTRO') NOT NULL DEFAULT 'COMPRA_DELEGACION',
  `observaciones_control` text DEFAULT NULL,
  `observaciones` text DEFAULT NULL,
  `detalles_vehiculo` longtext DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_inv_rubro` (`rubro_id`),
  KEY `idx_inv_oficina_rubro` (`oficina_id`,`rubro_id`),
  KEY `idx_inv_clave` (`clave_bien`),
  CONSTRAINT `fk_inv_oficina` FOREIGN KEY (`oficina_id`) REFERENCES `oficinas_regionales` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_inv_rubro` FOREIGN KEY (`rubro_id`) REFERENCES `rubros_inventario` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: prestamos_inventario
CREATE TABLE `prestamos_inventario` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `inventario_origen_id` int(11) NOT NULL,
  `oficina_origen_id` int(11) NOT NULL,
  `oficina_destino_id` int(11) NOT NULL,
  `rubro_id` int(11) NOT NULL,
  `clave_bien` varchar(60) NOT NULL,
  `descripcion` varchar(255) NOT NULL,
  `cantidad` int(11) NOT NULL DEFAULT 1,
  `tipo_movimiento` enum('PRESTAMO','TRANSFERENCIA_DEFINITIVA') NOT NULL DEFAULT 'PRESTAMO',
  `estatus` enum('PRESTADO','DEVUELTO','TRANSFERIDO','CANCELADO') NOT NULL DEFAULT 'PRESTADO',
  `fecha_salida` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `fecha_devolucion` datetime DEFAULT NULL,
  `motivo` varchar(255) DEFAULT NULL,
  `observaciones` text DEFAULT NULL,
  `usuario_registro` varchar(100) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_prest_inv_origen` (`inventario_origen_id`),
  KEY `fk_prest_ofi_origen` (`oficina_origen_id`),
  KEY `fk_prest_ofi_destino` (`oficina_destino_id`),
  KEY `fk_prest_rubro` (`rubro_id`),
  CONSTRAINT `fk_prest_inv_origen` FOREIGN KEY (`inventario_origen_id`) REFERENCES `inventario_oficina` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_prest_ofi_destino` FOREIGN KEY (`oficina_destino_id`) REFERENCES `oficinas_regionales` (`id`),
  CONSTRAINT `fk_prest_ofi_origen` FOREIGN KEY (`oficina_origen_id`) REFERENCES `oficinas_regionales` (`id`),
  CONSTRAINT `fk_prest_rubro` FOREIGN KEY (`rubro_id`) REFERENCES `rubros_inventario` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: formatos_inventario_regional
CREATE TABLE `formatos_inventario_regional` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `folio` varchar(40) NOT NULL,
  `region_id` int(11) NOT NULL,
  `oficina_id` int(11) DEFAULT NULL,
  `rubro_id` int(11) NOT NULL,
  `titulo_formato` varchar(200) NOT NULL,
  `firma_encargado_nombre` varchar(150) NOT NULL,
  `firma_encargado_cargo` varchar(150) NOT NULL,
  `firma_delegada_nombre` varchar(150) NOT NULL DEFAULT 'Diphna Yanssen Weichselbaum Calderon',
  `firma_delegada_cargo` varchar(150) NOT NULL DEFAULT 'Delegada de Programas para el Desarrollo en BCS',
  `firma_aprueba_nombre` varchar(150) NOT NULL DEFAULT 'Jorge Patron Murillo',
  `firma_aprueba_cargo` varchar(150) NOT NULL DEFAULT 'Aprueba',
  `firma_recibe_nombre` varchar(150) NOT NULL DEFAULT 'POR CONFIRMAR',
  `firma_recibe_cargo` varchar(150) NOT NULL DEFAULT 'Responsable Regional / Oficina',
  `snapshot_json` longtext NOT NULL,
  `observaciones` text DEFAULT NULL,
  `creado_por` varchar(100) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `folio` (`folio`),
  KEY `fk_fmt_region` (`region_id`),
  KEY `fk_fmt_oficina` (`oficina_id`),
  KEY `fk_fmt_rubro` (`rubro_id`),
  CONSTRAINT `fk_fmt_oficina` FOREIGN KEY (`oficina_id`) REFERENCES `oficinas_regionales` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_fmt_region` FOREIGN KEY (`region_id`) REFERENCES `regiones` (`id`),
  CONSTRAINT `fk_fmt_rubro` FOREIGN KEY (`rubro_id`) REFERENCES `rubros_inventario` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: vales_prestamo (Vales Provisionales para Operativos)
CREATE TABLE `vales_prestamo` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `folio` varchar(30) NOT NULL,
  `rubro_id` int(11) NOT NULL,
  `departamento_id` int(11) NOT NULL,
  `departamento_nombre` varchar(150) DEFAULT NULL,
  `solicitante_nombre` varchar(150) NOT NULL,
  `solicitante_cargo` varchar(150) DEFAULT NULL,
  `solicitante_telefono` varchar(50) DEFAULT NULL,
  `operativo_nombre` varchar(255) NOT NULL,
  `lugar_comision` varchar(255) NOT NULL,
  `fecha_salida` date NOT NULL,
  `fecha_devolucion_estimada` date NOT NULL,
  `fecha_devolucion_real` datetime DEFAULT NULL,
  `estado` enum('SOLICITADO','AUTORIZADO_EN_PRESTAMO','DEVUELTO','CANCELADO') NOT NULL DEFAULT 'SOLICITADO',
  `encargado_entrega` varchar(150) DEFAULT NULL,
  `encargado_recibe_devolucion` varchar(150) DEFAULT NULL,
  `observaciones_prestamo` text DEFAULT NULL,
  `observaciones_devolucion` text DEFAULT NULL,
  `usuario_id` int(11) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_vales_folio` (`folio`),
  KEY `idx_vales_rubro` (`rubro_id`),
  KEY `idx_vales_depto` (`departamento_id`),
  KEY `idx_vales_usuario` (`usuario_id`),
  KEY `idx_vales_estado` (`estado`),
  CONSTRAINT `fk_vales_rubro` FOREIGN KEY (`rubro_id`) REFERENCES `rubros_inventario` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla: vales_prestamo_detalle
CREATE TABLE `vales_prestamo_detalle` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `vale_id` int(11) NOT NULL,
  `articulo_id` int(11) DEFAULT NULL,
  `clave` varchar(60) DEFAULT NULL,
  `descripcion` varchar(255) NOT NULL,
  `serie` varchar(100) DEFAULT NULL,
  `marca` varchar(100) DEFAULT NULL,
  `modelo` varchar(100) DEFAULT NULL,
  `color` varchar(50) DEFAULT NULL,
  `cantidad` int(11) NOT NULL DEFAULT 1,
  `estado_salida` varchar(100) NOT NULL DEFAULT 'BUEN ESTADO',
  `estado_devolucion` varchar(100) NOT NULL DEFAULT 'PENDIENTE',
  `observaciones` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_vpd_vale` (`vale_id`),
  KEY `idx_vpd_art` (`articulo_id`),
  CONSTRAINT `fk_vpd_vale` FOREIGN KEY (`vale_id`) REFERENCES `vales_prestamo` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- 4. VISTAS DE REPORTE Y CONSULTA
-- =============================================================================

-- Vista: v_pendientes_por_oficialia
CREATE VIEW `v_pendientes_por_oficialia` AS
SELECT
  `o`.`nombre` AS `oficialia`,
  COUNT(DISTINCT `s`.`id`) AS `solicitudes`,
  SUM(COALESCE(`d`.`cantidad`, 0)) AS `solicitado`,
  SUM(COALESCE(`d`.`atendida`, 0)) AS `surtido`,
  SUM(COALESCE(`d`.`cantidad`, 0) - COALESCE(`d`.`atendida`, 0)) AS `pendiente`
FROM `solicitudes` `s`
JOIN `oficialias` `o` ON (`o`.`id` = `s`.`id_oficialia` AND `o`.`id_localidad` = `s`.`id_localidad`)
LEFT JOIN `detalles_solicitud` `d` ON (`d`.`solicitud_id` = `s`.`id`)
GROUP BY `o`.`nombre`
ORDER BY `pendiente` DESC, `solicitudes` DESC;

-- Vista: v_pendientes_por_usuario
CREATE VIEW `v_pendientes_por_usuario` AS
SELECT
  `u`.`username` AS `usuario`,
  COUNT(DISTINCT `s`.`id`) AS `solicitudes`,
  SUM(COALESCE(`d`.`cantidad`, 0)) AS `solicitado`,
  SUM(COALESCE(`d`.`atendida`, 0)) AS `surtido`,
  SUM(COALESCE(`d`.`cantidad`, 0) - COALESCE(`d`.`atendida`, 0)) AS `pendiente`
FROM `solicitudes` `s`
JOIN `usuario` `u` ON (`u`.`id` = `s`.`usuario_id`)
LEFT JOIN `detalles_solicitud` `d` ON (`d`.`solicitud_id` = `s`.`id`)
GROUP BY `u`.`username`
ORDER BY `pendiente` DESC, `solicitudes` DESC;

-- Vista: v_solicitudes_detalle
CREATE VIEW `v_solicitudes_detalle` AS
SELECT
  `s`.`id` AS `solicitud_id`,
  `s`.`fecha_solicitud` AS `fecha_solicitud`,
  `u`.`username` AS `Usuario`,
  CONCAT_WS(' ', `u`.`nombre`, `u`.`PRIMER_APELLIDO`, `u`.`SEGUNDO_APELLIDO`) AS `usuario_nombre`,
  `o`.`nombre` AS `oficialia`,
  `s`.`status` AS `status`,
  `d`.`id` AS `detalle_id`,
  `p`.`ID` AS `producto_id`,
  `p`.`CLAVE` AS `sku`,
  `p`.`DESCRIPCION` AS `producto`,
  `d`.`cantidad` AS `cantidad`,
  `d`.`atendida` AS `atendida`,
  (`d`.`cantidad` - `d`.`atendida`) AS `pendiente`,
  `d`.`observaciones` AS `observ_detalle`
FROM `solicitudes` `s`
JOIN `usuario` `u` ON (`u`.`id` = `s`.`usuario_id`)
JOIN `oficialias` `o` ON (`o`.`id` = `s`.`id_oficialia` AND `o`.`id_localidad` = `s`.`id_localidad`)
LEFT JOIN `detalles_solicitud` `d` ON (`d`.`solicitud_id` = `s`.`id`)
LEFT JOIN `productos` `p` ON (`p`.`ID` = `d`.`producto_id`)
ORDER BY `s`.`fecha_solicitud` DESC, `s`.`id` DESC, `d`.`id`;

-- Vista: v_solicitudes_inconsistentes
CREATE VIEW `v_solicitudes_inconsistentes` AS
SELECT
  `s`.`id` AS `id`,
  `s`.`id_oficialia` AS `id_oficialia`,
  `s`.`id_localidad` AS `id_localidad`,
  COUNT(`o`.`id`) AS `coincidencias_exactas`
FROM `solicitudes` `s`
LEFT JOIN `oficialias` `o` ON (`o`.`id_localidad` = `s`.`id_localidad` AND `o`.`id_tipo_oficialia` = `s`.`id_oficialia`)
GROUP BY `s`.`id`, `s`.`id_oficialia`, `s`.`id_localidad`
HAVING COUNT(`o`.`id`) = 0;

-- Vista: v_solicitudes_resumen
CREATE VIEW `v_solicitudes_resumen` AS
SELECT
  `s`.`id` AS `id`,
  `o`.`nombre` AS `oficialia`,
  `s`.`fecha_solicitud` AS `fecha_solicitud`,
  `s`.`tipo_solicitud` AS `tipo_solicitud`,
  `s`.`usuario_id` AS `usuario_id`,
  `s`.`id_oficialia` AS `id_oficialia`,
  `s`.`id_localidad` AS `id_localidad`,
  `u`.`username` AS `username`,
  `u`.`username` AS `Usuario`,
  CONCAT_WS(' ', `u`.`nombre`, `u`.`PRIMER_APELLIDO`, `u`.`SEGUNDO_APELLIDO`) AS `nombre_usuario`,
  CONCAT_WS(' ', `u`.`nombre`, `u`.`PRIMER_APELLIDO`, `u`.`SEGUNDO_APELLIDO`) AS `usuario_nombre`,
  `s`.`status` AS `status`,
  `s`.`fecha_surtido` AS `fecha_surtido`,
  `s`.`observaciones` AS `observaciones`,
  `s`.`region_solicitante` AS `region_solicitante`,
  `s`.`nombre_solicitante_firma` AS `nombre_solicitante_firma`,
  `s`.`firma_solicitante_data` AS `firma_solicitante_data`,
  `s`.`fecha_firma_digital` AS `fecha_firma_digital`,
  `s`.`folio_firma_digital` AS `folio_firma_digital`,
  COALESCE(`t`.`total_solicitado`, 0) AS `total_solicitado`,
  COALESCE(`t`.`total_surtido`, 0) AS `total_surtido`,
  (COALESCE(`t`.`total_solicitado`, 0) - COALESCE(`t`.`total_surtido`, 0)) AS `total_pendiente`
FROM `solicitudes` `s`
JOIN `usuario` `u` ON (`u`.`id` = `s`.`usuario_id`)
JOIN `oficialias` `o` ON (`o`.`id` = `s`.`id_oficialia` AND `o`.`id_localidad` = `s`.`id_localidad`)
LEFT JOIN (
  SELECT
    `detalles_solicitud`.`solicitud_id` AS `solicitud_id`,
    SUM(`detalles_solicitud`.`cantidad`) AS `total_solicitado`,
    SUM(`detalles_solicitud`.`atendida`) AS `total_surtido`
  FROM `detalles_solicitud`
  GROUP BY `detalles_solicitud`.`solicitud_id`
) `t` ON (`t`.`solicitud_id` = `s`.`id`)
ORDER BY `s`.`fecha_solicitud` DESC, `s`.`id` DESC;

-- Vista: v_stock
CREATE VIEW `v_stock` AS
SELECT
  `p`.`ID` AS `producto_id`,
  `p`.`CLAVE` AS `CLAVE`,
  `p`.`DESCRIPCION` AS `DESCRIPCION`,
  COALESCE(`c`.`descCategoria`, '(Sin categoria)') AS `categoria`,
  `um`.`DescUnidad` AS `unidad`,
  COALESCE(`p`.`MINIMO`, 0) AS `minimo`,
  COALESCE(`p`.`MAXIMO`, 0) AS `maximo`,
  COALESCE(`p`.`STOCK`, 0) AS `stock_producto`,
  COALESCE(`ap`.`stock_almacen`, 0) AS `stock_almacen`,
  COALESCE(`m`.`entradas`, 0) AS `entradas`,
  COALESCE(`m`.`salidas`, 0) AS `salidas`,
  COALESCE(`m`.`exist_calc`, 0) AS `exist_calc`,
  (COALESCE(`p`.`STOCK`, 0) - COALESCE(`m`.`exist_calc`, 0)) AS `diff_prod_vs_calc`,
  (COALESCE(`ap`.`stock_almacen`, 0) - COALESCE(`m`.`exist_calc`, 0)) AS `diff_alm_vs_calc`,
  CASE
    WHEN COALESCE(`ap`.`stock_almacen`, `p`.`STOCK`, `m`.`exist_calc`, 0) <= COALESCE(`p`.`MINIMO`, 0) THEN 'BAJO_MINIMO'
    WHEN COALESCE(`p`.`MAXIMO`, 999999999) > 0 AND COALESCE(`ap`.`stock_almacen`, `p`.`STOCK`, `m`.`exist_calc`, 0) >= COALESCE(`p`.`MAXIMO`, 999999999) THEN 'SOBRE_MAXIMO'
    ELSE 'OK'
  END AS `estado`
FROM `productos` `p`
LEFT JOIN `categorias` `c` ON (`c`.`idcategoria` = `p`.`CATEGORIA`)
LEFT JOIN `umedida` `um` ON (`um`.`idUnidad` = `p`.`UNIDAD`)
LEFT JOIN (
  SELECT
    `almacen_principal`.`producto_id` AS `producto_id`,
    SUM(COALESCE(`almacen_principal`.`STOCK`, 0)) AS `stock_almacen`
  FROM `almacen_principal`
  GROUP BY `almacen_principal`.`producto_id`
) `ap` ON (`ap`.`producto_id` = `p`.`ID`)
LEFT JOIN (
  SELECT
    `movimientos_inventario`.`producto_id` AS `producto_id`,
    SUM(CASE WHEN `movimientos_inventario`.`TIPO_MOVIMIENTO` = 'ENTRADA' THEN `movimientos_inventario`.`CANTIDAD` ELSE 0 END) AS `entradas`,
    SUM(CASE WHEN `movimientos_inventario`.`TIPO_MOVIMIENTO` = 'SALIDA' THEN `movimientos_inventario`.`CANTIDAD` ELSE 0 END) AS `salidas`,
    SUM(CASE WHEN `movimientos_inventario`.`TIPO_MOVIMIENTO` = 'ENTRADA' THEN `movimientos_inventario`.`CANTIDAD` WHEN `movimientos_inventario`.`TIPO_MOVIMIENTO` = 'SALIDA' THEN -`movimientos_inventario`.`CANTIDAD` ELSE 0 END) AS `exist_calc`
  FROM `movimientos_inventario`
  GROUP BY `movimientos_inventario`.`producto_id`
) `m` ON (`m`.`producto_id` = `p`.`ID`)
ORDER BY `p`.`CLAVE`;

SET FOREIGN_KEY_CHECKS = 1;
