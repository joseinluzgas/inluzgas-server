require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const { normalizarEstadoCRM, coincidirContratoAPI, camposEstadoAPI } = require('./estados-inergia.cjs');

const app = express();
app.use(express.json({ limit: '25mb' }));

// ── Configuración ─────────────────────────────────────────────────────────────
const SB_URL     = process.env.SUPABASE_URL;
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY; // service_role, nunca caduca
const INERGIA    = 'https://inergia.app/api';
const GANA_SEC   = process.env.GANA_WEBHOOK_SECRET || '';
const PORT       = process.env.PORT || 3001;

// CORS — en producción cambia * por la URL de tu frontend en Vercel
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin',  process.env.CRM_ORIGIN || '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Supabase REST helper (service_role, sin RLS) ──────────────────────────────
const sbH = (extra = {}) => ({
  'apikey':        SB_KEY,
  'Authorization': 'Bearer ' + SB_KEY,
  'Content-Type':  'application/json',
  ...extra,
});

const sbFetch = async (path, opts = {}) => {
  const url = SB_URL + '/rest/v1/' + path;
  const res  = await fetch(url, {
    ...opts,
    headers: { ...sbH(opts.prefer ? { Prefer: opts.prefer } : {}), ...(opts.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || res.statusText);
  return text ? JSON.parse(text) : null;
};

// PostgREST (Supabase) devuelve máx. 1000 filas por petición → paginamos con Range
const selPaginado = async (t, f = '') => {
  const PAG = 1000;
  // Orden estable necesario para paginar; si la consulta no trae order, usamos id
  const filtro = /(\?|&)order=/.test(f) ? f : f + '&order=id';
  let out = [], desde = 0;
  for (;;) {
    const pag = await sbFetch(t + '?select=*' + filtro, { headers: { Range: desde + '-' + (desde + PAG - 1) } });
    out = out.concat(pag || []);
    if (!pag || pag.length < PAG) return out;
    desde += PAG;
  }
};

const db = {
  sel:    selPaginado,
  ins:    (t, body)      => sbFetch(t, { method:'POST', prefer:'return=representation', body:JSON.stringify(body) }),
  upd:    (t, f, body)   => sbFetch(t + '?' + f, { method:'PATCH', prefer:'return=representation', body:JSON.stringify(body) }),
  del:    (t, f)         => sbFetch(t + '?' + f, { method:'DELETE' }),
  upsert: (t, body, on)  => sbFetch(t + '?on_conflict=' + on, { method:'POST', prefer:'resolution=merge-duplicates,return=representation', body:JSON.stringify(body) }),
};

const log = (msg) => { console.log(`[${new Date().toLocaleTimeString('es-ES')}] ${msg}`); };

// El CRM guarda un catálogo corto y estable. El texto literal del proveedor
// se conserva aparte en estado_proveedor y, cuando aporta detalle, en situacion.

// Cuando un CUPS tiene varias contrataciones, la más reciente es la actual y
// las anteriores se conservan como histórico. Nunca se actualiza en bloque el
// histórico completo por una notificación del suministro.
const fechaContrato = ct => {
  // La versión la determina la fecha de origen del contrato, no una baja o
  // sincronización posterior que podría hacer parecer nuevo a un histórico.
  const valor = [ct.fecha_registro, ct.fecha_activacion, ct.fecha_envio, ct.created_at, ct.estado_at, ct.fecha_baja].find(Boolean);
  if (!valor) return 0;
  const fecha = Date.parse(String(valor).length === 10 ? valor + 'T00:00:00' : valor);
  return Number.isFinite(fecha) ? fecha : 0;
};
const contratoActual = lista => [...(lista || [])].sort((a, b) => {
  const porFecha = fechaContrato(b) - fechaContrato(a);
  if (porFecha) return porFecha;
  const ca = Number(a.codigo || a.id_inergia || 0), cb = Number(b.codigo || b.id_inergia || 0);
  if (Number.isFinite(ca) && Number.isFinite(cb) && ca !== cb) return cb - ca;
  return String(b.id || '').localeCompare(String(a.id || ''));
})[0] || null;

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH — login / logout / sesión
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const r = await fetch(SB_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(401).json({ error: data.error_description || 'Credenciales incorrectas' });

    // Obtener usuario CRM por auth_id
    const authId = data.user?.id;
    const usuarios = await db.sel('usuarios', '&auth_id=eq.' + authId);
    const usuario  = usuarios?.[0] || null;

    log(`Login: ${email} → ${usuario?.nombre || 'sin usuario CRM'}`);
    res.json({ ok: true, usuario });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DATOS — carga inicial completa
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/datos', async (req, res) => {
  try {
    const [usuarios, proveedores, comercializadoras, productos, clientes,
           contratos, liquidaciones, lineas, eventos, comisiones, crm_ids, comision_tramos,
           tickets, ticket_notas, canales] = await Promise.all([
      db.sel('usuarios',           '&order=nombre'),
      db.sel('proveedores',        '&order=nombre'),
      db.sel('comercializadoras',  '&order=nombre'),
      db.sel('productos',          '&order=nombre'),
      db.sel('clientes',           '&order=razon_social'),
      db.sel('contratos',          '&order=created_at.desc'),
      db.sel('liquidaciones',      '&order=fecha.desc'),
      db.sel('lineas_liquidacion'),
      db.sel('eventos',            '&order=created_at.desc&limit=100'),
      db.sel('comisiones_usuario'),
      db.sel('crm_ids_proveedor'),
      db.sel('comision_tramos').catch(() => []),
      db.sel('tickets',            '&order=created_at.desc').catch(() => []),
      db.sel('ticket_notas',       '&order=created_at.asc').catch(() => []),
      db.sel('canales',            '&order=nombre').catch(() => []),
    ]);
    // Nunca exponer el token al frontend: enviar solo un indicador
    const proveedoresSafe = (proveedores || []).map(({ token, ...p }) => ({ ...p, tiene_token: !!token }));
    res.json({ ok: true, usuarios, proveedores: proveedoresSafe, comercializadoras, productos,
               clientes, contratos, liquidaciones, lineas, eventos, comisiones, crm_ids, comision_tramos,
               tickets, ticket_notas, canales });
  } catch (e) {
    log('ERROR /datos: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CRUD GENÉRICO — el CRM llama a estas rutas para leer/escribir
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/db/:tabla', async (req, res) => {
  try {
    const data = await db.sel(req.params.tabla, req.query.filter ? '&' + req.query.filter : '');
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/db/:tabla', async (req, res) => {
  try {
    const data = await db.ins(req.params.tabla, req.body);
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/db/:tabla', async (req, res) => {
  try {
    const data = await db.upd(req.params.tabla, req.query.filter, req.body);
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/db/:tabla', async (req, res) => {
  try {
    await db.del(req.params.tabla, req.query.filter);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/db/:tabla/upsert', async (req, res) => {
  try {
    const data = await db.upsert(req.params.tabla, req.body, req.query.on_conflict);
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// iNERGIA — ALFER y SALUTARIS
// ═══════════════════════════════════════════════════════════════════════════════
async function tokenProveedor(nombre) {
  const pvs = await db.sel('proveedores', '&nombre=eq.' + nombre);
  const pv  = pvs?.[0];
  if (!pv?.token) throw new Error('Token de ' + nombre + ' no configurado');
  return pv;
}

async function getquery(token, params) {
  const qs  = new URLSearchParams({ ...params, token }).toString();
  const r   = await fetch(INERGIA + '/getquery.php?' + qs);
  const txt = await r.text();
  try { return { status: r.status, data: JSON.parse(txt) }; }
  catch { return { status: r.status, data: { raw: txt } }; }
}

// Sincronizar catálogo completo de iNergia
app.post('/api/inergia/:proveedor/sincronizar-catalogo', async (req, res) => {
  const nombre = req.params.proveedor.toUpperCase();
  try {
    const pv = await tokenProveedor(nombre);
    const { data: cmData } = await getquery(pv.token, { query: 'comercializadoras' });
    const comercializadoras = cmData?.data || [];
    let cmImportadas = 0;
    for (const cm of comercializadoras) {
      if (cm.activo !== '1') continue;
      const existing = await db.sel('comercializadoras', '&id_inergia_int=eq.' + cm.idcomercializadora + '&proveedor_id=eq.' + pv.id);
      if (existing?.length) {
        await db.upd('comercializadoras', 'id=eq.' + existing[0].id, { nombre: cm.nombre, activo: true });
      } else {
        await db.ins('comercializadoras', { nombre: cm.nombre, proveedor_id: pv.id, id_inergia_int: parseInt(cm.idcomercializadora), activo: true });
      }
      cmImportadas++;
    }
    const cmSupabase = await db.sel('comercializadoras', '&proveedor_id=eq.' + pv.id);
    const cmMap = {};
    (cmSupabase || []).forEach(cm => { cmMap[cm.id_inergia_int] = cm.id; });

    const { data: prData } = await getquery(pv.token, { query: 'productos' });
    const productos = prData?.data || [];
    let prImportados = 0;
    for (const p of productos) {
      const cmId = cmMap[parseInt(p.idcomercializadora)];
      if (!cmId) continue;
      const pd = {
        nombre: p.producto, comercializadora_id: cmId,
        tipo: p.suministro === 'LUZ' ? 'luz' : 'gas',
        tarifa: p.tarifa || '', comision_bruta: 0,
        id_inergia: String(p.idproducto), id_inergia_int: parseInt(p.idproducto),
        sector: p.sector || '', indexado: p.indexado === '1',
        tipo_precio: p.tipo || '', tipo_potencia: p.tipo_potencia || '',
        p1:parseFloat(p.p1)||null, p2:parseFloat(p.p2)||null, p3:parseFloat(p.p3)||null,
        p4:parseFloat(p.p4)||null, p5:parseFloat(p.p5)||null, p6:parseFloat(p.p6)||null,
        e1:parseFloat(p.e1)||null, e2:parseFloat(p.e2)||null, e3:parseFloat(p.e3)||null,
        e4:parseFloat(p.e4)||null, e5:parseFloat(p.e5)||null, e6:parseFloat(p.e6)||null,
        ajuste_kwh: parseFloat(p.ajuste_kwh)||null, excedente: parseFloat(p.excedente)||null,
        fecha_act: p.fecha_act || null, activo: true,
      };
      const ex = await db.sel('productos', '&id_inergia_int=eq.' + pd.id_inergia_int + '&comercializadora_id=eq.' + cmId);
      if (ex?.length) { await db.upd('productos', 'id=eq.' + ex[0].id, pd); }
      else            { await db.ins('productos', pd); }
      prImportados++;
    }
    await db.ins('eventos', { origen: nombre + ' · iNergia', tipo: 'sync.catalogo', ref: '—', detalle: `Importadas ${cmImportadas} comercializadoras y ${prImportados} productos` });
    log(`Catálogo ${nombre}: ${cmImportadas} comer, ${prImportados} productos`);
    res.json({ ok: true, comercializadoras: cmImportadas, productos: prImportados });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Sincronizar CONTRATOS desde la cartera de iNergia ─────────────────────────
// Recorre las comercializadoras del proveedor, trae su cartera y crea/actualiza
// cada contrato VIGENTE (fuera Baja/Baja CC/Cancelado/Rechazado) cruzando cliente
// por CIF/NIF y producto por idproducto. El id del contrato en iNergia se guarda
// en id_inergia, dejando la sincronización de estados lista.
// Deduce tipo de titular por la primera letra del identificador
function tipoTitular(id) {
  const c = String(id || '').trim().charAt(0).toUpperCase();
  if (/[0-9XYZ]/.test(c)) return 'fisica';
  if ('PQS'.includes(c)) return 'organismo';
  return 'empresa';
}
// Limpia siglas societarias: S.L. -> SL, C.B. -> CB, etc.
function limpiaRazonSocial(rs) {
  if (!rs) return rs;
  return String(rs).replace(/\b((?:S\.?\s*L\.?\s*U|S\.?\s*L\.?\s*L|S\.?\s*A\.?\s*L|S\.?\s*A\.?\s*U|S\.?\s*L|S\.?\s*A|C\.?\s*B|S\.?\s*C|COOP)\.?)(?=\s|$)/gi,
    m => m.replace(/[.\s]/g, '').toUpperCase()).replace(/\s+/g, ' ').trim();
}
// Construye el objeto cliente a partir de una fila de la cartera de iNergia.
// Nombres de campo reales del JSON: nombre+ape1+ape2 (nombre partido), movil/movil_cli (tel),
// iban_cli/iban, y dirección del cliente (calle/ciudad...) con respaldo en la del CUPS (calle_cups...).
// Todos los campos de la tabla clientes son NOT NULL → nunca devolver null/undefined.
function clienteDesdeCartera(ct, comercialId) {
  const s = v => (v == null ? '' : String(v).trim());   // null/undefined -> ''
  const pick = (...vs) => { for (const v of vs) { const t = s(v); if (t) return t; } return ''; };
  const ident = s(ct.cif);
  const tt = tipoTitular(ident);
  const fisica = tt === 'fisica';
  // Nombre completo: nombre + apellidos (viene partido)
  const nombreCompleto = [s(ct.nombre), s(ct.ape1), s(ct.ape2)].filter(Boolean).join(' ');
  const rs = fisica ? nombreCompleto : limpiaRazonSocial(s(ct.nombre));
  return {
    tipo_titular: tt,
    razon_social: rs || nombreCompleto || ident || 'SIN NOMBRE',
    cif: fisica ? '' : ident,
    nif: fisica ? ident : '',
    contacto: nombreCompleto || rs || ident,
    ape1: s(ct.ape1), ape2: s(ct.ape2),
    representante: fisica ? '' : s(ct.representante),
    dni_representante: s(ct.cif_representante),
    telefono: pick(ct.movil, ct.movil_cli, ct.telefono, ct.telefono_cli),
    telefono2: pick(ct.telefono, ct.telefono_cli),
    email: s(ct.email),
    tipo_via: '',
    // Dirección del titular; si viene vacía, respaldo en la del punto de suministro (CUPS)
    direccion: pick(ct.calle, ct.calle_cups),
    numero: pick(ct.numero, ct.num_cups),
    planta: pick(ct.planta, ct.planta_cups),
    letra: pick(ct.puerta, ct.puerta_cups),
    aclarador: pick(ct.aclarador, ct.aclarador_cups),
    codpostal: pick(ct.codpostal, ct.codpostal_cups),
    localidad: pick(ct.ciudad, ct.ciudad_cups),
    provincia: pick(ct.provincia, ct.provincia_cups),
    observaciones: 'IMPORTADO DE CARTERA iNergia',
    iban: pick(ct.iban_cli, ct.iban),
    comercial_id: comercialId, creado_por: comercialId,
  };
}
app.post('/api/inergia/:proveedor/sincronizar-contratos', async (req, res) => {
  const nombre = req.params.proveedor.toUpperCase();
  try {
    const pv = await tokenProveedor(nombre);
    // Comercializadoras de este proveedor con su id_inergia_int
    const cms = await db.sel('comercializadoras', '&proveedor_id=eq.' + pv.id);
    if (!cms?.length) return res.status(400).json({ error: 'El proveedor no tiene comercializadoras sincronizadas. Sincroniza el catálogo primero.' });

    // Índices para cruce: clientes por CIF/NIF normalizado, productos por id_inergia_int
    const norm = s => String(s || '').toUpperCase().replace(/[\s.\-]/g, '');
    const clientes = await db.sel('clientes');
    const cliPorId = new Map();
    for (const c of clientes) {
      const k = norm(c.cif || c.nif);
      if (k && !cliPorId.has(k)) cliPorId.set(k, c.id);
    }
    const productos = await db.sel('productos');
    const prodPorInergia = new Map();      // id_inergia_int -> uuid
    const sinEspPorCm = new Map();         // comercializadora_id -> uuid del 'SIN ESPECIFICAR'
    for (const p of productos) {
      if (p.id_inergia_int != null) prodPorInergia.set(String(p.id_inergia_int), p.id);
      if (String(p.nombre).toUpperCase() === 'SIN ESPECIFICAR') sinEspPorCm.set(p.comercializadora_id, p.id);
    }
    // Comercial por defecto para clientes nuevos: Laura, o el primer usuario disponible
    const usuarios = await db.sel('usuarios');
    const comercialDefecto = (usuarios.find(u => /laura/i.test(u.nombre)) || usuarios[0])?.id;
    // Índice de comerciales por nombre normalizado
    const normNom = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
    const userPorNombre = new Map();
    for (const u of usuarios) { userPorNombre.set(normNom(u.nombre), u.id); }
    function resolverComercial(nombreComercial) {
      if (!nombreComercial) return comercialDefecto;
      const n = normNom(nombreComercial);
      if (userPorNombre.has(n)) return userPorNombre.get(n);
      // Match parcial: buscar si algún usuario contiene el nombre o viceversa
      for (const [key, uid] of userPorNombre) {
        if (key.includes(n) || n.includes(key)) return uid;
      }
      return comercialDefecto;
    }

    let creados = 0, actualizados = 0, saltados_novigente = 0, clientes_creados = 0, total = 0;
    const sinIdentificador = [];
    const erroresCli = [];

    for (const cm of cms) {
      if (cm.id_inergia_int == null) continue;
      // Endesa la gestiona SALUTARIS: al sincronizar ALFER, saltar Endesa para no duplicar
      if (nombre === 'ALFER' && /endesa/i.test(cm.nombre)) continue;
      const { data } = await getquery(pv.token, { query: 'cartera', idcomercializadora: cm.id_inergia_int });
      let cartera = data?.data || [];
      // Si devuelve exactamente 300, intentar pedir más con paginación
      if (cartera.length === 300) {
        try {
          // Intentar con parámetro 'pagina'
          const { data: p2 } = await getquery(pv.token, { query: 'cartera', idcomercializadora: cm.id_inergia_int, pagina: 2 });
          const next = p2?.data || [];
          if (next.length > 0 && next[0]?.cups !== cartera[0]?.cups) {
            cartera = cartera.concat(next);
            log('Paginación cartera ' + cm.nombre + ': página 2 → +' + next.length + ' contratos');
            // Página 3 si sigue dando 300
            if (next.length === 300) {
              const { data: p3 } = await getquery(pv.token, { query: 'cartera', idcomercializadora: cm.id_inergia_int, pagina: 3 });
              const n3 = p3?.data || [];
              if (n3.length > 0 && n3[0]?.cups !== next[0]?.cups) cartera = cartera.concat(n3);
            }
          }
        } catch (e) { log('Paginación no soportada para ' + cm.nombre + ': ' + e.message); }
      }
      const candidatos = await db.sel('contratos', '&comercializadora_id=eq.' + cm.id);
      for (const ct of cartera) {
        total++;
        const estadoAPI = normalizarEstadoCRM(ct.estado);
        if (!estadoAPI) {
          if (erroresCli.length < 50) erroresCli.push({ cups: ct.cups, motivo: 'Estado API desconocido; contrato conservado' });
          continue;
        }
        const claveCli = norm(ct.cif);
        if (!claveCli) { if (sinIdentificador.length < 100) sinIdentificador.push({ nombre: ct.nombre, cups: ct.cups }); continue; }
        let cliId = cliPorId.get(claveCli);
        if (!cliId) {
          // Cliente no existe: crearlo desde los datos de la cartera
          try {
            const comercialId = resolverComercial(ct.comercial);
            const nuevo = clienteDesdeCartera(ct, comercialId);
            const ins = await db.ins('clientes', nuevo);
            cliId = Array.isArray(ins) ? ins[0]?.id : ins?.id;
            if (cliId) { cliPorId.set(claveCli, cliId); clientes_creados++; }
            else { if (erroresCli.length < 50) erroresCli.push({ cif: ct.cif, motivo: 'insert sin id' }); continue; }
          } catch (e) {
            if (erroresCli.length < 50) erroresCli.push({ cif: ct.cif, nombre: ct.nombre, motivo: e.message });
            continue;
          }
        }
        // Producto: por idproducto si viene; si no, SIN ESPECIFICAR de la comercializadora
        let prodId = ct.idproducto ? prodPorInergia.get(String(ct.idproducto)) : null;
        if (!prodId) prodId = sinEspPorCm.get(cm.id);
        if (!prodId) continue; // no debería pasar si existe el SIN ESPECIFICAR

        // Resolver comercial por nombre de iNergia
        const comercialId = resolverComercial(ct.comercial);

        const fila = {
          cliente_id: cliId,
          cups: ct.cups,
          tipo: ct.suministro === 'GAS' ? 'gas' : 'luz',
          comercializadora_id: cm.id,
          producto_id: prodId,
          estado: estadoAPI,
          estado_proveedor: ct.estado || null,
          situacion: ct.situacion || ct.estado || '',
          codigo: ct.codigo || '',
          tarifa: ct.tarifa || '',
          potencia: String(ct.potencia1 || '0'),
          potencia_p1: parseFloat(ct.potencia1) || null,
          consumo_anual: parseFloat(ct.consumo) || null,
          permanencia: ct.permanencia === '1' ? 'SI' : 'NO',
          renovacion_auto: 'NO',
          tiposol: ct.tipo_solicitud || 'IMPORTADO API',
          // Dato informativo del proveedor. La cartera real se asigna desde Excel
          // o manualmente y nunca se sobrescribe durante una sincronizacion.
          comercial_import: ct.comercial ? String(ct.comercial).trim() : null,
          id_inergia: parseInt(ct.id) || null,
          iban: ct.iban || '',
          fecha_activacion: ct.fecha_alta || null,
          fecha_renovacion: ct.fecha_vto || null,
          fecha_registro: ct.fecha_reg ? String(ct.fecha_reg).slice(0, 10) : null,
          fecha_baja: ct.fecha_baja || null,
          // Dirección del punto de suministro
          calle_cups: ct.calle_cups || ct.calle || '',
          numero_cups: ct.numero_cups || ct.numero || '',
          planta_cups: ct.planta_cups || ct.planta || '',
          puerta_cups: ct.puerta_cups || ct.puerta || '',
          codpostal_cups: ct.codpostal_cups || ct.codpostal || '',
          localidad_cups: ct.localidad_cups || ct.localidad || '',
          provincia_cups: ct.provincia_cups || ct.provincia || '',
          aclarador_cups: ct.aclarador_cups || ct.aclarador || '',
        };
        const coincidencias = candidatos.filter(c => coincidirContratoAPI(c, clientes.find(cl => cl.id === c.cliente_id), [ct]));
        if (coincidencias.length === 1) {
          const existente = coincidencias[0];
          if (!existente.no_sync) {
            // Preserve cartera enrichment only after identifying the exact
            // contracting instance; never repurpose history for a renewal.
            const estadoData = { ...fila, ...camposEstadoAPI(existente, ct), id_inergia: Number(ct.id) };
            await db.upd('contratos', 'id=eq.' + existente.id + '&no_sync=not.is.true', estadoData);
            actualizados++;
          }
        } else if (coincidencias.length > 1) {
          if (erroresCli.length < 50) erroresCli.push({ cups: ct.cups, motivo: 'Varias contrataciones coincidentes; revisar duplicados' });
        } else if (candidatos.some(c => c.id_inergia && String(c.id_inergia) === String(ct.id))) {
          if (erroresCli.length < 50) erroresCli.push({ cups: ct.cups, motivo: 'ID API con identidad o fecha incompatible; contrato conservado' });
        } else if (['baja','cancelado','rechazado'].includes(estadoAPI)) {
          saltados_novigente++;
        } else {
          const nuevos = await db.ins('contratos', fila);
          candidatos.push(...(Array.isArray(nuevos) ? nuevos : [nuevos]));
          creados++;
        }
      }
    }
    await db.ins('eventos', { origen: nombre + ' · iNergia', tipo: 'sync.contratos', ref: '—',
      detalle: `Cartera: ${total} · contratos creados ${creados} · actualizados ${actualizados} · clientes creados ${clientes_creados} · no vigentes ${saltados_novigente}${erroresCli.length ? ' · errores cliente ' + erroresCli.length : ''}` });
    log(`Sync contratos ${nombre}: ${creados} nuevos, ${actualizados} act, ${clientes_creados} clientes nuevos, ${saltados_novigente} no vig`);
    res.json({ ok: true, total, creados, actualizados, clientes_creados, saltados_novigente, sinIdentificador, erroresCli });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Alta de contrato en iNergia
app.post('/api/inergia/:proveedor/newctr', async (req, res) => {
  const nombre = req.params.proveedor.toUpperCase();
  try {
    const pv      = await tokenProveedor(nombre);
    const ctId    = req.body._contrato_id;
    const payload = { ...req.body, clave: pv.token };
    delete payload._contrato_id;
    const r    = await fetch(INERGIA + '/newctr', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) return res.status(r.status).json({ error: 'iNergia rechazó el alta', detalle: data });
    const idInergia = typeof data === 'number' ? data : data.id ?? data.idcontrato ?? data.ID;
    if (ctId && idInergia) {
      await db.upd('contratos', 'id=eq.' + ctId, { id_inergia: idInergia, estado: 'enviado', fecha_envio: new Date().toISOString().slice(0,10) });
    }
    await db.ins('eventos', { origen: nombre + ' · iNergia', tipo: 'contrato.enviado', ref: ctId || '—', detalle: `cups ${payload.cups} · ID iNergia: ${idInergia}` });
    res.json({ ok: true, idInergia });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Consulta estado contrato
app.get('/api/inergia/:proveedor/estadoctr/:id', async (req, res) => {
  try {
    const pv = await tokenProveedor(req.params.proveedor.toUpperCase());
    const { status, data } = await getquery(pv.token, { query: 'estadoctr', idcontrato: req.params.id });
    res.status(status).json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Sincronización de estados desde iNergia ───────────────────────────────────
// Mapea el texto de estado que devuelve iNergia al estado del CRM.
// Un estado desconocido conserva el dato existente y requiere revisión.
function mapEstadoInergia(txt) {
  return normalizarEstadoCRM(txt, null);
}

// Extrae estado y motivo del JSON de estadoctr sea cual sea su envoltorio

// Aplica en el CRM el estado que reporta iNergia para un contrato concreto
// ── Comisión por tramos ───────────────────────────────────────────────────────
const normTarifa = t => String(t || '').toUpperCase().replace(/[\s.]/g, '').replace('TD', '.0TD').replace('.0.0TD', '.0TD');
// Devuelve el tramo vigente para un contrato (por consumo MWh/año y, si aplica, potencia P1).
// La comisión se lee de ese tramo tal cual (0 es un valor válido, no "pendiente").
// Devuelve {comision, origen:'tramo'|'producto'} o null solo si aún no puede resolverse (falta consumo con tramos definidos).
async function calcularComision(ct) {
  const prods = await db.sel('productos', '&id=eq.' + ct.producto_id);
  const pr = prods?.[0];
  if (!pr) return null;
  const tramos = await db.sel('comision_tramos', '&producto_id=eq.' + ct.producto_id);
  if (!tramos?.length) {
    // Sin tramos definidos: fallback a la comisión plana del producto (0 incluido)
    return { comision: Number(pr.comision_bruta ?? 0), origen: 'producto' };
  }
  if (ct.consumo_anual === null || ct.consumo_anual === undefined) return null; // hay tramos pero falta el consumo
  const c = Number(ct.consumo_anual);
  const pot = ct.potencia_p1 != null ? Number(ct.potencia_p1) : null;
  // Candidatos por tramo de consumo
  let cand = tramos.filter(t => c >= Number(t.desde) && (t.hasta === null || c < Number(t.hasta)));
  // Discriminar por potencia si los tramos la usan (Audax): '≤10kW' / '>10kW' / '≤15kW' / '>15kW'
  const conPotencia = cand.filter(t => t.potencia);
  if (conPotencia.length && pot != null) {
    const casaPot = t => {
      const s = String(t.potencia).replace('kW', '').trim();
      const lim = parseFloat(s.replace(/[^\d.]/g, ''));
      if (isNaN(lim)) return true;
      return /≤|<=/.test(s) ? pot <= lim : /</.test(s) ? pot < lim : pot > lim;
    };
    const filtrado = cand.filter(casaPot);
    if (filtrado.length) cand = filtrado;
  }
  // Prioridad: tramo con tarifa que casa con la del producto; luego sin tarifa; luego único
  const tPr = normTarifa(pr.tarifa);
  const elegido = cand.find(t => t.tarifa_acceso && tPr && normTarifa(t.tarifa_acceso) === tPr)
               || cand.find(t => !t.tarifa_acceso)
               || (cand.length === 1 ? cand[0] : cand[0] || null);
  return elegido ? { comision: Number(elegido.comision ?? 0), origen: 'tramo' } : null;
}

async function sincronizarEstadoContrato(ct, pv) {
  if (ct.no_sync) return { cambio: false, protegido: true, estadoTxt: ct.estado_proveedor, nuevoEstado: ct.estado, motivo: '' };
  const cm = (await db.sel('comercializadoras', '&id=eq.' + ct.comercializadora_id))?.[0];
  const cliente = (await db.sel('clientes', '&id=eq.' + ct.cliente_id))?.[0];
  if (cm?.proveedor_id !== pv.id || cm.id_inergia_int == null) throw new Error('Comercializadora sin identificación API');
  const { status, data: cartera } = await getquery(pv.token, { query: 'cartera', idcomercializadora: cm.id_inergia_int });
  if (status < 200 || status >= 300) throw new Error('iNergia respondió ' + status);
  const detalle = coincidirContratoAPI(ct, cliente, cartera?.data || []);
  if (!detalle) throw new Error('Sin coincidencia inequívoca en la API; contrato conservado');
  const data = { data: detalle };
  const estadoTxt = String(detalle.estado || ''), motivo = String(detalle.situacion || '');
  const nuevoEstado = mapEstadoInergia(estadoTxt);
  if (!nuevoEstado) throw new Error('Estado de iNergia vacío o desconocido; contrato conservado');
  const upd = camposEstadoAPI(ct, { ...detalle, estado: estadoTxt, situacion: detalle.situacion ?? motivo });
  upd.id_inergia = Number(detalle.id);
  let cambio = false;
  if (nuevoEstado && nuevoEstado !== ct.estado) {
    upd.estado = nuevoEstado;
    cambio = true;
    if (nuevoEstado === 'activado') {
      upd.motivo_rechazo = null;
      // Si iNergia devuelve el consumo anual y el contrato no lo tiene, capturarlo (MWh/año)
      const dd = Array.isArray(data?.data) ? data.data[0] : (data?.data || data || {});
      const consInergia = dd.consumo_anual ?? dd.consumoAnual ?? dd.consumo ?? null;
      if ((ct.consumo_anual === null || ct.consumo_anual === undefined) && consInergia !== null && !isNaN(Number(consInergia))) {
        upd.consumo_anual = Number(consInergia);
      }
      // Comisión-foto: se fija al activar; si falta el consumo queda pendiente (null)
      if (ct.comercial_cartera_id && (ct.comision_calculada === null || ct.comision_calculada === undefined)) {
        const res = await calcularComision({ ...ct, ...upd });
        if (res) upd.comision_calculada = res.comision;
      }
    }
    if (nuevoEstado === 'rechazado') upd.motivo_rechazo = motivo || estadoTxt || 'Sin motivo indicado';
  } else if (nuevoEstado === 'rechazado' && motivo && motivo !== ct.motivo_rechazo) {
    upd.motivo_rechazo = motivo; // actualizar motivo aunque ya estuviera rechazado
  }
  await db.upd('contratos', 'id=eq.' + ct.id + '&no_sync=not.is.true', upd);
  return { cambio, estadoTxt, nuevoEstado, motivo };
}

// Consulta y actualiza UN contrato
app.post('/api/inergia/sync-estado/:contratoId', async (req, res) => {
  try {
    const cts = await db.sel('contratos', '&id=eq.' + req.params.contratoId);
    const ct  = cts?.[0];
    if (!ct)             return res.status(404).json({ error: 'Contrato no encontrado' });
    if (ct.no_sync) return res.json({ ok: true, cambio: false, protegido: true, estadoTxt: ct.estado_proveedor });

    const cms = await db.sel('comercializadoras', '&id=eq.' + ct.comercializadora_id);
    const pvs = await db.sel('proveedores', '&id=eq.' + cms?.[0]?.proveedor_id);
    const pv  = pvs?.[0];
    if (!pv?.token) return res.status(400).json({ error: 'Proveedor sin token de API' });

    const r = await sincronizarEstadoContrato(ct, pv);
    if (r.cambio) {
      await db.ins('eventos', { origen: pv.nombre + ' · iNergia', tipo: 'contrato.' + r.nuevoEstado, ref: ct.id,
        detalle: `cups ${ct.cups} · estado iNergia: "${r.estadoTxt}"${r.motivo ? ' · ' + r.motivo : ''}` });
    }
    log(`Sync estado ct ${ct.id}: "${r.estadoTxt}" → ${r.nuevoEstado || 'sin cambio'}`);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Revisa todos los estados, incluidos los históricos, contra la cartera API.
// Una coincidencia requiere ID o titular+CUPS+fecha dentro de la comercializadora.
app.post('/api/inergia/:proveedor/sync-estados', async (req, res) => {
  const nombre = req.params.proveedor.toUpperCase();
  try {
    const pv  = await tokenProveedor(nombre);
    const cms = await db.sel('comercializadoras', '&proveedor_id=eq.' + pv.id);
    const cmIds = (cms || []).map(c => c.id);
    if (!cmIds.length) return res.json({ ok: true, revisados: 0, cambios: 0, errores: [] });

    const cts = await db.sel('contratos', '&comercializadora_id=in.(' + cmIds.join(',') + ')');
    const clientes = new Map((await db.sel('clientes')).map(c => [c.id,c]));
    const out = { revisados: 0, cambios: 0, activados: 0, rechazados: 0, protegidos: 0, sin_coincidencia: 0, errores: [] };
    const carteras = new Map();
    const { data: catalogo } = await getquery(pv.token, { query: 'comercializadoras' });
    for (const cm of cms) {
      const idAPI = cm.id_inergia_int ?? catalogo?.data?.find(c => String(c.nombre).toUpperCase() === String(cm.nombre).toUpperCase())?.idcomercializadora;
      if (idAPI == null) continue;
      try {
        const { status, data } = await getquery(pv.token, { query: 'cartera', idcomercializadora: idAPI });
        if (status < 200 || status >= 300 || !Array.isArray(data?.data)) throw new Error('Respuesta de cartera inválida');
        carteras.set(cm.id, data.data);
        if (data.data.length === 300) out.errores.push(cm.nombre + ': 300 resultados; comprobar cobertura de API');
      } catch (e) { out.errores.push(cm.nombre + ': ' + e.message); }
    }
    for (const ct of (cts || [])) {
      if (ct.no_sync) { out.protegidos++; continue; }
      try {
        const row = coincidirContratoAPI(ct, clientes.get(ct.cliente_id), carteras.get(ct.comercializadora_id) || []);
        if (!row) { out.sin_coincidencia++; continue; }
        const upd = camposEstadoAPI(ct, row);
        if (!upd) { out.errores.push(`CUPS ${ct.cups}: estado API desconocido`); continue; }
        upd.id_inergia = Number(row.id);
        const cambio = ct.estado !== upd.estado;
        if (cambio && upd.estado === 'activado' && ct.comercial_cartera_id && ct.comision_calculada == null) {
          const comision = await calcularComision({ ...ct, ...upd });
          if (comision) upd.comision_calculada = comision.comision;
        }
        const material = Object.fromEntries(Object.entries(upd).filter(([key, value]) =>
          key !== 'ultima_consulta_estado' && JSON.stringify(ct[key] ?? null) !== JSON.stringify(value ?? null)
        ));
        if (Object.keys(material).length) {
          material.ultima_consulta_estado = upd.ultima_consulta_estado;
          await db.upd('contratos', 'id=eq.' + ct.id + '&no_sync=not.is.true', material);
        }
        const r = { cambio, nuevoEstado: upd.estado, estadoTxt: row.estado, motivo: row.situacion };
        out.revisados++;
        if (r.cambio) {
          out.cambios++;
          if (r.nuevoEstado === 'activado')  out.activados++;
          if (r.nuevoEstado === 'rechazado') out.rechazados++;
          await db.ins('eventos', { origen: pv.nombre + ' · iNergia', tipo: 'contrato.' + r.nuevoEstado, ref: ct.id,
            detalle: `cups ${ct.cups} · estado iNergia: "${r.estadoTxt}"${r.motivo ? ' · ' + r.motivo : ''}` });
        }
      } catch (e) { out.errores.push(`CUPS ${ct.cups}: ${e.message}`); }
    }
    await db.ins('eventos', { origen: nombre + ' · iNergia', tipo: 'sync.estados', ref: '—',
      detalle: `Revisados:${out.revisados} Cambios:${out.cambios} (↑${out.activados} ✕${out.rechazados}) Errores:${out.errores.length}` });
    log(`Sync estados ${nombre}: ${out.revisados} revisados, ${out.cambios} cambios`);
    res.json({ ok: true, ...out });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Comisiones por tramos: precarga de RANGOS y edición manual ────────────────
// Rangos estándar de consumo (MWh/año) por tarifa de acceso. Se precargan a 0 €
// y José va rellenando la comisión a mano conforme llegan las liquidaciones.
const RANGOS_MWH = {
  luz: [0,2,5,10,20,30,50,75,100,150,250,500],   // topes; el último tramo es "resto" (hasta=null)
  gas: [0,5,15,50,100,300,1000],
};
// Devuelve [{desde,hasta}] a partir de una lista de topes
const rangosDe = topes => topes.map((d,i) => ({ desde: d, hasta: i < topes.length-1 ? topes[i+1] : null }));

// Precarga rangos a 0 € en los productos indicados (o en todos los de una comercializadora).
// No pisa tramos existentes salvo que se pida reset=true.
app.post('/api/tramos/precargar', async (req, res) => {
  try {
    const { producto_ids, comercializadora_id, reset } = req.body || {};
    let prods = await db.sel('productos');
    if (Array.isArray(producto_ids) && producto_ids.length) prods = prods.filter(p => producto_ids.includes(p.id));
    else if (comercializadora_id) prods = prods.filter(p => p.comercializadora_id === comercializadora_id);
    else return res.status(400).json({ error: 'Indica producto_ids o comercializadora_id' });

    let creados = 0, saltados = 0;
    for (const pr of prods) {
      const existentes = await db.sel('comision_tramos', '&producto_id=eq.' + pr.id);
      if (existentes.length && !reset) { saltados++; continue; }
      if (existentes.length && reset) await db.del('comision_tramos', 'producto_id=eq.' + pr.id);
      const topes = RANGOS_MWH[pr.tipo] || RANGOS_MWH.luz;
      const filas = rangosDe(topes).map(r => ({
        producto_id: pr.id, tarifa_acceso: pr.tarifa || null, potencia: null,
        desde: r.desde, hasta: r.hasta, comision: 0,
      }));
      await db.ins('comision_tramos', filas);
      creados++;
    }
    await db.ins('eventos', { origen: 'CRM', tipo: 'tramos.precargar', ref: '—',
      detalle: `Rangos precargados en ${creados} productos · ${saltados} ya tenían tramos` });
    log(`Precarga tramos: ${creados} productos, ${saltados} saltados`);
    res.json({ ok: true, creados, saltados });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Alta/edición/borrado de un tramo suelto (la comisión-foto de contratos ya activados NO se toca)
app.post('/api/tramos', async (req, res) => {
  try {
    const t = req.body || {};
    if (!t.producto_id) return res.status(400).json({ error: 'Falta producto_id' });
    const fila = {
      producto_id: t.producto_id,
      tarifa_acceso: t.tarifa_acceso || null,
      potencia: t.potencia || null,
      desde: Number(t.desde) || 0,
      hasta: (t.hasta === '' || t.hasta === null || t.hasta === undefined) ? null : Number(t.hasta),
      comision: Number(t.comision) || 0,
    };
    const r = t.id ? await db.upd('comision_tramos', 'id=eq.' + t.id, fila)
                   : await db.ins('comision_tramos', fila);
    res.json({ ok: true, tramo: Array.isArray(r) ? r[0] : r });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.delete('/api/tramos/:id', async (req, res) => {
  try { await db.del('comision_tramos', 'id=eq.' + req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Importación masiva de clientes (dedup por CIF) ────────────────────────────
const normCif = c => String(c || '').toUpperCase().replace(/[\s.-]/g, '').trim();
app.post('/api/clientes/importar', async (req, res) => {
  try {
    const { clientes, actualizar } = req.body || {};
    if (!Array.isArray(clientes) || !clientes.length) return res.status(400).json({ error: 'Sin clientes' });

    // CIFs ya existentes en la base
    const existentes = await db.sel('clientes');
    const yaExiste = new Map(existentes.map(c => [normCif(c.cif), c.id]));

    const aInsertar = [], saltados = [], actualizados = [];
    const vistos = new Set();
    for (const c of clientes) {
      const cif = normCif(c.cif);
      if (!cif) { saltados.push('(sin CIF) ' + (c.razon_social || '')); continue; }
      if (vistos.has(cif)) continue;           // duplicado dentro del propio lote
      vistos.add(cif);
      if (yaExiste.has(cif)) {
        if (actualizar) actualizados.push({ id: yaExiste.get(cif), c });
        else { saltados.push(cif + ' · ' + (c.razon_social || '')); }
        continue;
      }
      aInsertar.push({ ...c, creado_por: c.comercial_id || null });
    }

    let insertados = 0;
    for (let i = 0; i < aInsertar.length; i += 100) {
      await db.ins('clientes', aInsertar.slice(i, i + 100));
      insertados += Math.min(100, aInsertar.length - i);
    }
    for (const { id, c } of actualizados) await db.upd('clientes', 'id=eq.' + id, c);

    await db.ins('eventos', { origen: 'CRM', tipo: 'clientes.importar', ref: '—',
      detalle: `Insertados:${insertados} Actualizados:${actualizados.length} Saltados(ya existían):${saltados.length}` });
    log(`Importación clientes: ${insertados} insertados, ${actualizados.length} actualizados, ${saltados.length} saltados`);
    res.json({ ok: true, insertados, actualizados: actualizados.length, saltados: saltados.length, saltados_detalle: saltados.slice(0, 50) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Liquidaciones
app.get('/api/inergia/:proveedor/liquidaciones', async (req, res) => {
  try {
    const pv = await tokenProveedor(req.params.proveedor.toUpperCase());
    const { status, data } = await getquery(pv.token, { query: 'liquidaciones' });
    res.status(status).json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORTAR CONTRATOS DESDE EXCEL
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/importar/contratos-inergia', async (req, res) => {
  const { filas } = req.body;
  if (!filas?.length) return res.status(400).json({ error: 'Sin filas' });
  log(`[Importar] ${filas.length} filas recibidas`);

  const resultados = { creados: 0, actualizados: 0, errores: [] };
  const comerList  = await db.sel('comercializadoras');
  const prodList   = await db.sel('productos');
  const userList   = await db.sel('usuarios');

  const comerMap = {}; (comerList||[]).forEach(cm => { comerMap[cm.nombre.toUpperCase()] = cm.id; });
  const prodMap  = {}; (prodList||[]).forEach(p  => { prodMap[p.nombre?.toUpperCase()]   = p; });
  const normComercial = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z]/g,'');
  const resolverComercialExcel = nombre => {
    const n = normComercial(nombre);
    if (!n) return null;
    const exacto = (userList||[]).find(u => normComercial(u.nombre) === n);
    if (exacto) return exacto.id;
    return (userList||[]).find(u => normComercial(u.nombre).includes(n) || n.includes(normComercial(u.nombre)))?.id || null;
  };

  for (const f of filas) {
    try {
      const cif    = String(f.cif||'').toUpperCase().trim();
      const nombre = String(f.cliente||'').trim();
      if (!cif || !nombre) continue;

      // Buscar o crear cliente
      let clienteId = null;
      const clEx = await db.sel('clientes', '&cif=eq.' + encodeURIComponent(cif));
      if (clEx?.length) {
        clienteId = clEx[0].id;
      } else {
        const primerChar  = cif[0];
        const tipoTitular = /^[PQ]/i.test(primerChar) ? 'organismo' : /^[ABCDEFGHJNRSUVW]/i.test(primerChar) ? 'empresa' : 'fisica';
        const comercialId = resolverComercialExcel(f.comercial) || userList?.[0]?.id;
        const cl = await db.ins('clientes', { cif, razon_social: nombre, tipo_titular: tipoTitular, telefono: String(f.telefono||''), email: String(f.email||''), comercial_id: comercialId, creado_por: comercialId });
        clienteId = cl?.[0]?.id;
      }
      if (!clienteId) { resultados.errores.push('No se pudo crear cliente: ' + cif); continue; }

      // Comercializadora
      const cmNombre = String(f.comercializadora||'').toUpperCase().trim();
      const comercializadoraId = comerMap[cmNombre];
      if (!comercializadoraId) { resultados.errores.push('Comercializadora no encontrada: ' + f.comercializadora); continue; }

      // Producto
      const prNombre  = String(f.producto||'').toUpperCase().trim();
      const prod      = prNombre ? prodMap[prNombre] : null;
      const productoId = prod?.id || null;
      if (!productoId && prNombre) resultados.errores.push('Producto no encontrado: ' + f.producto + ' (CUPS: ' + f.cups + ')');

      // Estado
      const estado = normalizarEstadoCRM(f.estado);
      if (!estado) { resultados.errores.push('Estado no reconocido: ' + f.estado + ' (CUPS: ' + f.cups + ')'); continue; }
      const cups   = String(f.cups||'').trim();
      const hoy    = new Date().toISOString().slice(0,10);

      const comercialCarteraId = resolverComercialExcel(f.comercial);
      const ctData = {
        cliente_id: clienteId, cups, tipo: prod?.tipo || (cups.startsWith('ES02')?'gas':'luz'),
        comercial_cartera_id: comercialCarteraId,
        comercial_import: String(f.comercial_import||'').trim() || null,
        comercializadora_id: comercializadoraId, producto_id: productoId,
        estado, tarifa: String(f.tarifa||''),
        permanencia: f.perm==='SI'?'SI':'NO', renovacion_auto: f.ren==='SI'?'SI':'NO',
        iban: String(f.iban||''), potencia_p1: parseFloat(f.potencia)||0,
        consumo_kwh: parseFloat(f.consumo)||null, referencia: String(f.codigo||''),
        fecha_registro: f.reg ? new Date(f.reg).toISOString().slice(0,10) : null,
        fecha_activacion: estado==='activado' && f.alta ? new Date(f.alta).toISOString().slice(0,10) : null,
        fecha_renovacion: f.vto ? new Date(f.vto).toISOString().slice(0,10) : null,
        fecha_baja: estado==='baja' && f.fechaEstado ? new Date(f.fechaEstado).toISOString().slice(0,10) : null,
        pagador: parseInt(f.pag)||1, tiposol:'C1',
      };

      const referencia = String(f.codigo || '').trim();
      const ctMismoOrigen = referencia
        ? contratoActual(await db.sel('contratos', '&referencia=eq.' + encodeURIComponent(referencia) + '&comercializadora_id=eq.' + comercializadoraId))
        : null;
      if (ctMismoOrigen) {
        if (ctMismoOrigen.no_sync) continue;
        await db.upd('contratos', 'id=eq.' + ctMismoOrigen.id, ctData);
        resultados.actualizados++;
      } else if (referencia) {
        // Mismo CUPS con otro código = nueva contratación; la anterior queda en histórico.
        await db.ins('contratos', ctData);
        resultados.creados++;
      } else {
        const ctActual = contratoActual(await db.sel('contratos', '&cups=eq.' + encodeURIComponent(cups)));
        if (ctActual) { if (ctActual.no_sync) continue; await db.upd('contratos', 'id=eq.' + ctActual.id, ctData); resultados.actualizados++; }
        else          { await db.ins('contratos', ctData); resultados.creados++; }
      }
    } catch (e) {
      resultados.errores.push('Error en CUPS ' + f.cups + ': ' + e.message);
    }
  }
  await db.ins('eventos', { origen:'iNergia (importación)', tipo:'import.contratos', ref:'—', detalle:`Creados:${resultados.creados} Actualizados:${resultados.actualizados} Errores:${resultados.errores.length}` });
  log(`[Importar] Creados:${resultados.creados} Actualizados:${resultados.actualizados} Errores:${resultados.errores.length}`);
  res.json({ ok: true, ...resultados });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GANA ENERGÍA — Webhook
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/webhooks/gana-energia', async (req, res) => {
  if (GANA_SEC) {
    const firma    = req.get('X-Signature') || '';
    const esperada = crypto.createHmac('sha256', GANA_SEC).update(JSON.stringify(req.body)).digest('hex');
    if (firma !== esperada) return res.status(401).json({ error: 'Firma no válida' });
  }
  const ev   = req.body;
  const cups = ev.cups || ev.CUPS;
  const estadoPayload = ev.estado || ev.Estado;
  const estadoGana = typeof estadoPayload === 'object'
    ? estadoPayload?.nombre || estadoPayload?.name || ''
    : String(estadoPayload || '');
  if (cups && estadoGana) {
    const estadoCRM = normalizarEstadoCRM(estadoGana);

    const ganaCms = await db.sel('comercializadoras', '&nombre=eq.GANA');
    const ganaCmIds = new Set((ganaCms || []).map(cm => cm.id));
    const versiones = (await db.sel('contratos', '&cups=eq.' + encodeURIComponent(cups)))
      .filter(c => ganaCmIds.has(c.comercializadora_id));
    const actual = contratoActual(versiones);
    if (actual && !actual.no_sync) {
      const hoy = new Date().toISOString().slice(0,10);
      const upd = { estado_proveedor: estadoGana, situacion: estadoGana, ultima_consulta_estado: new Date().toISOString() };
      if (estadoCRM) upd.estado = estadoCRM;
      // Una repetición del webhook nunca debe desplazar una fecha ya conocida.
      if (estadoCRM === 'activado' && !actual.fecha_activacion) {
        const fechaActivacion = ev.fecha_activacion || ev.fechaAlta || ev.fecha_alta || hoy;
        upd.fecha_activacion = String(fechaActivacion).slice(0, 10);
        if (!actual.fecha_renovacion) {
          const d = new Date(upd.fecha_activacion + 'T00:00:00');
          d.setMonth(d.getMonth() + (Number(actual.duracion_meses) || 12));
          upd.fecha_renovacion = d.toISOString().slice(0, 10);
        }
      }
      if (estadoCRM === 'baja' && !actual.fecha_baja) {
        upd.fecha_baja = String(ev.fecha_baja || ev.fechaBaja || hoy).slice(0, 10);
      }
      await db.upd('contratos', 'id=eq.' + actual.id, upd);
    }
  }
  await db.ins('eventos', { origen:'Gana Energía (webhook)', tipo:ev.tipo||'evento', ref:cups||'—', detalle:JSON.stringify(ev).slice(0,200) });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  log(`Servidor INLUZGAS en http://localhost:${PORT}`);
  if (!SB_URL)  console.warn('⚠ Falta SUPABASE_URL');
  if (!SB_KEY)  console.warn('⚠ Falta SUPABASE_SERVICE_KEY');
});
