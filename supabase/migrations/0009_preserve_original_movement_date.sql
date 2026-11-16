-- ============================================================
-- StockMario · Migración 0009: Conservar la fecha real del retiro
-- Problema: al aprobar/corregir una solicitud, el movimiento efectivo
-- en movements se creaba SIN created_at explícito y heredaba el
-- DEFAULT now() (fecha de la aprobación), no la fecha real en que el
-- técnico retiró el material.
-- Solución:
-- 1) approve_withdrawal_request: inserta el movimiento con
--    created_at = withdrawal_requests.requested_at (fecha del retiro).
-- 2) correct_withdrawal_request: ídem.
-- 3) approve_return_request: ídem (fecha real de la solicitud de
--    devolución, no la de la aprobación).
-- 4) Backfill idempotente: los movimientos ya vinculados a solicitudes
--    (movement_id) recuperan la fecha original de su solicitud.
--    La fecha de aprobación queda preservada en resolved_at (no se
--    pierde información; no hay triggers ni updates sobre movements
--    que la pisen).
-- Nota: el stock se deriva de sumas de cantidades (no de fechas), por
-- lo que retrodatar created_at no altera inventario; sí mejora el
-- ordenamiento FIFO de devoluciones y la antigüedad de pendientes.
-- Idempotente: puede re-ejecutarse.
-- ============================================================

-- ------------------------------------------------------------
-- 1. approve_withdrawal_request: created_at = requested_at
-- ------------------------------------------------------------
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
  -- de movimientos). Mantiene la fotografía original vinculada.
  -- created_at conserva la fecha y hora REAL del retiro (cuando el
  -- técnico registró la solicitud), no la de la aprobación.
  insert into public.movements
    (technician_id, material_id, movement_type, quantity, notes, photo_path,
     created_by, created_at)
  values
    (v_req.technician_id, v_req.material_id, 'withdrawal', v_req.quantity,
     v_req.notes, v_req.photo_path, auth.uid(), v_req.requested_at)
  returning id into v_movement_id;

  -- Registrar resolución administrativa en la misma transacción
  -- (resolved_at = fecha de aprobación, campo separado del created_at)
  update public.withdrawal_requests
    set status      = 'approved',
        resolved_by = auth.uid(),
        resolved_at = now(),
        movement_id = v_movement_id
    where id = v_req.id;

  return v_movement_id;
end;
$$;

-- ------------------------------------------------------------
-- 2. correct_withdrawal_request: created_at = requested_at
-- ------------------------------------------------------------
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
  -- vinculada y la fecha real del retiro (requested_at), no la de la
  -- corrección administrativa.
  insert into public.movements
    (technician_id, material_id, movement_type, quantity, notes, photo_path,
     created_by, created_at)
  values
    (v_req.technician_id, p_corrected_material_id, 'withdrawal', p_corrected_quantity,
     v_req.notes, v_req.photo_path, auth.uid(), v_req.requested_at)
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
-- 3. approve_return_request: created_at = requested_at
-- ------------------------------------------------------------
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

  -- Se bloquea la fila del material para serializar aprobaciones
  -- concurrentes sobre el mismo inventario
  select name into v_material_name
    from public.materials
    where id = v_req.material_id
    for update;

  -- Movimiento real de devolución con la fecha real de la solicitud
  -- (requested_at), no la de la aprobación.
  insert into public.movements
    (technician_id, material_id, movement_type, quantity, notes, created_by,
     created_at)
  values
    (v_req.technician_id, v_req.material_id, 'return', v_req.quantity, v_req.notes,
     auth.uid(), v_req.requested_at)
  returning id into v_movement_id;

  -- Asociaciones devolución → retiros originales (solo reutilizables)
  if v_material_type = 'reusable' then
    v_remaining := v_req.quantity;

    if v_req.allocations is not null then
      for v_alloc_row in select * from jsonb_array_elements(v_req.allocations)
      loop
        v_alloc_qty := (v_alloc_row->>'quantity')::numeric;

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
  -- (resolved_at = fecha de aprobación, separada de created_at)
  update public.return_requests
    set status      = 'approved',
        resolved_by = auth.uid(),
        resolved_at = now(),
        movement_id = v_movement_id
    where id = v_req.id;

  return v_movement_id;
end;
$$;

-- ------------------------------------------------------------
-- 4. Backfill: los movimientos ya creados por aprobaciones previas
--    recuperan la fecha real de su solicitud. Idempotente: solo
--    actualiza filas donde difiere. resolved_at conserva la fecha
--    de aprobación, no se pierde trazabilidad.
-- ------------------------------------------------------------
update public.movements mv
set created_at = wr.requested_at
from public.withdrawal_requests wr
where wr.movement_id = mv.id
  and mv.created_at is distinct from wr.requested_at;

update public.movements mv
set created_at = rr.requested_at
from public.return_requests rr
where rr.movement_id = mv.id
  and mv.created_at is distinct from rr.requested_at;

-- ------------------------------------------------------------
-- 5. Concesiones (idénticas a las vigentes; las funciones se
--    reemplazan con la misma firma, no pierden permisos, pero se
--    dejan explícitas por consistencia con las demás migraciones).
-- ------------------------------------------------------------
revoke all on function public.approve_withdrawal_request(uuid) from anon;
grant execute on function public.approve_withdrawal_request(uuid) to authenticated;

revoke all on function public.correct_withdrawal_request(uuid, uuid, numeric, text) from anon;
grant execute on function public.correct_withdrawal_request(uuid, uuid, numeric, text) to authenticated;

revoke all on function public.approve_return_request(uuid) from anon;
grant execute on function public.approve_return_request(uuid) to authenticated;
