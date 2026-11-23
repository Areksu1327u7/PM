# Importaciones MB

Aplicación web de inventario, ingresos, transferencias SENKATA → CEJA, ventas, cotizaciones y reportes. El área interna requiere Supabase Auth, correo verificado y autorización del administrador. Sin sesión solo se muestra un catálogo público limitado.

## Cuentas del personal (actualización 010)

Configuración → (administración de accesos) ahora tiene:

- **Solicitudes de acceso**: toda cuenta creada con «Solicitar cuenta» aparece aquí aunque la persona no haya confirmado su correo (con el correo por defecto de Supabase la confirmación no llega a direcciones externas, por eso antes no aparecía nada). Se elige el rol y se pulsa «Aprobar»: el correo queda confirmado y la persona ya puede ingresar con su contraseña.
- **Crear cuenta**: correo, contraseña (mínimo 12 caracteres; «Generar contraseña» propone una) y rol. La cuenta queda confirmada y activa al instante. Se muestra la contraseña para entregarla a la persona.
- **Cambiar contraseña** en la tabla Usuarios, para quien la olvidó (la recuperación por correo tampoco llega sin SMTP propio).
- Nadie puede modificarse a sí mismo ni al administrador principal. Cada acción comprueba en la base de datos el permiso «Administrar usuarios y roles» y queda en la auditoría.

### Instalación (una sola vez)

1. Ejecutar `migrations/010_admin_accounts.sql` en el SQL Editor. Reejecutable; no modifica registros.
2. Publicar una segunda Edge Function igual que `pin-login`: *Deploy a new function → Via Editor*, nombre exacto `admin-users`, reemplazar todo el `index.ts` de ejemplo por el contenido de `supabase/functions/admin-users/index.ts`, publicar y **desactivar «Enforce JWT verification»** (la función valida la sesión por su cuenta). Con la CLI: `supabase functions deploy admin-users --no-verify-jwt`.

## Ingreso con código de 4 números (actualizaciones 008 y 009)

Pensado para cambiar rápido de persona en los equipos de la tienda:

- Cada persona tiene **un solo código** de 4 números, el que quiera (incluidos 1111 o 1234). Lo crea al entrar con contraseña o desde Mi perfil → Código de 4 números. Cambiarlo en un equipo lo cambia en todos.
- El código funciona en **cualquier equipo donde esa persona haya ingresado al menos una vez con su contraseña**. Ese ingreso habilita el equipo automáticamente (el servidor lo comprueba con el método de autenticación del token, no con lo que diga el navegador). En un equipo nuevo, si ya tiene código, entra con contraseña una vez y desde entonces aparece en la lista.
- Al abrir la página en un equipo habilitado aparece «¿Quién va a ingresar?». Se toca el nombre, se escribe el código en el teclado grande y se entra.
- «Cambiar usuario» (junto a Cerrar sesión) vuelve a la lista. Si hay una operación sin confirmar, no deja cambiar hasta resolverla.
- 5 códigos incorrectos seguidos, sumando todos los equipos, desactivan el código; se entra con contraseña y se vuelve a crear (puede ser el mismo). Cuentas suspendidas o pendientes no pueden entrar con código.
- El navegador guarda solo un identificador del equipo, un secreto aleatorio y la lista de nombres/correos. Nunca la contraseña, el código ni una sesión reutilizable. Cada ingreso con código crea una sesión nueva emitida por Supabase.
- La ✕ junto a un nombre lo quita de la lista de ese equipo; Mi perfil → «Quitar de este equipo» hace lo mismo desde la sesión.
- Los códigos creados con la versión 008 (que eran por equipo) no se conservan tras aplicar 009: cada persona crea su código otra vez.

### Instalación (una sola vez)

1. **SQL**: ejecutar `migrations/008_quick_access.sql` (si no se aplicó antes) y luego `migrations/009_quick_access_any_device.sql` en el SQL Editor. Ambas son reejecutables y no modifican registros comerciales.
2. **Edge Function**: Supabase → Edge Functions → *Deploy a new function* → *Via Editor*. Nombre exacto: `pin-login`. Pegar el contenido de `supabase/functions/pin-login/index.ts` y publicar. Luego, en la función → *Details/Settings*, **desactivar «Enforce JWT verification»** (la función hace su propia verificación). No hay que configurar secretos.
   Con la CLI: `supabase functions deploy pin-login --no-verify-jwt`.
3. Recargar las pestañas abiertas. Si falta la función, la pantalla de código lo indica y se puede seguir entrando con contraseña.

Pruebas: `tests/quick-access-sql.test.cjs` (código por persona, habilitación solo con contraseña, varios equipos, intentos sumados, bloqueo, cuentas suspendidas, permisos) y `tests/quick-access.test.cjs` (lista, teclado, mensajes, ofrecimiento tras contraseña). La Edge Function no se ejecuta en las pruebas locales; requiere comprobarla en Supabase.

## Publicación en GitHub Pages y rendimiento (actualización 007)

**Antes de publicar**, en este orden:

1. Ejecutar `migrations/007_performance.sql` completo en el SQL Editor de Supabase (después de 006). Es reejecutable, no modifica registros y solo agrega índices y una versión más rápida de la función privada de guardado.
2. Publicar el contenido de esta carpeta (`PM`) como raíz del sitio: Settings → Pages → Deploy from a branch → rama principal, carpeta `/ (root)`. El archivo `.nojekyll` evita el procesamiento con Jekyll. `node_modules`, `.env*` y `test-artifacts` están excluidos por `.gitignore`.
3. En Supabase → Authentication → URL Configuration: poner como Site URL la dirección final (`https://<usuario>.github.io/<repositorio>/`) y agregarla en Redirect URLs. Sin esto los correos de confirmación y recuperación apuntan a la dirección local.
4. En cada despliegue posterior, cambiar el número de versión `?v=` (actual: `20261121d`) en `index.html` y la constante `BUILD` de `modules/access.js` (mismo valor). GitHub Pages guarda archivos en caché 10 minutos; así los navegadores no mezclan archivos de versiones distintas.

Qué cambia en 007:

- Índices para historial de ventas (fecha), detalle por venta, historial por producto, transferencias, anulaciones y búsqueda de ITEM. Sin ellos cada consulta recorría tablas completas y se volvía más lenta a medida que crecían los registros.
- Al guardar o editar una venta, el servidor solo bloquea y recalcula los productos de esa venta (antes recorría todo el catálogo en cada venta). La lógica de stock, validaciones, idempotencia y auditoría es la misma; los 13 escenarios de `audit-transactions.cjs` se ejecutan sobre 007.
- Corrección: un descuento con más de dos decimales (p. ej. 7.125 %) hacía fallar la venta con el aviso «diferencias entre cabecera y detalle». Ahora el porcentaje se redondea a dos decimales, igual que se almacena, tanto en el cliente como en el servidor.
- La aplicación funciona con o sin 007; la migración solo acelera y corrige el caso del descuento.

Cambios en la aplicación:

- Las librerías de Excel (≈880 KB) y PDF (≈400 KB) ya no bloquean el arranque: Excel se descarga al exportar y PDF se precarga cuando el navegador queda libre después de iniciar sesión.
- Las lecturas completas piden la primera página con el total y las restantes en paralelo.
- Escribir un ITEM en Venta, Transferencia o Edición de venta consulta solo ese producto (existencias al día) en lugar de descargar todo el inventario. Las listas desplegables y la resolución de IDs al guardar usan un catálogo de hasta 30 s que se descarta con cualquier guardado o cambio en tiempo real; el servidor vuelve a validar stock y precios en cada operación. La vista Inventario sigue leyendo siempre del servidor.
- El historial de un producto consulta solo sus ventas y la lista de anulaciones (antes descargaba todas las ventas y todos los movimientos). Las exportaciones de ventas ya no descargan la tabla de movimientos. Los detalles de una venta y el dashboard hacen sus consultas en paralelo.
- La lista de anulaciones y reversiones se reutiliza hasta 15 s entre páginas del historial y se descarta al guardar.
- Corrección: si fallaba la carga al activar «Modo Edición» del inventario, la vista quedaba en edición sin filas editables y con la sincronización pausada.

## Corrección de integridad de inventario (006)

Aplicar `migrations/006_inventory_integrity.sql` después de 005 y recargar todas las pestañas. La aplicación permite consultas, pero bloquea los guardados comerciales hasta que Supabase confirme `inventory_integrity: true`. La migración es reejecutable, mantiene los permisos y solo crea/reemplaza funciones; no actualiza ni elimina registros comerciales anteriores.

- Las reversiones comparan identificadores numéricamente, incluso si una operación anterior los guardó con ceros iniciales. También se comprueban los registros de reversión heredados sin diario de operaciones.
- Editar una venta rechaza IDs de línea equivalentes antes de cambiar stock. La interfaz también los comprueba; la protección decisiva permanece en SQL.
- Antes de confirmar una venta, se verifica que cabecera, detalle y cantidades por producto coincidan. Un fallo revierte la operación completa.
- Si una venta antigua ya tiene diferencias entre cabecera y detalle, su edición y anulación se bloquean para revisión; no se intenta corregir ni devolver stock automáticamente. Los reintentos de operaciones ya confirmadas conservan su resultado sin repetir efectos.

`npm test` incluye las regresiones de ambos defectos y conservación de registros/auditoría. `node scripts/audit-transactions.cjs` repite los 13 escenarios comerciales en una base aislada con 001–006 y escribe `test-artifacts/transaction-audit-fixed.json`. `node scripts/verify-security.cjs` comprueba mediante lecturas que el clon ya publica la corrección y mantiene las restricciones anónimas. Las pruebas locales no sustituyen una reconciliación del inventario real ni una prueba de concurrencia con varias conexiones PostgreSQL.

## Rendimiento de la aplicación

Los historiales, las cotizaciones, la matriz de roles y el dashboard se consultan al abrir su apartado. Después de confirmar una venta o movimiento, el formulario se libera sin esperar recargas de otras vistas. Se actualiza en segundo plano el apartado visible y se vuelve a consultar al navegar a otro.

Las lecturas idénticas que coinciden en el tiempo comparten una solicitud; cada consumidor recibe su propia copia. No se conserva stock en caché permanente. Los guardados y eventos de cambios invalidan lecturas anteriores. El inventario mantiene la actualización en tiempo real y una comprobación cada 15 segundos mientras está visible, sin solapar recargas.

El dashboard consulta solo los 180 días necesarios para sus períodos y comparaciones, los ingresos de los últimos 90 días y todas las anulaciones necesarias para excluir ventas canceladas, incluso si su anulación fue tardía.

Ventas carga páginas de 50 comprobantes desde Supabase. El total del periodo se calcula por separado sin bloquear la tabla; solo ese importe se reutiliza en memoria durante un máximo de 15 segundos y se invalida al guardar o recibir cambios. Movimientos consulta únicamente transferencias, aplica filtros en el servidor y pagina por 20 días con actividad, sin cortar un día a la mitad. Las anulaciones y reversiones se comprueban también fuera del rango de fechas. «Ver histórico completo» permite descargar todos los resultados cuando se necesiten.

Con `npm start`, JavaScript y CSS se comprimen con gzip y se revalidan con ETag para evitar descargarlos otra vez si no cambiaron. El HTML conserva `no-store`; no se cachean sesiones ni datos comerciales en el servidor estático. Estas mejoras del servidor no se aplican si se utiliza otra extensión como Live Server. No se requiere otra migración SQL.

## Portada, motivos y perfiles (actualización 005)

Aplicar una vez `migrations/005_reasons_profiles.sql`, después de 004. No se modifican registros comerciales anteriores. Recargar las pestañas abiertas tras instalarla.

- La portada ocupa todo el ancho con un carrusel manual accesible por botones, teclado y gestos. Un botón pequeño «Iniciar sesión», arriba a la derecha, abre el formulario en un diálogo; los enlaces de recuperación lo abren automáticamente. Incluye entradas suaves al desplazarse y efectos al pasar el cursor, respetando la preferencia de movimiento reducido. No hay rotación automática ni se implementan imágenes de productos.
- Anular una venta o revertir un movimiento exige un motivo de entre 5 y 500 caracteres, validado tanto en el código como en SQL. Devolver stock y guardar la auditoría forman una sola transacción. Un reintento confirmado no duplica movimientos ni registros.
- Configuración → Anulaciones y reversiones muestra los productos y cantidades, referencia, motivo, fecha y hora de Bolivia, UUID de cuenta, correo y alias al momento de la operación. El historial requiere `access.manage`, se pagina y no es editable desde el cliente. No se atribuyen motivos ni cuentas a operaciones anteriores a esta actualización.
- Mi perfil permite guardar un alias de 2 a 50 caracteres. Solo se modifica el perfil de la cuenta autenticada. Los cambios de alias no cambian correo, permisos ni identidad en los registros anteriores.
- Las nuevas anulaciones/reversiones quedan bloqueadas en la interfaz si falta instalar 005. Las pruebas de la migración se ejecutan en PostgreSQL local, incluyendo un fallo simulado de auditoría que debe revertir toda la operación.

Las imágenes de productos son viables a futuro usando Supabase Storage y referencias por producto. Quedan fuera de esta actualización: no se agregaron buckets, columnas de imágenes ni controles de carga.

## Acceso y roles (actualización 004)

Aplicar una sola vez `migrations/004_auth_roles.sql`, después de las migraciones 001–003. Conserva los registros comerciales y la matriz anterior; reemplaza permisos y políticas de acceso. La aplicación bloquea el arranque interno si no detecta esta migración. No volver a ejecutar las migraciones antiguas después de 004: reabrirían funciones públicas.

Para desarrollo local, en Supabase → Authentication → URL Configuration establecer Site URL `http://127.0.0.1:4173/` y autorizar esa dirección y `http://localhost:4173/` en Redirect URLs. Mantener **Confirm email** habilitado. Configurar la longitud mínima de contraseña en Supabase en 12 caracteres para coincidir con el formulario. Los correos de confirmación y recuperación requieren un proveedor SMTP operativo; el servicio de prueba de Supabase limita destinatarios y frecuencia.

1. Abrir el proyecto con `npm start` y usar «Solicitar cuenta» con `alexfloresbe@gmail.com`. Confirmar el correo e iniciar sesión. No se crea una contraseña predeterminada.
2. Esa cuenta se registra como administrador principal después de verificar el correo. Su identidad queda fijada por UUID; ningún rol puede quitarle acceso.
3. Otros usuarios solicitan cuenta, confirman correo e inician sesión. Permanecen pendientes hasta que el administrador les asigna un rol y activa el acceso en Configuración → Usuarios.
4. Configuración → Roles y permisos permite crear roles sin privilegios, editar la matriz y guardar el conjunto de cambios atómicamente. Vendedor empieza con consulta de inventario y ventas, creación de ventas y cotizaciones. Anular, editar ventas, movimientos, costos y administración no se conceden por defecto.

RLS protege tablas; el motor transaccional privado solo puede invocarse a través de una función que comprueba usuario, permiso y autor de cada reintento. Las cuentas suspendidas pierden acceso en las consultas siguientes aunque su token siga vigente. La interfaz comprueba cambios cada 15 segundos y se bloquea al cerrar sesión o perder la validación de acceso. Los permisos de lectura conceden acceso a los datos del apartado: no equivalen a un filtro por vendedor. El permiso de exportación controla el botón Excel; no puede impedir copiar datos cuya consulta ya está autorizada.

Las cotizaciones nuevas se guardan en Supabase y requieren permiso. Al entrar un administrador, las cotizaciones locales antiguas se copian sin alterarlas a la base y se archiva el JSON original. Solo después de confirmar ambas copias se retira el duplicado local. El archivo anterior se puede descargar desde Configuración. Los pendientes anteriores se archivan para revisión, nunca se reenvían automáticamente. Los pendientes nuevos se cifran con AES-GCM y se separan por usuario. Las credenciales de sesión se conservan solo en la pestaña; no se guarda la contraseña.

El catálogo público expone únicamente nombre, categoría y precio de hasta 12 productos ordenados por ventas vigentes. No expone stock, costos, volúmenes vendidos ni datos de clientes. Las políticas y permisos de tablas/vistas/RPC antiguos del esquema `public` se cierran para evitar rutas alternativas.

`npm run test:security` verifica el acceso anónimo real del clon con consultas de solo lectura. `npm test` prueba localmente roles, RLS, elevación de privilegios, revocaciones, aislamiento de reintentos y regresiones comerciales. La verificación de entrega de correo e inicio de sesión real requiere completar el flujo desde la cuenta del propietario.

Antes de publicar: usar HTTPS y configurar la URL final en Supabase. Revocar cualquier clave secreta que haya sido compartida; una clave de servidor omite RLS y no debe estar en el frontend ni en mensajes. El código solo contiene la clave publicable. Referencias: [RLS de Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security), [autenticación por contraseña](https://supabase.com/docs/guides/auth/passwords).

## Estado de esta actualización

El código usa funciones transaccionales nuevas. Antes de guardar operaciones, debe instalarse `migrations/001_atomic_store.sql` en el clon **tgggakuinkbibqvvuvob**. El indicador superior confirma si el motor está instalado. No existe un modo alternativo de escritura insegura.

Si ya se instaló la primera versión, aplicar `migrations/002_movement_compatibility.sql`. Esta actualización conserva las restricciones de cantidades e importes no negativos de la base existente. Registra la magnitud del ajuste y su naturaleza en el detalle y diario; los reportes de ventas netas se calculan desde las ventas vigentes. La reversión de transferencias se muestra con signo negativo en el historial, aunque su magnitud se almacena positiva.

La migración no actualiza ni elimina filas anteriores. Agrega `store_operations`, `store_health` y `store_commit`, y sustituye los permisos de escritura directa de clientes públicos por ejecución de la función transaccional. Las pestañas con versiones anteriores deben cerrarse o actualizarse.

No ejecute `supabase_schema.sql` para actualizar una base existente: es un esquema histórico incompleto y no es la migración de esta versión.

## Instalar la migración

Opción A: abrir el SQL Editor del clon, pegar el archivo `migrations/001_atomic_store.sql` y ejecutarlo completo.

Opción B: desde VS Code/terminal, crear un archivo `.env.local` (ignorado por Git) que contenga `SUPABASE_DB_URL` con la conexión PostgreSQL del clon obtenida en Connect → Direct connection o Session pooler. Luego ejecutar:

```powershell
npm install
npm run db:apply -- 004_auth_roles.sql
```

El instalador verifica que la conexión identifica el clon y valida TLS. Una clave pública o secreta de la API de datos no sustituye una conexión PostgreSQL. Nunca colocar una clave secreta en `app.js` ni publicarla.

## Iniciar

```powershell
npm install
npm start
```

Abrir http://127.0.0.1:4173/ . El servidor solo escucha en este equipo. La URL y clave pública del clon se encuentran al inicio de `modules/access.js`.

## Pruebas

```powershell
npm test
```

Las pruebas usan PostgreSQL aislado en memoria (PGlite) y DOM simulado (jsdom). No se conectan a Supabase. Cubren rollback, reintentos, stock insuficiente, anulaciones, transferencias, conflictos, conservación de filas anteriores, navegación y formularios. No reemplazan la comprobación visual en navegador ni pruebas con varios clientes PostgreSQL reales.

Después de instalar la migración:

```powershell
npm run test:clone
```

Esta prueba exige la URL exacta del clon, crea únicamente registros `TEST-AUTO-...`, realiza operaciones con ellos y conserva los registros de prueba. Incluye dos solicitudes simultáneas por la última unidad: solo una debe venderla y su anulación debe devolver exactamente una unidad. Compara hashes de todas las filas anteriores en productos, ventas, líneas y movimientos. Nunca intenta restaurar ni borrar datos. Si detecta cambios externos, informa la diferencia y se detiene.

`node scripts/verify-ui-clone.cjs` comprueba los formularios en un DOM aislado conectado a la API real: ingreso de producto, transferencia, venta, edición, anulación, cotización, impresión y conversión a venta. Solo permite escrituras sobre sus registros `TEST-FORM-...`. Las cotizaciones de esta prueba se conservan en Supabase, sin abrir el almacenamiento del navegador del usuario. Tampoco usa una impresora física. Ambas pruebas remotas requieren SUPABASE_TEST_ACCESS_TOKEN de una cuenta de pruebas con los permisos correspondientes y se ejecutan manualmente, nunca al abrir la aplicación ni con `npm test`.

`scripts/verify-browser-clone.js` exporta un ensayo para una página Playwright abierta en el servidor local. Prueba formularios reales, ventas con varias líneas, retiro de líneas, anulación, reversión, edición y la lupa. Verifica fechas exactas y simula una respuesta perdida después de guardar una transferencia, comprobando que el reintento no duplique existencias. Comprueba también una pantalla de 390 px: los comprobantes pueden desplazarse sin desbordar la página ni recortar columnas. Crea solo registros `TEST-BROWSER-...`, bloquea escrituras fuera de sus productos/ventas/movimientos y compara hashes de las filas anteriores en las cinco tablas (incluidos roles). No se ejecuta al abrir la aplicación ni con `npm test`, y conserva sus registros.

## Cotizaciones impresas

El formulario y el historial ofrecen «Imprimir cotización» y «Descargar PDF». Se reutiliza el generador de comprobantes con un tipo separado: COTIZACIÓN, cliente, fecha, vigencia, productos, descuento y total. Todas las páginas aclaran que no es una venta ni reserva existencias. Imprimir un registro guardado sin cambios conserva su fecha y vigencia; una cotización vencida se identifica como VENCIDA. Si el navegador bloquea la ventana de impresión se descarga el PDF.

## Animaciones

Transiciones breves para secciones, ventanas, avisos y botones. Los botones de guardado muestran actividad durante la petición. `prefers-reduced-motion` y la impresión desactivan las animaciones. No se agregan esperas al proceso de guardado.

La presentación incorpora tarjetas, sombras suaves, jerarquía visual, estados de conexión verificados y superficies adaptadas al tema oscuro. Los efectos al pasar el puntero solo se activan en dispositivos compatibles y sin preferencia de movimiento reducido.

Capa adicional en `interface.css`: entrada escalonada de tarjetas, indicador de conexión con pulso, título de sección con acento, avisos con icono y barra de tiempo, comprobantes con aparición suave, encabezados de tabla fijos y estado de carga visible en tablas. Solo afecta la presentación.

## Comportamiento operativo

- Ventas, ediciones, anulaciones, ingresos, transferencias y cambios de catálogo se confirman completos o se revierten en el servidor.
- Cada solicitud conserva un UUID para reintentar sin duplicar. Ante desconexión use «Reintentar operación pendiente»; no cambie los datos de una operación pendiente.
- El registro de reintentos usa `sessionStorage`: conserve abierta la pestaña hasta confirmar todas las operaciones. No garantiza recuperación después de cerrar el navegador. El sistema advierte al salir si hay operaciones pendientes.
- Un registro local dañado o bloqueado impide enviar nuevas escrituras; no lo borre para intentar de nuevo sin revisar el comprobante. Una respuesta sin confirmación válida conserva el UUID. Si falla la limpieza local después de confirmar, el aviso distingue que la operación ya se guardó.
- Las anulaciones conservan cabeceras y detalles. Una reversión de transferencia agrega un movimiento compensatorio y conserva el original.
- Editar una venta o un producto verifica que la versión original no cambió en otro equipo.
- No se renombra un ITEM con historial. Los productos no se eliminan desde la interfaz.
- Importar CSV actualiza catálogo y precio de productos existentes, conservando sus existencias. Los nuevos toman el saldo del archivo. Para sumar stock, usar Ingreso.
- Dashboard y reabastecimiento excluyen ventas anuladas. Los listados leen todas las páginas de datos. La fecha comercial usa America/La_Paz.
- El historial conserva las fechas Desde/Hasta sin convertirlas a otra zona horaria. Sus ventanas de siete y treinta días incluyen hoy; los rangos invertidos se rechazan. Las respuestas atrasadas no reemplazan un filtro más reciente y los errores no muestran totales anteriores como vigentes.
- Las cotizaciones se guardan en Supabase y se comparten entre usuarios autorizados. Vencen después de tres días y se conservan. Guardar una cotización editada renueva su vigencia.
- Abrir la aplicación no crea productos de ejemplo ni elimina cotizaciones vencidas.
- Si una venta o un ingreso ya se confirmó pero falla la preparación visual del formulario siguiente, no se muestra como fallido: un aviso indica que quedó guardado y pide recargar. Así se evita repetirlo con otro número.
- Al escribir un ITEM en una venta, un código ambiguo o una lectura fallida se informan sin romper la fila. Una respuesta atrasada no reemplaza un ITEM más reciente.

## Historial de un producto

La lupa del inventario abre dos vistas: **Ventas** (incluye anuladas, excluidas de los totales) y **Movimientos** (transferencias y reversiones entre SENKATA y CEJA). Se muestran fecha comercial, cantidad, origen, destino y estado, conservando el original.

Para ver la fecha y hora de confirmación en horario de Bolivia, ejecutar `migrations/003_product_movement_history.sql` en el SQL Editor del clon **tgggakuinkbibqvvuvob**. Solo instala una función de lectura; no modifica filas existentes ni expone el contenido del diario. Los movimientos anteriores sin marca de operación muestran «Hora no registrada». Si falta la función, la vista informa que debe instalarse y permite consultar las fechas sin inventar horas. Otros errores de consulta se muestran explícitamente.

## Estructura

- `app.js`: interfaz y flujos comerciales.
- `modules/store.js`: validación, lecturas completas, reintentos y llamadas transaccionales.
- `modules/dashboard.js`: panel de solo lectura con períodos de 7/30/90 días, comparación contra el período anterior y gráficos con días sin ventas. El stock refleja existencias actuales; la reposición usa siempre 30 días de demanda.
- `interface.css`: estilos compartidos, navegación lateral en escritorio y diseño adaptable. El dashboard distingue ingresos de mercadería al costo de ventas netas; no calcula utilidad.
- `migrations/001_atomic_store.sql`: transacciones y diario de solicitudes.
- `modules/cotizaciones.js`: cotizaciones protegidas por permisos y versiones.
- `modules/prediction*.js`: herramientas de referencia cambiaria, independientes de la persistencia comercial.
- `styles.css`: presentación adaptable.
- `tests/`: pruebas aisladas.
- `scripts/`: servidor local, instalador SQL y pruebas del clon.

## Límites

Esta actualización no corrige ni reescribe posibles inconsistencias históricas. La reconciliación de datos anteriores necesita una revisión aparte. El acceso interno requiere autenticación y permisos desde la migración 004. Las bibliotecas principales están en `vendor/`; Supabase, clima y cotizaciones de mercado requieren conexión. La tipografía tiene alternativas locales si Google Fonts no responde.
