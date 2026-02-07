# no es nada
- Dashboard con gráficos (Chart.js).

Los datos se guardan temporalmente en `localStorage` del navegador.

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

- Pssssssssrecomienda agregar un backend (por ejitL).

## no

Pasos:
1. Copia el contenido de `supabase_schema.sql`.
2. Ve a Supabase → SQL → New Query → pega y ejecuta.
3. Verifica que las tablas `products`, `movements` y `roles_matrix` existan.
4. Abre `index.html` y prueba las operaciones (inventario, movimientos, ventas, admin, dashboard).
