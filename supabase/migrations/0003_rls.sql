-- ============================================================
-- StockMario · Migración 0003: Row Level Security (RLS)
-- anon                 → formulario móvil (solo lo estrictamente necesario)
-- authenticated admin  → panel administrativo completo
-- Los movimientos nunca se actualizan ni eliminan (historial puro).
-- ============================================================

alter table public.profiles                  enable row level security;
alter table public.technicians               enable row level security;
alter table public.materials                 enable row level security;
alter table public.movements                 enable row level security;
alter table public.movement_return_allocations enable row level security;

-- ---------------- profiles ----------------
-- Un administrador solo ve su propio perfil (validación interna vía is_admin)
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select to authenticated
  using (id = auth.uid());

-- Los perfiles no se crean ni modifican desde el cliente: solo por trigger server-side

-- ---------------- technicians ----------------
-- anon: lista de técnicos activos (para el selector del formulario)
drop policy if exists technicians_select on public.technicians;
create policy technicians_select
  on public.technicians for select to anon, authenticated
  using (active = true or public.is_admin());

-- admin: gestión completa de técnicos
drop policy if exists technicians_admin_all on public.technicians;
create policy technicians_admin_all
  on public.technicians for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------- materials ----------------
-- anon: catálogo activo con stock (para el buscador)
drop policy if exists materials_select on public.materials;
create policy materials_select
  on public.materials for select to anon, authenticated
  using (active = true or public.is_admin());

-- admin: CRUD de materiales
drop policy if exists materials_admin_all on public.materials;
create policy materials_admin_all
  on public.materials for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------- movements ----------------
-- anon: sin acceso directo. Solo vía RPC (create_withdrawal / create_return).
-- admin: lectura completa e inserción; nunca actualizar ni eliminar.
drop policy if exists movements_select_admin on public.movements;
create policy movements_select_admin
  on public.movements for select to authenticated
  using (public.is_admin());

drop policy if exists movements_insert_admin on public.movements;
create policy movements_insert_admin
  on public.movements for insert to authenticated
  with check (public.is_admin());

-- ---------------- movement_return_allocations ----------------
drop policy if exists allocations_select_admin on public.movement_return_allocations;
create policy allocations_select_admin
  on public.movement_return_allocations for select to authenticated
  using (public.is_admin());

drop policy if exists allocations_insert_admin on public.movement_return_allocations;
create policy allocations_insert_admin
  on public.movement_return_allocations for insert to authenticated
  with check (public.is_admin());

-- ---------------- vistas ----------------
-- Las vistas usan security_invoker, heredan las políticas de las tablas base.
grant select on public.v_material_stock        to anon, authenticated;
grant select on public.v_pending_withdrawals   to authenticated;
grant select on public.v_allocation_detail     to authenticated;

-- Nota: v_pending_withdrawals expone movimientos; se restringe a admin.
-- El formulario técnico usa la RPC get_pending_withdrawals (por técnico+material).

-- ---------------- restricción de escritura directa anon ----------------
-- (defensa en profundidad: aunque RLS ya lo impide, se revocan privilegios)
revoke insert, update, delete on all tables in schema public from anon;
grant select on public.materials, public.technicians to anon;
grant select on public.v_material_stock to anon;
