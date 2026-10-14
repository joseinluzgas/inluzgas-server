begin;

alter table public.contratos
  add column if not exists comercial_cartera_id uuid null,
  add column if not exists comercial_import text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'contratos_comercial_cartera_id_fkey'
  ) then
    alter table public.contratos
      add constraint contratos_comercial_cartera_id_fkey
      foreign key (comercial_cartera_id)
      references public.usuarios(id)
      on delete set null;
  end if;
end $$;

-- La cartera ya importada desde Excel hereda el responsable actual del cliente.
-- Los futuros contratos creados solo por API nacen con este campo a null.
update public.contratos ct
set comercial_cartera_id = cl.comercial_id
from public.clientes cl
where ct.cliente_id = cl.id
  and ct.comercial_cartera_id is null;

create index if not exists contratos_comercial_cartera_id_idx
  on public.contratos(comercial_cartera_id);

commit;
