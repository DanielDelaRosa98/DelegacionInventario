-- Datos minimos para arrancar una base nueva.
-- Usuario inicial: admin
-- Contrasena temporal: admin123
-- Cambiar la contrasena despues del primer acceso.

SET NAMES utf8mb4;

INSERT INTO oficialias
(id, id_tipo_oficialia, id_municipio, id_localidad, id_renapo, nombre, activo, direccion, telefono, oficial_reponsable, id_oficialia)
VALUES
(30030000, 0, 0, 0, NULL, 'DIRECCION ESTATAL', b'1', NULL, NULL, NULL, 30030000)
ON DUPLICATE KEY UPDATE
nombre = VALUES(nombre),
activo = VALUES(activo);

INSERT INTO usuario
(id, username, psw, nombre, PRIMER_APELLIDO, SEGUNDO_APELLIDO, ID_OFICIALIA, OFICIALIA_ID, ACTIVO, FECHA_ALTA, usuario_id, departamento)
VALUES
(1, 'admin', '$2b$10$TY9B5CJj8cwfJ66ndHgWs.sQaR.HnAMUnQEJfSigN.kVXzxXgDDt2', 'ADMIN', NULL, NULL, 30030000, 30030000, b'1', NOW(), NULL, 'ADMINISTRACION')
ON DUPLICATE KEY UPDATE
username = VALUES(username),
psw = VALUES(psw),
ACTIVO = VALUES(ACTIVO),
departamento = VALUES(departamento);

INSERT INTO categorias (idcategoria, descCategoria) VALUES
(1, 'GENERAL')
ON DUPLICATE KEY UPDATE descCategoria = VALUES(descCategoria);

INSERT INTO umedida (idUnidad, DescUnidad) VALUES
(1, 'PIEZA'),
(2, 'CAJA'),
(3, 'BLOCK'),
(4, 'PAQUETE')
ON DUPLICATE KEY UPDATE DescUnidad = VALUES(DescUnidad);
