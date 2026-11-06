-- =============================================================================
-- Semilla inicial para despliegue en Synology NAS (MariaDB / MySQL)
-- Incluye catálogos base, áreas/departamentos, usuarios, regiones, oficinas y rubros.
-- Limpia cualquier registro previo de "Órdenes de Material" e "Inventario".
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------------------------
-- 1. Limpieza de registros de "Órdenes de Material" e "Inventario"
-- -----------------------------------------------------------------------------
TRUNCATE TABLE `detalles_solicitud`;
TRUNCATE TABLE `solicitudes`;
TRUNCATE TABLE `movimientos_inventario`;
TRUNCATE TABLE `almacen_principal`;
TRUNCATE TABLE `almacen_dregcivil`;
TRUNCATE TABLE `productos`;
TRUNCATE TABLE `formatos_inventario_regional`;
TRUNCATE TABLE `prestamos_inventario`;
TRUNCATE TABLE `inventario_oficina`;
TRUNCATE TABLE `log_accesos`;

-- -----------------------------------------------------------------------------
-- 2. Catálogo de Departamentos / Oficialías
-- -----------------------------------------------------------------------------
INSERT INTO `oficialias`
(`id`, `id_tipo_oficialia`, `id_municipio`, `id_localidad`, `id_renapo`, `nombre`, `activo`, `direccion`, `telefono`, `oficial_reponsable`, `id_oficialia`)
VALUES
(30030000, 0, 0, 0, NULL, 'Administrador', b'1', NULL, NULL, 'Administrador', 30030000),
(30030001, 0, 0, 0, NULL, 'Recursos Materiales', b'1', NULL, NULL, 'Jorge Luis Patrón Murillo', 30030001),
(30030002, 0, 0, 0, NULL, 'Recursos Humanos', b'1', NULL, NULL, 'Jonathan Alain Olachea Noriega', 30030002),
(30030003, 0, 0, 0, NULL, 'Informática', b'1', NULL, NULL, 'Víctor Manuel Higuera Ruiz', 30030003),
(30030004, 0, 0, 0, NULL, 'Niñas y Niños', b'1', NULL, NULL, 'María de los Ángeles Valenzuela López', 30030004),
(30030005, 0, 0, 0, NULL, 'Salud Casa por Casa', b'1', NULL, NULL, 'Juan Carlos Cuadros Espinoza', 30030005),
(30030006, 0, 0, 0, NULL, 'Comunicación Social', b'1', NULL, NULL, 'Ericka Peralta Preciado', 30030006),
(30030007, 0, 0, 0, NULL, 'Programa de Adulto Mayor', b'1', NULL, NULL, 'Elizabeth González Wendy', 30030007),
(30030008, 0, 0, 0, NULL, 'Encargado de Inventario', b'1', NULL, NULL, 'Gabriel Adan Fiol Collins', 30030008),
(30030009, 0, 0, 0, NULL, 'Enlace Regional Los Cabos', b'1', NULL, NULL, 'Enlace Regional Los Cabos', 30030009),
(30030010, 0, 0, 0, NULL, 'Enlace Regional Mulegé', b'1', NULL, NULL, 'Diana Ramirez Hernandez', 30030010),
(30030011, 0, 0, 0, NULL, 'Enlace Regional Comondú / Loreto', b'1', NULL, NULL, 'Enlace Regional Comondú / Loreto', 30030011),
(30030012, 0, 0, 0, NULL, 'Asuntos Jurídicos', b'1', NULL, NULL, 'Mayra Cruz Salazar Escobosa', 30030012),
(30030013, 0, 0, 0, NULL, 'Jóvenes Construyendo el Futuro', b'1', NULL, NULL, 'Juan Daniel Carrera Villaseca', 30030013),
(30030014, 0, 0, 0, NULL, 'Programa de Discapacidad', b'1', NULL, NULL, 'Olga Camarillo Martínez', 30030014),
(30030015, 0, 0, 0, NULL, 'Dirección Regional La Paz', b'1', NULL, NULL, 'Sandra Guadalupe Salvatierra Amador', 30030015)
ON DUPLICATE KEY UPDATE
  `nombre` = VALUES(`nombre`),
  `activo` = VALUES(`activo`),
  `oficial_reponsable` = VALUES(`oficial_reponsable`),
  `id_oficialia` = VALUES(`id_oficialia`);

-- -----------------------------------------------------------------------------
-- 3. Usuarios iniciales del sistema (incluyendo Encargados Regionales, Enlaces Regionales y Jefes de Departamento)
-- Contraseña inicial homologada: secreta123
-- -----------------------------------------------------------------------------
INSERT INTO `usuario`
(`id`, `username`, `psw`, `nombre`, `PRIMER_APELLIDO`, `SEGUNDO_APELLIDO`, `ID_OFICIALIA`, `OFICIALIA_ID`, `ACTIVO`, `rol`, `FECHA_ALTA`, `usuario_id`, `departamento`, `rubro_id`, `region_id`, `oficina_id`)
VALUES
(1, 'admin', '$2b$10$TY9B5CJj8cwfJ66ndHgWs.sQaR.HnAMUnQEJfSigN.kVXzxXgDDt2', 'ADMIN', NULL, NULL, 30030000, 30030000, b'1', 'ADMIN', NOW(), NULL, 'ADMINISTRACION', NULL, 1, 1),
(2, 'encargado', '$2b$10$yXqfOZJ7GGrd9K5Xlfy8ROfz9FxZ346KQNjh2rXwCLZ1xyU64yCEy', 'Gabriel Adan', 'Fiol', 'Collins', 30030008, 30030008, b'1', 'ENCARGADO', NOW(), NULL, 'Encargado de Inventario', 1, 1, 1),
(3, 'departamento', '$2b$10$eZ4VRyWg6Ei1dOkMiJDi/uKVZJqEmnHJQHOdhlga34v1lct/gve0u', 'USUARIO', 'DEPARTAMENTO', NULL, 30030002, 30030002, b'1', 'USUARIO', NOW(), NULL, 'Recursos Humanos', NULL, 1, 1),
(4, 'gabrielfiol', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Gabriel Adan', 'Fiol', 'Collins', 30030008, 30030008, b'1', 'ENCARGADO', NOW(), NULL, 'ENCARGADO', 1, 1, 1),
(5, 'evelia', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Evelia', 'Contreras', 'Godinez', 30030001, 30030001, b'1', 'ENCARGADO', NOW(), NULL, 'ENCARGADO_REGIONAL', 2, 1, 1),
(6, 'jesus', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Jesus Salvador', 'Palacios', 'Martinez', 30030001, 30030001, b'1', 'ENCARGADO', NOW(), NULL, 'ENCARGADO_REGIONAL', 3, 1, 1),
(7, 'luiseduardo', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Luis Eduardo', 'Mayoral', 'Geraldo', 30030001, 30030001, b'1', 'ENCARGADO', NOW(), NULL, 'ENCARGADO_REGIONAL', 4, 1, 1),
(8, 'loscabos', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Enlace Regional', 'Los Cabos', NULL, 30030009, 30030009, b'1', 'USUARIO', NOW(), NULL, 'Enlace Regional Los Cabos', NULL, 2, 2),
(9, 'mulege', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Diana Ramirez Hernandez', 'Ramirez', 'Hernandez', 30030010, 30030010, b'1', 'USUARIO', NOW(), NULL, 'Enlace Regional Mulegé', NULL, 4, 9),
(10, 'rodrigo', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Rodrigo', 'Molina', 'Cosio', 30030001, 30030001, b'1', 'ENCARGADO', NOW(), NULL, 'Enlace del programa ''La Clínica es Nuestra''', NULL, 1, 1),
(11, 'jorge', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Jorge Luis', 'Patrón', 'Murillo', 30030001, 30030001, b'1', 'ENCARGADO', NOW(), NULL, 'Encargado de Recursos Materiales', NULL, 1, 1),
(12, 'comondu', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Enlace Regional Comondú / Loreto', '', '', 30030011, 30030011, b'1', 'USUARIO', NOW(), NULL, 'Enlace Regional Comondú / Loreto', NULL, 3, 6),
(13, 'informatica', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Víctor Manuel Higuera Ruiz', 'Higuera', 'Ruiz', 30030003, 30030003, b'1', 'USUARIO', NOW(), NULL, 'Informática', NULL, 1, 1),
(14, 'comunicacionsocial', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Ericka Peralta Preciado', 'Peralta', 'Preciado', 30030006, 30030006, b'1', 'USUARIO', NOW(), NULL, 'Comunicación Social', NULL, 1, 1),
(15, 'saludcasaporcasa', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Juan Carlos Cuadros Espinoza', 'Cuadros', 'Espinoza', 30030005, 30030005, b'1', 'USUARIO', NOW(), NULL, 'Salud Casa por Casa', NULL, 1, 1),
(16, 'asuntosjuridicos', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Mayra Cruz Salazar Escobosa', 'Salazar', 'Escobosa', 30030012, 30030012, b'1', 'USUARIO', NOW(), NULL, 'Asuntos Jurídicos', NULL, 1, 1),
(17, 'ninasyninos', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'María de los Ángeles Valenzuela López', 'Valenzuela', 'López', 30030004, 30030004, b'1', 'USUARIO', NOW(), NULL, 'Niñas y Niños', NULL, 1, 1),
(18, 'jovenes', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Juan Daniel Carrera Villaseca', 'Carrera', 'Villaseca', 30030013, 30030013, b'1', 'USUARIO', NOW(), NULL, 'Jóvenes Construyendo el Futuro', NULL, 1, 1),
(19, 'discapacidad', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Olga Camarillo Martínez', 'Camarillo', 'Martínez', 30030014, 30030014, b'1', 'USUARIO', NOW(), NULL, 'Programa de Discapacidad', NULL, 1, 1),
(20, 'adultomayor', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Elizabeth González Wendy', 'González', 'Wendy', 30030007, 30030007, b'1', 'USUARIO', NOW(), NULL, 'Programa de Adulto Mayor', NULL, 1, 1),
(21, 'direccionregional', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Sandra Guadalupe Salvatierra Amador', 'Salvatierra', 'Amador', 30030015, 30030015, b'1', 'USUARIO', NOW(), NULL, 'Dirección Regional La Paz', NULL, 1, 1)
ON DUPLICATE KEY UPDATE
  `username` = VALUES(`username`),
  `psw` = VALUES(`psw`),
  `nombre` = VALUES(`nombre`),
  `PRIMER_APELLIDO` = VALUES(`PRIMER_APELLIDO`),
  `SEGUNDO_APELLIDO` = VALUES(`SEGUNDO_APELLIDO`),
  `ID_OFICIALIA` = VALUES(`ID_OFICIALIA`),
  `OFICIALIA_ID` = VALUES(`OFICIALIA_ID`),
  `ACTIVO` = VALUES(`ACTIVO`),
  `rol` = VALUES(`rol`),
  `departamento` = VALUES(`departamento`),
  `rubro_id` = VALUES(`rubro_id`),
  `region_id` = VALUES(`region_id`),
  `oficina_id` = VALUES(`oficina_id`);

-- -----------------------------------------------------------------------------
-- 4. Categorías y Unidades de Medida base
-- -----------------------------------------------------------------------------
INSERT INTO `categorias` (`idcategoria`, `descCategoria`) VALUES
(1, 'GENERAL')
ON DUPLICATE KEY UPDATE `descCategoria` = VALUES(`descCategoria`);

INSERT INTO `umedida` (`idUnidad`, `DescUnidad`) VALUES
(1, 'PIEZA'),
(2, 'CAJA'),
(3, 'BLOCK'),
(4, 'PAQUETE')
ON DUPLICATE KEY UPDATE `DescUnidad` = VALUES(`DescUnidad`);

-- -----------------------------------------------------------------------------
-- 5. Fase B: Regiones, Oficinas Regionales y Rubros de Inventario (BCS)
-- -----------------------------------------------------------------------------
INSERT INTO `regiones` (`id`, `clave`, `nombre`, `responsable_regional`, `activo`) VALUES
(1, 'LA_PAZ', 'La Paz', 'Sandra Guadalupe Salvatierra Amador', 1),
(2, 'LOS_CABOS', 'Los Cabos', 'Samir Savin Ruiz', 1),
(3, 'COMONDU_LORETO', 'Comondú / Loreto', 'Humberto Arce Cordero', 1),
(4, 'MULEGE', 'Mulegé', 'Diana Ramirez Hernandez', 1)
ON DUPLICATE KEY UPDATE
  `nombre` = VALUES(`nombre`),
  `responsable_regional` = VALUES(`responsable_regional`),
  `activo` = VALUES(`activo`);

INSERT INTO `oficinas_regionales` (`id`, `region_id`, `municipio`, `nombre`, `responsable_oficina`, `activo`) VALUES
(1, 1, 'La Paz', 'Delegación La Paz', NULL, 1),
(2, 2, 'San José del Cabo', 'Guaymitas', NULL, 1),
(3, 2, 'San José del Cabo', 'SADER', NULL, 1),
(4, 2, 'Cabo San Lucas', 'PEC Caribe', NULL, 1),
(5, 2, 'Cabo San Lucas', 'Cangrejos', NULL, 1),
(6, 3, 'Comondú', 'Ciudad Constitución', NULL, 1),
(7, 3, 'Comondú', 'Ciudad Insurgentes', NULL, 1),
(8, 3, 'Loreto', 'Loreto', NULL, 1),
(9, 4, 'Mulegé', 'Santa Rosalía', NULL, 1),
(10, 4, 'Mulegé', 'Vizcaíno', NULL, 1),
(11, 4, 'Mulegé', 'Guerrero Negro', NULL, 1),
(12, 1, 'La Paz', 'S/A (Sin Asignar)', 'Por asignar', 1),
(13, 2, 'Los Cabos', 'S/A (Sin Asignar)', 'Por asignar', 1),
(14, 3, 'Comondú / Loreto', 'S/A (Sin Asignar)', 'Por asignar', 1),
(15, 4, 'Mulegé', 'S/A (Sin Asignar)', 'Por asignar', 1)
ON DUPLICATE KEY UPDATE
  `region_id` = VALUES(`region_id`),
  `municipio` = VALUES(`municipio`),
  `nombre` = VALUES(`nombre`),
  `responsable_oficina` = VALUES(`responsable_oficina`),
  `activo` = VALUES(`activo`);

INSERT INTO `rubros_inventario` (`id`, `codigo`, `nombre_rubro`, `encargado_nombre`, `encargado_cargo`, `activo`) VALUES
(1, 'ARCHIVO_MATERIALES', 'Archivo y Materiales', 'Gabriel Adan Fiol Collins', 'Encargado de archivo y materiales', 1),
(2, 'PARQUE_VEHICULAR', 'Parque Vehicular', 'Evelia Contreras Godinez', 'Encargada de parque vehicular', 1),
(3, 'MOBILIARIO', 'Mobiliario, Equipo y Consumibles Eventos', 'Jesus Salvador Palacios Martinez', 'Encargado de mobiliario', 1),
(4, 'TABLETS_STARLINKS', 'Tablets y Starlinks', 'Luis Eduardo Mayoral Geraldo', 'Encargado de Tablets y Starlinks', 1)
ON DUPLICATE KEY UPDATE
  `codigo` = VALUES(`codigo`),
  `nombre_rubro` = VALUES(`nombre_rubro`),
  `encargado_nombre` = VALUES(`encargado_nombre`),
  `encargado_cargo` = VALUES(`encargado_cargo`),
  `activo` = VALUES(`activo`);

SET FOREIGN_KEY_CHECKS = 1;
