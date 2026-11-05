-- ============================================================
-- StockMario · Migración 0008: Categorías + Subida a ICLASS
-- 1) Tabla categories (GESTIÓN DE CATEGORÍAS) sembrada con las
--    categorías ya existentes en materials (no se pierde nada;
--    materials.category sigue siendo texto libre → compatible con
--    todo lo anterior incl. historial, vistas y CSVs).
-- 2) RPCs admin: rename_category (propaga el nuevo nombre a los
--    materiales) y delete_category (bloqueada si hay materiales
--    asociados), alto/baja/edición también vía tabla + RLS admin.
-- 3) Tabla iclass_confirmations: registro interno de movimientos
--    confirmados como "subidos a ICLASS" (fecha + usuario).
--    Los movimientos NUNCA se borran ni modifican: la eliminación
--    del listado pendiente es solo de vista (filtro).
-- 4) RPC confirm_iclass_upload(p_movement_ids uuid[]): idempotente
--    (los ya confirmados se saltan), solo admin, en una transacción.
-- Idempotente: puede re-ejecutarse.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Categorías
-- ------------------------------------------------------------
create table if not exists public.categories (
  id         uuid primary key default extensions.gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now(),
  constraint categories_name_key unique (name),
  constraint categories_name_check check (char_length(btrim(name)) between 1 and 100)
);

comment on table public.categories is
  'Categorías del catálogo de materiales. materials.category sigue siendo texto libre (la lista se administra desde esta tabla).';

-- Siembra: se conservan las categorías ya usadas en materials
insert into public.categories (name)
select distinct btrim(m.category)
from public.materials m
where m.category is not null and btrim(m.category) <> ''
on conflict (name) do nothing;

alter table public.categories enable row level security;

drop policy if exists categories_select_admin on public.categories;
create policy categories_select_admin
  on public.categories for select to authenticated
  using (public.is_admin());

drop policy if exists categories_admin_all on public.categories;
create policy categories_admin_all
  on public.categories for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create index if not exists idx_categories_name on public.categories (name);

-- ------------------------------------------------------------
-- 1.a) RPC rename_category: renombra la categoría y propaga el
--      nombre a los materiales que la usan (consistencia total).
-- ------------------------------------------------------------
create or replace function public.rename_category(
  p_category_id uuid,
  p_new_name    text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_name text;
  v_new      text;
begin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden gestionar categorías'
      using errcode = 'INSUFFICIENT_PRIVILEGE';
  end if;

  v_new := btrim(coalesce(p_new_name, ''));
  if v_new = '' or char_length(v_new) > 100 then
    raise exception 'El nombre de la categoría es inválido (1 a 100 caracteres)';
  end if;

  select name into v_old_name from public.categories
    where id = p_category_id
    for update;
  if not found then
    raise exception 'Categoría inexistente';
  end if;
  if v_new = v_old_name then
    return;
  end if;
  if exists (select 1 from public.categories where name = v_new and id <> p_category_id) then
    raise exception 'Ya existe una categoría con el nombre "%"', v_new
      using errcode = 'CATEGORY_DUPLICATE';
  end if;

  update public.categories set name = v_new where id = p_category_id;
  update public.materials set category = v_new where category = v_old_name;
end;
$$;

-- ------------------------------------------------------------
-- 1.b) RPC delete_category: solo si NO hay materiales que la usen.
--      El administrador debe reasignar esos materiales a otra
--      categoría antes de poder eliminarla (nada se borra solo).
-- ------------------------------------------------------------
create or replace function public.delete_category(p_category_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text;
  v_usage int;
begin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden gestionar categorías'
      using errcode = 'INSUFFICIENT_PRIVILEGE';
  end if;

  select name into v_name from public.categories where id = p_category_id for update;
  if not found then
    raise exception 'Categoría inexistente';
  end if;

  select count(*) into v_usage
    from public.materials where category = v_name;
  if v_usage > 0 then
    raise exception
      'La categoría "%" está asociada a % material(es). Reasignalos a otra categoría antes de eliminarla',
      v_name, v_usage
      using errcode = 'CATEGORY_IN_USE';
  end if;

  delete from public.categories where id = p_category_id;
end;
$$;

grant execute on function public.rename_category(uuid, text) to authenticated;
grant execute on function public.delete_category(uuid) to authenticated;
revoke all on function public.rename_category(uuid, text) from anon;
revoke all on function public.delete_category(uuid) from anon;

-- ------------------------------------------------------------
-- 2. Confirmaciones de subida a ICLASS
-- ------------------------------------------------------------
create table if not exists public.iclass_confirmations (
  id           uuid primary key default extensions.gen_random_uuid(),
  movement_id  uuid not null unique references public.movements (id),
  confirmed_by uuid references public.profiles (id) on delete set null,
  confirmed_at timestamptz not null default now()
);

comment on table public.iclass_confirmations is
  'Registro de trazabilidad: movimientos ya cargados en ICLASS (quién y cuándo confirmó). No altera movements; el historial únicamente filtra los pendientes.';

create index if not exists idx_iclass_confirmations_confirmed_at
  on public.iclass_confirmations (confirmed_at desc);

alter table public.iclass_confirmations enable row level security;

drop policy if exists iclass_confirmations_select_admin on public.iclass_confirmations;
create policy iclass_confirmations_select_admin
  on public.iclass_confirmations for select to authenticated
  using (public.is_admin());

-- Escritura solo vía RPC (defensa en profundidad)
revoke insert, update, delete on public.iclass_confirmations from anon, authenticated;
revoke insert, update, delete on public.categories from anon;

-- ------------------------------------------------------------
-- 2.a) RPC confirm_iclass_upload: confirma la subida a ICLASS de
--      los movimientos indicados. Idempotente: los ya confirmados
--      se saltan sin cambiar su registro original. Traza admin+fecha.
-- ------------------------------------------------------------
create or replace function public.confirm_iclass_upload(p_movement_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden confirmar la subida a ICLASS'
      using errcode = 'INSUFFICIENT_PRIVILEGE';
  end if;

  if p_movement_ids is null or cardinality(p_movement_ids) = 0 then
    raise exception 'Seleccioná al menos un movimiento para confirmar';
  end if;

  insert into public.iclass_confirmations (movement_id, confirmed_by)
  select t.id, auth.uid()
  from unnest(p_movement_ids) as t(id)
  on conflict (movement_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.confirm_iclass_upload(uuid[]) to authenticated;
revoke all on function public.confirm_iclass_upload(uuid[]) from anon;
