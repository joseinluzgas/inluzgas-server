const CANONICOS = new Set(['borrador','enviado','en_tramite','activado','pdte_renovar','pdte_grabar','incidencia','rechazado','baja','cancelado']);
function normalizarEstadoCRM(valor, fallback = null) {
  const raw = String(valor ?? '').trim().toLowerCase();
  if (CANONICOS.has(raw)) return raw;
  const t = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[._]/g, ' ').replace(/\s+/g, ' ');
  if (!t) return fallback;
  if (/^(baja)(\s|$)/.test(t)) return 'baja';
  if (/cancel|anulad/.test(t)) return 'cancelado';
  if (/rechaz/.test(t) || t === 'ko') return 'rechazado';
  if (/incidencia resuelta/.test(t)) return 'en_tramite';
  if (/incidenc/.test(t)) return 'incidencia';
  if (/^(activo|activado)(\s+ftr)?$/.test(t) || t === 'comisionado') return 'activado';
  if (/^(pdte|pendiente).*renovar/.test(t)) return 'pdte_renovar';
  if (/^(pdte|pendiente).*grabar|^grabar a futuro$/.test(t)) return 'pdte_grabar';
  if (t === 'borrador') return 'borrador';
  if (t === 'enviado') return 'enviado';
  if (/tramite|pendiente|firma|nuevo|aceptado|revisado|solicitud/.test(t)) return 'en_tramite';
  return fallback;
}
const norm = v => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cupsBase = v => {
  const c = norm(v);
  return /^ES[A-Z0-9]{18}([A-Z0-9]{2})?$/.test(c) ? c.slice(0,20) : c;
};
function fechaAPI(v) {
  const text = String(v ?? '').slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(text + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === text ? text : null;
}
function parseEstadoCtr(data) {
  const d = Array.isArray(data) ? data[0] : Array.isArray(data?.data) ? data.data[0] : (data?.data || data || {});
  const estadoTxt = d?.estado ?? d?.Estado ?? d?.estado_contrato ?? d?.status ?? '';
  const motivo = d?.motivo ?? d?.Motivo ?? d?.observaciones ?? d?.Observaciones ?? d?.incidencia ?? d?.comentario ?? '';
  return { estadoTxt: String(estadoTxt), motivo: String(motivo), detalle: d };
}
// The caller scopes candidates to one provider and retailer. Never select the
// newest contract of a CUPS: a renewal and its history can have different states.
function coincidirContratoAPI(ct, cliente, rows) {
  const pool = rows.filter(a => cupsBase(a.cups) === cupsBase(ct.cups));
  const titular = a => !!norm(a.cif) && [norm(cliente?.cif),norm(cliente?.nif)].includes(norm(a.cif));
  const id = pool.filter(a => ct.id_inergia && String(a.id) === String(ct.id_inergia));
  if (id.length === 1 && (!id[0].cif || titular(id[0])) &&
      (!ct.fecha_registro || !id[0].fecha_reg || fechaAPI(ct.fecha_registro) === fechaAPI(id[0].fecha_reg))) return id[0];
  const reg = pool.filter(a => titular(a) && fechaAPI(ct.fecha_registro) && fechaAPI(ct.fecha_registro) === fechaAPI(a.fecha_reg));
  if (reg.length === 1) return reg[0];
  if (reg.length > 1) return null;
  const alta = pool.filter(a => titular(a) && !ct.fecha_registro && fechaAPI(ct.fecha_activacion) &&
    fechaAPI(ct.fecha_activacion) === fechaAPI(a.fecha_alta));
  return alta.length === 1 ? alta[0] : null;
}
function camposEstadoAPI(ct, row, now = new Date().toISOString()) {
  const estado = normalizarEstadoCRM(row.estado);
  if (!estado) return null; // Unknown is not evidence of activation.
  const upd = { estado, estado_proveedor: String(row.estado), ultima_consulta_estado: now };
  if (Object.hasOwn(row, 'situacion')) upd.situacion = String(row.situacion ?? '');
  else if (estado !== normalizarEstadoCRM(ct.estado)) upd.situacion = '';
  for (const [src,dst] of [['fecha_alta','fecha_activacion'],['fecha_vto','fecha_renovacion'],['fecha_baja','fecha_baja']]) {
    const value = fechaAPI(row[src]);
    if (value) upd[dst] = value;
  }
  if (estado === 'activado') {
    if (Object.hasOwn(row,'fecha_baja') && !row.fecha_baja) upd.fecha_baja = null;
    upd.motivo_rechazo = null;
  }
  if (estado === 'rechazado') upd.motivo_rechazo = String(row.motivo || row.situacion || row.estado);
  return upd;
}
module.exports = { CANONICOS, normalizarEstadoCRM, cupsBase, fechaAPI, parseEstadoCtr, coincidirContratoAPI, camposEstadoAPI };
