-- ============================================================
-- StockMario · Migración 0006: Hotfix
-- 1) create_withdrawal: la validación de la foto consultaba la
--    columna storage.objects.content_type, que dejó de existir en
--    el esquema storage actual de Supabase. El mimetype se lee de
--    metadata->>'mimetype' (siempre presente en uploads).
-- 2) approve_return_request: tenía un SELECT sin INTO sobre
--    technicians (error plpgsql "query has no destination for
--    result data"), lo que abortaba TODA aprobación de devolución.
-- Idempotente: puede re-ejecutarse.
-- ============================================================

-- ------------------------------------------------------------
-- 1. create_withdrawal: validación de foto vía metadata->>'mimetype'
-- ------------------------------------------------------------
drop function if exists public.create_withdrawal(uuid, uuid, numeric, text, text, text);

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

  -- La foto es obligatoria: debe existir en el bucket con la estructura
  -- YYYY/MM/UUID.<ext> y su contenido debe ser imagen (mimetype en metadata).
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

revoke all on function public.create_withdrawal(uuid, uuid, numeric, text, text, text) from anon, authenticated;
grant execute on function public.create_withdrawal(uuid, uuid, numeric, text, text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 2. approve_return_request: SELECT de técnico con INTO
-- ------------------------------------------------------------
drop function if exists public.approve_return_request(uuid);

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
  update public.return_requests
    set status      = 'approved',
        resolved_by = auth.uid(),
        resolved_at = now(),
        movement_id = v_movement_id
    where id = v_req.id;

  return v_movement_id;
end;
$$;

revoke all on function public.approve_return_request(uuid) from anon, authenticated;
grant execute on function public.approve_return_request(uuid) to authenticated;
