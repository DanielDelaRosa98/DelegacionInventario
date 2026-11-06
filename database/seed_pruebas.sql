-- =============================================================================
-- Semilla de Datos de Prueba (seed_pruebas.sql)
-- Sistema de Control de Inventario y Resguardo Regional — Delegación BCS
-- Nota: No elimina usuarios ni catálogos base; inserta/actualiza datos de prueba
-- para Almacén, Vales con Firma Digital e Inventario Regional (4 Rubros y 4 Regiones).
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------------------------
-- 1. Asegurar Categorías, Unidades, Oficialías, Regiones, Oficinas, Rubros y 4 Encargados
-- -----------------------------------------------------------------------------
INSERT INTO `categorias` (`idcategoria`, `descCategoria`) VALUES
(1, 'PAPELERIA'),
(2, 'CONSUMIBLES COMPUTO'),
(3, 'LIMPIEZA E INSUMOS'),
(4, 'ARCHIVO Y OFICINA')
ON DUPLICATE KEY UPDATE `descCategoria` = VALUES(`descCategoria`);

INSERT INTO `umedida` (`idUnidad`, `DescUnidad`) VALUES
(1, 'PIEZA'),
(2, 'CAJA'),
(3, 'BLOCK'),
(4, 'PAQUETE'),
(5, 'ROLLO'),
(6, 'LITRO'),
(7, 'JUEGO')
ON DUPLICATE KEY UPDATE `DescUnidad` = VALUES(`DescUnidad`);

INSERT INTO `oficialias`
(`id`, `id_tipo_oficialia`, `id_municipio`, `id_localidad`, `id_renapo`, `nombre`, `activo`, `direccion`, `telefono`, `oficial_reponsable`, `id_oficialia`)
VALUES
(30030000, 0, 0, 0, NULL, 'Administrador', b'1', NULL, NULL, 'Administrador', 30030000),
(30030001, 0, 0, 0, NULL, 'Recursos Materiales', b'1', NULL, NULL, 'Jorge Luis Patron Murrillo', 30030001),
(30030002, 0, 0, 0, NULL, 'Recursos Humanos', b'1', NULL, NULL, 'Jonathan Alain Olachea Noriega', 30030002),
(30030003, 0, 0, 0, NULL, 'Informática', b'1', NULL, NULL, 'Victor Manuel Higuera Ruiz', 30030003),
(30030004, 0, 0, 0, NULL, 'Niñas y Niños', b'1', NULL, NULL, 'Maria de los Angeles Valenzuela Lopez', 30030004),
(30030005, 0, 0, 0, NULL, 'Salud casa por casa', b'1', NULL, NULL, 'Juan Carlos Cuadros Espinoza', 30030005),
(30030006, 0, 0, 0, NULL, 'Comunicación Social', b'1', NULL, NULL, 'Erika Peralta Preciado', 30030006),
(30030007, 0, 0, 0, NULL, 'Programa adultos Mayores', b'1', NULL, NULL, 'Elizabeth Gonzalez Wendy', 30030007),
(30030008, 0, 0, 0, NULL, 'Encargado de Inventario', b'1', NULL, NULL, 'Gabriel Adan Fiol Collins', 30030008)
ON DUPLICATE KEY UPDATE
  `nombre` = VALUES(`nombre`),
  `activo` = VALUES(`activo`),
  `oficial_reponsable` = VALUES(`oficial_reponsable`);

INSERT INTO `regiones` (`id`, `clave`, `nombre`, `responsable_regional`, `activo`) VALUES
(1, 'LA_PAZ', 'La Paz', 'Sandra Guadalupe Salvatierra Amador', 1),
(2, 'LOS_CABOS', 'Los Cabos', 'Samir Savin Ruiz', 1),
(3, 'COMONDU_LORETO', 'Comondú / Loreto', 'Humberto Arce Cordero', 1),
(4, 'MULEGE', 'Mulegé', 'Roberto Carlos Leree Osuna', 1)
ON DUPLICATE KEY UPDATE
  `nombre` = VALUES(`nombre`),
  `responsable_regional` = VALUES(`responsable_regional`),
  `activo` = VALUES(`activo`);

INSERT INTO `oficinas_regionales` (`id`, `region_id`, `municipio`, `nombre`, `responsable_oficina`, `activo`) VALUES
(1, 1, 'La Paz', 'Delegación La Paz', 'Sandra Guadalupe Salvatierra Amador', 1),
(2, 2, 'San José del Cabo', 'Guaymitas', 'Samir Savin Ruiz', 1),
(3, 2, 'San José del Cabo', 'San José del Cabo Centro', 'Samir Savin Ruiz', 1),
(4, 2, 'Cabo San Lucas', 'PEC Caribe', 'Samir Savin Ruiz', 1),
(5, 2, 'Cabo San Lucas', 'Cangrejos', 'Samir Savin Ruiz', 1),
(6, 3, 'Comondú', 'Ciudad Constitución', 'Humberto Arce Cordero', 1),
(7, 3, 'Comondú', 'Ciudad Insurgentes', 'Humberto Arce Cordero', 1),
(8, 3, 'Loreto', 'Loreto', 'Humberto Arce Cordero', 1),
(9, 4, 'Mulegé', 'Santa Rosalía', 'Roberto Carlos Leree Osuna', 1),
(10, 4, 'Mulegé', 'Vizcaíno', 'Roberto Carlos Leree Osuna', 1)
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
(4, 'POR_DEFINIR', 'Rubro Especial (Por definir)', 'Luis Eduardo Mayoral Geraldo', 'Encargado (Por definir)', 1)
ON DUPLICATE KEY UPDATE
  `nombre_rubro` = VALUES(`nombre_rubro`),
  `encargado_nombre` = VALUES(`encargado_nombre`),
  `encargado_cargo` = VALUES(`encargado_cargo`),
  `activo` = VALUES(`activo`);

INSERT INTO `usuario`
(`id`, `username`, `psw`, `nombre`, `PRIMER_APELLIDO`, `SEGUNDO_APELLIDO`, `ID_OFICIALIA`, `OFICIALIA_ID`, `ACTIVO`, `rol`, `FECHA_ALTA`, `usuario_id`, `departamento`, `rubro_id`)
VALUES
(1, 'admin', '$2b$10$TY9B5CJj8cwfJ66ndHgWs.sQaR.HnAMUnQEJfSigN.kVXzxXgDDt2', 'ADMIN', NULL, NULL, 30030000, 30030000, b'1', 'ADMIN', NOW(), NULL, 'ADMINISTRACION', NULL),
(2, 'encargado', '$2b$10$yXqfOZJ7GGrd9K5Xlfy8ROfz9FxZ346KQNjh2rXwCLZ1xyU64yCEy', 'Gabriel Adan', 'Fiol', 'Collins', 30030008, 30030008, b'1', 'ENCARGADO', NOW(), NULL, 'Encargado de Inventario', 1),
(3, 'departamento', '$2b$10$eZ4VRyWg6Ei1dOkMiJDi/uKVZJqEmnHJQHOdhlga34v1lct/gve0u', 'USUARIO', 'DEPARTAMENTO', NULL, 30030002, 30030002, b'1', 'USUARIO', NOW(), NULL, 'Recursos Humanos', NULL),
(4, 'gabrielfiol', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Gabriel Adan', 'Fiol', 'Collins', 30030008, 30030008, b'1', 'ENCARGADO', NOW(), NULL, 'ENCARGADO', 1),
(5, 'evelia', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Evelia', 'Contreras', 'Godinez', 30030001, 30030001, b'1', 'ENCARGADO', NOW(), NULL, 'ENCARGADO_REGIONAL', 2),
(6, 'jesus', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Jesus Salvador', 'Palacios', 'Martinez', 30030001, 30030001, b'1', 'ENCARGADO', NOW(), NULL, 'ENCARGADO_REGIONAL', 3),
(7, 'luiseduardo', '$2b$10$SZGrole0cpmLunsm4IXiI.3kv/VyiDRGab94yLicE2EYF1/0ZS8Pm', 'Luis Eduardo', 'Mayoral', 'Geraldo', 30030001, 30030001, b'1', 'ENCARGADO', NOW(), NULL, 'ENCARGADO_REGIONAL', 4)
ON DUPLICATE KEY UPDATE
  `nombre` = VALUES(`nombre`),
  `PRIMER_APELLIDO` = VALUES(`PRIMER_APELLIDO`),
  `SEGUNDO_APELLIDO` = VALUES(`SEGUNDO_APELLIDO`),
  `ACTIVO` = VALUES(`ACTIVO`),
  `rol` = VALUES(`rol`),
  `rubro_id` = VALUES(`rubro_id`);

-- -----------------------------------------------------------------------------
-- 2. Productos de Almacén (14 artículos de Papelería, Consumibles y Limpieza)
-- -----------------------------------------------------------------------------
INSERT INTO `productos` (`ID`, `CLAVE`, `DESCRIPCION`, `PARTIDA`, `CATEGORIA`, `MINIMO`, `MAXIMO`, `UNIDAD`, `PRECIO`, `STOCK`, `Status`) VALUES
(1,  'CL-001', 'CAJA DE PAPEL BOND BLANCO TAMAÑO CARTA (5000 HOJAS)', '21101', 1, 10, 200, 'CAJA',    890.00, 85,  'ACTIVO'),
(2,  'CL-002', 'CAJA DE PAPEL BOND BLANCO TAMAÑO OFICIO (5000 HOJAS)', '21101', 1, 5,  100, 'CAJA',    980.00, 42,  'ACTIVO'),
(3,  'CL-003', 'BOLÍGRAFO PUNTO MEDIANO TINTA AZUL (CAJA C/12 PZAS)',  '21101', 1, 15, 150, 'CAJA',     68.00, 96,  'ACTIVO'),
(4,  'CL-004', 'BOLÍGRAFO PUNTO MEDIANO TINTA NEGRA (CAJA C/12 PZAS)', '21101', 1, 15, 150, 'CAJA',     68.00, 74,  'ACTIVO'),
(5,  'CL-005', 'CARPETA LEFORT TAMAÑO CARTA LOMO ANCHO',               '21101', 4, 20, 300, 'PIEZA',    45.00, 160, 'ACTIVO'),
(6,  'CL-006', 'CAJA DE ARCHIVO MUERTO TAMAÑO OFICIO CARTÓN REFORZADO','21101', 4, 20, 400, 'PIEZA',    52.00, 210, 'ACTIVO'),
(7,  'CL-007', 'CARTUCHO DE TÓNER LÁSER NEGRO ALTO RENDIMIENTO 85A',   '21401', 2, 5,  50,  'PIEZA',  1250.00, 24,  'ACTIVO'),
(8,  'CL-008', 'CARTUCHO DE TÓNER LÁSER NEGRO 58A PARA IMPRESORA HP',  '21401', 2, 5,  40,  'PIEZA',  1680.00, 18,  'ACTIVO'),
(9,  'CL-009', 'PAQUETE DE FÓLDER CREMA TAMAÑO CARTA (100 PIEZAS)',    '21101', 1, 10, 120, 'PAQUETE', 165.00, 65,  'ACTIVO'),
(10, 'CL-010', 'ENGRAPADORA METÁLICA DE OFICINA USO RUDO',             '21101', 1, 8,  60,  'PIEZA',   145.00, 32,  'ACTIVO'),
(11, 'CL-011', 'CAJA DE GRAPAS ESTÁNDAR GALVANIZADAS (5000 GRAPAS)',   '21101', 1, 15, 150, 'CAJA',     38.00, 110, 'ACTIVO'),
(12, 'CL-012', 'CINTA ADHESIVA TRANSPARENTE 48MM X 150M',              '21101', 4, 15, 150, 'ROLLO',    34.00, 88,  'ACTIVO'),
(13, 'CL-013', 'PAPEL HIGIÉNICO JUMBO INSTITUCIONAL (PAQUETE C/4)',    '21601', 3, 12, 120, 'PAQUETE', 195.00, 54,  'ACTIVO'),
(14, 'CL-014', 'LIMPIADOR MULTIUSOS DESINFECTANTE GALÓN 4 LITROS',     '21601', 3, 10, 80,  'PIEZA',   130.00, 39,  'ACTIVO')
ON DUPLICATE KEY UPDATE
  `DESCRIPCION` = VALUES(`DESCRIPCION`),
  `CATEGORIA` = VALUES(`CATEGORIA`),
  `UNIDAD` = VALUES(`UNIDAD`),
  `STOCK` = VALUES(`STOCK`),
  `Status` = VALUES(`Status`);

INSERT INTO `almacen_dregcivil` (`ID`, `CLAVE`, `DESCRIPCION`, `CATEGORIA_ID`, `CATEGORIA`, `UNIDAD`, `STOCK`, `ESTADO`) VALUES
(1,  'CL-001', 'CAJA DE PAPEL BOND BLANCO TAMAÑO CARTA (5000 HOJAS)', 1, 'PAPELERIA',           'CAJA',    85,  'ACTIVO'),
(2,  'CL-002', 'CAJA DE PAPEL BOND BLANCO TAMAÑO OFICIO (5000 HOJAS)',1, 'PAPELERIA',           'CAJA',    42,  'ACTIVO'),
(3,  'CL-003', 'BOLÍGRAFO PUNTO MEDIANO TINTA AZUL (CAJA C/12 PZAS)', 1, 'PAPELERIA',           'CAJA',    96,  'ACTIVO'),
(4,  'CL-004', 'BOLÍGRAFO PUNTO MEDIANO TINTA NEGRA (CAJA C/12 PZAS)',1, 'PAPELERIA',           'CAJA',    74,  'ACTIVO'),
(5,  'CL-005', 'CARPETA LEFORT TAMAÑO CARTA LOMO ANCHO',              4, 'ARCHIVO Y OFICINA',   'PIEZA',   160, 'ACTIVO'),
(6,  'CL-006', 'CAJA DE ARCHIVO MUERTO TAMAÑO OFICIO CARTÓN REFORZADO',4,'ARCHIVO Y OFICINA',   'PIEZA',   210, 'ACTIVO'),
(7,  'CL-007', 'CARTUCHO DE TÓNER LÁSER NEGRO ALTO RENDIMIENTO 85A',  2, 'CONSUMIBLES COMPUTO', 'PIEZA',   24,  'ACTIVO'),
(8,  'CL-008', 'CARTUCHO DE TÓNER LÁSER NEGRO 58A PARA IMPRESORA HP', 2, 'CONSUMIBLES COMPUTO', 'PIEZA',   18,  'ACTIVO'),
(9,  'CL-009', 'PAQUETE DE FÓLDER CREMA TAMAÑO CARTA (100 PIEZAS)',   1, 'PAPELERIA',           'PAQUETE', 65,  'ACTIVO'),
(10, 'CL-010', 'ENGRAPADORA METÁLICA DE OFICINA USO RUDO',            1, 'PAPELERIA',           'PIEZA',   32,  'ACTIVO'),
(11, 'CL-011', 'CAJA DE GRAPAS ESTÁNDAR GALVANIZADAS (5000 GRAPAS)',  1, 'PAPELERIA',           'CAJA',    110, 'ACTIVO'),
(12, 'CL-012', 'CINTA ADHESIVA TRANSPARENTE 48MM X 150M',             4, 'ARCHIVO Y OFICINA',   'ROLLO',   88,  'ACTIVO'),
(13, 'CL-013', 'PAPEL HIGIÉNICO JUMBO INSTITUCIONAL (PAQUETE C/4)',   3, 'LIMPIEZA E INSUMOS',  'PAQUETE', 54,  'ACTIVO'),
(14, 'CL-014', 'LIMPIADOR MULTIUSOS DESINFECTANTE GALÓN 4 LITROS',    3, 'LIMPIEZA E INSUMOS',  'PIEZA',   39,  'ACTIVO')
ON DUPLICATE KEY UPDATE
  `DESCRIPCION` = VALUES(`DESCRIPCION`),
  `CATEGORIA` = VALUES(`CATEGORIA`),
  `UNIDAD` = VALUES(`UNIDAD`),
  `STOCK` = VALUES(`STOCK`),
  `ESTADO` = VALUES(`ESTADO`);

INSERT INTO `almacen_principal` (`ID`, `producto_id`, `DescAlmacen`, `STOCK`) VALUES
(1,  1,  'Principal', 85),
(2,  2,  'Principal', 42),
(3,  3,  'Principal', 96),
(4,  4,  'Principal', 74),
(5,  5,  'Principal', 160),
(6,  6,  'Principal', 210),
(7,  7,  'Principal', 24),
(8,  8,  'Principal', 18),
(9,  9,  'Principal', 65),
(10, 10, 'Principal', 32),
(11, 11, 'Principal', 110),
(12, 12, 'Principal', 88),
(13, 13, 'Principal', 54),
(14, 14, 'Principal', 39)
ON DUPLICATE KEY UPDATE `STOCK` = VALUES(`STOCK`);

-- -----------------------------------------------------------------------------
-- 3. Solicitudes de Material (6 Vales de distintas Oficialías y Regiones con Firma Digital)
-- -----------------------------------------------------------------------------
SET @FIRMA_PNG_SAMPLE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALQAAAAyCAYAAAD1JPH3AAABv0lEQVR42u3bwXHDIBBGYReRKlJT+j+nhJxytCwBP2LR92Z0szSw+7Qs2H69AAAAAAAAAAAAAADAWb6+f37/L9EAoYEVZSY1CA2sLDOhtXDbCS0RVjxCq1DbrXil5nAkc88EnlqhUvFcZT4lB/wUoRNj20nocuN/N9jeSVRIaGJsn2SuJHXJsVcTOvGcGS1WNaG3krlXnlSFSj4n8QJX7UXLriqJBLwLRKrir9ASnL0/IcislmmL3esIoUdU11HyHd3f+tyr9yXbm9QztzqKuTKxT8EYJUxL0M/c1yvniBittMqUOpFpEbq3+owQprWitrYFVz7Xu4qNlHlE0dhO5h7xe/vIloqaagtGvJyJyn6mrRsR58cJ3RvA1iCnxGsRZ2YOWmLXE+ethE5sHq/2sa0vSKKKzjyCTOwZjubxCJlbBBwpS2/y0puvVC6Spzpb/XAqLfQdO/VkstICzKieZD55fJeuHquIlxRgVvXc8vfu6eOiu4M8S7x0XpLCkTkYdH8o2Oy0oZLQr0lft8oPmW8XWnTrejDiun0ilsaa4qx6WRqJQ2jiuB4toaQRRw9HHDxNaJEFAAAAAAAAgO34A3bwlLfvoEEnAAAAAElFTkSuQmCC';

INSERT INTO `solicitudes`
(`id`, `tipo_solicitud`, `fecha_solicitud`, `id_oficialia`, `id_localidad`, `status`, `fecha_surtido`, `observaciones`, `region_solicitante`, `nombre_solicitante_firma`, `firma_solicitante_data`, `fecha_firma_digital`, `folio_firma_digital`, `usuario_id`)
VALUES
(101, 'CONSUMIBLES', CURDATE() - INTERVAL 5 DAY, 30030007, 0, 'SURTIDA',   CURDATE() - INTERVAL 4 DAY, 'Operativo de pago Pensión Adultos Mayores en Los Cabos (Guaymitas)', 'Los Cabos',        'Samir Savin Ruiz',                     @FIRMA_PNG_SAMPLE, NOW() - INTERVAL 5 DAY, 'FIRMA-BCS-2026-LC101A', 3),
(102, 'CONSUMIBLES', CURDATE() - INTERVAL 3 DAY, 30030005, 0, 'APROBADA',  CURDATE() - INTERVAL 2 DAY, 'Brigadas Salud Casa por Casa en Santa Rosalía y Vizcaíno',           'Mulegé',           'Roberto Carlos Leree Osuna',           @FIRMA_PNG_SAMPLE, NOW() - INTERVAL 3 DAY, 'FIRMA-BCS-2026-MU102B', 3),
(103, 'CONSUMIBLES', CURDATE() - INTERVAL 2 DAY, 30030004, 0, 'PENDIENTE', NULL,                       'Papelería y carpetas para módulo regional Ciudad Constitución',       'Comondú / Loreto', 'Humberto Arce Cordero',                @FIRMA_PNG_SAMPLE, NOW() - INTERVAL 2 DAY, 'FIRMA-BCS-2026-CL103C', 3),
(104, 'CONSUMIBLES', CURDATE() - INTERVAL 1 DAY, 30030003, 0, 'PENDIENTE', NULL,                       'Insumos de impresión y tóners para centro de cómputo La Paz',        'La Paz',           'Victor Manuel Higuera Ruiz',           @FIRMA_PNG_SAMPLE, NOW() - INTERVAL 1 DAY, 'FIRMA-BCS-2026-LP104D', 3),
(105, 'CONSUMIBLES', CURDATE() - INTERVAL 1 DAY, 30030002, 0, 'SURTIDA',   CURDATE(),                  'Integración de expedientes de personal Delegación La Paz',           'La Paz',           'Jonathan Alain Olachea Noriega',       @FIRMA_PNG_SAMPLE, NOW() - INTERVAL 1 DAY, 'FIRMA-BCS-2026-LP105E', 3),
(106, 'CONSUMIBLES', CURDATE(),                  30030006, 0, 'PENDIENTE', NULL,                       'Material para difusión institucional en PEC Caribe Cabo San Lucas',  'Los Cabos',        'Erika Peralta Preciado',               NULL,              NULL,                   NULL,                    3)
ON DUPLICATE KEY UPDATE
  `status` = VALUES(`status`),
  `observaciones` = VALUES(`observaciones`),
  `region_solicitante` = VALUES(`region_solicitante`),
  `nombre_solicitante_firma` = VALUES(`nombre_solicitante_firma`),
  `firma_solicitante_data` = VALUES(`firma_solicitante_data`),
  `fecha_firma_digital` = VALUES(`fecha_firma_digital`),
  `folio_firma_digital` = VALUES(`folio_firma_digital`);

INSERT INTO `detalles_solicitud` (`id`, `solicitud_id`, `producto_id`, `cantidad`, `atendida`, `observaciones`) VALUES
(1001, 101, 1,  4,  4,  'Entregado completo para operativo Los Cabos'),
(1002, 101, 3,  6,  6,  'Bolígrafos azules para mesas de atención'),
(1003, 101, 9,  5,  5,  'Fólders tamaño carta'),
(1004, 102, 1,  3,  3,  'Enviado a Santa Rosalía'),
(1005, 102, 5,  15, 15, 'Carpetas Lefort para censo'),
(1006, 102, 12, 8,  8,  'Cintas adhesivas'),
(1007, 103, 2,  3,  0,  'Pendiente de envío a Ciudad Constitución'),
(1008, 103, 6,  20, 0,  'Cajas de archivo muerto'),
(1009, 103, 10, 4,  0,  'Engrapadoras uso rudo'),
(1010, 104, 7,  3,  0,  'Tóners 85A solicitados por Informática'),
(1011, 104, 8,  2,  0,  'Tóners 58A'),
(1012, 105, 5,  12, 12, 'Carpetas entregadas en almacén La Paz'),
(1013, 105, 11, 5,  5,  'Cajas de grapas'),
(1014, 106, 1,  2,  0,  'Papel bond carta'),
(1015, 106, 13, 4,  0,  'Insumos higiene oficina')
ON DUPLICATE KEY UPDATE
  `cantidad` = VALUES(`cantidad`),
  `atendida` = VALUES(`atendida`),
  `observaciones` = VALUES(`observaciones`);

-- -----------------------------------------------------------------------------
-- 4. Inventario Regional (16 Activos en las 4 Regiones y los 4 Rubros)
-- Incluye 4 unidades vehiculares con JSON completo de detalles_vehiculo y checklist
-- -----------------------------------------------------------------------------
SET @CHK_ALL_SI = '"checklist":{"llaves_encendido":"Sí","llave_repuesto":"Sí","control_remoto_alarma":"Sí","radio":"Sí","bocinas":"Sí","espejo_retrovisor":"Sí","espejo_lat_derecho":"Sí","espejo_lat_izquierdo":"Sí","encendedor":"Sí","aire_acondicionado":"Sí","tarjeta_circulacion":"Sí","poliza_seguro":"Sí","manuales":"Sí","placa_delantera":"Sí","placa_trasera":"Sí","viseras":"Sí","claxon":"Sí","asientos":"Sí","manijas":"Sí","tapetes":"Sí","llave_cruz":"Sí","llave_l":"Sí","reflejantes":"Sí","gato":"Sí","extintor":"Sí","cables_pasa_corriente":"Sí","herramienta":"Sí","llanta_refaccion":"Sí","golpes":"No","rayones":"No","emblemas":"Sí","faros":"Sí","calaveras":"Sí","tumba_burros":"N/A","tira_remolque":"Sí","biseles":"Sí","tapones_llantas":"Sí","tapon_gasolina":"Sí","brazos_limpiadores":"Sí","bayoneta_aceite":"Sí","bayoneta_transmision":"Sí"}';

SET @VEH_JSON_1 = CONCAT('{"unidad":{"marca":"TOYOTA","tipo":"PICK UP DOBLE CABINA","modelo":"2022","color":"BLANCO","placas":"CE-4821-A","serie_vin":"8AJBA3CD5N1029384","cilindros":"4 CIL.","poliza_seguro":"GNP-992831-BCS","odometro_km":"42,650","nivel_gasolina":"3/4"},"estado_general":{"estado_mecanico":"B","estado_electrico":"B","estado_carroceria":"B","llanta_1":"B","llanta_2":"B","llanta_3":"B","llanta_4":"B","llanta_5":"B"},', @CHK_ALL_SI, '}');
SET @VEH_JSON_2 = CONCAT('{"unidad":{"marca":"NISSAN","tipo":"NP300 FRONTIER","modelo":"2023","color":"BLANCO","placas":"CE-7710-B","serie_vin":"3N6AD33A9PK847291","cilindros":"4 CIL.","poliza_seguro":"QUALITAS-441029-LC","odometro_km":"28,140","nivel_gasolina":"Lleno"},"estado_general":{"estado_mecanico":"B","estado_electrico":"B","estado_carroceria":"B","llanta_1":"B","llanta_2":"B","llanta_3":"B","llanta_4":"B","llanta_5":"R"},', @CHK_ALL_SI, '}');
SET @VEH_JSON_3 = CONCAT('{"unidad":{"marca":"CHEVROLET","tipo":"S10 MAX CABINA DOBLE","modelo":"2022","color":"PLATA","placas":"CF-1194-C","serie_vin":"LSGHD52H8ND019283","cilindros":"4 CIL.","poliza_seguro":"AXA-772819-COM","odometro_km":"61,890","nivel_gasolina":"1/2"},"estado_general":{"estado_mecanico":"B","estado_electrico":"B","estado_carroceria":"R","llanta_1":"B","llanta_2":"B","llanta_3":"R","llanta_4":"B","llanta_5":"B"},', @CHK_ALL_SI, '}');
SET @VEH_JSON_4 = CONCAT('{"unidad":{"marca":"RAM","tipo":"RAM 700 SLT","modelo":"2021","color":"BLANCO","placas":"CD-9032-D","serie_vin":"9BD57814XM9283741","cilindros":"4 CIL.","poliza_seguro":"GNP-558192-MUL","odometro_km":"79,320","nivel_gasolina":"3/4"},"estado_general":{"estado_mecanico":"R","estado_electrico":"B","estado_carroceria":"B","llanta_1":"B","llanta_2":"R","llanta_3":"B","llanta_4":"B","llanta_5":"B"},', @CHK_ALL_SI, '}');

INSERT INTO `inventario_oficina`
(`id`, `oficina_id`, `rubro_id`, `clave_bien`, `descripcion`, `marca_modelo`, `numero_serie_placas`, `unidad`, `cantidad_propia`, `cantidad_prestada_recibida`, `cantidad_prestada_enviada`, `estado_fisico`, `estatus_uso`, `observaciones`, `detalles_vehiculo`)
VALUES
-- RUBRO 1: ARCHIVO_MATERIALES (Encargado: Gabriel Adan Fiol Collins)
(201, 1, 1, 'AM-LPZ-001', 'ANAQUEL METÁLICO DE 5 ENTREPAÑOS PARA ARCHIVO CONCENTRACIÓN', 'PM STEELE AR-5',   'SN-AM-9001', 'PIEZA', 12, 0, 0, 'BUENO',   'ACTIVO',   'Ubicado en archivo general Delegación La Paz', NULL),
(202, 2, 1, 'AM-LCB-001', 'ARCHIVERO VERTICAL DE 4 GAVETAS CON CERRADURA',               'BÁSICOS OFICINA',  'SN-AM-9002', 'PIEZA', 6,  0, 0, 'BUENO',   'ACTIVO',   'Resguardo de expedientes Guaymitas Los Cabos', NULL),
(203, 6, 1, 'AM-COM-001', 'GUILLOTINA DE PALANCA Y ENGARGOLADORA DE USO RUDO',           'GBC SWINGLINE',    'SN-AM-9003', 'JUEGO', 2,  0, 0, 'BUENO',   'ACTIVO',   'Área de archivo Ciudad Constitución', NULL),
(204, 9, 1, 'AM-MUL-001', 'ESTANTERÍA METÁLICA REFORZADA PARA RESGUARDO DE MATERIALES',  'MECALUX EST-200',  'SN-AM-9004', 'PIEZA', 8,  0, 0, 'REGULAR', 'ACTIVO',   'Bodega regional Santa Rosalía', NULL),

-- RUBRO 2: PARQUE_VEHICULAR (Encargada: Evelia Contreras Godinez)
(205, 1, 2, 'PV-LPZ-001', 'CAMIONETA PICK UP DOBLE CABINA 4X2 OPERATIVO BIENESTAR',      'TOYOTA HILUX 2022',      'CE-4821-A / 8AJBA3CD5N1029384', 'UNIDAD', 1, 0, 0, 'BUENO',   'ACTIVO', 'Unidad asignada a coordinación operativa La Paz. Servicio de 40,000 km realizado.', @VEH_JSON_1),
(206, 2, 2, 'PV-LCB-001', 'CAMIONETA PICK UP DOBLE CABINA OPERATIVO LOS CABOS',          'NISSAN NP300 2023',      'CE-7710-B / 3N6AD33A9PK847291', 'UNIDAD', 1, 0, 0, 'BUENO',   'ACTIVO', 'Unidad asignada a brigadas en San José del Cabo y Cabo San Lucas.',                 @VEH_JSON_2),
(207, 6, 2, 'PV-COM-001', 'CAMIONETA PICK UP DOBLE CABINA OPERATIVO VALLE DE SANTO DOMINGO','CHEVROLET S10 MAX 2022','CF-1194-C / LSGHD52H8ND019283', 'UNIDAD', 1, 0, 0, 'BUENO',   'ACTIVO', 'Unidad asignada a rutas rurales Comondú y Loreto.',                                 @VEH_JSON_3),
(208, 9, 2, 'PV-MUL-001', 'CAMIONETA UTILITARIA OPERATIVO ZONA NORTE MULEGÉ',            'RAM 700 SLT 2021',       'CD-9032-D / 9BD57814XM9283741', 'UNIDAD', 1, 0, 0, 'REGULAR', 'ACTIVO', 'Unidad asignada a operativos Santa Rosalía - Guerrero Negro.',                      @VEH_JSON_4),

-- RUBRO 3: MOBILIARIO (Encargado: Jesus Salvador Palacios Martinez)
(209, 1, 3, 'MO-LPZ-001', 'TOLDOS PLEGABLES 3X3M REFORZADOS COLOR GUINDA INSTITUCIONAL', 'MASTERTENT 3X3',   'LOTE-TOL-01', 'PIEZA', 15, 0, 2, 'BUENO', 'ACTIVO', 'Para operativos de pago y ferias de Bienestar La Paz', NULL),
(210, 4, 3, 'MO-LCB-001', 'MESAS PLEGABLES TIPO PORTAFOLIO 1.80M USO RUDO',              'LIFETIME 80160',   'LOTE-MES-02', 'PIEZA', 25, 2, 0, 'BUENO', 'ACTIVO', 'Mesas de atención PEC Caribe Cabo San Lucas', NULL),
(211, 6, 3, 'MO-COM-001', 'SILLAS PLEGABLES ACOLCHADAS ESTRUCTURA DE ACERO',             'SAMSONITE S-200',  'LOTE-SIL-03', 'PIEZA', 80, 0, 0, 'BUENO', 'ACTIVO', 'Sillas para atención a derechohabientes Ciudad Constitución', NULL),
(212, 10,3, 'MO-MUL-001', 'EQUIPO DE SONIDO PORTÁTIL CON BOCINA AMPLIFICADA Y MICRÓFONO','BOSE S1 PRO / JBL','SN-SON-4410', 'JUEGO', 2,  0, 0, 'BUENO', 'ACTIVO', 'Eventos operativos en Vizcaíno y Mulegé', NULL),

-- RUBRO 4: POR_DEFINIR (Encargado: Luis Eduardo Mayoral Geraldo)
(213, 1, 4, 'RE-LPZ-001', 'PLANTA GENERADORA ELÉCTRICA PORTÁTIL A GASOLINA 3500W',       'HONDA EU3000IS',   'SN-GEN-7001', 'PIEZA', 2,  0, 0, 'BUENO', 'ACTIVO', 'Respaldo eléctrico para sedes operativas sin red', NULL),
(214, 2, 4, 'RE-LCB-001', 'KIT DE CONECTIVIDAD SATELITAL MÓVIL PARA ZONAS RURALES',      'STARLINK ENTERPRISE','SN-SAT-7002','JUEGO', 3,  0, 0, 'BUENO', 'ACTIVO', 'Operativos en comunidades rurales de Los Cabos', NULL),
(215, 8, 4, 'RE-LOR-001', 'ENFRIADOR EVAPORATIVO PORTÁTIL PARA CARPA DE ATENCIÓN',       'PORTACOOL JET',    'SN-ENF-7003', 'PIEZA', 4,  0, 0, 'BUENO', 'ACTIVO', 'Centro Integrador Loreto', NULL),
(216, 9, 4, 'RE-MUL-001', 'LÁMPARAS LED RECARGABLES DE EMERGENCIA ALTA POTENCIA',        'MILWAUKEE M18',    'SN-LAM-7004', 'PIEZA', 6,  0, 0, 'BUENO', 'ACTIVO', 'Brigadas de atención en Mulegé', NULL)
ON DUPLICATE KEY UPDATE
  `oficina_id` = VALUES(`oficina_id`),
  `rubro_id` = VALUES(`rubro_id`),
  `clave_bien` = VALUES(`clave_bien`),
  `descripcion` = VALUES(`descripcion`),
  `marca_modelo` = VALUES(`marca_modelo`),
  `numero_serie_placas` = VALUES(`numero_serie_placas`),
  `cantidad_propia` = VALUES(`cantidad_propia`),
  `estado_fisico` = VALUES(`estado_fisico`),
  `estatus_uso` = VALUES(`estatus_uso`),
  `observaciones` = VALUES(`observaciones`),
  `detalles_vehiculo` = VALUES(`detalles_vehiculo`);

-- Préstamo de prueba entre oficinas regionales
INSERT INTO `prestamos_inventario`
(`id`, `inventario_origen_id`, `oficina_origen_id`, `oficina_destino_id`, `rubro_id`, `clave_bien`, `descripcion`, `cantidad`, `tipo_movimiento`, `estatus`, `fecha_salida`, `motivo`, `observaciones`, `usuario_registro`)
VALUES
(1, 209, 1, 4, 3, 'MO-LPZ-001', 'TOLDOS PLEGABLES 3X3M REFORZADOS COLOR GUINDA INSTITUCIONAL', 2, 'PRESTAMO', 'PRESTADO', NOW() - INTERVAL 4 DAY, 'Apoyo operativo entrega de tarjetas en Cabo San Lucas', 'Retorno programado al finalizar operativo mensual', 'jesus')
ON DUPLICATE KEY UPDATE
  `estatus` = VALUES(`estatus`),
  `motivo` = VALUES(`motivo`);

SET FOREIGN_KEY_CHECKS = 1;
