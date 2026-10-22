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
      nested.nombre_completo || nested.nombre_usuario || nested.NOMBRE_USUARIO ||
      [nested.nombre, nested.PRIMER_APELLIDO, nested.SEGUNDO_APELLIDO].filter(Boolean).join(' ');
    if (nestedName) return nestedName;

    return (
      d.nombreUsuario || d.nombre_usuario || d.NOMBRE_USUARIO ||
      d.usuarioNombre || d.usuario_nombre || d.USUARIO ||
      d.solicitante || d.SOLICITANTE || nested.username || nested.USERNAME ||
      d.username || d.USERNAME ||
      [d.nombre||d.NOMBRE, d.PRIMER_APELLIDO||d.primer_ap, d.SEGUNDO_APELLIDO||d.segundo_ap].filter(Boolean).join(' ')
    ) || '-';
  }
  const norm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase();
  const safestr = v => (typeof v==='string' ? v.trim() : (v==null?'':String(v))).trim();
  const isNum = v => !isNaN(Number(v)) && v!=='' && v!=null;

  let CURRENT_USER = null;
  let UI_PERMISOS = null;
  const uiPerms = ()=> UI_PERMISOS?.permisos || {};

  function applyPermassions(){  
    const p = uiPerms();

    // 1. Ocultar/mostrar botones del Sidebar según el rol
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(btn => {  
      const v = (btn.dataset.view || '').toLowerCase();
      if (v === 'almacen') {
        btn.classList.toggle('hidden', !p.puedeAccederAlmacen);
      } else if (v === 'reporte' || v === 'graficas') {
        btn.classList.toggle('hidden', !p.reportes?.acceso);
      } else if (v === 'auditoria') {
        btn.classList.toggle('hidden', !p.verLogs);
      }
    });  

    // 2. Selector de área/usuario al crear solicitud
    const uidIn = $('sol_user_id');  
    if (uidIn){  
      const editable = p.admin || p.encargado; 
      if (!uidIn.value) uidIn.value = (CURRENT_USER?.id ?? '').toString();  
      uidIn.disabled = !editable;  
      uidIn.title = editable ? '' : 'Bloqueado (autorrelleno con tu usuario)';  
    }  

    // 3. Botones de acciones sobre solicitudes
    if ($('btn-sol-eliminar')) {$('btn-sol-eliminar').disabled = !p.solicitudes?.puedeEliminar;  
      $('btn-sol-eliminar').title = p.solicitudes?.puedeEliminar ? '' : 'Eliminar solo Admin';  
    }  
    if ($('btn-sol-cancelar')) {$('btn-sol-cancelar').disabled = !p.solicitudes?.puedeCancelar;
      $('btn-sol-cancelar').title = p.solicitudes?.puedeCancelar ? '' : 'Cancelar solo usuarios autorizados';
    }
  }

  let API = ''; 
  async function ensureAPI(){ return API || ''; }
  async function api(path, opts = {}){ const base = await ensureAPI(); const url = (/^https?:\/\//.test(path) ? path : (base + path)); return fetch(url, { credentials:'include', ...opts }); }
  async function apiJSON(path, opts = {}){
    const res = await api(path, { headers:{'Accept':'application/json', ...(opts.headers||{})}, ...opts });
    const text = await res.text(); const json = (()=>{ try{return JSON.parse(text);}catch{return null;} })();
    if (!res.ok){ const msg = json?.error || json?.message || json?.massage || text || `HTTP ${res.status}`; throw new Error(msg); }
    return json ?? {};
  }
  
  function handleAuthError(e){
    const m = String(e?.message || e?.massage || '').toLowerCase();
    if (m.includes('no autenticado') || m.includes('unauthorized') || m.includes('token')){
      window.location.replace('/');
      return true;
    }
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
    routeKey('POST', '/api/lookup/unidad-categoria'),
    routeKey('DELETE', '/api/solicitudes/:id')
  ]);
  async function hasRoute(method, path){ return APP_ROUTES.has(routeKey(method, path)); }

  async function loadSolicitudUsers(){
    const createSel = $('sol_user_id');
    if (!createSel) return;

    const p = uiPerms();
    const rolActual = norm(CURRENT_USER?.rol || UI_PERMISOS?.rol || 'USUARIO');
    const isAdminUser = Boolean(p.admin || rolActual === 'ADMIN');
    const isEncargadoUser = Boolean(p.encargado || rolActual === 'ENCARGADO');
    const canSelectArea = isAdminUser || isEncargadoUser;
    const ownId = Number(CURRENT_USER?.id || 0) || null;
    const currentCreate = createSel?.value || '';
    let userData = [];
    const ofiMap = new Map();

    try{
      if (await hasRoute('GET','/api/oficialias')){
        const jo = await apiJSON('/api/oficialias');
        (Array.isArray(jo?.data) ? jo.data : []).forEach(o => {
          if (o?.id != null && safestr(o.nombre)) ofiMap.set(Number(o.id), safestr(o.nombre));
        });
      }
    }catch{}

    try{
      if (await hasRoute('GET','/api/usuarios')){
        const j = await apiJSON('/api/usuarios?include_inactive=1');
        userData = Array.isArray(j?.data) ? j.data : [];
      }
    }catch{}

    if (!userData.length && ownId){
      const ownOfiId = Number(CURRENT_USER?.id_oficialia || 0) || null;
      const ownArea = ofiMap.get(ownOfiId) || safestr(CURRENT_USER?.oficialia_nombre || CURRENT_USER?.departamento) || [CURRENT_USER?.nombre, CURRENT_USER?.primer_ap, CURRENT_USER?.segundo_ap].filter(Boolean).join(' ').trim();
      userData = [{
        id: ownId,
        username: CURRENT_USER?.username || '',
        rol: rolActual,
        id_oficialia: ownOfiId,
        oficialia_nombre: ownArea,
        area_nombre: ownArea,
        nombre_completo: ownArea || CURRENT_USER?.username || `Área ${ownId}`
      }];
    }

    const activeUsers = userData.filter(u => {
      const activo = Number(u?.activo?.data?.[0] ?? u?.activo ?? 1);
      return activo !== 0;
    });
    const baseSource = activeUsers.length ? activeUsers : userData;

    // Filtrar según rol:
    // - ADMIN: todas las áreas/departamentos
    // - ENCARGADO: su propia área (Encargado / Recursos Materiales) + áreas de USUARIO
    // - USUARIO: únicamente su propia área asignada
    const createSource = baseSource.filter(u => {
      const uId = Number(u.id || 0);
      const uRol = norm(u.rol || (u.username === 'admin' ? 'ADMIN' : u.username === 'encargado' ? 'ENCARGADO' : 'USUARIO'));
      if (isAdminUser) return true;
      if (isEncargadoUser) return uRol === 'ENCARGADO' || uRol === 'USUARIO' || uId === ownId;
      return uId === ownId;
    });

    const finalSource = createSource.length ? createSource : baseSource;
    const options = finalSource.map(u => {
      const id = Number(u.id || 0);
      const ofiId = Number(u.id_oficialia ?? u.ID_OFICIALIA ?? 0);
      const areaLabel = safestr(
        u.oficialia_nombre ||
        u.area_nombre ||
        u.departamento ||
        ofiMap.get(ofiId) ||
        u.nombre_completo ||
        u.fullname ||
        u.username ||
        `Área ${id}`
      );
      return `<option value="${id}">${areaLabel}</option>`;
    }).join('');
    
    createSel.innerHTML = options || '<option value="">Sin áreas disponibles</option>';
    const validCurrent = currentCreate && finalSource.some(u => String(u.id) === String(currentCreate));
    createSel.value = validCurrent ? currentCreate : String(ownId || finalSource[0]?.id || '');
    createSel.disabled = !canSelectArea;
    createSel.title = canSelectArea ? '' : 'Bloqueado con tu área asignada';
  }

  async function loadSolicitudOficialias(){
    const listSel = $('list_oficialia');
    if (!listSel) return;
    const p = uiPerms();
    const canAllUsers = p.solicitudes?.puedeSurtir;
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
    const allOption = canAllUsers ? '<option value="">Todas los departamentos</option>' : '';
    listSel.innerHTML = allOption + (options || '<option value="">Sin departamentos</option>');
    listSel.value = canAllUsers ? (current || '') : String(ownOfi || rows[0]?.id || '');
    listSel.disabled = !canAllUsers;
    listSel.title = canAllUsers ? '' : 'Solo puedes consultar tu departamento';
  }

  async function fetchUiConfig(){ 
    try { 
      if (!(await hasRoute('GET','/api/ui-config'))) return null; 
      const j = await apiJSON('/api/ui-config'); 
      UI_PERMISOS = j; 
      return j; 
    } catch { return null; } 
  }
  
  async function me(){
    try {
      const j = await apiJSON('/api/auth/me'); 
      const u = j.user || {};
      CURRENT_USER = u; 
      
      await fetchUiConfig(); 
      const rol = u.rol || UI_PERMISOS?.rol || 'USUARIO';
      CURRENT_USER.rol = rol;

      if($('who'))$('who').textContent = u.username || u.nombre || 'usuario';
      if($('who_rol'))$('who_rol').textContent = `[${rol}]`; 
      
      applyPermassions();
      showView('panel_general'); 
      
      await Promise.all([loadSolicitudUsers(), loadSolicitudOficialias()]); 
      applyPermassions();
    } catch(e) {
      console.error("Error en me():", e);
      window.location.replace('/');
    }
  }

  async function logout(){
    try{ await apiJSON('/api/auth/logout', { method:'POST' }); }catch{}
    CURRENT_USER = null; UI_PERMISOS = null;
    window.location.replace('/');
  }

  function showView(id){
    document.querySelectorAll('.view-section, #view-container > section').forEach(sec => {
      sec.classList.remove('active');
      sec.classList.add('hidden');
      sec.style.display = 'none';
    });

    const el = document.getElementById('view-' + id);
    if (el) {
      el.classList.remove('hidden');
      el.classList.add('active');
      el.style.display = 'block';
    }

    document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.sidebar-nav .nav-item[data-view="${id}"]`);
    if (btn) {
      btn.classList.add('active');
      const breadcrumb = document.getElementById('breadcrumb');
      if (breadcrumb) {
        breadcrumb.innerHTML = `Operación / <b>${btn.textContent.trim()}</b>`;
      }
    }

    if (id === 'panel_general') { if (typeof loadPanelGeneral === 'function') loadPanelGeneral(); }
    if (id === 'almacen') { loadCategorias(); loadAlmacen(); }
    if (id === 'reporte') { setReporteView('home'); loadReporteUsuarios(); }
    if (id === 'graficas') { loadGraficas(); }
    if (id === 'auditoria') { if (typeof loadAuditoria === 'function') loadAuditoria(); }
  }

  async function loadPanelGeneral(){
    try {
      const solRes = await apiJSON('/api/solicitudes?limit=500&page=1');
      const rows = Array.isArray(solRes?.data) ? solRes.data : [];

      const total = rows.length;
      const pendientes = rows.filter(r => norm(r.status || r.STATUS) === 'PENDIENTE').length;
      const surtidas = rows.filter(r => ['APROBADA', 'SURTIDA', 'ENTREGADO', 'ENTREGADA'].includes(norm(r.status || r.STATUS))).length;

      if ($('kpi-ordenes-total'))$('kpi-ordenes-total').textContent = total;
      if ($('kpi-ordenes-pendientes'))$('kpi-ordenes-pendientes').textContent = pendientes;
      if ($('kpi-ordenes-autorizadas'))$('kpi-ordenes-autorizadas').textContent = surtidas;

      const actBox = $('panel_actividad_box');
      if (actBox) {
        const recientes = rows.slice(0, 6);
        if (!recientes.length) {
          actBox.innerHTML = '<div class="muted">Aún no hay solicitudes registradas.</div>';
        } else {
          actBox.innerHTML = `
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Folio</th>
                    <th>Fecha</th>
                    <th>Solicitante</th>
                    <th>Departamento</th>
                    <th>Estatus</th>
                    <th>Acción</th>
                  </tr>
                </thead>
                <tbody>
                  ${recientes.map(r => {
                    const id = r.id ?? r.ID;
                    const status = String(r.status ?? r.STATUS ?? '-').toUpperCase();
                    let badgeClass = 'status-pendiente';
                    if (['APROBADA', 'SURTIDA', 'ENTREGADA'].includes(status)) badgeClass = 'status-aprobada';
                    if (['CANCELADA', 'CANCELADO', 'RECHAZADA'].includes(status)) badgeClass = 'status-cancelada';
                    return `<tr>
                      <td><b>#${id}</b></td>
                      <td>${fmtDate(r.fecha_solicitud)}</td>
                      <td>${pickUsuario(r)}</td>
                      <td>${safestr(r.oficialia_nombre || r.id_oficialia || '-')}</td>
                      <td><span class="status-badge ${badgeClass}">${status}</span></td>
                      <td><button class="mini" data-open-sol="${id}">Revisar / Surtir</button></td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>`;
        }
      }

      if (uiPerms().puedeAccederAlmacen) {
        const almRes = await apiJSON('/api/almacen?limit=1000&page=1');
        const almRows = Array.isArray(almRes?.data) ? almRes.data : [];
        if ($('kpi-materiales-total'))$('kpi-materiales-total').textContent = almRows.length;
      } else {
        const stRes = await apiJSON('/api/stock?limit=1000&page=1');
        const stRows = Array.isArray(stRes?.data) ? stRes.data : [];
        if ($('kpi-materiales-total'))$('kpi-materiales-total').textContent = stRows.length;
      }
    } catch (e) {
      console.warn('Error cargando KPIs:', e);
    }
  }

  async function loadAuditoria(){
    const box = $('audit_box');
    if (!box) return;
    box.innerHTML = '<div class="muted">Cargando...</div>';
    try {
      const j = await apiJSON('/api/logs/accesos?limit=150');
      const rows = Array.isArray(j?.data) ? j.data : [];
      if (!rows.length) {
        box.innerHTML = '<div class="muted">Sin registros de acceso.</div>';
        return;
      }
      box.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Usuario</th>
              <th>Dirección IP</th>
              <th>Fecha y Hora</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => {
              const f = r.fecha_acceso ? new Date(r.fecha_acceso).toLocaleString('es-MX') : '-';
              const exito = r.exito 
                ? '<span style="color: var(--accent); font-weight: 600;">Exitoso</span>' 
                : '<span style="color: var(--danger); font-weight: 600;">Fallido</span>';
              return `<tr>
                <td>${r.id}</td>
                <td><b>${safestr(r.username)}</b></td>
                <td>${safestr(r.ip_address)}</td>
                <td>${f}</td>
                <td>${exito}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    } catch (e) {
      box.innerHTML = `<div class="muted" style="color: var(--danger);">${e.message || 'Error al cargar bitácora'}</div>`;
    }
  }

  let DET_ROWS = []; 
  let DET_SOL_ID = null; 
  let LIST_SELECTED_ID = null; 
  let CONSULTA_STATUS = '';
  let SOL_ID = null;
  let SOL_DRAFT = null;
  let SOL_DRAFT_ACTIVE = false;
  let SOL_FLOW_TAB = 'crear';
  let SOL_READY_FOR_PDF = false;
  let CAPTURA_DIRTY = false;
  let SOLICITUDES_TAB = 'lista';
  let SOL_LIST_MODE = 'activas';

  function setSolicitudListMode(mode){
    SOL_LIST_MODE = mode === 'canceladas' ? 'canceladas' : 'activas';
    $('btn-list-mode-activas')?.classList.toggle('active', SOL_LIST_MODE === 'activas');
    $('btn-list-mode-canceladas')?.classList.toggle('active', SOL_LIST_MODE === 'canceladas');
  }

  function isCapturaViewActive(){
    const el = $('view-captura');
    return Boolean(el && el.classList.contains('active') && !el.classList.contains('hidden') && el.style.display !== 'none');
  }

  function hasUnsavedSolicitudChanges(){
    if (!isCapturaViewActive()) return false;
    if (SOL_ID !== null && SOL_FLOW_TAB === 'pdf') return false;
    if (DET_ROWS.length > 0) return true;
    if (SOL_DRAFT_ACTIVE) return true;
    const obsSol = safestr($('obs_sol')?.value);
    const buscaProd = safestr($('busca_prod')?.value);
    const detObs = safestr($('det_obs')?.value);
    const prodSel = safestr($('prod_sel')?.value);
    const tipoSol = safestr($('tipo_solicitud')?.value);
    const detCant = safestr($('det_cant')?.value);
    if (obsSol || buscaProd || detObs || prodSel) return true;
    if (tipoSol && tipoSol !== 'CONSUMIBLES') return true;
    if (detCant && detCant !== '1') return true;
    return Boolean(CAPTURA_DIRTY);
  }

  async function discardActiveCapturaSolicitud(){
    const idToDiscard = SOL_ID;
    if (!idToDiscard || !isCapturaViewActive() || SOL_FLOW_TAB === 'pdf') return;
    try {
      await api(`/api/solicitudes/${encodeURIComponent(idToDiscard)}?draft=1`, {
        method: 'DELETE',
        keepalive: true
      });
    } catch {}
  }

  function updateSolBadge(){
    const solActual = $('sol_actual');
    if (solActual) {
      if (SOL_ID) {
        solActual.textContent = `Solicitud activa (#${SOL_ID})`;
      } else if (DET_ROWS.length > 0) {
        solActual.textContent = `Borrador (${DET_ROWS.length} items)`;
      } else if (SOL_DRAFT_ACTIVE) {
        solActual.textContent = 'Borrador en proceso';
      } else {
        solActual.textContent = 'Sin solicitud';
      }
    }

    const canDetail = Boolean(SOL_DRAFT_ACTIVE || $('sol_user_id')?.value);
    const canRevision = DET_ROWS.length > 0;
    const canPdf = Boolean(SOL_ID);
    
    if ($('btn-sol-tab-agregar'))$('btn-sol-tab-agregar').disabled = !canDetail;
    if ($('btn-sol-tab-revision'))$('btn-sol-tab-revision').disabled = !canRevision;
    if ($('btn-sol-tab-pdf'))$('btn-sol-tab-pdf').disabled = !canPdf;

    if ($('sol_flow_id')) {
      $('sol_flow_id').textContent = SOL_ID
        ? `Solicitud guardada (#${SOL_ID})`
        : (DET_ROWS.length > 0 ? `Borrador (${DET_ROWS.length} producto${DET_ROWS.length === 1 ? '' : 's'})` : 'Nueva solicitud');
    }
    if ($('sol_flow_text'))$('sol_flow_text').textContent = '';

    if (!canDetail && SOL_FLOW_TAB !== 'crear') setSolicitudTab('crear');
    if (canDetail && !canRevision && ['revision','pdf'].includes(SOL_FLOW_TAB)) setSolicitudTab('agregar');
    if (canRevision && !canPdf && SOL_FLOW_TAB === 'pdf') setSolicitudTab('revision');
  }

  function setSolicitudTab(tab){
    const canDetail = Boolean(SOL_DRAFT_ACTIVE || $('sol_user_id')?.value);
    const canRevision = DET_ROWS.length > 0;
    const canPdf = Boolean(SOL_ID);
    if (tab === 'agregar' && !canDetail){ toast('Completa primero el Paso 1'); return; }
    if (tab === 'revision' && !canRevision){ toast('Agrega por lo menos un producto en el Paso 2'); return; }
    if (tab === 'pdf' && !canPdf){ toast('Guarda la solicitud en el Paso 3 antes de descargar el PDF'); return; }
    
    SOL_FLOW_TAB = ['agregar','revision','pdf'].includes(tab) ? tab : 'crear';
    $('btn-sol-tab-crear')?.classList.toggle('active', SOL_FLOW_TAB === 'crear');$('btn-sol-tab-agregar')?.classList.toggle('active', SOL_FLOW_TAB === 'agregar');
    $('btn-sol-tab-revision')?.classList.toggle('active', SOL_FLOW_TAB === 'revision');$('btn-sol-tab-pdf')?.classList.toggle('active', SOL_FLOW_TAB === 'pdf');
    $('sol-pane-crear')?.classList.toggle('hidden', SOL_FLOW_TAB !== 'crear');$('sol-pane-agregar')?.classList.toggle('hidden', SOL_FLOW_TAB !== 'agregar');
    $('sol-pane-revision')?.classList.toggle('hidden', SOL_FLOW_TAB !== 'revision');$('sol-pane-pdf')?.classList.toggle('hidden', SOL_FLOW_TAB !== 'pdf');
    if (SOL_FLOW_TAB === 'revision') {
      enrichDetalleRows(DET_ROWS).then(() => renderFlowDetalleView());
    }
  }

  function resetSolicitudFlow({ stayInCaptura = true } = {}){
    SOL_ID = null; DET_SOL_ID = null; DET_ROWS = []; SOL_READY_FOR_PDF = false; CAPTURA_DIRTY = false;
    SOL_DRAFT = null; SOL_DRAFT_ACTIVE = false;
    if ($('tipo_solicitud'))$('tipo_solicitud').value = 'CONSUMIBLES';
    if ($('obs_sol'))$('obs_sol').value = '';
    if ($('busca_prod'))$('busca_prod').value = '';
    if ($('prod_sel'))$('prod_sel').innerHTML = `<option value="">- selecciona producto -</option>`;
    if ($('det_cant'))$('det_cant').value = '1';
    if ($('det_obs'))$('det_obs').value = '';
    if ($('sol_edit_id'))$('sol_edit_id').value = '';
    if ($('list_oficialia') && !uiPerms().solicitudes?.puedeSurtir) $('list_oficialia').value = String(CURRENT_USER?.id_oficialia || '');
    if ($('msg_sol'))$('msg_sol').textContent = '';
    if ($('msg_det'))$('msg_det').textContent = '';
    if ($('msg_lookup'))$('msg_lookup').textContent = '';
    if ($('msg_edit'))$('msg_edit').textContent = '';
    if ($('det_preview'))$('det_preview').innerHTML = 'Sin renglones.';
    if ($('sol_resumen'))$('sol_resumen').innerHTML = '';
    if ($('sol_consulta_detalle'))$('sol_consulta_detalle').innerHTML = '<div class="muted">Sin renglones.</div>';
    if ($('sol_detalle_box'))$('sol_detalle_box').innerHTML = '<div class="muted">Sin renglones.</div>';
    if ($('sol_detalle_badge'))$('sol_detalle_badge').textContent = 'Sin solicitud';
    if ($('sol_msg_detalle'))$('sol_msg_detalle').textContent = '';
    if ($('btn-list-consultar'))$('btn-list-consultar').disabled = true;
    if ($('btn-solicitudes-tab-consulta'))$('btn-solicitudes-tab-consulta').disabled = true;

    updateSolBadge();
    setSolicitudTab('crear');
    setSolicitudesTab('lista');
    if (stayInCaptura) showView('captura');
    applyPermassions();
  }

  function continuarAPaso2(){
    const uidIn  = $('sol_user_id');
    const uidVal = (uidIn && uidIn.value) ? Number(uidIn.value) : (CURRENT_USER?.id ?? null);
    const msg = $('msg_sol');
    if (!uidVal){
      toast('Área solicitante requerida');
      if (msg) msg.textContent = 'Selecciona el área solicitante';
      return;
    }
    const tipo = $('tipo_solicitud')?.value || 'CONSUMIBLES';
    const obs  = $('obs_sol')?.value?.trim() || '';

    SOL_DRAFT = {
      usuario_id: Number(uidVal),
      tipo_solicitud: tipo,
      observaciones: obs
    };
    SOL_DRAFT_ACTIVE = true;
    if (msg) msg.textContent = '';

    updateSolBadge();
    setSolicitudTab('agregar');
    toast('Paso 1 completado. Ahora agrega productos a la solicitud.');
  }

  const crearSolicitud = continuarAPaso2;

  async function buscarProductos(){
    const qInput = $('busca_prod');
    const q = qInput.value.trim();
    const msg = $('msg_det'); const sel =$('prod_sel');
    msg.textContent = 'Buscando...';
    sel.innerHTML = `<option value="">- selecciona producto -</option>`;
    try{
      let almRows = [];
      try {
        const ja = await apiJSON(`/api/almacen?q=${encodeURIComponent(q)}&page=1&limit=500`);
        almRows = ja.data || [];
      } catch {}

      almRows.forEach(r=>{
        const stock = r.STOCK ?? 0;
        const txt = `[ALM] ${r.CLAVE} - ${r.DESCRIPCION} [${r.CATEGORIA_NOMBRE ?? r.CATEGORIA ?? ''}] (stock:${stock})`;
        const opt = document.createElement('option');
        opt.value = r.CLAVE; opt.textContent = txt;
        opt.dataset.source = 'almacen';
        opt.dataset.clave = r.CLAVE || '';
        opt.dataset.desc = r.DESCRIPCION || '';
        opt.dataset.cat = r.CATEGORIA_NOMBRE || r.CATEGORIA || '';
        opt.dataset.unidad = r.UNIDAD || '';
        opt.dataset.prodId = r.producto_id || r.PRODUCTO_ID || '';
        opt.dataset.stock = String(stock);
        sel.appendChild(opt);
      });

      if (!almRows.length){
        try{
          const js = await apiJSON(`/api/stock?q=${encodeURIComponent(q)}&page=1&limit=500`);
          (js.data||[]).forEach(r=>{
            const stock = r.stock_almacen ?? r.stock_producto ?? r.exist_calc ?? 0;
            const txt = `[ALM] ${r.CLAVE} - ${r.DESCRIPCION} [${r.categoria ?? ''}] (stock:${stock})`;
            const opt = document.createElement('option');
            opt.value = r.CLAVE; opt.textContent = txt;
            opt.dataset.source = 'almacen';
            opt.dataset.clave = r.CLAVE || '';
            opt.dataset.desc = r.DESCRIPCION || '';
            opt.dataset.cat = r.categoria || '';
            opt.dataset.unidad = r.unidad || '';
            opt.dataset.prodId = r.producto_id || '';
            opt.dataset.stock = String(stock);
            sel.appendChild(opt);
          });
        }catch{}
      }

      if (sel.options.length <= 1){
        try{
          const jp = await apiJSON(`/api/productos?q=${encodeURIComponent(q)}&page=1&limit=500`);
          (jp.data||[]).forEach(p=>{
            const txt = `[PROD] ${p.CLAVE} - ${p.DESCRIPCION} ${p.unidad?('('+p.unidad+')'):''}`;
            const opt = document.createElement('option');
            opt.value = p.CLAVE || p.producto_id; opt.textContent = txt;
            opt.dataset.source = 'producto';
            opt.dataset.prodId = p.producto_id || '';
            opt.dataset.clave = p.CLAVE || '';
            opt.dataset.desc = p.DESCRIPCION || p.descripcion || '';
            opt.dataset.cat = p.CATEGORIA_NOMBRE || p.categoria_nombre || p.CATEGORIA || p.categoria || '';
            opt.dataset.unidad = p.UNIDAD || p.unidad || '';
            sel.appendChild(opt);
          });
        }catch{}
      }

      const total = sel.options.length - 1;
      sel.selectedIndex = 0;
      msg.textContent = `${total} resultado${total===1?'':'s'}`;
    }catch(e){ msg.textContent = e.message || 'Error'; if (!handleAuthError(e)) toast(e.message || 'Error'); }
  }

  function agregarDetalle(){
    const uidIn = $('sol_user_id');
    if (!SOL_DRAFT_ACTIVE && !(uidIn && uidIn.value)){
      toast('Completa primero el Paso 1');
      setSolicitudTab('crear');
      return;
    }
    const sel = $('prod_sel');
    const opt = sel?.selectedOptions?.[0];
    const cant = Number($('det_cant')?.value || '1');
    const obs  = $('det_obs')?.value?.trim() || null;
    const msg  = $('msg_det');

    if (!opt || !opt.value){ toast('Selecciona un producto'); return; }
    if (!(cant > 0)){ toast('Cantidad inválida (debe ser mayor a 0)'); return; }

    const clave = opt.dataset.clave || opt.value;
    const desc = opt.dataset.desc || opt.text || clave;
    const cat = opt.dataset.cat || '';
    const unidad = opt.dataset.unidad || '';
    const prodId = opt.dataset.prodId ? Number(opt.dataset.prodId) : null;

    // Verificar si el producto ya fue agregado a la lista en memoria
    const existingIdx = DET_ROWS.findIndex(r => (clave && r.clave === clave) || (prodId && r.producto_id === prodId));
    if (existingIdx >= 0) {
      DET_ROWS[existingIdx].cantidad = Number(DET_ROWS[existingIdx].cantidad || 0) + cant;
      if (obs) {
        DET_ROWS[existingIdx].observaciones = (DET_ROWS[existingIdx].observaciones ? DET_ROWS[existingIdx].observaciones + '; ' : '') + obs;
      }
      toast(`Cantidad actualizada para ${clave} (+${cant})`, true);
    } else {
      DET_ROWS.push({
        temp_id: `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        producto_id: prodId,
        clave: clave,
        descripcion: desc,
        categoria: cat,
        unidad: unidad,
        cantidad: cant,
        atendida: 0,
        observaciones: obs
      });
      toast(`Producto ${clave} agregado`, true);
    }

    if (msg) msg.textContent = `${DET_ROWS.length} producto(s) en lista`;
    renderDetallePreviewFromRows();
    updateSolBadge();

    // Limpiar campos para el siguiente producto
    if ($('busca_prod')) $('busca_prod').value = '';
    if ($('det_cant')) $('det_cant').value = '1';
    if ($('det_obs')) $('det_obs').value = '';
    if ($('prod_sel')) $('prod_sel').innerHTML = `<option value="">- selecciona producto -</option>`;
  }

  // --- Funciones de Datos Globales ---
  const UNIDAD_BY_CLAVE    = new Map();
  const CATEGORIA_BY_CLAVE = new Map();
  let ALM_LAST_ROWS = [];
  let ALM_UNIDAD_IS_SELECT = false;
  let ALM_EDIT_ID = null;
  let ALM_CATS = [];
  let ALM_CAT_IS_SELECT = true;
  let ALM_UNI_OPTIONS = [];
  const ALM_DEFAULT_UNIDADES = ['BLOCK','PIEZA','PIEZAS','CAJA','PAQUETE','ROLLO','METRO','JUEGO','PAR','BOLSA','KILO','LITRO','UNIDAD'];
  const PRODUCTO_CACHE     = new Map(); 
  const ALMACEN_CACHE      = new Map(); 
  const CATEGORIA_NOMBRE_BY_ID = new Map(); 

  function extractClave(r) {
    const raw = r?.CLAVE ?? r?.clave ?? r?.PRODUCTO_CLAVE ?? r?.producto_clave ?? r?.CLAVE_PRODUCTO ?? r?.clave_producto ?? '';
    return norm(safestr(raw));
  }
  function extractProdId(r){ return r.producto_id ?? r.PRODUCTO_ID ?? r.id_producto ?? r.ID_PRODUCTO ?? null; }
  function extractAlmId(r){ return r.almacen_id ?? r.ALMACEN_ID ?? r.id_almacen ?? r.ID_ALMACEN ?? null; }
  function nombreCategoriaFromRow(r){
    const cNom = r.CATEGORIA_NOMBRE ?? r.categoria_nombre;
    if (safestr(cNom)) return safestr(cNom);
    const cVal = r.categoria ?? r.CATEGORIA ?? r.categoria_id ?? r.CATEGORIA_ID;
    if (!safestr(cVal)) return '';
    if (!isNum(cVal)) return safestr(cVal);
    return safestr(CATEGORIA_NOMBRE_BY_ID.get(Number(cVal)));
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
    }catch(e){}
  }

  async function getAlmacenById(id){
    if (!id) return null;
    if (ALMACEN_CACHE.has(id)) return ALMACEN_CACHE.get(id);
    if (!(await hasRoute('GET','/api/almacen/:id'))) return null;
    try{ const j = await apiJSON(`/api/almacen/${id}`); ALMACEN_CACHE.set(id, j?.data||null); return j?.data||null; }catch{ return null; }
  }

  async function getProductoById(id){
    if (!id) return null;
    if (PRODUCTO_CACHE.has(id)) return PRODUCTO_CACHE.get(id);
    if (await hasRoute('GET','/api/productos/:id')){
      try{ const j = await apiJSON(`/api/productos/${id}`); PRODUCTO_CACHE.set(id, j?.data||null); return j?.data||null; }catch{}
    }
    if (await hasRoute('GET','/api/productos')){
      try{ const jq = await apiJSON(`/api/productos?q=${encodeURIComponent(id)}&limit=1&page=1`); PRODUCTO_CACHE.set(id, (jq.data||[])[0]||null); return (jq.data||[])[0]||null; }catch{}
    }
    return null;
  }

  async function getCategoriaNombreById(id){
    if (!isNum(id)) return '';
    const nId = Number(id);
    if (CATEGORIA_NOMBRE_BY_ID.has(nId)) return CATEGORIA_NOMBRE_BY_ID.get(nId) || '';
    if (await hasRoute('GET','/api/categorias')){
      try{
        const j = await apiJSON('/api/categorias'); 
        (j?.data||[]).forEach(c=>{ if (isNum(c.id)) CATEGORIA_NOMBRE_BY_ID.set(Number(c.id), safestr(c.nombre)); });
        return CATEGORIA_NOMBRE_BY_ID.get(nId) || '';
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
    for (const id of ids){ await getCategoriaNombreById(id); }
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
          if (safestr(row.UNIDAD)) unidad = String(row.UNIDAD);
          if (safestr(row.CATEGORIA_NOMBRE)) categoria = String(row.CATEGORIA_NOMBRE);
        }
      }catch{}
    }
    if ((!unidad || !categoria) && await hasRoute('GET','/api/productos')){
      try{
        const j = await apiJSON(`/api/productos?q=${encodeURIComponent(k)}&limit=5&page=1`);
        const rec = (j.data||[]).find(r => norm(r.CLAVE||'')===k) || (j.data||[])[0];
        if (rec){
          if (safestr(rec.UNIDAD)) unidad = String(rec.UNIDAD);
          if (safestr(rec.CATEGORIA_NOMBRE)) categoria = String(rec.CATEGORIA_NOMBRE);
        }
      }catch{}
    }
    if (unidad) UNIDAD_BY_CLAVE.set(k, unidad);
    if (categoria) CATEGORIA_BY_CLAVE.set(k, categoria);
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
        const alm = await getAlmacenById(extractAlmId(r));
        if (alm){
          if (!unidad) unidad = safestr(alm.UNIDAD);
          if (!categoria) categoria = safestr(alm.CATEGORIA_NOMBRE);
        }
      }
      if ((!unidad || !categoria)){
        const prod = await getProductoById(extractProdId(r));
        if (prod){
          if (!unidad) unidad = safestr(prod.UNIDAD);
          if (!categoria) categoria = safestr(prod.CATEGORIA_NOMBRE);
          if (!categoria_id) categoria_id = prod.categoria_id;
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

  function buildDetalleTableHtml(rows, saveButtonId){
    const puedeSurtir = Boolean(uiPerms().solicitudes?.puedeSurtir);
    if (!puedeSurtir) {
      return `
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>CLAVE</th>
                <th>Descripción</th>
                <th>Categoría</th>
                <th>Unidad</th>
                <th>Solicitada</th>
                <th>Observaciones</th>
                <th style="width:70px; text-align:center;">Quitar</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((r, idx)=>{
                const detId = r.detalle_id ?? r.DETALLE_ID ?? r.temp_id ?? `tmp_${idx}`;
                const clave = extractClave(r);
                const desc  = r.DESCRIPCION ?? r.descripcion ?? r.producto ?? '';
                const cat   = nombreCategoriaFromRow(r) || safestr(r.categoria) || safestr(r.CATEGORIA) || '';
                const uni   = safestr(r.unidad ?? r.UNIDAD);
                const cant  = Number(r.cantidad ?? r.CANTIDAD ?? 0) || 0;
                const obs   = safestr(r.observaciones ?? r.OBSERVACIONES) || '-';
                return `
                  <tr data-det="${detId}" data-index="${idx}">
                    <td><b>${clave}</b></td>
                    <td>${desc}</td>
                    <td>${cat}</td>
                    <td>${uni}</td>
                    <td><b>${cant}</b></td>
                    <td>${obs}</td>
                    <td style="text-align:center;">
                      <button type="button" class="btn-del-det-row" data-index="${idx}" style="color:var(--danger, #ef4444); border:1px solid #fca5a5; background:transparent; padding:2px 8px; border-radius:4px; cursor:pointer;" title="Eliminar este producto">&times;</button>
                    </td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <div class="actions" style="margin-top:1rem; display:flex; gap:10px; align-items:center;">
          <button class="btn-primary" id="${saveButtonId}" type="button">Guardar solicitud</button>
        </div>
      `;
    }

    return `
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>CLAVE</th>
              <th>Descripción</th>
              <th>Categoría</th>
              <th>Unidad</th>
              <th>Solicitada</th>
              <th>Atendida</th>
              <th>Observaciones</th>
              <th style="width:70px; text-align:center;">Quitar</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r, idx)=>{
              const detId = r.detalle_id ?? r.DETALLE_ID ?? r.temp_id ?? `tmp_${idx}`;
              const clave = extractClave(r);
              const desc  = r.DESCRIPCION ?? r.descripcion ?? r.producto ?? '';
              const cat   = nombreCategoriaFromRow(r) || safestr(r.categoria) || safestr(r.CATEGORIA) || '';
              const uni   = safestr(r.unidad ?? r.UNIDAD);
              const cant  = Number(r.cantidad ?? r.CANTIDAD ?? 0) || 0;
              const atend = (r.atendida ?? r.ATENDIDA ?? '');
              const obs   = (r.observaciones ?? r.OBSERVACIONES ?? '');
              return `
                <tr data-det="${detId}" data-index="${idx}">
                  <td><b>${clave}</b></td>
                  <td>${desc}</td>
                  <td>${cat}</td>
                  <td>${uni}</td>
                  <td><b>${cant}</b></td>
                  <td><input class="mini-in in-atendida" type="number" min="0" max="${cant}" value="${atend}"></td>
                  <td><input class="mini-in in-obs" type="text" value="${obs}"></td>
                  <td style="text-align:center;">
                    <button type="button" class="btn-del-det-row" data-index="${idx}" style="color:var(--danger, #ef4444); border:1px solid #fca5a5; background:transparent; padding:2px 8px; border-radius:4px; cursor:pointer;" title="Eliminar este producto">&times;</button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="actions" style="margin-top:1rem; display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn-primary" id="${saveButtonId}" type="button">Guardar solicitud</button>
      </div>
    `;
  }

  function buildConsultaDetalleHtml(rows){
    if (!rows?.length) return '<div class="muted">Sin renglones.</div>';
    const p = uiPerms();
    const puedeSurtir = p.solicitudes?.puedeSurtir && norm(CONSULTA_STATUS) !== 'CANCELADA';

    return `
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>CLAVE</th>
              <th>Descripción</th>
              <th>Categoría</th>
              <th>Unidad</th>
              <th>Solicitada</th>
              <th>Entregada</th>
              <th>Observaciones</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r=>{
              const detId = r.detalle_id ?? r.DETALLE_ID ?? r.id ?? r.ID ?? '';
              const clave = extractClave(r) || '-';
              const desc  = r.DESCRIPCION ?? r.descripcion ?? r.producto ?? '-';
              const cat   = nombreCategoriaFromRow(r) || safestr(r.categoria) || safestr(r.CATEGORIA) || '-';
              const uni   = safestr(r.unidad ?? r.UNIDAD) || '-';
              const cant  = Number(r.cantidad ?? r.CANTIDAD ?? 0) || 0;
              const rawAtend = Number(r.atendida ?? r.ATENDIDA ?? 0) || 0;
              const defaultAtend = (norm(CONSULTA_STATUS) === 'PENDIENTE' && rawAtend === 0) ? cant : rawAtend;
              const obs   = safestr(r.observaciones ?? r.OBSERVACIONES) || '';

              if (puedeSurtir) {
                return `<tr data-det="${detId}">
                  <td><b>${clave}</b></td>
                  <td>${desc}</td>
                  <td>${cat}</td>
                  <td>${uni}</td>
                  <td><b>${cant}</b></td>
                  <td><input class="mini-in" type="number" min="0" max="${cant}" value="${defaultAtend}"></td>
                  <td><input class="mini-in" type="text" value="${obs}" placeholder="Opcional" style="max-width:200px;"></td>
                </tr>`;
              }
              return `<tr>
                <td><b>${clave}</b></td>
                <td>${desc}</td>
                <td>${cat}</td>
                <td>${uni}</td>
                <td>${cant}</td>
                <td>${rawAtend}</td>
                <td>${obs || '-'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      ${puedeSurtir ? `
        <div style="margin-top:14px; display:flex; gap:10px; align-items:center; justify-content:flex-end;">
          <button class="btn-primary" id="btn-aprobar-surtir-consulta" type="button">
            Aceptar y Surtir Orden (Descontar Inventario)
          </button>
        </div>
      ` : ''}
    `;
  }

  function renderDetallePreviewFromRows(){
    const box = $('det_preview');
    if (!box) return;
    if (!DET_ROWS.length){ box.innerHTML = 'Sin renglones.'; return; }
    box.innerHTML = `
      <div style="font-weight:600; margin-bottom:8px; color:var(--text-strong, #333);">Productos agregados (${DET_ROWS.length}):</div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        ${DET_ROWS.map((r, idx) => {
          const clave = extractClave(r);
          const desc = r.DESCRIPCION ?? r.descripcion ?? r.producto ?? 'Item';
          const cant = Number(r.cantidad ?? r.CANTIDAD ?? 0) || 0;
          const uni = safestr(r.unidad ?? r.UNIDAD);
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; background:var(--card-bg, #fff); padding:6px 10px; border-radius:6px; border:1px solid var(--border);">
              <span><b>${clave ? `${clave} - ` : ''}</b>${desc} &times; <b>${cant}</b> ${uni ? `(${uni})` : ''}</span>
              <button type="button" class="btn-del-preview-row" data-index="${idx}" style="color:var(--danger, #ef4444); background:transparent; border:none; cursor:pointer; font-weight:bold; font-size:16px; line-height:1;" title="Eliminar">&times;</button>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function setSolicitudesTab(tab) {
    const hasConsulta = Boolean($('btn-solicitudes-tab-consulta') && !$('btn-solicitudes-tab-consulta').disabled);
    SOLICITUDES_TAB = (tab === 'consulta' && hasConsulta) ? 'consulta' : 'lista';
    
    $('btn-solicitudes-tab-lista')?.classList.toggle('active', SOLICITUDES_TAB === 'lista');
    $('btn-solicitudes-tab-consulta')?.classList.toggle('active', SOLICITUDES_TAB === 'consulta');
    
    const paneLista = $('solicitudes-pane-lista');
    const paneConsulta = $('solicitudes-pane-consulta');

    if (SOLICITUDES_TAB === 'lista') {
        if (paneLista) { paneLista.classList.remove('hidden'); paneLista.style.display = 'block'; }
        if (paneConsulta) { paneConsulta.classList.add('hidden'); paneConsulta.style.display = 'none'; }
        updateSolicitudActionsVisibility('');
    } else {
        if (paneLista) { paneLista.classList.add('hidden'); paneLista.style.display = 'none'; }
        if (paneConsulta) { paneConsulta.classList.remove('hidden'); paneConsulta.style.display = 'block'; }
        updateSolicitudActionsVisibility(CONSULTA_STATUS);
    }
  }

  function renderFlowDetalleView(filterText=''){
    const box = $('sol_detalle_box'), badge = $('sol_detalle_badge'), msg = $('sol_msg_detalle');
    if (!box) return;
    const txt = (filterText||'').toLowerCase();
    const rows = !txt ? DET_ROWS : DET_ROWS.filter(r => Object.values(r).some(v => String(v??'').toLowerCase().includes(txt)));
    if (!rows.length){
      box.innerHTML = '<div class="muted">Sin renglones. Agrega productos en el Paso 2.</div>';
      if (badge) badge.textContent = SOL_ID ? `Solicitud guardada (#${SOL_ID})` : 'Borrador * 0 productos';
      if (msg) msg.textContent = '';
      return;
    }
    box.innerHTML = buildDetalleTableHtml(rows, 'btn-sol-save-detalle');
    if (badge) badge.textContent = SOL_ID ? `Solicitud guardada (#${SOL_ID}) * ${rows.length} renglones` : `Borrador * ${rows.length} producto${rows.length===1?'':'s'} por guardar`;
    if (msg) msg.textContent = '';
  }

  async function refreshActiveSolicitudData(){
    if (!SOL_ID) return;
    const resDetalle = await apiJSON(`/api/solicitudes/${SOL_ID}/detalle`);
    DET_ROWS = Array.isArray(resDetalle?.data) ? resDetalle.data : (Array.isArray(resDetalle) ? resDetalle : []);
    DET_SOL_ID = SOL_ID;
    if (DET_ROWS.length > 0) SOL_READY_FOR_PDF = true;
    await enrichDetalleRows(DET_ROWS);
    renderDetallePreviewFromRows();
    renderFlowDetalleView();
    updateSolBadge();
  }

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

      const p = uiPerms();
      const tieneRespaldo = Boolean(d.archivo_respaldo);
      const puedeSurtir = p.solicitudes?.puedeSurtir || false;
      
      if ($('btn-sol-ver-respaldo')) $('btn-sol-ver-respaldo').classList.toggle('hidden', !tieneRespaldo);
      if ($('respaldo-consulta-card')) $('respaldo-consulta-card').classList.toggle('hidden', !puedeSurtir && !tieneRespaldo);

      const idSol = d.id ?? d.ID ?? d.solicitud_id ?? d.SOLICITUD_ID ?? id;
      const ofiNom = d.oficialia_nombre || d.usuario?.oficialia_nombre || null;
      const oficialia = ofiNom || (d.id_oficialia ?? d.ID_OFICIALIA ?? d.oficialia ?? d.OFICIALIA ?? '-');
      const fechaFmt = fmtDate(d.fecha_solicitud ?? d.FECHA ?? d.fecha ?? d.fecha_creacion ?? d.created_at ?? null);
      const userPrimary = pickUsuario(d);
      const userNested = pickUsuario(d.usuario || {});
      const usuario = safestr(
        d.solicitante_display || d.SOLICITANTE_DISPLAY || d.usuario?.nombre_completo ||
        (userPrimary !== '-' ? userPrimary : '') || (userNested !== '-' ? userNested : '') ||
        d.nombre_usuario || d.NOMBRE_USUARIO || d.usuario_nombre || d.USUARIO ||
        d.solicitante || d.SOLICITANTE || d.username || d.USERNAME ||
        d.usuario?.username || CURRENT_USER?.username || '-'
      );
      const observ  = d.observaciones || d.OBSERVACIONES || '-';
      const tipo = d.tipo_solicitud || d.TIPO || '-';
      const status = d.status || d.STATUS || '-';

      const resDetalle = await apiJSON(`/api/solicitudes/${id}/detalle`);
      const consultaRows = Array.isArray(resDetalle?.data) ? resDetalle.data : (Array.isArray(resDetalle) ? resDetalle : []);
      DET_SOL_ID = idSol;
      CONSULTA_STATUS = status;
      setListadoSelectedId(idSol);
      updateSolicitudActionsVisibility(status);
      if ($('sol_edit_id')) $('sol_edit_id').value = String(idSol);

      await enrichDetalleRows(consultaRows);

      let productoLinea = '-';
      if (consultaRows.length){
        const r0 = consultaRows[0];
        const clave = extractClave(r0);
        const desc  = r0.DESCRIPCION ?? r0.descripcion ?? r0.producto ?? '';
        productoLinea = `${clave ? (clave + ' - ') : ''}${desc || 'Producto'}` + (consultaRows.length > 1 ? `  (+${consultaRows.length - 1} mas)` : '');
      }
      const totalQty = consultaRows.reduce((acc, r) => acc + (Number(r.cantidad ?? r.CANTIDAD ?? 0) || 0), 0);
      const totalAtendido = consultaRows.reduce((acc, r) => acc + (Number(r.atendida ?? r.ATENDIDA ?? 0) || 0), 0);

      const box = $('sol_resumen');
      if (box){
        box.innerHTML = `
          <div class="item"><div class="label">Folio</div><div class="value">#${idSol}</div></div>
          <div class="item"><div class="label">Fecha</div><div class="value">${fechaFmt}</div></div>
          <div class="item"><div class="label">Usuario solicitante</div><div class="value">${usuario}</div></div>
          <div class="item"><div class="label">Departamento</div><div class="value">${oficialia}</div></div>
          <div class="item"><div class="label">Tipo</div><div class="value">${tipo}</div></div>
          <div class="item"><div class="label">Estatus</div><div class="value">${status}</div></div>
          <div class="item"><div class="label">Renglones</div><div class="value">${consultaRows.length}</div></div>
          <div class="item span-2"><div class="label">Resumen</div><div class="value">${productoLinea}</div></div>
          <div class="item"><div class="label">Cantidad solicitada</div><div class="value">${totalQty}</div></div>
          <div class="item"><div class="label">Cantidad atendida</div><div class="value">${totalAtendido}</div></div>
          <div class="item span-2"><div class="label">Observaciones</div><div class="value">${observ}</div></div>
        `;
      }
      if ($('sol_consulta_detalle')) $('sol_consulta_detalle').innerHTML = buildConsultaDetalleHtml(consultaRows);
      if ($('btn-solicitudes-tab-consulta')) $('btn-solicitudes-tab-consulta').disabled = false;
      setSolicitudesTab('consulta');

      msg.textContent = 'Listo'; toast('Resumen cargado', true);
    }catch(e){
      msg.textContent = e.message;
      if ($('sol_consulta_detalle')) $('sol_consulta_detalle').innerHTML = '<div class="muted">Sin renglones.</div>';
      DET_SOL_ID = null; CONSULTA_STATUS = '';
      updateSolicitudActionsVisibility('');
      if ($('btn-solicitudes-tab-consulta')) $('btn-solicitudes-tab-consulta').disabled = true;
      setSolicitudesTab('lista');
      if (!handleAuthError(e)) toast(e.message);
    }
  }

  async function guardarSolicitudEnPaso3(){
    const msg = $('sol_msg_detalle');
    if (!DET_ROWS.length){
      toast('Agrega por lo menos un producto antes de guardar la solicitud');
      if (msg) msg.textContent = 'Agrega productos en el Paso 2';
      return;
    }

    const uidIn = $('sol_user_id');
    const uidVal = (uidIn && uidIn.value) ? Number(uidIn.value) : (SOL_DRAFT?.usuario_id || CURRENT_USER?.id);
    if (!uidVal){
      toast('Área solicitante requerida');
      return;
    }

    const tipo = $('tipo_solicitud')?.value || SOL_DRAFT?.tipo_solicitud || 'CONSUMIBLES';
    const obs  = $('obs_sol')?.value?.trim() || SOL_DRAFT?.observaciones || null;

    // Sincronizar cambios en campos Atendida u Observaciones si el usuario tiene permiso
    const tableRows = $('sol_detalle_box')?.querySelectorAll('tbody tr') || [];
    tableRows.forEach(tr => {
      const idx = Number(tr.dataset.index);
      if (Number.isFinite(idx) && DET_ROWS[idx]) {
        const inAtendida = tr.querySelector('.in-atendida');
        const inObs = tr.querySelector('.in-obs');
        if (inAtendida) {
          const atVal = Number(inAtendida.value || 0);
          if (Number.isFinite(atVal) && atVal >= 0) DET_ROWS[idx].atendida = atVal;
        }
        if (inObs) {
          DET_ROWS[idx].observaciones = inObs.value || DET_ROWS[idx].observaciones;
        }
      }
    });

    const itemsPayload = DET_ROWS.map(r => ({
      producto_id: r.producto_id || null,
      clave: extractClave(r),
      cantidad: Number(r.cantidad || 0),
      atendida: Number(r.atendida || 0),
      observaciones: r.observaciones || null
    }));

    if (msg) msg.textContent = 'Guardando solicitud en el sistema...';
    const saveBtn = $('btn-sol-save-detalle');
    if (saveBtn) saveBtn.disabled = true;

    try {
      const res = await apiJSON('/api/solicitudes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          usuario_id: uidVal,
          tipo_solicitud: tipo,
          observaciones: obs,
          items: itemsPayload
        })
      });

      if (!res?.ok || !res?.solicitud_id) {
        throw new Error(res?.error || 'No se pudo crear la solicitud');
      }

      SOL_ID = res.solicitud_id;
      DET_SOL_ID = SOL_ID;
      SOL_READY_FOR_PDF = true;
      CAPTURA_DIRTY = false;

      if ($('sol_edit_id')) $('sol_edit_id').value = String(SOL_ID);
      if (msg) msg.textContent = `Solicitud #${SOL_ID} guardada con éxito`;

      toast(`Solicitud #${SOL_ID} guardada exitosamente`, true);

      updateSolBadge();

      const pdfSuccessText = $('sol_pdf_success_text');
      if (pdfSuccessText) {
        pdfSuccessText.textContent = `La solicitud #${SOL_ID} ha sido registrada con éxito en el sistema. Ahora puedes descargar el vale oficial en PDF para recabar firmas.`;
      }

      setSolicitudTab('pdf');
    } catch (e) {
      if (msg) msg.textContent = e.message || 'Error al guardar solicitud';
      if (!handleAuthError(e)) toast(e.message || 'Error al guardar solicitud', false);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function guardarTodoDetalle(containerId='sol_detalle_box', { goToPdf = false } = {}){
    if (!uiPerms().solicitudes?.puedeSurtir){
      SOL_READY_FOR_PDF = true;
      updateSolBadge();
      if (goToPdf) setSolicitudTab('pdf');
      return;
    }
    const targetSolId = containerId === 'sol_detalle_box' ? (SOL_ID || DET_SOL_ID) : (DET_SOL_ID || SOL_ID);
    if (!targetSolId){ toast('Sin solicitud activa', false); return; }
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
      if (msg) msg.textContent = 'Faltan datos de detalle'; toast('Faltan datos de detalle', false); return;
    }
    if (payload.some(item => !Number.isFinite(item.atendida) || item.atendida < 0)){
      if (msg) msg.textContent = 'Cantidad atendida invalida'; toast('Cantidad atendida invalida', false); return;
    }
    if (payload.some(item => item.atendida > item.max_atendida)){
      if (msg) msg.textContent = 'Atendida no puede ser mayor que solicitada'; toast('Atendida no puede ser mayor que solicitada', false); return;
    }

    const hasBulk = await hasRoute('PATCH','/api/solicitudes/:id/detalles');
    try{
      if (hasBulk){
        await apiJSON(`/api/solicitudes/${targetSolId}/detalles`, {
          method:'PATCH', headers:{'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });
        SOL_READY_FOR_PDF = true;
        if (SOL_ID && String(SOL_ID) === String(targetSolId)) await refreshActiveSolicitudData();
        if (msg) msg.textContent = 'Detalle guardado';
        if (goToPdf) setSolicitudTab('pdf');
        toast('Detalle guardado', true);
        return;
      }
      throw new Error('bulk-patch-not-supported');
    }catch(e){
      try{
        for (const item of payload){
          await apiJSON(`/api/solicitudes/${targetSolId}/detalles/${item.detalle_id}`, {
            method:'PATCH', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ atendida: item.atendida, observaciones: item.observaciones })
          });
        }
        SOL_READY_FOR_PDF = true;
        if (SOL_ID && String(SOL_ID) === String(targetSolId)) await refreshActiveSolicitudData();
        if (msg) msg.textContent = 'Detalle guardado';
        if (goToPdf) setSolicitudTab('pdf');
        toast('Detalle guardado', true);
      }catch(e2){
        const detail = e2?.message || e?.message || 'No se pudo guardar el detalle';
        if (msg) msg.textContent = detail;
        toast(detail, false);
      }
    }
  }

  function renderSolicitudesListado(rows){
    if (!rows?.length) return '<div class="muted">Sin resultados.</div>';
    const head = `
      <thead><tr>
        <th>Folio</th><th>Fecha</th><th>Usuario Solicitante</th><th>Tipo</th><th>Departamento</th><th>Estatus</th>
      </tr></thead>`;
    const body = rows.map(r=>{
      const id   = r.id ?? r.ID ?? r.solicitud_id ?? r.SOLICITUD_ID ?? '-';
      const fraw = r.fecha_solicitud ?? r.FECHA ?? r.fecha;
      const fec  = fmtDate(fraw);
      const usr  = pickUsuario(r);
      const tipo = r.tipo_solicitud ?? r.TIPO ?? '-';
      const ofi  = r.oficialia_nombre ?? r.OFICIALIA_NOMBRE ?? r.id_oficialia ?? r.ID_OFICIALIA ?? '-';
      const status = String(r.status ?? r.STATUS ?? '-').toUpperCase();
      let badgeClass = 'status-pendiente';
      if (['APROBADA', 'SURTIDA', 'ENTREGADA'].includes(status)) badgeClass = 'status-aprobada';
      if (['CANCELADA', 'CANCELADO', 'RECHAZADA'].includes(status)) badgeClass = 'status-cancelada';

      return `<tr data-sol-id="${id}">
        <td><b>#${id}</b></td><td>${fec}</td><td>${usr}</td><td>${tipo}</td><td>${ofi}</td>
        <td><span class="status-badge ${badgeClass}">${status}</span></td>
      </tr>`;
    }).join('');
    return `<div class="table-scroll"><table>${head}<tbody>${body}</tbody></table></div>`;
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
      box.innerHTML = '<div class="muted">Error al cargar.</div>';
      msg.textContent = e.message || 'Error'; if (!handleAuthError(e)) toast(e.message || 'Error');
    }
  }

  async function cancelarSolicitud(){
    const p = uiPerms();
    if (!p.solicitudes?.puedeCancelar){ toast('No tienes permiso para cancelar solicitudes', false); return; }
    const id = String($('sol_edit_id')?.value || LIST_SELECTED_ID || DET_SOL_ID || '').trim();
    const msg = $('msg_edit');
    if (!id){ toast('Selecciona una solicitud'); return; }
    if (!confirm('¿Cancelar la solicitud seleccionada?')) return;
    msg.textContent = 'Cancelando...';
    try{
      const j = await apiJSON(`/api/solicitudes/${id}/status`, {
        method:'PATCH', headers:{'Content-Type':'application/json'},
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
      msg.textContent = e.message || 'Error'; if (!handleAuthError(e)) toast(e.message || 'Error');
    }
  }

  async function eliminarSolicitud(){
    const p = uiPerms();
    if (!p.solicitudes?.puedeEliminar){ toast('Eliminar solo Admin', false); return; }
    const id = $('sol_edit_id').value.trim();
    const msg = $('msg_edit');
    if (!id){ toast('Selecciona una solicitud'); return; }
    if (!confirm('¿Eliminar la solicitud seleccionada? Esta accion no se puede deshacer.')) return;
    msg.textContent = 'Eliminando...';
    try{
      const j = await apiJSON(`/api/solicitudes/${id}`, { method:'DELETE' });
      msg.textContent = j.deleted ? 'Solicitud eliminada' : 'No se encontro la solicitud';
      toast('Eliminada', true);
    }catch(e){ msg.textContent = e.message || 'Error'; if (!handleAuthError(e)) toast(e.message || 'Error'); }
  }

  function ensureUnidadInput(){
    const el = $('alm_unidad'); if (!el) return null;
    if (el.tagName.toLowerCase() === 'input') return el;
    const parent = el.parentElement;
    const val = el.value || '';
    const disabled = !!el.disabled;
    const readOnly = !!el.readOnly;
    const isReadonly = el.classList.contains('readonly');
    const input = document.createElement('input');
    input.id = 'alm_unidad'; input.placeholder = 'Ej. PIEZA, CAJA, METRO'; input.value = val;
    input.disabled = disabled; input.readOnly = readOnly;
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
    (rows || []).forEach(r => { const u = safestr(r.UNIDAD ?? r.unidad); if (u) vals.add(u); });
    UNIDAD_BY_CLAVE.forEach(v => { if (safestr(v)) vals.add(String(v)); });
    ALM_UNI_OPTIONS = Array.from(vals).sort();
    if (ALM_UNI_OPTIONS.length === 0){ ensureUnidadInput(); return; }
    const sel = ensureUnidadSelect(); if (!sel) return;
    sel.innerHTML = `<option value="">- seleccionar -</option>` + ALM_UNI_OPTIONS.map(u => `<option value="${u}">${u}</option>`).join('');
    sel.value = '';
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
    input.id = 'alm_cat'; input.placeholder = 'Categoria'; input.value = currentText === '- seleccionar -' ? '' : currentText;
    input.disabled = disabled; input.readOnly = readOnly;
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
    (rows || []).forEach(r => { const c = nombreCategoriaFromRow(r) || safestr(r.CATEGORIA_NOMBRE ?? r.categoria_nombre ?? r.CATEGORIA ?? r.categoria); if (c) vals.add(c); });
    CATEGORIA_BY_CLAVE.forEach(v => { if (safestr(v)) vals.add(String(v)); });
    CATEGORIA_NOMBRE_BY_ID.forEach(v => { if (safestr(v)) vals.add(String(v)); });
    if (vals.size === 0 && await hasRoute('GET','/api/productos')){
      try{
        const j = await apiJSON('/api/productos?q=&limit=500&page=1');
        (j.data || []).forEach(r => { const c = safestr(r.CATEGORIA_NOMBRE ?? r.categoria_nombre ?? r.CATEGORIA ?? r.categoria); if (c) vals.add(c); });
      }catch{}
    }
    const list = Array.from(vals).sort((a,b) => a.localeCompare(b));
    if (!list.length){ ensureCategoriaInput(); return; }
    const sel = ensureCategoriaSelect(); if (!sel) return;
    sel.innerHTML = `<option value="">- seleccionar -</option>` + list.map(c => `<option value="${c}">${c}</option>`).join('');
    ALM_CAT_IS_SELECT = true;
    if (ALM_EDIT_ID) onlyQtyEnabled();
  }

  async function loadCategorias(){
    const el = $('alm_cat'); if (!el) return;
    try{
      if (!(await hasRoute('GET','/api/categorias'))){ await updateCategoriaFallbackOptions(ALM_LAST_ROWS); return; }
      const j = await apiJSON('/api/categorias');
      if (!Array.isArray(j.data)) throw new Error('sin data');
      ALM_CATS = j.data;
      if (!ALM_CATS.length){ await updateCategoriaFallbackOptions(ALM_LAST_ROWS); return; }
      const selNow = ensureCategoriaSelect();
      if (!selNow) return;
      selNow.innerHTML = `<option value="">- seleccionar -</option>` + ALM_CATS.map(c => `<option value="${c.id}">${c.nombre}</option>`).join('');
      ALM_CAT_IS_SELECT = true;
      if (ALM_EDIT_ID) onlyQtyEnabled();
      ALM_CATS.forEach(c=>{ if (isNum(c.id)) CATEGORIA_NOMBRE_BY_ID.set(Number(c.id), safestr(c.nombre)); });
    }catch{
      await updateCategoriaFallbackOptions(ALM_LAST_ROWS);
    }
  }
  let ALM_NEXT_CLAVE = '';
  function computeNextClave(rows = ALM_LAST_ROWS){
    let maxNum = 0;
    (rows || []).forEach(r => {
      const c = safestr(r?.CLAVE ?? r?.clave).toUpperCase();
      const m = c.match(/^CL-(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxNum) maxNum = n;
      }
    });
    return `CL-${String(maxNum + 1).padStart(3, '0')}`;
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
    ['alm_desc','alm_estado','alm_cat','alm_unidad','alm_stock'].forEach(id=>{
      const el = $(id); if (el) { el.readOnly = false; el.disabled = false; el.classList.remove('readonly'); }
    });
    const claveEl = $('alm_clave');
    if (claveEl) {
      claveEl.readOnly = true;
      claveEl.disabled = false;
      claveEl.classList.add('readonly');
    }
  }
  function almResetForm(){
    ALM_EDIT_ID = null;
    $('alm_clave').value = ALM_NEXT_CLAVE || computeNextClave(ALM_LAST_ROWS);
    $('alm_desc').value = '';
    $('alm_stock').value = '';
    $('alm_estado').value = 'ACTIVO';
    if ($('alm_unidad')) $('alm_unidad').value = '';
    if ($('alm_cat')) $('alm_cat').value = '';
    $('btn-alm-crear').textContent = 'Guardar';
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
    if (!bajos.length){ box.innerHTML = '<div class="muted">Sin alertas de stock bajo.</div>'; return; }
    box.innerHTML = `
      <div class="table-scroll">
        <table>
          <thead><tr><th>CLAVE</th><th>Producto</th><th>Stock</th><th>Mínimo</th></tr></thead>
          <tbody>
            ${bajos.slice(0, 25).map(r => `<tr><td>${safestr(r.CLAVE)}</td><td>${safestr(r.DESCRIPCION)}</td><td class="danger" style="color:var(--danger);font-weight:bold;">${Number(r.stock || 0)}</td><td>${Number(r.minimo || 0)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }
  function renderAlmacen(rows){
    const tb = $('alm_tbody'); if (!tb) return;
    tb.innerHTML = '';
    const p = uiPerms();
    const puedeEliminarAlmacen = p.puedeEliminarAlmacen;

    rows.forEach(r=>{
      const id = r.ID ?? r.id;
      const categoriaNom = nombreCategoriaFromRow(r) || '';
      const stock = r.STOCK ?? 0;
      const estado = r.status ?? r.STATUS ?? r.ESTADO ?? '-';
      const tr = document.createElement('tr');
      tr.dataset.id = id; tr.dataset.clave = r.CLAVE ?? ''; tr.dataset.desc = r.DESCRIPCION ?? '';
      tr.dataset.categoria = r.CATEGORIA; tr.dataset.categoriaNombre = categoriaNom;
      tr.dataset.unidad = r.UNIDAD ?? r.unidad ?? ''; tr.dataset.stock = stock; tr.dataset.estado = estado;
      tr.innerHTML = `
        <td><b>${r.CLAVE ?? ''}</b></td>
        <td>${r.DESCRIPCION ?? ''}</td>
        <td>${categoriaNom}</td>
        <td>${tr.dataset.unidad||''}</td>
        <td><b>${stock}</b></td>
        <td>${estado}</td>
        <td>
          <button class="mini" data-action="hist">Historial</button>
          <button class="mini" data-action="edit">Editar</button>
          ${puedeEliminarAlmacen ? '<button class="mini danger" data-action="del" title="Eliminar">Eliminar</button>' : ''}
        </td>`;
      tb.appendChild(tr);

      const clave = norm(r.CLAVE ?? '');
      if (clave && categoriaNom) CATEGORIA_BY_CLAVE.set(clave, String(categoriaNom));
      if (clave && tr.dataset.unidad) UNIDAD_BY_CLAVE.set(clave, String(tr.dataset.unidad));
    });
  }
  async function loadAlmacen(){
    const p = uiPerms();
    if (!p.puedeAccederAlmacen){
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
      ALM_NEXT_CLAVE = safestr(j.next_clave) || computeNextClave(rows);
      if (!ALM_EDIT_ID && $('alm_clave')) {
        $('alm_clave').value = ALM_NEXT_CLAVE;
        $('alm_clave').readOnly = true;
        $('alm_clave').classList.add('readonly');
      }
      if (!ALM_CATS.length) await updateCategoriaFallbackOptions(rows);
      updateUnidadOptions(rows);
      renderAlmacen(rows);
      renderStockBajo(rows);
      $('alm_meta').textContent = `${rows.length} filas`;
      applyPermassions();
    }catch(e){
      $('alm_meta').textContent = '-';
      $('alm_tbody').innerHTML = `<tr><td colspan="7" class="muted">Error: ${e.message || 'Error'}</td></tr>`;
      renderStockBajo([]);
      if (!handleAuthError(e)) console.error(e);
    }
  }
  async function loadProductoHistorial(clave){
    const title = $('alm_hist_title');
    const box = $('alm_historial_box');
    const cleanClave = safestr(clave);
    if (!box || !cleanClave) return;
    if (!(await hasRoute('GET','/api/productos/historial/:clave'))){ box.innerHTML = '<div class="muted">Historial no disponible.</div>'; return; }
    if (title) title.textContent = `Historial: ${cleanClave}`;
    box.innerHTML = '<div class="muted">Cargando...</div>';
    try{
      const j = await apiJSON(`/api/productos/historial/${encodeURIComponent(cleanClave)}`);
      const rows = Array.isArray(j.data) ? j.data : [];
      if (!rows.length){ box.innerHTML = '<div class="muted">Sin movimientos registrados.</div>'; return; }
      box.innerHTML = `
        <div class="table-scroll">
          <table>
            <thead><tr><th>Fecha</th><th>Tipo</th><th>Cantidad</th><th>Responsable</th><th>Referencia</th><th>Observaciones</th></tr></thead>
            <tbody>
              ${rows.map(r => `<tr><td>${fmtDate(r.fecha || r.FECHA)}</td><td>${safestr(r.tipo || r.TIPO || r.TIPO_MOVIMIENTO)}</td><td><b>${Number(r.cantidad ?? r.CANTIDAD ?? 0)}</b></td><td>${safestr(r.responsable || r.RESPONSABLE)}</td><td>${safestr(r.referencia || r.REFERENCIA)}</td><td>${safestr(r.observaciones || r.OBSERVACIONES)}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }catch(e){
      box.innerHTML = `<div style="color:var(--danger)">${e.message || 'Error'}</div>`;
      if (!handleAuthError(e)) toast(e.message || 'Error', false);
    }
  }
  async function intentarAltaProductoDesdeAlmacen(body){
    try{
      if (!(await hasRoute('POST','/api/productos'))) return;
      const prod = { CLAVE: body.CLAVE, DESCRIPCION: body.DESCRIPCION, categoria: body.CATEGORIA ?? null, unidad: body.UNIDAD ?? null, minimo: null, maximo: null, status: body.ESTADO ?? 'ACTIVO' };
      await apiJSON('/api/productos', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(prod) });
    }catch(e){ console.warn('No se pudo dar de alta producto espejo:', e.message); }
  }
  async function crearAlmacen(){
    const p = uiPerms();
    if (!p.puedeAccederAlmacen){ toast('Acceso restringido', false); return; }
    const msg = $('alm_msg');
    const rawClave = ($('alm_clave')?.value || '').trim();
    const rawDesc  = ($('alm_desc')?.value || '').trim();
    const rawCat   = ($('alm_cat')?.value || '').trim();
    const rawUni   = ($('alm_unidad')?.value || '').trim();
    const rawStock = ($('alm_stock')?.value ?? '').toString().trim();
    const rawEst   = ($('alm_estado')?.value || '').trim().toUpperCase();

    if (ALM_EDIT_ID) {
      if (rawStock === '' || !Number.isFinite(Number(rawStock))) {
        const warn = 'Falta agregar información: completa todos los campos';
        if (msg) msg.textContent = warn;
        toast(warn, false);
        return;
      }
    } else {
      if (!rawClave || !rawDesc || !rawCat || !rawUni || rawStock === '' || !Number.isFinite(Number(rawStock)) || Number(rawStock) < 0 || !rawEst) {
        const warn = 'Falta agregar información: completa todos los campos';
        if (msg) msg.textContent = warn;
        toast(warn, false);
        return;
      }
    }

    const body = almFormToBody();
    msg.textContent = ALM_EDIT_ID ? 'Actualizando...' : 'Guardando...';
    try{
      if (ALM_EDIT_ID){
        const add = Number(body.STOCK||0) || 0;
        await apiJSON(`/api/almacen/${ALM_EDIT_ID}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ addStock: add }) });
        toast(`Ajuste aplicado: ${add >= 0 ? '+' : ''}${add}`, true);
      } else {
        await apiJSON('/api/almacen', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        toast('Guardado', true);
      }
      msg.textContent = 'Listo';
      await loadAlmacen();
      almResetForm();
    }catch(e){
      msg.textContent = e.message || 'Error'; if (!handleAuthError(e)) toast(e.message || 'Error');
    }
  }
  function startEditFromRow(tr){
    const p = uiPerms();
    if (!p.puedeAccederAlmacen){ toast('Acceso restringido', false); return; }
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
    const p = uiPerms();
    if (!p.puedeEliminarAlmacen){ toast('Eliminar solo Admin', false); return; }
    if (!confirm('¿Eliminar el registro #' + id + '?')) return;
    const msg = $('alm_msg');
    msg.textContent = 'Eliminando...';
    try{
      const j = await apiJSON(`/api/almacen/${id}?hard=1`, { method:'DELETE' });
      msg.textContent = 'Listo';
      toast(j.deleted ? 'Eliminado' : 'No se elimino (?no existe?)', true);
      if (ALM_EDIT_ID === String(id)) almResetForm();
      await loadAlmacen();
    }catch(e){
      msg.textContent = e.message || 'Error'; if (!handleAuthError(e)) toast(e.message || 'Error');
    }
  }

  function getSolicitudIdForPdf(){
    if (isCapturaViewActive()) {
      return String(SOL_ID || DET_SOL_ID || '').trim();
    }
    return String($('sol_edit_id')?.value || DET_SOL_ID || LIST_SELECTED_ID || SOL_ID || '').trim();
  }
  
  async function descargarPDF({ resetAfter = false } = {}) {
    const btn = document.getElementById('btn-sol-pdf');
    const btnFlow = document.getElementById('btn-sol-pdf-flow');
    if (btn) btn.disabled = true;
    if (btnFlow) btnFlow.disabled = true;

    try {
      const id = getSolicitudIdForPdf();
      if (!id) throw new Error('No hay solicitud seleccionada');
      const res = await api(`/api/solicitudes/${encodeURIComponent(id)}/pdf`, { headers: { Accept: 'application/pdf' } });
      if (!res.ok) {
        const text = await res.text();
        let msg = text || `HTTP ${res.status}`;
        try { const json = JSON.parse(text); msg = json?.error || json?.message || msg; } catch {}
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
      toast(`Error generando PDF: ${e.message}`, false);
    } finally {
      if (btn) btn.disabled = false;
      if (btnFlow) btnFlow.disabled = false;
    }
  }
  
  async function subirRespaldoFirmado(){
    const id = $('sol_edit_id')?.value;
    const fileIn = $('sol_file_respaldo');
    const msg = $('msg_respaldo') || $('msg_edit');
    if (!id) { toast('Selecciona primero una solicitud', false); return; }
    if (!fileIn?.files?.length) { toast('Selecciona un archivo PDF o imagen', false); return; }

    const formData = new FormData();
    formData.append('archivo', fileIn.files[0]);
    if (msg) msg.textContent = 'Subiendo respaldo...';

    try {
      const res = await api(`/api/solicitudes/${encodeURIComponent(id)}/respaldo`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'No se pudo subir el archivo');

      if (msg) msg.textContent = 'Vale firmado guardado en el servidor.';
      fileIn.value = '';
      $('btn-sol-ver-respaldo')?.classList.remove('hidden');
      toast('Respaldo guardado correctamente', true);
    } catch (e) {
      if (msg) msg.textContent = e.message || 'Error al subir';
      toast(e.message || 'Error al subir', false);
    }
  }

  function verRespaldoFirmado(){
    const id = $('sol_edit_id')?.value;
    if (!id) { toast('Selecciona una solicitud', false); return; }
    window.open(`/api/solicitudes/${encodeURIComponent(id)}/respaldo`, '_blank');
  }

  // --- REPORTES Y GRÁFICAS ---
  function formatReportOficialiaLabel(row){ return safestr(row?.oficialia_nombre || row?.nombre || '-') || '-'; }
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
    REP_DATA = null; REP_SELECTED_OFICIALIA = '';
    ['rep_msg','rep_detail_sub'].forEach(i => { if($(i)) $(i).textContent = ''; });
    if ($('rep_detail_title')) $('rep_detail_title').textContent = 'Reporte de departamento';
    ['rep_kpi_sol','rep_kpi_cant','rep_kpi_ent','rep_kpi_top_prod','rep_kpi_top_oficialia'].forEach(i => { if($(i)) $(i).textContent = '-'; });
    ['rep_productos_box','rep_oficialias_box','rep_solicitudes_box','rep_inconsistencias_box','rep_chart_box'].forEach(i => { if($(i)) $(i).innerHTML = '<div class="muted">Sin datos.</div>'; });
    setReporteView('home');
  }
  function fillOficialiasSelect(selId, rows, current='', allLabel='Todos'){
    const sel = $(selId); if (!sel) return;
    const options = [`<option value="">${allLabel}</option>`].concat((rows || []).map(r => `<option value="${Number(r.oficialia_id || 0)}">${formatReportOficialiaLabel(r)}</option>`));
    sel.innerHTML = options.join(''); sel.value = current || '';
  }
  function fillReporteOficialiasSelect(rows, current=''){ fillOficialiasSelect('rep_oficialia', rows, current, 'Todos'); }
  function fillGraficasOficialiasSelect(rows, current=''){ fillOficialiasSelect('graf_oficialia', rows, current, 'Todas'); }

  function renderReporteProductos(rows){
    const box = $('rep_productos_box'); if (!box) return;
    if (!rows?.length){ box.innerHTML = '<div class="muted">Sin datos.</div>'; return; }
    const topRows = rows.slice(0, 10);
    const renderTable = (tableRows) => `
      <div class="table-scroll">
        <table>
          <thead><tr><th>CLAVE</th><th>PRODUCTO</th><th>SOLICITUDES</th><th>CANT. SOLICITADA</th><th>CANT. ENTREGADA</th></tr></thead>
          <tbody>${tableRows.map(r => `<tr><td><b>${safestr(r.clave || r.CLAVE) || '-'}</b></td><td>${safestr(r.descripcion || r.DESCRIPCION) || '-'}</td><td>${Number(r.solicitudes_count || 0)}</td><td>${Number(r.cantidad_solicitada || 0)}</td><td>${Number(r.cantidad_atendida || 0)}</td></tr>`).join('')}</tbody>
        </table>
      </div>`;
    box.innerHTML = `<div style="margin-bottom:14px;"><h4 style="margin:0 0 8px 0;">Top 10</h4>${renderTable(topRows)}</div><div><h4 style="margin:0 0 8px 0;">Todos los productos solicitados</h4>${renderTable(rows)}</div>`;
  }
  function renderReporteOficialias(rows){
    const box = $('rep_oficialias_box'); if (!box) return;
    if (!rows?.length){ box.innerHTML = '<div class="muted">Sin datos.</div>'; return; }
    box.innerHTML = `
      <div class="table-scroll">
        <table>
          <thead><tr><th>DEPARTAMENTO</th><th>SOLICITUDES</th><th>PROD. SOLICITADOS</th><th>PROD. ENTREGADOS</th><th>ACCIÓN</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td>${formatReportOficialiaLabel(r)}</td><td>${Number(r.solicitudes_count || 0)}</td><td>${Number(r.cantidad_solicitada || 0)}</td><td>${Number(r.cantidad_atendida || 0)}</td><td><button class="mini btn-secondary" data-rep-open-oficialia="${Number(r.oficialia_id || 0)}">Ver reporte</button></td></tr>`).join('')}</tbody>
        </table>
      </div>`;
  }
  function renderReporteSolicitudes(rows){
    const box = $('rep_solicitudes_box'); if (!box) return;
    if (!rows?.length){ box.innerHTML = '<div class="muted">Sin datos.</div>'; return; }
    box.innerHTML = `
      <div class="table-scroll">
        <table>
          <thead><tr><th>USUARIO</th><th>DEPARTAMENTO</th><th>SOLICITUDES</th><th>ÚLTIMA FECHA</th><th>CANT. SOLICITADA</th><th>CANT. ENTREGADA</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td><b>${safestr(r.nombre_usuario) || '-'}</b></td><td>${safestr(r.oficialia_nombre) || '-'}</td><td>${Number(r.solicitudes_count || 0)}</td><td>${fmtDate(r.ultima_fecha)}</td><td>${Number(r.cantidad_solicitada || 0)}</td><td>${Number(r.cantidad_atendida || 0)}</td></tr>`).join('')}</tbody>
        </table>
      </div>`;
  }
  function renderReporteInconsistencias(rows){
    const box = $('rep_inconsistencias_box'); if (!box) return;
    if (!rows?.length){ box.innerHTML = '<div class="muted">Sin inconsistencias.</div>'; return; }
    box.innerHTML = `
      <div class="table-scroll">
        <table>
          <thead><tr><th>USUARIO</th><th>DEPARTAMENTO SOLICITUD</th><th>DEPARTAMENTO USUARIO</th><th>SOLICITUDES</th><th>ÚLTIMA FECHA</th><th>CANT. SOLICITADA</th><th>CANT. ENTREGADA</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td>${safestr(r.nombre_usuario) || '-'}</td><td>${safestr(r.oficialia_solicitud_nombre) || '-'}</td><td>${safestr(r.oficialia_usuario_nombre) || '-'}</td><td>${Number(r.solicitudes_count || 0)}</td><td>${fmtDate(r.ultima_fecha)}</td><td>${Number(r.cantidad_solicitada || 0)}</td><td>${Number(r.cantidad_atendida || 0)}</td></tr>`).join('')}</tbody>
        </table>
      </div>`;
  }
  function renderReporteChart(rows){
    const box = $('rep_chart_box'); if (!box) return;
    const topRows = (rows || []).slice(0, 10);
    if (!topRows.length){ box.innerHTML = '<div class="muted">Sin datos.</div>'; return; }
    const maxVal = Math.max(...topRows.map(r => Number(r.cantidad_solicitada || 0)), 1);
    box.innerHTML = `<div class="rep-chart">${topRows.map(r => {
      const val = Number(r.cantidad_solicitada || 0); const width = Math.max(4, Math.round((val / maxVal) * 100)); const label = [safestr(r.clave || r.CLAVE), safestr(r.descripcion || r.DESCRIPCION)].filter(Boolean).join(' - ') || '-';
      return `<div class="rep-bar-row"><div class="rep-bar-label" title="${label}">${label}</div><div class="rep-bar-track"><div class="rep-bar-fill" style="width:${width}%"></div></div><div class="rep-bar-val">${val}</div></div>`;
    }).join('')}</div>`;
  }

  function reportHtmlTable(headers, rows){
    return `
      <table style="width:100%; border-collapse:collapse; margin-top:10px;">
        <thead><tr>${headers.map(h => `<th style="text-align:left; border:1px solid #999; padding:6px; background:#eee;">${h}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(row => `<tr>${row.map(cell => `<td style="border:1px solid #999; padding:6px;">${cell}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>`;
  }

  function buildReportPrintHtml(data, { general = false } = {}){
    const summary = data?.summary || {};
    const productos = Array.isArray(data?.productos) ? data.productos : [];
    const rankings = data?.rankings || {};
    const title = general ? 'Reporte general de solicitudes' : `Reporte de departamento: ${summary.scope_label || '-'}`;
    const topProductosTable = reportHtmlTable(['CLAVE','PRODUCTO','SOLICITUDES','CANT. SOLICITADA','CANT. ENTREGADA'], productos.slice(0, 10).map(r => [safestr(r.clave || r.CLAVE) || '-', safestr(r.descripcion || r.DESCRIPCION) || '-', Number(r.solicitudes_count || 0), Number(r.cantidad_solicitada || 0), Number(r.cantidad_atendida || 0)]));
    const productosTable = reportHtmlTable(['CLAVE','PRODUCTO','SOLICITUDES','CANT. SOLICITADA','CANT. ENTREGADA'], productos.map(r => [safestr(r.clave || r.CLAVE) || '-', safestr(r.descripcion || r.DESCRIPCION) || '-', Number(r.solicitudes_count || 0), Number(r.cantidad_solicitada || 0), Number(r.cantidad_atendida || 0)]));
    const chartRows = productos.slice(0, 10);
    const maxVal = Math.max(...chartRows.map(r => Number(r.cantidad_solicitada || 0)), 1);
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title>
    <style>body{font-family:Arial,sans-serif; color:#111; margin:24px;} h1,h2{margin:0 0 10px 0;} .meta{margin:12px 0 18px 0;} .kpis{display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin:14px 0 18px 0;} .kpi{border:1px solid #999; padding:10px;} .lab{font-size:12px; color:#555;} .val{font-size:18px; font-weight:700; margin-top:4px;} .chart{display:grid; gap:8px; margin:10px 0 18px 0;} .row{display:grid; grid-template-columns:220px 1fr 60px; gap:10px; align-items:center;} .label{font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;} .track{height:12px; border:1px solid #bbb; border-radius:999px; overflow:hidden; background:#f3f4f6;} .fill{height:100%; background:#1a5596;} .num{font-size:12px; text-align:right;} </style></head>
    <body><h1>${title}</h1><div class="meta">Fecha: ${new Date().toLocaleDateString('es-MX')}</div>
    <div class="kpis"><div class="kpi"><div class="lab">Solicitudes</div><div class="val">${Number(summary.solicitudes_count || 0)}</div></div><div class="kpi"><div class="lab">Productos solicitados</div><div class="val">${Number(summary.cantidad_solicitada || 0)}</div></div><div class="kpi"><div class="lab">Productos entregados</div><div class="val">${Number(summary.cantidad_atendida || 0)}</div></div><div class="kpi"><div class="lab">Producto mas solicitado</div><div class="val" style="font-size:14px;">${safestr(summary.top_producto_nombre || '-') || '-'}</div></div></div>
    <div class="meta"><b>Departamento que mas solicita:</b> ${rankings.mas_pide ? formatReportOficialiaLabel(rankings.mas_pide) : '-'}</div>
    <h2>Grafica de productos</h2><div class="chart">${chartRows.map(r => { const val = Number(r.cantidad_solicitada || 0); const width = Math.max(4, Math.round((val / maxVal) * 100)); const label = [safestr(r.clave || r.CLAVE), safestr(r.descripcion || r.DESCRIPCION)].filter(Boolean).join(' - ') || '-'; return `<div class="row"><div class="label">${label}</div><div class="track"><div class="fill" style="width:${width}%"></div></div><div class="num">${val}</div></div>`; }).join('')}</div>
    <h2>Top 10 productos mas solicitados</h2>${topProductosTable}<h2>Todos los productos solicitados</h2>${productosTable}</body></html>`;
  }

  function buildExcelHtml(data){
    const summary = data?.summary || {};
    const productos = Array.isArray(data?.productos) ? data.productos : [];
    const solicitudes = Array.isArray(data?.solicitudes) ? data.solicitudes : [];
    return `<!doctype html><html><head><meta charset="utf-8"></head><body><table border="1">
      <tr><th colspan="2">Resumen</th></tr><tr><td>Departamento</td><td>${safestr(summary.scope_label) || '-'}</td></tr><tr><td>Solicitudes</td><td>${Number(summary.solicitudes_count || 0)}</td></tr><tr><td>Productos solicitados</td><td>${Number(summary.cantidad_solicitada || 0)}</td></tr><tr><td>Productos entregados</td><td>${Number(summary.cantidad_atendida || 0)}</td></tr><tr><td>Producto mas solicitado</td><td>${safestr(summary.top_producto_nombre) || '-'}</td></tr></table>
      ${reportHtmlTable(['USUARIO','DEPARTAMENTO','SOLICITUDES','ULTIMA FECHA','CANT. SOLICITADA','CANT. ENTREGADA'], solicitudes.map(r => [safestr(r.nombre_usuario) || '-', safestr(r.oficialia_nombre) || '-', Number(r.solicitudes_count || 0), fmtDate(r.ultima_fecha), Number(r.cantidad_solicitada || 0), Number(r.cantidad_atendida || 0)]))}
      ${reportHtmlTable(['CLAVE','PRODUCTO','SOLICITUDES','CANT. SOLICITADA','CANT. ENTREGADA'], productos.map(r => [safestr(r.clave || r.CLAVE) || '-', safestr(r.descripcion || r.DESCRIPCION) || '-', Number(r.solicitudes_count || 0), Number(r.cantidad_solicitada || 0), Number(r.cantidad_atendida || 0)]))}
      </body></html>`;
  }

  function exportReporteExcel(){
    if (!REP_DATA) { toast('No hay reporte cargado', false); return; }
    const html = buildExcelHtml(REP_DATA);
    const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reporte_${safestr(REP_DATA?.summary?.scope_label || 'departamento').replace(/[^\w\-]+/g, '_')}.xls`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  function getDateRange(prefix){ return { inicio: ($(`${prefix}_fecha_inicio`)?.value || '').trim(), fin: ($(`${prefix}_fecha_fin`)?.value || '').trim() }; }
  function setDateRangeParams(params, range){ if (range?.inicio) params.set('fecha_inicio', range.inicio); if (range?.fin) params.set('fecha_fin', range.fin); }
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
    const w = window.open('', '_blank', 'width=1000,height=800');
    if (!w) throw new Error('No se pudo abrir la ventana de impresion');
    w.document.open(); w.document.write(buildReportPrintHtml(j?.data || {}, { general: !oficialiaId })); w.document.close();
    w.focus(); setTimeout(() => { try { w.print(); } catch {} }, 250);
  }

  async function loadReporteUsuarios(forceDetail = false){
    const p = uiPerms();
    if (!p.reportes?.acceso){ toast('Acceso restringido', false); return; }
    const msg = $('rep_msg');
    const currentOficialiaId = $('rep_oficialia')?.value || '';
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
      
      if ($('rep_detail_title')) $('rep_detail_title').textContent = `Reporte de: ${summary.scope_label || 'Departamento'}`;
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
      if (msg) msg.textContent = e.message || 'Error';
      if (!handleAuthError(e)) toast(e.message || 'Error', false);
    }
  }

  function renderPieChart(boxId, rows, { labelFn, valueFn, empty = 'Sin datos.', totalLabel = 'Total', maxItems = 6, groupOthers = true } = {}){
    const box = $(boxId); if (!box) return;
    const palette = ['#6ea8fe','#8dd3c7','#fdb462','#fb8072','#80b1d3','#b3de69','#fccde5','#bc80bd'];
    const source = (rows || []).map(r => ({ raw: r, label: safestr(labelFn(r)) || '-', value: Number(valueFn(r) || 0) })).filter(r => r.value > 0).sort((a, b) => b.value - a.value);
    if (!source.length){ box.innerHTML = `<div class="muted">${empty}</div>`; return; }
    
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
          <div class="pie-center"><div class="big">${total}</div><div class="small">${totalLabel}</div></div>
        </div>
        <div class="pie-legend">
          ${data.map(item => `<div class="pie-legend-item"><span class="pie-swatch" style="background:${item.color};"></span><span class="pie-label" title="${item.label}">${item.label}</span><span class="pie-val">${item.value} / ${item.percent}%</span></div>`).join('')}
        </div>
      </div>`;
  }

  function renderCumplimientoChart(rows){
    const box = $('graf_cumplimiento'); if (!box) return;
    const data = (rows || []).map(r => {
      const solicitada = Number(r.cantidad_solicitada || 0);
      const atendida = Number(r.cantidad_atendida || 0);
      const ratio = solicitada > 0 ? Math.round((atendida / solicitada) * 100) : 0;
      return { ...r, ratio };
    }).sort((a, b) => Number(b.ratio || 0) - Number(a.ratio || 0) || Number(b.cantidad_solicitada || 0) - Number(a.cantidad_solicitada || 0)).slice(0, 10);
    
    if (!data.length){ box.innerHTML = '<div class="muted">Sin datos.</div>'; return; }
    box.innerHTML = `<div class="rep-chart">${data.map(r => {
      const label = [safestr(r.clave || r.CLAVE), safestr(r.descripcion || r.DESCRIPCION)].filter(Boolean).join(' - ') || '-';
      const width = Math.max(4, Math.min(100, Number(r.ratio || 0)));
      return `<div class="rep-bar-row"><div class="rep-bar-label" title="${label}">${label}</div><div class="rep-bar-track"><div class="rep-bar-fill" style="width:${width}%"></div></div><div class="rep-bar-val">${Number(r.ratio || 0)}%</div></div>`;
    }).join('')}</div>`;
  }

  function renderAllProductosPie(rows){
    const box = $('graf_all_productos'); if (!box) return;
    const data = Array.isArray(rows) ? rows : [];
    if (!data.length){ box.innerHTML = '<div class="muted">Sin datos.</div>'; return; }
    
    const pieData = data.map(r => ({
      clave: safestr(r.clave || r.CLAVE) || '-',
      descripcion: safestr(r.descripcion || r.DESCRIPCION) || '-',
      cantidad_solicitada: Number(r.cantidad_solicitada || 0) || 0,
    })).filter(r => r.cantidad_solicitada > 0).sort((a, b) => b.cantidad_solicitada - a.cantidad_solicitada);
    
    const total = pieData.reduce((acc, r) => acc + r.cantidad_solicitada, 0);
    const palette = ['#6ea8fe','#8dd3c7','#fdb462','#fb8072','#80b1d3','#b3de69','#fccde5','#bc80bd','#ffcc80','#90caf9','#a5d6a7','#ce93d8'];
    
    let cursor = 0;
    const decorated = pieData.map((item, idx) => {
      const pct = total > 0 ? (item.cantidad_solicitada / total) * 100 : 0;
      const start = cursor; cursor += pct;
      return { ...item, color: palette[idx % palette.length], percent: total > 0 ? ((item.cantidad_solicitada / total) * 100).toFixed(1) : '0.0', stop: `${palette[idx % palette.length]} ${start}% ${cursor}%` };
    });
    
    box.innerHTML = `
      <div class="pie-wrap single">
        <div class="pie-chart" style="background:conic-gradient(${decorated.map(r => r.stop).join(', ')});">
          <div class="pie-center"><div class="big">${total}</div><div class="small">Todos</div></div>
        </div>
      </div>
      <div class="pie-scroll table-scroll">
        <table>
          <thead><tr><th>COLOR</th><th>CLAVE</th><th>PRODUCTO</th><th>SOLICITADA</th><th>%</th></tr></thead>
          <tbody>${decorated.map(r => `<tr><td><span class="pie-swatch" style="display:inline-block;background:${r.color};"></span></td><td><b>${r.clave}</b></td><td>${r.descripcion}</td><td>${r.cantidad_solicitada}</td><td>${r.percent}%</td></tr>`).join('')}</tbody>
        </table>
      </div>`;
  }

  function resetGraficasView(){
    GRAF_DATA = null;
    if ($('graf_msg')) $('graf_msg').textContent = '';
    ['graf_kpi_sol','graf_kpi_cant','graf_kpi_ent','graf_kpi_cump'].forEach(id => { if($(id)) $(id).textContent = '-'; });
    ['graf_top_solicitados','graf_top_entregados','graf_top_grupo','graf_cumplimiento','graf_all_productos'].forEach(id => { if ($(id)) $(id).innerHTML = '<div class="muted">Sin datos.</div>'; });
  }

  async function loadGraficas(){
    const p = uiPerms();
    if (!p.reportes?.acceso){ toast('Acceso restringido', false); return; }
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
      const ratio = Number(summary.cantidad_solicitada || 0) > 0 ? Math.round((Number(summary.cantidad_atendida || 0) / Number(summary.cantidad_solicitada || 0)) * 100) : 0;
      if ($('graf_kpi_cump')) $('graf_kpi_cump').textContent = `${ratio}%`;
      
      renderPieChart('graf_top_solicitados', productos, { labelFn: r => [r.clave || r.CLAVE, r.descripcion || r.DESCRIPCION].filter(Boolean).join(' - '), valueFn: r => r.cantidad_solicitada, totalLabel: 'Solicitado' });
      renderPieChart('graf_top_entregados', productos, { labelFn: r => [r.clave || r.CLAVE, r.descripcion || r.DESCRIPCION].filter(Boolean).join(' - '), valueFn: r => r.cantidad_atendida, totalLabel: 'Entregado' });
      
      const groupRows = currentOficialiaId ? solicitudes : oficialias;
      renderPieChart('graf_top_grupo', groupRows, { labelFn: r => currentOficialiaId ? (r.nombre_usuario || '-') : formatReportOficialiaLabel(r), valueFn: r => r.cantidad_solicitada, empty: 'Sin datos.', totalLabel: currentOficialiaId ? 'Usuario' : 'Departamento' });
      
      renderCumplimientoChart(productos);
      renderAllProductosPie(productos);
      if (msg) msg.textContent = summary.scope_label ? `Graficas: ${summary.scope_label}${rangeLabel ? ` / ${rangeLabel}` : ''}` : 'Listo';
    }catch(e){
      resetGraficasView();
      if (msg) msg.textContent = e.message || 'Error';
      if (!handleAuthError(e)) toast(e.message || 'Error', false);
    }
  }

  // =========================================================================
  // INICIALIZACIÓN (AQUÍ ESTÁN TODOS LOS EVENT LISTENERS)
  // =========================================================================
  document.addEventListener('DOMContentLoaded', async ()=>{
    
    $('btn-logout')?.addEventListener('click', async () => {
      if (hasUnsavedSolicitudChanges()) {
        const salir = confirm('Tienes una solicitud en proceso. Si continúas, se perderán los cambios. ¿Deseas salir?');
        if (!salir) return;
        await discardActiveCapturaSolicitud();
        resetSolicitudFlow({ stayInCaptura: false });
      }
      await logout();
    });

    // Marcar cambios en #view-captura al escribir o seleccionar
    $('view-captura')?.addEventListener('input', (ev) => {
      const t = ev.target;
      if (!t || !['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
      CAPTURA_DIRTY = Boolean(
        SOL_ID !== null ||
        safestr($('obs_sol')?.value) ||
        safestr($('busca_prod')?.value) ||
        safestr($('det_obs')?.value) ||
        safestr($('prod_sel')?.value) ||
        (safestr($('tipo_solicitud')?.value) && safestr($('tipo_solicitud')?.value) !== 'CONSUMIBLES') ||
        (safestr($('det_cant')?.value) && safestr($('det_cant')?.value) !== '1')
      );
    });
    $('view-captura')?.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!t || !['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
      if (t.id === 'sol_user_id' || t.id === 'tipo_solicitud' || t.id === 'prod_sel') {
        CAPTURA_DIRTY = true;
      }
    });

    // Alerta al refrescar o cerrar pestaña con cambios sin guardar en #view-captura
    window.addEventListener('beforeunload', (e) => {
      if (hasUnsavedSolicitudChanges()) {
        e.preventDefault();
        e.returnValue = 'Tienes una solicitud en proceso. Si continúas, se perderán los cambios. ¿Deseas salir?';
        return e.returnValue;
      }
    });

    // Si el usuario confirma recargar o cerrar la pestaña con una solicitud en proceso sin descargar PDF, descartarla
    window.addEventListener('pagehide', () => {
      if (SOL_ID !== null && isCapturaViewActive()) {
        try {
          navigator.sendBeacon(`/api/solicitudes/${encodeURIComponent(SOL_ID)}/discard`);
        } catch {}
      }
    });

    // Clics del Menú Lateral (Sidebar)
    document.querySelector('.sidebar-nav')?.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('.nav-item');
      if (!btn) return;
      if (btn.classList.contains('hidden') || btn.classList.contains('disabled')) { 
        toast('Acceso restringido', false); 
        return; 
      }
      const targetView = btn.dataset.view;
      if (targetView !== 'captura' && hasUnsavedSolicitudChanges()) {
        const salir = confirm('Tienes una solicitud en proceso. Si continúas, se perderán los cambios. ¿Deseas salir?');
        if (!salir) return;
        await discardActiveCapturaSolicitud();
        resetSolicitudFlow({ stayInCaptura: false });
      }
      showView(targetView);
    });

    // Botones del Panel General y Auditoria
    $('btn-crear-rapido')?.addEventListener('click', () => showView('captura'));
    $('btn-audit-refresh')?.addEventListener('click', () => { 
      if (typeof loadAuditoria === 'function') loadAuditoria(); 
    });

    // Accesos directos de las 4 tarjetas KPI
    $('kpi-card-total')?.addEventListener('click', async () => {
      if ($('list_q')) $('list_q').value = '';
      setSolicitudListMode('activas'); 
      showView('solicitudes'); 
      setSolicitudesTab('lista'); 
      await listarSolicitudes();
    });
    
    $('kpi-card-pendientes')?.addEventListener('click', async () => {
      if ($('list_q')) $('list_q').value = 'PENDIENTE';
      setSolicitudListMode('activas'); 
      showView('solicitudes'); 
      setSolicitudesTab('lista'); 
      await listarSolicitudes();
    });
    
    $('kpi-card-surtidas')?.addEventListener('click', async () => {
      if ($('list_q')) $('list_q').value = 'APROBADA'; 
      setSolicitudListMode('activas'); 
      showView('solicitudes'); 
      setSolicitudesTab('lista'); 
      await listarSolicitudes(); 
      
      const box = $('listado_box');
      if (box) {
        Array.from(box.querySelectorAll('tbody tr')).forEach(tr => {
          const statusCell = tr.querySelector('.status-badge');
          if (statusCell) {
            const txt = (statusCell.textContent || '').trim().toUpperCase();
            tr.style.display = ['APROBADA', 'SURTIDA', 'ENTREGADA'].includes(txt) ? '' : 'none';
          }
        });
      }
    });
    
    $('kpi-card-materiales')?.addEventListener('click', () => { 
      const p = uiPerms();
      if (p.puedeAccederAlmacen) showView('almacen'); 
    });
    
    $('btn-ver-todas-ordenes')?.addEventListener('click', async () => {
      if ($('list_q')) $('list_q').value = '';
      showView('solicitudes'); 
      setSolicitudesTab('lista'); 
      await listarSolicitudes();
    });
    
    $('panel_actividad_box')?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-open-sol]');
      if (!btn) return;
      showView('solicitudes'); 
      consultarSolicitudById(btn.getAttribute('data-open-sol'));
    });

    // Pestaña: Captura de Solicitudes
    $('btn-crear-sol')?.addEventListener('click', continuarAPaso2);
    $('btn-sol-tab-crear')?.addEventListener('click', ()=> setSolicitudTab('crear'));
    $('btn-sol-tab-agregar')?.addEventListener('click', ()=> setSolicitudTab('agregar'));
    $('btn-sol-tab-revision')?.addEventListener('click', ()=> setSolicitudTab('revision'));
    $('btn-sol-tab-pdf')?.addEventListener('click', ()=> setSolicitudTab('pdf'));
    $('btn-find-prod')?.addEventListener('click', buscarProductos);
    $('btn-add-det')?.addEventListener('click', agregarDetalle);
    $('btn-sol-go-revision')?.addEventListener('click', () => {
      if (!DET_ROWS.length) {
        toast('Agrega por lo menos un producto al detalle');
        return;
      }
      setSolicitudTab('revision');
    });

    $('det_preview')?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.btn-del-preview-row');
      if (!btn) return;
      const idx = Number(btn.dataset.index);
      if (Number.isFinite(idx) && idx >= 0 && idx < DET_ROWS.length) {
        DET_ROWS.splice(idx, 1);
        renderDetallePreviewFromRows();
        updateSolBadge();
      }
    });

    // Pestaña: Lista y Consulta de Solicitudes
    $('btn-listar')?.addEventListener('click', listarSolicitudes);
    $('list_oficialia')?.addEventListener('change', listarSolicitudes);
    $('btn-list-mode-activas')?.addEventListener('click', ()=>{ setSolicitudListMode('activas'); listarSolicitudes(); });
    $('btn-list-mode-canceladas')?.addEventListener('click', ()=>{ setSolicitudListMode('canceladas'); listarSolicitudes(); });
    $('btn-list-consultar')?.addEventListener('click', ()=> consultarSolicitudById(LIST_SELECTED_ID));
    $('btn-solicitudes-tab-lista')?.addEventListener('click', ()=> setSolicitudesTab('lista'));
    $('btn-solicitudes-tab-consulta')?.addEventListener('click', ()=> setSolicitudesTab('consulta'));

    setSolicitudListMode('activas');
    $('btn-sol-cancelar')?.addEventListener('click', cancelarSolicitud);
    
    $('sol_detalle_box')?.addEventListener('click', async (ev)=>{
      const delBtn = ev.target.closest('.btn-del-det-row');
      if (delBtn) {
        const idx = Number(delBtn.dataset.index);
        if (Number.isFinite(idx) && idx >= 0 && idx < DET_ROWS.length) {
          DET_ROWS.splice(idx, 1);
          renderDetallePreviewFromRows();
          renderFlowDetalleView();
          updateSolBadge();
          if (DET_ROWS.length === 0) {
            setSolicitudTab('agregar');
          }
        }
        return;
      }
      const goPdfBtn = ev.target.closest('#btn-sol-go-pdf');
      if (goPdfBtn) {
        if (!SOL_ID) {
          await guardarSolicitudEnPaso3();
        } else {
          setSolicitudTab('pdf');
        }
        return;
      }
      const btn = ev.target.closest('#btn-sol-save-detalle');
      if (!btn) return;
      await guardarSolicitudEnPaso3();
    });

    // Botón Aceptar y Surtir de la pestaña Consulta (Para Encargados)
    $('sol_consulta_detalle')?.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('#btn-aprobar-surtir-consulta');
      if (!btn) return;
      btn.disabled = true;
      await guardarTodoDetalle('sol_consulta_detalle', { goToPdf: false });
      await consultarSolicitudById(DET_SOL_ID);
      await listarSolicitudes();
      btn.disabled = false;
    });

    $('btn-sol-subir-respaldo')?.addEventListener('click', subirRespaldoFirmado);
    $('btn-sol-ver-respaldo')?.addEventListener('click', verRespaldoFirmado);

    // Botones de PDF
    $('btn-sol-pdf')?.addEventListener('click', ()=> descargarPDF({ resetAfter: false }));
    $('btn-sol-pdf-flow')?.addEventListener('click', ()=> descargarPDF({ resetAfter: true }));

    // Selección de renglón en la tabla
    $('listado_box')?.addEventListener('click', (ev)=>{
      const tr = ev.target.closest('tbody tr[data-sol-id]'); if (!tr) return;
      setListadoSelectedId(tr.dataset.solId || tr.getAttribute('data-sol-id'));
    });

    // Pestaña: Almacén (Inventario)
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

    // Pestaña: Reportes y Gráficas
    $('btn-rep-load')?.addEventListener('click', ()=> loadReporteUsuarios(true));
    $('btn-rep-print-general')?.addEventListener('click', ()=> printReporte(''));
    $('btn-rep-back')?.addEventListener('click', ()=> { REP_SELECTED_OFICIALIA = ''; setReporteView('home'); });
    $('btn-rep-print-detail')?.addEventListener('click', ()=> printReporte(REP_SELECTED_OFICIALIA || $('rep_oficialia')?.value || ''));
    $('btn-rep-export-excel')?.addEventListener('click', exportReporteExcel);
    $('rep_oficialias_box')?.addEventListener('click', async (ev)=>{
      const btn = ev.target.closest('[data-rep-open-oficialia]'); if (!btn) return;
      try{
        const id = btn.getAttribute('data-rep-open-oficialia') || '';
        if ($('rep_oficialia')) $('rep_oficialia').value = id;
        REP_SELECTED_OFICIALIA = id;
        await loadReporteUsuarios();
      }catch(e){
        toast(e.message || 'Error al abrir reporte', false);
      }
    });
    $('btn-graf-load')?.addEventListener('click', loadGraficas);
    $('graf_oficialia')?.addEventListener('change', loadGraficas);
    $('graf_fecha_inicio')?.addEventListener('change', loadGraficas);
    $('graf_fecha_fin')?.addEventListener('change', loadGraficas);

    // Arranque Inicial
    try { await ensureAPI(); } catch(e){ alert(e.message); return; }
    await me();

    if ($('btn-sol-eliminar')) {
      $('btn-sol-eliminar').addEventListener('click', eliminarSolicitud);
      const can = await hasRoute('DELETE','/api/solicitudes/:id');
      if (!can) { $('btn-sol-eliminar').classList.add('hidden'); }
    }

    applyPermassions();
    updateSolBadge();
    setSolicitudTab('crear');
    
  }); // <-- FIN DEL EVENTO DOMContentLoaded

})(); // <-- FIN DEL ARCHIVO APP.JS