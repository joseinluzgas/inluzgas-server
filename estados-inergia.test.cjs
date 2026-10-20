const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const policy = require('./estados-inergia.cjs');
const { normalizarEstadoCRM, coincidirContratoAPI, camposEstadoAPI, parseEstadoCtr } = policy;
const cliente = { nif: '12345678Z', cif: '' };
const ct = { id: 'crm', cliente_id: 'cliente', comercializadora_id: 'cm', cups: 'ES0021000000000001AA', fecha_registro: '2026-09-30', estado: 'en_tramite', situacion: 'PDT FIRMA' };
const row = { id: '91', cups: ct.cups, cif: cliente.nif, fecha_reg: '2026-09-30 10:49:24', estado: 'Activo', situacion: '', fecha_alta: '2026-10-06', fecha_vto: '2027-10-06', fecha_baja: null };
test('maps actual API states and preserves every canonical state', () => {
  for (const state of policy.CANONICOS) assert.equal(normalizarEstadoCRM(state), state);
  for (const [raw, expected] of Object.entries({
    'Activo':'activado','Activo FTR':'activado','Baja CC':'baja','Pendiente CC':'en_tramite',
    'En Trámite':'en_tramite','Pendiente de Firma':'en_tramite','Incidencia Resuelta':'en_tramite',
    'Sin Firmar - Anulado':'cancelado','Firmado - Tramitado - Incidencia':'incidencia'
  })) assert.equal(normalizarEstadoCRM(raw), expected);
  for (const raw of ['',null,'Suspendido','Ojo se va','Activación pendiente desconocida']) {
    if (raw === 'Activación pendiente desconocida') assert.notEqual(normalizarEstadoCRM(raw),'activado');
    else assert.equal(normalizarEstadoCRM(raw),null);
  }
});
test('recovers missing identifier only with matching supply, customer and registration', () => {
  assert.equal(coincidirContratoAPI(ct,cliente,[row]),row);
  assert.equal(coincidirContratoAPI({...ct, cups:ct.cups+'0F'},cliente,[row]),row);
  assert.equal(coincidirContratoAPI(ct,{nif:'other'},[row]),null);
  assert.equal(coincidirContratoAPI({...ct,fecha_registro:'2025-09-30'},cliente,[row]),null);
  assert.equal(coincidirContratoAPI(ct,cliente,[row,{...row,id:'92'}]),null);
  assert.equal(coincidirContratoAPI({...ct,id_inergia:91},cliente,[{...row,cups:'ES0021000000000002BB'}]),null);
});
test('retains history when the same CUPS has a renewal', () => {
  const old = {...row,id:'80',fecha_reg:'2025-09-30',estado:'Baja',fecha_baja:'2026-10-05'};
  assert.equal(coincidirContratoAPI({...ct,fecha_registro:'2025-09-30'},cliente,[row,old]),old);
  assert.equal(coincidirContratoAPI(ct,cliente,[row,old]),row);
});
test('clears obsolete pending detail and uses actual activation dates', () => {
  const patch=camposEstadoAPI({...ct,fecha_baja:'2024-01-01'},row,'2026-10-20T12:00:00Z');
  assert.equal(patch.estado,'activado');
  assert.equal(patch.situacion,'');
  assert.equal(patch.fecha_activacion,'2026-10-06');
  assert.equal(patch.fecha_renovacion,'2027-10-06');
  assert.equal(patch.fecha_baja,null);
  assert.equal(patch.comercial_cartera_id,undefined);
  assert.equal(patch.estado_original,undefined);
  assert.equal(camposEstadoAPI(ct,{estado:'Suspendido'}),null);
});
test('never invents today as activation, renewal or termination date', () => {
  const p=camposEstadoAPI(ct,{estado:'Activo'});
  assert.equal(p.fecha_activacion,undefined);
  assert.equal(p.fecha_renovacion,undefined);
  assert.equal(camposEstadoAPI(ct,{estado:'Baja'}).fecha_baja,undefined);
  assert.equal(policy.fechaAPI('0000-00-00'),null);
  assert.equal(policy.fechaAPI('2026-02-30'),null);
});
test('parses supported provider envelopes', () => {
  for (const d of [row,[row],{data:row},{data:[row]}]) assert.equal(parseEstadoCtr(d).estadoTxt,'Activo');
});
function server() {
  const routes = new Map();
  const app = { use(){}, listen(){}, get(p,h){routes.set('GET '+p,h);}, post(p,h){routes.set('POST '+p,h);}, patch(){}, delete(){} };
  const express=()=>app; express.json=()=>()=>{};
  const context={require:n=>n==='dotenv'?{config(){}}:n==='express'?express:n==='./estados-inergia.cjs'?policy:require(n),
    console:{log(){},warn(){}},process:{env:{}},URLSearchParams,fetch:()=>{throw new Error('Unexpected network');}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(__dirname+'/server-inluzgas.js','utf8')+
    '\nglobalThis.harness={db,setQuery:fn=>{getquery=fn;},sincronizarEstadoContrato};',context);
  return {routes,...context.harness};
}
test('bulk checks pending and active records, terminal transitions and no_sync', async () => {
  const h=server(), writes=[], filters=[];
  const records=[
    {...ct,comercializadora_id:'cm'},
    {...ct,id:'active',id_inergia:92,cups:'ES0021000000000002BB',estado:'activado'},
    {...ct,id:'manual',no_sync:true},
    {...ct,id:'history',fecha_registro:'2024-01-01'}
  ];
  const apiRows=[row,{...row,id:92,cups:'ES0021000000000002BB',estado:'Baja',fecha_baja:'2026-10-19'}];
  h.db.sel=async(t,f)=>{filters.push([t,f]);return t==='proveedores'?[{id:'pv',token:'test',nombre:'SALUTARIS'}]:
    t==='comercializadoras'?[{id:'cm',id_inergia_int:1,proveedor_id:'pv',nombre:'ENDESA'}]:
    t==='contratos'?records:t==='clientes'?[{...cliente,id:'cliente'}]:[];};
  h.db.upd=async(t,f,p)=>{writes.push({t,f,p});return [{id:f.split('=eq.')[1]?.split('&')[0],...p}];};
  h.db.ins=async()=>[];
  h.setQuery(async(_token,q)=>({status:200,data:{data:q.query==='comercializadoras'?[{idcomercializadora:1,nombre:'ENDESA'}]:apiRows}}));
  let result;
  const res={json(d){result=d;},status(){return this;}};
  await h.routes.get('POST /api/inergia/:proveedor/sync-estados')({params:{proveedor:'SALUTARIS'}},res);
  assert.equal(result.ok,true);
  assert.equal(result.cambios,2);
  assert.equal(result.protegidos,1);
  assert.equal(result.sin_coincidencia,1);
  assert.equal(writes.length,2);
  assert.ok(writes.every(w=>w.f.includes('no_sync=not.is.true')));
  assert.equal(writes[0].p.fecha_activacion,'2026-10-06');
  assert.equal(writes[1].p.fecha_baja,'2026-10-19');
  assert.ok(filters.filter(([t])=>t==='contratos').every(([,f])=>!f.includes('estado=eq.enviado')));
});
test('individual sync never reads or writes a manually protected contract', async () => {
  const h=server();
  h.setQuery(async()=>{throw new Error('Must not read provider');});
  h.db.upd=async()=>{throw new Error('Must not write');};
  const result=await h.sincronizarEstadoContrato({...ct,no_sync:true},{});
  assert.equal(result.protegido,true);
  assert.equal(result.cambio,false);
});
test('cartera updates an existing termination and never repurposes history or protected rows', async () => {
  const h=server(), writes=[], inserts=[];
  const old={...ct,id:'old',fecha_registro:'2025-09-30',estado:'activado',comercial_cartera_id:'owner'};
  const manual={...ct,id:'manual',no_sync:true};
  const incoming=[{...row,id:80,fecha_reg:'2025-09-30',estado:'Baja',fecha_baja:'2026-10-05'},row];
  h.db.sel=async(t)=>t==='proveedores'?[{id:'pv',token:'test',nombre:'SALUTARIS'}]:
    t==='comercializadoras'?[{id:'cm',id_inergia_int:1,proveedor_id:'pv',nombre:'ENDESA'}]:
    t==='contratos'?[old,manual]:t==='clientes'?[{...cliente,id:'cliente'}]:
    t==='productos'?[{id:'product',nombre:'SIN ESPECIFICAR',comercializadora_id:'cm'}]:[];
  h.db.upd=async(t,f,p)=>{writes.push({t,f,p});return [{...old,...p}];};
  h.db.ins=async(t,p)=>{inserts.push({t,p});return [];};
  h.setQuery(async()=>({status:200,data:{data:incoming}}));
  let result;
  await h.routes.get('POST /api/inergia/:proveedor/sincronizar-contratos')(
    {params:{proveedor:'SALUTARIS'}},{json(d){result=d;},status(){return this;}});
  assert.equal(result.ok,true);
  assert.equal(result.actualizados,1);
  assert.equal(result.creados,0);
  assert.equal(writes.length,1);
  assert.equal(writes[0].p.estado,'baja');
  assert.equal(writes[0].p.fecha_registro,old.fecha_registro);
  assert.equal(writes[0].p.cliente_id,old.cliente_id);
  assert.equal(writes[0].p.comercial_cartera_id,undefined);
  assert.ok(inserts.every(i=>i.t==='eventos'));
});
