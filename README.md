# StockMario · Gestión de Depósito SwissNet

Sistema web para registrar **retiros y devoluciones** de materiales del depósito mediante un código QR único, con historial trazable, sumatorias acumuladas y control de herramientas pendientes de devolución.

- **Frontend:** React + TypeScript + Vite + Tailwind CSS, responsive (prioridad: celular).
- **Backend y base de datos:** Supabase (PostgreSQL + Auth + RLS + funciones RPC transaccionales).
- **Publicación:** Vercel (URL estable para el QR físico).

---

## 1. Estructura del proyecto

```
StockMario/
├── index.html
├── package.json
├── vite.config.ts / tailwind.config.js / postcss.config.js / tsconfig.json
├── .env.example                      Variables de entorno de ejemplo
├── supabase/
│   └── migrations/                   Migraciones SQL versionadas (ejecutar en orden)
│       ├── 0001_schema.sql           Tablas, triggers, vistas e índices
│       ├── 0002_rpcs.sql             Funciones RPC transaccionales + importación
│       └── 0003_rls.sql              Políticas Row Level Security
└── src/
    ├── main.tsx / App.tsx / index.css
    ├── lib/
    │   ├── supabase.ts               Cliente Supabase (solo anon key, nunca service_role)
    │   ├── types.ts                  Tipos de dominio
    │   ├── format.ts                 Fechas (America/Argentina/Buenos_Aires), cantidades
    │   ├── csv.ts                    Exportación a CSV
    │   └── image.ts                  Compresión de fotos en navegador (WebP/JPEG + EXIF)
    └── pages/
        ├── MovementForm.tsx          Formulario móvil (lo que ven los técnicos)
        ├── LoginPage.tsx             Acceso administrativo
        └── admin/
            ├── AdminLayout.tsx       Layout protegido + navegación
            ├── Dashboard.tsx         Métricas del depósito
            ├── History.tsx           Historial con filtros + export CSV
            ├── Summaries.tsx         Sumatorias por material / técnico / pendientes
            ├── Pending.tsx           Herramientas fuera del depósito
            ├── Materials.tsx         CRUD de materiales + importación CSV
            ├── Technicians.tsx       CRUD de técnicos
            └── PhotoPreview.tsx      Vista previa firmada de fotos de retiros
```

---

## 2. Modelo de datos

| Tabla | Descripción |
|---|---|
| `technicians` | Técnicos con `active` (los inactivos no aparecen en el formulario). |
| `materials` | Catálogo: `code` (único), `name`, `category`, `material_type` (`consumable`/`reusable`), `unit`, `initial_stock`, `minimum_stock`, `active`. |
| `movements` | Historial **inmutable**: `withdrawal` o `return`, cantidad > 0, `created_at` del servidor (timestamptz), `notes`, `created_by`, `idempotency_key` (previene duplicados por doble pulsación). |
| `movement_return_allocations` | Devolución parcial asignada a retiros originales de herramientas reutilizables. |
| `profiles` | Usuarios de Supabase Auth con rol `admin`. |

**Vistas de cálculo** (siempre derivadas del historial, nunca valores manuales):
- `v_material_stock`: stock actual = inicial + devoluciones − retiros, con marcadores de stock bajo/fuera de stock.
- `v_pending_withdrawals`: unidades pendientes de devolución por retiro (técnico, material, fecha).
- `v_allocation_detail`: qué devoluciones cubren cada retiro.

**Fórmula:** SALIDA NETA = TOTAL RETIRADO − TOTAL DEVUELTO.

---

## 3. Configuración de Supabase (paso a paso)

1. Creá el proyecto en <https://supabase.com> (plan gratuito alcanza).
2. Anotá de **Settings → API**: la URL del proyecto y la clave `anon` **pública**. La `service_role` **nunca** se pega en el frontend.
3. Abrí **SQL Editor** y ejecutá, en orden, el contenido de cada migración:
   1. `supabase/migrations/0001_schema.sql`
   2. `supabase/migrations/0002_rpcs.sql`
   3. `supabase/migrations/0003_rls.sql`
4. Creá el primer administrador:
   - **Authentication → Users → Add user → Create new user**, con email y contraseña, y **marcá "Auto Confirm User"**.
   - El trigger `handle_new_user` crea automáticamente su perfil con rol `admin`.
5. **Cerrar el registro abierto:** en **Authentication → Sign In / Providers → Email**, deshabilitá **"Allow new users to sign up"** (importante: evita que cualquier persona cree una cuenta admin). Agregá administradores nuevos siempre desde el panel de Auth.
6. Opcional: en **Authentication → URL Configuration**, configurá la URL final de Vercel para el logout.

### Variables de entorno

```
cp .env.example .env
```

```
VITE_SUPABASE_URL=https://TU-PROYECTO.supabase.co
VITE_SUPABASE_ANON_KEY=TU-CLAVE-ANON
```

---

## 4. Desarrollo local

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # verificación de tipos + build de producción
```

- `/` → formulario móvil de movimientos.
- `/admin` → panel administrativo (protegido con Supabase Auth).

---

## 5. Publicación en Vercel

```bash
git init && git add -A && git commit -m "StockMario v1"
```

1. Subí el repo a GitHub.
2. En <https://vercel.com> → **Add New → Project** → importá el repo.
3. Framework **Vite** detectado automático; en **Environment Variables** agregá `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`.
4. Deploy. La URL final (`https://<nombre>.vercel.app`) es **estable**: no cambia con cada actualización, por lo que el QR impreso no se vuelve a generar.

Alternativa sin Git: `npx vercel` desde la carpeta.

## 6. Generación del código QR

Cuando la app esté publicada, generá el QR apuntando a `https://<tu-app>.vercel.app/` (sugerencia: <https://www.qr-code-generator.com> o el generador integrado del celular). Imprimilo y colocá el código QR físicamente en el depósito. Recomendación: resolución ≥ 300 dpi y tamaño mínimo 10×10 cm.

## 7. Importación del inventario existente

1. Descargá la plantilla: **Admin → Materiales → Descargar plantilla CSV**.
2. Completá tu inventario actual en las columnas: `codigo, nombre, categoria, tipo, unidad, stock, minimo`.
   - `tipo`: `consumable` / `reusable` (también acepta `consumible` / `herramienta`).
   - `stock`: stock físico actual al momento de importar (se carga como stock inicial).
3. **Admin → Materiales → Importar inventario (CSV)**. Se importa por `codigo` (actualiza existentes sin pisar datos calculados). El stock inicial solo se actualiza si el material aún no registra movimientos.

## 8. Manual de uso para técnicos

1. Escaneá el código QR del depósito con la cámara del celular.
2. Seleccioná tu nombre en la lista.
3. Elegí **Retiro** o **Devolución**.
4. Buscá el material por nombre, código o categoría, y seleccionalo (verás el stock disponible).
5. Ingresá la cantidad y, si querés, una observación. La fecha y hora se registran automáticamente del servidor; no podés modificarlas.
6. Tocá **Confirmar movimiento**. Verás la confirmación y el formulario queda listo para otro registro.

Reglas para reutilizables (herramientas, equipos):
- Al devolver, la app muestra tus retiros pendientes. Por defecto la devolución se asigna automáticamente al retiro más antiguo; podés activar "Asignar manualmente" para elegir a cuál retiro corresponde.
- No se aceptan devoluciones mayores a lo que tenés pendiente.

## 9. Manual administrativo

- **Dashboard:** totales de materiales y movimientos, retiros, devoluciones, stock bajo, sin stock, unidades pendientes de devolución, últimos movimientos.
- **Historial:** tabla completa con filtros por técnico, material, tipo y rango de fechas, paginada y exportable a CSV (ábrelo en Excel con separador `;`).
- **Resumen de movimientos:** sumatorias por material (retirado / devuelto / salida neta con historial individual expandible), por técnico, y pendientes por técnico, con filtro de período, categoría y tipo.
- **Pendientes:** herramientas fuera del depósito, ordenadas por antigüedad.
- **Materiales:** crear, editar, desactivar e importar; el stock se recalcula siempre desde el historial.
- **Técnicos:** alta, edición y desactivación (los inactivos no aparecen en el formulario y conservan su historial).

### Recuperación del stock

El stock de cualquier material puede reconstruirse como `initial_stock + Σ devoluciones − Σ retiros`; los datos fuente son el historial de `movements`, que nunca se edita ni borra (RLS lo impide).

### Mantenimiento

- Copia de seguridad: Supabase permite **PITR/backups** según plan; con plan Free podés exportar `movements`, `materials` y `technicians` desde el editor SQL o **Database → Backups**.
- Rotación de claves: solo la clave `anon` vive en el frontend; si se reemplaza, actualizar las variables en Vercel y volver a desplegar.

## 10. Privacidad y seguridad implementadas

- Las operaciones críticas (retiro/devolución) son funciones RPC de PostgreSQL con `security definer`: validan técnico activo, material activo, cantidad positiva, stock disponible y pendientes de devolución dentro de una **misma transacción**; cualquier error revierte todo.
- Row Level Security en todas las tablas: el rol `anon` solo puede leer el catálogo y ejecutar las RPC; el historial completo es visible **solamente** para administradores autenticados; **no hay** políticas de UPDATE/DELETE para movimientos (historial inmutable).
- Bloqueo por fila (`FOR UPDATE` sobre el material) para prevenir carreras de stock simultáneo.
- Idempotencia por `idempotency_key` única: una doble pulsación no crea dos movimientos.
- Extensión futura habilitada: la estructura permite agregar PIN por técnico o autenticación de técnicos sin cambios de esquema mayor (la selección de nombre hoy es identificación declarada, no autenticación).

---

## 11. Fotografía obligatoria en los retiros (v1.1)

Cada **RETIRO** requiere una fotografía del material, herramienta o equipo. Las **devoluciones no piden foto** y mantienen su comportamiento original.

### Cambios en Supabase (aplicar en este orden: 2 SQL + 1 ajuste de configuración)

1. **SQL:** ejecutar en el SQL Editor `supabase/migrations/0004_movement_photos.sql`. Hace:
   - `alter table movements add column photo_path text` (nullable → compatible con los registros anteriores).
   - Reemplaza la RPC `create_withdrawal` con un parámetro opcional `p_photo_path`; dentro de la **misma transacción** valida que la fotografía ya esté subida en el bucket (`storage.objects`) y que la ruta respete el patrón `YYYY/MM/UUID.webp|jpg`. Si la foto falta o la suba falló, el retiro **no se registra** (PHOTO_REQUIRED / PHOTO_MISSING).
   - Crea el bucket privado `movement-photos` (límite 5 MB por archivo).
   - Políticas de Storage:
     - Administradores autenticados: acceso completo al bucket (lectura vía **URLs firmadas**).
     - Rol `anon` (el QR público): solo **INSERT** y **DELETE** de archivos cuya ruta coincida estrictamente con `^\d{4}/\d{2}/UUID\.(webp|jpe?g)$` y ≤ 5 MB. No hay política de lectura para `anon`: el bucket es privado.
2. **Sin Edge Function requerida:** la restricción se logra con políticas de Storage por patrón de ruta (si alguien con la anon key intentara subir otro archivo, Storage lo rechaza). Endurecimiento opcional futuro: Edge Function `upload-movement-photo` con `service_role` del lado del servidor para quien requiera control adicional.

### Flujo del formulario (público)

1. Botones **"📷 Tomar foto"** (`capture="environment"`, abre la cámara en Chrome/Opera/Safari) y **"De la galería"** (sin `capture`, el navegador decide).
2. Al elegir imagen se comprime **en el navegador**: corrección de orientación EXIF, lado máximo 1280 px sin deformar, WebP calidad 0,75 (fallback JPEG); objetivo 100–300 KB; nunca se sube el original (límite 15 MB, validación de MIME y decodificación).
3. Vista previa con "Repetir foto" / "Eliminar".
4. Al confirmar: `upload → create_withdrawal(p_photo_path)`. Si el registro falla después de subir, se **borra el archivo** (compensación, política anon DELETE) y no queda retiro sin foto ni archivo huérfano por reintento.
5. Estados visibles: esperando foto / foto seleccionada / comprimiendo / subiendo / registrando / registrado / error. El botón queda deshabilitado durante el procesamiento (sin duplicaciones, además del `idempotency_key`).

### Historial administrativo

- Columna **Foto** con indicador `📷 Ver` solo en movimientos que tienen foto; los antiguos muestran "—" y siguen iguales.
- La vista previa (`PhotoPreview.tsx`) genera la **URL firmada bajo demanda** al abrir (no descarga todas las imágenes del listado), con "Abrir en tamaño completo".

### Pruebas recomendadas antes de desplegar

1. Chrome Android / Opera Android: retiro con cámara y desde galería; iPhone (Safari): retiro con cámara.
2. Imagen grande (> 5 MB que comprime a < 300 KB), vertical y horizontal (verificar orientación EXIF correcta).
3. Intentar confirmar retiro **sin foto** → botón bloqueado.
4. Simular fallo de suba (ej: modo avión justo tras confirmar) → mensaje de error, **sin** movimiento registrado y **sin** archivo en el bucket.
5. Consultar la foto en Admin → Historial y verificar que los movimientos anteriores y las devoluciones siguen igual.

### Despliegue de la actualización (Vercel)

1. Aplicar la migración 0004 en Supabase (punteada arriba).
2. Commit y push del código (o `npx vercel --prod`): la URL **no cambia**, el QR impreso sigue válido.

---

## 12. Privacidad y seguridad implementadas (resumen v1)

- Las operaciones críticas (retiro/devolución) son funciones RPC de PostgreSQL con `security definer`: validan técnico activo, material activo, cantidad positiva, stock disponible y pendientes de devolución dentro de una **misma transacción**; cualquier error revierte todo.
- Row Level Security en todas las tablas: el rol `anon` solo puede leer el catálogo y ejecutar las RPC; el historial completo es visible **solamente** para administradores autenticados; **no hay** políticas de UPDATE/DELETE para movimientos (historial inmutable).
- Bloqueo por fila (`FOR UPDATE` sobre el material) para prevenir carreras de stock simultáneo.
- Idempotencia por `idempotency_key` única: una doble pulsación no crea dos movimientos.
- La clave `service_role` nunca se usa ni se expone en el frontend.

---

## 13. Cámara obligatoria y devoluciones con aprobación (v1.2)

### Retiros: solo cámara en el momento

- El input de archivos fue **eliminado**; no existe botón de galería ni `accept="image/*"`.
- Nuevo componente `src/components/CameraCapture.tsx`: `navigator.mediaDevices.getUserMedia()` con `facingMode: environment` (cámara trasera), video `playsInline`, botón **Abrir cámara** → **Capturar foto** → vista previa → **Volver a tomar / Descartar**.
- Mensajes claros para: permiso denegado, sin cámara, navegador incompatible y error interno.
- Las pistas de video se detienen al capturar, desmontar el componente o cambiar de pantalla (cleanup de React).
- Se mantiene la compresión previa (WebP 1ª opción, JPEG fallback; ≤ 1280 px; calidad ~0.75).

### Devoluciones: flujo con aprobación administrativa

**Formulario del técnico:** al elegir DEVOLUCIÓN ya no registra el movimiento: envía una **solicitud** (RPC `create_return_request`, que valida técnico/material activos, cantidad > 0 y asignaciones compatibles para reutilizables). Confirmación: *"Devolución enviada correctamente. Está pendiente de aprobación por el administrador."* El stock no cambia.

**Modelo:** tabla `return_requests` (`status: pending/approved/rejected`, `requested_at`, `resolved_by → profiles`, `resolved_at`, `admin_notes`, `movement_id`, `allocations` jsonb, `idempotency_key`) con CHECK de invariantes de estado (pendiente sin resolver; aprobada con movimiento; rechazada con motivo). Las devoluciones efectivas siguen siendo filas de `movements` — los históricos y sumatorias **no cambian** y no cuentan solicitudes pendientes/rechazadas.

**RPCs transaccionales:**
- `create_return_request(...)` — alta de solicitud (rol anon, sin tocar stock).
- `approve_return_request(p_request_id)` — solo `is_admin`; bloquea la fila de la solicitud (`FOR UPDATE`, un segundo intento falla con REQUEST_ALREADY_RESOLVED), bloquea la fila del material (protección contra dos aprobaciones simultáneas), **revalida** pendientes reales de cada retiro, crea el movimiento, genera/revalida las asociaciones de devoluciones parciales (FIFO o las solicitadas por el técnico) y registra resolved_by/resolved_at. Todo o nada.
- `reject_return_request(p_request_id, p_admin_notes)` — marca rechazada con motivo; sin tocar stock ni historial.
- `create_return` (devolución directa legacy) quedó **restringida a administradores** (se revocó al rol anon) y con bloqueo por filas base corregido (bug latente de `FOR UPDATE` sobre vista, aplicado también en la vía de aprobación).

**Panel administrativo:**
- Nueva sección **Devoluciones pendientes** (`/admin/devoluciones`): tabla con solicitada/técnico/material/cantidad/unidad/observaciones/estado y acciones **Aprobar / Rechazar** con confirmación (el rechazo exige motivo). Errores mostrados sin procesar nada parcialmente.
- Indicador visible: badge con contador en la navegación + tarjeta en el Dashboard, refresco automático (45 s y al resolver una solicitud).
- **Historial:** al filtrar por tipo *Devoluciones* la tabla cambia al flujo combinado (vista `v_return_flow`: devoluciones efectivas + solicitudes pendientes/rechazadas sin duplicar) con columnas de estado, resolvió (usuario y fecha) y motivo, además del filtro "Estado devolución" (Todas/Pendientes/Aprobadas/Rechazadas) y CSV propio.

### SQL y despliegue

1. Ejecutar en el SQL Editor **`supabase/migrations/0005_return_requests.sql`** (idempotente): tabla + índices + CHECKs, 3 RPCs nuevas, corrección de `create_return`, revocación de `create_return` al rol anon, vista `v_return_flow`, RLS de `return_requests` y el extra de lectura de `profiles` para administradores.
2. Ejecutar en el SQL Editor **`supabase/migrations/0006_hotfix_storage_type_and_approve.sql`** (idempotente): corrige `create_withdrawal` (la foto se valida por `metadata->>'mimetype'` porque la columna `content_type` ya no existe en `storage.objects`) y corrige `approve_return_request` (un `SELECT` de técnicos sin `INTO` abortaba toda aprobación).
3. Sin cambios de Storage ni de Edge Functions.
4. Deploy: push a GitHub (Vercel redespliega automático; URL y QR intacta).

---

## 14. Retiros con aprobación administrativa (v1.3)

**Formulario del técnico:** al registrar un RETIRO ya no se descuenta stock: la foto se sube y se crea una **solicitud** (`create_withdrawal_request`, misma validación de fotografía obligatoria). Confirmación: *"Retiro registrado correctamente. Está pendiente de aprobación por el administrador."* La solicitud no se puede modificar luego de enviarse.

**Modelo:** tabla `withdrawal_requests` (`status: pending/approved/rejected/corrected`, `requested_at`, `resolved_by → profiles`, `resolved_at`, `admin_notes`, `photo_path` obligatoria, `movement_id` del movimiento efectivo, `corrected_material_id`/`corrected_quantity` reales, `resolution_reason: nothing_withdrawn | different_material_withdrawn`, `idempotency_key`) con CHECK de invariantes de estado.

**Tres caminos del administrador** (`/admin/retiros`, con listado de fecha/técnico/material/cantidad/unidad/foto/observaciones y foto ampliada junto a los datos declarados):
1. **Aprobar retiro** (`approve_withdrawal_request`): confirma el movimiento tal como lo declaró el técnico y descuenta stock.
2. **Rechazar: no se retiró nada** (`reject_withdrawal_request`): motivo `nothing_withdrawn`, con observación administrativa opcional; el stock no cambia y la solicitud queda en historial.
3. **Rechazar: se retiró otro material** (`correct_withdrawal_request`): selector de material real del catálogo (unidad automática) + cantidad real validada + observaciones. Se crea un movimiento efectivo independiente con la cantidad REAL del material REAL (solo eso se descuenta), queda vinculado a la solicitud original (`movement_id`) y los datos originales del técnico **no se sobrescriben** (`.status = 'corrected'`, motivo `different_material_withdrawn`).

**RPCs transaccionales** (security definer, `FOR UPDATE` sobre la solicitud y sobre la fila del material → doble aprobación y aprobaciones simultáneas quedan bloqueadas; error con rollback completo). La validación de stock ocurre **en la transacción** de la aprobación/corrección: si no alcanza el stock, no se procesa nada (`STOCK_INSUFFICIENT`). Los JSON de error marcan `REQUEST_ALREADY_RESOLVED` si la solicitud ya fue resuelta.

**Historial administrativo:** filtro por tipo *Retiros* consulta la vista `v_withdrawal_flow` con filtro de estado (Todas/Pendientes/Aprobadas/Rechazadas/Corregidas): muestra datos originales declarados + resolución (material real, cantidad real, resolvió, fecha, motivo) sin duplicar retiros corregidos, y exporta CSV propio. Las solicitudes pendientes/rechazadas no cuentan en inventario ni sumatorias; los corregidos contabilizan solo el movimiento efectivo. Filtros anteriores y devoluciones (v1.2) intactos.

**Compatibilidad retiros ↔ devoluciones:** el movimiento creado al aprobar/corregir es un retiro normal de `movements`, por lo que `v_pending_withdrawals` y la vinculación de devoluciones parciales reutilizables funcionan igual que siempre.

### SQL y despliegue (v1.3)

1. Ejecutar en el SQL Editor **`supabase/migrations/0007_withdrawal_requests.sql`** (idempotente): tabla, RPCs, vista `v_withdrawal_flow`, RLS y revocación de `create_withdrawal` al rol anon (todo retiro público pasa por aprobación).
2. Deploy: push a GitHub (Vercel redespliega automático; URL y QR intacta).

### Pruebas obligatorias cubiertas (resumen)

Retiro solo-cámara en Chrome/Opera/Opera con rechazo de permisos; solicitud de devolución → queda pendiente y el stock no varía; aprobar → stock y pendientes actualizados con auditoría; rechazar → sin cambios con motivo; doble aprobación y aprobación simultánea bloqueadas por `FOR UPDATE`; devolución parcial reutilizable con revalidación de asignaciones; históricos intactos.
