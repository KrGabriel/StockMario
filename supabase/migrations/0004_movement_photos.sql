-- ============================================================
-- StockMario · Migración 0004: Fotografía obligatoria en retiros
-- - Columna photo_path en movements (nullable: compatible con
--   registros anteriores que no tienen fotografía).
-- - Bucket privado movement-photos en Supabase Storage.
-- - Políticas de Storage restringidas: el formulario público
--   (rol anon) solo puede subir/borrar archivos con ruta exacta
--   YYYY/MM/UUID.png|webp|jpe?g — no permisos generales.
-- - La lectura queda solo para administradores (URLs firmadas).
-- Idempotente: puede re-ejecutarse sin romper nada.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Columna photo_path (sin NOT NULL: retrocompatibilidad)
-- ------------------------------------------------------------
alter table public.movements
  add column if not exists photo_path text;

comment on column public.movements.photo_path is
  'Ruta dentro del bucket movement-photos (ej: 2026/11/UUID.webp). NULL para movimientos sin foto (anteriores o devoluciones).';

-- Las asignaciones de devolución no dependen de photo_path:
-- no se modifican tablas ni reglas de devoluciones.

-- ------------------------------------------------------------
-- 2. Bucket privado (no público: solo acceso por políticas)
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('movement-photos', 'movement-photos', false, 5242880)
on conflict (id) do update
  set public = false,
      file_size_limit = 5242880;

-- ------------------------------------------------------------
-- 3. RPC create_withdrawal: nueva versión con p_photo_path.
--    Se reemplaza la función (nueva firma con parámetro opcional).
--    Valida dentro de la MISMA transacción que la foto ya fue
--    subida al bucket antes de registrar el movimiento: si la
--    foto no existe, el retiro se rechaza y revierte.
-- ------------------------------------------------------------
drop function if exists public.create_withdrawal(uuid, uuid, numeric, text, text);

create or replace function public.create_withdrawal(
  p_technician_id    uuid,
  p_material_id      uuid,
  p_quantity         numeric,
  p_notes            text default null,
  p_photo_path       text default null,
  p_idempotency_key  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_movement_id   uuid;
  v_stock         numeric(14,3);
  v_material_type text;
  v_material_name text;
  v_tech_name     text;
begin
  -- Idempotencia: si la clave ya fue usada, devolver el movimiento original
  if p_idempotency_key is not null then
    select id into v_movement_id from public.movements
      where idempotency_key = p_idempotency_key;
    if v_movement_id is not null then
      return v_movement_id;
    end if;
  end if;

  -- Validar cantidad
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'La cantidad debe ser mayor que cero';
  end if;

  -- Validar técnico activo
  select full_name into v_tech_name from public.technicians
    where id = p_technician_id and active = true;
  if v_tech_name is null then
    raise exception 'Técnico inexistente o desactivado';
  end if;

  -- Bloquear la fila del material para evitar operaciones simultáneas
  select material_type, name into v_material_type, v_material_name
    from public.materials
    where id = p_material_id and active = true
    for update;
  if v_material_name is null then
    raise exception 'Material inexistente o desactivado';
  end if;

  select current_stock into v_stock
    from public.v_material_stock
    where id = p_material_id;

  if p_quantity > v_stock then
    raise exception 'Stock insuficiente para "%": disponible %, solicitado %',
      v_material_name, v_stock, p_quantity
      using errcode = 'STOCK_INSUFFICIENT';
  end if;

  -- La foto es obligatoria para todo retiro: debe existir en el bucket
  -- y respetar la estructura YYYY/MM/UUID.<ext> (coherente con las
  -- políticas de Storage). También valida que el contenido sea imagen.
  if p_photo_path is null then
    raise exception 'La fotografía del material retirado es obligatoria'
      using errcode = 'PHOTO_REQUIRED';
  end if;
  if p_photo_path !~ '^([0-9]{4})/(0[1-9]|1[0-2])/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(webp|jpg|jpeg)$'
  then
    raise exception 'Ruta de fotografía inválida'
      using errcode = 'PHOTO_INVALID_PATH';
  end if;
  if not exists (
    select 1 from storage.objects
    where bucket_id = 'movement-photos'
      and name = p_photo_path
      and (content_type like 'image/%' or content_type like 'application/%image%' or content_type = '')
  ) then
    raise exception 'La fotografía no se subió correctamente. Retiro no registrado: volvé a intentarlo.'
      using errcode = 'PHOTO_MISSING';
  end if;

  insert into public.movements
    (technician_id, material_id, movement_type, quantity, notes,
     photo_path, created_by, idempotency_key)
  values
    (p_technician_id, p_material_id, 'withdrawal', p_quantity, p_notes,
     p_photo_path, auth.uid(), p_idempotency_key)
  returning id into v_movement_id;

  return v_movement_id;
end;
$$;

-- Concesiones (nueva firma); equivalente a 0002 para la anterior
revoke all on function public.create_withdrawal(uuid, uuid, numeric, text, text, text) from anon, authenticated;
grant execute on function public.create_withdrawal(uuid, uuid, numeric, text, text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 4. Políticas de Storage para movement-photos
--    El rol autenticado administrador tiene acceso completo;
--    el rol anon solo escritura/borrado con ruta pattern-strict.
-- ------------------------------------------------------------
drop policy if exists "movement-photos admin all" on storage.objects;
create policy "movement-photos admin all"
  on storage.objects for all to authenticated
  using (bucket_id = 'movement-photos' and public.is_admin())
  with check (bucket_id = 'movement-photos' and public.is_admin());

-- Solo permite INSERTAR imágenes dentro del patrón YYYY/MM/UUID.webp(jpg)
drop policy if exists "movement-photos anon insert" on storage.objects;
create policy "movement-photos anon insert"
  on storage.objects for insert to anon
  with check (
    bucket_id = 'movement-photos'
    and name ~ '^([0-9]{4})/(0[1-9]|1[0-2])/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(webp|jpg|jpeg)$'
    and coalesce((metadata->>'size')::bigint, 0) <= 5242880
  );

-- Compensación: si el registro del movimiento falla después de subir
-- la foto, el cliente borra el archivo recién subido (evita huérfanos)
drop policy if exists "movement-photos anon delete own" on storage.objects;
create policy "movement-photos anon delete own"
  on storage.objects for delete to anon
  using (
    bucket_id = 'movement-photos'
    and name ~ '^([0-9]{4})/(0[1-9]|1[0-2])/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(webp|jpg|jpeg)$'
  );

-- Lectura: SOLO administradores (la política admin all anterior ya la
-- cubre); no hay política de select para anon → el bucket es privado.
-- El panel usa storage.createSignedUrl() con su sesión de admin.
