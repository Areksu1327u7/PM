-- Schema for products, movements, roles_matrix
-- Run in Supabase SQL editor on your project

-- PRODUCTS
create table if not exists public.products (
  id bigint generated always as identity primary key,
  item text not null unique,
  nombre text not null,
  categoria text,
  ceja integer not null default 0,
  senkata integer not null default 0,
  unidad text not null default 'PCS',
  precio numeric(12,2) not null default 0
);

create index if not exists products_nombre_idx on public.products (nombre);
create index if not exists products_categoria_idx on public.products (categoria);

-- MOVEMENTS
create table if not exists public.movements (
  id bigint generated always as identity primary key,
  tipo text not null check (tipo in ('ingreso','venta','transfer')),
  fecha date not null,
  item text,
  nombre text,
  cantidad integer not null default 0,
  detalle text,
  total numeric(14,2) not null default 0,
  descuento numeric(12,2) not null default 0
);

create index if not exists movements_fecha_idx on public.movements (fecha);
create index if not exists movements_tipo_idx on public.movements (tipo);

-- ROLES MATRIX
create table if not exists public.roles_matrix (
  id bigint generated always as identity primary key,
  data_json jsonb not null
);

-- Enable Row Level Security and add permissive policies for anon key usage
alter table public.products enable row level security;
alter table public.movements enable row level security;
alter table public.roles_matrix enable row level security;

-- READ policies
create policy if not exists products_read_all on public.products for select using (true);
create policy if not exists movements_read_all on public.movements for select using (true);
create policy if not exists roles_matrix_read_all on public.roles_matrix for select using (true);

-- WRITE policies (insert/update/delete)
create policy if not exists products_write_all on public.products for insert with check (true);
create policy if not exists products_update_all on public.products for update using (true) with check (true);
create policy if not exists products_delete_all on public.products for delete using (true);

create policy if not exists movements_write_all on public.movements for insert with check (true);
create policy if not exists movements_update_all on public.movements for update using (true) with check (true);
create policy if not exists movements_delete_all on public.movements for delete using (true);

create policy if not exists roles_matrix_write_all on public.roles_matrix for insert with check (true);
create policy if not exists roles_matrix_update_all on public.roles_matrix for update using (true) with check (true);
create policy if not exists roles_matrix_delete_all on public.roles_matrix for delete using (true);

-- Optional: seed minimal roles_matrix row if empty
insert into public.roles_matrix (data_json)
select '{"roles":["Admin","Vendedor","Almacenero"],"modules":["Ingreso","Movimientos","Ventas","Inventario","Dashboard","Administrador"],"matrix":{"Admin":{"Ingreso":true,"Movimientos":true,"Ventas":true,"Inventario":true,"Dashboard":true,"Administrador":true},"Vendedor":{"Ingreso":true,"Movimientos":true,"Ventas":true,"Inventario":true,"Dashboard":true,"Administrador":true},"Almacenero":{"Ingreso":true,"Movimientos":true,"Ventas":true,"Inventario":true,"Dashboard":true,"Administrador":true}}}'::jsonb
where not exists (select 1 from public.roles_matrix);
