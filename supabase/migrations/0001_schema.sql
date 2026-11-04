-- ============================================================
-- StockMario · Migración 0001: Esquema de base de datos
-- Sistema de gestión de depósito mediante código QR · SwissNet
-- ============================================================

-- Extensión para UUIDs
create extension if not exists "pgcrypto" with schema "extensions";

-- ============================================================
-- Tabla: profiles
-- Relaciona usuarios de Supabase Auth con roles administrativos
-- ============================================================
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  role        text not null default 'admin' check (role in ('admin')),
  created_at  timestamptz not null default now()
);

comment on table public.profiles is
  'Perfiles administrativos. Un row por usuario de Supabase Auth con rol.';

-- Trigger: crear perfil automáticamente al crear un usuario de Auth.
-- IMPORTANTE: en Supabase hay que deshabilitar "Allow new users to sign up"
-- después de crear el primer administrador, para que solo se creen usuarios
-- desde el panel de Auth.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'admin')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- Tabla: technicians
-- Técnicos que retiran y devuelven materiales (sin cuenta propia)
-- ============================================================
create table if not exists public.technicians (
  id          uuid primary key default extensions.gen_random_uuid(),
  full_name   text not null check (length(btrim(full_name)) between 2 and 120),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists idx_technicians_active on public.technicians (active);

-- ============================================================
-- Tabla: materials
-- Catálogo de materiales, herramientas y equipos
-- ============================================================
create table if not exists public.materials (
  id             uuid primary key default extensions.gen_random_uuid(),
  code           text not null unique,
  name           text not null check (length(btrim(name)) between 1 and 200),
  category       text,
  material_type  text not null check (material_type in ('consumable', 'reusable')),
  unit           text not null default 'un',
  initial_stock  numeric(14,3) not null default 0 check (initial_stock >= 0),
  minimum_stock  numeric(14,3) not null default 0 check (minimum_stock >= 0),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_materials_active       on public.materials (active);
create index if not exists idx_materials_type         on public.materials (material_type);
create index if not exists idx_materials_category     on public.materials (category);
create index if not exists idx_materials_search       on public.materials using gin (to_tsvector('spanish', name));

-- updated_at automático
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_materials_updated_at on public.materials;
create trigger trg_materials_updated_at
  before update on public.materials
  for each row execute function public.set_updated_at();

-- ============================================================
-- Tabla: movements
-- Historial inmutable de retiros y devoluciones
-- ============================================================
create table if not exists public.movements (
  id                uuid primary key default extensions.gen_random_uuid(),
  technician_id     uuid not null references public.technicians (id),
  material_id       uuid not null references public.materials (id),
  movement_type     text not null check (movement_type in ('withdrawal', 'return')),
  quantity          numeric(14,3) not null check (quantity > 0),
  notes             text,
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  idempotency_key   text unique
);

create index if not exists idx_movements_created_at   on public.movements (created_at desc);
create index if not exists idx_movements_technician   on public.movements (technician_id);
create index if not exists idx_movements_material     on public.movements (material_id);
create index if not exists idx_movements_type         on public.movements (movement_type);
create index if not exists idx_movements_mat_created  on public.movements (material_id, created_at desc);
create index if not exists idx_movements_tech_created on public.movements (technician_id, created_at desc);

comment on table public.movements is
  'Historial inmutable: nunca se actualiza ni se elimina un movimiento.';

-- ============================================================
-- Tabla: movement_return_allocations
-- Asocia devoluciones con los retiros originales (reutilizables)
-- ============================================================
create table if not exists public.movement_return_allocations (
  id                       uuid primary key default extensions.gen_random_uuid(),
  return_movement_id       uuid not null references public.movements (id) on delete cascade,
  withdrawal_movement_id   uuid not null references public.movements (id),
  quantity                 numeric(14,3) not null check (quantity > 0),
  created_at               timestamptz not null default now(),
  unique (return_movement_id, withdrawal_movement_id)
);

create index if not exists idx_alloc_return_wm  on public.movement_return_allocations (withdrawal_movement_id);
create index if not exists idx_alloc_return_rid on public.movement_return_allocations (return_movement_id);

-- Coherencia: la asignación debe referir a movimientos compatibles
-- (un retiro y su devolución, mismo material, tipo return para el primero)
create or replace function public.validate_allocation()
returns trigger
language plpgsql
as $$
declare
  v_return_type     text;
  v_return_material uuid;
  v_withdrawal_type text;
  v_withdrawal_material uuid;
begin
  select movement_type, material_id into v_return_type, v_return_material
    from public.movements where id = new.return_movement_id;
  if not found then
    raise exception 'allocation: movimiento de devolución inexistente';
  end if;

  select movement_type, material_id into v_withdrawal_type, v_withdrawal_material
    from public.movements where id = new.withdrawal_movement_id;
  if not found then
    raise exception 'allocation: movimiento de retiro inexistente';
  end if;

  if v_return_type <> 'return' or v_withdrawal_type <> 'withdrawal' then
    raise exception 'allocation: debe asociar una devolución con un retiro';
  end if;

  if v_return_material <> v_withdrawal_material then
    raise exception 'allocation: el material de la devolución no coincide con el retiro';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_allocation on public.movement_return_allocations;
create trigger trg_validate_allocation
  before insert on public.movement_return_allocations
  for each row execute function public.validate_allocation();

-- ============================================================
-- Vistas de cálculo (stock y sumatorias, siempre desde movimientos)
-- ============================================================

-- Stock actual por material: stock inicial + devoluciones - retiros
create or replace view public.v_material_stock
with (security_invoker = true) as
select
  m.id,
  m.code,
  m.name,
  m.category,
  m.material_type,
  m.unit,
  m.minimum_stock,
  m.active,
  m.initial_stock,
  coalesce(ret.total, 0)  as total_withdrawn,
  coalesce(dev.total, 0)  as total_returned,
  m.initial_stock + coalesce(dev.total, 0) - coalesce(ret.total, 0) as current_stock,
  m.initial_stock + coalesce(dev.total, 0) - coalesce(ret.total, 0) <= m.minimum_stock
    and m.active as is_low_stock,
  m.initial_stock + coalesce(dev.total, 0) - coalesce(ret.total, 0) <= 0 as is_out_of_stock
from public.materials m
left join (
  select material_id, sum(quantity) as total
  from public.movements where movement_type = 'withdrawal' group by material_id
) ret on ret.material_id = m.id
left join (
  select material_id, sum(quantity) as total
  from public.movements where movement_type = 'return' group by material_id
) dev on dev.material_id = m.id;

-- Retiros pendientes de devolución (unidades fuera del depósito, por retiro)
create or replace view public.v_pending_withdrawals
with (security_invoker = true) as
select
  mv.id,
  mv.technician_id,
  t.full_name as technician_name,
  mv.material_id,
  mat.name as material_name,
  mat.code as material_code,
  mat.category as material_category,
  mv.quantity as withdrawn_qty,
  coalesce(a.returned, 0) as returned_qty,
  mv.quantity - coalesce(a.returned, 0) as pending_qty,
  mv.created_at as withdrawn_at
from public.movements mv
join public.technicians t on t.id = mv.technician_id
join public.materials mat on mat.id = mv.material_id
left join (
  select withdrawal_movement_id, sum(quantity) as returned
  from public.movement_return_allocations
  group by withdrawal_movement_id
) a on a.withdrawal_movement_id = mv.id
where mv.movement_type = 'withdrawal'
  and mv.quantity - coalesce(a.returned, 0) > 0;

-- Detalle: qué devoluciones cubren cada retiro (para historial individual)
create or replace view public.v_allocation_detail
with (security_invoker = true) as
select
  a.id,
  a.return_movement_id,
  a.withdrawal_movement_id,
  a.quantity,
  a.created_at,
  mvw.technician_id,
  mvw.material_id,
  mvw.created_at as withdrawn_at,
  mvr.created_at as returned_at
from public.movement_return_allocations a
join public.movements mvw on mvw.id = a.withdrawal_movement_id
join public.movements mvr on mvr.id = a.return_movement_id;
