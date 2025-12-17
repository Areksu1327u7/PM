# no ceder para las vistas

Esteno para:
- una vez
- Resquina
- pen
- no sar
- un fil
Los navor.

## Ejecutar

En Windows PowerShell, abra el archivo `index.html` en su navegador:

```powershell
Start-Process "c:\Users\alexf\OneDrive\Escritorio\prueba\prueba1\index.html"
```

También puede abrirlo directamente desde el Explorador de archivos.

## Estructura

- `index.html`: Página principal con todas las secciones.
- `styles.css`: Estilos.
- `app.js`: Lógica de la aplicación.

## Notas

- Para los gráficos se usa CDN de Chart.js; requiere conexión a Internet.
- Esta es una demo sin control de acceso; la matriz de roles es ilustrativa.
- Si desea persistencia real y multiusuario, se recomienda agregar un backend (por ejemplo Node.js + Express + SQLite/PostgreSQL).

## Supabase (Base de Datos)

- Este proyecto ya está integrado con Supabase usando tus credenciales.
- Crea las tablas y políticas ejecutando el archivo `supabase_schema.sql` en el SQL editor de tu proyecto Supabase.

Pasos:
1. Copia el contenido de `supabase_schema.sql`.
2. Ve a Supabase → SQL → New Query → pega y ejecuta.
3. Verifica que las tablas `products`, `movements` y `roles_matrix` existan.
4. Abre `index.html` y prueba las operaciones (inventario, movimientos, ventas, admin, dashboard).

