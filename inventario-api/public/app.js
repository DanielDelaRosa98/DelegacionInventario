(() => {
  'use strict';

  const $ = (id)=> document.getElementById(id);
  const hide = (id)=>{ const el=$(id); if(el) el.classList.add('hidden'); };
  const show = (id)=>{ const el=$(id); if(el) el.classList.remove('hidden'); };

  function toast(msg, ok=false){
    const t=$('toast'); if(!t) return;
    t.textContent = msg||'';
    t.className = ok ? 'ok' : 'danger';
    setTimeout(()=>{ if(t.textContent===msg) t.textContent=''; t.className=''; }, 4000);
  }
  const toNumberOrNull = (v)=>{ if(v==null||v==='')return null; const n=Number(v); return Number.isFinite(n)?n:null; };
  function fmtDate(val){
    if (!val) return '-';
    if (typeof val === 'string'){
      const s = val.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)){ const [y,m,d]=s.split('-'); return `${d}/${m}/${y}`; }
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)){
        const d=new Date(s.replace(' ','T')); if(!isNaN(d)) return d.toLocaleDateString('es-MX');
      }
    }
    const d = new Date(val); if (!isNaN(d)) return d.toLocaleDateString('es-MX');
    return String(val);
  }
  function pickUsuario(d){
    const nested = d?.usuario || {};
    const nestedName =
      nested.nombre_completo ||
      nested.nombre_usuario ||
      nested.NOMBRE_USUARIO ||
      [nested.nombre, nested.PRIMER_APELLIDO, nested.SEGUNDO_APELLIDO].filter(Boolean).join(' ');
    if (nestedName) return nestedName;

    return (
      d.nombreUsuario || d.nombre_usuario || d.NOMBRE_USUARIO ||
      d.usuarioNombre || d.usuario_nombre || d.USUARIO ||
      d.solicitante || d.SOLICITANTE ||
      nested.username || nested.USERNAME ||
      d.username || d.USERNAME ||
      [d.nombre||d.NOMBRE, d.PRIMER_APELLIDO||d.primer_ap, d.SEGUNDO_APELLIDO||d.segundo_ap].filter(Boolean).join(' ')
    ) || '-';
  }
  const norm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase();
  const safestr = v => (typeof v==='string' ? v.trim() : (v==null?'':String(v))).trim();
  const isNum = v => !isNaN(Number(v)) && v!=='' && v!=null;

  let CURRENT_USER = null;
  const ALLOW_SEC_FULL = new Set(['ADMIN','DEMO','SERVICIO_SOCIAL','ALVARO MARTIN','REBECA','REBECA TRUJILLO','REBECA TRUJILLO TORRES','CAAJ870407MBSHMH08']);
  const ALLOW_USERID_EDIT = new Set(['ALVARO MARTIN','JOHAN GUADALUPE','REBECA','REBECA TRUJILLO','REBECA TRUJILLO TORRES']);
  const SPECIAL_ALMACEN_USERS = new Set([
    'CAAJ870407MBSHMH08',
    'ALVARO_MARTIN',
    'MARIA_TERESA',
    'REBECA',
    'REBECA_CAMPOS',
    'REBECA_TRUJILLO',
    'REBECA_TRUJILLO_TORRES',
    'REBECA TRUJILLO',
    'REBECA TRUJILLO TORRES',
    'SERVICIO_SOCIAL'
  ]);
  const REPORT_USERS = new Set(['DEMO','ALVARO_MARTIN','CAAJ870407MBSHMH08','REBECA','REBECA_CAMPOS','REBECA_TRUJILLO']);
  let UI_PERMISOS = null;
  const uiPerms = ()=> UI_PERMISOS?.permisos || UI_PERMISOS?.permasos || {};

  function isAdminDemo(u){ const uname = norm(u?.username); return uname==='ADMIN' || uname==='DEMO' || uname==='SERVICIO_SOCIAL'; }
  function fullNameOrRFC(u){ const rf = norm(u?.username); const whole = norm([u?.nombre,u?.primer_ap,u?.segundo_ap].filter(Boolean).join(' ')); return whole || rf; }
  function canFullSections(u){ const perms = uiPerms(); const id = fullNameOrRFC(u); const uname = norm(u?.username); if (perms?.admin) return true; return ALLOW_SEC_FULL.has(id) || ALLOW_SEC_FULL.has(uname); }
  function isFrontAlmacenAllowed(u){ const perms = uiPerms(); const uname = norm(u?.username); const full = fullNameOrRFC(u); if (perms?.puedeAccederAlmacen) return true; return SPECIAL_ALMACEN_USERS.has(uname) || SPECIAL_ALMACEN_USERS.has(full); }
  function canViewReportesFront(u){ const perms = uiPerms(); const uname = norm(u?.username); return !!perms?.reportes?.acceso || REPORT_USERS.has(uname); }
  function canManageSolicitudesFront(u){ return isAdminDemo(u) || isFrontAlmacenAllowed(u) || !!uiPerms()?.solicitudes?.puedeCambiarStatus; }
  function canEditUserId(u){
    if (uiPerms()?.solicitudes?.idEditable) return true;
    if (isAdminDemo(u)) return true;
    if (isFrontAlmacenAllowed(u)) return true;
    const id = fullNameOrRFC(u); return ALLOW_USERID_EDIT.has(id);
  }

  function applyPermassions(){  
    const u = CURRENT_USER || {};  
    const allowFull = canFullSections(u);  
    const adminDemo = isAdminDemo(u);  
    const allowAlmacen = allowFull || isFrontAlmacenAllowed(u);
    const allowReportes = canViewReportesFront(u);

    const basicViews = new Set(['captura','solicitudes']);
    document.querySelectorAll('#nav .tab').forEach(t=>{  
      const v = (t.dataset.view||'').toLowerCase();
      if (v === 'reporte' || v === 'graficas'){
        if (!allowReportes){
          t.classList.add('hidden');
        } else {
          t.classList.remove('hidden');
          t.classList.remove('disabled');
          t.removeAttribute('aria-disabled');
        }
        return;
      }
      if (!allowAlmacen && !basicViews.has(v)) {
        t.classList.add('hidden');
        return;
      } else {
        t.classList.remove('hidden');
      }
      if (v === 'almacen') {  
        if (!allowAlmacen){  
          t.classList.add('disabled');  
          t.setAttribute('aria-disabled','true');  
        } else {  
          t.classList.remove('disabled');  
          t.removeAttribute('aria-disabled');  
        }  
      }  
    });  

    const uidIn = $('sol_user_id');  
    if (uidIn){  
      const editable = canEditUserId(u);  
      if (!uidIn.value) uidIn.value = (CURRENT_USER?.id ?? '').toString();  
      uidIn.disabled = !editable;  
      uidIn.title = editable ? '' : 'Bloqueado (autorrelleno con tu usuario)';  
    }  

    if ($('btn-sol-eliminar')) {  
      $('btn-sol-eliminar').disabled = !adminDemo;  
      $('btn-sol-eliminar').title = adminDemo ? '' : 'Eliminar solo admin/demo';  
    }  
    if ($('btn-sol-cancelar')) {
      const canCancel = canManageSolicitudesFront(u);
      $('btn-sol-cancelar').disabled = !canCancel;
      $('btn-sol-cancelar').title = canCancel ? '' : 'Cancelar solo usuarios autorizados';
    }
  }

  let API = ''; 
  async function ensureAPI(){
    if (!API) { API = ''; }
    return API;
  }
  async function api(path, opts = {}){ const base = await ensureAPI(); const url = (/^https?:\/\//.test(path) ? path : (base + path)); return fetch(url, { credentials:'include', ...opts }); }
  async function apiJSON(path, opts = {}){
    const res = await api(path, { headers:{'Accept':'application/json', ...(opts.headers||{})}, ...opts });
    const text = await res.text(); const json = (()=>{ try{return JSON.parse(text);}catch{return null;} })();
    if (!res.ok){ const msg = json?.error || json?.message || json?.massage || text || `HTTP ${res.status}`; throw new Error(msg); }
    return json ?? {};
  }
  function handleAuthError(e){
    const m = String(e?.message || e?.massage || '').toLowerCase();
    if (m.includes('no autenticado') || m.includes('unauthorized') || m.includes('token')){ show('login-wrap'); hide('app-wrap'); toast('Sesion requerida'); return true; }
    return false;
  }

  function routeKey(method, path){ return `${String(method||'GET').toUpperCase()} ${String(path||'').trim()}`; }
  const APP_ROUTES = new Set([
    routeKey('GET', '/api/usuarios'),
    routeKey('GET', '/api/oficialias'),
    routeKey('GET', '/api/ui-config'),
    routeKey('GET', '/api/almacen'),
    routeKey('GET', '/api/productos'),
    routeKey('GET', '/api/productos/historial/:clave'),
    routeKey('GET', '/api/productos/:id'),
    routeKey('GET', '/api/categorias'),
    routeKey('POST', '/api/productos'),
    routeKey('POST', '/api/lookup/unidad-categoria')
  ]);
  async function hasRoute(method, path){ return APP_ROUTES.has(routeKey(method, path)); }
  async function loadSolicitudUsers(){
    const createSel = $('sol_user_id');
    if (!createSel) return;

    const canAllUsers = canEditUserId(CURRENT_USER);
    const ownId = Number(CURRENT_USER?.id || 0) || null;
    const currentCreate = createSel?.value || '';
    let userData = [];

    try{
      if (await hasRoute('GET','/api/usuarios')){
        const j = await apiJSON('/api/usuarios?include_inactive=1');
        userData = Array.isArray(j?.data) ? j.data : [];
      }
    }catch{}

    if (!userData.length && ownId){
      const ownName = [CURRENT_USER?.nombre, CURRENT_USER?.primer_ap, CURRENT_USER?.segundo_ap].filter(Boolean).join(' ').trim();
      userData = [{ id: ownId, username: CURRENT_USER?.username || '', nombre_completo: ownName || CURRENT_USER?.username || `Usuario ${ownId}` }];
    }

    const activeUsers = userData.filter(u => {
      const activo = Number(u?.activo?.data?.[0] ?? u?.activo ?? 1);
      return activo !== 0;
    });
    const createSource = activeUsers.length ? activeUsers : userData;
    const options = createSource.map(u => {
      const id = Number(u.id || 0);
      const name = safestr(u.nombre_completo || u.fullname || u.username || `Usuario ${id}`);
      return `<option value="${id}">${name}</option>`;
    }).join('');
    if (createSel){
      createSel.innerHTML = options || '<option value="">Sin usuarios</option>';
      createSel.value = currentCreate || String(ownId || createSource[0]?.id || '');
      createSel.disabled = !canAllUsers;
      createSel.title = canAllUsers ? '' : 'Bloqueado con tu usuario';
    }

  }
  async function loadSolicitudOficialias(){
    const listSel = $('list_oficialia');
    if (!listSel) return;
    const canAllUsers = canManageSolicitudesFront(CURRENT_USER);
    const ownOfi = Number(CURRENT_USER?.id_oficialia || 0) || null;
    const current = listSel.value || '';
    let rows = [];
    try{
      if (await hasRoute('GET','/api/oficialias')){
        const j = await apiJSON('/api/oficialias');
        rows = Array.isArray(j?.data) ? j.data : [];
      }
    }catch{}
    if (!rows.length && ownOfi){
      rows = [{ id: ownOfi, nombre: `Oficialia ${ownOfi}` }];
    }
    const options = rows.map(r => `<option value="${Number(r.id || 0)}">${safestr(r.nombre) || `Oficialia ${Number(r.id || 0)}`}</option>`).join('');
    const allOption = canAllUsers ? '<option value="">Todas las oficialias</option>' : '';
    listSel.innerHTML = allOption + (options || '<option value="">Sin oficialias</option>');
    listSel.value = canAllUsers ? (current || '') : String(ownOfi || rows[0]?.id || '');
    listSel.disabled = !canAllUsers;
    listSel.title = canAllUsers ? '' : 'Solo puedes consultar tu oficialia';
  }

  async function fetchUiConfig(){ try{ if (!(await hasRoute('GET','/api/ui-config'))) return null; const j = await apiJSON('/api/ui-config'); UI_PERMISOS = j; return j; }catch{ return null; } }
  async function me(){
    try{
      const j = await apiJSON('/api/auth/me'); const u = j.user || {};
      CURRENT_USER = u; $('who').textContent = u.username || u.nombre || 'usuario';
      hide('login-wrap'); show('app-wrap'); await fetchUiConfig(); showView('captura');
      await Promise.all([loadSolicitudUsers(), loadSolicitudOficialias()]); applyPermassions();
    }catch{
      CURRENT_USER = null; show('login-wrap'); hide('app-wrap'); const m = $('login-msg'); if (m) m.textContent = '';
    }
  }
  async function login(){
    const username = $('user').value.trim(); const password = $('pass').value; const msg = $('login-msg'); msg.textContent = 'Validando...';
    try{
      const j = await apiJSON('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username, password }) });
      CURRENT_USER = j.user || null; $('who').textContent = j.user?.username || username;
      msg.textContent = ''; hide('login-wrap'); show('app-wrap'); await fetchUiConfig(); showView('captura');
      await Promise.all([loadSolicitudUsers(), loadSolicitudOficialias()]); applyPermassions();
    }catch(e){ console.error(e); msg.textContent = e.message || e.massage || 'No se pudo iniciar sesion'; }
  }
  async function logout(){
    try{ await apiJSON('/api/auth/logout', { method:'POST' }); }catch{}
    CURRENT_USER = null; UI_PERMISOS = null; show('login-wrap'); hide('app-wrap');
    $('user').focus();
  }

  function showView(id){
    for (const sec of document.querySelectorAll('section')) sec.classList.add('hidden');
    const el = document.getElementById('view-'+id); if (el) el.classList.remove('hidden');
    for (const b of document.querySelectorAll('#nav .tab')) b.classList.remove('active');
    const btn = document.querySelector(`#nav .tab[data-view="${id}"]`); if (btn) btn.classList.add('active');

    const viewId = String(id).toLowerCase();
    const locked =
      (viewId === 'almacen' && !(canFullSections(CURRENT_USER) || isFrontAlmacenAllowed(CURRENT_USER) || isAdminDemo(CURRENT_USER))) ||
      ((viewId === 'reporte' || viewId === 'graficas') && !canViewReportesFront(CURRENT_USER));
    if (locked){ toast('Acceso restringido', false); showView('captura'); return; }

    if (id==='almacen'){ loadCategorias(); loadAlmacen(); }
    if (id==='reporte'){ setReporteView('home'); loadReporteUsuarios(); }
    if (id==='graficas'){ loadGraficas(); }
  }

  function formatReportOficialiaLabel(row){
    return safestr(row?.oficialia_nombre || row?.nombre || '-') || '-';
  }
  let REP_DATA = null;
  let GRAF_DATA = null;
  let REP_SELECTED_OFICIALIA = '';
  function setReporteView(mode){
    const home = $('rep-home');
    const detail = $('rep-detail');
    home?.classList.toggle('hidden', mode === 'detail');
    detail?.classList.toggle('hidden', mode !== 'detail');
  }
  function resetReporteView(){
    REP_DATA = null;
    REP_SELECTED_OFICIALIA = '';
    if ($('rep_msg')) $('rep_msg').textContent = '';
    if ($('rep_detail_title')) $('rep_detail_title').textContent = 'Reporte de oficialia';
    if ($('rep_detail_sub')) $('rep_detail_sub').textContent = '';
    if ($('rep_kpi_sol')) $('rep_kpi_sol').textContent = '-';
    if ($('rep_kpi_cant')) $('rep_kpi_cant').textContent = '-';
    if ($('rep_kpi_ent')) $('rep_kpi_ent').textContent = '-';
    if ($('rep_kpi_top_prod')) $('rep_kpi_top_prod').textContent = '-';
    if ($('rep_kpi_top_oficialia')) $('rep_kpi_top_oficialia').textContent = '-';
    if ($('rep_productos_box')) $('rep_productos_box').innerHTML = '<div class="muted">Sin datos.</div>';
    if ($('rep_oficialias_box')) $('rep_oficialias_box').innerHTML = '<div class="muted">Sin datos.</div>';
    if ($('rep_solicitudes_box')) $('rep_solicitudes_box').innerHTML = '<div class="muted">Sin datos.</div>';
    if ($('rep_inconsistencias_box')) $('rep_inconsistencias_box').innerHTML = '<div class="muted">Sin datos.</div>';
    if ($('rep_chart_box')) $('rep_chart_box').innerHTML = '<div class="muted">Sin datos.</div>';
    setReporteView('home');
  }
  function fillOficialiasSelect(selId, rows, current='', allLabel='Todos'){
    const sel = $(selId); if (!sel) return;
    const options = [`<option value="">${allLabel}</option>`].concat(
      (rows || []).map(r => `<option value="${Number(r.oficialia_id || 0)}">${formatReportOficialiaLabel(r)}</option>`)
    );
    sel.innerHTML = options.join('');
    sel.value = current || '';
  }
  function fillReporteOficialiasSelect(rows, current=''){
    fillOficialiasSelect('rep_oficialia', rows, current, 'Todos');
  }
  function fillGraficasOficialiasSelect(rows, current=''){
    fillOficialiasSelect('graf_oficialia', rows, current, 'Todas');
  }
  function renderReporteProductos(rows){
    const box = $('rep_productos_box'); if (!box) return;
    if (!rows?.length){
      box.innerHTML = '<div class="muted">Sin datos.</div>';
      return;
    }
    const topRows = rows.slice(0, 10);
    const renderTable = (tableRows) => `
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>CLAVE</th>
              <th>PRODUCTO</th>
              <th>SOLICITUDES</th>
              <th>CANT. SOLICITADA</th>
              <th>CANT. ENTREGADA</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows.map(r => `<tr>
              <td>${safestr(r.clave || r.CLAVE) || '-'}</td>
              <td>${safestr(r.descripcion || r.DESCRIPCION) || '-'}</td>
              <td>${Number(r.solicitudes_count || 0)}</td>
              <td>${Number(r.cantidad_solicitada || 0)}</td>
              <td>${Number(r.cantidad_atendida || 0)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    box.innerHTML = `
      <div style="margin-bottom:14px;">
        <h4 style="margin:0 0 8px 0;">Top 10</h4>
        ${renderTable(topRows)}
      </div>
      <div>
        <h4 style="margin:0 0 8px 0;">Todos los productos solicitados</h4>
        ${renderTable(rows)}
      </div>`;
  }
  function renderReporteOficialias(rows){
    const box = $('rep_oficialias_box'); if (!box) return;
    if (!rows?.length){
      box.innerHTML = '<div class="muted">Sin datos.</div>';
      return;
    }
    box.innerHTML = `
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>OFICIALIA</th>
              <th>SOLICITUDES</th>
              <th>PROD. SOLICITADOS</th>
              <th>PROD. ENTREGADOS</th>
              <th>ACCION</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td>${formatReportOficialiaLabel(r)}</td>
              <td>${Number(r.solicitudes_count || 0)}</td>
              <td>${Number(r.cantidad_solicitada || 0)}</td>
              <td>${Number(r.cantidad_atendida || 0)}</td>
              <td><button class="mini" data-rep-open-oficialia="${Number(r.oficialia_id || 0)}">Ver reporte</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }
  function renderReporteSolicitudes(rows){
    const box = $('rep_solicitudes_box'); if (!box) return;
    if (!rows?.length){
      box.innerHTML = '<div class="muted">Sin datos.</div>';
      return;
    }
    box.innerHTML = `
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>USUARIO</th>
              <th>OFICIALIA</th>
              <th>SOLICITUDES</th>
              <th>ULTIMA FECHA</th>
              <th>CANT. SOLICITADA</th>
              <th>CANT. ENTREGADA</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td>${safestr(r.nombre_usuario) || '-'}</td>
              <td>${safestr(r.oficialia_nombre) || '-'}</td>
              <td>${Number(r.solicitudes_count || 0)}</td>
              <td>${fmtDate(r.ultima_fecha)}</td>
              <td>${Number(r.cantidad_solicitada || 0)}</td>
              <td>${Number(r.cantidad_atendida || 0)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }
  function renderReporteInconsistencias(rows){
    const box = $('rep_inconsistencias_box'); if (!box) return;
    if (!rows?.length){
      box.innerHTML = '<div class="muted">Sin inconsistencias.</div>';
      return;
    }
    box.innerHTML = `
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>USUARIO</th>
              <th>OFICIALIA SOLICITUD</th>
              <th>OFICIALIA USUARIO</th>
              <th>SOLICITUDES</th>
              <th>ULTIMA FECHA</th>
              <th>CANT. SOLICITADA</th>
              <th>CANT. ENTREGADA</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td>${safestr(r.nombre_usuario) || '-'}</td>
              <td>${safestr(r.oficialia_solicitud_nombre) || '-'}</td>
              <td>${safestr(r.oficialia_usuario_nombre) || '-'}</td>
              <td>${Number(r.solicitudes_count || 0)}</td>
              <td>${fmtDate(r.ultima_fecha)}</td>
              <td>${Number(r.cantidad_solicitada || 0)}</td>
              <td>${Number(r.cantidad_atendida || 0)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }
  function renderReporteChart(rows){
    const box = $('rep_chart_box'); if (!box) return;
    const topRows = (rows || []).slice(0, 10);
    if (!topRows.length){
      box.innerHTML = '<div class="muted">Sin datos.</div>';
      return;
    }
    const maxVal = Math.max(...topRows.map(r => Number(r.cantidad_solicitada || 0)), 1);
    box.innerHTML = `
      <div class="rep-chart">
        ${topRows.map(r => {
          const val = Number(r.cantidad_solicitada || 0);
          const width = Math.max(4, Math.round((val / maxVal) * 100));
          const label = [safestr(r.clave || r.CLAVE), safestr(r.descripcion || r.DESCRIPCION)].filter(Boolean).join(' - ') || '-';
          return `<div class="rep-bar-row">
            <div class="rep-bar-label" title="${label}">${label}</div>
            <div class="rep-bar-track"><div class="rep-bar-fill" style="width:${width}%"></div></div>
            <div class="rep-bar-val">${val}</div>
          </div>`;
        }).join('')}
      </div>`;
  }
  function reportHtmlTable(headers, rows){
    return `
      <table style="width:100%; border-collapse:collapse; margin-top:10px;">
        <thead>
          <tr>
            ${headers.map(h => `<th style="text-align:left; border:1px solid #999; padding:6px; background:#eee;">${h}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `<tr>${row.map(cell => `<td style="border:1px solid #999; padding:6px;">${cell}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>`;
  }
  function buildReportPrintHtml(data, { general = false } = {}){
    const summary = data?.summary || {};
    const productos = Array.isArray(data?.productos) ? data.productos : [];
    const rankings = data?.rankings || {};
    const title = general ? 'Reporte general de solicitudes' : `Reporte de oficialia: ${summary.scope_label || '-'}`;
    const topProductosTable = reportHtmlTable(
      ['CLAVE','PRODUCTO','SOLICITUDES','CANT. SOLICITADA','CANT. ENTREGADA'],
      productos.slice(0, 10).map(r => [
        safestr(r.clave || r.CLAVE) || '-',
        safestr(r.descripcion || r.DESCRIPCION) || '-',
        Number(r.solicitudes_count || 0),
        Number(r.cantidad_solicitada || 0),
        Number(r.cantidad_atendida || 0),
      ])
    );
    const productosTable = reportHtmlTable(
      ['CLAVE','PRODUCTO','SOLICITUDES','CANT. SOLICITADA','CANT. ENTREGADA'],
      productos.map(r => [
        safestr(r.clave || r.CLAVE) || '-',
        safestr(r.descripcion || r.DESCRIPCION) || '-',
        Number(r.solicitudes_count || 0),
        Number(r.cantidad_solicitada || 0),
        Number(r.cantidad_atendida || 0),
      ])
    );
    const chartRows = productos.slice(0, 10);
    const maxVal = Math.max(...chartRows.map(r => Number(r.cantidad_solicitada || 0)), 1);
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body{font-family:Arial,Helvetica,sans-serif; color:#111; margin:24px;}
    h1,h2{margin:0 0 10px 0;}
    .meta{margin:12px 0 18px 0;}
    .kpis{display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:14px 0 18px 0;}
    .kpi{border:1px solid #999; padding:10px;}
    .lab{font-size:12px; color:#555;}
    .val{font-size:18px; font-weight:700; margin-top:4px;}
    .chart{display:grid; gap:8px; margin:10px 0 18px 0;}
    .row{display:grid; grid-template-columns:220px 1fr 60px; gap:10px; align-items:center;}
    .label{font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
    .track{height:12px; border:1px solid #bbb; border-radius:999px; overflow:hidden; background:#f3f4f6;}
    .fill{height:100%; background:#7aa2e3;}
    .num{font-size:12px; text-align:right;}
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="meta">Fecha: ${new Date().toLocaleDateString('es-MX')}</div>
  <div class="kpis">
    <div class="kpi"><div class="lab">Solicitudes</div><div class="val">${Number(summary.solicitudes_count || 0)}</div></div>
    <div class="kpi"><div class="lab">Productos solicitados</div><div class="val">${Number(summary.cantidad_solicitada || 0)}</div></div>
    <div class="kpi"><div class="lab">Productos entregados</div><div class="val">${Number(summary.cantidad_atendida || 0)}</div></div>
    <div class="kpi"><div class="lab">Producto mas solicitado</div><div class="val" style="font-size:14px;">${safestr(summary.top_producto_nombre || '-') || '-'}</div></div>
  </div>
  <div class="meta"><b>Oficialia que mas solicita:</b> ${rankings.mas_pide ? formatReportOficialiaLabel(rankings.mas_pide) : '-'}</div>
  <h2>Grafica de productos</h2>
  <div class="chart">
    ${chartRows.map(r => {
      const val = Number(r.cantidad_solicitada || 0);
      const width = Math.max(4, Math.round((val / maxVal) * 100));
      const label = [safestr(r.clave || r.CLAVE), safestr(r.descripcion || r.DESCRIPCION)].filter(Boolean).join(' - ') || '-';
      return `<div class="row">
        <div class="label">${label}</div>
        <div class="track"><div class="fill" style="width:${width}%"></div></div>
        <div class="num">${val}</div>
      </div>`;
    }).join('')}
  </div>
  <h2>Top 10 productos mas solicitados</h2>
  ${topProductosTable}
  <h2>Todos los productos solicitados</h2>
  ${productosTable}
</body>
</html>`;
  }
  function buildExcelHtml(data){
    const summary = data?.summary || {};
    const productos = Array.isArray(data?.productos) ? data.productos : [];
    const solicitudes = Array.isArray(data?.solicitudes) ? data.solicitudes : [];
    return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body>
  <table border="1">
    <tr><th colspan="2">Resumen</th></tr>
    <tr><td>Oficialia</td><td>${safestr(summary.scope_label) || '-'}</td></tr>
    <tr><td>Solicitudes</td><td>${Number(summary.solicitudes_count || 0)}</td></tr>
    <tr><td>Productos solicitados</td><td>${Number(summary.cantidad_solicitada || 0)}</td></tr>
    <tr><td>Productos entregados</td><td>${Number(summary.cantidad_atendida || 0)}</td></tr>
    <tr><td>Producto mas solicitado</td><td>${safestr(summary.top_producto_nombre) || '-'}</td></tr>
  </table>
  ${reportHtmlTable(
    ['USUARIO','OFICIALIA','SOLICITUDES','ULTIMA FECHA','CANT. SOLICITADA','CANT. ENTREGADA'],
    solicitudes.map(r => [
      safestr(r.nombre_usuario) || '-',
      safestr(r.oficialia_nombre) || '-',
      Number(r.solicitudes_count || 0),
      fmtDate(r.ultima_fecha),
      Number(r.cantidad_solicitada || 0),
      Number(r.cantidad_atendida || 0),
    ])
  )}
  ${reportHtmlTable(
    ['CLAVE','PRODUCTO','SOLICITUDES','CANT. SOLICITADA','CANT. ENTREGADA'],
    productos.slice(0, 10).map(r => [
      safestr(r.clave || r.CLAVE) || '-',
      safestr(r.descripcion || r.DESCRIPCION) || '-',
      Number(r.solicitudes_count || 0),
      Number(r.cantidad_solicitada || 0),
      Number(r.cantidad_atendida || 0),
    ])
  )}
  ${reportHtmlTable(
    ['CLAVE','PRODUCTO','SOLICITUDES','CANT. SOLICITADA','CANT. ENTREGADA'],
    productos.map(r => [
      safestr(r.clave || r.CLAVE) || '-',
      safestr(r.descripcion || r.DESCRIPCION) || '-',
      Number(r.solicitudes_count || 0),
      Number(r.cantidad_solicitada || 0),
      Number(r.cantidad_atendida || 0),
    ])
  )}
</body>
</html>`;
  }
  function exportReporteExcel(){
    if (!REP_DATA) { toast('No hay reporte cargado', false); return; }
    const html = buildExcelHtml(REP_DATA);
    const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const scope = safestr(REP_DATA?.summary?.scope_label || 'reporte').replace(/[^\w\-]+/g, '_');
    a.href = url;
    a.download = `reporte_${scope || 'oficialia'}.xls`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  function getDateRange(prefix){
    return {
      inicio: ($(`${prefix}_fecha_inicio`)?.value || '').trim(),
      fin: ($(`${prefix}_fecha_fin`)?.value || '').trim(),
    };
  }
  function setDateRangeParams(params, range){
    if (range?.inicio) params.set('fecha_inicio', range.inicio);
    if (range?.fin) params.set('fecha_fin', range.fin);
  }
  function formatDateRangeLabel(range){
    if (range?.inicio && range?.fin) return `${fmtDate(range.inicio)} - ${fmtDate(range.fin)}`;
    if (range?.inicio) return `Desde ${fmtDate(range.inicio)}`;
    if (range?.fin) return `Hasta ${fmtDate(range.fin)}`;
    return '';
  }
  async function printReporte(oficialiaId = ''){
    const params = new URLSearchParams();
    const range = getDateRange('rep');
    if (oficialiaId) params.set('oficialia_id', oficialiaId);
    setDateRangeParams(params, range);
    const qs = params.toString() ? `?${params}` : '';
    const j = await apiJSON(`/api/reportes/oficialias${qs}`);
    const data = j?.data || {};
    const w = window.open('', '_blank', 'width=1000,height=800');
    if (!w) throw new Error('No se pudo abrir la ventana de impresion');
    w.document.open();
    w.document.write(buildReportPrintHtml(data, { general: !oficialiaId }));
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch {} }, 250);
  }
  async function loadReporteUsuarios(forceDetail = false){
    if (!canViewReportesFront(CURRENT_USER)){ toast('Acceso restringido', false); return; }
    const msg = $('rep_msg');
    const sel = $('rep_oficialia');
    const currentOficialiaId = sel?.value || '';
    const range = getDateRange('rep');
    const rangeLabel = formatDateRangeLabel(range);
    if (msg) msg.textContent = 'Generando...';
    try{
      const params = new URLSearchParams();
      if (currentOficialiaId) params.set('oficialia_id', currentOficialiaId);
      setDateRangeParams(params, range);
      const qs = params.toString() ? `?${params}` : '';
      const j = await apiJSON(`/api/reportes/oficialias${qs}`);
      const data = j?.data || {};
      REP_DATA = data;
      const oficialias = Array.isArray(data.oficialias) ? data.oficialias : [];
      const productos = Array.isArray(data.productos) ? data.productos : [];
      const solicitudes = Array.isArray(data.solicitudes) ? data.solicitudes : [];
      const inconsistencias = Array.isArray(data.inconsistencias) ? data.inconsistencias : [];
      const summary = data.summary || {};
      const rankings = data.rankings || {};

      fillReporteOficialiasSelect(oficialias, String(data.selected_oficialia_id || currentOficialiaId || ''));
      if ($('rep_kpi_sol')) $('rep_kpi_sol').textContent = Number(summary.solicitudes_count || 0);
      if ($('rep_kpi_cant')) $('rep_kpi_cant').textContent = Number(summary.cantidad_solicitada || 0);
      if ($('rep_kpi_ent')) $('rep_kpi_ent').textContent = Number(summary.cantidad_atendida || 0);
      if ($('rep_kpi_top_prod')) $('rep_kpi_top_prod').textContent = safestr(summary.top_producto_nombre || '-') || '-';
      if ($('rep_kpi_top_oficialia')) $('rep_kpi_top_oficialia').textContent = rankings.mas_pide ? formatReportOficialiaLabel(rankings.mas_pide) : '-';
      renderReporteProductos(productos);
      renderReporteOficialias(oficialias);
      renderReporteSolicitudes(solicitudes);
      renderReporteInconsistencias(inconsistencias);
      renderReporteChart(productos);
      if ($('rep_detail_title')) $('rep_detail_title').textContent = `Reporte de: ${summary.scope_label || 'Oficialia'}`;
      if ($('rep_detail_sub')) $('rep_detail_sub').textContent = rangeLabel ? `Periodo: ${rangeLabel}` : 'Todos los registros';
      if (msg) msg.textContent = summary.scope_label ? `Reporte: ${summary.scope_label}${rangeLabel ? ` / ${rangeLabel}` : ''}` : 'Listo';
      if (forceDetail || currentOficialiaId) {
        REP_SELECTED_OFICIALIA = String(currentOficialiaId || '__general__');
        setReporteView('detail');
      } else {
        REP_SELECTED_OFICIALIA = '';
        setReporteView('home');
      }
    }catch(e){
      resetReporteView();
      if (msg) msg.textContent = e.message || e.massage || 'Error';
      if (!handleAuthError(e)) toast(e.message || e.massage || 'Error', false);
    }
  }

  function renderBarChart(boxId, rows, { labelFn, valueFn, empty = 'Sin datos.' } = {}){
    const box = $(boxId); if (!box) return;
    const data = (rows || []).filter(Boolean).slice(0, 10);
    if (!data.length){
      box.innerHTML = `<div class="muted">${empty}</div>`;
      return;
    }
    const maxVal = Math.max(...data.map(r => Number(valueFn(r) || 0)), 1);
    box.innerHTML = `
      <div class="rep-chart">
        ${data.map(r => {
          const val = Number(valueFn(r) || 0);
          const width = Math.max(4, Math.round((val / maxVal) * 100));
          const label = safestr(labelFn(r)) || '-';
          return `<div class="rep-bar-row">
            <div class="rep-bar-label" title="${label}">${label}</div>
            <div class="rep-bar-track"><div class="rep-bar-fill" style="width:${width}%"></div></div>
            <div class="rep-bar-val">${val}</div>
          </div>`;
        }).join('')}
      </div>`;
  }
  function renderPieChart(boxId, rows, { labelFn, valueFn, empty = 'Sin datos.', totalLabel = 'Total', maxItems = 6, groupOthers = true } = {}){
    const box = $(boxId); if (!box) return;
    const palette = ['#6ea8fe','#8dd3c7','#fdb462','#fb8072','#80b1d3','#b3de69','#fccde5','#bc80bd'];
    const source = (rows || [])
      .map(r => ({ raw: r, label: safestr(labelFn(r)) || '-', value: Number(valueFn(r) || 0) }))
      .filter(r => r.value > 0)
      .sort((a, b) => b.value - a.value);
    if (!source.length){
      box.innerHTML = `<div class="muted">${empty}</div>`;
      return;
    }
    const limit = Number.isFinite(Number(maxItems)) && Number(maxItems) > 0 ? Number(maxItems) : source.length;
    const base = source.slice(0, limit);
    const restValue = source.slice(limit).reduce((acc, item) => acc + item.value, 0);
    const data = groupOthers && restValue > 0 ? base.concat([{ label: 'Otros', value: restValue }]) : source;
    const total = data.reduce((acc, item) => acc + item.value, 0);
    let cursor = 0;
    const stops = data.map((item, idx) => {
      const start = cursor;
      const pct = total > 0 ? (item.value / total) * 100 : 0;
      cursor += pct;
      item.color = palette[idx % palette.length];
      item.percent = total > 0 ? Math.round((item.value / total) * 100) : 0;
      return `${item.color} ${start}% ${cursor}%`;
    });
    box.innerHTML = `
      <div class="pie-wrap">
        <div class="pie-chart" style="background:conic-gradient(${stops.join(', ')});">
          <div class="pie-center">
            <div class="big">${total}</div>
            <div class="small">${totalLabel}</div>
          </div>
        </div>
        <div class="pie-legend">
          ${data.map(item => `<div class="pie-legend-item">
            <span class="pie-swatch" style="background:${item.color};"></span>
            <span class="pie-label" title="${item.label}">${item.label}</span>
            <span class="pie-val">${item.value} / ${item.percent}%</span>
          </div>`).join('')}
        </div>
      </div>`;
  }
  function renderCumplimientoChart(rows){
    const box = $('graf_cumplimiento'); if (!box) return;
    const data = (rows || [])
      .map(r => {
        const solicitada = Number(r.cantidad_solicitada || 0);
        const atendida = Number(r.cantidad_atendida || 0);
        const ratio = solicitada > 0 ? Math.round((atendida / solicitada) * 100) : 0;
        return { ...r, ratio };
      })
      .sort((a, b) => Number(b.ratio || 0) - Number(a.ratio || 0) || Number(b.cantidad_solicitada || 0) - Number(a.cantidad_solicitada || 0))
      .slice(0, 10);
    if (!data.length){
      box.innerHTML = '<div class="muted">Sin datos.</div>';
      return;
    }
    box.innerHTML = `
      <div class="rep-chart">
        ${data.map(r => {
          const label = [safestr(r.clave || r.CLAVE), safestr(r.descripcion || r.DESCRIPCION)].filter(Boolean).join(' - ') || '-';
          const width = Math.max(4, Math.min(100, Number(r.ratio || 0)));
          return `<div class="rep-bar-row">
            <div class="rep-bar-label" title="${label}">${label}</div>
            <div class="rep-bar-track"><div class="rep-bar-fill" style="width:${width}%"></div></div>
            <div class="rep-bar-val">${Number(r.ratio || 0)}%</div>
          </div>`;
        }).join('')}
      </div>`;
  }
  function renderAllProductosPie(rows){
    const box = $('graf_all_productos'); if (!box) return;
    const data = Array.isArray(rows) ? rows : [];
    if (!data.length){
      box.innerHTML = '<div class="muted">Sin datos.</div>';
      return;
    }
    const pieData = data
      .map(r => ({
        clave: safestr(r.clave || r.CLAVE) || '-',
        descripcion: safestr(r.descripcion || r.DESCRIPCION) || '-',
        cantidad_solicitada: Number(r.cantidad_solicitada || 0) || 0,
      }))
      .filter(r => r.cantidad_solicitada > 0)
      .sort((a, b) => b.cantidad_solicitada - a.cantidad_solicitada);
    const total = pieData.reduce((acc, r) => acc + r.cantidad_solicitada, 0);
    const palette = ['#6ea8fe','#8dd3c7','#fdb462','#fb8072','#80b1d3','#b3de69','#fccde5','#bc80bd','#ffcc80','#90caf9','#a5d6a7','#ce93d8'];
    let cursor = 0;
    const decorated = pieData.map((item, idx) => {
      const pct = total > 0 ? (item.cantidad_solicitada / total) * 100 : 0;
      const start = cursor;
      cursor += pct;
      return {
        ...item,
        color: palette[idx % palette.length],
        percent: total > 0 ? ((item.cantidad_solicitada / total) * 100).toFixed(1) : '0.0',
        stop: `${palette[idx % palette.length]} ${start}% ${cursor}%`
      };
    });
    box.innerHTML = `
      <div class="pie-wrap single">
        <div class="pie-chart" style="background:conic-gradient(${decorated.map(r => r.stop).join(', ')});">
          <div class="pie-center">
            <div class="big">${total}</div>
            <div class="small">Todos</div>
          </div>
        </div>
      </div>
      <div class="pie-scroll table-scroll">
        <table>
          <thead>
            <tr>
              <th>COLOR</th>
              <th>CLAVE</th>
              <th>PRODUCTO</th>
              <th>SOLICITADA</th>
              <th>%</th>
            </tr>
          </thead>
          <tbody>
            ${decorated.map(r => `<tr>
              <td><span class="pie-swatch" style="display:inline-block;background:${r.color};"></span></td>
              <td>${r.clave}</td>
              <td>${r.descripcion}</td>
              <td>${r.cantidad_solicitada}</td>
              <td>${r.percent}%</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }
  function resetGraficasView(){
    GRAF_DATA = null;
    if ($('graf_msg')) $('graf_msg').textContent = '';
    if ($('graf_kpi_sol')) $('graf_kpi_sol').textContent = '-';
    if ($('graf_kpi_cant')) $('graf_kpi_cant').textContent = '-';
    if ($('graf_kpi_ent')) $('graf_kpi_ent').textContent = '-';
    if ($('graf_kpi_cump')) $('graf_kpi_cump').textContent = '-';
    ['graf_top_solicitados','graf_top_entregados','graf_top_grupo','graf_cumplimiento','graf_all_productos'].forEach(id => {
      if ($(id)) $(id).innerHTML = '<div class="muted">Sin datos.</div>';
    });
  }
  async function loadGraficas(){
    if (!canViewReportesFront(CURRENT_USER)){ toast('Acceso restringido', false); return; }
    const msg = $('graf_msg');
    const currentOficialiaId = $('graf_oficialia')?.value || '';
    const range = getDateRange('graf');
    const rangeLabel = formatDateRangeLabel(range);
    if (msg) msg.textContent = 'Generando...';
    try{
      const params = new URLSearchParams();
      if (currentOficialiaId) params.set('oficialia_id', currentOficialiaId);
      setDateRangeParams(params, range);
      const qs = params.toString() ? `?${params}` : '';
      const j = await apiJSON(`/api/reportes/oficialias${qs}`);
      const data = j?.data || {};
      GRAF_DATA = data;
      const oficialias = Array.isArray(data.oficialias) ? data.oficialias : [];
      const productos = Array.isArray(data.productos) ? data.productos : [];
      const solicitudes = Array.isArray(data.solicitudes) ? data.solicitudes : [];
      const summary = data.summary || {};
      fillGraficasOficialiasSelect(oficialias, String(data.selected_oficialia_id || currentOficialiaId || ''));
      if ($('graf_kpi_sol')) $('graf_kpi_sol').textContent = Number(summary.solicitudes_count || 0);
      if ($('graf_kpi_cant')) $('graf_kpi_cant').textContent = Number(summary.cantidad_solicitada || 0);
      if ($('graf_kpi_ent')) $('graf_kpi_ent').textContent = Number(summary.cantidad_atendida || 0);
      const ratio = Number(summary.cantidad_solicitada || 0) > 0
        ? Math.round((Number(summary.cantidad_atendida || 0) / Number(summary.cantidad_solicitada || 0)) * 100)
        : 0;
      if ($('graf_kpi_cump')) $('graf_kpi_cump').textContent = `${ratio}%`;
      renderPieChart('graf_top_solicitados', productos, {
        labelFn: r => [r.clave || r.CLAVE, r.descripcion || r.DESCRIPCION].filter(Boolean).join(' - '),
        valueFn: r => r.cantidad_solicitada,
        totalLabel: 'Solicitado',
      });
      renderPieChart('graf_top_entregados', productos, {
        labelFn: r => [r.clave || r.CLAVE, r.descripcion || r.DESCRIPCION].filter(Boolean).join(' - '),
        valueFn: r => r.cantidad_atendida,
        totalLabel: 'Entregado',
      });
      const groupRows = currentOficialiaId ? solicitudes : oficialias;
      renderPieChart('graf_top_grupo', groupRows, {
        labelFn: r => currentOficialiaId ? (r.nombre_usuario || '-') : formatReportOficialiaLabel(r),
        valueFn: r => r.cantidad_solicitada,
        empty: 'Sin datos.',
        totalLabel: currentOficialiaId ? 'Usuario' : 'Oficialia',
      });
      renderCumplimientoChart(productos);
      renderAllProductosPie(productos);
      if (msg) msg.textContent = summary.scope_label ? `Graficas: ${summary.scope_label}${rangeLabel ? ` / ${rangeLabel}` : ''}` : 'Listo';
    }catch(e){
      resetGraficasView();
      if (msg) msg.textContent = e.message || e.massage || 'Error';
      if (!handleAuthError(e)) toast(e.message || e.massage || 'Error', false);
    }
  }

  const UNIDAD_BY_CLAVE    = new Map();
  const CATEGORIA_BY_CLAVE = new Map();
  let ALM_LAST_ROWS = [];
  let ALM_UNIDAD_IS_SELECT = false;
  const PRODUCTO_CACHE     = new Map(); 
  const ALMACEN_CACHE      = new Map(); 
  const CATEGORIA_NOMBRE_BY_ID = new Map(); 
function extractClave(r) {
  const raw =
    r?.CLAVE ?? r?.clave ??
    r?.PRODUCTO_CLAVE ?? r?.producto_clave ??
    r?.CLAVE_PRODUCTO ?? r?.clave_producto ?? '';
  return norm(safestr(raw));
}
  function extractProdId(r){
    return r.producto_id ?? r.PRODUCTO_ID ?? r.id_producto ?? r.ID_PRODUCTO ?? null;
  }
  function extractAlmId(r){
    return r.almacen_id ?? r.ALMACEN_ID ?? r.id_almacen ?? r.ID_ALMACEN ?? null;
  }
  function nombreCategoriaFromRow(r){
    const cNom = r.CATEGORIA_NOMBRE ?? r.categoria_nombre;
    if (safestr(cNom)) return safestr(cNom);
    const cVal = r.categoria ?? r.CATEGORIA ?? r.categoria_id ?? r.CATEGORIA_ID;
    if (!safestr(cVal)) return '';
    if (!isNum(cVal)) return safestr(cVal);
    const byId = CATEGORIA_NOMBRE_BY_ID.get(Number(cVal));
    return safestr(byId);
  }

  async function prefetchUnidadCategoriaByClave(claves){
    const uniq = [...new Set((claves||[]).map(k=>norm(k)).filter(Boolean))];
    if (!uniq.length) return;
    try{
      if (!(await hasRoute('POST','/api/lookup/unidad-categoria'))) return;
      const j = await apiJSON('/api/lookup/unidad-categoria', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ claves: uniq })
      });
      const map = j?.data || {};
      for (const k of Object.keys(map)){
        const u = map[k]?.unidad || map[k]?.UNIDAD || '';
        const c = map[k]?.categoria || map[k]?.CATEGORIA || map[k]?.categoria_nombre || '';
        if (safestr(u)) UNIDAD_BY_CLAVE.set(norm(k), String(u));
        if (safestr(c)) CATEGORIA_BY_CLAVE.set(norm(k), String(c));
      }
    }catch(e){ console.warn('lookup masivo por clave fallo:', e.message || e.massage || e); }
  }

  async function getAlmacenById(id){
    if (!id) return null;
    if (ALMACEN_CACHE.has(id)) return ALMACEN_CACHE.get(id);
    if (!(await hasRoute('GET','/api/almacen/:id'))) return null;
    try{
      const j = await apiJSON(`/api/almacen/${id}`); const row = j?.data || j;
      ALMACEN_CACHE.set(id, row||null); return row||null;
    }catch{ return null; }
  }
  async function getProductoById(id){
    if (!id) return null;
    if (PRODUCTO_CACHE.has(id)) return PRODUCTO_CACHE.get(id);
    if (await hasRoute('GET','/api/productos/:id')){
      try{
        const j = await apiJSON(`/api/productos/${id}`); const row = j?.data || j;
        PRODUCTO_CACHE.set(id, row||null); return row||null;
      }catch{}
    }
    if (await hasRoute('GET','/api/productos')){
      try{
        const jq = await apiJSON(`/api/productos?q=${encodeURIComponent(id)}&limit=1&page=1`);
        const row = (jq.data||[])[0]; PRODUCTO_CACHE.set(id, row||null); return row||null;
      }catch{}
    }
    return null;
  }
  async function getCategoriaNombreById(id){
    if (!isNum(id)) return '';
    const nId = Number(id);
    if (CATEGORIA_NOMBRE_BY_ID.has(nId)) return CATEGORIA_NOMBRE_BY_ID.get(nId) || '';
    if (await hasRoute('GET','/api/categorias')){
      try{
        const j = await apiJSON('/api/categorias'); const arr = j?.data||[];
        arr.forEach(c=>{ if (isNum(c.id)) CATEGORIA_NOMBRE_BY_ID.set(Number(c.id), safestr(c.nombre)); });
        return CATEGORIA_NOMBRE_BY_ID.get(nId) || '';
      }catch{}
    }
    if (await hasRoute('GET','/api/categorias/:id')){
      try{
        const j2 = await apiJSON(`/api/categorias/${nId}`); const nm = safestr(j2?.data?.nombre||j2?.nombre);
        if (nm) CATEGORIA_NOMBRE_BY_ID.set(nId, nm);
        return nm || '';
      }catch{}
    }
    return '';
  }

  async function ensureCategoriaNames(rows){
    if (!Array.isArray(rows) || !rows.length) return;
    const ids = [...new Set(
      rows.map(r => {
        const hasName = safestr(r?.CATEGORIA_NOMBRE) || safestr(r?.categoria_nombre);
        if (hasName) return null;
        return r?.CATEGORIA ?? r?.categoria ?? r?.categoria_id ?? r?.CATEGORIA_ID ?? null;
      }).filter(isNum).map(Number)
    )].filter(id => id && !CATEGORIA_NOMBRE_BY_ID.has(id));
    for (const id of ids){
      await getCategoriaNombreById(id);
    }
  }

  async function ensureFromClave(clave){
    if (!clave) return {};
    const k = norm(clave);
    let unidad = UNIDAD_BY_CLAVE.get(k) || '';
    let categoria = CATEGORIA_BY_CLAVE.get(k) || '';

    if ((!unidad || !categoria) && await hasRoute('GET','/api/almacen')){
      try{
        const j = await apiJSON(`/api/almacen?clave=${encodeURIComponent(k)}&limit=1&page=1`);
        const row = (j.data||[])[0];
        if (row){
          const u = row.UNIDAD ?? row.unidad ?? '';
          const c = row.CATEGORIA_NOMBRE ?? row.CATEGORIA ?? row.categoria ?? '';
          if (safestr(u)){ unidad = String(u); UNIDAD_BY_CLAVE.set(k, unidad); }
          if (safestr(c)){ categoria = String(c); CATEGORIA_BY_CLAVE.set(k, categoria); }
        }
      }catch{}
    }
    if ((!unidad || !categoria) && await hasRoute('GET','/api/productos')){
      try{
        const j = await apiJSON(`/api/productos?q=${encodeURIComponent(k)}&limit=5&page=1`);
        const rows = j.data||[];
        const rec = rows.find(r => norm(r.CLAVE||'')===k) || rows[0];
        if (rec){
          const u = rec.UNIDAD ?? rec.unidad ?? rec.unidad_medida ?? rec.unidad_siglas ?? '';
          const c = rec.CATEGORIA_NOMBRE ?? rec.CATEGORIA ?? rec.categoria ?? rec.categoria_nombre ?? '';
          if (safestr(u)){ unidad = String(u); UNIDAD_BY_CLAVE.set(k, unidad); }
          if (safestr(c)){ categoria = String(c); CATEGORIA_BY_CLAVE.set(k, categoria); }
        }
      }catch{}
    }
    return { unidad, categoria };
  }

  async function enrichDetalleRows(rows){
    if (!Array.isArray(rows) || !rows.length) return;

    const claves = rows.map(extractClave).filter(Boolean);
    await prefetchUnidadCategoriaByClave(claves);

    for (const r of rows){
      const clave = extractClave(r);
      let unidad = safestr(r.unidad ?? r.UNIDAD);
      let categoria = safestr(r.categoria ?? r.CATEGORIA ?? r.categoria_nombre ?? r.CATEGORIA_NOMBRE);
      let categoria_id = r.categoria_id ?? r.CATEGORIA_ID;

      if ((!unidad || !categoria) && clave){
        const byClave = await ensureFromClave(clave);
        if (!unidad) unidad = byClave.unidad || '';
        if (!categoria) categoria = byClave.categoria || '';
      }

      if ((!unidad || !categoria)){
        const almId = extractAlmId(r);
        if (almId){
          const alm = await getAlmacenById(almId);
          if (alm){
            if (!unidad) unidad = safestr(alm.UNIDAD ?? alm.unidad);
            if (!categoria) categoria = safestr(alm.CATEGORIA_NOMBRE ?? alm.CATEGORIA ?? alm.categoria);
            if (clave && unidad) UNIDAD_BY_CLAVE.set(clave, unidad);
            if (clave && categoria) CATEGORIA_BY_CLAVE.set(clave, categoria);
          }
        }
      }

      if ((!unidad || !categoria)){
        const prodId = extractProdId(r);
        if (prodId){
          const prod = await getProductoById(prodId);
          if (prod){
            if (!unidad) unidad = safestr(prod.UNIDAD ?? prod.unidad ?? prod.unidad_medida ?? prod.unidad_siglas);
            if (!categoria) categoria = safestr(prod.CATEGORIA_NOMBRE ?? prod.CATEGORIA ?? prod.categoria ?? prod.categoria_nombre);
            if (!categoria_id) categoria_id = prod.categoria_id ?? prod.CATEGORIA_ID;
            if (clave && unidad) UNIDAD_BY_CLAVE.set(clave, unidad);
            if (clave && categoria) CATEGORIA_BY_CLAVE.set(clave, categoria);
          }
        }
      }

      if (!safestr(categoria) && isNum(categoria_id)){
        const nombre = await getCategoriaNombreById(categoria_id);
        if (nombre) categoria = nombre;
      }

      if (!safestr(r.unidad) && unidad) r.unidad = unidad;
      if (!safestr(r.categoria) && categoria) { r.categoria = categoria; r.CATEGORIA_NOMBRE = categoria; }
    }
  }

  let SOL_ID = null;
  let SOL_FLOW_TAB = 'crear';
  let SOL_READY_FOR_PDF = false;
  let SOLICITUDES_TAB = 'lista';
  function buildDetalleTableHtml(rows, saveButtonId){
    return `
      <table>
        <thead>
          <tr>
            <th>CLAVE</th>
            <th>Descripcion</th>
            <th>Categoria</th>
            <th>Unidad</th>
            <th>Solicitada</th>
            <th>Atendida</th>
            <th>Observaciones</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r=>{
            const detId = r.detalle_id ?? r.DETALLE_ID ?? r.id ?? r.ID ?? '';
            const clave = extractClave(r);
            const desc  = r.DESCRIPCION ?? r.descripcion ?? r.producto ?? '';
            const cat   = nombreCategoriaFromRow(r) || safestr(r.categoria) || safestr(r.CATEGORIA) || '';
            const uni   = safestr(r.unidad ?? r.UNIDAD);
            const cant  = Number(r.cantidad ?? r.CANTIDAD ?? 0) || 0;
            const atend = (r.atendida ?? r.ATENDIDA ?? '');
            const obs   = (r.observaciones ?? r.OBSERVACIONES ?? '');
            return `
              <tr data-det="${detId}">
                <td>${clave}</td>
                <td>${desc}</td>
                <td>${cat}</td>
                <td>${uni}</td>
                <td>${cant}</td>
                <td><input class="mini-in" type="number" min="0" max="${cant}" value="${atend}"></td>
                <td><input class="mini-in" type="text" value="${obs}"></td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
      <div class="actions" style="margin-top:.75rem">
        <button class="primary" id="${saveButtonId}">Guardar todo</button>
      </div>
    `;
  }
  function buildConsultaDetalleHtml(rows){
    if (!rows?.length) return '<div class="muted">Sin renglones.</div>';
    return `
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>CLAVE</th>
              <th>Descripcion</th>
              <th>Categoria</th>
              <th>Unidad</th>
              <th>Solicitada</th>
              <th>Atendida</th>
              <th>Observaciones</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r=>{
              const clave = extractClave(r) || '-';
              const desc  = r.DESCRIPCION ?? r.descripcion ?? r.producto ?? '-';
              const cat   = nombreCategoriaFromRow(r) || safestr(r.categoria) || safestr(r.CATEGORIA) || '-';
              const uni   = safestr(r.unidad ?? r.UNIDAD) || '-';
              const cant  = Number(r.cantidad ?? r.CANTIDAD ?? 0) || 0;
              const atend = Number(r.atendida ?? r.ATENDIDA ?? 0) || 0;
              const obs   = safestr(r.observaciones ?? r.OBSERVACIONES) || '-';
              return `<tr>
                <td>${clave}</td>
                <td>${desc}</td>
                <td>${cat}</td>
                <td>${uni}</td>
                <td>${cant}</td>
                <td>${atend}</td>
                <td>${obs}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }
  function renderDetallePreviewFromRows(){
    const box = $('det_preview');
    if (!box) return;
    if (!DET_ROWS.length){
      box.innerHTML = 'Sin renglones.';
      return;
    }
    box.innerHTML = DET_ROWS.map(r => {
      const clave = extractClave(r);
      const desc = r.DESCRIPCION ?? r.descripcion ?? r.producto ?? 'Item';
      const cant = Number(r.cantidad ?? r.CANTIDAD ?? 0) || 0;
      return `<div>* ${clave ? `${clave} - ` : ''}${desc} x${cant}</div>`;
    }).join('');
  }
  function setSolicitudesTab(tab){
    const hasConsulta = Boolean($('btn-solicitudes-tab-consulta') && !$('btn-solicitudes-tab-consulta').disabled);
    SOLICITUDES_TAB = (tab === 'consulta' && hasConsulta) ? 'consulta' : 'lista';
    $('btn-solicitudes-tab-lista')?.classList.toggle('active', SOLICITUDES_TAB === 'lista');
    $('btn-solicitudes-tab-consulta')?.classList.toggle('active', SOLICITUDES_TAB === 'consulta');
    $('solicitudes-pane-lista')?.classList.toggle('hidden', SOLICITUDES_TAB !== 'lista');
    $('solicitudes-pane-consulta')?.classList.toggle('hidden', SOLICITUDES_TAB !== 'consulta');
    updateSolicitudActionsVisibility(SOLICITUDES_TAB === 'consulta' ? CONSULTA_STATUS : '');
  }
  function renderFlowDetalleView(filterText=''){
    const box = $('sol_detalle_box'), badge = $('sol_detalle_badge'), msg = $('sol_msg_detalle');
    if (!box) return;
    const txt = (filterText||'').toLowerCase();
    const rows = !txt ? DET_ROWS : DET_ROWS.filter(r =>
      Object.values(r).some(v => String(v??'').toLowerCase().includes(txt))
    );
    if (!rows.length){
      box.innerHTML = '<div class="muted">Sin renglones.</div>';
      if (badge) badge.textContent = DET_SOL_ID ? 'Solicitud activa * 0 renglones' : 'Sin solicitud';
      if (msg) msg.textContent = '';
      return;
    }
    box.innerHTML = buildDetalleTableHtml(rows, 'btn-sol-save-detalle');
    if (badge) badge.textContent = DET_SOL_ID ? `Solicitud activa * ${rows.length} renglones` : 'Sin solicitud';
    if (msg) msg.textContent = '';
  }
  async function refreshActiveSolicitudData(){
    if (!SOL_ID) return;
    const resDetalle = await apiJSON(`/api/solicitudes/${SOL_ID}/detalle`);
    const detalleData = Array.isArray(resDetalle?.data) ? resDetalle.data : (Array.isArray(resDetalle) ? resDetalle : []);
    DET_ROWS = detalleData;
    DET_SOL_ID = SOL_ID;
    await enrichDetalleRows(DET_ROWS);
    renderDetallePreviewFromRows();
    renderFlowDetalleView();
    updateSolBadge();
  }
  function setSolicitudTab(tab){
    const canAgregar = Boolean(SOL_ID);
    const canRevision = DET_ROWS.length > 0;
    const canPdf = SOL_READY_FOR_PDF;
    if (tab === 'agregar' && !canAgregar){
      toast('Crea primero la solicitud');
      return;
    }
    if (tab === 'revision' && !canRevision){
      toast('Agrega por lo menos un producto');
      return;
    }
    if (tab === 'pdf' && !canPdf){
      toast('Guarda o agrega detalle antes de descargar el PDF');
      return;
    }
    SOL_FLOW_TAB = ['agregar','revision','pdf'].includes(tab) ? tab : 'crear';
    $('btn-sol-tab-crear')?.classList.toggle('active', SOL_FLOW_TAB === 'crear');
    $('btn-sol-tab-agregar')?.classList.toggle('active', SOL_FLOW_TAB === 'agregar');
    $('btn-sol-tab-revision')?.classList.toggle('active', SOL_FLOW_TAB === 'revision');
    $('btn-sol-tab-pdf')?.classList.toggle('active', SOL_FLOW_TAB === 'pdf');
    $('sol-pane-crear')?.classList.toggle('hidden', SOL_FLOW_TAB !== 'crear');
    $('sol-pane-agregar')?.classList.toggle('hidden', SOL_FLOW_TAB !== 'agregar');
    $('sol-pane-revision')?.classList.toggle('hidden', SOL_FLOW_TAB !== 'revision');
    $('sol-pane-pdf')?.classList.toggle('hidden', SOL_FLOW_TAB !== 'pdf');
    if (SOL_FLOW_TAB === 'revision') renderFlowDetalleView();
  }
  function updateSolBadge(){
    $('sol_actual').textContent = SOL_ID ? 'Solicitud activa' : 'Sin solicitud';
    const canDetail = Boolean(SOL_ID);
    const canRevision = DET_ROWS.length > 0;
    const canPdf = SOL_READY_FOR_PDF;
    const flowText = $('sol_flow_text');
    const flowId = $('sol_flow_id');
    const tabAgregar = $('btn-sol-tab-agregar');
    const tabRevision = $('btn-sol-tab-revision');
    const tabPdf = $('btn-sol-tab-pdf');
    if (tabAgregar) tabAgregar.disabled = !canDetail;
    if (tabRevision) tabRevision.disabled = !canRevision;
    if (tabPdf) tabPdf.disabled = !canPdf;
    if (flowId) flowId.textContent = canDetail ? 'Solicitud activa' : 'Sin solicitud';
    if (flowText) {
      flowText.textContent = '';
    }
    if (!canDetail && SOL_FLOW_TAB !== 'crear') setSolicitudTab('crear');
    if (canDetail && !canRevision && ['revision','pdf'].includes(SOL_FLOW_TAB)) setSolicitudTab('agregar');
    if (canRevision && !canPdf && SOL_FLOW_TAB === 'pdf') setSolicitudTab('revision');
  }
  function resetSolicitudFlow(){
    SOL_ID = null;
    DET_SOL_ID = null;
    DET_ROWS = [];
    SOL_READY_FOR_PDF = false;

    if ($('tipo_solicitud')) $('tipo_solicitud').value = 'CONSUMIBLES';
    if ($('obs_sol')) $('obs_sol').value = '';
    if ($('busca_prod')) $('busca_prod').value = '';
    if ($('prod_sel')) $('prod_sel').innerHTML = `<option value="">- selecciona producto -</option>`;
    if ($('det_cant')) $('det_cant').value = '1';
    if ($('det_obs')) $('det_obs').value = '';
    if ($('sol_edit_id')) $('sol_edit_id').value = '';
    if ($('list_oficialia') && !canManageSolicitudesFront(CURRENT_USER)) $('list_oficialia').value = String(CURRENT_USER?.id_oficialia || '');
    if ($('msg_sol')) $('msg_sol').textContent = '';
    if ($('msg_det')) $('msg_det').textContent = '';
    if ($('msg_lookup')) $('msg_lookup').textContent = '';
    if ($('msg_edit')) $('msg_edit').textContent = '';
    if ($('det_preview')) $('det_preview').innerHTML = 'Sin renglones.';
    if ($('sol_resumen')) $('sol_resumen').innerHTML = '';
    if ($('sol_consulta_detalle')) $('sol_consulta_detalle').innerHTML = '<div class="muted">Sin renglones.</div>';
    if ($('sol_detalle_box')) $('sol_detalle_box').innerHTML = '<div class="muted">Sin renglones.</div>';
    if ($('sol_detalle_badge')) $('sol_detalle_badge').textContent = 'Sin solicitud';
    if ($('sol_msg_detalle')) $('sol_msg_detalle').textContent = '';
    if ($('btn-list-consultar')) $('btn-list-consultar').disabled = true;
    if ($('btn-solicitudes-tab-consulta')) $('btn-solicitudes-tab-consulta').disabled = true;

    updateSolBadge();
    setSolicitudTab('crear');
    setSolicitudesTab('lista');
    showView('captura');
    applyPermassions();
  }

  async function crearSolicitud(){
    const tipo = $('tipo_solicitud').value || 'CONSUMIBLES';
    const obs  = $('obs_sol').value || null;
    const uidIn  = $('sol_user_id');
    const uidVal = (uidIn && uidIn.value) ? Number(uidIn.value) : (CURRENT_USER?.id ?? null);
    const msg = $('msg_sol');
    if (!uidVal){ toast('Usuario solicitante requerido'); msg.textContent=''; return; }
    msg.textContent = 'Creando...';
    try{
      const j = await apiJSON('/api/solicitudes', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ usuario_id: Number(uidVal), tipo_solicitud: tipo, observaciones: obs })
      });
      SOL_ID = j.solicitud_id;
      DET_SOL_ID = SOL_ID;
      DET_ROWS = [];
      SOL_READY_FOR_PDF = false;
      updateSolBadge();
      if ($('sol_edit_id')) $('sol_edit_id').value = String(SOL_ID);
      msg.textContent = 'Solicitud creada'; toast('Solicitud creada', true);
      renderDetallePreviewFromRows();
      renderFlowDetalleView();
      setSolicitudTab('agregar');
    }catch(e){
      msg.textContent = e.message || e.massage || 'Error'; if (!handleAuthError(e)) toast(e.message || e.massage || 'Error');
    }
  }

  async function buscarProductos(){
    const qInput = $('busca_prod');
    const q = qInput.value.trim();
    const msg = $('msg_det'); const sel = $('prod_sel');
    msg.textContent = 'Buscando...';
    sel.innerHTML = `<option value="">- selecciona producto -</option>`;
    try{
      const ja = await apiJSON(`/api/almacen?q=${encodeURIComponent(q)}&page=1&limit=500`);
      (ja.data||[]).forEach(r=>{
        const stock = r.STOCK ?? 0;
        const txt = `[ALM] ${r.CLAVE} - ${r.DESCRIPCION} [${r.CATEGORIA_NOMBRE ?? r.CATEGORIA ?? ''}] (stock:${stock})`;
        const opt = document.createElement('option');
        opt.value = r.CLAVE; opt.textContent = txt;
        opt.dataset.source = 'almacen'; opt.dataset.clave = r.CLAVE || '';
        sel.appendChild(opt);
      });

      if (!(ja.data||[]).length){
        try{
          const jp = await apiJSON(`/api/productos?q=${encodeURIComponent(q)}&page=1&limit=500`);
          (jp.data||[]).forEach(p=>{
            const txt = `[PROD] ${p.CLAVE} - ${p.DESCRIPCION} ${p.unidad?('('+p.unidad+')'):''}`;
            const opt = document.createElement('option');
            opt.value = p.producto_id; opt.textContent = txt;
            opt.dataset.source = 'producto';
            opt.dataset.prodId = p.producto_id || '';
            opt.dataset.clave = p.CLAVE || '';
            sel.appendChild(opt);
          });
        }catch{}
      }

      const total = sel.options.length - 1;
      sel.selectedIndex = 0;
      msg.textContent = `${total} resultado${total===1?'':'s'}`;
    }catch(e){ msg.textContent = e.message || e.massage || 'Error'; if (!handleAuthError(e)) toast(e.message || e.massage || 'Error'); }
  }

  async function agregarDetalle(){
    if (!SOL_ID){ toast('Crea primero la solicitud'); return; }
    const sel = $('prod_sel');
    const opt = sel.selectedOptions[0];
    const cant = Number($('det_cant').value||'1');
    const obs  = $('det_obs').value || null;
    const msg  = $('msg_det');

    if (!opt || !opt.value){ toast('Selecciona un producto/clave'); return; }
    if (!(cant>0)){ toast('Cantidad invalida'); return; }
    msg.textContent = 'Agregando...';

    const source = opt.dataset.source || 'almacen';
    try{
      if (source === 'producto' && opt.dataset.prodId){
        await apiJSON(`/api/solicitudes/${SOL_ID}/detalles`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ producto_id: opt.dataset.prodId, cantidad: cant, observaciones: obs })
        });
        msg.textContent = 'Detalle agregado';
      } else {
        const clave = opt.dataset.clave || opt.value;
        await apiJSON(`/api/solicitudes/${SOL_ID}/detalles/by-clave`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ clave, cantidad: cant, observaciones: obs })
        });
        msg.textContent = 'Detalle agregado';
      }
      SOL_READY_FOR_PDF = false;
      await refreshActiveSolicitudData();
      $('busca_prod').value = '';
      $('det_cant').value = '1';
      $('det_obs').value = '';
      $('prod_sel').innerHTML = `<option value="">- selecciona producto -</option>`;
      toast('Detalle agregado', true);
    }catch(e){ msg.textContent = e.message || e.massage || 'Error'; if (!handleAuthError(e)) toast(e.message || e.massage || 'Error'); }
  }

  let SOL_LIST_MODE = 'activas';

  function setSolicitudListMode(mode){
    SOL_LIST_MODE = mode === 'canceladas' ? 'canceladas' : 'activas';
    $('btn-list-mode-activas')?.classList.toggle('active', SOL_LIST_MODE === 'activas');
    $('btn-list-mode-canceladas')?.classList.toggle('active', SOL_LIST_MODE === 'canceladas');
  }

  function renderSolicitudesListado(rows){
    if (!rows?.length) return '<div class="muted">Sin resultados.</div>';
    const head = `
      <thead><tr>
        <th>ID</th><th>Fecha</th><th>Usuario</th><th>Tipo</th><th>Oficialia</th><th>Estatus</th>
      </tr></thead>`;
    const body = rows.map(r=>{
      const id   = r.id ?? r.ID ?? r.solicitud_id ?? r.SOLICITUD_ID ?? '-';
      const fraw = r.fecha_solicitud ?? r.FECHA ?? r.fecha;
      const fec  = fmtDate(fraw);
      const usr  = pickUsuario(r);
      const tipo = r.tipo_solicitud ?? r.TIPO ?? '-';
      const ofi  = r.oficialia_nombre ?? r.OFICIALIA_NOMBRE ?? r.id_oficialia ?? r.ID_OFICIALIA ?? '-';
      const status = r.status ?? r.STATUS ?? '-';
      return `<tr data-sol-id="${id}"><td>${id}</td><td>${fec}</td><td>${usr}</td><td>${tipo}</td><td>${ofi}</td><td>${status}</td></tr>`;
    }).join('');
    return `<div class="table-scroll"><table>${head}<tbody>${body}</tbody></table></div>`;
  }

  let DET_ROWS = []; let DET_SOL_ID = null; let LIST_SELECTED_ID = null; let CONSULTA_STATUS = '';

  function updateSolicitudActionsVisibility(status = ''){
    const card = $('sol_acciones_card');
    if (!card) return;
    card.classList.toggle('hidden', norm(status) === 'CANCELADA');
  }

  function setListadoSelectedId(id){
    LIST_SELECTED_ID = id ? String(id) : null;
    document.querySelectorAll('#listado_box tbody tr').forEach(tr => {
      tr.classList.toggle('is-selected', LIST_SELECTED_ID === String(tr.dataset.solId || ''));
    });
    if ($('btn-list-consultar')) $('btn-list-consultar').disabled = !LIST_SELECTED_ID;
  }

  async function consultarSolicitudById(idParam = null){
    const id  = String(idParam || LIST_SELECTED_ID || '').trim();
    const msg = $('msg_lookup');
    if (!id){ toast('Selecciona una solicitud del listado'); return; }
    msg.textContent = 'Consultando...';
    try{
      const resResumen = await apiJSON(`/api/solicitudes/${id}`);
      const d = resResumen.data || resResumen || {};

      const idSol = d.id ?? d.ID ?? d.solicitud_id ?? d.SOLICITUD_ID ?? id;
      const ofiNom = d.oficialia_nombre || d.usuario?.oficialia_nombre || null;
      const oficialia = ofiNom || (d.id_oficialia ?? d.ID_OFICIALIA ?? d.oficialia ?? d.OFICIALIA ?? '-');
      const fechaFmt = fmtDate(d.fecha_solicitud ?? d.FECHA ?? d.fecha ?? d.fecha_creacion ?? d.created_at ?? null);
      const userPrimary = pickUsuario(d);
      const userNested = pickUsuario(d.usuario || {});
      const usuario = safestr(
        d.solicitante_display ||
        d.SOLICITANTE_DISPLAY ||
        d.usuario?.nombre_completo ||
        (userPrimary !== '-' ? userPrimary : '') ||
        (userNested !== '-' ? userNested : '') ||
        d.nombre_usuario || d.NOMBRE_USUARIO ||
        d.usuario_nombre || d.usuarioNombre || d.USUARIO ||
        d.solicitante || d.SOLICITANTE ||
        d.username || d.USERNAME ||
        d.usuario?.username || d.usuario?.USERNAME ||
        CURRENT_USER?.username ||
        '-'
      );
      const observ  = d.observaciones || d.OBSERVACIONES || '-';
      const tipo = d.tipo_solicitud || d.TIPO || '-';
      const status = d.status || d.STATUS || '-';

      const resDetalle = await apiJSON(`/api/solicitudes/${id}/detalle`);
      const detalleData = Array.isArray(resDetalle?.data) ? resDetalle.data : (Array.isArray(resDetalle) ? resDetalle : []);
      DET_ROWS = detalleData;
      DET_SOL_ID = idSol;
      CONSULTA_STATUS = status;
      SOL_ID = idSol;
      SOL_READY_FOR_PDF = false;
      setListadoSelectedId(idSol);
      updateSolBadge();
      updateSolicitudActionsVisibility(status);
      if ($('sol_edit_id')) $('sol_edit_id').value = String(idSol);

      await enrichDetalleRows(DET_ROWS);
      renderDetallePreviewFromRows();
      renderFlowDetalleView();

      let productoLinea = '-';
      if (DET_ROWS.length){
        const r0 = DET_ROWS[0];
        const clave = extractClave(r0);
        const desc  = r0.DESCRIPCION ?? r0.descripcion ?? r0.producto ?? '';
        const principal = `${clave ? (clave + ' - ') : ''}${desc || 'Producto'}`;
        const extra = DET_ROWS.length > 1 ? `  (+${DET_ROWS.length - 1} mas)` : '';
        productoLinea = principal + extra;
      }
      const totalQty = DET_ROWS.reduce((acc, r) => acc + (Number(r.cantidad ?? r.CANTIDAD ?? 0) || 0), 0);
      const totalAtendido = DET_ROWS.reduce((acc, r) => acc + (Number(r.atendida ?? r.ATENDIDA ?? 0) || 0), 0);

      const box = $('sol_resumen');
      if (box){
        box.innerHTML = `
          <div class="item"><div class="label">Oficialia</div><div class="value">${oficialia}</div></div>
          <div class="item"><div class="label">Fecha</div><div class="value">${fechaFmt}</div></div>
          <div class="item"><div class="label">Usuario solicitante</div><div class="value">${usuario}</div></div>
          <div class="item"><div class="label">Tipo</div><div class="value">${tipo}</div></div>
          <div class="item"><div class="label">Estatus</div><div class="value">${status}</div></div>
          <div class="item"><div class="label">Renglones</div><div class="value">${DET_ROWS.length}</div></div>
          <div class="item span-2"><div class="label">Resumen</div><div class="value">${productoLinea}</div></div>
          <div class="item"><div class="label">Cantidad solicitada</div><div class="value">${totalQty}</div></div>
          <div class="item"><div class="label">Cantidad atendida</div><div class="value">${totalAtendido}</div></div>
          <div class="item span-2"><div class="label">Observaciones</div><div class="value">${observ}</div></div>
        `;
      }
      if ($('sol_consulta_detalle')) $('sol_consulta_detalle').innerHTML = buildConsultaDetalleHtml(DET_ROWS);
      if ($('btn-solicitudes-tab-consulta')) $('btn-solicitudes-tab-consulta').disabled = false;
      setSolicitudesTab('consulta');

      msg.textContent = 'Listo'; toast('Resumen cargado', true);
    }catch(e){
      msg.textContent = e.message;
      const box = $('sol_resumen');
      if (box){
        box.innerHTML = `
          <div class="item"><div class="label">Oficialia</div><div class="value">-</div></div>
          <div class="item"><div class="label">Fecha</div><div class="value">-</div></div>
          <div class="item"><div class="label">Usuario solicitante</div><div class="value">-</div></div>
          <div class="item"><div class="label">Tipo</div><div class="value">-</div></div>
          <div class="item"><div class="label">Renglones</div><div class="value">-</div></div>
          <div class="item span-2"><div class="label">Resumen</div><div class="value">-</div></div>
          <div class="item"><div class="label">Cantidad solicitada</div><div class="value">-</div></div>
          <div class="item"><div class="label">Cantidad atendida</div><div class="value">-</div></div>
          <div class="item span-2"><div class="label">Observaciones</div><div class="value">-</div></div>
        `;
      }
      if ($('sol_consulta_detalle')) $('sol_consulta_detalle').innerHTML = '<div class="muted">Sin renglones.</div>';
      DET_ROWS = []; DET_SOL_ID = null; CONSULTA_STATUS = '';
      SOL_READY_FOR_PDF = false;
      updateSolicitudActionsVisibility('');
      if ($('btn-solicitudes-tab-consulta')) $('btn-solicitudes-tab-consulta').disabled = true;
      setSolicitudesTab('lista');
      if (!handleAuthError(e)) toast(e.message);
    }
  }

  async function guardarTodoDetalle(containerId='sol_detalle_box', { goToPdf = false } = {}){
    if (!DET_SOL_ID){ toast('Sin solicitud activa', false); return; }
    const tbody = $(containerId)?.querySelector('tbody');
    if (!tbody){ toast('Nada que guardar', false); return; }
    const msg = $('sol_msg_detalle');
    if (msg) msg.textContent = 'Guardando...';

    const payload = [];
    tbody.querySelectorAll('tr').forEach(tr=>{
      const detId = tr.dataset.det;
      const inputs = tr.querySelectorAll('input');
      const atendida = Number(inputs[0]?.value||'0');
      const maxAtendida = Number(inputs[0]?.max || '0');
      const observaciones = inputs[1]?.value || null;
      payload.push({ detalle_id: detId, atendida, max_atendida: maxAtendida, observaciones });
    });
    if (payload.some(item => !item.detalle_id)){
      if (msg) msg.textContent = 'Faltan datos de detalle';
      toast('Faltan datos de detalle', false);
      return;
    }
    if (payload.some(item => !Number.isFinite(item.atendida) || item.atendida < 0)){
      if (msg) msg.textContent = 'Cantidad atendida invalida';
      toast('Cantidad atendida invalida', false);
      return;
    }
    if (payload.some(item => item.atendida > item.max_atendida)){
      if (msg) msg.textContent = 'Atendida no puede ser mayor que solicitada';
      toast('Atendida no puede ser mayor que solicitada', false);
      return;
    }

    const hasBulk = await hasRoute('PATCH','/api/solicitudes/:id/detalles');
    try{
      if (hasBulk){
        await apiJSON(`/api/solicitudes/${DET_SOL_ID}/detalles`, {
          method:'PATCH', headers:{'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });
        SOL_READY_FOR_PDF = true;
        await refreshActiveSolicitudData();
        if (msg) msg.textContent = 'Detalle guardado';
        if (goToPdf) setSolicitudTab('pdf');
        toast('Detalle guardado', true);
        return;
      }
      throw new Error('bulk-patch-not-supported');
    }catch(e){
      try{
        for (const item of payload){
          await apiJSON(`/api/solicitudes/${DET_SOL_ID}/detalles/${item.detalle_id}`, {
            method:'PATCH', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ atendida: item.atendida, observaciones: item.observaciones })
          });
        }
        SOL_READY_FOR_PDF = true;
        await refreshActiveSolicitudData();
        if (msg) msg.textContent = 'Detalle guardado';
        if (goToPdf) setSolicitudTab('pdf');
        toast('Detalle guardado', true);
      }catch(e2){
        console.error(e, e2);
        const detail = e2?.message || e?.message || 'No se pudo guardar el detalle';
        if (msg) msg.textContent = detail;
        toast(detail, false);
      }
    }
  }

  async function listarSolicitudes(){
    const q = $('list_q').value.trim();
    const oficialia_id = $('list_oficialia')?.value?.trim() || '';
    const msg = $('msg_list'); const box = $('listado_box');
    msg.textContent = 'Listando...';
    setListadoSelectedId(null);
    try{
      const params = new URLSearchParams({ q, page:1, limit:200 });
      if (oficialia_id) params.set('oficialia_id', oficialia_id);
      if (SOL_LIST_MODE === 'canceladas') params.set('status', 'CANCELADA');
      const url = `/api/solicitudes?${params}`;
      const j = await apiJSON(url);
      if (!Array.isArray(j.data)) throw new Error('Respuesta inesperada');
      const rows = SOL_LIST_MODE === 'canceladas'
        ? j.data.filter(r => ['CANCELADA','CANCELADO'].includes(norm(r.status ?? r.STATUS ?? '')))
        : j.data.filter(r => !['CANCELADA','CANCELADO'].includes(norm(r.status ?? r.STATUS ?? '')));
      if (!rows.length) {
        box.innerHTML = `<div class="muted">Sin ${SOL_LIST_MODE === 'canceladas' ? 'cancelados' : 'resultados'}.</div>`;
        msg.textContent='Listo';
        return;
      }
      box.innerHTML = renderSolicitudesListado(rows);
      const filterText = SOL_LIST_MODE === 'canceladas' ? 'cancelada(s)' : 'solicitud(es) activa(s)';
      msg.textContent = `Mostrando ${rows.length} ${filterText}.`;
      toast('Listado cargado', true);
    }catch(e){
      box.innerHTML = '<div class="muted">Tu API no expone GET /api/solicitudes (aun).</div>';
      msg.textContent = e.message || e.massage || 'Error'; if (!handleAuthError(e)) toast(e.message || e.massage || 'Error');
    }
  }

  async function cancelarSolicitud(){
    if (!canManageSolicitudesFront(CURRENT_USER)){ toast('No tienes permiso para cancelar solicitudes', false); return; }
    const id = String($('sol_edit_id')?.value || LIST_SELECTED_ID || DET_SOL_ID || '').trim();
    const msg = $('msg_edit');
    if (!id){ toast('Selecciona una solicitud'); return; }
    if (!confirm('¿Cancelar la solicitud seleccionada?')) return;
    msg.textContent = 'Cancelando...';
    try{
      const j = await apiJSON(`/api/solicitudes/${id}/status`, {
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ status:'CANCELADA' })
      });
      const restored = Number(j?.restored_qty || 0) || 0;
      msg.textContent = restored > 0 ? `Solicitud cancelada. Regresaron ${restored} al almacen.` : 'Solicitud cancelada';
      if (String(DET_SOL_ID || '') === id || String(LIST_SELECTED_ID || '') === id) {
        await consultarSolicitudById(id);
      }
      await listarSolicitudes();
      toast(restored > 0 ? `Cancelada y regresaron ${restored}` : 'Solicitud cancelada', true);
    }catch(e){
      msg.textContent = e.message || e.massage || 'Error';
      if (!handleAuthError(e)) toast(e.message || e.massage || 'Error');
    }
  }

  async function eliminarSolicitud(){
    if (!isAdminDemo(CURRENT_USER)){ toast('Eliminar solo admin/demo', false); return; }
    const id = $('sol_edit_id').value.trim();
    const msg = $('msg_edit');
    if (!id){ toast('Selecciona una solicitud'); return; }
    if (!confirm('¿Eliminar la solicitud seleccionada? Esta accion no se puede deshacer.')) return;
    msg.textContent = 'Eliminando...';
    try{
      const j = await apiJSON(`/api/solicitudes/${id}`, { method:'DELETE' });
      msg.textContent = j.deleted ? 'Solicitud eliminada' : 'No se encontro la solicitud';
      toast('Eliminada', true);
    }catch(e){ msg.textContent = e.message || e.massage || 'Error'; if (!handleAuthError(e)) toast(e.message || e.massage || 'Error'); }
  }

  let ALM_EDIT_ID = null;
  let ALM_CATS = [];
  let ALM_CAT_IS_SELECT = true;
  let ALM_UNI_OPTIONS = [];
  const ALM_DEFAULT_UNIDADES = [
    'BLOCK',
    'PIEZA',
    'PIEZAS',
    'CAJA',
    'PAQUETE',
    'ROLLO',
    'METRO',
    'JUEGO',
    'PAR',
    'BOLSA',
    'KILO',
    'LITRO',
    'UNIDAD'
  ];

  function ensureUnidadInput(){
    const el = $('alm_unidad'); if (!el) return null;
    if (el.tagName.toLowerCase() === 'input') return el;
    const parent = el.parentElement;
    const val = el.value || '';
    const disabled = !!el.disabled;
    const readOnly = !!el.readOnly;
    const isReadonly = el.classList.contains('readonly');
    const input = document.createElement('input');
    input.id = 'alm_unidad';
    input.placeholder = 'Ej. PIEZA, CAJA, METRO';
    input.value = val;
    input.disabled = disabled;
    input.readOnly = readOnly;
    if (isReadonly) input.classList.add('readonly');
    parent.replaceChild(input, el);
    ALM_UNIDAD_IS_SELECT = false;
    return input;
  }
  function ensureUnidadSelect(){
    const el = $('alm_unidad'); if (!el) return null;
    if (el.tagName.toLowerCase() === 'select') return el;
    const parent = el.parentElement;
    const val = el.value || '';
    const disabled = !!el.disabled;
    const isReadonly = el.classList.contains('readonly');
    const sel = document.createElement('select');
    sel.id = 'alm_unidad';
    parent.replaceChild(sel, el);
    ALM_UNIDAD_IS_SELECT = true;
    sel.disabled = disabled;
    if (isReadonly) sel.classList.add('readonly');
    sel.value = val;
    return sel;
  }
  function updateUnidadOptions(rows){
    const vals = new Set();
    ALM_DEFAULT_UNIDADES.forEach(u => vals.add(u));
    (rows || []).forEach(r => {
      const u = safestr(r.UNIDAD ?? r.unidad);
      if (u) vals.add(u);
    });
    UNIDAD_BY_CLAVE.forEach(v => { if (safestr(v)) vals.add(String(v)); });
    ALM_UNI_OPTIONS = Array.from(vals).sort();
    if (ALM_UNI_OPTIONS.length === 0){
      ensureUnidadInput();
      return;
    }
    const sel = ensureUnidadSelect(); if (!sel) return;
    const current = sel.value || '';
    sel.innerHTML = `<option value="">- seleccionar -</option>` + ALM_UNI_OPTIONS.map(u => `<option value="${u}">${u}</option>`).join('');
    sel.value = current || '';
  }
  function ensureCategoriaInput(){
    const el = $('alm_cat'); if (!el) return null;
    if (el.tagName.toLowerCase() === 'input') return el;
    const parent = el.parentElement;
    const currentText = el.options?.[el.selectedIndex]?.textContent || el.value || '';
    const disabled = !!el.disabled;
    const readOnly = !!el.readOnly;
    const isReadonly = el.classList.contains('readonly');
    const input = document.createElement('input');
    input.id = 'alm_cat';
    input.placeholder = 'Categoria';
    input.value = currentText === '- seleccionar -' ? '' : currentText;
    input.disabled = disabled;
    input.readOnly = readOnly;
    if (isReadonly) input.classList.add('readonly');
    parent.replaceChild(input, el);
    ALM_CAT_IS_SELECT = false;
    return input;
  }
  function ensureCategoriaSelect(){
    const el = $('alm_cat'); if (!el) return null;
    if (el.tagName.toLowerCase() === 'select') return el;
    const parent = el.parentElement;
    const current = el.value || '';
    const disabled = !!el.disabled;
    const isReadonly = el.classList.contains('readonly');
    const select = document.createElement('select');
    select.id = 'alm_cat';
    parent.replaceChild(select, el);
    ALM_CAT_IS_SELECT = true;
    select.disabled = disabled;
    if (isReadonly) select.classList.add('readonly');
    select.value = current;
    return select;
  }
  async function updateCategoriaFallbackOptions(rows){
    const vals = new Set();
    (rows || []).forEach(r => {
      const c = nombreCategoriaFromRow(r) || safestr(r.CATEGORIA_NOMBRE ?? r.categoria_nombre ?? r.CATEGORIA ?? r.categoria);
      if (c) vals.add(c);
    });
    CATEGORIA_BY_CLAVE.forEach(v => { if (safestr(v)) vals.add(String(v)); });
    CATEGORIA_NOMBRE_BY_ID.forEach(v => { if (safestr(v)) vals.add(String(v)); });
    if (vals.size === 0 && await hasRoute('GET','/api/productos')){
      try{
        const j = await apiJSON('/api/productos?q=&limit=500&page=1');
        (j.data || []).forEach(r => {
          const c = safestr(r.CATEGORIA_NOMBRE ?? r.categoria_nombre ?? r.CATEGORIA ?? r.categoria);
          if (c) vals.add(c);
        });
      }catch{}
    }
    const list = Array.from(vals).sort((a,b) => a.localeCompare(b));
    if (!list.length){
      ensureCategoriaInput();
      return;
    }
    const sel = ensureCategoriaSelect(); if (!sel) return;
    const current = sel.value || '';
    sel.innerHTML = `<option value="">- seleccionar -</option>` + list.map(c => `<option value="${c}">${c}</option>`).join('');
    sel.value = current || '';
    ALM_CAT_IS_SELECT = true;
    if (ALM_EDIT_ID) onlyQtyEnabled();
  }

  async function loadCategorias(){
    const el = $('alm_cat'); if (!el) return;
    try{
      if (!(await hasRoute('GET','/api/categorias'))){
        await updateCategoriaFallbackOptions(ALM_LAST_ROWS);
        return;
      }
      const j = await apiJSON('/api/categorias');
      if (!Array.isArray(j.data)) throw new Error('sin data');
      ALM_CATS = j.data;
      if (!ALM_CATS.length){
        await updateCategoriaFallbackOptions(ALM_LAST_ROWS);
        return;
      }
      const selNow = ensureCategoriaSelect();
      if (!selNow) return;
      const current = selNow.value || '';
      selNow.innerHTML = `<option value="">- seleccionar -</option>` + ALM_CATS.map(c => `<option value="${c.id}">${c.nombre}</option>`).join('');
      selNow.value = current || '';
      ALM_CAT_IS_SELECT = true;
      if (ALM_EDIT_ID) onlyQtyEnabled();

      ALM_CATS.forEach(c=>{ if (isNum(c.id)) CATEGORIA_NOMBRE_BY_ID.set(Number(c.id), safestr(c.nombre)); });
    }catch{
      await updateCategoriaFallbackOptions(ALM_LAST_ROWS);
    }
  }
  function almFormToBody(){
    const CLAVE = ($('alm_clave').value||'').trim();
    const DESCRIPCION = ($('alm_desc').value||'').trim();
    const STOCK = Number($('alm_stock').value||'0');
    const ESTADO = ($('alm_estado').value||'ACTIVO').toUpperCase();
    let CATEGORIA = null;
    if (ALM_CAT_IS_SELECT){ CATEGORIA = $('alm_cat').value || null; } else { const txt = ($('alm_cat').value||'').trim(); CATEGORIA = txt || null; }
    const UNIDAD = ($('alm_unidad')?.value||'').trim() || null;
    return { CLAVE, DESCRIPCION, STOCK, ESTADO, CATEGORIA, UNIDAD };
  }
  function onlyQtyEnabled(){
    ['alm_clave','alm_desc','alm_estado','alm_cat','alm_unidad'].forEach(id=>{
      const el = $(id); if (el) { el.readOnly = true; el.disabled = true; el.classList.add('readonly'); }
    });
    const st = $('alm_stock'); if (st){ st.readOnly = false; st.disabled = false; st.focus(); }
  }
  function allEnabled(){
    ['alm_clave','alm_desc','alm_estado','alm_cat','alm_unidad','alm_stock'].forEach(id=>{
      const el = $(id); if (el) { el.readOnly = false; el.disabled = false; el.classList.remove('readonly'); }
    });
  }
  function almResetForm(){
    $('alm_clave').value = ''; $('alm_desc').value = ''; $('alm_stock').value = '';
    $('alm_estado').value = 'ACTIVO'; if ($('alm_unidad')) $('alm_unidad').value = '';
    if (ALM_CAT_IS_SELECT) $('alm_cat').value = ''; else $('alm_cat').value = '';
    ALM_EDIT_ID = null; $('btn-alm-crear').textContent = 'Guardar en almacen';
    show('btn-alm-crear'); show('alm_msg'); hide('btn-alm-cancel'); allEnabled(); applyPermassions();
  }
  function renderStockBajo(rows){
    const box = $('alm_stock_bajo'); if (!box) return;
    const bajos = (rows || [])
      .map(r => {
        const stock = Number(r.STOCK ?? r.stock ?? 0);
        const minimo = Number(r.minimo ?? r.MINIMO ?? r.min_stock ?? r.stock_minimo);
        return { ...r, stock, minimo };
      })
      .filter(r => Number.isFinite(r.minimo) && r.minimo > 0 && r.stock <= r.minimo)
      .sort((a, b) => a.stock - b.stock || String(a.CLAVE || '').localeCompare(String(b.CLAVE || '')));
    if (!bajos.length){
      box.innerHTML = '<div class="muted">Sin alertas de stock bajo.</div>';
      return;
    }
    box.innerHTML = `
      <div class="table-scroll">
        <table>
          <thead>
            <tr><th>CLAVE</th><th>Producto</th><th>Stock</th><th>Minimo</th></tr>
          </thead>
          <tbody>
            ${bajos.slice(0, 25).map(r => `<tr>
              <td>${safestr(r.CLAVE)}</td>
              <td>${safestr(r.DESCRIPCION)}</td>
              <td class="danger">${Number(r.stock || 0)}</td>
              <td>${Number(r.minimo || 0)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }
  function renderAlmacen(rows){
    const tb = $('alm_tbody'); if (!tb) return;
    tb.innerHTML = '';
    const adminDemo = isAdminDemo(CURRENT_USER);
    rows.forEach(r=>{
      const id = r.ID ?? r.id;
      const categoriaNom = nombreCategoriaFromRow(r) || '';
      const stock = r.STOCK ?? 0;
      const estado = r.status ?? r.STATUS ?? r.ESTADO ?? '-';
      const tr = document.createElement('tr');
      tr.dataset.id = id;
      tr.dataset.clave = r.CLAVE ?? '';
      tr.dataset.desc = r.DESCRIPCION ?? '';
      tr.dataset.categoria = r.CATEGORIA;
      tr.dataset.categoriaNombre = categoriaNom;
      tr.dataset.unidad = r.UNIDAD ?? r.unidad ?? '';
      tr.dataset.stock = stock;
      tr.dataset.estado = estado;
      tr.innerHTML = `
        <td>${r.CLAVE ?? ''}</td>
        <td>${r.DESCRIPCION ?? ''}</td>
        <td>${categoriaNom}</td>
        <td>${tr.dataset.unidad||''}</td>
        <td>${stock}</td>
        <td class="muted">${estado}</td>
        <td>
          <button class="mini" data-action="hist">Historial</button>
          <button class="mini" data-action="edit">Editar</button>
          <button class="mini danger" data-action="del" title="Eliminar" ${adminDemo?'':'disabled'}>${adminDemo?'Eliminar':'Eliminar'}</button>
        </td>`;
      tb.appendChild(tr);

      const clave = norm(r.CLAVE ?? '');
      if (clave && categoriaNom) CATEGORIA_BY_CLAVE.set(clave, String(categoriaNom));
      if (clave && tr.dataset.unidad) UNIDAD_BY_CLAVE.set(clave, String(tr.dataset.unidad));
    });
  }
  async function loadAlmacen(){
    const canAlm = canFullSections(CURRENT_USER) || isFrontAlmacenAllowed(CURRENT_USER) || isAdminDemo(CURRENT_USER);
    if (!canAlm){
      $('alm_meta').textContent = '-';
      $('alm_tbody').innerHTML = `<tr><td colspan="7" class="muted">Acceso restringido</td></tr>`;
      renderStockBajo([]);
      return;
    }
    const q = ($('alm_q')?.value||'').trim();
    const order = $('alm_order')?.value || 'CLAVE';
    const dir = $('alm_dir')?.value || 'ASC';
    try{
      const j = await apiJSON(`/api/almacen?q=${encodeURIComponent(q)}&order=${encodeURIComponent(order)}&dir=${encodeURIComponent(dir)}&limit=500&page=1`);
      let rows = Array.isArray(j.data) ? j.data : [];
      await ensureCategoriaNames(rows);
      ALM_LAST_ROWS = rows;
      if (!ALM_CATS.length) await updateCategoriaFallbackOptions(rows);
      updateUnidadOptions(rows);
      renderAlmacen(rows);
      renderStockBajo(rows);
      $('alm_meta').textContent = `${rows.length} filas`;
      applyPermassions();
    }catch(e){
      $('alm_meta').textContent = '-';
      $('alm_tbody').innerHTML = `<tr><td colspan="7" class="muted">Error: ${e.message || e.massage || 'Error'}</td></tr>`;
      renderStockBajo([]);
      if (!handleAuthError(e)) console.error(e);
    }
  }
  async function loadProductoHistorial(clave){
    const title = $('alm_hist_title');
    const box = $('alm_historial_box');
    const cleanClave = safestr(clave);
    if (!box || !cleanClave) return;
    if (!(await hasRoute('GET','/api/productos/historial/:clave'))){
      box.innerHTML = '<div class="muted">Historial no disponible.</div>';
      return;
    }
    if (title) title.textContent = `Historial: ${cleanClave}`;
    box.innerHTML = '<div class="muted">Cargando...</div>';
    try{
      const j = await apiJSON(`/api/productos/historial/${encodeURIComponent(cleanClave)}`);
      const rows = Array.isArray(j.data) ? j.data : [];
      if (!rows.length){
        box.innerHTML = '<div class="muted">Sin movimientos registrados.</div>';
        return;
      }
      box.innerHTML = `
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Cantidad</th>
                <th>Responsable</th>
                <th>Referencia</th>
                <th>Observaciones</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => `<tr>
                <td>${fmtDate(r.fecha || r.FECHA)}</td>
                <td>${safestr(r.tipo || r.TIPO || r.TIPO_MOVIMIENTO)}</td>
                <td>${Number(r.cantidad ?? r.CANTIDAD ?? 0)}</td>
                <td>${safestr(r.responsable || r.RESPONSABLE)}</td>
                <td>${safestr(r.referencia || r.REFERENCIA)}</td>
                <td>${safestr(r.observaciones || r.OBSERVACIONES)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }catch(e){
      box.innerHTML = `<div class="danger">${e.message || e.massage || 'Error'}</div>`;
      if (!handleAuthError(e)) toast(e.message || e.massage || 'Error', false);
    }
  }
  async function intentarAltaProductoDesdeAlmacen(body){
    try{
      if (!(await hasRoute('POST','/api/productos'))) return;
      const prod = { CLAVE: body.CLAVE, DESCRIPCION: body.DESCRIPCION, categoria: body.CATEGORIA ?? null, unidad: body.UNIDAD ?? null, minimo: null, maximo: null, status: body.ESTADO ?? 'ACTIVO' };
      await apiJSON('/api/productos', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(prod) });
    }catch(e){ console.warn('No se pudo dar de alta producto espejo:', e.message || e.massage || e); }
  }
  async function crearAlmacen(){
    const canAlm = canFullSections(CURRENT_USER) || isFrontAlmacenAllowed(CURRENT_USER) || isAdminDemo(CURRENT_USER);
    if (!canAlm){ toast('Acceso restringido', false); return; }
    const msg = $('alm_msg');
    const body = almFormToBody();
    if (!body.CLAVE || !body.DESCRIPCION){ toast('CLAVE y DESCRIPCION son obligatorios'); return; }
    msg.textContent = ALM_EDIT_ID ? 'Actualizando...' : 'Guardando...';
    try{
      if (ALM_EDIT_ID){
        const add = Number(body.STOCK||0) || 0;
        await apiJSON(`/api/almacen/${ALM_EDIT_ID}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ addStock: add }) });
        toast(`Ajuste aplicado: ${add >= 0 ? '+' : ''}${add}`, true);
      } else {
        const j = await apiJSON('/api/almacen', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        await intentarAltaProductoDesdeAlmacen(body);
        toast('Guardado', true);
      }
      msg.textContent = 'Listo';
      almResetForm(); await loadAlmacen();
    }catch(e){
      msg.textContent = e.message || e.massage || 'Error'; if (!handleAuthError(e)) toast(e.message || e.massage || 'Error');
    }
  }
  function startEditFromRow(tr){
    const canAlm = canFullSections(CURRENT_USER) || isFrontAlmacenAllowed(CURRENT_USER) || isAdminDemo(CURRENT_USER);
    if (!canAlm){ toast('Acceso restringido', false); return; }
    ALM_EDIT_ID = tr.dataset.id;
    $('alm_clave').value = tr.dataset.clave || '';
    $('alm_desc').value = tr.dataset.desc || '';
    $('alm_stock').value = '0';
    $('alm_estado').value = tr.dataset.estado || 'ACTIVO';
    if ($('alm_unidad')){
      const valU = tr.dataset.unidad || '';
      if (ALM_UNIDAD_IS_SELECT && $('alm_unidad').tagName.toLowerCase() === 'select'){
        const exists = Array.from($('alm_unidad').options).some(o => o.value === valU);
        if (!exists && valU){
          const opt = document.createElement('option'); opt.value = valU; opt.textContent = valU;
          $('alm_unidad').appendChild(opt);
        }
      }
      $('alm_unidad').value = valU;
    }
    if (ALM_CAT_IS_SELECT){
      $('alm_cat').value = tr.dataset.categoria || '';
      if (!$('alm_cat').value && tr.dataset.categoriaNombre){
        const opt = Array.from($('alm_cat').options).find(o => o.textContent === tr.dataset.categoriaNombre);
        if (opt) $('alm_cat').value = opt.value;
      }
    } else {
      $('alm_cat').value = tr.dataset.categoriaNombre || tr.dataset.categoria || '';
    }
    $('btn-alm-crear').textContent = 'Actualizar';
    show('btn-alm-cancel');
    toast('Editando registro (usa negativo para restar)');
    onlyQtyEnabled();
  }
  function cancelEdit(){ almResetForm(); toast('Edicion cancelada'); }
  async function eliminarFila(id){
    if (!isAdminDemo(CURRENT_USER)){ toast('Eliminar solo admin/demo', false); return; }
    if (!confirm('?Eliminar el registro #' + id + '?')) return;
    const msg = $('alm_msg');
    msg.textContent = 'Eliminando...';
    try{
      const j = await apiJSON(`/api/almacen/${id}?hard=1`, { method:'DELETE' });
      msg.textContent = 'Listo';
      toast(j.deleted ? 'Eliminado' : 'No se elimino (?no existe?)', true);
      if (ALM_EDIT_ID === String(id)) almResetForm();
      await loadAlmacen();
    }catch(e){
      msg.textContent = e.message || e.massage || 'Error'; if (!handleAuthError(e)) toast(e.message || e.massage || 'Error');
    }
  }

  function getSolicitudIdForPdf(){
    return String(DET_SOL_ID || SOL_ID || $('sol_edit_id')?.value || '').trim();
  }
  async function descargarPDF({ resetAfter = false } = {}) {
  const btn = document.getElementById('btn-sol-pdf');
  const btnFlow = document.getElementById('btn-sol-pdf-flow');
  if (btn) btn.disabled = true;
  if (btnFlow) btnFlow.disabled = true;

  try {
    const id = getSolicitudIdForPdf();
    if (!id) throw new Error('No hay solicitud seleccionada');
    const res = await api(`/api/solicitudes/${encodeURIComponent(id)}/pdf`, {
      headers: { Accept: 'application/pdf' }
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = text || `HTTP ${res.status}`;
      try {
        const json = JSON.parse(text);
        msg = json?.error || json?.message || msg;
      } catch {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `solicitud_${id}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    if (resetAfter) resetSolicitudFlow();
  } catch (e) {
    console.error('Error generando PDF', e);
    alert(`Error generando PDF: ${e.message}`);
  } finally {
    if (btn) btn.disabled = false;
    if (btnFlow) btnFlow.disabled = false;
  }
}
  
  document.addEventListener('DOMContentLoaded', async ()=>{
    $('btn-login')?.addEventListener('click', login);
    $('pass')?.addEventListener('keydown', (e)=>{ if(e.key==='Enter') login(); });
    $('btn-logout')?.addEventListener('click', logout);

    document.getElementById('nav')?.addEventListener('click', (ev)=>{
      const btn = ev.target.closest('.tab'); if (!btn) return;
      const isDisabled = btn.classList.contains('disabled');
      if (isDisabled){ toast('Acceso restringido', false); return; }
      showView(btn.dataView || btn.dataset.view);
      const v = btn.dataView || btn.dataset.view;
      if (v==='almacen') { loadCategorias(); loadAlmacen(); }
    });

    $('btn-rep-load')?.addEventListener('click', ()=> loadReporteUsuarios(true));
    $('btn-rep-print-general')?.addEventListener('click', ()=> printReporte(''));
    $('btn-rep-back')?.addEventListener('click', ()=> { REP_SELECTED_OFICIALIA = ''; setReporteView('home'); });
    $('btn-rep-print-detail')?.addEventListener('click', ()=> printReporte(REP_SELECTED_OFICIALIA || $('rep_oficialia')?.value || ''));
    $('btn-rep-export-excel')?.addEventListener('click', exportReporteExcel);
    $('btn-graf-load')?.addEventListener('click', loadGraficas);
    $('graf_oficialia')?.addEventListener('change', loadGraficas);
    $('graf_fecha_inicio')?.addEventListener('change', loadGraficas);
    $('graf_fecha_fin')?.addEventListener('change', loadGraficas);

    
    $('btn-crear-sol')?.addEventListener('click', crearSolicitud);
    $('btn-sol-tab-crear')?.addEventListener('click', ()=> setSolicitudTab('crear'));
    $('btn-sol-tab-agregar')?.addEventListener('click', ()=> setSolicitudTab('agregar'));
    $('btn-sol-tab-revision')?.addEventListener('click', ()=> setSolicitudTab('revision'));
    $('btn-sol-tab-pdf')?.addEventListener('click', ()=> setSolicitudTab('pdf'));
    $('btn-find-prod')?.addEventListener('click', buscarProductos);
    $('btn-add-det')?.addEventListener('click', agregarDetalle);

    $('btn-listar')?.addEventListener('click', listarSolicitudes);
    $('list_oficialia')?.addEventListener('change', listarSolicitudes);
    $('btn-list-mode-activas')?.addEventListener('click', ()=>{ setSolicitudListMode('activas'); listarSolicitudes(); });
    $('btn-list-mode-canceladas')?.addEventListener('click', ()=>{ setSolicitudListMode('canceladas'); listarSolicitudes(); });
    $('btn-list-consultar')?.addEventListener('click', ()=> consultarSolicitudById(LIST_SELECTED_ID));
    $('btn-solicitudes-tab-lista')?.addEventListener('click', ()=> setSolicitudesTab('lista'));
    $('btn-solicitudes-tab-consulta')?.addEventListener('click', ()=> setSolicitudesTab('consulta'));

    setSolicitudListMode('activas');
    $('btn-sol-cancelar')?.addEventListener('click', cancelarSolicitud);
    $('btn-sol-eliminar')?.addEventListener('click', eliminarSolicitud);

    
    $('btn-sol-pdf')?.addEventListener('click', ()=> descargarPDF({ resetAfter: false }));
    $('btn-sol-pdf-flow')?.addEventListener('click', ()=> descargarPDF({ resetAfter: true }));

    $('listado_box')?.addEventListener('click', (ev)=>{
      const tr = ev.target.closest('tbody tr[data-sol-id]'); if (!tr) return;
      setListadoSelectedId(tr.dataset.solId || tr.getAttribute('data-sol-id'));
    });
    $('sol_detalle_box')?.addEventListener('click', (ev)=>{
      const btn = ev.target.closest('#btn-sol-save-detalle'); if (!btn) return;
      guardarTodoDetalle('sol_detalle_box', { goToPdf: true });
    });
    $('rep_oficialias_box')?.addEventListener('click', async (ev)=>{
      const btn = ev.target.closest('[data-rep-open-oficialia]'); if (!btn) return;
      try{
        const id = btn.getAttribute('data-rep-open-oficialia') || '';
        if ($('rep_oficialia')) $('rep_oficialia').value = id;
        REP_SELECTED_OFICIALIA = id;
        await loadReporteUsuarios();
      }catch(e){
        toast(e.message || e.massage || 'Error al abrir reporte', false);
      }
    });
    $('btn-alm-apply')?.addEventListener('click', loadAlmacen);
    $('alm_q')?.addEventListener('keydown', (e)=>{ if(e.key==='Enter') loadAlmacen(); });
    $('alm_order')?.addEventListener('change', loadAlmacen);
    $('alm_dir')?.addEventListener('change', loadAlmacen);
    $('btn-alm-crear')?.addEventListener('click', crearAlmacen);
    $('btn-alm-cancel')?.addEventListener('click', cancelEdit);
    $('alm_tbody')?.addEventListener('click', (ev)=>{
      const btn = ev.target.closest('button'); if (!btn) return;
      const tr = ev.target.closest('tr'); if (!tr) return;
      const id = tr.dataset.id;
      if (btn.dataset.action === 'hist')      loadProductoHistorial(tr.dataset.clave || '');
      else if (btn.dataset.action === 'edit') startEditFromRow(tr);
      else if (btn.dataset.action === 'del')  eliminarFila(id);
    });

    try { await ensureAPI(); } catch(e){ alert(e.message || e.massage || 'Error'); return; }
    await me();

    if ($('btn-sol-eliminar')) {
      const can = await hasRoute('DELETE','/api/solicitudes/:id');
      if (!can) { $('btn-sol-eliminar').classList.add('hidden'); }
    }

    applyPermassions();
    updateSolBadge();
    setSolicitudTab('crear');
  });

})();












