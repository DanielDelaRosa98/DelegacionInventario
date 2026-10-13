-- Esquema limpio para Inventario Consumibles
-- Generado sin datos reales.

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS=0;

DROP VIEW IF EXISTS `v_stock`;
DROP VIEW IF EXISTS `v_solicitudes_resumen`;
DROP VIEW IF EXISTS `v_solicitudes_inconsistentes`;
DROP VIEW IF EXISTS `v_solicitudes_detalle`;
DROP VIEW IF EXISTS `v_pendientes_por_usuario`;
DROP VIEW IF EXISTS `v_pendientes_por_oficialia`;
DROP TABLE IF EXISTS `usuario`;
DROP TABLE IF EXISTS `umedida`;
DROP TABLE IF EXISTS `solicitudes`;
DROP TABLE IF EXISTS `productos`;
DROP TABLE IF EXISTS `oficialias`;
DROP TABLE IF EXISTS `movimientos_inventario`;
DROP TABLE IF EXISTS `detalles_solicitud`;
DROP TABLE IF EXISTS `categorias`;
DROP TABLE IF EXISTS `almacen_principal`;
DROP TABLE IF EXISTS `almacen_dregcivil`;



-- Tabla: almacen_dregcivil
CREATE TABLE `almacen_dregcivil` (
  `ID` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `CLAVE` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `DESCRIPCION` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `CATEGORIA_ID` int(10) unsigned DEFAULT NULL,
  `CATEGORIA` varchar(50) DEFAULT NULL,
  `UNIDAD` varchar(20) DEFAULT NULL,
  `STOCK` int(11) DEFAULT NULL,
  `ESTADO` enum('ACTIVO','INACTIVO') NOT NULL DEFAULT 'ACTIVO',
  PRIMARY KEY (`ID`),
  UNIQUE KEY `ux_clave` (`CLAVE`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Tabla: almacen_principal
CREATE TABLE `almacen_principal` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `producto_id` int(11) UNSIGNED NOT NULL,
  `DescAlmacen` varchar(100) NOT NULL DEFAULT 'Principal',
  `STOCK` int(11) NOT NULL DEFAULT '0',
  PRIMARY KEY (`ID`),
  UNIQUE KEY `CATALOGO_ID` (`producto_id`) USING BTREE,
  CONSTRAINT `fk_almacen_catalogo` FOREIGN KEY (`producto_id`) REFERENCES `productos` (`ID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- Tabla: categorias
CREATE TABLE `categorias` (
  `idcategoria` int(11) NOT NULL AUTO_INCREMENT,
  `descCategoria` varchar(100) DEFAULT NULL,
  PRIMARY KEY (`idcategoria`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Tabla: detalles_solicitud
CREATE TABLE `detalles_solicitud` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `solicitud_id` bigint(20) UNSIGNED NOT NULL,
  `producto_id` int(11) UNSIGNED NOT NULL,
  `cantidad` int(11) NOT NULL,
  `atendida` int(11) NOT NULL DEFAULT '0',
  `observaciones` varchar(300) DEFAULT NULL,
  `creado_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actualizado_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_det_sol` (`solicitud_id`),
  KEY `idx_det_prod` (`producto_id`),
  CONSTRAINT `fk_det_prod` FOREIGN KEY (`producto_id`) REFERENCES `productos` (`ID`),
  CONSTRAINT `fk_det_sol` FOREIGN KEY (`solicitud_id`) REFERENCES `solicitudes` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Tabla: movimientos_inventario
CREATE TABLE `movimientos_inventario` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `producto_id` int(11) NOT NULL,
  `TIPO_MOVIMIENTO` enum('ENTRADA','SALIDA') NOT NULL,
  `CANTIDAD` int(11) NOT NULL,
  `FECHA` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `RESPONSABLE` varchar(100) DEFAULT NULL,
  `DESTINO` varchar(100) DEFAULT NULL,
  `REFERENCIA` varchar(255) DEFAULT NULL,
  `OBSERVACIONES` text,
  PRIMARY KEY (`ID`),
  KEY `idx_mov_cat_fecha` (`producto_id`,`FECHA`) USING BTREE,
  CONSTRAINT `fk_mov_cat` FOREIGN KEY (`producto_id`) REFERENCES `productos` (`ID`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Tabla: oficialias
CREATE TABLE `oficialias` (
  `id` int(11) NOT NULL DEFAULT '0',
  `id_tipo_oficialia` smallint(6) NOT NULL,
  `id_municipio` int(11) NOT NULL,
  `id_localidad` int(11) DEFAULT NULL,
  `id_renapo` smallint(6) DEFAULT NULL,
  `nombre` varchar(255) CHARACTER SET utf8 NOT NULL,
  `activo` bit(1) DEFAULT NULL,
  `direccion` varchar(100) CHARACTER SET utf8 DEFAULT NULL,
  `telefono` varchar(20) CHARACTER SET utf8 DEFAULT NULL,
  `oficial_reponsable` varchar(50) CHARACTER SET utf8 DEFAULT NULL,
  `id_oficialia` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ofi_id_loc` (`id`,`id_localidad`),
  UNIQUE KEY `uq_ofi_id_loc2` (`id`,`id_localidad`),
  KEY `idx_oficialias_tipo` (`id_tipo_oficialia`),
  KEY `idx_oficialias_id_tipo_oficialia` (`id_tipo_oficialia`),
  KEY `idx_oficialias_id_localidad` (`id_localidad`),
  KEY `idx_ofi_tipo_loc` (`id_tipo_oficialia`,`id_localidad`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Tabla: productos
CREATE TABLE `productos` (
  `ID` int(11) UNSIGNED NOT NULL AUTO_INCREMENT,
  `CLAVE` varchar(10) NOT NULL,
  `DESCRIPCION` varchar(255) NOT NULL,
  `PARTIDA` varchar(30) DEFAULT NULL,
  `CATEGORIA` int(11) NOT NULL,
  `MINIMO` int(11) DEFAULT '0',
  `MAXIMO` int(11) DEFAULT '0',
  `UNIDAD` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `PRECIO` decimal(10,2) DEFAULT NULL,
  `STOCK` int(11) DEFAULT '0',
  `Status` varchar(50) DEFAULT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `unq_clave_categoria` (`CLAVE`,`CATEGORIA`) USING BTREE,
  KEY `idx_productos_ID` (`ID`),
  KEY `idx_prod_clave_cat` (`CLAVE`,`CATEGORIA`) USING BTREE,
  KEY `fk_prod_categoria` (`CATEGORIA`),
  CONSTRAINT `fk_prod_categoria` FOREIGN KEY (`CATEGORIA`) REFERENCES `categorias` (`idcategoria`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Tabla: solicitudes
CREATE TABLE `solicitudes` (
  `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `tipo_solicitud` varchar(50) NOT NULL,
  `fecha_solicitud` date NOT NULL,
  `id_oficialia` int(11) NOT NULL,
  `id_localidad` int(11) NOT NULL,
  `status` enum('PENDIENTE','APROBADA','SURTIDA','RECHAZADA','CANCELADA') NOT NULL DEFAULT 'PENDIENTE',
  `fecha_surtido` date DEFAULT NULL,
  `observaciones` varchar(500) DEFAULT NULL,
  `creado_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actualizado_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `usuario_id` int(11) UNSIGNED NOT NULL,
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
  CONSTRAINT `fk_sol_usuario_ofi_ok` FOREIGN KEY (`usuario_id`, `id_oficialia`) REFERENCES `usuario` (`id`, `ID_OFICIALIA`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Tabla: umedida
CREATE TABLE `umedida` (
  `idUnidad` int(11) NOT NULL,
  `DescUnidad` varchar(50) NOT NULL,
  PRIMARY KEY (`idUnidad`),
  UNIQUE KEY `uq_umedida_desc` (`DescUnidad`),
  UNIQUE KEY `uq_umedida_d` (`DescUnidad`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Tabla: usuario
CREATE TABLE `usuario` (
  `id` int(11) UNSIGNED NOT NULL DEFAULT '0',
  `username` varchar(255) CHARACTER SET utf8 DEFAULT NULL,
  `psw` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `nombre` varchar(255) CHARACTER SET utf8 DEFAULT NULL,
  `PRIMER_APELLIDO` varchar(255) CHARACTER SET utf8 DEFAULT NULL,
  `SEGUNDO_APELLIDO` varchar(255) CHARACTER SET utf8 DEFAULT NULL,
  `ID_OFICIALIA` int(11) DEFAULT NULL,
  `OFICIALIA_ID` int(11) DEFAULT NULL,
  `ACTIVO` bit(1) DEFAULT NULL,
  `FECHA_ALTA` datetime DEFAULT NULL,
  `usuario_id` int(11) UNSIGNED DEFAULT NULL,
  `departamento` varchar(255) DEFAULT NULL,
  UNIQUE KEY `uq_usuario_id_ofi` (`id`,`OFICIALIA_ID`),
  UNIQUE KEY `uq_usuario_id_ofi2` (`id`,`OFICIALIA_ID`),
  UNIQUE KEY `uq_usuario_id_ofi_ok` (`id`,`ID_OFICIALIA`),
  KEY `idx_usuario_id` (`id`),
  KEY `FK_usuario_usuario` (`usuario_id`),
  KEY `fk_usuario_oficialia_pk2` (`OFICIALIA_ID`),
  KEY `fk_usuario_id_oficialia_pk` (`ID_OFICIALIA`),
  CONSTRAINT `fk_usuario_id_oficialia_pk` FOREIGN KEY (`ID_OFICIALIA`) REFERENCES `oficialias` (`id`),
  CONSTRAINT `fk_usuario_oficialia_pk` FOREIGN KEY (`OFICIALIA_ID`) REFERENCES `oficialias` (`id`),
  CONSTRAINT `fk_usuario_oficialia_pk2` FOREIGN KEY (`OFICIALIA_ID`) REFERENCES `oficialias` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Vista: v_pendientes_por_oficialia
CREATE VIEW `v_pendientes_por_oficialia` AS select `o`.`nombre` AS `oficialia`,count(distinct `s`.`id`) AS `solicitudes`,sum(coalesce(`d`.`cantidad`,0)) AS `solicitado`,sum(coalesce(`d`.`atendida`,0)) AS `surtido`,sum((coalesce(`d`.`cantidad`,0) - coalesce(`d`.`atendida`,0))) AS `pendiente` from ((`solicitudes` `s` join `oficialias` `o` on(((`o`.`id` = `s`.`id_oficialia`) and (`o`.`id_localidad` = `s`.`id_localidad`)))) left join `detalles_solicitud` `d` on((`d`.`solicitud_id` = `s`.`id`))) group by `o`.`nombre` order by `pendiente` desc,`solicitudes` desc;

-- Vista: v_pendientes_por_usuario
CREATE VIEW `v_pendientes_por_usuario` AS select `u`.`username` AS `usuario`,count(distinct `s`.`id`) AS `solicitudes`,sum(coalesce(`d`.`cantidad`,0)) AS `solicitado`,sum(coalesce(`d`.`atendida`,0)) AS `surtido`,sum((coalesce(`d`.`cantidad`,0) - coalesce(`d`.`atendida`,0))) AS `pendiente` from ((`solicitudes` `s` join `usuario` `u` on((`u`.`id` = `s`.`usuario_id`))) left join `detalles_solicitud` `d` on((`d`.`solicitud_id` = `s`.`id`))) group by `u`.`username` order by `pendiente` desc,`solicitudes` desc;

-- Vista: v_solicitudes_detalle
CREATE VIEW `v_solicitudes_detalle` AS select `s`.`id` AS `solicitud_id`,`s`.`fecha_solicitud` AS `fecha_solicitud`,`u`.`username` AS `Usuario`,concat_ws(' ',`u`.`nombre`,`u`.`PRIMER_APELLIDO`,`u`.`SEGUNDO_APELLIDO`) AS `usuario_nombre`,`o`.`nombre` AS `oficialia`,`s`.`status` AS `status`,`d`.`id` AS `detalle_id`,`p`.`ID` AS `producto_id`,`p`.`CLAVE` AS `sku`,`p`.`DESCRIPCION` AS `producto`,`d`.`cantidad` AS `cantidad`,`d`.`atendida` AS `atendida`,(`d`.`cantidad` - `d`.`atendida`) AS `pendiente`,`d`.`observaciones` AS `observ_detalle` from ((((`solicitudes` `s` join `usuario` `u` on((`u`.`id` = `s`.`usuario_id`))) join `oficialias` `o` on(((`o`.`id` = `s`.`id_oficialia`) and (`o`.`id_localidad` = `s`.`id_localidad`)))) left join `detalles_solicitud` `d` on((`d`.`solicitud_id` = `s`.`id`))) left join `productos` `p` on((`p`.`ID` = `d`.`producto_id`))) order by `s`.`fecha_solicitud` desc,`s`.`id` desc,`d`.`id`;

-- Vista: v_solicitudes_inconsistentes
CREATE VIEW `v_solicitudes_inconsistentes` AS select `s`.`id` AS `id`,`s`.`id_oficialia` AS `id_oficialia`,`s`.`id_localidad` AS `id_localidad`,count(`o`.`id`) AS `coincidencias_exactas` from (`solicitudes` `s` left join `oficialias` `o` on(((`o`.`id_localidad` = `s`.`id_localidad`) and (`o`.`id_tipo_oficialia` = `s`.`id_oficialia`)))) group by `s`.`id`,`s`.`id_oficialia`,`s`.`id_localidad` having (count(`o`.`id`) = 0);

-- Vista: v_solicitudes_resumen
CREATE VIEW `v_solicitudes_resumen` AS select `s`.`id` AS `id`,`o`.`nombre` AS `oficialia`,`s`.`fecha_solicitud` AS `fecha_solicitud`,`u`.`username` AS `Usuario`,concat_ws(' ',`u`.`nombre`,`u`.`PRIMER_APELLIDO`,`u`.`SEGUNDO_APELLIDO`) AS `usuario_nombre`,`s`.`status` AS `status`,`s`.`fecha_surtido` AS `fecha_surtido`,coalesce(`t`.`total_solicitado`,0) AS `total_solicitado`,coalesce(`t`.`total_surtido`,0) AS `total_surtido`,(coalesce(`t`.`total_solicitado`,0) - coalesce(`t`.`total_surtido`,0)) AS `total_pendiente` from (((`solicitudes` `s` join `usuario` `u` on((`u`.`id` = `s`.`usuario_id`))) join `oficialias` `o` on(((`o`.`id` = `s`.`id_oficialia`) and (`o`.`id_localidad` = `s`.`id_localidad`)))) left join (select `detalles_solicitud`.`solicitud_id` AS `solicitud_id`,sum(`detalles_solicitud`.`cantidad`) AS `total_solicitado`,sum(`detalles_solicitud`.`atendida`) AS `total_surtido` from `detalles_solicitud` group by `detalles_solicitud`.`solicitud_id`) `t` on((`t`.`solicitud_id` = `s`.`id`))) order by `s`.`fecha_solicitud` desc,`s`.`id` desc;

-- Vista: v_stock
CREATE VIEW `v_stock` AS select `p`.`ID` AS `producto_id`,`p`.`CLAVE` AS `CLAVE`,`p`.`DESCRIPCION` AS `DESCRIPCION`,coalesce(`c`.`descCategoria`,'(Sin categoria)') AS `categoria`,`um`.`DescUnidad` AS `unidad`,coalesce(`p`.`MINIMO`,0) AS `minimo`,coalesce(`p`.`MAXIMO`,0) AS `maximo`,coalesce(`p`.`STOCK`,0) AS `stock_producto`,coalesce(`ap`.`stock_almacen`,0) AS `stock_almacen`,coalesce(`m`.`entradas`,0) AS `entradas`,coalesce(`m`.`salidas`,0) AS `salidas`,coalesce(`m`.`exist_calc`,0) AS `exist_calc`,(coalesce(`p`.`STOCK`,0) - coalesce(`m`.`exist_calc`,0)) AS `diff_prod_vs_calc`,(coalesce(`ap`.`stock_almacen`,0) - coalesce(`m`.`exist_calc`,0)) AS `diff_alm_vs_calc`,(case when (coalesce(`ap`.`stock_almacen`,`p`.`STOCK`,`m`.`exist_calc`,0) <= coalesce(`p`.`MINIMO`,0)) then 'BAJO_MINIMO' when ((coalesce(`p`.`MAXIMO`,999999999) > 0) and (coalesce(`ap`.`stock_almacen`,`p`.`STOCK`,`m`.`exist_calc`,0) >= coalesce(`p`.`MAXIMO`,999999999))) then 'SOBRE_MAXIMO' else 'OK' end) AS `estado` from ((((`productos` `p` left join `categorias` `c` on((`c`.`idcategoria` = `p`.`CATEGORIA`))) left join `umedida` `um` on((`um`.`idUnidad` = `p`.`UNIDAD`))) left join (select `almacen_principal`.`producto_id` AS `producto_id`,sum(coalesce(`almacen_principal`.`STOCK`,0)) AS `stock_almacen` from `almacen_principal` group by `almacen_principal`.`producto_id`) `ap` on((`ap`.`producto_id` = `p`.`ID`))) left join (select `movimientos_inventario`.`producto_id` AS `producto_id`,sum((case when (`movimientos_inventario`.`TIPO_MOVIMIENTO` = 'ENTRADA') then `movimientos_inventario`.`CANTIDAD` else 0 end)) AS `entradas`,sum((case when (`movimientos_inventario`.`TIPO_MOVIMIENTO` = 'SALIDA') then `movimientos_inventario`.`CANTIDAD` else 0 end)) AS `salidas`,sum((case when (`movimientos_inventario`.`TIPO_MOVIMIENTO` = 'ENTRADA') then `movimientos_inventario`.`CANTIDAD` when (`movimientos_inventario`.`TIPO_MOVIMIENTO` = 'SALIDA') then -(`movimientos_inventario`.`CANTIDAD`) else 0 end)) AS `exist_calc` from `movimientos_inventario` group by `movimientos_inventario`.`producto_id`) `m` on((`m`.`producto_id` = `p`.`ID`))) order by `p`.`CLAVE`;

SET FOREIGN_KEY_CHECKS=1;

