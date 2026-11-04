-- ============================================================
-- StockMario · Migración 0002: Funciones RPC transaccionales
-- Las operaciones críticas se validan y ejecutan en PostgreSQL
-- dentro de una única transacción (todo o nada).
-- ============================================================

-- ------------------------------------------------------------
-- Función auxiliar: ¿el usuario autenticado es administrador?
-- ------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated, anon;

-- ------------------------------------------------------------
-- RPC: create_withdrawal
-- Registra un retiro validando stock en la misma transacción.
-- ------------------------------------------------------------
create or replace function public.create_withdrawal(
  p_technician_id    uuid,
  p_material_id      uuid,
  p_quantity         numeric,
  p_notes            text default null,
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
  -- sobre el mismo material y calcular el stock dentro del lock
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

  insert into public.movements
    (technician_id, material_id, movement_type, quantity, notes,
     created_by, idempotency_key)
  values
    (p_technician_id, p_material_id, 'withdrawal', p_quantity, p_notes,
     auth.uid(), p_idempotency_key)
  returning id into v_movement_id;

  return v_movement_id;
end;
$$;

-- ------------------------------------------------------------
-- RPC: create_return
-- Registra una devolución. Para materiales reutilizables asocia
-- la devolución a retiros pendientes (asignación manual o FIFO).
-- ------------------------------------------------------------
create or replace function public.create_return(
  p_technician_id    uuid,
  p_material_id      uuid,
  p_quantity         numeric,
  p_notes            text default null,
  p_allocations      jsonb default null,  -- [{withdrawal_movement_id, quantity}]
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
  v_is_admin       boolean := public.is_admin();
begin
  -- Idempotencia
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
    raise exception 'Técnico inexistente o desactivado';
  end if;

  select material_type, name into v_material_type, v_material_name
    from public.materials
    where id = p_material_id and active = true;
  if v_material_name is null then
    raise exception 'Material inexistente o desactivado';
  end if;

  -- Registrar la devolución
  insert into public.movements
    (technician_id, material_id, movement_type, quantity, notes,
     created_by, idempotency_key)
  values
    (p_technician_id, p_material_id, 'return', p_quantity, p_notes,
     auth.uid(), p_idempotency_key)
  returning id into v_movement_id;

  -- ----------------------------------------------------------
  -- Reutilizables: generar asignaciones contra retiros pendientes
  -- ----------------------------------------------------------
  if v_material_type = 'reusable' then
    v_remaining := p_quantity;

    if p_allocations is not null then
      -- Asignación manual provista por el frontend
      for v_item in select * from jsonb_array_elements(p_allocations)
      loop
        v_withdrawal_id := (v_item->>'withdrawal_movement_id')::uuid;
        v_alloc_qty     := (v_item->>'quantity')::numeric;

        if v_withdrawal_id is null or coalesce(v_alloc_qty, 0) <= 0 then
          raise exception 'Asignación inválida';
        end if;

        -- Verificar que el retiro pertenezca a este técnico y material
        select pending_qty into v_pending
          from public.v_pending_withdrawals
          where id = v_withdrawal_id
            and technician_id = p_technician_id
            and material_id = p_material_id
          for update;
        if v_pending is null then
          raise exception 'El retiro % no es pendiente para este técnico y material',
            v_withdrawal_id;
        end if;
        if v_alloc_qty > v_pending then
          raise exception 'Asignación % supera el pendiente (pendiente: %)',
            v_withdrawal_id, v_pending;
        end if;

        insert into public.movement_return_allocations
          (return_movement_id, withdrawal_movement_id, quantity)
        values (v_movement_id, v_withdrawal_id, v_alloc_qty);

        v_remaining := v_remaining - v_alloc_qty;
      end loop;

    else
      -- Asignación automática FIFO: retiros más antiguos primero
      for v_alloc_row in
        select id, pending_qty
          from public.v_pending_withdrawals
          where technician_id = p_technician_id
            and material_id = p_material_id
          order by withdrawn_at asc
          for update
      loop
        exit when v_remaining <= 0;

        v_alloc_qty := least(v_remaining, v_alloc_row.pending_qty);

        insert into public.movement_return_allocations
          (return_movement_id, withdrawal_movement_id, quantity)
        values (v_movement_id, v_alloc_row.id, v_alloc_qty);

        v_remaining := v_remaining - v_alloc_qty;
      end loop;
    end if;

    -- Debe haber quedado todo asignado y sin excedentes
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

-- ------------------------------------------------------------
-- RPC: get_pending_withdrawals
-- Permite al formulario público consultar los retiros pendientes
-- de un técnico para un material reutilizable (devolución asociada).
-- ------------------------------------------------------------
create or replace function public.get_pending_withdrawals(
  p_technician_id uuid,
  p_material_id   uuid
)
returns table (
  id               uuid,
  withdrawn_qty    numeric,
  returned_qty     numeric,
  pending_qty      numeric,
  withdrawn_at     timestamptz,
  technician_name  text,
  material_name    text,
  material_code    text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id,
    v.withdrawn_qty,
    v.returned_qty,
    v.pending_qty,
    v.withdrawn_at,
    v.technician_name,
    v.material_name,
    v.material_code
  from public.v_pending_withdrawals v
  where v.technician_id = p_technician_id
    and v.material_id = p_material_id
  order by v.withdrawn_at asc;
$$;

-- ------------------------------------------------------------
-- RPC: import_materials
-- Importación masiva del inventario existente (solo administrador).
-- p_rows: [{code, name, category, material_type, unit,
--           initial_stock, minimum_stock}]
-- Upsert por código. Los materiales existentes no pierden movimientos.
-- ------------------------------------------------------------
create or replace function public.import_materials(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    jsonb;
  v_count  int := 0;
begin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden importar materiales'
      using errcode = 'INSUFFICIENT_PRIVILEGE';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Se esperaba un arreglo JSON de materiales';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    if v_row->>'code' is null or v_row->>'name' is null then
      raise exception 'Cada material requiere code y name';
    end if;
    if v_row->>'material_type' is null
       or v_row->>'material_type' not in ('consumable', 'reusable') then
      raise exception 'material_type debe ser consumable o reusable (code: %)',
        v_row->>'code';
    end if;

    insert into public.materials
      (code, name, category, material_type, unit,
       initial_stock, minimum_stock)
    values (
      btrim(v_row->>'code'),
      btrim(v_row->>'name'),
      v_row->>'category',
      v_row->>'material_type',
      coalesce(nullif(btrim(v_row->>'unit'), ''), 'un'),
      coalesce((v_row->>'initial_stock')::numeric, 0),
      coalesce((v_row->>'minimum_stock')::numeric, 0)
    )
    on conflict (code) do update
      set name          = excluded.name,
          category      = coalesce(excluded.category, public.materials.category),
          material_type = excluded.material_type,
          unit          = excluded.unit,
          minimum_stock = coalesce(excluded.minimum_stock, public.materials.minimum_stock),
          -- el stock inicial solo se actualiza si el material no registra movimientos
          initial_stock = case
            when not exists (
              select 1 from public.movements mv where mv.material_id = public.materials.id
            ) then coalesce(excluded.initial_stock, public.materials.initial_stock)
            else public.materials.initial_stock
          end;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ------------------------------------------------------------
-- Concesión de ejecución de RPCs al rol público (formulario móvil).
-- La validación ocurre dentro de las funciones.
-- ------------------------------------------------------------
grant execute on function public.create_withdrawal(uuid, uuid, numeric, text, text) to anon, authenticated;
grant execute on function public.create_return(uuid, uuid, numeric, text, jsonb, text) to anon, authenticated;
grant execute on function public.get_pending_withdrawals(uuid, uuid) to anon, authenticated;
