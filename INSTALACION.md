# Instalacion del sistema de inventario

Este paquete esta pensado para instalar el sistema con una base de datos nueva y datos distintos.

## Requisitos

- Windows 10/11 o Windows Server.
- Node.js 20 o superior.
- MySQL 8 o compatible.
- Puerto `8080` disponible.

## 1. Crear base de datos

En MySQL:

```sql
CREATE DATABASE inventario_consumibles CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

Importa el esquema limpio:

```powershell
mysql -u root -p inventario_consumibles < database\schema.sql
```

Carga datos minimos para poder entrar:

```powershell
mysql -u root -p inventario_consumibles < database\seed_inicial.sql
```

## 2. Crear usuarios de MySQL para la aplicacion

Ejemplo:

```sql
CREATE USER 'app_read'@'%' IDENTIFIED BY 'CAMBIAR_PASSWORD_READ';
CREATE USER 'app_ops'@'%' IDENTIFIED BY 'CAMBIAR_PASSWORD_OPS';

GRANT SELECT ON inventario_consumibles.* TO 'app_read'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON inventario_consumibles.* TO 'app_ops'@'%';

FLUSH PRIVILEGES;
```

Para una instalacion local puedes cambiar `'%'` por `'localhost'`.

## 3. Configurar variables

En la carpeta `inventario-api`, copia:

```powershell
Copy-Item .env.example .env
```

Edita `.env` y cambia:

- `DB_HOST`
- `DB_NAME`
- `DB_USER_READ`
- `DB_PASS_READ`
- `DB_USER_OPS`
- `DB_PASS_OPS`
- `JWT_SECRET`
- `CORS_ORIGIN`

No compartas el archivo `.env` real.

## 4. Instalar dependencias

Dentro de `inventario-api`:

```powershell
npm ci
```

## 5. Validar e iniciar

```powershell
npm run check
npm start
```

Abrir:

```text
http://127.0.0.1:8080
```

Usuario inicial:

```text
usuario: admin
contrasena: admin123
```

Cambia esa contrasena despues del primer acceso.

## 6. Arranque automatico en Windows

El paquete incluye `start-inventario.ps1`. Puedes usarlo para iniciar el sistema al prender la computadora.

Si quieres que arranque al iniciar sesion, crea un acceso en:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
```

que ejecute:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\RUTA\inventario-api\start-inventario.ps1"
```

## Notas

- `database\schema.sql` trae solo estructura, sin datos reales.
- `database\seed_inicial.sql` trae solo datos minimos para iniciar.
- No se incluye `node_modules`; se instala con `npm ci`.
- No se incluye `.env` real.
