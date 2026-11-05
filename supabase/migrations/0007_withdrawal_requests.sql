-- ============================================================
-- StockMario · Migración 0007: Retiros con aprobación admin
-- 1) Tabla withdrawal_requests (solicitud del técnico → aprobación /
--    rechazo / corrección del material real)
-- 2) RPCs transaccionales: create_withdrawal_request /
--    approve_withdrawal_request / reject_withdrawal_request /
--    correct_withdrawal_request (FOR UPDATE contra doble aprobación
--    y aprobaciones simultáneas; validación de stock en la misma
--    transacción que confirma el movimiento)
-- 3) Vista v_withdrawal_flow: historial administrativo (datos
--    originales del técnico + resolución administrativa, sin
--    duplicar movimiento efectivo y solicitud)
-- 4) Compatibilidad:
--    - Los movimientos históricos NO se tocan.
--    - Las solicitudes pendientes/rechazadas NO cuentan para stock
--      ni sumatorios (no existen en movements hasta aprobarse).
--    - Inventario reutilizable: el movimiento creado al aprobar usa
--      el mismo mecanismo derivado, por lo que v_pending_withdrawals
--      y la vinculación de devoluciones funcionan igual que siempre.
--    - El flujo de devoluciones (0005/0006) no se modifica.
-- 5) create_withdrawal (registro directo efectivo) deja de ser
--    ejecutable por anon: todo retiro público pasa por aprobación.
-- Idempotente: puede re-ejecutarse.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tabla withdrawal_requests
-- ------------------------------------------------------------
create table if not exists public.withdrawal_requests (
  id                      uuid primary key default extensions.gen_random_uuid(),
  technician_id           uuid not null references public.technicians (id),
  material_id             uuid not null references public.materials (id),
  quantity                numeric(14,3) not null check (quantity > 0),
  notes                   text,
  photo_path              text not null,
  status                  text not null default 'pending'
                            check (status in ('pending', 'approved', 'rejected', 'corrected')),
  resolution_reason       text check (resolution_reason in ('nothing_withdrawn', 'different_material_withdrawn')),
  corrected_material_id   uuid references public.materials (id),
  corrected_quantity      numeric(14,3) check (corrected_quantity is null or corrected_quantity > 0),
  admin_notes             text,
  requested_at            timestamptz not null default now(),
  resolved_by             uuid references public.profiles (id) on delete set null,
  resolved_at             timestamptz,
  movement_id             uuid references public.movements (id),   -- movimiento efectivo (approved/corrected)
  idempotency_key         text unique,
  created_at              timestamptz not null default now(),

  -- Invariantes de estado (auditoría completa: originales + resolución)
  constraint withdrawal_requests_state_check check (
    (status = 'pending'
      and resolved_by is null and resolved_at is null and movement_id is null
      and resolution_reason is null
      and corrected_material_id is null and corrected_quantity is null)
    or
    (status = 'approved'
      and resolved_by is not null and resolved_at is not null
      and movement_id is not null
      and resolution_reason is null
      and corrected_material_id is null and corrected_quantity is null)
    or
    (status = 'rejected'
      and resolved_by is not null and resolved_at is not null
      and movement_id is null
      and resolution_reason = 'nothing_withdrawn'
      and corrected_material_id is null and corrected_quantity is null)
    or
    (status = 'corrected'
      and resolved_by is not null and resolved_at is not null
      and movement_id is not null
      and resolution_reason = 'different_material_withdrawn'
      and corrected_material_id is not null and corrected_quantity is not null)
  )
);

comment on table public.withdrawal_requests is
  'Solicitudes de retiro del técnico. Quedan en pending sin afectar stock; el admin aprueba (crea el movimiento real tal como se declaró), rechaza sin stock (nothing_withdrawn) o corrige material/cantidad reales (different_material_withdrawn, crea el movimiento efectivo con los datos reales y conserva los originales sin pisarlos).';

create index if not exists idx_withdrawal_requests_status      on public.withdrawal_requests (status, requested_at desc);
create index if not exists idx_withdrawal_requests_technician  on public.withdrawal_requests (technician_id);
create index if not exists idx_withdrawal_requests_material    on public.withdrawal_requests (material_id);
create index if not exists idx_withdrawal_requests_movement    on public.withdrawal_requests (movement_id);
create index if not exists idx_withdrawal_requests_corr_mat    on public.withdrawal_requests (corrected_material_id);

-- ------------------------------------------------------------
-- 2. RPCs transaccionales
-- ------------------------------------------------------------

-- 2.a) create_withdrawal_request: alta de la solicitud por el formulario
--      público. NO valida ni modifica stock: el inventario solo se
--      descuenta cuando el administrador aprueba o corrige.
--      La fotografía (obligatoria) se valida igual que en create_withdrawal:
--      debe existir en el bucket con ruta YYYY/MM/UUID.webp|jpe?g.
create or replace function public.create_withdrawal_request(
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
  v_request_id    uuid;
  v_material_name text;
  v_tech_name     text;
begin
  -- Idempotencia: si la clave ya fue usada, devolver la solicitud original
  if p_idempotency_key is not null then
    select id into v_request_id from public.withdrawal_requests
      where idempotency_key = p_idempotency_key;
    if v_request_id is not null then
      return v_request_id;
    end if;
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'La cantidad debe ser mayor que cero';
  end if;

  select full_name into v_tech_name from public.technicians
    where id = p_technician_id and active = true;
  if v_tech_name is null then
    raise exception 'Técnico inexistente o desactivado';
  end if;

  select name into v_material_name
    from public.materials
    where id = p_material_id and active = true;
  if v_material_name is null then
    raise exception 'Material inexistente o desactivado';
  end if;

  -- La foto es obligatoria para todo retiro: debe existir en el bucket
  -- con la estructura YYYY/MM/UUID.<ext> y contenido de imagen.
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
      and coalesce(metadata->>'mimetype', '') like 'image/%'
  ) then
    raise exception 'La fotografía no se subió correctamente. Retiro no registrado: volvé a intentarlo.'
      using errcode = 'PHOTO_MISSING';
  end if;

  insert into public.withdrawal_requests
    (technician_id, material_id, quantity, notes, photo_path,
     requested_at, idempotency_key)
  values
    (p_technician_id, p_material_id, p_quantity, p_notes, p_photo_path,
     now(), p_idempotency_key)
  returning id into v_request_id;

  return v_request_id;
end;
$$;

-- 2.b) approve_withdrawal_request: aprueba la solicitud tal como la registró
--      el técnico y crea el movimiento efectivo dentro de la MISMA
--      transacción. Valida stock disponible en el momento de la aprobación;
--      si es insuficiente, no procesa nada (rollback completo).
create or replace function public.approve_withdrawal_request(p_request_id uuid)
returns uuid   -- id del movimiento de retiro creado
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req            public.withdrawal_requests%rowtype;
  v_material_name  text;
  v_tech_name      text;
  v_movement_id    uuid;
  v_stock          numeric(14,3);
begin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden aprobar retiros'
      using errcode = 'INSUFFICIENT_PRIVILEGE';
  end if;

  -- Bloquear la fila: dos aprobaciones simultáneas se serializan aquí y el
  -- segundo intento ve el estado ya resuelto (REQUEST_ALREADY_RESOLVED)
  select * into v_req from public.withdrawal_requests
    where id = p_request_id
    for update;
  if not found then
    raise exception 'Solicitud de retiro inexistente';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'La solicitud ya fue resuelta (estado: %)', v_req.status
      using errcode = 'REQUEST_ALREADY_RESOLVED';
  end if;

  -- Revalidar sobre la geometría actual del inventario
  select full_name into v_tech_name from public.technicians
    where id = v_req.technician_id and active = true;
  if not found then
    raise exception 'El técnico ya no está activo: no se puede aprobar';
  end if;

  select name into v_material_name
    from public.materials
    where id = v_req.material_id and active = true
    for update;   -- serializa aprobaciones concurrentes sobre el mismo stock
  if v_material_name is null then
    raise exception 'El material ya no está activo: no se puede aprobar';
  end if;

  select current_stock into v_stock
    from public.v_material_stock
    where id = v_req.material_id;

  if v_req.quantity > v_stock then
    raise exception 'Stock insuficiente para "%": disponible %, solicitado %',
      v_material_name, v_stock, v_req.quantity
      using errcode = 'STOCK_INSUFFICIENT';
  end if;

  -- Movimiento efectivo de retiro (el stock se actualiza por derivación
  -- de movements). Mantiene la fotografía original vinculada.
  insert into public.movements
    (technician_id, material_id, movement_type, quantity, notes, photo_path, created_by)
  values
    (v_req.technician_id, v_req.material_id, 'withdrawal', v_req.quantity,
     v_req.notes, v_req.photo_path, auth.uid())
  returning id into v_movement_id;

  -- Registrar resolución administrativa en la misma transacción
  update public.withdrawal_requests
    set status      = 'approved',
        resolved_by = auth.uid(),
        resolved_at = now(),
        movement_id = v_movement_id
    where id = v_req.id;

  return v_movement_id;
end;
$$;

-- 2.c) reject_withdrawal_request: rechaza porque no se retiró nada.
--      Sin tocar stock ni historial; conserva foto y datos originales.
create or replace function public.reject_withdrawal_request(
  p_request_id  uuid,
  p_admin_notes text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden rechazar retiros'
      using errcode = 'INSUFFICIENT_PRIVILEGE';
  end if;

  select status into v_status from public.withdrawal_requests
    where id = p_request_id
    for update;
  if not found then
    raise exception 'Solicitud de retiro inexistente';
  end if;
  if v_status <> 'pending' then
    raise exception 'La solicitud ya fue resuelta (estado: %)', v_status
      using errcode = 'REQUEST_ALREADY_RESOLVED';
  end if;

  update public.withdrawal_requests
    set status             = 'rejected',
        resolution_reason  = 'nothing_withdrawn',
        resolved_by        = auth.uid(),
        resolved_at        = now(),
        admin_notes        = nullif(btrim(p_admin_notes), ''),
        corrected_material_id = null,
        corrected_quantity    = null
    where id = p_request_id;
end;
$$;

-- 2.d) correct_withdrawal_request: el material/cantidad declarados no
--      coinciden con la realidad. Registra el material y la cantidad
--      REALES, crea un movimiento efectivo por el retiro real y queda
--      vinculado a la solicitud original (los datos del técnico NO se
--      sobrescriben: registro auditable completo). Desuenta la
--      cantidad REAL del material REAL, con validación de stock.
create or replace function public.correct_withdrawal_request(
  p_request_id             uuid,
  p_corrected_material_id  uuid,
  p_corrected_quantity     numeric,
  p_admin_notes            text default null
)
returns uuid   -- id del movimiento efectivo creado
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req                 public.withdrawal_requests%rowtype;
  v_material_name       text;
  v_corr_material_name  text;
  v_tech_name           text;
  v_movement_id         uuid;
  v_stock               numeric(14,3);
begin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden corregir retiros'
      using errcode = 'INSUFFICIENT_PRIVILEGE';
  end if;

  select * into v_req from public.withdrawal_requests
    where id = p_request_id
    for update;
  if not found then
    raise exception 'Solicitud de retiro inexistente';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'La solicitud ya fue resuelta (estado: %)', v_req.status
      using errcode = 'REQUEST_ALREADY_RESOLVED';
  end if;

  if p_corrected_quantity is null or p_corrected_quantity <= 0 then
    raise exception 'La cantidad real retirada debe ser mayor que cero';
  end if;
  if p_corrected_material_id is null then
    raise exception 'Seleccioná el material realmente retirado';
  end if;

  select full_name into v_tech_name from public.technicians
    where id = v_req.technician_id and active = true;
  if not found then
    raise exception 'El técnico ya no está activo: no se puede corregir';
  end if;

  -- Material declarado: solo se verifica que exista (queda como registro
  -- original; no se toca el inventario por el material declarado).
  select name into v_material_name
    from public.materials
    where id = v_req.material_id;
  if v_material_name is null then
    raise exception 'El material declarado por el técnico no existe';
  end if;

  -- Material real activo + bloqueo de fila para serializar sobre el stock
  select name into v_corr_material_name
    from public.materials
    where id = p_corrected_material_id and active = true
    for update;
  if v_corr_material_name is null then
    raise exception 'El material real indicado no existe o está desactivado';
  end if;

  select current_stock into v_stock
    from public.v_material_stock
    where id = p_corrected_material_id;

  if p_corrected_quantity > v_stock then
    raise exception 'Stock insuficiente para "%": disponible %, retirado real %',
      v_corr_material_name, v_stock, p_corrected_quantity
      using errcode = 'STOCK_INSUFFICIENT';
  end if;

  -- Movimiento efectivo del retiro REAL, con la fotografía original
  -- vinculada (así el movimiento corregido conserva la evidencia).
  insert into public.movements
    (technician_id, material_id, movement_type, quantity, notes, photo_path, created_by)
  values
    (v_req.technician_id, p_corrected_material_id, 'withdrawal', p_corrected_quantity,
     v_req.notes, v_req.photo_path, auth.uid())
  returning id into v_movement_id;

  -- Resolución: la solicitud queda corregida; los datos originales
  -- del técnico permanecen intactos en esta misma fila (auditable).
  update public.withdrawal_requests
    set status                 = 'corrected',
        resolution_reason      = 'different_material_withdrawn',
        corrected_material_id  = p_corrected_material_id,
        corrected_quantity     = p_corrected_quantity,
        resolved_by            = auth.uid(),
        resolved_at            = now(),
        movement_id            = v_movement_id,
        admin_notes            = nullif(btrim(p_admin_notes), '')
    where id = v_req.id;

  return v_movement_id;
end;
$$;

-- ------------------------------------------------------------
-- 3. endurecer create_withdrawal (registro directo efectivo):
--    todo retiro del formulario público pasa por aprobación admin.
--    Los históricos no se modifican.
-- ------------------------------------------------------------
revoke all on function public.create_withdrawal(uuid, uuid, numeric, text, text, text) from anon;
grant execute on function public.create_withdrawal(uuid, uuid, numeric, text, text, text) to authenticated;

grant execute on function public.create_withdrawal_request(uuid, uuid, numeric, text, text, text) to anon, authenticated;
grant execute on function public.approve_withdrawal_request(uuid) to authenticated;
grant execute on function public.reject_withdrawal_request(uuid, text) to authenticated;
grant execute on function public.correct_withdrawal_request(uuid, uuid, numeric, text) to authenticated;

-- ------------------------------------------------------------
-- 4. Vista v_withdrawal_flow: historial de retiros para el panel
--    - Solicitudes (todas: pending/approved/rejected/corrected) con
--      datos originales del técnico + resolución administrativa.
--    - Movimientos efectivos de retiro NO generados por una solicitud
--      (históricos y registros directos de admin) como 'approved'.
--    Security_invoker: hereda RLS (solo admins ven movimientos).
-- ------------------------------------------------------------
create or replace view public.v_withdrawal_flow
with (security_invoker = true) as
select
  rq.id,
  'request'::text as source,
  rq.technician_id,
  t.full_name as technician_name,
  rq.material_id as declared_material_id,
  mat.name as declared_material_name,
  mat.code as declared_material_code,
  mat.unit as declared_unit,
  rq.quantity as declared_quantity,
  rq.photo_path,
  rq.status,
  rq.resolution_reason,
  rq.corrected_material_id,
  corr.name as corrected_material_name,
  corr.code as corrected_material_code,
  corr.unit as corrected_unit,
  rq.corrected_quantity,
  rq.notes,
  rq.resolved_by,
  prof.email as resolver_email,
  rq.resolved_at,
  rq.admin_notes,
  rq.requested_at,
  rq.movement_id
from public.withdrawal_requests rq
join public.technicians t   on t.id = rq.technician_id
join public.materials mat   on mat.id = rq.material_id
left join public.materials corr on corr.id = rq.corrected_material_id
left join public.profiles prof  on prof.id = rq.resolved_by

union all

select
  mv.id,
  'movement'::text as source,
  mv.technician_id,
  t.full_name as technician_name,
  mv.material_id as declared_material_id,
  mat.name as declared_material_name,
  mat.code as declared_material_code,
  mat.unit as declared_unit,
  mv.quantity as declared_quantity,
  mv.photo_path,
  'approved'::text as status,
  null::text as resolution_reason,
  null::uuid as corrected_material_id,
  null::text as corrected_material_name,
  null::text as corrected_material_code,
  null::text as corrected_unit,
  null::numeric as corrected_quantity,
  mv.notes,
  mv.created_by as resolved_by,
  prof.email as resolver_email,
  mv.created_at as resolved_at,
  null::text as admin_notes,
  mv.created_at as requested_at,
  mv.id as movement_id
from public.movements mv
join public.technicians t on t.id = mv.technician_id
join public.materials mat on mat.id = mv.material_id
left join public.profiles prof on prof.id = mv.created_by
where mv.movement_type = 'withdrawal'
  and not exists (
    select 1 from public.withdrawal_requests r where r.movement_id = mv.id
  );

grant select on public.v_withdrawal_flow to authenticated;

-- ------------------------------------------------------------
-- 5. Row Level Security para withdrawal_requests
--    anon: sin acceso directo a la tabla (alta solo vía RPC).
--    authenticated admin: lectura completa (aprobaciones vía RPC).
-- ------------------------------------------------------------
alter table public.withdrawal_requests enable row level security;

drop policy if exists withdrawal_requests_select_admin on public.withdrawal_requests;
create policy withdrawal_requests_select_admin
  on public.withdrawal_requests for select to authenticated
  using (public.is_admin());

-- ------------------------------------------------------------
-- 6. Defensa en profundidad: sin escritura directa para anon
-- ------------------------------------------------------------
revoke insert, update, delete on public.withdrawal_requests from anon;
