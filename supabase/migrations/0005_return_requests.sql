-- ============================================================
-- StockMario · Migración 0005: Devoluciones con aprobación admin
-- 1) Tabla return_requests (solicitud del técnico → aprobación/rechazo)
-- 2) RPCs transaccionales: create_return_request / approve /
--    reject (bloqueadas contra procesamiento simultáneo)
-- 3) Vista v_return_flow para el historial administrativo
-- 4) Reglas compatibles con datos históricos:
--    - Los movimientos existentes NO se tocan.
--    - Las devoluciones ya confirmadas siguen en movements.
--    - Las solicitudes pendientes/rechazadas NO cuentan para stock
--      ni sumatorios (no existen en movements hasta aprobarse).
-- Idempotente: puede re-ejecutarse.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tabla return_requests
-- ------------------------------------------------------------
create table if not exists public.return_requests (
  id                 uuid primary key default extensions.gen_random_uuid(),
  technician_id      uuid not null references public.technicians (id),
  material_id        uuid not null references public.materials (id),
  quantity           numeric(14,3) not null check (quantity > 0),
  notes              text,
  status             text not null default 'pending'
                       check (status in ('pending', 'approved', 'rejected')),
  allocations        jsonb,               -- asignaciones solicitadas (reutilizables)
  requested_at       timestamptz not null default now(),
  resolved_by        uuid references public.profiles (id) on delete set null,
  resolved_at        timestamptz,
  admin_notes        text,                -- motivo de rechazo u observación del admin
  movement_id        uuid references public.movements (id),  -- creado al aprobar
  idempotency_key    text unique,
  created_at         timestamptz not null default now(),

  -- Invariantes de estado
  constraint return_requests_state_check check (
    (status = 'pending'
      and resolved_by is null and resolved_at is null and movement_id is null)
    or
    (status = 'approved'
      and resolved_by is not null and resolved_at is not null
      and movement_id is not null)
    or
    (status = 'rejected'
      and resolved_by is not null and resolved_at is not null
      and movement_id is null)
  )
);

comment on table public.return_requests is
  'Solicitudes de devolución del técnico. Quedan en pending sin afectar stock; el admin aprueba (crea el movimiento real) o rechaza.';

create index if not exists idx_return_requests_status       on public.return_requests (status, requested_at desc);
create index if not exists idx_return_requests_technician   on public.return_requests (technician_id);
create index if not exists idx_return_requests_material     on public.return_requests (material_id);
create index if not exists idx_return_requests_movement     on public.return_requests (movement_id);

-- ------------------------------------------------------------
-- 2. RPCs transaccionales
-- ------------------------------------------------------------

-- 2.a) create_return_request: alta de solicitud por el formulario público.
--      NO modifica stock ni crea movimiento.
create or replace function public.create_return_request(
  p_technician_id    uuid,
  p_material_id      uuid,
  p_quantity         numeric,
  p_notes            text default null,
  p_allocations      jsonb default null,   -- [{withdrawal_movement_id, quantity}]
  p_idempotency_key  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_id    uuid;
  v_material_type text;
  v_material_name text;
  v_tech_name     text;
  v_item          jsonb;
  v_alloc_qty     numeric;
  v_pending       numeric(14,3);
  v_total_pending numeric(14,3);
  v_alloc_sum     numeric(14,3) := 0;
begin
  -- Idempotencia
  if p_idempotency_key is not null then
    select id into v_request_id from public.return_requests
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

  select material_type, name into v_material_type, v_material_name
    from public.materials
    where id = p_material_id and active = true;
  if v_material_name is null then
    raise exception 'Material inexistente o desactivado';
  end if;

  -- Reutilizables: validar la asignación solicitada contra los retiros pendientes
  if v_material_type = 'reusable' and p_allocations is not null then
    select coalesce(sum(pending_qty), 0) into v_total_pending
      from public.v_pending_withdrawals
      where technician_id = p_technician_id and material_id = p_material_id;

    if p_quantity > v_total_pending then
      raise exception
        'No hay retiros pendientes suficientes de "%" para devolver % unidades (pendiente: %)',
        v_material_name, p_quantity, v_total_pending
        using errcode = 'RETURN_EXCEEDS_PENDING';
    end if;

    for v_item in select * from jsonb_array_elements(p_allocations)
    loop
      v_alloc_qty := (v_item->>'quantity')::numeric;
      select pending_qty into v_pending
        from public.v_pending_withdrawals
        where id = (v_item->>'withdrawal_movement_id')::uuid
          and technician_id = p_technician_id
          and material_id = p_material_id;
      if v_pending is null or v_alloc_qty is null or v_alloc_qty <= 0 then
        raise exception 'Asignación inválida para devolución';
      end if;
      if v_alloc_qty > v_pending then
        raise exception 'Una asignación supera el pendiente del retiro (pendiente: %)', v_pending;
      end if;
      v_alloc_sum := v_alloc_sum + v_alloc_qty;
    end loop;

    if v_alloc_sum <> p_quantity then
      raise exception 'Las asignaciones deben sumar exactamente la cantidad devuelta';
    end if;
  end if;

  insert into public.return_requests
    (technician_id, material_id, quantity, notes, allocations,
     requested_at, idempotency_key)
  values
    (p_technician_id, p_material_id, p_quantity, p_notes, p_allocations,
     now(), p_idempotency_key)
  returning id into v_request_id;

  return v_request_id;
end;
$$;

-- 2.b) approve_return_request: aprueba la solicitud y crea el movimiento real
--      dentro de la MISMA transacción. Protegida contra doble procesamiento
--      concurrente mediante SELECT ... FOR UPDATE.
create or replace function public.approve_return_request(p_request_id uuid)
returns uuid   -- id del movimiento de devolución creado
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req            public.return_requests%rowtype;
  v_material_type  text;
  v_material_name  text;
  v_tech_name      text;
  v_movement_id    uuid;
  v_alloc_row      record;
  v_alloc_qty      numeric;
  v_pending        numeric(14,3);
  v_remaining      numeric(14,3);
begin
  -- Solo administradores
  if not public.is_admin() then
    raise exception 'Solo administradores pueden aprobar devoluciones'
      using errcode = 'INSUFFICIENT_PRIVILEGE';
  end if;

  -- Bloquear la fila: dos aprobaciones simultáneas se serializan aquí
  select * into v_req from public.return_requests
    where id = p_request_id
    for update;
  if not found then
    raise exception 'Solicitud de devolución inexistente';
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

  select material_type, name into v_material_type, v_material_name
    from public.materials
    where id = v_req.material_id and active = true;
  if v_material_name is null then
    raise exception 'El material ya no está activo: no se puede aprobar';
  end if;

  -- Movimiento real de devolución (stock se actualiza por derivación de movements)
  -- Se bloquea la fila del material para serializar aprobaciones concurrentes
  -- sobre el mismo inventario (equivalente al retiro).
  select name into v_material_name
    from public.materials
    where id = v_req.material_id
    for update;

  insert into public.movements
    (technician_id, material_id, movement_type, quantity, notes, created_by)
  values
    (v_req.technician_id, v_req.material_id, 'return', v_req.quantity, v_req.notes,
     auth.uid())
  returning id into v_movement_id;

  -- Asociaciones devolución → retiros originales (solo reutilizables)
  if v_material_type = 'reusable' then
    v_remaining := v_req.quantity;

    if v_req.allocations is not null then
      -- Asignación solicitada por el técnico: revalidar contra pendientes actuales
      for v_alloc_row in select * from jsonb_array_elements(v_req.allocations)
      loop
        v_alloc_qty := (v_alloc_row->>'quantity')::numeric;

        -- Pendiente real del retiro (bloquea la fila del retiro origen)
        select wm.quantity - coalesce((
          select sum(a.quantity)
          from public.movement_return_allocations a
          where a.withdrawal_movement_id = wm.id
        ), 0) into v_pending
        from public.movements wm
        where wm.id = (v_alloc_row->>'withdrawal_movement_id')::uuid
          and wm.technician_id = v_req.technician_id
          and wm.material_id = v_req.material_id
          and wm.movement_type = 'withdrawal'
        for update;
        if v_pending is null or v_alloc_qty is null or v_alloc_qty <= 0 then
          raise exception
            'La devolución ya no puede aprobarse tal como se solicitó (retiro inexistente o ya devuelto). Verificá el inventario; el técnico debe reenviar la solicitud o rechazala'
            using errcode = 'ALLOCATION_CONFLICT';
        end if;
        if v_alloc_qty > v_pending then
          raise exception
            'La asignación supera el pendiente actual (% disponible en el retiro solicitado). El inventario cambió desde la solicitud; no se procesó ninguna parte: rechazá la solicitud o pedí al técnico que la reenvíe',
            v_pending
            using errcode = 'ALLOCATION_CONFLICT';
        end if;

        insert into public.movement_return_allocations
          (return_movement_id, withdrawal_movement_id, quantity)
        values (v_movement_id, (v_alloc_row->>'withdrawal_movement_id')::uuid, v_alloc_qty);

        v_remaining := v_remaining - v_alloc_qty;
      end loop;
    else
      -- Sin asignación manual: FIFO automático (retiros más antiguos primero)
      for v_alloc_row in
        select wm.id,
               wm.quantity - coalesce((
                 select sum(a.quantity)
                 from public.movement_return_allocations a
                 where a.withdrawal_movement_id = wm.id
               ), 0) as pending_qty
        from public.movements wm
        where wm.technician_id = v_req.technician_id
          and wm.material_id = v_req.material_id
          and wm.movement_type = 'withdrawal'
        order by wm.created_at asc
        for update
      loop
        exit when v_remaining <= 0;
        v_pending := v_alloc_row.pending_qty;
        if v_pending <= 0 then
          continue;
        end if;
        v_alloc_qty := least(v_remaining, v_pending);

        insert into public.movement_return_allocations
          (return_movement_id, withdrawal_movement_id, quantity)
        values (v_movement_id, v_alloc_row.id, v_alloc_qty);

        v_remaining := v_remaining - v_alloc_qty;
      end loop;
    end if;

    if v_remaining > 0 then
      raise exception
        'No hay retiros pendientes suficientes de "%" (% faltante): no se aprobó nada parcial. Rechazá la solicitud o pedí reenvío',
        v_material_name, v_remaining
        using errcode = 'RETURN_EXCEEDS_PENDING';
    end if;
  end if;


  -- Registrar resolución administrativa dentro de la misma transacción
  update public.return_requests
    set status      = 'approved',
        resolved_by = auth.uid(),
        resolved_at = now(),
        movement_id = v_movement_id
    where id = v_req.id;

  return v_movement_id;
end;
$$;

-- 2.c) reject_return_request: rechaza sin tocar stock ni historial
create or replace function public.reject_return_request(
  p_request_id  uuid,
  p_admin_notes text
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
    raise exception 'Solo administradores pueden rechazar devoluciones'
      using errcode = 'INSUFFICIENT_PRIVILEGE';
  end if;

  select status into v_status from public.return_requests
    where id = p_request_id
    for update;
  if not found then
    raise exception 'Solicitud de devolución inexistente';
  end if;
  if v_status <> 'pending' then
    raise exception 'La solicitud ya fue resuelta (estado: %)', v_status
      using errcode = 'REQUEST_ALREADY_RESOLVED';
  end if;

  update public.return_requests
    set status      = 'rejected',
        resolved_by = auth.uid(),
        resolved_at = now(),
        admin_notes = nullif(btrim(p_admin_notes), '')
    where id = p_request_id;
end;
$$;

-- ------------------------------------------------------------
-- 3. Volver segura la RPC antigua de devolución directa:
--    el técnico ya no debe poder registrar devoluciones por su cuenta
--    (toda devolución pasa por aprobación administrativa).
--    Los datos históricos no se modifican.
-- ------------------------------------------------------------
revoke execute on function public.create_return(uuid, uuid, numeric, text, jsonb, text) from anon;
grant execute on function public.create_return(uuid, uuid, numeric, text, jsonb, text) to authenticated;

grant execute on function public.create_return_request(uuid, uuid, numeric, text, jsonb, text) to anon, authenticated;
grant execute on function public.approve_return_request(uuid) to authenticated;
grant execute on function public.reject_return_request(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 4. Vista v_return_flow: historial de devoluciones para el panel
--    - Movimientos efectivos tipo return (aprobadas; históricas incluidas)
--    - Solicitudes pendientes y rechazadas (movement_id is null, evita duplicar aprobadas)
--    Security_invoker: hereda RLS (solo admins ven movements/solicitudes)
-- ------------------------------------------------------------
create or replace view public.v_return_flow
with (security_invoker = true) as
select
  mv.id,
  'movement'::text as source,
  mv.technician_id,
  t.full_name as technician_name,
  mv.material_id,
  mat.name as material_name,
  mat.code as material_code,
  mat.unit as unit,
  mv.quantity,
  mv.notes,
  mv.created_at as requested_at,
  'approved'::text as status,
  mv.created_by as resolved_by,
  prof.email as resolver_email,
  mv.created_at as resolved_at,
  rr.admin_notes,
  mv.photo_path
from public.movements mv
join public.technicians t   on t.id = mv.technician_id
join public.materials mat   on mat.id = mv.material_id
left join public.return_requests rr on rr.movement_id = mv.id
left join public.profiles prof      on prof.id = mv.created_by
where mv.movement_type = 'return'

union all

select
  rq.id,
  'request'::text as source,
  rq.technician_id,
  t.full_name as technician_name,
  rq.material_id,
  mat.name as material_name,
  mat.code as material_code,
  mat.unit as unit,
  rq.quantity,
  rq.notes,
  rq.requested_at as requested_at,
  rq.status,
  rq.resolved_by,
  prof.email as resolver_email,
  rq.resolved_at,
  rq.admin_notes,
  null::text as photo_path
from public.return_requests rq
join public.technicians t on t.id = rq.technician_id
join public.materials mat on mat.id = rq.material_id
left join public.profiles prof on prof.id = rq.resolved_by
where rq.movement_id is null;   -- aprobadas ya visible como movimiento

grant select on public.v_return_flow to authenticated;

-- ------------------------------------------------------------
-- 5. Row Level Security para return_requests
--    anon: sin acceso directo a la tabla (alta solo v�a RPC).
--    authenticated admin: lectura completa (aprobaciones v�a RPC).
-- ------------------------------------------------------------
alter table public.return_requests enable row level security;

drop policy if exists return_requests_select_admin on public.return_requests;
create policy return_requests_select_admin
  on public.return_requests for select to authenticated
  using (public.is_admin());

-- ------------------------------------------------------------
-- 6. Correcci�n de create_return (misma firma y comportamiento que 0002):
--    reemplaza el 'FOR UPDATE' sobre la vista v_pending_withdrawals
--    (no bloqueable) por bloqueos sobre las filas base de movements,
--    de forma que devoluciones concurrentes nunca duplicen asignaciones.
-- ------------------------------------------------------------
drop function if exists public.create_return(uuid, uuid, numeric, text, jsonb, text);

create or replace function public.create_return(
  p_technician_id    uuid,
  p_material_id      uuid,
  p_quantity         numeric,
  p_notes            text default null,
  p_allocations      jsonb default null,
  p_idempotency_key  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_movement_id    uuid;
  v_material_type  text;
  v_material_name  text;
  v_tech_name      text;
  v_item           jsonb;
  v_withdrawal_id  uuid;
  v_alloc_qty      numeric;
  v_pending        numeric(14,3);
  v_remaining      numeric(14,3);
  v_alloc_row      record;
begin
  if p_idempotency_key is not null then
    select id into v_movement_id from public.movements
      where idempotency_key = p_idempotency_key;
    if v_movement_id is not null then
      return v_movement_id;
    end if;
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'La cantidad debe ser mayor que cero';
  end if;

  select full_name into v_tech_name from public.technicians
    where id = p_technician_id and active = true;
  if v_tech_name is null then
    raise exception 'T�cnico inexistente o desactivado';
  end if;

  select material_type, name into v_material_type, v_material_name
    from public.materials
    where id = p_material_id and active = true
    for update;
  if v_material_name is null then
    raise exception 'Material inexistente o desactivado';
  end if;

  insert into public.movements
    (technician_id, material_id, movement_type, quantity, notes,
     created_by, idempotency_key)
  values
    (p_technician_id, p_material_id, 'return', p_quantity, p_notes,
     auth.uid(), p_idempotency_key)
  returning id into v_movement_id;

  if v_material_type = 'reusable' then
    v_remaining := p_quantity;

    if p_allocations is not null then
      for v_item in select * from jsonb_array_elements(p_allocations)
      loop
        v_withdrawal_id := (v_item->>'withdrawal_movement_id')::uuid;
        v_alloc_qty     := (v_item->>'quantity')::numeric;

        if v_withdrawal_id is null or coalesce(v_alloc_qty, 0) <= 0 then
          raise exception 'Asignaci�n inv�lida';
        end if;

        select wm.quantity - coalesce((
          select sum(a.quantity)
          from public.movement_return_allocations a
          where a.withdrawal_movement_id = wm.id
        ), 0) into v_pending
        from public.movements wm
        where wm.id = v_withdrawal_id
          and wm.technician_id = p_technician_id
          and wm.material_id = p_material_id
          and wm.movement_type = 'withdrawal'
        for update;
        if v_pending is null then
          raise exception 'El retiro % no es pendiente para este t�cnico y material',
            v_withdrawal_id;
        end if;
        if v_alloc_qty > v_pending then
          raise exception 'Asignaci�n % supera el pendiente (pendiente: %)',
            v_withdrawal_id, v_pending;
        end if;

        insert into public.movement_return_allocations
          (return_movement_id, withdrawal_movement_id, quantity)
        values (v_movement_id, v_withdrawal_id, v_alloc_qty);

        v_remaining := v_remaining - v_alloc_qty;
      end loop;
    else
      for v_alloc_row in
        select wm.id,
               wm.quantity - coalesce((
                 select sum(a.quantity)
                 from public.movement_return_allocations a
                 where a.withdrawal_movement_id = wm.id
               ), 0) as pending_qty
        from public.movements wm
        where wm.technician_id = p_technician_id
          and wm.material_id = p_material_id
          and wm.movement_type = 'withdrawal'
        order by wm.created_at asc
        for update
      loop
        exit when v_remaining <= 0;
        if v_alloc_row.pending_qty <= 0 then
          continue;
        end if;
        v_alloc_qty := least(v_remaining, v_alloc_row.pending_qty);

        insert into public.movement_return_allocations
          (return_movement_id, withdrawal_movement_id, quantity)
        values (v_movement_id, v_alloc_row.id, v_alloc_qty);

        v_remaining := v_remaining - v_alloc_qty;
      end loop;
    end if;

    if v_remaining > 0 then
      raise exception
        'No hay retiros pendientes suficientes de "%" para devolver % unidades: faltan asignar %',
        v_material_name, p_quantity, v_remaining
        using errcode = 'RETURN_EXCEEDS_PENDING';
    end if;
  end if;

  return v_movement_id;
end;
$$;

grant execute on function public.create_return(uuid, uuid, numeric, text, jsonb, text) to authenticated;

drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin
  on public.profiles for select to authenticated
  using (public.is_admin());
