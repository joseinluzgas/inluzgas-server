begin;

alter table public.contratos
  add column if not exists fecha_comisionado date null;

create index if not exists contratos_fecha_comisionado_idx
  on public.contratos(fecha_comisionado);

commit;
