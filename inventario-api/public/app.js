(() => {
  'use strict';

  const APP_VERSION = 62;

  const $ = (id)=> document.getElementById(id);
  const hide = (id)=>{ const el=$(id); if(el) el.classList.add('hidden'); };
  const show = (id)=>{ const el=$(id); if(el) el.classList.remove('hidden'); };

  function escHtml(unsafe) {
    return (unsafe ?? '').toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  const TITULARES_REGIONALES_V59 = {
    LA_PAZ: 'Sandra Guadalupe Salvatierra Amador',
    LOS_CABOS: 'Samir Savin Ruiz',
    COMONDU_LORETO: 'Humberto Arce Cordero',
    MULEGE: 'Diana Ramírez Hernández',
  };

  function getTitularRegionalFromText(regOrUser) {
    const k = String(regOrUser || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .trim();
    if (!k) return '';
    if (k.includes('CABOS') || k === 'LOSCABOS') return TITULARES_REGIONALES_V59.LOS_CABOS;
    if (k.includes('COMONDU') || k.includes('LORETO')) return TITULARES_REGIONALES_V59.COMONDU_LORETO;
    if (k.includes('MULEGE') || k.includes('GUERRERO')) return TITULARES_REGIONALES_V59.MULEGE;
    if (k.includes('PAZ') || k === 'LAPAZ') return TITULARES_REGIONALES_V59.LA_PAZ;
    return '';
  }

  function isSiniestroActivo(row) {
    if (!row || typeof row !== 'object') return false;
    const det = row.detalles_vehiculo && typeof row.detalles_vehiculo === 'object'
      ? JSON.stringify(row.detalles_vehiculo)
      : String(row.detalles_vehiculo || '');
    const txt = [row.estatus_uso, row.estado_fisico, row.observaciones, row.observaciones_control, det]
      .join(' ')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase();
    return txt.includes('SINIESTRO') || txt.includes('ASEGURADORA') || txt.includes('NO DISPONIBLE');
  }

  // Notificaciones flotantes fijas en el viewport (no requieren hacer scroll)
  function toast(msg, ok=false){
    if (!msg) return;
    let stack = $('toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toast-stack';
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }
    // Evitar duplicados idénticos consecutivos
    const last = stack.lastElementChild;
    if (last && last.dataset.msg === String(msg)) last.remove();
    while (stack.children.length >= 4) stack.firstElementChild.remove();

    const item = document.createElement('div');
    item.className = `toast-item ${ok ? 'ok' : 'danger'}`;
    item.setAttribute('role', ok ? 'status' : 'alert');
    item.dataset.msg = String(msg);
    const span = document.createElement('span');
    span.className = 'toast-msg';
    span.textContent = String(msg);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Cerrar');
    close.textContent = '×';
    const dismiss = () => {
      if (!item.isConnected) return;
      item.classList.add('toast-out');
      setTimeout(() => item.remove(), 200);
    };
    close.addEventListener('click', dismiss);
    item.append(span, close);
    stack.appendChild(item);
    setTimeout(dismiss, ok ? 4000 : 7000);
  }
  const toNumberOrNull = (v)=>{ if(v==null||v==='')return null; const n=Number(v); return Number.isFinite(n)?n:null; };

  function getTodayLocalISO() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function formatDate(dateInput) {
    if (dateInput === null || dateInput === undefined || String(dateInput).trim() === '') return '—';
    const s = String(dateInput).trim();
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      const [, y, m, d] = isoMatch;
      return `${d}/${m}/${y}`;
    }
    const dObj = new Date(dateInput);
    if (!isNaN(dObj.getTime())) {
      const day = String(dObj.getDate()).padStart(2, '0');
      const month = String(dObj.getMonth() + 1).padStart(2, '0');
      const year = dObj.getFullYear();
      return `${day}/${month}/${year}`;
    }
    return s;
  }
  window.formatDate = formatDate;

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
  let OFICIALIAS_LIST = [];
  let SOL_SIG_PAD = null;
  let CONSULTA_SIG_PAD = null;
  let RESETTING_SOL_FLOW = false; // guardia anti-recursión showView <-> resetSolicitudFlow
  const uiPerms = ()=> UI_PERMISOS?.permisos || {};
  const getAssignedRubroId = () => {
    const uname = String(CURRENT_USER?.username || UI_PERMISOS?.user || '').toLowerCase().trim();
    if (uname === 'jesus') return 3;
    if (['luismayoral', 'luiseduardo', 'luis'].includes(uname)) return 4;
    if (uname === 'evelia') return 2;
    const r = Number(uiPerms().regionalRubroId || UI_PERMISOS?.rubro_id || CURRENT_USER?.rubro_id || 0);
    return r > 1 ? r : null;
  };

  function getLoggedUserFullName() {
    if (!CURRENT_USER) return '';
    const uName = norm(CURRENT_USER.username || UI_PERMISOS?.user || '');
    if (uName === 'GABRIELFIOL' || uName === 'FIOL' || uName === 'ENCARGADO') {
      return 'Gabriel Adán Fiol Collins';
    }
    const n = safestr(CURRENT_USER.nombre || CURRENT_USER.NOMBRE);
    const a1 = safestr(CURRENT_USER.PRIMER_APELLIDO || CURRENT_USER.primer_apellido || CURRENT_USER.primer_ap);
    const a2 = safestr(CURRENT_USER.SEGUNDO_APELLIDO || CURRENT_USER.segundo_apellido || CURRENT_USER.segundo_ap);
    let built = '';
    if (n) {
      const nNorm = norm(n);
      const parts = [n];
      if (a1 && !nNorm.includes(norm(a1))) parts.push(a1);
      if (a2 && !nNorm.includes(norm(a2))) parts.push(a2);
      built = parts.join(' ').replace(/\s+/g, ' ').trim();
    } else {
      built = [a1, a2].filter(Boolean).join(' ').trim();
    }
    return safestr(built || CURRENT_USER.nombre_completo || CURRENT_USER.username || '');
  }

  function renderPruebaBadge(esPrueba) {
    return Number(esPrueba) === 1
      ? ' <span class="badge-prueba" title="Registro de prueba (No afecta inventarios reales)">🧪 PRUEBA</span>'
      : '';
  }

  function getSolicitudStatusBadgeHtml(statusRaw) {
    const st = String(statusRaw || 'PENDIENTE').trim().toUpperCase();
    let cls = 'status-pendiente';
    let label = st;
    if (st === 'EN_PROCESO') {
      cls = 'badge-status-en-proceso';
      label = 'EN PROCESO';
    } else if (st === 'PARA_FIRMAS') {
      cls = 'badge-status-para-firmas';
      label = 'PARA FIRMAS';
    } else if (['COMPLETADA', 'SURTIDA', 'SURTIDO', 'ENTREGADA', 'ENTREGADO', 'APROBADA'].includes(st)) {
      cls = 'badge-status-completada';
      label = st === 'COMPLETADA' ? 'COMPLETADA' : st;
    } else if (['CANCELADA', 'CANCELADO', 'RECHAZADA'].includes(st)) {
      cls = 'status-cancelada';
    }
    return `<span class="status-badge ${cls}">${escHtml(label)}</span>`;
  }

  // Regla de Negocio: Inventario General (Estatal) exclusivo para Rodrigo Molina, Jorge Patrón y Admin
  function canViewInventarioGeneral(user = CURRENT_USER) {
    if (!user) return false;
    const uname = String(user.username || UI_PERMISOS?.user || '').toLowerCase().trim();
    const role = String(user.rol || user.role || UI_PERMISOS?.rol || '').toLowerCase().trim();
    return (
      role === 'admin' ||
      uname === 'admin' ||
      uname === 'rodrigo' ||
      uname === 'jorge' ||
      uname === 'jorgepatron'
    );
  }

  // Control de Acceso Estricto al Módulo de Tabletas Digitales:
  // Solo Admin, Luis Eduardo (operativo completo) y Jorge/Rodrigo (solo lectura). Gabriel Fiol y demás usuarios quedan bloqueados.
  function canViewTabletas(user = CURRENT_USER) {
    const u = user || CURRENT_USER || {};
    const uname = String(u.username || UI_PERMISOS?.user || '').toLowerCase().trim();
    const role = String(u.rol || u.role || UI_PERMISOS?.rol || '').toUpperCase().trim();
    const fullName = [u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO, u.primer_ap, u.segundo_ap, u.nombre_completo]
      .filter(Boolean)
      .join(' ')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (uname === 'gabrielfiol' || uname === 'fiol' || uname === 'encargado' || fullName.includes('fiol')) {
      return false;
    }
    if (role === 'ADMIN' || uname === 'admin') return true;
    if (['luiseduardo', 'luismayoral'].includes(uname) || fullName.includes('luis eduardo') || fullName.includes('mayoral geraldo')) {
      return true;
    }
    if (['jorge', 'jorgepatron', 'rodrigo'].includes(uname) || fullName.includes('jorge luis patron') || fullName.includes('rodrigo molina')) {
      return true;
    }
    return false;
  }

  function canEditTabletas(user = CURRENT_USER) {
    const u = user || CURRENT_USER || {};
    const uname = String(u.username || UI_PERMISOS?.user || '').toLowerCase().trim();
    const role = String(u.rol || u.role || UI_PERMISOS?.rol || '').toUpperCase().trim();
    const fullName = [u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO, u.primer_ap, u.segundo_ap, u.nombre_completo]
      .filter(Boolean)
      .join(' ')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (uname === 'gabrielfiol' || uname === 'fiol' || uname === 'encargado' || fullName.includes('fiol')) {
      return false;
    }
    if (['jorge', 'jorgepatron', 'rodrigo'].includes(uname)) {
      return false;
    }
    if (role === 'ADMIN' || uname === 'admin') return true;
    if (['luiseduardo', 'luismayoral'].includes(uname) || fullName.includes('luis eduardo') || fullName.includes('mayoral geraldo')) {
      return true;
    }
    return false;
  }

  function getRegionalSignatureScopeFront(user = CURRENT_USER) {
    const u = user || CURRENT_USER || {};
    const uname = String(u.username || UI_PERMISOS?.user || '').toLowerCase().trim();
    if (uname === 'loscabos') return 'LOS CABOS';
    if (uname === 'mulege') return 'MULEGE';
    if (uname === 'comondu') return 'COMONDU';
    return null;
  }

  function normalizeTabletaForaneaRegionFront(regionStr) {
    const clean = String(regionStr || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return null;
    if (clean.includes('CABOS')) return 'LOS CABOS';
    if (clean.includes('MULEGE') || clean.includes('GUERRERO')) return 'MULEGE';
    if (clean.includes('COMONDU') || clean.includes('LORETO')) return 'COMONDU';
    return null;
  }

  function canViewFirmasTabletas(user = CURRENT_USER) {
    const u = user || CURRENT_USER || {};
    const uname = String(u.username || UI_PERMISOS?.user || '').toLowerCase().trim();
    const role = String(u.rol || u.role || UI_PERMISOS?.rol || '').toUpperCase().trim();
    if (getRegionalSignatureScopeFront(u)) return true;
    if (role === 'ADMIN' || uname === 'admin') return true;
    return false;
  }

  // Regla de Negocio: solo Administrador puede elegir cualquier departamento (Gabriel Fiol solicita bajo su área)
  const canUserSelectAnyDepartment = () => {
    const uname = norm(CURRENT_USER?.username || UI_PERMISOS?.user || '');
    if (uname === 'gabrielfiol' || uname === 'fiol' || uname === 'encargado') return false;
    if (uiPerms().puedeSeleccionarCualquierDepartamento !== undefined) {
      return Boolean(uiPerms().puedeSeleccionarCualquierDepartamento);
    }
    if (CURRENT_USER?.puede_seleccionar_cualquier_departamento !== undefined) {
      return Boolean(CURRENT_USER.puede_seleccionar_cualquier_departamento);
    }
    const rol = norm(CURRENT_USER?.rol || UI_PERMISOS?.rol || '');
    return rol === 'ADMIN' || uname === 'admin';
  };

  const getBloqueReceptorVale = () => $('bloque-receptor-vale') || $('vp_bloque_quien_recibe');
  const getTipoValeSelect = () => $('vp_tipo_vale') || $('vp_modalidad');

  const isAuditorUser = () => {
    const uname = norm(CURRENT_USER?.username || UI_PERMISOS?.user || '');
    return ['RODRIGO', 'JORGE', 'JORGEPATRON'].includes(uname);
  };

  const canUserUseCuatroFirmas = () => {
    const uname = norm(CURRENT_USER?.username || UI_PERMISOS?.user || '');
    const rol = norm(CURRENT_USER?.rol || UI_PERMISOS?.rol || '');
    if (rol === 'ADMIN' || uname === 'ADMIN') return true;
    const allowed = ['RODRIGO', 'JORGE', 'JORGEPATRON', 'LUISEDUARDO', 'LUIS', 'GABRIELFIOL', 'FIOL', 'ENCARGADO', 'EVELIA', 'JESUS'];
    if (allowed.includes(uname)) return true;
    if (rol === 'ENCARGADO') return true;
    return false;
  };

  const canUserEditQuienRecibe = () => {
    return canUserUseCuatroFirmas();
  };

  const canUserSeeAllSolicitudes = () => {
    if (uiPerms().puedeVerTodasSolicitudes !== undefined) {
      return Boolean(uiPerms().puedeVerTodasSolicitudes);
    }
    const uname = norm(CURRENT_USER?.username || UI_PERMISOS?.user || '');
    const rol = norm(CURRENT_USER?.rol || UI_PERMISOS?.rol || '');
    return rol === 'ADMIN' || rol === 'ENCARGADO' || uname === 'admin' || uname === 'gabrielfiol' || uname === 'fiol' || uname === 'encargado';
  };

  function getUserAssignedDepartment() {
    const uName = norm(CURRENT_USER?.username || UI_PERMISOS?.user || '');
    if (uName === 'gabrielfiol' || uName === 'fiol' || uName === 'encargado') {
      return { id: 30030008, nombre: 'Encargado de Archivos y Materiales' };
    }
    let id = Number(CURRENT_USER?.departamento_id || CURRENT_USER?.id_oficialia || 0);
    let nombre = safestr(CURRENT_USER?.departamento_nombre || CURRENT_USER?.oficialia_nombre || CURRENT_USER?.departamento);
    if (!id) {
      const regId = Number(CURRENT_USER?.region_id || UI_PERMISOS?.scope?.region_id || 0);
      if (uName === 'loscabos' || regId === 2) {
        id = 30030009;
        nombre = nombre || 'Enlace Regional Los Cabos';
      } else if (uName === 'mulege' || regId === 4) {
        id = 30030010;
        nombre = nombre || 'Enlace Regional Mulegé';
      } else if (uName === 'comondu' || regId === 3) {
        id = 30030011;
        nombre = nombre || 'Enlace Regional Comondú / Loreto';
      } else {
        id = 30030001;
        nombre = nombre || 'Recursos Materiales';
      }
    }
    return { id, nombre: nombre || `Departamento ${id}` };
  }

  function createSignaturePadController({ canvasId, clearBtnId, uploadInputId, statusId }) {
    const canvas = $(canvasId);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    let drawing = false;
    let hasStrokes = false;
    let uploadedDataUrl = null;

    function updateStatus(text, isSigned = false) {
      const st = $(statusId);
      if (!st) return;
      st.textContent = text;
      st.style.color = isSigned ? '#166534' : '';
      st.style.fontWeight = isSigned ? '600' : '';
    }

    function initCtx() {
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }
    initCtx();

    function getPos(ev) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / (rect.width || 1);
      const scaleY = canvas.height / (rect.height || 1);
      const touch = ev.touches?.[0] || ev.changedTouches?.[0];
      const clientX = touch ? touch.clientX : ev.clientX;
      const clientY = touch ? touch.clientY : ev.clientY;
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY
      };
    }

    function startDraw(ev) {
      if (ev.cancelable) ev.preventDefault();
      drawing = true;
      hasStrokes = true;
      uploadedDataUrl = null;
      initCtx();
      const p = getPos(ev);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    }

    function moveDraw(ev) {
      if (!drawing) return;
      if (ev.cancelable) ev.preventDefault();
      const p = getPos(ev);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      updateStatus('✓ Firma capturada en pad digital', true);
    }

    function endDraw(ev) {
      if (!drawing) return;
      if (ev && ev.cancelable) ev.preventDefault();
      drawing = false;
      ctx.closePath();
      if (hasStrokes) {
        updateStatus('✓ Firma capturada en pad digital', true);
      }
    }

    canvas.addEventListener('mousedown', startDraw);
    canvas.addEventListener('mousemove', moveDraw);
    window.addEventListener('mouseup', endDraw);
    canvas.addEventListener('mouseleave', endDraw);

    canvas.addEventListener('touchstart', startDraw, { passive: false });
    canvas.addEventListener('touchmove', moveDraw, { passive: false });
    canvas.addEventListener('touchend', endDraw, { passive: false });

    let clearing = false;
    function clear(ev) {
      // Limpia SOLO el canvas/estado local; nunca se invoca a sí mismo ni dispara flujos externos.
      if (clearing) return;
      clearing = true;
      try {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        hasStrokes = false;
        uploadedDataUrl = null;
        const up = uploadInputId ? $(uploadInputId) : null;
        if (up && up.value) up.value = '';
        updateStatus('Sin firma capturada', false);
      } finally {
        clearing = false;
      }
    }

    const clearBtnEl = clearBtnId ? $(clearBtnId) : null;
    clearBtnEl?.addEventListener('click', (ev) => {
      ev.preventDefault();
      clear(ev);
    });

    if (uploadInputId) $(uploadInputId)?.addEventListener('change', (ev) => {
      const file = ev.target?.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        if (!dataUrl.startsWith('data:image/')) {
          toast('Selecciona una imagen PNG válida', false);
          return;
        }
        const img = new Image();
        img.onload = () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const ratio = Math.min((canvas.width - 20) / (img.width || 1), (canvas.height - 16) / (img.height || 1));
          const w = (img.width || 1) * ratio;
          const h = (img.height || 1) * ratio;
          const x = (canvas.width - w) / 2;
          const y = (canvas.height - h) / 2;
          ctx.drawImage(img, x, y, w, h);
          hasStrokes = true;
          uploadedDataUrl = canvas.toDataURL('image/png');
          updateStatus(`✓ Imagen de firma cargada (${file.name})`, true);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });

    function getDataUrl() {
      if (uploadedDataUrl) return uploadedDataUrl;
      if (!hasStrokes) return null;
      return canvas.toDataURL('image/png');
    }

    return {
      clear,
      getDataUrl,
      hasSignature: () => Boolean(hasStrokes || uploadedDataUrl)
    };
  }

  // ============================================================================
  // FASE 3: DETECCIÓN DE REGIONES FORÁNEAS (FIRMA OBLIGATORIA SOLO PARA FORÁNEOS)
  // ============================================================================
  function isRegionForaneaObligatoriaFirma(regionStr) {
    if (!regionStr) return false;
    const normStr = String(regionStr)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase()
      .replace(/_/g, " ");
    return normStr.includes("los cabos") || normStr.includes("mulege") || normStr.includes("comondu");
  }

  function isCurrentUserRegionalForaneo() {
    const p = uiPerms();
    const scope = UI_PERMISOS?.scope || {};
    const uName = String(CURRENT_USER?.username || UI_PERMISOS?.user || '').trim().toLowerCase();
    const uRol = String(CURRENT_USER?.rol || UI_PERMISOS?.rol || '').trim().toUpperCase();
    // Admin, encargados y departamentos de La Paz NO están obligados a firmar digitalmente
    if (p.admin || uRol === 'ADMIN' || ['admin', 'gabrielfiol', 'fiol', 'encargado'].includes(uName)) {
      return false;
    }
    if (['loscabos', 'mulege', 'comondu', 'guerreronegro'].includes(uName)) {
      return true;
    }
    const regCod = String(scope.region_clave || scope.region_codigo || p.region_codigo || '').trim().toUpperCase();
    if (['LOS_CABOS', 'MULEGE', 'COMONDU', 'COMONDU_LORETO'].includes(regCod)) {
      return true;
    }
    const regId = Number(scope.region_id || p.region_id || CURRENT_USER?.region_id || 0);
    if ([2, 3, 4].includes(regId)) {
      return true;
    }
    const regName = String(scope.region_nombre || CURRENT_USER?.region_nombre || '').trim();
    return Boolean(scope.es_region_foranea || isRegionForaneaObligatoriaFirma(regName));
  }

  function syncSolicitudFirmaVisibility() {
    const p = uiPerms();
    const scope = UI_PERMISOS?.scope || {};
    const regSel = $('sol_region') || $('sol_region_solicitante');
    const firmaCard = $('sol_firma_card_wrap');
    const nombreWrap = $('sol_nombre_firma_wrap');

    const regCod = String(scope.region_clave || scope.region_codigo || p.region_codigo || '').toUpperCase();
    const regId = Number(scope.region_id || p.region_id || CURRENT_USER?.region_id || 0);
    const uName = norm(CURRENT_USER?.username || '');
    let userRegionLabel = 'La Paz';
    if (regCod === 'LOS_CABOS' || regId === 2 || uName === 'LOSCABOS') userRegionLabel = 'Los Cabos';
    else if (regCod === 'MULEGE' || regId === 4 || uName === 'MULEGE') userRegionLabel = 'Mulegé';
    else if (regCod === 'COMONDU_LORETO' || regId === 3 || uName === 'COMONDU') userRegionLabel = 'Comondú / Loreto';

    if (regSel && !p.admin) {
      regSel.value = userRegionLabel;
      regSel.disabled = true;
      regSel.title = 'Región asignada a tu perfil de usuario';
    } else if (regSel && p.admin) {
      regSel.disabled = false;
    }

    const selectedRegion = safestr(regSel?.value || userRegionLabel);
    const isSelectedForeign = ['los cabos', 'mulegé', 'mulege', 'comondú / loreto', 'comondu / loreto'].includes(selectedRegion.toLowerCase());
    const isUserForaneo = isCurrentUserRegionalForaneo();

    if (firmaCard) firmaCard.classList.remove('hidden');
    if (nombreWrap) nombreWrap.classList.remove('hidden');

    const firmaTitle = $('sol_firma_title') || firmaCard?.querySelector('.sig-pad-title');
    const firmaSubtitle = $('sol_firma_subtitle') || firmaCard?.querySelector('.sig-pad-header .muted');
    if (isUserForaneo) {
      if (firmaTitle) firmaTitle.textContent = '✍️ Firma Digital del Solicitante * (Obligatoria para envío a Almacén — Gabriel Adán Fiol Collins)';
      if (firmaSubtitle) firmaSubtitle.textContent = 'Dibuja tu firma digital en el recuadro o adjunta tu firma en imagen PNG antes de continuar.';
    } else {
      if (firmaTitle) firmaTitle.textContent = '✍️ Firma Digital del Solicitante (Opcional)';
      if (firmaSubtitle) firmaSubtitle.textContent = 'Puedes dibujar tu firma digital o adjuntar una imagen PNG si lo deseas, o continuar sin firmar.';
    }

    const nameIn = $('sol_nombre_firma');
    if (nameIn) {
      if (isSelectedForeign) {
        const titular = getTitularRegionalFromText(selectedRegion) || getTitularRegionalFromText(uName);
        const cur = safestr(nameIn.value).trim();
        const isKnownTitularOrPlaceholder =
          !cur ||
          Object.values(TITULARES_REGIONALES_V59).includes(cur) ||
          /enlace regional|nieves flores/i.test(cur);
        if (titular && isKnownTitularOrPlaceholder) nameIn.value = titular;
      } else if (!safestr(nameIn.value)) {
        const ownFull = getLoggedUserFullName();
        if (ownFull) nameIn.value = ownFull;
      }
    }
  }

  function applyPermassions(){  
    const p = uiPerms();
    const uname = String(CURRENT_USER?.username || UI_PERMISOS?.user || '').toLowerCase().trim();
    const isFiol = uname === 'gabrielfiol' || uname === 'fiol';
    const hideReportesGraficas = !p.reportes?.acceso || isFiol;

    // 1. Ocultar/mostrar botones del Sidebar según el rol
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(btn => {  
      const v = (btn.dataset.view || '').toLowerCase();
      if (v === 'almacen') {
        btn.classList.toggle('hidden', !p.puedeAccederAlmacen);
      } else if (v === 'regional') {
        btn.classList.toggle('hidden', !p.puedeAccederRegional);
      } else if (v === 'inventario_estatal') {
        btn.classList.toggle('hidden', !canViewInventarioGeneral());
      } else if (v === 'tabletas') {
        const canTab = canViewTabletas(CURRENT_USER);
        btn.classList.toggle('hidden', !canTab);
        if (!canTab) {
          btn.style.display = 'none';
        } else {
          btn.style.removeProperty('display');
        }
      } else if (v === 'firmas_tabletas') {
        const canFirmasTab = canViewFirmasTabletas(CURRENT_USER);
        btn.classList.toggle('hidden', !canFirmasTab);
        if (!canFirmasTab) {
          btn.style.display = 'none';
        } else {
          btn.style.removeProperty('display');
        }
      } else if (v === 'reporte' || v === 'graficas') {
        btn.classList.toggle('hidden', hideReportesGraficas);
        if (hideReportesGraficas) {
          btn.style.display = 'none';
        } else {
          btn.style.removeProperty('display');
        }
      } else if (v === 'auditoria') {
        btn.classList.toggle('hidden', !p.verLogs);
      } else if (v === 'usuarios') {
        btn.classList.toggle('hidden', !p.gestionarUsuarios);
      }
    });  

    if (hideReportesGraficas) {
      if ($('nav-reportes')) { $('nav-reportes').classList.add('hidden'); $('nav-reportes').style.display = 'none'; }
      if ($('nav-graficas')) { $('nav-graficas').classList.add('hidden'); $('nav-graficas').style.display = 'none'; }
      if ($('view-reporte')) { $('view-reporte').classList.add('hidden'); $('view-reporte').style.display = 'none'; }
      if ($('view-graficas')) { $('view-graficas').classList.add('hidden'); $('view-graficas').style.display = 'none'; }
    }  

    // 2. Botones de Inventario Regional según permisos de edición / PDF
    if ($('btn-reg-add')) $('btn-reg-add').classList.toggle('hidden', !p.puedeEditarRegional);
    if ($('btn-reg-pdf')) {
      const canPdf = Boolean(p.puedeGenerarPdfRegional);
      $('btn-reg-pdf').classList.toggle('hidden', !canPdf);
      $('btn-reg-pdf').disabled = !canPdf;
    }

    // 2B. Botones del módulo de Tabletas Digitales según permisos estrictos
    const canViewTab = canViewTabletas(CURRENT_USER);
    const canEditTab = canEditTabletas(CURRENT_USER);
    const canFirmasTab = canViewFirmasTabletas(CURRENT_USER);
    if (!canViewTab && $('view-tabletas')) {
      $('view-tabletas').classList.add('hidden');
      $('view-tabletas').style.display = 'none';
    }
    if (!canFirmasTab && $('view-firmas_tabletas')) {
      $('view-firmas_tabletas').classList.add('hidden');
      $('view-firmas_tabletas').style.display = 'none';
    }
    if ($('btn-tab-agregar')) $('btn-tab-agregar').classList.toggle('hidden', !canEditTab);
    if ($('btn-tab-nuevo-resguardo')) $('btn-tab-nuevo-resguardo').classList.toggle('hidden', !canEditTab);
    if ($('btn-tab-importar-excel')) $('btn-tab-importar-excel').classList.toggle('hidden', !canEditTab);
    if ($('btn-tab-bitacora')) $('btn-tab-bitacora').classList.toggle('hidden', !canViewTab);

    // 2C. Acceso a Vales Provisionales (v61: Oculto para Gabriel Fiol ya que Rubro 1 se solicita por Solicitudes de Almacén; Luis Mayoral restringido a Rubro 4)
    const isLuisRubro4 = !p.admin && getAssignedRubroId() === 4;
    if ($('nav-vales-prestamo')) {
      if (isFiol) {
        $('nav-vales-prestamo').classList.add('hidden');
        $('nav-vales-prestamo').style.display = 'none';
      } else {
        $('nav-vales-prestamo').classList.remove('hidden');
        $('nav-vales-prestamo').style.removeProperty('display');
      }
    }
    if ($('btn-sol-modo-prestamo')) {
      $('btn-sol-modo-prestamo').classList.toggle('hidden', isFiol);
      if (isFiol) $('btn-sol-modo-prestamo').style.display = 'none';
      else $('btn-sol-modo-prestamo').style.removeProperty('display');
    }
    if ($('tipo_solicitud')) {
      const optPrestamo = $('tipo_solicitud').querySelector('option[value="PRESTAMO_ACTIVOS"]');
      if (optPrestamo) {
        optPrestamo.hidden = isFiol;
        optPrestamo.disabled = isFiol;
      }
    }
    // v61: Ocultar pestaña Paso 4 (Descargar PDF) en creación de solicitudes para todos los usuarios (las órdenes nuevas van a revisión de Fiol)
    if ($('btn-sol-tab-pdf')) {
      $('btn-sol-tab-pdf').classList.add('hidden');
      $('btn-sol-tab-pdf').style.display = 'none';
    }
    if ($('vp_rubro_id')) {
      if (isLuisRubro4) {
        $('vp_rubro_id').value = '4';
        $('vp_rubro_id').disabled = true;
        $('vp_rubro_id').classList.add('readonly');
        $('vp_rubro_id').title = 'Rubro exclusivo asignado: 4. Tabletas Digitales (Luis Eduardo Mayoral Geraldo)';
      } else {
        $('vp_rubro_id').disabled = false;
        $('vp_rubro_id').classList.remove('readonly');
      }
    }
    if ($('vp_filter_rubro')) {
      if (isLuisRubro4) {
        $('vp_filter_rubro').value = '4';
        $('vp_filter_rubro').disabled = true;
        $('vp_filter_rubro').classList.add('readonly');
      } else {
        $('vp_filter_rubro').disabled = false;
        $('vp_filter_rubro').classList.remove('readonly');
      }
    }

    // 3. Selector de área/usuario al crear solicitud: bloqueado si no es admin ni gabrielfiol
    const uidIn = $('sol_user_id');  
    if (uidIn){  
      if (!canUserSelectAnyDepartment()) {
        uidIn.disabled = true;
        uidIn.classList.add('readonly');
        const userDepto = getUserAssignedDepartment();
        if (userDepto.id && (!uidIn.value || uidIn.value !== String(userDepto.id))) {
          uidIn.value = String(userDepto.id);
        }
        uidIn.title = `Área asignada fija: ${userDepto.nombre}`;
      } else {
        uidIn.disabled = false;
        uidIn.classList.remove('readonly');
        uidIn.title = 'Selecciona el área solicitante';
      }
    }

    const vpDeptoIn = $('vp_departamento_id');
    if (vpDeptoIn) {
      if (!canUserSelectAnyDepartment()) {
        vpDeptoIn.disabled = true;
        vpDeptoIn.classList.add('readonly');
        const userDepto = getUserAssignedDepartment();
        if (userDepto.id && (!vpDeptoIn.value || vpDeptoIn.value !== String(userDepto.id))) {
          vpDeptoIn.value = String(userDepto.id);
        }
        vpDeptoIn.title = `Área asignada fija: ${userDepto.nombre}`;
      } else {
        vpDeptoIn.disabled = false;
        vpDeptoIn.classList.remove('readonly');
        vpDeptoIn.title = 'Selecciona el área solicitante';
      }
    }  

    // 4. Visibilidad de Firma Digital al crear solicitud (solo regiones foráneas)
    syncSolicitudFirmaVisibility();

    // 5. Menú y botones de acciones sobre solicitudes
    updateSolicitudActionsVisibility(CONSULTA_STATUS);

    // 6. Modalidades y campos permitidos en vales de préstamo
    syncVpModalidadOptions();
    syncVpQuienRecibeVisibility();
  }

  let API = ''; 
  async function ensureAPI(){ return API || ''; }
  async function api(path, opts = {}){ const base = await ensureAPI(); const url = (/^https?:\/\//.test(path) ? path : (base + path)); return fetch(url, { credentials:'include', ...opts }); }
  async function apiJSON(path, opts = {}){
    const res = await api(path, { headers:{'Accept':'application/json', ...(opts.headers||{})}, ...opts });
    const text = await res.text(); const json = (()=>{ try{return JSON.parse(text);}catch{return null;} })();
    if (!res.ok){
      let msg = json?.error || json?.message || json?.massage || '';
      if (!msg) {
        const looksHtml = /<\/?[a-z][\s\S]*>/i.test(text || '');
        if (looksHtml) {
          const pre = (text.match(/<pre>([\s\S]*?)<\/pre>/i) || [])[1] || '';
          msg = pre ? `Cannot ${pre.replace(/^Cannot\s*/i, '').trim()}` : `Error del servidor (HTTP ${res.status})`;
        } else {
          msg = text || `HTTP ${res.status}`;
        }
      }
      throw new Error(msg);
    }
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
    routeKey('DELETE', '/api/solicitudes/:id'),
    routeKey('POST', '/api/solicitudes/:id/firma'),
    routeKey('GET', '/api/regiones'),
    routeKey('GET', '/api/oficinas'),
    routeKey('GET', '/api/rubros'),
    routeKey('GET', '/api/inventario-regional'),
    routeKey('POST', '/api/inventario-regional'),
    routeKey('PUT', '/api/inventario-regional/:id'),
    routeKey('PUT', '/api/inventario-regional/:id/forzar-retorno'),
    routeKey('POST', '/api/inventario-regional/:id/forzar-retorno'),
    routeKey('POST', '/api/inventario-regional/transferir'),
    routeKey('POST', '/api/inventario-regional/:id/transferir'),
    routeKey('POST', '/api/inventario-regional/formatos'),
    routeKey('POST', '/api/inventario-regional/homologar-claves'),
    routeKey('DELETE', '/api/inventario-regional/:id'),
    routeKey('GET', '/api/ver-bitacora'),
    routeKey('GET', '/api/admin/backups'),
    routeKey('POST', '/api/admin/backups/restore'),
    routeKey('POST', '/api/migracion/consolidar-bodega-rm-jesus'),
    routeKey('PUT', '/api/usuarios/:id/perfil'),
    routeKey('GET', '/api/tabletas'),
    routeKey('POST', '/api/tabletas'),
    routeKey('GET', '/api/tabletas/bitacora'),
    routeKey('PUT', '/api/tabletas/:id'),
    routeKey('DELETE', '/api/tabletas/:id'),
    routeKey('POST', '/api/tabletas/importar-nombres'),
    routeKey('POST', '/api/tabletas/:id/generar-devolucion'),
    routeKey('PUT', '/api/tabletas/movimientos/:movId/confirmar-devolucion'),
    routeKey('POST', '/api/tabletas/:id/generar-resguardo'),
    routeKey('GET', '/api/tabletas/devoluciones/badge'),
    routeKey('GET', '/api/tabletas/devoluciones/pendientes-firma'),
    routeKey('POST', '/api/tabletas/devoluciones/:movimientoId/firmar'),
    routeKey('POST', '/api/tabletas/devoluciones/:movimientoId/rechazar'),
    routeKey('POST', '/api/tabletas/devoluciones/:movimientoId/cancelar'),
    routeKey('GET', '/api/tabletas/evidencias/:movimientoId/:tipo'),
    routeKey('GET', '/api/tabletas/:id/resguardo-evidencias-pdf'),
    routeKey('PUT', '/api/vales-prestamo/:id/autorizar'),
    routeKey('PUT', '/api/vales-prestamo/:id/devolver'),
    routeKey('PUT', '/api/vales-prestamo/:id/cancelar'),
    routeKey('PUT', '/api/solicitudes/:id/estado'),
    routeKey('PATCH', '/api/solicitudes/:id/estado')
  ]);
  async function hasRoute(method, path){ return APP_ROUTES.has(routeKey(method, path)); }

  function syncDefaultNombreFirmaFromOficialia(force = false) {
    const createSel = $('sol_user_id');
    const nameIn = $('sol_nombre_firma');
    if (!createSel || !nameIn) return;
    const uName = norm(CURRENT_USER?.username || UI_PERMISOS?.user || '');
    if (uName === 'GABRIELFIOL' || uName === 'FIOL' || uName === 'ENCARGADO') {
      nameIn.value = 'Gabriel Adán Fiol Collins';
      return;
    }
    if (!force && safestr(nameIn.value)) return;
    const ownFull = getLoggedUserFullName();
    if (!canUserSelectAnyDepartment() && ownFull) {
      nameIn.value = ownFull;
      return;
    }
    const selectedId = Number(createSel.value || 0);
    const found = OFICIALIAS_LIST.find(o => Number(o.id || 0) === selectedId);
    const jefe = safestr(found?.oficial_reponsable) || ownFull;
    if (jefe) nameIn.value = jefe;
  }

  async function loadSolicitudUsers(){
    const createSel = $('sol_user_id');
    if (!createSel) return;

    const currentCreate = createSel?.value || '';
    const userDepto = getUserAssignedDepartment();
    let ofiRows = [];

    try{
      if (await hasRoute('GET','/api/oficialias')){
        const jo = await apiJSON('/api/oficialias');
        ofiRows = Array.isArray(jo?.data) ? jo.data : [];
      }
    }catch{}

    if (!ofiRows.length && userDepto.id){
      ofiRows = [{ id: userDepto.id, nombre: userDepto.nombre }];
    }

    const canSelectAny = canUserSelectAnyDepartment();
    let filteredOfi = [];

    if (!canSelectAny) {
      // Regla de Negocio 1 & 2:
      // Si el usuario no es admin ni gabrielfiol, SOLO puede ver y seleccionar su propio departamento asignado
      let myOfi = ofiRows.find(o => Number(o.id) === Number(userDepto.id));
      if (!myOfi) {
        myOfi = { id: userDepto.id, nombre: userDepto.nombre };
      }
      filteredOfi = [myOfi];
    } else {
      const p = uiPerms();
      const rolActual = norm(CURRENT_USER?.rol || UI_PERMISOS?.rol || 'USUARIO');
      const isAdminUser = Boolean(p.admin || rolActual === 'ADMIN');
      filteredOfi = ofiRows.filter(o => {
        const id = Number(o.id || 0);
        const name = String(o.nombre || '').trim().toLowerCase();
        const isAdminOfi = id === 30030000 || name.includes('administrador') || name.includes('direccion estatal');
        if (isAdminUser) return true;
        return !isAdminOfi;
      });
    }

    OFICIALIAS_LIST = filteredOfi;

    // Generar opciones con las áreas/oficialías permitidas
    createSel.innerHTML = filteredOfi.map(o => {
      const id = Number(o.id || 0);
      const nombre = safestr(o.nombre) || `Área ${id}`;
      return `<option value="${id}">${escHtml(nombre)}</option>`;
    }).join('') || '<option value="">Sin áreas disponibles</option>';

    if (!canSelectAny) {
      createSel.value = String(userDepto.id);
      createSel.disabled = true;
      createSel.classList.add('readonly');
      createSel.title = `Área asignada a tu perfil: ${userDepto.nombre}`;
      const uName = norm(CURRENT_USER?.username || UI_PERMISOS?.user || '');
      if (uName === 'gabrielfiol' || uName === 'fiol' || uName === 'encargado') {
        const nameIn = $('sol_nombre_firma');
        if (nameIn) nameIn.value = 'Gabriel Adán Fiol Collins';
      }
    } else {
      const validCurrent = currentCreate && filteredOfi.some(o => String(o.id) === String(currentCreate));
      createSel.value = validCurrent ? currentCreate : String(filteredOfi[0]?.id || userDepto.id);
      createSel.disabled = false;
      createSel.classList.remove('readonly');
      createSel.title = 'Selecciona el área solicitante';
    }

    syncDefaultNombreFirmaFromOficialia(false);

    const vpDeptoSel = $('vp_departamento_id');
    if (vpDeptoSel) {
      vpDeptoSel.innerHTML = filteredOfi.map(o => {
        const id = Number(o.id || 0);
        const nombre = safestr(o.nombre) || `Área ${id}`;
        return `<option value="${id}">${escHtml(nombre)}</option>`;
      }).join('') || '<option value="">Sin áreas disponibles</option>';

      if (!canSelectAny) {
        vpDeptoSel.value = String(userDepto.id);
        vpDeptoSel.disabled = true;
        vpDeptoSel.classList.add('readonly');
      } else {
        vpDeptoSel.value = String(filteredOfi[0]?.id || userDepto.id);
        vpDeptoSel.disabled = false;
        vpDeptoSel.classList.remove('readonly');
      }
    }

    const vpFilterDepto = $('vp_filter_depto');
    if (vpFilterDepto) {
      if (!canSelectAny) {
        vpFilterDepto.innerHTML = `<option value="${Number(userDepto.id || 0)}">${escHtml(userDepto.nombre)}</option>`;
        vpFilterDepto.value = String(userDepto.id);
        vpFilterDepto.disabled = true;
      } else {
        const opts = ['<option value="0">Todos los Departamentos</option>']
          .concat(filteredOfi.map(o => `<option value="${Number(o.id || 0)}">${escHtml(safestr(o.nombre))}</option>`));
        vpFilterDepto.innerHTML = opts.join('');
        vpFilterDepto.disabled = false;
      }
    }
  }

  async function loadSolicitudOficialias(){
    const listSel = $('list_oficialia');
    if (!listSel) return;
    const canSeeAll = canUserSeeAllSolicitudes();
    let rows = [];
    try{
      if (await hasRoute('GET','/api/oficialias')){
        const j = await apiJSON('/api/oficialias');
        rows = Array.isArray(j?.data) ? j.data : [];
      }
    }catch{}

    const userDepto = getUserAssignedDepartment();

    if (!canSeeAll) {
      // Regla de Negocio 2:
      // En el filtro del listado, ocultar "Todos los departamentos" y dejar fijo su departamento
      let myOfi = rows.find(r => Number(r.id) === Number(userDepto.id));
      if (!myOfi) {
        myOfi = { id: userDepto.id, nombre: userDepto.nombre };
      }
      listSel.innerHTML = `<option value="${Number(myOfi.id || 0)}">${escHtml(safestr(myOfi.nombre))}</option>`;
      listSel.value = String(myOfi.id);
      listSel.disabled = true;
      listSel.classList.add('readonly');
      listSel.title = `Filtro fijo a tu departamento: ${safestr(myOfi.nombre)}`;
    } else {
      const options = rows.map(r => `<option value="${Number(r.id || 0)}">${escHtml(safestr(r.nombre) || `Oficialía ${Number(r.id || 0)}`)}</option>`).join('');
      listSel.innerHTML = '<option value="">Todos los departamentos</option>' + (options || '');
      listSel.value = '';
      listSel.disabled = false;
      listSel.classList.remove('readonly');
      listSel.title = 'Filtrar por departamento';
    }
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

      const uName = norm(u.username || '');
      let rolDisplay = rol;
      if (uName === 'gabrielfiol' || uName === 'fiol' || uName === 'encargado') {
        rolDisplay = 'ENCARGADO DE ARCHIVOS Y MATERIALES';
      }

      if($('who'))$('who').textContent = u.username || u.nombre || 'usuario';
      if($('who_rol'))$('who_rol').textContent = `[${rolDisplay}]`; 
      
      applyPermassions();
      const unameLower = String(u.username || '').toLowerCase().trim();
      const isLuisMayoral = ['luismayoral', 'luiseduardo', 'luis'].includes(unameLower) || (!uiPerms().admin && Number(u.rubro_id || UI_PERMISOS?.rubro_id || 0) === 4);
      showView(isLuisMayoral ? 'tabletas' : 'panel_general'); 
      
      await Promise.all([loadSolicitudUsers(), loadSolicitudOficialias()]); 
      applyPermassions();
      startSolicitudesPolling();
      startTabletasBadgePolling();
    } catch(e) {
      console.error("Error en me():", e);
      window.location.replace('/');
    }
  }

  async function logout(){
    stopSolicitudesPolling();
    stopTabletasBadgePolling();
    try{ await apiJSON('/api/auth/logout', { method:'POST' }); }catch{}
    CURRENT_USER = null; UI_PERMISOS = null;
    window.location.replace('/');
  }

  function showView(id){
    // v53: Auto-cerrar Bitácora de Movimientos al cambiar de menú/pestaña
    if (typeof closeBitacoraModal === 'function') {
      try { closeBitacoraModal(); } catch (_) {}
    }

    const p = uiPerms();
    const uname = String(CURRENT_USER?.username || UI_PERMISOS?.user || '').toLowerCase().trim();
    const isFiol = uname === 'gabrielfiol' || uname === 'fiol';
    if ((id === 'reporte' || id === 'graficas') && (!p.reportes?.acceso || isFiol)) {
      toast('Acceso restringido', false);
      return showView(p.puedeAccederAlmacen ? 'almacen' : 'panel_general');
    }
    if (id === 'inventario_estatal' && !canViewInventarioGeneral()) {
      toast('Acceso exclusivo para Rodrigo Molina, Jorge Patrón y Administración', false);
      return showView('panel_general');
    }
    if (id === 'regional' && uiPerms().puedeAccederRegional === false) {
      toast('No tienes acceso al módulo de Inventario Regional', false);
      return showView('panel_general');
    }
    if (id === 'tabletas' && !canViewTabletas(CURRENT_USER)) {
      toast('Acceso exclusivo para Luis Eduardo Mayoral Geraldo, Recursos Materiales (Jorge Patrón / Rodrigo Molina) y Administración', false);
      return showView('panel_general');
    }
    if (id === 'firmas_tabletas' && !canViewFirmasTabletas(CURRENT_USER)) {
      toast('Acceso exclusivo para enlaces regionales (Los Cabos, Mulegé, Comondú) y Administración', false);
      return showView('panel_general');
    }
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
        const btnClone = btn.cloneNode(true);
        btnClone.querySelectorAll('.badge-pending, svg').forEach(n => n.remove());
        const labelClean = (btnClone.textContent || btn.textContent || '')
          .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]+\s*/u, '')
          .trim();
        breadcrumb.innerHTML = `Operación / <b>${escHtml(labelClean)}</b>`;
      }
    }

    if (id === 'panel_general') { if (typeof loadPanelGeneral === 'function') loadPanelGeneral(); }
    if (id === 'captura') {
      // IMPORTANTE: stayInCaptura:false para NO volver a llamar showView desde resetSolicitudFlow (evita recursión infinita)
      if (!RESETTING_SOL_FLOW && (SOL_FLOW_TAB === 'pdf' || SOL_READY_FOR_PDF || Boolean(SOL_ID) || !SOL_DRAFT_ACTIVE)) {
        resetSolicitudFlow({ stayInCaptura: false });
        setSolicitudTab('crear');
      }
      syncSolicitudFirmaVisibility();
    }
    if (id === 'solicitudes') { setSolicitudesTab('lista'); listarSolicitudes(); }
    if (id === 'almacen') { loadCategorias(); loadAlmacen(); }
    if (id === 'regional') {
      if (typeof loadRegionalFilters === 'function') {
        loadRegionalFilters().then(() => {
          if (typeof renderRegionalInventory === 'function') renderRegionalInventory();
        });
      }
    }
    if (id === 'inventario_estatal') {
      if (typeof loadInventarioEstatal === 'function') loadInventarioEstatal();
    }
    if (id === 'vales_prestamo') {
      if (typeof loadValesProvisionales === 'function') loadValesProvisionales();
    }
    if (id === 'tabletas') {
      if (typeof loadTabletasModule === 'function') loadTabletasModule();
    }
    if (id === 'firmas_tabletas') {
      if (typeof loadFirmasTabletasView === 'function') loadFirmasTabletasView();
    }
    if (id === 'reporte') { setReporteView('home'); loadReporteUsuarios(); }
    if (id === 'graficas') { loadGraficas(); }
    if (id === 'auditoria') { if (typeof loadAuditoria === 'function') loadAuditoria(); }
    if (id === 'usuarios') { if (typeof loadUsuariosAdmin === 'function') loadUsuariosAdmin(); }
  }

  async function loadPanelGeneral(){
    try {
      const solRes = await apiJSON('/api/solicitudes?limit=500&page=1');
      const rows = Array.isArray(solRes?.data) ? solRes.data : [];

      const total = rows.length;
      const pendientes = rows.filter(r => ['PENDIENTE', 'EN_PROCESO', 'PARA_FIRMAS'].includes(norm(r.status || r.STATUS))).length;
      const surtidas = rows.filter(r => ['COMPLETADA', 'APROBADA', 'SURTIDA', 'ENTREGADO', 'ENTREGADA'].includes(norm(r.status || r.STATUS))).length;

      if ($('kpi-ordenes-total'))$('kpi-ordenes-total').textContent = total;
      if ($('kpi-ordenes-pendientes'))$('kpi-ordenes-pendientes').textContent = pendientes;
      if ($('kpi-ordenes-autorizadas'))$('kpi-ordenes-autorizadas').textContent = surtidas;

      updateNavSolicitudesBadge(pendientes);
      if (!HAS_SEEN_INITIAL_SOL && rows.length) {
        rows.forEach(r => {
          const id = Number(r.id ?? r.ID ?? r.solicitud_id ?? r.SOLICITUD_ID);
          if (Number.isFinite(id) && id > 0) KNOWN_SOL_IDS.add(id);
        });
        HAS_SEEN_INITIAL_SOL = true;
      }

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
                    <th>Solicitante / Región</th>
                    <th>Departamento</th>
                    <th>Estatus / Firma</th>
                    <th>Acción</th>
                  </tr>
                </thead>
                <tbody>
                  ${recientes.map(r => {
                    const id = r.id ?? r.ID;
                    const status = String(r.status ?? r.STATUS ?? '-').toUpperCase();
                    const tieneFirma = Boolean(r.tiene_firma_digital || r.folio_firma_digital || r.firma_solicitante_data || r.firma_solicitante);
                    const firmaBadge = tieneFirma
                      ? `<div style="margin-top:4px;"><span class="badge-firma-digital" title="Sello: ${escHtml(safestr(r.folio_firma_digital || ''))}">✓ Firmado Digitalmente por Solicitante</span></div>`
                      : '';
                    const regTxt = safestr(r.region_solicitante) ? `<div class="muted" style="font-size:11px;">Región: ${escHtml(safestr(r.region_solicitante))}</div>` : '';
                    return `<tr>
                      <td><b>#${escHtml(id)}</b>${renderPruebaBadge(r.es_prueba)}</td>
                      <td>${escHtml(fmtDate(r.fecha_solicitud))}</td>
                      <td>${escHtml(safestr(r.nombre_solicitante_firma) || pickUsuario(r))}${regTxt}</td>
                      <td>${escHtml(safestr(r.oficialia_nombre || r.id_oficialia || '-'))}</td>
                      <td>${getSolicitudStatusBadgeHtml(status)}${firmaBadge}</td>
                      <td><button class="mini" data-open-sol="${escHtml(id)}">Revisar / Surtir</button></td>
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
                <td>${escHtml(r.id)}</td>
                <td><b>${escHtml(safestr(r.username))}</b></td>
                <td>${escHtml(safestr(r.ip_address))}</td>
                <td>${escHtml(f)}</td>
                <td>${exito}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    } catch (e) {
      box.innerHTML = `<div class="muted" style="color: var(--danger);">${escHtml(e.message || 'Error al cargar bitácora')}</div>`;
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
  let SOLICITUDES_POLLING_TIMER = null;
  let IS_AUTO_REFRESHING_SOL = false;
  const KNOWN_SOL_IDS = new Set();
  let HAS_SEEN_INITIAL_SOL = false;

  function setSolicitudListMode(mode){
    SOL_LIST_MODE = mode === 'canceladas' ? 'canceladas' : 'activas';
    $('btn-list-mode-activas')?.classList.toggle('active', SOL_LIST_MODE === 'activas');
    $('btn-list-mode-canceladas')?.classList.toggle('active', SOL_LIST_MODE === 'canceladas');
  }

  function updateNavSolicitudesBadge(count) {
    let badge = $('nav-sol-badge');
    if (!badge) {
      const navBtn = $('nav-solicitudes');
      if (navBtn) {
        badge = document.createElement('span');
        badge.id = 'nav-sol-badge';
        badge.className = 'badge-pending';
        badge.style.cssText = 'background:#e11d48; color:#fff; font-size:11px; font-weight:700; border-radius:10px; padding:1px 7px; margin-left:auto; line-height:16px;';
        navBtn.appendChild(badge);
      }
    }
    if (badge) {
      const n = Number(count || 0);
      if (n > 0) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.classList.remove('hidden');
        badge.style.display = 'inline-block';
        badge.title = `${n} orden(es) pendiente(s)`;
      } else {
        badge.textContent = '0';
        badge.classList.add('hidden');
        badge.style.display = 'none';
        badge.title = '';
      }
    }
  }

  function isSolicitudesListViewActive() {
    // 1. Pestaña en segundo plano (document.hidden)
    if (document.hidden) return false;

    // 2. Vista principal de solicitudes activa
    const viewSol = $('view-solicitudes');
    if (!viewSol || viewSol.classList.contains('hidden') || viewSol.style.display === 'none') {
      return false;
    }

    // 3. Pestaña de listado dentro de solicitudes (NO consulta/detalle de una orden)
    if (typeof SOLICITUDES_TAB !== 'undefined' && SOLICITUDES_TAB !== 'lista') {
      return false;
    }
    const paneLista = $('solicitudes-pane-lista');
    if (!paneLista || paneLista.classList.contains('hidden') || paneLista.style.display === 'none') {
      return false;
    }
    const paneConsulta = $('solicitudes-pane-consulta');
    if (paneConsulta && (!paneConsulta.classList.contains('hidden') && paneConsulta.style.display !== 'none')) {
      return false;
    }

    // 4. Ningún modal abierto en pantalla
    const openModals = document.querySelectorAll('.modal-overlay, .modal');
    for (const m of openModals) {
      if (!m.classList.contains('hidden') && m.style.display !== 'none' && m.offsetParent !== null) {
        return false;
      }
    }

    // 5. Usuario no debe estar capturando/editando texto en inputs de la vista
    const activeEl = document.activeElement;
    if (activeEl && ['INPUT', 'TEXTAREA'].includes(activeEl.tagName) && activeEl.closest('#view-solicitudes')) {
      return false;
    }

    return true;
  }

  async function autoRefreshSolicitudesList() {
    if (IS_AUTO_REFRESHING_SOL) return;
    if (!isSolicitudesListViewActive()) return;

    IS_AUTO_REFRESHING_SOL = true;
    try {
      await listarSolicitudes({ isAutoRefresh: true });
    } catch (err) {
      console.debug('[AutoRefresh] Fallo en polling silencioso de solicitudes:', err?.message || err);
    } finally {
      IS_AUTO_REFRESHING_SOL = false;
    }
  }

  function startSolicitudesPolling() {
    if (SOLICITUDES_POLLING_TIMER) {
      clearInterval(SOLICITUDES_POLLING_TIMER);
      SOLICITUDES_POLLING_TIMER = null;
    }
    SOLICITUDES_POLLING_TIMER = setInterval(() => {
      autoRefreshSolicitudesList();
    }, 30000);
  }

  function stopSolicitudesPolling() {
    if (SOLICITUDES_POLLING_TIMER) {
      clearInterval(SOLICITUDES_POLLING_TIMER);
      SOLICITUDES_POLLING_TIMER = null;
    }
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

    // Asegurar que el formulario de préstamo se oculte al navegar pestañas de consumibles
    const panePrestamo = $('pane-prestamo-activos');
    if (panePrestamo) {
      panePrestamo.classList.add('hidden');
      panePrestamo.style.display = 'none';
    }
    if ($('sol-flow-tabs')) $('sol-flow-tabs').classList.remove('hidden');
    const flowStatus = document.querySelector('.sol-flow-status');
    if (flowStatus) flowStatus.classList.remove('hidden');
    $('btn-sol-modo-consumibles')?.classList.add('active');
    $('btn-sol-modo-prestamo')?.classList.remove('active');

    if (SOL_FLOW_TAB === 'agregar') {
      const prodSel = $('prod_sel');
      if (!prodSel || prodSel.options.length <= 1) {
        buscarProductos();
      }
    }

    if (SOL_FLOW_TAB === 'revision') {
      enrichDetalleRows(DET_ROWS).then(() => renderFlowDetalleView());
    }
  }

  function syncVpQuienRecibeVisibility() {
    const bloqueRecibe = getBloqueReceptorVale();
    if (!bloqueRecibe) return;

    const modSelect = getTipoValeSelect();
    const modVal = String(modSelect?.value || '2_FIRMAS');
    const allowed = canUserUseCuatroFirmas();
    const is4Firmas = allowed && (modVal === '4_FIRMAS' || modVal === '1');

    if (is4Firmas) {
      bloqueRecibe.style.display = 'block';
      bloqueRecibe.classList.remove('hidden');
    } else {
      bloqueRecibe.style.display = 'none';
      bloqueRecibe.classList.add('hidden');

      // Sincronizar automáticamente en segundo plano los campos de quien recibe con los del solicitante
      const solNombre = safestr($('vp_solicitante_nombre')?.value);
      const solCargo = safestr($('vp_solicitante_cargo')?.value);
      const deptoOption = $('vp_departamento_id')?.selectedOptions?.[0];
      const deptoNombre = deptoOption ? deptoOption.textContent.trim() : '';

      if ($('vale-recibe-nombre')) {
        $('vale-recibe-nombre').value = solNombre;
      }
      if ($('vale-recibe-cargo')) {
        $('vale-recibe-cargo').value = solCargo || deptoNombre;
      }
    }
  }

  function syncVpModalidadOptions() {
    const modSelect = getTipoValeSelect();
    if (!modSelect) return;
    const allowed = canUserUseCuatroFirmas();
    const opt4 = modSelect.querySelector('option[value="4_FIRMAS"]');
    if (!allowed) {
      if (opt4) opt4.remove();
      modSelect.value = '2_FIRMAS';
    } else {
      if (!opt4) {
        const newOpt = document.createElement('option');
        newOpt.value = '4_FIRMAS';
        newOpt.textContent = 'Vale Préstamo Regional / Especial (4 Firmas - Indefinido u Opcional)';
        modSelect.appendChild(newOpt);
      }
    }
    syncVpMinDates();
    syncVpQuienRecibeVisibility();
  }

  function syncVpMinDates() {
    const todayLocal = getTodayLocalISO();
    const salidaIn = $('vp_fecha_salida');
    const devIn = $('vp_fecha_devolucion_estimada');
    const modSelect = getTipoValeSelect();
    const fDevWrap = $('vp_fecha_devolucion_wrap');
    const devLabel = $('vp_fecha_devolucion_label');
    const devHint = $('vp_fecha_devolucion_hint');

    const modVal = String(modSelect?.value || '2_FIRMAS');
    const is4Firmas = (modVal === '4_FIRMAS' || modVal === '1') && canUserUseCuatroFirmas();

    if (fDevWrap) {
      fDevWrap.style.display = 'block';
    }

    if (salidaIn) {
      salidaIn.min = todayLocal;
      if (!salidaIn.value || salidaIn.value < todayLocal) {
        salidaIn.value = todayLocal;
      }
    }

    if (devIn) {
      const minDev = (salidaIn && salidaIn.value && salidaIn.value >= todayLocal)
        ? salidaIn.value
        : todayLocal;
      devIn.min = minDev;

      if (is4Firmas) {
        devIn.removeAttribute('required');
        if (devLabel) {
          devLabel.innerHTML = 'Fecha Estimada de Devolución <span style="font-weight:normal; color:#64748b;">(Opcional - Indefinido si se deja vacío)</span>';
        }
        if (devHint) {
          devHint.style.display = 'block';
        }
        if (devIn.value && devIn.value < minDev) {
          devIn.value = minDev;
        }
      } else {
        devIn.setAttribute('required', 'required');
        if (devLabel) {
          devLabel.innerHTML = 'Fecha Estimada de Devolución <span style="color:#b91c1c;">*</span>';
        }
        if (devHint) {
          devHint.style.display = 'none';
        }
        if (!devIn.value || devIn.value < minDev) {
          devIn.value = minDev;
        }
      }
    }
  }

  function setSolicitudModo(modo){
    const uname = String(CURRENT_USER?.username || UI_PERMISOS?.user || '').toLowerCase().trim();
    const isFiol = uname === 'gabrielfiol' || uname === 'fiol' || uname === 'encargado';
    if (isFiol && modo === 'PRESTAMO_ACTIVOS') {
      toast('Los materiales de almacén (Rubro 1) se gestionan exclusivamente en Solicitudes de Almacén.', false);
      modo = 'CONSUMIBLES';
    }
    const isPrestamo = modo === 'PRESTAMO_ACTIVOS';
    const btnCons = $('btn-sol-modo-consumibles');
    const btnPrest = $('btn-sol-modo-prestamo');
    const flowTabs = $('sol-flow-tabs');
    const flowStatus = document.querySelector('.sol-flow-status');
    const panePrestamo = $('pane-prestamo-activos');
    const tipoSel = $('tipo_solicitud');

    if (btnCons) btnCons.classList.toggle('active', !isPrestamo);
    if (btnPrest) btnPrest.classList.toggle('active', isPrestamo);
    if (tipoSel && tipoSel.value !== modo) tipoSel.value = modo;

    if (isPrestamo) {
      if (flowStatus) flowStatus.classList.add('hidden');
      if (flowTabs) flowTabs.classList.add('hidden');
      $('sol-pane-crear')?.classList.add('hidden');
      $('sol-pane-agregar')?.classList.add('hidden');
      $('sol-pane-revision')?.classList.add('hidden');
      $('sol-pane-pdf')?.classList.add('hidden');
      if (panePrestamo) {
        panePrestamo.classList.remove('hidden');
        panePrestamo.style.display = 'block';
      }

      // Asignar rubro automático si el usuario tiene un rubro encargado (Jesús=3, Luis Eduardo=4, Evelia=2)
      const assignedRubro = getAssignedRubroId();
      if ($('vp_rubro_id')) {
        if (assignedRubro && assignedRubro >= 2) {
          $('vp_rubro_id').value = String(assignedRubro);
          if (!uiPerms().admin && assignedRubro === 4) {
            $('vp_rubro_id').disabled = true;
            $('vp_rubro_id').classList.add('readonly');
          }
        } else if (!$('vp_rubro_id').value || $('vp_rubro_id').value === '1') {
          $('vp_rubro_id').value = '2';
        }
      }

      // v61: Prellenar SIEMPRE con el nombre real del usuario logueado en sesión (NUNCA precargar "Sandra Guadalupe Salvatierra Amador" por región)
      const uNombreReal = getLoggedUserFullName();
      const userDepto = getUserAssignedDepartment();
      const uCargoReal = safestr(CURRENT_USER?.cargo || userDepto.nombre || CURRENT_USER?.departamento || '');
      const rolNorm = norm(CURRENT_USER?.rol || UI_PERMISOS?.rol || 'USUARIO');
      const isStandardUser = rolNorm === 'USUARIO' && !uiPerms().admin;

      if ($('vp_departamento_id') && userDepto.id && !canUserSelectAnyDepartment()) {
        $('vp_departamento_id').value = String(userDepto.id);
      }

      const solNombreIn = $('vp_solicitante_nombre');
      if (solNombreIn) {
        if (isStandardUser || !solNombreIn.value || /sandra guadalupe salvatierra amador/i.test(solNombreIn.value)) {
          solNombreIn.value = uNombreReal;
        }
        solNombreIn.readOnly = isStandardUser;
        solNombreIn.classList.toggle('readonly', isStandardUser);
      }
      const solCargoIn = $('vp_solicitante_cargo');
      if (solCargoIn) {
        if (isStandardUser || !solCargoIn.value) {
          solCargoIn.value = uCargoReal;
        }
      }
      if ($('vale-recibe-nombre')) {
        if (!$('vale-recibe-nombre').value || /sandra guadalupe salvatierra amador/i.test($('vale-recibe-nombre').value)) {
          $('vale-recibe-nombre').value = uNombreReal;
        }
      }
      if ($('vale-recibe-cargo') && !$('vale-recibe-cargo').value) {
        $('vale-recibe-cargo').value = uCargoReal;
      }
      syncVpModalidadOptions();
      syncVpMinDates();
      syncVpQuienRecibeVisibility();
      if (typeof loadVpCatalogo === 'function') loadVpCatalogo();
    } else {
      if (panePrestamo) {
        panePrestamo.classList.add('hidden');
        panePrestamo.style.display = 'none';
      }
      if (flowStatus) flowStatus.classList.remove('hidden');
      if (flowTabs) flowTabs.classList.remove('hidden');
      setSolicitudTab(SOL_FLOW_TAB || 'crear');
    }
  }

  function resetSolicitudFlow({ stayInCaptura = true } = {}){
    // Guardia de reentrada: evita el ciclo showView('captura') <-> resetSolicitudFlow()
    if (RESETTING_SOL_FLOW) return;
    RESETTING_SOL_FLOW = true;
    try {
      resetSolicitudFlowInner();
      // Mientras RESETTING_SOL_FLOW = true, showView('captura') solo muestra la vista y NO vuelve a resetear
      if (stayInCaptura) showView('captura');
      applyPermassions();
    } finally {
      RESETTING_SOL_FLOW = false;
    }
  }

  function resetSolicitudFlowInner(){
    SOL_ID = null; DET_SOL_ID = null; DET_ROWS = []; SOL_READY_FOR_PDF = false; CAPTURA_DIRTY = false;
    SOL_DRAFT = null; SOL_DRAFT_ACTIVE = false;
    if ($('tipo_solicitud')) $('tipo_solicitud').value = 'CONSUMIBLES';
    if ($('btn-sol-modo-consumibles')) $('btn-sol-modo-consumibles').classList.add('active');
    if ($('btn-sol-modo-prestamo')) $('btn-sol-modo-prestamo').classList.remove('active');
    const panePrestamo = $('pane-prestamo-activos');
    if (panePrestamo) {
      panePrestamo.classList.add('hidden');
      panePrestamo.style.display = 'none';
    }
    if ($('sol-flow-tabs')) $('sol-flow-tabs').classList.remove('hidden');
    const flowStatus = document.querySelector('.sol-flow-status');
    if (flowStatus) flowStatus.classList.remove('hidden');
    if ($('sol_region_solicitante')) $('sol_region_solicitante').value = 'La Paz';
    if ($('sol_region')) $('sol_region').value = 'La Paz';
    if ($('sol_nombre_firma')) $('sol_nombre_firma').value = '';
    if ($('obs_sol')) $('obs_sol').value = '';
    if ($('busca_prod')) $('busca_prod').value = '';
    if ($('prod_sel')) $('prod_sel').innerHTML = `<option value="">- selecciona producto -</option>`;
    if ($('det_cant')) $('det_cant').value = '1';
    if ($('det_obs')) $('det_obs').value = '';
    if ($('sol_edit_id')) $('sol_edit_id').value = '';
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
    if (SOL_SIG_PAD) {
      try { SOL_SIG_PAD.clear(); } catch {}
    }
    if ($('sol_firma_file')) $('sol_firma_file').value = '';
    if ($('sol_firma_status_badge')) {
      $('sol_firma_status_badge').textContent = 'Sin firma capturada';
      $('sol_firma_status_badge').className = 'status-badge status-pendiente';
    }
    if ($('sol_user_id')) {
      const sel = $('sol_user_id');
      const userDepto = getUserAssignedDepartment();
      const ownOfiStr = String(userDepto.id || '');
      const hasOwn = Array.from(sel.options).some(o => o.value === ownOfiStr);
      if (hasOwn) {
        sel.value = ownOfiStr;
      } else if (sel.options.length > 0) {
        sel.selectedIndex = 0;
      }
      if (!canUserSelectAnyDepartment()) {
        sel.disabled = true;
        sel.classList.add('readonly');
        sel.title = `Área asignada fija: ${userDepto.nombre}`;
      } else {
        sel.disabled = false;
        sel.classList.remove('readonly');
        sel.title = 'Selecciona el área solicitante';
      }
    }
    syncDefaultNombreFirmaFromOficialia(true);
    syncSolicitudFirmaVisibility();
    if ($('btn-list-consultar')) $('btn-list-consultar').disabled = true;
    if ($('btn-solicitudes-tab-consulta')) $('btn-solicitudes-tab-consulta').disabled = true;

    $('sol-pane-pdf')?.classList.add('hidden');
    $('sol-pane-revision')?.classList.add('hidden');
    $('sol-pane-agregar')?.classList.add('hidden');
    $('sol-pane-crear')?.classList.remove('hidden');

    updateSolBadge();
    setSolicitudTab('crear');
    setSolicitudesTab('lista');
  }

  function continuarAPaso2(){
    const uidIn  = $('sol_user_id');
    const userDepto = getUserAssignedDepartment();
    let ofiVal = null;
    if (!canUserSelectAnyDepartment()) {
      ofiVal = userDepto.id;
    } else {
      ofiVal = (uidIn && uidIn.value) ? Number(uidIn.value) : (userDepto.id ?? null);
    }
    const msg = $('msg_sol');
    if (!ofiVal){
      toast('Área solicitante requerida');
      if (msg) msg.textContent = 'Selecciona el área solicitante';
      return;
    }
    const tipo = $('tipo_solicitud')?.value || 'CONSUMIBLES';
    const obs  = $('obs_sol')?.value?.trim() || '';
    const regEl = $('sol_region') || $('sol_region_solicitante');
    const regionSol = safestr(regEl?.value) || 'La Paz';
    const nombreFirma = safestr($('sol_nombre_firma')?.value) || getLoggedUserFullName();
    if ($('sol_nombre_firma') && !safestr($('sol_nombre_firma').value) && nombreFirma) {
      $('sol_nombre_firma').value = nombreFirma;
    }
    if (!nombreFirma) {
      toast('Ingresa el nombre completo de quien solicita y firma', false);
      if (msg) msg.textContent = 'Ingresa el nombre completo de quien solicita y firma';
      $('sol_nombre_firma')?.focus();
      return;
    }
    const esForaneo = isCurrentUserRegionalForaneo();
    const hasSig = Boolean(SOL_SIG_PAD && SOL_SIG_PAD.hasSignature());
    const firmaData = hasSig ? (SOL_SIG_PAD.getDataUrl() || null) : null;
    if (esForaneo && (!firmaData || !hasSig)) {
      alert('La firma digital del solicitante es obligatoria para las regiones foráneas (Los Cabos, Mulegé o Comondú). Por favor dibuja o adjunta tu firma antes de continuar.');
      toast('✍️ La firma digital del solicitante es obligatoria para tu región.', false);
      if (msg) msg.textContent = '✍️ Dibuja o sube tu firma digital en el recuadro antes de continuar.';
      return;
    }

    SOL_DRAFT = {
      usuario_id: CURRENT_USER?.id ?? null,
      id_oficialia: Number(ofiVal),
      tipo_solicitud: tipo,
      observaciones: obs,
      region_solicitante: regionSol,
      nombre_solicitante_firma: nombreFirma,
      firma_solicitante: firmaData,
      firma_solicitante_data: firmaData
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

      const isActiveRow = (r) => {
        const st = String(r.status ?? r.STATUS ?? r.estado ?? r.ESTADO ?? 'ACTIVO').trim().toUpperCase();
        return !st || st === 'ACTIVO';
      };

      const appendProductOption = (r) => {
        const descClean = String(r.DESCRIPCION ?? r.descripcion ?? '').trim();
        const uniClean = String(r.UNIDAD ?? r.unidad ?? '').trim();
        const txt = uniClean ? `${descClean} (${uniClean})` : descClean;
        const opt = document.createElement('option');
        opt.value = r.CLAVE ?? r.clave ?? '';
        opt.textContent = txt;
        opt.dataset.source = 'almacen';
        opt.dataset.clave = r.CLAVE ?? r.clave ?? '';
        opt.dataset.desc = descClean;
        opt.dataset.cat = r.CATEGORIA_NOMBRE ?? r.CATEGORIA ?? r.categoria ?? '';
        opt.dataset.unidad = uniClean;
        opt.dataset.prodId = r.producto_id ?? r.PRODUCTO_ID ?? '';
        sel.appendChild(opt);
      };

      almRows.filter(isActiveRow).forEach(appendProductOption);

      if (!sel.options.length || sel.options.length <= 1){
        try{
          const js = await apiJSON(`/api/stock?q=${encodeURIComponent(q)}&page=1&limit=500`);
          (js.data||[]).filter(isActiveRow).forEach(appendProductOption);
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

    // Verificar si el producto ya fue agregado a la lista en memoria (se permite pedir cualquier producto activo aunque su existencia sea 0)
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

    // Limpiar campos para el siguiente producto (v62: conservar búsqueda y resultados para adición rápida)
    if ($('det_cant')) $('det_cant').value = '1';
    if ($('det_obs')) $('det_obs').value = '';
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

  // v44: Selección múltiple y persistente en Almacén General
  const selectedMaterialIds = new Set();
  let filterOnlySelected = false;

  // v44: Lematizador y normalizador de raíces para búsqueda flexible (acentos y plurales)
  function getSearchTokenRoots(queryStr) {
    if (!queryStr) return [];
    const normalized = String(queryStr)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
    if (!normalized) return [];

    const tokens = normalized.split(/\s+/).filter(Boolean);
    const roots = [];

    for (const token of tokens) {
      if (!token) continue;
      const variants = new Set([token]);
      // 1. -ces -> -z / -c (ej: lapices -> lapiz, lapic)
      if (token.endsWith("ces") && token.length > 3) {
        variants.add(token.slice(0, -3) + "z");
        variants.add(token.slice(0, -3) + "c");
      }
      // 2. Consonante + es (ej: plumones -> plumon, papeles -> papel, colores -> color; sobres -> sobre)
      else if (token.length > 3 && /[^aeiou]es$/i.test(token)) {
        variants.add(token.slice(0, -2));
        variants.add(token.slice(0, -1));
      }
      // 3. Vocal + s (ej: sillas -> silla, carpetas -> carpeta, toldos -> toldo)
      else if (token.length > 2 && /[aeiou]s$/i.test(token)) {
        variants.add(token.slice(0, -1));
      }
      roots.push(Array.from(variants));
    }
    return roots;
  }

  function matchFlexible(queryStr, ...fields) {
    if (!queryStr || !queryStr.trim()) return true;
    const tokenGroups = getSearchTokenRoots(queryStr);
    if (!tokenGroups.length) return true;

    const targetText = fields
      .filter(Boolean)
      .join(" ")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

    return tokenGroups.every(group =>
      group.some(variant => targetText.includes(variant))
    );
  } 

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
                <tr data-det="${escHtml(detId)}" data-index="${idx}">
                  <td><b>${escHtml(clave)}</b></td>
                  <td>${escHtml(desc)}</td>
                  <td>${escHtml(cat)}</td>
                  <td>${escHtml(uni)}</td>
                  <td><b>${cant}</b></td>
                  <td><input class="mini-in in-atendida" type="number" min="0" max="${cant}" value="${escHtml(atend)}"></td>
                  <td><input class="mini-in in-obs" type="text" value="${escHtml(obs)}"></td>
                  <td style="text-align:center;">
                    <button type="button" class="btn-del-det-row" data-index="${idx}" style="color:var(--danger, #ef4444); border:1px solid #fca5a5; background:transparent; padding:2px 8px; border-radius:4px; cursor:pointer;" title="Eliminar este producto">&times;</button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="actions" style="margin-top:1rem; display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn-primary" id="${escHtml(saveButtonId)}" type="button">Guardar solicitud</button>
      </div>
    `;
  }

  function buildConsultaDetalleHtml(rows){
    if (!rows?.length) return '<div class="muted">Sin renglones.</div>';
    const p = uiPerms();
    const stNorm = norm(CONSULTA_STATUS || 'PENDIENTE');
    const isClosed = ['COMPLETADA', 'SURTIDA', 'SURTIDO', 'ENTREGADA', 'ENTREGADO', 'CANCELADA', 'CANCELADO', 'RECHAZADA'].includes(stNorm);
    const isAuditorOnly = isAuditorUser();
    const puedeSurtir = !isAuditorOnly && Boolean(p.solicitudes?.puedeSurtir) && !isClosed;
    const canDownloadPdf = Boolean(p.solicitudes?.puedeDescargarPdf || p.admin || p.encargado || isAuditorOnly);
    const isStep2 = ['EN_PROCESO', 'EN_REVISION', 'PASO_2'].includes(stNorm);
    const isLockedFromStep3 = ['PARA_FIRMAS', 'PASO_3', 'COMPLETADA', 'SURTIDA', 'SURTIDO', 'ENTREGADA', 'ENTREGADO', 'APROBADA', 'PASO_4', 'CANCELADA', 'CANCELADO', 'RECHAZADA', 'RECHAZADO'].includes(stNorm);
    // Los inputs de cantidad_surtida y observaciones SOLO están habilitados en el Paso 2 (EN_PROCESO / EN_REVISION)
    const allowEditQty = Boolean(puedeSurtir && isStep2 && !isLockedFromStep3);

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
              ${puedeSurtir ? '<th>Stock Almacén</th>' : ''}
              <th>Cantidad Surtida</th>
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
              const stockAlm = Number(r.stock_almacen ?? r.STOCK_ALMACEN ?? r.STOCK ?? r.stock ?? 0) || 0;
              const hasSurtida = r.cantidad_surtida !== null && r.cantidad_surtida !== undefined && r.cantidad_surtida !== '';
              const rawAtend = hasSurtida ? Number(r.cantidad_surtida) : (Number(r.atendida ?? r.ATENDIDA ?? 0) || 0);
              const defaultAtend = (!hasSurtida && rawAtend === 0 && isStep2)
                ? Math.max(0, Math.min(cant, stockAlm))
                : rawAtend;
              const obs   = safestr(r.observaciones ?? r.OBSERVACIONES) || '';
              const isStockInsuf = puedeSurtir && stockAlm < cant;
              const stockStyle = isStockInsuf ? 'color:var(--danger, #dc2626); font-weight:700;' : 'font-weight:600;';
              const stockBadge = isStockInsuf
                ? `<span style="${stockStyle}">${stockAlm}</span> <span style="display:inline-block; font-size:10px; background:#fee2e2; color:#991b1b; border:1px solid #f87171; border-radius:3px; padding:1px 4px; margin-left:3px;">${stockAlm <= 0 ? 'Sin stock' : '¡Insuficiente!'}</span>`
                : `<span style="${stockStyle}">${stockAlm}</span>`;

              if (puedeSurtir) {
                return `<tr data-det="${escHtml(detId)}" data-clave="${escHtml(clave)}" data-desc="${escHtml(desc)}" data-cant="${cant}" data-stock="${stockAlm}">
                  <td><b>${escHtml(clave)}</b></td>
                  <td>${escHtml(desc)}</td>
                  <td>${escHtml(cat)}</td>
                  <td>${escHtml(uni)}</td>
                  <td><b>${cant}</b></td>
                  <td>${stockBadge}</td>
                  <td>${
                    allowEditQty
                      ? `<input class="mini-in in-atendida" type="number" min="0" max="${cant}" step="1" value="${defaultAtend}" style="width:80px; font-weight:700;">`
                      : (isLockedFromStep3
                          ? `<input class="mini-in in-atendida readonly" type="number" value="${defaultAtend}" disabled readonly tabindex="-1" style="width:80px; font-weight:700; background:#f1f5f9; color:#334155; cursor:not-allowed;" title="Cantidad bloqueada desde el Paso 3 (Para Firmas)">`
                          : `<b>${defaultAtend}</b> <span class="muted" style="font-size:11px;">(Acepta la orden para editar)</span>`)
                  }</td>
                  <td>${
                    allowEditQty
                      ? `<input class="mini-in in-obs" type="text" value="${escHtml(obs)}" placeholder="Opcional" style="max-width:200px;">`
                      : (isLockedFromStep3
                          ? `<input class="mini-in in-obs readonly" type="text" value="${escHtml(obs)}" disabled readonly tabindex="-1" placeholder="-" style="max-width:200px; background:#f1f5f9; color:#475569; cursor:not-allowed;" title="Observaciones bloqueadas desde el Paso 3 (Para Firmas)">`
                          : escHtml(obs || '-'))
                  }</td>
                </tr>`;
              }
              return `<tr>
                <td><b>${escHtml(clave)}</b></td>
                <td>${escHtml(desc)}</td>
                <td>${escHtml(cat)}</td>
                <td>${escHtml(uni)}</td>
                <td>${cant}</td>
                <td>${
                  isLockedFromStep3
                    ? `<input class="mini-in in-atendida readonly" type="number" value="${rawAtend}" disabled readonly tabindex="-1" style="width:80px; font-weight:700; background:#f1f5f9; color:#334155; cursor:not-allowed;">`
                    : `<b>${rawAtend}</b>`
                }</td>
                <td>${
                  isLockedFromStep3
                    ? `<input class="mini-in in-obs readonly" type="text" value="${escHtml(obs)}" disabled readonly tabindex="-1" placeholder="-" style="max-width:200px; background:#f1f5f9; color:#475569; cursor:not-allowed;">`
                    : escHtml(obs || '-')
                }</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      ${puedeSurtir ? `
        <div id="sol_surtir_alert" class="surtir-alert hidden" role="alert"></div>
        <div style="margin-top:14px; padding:12px 14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between;">
          ${stNorm === 'PENDIENTE' ? `
            <div style="font-size:13px; color:#334155;">
              <b>Paso 1 de 4 (PENDIENTE):</b> Revisa la orden solicitada y acéptala para pasarla a preparación y habilitar el ajuste de cantidades.
            </div>
            <button class="btn-primary" id="btn-sol-pasar-en-proceso" type="button" style="background:#1d4ed8; border-color:#1e40af;">
              👍 Aceptar Orden (Pasar a En Proceso)
            </button>
          ` : ''}
          ${stNorm === 'EN_PROCESO' ? `
            <div style="font-size:13px; color:#1e40af;">
              <b>Paso 2 de 4 (EN PROCESO):</b> Ajusta la <b>Cantidad Surtida</b> de cada artículo según el stock disponible (puedes poner 0 si no hay existencia). Aún no se descontará del inventario.
            </div>
            <button class="btn-primary" id="btn-sol-pasar-para-firmas" type="button" style="background:#7e22ce; border-color:#6b21a8;">
              ✍️ Pasar a Recaudar Firmas (Listo para Imprimir)
            </button>
          ` : ''}
          ${stNorm === 'PARA_FIRMAS' ? `
            <div style="font-size:13px; color:#6b21a8;">
              <b>🔒 Paso 3 de 4 (PARA FIRMAS):</b> Las cantidades surtidas y observaciones han quedado bloqueadas. Imprime el Vale PDF para recabar firmas físicas y, al entregar el material, márcala como Completada.
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
              <button class="btn-secondary" id="btn-sol-imprimir-vale-firmas" type="button" style="background:#f3e8ff; color:#6b21a8; border:1px solid #c084fc; font-weight:700;">
                🖨️ Imprimir Vale PDF (Con Firma del Solicitante)
              </button>
              <button class="btn-primary" id="btn-sol-marcar-completada" type="button" style="background:#15803d; border-color:#166534;">
                ✅ Marcar como Entregada / Completada
              </button>
            </div>
          ` : ''}
        </div>
      ` : (isClosed ? `
        <div style="margin-top:12px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
          <div class="muted" style="font-size:12.5px;">Orden en estado <b>${escHtml(CONSULTA_STATUS)}</b>: vista de solo lectura (cantidades solicitadas y surtidas).</div>
          ${canDownloadPdf && ['COMPLETADA', 'SURTIDA', 'SURTIDO', 'ENTREGADA', 'ENTREGADO', 'APROBADA'].includes(stNorm) ? `
            <button class="btn-secondary" id="btn-sol-imprimir-vale-firmas" type="button">
              🖨️ Imprimir Vale PDF (Con Firma del Solicitante)
            </button>
          ` : ''}
        </div>
      ` : '')}
    `;
  }

  // Muestra un mensaje en línea justo arriba del botón "Surtir" (además del toast flotante)
  function showSurtirAlert(msg, ok = false){
    const box = $('sol_surtir_alert');
    const msgBox = $('msg_surtir_consulta');
    if (msgBox) {
      msgBox.textContent = (!box && msg) ? msg : '';
      if (!box && msg) msgBox.className = `msg ${ok ? 'ok' : 'danger'}`;
    }
    if (!box) return;
    if (!msg) { box.textContent = ''; box.className = 'surtir-alert hidden'; return; }
    box.textContent = msg;
    box.className = `surtir-alert${ok ? ' ok' : ''}`;
    try { box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
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
              <span><b>${clave ? `${escHtml(clave)} - ` : ''}</b>${escHtml(desc)} &times; <b>${cant}</b> ${uni ? `(${escHtml(uni)})` : ''}</span>
              <button type="button" class="btn-del-preview-row" data-index="${idx}" style="color:var(--danger, #ef4444); background:transparent; border:none; cursor:pointer; font-weight:bold; font-size:16px; line-height:1;" title="Eliminar">&times;</button>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function setSolicitudesTab(tab) {
    // Limpiar mensajes de error previos al cambiar de pestaña
    if (typeof showSurtirAlert === 'function') showSurtirAlert('');
    if ($('sol_msg_detalle')) $('sol_msg_detalle').textContent = '';
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

    // Ocultar el menú de acciones en el listado; solo mostrar cuando se entra a un registro de orden
    const inConsulta = SOLICITUDES_TAB === 'consulta' && Boolean(DET_SOL_ID || LIST_SELECTED_ID);
    card.classList.toggle('hidden', !inConsulta);
    if (!inConsulta) return;

    const p = uiPerms();
    const isAuditorOnly = isAuditorUser();
    const rol = norm(CURRENT_USER?.rol || UI_PERMISOS?.rol || 'USUARIO');
    const isAdmin = !isAuditorOnly && Boolean(p.admin || rol === 'ADMIN');
    const isEncargado = !isAuditorOnly && Boolean(p.encargado || rol === 'ENCARGADO');
    const isCancelada = norm(status) === 'CANCELADA' || norm(status) === 'CANCELADO';

    const btnCancelar = $('btn-sol-cancelar');
    const btnEliminar = $('btn-sol-eliminar');
    const btnPdf = $('btn-sol-pdf');

    // el usuario "departamento" solo puede descargar los pdf que existen:
    // ocultar cancelar y eliminar para departamento y auditores
    if (btnCancelar) {
      const showCancel = !isAuditorOnly && (isAdmin || isEncargado);
      btnCancelar.classList.toggle('hidden', !showCancel);
      btnCancelar.disabled = !showCancel || isCancelada;
      btnCancelar.title = isAuditorOnly
        ? 'Modo auditoría: solo lectura'
        : (isCancelada ? 'La solicitud ya está cancelada' : (showCancel ? 'Cancelar esta solicitud' : 'Solo usuarios autorizados'));
    }

    if (btnEliminar) {
      // el administrador puede eliminarlas (auditores no pueden)
      const showEliminar = !isAuditorOnly && isAdmin;
      btnEliminar.classList.toggle('hidden', !showEliminar);
      btnEliminar.disabled = !showEliminar;
      btnEliminar.title = isAuditorOnly
        ? 'Modo auditoría: solo lectura'
        : (isAdmin ? 'Eliminar permanentemente esta solicitud' : 'Eliminar solo Admin');
    }

    if (btnPdf) {
      // v61: Bloquear y ocultar descarga de PDF de Solicitudes de Almacén para rol USUARIO; solo visible para Fiol/Encargado, Admin o Auditor (Jorge) y cuando ya está en PARA_FIRMAS / COMPLETADA
      const canDownloadPdf = Boolean(p.solicitudes?.puedeDescargarPdf || isAdmin || isEncargado || isAuditorOnly);
      const stNorm = norm(status);
      const pdfReadyState = ['PARA_FIRMAS', 'COMPLETADA', 'SURTIDA', 'SURTIDO', 'ENTREGADA', 'ENTREGADO', 'APROBADA'].includes(stNorm);
      const showPdfBtn = canDownloadPdf && pdfReadyState;
      btnPdf.classList.toggle('hidden', !showPdfBtn);
      btnPdf.style.display = showPdfBtn ? '' : 'none';
      btnPdf.disabled = !showPdfBtn;
      btnPdf.title = showPdfBtn
        ? 'Imprimir Vale PDF Oficial (Con Firma del Solicitante)'
        : 'El PDF se habilita para Almacén al pasar a Recaudar Firmas (PARA_FIRMAS)';
    }
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
    if (msg) msg.textContent = 'Consultando...';
    // Limpiar mensajes/errores de la orden anterior
    showSurtirAlert('');
    if ($('sol_msg_detalle')) $('sol_msg_detalle').textContent = '';
    if ($('sol_consulta_detalle')) $('sol_consulta_detalle').innerHTML = '<div class="muted">Cargando renglones...</div>';
    try{
      const resResumen = await apiJSON(`/api/solicitudes/${id}?_=${Date.now()}`, { cache: 'no-store' });
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

      // Stock en tiempo real: sin caché del navegador
      const resDetalle = await apiJSON(`/api/solicitudes/${id}/detalle?_=${Date.now()}`, { cache: 'no-store' });
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
      const totalAtendido = consultaRows.reduce((acc, r) => {
        const hasSurt = r.cantidad_surtida !== null && r.cantidad_surtida !== undefined && r.cantidad_surtida !== '';
        return acc + (hasSurt ? Number(r.cantidad_surtida) : (Number(r.atendida ?? r.ATENDIDA ?? 0) || 0));
      }, 0);

      const regionSol = safestr(d.region_solicitante) || 'La Paz';
      const nombreFirmante = safestr(d.nombre_solicitante_firma) || usuario;
      const tieneFirmaDig = Boolean(d.tiene_firma_digital || d.folio_firma_digital || d.firma_solicitante_data || d.firma_solicitante);
      const folioFirma = safestr(d.folio_firma_digital);
      const fechaFirmaFmt = d.fecha_firma_digital ? new Date(d.fecha_firma_digital).toLocaleString('es-MX') : fmtDate(d.fecha_solicitud);

      const box = $('sol_resumen');
      if (box){
        box.innerHTML = `
          <div class="item"><div class="label">Folio</div><div class="value">#${escHtml(idSol)}${renderPruebaBadge(d.es_prueba)}</div></div>
          <div class="item"><div class="label">Fecha</div><div class="value">${escHtml(fechaFmt)}</div></div>
          <div class="item"><div class="label">Jefe / Enlace Solicitante</div><div class="value">${escHtml(nombreFirmante)}</div></div>
          <div class="item"><div class="label">Región / Oficina</div><div class="value"><b>${escHtml(regionSol)}</b> — ${escHtml(oficialia)}</div></div>
          <div class="item"><div class="label">Tipo</div><div class="value">${escHtml(tipo)}</div></div>
          <div class="item"><div class="label">Estatus</div><div class="value">${getSolicitudStatusBadgeHtml(status)}</div></div>
          <div class="item span-2"><div class="label">Firma Digital Solicitante</div><div class="value">${
            tieneFirmaDig
              ? `<span class="badge-firma-digital">✓ Firmado Digitalmente por Solicitante</span> <span class="muted" style="font-size:12px; margin-left:6px;">(${escHtml(fechaFirmaFmt)}${folioFirma ? ` · Sello: <b>${escHtml(folioFirma)}</b>` : ''})</span>`
              : `<span class="muted">Sin firma digital registrada</span>`
          }</div></div>
          <div class="item span-2"><div class="label">Resumen</div><div class="value">${escHtml(productoLinea)} (${consultaRows.length} renglones)</div></div>
          <div class="item"><div class="label">Cantidad solicitada</div><div class="value">${totalQty}</div></div>
          <div class="item"><div class="label">Cantidad surtida</div><div class="value">${totalAtendido}</div></div>
          <div class="item span-2"><div class="label">Observaciones</div><div class="value">${escHtml(observ)}</div></div>
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
    const ofiVal = (uidIn && uidIn.value) ? Number(uidIn.value) : (SOL_DRAFT?.id_oficialia || CURRENT_USER?.id_oficialia);
    if (!ofiVal){
      toast('Área solicitante requerida');
      return;
    }

    const tipo = $('tipo_solicitud')?.value || SOL_DRAFT?.tipo_solicitud || 'CONSUMIBLES';
    const obs  = $('obs_sol')?.value?.trim() || SOL_DRAFT?.observaciones || null;
    const regEl = $('sol_region') || $('sol_region_solicitante');
    const regionSol = safestr(regEl?.value) || SOL_DRAFT?.region_solicitante || 'La Paz';
    const esForaneo = isCurrentUserRegionalForaneo();
    const nombreFirma = safestr($('sol_nombre_firma')?.value) || SOL_DRAFT?.nombre_solicitante_firma || getLoggedUserFullName() || null;

    let firmaData = null;
    if (SOL_SIG_PAD && SOL_SIG_PAD.hasSignature()) {
      firmaData = SOL_SIG_PAD.getDataUrl();
    } else if (SOL_DRAFT?.firma_solicitante_data || SOL_DRAFT?.firma_solicitante) {
      firmaData = SOL_DRAFT.firma_solicitante_data || SOL_DRAFT.firma_solicitante;
    }

    if (!nombreFirma) {
      toast('Ingresa el nombre completo de quien solicita y firma en el Paso 1', false);
      setSolicitudTab('crear');
      $('sol_nombre_firma')?.focus();
      return;
    }
    if (esForaneo && !firmaData) {
      alert('La firma digital del solicitante es obligatoria para las regiones foráneas (Los Cabos, Mulegé o Comondú). Por favor firma antes de guardar la solicitud.');
      toast('✍️ La firma digital del solicitante es obligatoria antes de guardar la solicitud.', false);
      setSolicitudTab('crear');
      return;
    }

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
          usuario_id: CURRENT_USER?.id || null,
          id_oficialia: ofiVal,
          tipo_solicitud: tipo,
          observaciones: obs,
          region_solicitante: regionSol,
          nombre_solicitante_firma: nombreFirma,
          firma_solicitante: firmaData,
          firma_solicitante_data: firmaData,
          items: itemsPayload
        })
      });

      if (!res?.ok || !res?.solicitud_id) {
        throw new Error(res?.error || 'No se pudo crear la solicitud');
      }

      CAPTURA_DIRTY = false;
      const msgExito = '✅ Orden creada con éxito. El encargado de almacén la revisará para su surtido.';
      toast(msgExito, true);
      alert(msgExito);

      // v61: Limpiar formulario, carrito y pad de firma, y redirigir a la vista principal sin abrir/descargar PDF
      resetSolicitudFlow({ stayInCaptura: false });
      showView('panel_general');
    } catch (e) {
      if (msg) msg.textContent = e.message || 'Error al guardar solicitud';
      if (!handleAuthError(e)) toast(e.message || 'Error al guardar solicitud', false);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function collectConsultaItemsPayload(containerId = 'sol_consulta_detalle') {
    const tbody = $(containerId)?.querySelector('tbody');
    if (!tbody) return { payload: [], validationError: null };
    const payload = [];
    let validationError = null;

    tbody.querySelectorAll('tr').forEach(tr => {
      if (validationError) return;
      const detId = tr.dataset.det;
      const clave = tr.dataset.clave || 'Producto';
      const nombre = tr.dataset.desc || clave;
      const cant = Number(tr.dataset.cant || 0);
      const stock = Number(tr.dataset.stock || 0);
      const inAtend = tr.querySelector('.in-atendida');
      const inObs = tr.querySelector('.in-obs');
      if (!inAtend) return;

      const valRaw = String(inAtend.value ?? '').trim();
      if (valRaw === '' || isNaN(Number(valRaw))) {
        validationError = `Debes ingresar una cantidad válida a surtir para ${nombre} (usa 0 si no se surtirá).`;
        return;
      }
      const atendida = Number(valRaw);
      if (!Number.isInteger(atendida) || atendida < 0) {
        validationError = `La cantidad a surtir debe ser un número entero mayor o igual a 0 para ${nombre}.`;
        return;
      }
      if (atendida > cant) {
        validationError = `La cantidad a surtir (${atendida}) no puede superar la cantidad solicitada (${cant}) para ${nombre}.`;
        return;
      }
      if (atendida > 0 && atendida > stock) {
        if (stock <= 0) {
          validationError = `No hay existencia en inventario para ${nombre} (Existencia actual: 0). Agrega stock en Almacén primero o coloca 0 en cantidad surtida.`;
        } else {
          validationError = `Stock insuficiente para ${nombre}. Solicitado a surtir: ${atendida}, Existencia disponible: ${stock}.`;
        }
        return;
      }
      payload.push({
        detalle_id: detId,
        cantidad_surtida: atendida,
        atendida,
        observaciones: inObs?.value || null
      });
    });

    return { payload, validationError };
  }

  async function cambiarEstadoSolicitudConsulta(nuevoEstado) {
    if (isAuditorUser() || !uiPerms().solicitudes?.puedeSurtir) {
      toast('No tienes permisos para cambiar el estado de la solicitud.', false);
      return false;
    }
    const targetSolId = DET_SOL_ID || LIST_SELECTED_ID || SOL_ID;
    if (!targetSolId) {
      toast('Sin solicitud seleccionada', false);
      return false;
    }
    showSurtirAlert('');

    const estUpper = String(nuevoEstado || '').trim().toUpperCase();
    let itemsPayload = [];

    // Las cantidades surtidas y observaciones solo se capturan y congelan al pasar del Paso 2 al Paso 3 (PARA_FIRMAS).
    // Al pasar del Paso 3 al Paso 4 (COMPLETADA), el backend descuenta estrictamente lo congelado en BD.
    if (estUpper === 'PARA_FIRMAS') {
      const { payload, validationError } = collectConsultaItemsPayload('sol_consulta_detalle');
      if (validationError) {
        showSurtirAlert(validationError);
        toast(validationError, false);
        return false;
      }
      itemsPayload = payload;
    }

    try {
      const res = await apiJSON(`/api/solicitudes/${encodeURIComponent(targetSolId)}/estado`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: estUpper,
          items: itemsPayload
        })
      });

      showSurtirAlert('');
      if (estUpper === 'EN_PROCESO') {
        toast('👍 Orden aceptada y pasada a EN PROCESO. Ahora puedes ajustar las cantidades a surtir.', true);
      } else if (estUpper === 'PARA_FIRMAS') {
        toast('✍️ Cantidades guardadas. Orden lista en PARA FIRMAS para imprimir el Vale PDF.', true);
      } else if (estUpper === 'COMPLETADA') {
        const msgComp = res?.inventario_descontado
          ? '✅ Orden completada y existencias descontadas del almacén con éxito.'
          : '✅ Orden completada exitosamente.';
        toast(msgComp, true);
      } else {
        toast(`Estado actualizado a ${estUpper}`, true);
      }

      await consultarSolicitudById(targetSolId);
      await listarSolicitudes();
      if (typeof loadAlmacen === 'function') Promise.resolve(loadAlmacen()).catch(() => {});
      if (typeof loadPanelGeneral === 'function') Promise.resolve(loadPanelGeneral()).catch(() => {});
      return true;
    } catch (e) {
      const detail = e?.message || 'Error al actualizar el estado de la solicitud';
      showSurtirAlert(detail);
      if (!handleAuthError(e)) toast(detail, false);
      return false;
    }
  }

  async function guardarTodoDetalle(containerId='sol_consulta_detalle', { goToPdf = false } = {}){
    return cambiarEstadoSolicitudConsulta('PARA_FIRMAS');
  }

  function renderSolicitudesListado(rows){
    if (!rows?.length) return '<div class="muted">Sin resultados.</div>';
    const head = `
      <thead><tr>
        <th>Folio</th><th>Fecha</th><th>Jefe / Solicitante</th><th>Región / Oficina</th><th>Tipo</th><th>Departamento</th><th>Estatus y Firma</th>
      </tr></thead>`;
    const body = rows.map(r=>{
      const id   = r.id ?? r.ID ?? r.solicitud_id ?? r.SOLICITUD_ID ?? '-';
      const fraw = r.fecha_solicitud ?? r.FECHA ?? r.fecha;
      const fec  = fmtDate(fraw);
      const usr  = safestr(r.nombre_solicitante_firma) || pickUsuario(r);
      const reg  = safestr(r.region_solicitante) || 'La Paz';
      const tipo = r.tipo_solicitud ?? r.TIPO ?? '-';
      const ofi  = r.oficialia_nombre ?? r.OFICIALIA_NOMBRE ?? r.id_oficialia ?? r.ID_OFICIALIA ?? '-';
      const status = String(r.status ?? r.STATUS ?? '-').toUpperCase();
      const tieneFirma = Boolean(r.tiene_firma_digital || r.folio_firma_digital || r.firma_solicitante_data || r.firma_solicitante);
      const firmaBadge = tieneFirma
        ? `<div style="margin-top:4px;"><span class="badge-firma-digital" title="Sello: ${escHtml(safestr(r.folio_firma_digital || ''))}">✓ Firmado Digitalmente por Solicitante</span></div>`
        : '';

      return `<tr data-sol-id="${escHtml(id)}">
        <td><b>#${escHtml(id)}</b>${renderPruebaBadge(r.es_prueba)}</td><td>${escHtml(fec)}</td><td>${escHtml(usr)}</td><td><b>${escHtml(reg)}</b></td><td>${escHtml(tipo)}</td><td>${escHtml(ofi)}</td>
        <td>${getSolicitudStatusBadgeHtml(status)}${firmaBadge}</td>
      </tr>`;
    }).join('');
    return `<div class="table-scroll"><table>${head}<tbody>${body}</tbody></table></div>`;
  }

  async function listarSolicitudes({ isAutoRefresh = false } = {}){
    const q = $('list_q')?.value?.trim() || '';
    let oficialia_id = $('list_oficialia')?.value?.trim() || '';
    if (!canUserSeeAllSolicitudes()) {
      const userDepto = getUserAssignedDepartment();
      oficialia_id = String(userDepto.id || oficialia_id || '');
    }
    const msg = $('msg_list');
    const box = $('listado_box');
    if (!box) return;

    // Preservar scroll y selección previa para evitar saltos
    const prevScrollY = window.scrollY || document.documentElement.scrollTop;
    const prevTableScroll = box.querySelector('.table-scroll');
    const prevTableTop = prevTableScroll ? prevTableScroll.scrollTop : 0;
    const prevTableLeft = prevTableScroll ? prevTableScroll.scrollLeft : 0;
    const prevSelectedId = LIST_SELECTED_ID;

    if (!isAutoRefresh) {
      if (msg) msg.textContent = 'Listando...';
      setListadoSelectedId(null);
    }

    try{
      const params = new URLSearchParams({ q, page: 1, limit: 200 });
      if (oficialia_id) params.set('oficialia_id', oficialia_id);
      if (SOL_LIST_MODE === 'canceladas') params.set('status', 'CANCELADA');
      const url = `/api/solicitudes?${params}`;
      const j = await apiJSON(url);
      if (!Array.isArray(j?.data)) throw new Error('Respuesta inesperada');

      const rows = SOL_LIST_MODE === 'canceladas'
        ? j.data.filter(r => ['CANCELADA','CANCELADO'].includes(norm(r.status ?? r.STATUS ?? '')))
        : j.data.filter(r => !['CANCELADA','CANCELADO'].includes(norm(r.status ?? r.STATUS ?? '')));

      // Comprobar si hay nuevas solicitudes para avisar discretamente
      const currentIds = rows.map(r => Number(r.id ?? r.ID ?? r.solicitud_id ?? r.SOLICITUD_ID)).filter(id => Number.isFinite(id) && id > 0);
      if (!HAS_SEEN_INITIAL_SOL) {
        currentIds.forEach(id => KNOWN_SOL_IDS.add(id));
        HAS_SEEN_INITIAL_SOL = true;
      } else if (isAutoRefresh) {
        let newCount = 0;
        for (const id of currentIds) {
          if (!KNOWN_SOL_IDS.has(id)) {
            newCount++;
            KNOWN_SOL_IDS.add(id);
          }
        }
        if (newCount > 0) {
          const toastMsg = newCount === 1 ? '📥 Nueva solicitud recibida' : `📥 ${newCount} nuevas solicitudes recibidas`;
          toast(toastMsg, true);
        }
      } else {
        currentIds.forEach(id => KNOWN_SOL_IDS.add(id));
      }

      // Actualizar contador badge de pendientes en el menú lateral
      if (SOL_LIST_MODE !== 'canceladas') {
        const pendingCount = rows.filter(r => {
          const st = String(r.status ?? r.STATUS ?? 'PENDIENTE').trim().toUpperCase();
          return ['PENDIENTE', 'NUEVA', 'EN_REVISION', 'EN_PROCESO', 'PARA_FIRMAS'].includes(st);
        }).length;
        updateNavSolicitudesBadge(pendingCount);
      }

      if (!rows.length) {
        box.innerHTML = `<div class="muted">Sin ${SOL_LIST_MODE === 'canceladas' ? 'cancelados' : 'resultados'}.</div>`;
        if (msg) msg.textContent = 'Listo';
        return;
      }

      box.innerHTML = renderSolicitudesListado(rows);

      // Restaurar scroll de pantalla y scroll interno de la tabla sin saltos
      if (isAutoRefresh) {
        if (prevScrollY !== undefined) {
          window.scrollTo({ top: prevScrollY, behavior: 'instant' });
        }
        const newTableScroll = box.querySelector('.table-scroll');
        if (newTableScroll) {
          newTableScroll.scrollTop = prevTableTop;
          newTableScroll.scrollLeft = prevTableLeft;
        }
        if (prevSelectedId && rows.some(r => String(r.id ?? r.ID ?? r.solicitud_id ?? r.SOLICITUD_ID) === String(prevSelectedId))) {
          setListadoSelectedId(prevSelectedId);
        }
      }

      const filterText = SOL_LIST_MODE === 'canceladas' ? 'cancelada(s)' : 'solicitud(es) activa(s)';
      if (msg) msg.textContent = `Mostrando ${rows.length} ${filterText}.`;

      if (!isAutoRefresh) {
        toast('Listado cargado', true);
      }
    }catch(e){
      if (!isAutoRefresh) {
        box.innerHTML = '<div class="muted">Error al cargar.</div>';
        if (msg) msg.textContent = e.message || 'Error';
        if (!handleAuthError(e)) toast(e.message || 'Error');
      } else {
        // En auto-refresh silencioso, no generar errores visuales ni romper la vista
        if (handleAuthError(e)) {
          stopSolicitudesPolling();
          return;
        }
        console.debug('[AutoRefresh] Fallo temporal al consultar solicitudes:', e?.message || e);
      }
    }
  }

  async function cancelarSolicitud(){
    if (isAuditorUser()) {
      toast('Modo auditoría. No tienes permisos para cancelar solicitudes.', false);
      return;
    }
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
    if (isAuditorUser()) {
      toast('Modo auditoría. No tienes permisos para eliminar solicitudes.', false);
      return;
    }
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
    sel.innerHTML = `<option value="">- seleccionar -</option>` + ALM_UNI_OPTIONS.map(u => `<option value="${escHtml(u)}">${escHtml(u)}</option>`).join('');
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
    sel.innerHTML = `<option value="">- seleccionar -</option>` + list.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
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
      selNow.innerHTML = `<option value="">- seleccionar -</option>` + ALM_CATS.map(c => `<option value="${escHtml(c.id)}">${escHtml(c.nombre)}</option>`).join('');
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
      const m = c.match(/^MAT-(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxNum) maxNum = n;
      }
    });
    return `MAT-${String(maxNum + 1).padStart(3, '0')}`;
  }
  function formatOrigenLabel(origen) {
    const o = String(origen || '').trim().toUpperCase();
    if (o === 'POR_CONTRATO') return 'Por Contrato';
    if (o === 'OTRO') return 'Otro';
    return 'Compra Delegación';
  }
  function almFormToBody(){
    const CLAVE = ($('alm_clave').value||'').trim();
    const DESCRIPCION = ($('alm_desc').value||'').trim();
    const STOCK = Number($('alm_stock').value||'0');
    const stock_minimo = Math.max(0, Number($('alm_stock_minimo')?.value || '0') || 0);
    const origen_adquisicion = ($('alm_origen_adquisicion')?.value || 'COMPRA_DELEGACION').trim().toUpperCase();
    const observaciones_control = ($('alm_observaciones_control')?.value || '').trim() || null;
    const ESTADO = ($('alm_estado').value||'ACTIVO').toUpperCase();
    let CATEGORIA = null;
    if (ALM_CAT_IS_SELECT){ CATEGORIA = $('alm_cat').value || null; } else { const txt = ($('alm_cat').value||'').trim(); CATEGORIA = txt || null; }
    const UNIDAD = ($('alm_unidad')?.value||'').trim() || null;
    return { CLAVE, DESCRIPCION, STOCK, stock_minimo, origen_adquisicion, observaciones_control, ESTADO, CATEGORIA, UNIDAD };
  }
  function onlyQtyEnabled(){
    ['alm_clave','alm_desc','alm_estado','alm_cat','alm_unidad'].forEach(id=>{
      const el = $(id); if (el) { el.readOnly = true; el.disabled = true; el.classList.add('readonly'); }
    });
    ['alm_stock','alm_stock_minimo','alm_origen_adquisicion','alm_observaciones_control'].forEach(id=>{
      const el = $(id); if (el) { el.readOnly = false; el.disabled = false; el.classList.remove('readonly'); }
    });
    const st = $('alm_stock'); if (st){ st.focus(); }
  }
  function allEnabled(){
    ['alm_clave','alm_desc','alm_estado','alm_cat','alm_unidad','alm_stock','alm_stock_minimo','alm_origen_adquisicion','alm_observaciones_control'].forEach(id=>{
      const el = $(id); if (el) { el.readOnly = false; el.disabled = false; el.classList.remove('readonly'); }
    });
  }
  function updateAlmSelectionUI() {
    const cnt = selectedMaterialIds.size;
    const badge = $('alm_sel_counter');
    if (badge) badge.textContent = `${cnt} seleccionado${cnt === 1 ? '' : 's'}`;
    const toggleBtn = $('btn-alm-toggle-sel');
    if (toggleBtn) {
      if (filterOnlySelected) {
        toggleBtn.textContent = `👁️ Ver todos (${ALM_LAST_ROWS.length})`;
        toggleBtn.classList.remove('btn-secondary');
        toggleBtn.classList.add('btn-primary');
      } else {
        toggleBtn.textContent = `🔍 Ver solo seleccionados (${cnt})`;
        toggleBtn.classList.remove('btn-primary');
        toggleBtn.classList.add('btn-secondary');
      }
    }
    const chkAll = $('alm_check_all');
    if (chkAll) {
      const rowChecks = document.querySelectorAll('.alm-row-check');
      if (rowChecks.length > 0 && Array.from(rowChecks).every(c => c.checked)) {
        chkAll.checked = true;
        chkAll.indeterminate = false;
      } else if (Array.from(rowChecks).some(c => c.checked)) {
        chkAll.checked = false;
        chkAll.indeterminate = true;
      } else {
        chkAll.checked = false;
        chkAll.indeterminate = false;
      }
    }
  }

  function almResetForm(){
    ALM_EDIT_ID = null;
    const claveEl = $('alm_clave');
    if (claveEl) {
      const nextKey = ALM_NEXT_CLAVE || computeNextClave(ALM_LAST_ROWS);
      claveEl.value = nextKey;
      claveEl.placeholder = 'Auto: ' + (nextKey || 'MAT-001');
      claveEl.readOnly = false;
      claveEl.disabled = false;
      claveEl.classList.remove('readonly');
      claveEl.style.backgroundColor = '';
      claveEl.style.cursor = '';
    }
    const descEl = $('alm_desc');
    if (descEl) {
      descEl.value = '';
      descEl.readOnly = false;
      descEl.disabled = false;
      descEl.classList.remove('readonly');
      descEl.style.backgroundColor = '';
      descEl.style.cursor = '';
    }
    $('alm_stock').value = '';
    if ($('alm_stock_minimo')) $('alm_stock_minimo').value = '0';
    if ($('alm_origen_adquisicion')) $('alm_origen_adquisicion').value = 'COMPRA_DELEGACION';
    if ($('alm_observaciones_control')) $('alm_observaciones_control').value = '';
    $('alm_estado').value = 'ACTIVO';
    if ($('alm_unidad')) $('alm_unidad').value = '';
    if ($('alm_cat')) $('alm_cat').value = '';
    $('btn-alm-crear').textContent = 'Guardar';
    show('btn-alm-crear'); show('alm_msg'); hide('btn-alm-cancel'); allEnabled(); applyPermassions();
  }
  function renderStockBajo(rows){
    const box = $('alm_stock_bajo');
    const banner = $('alm_alerta_banner');
    const bajos = (rows || [])
      .map(r => {
        const stock = Number(r.STOCK ?? r.stock ?? 0);
        const minimo = Number(r.stock_minimo ?? r.minimo ?? r.MINIMO ?? r.min_stock ?? 0);
        return { ...r, stock, minimo };
      })
      .filter(r => (Number.isFinite(r.minimo) && r.minimo > 0 && r.stock <= r.minimo) || r.stock <= 0)
      .sort((a, b) => a.stock - b.stock || String(a.CLAVE || '').localeCompare(String(b.CLAVE || '')));

    if (banner) {
      if (bajos.length > 0) {
        banner.classList.remove('hidden');
        const itemsTxt = bajos.slice(0, 6).map(r => `<b>${escHtml(safestr(r.CLAVE))}</b> (${escHtml(safestr(r.DESCRIPCION))}: <b>${r.stock}</b> / mín. ${r.minimo})`).join(', ');
        banner.innerHTML = `⚠️ <b>Alerta de Stock Mínimo (${bajos.length} producto${bajos.length === 1 ? '' : 's'}):</b> Se requiere reabastecer: ${itemsTxt}${bajos.length > 6 ? ` y ${bajos.length - 6} más...` : ''}`;
      } else {
        banner.classList.add('hidden');
        banner.innerHTML = '';
      }
    }

    if (!box) return;
    if (!bajos.length){ box.innerHTML = '<div class="muted">Sin alertas de stock bajo.</div>'; return; }
    box.innerHTML = `
      <div class="table-scroll">
        <table>
          <thead><tr><th>CLAVE</th><th>Producto</th><th>Stock</th><th>Mínimo</th></tr></thead>
          <tbody>
            ${bajos.slice(0, 25).map(r => `<tr><td>${escHtml(safestr(r.CLAVE))}</td><td>${escHtml(safestr(r.DESCRIPCION))}</td><td class="danger" style="color:var(--danger);font-weight:bold;">${Number(r.stock || 0)}</td><td>${Number(r.minimo || 0)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }
  function renderAlmacen(rows){
    const tb = $('alm_tbody'); if (!tb) return;
    tb.innerHTML = '';
    const p = uiPerms();
    const puedeEliminarAlmacen = p.puedeEliminarAlmacen;

    let displayRows = rows || [];
    if (filterOnlySelected) {
      displayRows = displayRows.filter(r => selectedMaterialIds.has(String(r.ID ?? r.id)));
    }

    if (!displayRows.length) {
      tb.innerHTML = `<tr><td colspan="10" class="muted" style="text-align:center; padding:18px;">${filterOnlySelected ? 'No hay materiales seleccionados actualmente.' : 'No se encontraron materiales.'}</td></tr>`;
      updateAlmSelectionUI();
      return;
    }

    displayRows.forEach(r=>{
      const id = r.ID ?? r.id;
      const categoriaNom = nombreCategoriaFromRow(r) || '';
      const stock = Number(r.STOCK ?? 0);
      const stockMin = Number(r.stock_minimo ?? r.minimo ?? r.MINIMO ?? 0);
      const origen = safestr(r.origen_adquisicion || 'COMPRA_DELEGACION').toUpperCase();
      const obsControl = safestr(r.observaciones_control || '');
      const estado = r.status ?? r.STATUS ?? r.ESTADO ?? '-';
      const isChecked = selectedMaterialIds.has(String(id));

      // v55: Semáforo de Stock: Rojo para stock 0 (sin badge de texto) y Amarillo para stock bajo
      const isSinProducto = stock <= 0;
      const isBajoStock = stockMin > 0 && stock > 0 && stock <= stockMin;

      const tr = document.createElement('tr');
      tr.dataset.id = id; tr.dataset.clave = r.CLAVE ?? ''; tr.dataset.desc = r.DESCRIPCION ?? '';
      tr.dataset.categoria = r.CATEGORIA; tr.dataset.categoriaNombre = categoriaNom;
      tr.dataset.unidad = r.UNIDAD ?? r.unidad ?? ''; tr.dataset.stock = stock; tr.dataset.estado = estado;
      tr.dataset.stockMinimo = stockMin; tr.dataset.origen = origen; tr.dataset.obsControl = obsControl;

      let stockBadge = `<b>${stock}</b>`;
      if (isSinProducto) {
        tr.style.backgroundColor = '#fee2e2';
        tr.style.color = '#991b1b';
        stockBadge = `<span style="font-weight:700;">0</span>`;
      } else if (isBajoStock) {
        tr.style.backgroundColor = '#fef3c7';
        tr.style.color = '#92400e';
        stockBadge = `<span style="font-weight:700;">${stock}</span>`;
      }
      const origenHtml = `<div style="font-size:11.5px;"><b>${escHtml(formatOrigenLabel(origen))}</b>${obsControl ? `<br><span class="muted">${escHtml(obsControl)}</span>` : ''}</div>`;

      tr.innerHTML = `
        <td style="text-align:center;"><input type="checkbox" class="alm-row-check" data-id="${escHtml(id)}" ${isChecked ? 'checked' : ''}></td>
        <td><b>${escHtml(r.CLAVE ?? '')}</b></td>
        <td>${escHtml(r.DESCRIPCION ?? '')}</td>
        <td>${escHtml(categoriaNom)}</td>
        <td>${escHtml(tr.dataset.unidad||'')}</td>
        <td>${stockBadge}</td>
        <td>${stockMin}</td>
        <td>${origenHtml}</td>
        <td>${escHtml(estado)}</td>
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

    updateAlmSelectionUI();
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
      if (!q && selectedMaterialIds.size > 0) {
        const existingIdSet = new Set(rows.map(r => String(r.ID ?? r.id)));
        for (const selId of Array.from(selectedMaterialIds)) {
          if (!existingIdSet.has(selId)) {
            selectedMaterialIds.delete(selId);
          }
        }
      }
      await ensureCategoriaNames(rows);
      ALM_LAST_ROWS = rows;
      ALM_NEXT_CLAVE = safestr(j.next_clave) || computeNextClave(rows);
      if (!ALM_EDIT_ID && $('alm_clave')) {
        $('alm_clave').value = ALM_NEXT_CLAVE;
        $('alm_clave').placeholder = 'Auto: ' + (ALM_NEXT_CLAVE || 'MAT-001');
        $('alm_clave').readOnly = false;
        $('alm_clave').disabled = false;
        $('alm_clave').classList.remove('readonly');
      }
      if (!ALM_CATS.length) await updateCategoriaFallbackOptions(rows);
      updateUnidadOptions(rows);
      renderAlmacen(rows);
      renderStockBajo(rows);
      $('alm_meta').textContent = `${rows.length} filas`;
      applyPermassions();
    }catch(e){
      $('alm_meta').textContent = '-';
      $('alm_tbody').innerHTML = `<tr><td colspan="7" class="muted">Error: ${escHtml(e.message || 'Error')}</td></tr>`;
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
              ${rows.map(r => `<tr><td>${escHtml(fmtDate(r.fecha || r.FECHA))}</td><td>${escHtml(safestr(r.tipo || r.TIPO || r.TIPO_MOVIMIENTO))}</td><td><b>${Number(r.cantidad ?? r.CANTIDAD ?? 0)}</b></td><td>${escHtml(safestr(r.responsable || r.RESPONSABLE))}</td><td>${escHtml(safestr(r.referencia || r.REFERENCIA))}</td><td>${escHtml(safestr(r.observaciones || r.OBSERVACIONES))}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }catch(e){
      box.innerHTML = `<div style="color:var(--danger)">${escHtml(e.message || 'Error')}</div>`;
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
      if (!rawDesc || !rawCat || !rawUni || rawStock === '' || !Number.isFinite(Number(rawStock)) || Number(rawStock) < 0 || !rawEst) {
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
        await apiJSON(`/api/almacen/${ALM_EDIT_ID}`, {
          method:'PUT',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            CLAVE: body.CLAVE,
            DESCRIPCION: body.DESCRIPCION,
            CATEGORIA: body.CATEGORIA,
            UNIDAD: body.UNIDAD,
            ESTADO: body.ESTADO,
            addStock: add,
            stock_minimo: body.stock_minimo,
            origen_adquisicion: body.origen_adquisicion,
            observaciones_control: body.observaciones_control
          })
        });
        toast(`Registro actualizado exitosamente`, true);
      } else {
        await apiJSON('/api/almacen', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        toast('Guardado', true);
      }
      msg.textContent = 'Listo';
      await loadAlmacen();
      almResetForm();
    }catch(e){
      msg.textContent = e.message || 'Error';
      if (e.status === 409 || (e.message && e.message.includes('ya existe'))) {
        alert(e.message || "⚠️ Error: La clave de producto ingresada ya existe. Por favor asigna una clave diferente.");
        $('alm_clave')?.focus();
      } else if (!handleAuthError(e)) {
        toast(e.message || 'Error', false);
      }
    }
  }
  function startEditFromRow(tr){
    const p = uiPerms();
    if (!p.puedeAccederAlmacen){ toast('Acceso restringido', false); return; }
    ALM_EDIT_ID = tr.dataset.id;
    $('alm_clave').value = tr.dataset.clave || '';
    $('alm_desc').value = tr.dataset.desc || '';
    $('alm_stock').value = '0';
    if ($('alm_stock_minimo')) $('alm_stock_minimo').value = tr.dataset.stockMinimo ?? '0';
    if ($('alm_origen_adquisicion')) $('alm_origen_adquisicion').value = tr.dataset.origen || 'COMPRA_DELEGACION';
    if ($('alm_observaciones_control')) $('alm_observaciones_control').value = tr.dataset.obsControl || '';
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

    // v44: Precarga exacta de categoría inyectando opción si falta
    const catVal = tr.dataset.categoria || '';
    const catNom = tr.dataset.categoriaNombre || catVal || '';
    const catEl = $('alm_cat');
    if (catEl) {
      if (ALM_CAT_IS_SELECT && catEl.tagName.toLowerCase() === 'select') {
        let optFound = Array.from(catEl.options).find(o => 
          o.value === catVal ||
          (catNom && o.textContent.trim().toUpperCase() === catNom.trim().toUpperCase()) ||
          (catVal && o.textContent.trim().toUpperCase() === catVal.trim().toUpperCase())
        );
        if (!optFound && (catNom || catVal)) {
          const opt = document.createElement('option');
          opt.value = catVal || catNom;
          opt.textContent = catNom || catVal;
          catEl.appendChild(opt);
          optFound = opt;
        }
        if (optFound) catEl.value = optFound.value;
        else catEl.value = catVal || '';
      } else {
        catEl.value = catNom || catVal || '';
      }
    }

    $('btn-alm-crear').textContent = 'Actualizar';
    show('btn-alm-cancel');
    toast('Editando registro');
    allEnabled();

    // v44: Restricción parcial de privilegios para Gabriel Fiol / no-admins:
    // No puede editar clave ni descripción de productos existentes
    const esAdmin = !!(p.esAdmin || p.esAdministrador || p.rol === 'ADMIN');
    if (!esAdmin) {
      const claveEl = $('alm_clave');
      const descEl = $('alm_desc');
      if (claveEl) {
        claveEl.readOnly = true;
        claveEl.disabled = true;
        claveEl.classList.add('readonly');
        claveEl.style.backgroundColor = '#f1f5f9';
        claveEl.style.cursor = 'not-allowed';
      }
      if (descEl) {
        descEl.readOnly = true;
        descEl.disabled = true;
        descEl.classList.add('readonly');
        descEl.style.backgroundColor = '#f1f5f9';
        descEl.style.cursor = 'not-allowed';
      }
    }
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
      selectedMaterialIds.delete(String(id));
      updateAlmSelectionUI();
      await loadAlmacen();
    }catch(e){
      msg.textContent = e.message || 'Error'; if (!handleAuthError(e)) toast(e.message || 'Error');
    }
  }

  // v44: Generador de Reporte PDF Institucional del Almacén General
  async function generarReporteAlmacenPdf(soloSeleccionados = false) {
    let ids = [];
    if (soloSeleccionados) {
      if (!selectedMaterialIds.size) {
        toast('Selecciona al menos un material con los checkboxes para generar este reporte', false);
        return;
      }
      ids = Array.from(selectedMaterialIds);
    }
    toast('Generando reporte PDF institucional...', true);
    try {
      const resp = await fetch('/api/almacen/reporte-pdf', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ids })
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || 'Error al generar reporte PDF');
      }
      const blob = await resp.blob();
      const url = window.URL.createObjectURL(blob);
      const filename = soloSeleccionados ? `reporte_materiales_${Date.now()}.pdf` : `inventario_general_almacen_${Date.now()}.pdf`;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => window.URL.revokeObjectURL(url), 2000);
      toast('Reporte PDF descargado exitosamente', true);
    } catch (e) {
      toast(e.message || 'Error al generar reporte PDF', false);
    }
  }

  function getSolicitudIdForPdf(){
    if (isCapturaViewActive()) {
      return String(SOL_ID || DET_SOL_ID || '').trim();
    }
    return String($('sol_edit_id')?.value || DET_SOL_ID || LIST_SELECTED_ID || SOL_ID || '').trim();
  }
  
  async function descargarPDF({ resetAfter = false } = {}) {
    const p = uiPerms();
    const canPdf = Boolean(p.solicitudes?.puedeDescargarPdf || p.admin || p.encargado || isAuditorUser());
    if (!canPdf) {
      toast('La descarga e impresión del Vale PDF está reservada exclusivamente para el Encargado de Almacén y Administración.', false);
      return;
    }
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
    const options = [`<option value="">${escHtml(allLabel)}</option>`].concat((rows || []).map(r => `<option value="${Number(r.oficialia_id || 0)}">${escHtml(formatReportOficialiaLabel(r))}</option>`));
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
          <tbody>${tableRows.map(r => `<tr><td><b>${escHtml(safestr(r.clave || r.CLAVE) || '-')}</b></td><td>${escHtml(safestr(r.descripcion || r.DESCRIPCION) || '-')}</td><td>${Number(r.solicitudes_count || 0)}</td><td>${Number(r.cantidad_solicitada || 0)}</td><td>${Number(r.cantidad_atendida || 0)}</td></tr>`).join('')}</tbody>
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
          <tbody>${rows.map(r => `<tr><td>${escHtml(formatReportOficialiaLabel(r))}</td><td>${Number(r.solicitudes_count || 0)}</td><td>${Number(r.cantidad_solicitada || 0)}</td><td>${Number(r.cantidad_atendida || 0)}</td><td><button class="mini btn-secondary" data-rep-open-oficialia="${Number(r.oficialia_id || 0)}">Ver reporte</button></td></tr>`).join('')}</tbody>
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
          <tbody>${rows.map(r => `<tr><td><b>${escHtml(safestr(r.nombre_usuario) || '-')}</b></td><td>${escHtml(safestr(r.oficialia_nombre) || '-')}</td><td>${Number(r.solicitudes_count || 0)}</td><td>${escHtml(fmtDate(r.ultima_fecha))}</td><td>${Number(r.cantidad_solicitada || 0)}</td><td>${Number(r.cantidad_atendida || 0)}</td></tr>`).join('')}</tbody>
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
          <tbody>${rows.map(r => `<tr><td>${escHtml(safestr(r.nombre_usuario) || '-')}</td><td>${escHtml(safestr(r.oficialia_solicitud_nombre) || '-')}</td><td>${escHtml(safestr(r.oficialia_usuario_nombre) || '-')}</td><td>${Number(r.solicitudes_count || 0)}</td><td>${escHtml(fmtDate(r.ultima_fecha))}</td><td>${Number(r.cantidad_solicitada || 0)}</td><td>${Number(r.cantidad_atendida || 0)}</td></tr>`).join('')}</tbody>
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
      return `<div class="rep-bar-row"><div class="rep-bar-label" title="${escHtml(label)}">${escHtml(label)}</div><div class="rep-bar-track"><div class="rep-bar-fill" style="width:${width}%"></div></div><div class="rep-bar-val">${val}</div></div>`;
    }).join('')}</div>`;
  }

  function reportHtmlTable(headers, rows){
    return `
      <table style="width:100%; border-collapse:collapse; margin-top:10px;">
        <thead><tr>${headers.map(h => `<th style="text-align:left; border:1px solid #4E0D28; padding:6px; background:#621132; color:#fff;">${escHtml(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((row, idx) => `<tr style="background:${idx % 2 === 1 ? '#F9F2F4' : '#fff'};">${row.map(cell => `<td style="border:1px solid #ccc; padding:6px;">${escHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
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
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escHtml(title)}</title>
    <style>body{font-family:Arial,sans-serif; color:#111; margin:24px;} h1,h2{margin:0 0 10px 0; color:#621132;} .meta{margin:12px 0 18px 0;} .kpis{display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin:14px 0 18px 0;} .kpi{border:1px solid #B38E5D; background:#F9F2F4; padding:10px;} .lab{font-size:12px; color:#555;} .val{font-size:18px; font-weight:700; margin-top:4px; color:#621132;} .chart{display:grid; gap:8px; margin:10px 0 18px 0;} .row{display:grid; grid-template-columns:220px 1fr 60px; gap:10px; align-items:center;} .label{font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;} .track{height:12px; border:1px solid #d6c5cb; border-radius:999px; overflow:hidden; background:#F9F2F4;} .fill{height:100%; background:#621132;} .num{font-size:12px; text-align:right;} </style></head>
    <body><h1>${escHtml(title)}</h1><div class="meta"><b>Delegación Baja California Sur</b> — Fecha: ${escHtml(new Date().toLocaleDateString('es-MX'))}</div>
    <div class="kpis"><div class="kpi"><div class="lab">Solicitudes</div><div class="val">${Number(summary.solicitudes_count || 0)}</div></div><div class="kpi"><div class="lab">Productos solicitados</div><div class="val">${Number(summary.cantidad_solicitada || 0)}</div></div><div class="kpi"><div class="lab">Productos entregados</div><div class="val">${Number(summary.cantidad_atendida || 0)}</div></div><div class="kpi"><div class="lab">Producto mas solicitado</div><div class="val" style="font-size:14px;">${escHtml(safestr(summary.top_producto_nombre || '-') || '-')}</div></div></div>
    <div class="meta"><b>Departamento que mas solicita:</b> ${escHtml(rankings.mas_pide ? formatReportOficialiaLabel(rankings.mas_pide) : '-')}</div>
    <h2>Grafica de productos</h2><div class="chart">${chartRows.map(r => { const val = Number(r.cantidad_solicitada || 0); const width = Math.max(4, Math.round((val / maxVal) * 100)); const label = [safestr(r.clave || r.CLAVE), safestr(r.descripcion || r.DESCRIPCION)].filter(Boolean).join(' - ') || '-'; return `<div class="row"><div class="label">${escHtml(label)}</div><div class="track"><div class="fill" style="width:${width}%"></div></div><div class="num">${val}</div></div>`; }).join('')}</div>
    <h2>Top 10 productos mas solicitados</h2>${topProductosTable}<h2>Todos los productos solicitados</h2>${productosTable}</body></html>`;
  }

  function buildExcelHtml(data){
    const summary = data?.summary || {};
    const productos = Array.isArray(data?.productos) ? data.productos : [];
    const solicitudes = Array.isArray(data?.solicitudes) ? data.solicitudes : [];
    return `<!doctype html><html><head><meta charset="utf-8"></head><body><table border="1">
      <tr><th colspan="2">Resumen</th></tr><tr><td>Departamento</td><td>${escHtml(safestr(summary.scope_label) || '-')}</td></tr><tr><td>Solicitudes</td><td>${Number(summary.solicitudes_count || 0)}</td></tr><tr><td>Productos solicitados</td><td>${Number(summary.cantidad_solicitada || 0)}</td></tr><tr><td>Productos entregados</td><td>${Number(summary.cantidad_atendida || 0)}</td></tr><tr><td>Producto mas solicitado</td><td>${escHtml(safestr(summary.top_producto_nombre) || '-')}</td></tr></table>
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
    const uname = String(CURRENT_USER?.username || UI_PERMISOS?.user || '').toLowerCase().trim();
    if (!p.reportes?.acceso || uname === 'gabrielfiol' || uname === 'fiol'){ toast('Acceso restringido', false); return; }
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
          <div class="pie-center"><div class="big">${total}</div><div class="small">${escHtml(totalLabel)}</div></div>
        </div>
        <div class="pie-legend">
          ${data.map(item => `<div class="pie-legend-item"><span class="pie-swatch" style="background:${item.color};"></span><span class="pie-label" title="${escHtml(item.label)}">${escHtml(item.label)}</span><span class="pie-val">${item.value} / ${item.percent}%</span></div>`).join('')}
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
      return `<div class="rep-bar-row"><div class="rep-bar-label" title="${escHtml(label)}">${escHtml(label)}</div><div class="rep-bar-track"><div class="rep-bar-fill" style="width:${width}%"></div></div><div class="rep-bar-val">${Number(r.ratio || 0)}%</div></div>`;
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
          <tbody>${decorated.map(r => `<tr><td><span class="pie-swatch" style="display:inline-block;background:${r.color};"></span></td><td><b>${escHtml(r.clave)}</b></td><td>${escHtml(r.descripcion)}</td><td>${r.cantidad_solicitada}</td><td>${r.percent}%</td></tr>`).join('')}</tbody>
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
    const uname = String(CURRENT_USER?.username || UI_PERMISOS?.user || '').toLowerCase().trim();
    if (!p.reportes?.acceso || uname === 'gabrielfiol' || uname === 'fiol'){ toast('Acceso restringido', false); return; }
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
  // FASE B: CONTROL DE INVENTARIO REGIONAL (Módulo Aislado + Parque Vehicular Híbrido)
  // =========================================================================
  let REGIONAL_CATALOGS = { regiones: [], oficinas: [], rubros: [] };
  let REGIONAL_FILTERS_LOADED = false;
  let REGIONAL_LAST_ROWS = [];

  const VEHICULO_ESTADO_KEYS = [
    'estado_mecanico', 'estado_electrico', 'estado_carroceria',
    'llanta_1', 'llanta_2', 'llanta_3', 'llanta_4', 'llanta_5'
  ];

  const VEHICULO_CHECKLIST_ITEMS = [
    { key: 'llaves_encendido', label: 'Llaves de encendido' },
    { key: 'llave_repuesto', label: 'Llave de repuesto' },
    { key: 'control_remoto_alarma', label: 'Control remoto alarma' },
    { key: 'radio', label: 'Radio' },
    { key: 'bocinas', label: 'Bocinas' },
    { key: 'espejo_retrovisor', label: 'Espejo retrovisor' },
    { key: 'espejo_lat_derecho', label: 'Espejo lat. derecho' },
    { key: 'espejo_lat_izquierdo', label: 'Espejo lat. izquierdo' },
    { key: 'encendedor', label: 'Encendedor' },
    { key: 'aire_acondicionado', label: 'Aire acondicionado' },
    { key: 'tarjeta_circulacion', label: 'Tarjeta de circulación' },
    { key: 'poliza_seguro', label: 'Póliza de seguro' },
    { key: 'manuales', label: 'Manuales' },
    { key: 'placa_delantera', label: 'Placa delantera' },
    { key: 'placa_trasera', label: 'Placa trasera' },
    { key: 'viseras', label: 'Viseras' },
    { key: 'claxon', label: 'Claxon' },
    { key: 'asientos', label: 'Asientos' },
    { key: 'manijas', label: 'Manijas' },
    { key: 'tapetes', label: 'Tapetes' },
    { key: 'llave_cruz', label: 'Llave de cruz' },
    { key: 'llave_l', label: 'Llave L' },
    { key: 'dado_seguridad', label: 'Dado de seguridad' },
    { key: 'reflejantes', label: 'Reflejantes' },
    { key: 'gato', label: 'Gato' },
    { key: 'extintor', label: 'Extintor' },
    { key: 'cables_pasa_corriente', label: 'Cables pasa corriente' },
    { key: 'herramienta', label: 'Herramienta' },
    { key: 'llanta_refaccion', label: 'Llanta de refacción' },
    { key: 'golpes', label: 'Golpes' },
    { key: 'rayones', label: 'Rayones' },
    { key: 'emblemas', label: 'Emblemas' },
    { key: 'faros', label: 'Faros' },
    { key: 'calaveras', label: 'Calaveras' },
    { key: 'tumba_burros', label: 'Tumba burros' },
    { key: 'tira_remolque', label: 'Tira remolque' },
    { key: 'biseles', label: 'Biseles' },
    { key: 'tapones_llantas', label: 'Tapones de llantas' },
    { key: 'tapon_gasolina', label: 'Tapón de gasolina' },
    { key: 'brazos_limpiadores', label: 'Brazos limpiadores' },
    { key: 'bayoneta_aceite', label: 'Bayoneta de aceite' },
    { key: 'bayoneta_transmision', label: 'Bayoneta de transmisión' }
  ];

  function isRubroParqueVehicular(rubroId){
    const rid = Number(rubroId || 0);
    if (!rid) return false;
    const rub = REGIONAL_CATALOGS.rubros.find(r => Number(r.id) === rid);
    if (!rub) return false;
    const code = safestr(rub.codigo).toUpperCase();
    const name = safestr(rub.nombre_rubro).toUpperCase();
    return code === 'PARQUE_VEHICULAR' || name.includes('VEHICULAR');
  }

  function renderVehiculoChecklistInputs(savedChecklist = {}){
    const box = $('veh_checklist_container');
    if (!box) return;
    const chk = savedChecklist && typeof savedChecklist === 'object' ? savedChecklist : {};
    box.innerHTML = VEHICULO_CHECKLIST_ITEMS.map(item => {
      const raw = safestr(chk[item.key] || 'Sí');
      const val = (raw === 'No' || raw.toUpperCase() === 'NO')
        ? 'No'
        : ((raw === 'N/A' || raw.toUpperCase() === 'N/A' || raw.toUpperCase() === 'NA') ? 'N/A' : 'Sí');
      return `
        <div class="veh-chk-item">
          <label for="veh_chk_${item.key}">${escHtml(item.label)}</label>
          <select id="veh_chk_${item.key}" data-veh-chk="${item.key}">
            <option value="Sí" ${val === 'Sí' ? 'selected' : ''}>Sí</option>
            <option value="No" ${val === 'No' ? 'selected' : ''}>No</option>
            <option value="N/A" ${val === 'N/A' ? 'selected' : ''}>N/A</option>
          </select>
        </div>
      `;
    }).join('');
  }

  function setAllVehiculoChecklist(value){
    const box = $('veh_checklist_container');
    if (!box) return;
    box.querySelectorAll('select[data-veh-chk]').forEach(sel => {
      sel.value = value;
    });
  }

  function toggleVehiculoSectionByRubro(){
    const rubId = $('reg_add_rubro')?.value;
    const vehSec = $('reg_vehiculo_section');
    if (!vehSec) return;
    const isVeh = isRubroParqueVehicular(rubId);
    vehSec.classList.toggle('hidden', !isVeh);
    const btnSavePdf = $('btn-reg-save-and-pdf');
    if (btnSavePdf) {
      const canPdf = uiPerms().puedeGenerarPdfRegional !== false;
      btnSavePdf.classList.toggle('hidden', !(isVeh && canPdf));
    }
  }

  function normalizeRegionalCargo(val){
    const s = safestr(val).trim();
    if (!s) return '';
    return s
      .replace(/Coordinadora?\s+Regionall?(\s+(de\s+)?(Muleg[eé]|Los\s+Cabos|Comond[uú](\s*\/\s*Loreto)?|La\s+Paz))?/gi, 'Director Regional')
      .replace(/Coordinadora?\s+Regionall?/gi, 'Director Regional');
  }

  function populateVehiculoFormFields(detalles = null, row = null){
    const det = detalles && typeof detalles === 'object' ? detalles : {};
    const u = det.unidad && typeof det.unidad === 'object' ? det.unidad : {};
    const eg = det.estado_general && typeof det.estado_general === 'object' ? det.estado_general : {};
    const chk = det.checklist && typeof det.checklist === 'object' ? det.checklist : {};
    const resg = det.resguardante && typeof det.resguardante === 'object' ? det.resguardante : {};

    if ($('veh_resg_preset')) $('veh_resg_preset').value = '';
    if ($('veh_resg_nombre')) $('veh_resg_nombre').value = safestr(row?.resguardante_nombre || resg.nombre_completo || '');
    if ($('veh_resg_rfc')) $('veh_resg_rfc').value = safestr(row?.resguardante_rfc || resg.rfc || '').toUpperCase();
    if ($('veh_resg_puesto')) $('veh_resg_puesto').value = normalizeRegionalCargo(row?.resguardante_puesto || resg.puesto || '');
    if ($('veh_resg_adscripcion')) $('veh_resg_adscripcion').value = safestr(row?.resguardante_adscripcion || resg.adscripcion || '');
    if ($('veh_resg_programa')) $('veh_resg_programa').value = safestr(row?.resguardante_programa || resg.programa || '');
    if ($('veh_resg_licencia')) $('veh_resg_licencia').value = safestr(row?.resguardante_licencia || resg.licencia_no || '').toUpperCase();
    if ($('veh_resg_vigencia')) $('veh_resg_vigencia').value = safestr(row?.resguardante_vigencia_licencia || resg.vigencia_licencia || '');

    if ($('veh_marca')) $('veh_marca').value = safestr(u.marca || row?.marca_modelo || '');
    if ($('veh_tipo')) $('veh_tipo').value = safestr(u.tipo || '');
    if ($('veh_modelo')) $('veh_modelo').value = safestr(u.modelo || '');
    if ($('veh_color')) $('veh_color').value = safestr(u.color || '');
    if ($('veh_placas')) $('veh_placas').value = safestr(u.placas || row?.numero_serie_placas || '');
    if ($('veh_serie_vin')) $('veh_serie_vin').value = safestr(u.serie_vin || '');
    if ($('veh_cilindros')) $('veh_cilindros').value = safestr(u.cilindros || '');
    if ($('veh_poliza_seguro')) $('veh_poliza_seguro').value = safestr(u.poliza_seguro || '');
    if ($('veh_odometro_km')) $('veh_odometro_km').value = safestr(u.odometro_km || '');
    if ($('veh_nivel_gasolina')) $('veh_nivel_gasolina').value = safestr(u.nivel_gasolina || '');

    VEHICULO_ESTADO_KEYS.forEach(k => {
      const el = $(`veh_est_${k}`);
      if (el) {
        const v = safestr(eg[k] || 'B').toUpperCase();
        el.value = ['B', 'R', 'M'].includes(v) ? v : 'B';
      }
    });

    renderVehiculoChecklistInputs(chk);
  }

  function collectVehiculoFormFields(){
    const resguardante = {
      nombre_completo: safestr($('veh_resg_nombre')?.value).trim(),
      rfc: safestr($('veh_resg_rfc')?.value).trim().toUpperCase(),
      puesto: normalizeRegionalCargo($('veh_resg_puesto')?.value),
      adscripcion: safestr($('veh_resg_adscripcion')?.value).trim(),
      programa: safestr($('veh_resg_programa')?.value).trim(),
      licencia_no: safestr($('veh_resg_licencia')?.value).trim().toUpperCase(),
      vigencia_licencia: safestr($('veh_resg_vigencia')?.value).trim()
    };
    const unidad = {
      marca: safestr($('veh_marca')?.value),
      tipo: safestr($('veh_tipo')?.value),
      modelo: safestr($('veh_modelo')?.value),
      color: safestr($('veh_color')?.value),
      placas: safestr($('veh_placas')?.value),
      serie_vin: safestr($('veh_serie_vin')?.value),
      cilindros: safestr($('veh_cilindros')?.value),
      poliza_seguro: safestr($('veh_poliza_seguro')?.value),
      odometro_km: safestr($('veh_odometro_km')?.value),
      nivel_gasolina: safestr($('veh_nivel_gasolina')?.value)
    };
    const estado_general = {};
    VEHICULO_ESTADO_KEYS.forEach(k => {
      estado_general[k] = safestr($(`veh_est_${k}`)?.value || 'B') || 'B';
    });
    const checklist = {};
    const box = $('veh_checklist_container');
    if (box) {
      box.querySelectorAll('select[data-veh-chk]').forEach(sel => {
        const key = sel.getAttribute('data-veh-chk');
        if (key) checklist[key] = sel.value || 'Sí';
      });
    }
    return { resguardante, unidad, estado_general, checklist };
  }

  function updateRegionalFirmasPreview(){
    const box = $('reg_firmas_preview');
    if (!box) return;
    const p = uiPerms();
    if (!p.puedeGenerarPdfRegional) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const regId = Number($('reg_filter_region')?.value || 0);
    const rubId = Number($('reg_filter_rubro')?.value || 0);

    const regObj = REGIONAL_CATALOGS.regiones.find(r => Number(r.id) === regId);
    const rubObj = REGIONAL_CATALOGS.rubros.find(r => Number(r.id) === rubId);

    const respRegionalNombre =
      getTitularRegionalFromText(regObj?.clave || regObj?.nombre || '') ||
      safestr(regObj?.responsable_regional || 'POR CONFIRMAR');

    const entregaTxt = rubObj
      ? `${safestr(rubObj.encargado_nombre)} (${safestr(rubObj.encargado_cargo)})`
      : 'Todos los rubros (selecciona un rubro para firma específica)';
    const validaTxt = 'Jorge Luis Patrón Murillo (Coordinador Operativo de Recursos Materiales)';
    const recibeTxt = regObj
      ? `${respRegionalNombre} (Director Regional — ${safestr(regObj.nombre)})`
      : 'POR CONFIRMAR (Director Regional)';
    const autorizaTxt = 'Diphna Yanssen Weichselbaum Calderón (Delegada de Programas para el Desarrollo en BCS)';

    box.innerHTML = `
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap:8px;">
        <div><b>1. Entrega / 2. Recibe Retorno:</b><br>${escHtml(entregaTxt)}</div>
        <div><b>2. Recibe / 1. Devuelve:</b><br>${escHtml(recibeTxt)}</div>
        <div><b>3. Valida (Entrega y Retorno):</b><br>${escHtml(validaTxt)}</div>
        <div><b>4. Autoriza (Entrega y Retorno):</b><br>${escHtml(autorizaTxt)}</div>
      </div>
    `;
  }

  function formatRegionalOficinaOptionLabel(o) {
    if (!o) return '';
    const nombreNorm = safestr(o.nombre)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const isSA = nombreNorm.includes('s/a') || nombreNorm.includes('sin asignar');
    if (isSA) {
      return o.municipio
        ? `S/A — Sin Asignar (Pendiente Regional) — ${safestr(o.municipio)}`
        : 'S/A — Sin Asignar (Pendiente Regional)';
    }
    return o.municipio
      ? `${safestr(o.nombre)} — ${safestr(o.municipio)}`
      : safestr(o.nombre);
  }

  function filterOficinasForRegionalSelector(oficinas, rubroIdOverride = null) {
    if (!Array.isArray(oficinas)) return [];
    const uname = safestr(CURRENT_USER?.username || UI_PERMISOS?.user).toLowerCase();
    const role = safestr(CURRENT_USER?.rol || CURRENT_USER?.role || UI_PERMISOS?.rol).toLowerCase();
    const assignedRubro = getAssignedRubroId();
    const filterRubroVal = Number(
      rubroIdOverride != null
        ? rubroIdOverride
        : ($('reg_filter_rubro')?.value || assignedRubro || 0)
    );
    const effectiveRubroId = filterRubroVal || Number(assignedRubro || 0);

    const isAdminUser = role === 'admin' || uname === 'admin' || Boolean(uiPerms().admin);
    const isAdminOrDirectivo =
      isAdminUser ||
      ['jorge', 'jorgepatron', 'rodrigo'].includes(uname);
    // RM (Recursos Materiales) se muestra cuando:
    // - rubro_id == 2 y el usuario es evelia o administrador/directivo, O
    // - rubro_id == 3 y el usuario es jesus o administrador/directivo
    const canShowRM =
      ((isAdminOrDirectivo || uname === 'evelia') && (!effectiveRubroId || effectiveRubroId === 2)) ||
      ((isAdminOrDirectivo || uname === 'jesus') && (!effectiveRubroId || effectiveRubroId === 3));
    const isMobiliario = effectiveRubroId === 3 || uname === 'jesus';
    const isVehicular = effectiveRubroId === 2 || uname === 'evelia';
    const canShowSA = isAdminUser || isAdminOrDirectivo || isMobiliario || uname === 'jesus';

    return oficinas.filter(o => {
      const nombreNorm = safestr(o.nombre)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
      const isRM =
        nombreNorm.includes('rm (recursos materiales)') ||
        nombreNorm.includes('la paz/rm') ||
        nombreNorm === 'rm';

      if (isRM && !canShowRM) return false;

      const isSA = nombreNorm.includes('s/a') || nombreNorm.includes('sin asignar');
      if (isSA) {
        // v55: Ni evelia ni el módulo de vehículos pueden ver o asignar a oficinas S/A
        if (isVehicular || uname === 'evelia') return false;
        return canShowSA;
      }

      // v55: Ni evelia ni el módulo de vehículos pueden ver o asignar a Coordinación Regional La Paz
      const isCoordRegionalLaPaz =
        nombreNorm.includes('coordinacion regional la paz') ||
        nombreNorm.includes('coordinacion regional') ||
        nombreNorm === 'coordinacion regional la paz';
      if (isCoordRegionalLaPaz && (isVehicular || uname === 'evelia')) {
        return false;
      }

      if (isMobiliario) {
        if (Number(o.id) === 1 || nombreNorm.includes('delegacion la paz')) return false;
      }
      return true;
    });
  }

  async function loadRegionalOficinas(regionId = ''){
    const ofiSel = $('reg_filter_oficina');
    if (!ofiSel) return;
    const prevVal = ofiSel.value || '';
    try {
      const rubVal = $('reg_filter_rubro')?.value || getAssignedRubroId() || '';
      const params = new URLSearchParams();
      if (regionId) params.set('region_id', regionId);
      if (rubVal) params.set('rubro_id', String(rubVal));
      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await apiJSON(`/api/oficinas${qs}`);
      const rawRows = Array.isArray(res?.data) ? res.data : [];
      const rows = filterOficinasForRegionalSelector(rawRows, rubVal ? Number(rubVal) : null);
      REGIONAL_CATALOGS.oficinas = rows;
      const opts = rows.map(o => {
        const label = formatRegionalOficinaOptionLabel(o);
        return `<option value="${Number(o.id)}">${escHtml(label)}</option>`;
      }).join('');
      ofiSel.innerHTML = `<option value="">Todas</option>${opts}`;
      if (prevVal && rows.some(o => String(o.id) === String(prevVal))) {
        ofiSel.value = prevVal;
      } else {
        ofiSel.value = '';
      }
    } catch (e) {
      ofiSel.innerHTML = '<option value="">Todas</option>';
    }
  }

  async function loadRegionalFilters(force = false){
    const regSel = $('reg_filter_region');
    const ofiSel = $('reg_filter_oficina');
    const rubSel = $('reg_filter_rubro');
    if (!regSel || !ofiSel || !rubSel) return;

    const p = uiPerms();
    if ($('btn-reg-add')) $('btn-reg-add').classList.toggle('hidden', !p.puedeEditarRegional);
    if ($('btn-reg-pdf')) $('btn-reg-pdf').classList.toggle('hidden', !p.puedeGenerarPdfRegional);

    if (REGIONAL_FILTERS_LOADED && !force) {
      updateRegionalFirmasPreview();
      return;
    }

    const curReg = regSel.value || '';
    const curRub = rubSel.value || '';

    try {
      const [regRes, rubRes] = await Promise.all([
        apiJSON('/api/regiones'),
        apiJSON('/api/rubros')
      ]);

      const regiones = Array.isArray(regRes?.data) ? regRes.data : [];
      // El Rubro 1 (Archivo y Materiales - Gabriel Fiol) queda estrictamente excluido de Inventario Regional
      const rubros = (Array.isArray(rubRes?.data) ? rubRes.data : []).filter(ru => Number(ru.id) !== 1);
      REGIONAL_CATALOGS.regiones = regiones;
      REGIONAL_CATALOGS.rubros = rubros;

      const userRegId = Number(p.region_id || UI_PERMISOS?.scope?.region_id || 0) || null;
      if (!p.puedeEditarRegional && userRegId) {
        regSel.innerHTML = regiones
          .filter(r => Number(r.id) === userRegId)
          .map(r => `<option value="${Number(r.id)}">${escHtml(safestr(r.nombre))}</option>`)
          .join('');
        regSel.value = String(userRegId);
        regSel.disabled = true;
        regSel.title = 'Modo consulta: filtrado automáticamente a tu región asignada';
      } else {
        regSel.innerHTML = '<option value="">Todas</option>' + regiones.map(r => (
          `<option value="${Number(r.id)}">${escHtml(safestr(r.nombre))}</option>`
        )).join('');
        regSel.disabled = false;
        if (curReg && regiones.some(r => String(r.id) === String(curReg))) regSel.value = curReg;
      }

      const assignedRubro = getAssignedRubroId();
      if (assignedRubro && assignedRubro !== 1) {
        rubSel.innerHTML = rubros
          .filter(ru => Number(ru.id) === assignedRubro)
          .map(ru => `<option value="${Number(ru.id)}">${escHtml(`${safestr(ru.nombre_rubro)} (${safestr(ru.encargado_nombre)})`)}</option>`)
          .join('');
        rubSel.value = String(assignedRubro);
        rubSel.disabled = true;
        rubSel.title = 'Filtrado automáticamente a tu rubro asignado';
      } else {
        rubSel.innerHTML = '<option value="">Todos</option>' + rubros.map(ru => (
          `<option value="${Number(ru.id)}">${escHtml(`${safestr(ru.nombre_rubro)} (${safestr(ru.encargado_nombre)})`)}</option>`
        )).join('');
        rubSel.disabled = false;
        if (curRub && curRub !== '1' && rubros.some(ru => String(ru.id) === String(curRub))) {
          rubSel.value = curRub;
        } else {
          rubSel.value = '';
        }
      }

      await loadRegionalOficinas(regSel.value || '');
      REGIONAL_FILTERS_LOADED = true;
      updateRegionalFirmasPreview();
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || 'Error al cargar catálogos regionales', false);
    }
  }

  async function renderRegionalInventory(){
    const tbody = $('reg_tbody');
    const meta = $('reg_meta');
    const badge = $('reg_mode_badge');
    const msg = $('reg_msg');
    if (!tbody) return;

    updateRegionalFirmasPreview();
    if (msg) msg.textContent = '';

    const region_id = safestr($('reg_filter_region')?.value);
    const oficina_id = safestr($('reg_filter_oficina')?.value);
    const rubro_id = safestr($('reg_filter_rubro')?.value);

    const params = new URLSearchParams();
    if (region_id) params.set('region_id', region_id);
    if (oficina_id) params.set('oficina_id', oficina_id);
    if (rubro_id) params.set('rubro_id', rubro_id);

    tbody.innerHTML = '<tr><td colspan="8" class="muted">Cargando inventario regional...</td></tr>';

    try {
      const qs = params.toString();
      const res = await apiJSON(`/api/inventario-regional${qs ? `?${qs}` : ''}`);
      const rows = Array.isArray(res?.data) ? res.data : [];
      const isGrouped = Boolean(res?.grouped);
      const canUserEdit = Boolean(uiPerms().puedeEditarRegional && res?.puedeEditar !== false);
      const canUserPdf = Boolean(uiPerms().puedeGenerarPdfRegional && res?.puedeGenerarPdf !== false);
      REGIONAL_LAST_ROWS = rows;

      if ($('btn-reg-add')) $('btn-reg-add').classList.toggle('hidden', !canUserEdit);
      if ($('btn-reg-pdf')) $('btn-reg-pdf').classList.toggle('hidden', !canUserPdf);

      if (meta) {
        meta.textContent = `${rows.length} registro${rows.length === 1 ? '' : 's'}`;
      }
      if (badge) {
        const roLabel = !canUserEdit ? ' — Modo Solo Lectura (Región Asignada)' : '';
        badge.textContent = (isGrouped
          ? 'Vista agrupada por Clave Bien (Suma regional de oficinas)'
          : 'Vista detallada por oficina') + roLabel;
      }

      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="muted">Sin registros de inventario para los filtros seleccionados.</td></tr>';
        return;
      }

      tbody.innerHTML = rows.map((r, idx) => {
        const estatus = safestr(r.estatus_uso || 'ACTIVO').toUpperCase();
        const inSiniestro = isSiniestroActivo(r);
        let statusClass = 'status-aprobada';
        if (estatus === 'PRESTADO' || estatus === 'EN_REPARACION') statusClass = 'status-pendiente';
        if (estatus === 'BAJA' || inSiniestro) statusClass = 'status-cancelada';

        const isVeh = safestr(r.rubro_codigo).toUpperCase() === 'PARQUE_VEHICULAR' || isRubroParqueVehicular(r.rubro_id);
        const canEditRow = Boolean(canUserEdit && r.id && !isGrouped);
        const histBtn = isVeh
          ? `<button type="button" class="mini" data-reg-hist-idx="${idx}" title="Ver historial de movimientos y transferencias">⏱️ Historial</button>`
          : '';

        const ofiNorm = safestr(r.oficina_nombre).toLowerCase();
        const isRowInRM = ofiNorm.includes('rm') || ofiNorm.includes('recursos materiales') || Number(r.es_bodega_delegacion || 0) === 1;
        const transBtnLabel = (Number(r.rubro_id) === 3 && !isRowInRM)
          ? '🔄 Transferir / Regresar a RM'
          : '🔄 Transferir';

        const obsPublica = safestr(r.observaciones || '-');
        const cantPropia = Number(r.cantidad_propia ?? 0);
        const cantDisp = Number(r.cantidad_disponible ?? cantPropia);
        const cantPrest = Number(r.cantidad_prestada_enviada ?? 0);
        const stockMin = Number(r.stock_minimo ?? 0);
        const showDispBadge = cantDisp < cantPropia || cantPrest > 0;

        // v55: Semáforo de Stock en Inventario Regional: Solo alerta roja por stock cero (sin badge de texto, alerta amarilla eliminada)
        // v59: Alerta roja destacada cuando el vehículo/bien está en Siniestro / Aseguradora
        const isSinProducto = cantDisp <= 0;

        let rowBgStyle = '';
        if (inSiniestro) {
          rowBgStyle = 'background-color:#fff1f2; border-left:4px solid #e11d48; color:#9f1239;';
        } else if (isSinProducto) {
          rowBgStyle = 'background-color:#fee2e2; color:#991b1b;';
        }

        const estatusCellHtml = inSiniestro
          ? `<span class="badge-siniestro">🚨 NO DISPONIBLE — EN ASEGURADORA / SINIESTRO</span>`
          : `<span class="status-badge ${statusClass}">${escHtml(estatus)}</span>`;

        const cantHtml = showDispBadge
          ? `<b>${cantPropia}</b><div style="font-size:11px; color:inherit; font-weight:500;">(${cantDisp} disp.${cantPrest > 0 ? ` / ${cantPrest} prést.` : ''})</div>`
          : `<b>${cantPropia}</b>`;
        const stockCellHtml = cantHtml;

        const isAdminUser = Boolean(
          uiPerms().admin ||
          norm(CURRENT_USER?.rol || UI_PERMISOS?.rol || '') === 'ADMIN' ||
          norm(CURRENT_USER?.username || UI_PERMISOS?.user || '') === 'ADMIN'
        );
        const needsForzarRetorno = isAdminUser && canEditRow && (cantDisp < cantPropia || cantPrest > 0 || estatus === 'PRESTADO');
        const forceReturnBtn = needsForzarRetorno
          ? `<button type="button" class="mini" style="border-color:#d97706; color:#b45309; background:#fffbeb; font-weight:600;" data-reg-force-return-idx="${idx}" title="Forzar Retorno: Restaurar stock disponible igual a cantidad propia">🔄 Forzar Retorno</button>`
          : '';

        let actionsHtml = `<div style="display:flex; gap:4px; align-items:center; flex-wrap:wrap;">${histBtn}<span class="muted" style="font-size:11.5px;">Solo lectura</span></div>`;
        if (canUserEdit) {
          actionsHtml = canEditRow
            ? `<div style="display:flex; gap:4px; flex-wrap:wrap;">
                 <button type="button" class="mini" data-reg-edit-idx="${idx}" title="Editar datos y checklist">Editar</button>
                 <button type="button" class="mini" data-reg-trans-idx="${idx}" title="Transferir o regresar piezas a otra oficina / RM">${transBtnLabel}</button>
                 ${forceReturnBtn}
                 ${histBtn}
                 ${(isVeh && canUserPdf) ? `<button type="button" class="mini" style="border-color:var(--primary); color:var(--primary);" data-reg-pdf-id="${Number(r.id)}" title="Generar formato PDF de resguardo vehicular">PDF Resguardo</button>` : ''}
               </div>`
            : `<div style="display:flex; gap:4px; align-items:center; flex-wrap:wrap;">
                 ${histBtn}
                 <span class="muted" style="font-size:11.5px;">Selecciona oficina para editar/transferir</span>
               </div>`;
        }

        const ofiSubtitle = (!oficina_id && r.oficina_nombre)
          ? `<div class="muted" style="font-size:11px; margin-top:2px;">📍 ${escHtml(safestr(r.oficina_nombre))}</div>`
          : '';

        return `<tr class="${inSiniestro ? 'row-siniestro' : ''}" style="${rowBgStyle}">
          <td><b>${escHtml(safestr(r.clave_bien || '-'))}</b></td>
          <td>${escHtml(safestr(r.descripcion || '-'))}${ofiSubtitle}</td>
          <td>${escHtml(safestr(r.marca_modelo || '-'))}</td>
          <td>${escHtml(safestr(r.numero_serie_placas || '-'))}</td>
          <td style="text-align:center; font-weight:600;">${stockCellHtml}</td>
          <td>${estatusCellHtml}</td>
          <td>${escHtml(obsPublica)}</td>
          <td>${actionsHtml}</td>
        </tr>`;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="8" class="muted" style="color:var(--danger);">${escHtml(e.message || 'Error al cargar inventario regional')}</td></tr>`;
      if (!handleAuthError(e)) toast(e.message || 'Error al cargar inventario regional', false);
    }
  }

  // ---- Modal "Agregar / Editar Activo" (con soporte híbrido PARQUE_VEHICULAR) ----
  async function openRegionalAddModal(editRow = null){
    const modal = $('modal-add-regional');
    const form = $('form-add-regional');
    const ofiSel = $('reg_add_oficina');
    const rubSel = $('reg_add_rubro');
    const titleEl = $('modal-add-regional-title');
    if (!modal || !form || !ofiSel || !rubSel) return;

    const isAdminUser = Boolean(
      uiPerms().admin ||
      norm(CURRENT_USER?.rol || UI_PERMISOS?.rol || '') === 'ADMIN' ||
      norm(CURRENT_USER?.username || UI_PERMISOS?.user || '') === 'ADMIN'
    );

    form.reset();
    if ($('reg_add_id')) $('reg_add_id').value = editRow?.id ? String(editRow.id) : '';
    if (titleEl) {
      titleEl.textContent = editRow?.id
        ? `Editar Activo — ${safestr(editRow.clave_bien)}`
        : 'Agregar Activo';
    }
    if ($('reg_add_cantidad')) {
      $('reg_add_cantidad').min = (isAdminUser || editRow?.id) ? '0' : '1';
      $('reg_add_cantidad').value = editRow?.cantidad_propia != null ? String(editRow.cantidad_propia) : '1';
    }
    if ($('reg_add_estado')) $('reg_add_estado').value = safestr(editRow?.estado_fisico || 'BUENO').toUpperCase();
    if ($('reg_add_estatus')) $('reg_add_estatus').value = safestr(editRow?.estatus_uso || 'ACTIVO').toUpperCase();
    if ($('reg_add_obs')) $('reg_add_obs').value = safestr(editRow?.observaciones || '');
    if ($('reg_add_msg')) $('reg_add_msg').textContent = '';

    const btnForzar = $('btn-forzar-retorno');
    if (btnForzar) {
      const cantPropia = Number(editRow?.cantidad_propia ?? 0);
      const cantDisp = Number(editRow?.cantidad_disponible ?? cantPropia);
      const cantPrest = Number(editRow?.cantidad_prestada_enviada ?? 0);
      const estUso = norm(editRow?.estatus_uso || '');
      if (editRow?.id && isAdminUser && (cantDisp < cantPropia || cantPrest > 0 || estUso === 'PRESTADO')) {
        btnForzar.classList.remove('hidden');
        btnForzar.style.display = '';
        btnForzar.dataset.activoId = String(editRow.id);
        btnForzar.dataset.claveBien = safestr(editRow.clave_bien);
      } else {
        btnForzar.classList.add('hidden');
        btnForzar.style.display = 'none';
        btnForzar.dataset.activoId = '';
        btnForzar.dataset.claveBien = '';
      }
    }

    const btnEliminar = $('btn-eliminar-regional');
    if (btnEliminar) {
      if (editRow?.id && isAdminUser) {
        btnEliminar.classList.remove('hidden');
        btnEliminar.style.display = 'inline-block';
        btnEliminar.dataset.activoId = String(editRow.id);
        btnEliminar.dataset.claveBien = safestr(editRow.clave_bien);
      } else {
        btnEliminar.classList.add('hidden');
        btnEliminar.style.display = 'none';
        btnEliminar.dataset.activoId = '';
        btnEliminar.dataset.claveBien = '';
      }
    }

    try {
      if (!REGIONAL_CATALOGS.rubros.length) await loadRegionalFilters(true);
      const assignedRubro = getAssignedRubroId();
      const rubrosDisponibles = REGIONAL_CATALOGS.rubros.filter(ru => Number(ru.id) !== 1);
      if (assignedRubro && assignedRubro !== 1) {
        rubSel.innerHTML = rubrosDisponibles
          .filter(ru => Number(ru.id) === assignedRubro)
          .map(ru => `<option value="${Number(ru.id)}">${escHtml(`${safestr(ru.nombre_rubro)} (${safestr(ru.encargado_nombre)})`)}</option>`)
          .join('');
        rubSel.value = String(assignedRubro);
        rubSel.disabled = true;
      } else {
        rubSel.innerHTML = '<option value="">- selecciona rubro -</option>' +
          rubrosDisponibles.map(ru => (
            `<option value="${Number(ru.id)}">${escHtml(`${safestr(ru.nombre_rubro)} (${safestr(ru.encargado_nombre)})`)}</option>`
          )).join('');
        rubSel.disabled = false;
      }

      if (editRow && editRow.rubro_id && (!assignedRubro || assignedRubro === 1)) {
        rubSel.value = String(editRow.rubro_id);
      } else if (!editRow && (!assignedRubro || assignedRubro === 1)) {
        const curRub = safestr($('reg_filter_rubro')?.value);
        if (curRub && curRub !== '1' && rubrosDisponibles.some(r => String(r.id) === curRub)) rubSel.value = curRub;
      }

      const activeModalRubro = Number(rubSel.value || editRow?.rubro_id || assignedRubro || $('reg_filter_rubro')?.value || 0);
      const res = await apiJSON(`/api/oficinas${activeModalRubro ? `?rubro_id=${activeModalRubro}` : ''}`);
      const rawOficinas = Array.isArray(res?.data) ? res.data : [];
      const oficinas = filterOficinasForRegionalSelector(rawOficinas, activeModalRubro);
      if (editRow && editRow.oficina_id && !oficinas.some(o => Number(o.id) === Number(editRow.oficina_id))) {
        const matchRaw = rawOficinas.find(o => Number(o.id) === Number(editRow.oficina_id));
        if (matchRaw) oficinas.push(matchRaw);
      }
      const byRegion = new Map();
      oficinas.forEach(o => {
        const key = safestr(o.region_nombre) || `Región ${o.region_id}`;
        if (!byRegion.has(key)) byRegion.set(key, []);
        byRegion.get(key).push(o);
      });
      ofiSel.innerHTML = '<option value="">- selecciona oficina -</option>' +
        Array.from(byRegion.entries()).map(([regName, list]) => (
          `<optgroup label="${escHtml(regName)}">` +
          list.map(o => {
            const label = formatRegionalOficinaOptionLabel(o);
            return `<option value="${Number(o.id)}">${escHtml(label)}</option>`;
          }).join('') +
          '</optgroup>'
        )).join('');

      if (editRow) {
        if (editRow.oficina_id) ofiSel.value = String(editRow.oficina_id);
        if ($('reg_add_clave')) $('reg_add_clave').value = safestr(editRow.clave_bien).toUpperCase();
        if ($('reg_add_desc')) $('reg_add_desc').value = safestr(editRow.descripcion);
        if ($('reg_add_marca')) $('reg_add_marca').value = safestr(editRow.marca_modelo);
        if ($('reg_add_serie')) $('reg_add_serie').value = safestr(editRow.numero_serie_placas);
      } else {
        const curOfi = safestr($('reg_filter_oficina')?.value);
        if (curOfi && oficinas.some(o => String(o.id) === curOfi)) ofiSel.value = curOfi;
        if ($('reg_add_clave')) $('reg_add_clave').value = '';
      }

      populateVehiculoFormFields(editRow?.detalles_vehiculo || null, editRow);
      toggleVehiculoSectionByRubro();

      const isVehRow = safestr(editRow?.rubro_codigo).toUpperCase() === 'PARQUE_VEHICULAR' || isRubroParqueVehicular(editRow?.rubro_id);
      const btnHistModal = $('btn-reg-ver-historial-modal');
      if (btnHistModal) {
        if (editRow && isVehRow) {
          btnHistModal.classList.remove('hidden');
          btnHistModal.onclick = () => openVehiculoHistorialModal(editRow);
        } else {
          btnHistModal.classList.add('hidden');
          btnHistModal.onclick = null;
        }
      }
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || 'Error al cargar catálogos', false);
      return;
    }

    modal.classList.remove('hidden');
    setTimeout(() => (ofiSel.value ? $('reg_add_clave') : ofiSel)?.focus(), 0);
  }

  function closeRegionalAddModal(){
    $('modal-add-regional')?.classList.add('hidden');
    const btnHistModal = $('btn-reg-ver-historial-modal');
    if (btnHistModal) {
      btnHistModal.classList.add('hidden');
      btnHistModal.onclick = null;
    }
    const btnForzar = $('btn-forzar-retorno');
    if (btnForzar) {
      btnForzar.classList.add('hidden');
      btnForzar.style.display = 'none';
      btnForzar.dataset.activoId = '';
      btnForzar.dataset.claveBien = '';
    }
    const btnEliminar = $('btn-eliminar-regional');
    if (btnEliminar) {
      btnEliminar.classList.add('hidden');
      btnEliminar.style.display = 'none';
      btnEliminar.dataset.activoId = '';
      btnEliminar.dataset.claveBien = '';
    }
  }

  async function eliminarActivoRegional(activoId, claveBien = ''){
    const id = Number(activoId || $('btn-eliminar-regional')?.dataset?.activoId || $('reg_add_id')?.value || 0);
    if (!id) return;
    const label = claveBien ? ` (${claveBien})` : ` #${id}`;
    if (!confirm("⚠️ ¿Estás seguro de eliminar definitivamente este artículo del inventario regional? Esta acción no se puede deshacer.")) {
      return;
    }
    const btn = $('btn-eliminar-regional');
    try {
      if (btn) btn.disabled = true;
      const res = await apiJSON(`/api/inventario-regional/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
      toast(res?.message || `Artículo${label} eliminado definitivamente.`, true);
      closeRegionalAddModal();
      await renderRegionalInventory();
      try { if (typeof loadVpCatalogo === 'function') await loadVpCatalogo(); } catch (_) {}
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || 'Error al eliminar activo regional', false);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function forzarRetornoRegional(activoId, claveBien = ''){
    const id = Number(activoId || $('reg_add_id')?.value || 0);
    if (!id) return;
    const label = claveBien ? ` (${claveBien})` : ` #${id}`;
    if (!confirm(`¿Forzar retorno y restaurar el stock disponible al 100% para el artículo${label}?`)) {
      return;
    }
    const btn = $('btn-forzar-retorno');
    try {
      if (btn) btn.disabled = true;
      const res = await apiJSON(`/api/inventario-regional/${encodeURIComponent(id)}/forzar-retorno`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' }
      });
      toast(res?.message || `Stock restaurado exitosamente para el artículo${label}`, true);
      closeRegionalAddModal();
      await renderRegionalInventory();
      try { if (typeof loadVpCatalogo === 'function') await loadVpCatalogo(); } catch (_) {}
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || 'Error al forzar retorno del activo', false);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function submitRegionalAddForm(ev, { downloadPdfAfter = false } = {}){
    ev?.preventDefault();
    const msg = $('reg_add_msg');
    const btn = $('btn-reg-add-save');
    const btnPdf = $('btn-reg-save-and-pdf');
    const editId = Number($('reg_add_id')?.value || 0) || null;
    const rubroId = Number($('reg_add_rubro')?.value || 0);
    const isVeh = isRubroParqueVehicular(rubroId);
    const vehDetails = isVeh ? collectVehiculoFormFields() : null;
    const resgObj = vehDetails?.resguardante || {};

    const payload = {
      oficina_id: Number($('reg_add_oficina')?.value || 0),
      rubro_id: rubroId,
      clave_bien: safestr($('reg_add_clave')?.value).trim().toUpperCase(),
      descripcion: safestr($('reg_add_desc')?.value),
      marca_modelo: safestr($('reg_add_marca')?.value) || null,
      numero_serie_placas: safestr($('reg_add_serie')?.value) || null,
      cantidad_propia: safestr($('reg_add_cantidad')?.value) === '' ? 1 : Number($('reg_add_cantidad')?.value),
      estado_fisico: safestr($('reg_add_estado')?.value) || 'BUENO',
      estatus_uso: safestr($('reg_add_estatus')?.value) || 'ACTIVO',
      observaciones: safestr($('reg_add_obs')?.value) || null,
      detalles_vehiculo: vehDetails,
      ...(isVeh ? {
        resguardante_nombre: resgObj.nombre_completo || null,
        resguardante_rfc: resgObj.rfc || null,
        resguardante_puesto: resgObj.puesto || null,
        resguardante_adscripcion: resgObj.adscripcion || null,
        resguardante_programa: resgObj.programa || null,
        resguardante_licencia: resgObj.licencia_no || null,
        resguardante_vigencia_licencia: resgObj.vigencia_licencia || null
      } : {})
    };

    if (isVeh && payload.detalles_vehiculo?.unidad) {
      const u = payload.detalles_vehiculo.unidad;
      if (!payload.marca_modelo) {
        payload.marca_modelo = [u.marca, u.tipo, u.modelo].filter(Boolean).join(' ') || null;
      }
      if (!payload.numero_serie_placas) {
        payload.numero_serie_placas = [u.placas, u.serie_vin].filter(Boolean).join(' / ') || null;
      }
    }

    const fail = (text, focusId) => {
      if (msg) msg.textContent = text;
      if (focusId) $(focusId)?.focus();
    };
    if (!payload.oficina_id) return fail('Selecciona la oficina.', 'reg_add_oficina');
    if (!payload.rubro_id) return fail('Selecciona el rubro.', 'reg_add_rubro');
    if (!payload.clave_bien) return fail('La clave del bien es requerida.', 'reg_add_clave');
    if (!payload.descripcion) return fail('La descripción es requerida.', 'reg_add_desc');

    const isAdminUser = Boolean(
      uiPerms().admin ||
      norm(CURRENT_USER?.rol || UI_PERMISOS?.rol || '') === 'ADMIN' ||
      norm(CURRENT_USER?.username || UI_PERMISOS?.user || '') === 'ADMIN'
    );
    const minCant = (isAdminUser || editId) ? 0 : 1;
    if (!Number.isInteger(payload.cantidad_propia) || payload.cantidad_propia < minCant) {
      return fail(
        minCant === 0
          ? 'La cantidad debe ser un número entero mayor o igual a 0.'
          : 'La cantidad debe ser un número entero mayor o igual a 1.',
        'reg_add_cantidad'
      );
    }

    try {
      if (btn) btn.disabled = true;
      if (btnPdf) btnPdf.disabled = true;
      if (msg) msg.textContent = 'Guardando...';
      let savedAssetId = editId;
      if (editId) {
        await apiJSON(`/api/inventario-regional/${encodeURIComponent(editId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        toast(`Activo "${payload.clave_bien}" actualizado correctamente`, true);
      } else {
        const created = await apiJSON('/api/inventario-regional', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        savedAssetId = Number(created?.id || 0) || null;
        toast(`Activo "${payload.clave_bien}" agregado correctamente`, true);
      }
      closeRegionalAddModal();
      await renderRegionalInventory();
      try { if (typeof loadVpCatalogo === 'function') await loadVpCatalogo(); } catch (_) {}
      if (downloadPdfAfter && savedAssetId) {
        await generarFormatoRegionalPDF(savedAssetId);
      }
    } catch (e) {
      if (msg) msg.textContent = e.message || 'Error al guardar el activo';
      if (e.status === 409 || (e.message && e.message.includes('ya existe'))) {
        alert(e.message || "⚠️ Error: La clave de producto ingresada ya existe. Por favor asigna una clave diferente.");
        $('reg_add_clave')?.focus();
      } else if (!handleAuthError(e)) {
        toast(e.message || 'Error al guardar el activo', false);
      }
    } finally {
      if (btn) btn.disabled = false;
      if (btnPdf) btnPdf.disabled = false;
    }
  }

  async function generarFormatoRegionalPDF(activoId = null){
    const btn = $('btn-reg-pdf');
    const msg = $('reg_msg');
    const region_id = safestr($('reg_filter_region')?.value);
    const oficina_id = safestr($('reg_filter_oficina')?.value);
    const rubro_id = safestr($('reg_filter_rubro')?.value);

    if (uiPerms().puedeGenerarPdfRegional === false) {
      toast('No tienes permisos para descargar el PDF de resguardo regional', false);
      return;
    }

    // No permitir generar el documento general (todos los filtros en "Todas"/"Todos") salvo que sea un activo individual
    if (!region_id && !oficina_id && !rubro_id && !activoId) {
      toast('No se puede generar el documento general. Por favor selecciona al menos una Región o un Rubro.', false);
      return;
    }

    try {
      if (btn) btn.disabled = true;
      if (msg) msg.textContent = 'Generando formato PDF y guardando respaldo...';

      const res = await api('/api/inventario-regional/formatos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/pdf'
        },
        body: JSON.stringify({
          region_id: region_id ? Number(region_id) : null,
          oficina_id: oficina_id ? Number(oficina_id) : null,
          rubro_id: rubro_id ? Number(rubro_id) : null,
          activo_id: activoId ? Number(activoId) : null
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        let errMsg = `HTTP ${res.status}`;
        try {
          const j = JSON.parse(errText);
          errMsg = j?.error || j?.message || errMsg;
        } catch {
          if (errText) errMsg = errText;
        }
        throw new Error(errMsg);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const disp = res.headers.get('Content-Disposition') || '';
      const match = disp.match(/filename="?([^"]+)"?/i);
      link.download = match ? match[1] : `formato_inventario_regional_${Date.now()}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      if (msg) msg.textContent = 'Formato PDF generado y registrado exitosamente.';
      toast('Formato PDF (4 Firmas) descargado con éxito', true);
    } catch (e) {
      if (msg) msg.textContent = e.message || 'Error al generar PDF';
      if (!handleAuthError(e)) toast(`Error generando PDF: ${e.message}`, false);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---- Modal de Transferencia entre Oficinas Regionales (Punto 5) ----
  async function openRegionalTransferModal(row){
    if (!row || !row.id) return;
    const modal = $('modal-transferir-regional');
    const form = $('form-transferir-regional');
    const destSel = $('reg_trans_oficina_destino') || $('reg_trans_destino');
    if (!modal || !form || !destSel) {
      console.warn("No se encontró modal, form o selector de destino para transferencia");
      return;
    }

    form.reset();
    if ($('reg_trans_id')) $('reg_trans_id').value = String(row.id);
    const cantPropiaRow = Number(row.cantidad_propia ?? 1);
    const cantDispRow = Number(row.cantidad_disponible ?? cantPropiaRow);
    const maxQty = Math.max(1, Math.min(cantPropiaRow, cantDispRow));
    if ($('reg_trans_info')) {
      $('reg_trans_info').innerHTML = `
        <b>Bien:</b> ${escHtml(safestr(row.clave_bien))} — ${escHtml(safestr(row.descripcion))}<br>
        <b>Oficina actual:</b> ${escHtml(safestr(row.oficina_nombre || '-'))} (${escHtml(safestr(row.region_nombre || '-'))}) | <b>Propia:</b> ${cantPropiaRow} | <b>Disponible para transferir:</b> ${maxQty}
      `;
    }
    if ($('reg_trans_cantidad')) {
      $('reg_trans_cantidad').value = String(maxQty);
      $('reg_trans_cantidad').max = String(maxQty);
    }
    if ($('reg_trans_motivo')) $('reg_trans_motivo').value = '';
    if ($('reg_trans_msg')) $('reg_trans_msg').textContent = '';

    try {
      const rowRubroId = Number(row.rubro_id || $('reg_filter_rubro')?.value || getAssignedRubroId() || 0);
      const res = await apiJSON(`/api/oficinas${rowRubroId ? `?rubro_id=${rowRubroId}` : ''}`);
      const rawOficinas = Array.isArray(res?.data) ? res.data : [];
      const oficinas = filterOficinasForRegionalSelector(rawOficinas, rowRubroId);
      const byRegion = new Map();
      const destCandidates = oficinas.filter(o => Number(o.id) !== Number(row.oficina_id));
      destCandidates.forEach(o => {
        const key = safestr(o.region_nombre) || `Región ${o.region_id}`;
        if (!byRegion.has(key)) byRegion.set(key, []);
        byRegion.get(key).push(o);
      });
      destSel.innerHTML = '<option value="">- selecciona oficina destino -</option>' +
        Array.from(byRegion.entries()).map(([regName, list]) => (
          `<optgroup label="${escHtml(regName)}">` +
          list.map(o => {
            const label = formatRegionalOficinaOptionLabel(o);
            return `<option value="${Number(o.id)}">${escHtml(label)}</option>`;
          }).join('') +
          '</optgroup>'
        )).join('');

      // Si el bien está en una oficina regional (no RM), preseleccionar automáticamente RM (Recursos Materiales) si está disponible
      const curOfiNorm = safestr(row.oficina_nombre).toLowerCase();
      const isCurrentlyRM = curOfiNorm.includes('rm') || curOfiNorm.includes('recursos materiales') || Number(row.es_bodega_delegacion || 0) === 1;
      if (!isCurrentlyRM) {
        const rmOpt = destCandidates.find(o => {
          const n = safestr(o.nombre).toLowerCase();
          return n.includes('rm (recursos materiales)') || n === 'rm' || n.includes('recursos materiales');
        });
        if (rmOpt) {
          destSel.value = String(rmOpt.id);
        }
      }
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || 'Error al cargar oficinas', false);
      return;
    }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }

  function closeRegionalTransferModal(){
    const modal = $('modal-transferir-regional');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }

  async function submitRegionalTransferForm(ev){
    ev?.preventDefault();
    const id = Number($('reg_trans_id')?.value || 0);
    const destSel = $('reg_trans_oficina_destino') || $('reg_trans_destino');
    const destino = Number(destSel?.value || 0);
    const cantidad = Number($('reg_trans_cantidad')?.value || 0);
    const motivo = safestr($('reg_trans_motivo')?.value) || null;
    const msg = $('reg_trans_msg');
    const btn = $('btn-reg-trans-save');

    if (!id) return;
    if (!destino) {
      if (msg) msg.textContent = 'Selecciona la oficina destino.';
      return;
    }
    if (!Number.isInteger(cantidad) || cantidad < 1) {
      if (msg) msg.textContent = 'Ingresa una cantidad válida a transferir.';
      return;
    }

    try {
      if (btn) btn.disabled = true;
      if (msg) msg.textContent = 'Transfiriendo...';
      const res = await apiJSON('/api/inventario-regional/transferir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origen_id: id,
          oficina_destino_id: destino,
          cantidad_transferir: cantidad,
          cantidad: cantidad,
          motivo
        })
      });
      toast(res?.message || 'Transferencia realizada exitosamente', true);
      closeRegionalTransferModal();
      await renderRegionalInventory();
      try { if (typeof loadVpCatalogo === 'function') await loadVpCatalogo(); } catch (_) {}
    } catch (e) {
      if (msg) msg.textContent = e.message || 'Error al transferir';
      if (!handleAuthError(e)) toast(e.message || 'Error al transferir bien', false);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---- Modal Historial de Movimientos de Vehículo ----
  function openVehiculoHistorialModal(row){
    if (!row) return;
    const modal = $('modal-historial-vehiculo');
    if (!modal) return;

    const infoBox = $('historial_vehiculo_info');
    const titleEl = $('modal-historial-vehiculo-title');
    const listEl = $('historial_vehiculo_lista');
    const textArea = $('historial_vehiculo_texto');

    const clave = safestr(row.clave_bien || '-');
    const desc = safestr(row.descripcion || '-');
    const marca = safestr(row.marca_modelo || '-');
    const serie = safestr(row.numero_serie_placas || '-');
    const ofi = safestr(row.oficina_nombre || '-');
    const reg = safestr(row.region_nombre || '-');

    if (titleEl) {
      titleEl.textContent = `Historial de Movimientos — ${clave}`;
    }

    if (infoBox) {
      infoBox.innerHTML = `
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:6px;">
          <div><b>Clave Bien:</b> ${escHtml(clave)}</div>
          <div><b>Placas / Serie:</b> ${escHtml(serie)}</div>
          <div><b>Marca / Modelo:</b> ${escHtml(marca)}</div>
          <div><b>Oficina Actual:</b> ${escHtml(ofi)} (${escHtml(reg)})</div>
        </div>
        <div style="margin-top:6px; font-size:12px; color:var(--muted);"><b>Descripción:</b> ${escHtml(desc)}</div>
      `;
    }

    // Extraer observaciones, notas o historial de transferencias
    const rawObs = String(row.observaciones || row.detalles_vehiculo?.observaciones || row.observaciones_control || '').trim();

    if (textArea) {
      textArea.value = rawObs || 'Sin notas ni registros de transferencias previas para este vehículo.';
    }

    if (listEl) {
      if (!rawObs) {
        listEl.innerHTML = '<div class="muted" style="font-size:13px; padding:12px; text-align:center;">No hay registros de transferencias ni movimientos para esta unidad.</div>';
      } else {
        // Separar entradas por ' | ' o saltos de línea
        const entries = rawObs.split(/\s*\|\s*|\r?\n/).map(s => s.trim()).filter(Boolean);
        listEl.innerHTML = entries.map(entry => {
          const isTransfer = /transfer/i.test(entry) || /recibid/i.test(entry);
          const icon = isTransfer ? '🔄' : '📝';
          const bg = isTransfer ? 'var(--bg-app, #f8fafc)' : '#fff';
          const border = isTransfer ? 'var(--primary, #621132)' : 'var(--border, #cbd5e1)';
          return `
            <div style="padding:10px 12px; background:${bg}; border-left:4px solid ${border}; border-radius:4px; font-size:12.5px; line-height:1.4; box-shadow:0 1px 2px rgba(0,0,0,0.04);">
              <span style="margin-right:6px;">${icon}</span>
              ${escHtml(entry)}
            </div>
          `;
        }).join('');
      }
    }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }

  function closeVehiculoHistorialModal(){
    const modal = $('modal-historial-vehiculo');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }

  // ---- Gestión de Usuarios y Perfiles (Exclusivo Admin - CRUD) ----
  let ADMIN_USUARIOS_ROWS = [];

  async function loadUsuariosAdmin(){
    const tbody = $('usuarios_tbody');
    const msg = $('usuarios_msg');
    if (!tbody) return;
    if (!uiPerms().gestionarUsuarios) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">Acceso exclusivo para Administrador.</td></tr>';
      return;
    }
    tbody.innerHTML = '<tr><td colspan="7" class="muted">Cargando usuarios...</td></tr>';
    if (msg) msg.textContent = '';

    try {
      const res = await apiJSON('/api/usuarios');
      const rows = Array.isArray(res?.data) ? res.data : [];
      ADMIN_USUARIOS_ROWS = rows;

      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="muted">Sin usuarios registrados.</td></tr>';
        return;
      }

      tbody.innerHTML = rows.map((u, idx) => {
        const regTxt = u.region_nombre
          ? `${safestr(u.region_nombre)}${u.oficina_nombre ? ` — ${safestr(u.oficina_nombre)}` : ''}`
          : '<span class="muted">La Paz (Delegación Central)</span>';
        const uLow = String(u.username || '').toLowerCase().trim();
        const isFiol = uLow === 'gabrielfiol' || uLow === 'encargado' || uLow === 'fiol';
        const depTxt = isFiol ? 'Encargado de Archivos y Materiales' : safestr(u.oficialia_nombre || u.departamento || (u.id_oficialia ? `Oficialía ${u.id_oficialia}` : '-'));
        const cargoTxt = safestr(u.cargo || '-');
        const rolBadge = isFiol
          ? `<span class="status-badge status-prestamo">ENCARGADO DE ARCHIVOS Y MATERIALES</span>`
          : `<span class="status-badge ${String(u.rol).toUpperCase() === 'ADMIN' ? 'status-aprobada' : (String(u.rol).toUpperCase() === 'ENCARGADO' ? 'status-prestamo' : 'status-pendiente')}">${escHtml(safestr(u.rol || 'USUARIO'))}</span>`;
        const nombreComp = safestr(u.nombre_completo || [u.nombre, u.PRIMER_APELLIDO, u.SEGUNDO_APELLIDO].filter(Boolean).join(' ') || u.nombre || '-');

        return `<tr>
          <td><strong>${u.id}</strong></td>
          <td><b>${escHtml(safestr(u.username))}</b></td>
          <td>${escHtml(nombreComp)}</td>
          <td>${rolBadge}</td>
          <td>${escHtml(cargoTxt)}</td>
          <td><small>${regTxt}</small><br><strong>${escHtml(depTxt)}</strong></td>
          <td>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button type="button" class="mini btn-secondary" data-usr-edit-idx="${idx}">✏️ Editar</button>
              <button type="button" class="mini btn-danger" data-usr-del-idx="${idx}">🗑️ Eliminar</button>
            </div>
          </td>
        </tr>`;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted" style="color:var(--danger);">${escHtml(e.message || 'Error al cargar usuarios')}</td></tr>`;
      if (!handleAuthError(e)) toast(e.message || 'Error al cargar usuarios', false);
    }
  }

  // Alias global requerido
  window.loadUsuarios = loadUsuariosAdmin;

  async function loadUserModalCatalogs(u) {
    const [ofiRes, regRes, ofiRegRes, rubRes] = await Promise.all([
      apiJSON('/api/oficialias'),
      apiJSON('/api/regiones'),
      apiJSON('/api/oficinas'),
      apiJSON('/api/rubros')
    ]);

    const oficialias = Array.isArray(ofiRes?.data) ? ofiRes.data : [];
    const regiones = Array.isArray(regRes?.data) ? regRes.data : [];
    const oficinas = Array.isArray(ofiRegRes?.data) ? ofiRegRes.data : [];
    const rubros = Array.isArray(rubRes?.data) ? rubRes.data : [];

    const ofiSelect = $('usr_edit_oficialia') || $('usr_edit_departamento');
    if (ofiSelect) {
      ofiSelect.innerHTML = '<option value="">- Sin oficialía asignada -</option>' +
        oficialias.map(o => `<option value="${Number(o.id)}">${escHtml(safestr(o.nombre))}</option>`).join('');
      const currentOfi = u ? (u.id_oficialia || u.departamento_id || u.OFICIALIA_ID) : '';
      ofiSelect.value = currentOfi ? String(currentOfi) : '';
    }
    if ($('usr_edit_region')) {
      $('usr_edit_region').innerHTML = '<option value="">La Paz (Delegación Central por defecto)</option>' +
        regiones.map(r => `<option value="${Number(r.id)}">${escHtml(safestr(r.nombre))}</option>`).join('');
      $('usr_edit_region').value = u && u.region_id ? String(u.region_id) : '';
    }
    if ($('usr_edit_oficina')) {
      $('usr_edit_oficina').innerHTML = '<option value="">- ninguna -</option>' +
        oficinas.map(o => `<option value="${Number(o.id)}">${escHtml(`${safestr(o.region_nombre || '')} — ${safestr(o.nombre)}`)}</option>`).join('');
      $('usr_edit_oficina').value = u && u.oficina_id ? String(u.oficina_id) : '';
    }
    if ($('usr_edit_rubro')) {
      $('usr_edit_rubro').innerHTML = '<option value="">- ninguno (no es encargado de rubro) -</option>' +
        rubros.map(r => `<option value="${Number(r.id)}">${escHtml(`${safestr(r.nombre_rubro)} (${safestr(r.encargado_nombre)})`)}</option>`).join('');
      $('usr_edit_rubro').value = u && u.rubro_id ? String(u.rubro_id) : '';
    }
  }

  function getEditUserModal() {
    return $('modal-edit-user') || $('modal-edit-usuario');
  }

  async function openNewUsuarioModal() {
    const modal = getEditUserModal();
    const form = $('form-edit-usuario');
    if (!modal || !form) return;

    form.reset();
    form.dataset.isEditing = '';
    form.dataset.editingUsername = '';
    if ($('usr_edit_id')) $('usr_edit_id').value = '';
    const uInput = $('usr_edit_username');
    if (uInput) {
      uInput.value = '';
      uInput.readOnly = false;
      uInput.classList.remove('readonly');
      uInput.placeholder = 'ej. jnieves';
    }
    const titleEl = $('modal-user-title') || modal.querySelector('.modal-header h3');
    if (titleEl) titleEl.textContent = '➕ Nuevo Usuario';
    const pwdLabel = $('usr_edit_password_label');
    if (pwdLabel) pwdLabel.textContent = 'Contraseña inicial *';
    const pwdInput = $('usr_edit_password');
    if (pwdInput) {
      pwdInput.required = true;
      pwdInput.placeholder = 'Contraseña de acceso';
    }

    if ($('usr_edit_rol')) $('usr_edit_rol').value = 'USUARIO';
    if ($('usr_edit_nombre')) $('usr_edit_nombre').value = '';
    if ($('usr_edit_primer_ap')) $('usr_edit_primer_ap').value = '';
    if ($('usr_edit_segundo_ap')) $('usr_edit_segundo_ap').value = '';
    if ($('usr_edit_cargo')) $('usr_edit_cargo').value = '';
    if ($('usr_edit_licencia')) $('usr_edit_licencia').value = '';
    if ($('usr_edit_vigencia_licencia')) $('usr_edit_vigencia_licencia').value = '';

    if ($('usr_edit_msg')) {
      $('usr_edit_msg').textContent = '';
      $('usr_edit_msg').className = 'msg';
    }

    try {
      await loadUserModalCatalogs(null);
    } catch (_) {}

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }

  async function openEditUsuarioModal(u){
    if (!u || (u.id == null && !u.username)) return;
    const modal = getEditUserModal();
    const form = $('form-edit-usuario');
    if (!modal || !form) return;

    form.reset();
    form.dataset.isEditing = '1';
    form.dataset.editingUsername = safestr(u.username);
    if ($('usr_edit_id')) $('usr_edit_id').value = String(u.id ?? 0);
    const uInput = $('usr_edit_username');
    if (uInput) {
      uInput.value = safestr(u.username);
      uInput.readOnly = true;
      uInput.classList.add('readonly');
    }
    const titleEl = $('modal-user-title') || modal.querySelector('.modal-header h3');
    if (titleEl) titleEl.textContent = `✏️ Editar Usuario: ${u.username}`;
    const pwdLabel = $('usr_edit_password_label');
    if (pwdLabel) pwdLabel.textContent = 'Nueva Contraseña (dejar en blanco para mantener la actual)';
    const pwdInput = $('usr_edit_password');
    if (pwdInput) {
      pwdInput.required = false;
      pwdInput.placeholder = 'Escribe nueva contraseña solo si deseas cambiarla';
    }

    if ($('usr_edit_rol')) $('usr_edit_rol').value = safestr(u.rol || 'USUARIO').toUpperCase();
    if ($('usr_edit_nombre')) $('usr_edit_nombre').value = safestr(u.nombre);

    const ap1Val = safestr(u.PRIMER_APELLIDO || u.primer_apellido || '');
    if ($('usr_edit_primer_ap')) $('usr_edit_primer_ap').value = ap1Val;
    if ($('usr_edit_ap1')) $('usr_edit_ap1').value = ap1Val;

    const ap2Val = safestr(u.SEGUNDO_APELLIDO || u.segundo_apellido || '');
    if ($('usr_edit_segundo_ap')) $('usr_edit_segundo_ap').value = ap2Val;
    if ($('usr_edit_ap2')) $('usr_edit_ap2').value = ap2Val;

    if ($('usr_edit_cargo')) $('usr_edit_cargo').value = safestr(u.cargo || '');
    if ($('usr_edit_licencia')) $('usr_edit_licencia').value = safestr(u.licencia || '');
    if ($('usr_edit_vigencia_licencia')) $('usr_edit_vigencia_licencia').value = safestr(u.vigencia_licencia || '');

    if ($('usr_edit_password')) $('usr_edit_password').value = '';
    if ($('usr_edit_msg')) {
      $('usr_edit_msg').textContent = '';
      $('usr_edit_msg').className = 'msg';
    }

    try {
      await loadUserModalCatalogs(u);
    } catch (e) {
      if (!handleAuthError(e)) toast(e.message || 'Error al cargar catálogos de usuario', false);
    }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }

  function closeEditUsuarioModal(){
    const modal = getEditUserModal();
    if (modal) {
      modal.classList.add('hidden');
      modal.style.display = 'none';
    }
    const msg = $('usr_edit_msg');
    if (msg) msg.textContent = '';
    const btn = $('btn-usr-edit-save');
    if (btn) btn.disabled = false;
  }

  async function deleteUsuarioAdmin(u) {
    if (!u || (u.id == null && !u.username)) return;
    const uIdNum = Number(u.id || 0);
    if ((uIdNum > 0 && Number(CURRENT_USER?.id) === uIdNum) || (u.username && norm(CURRENT_USER?.username) === norm(u.username))) {
      toast('No puedes eliminar tu propio usuario de sesión activa.', false);
      return;
    }
    const conf = confirm(`¿Estás seguro de que deseas eliminar al usuario "${u.username}" (${u.nombre_completo || u.nombre})?`);
    if (!conf) return;

    try {
      const qUser = u.username ? `?username=${encodeURIComponent(u.username)}` : '';
      const res = await apiJSON(`/api/usuarios/${encodeURIComponent(uIdNum)}${qUser}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u.username })
      });
      if (!res.ok) throw new Error(res.error || res.message || 'Error al eliminar usuario');
      toast(res.message || '✓ Usuario eliminado correctamente', true);
      await loadUsuariosAdmin();
    } catch (e) {
      if (!handleAuthError(e)) toast('Error al eliminar: ' + (e.message || e), false);
    }
  }

  async function submitEditUsuarioForm(ev){
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    const form = $('form-edit-usuario');
    const id = Number($('usr_edit_id')?.value || 0);
    const isEditing = Boolean(id > 0 || form?.dataset?.isEditing === '1');
    const msg = $('usr_edit_msg');
    const btn = $('btn-usr-edit-save');

    const username = safestr($('usr_edit_username')?.value || form?.dataset?.editingUsername).trim().toLowerCase();
    const nombre = safestr($('usr_edit_nombre')?.value).trim();
    const primerAp = safestr($('usr_edit_primer_ap')?.value || $('usr_edit_ap1')?.value).trim();
    const segundoAp = safestr($('usr_edit_segundo_ap')?.value || $('usr_edit_ap2')?.value).trim();
    const cargo = safestr($('usr_edit_cargo')?.value).trim();
    const licencia = safestr($('usr_edit_licencia')?.value).trim();
    const vigenciaLicencia = safestr($('usr_edit_vigencia_licencia')?.value).trim();
    const rol = safestr($('usr_edit_rol')?.value) || 'USUARIO';
    const ofiEl = $('usr_edit_oficialia') || $('usr_edit_departamento');
    const ofiId = ofiEl && ofiEl.value ? Number(ofiEl.value) : null;
    const regEl = $('usr_edit_region');
    const regId = regEl && regEl.value ? Number(regEl.value) : null;
    const pwd = safestr($('usr_edit_password')?.value);

    if (!isEditing && !username) {
      if (msg) {
        msg.textContent = 'El nombre de usuario (login) es obligatorio.';
        msg.className = 'msg text-danger';
      }
      $('usr_edit_username')?.focus();
      return;
    }

    if (!nombre) {
      if (msg) {
        msg.textContent = 'El nombre es obligatorio.';
        msg.className = 'msg text-danger';
      }
      $('usr_edit_nombre')?.focus();
      return;
    }

    if (!isEditing && !pwd) {
      if (msg) {
        msg.textContent = 'La contraseña inicial es obligatoria para nuevos usuarios.';
        msg.className = 'msg text-danger';
      }
      $('usr_edit_password')?.focus();
      return;
    }

    const payload = {
      nombre,
      primer_apellido: primerAp,
      segundo_apellido: segundoAp,
      cargo: cargo || null,
      licencia: licencia || null,
      vigencia_licencia: vigenciaLicencia || null,
      rol,
      id_oficialia: ofiId,
      departamento_id: ofiId,
      region_id: regId
    };

    if (username) payload.username = username;
    if (pwd) payload.password = pwd;

    if ($('usr_edit_oficina')) {
      payload.oficina_id = $('usr_edit_oficina').value ? Number($('usr_edit_oficina').value) : null;
    }
    if ($('usr_edit_rubro')) {
      payload.rubro_id = $('usr_edit_rubro').value ? Number($('usr_edit_rubro').value) : null;
    }

    try {
      if (btn) btn.disabled = true;
      if (msg) {
        msg.textContent = 'Guardando cambios...';
        msg.className = 'msg muted';
      }

      let res;
      if (isEditing) {
        res = await apiJSON(`/api/usuarios/${encodeURIComponent(id || 0)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } else {
        res = await apiJSON('/api/usuarios', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      if (!res.ok) {
        throw new Error(res.error || res.message || 'Error al guardar usuario');
      }

      toast(isEditing ? '✓ Perfil de usuario actualizado correctamente' : '✓ Usuario creado exitosamente', true);
      closeEditUsuarioModal();
      await Promise.all([
        loadUsuariosAdmin(),
        loadSolicitudUsers(),
        loadSolicitudOficialias()
      ]);

      if (isEditing && ((id > 0 && Number(CURRENT_USER?.id) === id) || (username && norm(CURRENT_USER?.username) === norm(username)))) {
        if (res?.user) {
          CURRENT_USER = { ...CURRENT_USER, ...res.user };
        }
        await fetchUiConfig();
        applyPermassions();
      }
      if (!SOL_ID && !SOL_DRAFT_ACTIVE) {
        syncDefaultNombreFirmaFromOficialia(true);
      }
    } catch (e) {
      if (msg) {
        msg.textContent = e.message || 'Error al guardar usuario';
        msg.className = 'msg text-danger';
      }
      if (!handleAuthError(e)) toast('Error: ' + (e.message || 'Error al guardar usuario'), false);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ============================================================================
  // v42: DESCARGA DE RESPALDO DE BASE DE DATOS (BACKUP)
  // ============================================================================
  async function downloadDatabaseBackup() {
    try {
      toast('Generando respaldo completo de base de datos...', true);
      const res = await fetch('/api/backup-db', {
        credentials: 'include'
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || errJson.message || 'Error al descargar respaldo de BD');
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const nowStr = new Date().toISOString().slice(0, 10);
      const filename = match ? match[1] : `respaldo_inventario_${nowStr}.sql`;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast('✓ Respaldo de BD descargado (' + filename + ')', true);
    } catch (e) {
      if (!handleAuthError(e)) toast('Error al descargar respaldo: ' + (e.message || e), false);
    }
  }

  // ============================================================================
  // v44: BITÁCORA DE MOVIMIENTOS DEL INVENTARIO (ADMINISTRADOR)
  // ============================================================================
  function openBitacoraModal() {
    const modal = $('modal-bitacora');
    if (!modal) return;
    modal.style.display = 'flex';
    cargarBitacora();
  }

  function closeBitacoraModal() {
    const modal = $('modal-bitacora');
    if (!modal) return;
    modal.style.display = 'none';
  }

  async function cargarBitacora(q = '', fecha = '') {
    const tb = $('bitacora_tbody');
    const meta = $('bitacora_meta');
    if (!tb) return;
    tb.innerHTML = '<tr><td colspan="5" class="muted" style="text-align:center; padding:16px;">Cargando movimientos...</td></tr>';
    if (meta) meta.textContent = 'Consultando registros de auditoría...';

    try {
      let url = '/api/bitacora?limit=500';
      if (q && q.trim()) url += `&q=${encodeURIComponent(q.trim())}`;
      if (fecha && fecha.trim()) url += `&fecha=${encodeURIComponent(fecha.trim())}`;

      const res = await apiJSON(url);
      const rows = Array.isArray(res?.data) ? res.data : [];

      if (!rows.length) {
        tb.innerHTML = '<tr><td colspan="5" class="muted" style="text-align:center; padding:16px;">Sin movimientos registrados para el filtro seleccionado.</td></tr>';
        if (meta) meta.textContent = '0 movimientos encontrados';
        return;
      }

      if (meta) meta.textContent = `Mostrando ${rows.length} movimiento${rows.length === 1 ? '' : 's'} más recientes`;

      tb.innerHTML = rows.map(r => {
        const d = r.fecha ? new Date(r.fecha) : new Date();
        const fechaFmt = isNaN(d.getTime()) ? String(r.fecha || '-') : d.toLocaleString('es-MX', { timeZone: 'America/Mazatlan', hour12: false });
        const accion = safestr(r.accion).toUpperCase();
        let badgeColor = '#64748b';
        let badgeBg = '#f1f5f9';
        if (accion.includes('ALTA')) { badgeColor = '#15803d'; badgeBg = '#dcfce7'; }
        else if (accion.includes('ENTRADA')) { badgeColor = '#0369a1'; badgeBg = '#e0f2fe'; }
        else if (accion.includes('SURTIDA')) { badgeColor = '#621132'; badgeBg = '#fdf2f4'; }
        else if (accion.includes('AJUSTE')) { badgeColor = '#b45309'; badgeBg = '#fef3c7'; }

        const badgeHtml = `<span style="display:inline-block; font-size:11px; font-weight:700; padding:2px 8px; border-radius:10px; background:${badgeBg}; color:${badgeColor}; border:1px solid ${badgeColor}33;">${escHtml(accion)}</span>`;

        return `
          <tr>
            <td style="font-size:11.5px; white-space:nowrap; color:#475569;">${escHtml(fechaFmt)}</td>
            <td><b>${escHtml(safestr(r.usuario))}</b><br><span class="muted" style="font-size:11px;">${escHtml(safestr(r.nombre_usuario || ''))}</span></td>
            <td><span style="font-size:11.5px; font-weight:600; color:#334155;">${escHtml(safestr(r.modulo))}</span></td>
            <td>${badgeHtml}</td>
            <td style="font-size:12px; color:#1e293b;">${escHtml(safestr(r.detalles))}</td>
          </tr>
        `;
      }).join('');
    } catch (e) {
      tb.innerHTML = `<tr><td colspan="5" style="color:var(--danger); text-align:center; padding:16px;">Error: ${escHtml(e.message || 'Error al cargar bitácora')}</td></tr>`;
      if (meta) meta.textContent = 'Error al cargar';
      if (!handleAuthError(e)) toast(e.message || 'Error al cargar bitácora', false);
    }
  }

  // ============================================================================
  // v42: HEARTBEAT (PING + AUTO-ACTUALIZACIÓN + MONITOR DE SESIONES EN LÍNEA)
  // ============================================================================
  async function checkSystemHeartbeat() {
    try {
      await apiJSON('/api/ping', { method: 'POST' }).catch(() => {});
      const res = await apiJSON('/api/system-status').catch(() => null);
      if (res && res.version && Number(res.version) > APP_VERSION) {
        toast(`⚠️ Nueva versión del sistema disponible (v${res.version}). Actualizando...`, true);
        setTimeout(() => {
          window.location.reload(true);
        }, 1500);
        return;
      }
      if (res && res.activeUsers && Array.isArray(res.activeUsers)) {
        renderOnlineUsers(res.activeUsers);
      } else if (res && res.onlineCount !== undefined) {
        const cntEl = $('online-users-count');
        if (cntEl) cntEl.textContent = String(res.onlineCount);
      }
    } catch (_) {}
  }

  function renderOnlineUsers(users) {
    const cntEl = $('online-users-count');
    if (cntEl) cntEl.textContent = String(users.length);

    const listEl = $('online-users-list');
    if (listEl) {
      if (!users.length) {
        listEl.innerHTML = '<span class="muted">No hay usuarios activos registrados</span>';
      } else {
        listEl.innerHTML = users.map(u => {
          const ago = Math.max(0, Math.round((Date.now() - (u.lastSeen || Date.now())) / 1000));
          const agoTxt = ago < 60 ? `${ago}s` : `${Math.round(ago/60)}m`;
          return `<span style="display:inline-block; padding:3px 10px; background:#fff; border:1px solid #bae6fd; border-radius:12px; font-size:12px;">
            👤 <b>${escHtml(safestr(u.username))}</b> (${escHtml(safestr(u.rol))}) <small class="muted" style="margin-left:4px;">hace ${agoTxt}</small>
          </span>`;
        }).join(' ');
      }
    }
  }

  // ============================================================================
  // MÓDULO: VALES PROVISIONALES (Préstamo de Material/Equipo para Operativos)
  // ============================================================================

  let VP_FORM_ITEMS = [];
  let VP_CATALOGO = [];
  let VP_ACTIVE_DEVOLUCION_ID = null;

  async function loadVpCatalogo() {
    const rubroId = Number($('vp_rubro_id')?.value || 2);
    const sel = $('vp_item_select');
    const cantIn = $('vp_item_cant');
    if (cantIn) {
      if (rubroId === 4) {
        cantIn.value = 1;
        cantIn.readOnly = true;
        cantIn.disabled = true;
        cantIn.title = 'Las tabletas digitales son activos serializados únicos (cantidad fija = 1)';
      } else {
        cantIn.readOnly = false;
        cantIn.disabled = false;
        cantIn.title = '';
      }
    }
    if (!sel) return;
    sel.innerHTML = '<option value="">- Cargando artículos disponibles... -</option>';
    try {
      const res = await apiJSON(`/api/vales-prestamo/catalogo?rubro_id=${rubroId}`);
      VP_CATALOGO = (Array.isArray(res?.data) ? res.data : []).filter(it => (Number(it.cantidad_disponible ?? it.stock ?? it.existencia ?? 0) > 0) || it.disponible === true);
      if (!VP_CATALOGO.length) {
        sel.innerHTML = rubroId === 4
          ? '<option value="">- No hay tabletas en estado DISPONIBLE para préstamo provisional -</option>'
          : '<option value="">- No hay artículos con existencia disponible en este rubro -</option>';
        return;
      }
      const opts = [rubroId === 4
        ? '<option value="">- Selecciona una tableta disponible (Resguardo / IMEI / Serie) -</option>'
        : '<option value="">- Selecciona un bien o material disponible -</option>'
      ];
      VP_CATALOGO.forEach((it, idx) => {
        if (rubroId === 4 || it.es_tableta) {
          const modeloTxt = safestr(it.modelo || 'QTab LTE');
          const imeiTxt = safestr(it.imei || '-');
          const serieTxt = safestr(it.numero_serie || '-');
          opts.push(`<option value="${idx}">Resguardo #${Number(it.no_resguardo || 0)} — ${escHtml(modeloTxt)} (IMEI: ${escHtml(imeiTxt)} | Serie: ${escHtml(serieTxt)})</option>`);
        } else {
          const clavePrefix = it.clave ? `${it.clave} — ` : '';
          const serieTxt = it.serie ? ` (${it.serie})` : '';
          opts.push(`<option value="${idx}">${escHtml(`${clavePrefix}${it.descripcion ?? ''}${serieTxt}`)}</option>`);
        }
      });
      sel.innerHTML = opts.join('');
    } catch (e) {
      sel.innerHTML = '<option value="">Error al cargar catálogo</option>';
      toast('Error al cargar catálogo de préstamo: ' + e.message, false);
    }
  }

  function renderVpFormItems() {
    const tbody = $('vp_items_tbody');
    if (!tbody) return;
    if (!VP_FORM_ITEMS.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center muted" style="padding:16px;">No has agregado ningún artículo al vale provisional.</td></tr>';
      return;
    }
    tbody.innerHTML = VP_FORM_ITEMS.map((it, idx) => `
      <tr>
        <td style="text-align:center; font-weight:bold;">${idx + 1}</td>
        <td><strong>${escHtml(safestr(it.descripcion))}</strong>${it.clave ? ` <small class="muted">(${escHtml(it.clave)})</small>` : ''}</td>
        <td>${safestr(it.marca || it.modelo || it.serie) ? escHtml([it.marca, it.modelo, it.serie].filter(Boolean).join(' / ')) : '<span class="muted">N/A</span>'}</td>
        <td style="text-align:center; font-weight:bold;">${Number(it.cantidad || 0)}</td>
        <td><span class="status-badge" style="font-size:11px;">${escHtml(safestr(it.estado_salida || 'BUENO'))}</span></td>
        <td>${safestr(it.observaciones) ? escHtml(safestr(it.observaciones)) : '<span class="muted">-</span>'}</td>
        <td style="text-align:center;">
          <button type="button" class="btn-icon text-danger" title="Eliminar del vale" onclick="window.removeVpFormItem(${idx})">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </td>
      </tr>
    `).join('');
  }

  window.removeVpFormItem = function(index) {
    if (VP_FORM_ITEMS[index]) {
      VP_FORM_ITEMS.splice(index, 1);
      renderVpFormItems();
    }
  };

  function addVpItemToForm() {
    const sel = $('vp_item_select');
    const idx = sel?.value;
    if (idx === '' || idx === undefined || !VP_CATALOGO[idx]) {
      toast('Selecciona un artículo del catálogo para agregar');
      return;
    }
    const catItem = VP_CATALOGO[idx];
    const rubroId = Number($('vp_rubro_id')?.value || 1);
    const isTableta = rubroId === 4 || Boolean(catItem.es_tableta);
    const cantIn = $('vp_item_cant');
    const cant = isTableta ? 1 : Math.max(1, Number(cantIn?.value) || 1);
    const dispStock = Number(catItem.cantidad_disponible ?? catItem.stock ?? 0);

    if (isTableta) {
      const dupTab = VP_FORM_ITEMS.find(x => Number(x.tableta_id || x.articulo_id) === Number(catItem.tableta_id || catItem.id));
      if (dupTab) {
        toast(`La tableta con Resguardo #${catItem.no_resguardo} ya fue agregada a este vale provisional.`, false);
        return;
      }
    }

    const existingItem = isTableta ? null : VP_FORM_ITEMS.find(x => Number(x.articulo_id) === Number(catItem.id));
    const alreadyInForm = existingItem ? Number(existingItem.cantidad || 0) : 0;

    if (alreadyInForm + cant > dispStock) {
      toast(`La cantidad solicitada (${alreadyInForm + cant}) supera la disponibilidad actual (${dispStock}).`, false);
      return;
    }

    const serieIn = $('vp_item_serie');
    const estadoIn = $('vp_item_estado');
    const obsIn = $('vp_item_obs');

    if (existingItem) {
      existingItem.cantidad = alreadyInForm + cant;
      if (obsIn?.value?.trim()) {
        existingItem.observaciones = existingItem.observaciones
          ? `${existingItem.observaciones} | ${obsIn.value.trim()}`
          : obsIn.value.trim();
      }
    } else {
      const itemToAdd = {
        articulo_id: isTableta ? null : catItem.id,
        tableta_id: isTableta ? Number(catItem.tableta_id || catItem.id) : null,
        id: catItem.id,
        es_tableta: isTableta,
        no_resguardo: catItem.no_resguardo || null,
        imei: catItem.imei || null,
        numero_serie: catItem.numero_serie || null,
        clave: catItem.clave || null,
        clave_bien: catItem.clave || null,
        descripcion: catItem.descripcion,
        marca: catItem.marca || null,
        modelo: catItem.modelo || null,
        color: catItem.color || null,
        serie: isTableta ? (catItem.serie || null) : ((serieIn?.value?.trim()) || catItem.serie || null),
        cantidad: cant,
        estado_salida: estadoIn?.value || 'BUEN ESTADO',
        observaciones: obsIn?.value?.trim() || null
      };
      VP_FORM_ITEMS.push(itemToAdd);
    }

    renderVpFormItems();

    if (cantIn) cantIn.value = 1;
    if (serieIn) serieIn.value = '';
    if (obsIn) obsIn.value = '';
    if (sel) sel.value = '';
    toast('✓ Artículo agregado al vale', true);
  }

  async function submitVpForm() {
    const msg = $('vp_form_msg');
    const rubroId = Number($('vp_rubro_id')?.value || 0);
    const deptoId = Number($('vp_departamento_id')?.value || 0);
    const solicitanteNombre = safestr($('vp_solicitante_nombre')?.value);
    const solicitanteCargo = safestr($('vp_solicitante_cargo')?.value);
    const solicitanteTelefono = safestr($('vp_solicitante_telefono')?.value);
    const operativoNombre = safestr($('vp_operativo_nombre')?.value);
    const lugarComision = safestr($('vp_lugar_comision')?.value);
    const fechaSalida = safestr($('vp_fecha_salida')?.value);
    const fechaDevolucionEstimada = safestr($('vp_fecha_devolucion_estimada')?.value);
    const observacionesPrestamo = safestr($('vp_obs_prestamo')?.value);
    const modSelect = getTipoValeSelect();
    const modVal = safestr(modSelect?.value || '2_FIRMAS');
    const allowed4 = canUserUseCuatroFirmas();
    const es4Firmas = allowed4 && (modVal === '4_FIRMAS' || modVal === '1');
    const tipoFirmas = es4Firmas ? 4 : 2;
    const deptoOption = $('vp_departamento_id')?.selectedOptions?.[0];
    const deptoNombre = deptoOption ? deptoOption.textContent.trim() : '';

    let recibeNombre = safestr($('vale-recibe-nombre')?.value);
    let recibeCargo = safestr($('vale-recibe-cargo')?.value);

    if (!es4Firmas) {
      recibeNombre = solicitanteNombre;
      recibeCargo = solicitanteCargo || deptoNombre;
      if ($('vale-recibe-nombre')) $('vale-recibe-nombre').value = recibeNombre;
      if ($('vale-recibe-cargo')) $('vale-recibe-cargo').value = recibeCargo;
    } else {
      if (!recibeNombre) {
        toast('Ingresa el nombre de quien recibe para la modalidad de 4 Firmas');
        $('vale-recibe-nombre')?.focus();
        return;
      }
      if (!recibeCargo) {
        toast('Ingresa el cargo o departamento de quien recibe para la modalidad de 4 Firmas');
        $('vale-recibe-cargo')?.focus();
        return;
      }
    }

    if (!rubroId) { toast('Selecciona el rubro'); return; }
    if (!solicitanteNombre) { toast('Ingresa el nombre del solicitante'); $('vp_solicitante_nombre')?.focus(); return; }
    if (!operativoNombre) { toast('Ingresa el nombre del operativo o comisión'); $('vp_operativo_nombre')?.focus(); return; }
    if (!lugarComision) { toast('Ingresa el lugar de comisión'); $('vp_lugar_comision')?.focus(); return; }
    if (!fechaSalida) { toast('Selecciona la fecha de salida'); $('vp_fecha_salida')?.focus(); return; }

    const todayLocal = getTodayLocalISO();
    if (fechaSalida < todayLocal) {
      toast('La fecha de salida no puede ser anterior al día de hoy', false);
      $('vp_fecha_salida')?.focus();
      return;
    }

    let finalFechaDev = null;
    let esIndefinido = 0;

    if (es4Firmas) {
      // 4 FIRMAS (Regional/Especial): Fecha opcional; si se omite, es por tiempo indefinido
      if (fechaDevolucionEstimada) {
        if (fechaDevolucionEstimada < fechaSalida) {
          toast('La fecha estimada de devolución no puede ser anterior a la fecha de salida', false);
          $('vp_fecha_devolucion_estimada')?.focus();
          return;
        }
        finalFechaDev = fechaDevolucionEstimada;
        esIndefinido = 0;
      } else {
        finalFechaDev = null;
        esIndefinido = 1;
      }
    } else {
      // 2 FIRMAS (Delegación): Fecha obligatoria
      if (!fechaDevolucionEstimada) {
        toast('Selecciona la fecha estimada de devolución para la modalidad de 2 Firmas');
        $('vp_fecha_devolucion_estimada')?.focus();
        return;
      }
      if (fechaDevolucionEstimada < fechaSalida) {
        toast('La fecha estimada de devolución no puede ser anterior a la fecha de salida', false);
        $('vp_fecha_devolucion_estimada')?.focus();
        return;
      }
      finalFechaDev = fechaDevolucionEstimada;
      esIndefinido = 0;
    }

    if (!VP_FORM_ITEMS.length) { toast('Agrega al menos un artículo o bien al vale'); return; }

    const payload = {
      rubro_id: rubroId,
      departamento_id: deptoId,
      departamento_nombre: deptoNombre,
      solicitante_nombre: solicitanteNombre,
      solicitante_cargo: solicitanteCargo,
      solicitante_telefono: solicitanteTelefono,
      nombre_solicitante: solicitanteNombre,
      cargo_solicitante: solicitanteCargo,
      operativo_nombre: operativoNombre,
      lugar_comision: lugarComision,
      fecha_salida: fechaSalida,
      fecha_devolucion_estimada: finalFechaDev,
      tipo_firmas: tipoFirmas,
      es_indefinido: esIndefinido,
      recibe_nombre: recibeNombre,
      recibe_cargo: recibeCargo,
      nombre_recibe: recibeNombre,
      cargo_recibe: recibeCargo,
      observaciones_prestamo: observacionesPrestamo,
      items: VP_FORM_ITEMS
    };

    if (msg) msg.textContent = 'Guardando vale provisional...';
    try {
      const res = await apiJSON('/api/vales-prestamo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(res.error || 'Error al guardar vale provisional');

      toast(`✓ Vale Provisional ${res.folio} creado exitosamente`, true);

      VP_FORM_ITEMS = [];
      renderVpFormItems();
      if ($('vp_operativo_nombre')) $('vp_operativo_nombre').value = '';
      if ($('vp_lugar_comision')) $('vp_lugar_comision').value = '';
      if ($('vp_obs_prestamo')) $('vp_obs_prestamo').value = '';
      if ($('vale-recibe-nombre')) $('vale-recibe-nombre').value = '';
      if ($('vale-recibe-cargo')) $('vale-recibe-cargo').value = '';
      if ($('vale-recibe-preset')) $('vale-recibe-preset').value = '';
      const selModalidad = getTipoValeSelect();
      if (selModalidad) {
        selModalidad.value = '2_FIRMAS';
        syncVpMinDates();
        syncVpQuienRecibeVisibility();
      }
      if (msg) msg.textContent = '';

      window.open(`/api/vales-prestamo/${res.id}/pdf`, '_blank');
      showView('vales_prestamo');
    } catch (e) {
      if (msg) msg.textContent = e.message;
      toast('Error: ' + e.message, false);
    }
  }

  async function loadValesProvisionales() {
    const tbody = $('vp_main_tbody');
    const msg = $('vp_main_msg');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="10" class="text-center muted" style="padding:24px;">Cargando vales provisionales...</td></tr>';
    if (msg) msg.textContent = '';

    const q = safestr($('vp_filter_q')?.value);
    const estado = safestr($('vp_filter_estado')?.value || 'TODOS');
    const rubroId = Number($('vp_filter_rubro')?.value || 0);
    const deptoId = Number($('vp_filter_depto')?.value || 0);
    const firmasFilter = safestr($('vp_filter_firmas')?.value || 'TODOS');

    const params = new URLSearchParams();
    if (estado && estado !== 'TODOS') params.set('estado', estado);
    if (rubroId > 0) params.set('rubro_id', String(rubroId));
    if (deptoId > 0) params.set('departamento_id', String(deptoId));
    if (firmasFilter && firmasFilter !== 'TODOS') params.set('tipo_firmas', firmasFilter);

    try {
      const res = await apiJSON(`/api/vales-prestamo?${params}`);
      let rows = Array.isArray(res?.data) ? res.data : [];

      if (q) {
        const qUpper = q.toUpperCase();
        rows = rows.filter(r =>
          String(r.folio || '').toUpperCase().includes(qUpper) ||
          String(r.solicitante_nombre || '').toUpperCase().includes(qUpper) ||
          String(r.recibe_nombre || '').toUpperCase().includes(qUpper) ||
          String(r.operativo_nombre || '').toUpperCase().includes(qUpper) ||
          String(r.lugar_comision || '').toUpperCase().includes(qUpper)
        );
      }

      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="10" class="text-center muted" style="padding:32px;">No se encontraron vales provisionales con los filtros seleccionados.</td></tr>';
        return;
      }

      const todayStr = getTodayLocalISO();
      const p = uiPerms();
      const currentRubro = getAssignedRubroId();

      tbody.innerHTML = rows.map(r => {
        const est = String(r.estado || 'SOLICITADO').toUpperCase();
        const tipoFirmasNum = Number(r.tipo_firmas) === 4 ? 4 : 2;
        const esIndef = Boolean(r.es_indefinido === 1 || r.es_indefinido === true || r.es_indefinido === '1' || (!r.fecha_devolucion_estimada && tipoFirmasNum === 4));
        let estBadge = '';
        let isVencido = false;

        if (est === 'SOLICITADO') {
          estBadge = '<span class="status-badge status-pendiente">SOLICITADO</span>';
        } else if (est === 'AUTORIZADO_EN_PRESTAMO') {
          const fDev = r.fecha_devolucion_estimada ? String(r.fecha_devolucion_estimada).slice(0, 10) : '';
          isVencido = !esIndef && Boolean(fDev && fDev < todayStr);
          estBadge = `<span class="status-badge status-prestamo">EN PRÉSTAMO</span>${isVencido ? '<span class="badge-vencido" title="Fecha de devolución rebasada">⚠️ VENCIDO</span>' : ''}`;
        } else if (est === 'DEVUELTO') {
          estBadge = '<span class="status-badge status-surtida">DEVUELTO</span>';
        } else if (est === 'CANCELADO') {
          estBadge = '<span class="status-badge status-cancelada">CANCELADO</span>';
        }

        const tipoValeBadge = tipoFirmasNum === 4
          ? '<span class="status-badge" style="background:#f3e8ff; color:#6b21a8; border:1px solid #d8b4fe; font-size:11px; font-weight:700;">4 FIRMAS (Regional)</span>'
          : '<span class="status-badge" style="background:#e0f2fe; color:#0369a1; border:1px solid #bae6fd; font-size:11px; font-weight:700;">2 FIRMAS (Delegación)</span>';

        let fechaDevCell = '';
        if (est === 'DEVUELTO') {
          const fDevReal = r.fecha_devolucion_real ? formatDate(r.fecha_devolucion_real) : (r.fecha_devolucion_estimada ? formatDate(r.fecha_devolucion_estimada) : 'REGISTRADA');
          fechaDevCell = `<div><span style="font-size:11px; color:#15803d; font-weight:bold;">Devuelto el:</span><br><strong>✓ ${fDevReal}</strong></div>`;
        } else if (esIndef) {
          fechaDevCell = '<span class="status-badge" style="background:#e0e7ff; color:#3730a3; font-size:11px; font-weight:600;">TIEMPO INDEFINIDO</span>';
        } else {
          fechaDevCell = formatDate(r.fecha_devolucion_estimada);
        }

        const canManageThisVale = Boolean(p.admin || (currentRubro && Number(currentRubro) === Number(r.rubro_id)) || (Number(r.rubro_id) === 1 && p.puedeAccederAlmacen));
        const isOwner = Number(r.usuario_id) === Number(CURRENT_USER?.id);

        let actionBtns = [];
        actionBtns.push(`<button type="button" class="btn-secondary mini" title="Descargar Vale Oficial en PDF" onclick="window.open('/api/vales-prestamo/${r.id}/pdf', '_blank')">📄 PDF</button>`);

        if (r.archivo_pdf_firmado) {
          actionBtns.push(`<a class="btn-primary mini" style="background:#0f766e; border-color:#0f766e; text-decoration:none;" href="/api/vales-prestamo/${r.id}/pdf-firmado" target="_blank" title="Ver documento PDF con firmas autógrafas">📎 Ver PDF Firmado</a>`);
        } else if (est === 'DEVUELTO' && canManageThisVale) {
          actionBtns.push(`<button type="button" class="btn-secondary mini" title="Subir PDF escaneado con firmas" onclick="window.subirPdfFirmadoValePrompt(${r.id})">📎 Subir PDF Firmado</button>`);
        }

        if (est === 'SOLICITADO') {
          if (canManageThisVale) {
            actionBtns.push(`<button type="button" class="btn-primary mini" style="background:#1d4ed8; border-color:#1d4ed8;" onclick="window.autorizarValeProvisional(${Number(r.id)}, '${escHtml(r.folio)}')">✓ Autorizar</button>`);
          }
          if (canManageThisVale || isOwner) {
            actionBtns.push(`<button type="button" class="btn-secondary mini text-danger" onclick="window.cancelarValeProvisional(${Number(r.id)}, '${escHtml(r.folio)}')">✕ Cancelar</button>`);
          }
        } else if (est === 'AUTORIZADO_EN_PRESTAMO') {
          if (canManageThisVale) {
            actionBtns.push(`<button type="button" class="btn-primary mini" style="background:#15803d; border-color:#15803d;" onclick="window.openDevolucionValeModal(${Number(r.id)})">📥 Registrar Devolución / Finalizar</button>`);
          }
        }

        return `
          <tr>
            <td><strong>${escHtml(safestr(r.folio))}</strong>${renderPruebaBadge(r.es_prueba)}</td>
            <td><span class="status-badge" style="font-size:11px;">${escHtml(safestr(r.nombre_rubro || `Rubro ${r.rubro_id}`))}</span></td>
            <td>${tipoValeBadge}</td>
            <td>${escHtml(safestr(r.oficialia_nombre || r.departamento_nombre))}</td>
            <td><strong>${escHtml(safestr(r.operativo_nombre))}</strong><br><small class="muted">📍 ${escHtml(safestr(r.lugar_comision))}</small></td>
            <td>${escHtml(safestr(r.solicitante_nombre))}<br><small class="muted">Recibe: ${escHtml(safestr(r.recibe_nombre || r.solicitante_nombre))}</small></td>
            <td>${escHtml(formatDate(r.fecha_salida))}</td>
            <td>${fechaDevCell}</td>
            <td>${estBadge}</td>
            <td style="text-align:center;">
              <div style="display:inline-flex; gap:6px; flex-wrap:wrap; justify-content:center;">
                ${actionBtns.join('')}
              </div>
            </td>
          </tr>
        `;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="10" class="text-center text-danger" style="padding:24px;">Error al cargar vales: ${escHtml(e.message)}</td></tr>`;
    }
  }

  window.autorizarValeProvisional = async function(id, folio) {
    const ok = confirm(`¿Confirmas la autorización y entrega del Vale Provisional ${folio}?\nSe descontará el stock correspondiente del inventario.`);
    if (!ok) return;
    try {
      const res = await apiJSON(`/api/vales-prestamo/${id}/autorizar`, { method: 'POST' });
      if (!res.ok) throw new Error(res.error || 'Error al autorizar vale');
      toast(`✓ Vale Provisional ${folio} autorizado y entregado`, true);
      loadValesProvisionales();
    } catch (e) {
      toast('Error: ' + e.message, false);
    }
  };

  window.cancelarValeProvisional = async function(id, folio) {
    const ok = confirm(`¿Deseas cancelar el Vale Provisional ${folio}?`);
    if (!ok) return;
    try {
      const res = await apiJSON(`/api/vales-prestamo/${id}/cancelar`, { method: 'POST' });
      if (!res.ok) throw new Error(res.error || 'Error al cancelar vale');
      toast(`Vale Provisional ${folio} cancelado`, true);
      loadValesProvisionales();
    } catch (e) {
      toast('Error: ' + e.message, false);
    }
  };

  window.openDevolucionValeModal = async function(id) {
    VP_ACTIVE_DEVOLUCION_ID = id;
    const modal = $('modal-devolucion-vale');
    const infoBox = $('vp_dev_info_box');
    const badge = $('vp_dev_folio_badge');
    const tbody = $('vp_dev_items_tbody');
    const msg = $('vp_dev_msg');
    const obsGen = $('vp_dev_obs_general');
    const devFechaRealIn = $('vp_dev_fecha_real');

    if (msg) msg.textContent = '';
    if (obsGen) obsGen.value = '';
    if (devFechaRealIn) devFechaRealIn.value = getTodayLocalISO();
    const pdfIn = $('vp_dev_pdf_firmado');
    if (pdfIn) pdfIn.value = '';
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-center muted">Cargando detalles...</td></tr>';
    if (modal) modal.classList.remove('hidden');

    try {
      const res = await apiJSON(`/api/vales-prestamo/${id}`);
      if (!res.ok) throw new Error(res.error || 'Error al consultar vale');
      const vale = res.data;

      if (badge) badge.textContent = `${vale.folio} — ${vale.nombre_rubro || ''}`;
      if (infoBox) {
        const esIndef = Boolean(vale.es_indefinido === 1 || vale.es_indefinido === true || !vale.fecha_devolucion_estimada);
        const tipoFirmasTxt = Number(vale.tipo_firmas) === 4 ? '4 Firmas (Regional / Especial)' : '2 Firmas (Delegación)';
        infoBox.innerHTML = `
          <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px;">
            <div><strong>Solicitante:</strong> ${escHtml(safestr(vale.solicitante_nombre))} (${escHtml(safestr(vale.solicitante_cargo || 'N/A'))})</div>
            <div><strong>Área:</strong> ${escHtml(safestr(vale.oficialia_nombre || vale.departamento_nombre))}</div>
            <div><strong>Operativo:</strong> ${escHtml(safestr(vale.operativo_nombre))} — 📍 ${escHtml(safestr(vale.lugar_comision))}</div>
            <div><strong>Modalidad:</strong> ${escHtml(tipoFirmasTxt)}</div>
            <div><strong>Fecha Límite Estimada:</strong> ${esIndef ? '<span style="color:#4338ca; font-weight:bold;">TIEMPO INDEFINIDO</span>' : escHtml(formatDate(vale.fecha_devolucion_estimada))}</div>
          </div>
        `;
      }

      const items = Array.isArray(vale.detalles) ? vale.detalles : [];
      if (tbody) {
        tbody.innerHTML = items.map(it => `
          <tr data-det-id="${escHtml(it.id)}">
            <td>
              <strong>${escHtml(safestr(it.descripcion))}</strong>
              ${it.serie ? `<br><small class="muted">S/N: ${escHtml(it.serie)}</small>` : ''}
              ${it.marca || it.modelo ? `<br><small class="muted">${escHtml([it.marca, it.modelo].filter(Boolean).join(' '))}</small>` : ''}
            </td>
            <td style="text-align:center; font-weight:bold;">${Number(it.cantidad || 0)}</td>
            <td>
              <select class="vp_item_dev_estado" style="width:100%; font-size:12px;">
                <option value="BUEN ESTADO">BUEN ESTADO</option>
                <option value="REGULAR">REGULAR</option>
                <option value="CON DAÑOS">CON DAÑOS</option>
                <option value="NO DEVUELTO">NO DEVUELTO / FALTANTE</option>
              </select>
            </td>
            <td>
              <input class="vp_item_dev_obs" placeholder="Observaciones de recepción..." style="width:100%; font-size:12px;" value="${escHtml(safestr(it.observaciones || ''))}">
            </td>
          </tr>
        `).join('');
      }
    } catch (e) {
      if (msg) msg.textContent = 'Error: ' + e.message;
      toast('Error al consultar vale: ' + e.message, false);
    }
  };

  async function submitDevolucionVale() {
    if (!VP_ACTIVE_DEVOLUCION_ID) return;
    const msg = $('vp_dev_msg');
    const tbody = $('vp_dev_items_tbody');
    const rows = tbody ? Array.from(tbody.querySelectorAll('tr[data-det-id]')) : [];
    const fechaReal = $('vp_dev_fecha_real')?.value || getTodayLocalISO();

    const items = rows.map(tr => {
      const id = Number(tr.getAttribute('data-det-id'));
      const estado = tr.querySelector('.vp_item_dev_estado')?.value || 'BUEN ESTADO';
      const obs = tr.querySelector('.vp_item_dev_obs')?.value?.trim() || null;
      return { id, estado_devolucion: estado, observaciones: obs };
    });

    const obsGen = $('vp_dev_obs_general')?.value?.trim() || null;

    let pdfBase64 = null;
    const fileIn = $('vp_dev_pdf_firmado');
    if (fileIn && fileIn.files && fileIn.files[0]) {
      const file = fileIn.files[0];
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        toast('El archivo adjunto debe ser en formato PDF', false);
        if (msg) msg.textContent = 'El archivo adjunto debe ser en formato PDF';
        return;
      }
      try {
        pdfBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      } catch (fErr) {
        toast('Error al leer el archivo PDF: ' + fErr.message, false);
        return;
      }
    }

    if (msg) msg.textContent = 'Registrando devolución e ingresando inventario...';

    try {
      const res = await apiJSON(`/api/vales-prestamo/${VP_ACTIVE_DEVOLUCION_ID}/devolver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          fecha_devolucion_real: fechaReal,
          observaciones_devolucion: obsGen,
          pdf_base64: pdfBase64
        })
      });
      if (!res.ok) throw new Error(res.error || 'Error al registrar devolución');

      toast('✓ Devolución registrada e inventario reincorporado exitosamente', true);
      $('modal-devolucion-vale')?.classList.add('hidden');
      VP_ACTIVE_DEVOLUCION_ID = null;
      loadValesProvisionales();
    } catch (e) {
      if (msg) msg.textContent = e.message;
      toast('Error: ' + e.message, false);
    }
  }

  window.subirPdfFirmadoValePrompt = function(id) {
    let inp = $('vp_upload_pdf_input');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.id = 'vp_upload_pdf_input';
      inp.accept = 'application/pdf';
      inp.style.display = 'none';
      document.body.appendChild(inp);
    }
    inp.value = '';
    inp.onchange = async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        toast('El archivo seleccionado debe ser en formato PDF', false);
        return;
      }
      try {
        toast('Subiendo y respaldando PDF firmado...', true);
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const base64 = reader.result;
            const res = await apiJSON(`/api/vales-prestamo/${id}/subir-pdf-firmado`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pdf_base64: base64 })
            });
            if (!res.ok) throw new Error(res.error || 'Error al subir PDF firmado');
            toast('✓ PDF firmado subido y respaldado exitosamente', true);
            loadValesProvisionales();
          } catch (err) {
            toast('Error: ' + err.message, false);
          }
        };
        reader.readAsDataURL(file);
      } catch (err) {
        toast('Error al leer archivo: ' + err.message, false);
      }
    };
    inp.click();
  };

  // =========================================================================
  // FUNCIÓN DE MIGRACIÓN MASIVA: PARQUE VEHICULAR (Evelia - 24 Vehículos)
  // =========================================================================
  window.cargarVehiculosEvelia = async function() {
    const data = [
      { marca: "MG 5", descripcion: "MG 5", color: "BLANCO YORK", serie: "LSJA36E91PZ039626", placas: "DAH 99-46", municipio: "LOS CABOS", observaciones: "Municipio referencia: LOS CABOS", modelo: "2023" },
      { marca: "MG 5", descripcion: "MG 5", color: "GRIS OXFORD", serie: "LSJA36E91PZ040095", placas: "DAH 99-35", municipio: "LA PAZ", observaciones: "Municipio referencia: LA PAZ", modelo: "2023" },
      { marca: "MG 5", descripcion: "MG 5", color: "NEGRO BRILLANTE", serie: "LSJA36E9XPZ040290", placas: "DAH 99-43", municipio: "MULEGÉ", observaciones: "Municipio referencia: MULEGÉ", modelo: "2023" },
      { marca: "MG 5", descripcion: "MG 5", color: "ROJO MANCHESTER", serie: "LSJA36E94PZ045355", placas: "DAH 99-36", municipio: "LA PAZ", observaciones: "Municipio referencia: LA PAZ", modelo: "2023" },
      { marca: "MG 5", descripcion: "MG 5", color: "ROJO MANCHESTER", serie: "LSJA36E9XPZ044193", placas: "DAH 99-41", municipio: "COMONDU", observaciones: "Municipio referencia: COMONDU", modelo: "2023" },
      { marca: "MG 5", descripcion: "MG 5", color: "ROJO MANCHESTER", serie: "LSJA36E95PZ045493", placas: "DAH 99-38", municipio: "LOS CABOS", observaciones: "Municipio referencia: LOS CABOS", modelo: "2023" },
      { marca: "RAM 4x4", descripcion: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDTXNG407364", placas: "CF-54-460", municipio: "COMONDU", observaciones: "Municipio referencia: COMONDU", modelo: "2022" },
      { marca: "RAM 4x4", descripcion: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDT3NG414236", placas: "CF-54-400", municipio: "MULEGE", observaciones: "Municipio referencia: MULEGE", modelo: "2022" },
      { marca: "RAM 4x4", descripcion: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDTXNG407039", placas: "CF-54-459", municipio: "LA PAZ", observaciones: "Municipio referencia: LA PAZ", modelo: "2022" },
      { marca: "RAM 4x4", descripcion: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDT7NG407192", placas: "CF-54-398", municipio: "LA PAZ", observaciones: "Municipio referencia: LA PAZ", modelo: "2022" },
      { marca: "TOYOTA HILUX", descripcion: "TOYOTA HILUX", color: "BLANCO", serie: "MR0CX3DD3N1332900", placas: "CF-54-479", municipio: "COMONDU", observaciones: "Municipio referencia: COMONDU", modelo: "2022" },
      { marca: "TOYOTA HILUX", descripcion: "TOYOTA HILUX", color: "BLANCO", serie: "MR0CX3DD0N1333065", placas: "CF-54-435", municipio: "MULEGE", observaciones: "Municipio referencia: MULEGE", modelo: "2022" },
      { marca: "RAM SENCILLA", descripcion: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT7NG430370", placas: "CF-54-483", municipio: "LA PAZ", observaciones: "Municipio referencia: LA PAZ", modelo: "2022" },
      { marca: "RAM SENCILLA", descripcion: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT4NG413641", placas: "CF-54-471", municipio: "COMONDU", observaciones: "Municipio referencia: COMONDU", modelo: "2022" },
      { marca: "RAM SENCILLA", descripcion: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT9NG425736", placas: "CF-54-490", municipio: "LA PAZ", observaciones: "Municipio referencia: LA PAZ", modelo: "2022" },
      { marca: "RAM SENCILLA", descripcion: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT4NG413574", placas: "CF-54-465", municipio: "LA PAZ", observaciones: "Municipio referencia: LA PAZ", modelo: "2022" },
      { marca: "RAM SENCILLA", descripcion: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT7NG430322", placas: "CF-54-484", municipio: "LA PAZ", observaciones: "Municipio referencia: LA PAZ", modelo: "2022" },
      { marca: "RAM SENCILLA", descripcion: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT7NG430255", placas: "CF-54-488", municipio: "LOS CABOS", observaciones: "Municipio referencia: LOS CABOS", modelo: "2022" },
      { marca: "RAM SENCILLA", descripcion: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT4NG406740", placas: "CF-54-487", municipio: "MULEGE", observaciones: "Municipio referencia: MULEGE", modelo: "2022" },
      { marca: "RAM SENCILLA", descripcion: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT8NG406675", placas: "CF-54-492", municipio: "LOS CABOS", observaciones: "Municipio referencia: LOS CABOS", modelo: "2022" },
      { marca: "RAM SENCILLA", descripcion: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT5NG406620", placas: "CF-54-485", municipio: "LOS CABOS", observaciones: "Municipio referencia: LOS CABOS", modelo: "2022" },
      { marca: "URVAN", descripcion: "URVAN", color: "BLANCO", serie: "JN1BE6DS5P9081403", placas: "DAH 99-23", municipio: "LA PAZ", observaciones: "Municipio referencia: LA PAZ", modelo: "2023" },
      { marca: "FRONTIER", descripcion: "FRONTIER", color: "BLANCO", serie: "3N6AD33A4PK828180", placas: "CF-61-040", municipio: "LOS CABOS", observaciones: "Municipio referencia: LOS CABOS", modelo: "2023" },
      { marca: "FRONTIER", descripcion: "FRONTIER", color: "BLANCO", serie: "3N6AD33A6PK828150", placas: "CF-61-042", municipio: "COMONDU", observaciones: "Municipio referencia: COMONDU", modelo: "2023" }
    ];

    try {
      const response = await fetch('/api/migracion/vehiculos', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || 'Error al migrar vehículos');
      }
      toast(result.message || `✓ ${result.total_insertados} vehículos migrados correctamente`, true);
      alert(result.message || `Migración exitosa: ${result.total_insertados} vehículos cargados.`);
      if (typeof loadRegionalFilters === 'function') await loadRegionalFilters(true);
      if (typeof renderRegionalInventory === 'function') await renderRegionalInventory();
      return result;
    } catch (err) {
      toast('Error en migración: ' + err.message, false);
      alert('Error en migración: ' + err.message);
      throw err;
    }
  };

  // =========================================================================
  // FUNCIÓN DE LIMPIEZA DE INVENTARIO: ARCHIVO Y MATERIALES (Gabriel Fiol)
  // =========================================================================
  window.limpiarInventarioFiol = async function() {
    const confirmar = confirm('¿Estás seguro de que deseas ELIMINAR TODO el inventario de Archivo y Materiales (Gabriel Fiol)?');
    if (!confirmar) return;

    try {
      const response = await fetch('/api/migracion/limpiar-fiol', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || 'Error al limpiar el inventario de Archivo y Materiales');
      }
      alert(result.message || 'Inventario de Archivo y Materiales eliminado correctamente.');
      window.location.reload();
      return result;
    } catch (err) {
      toast('Error al limpiar inventario: ' + err.message, false);
      alert('Error al limpiar inventario: ' + err.message);
      throw err;
    }
  };

  // =========================================================================
  // FUNCIÓN DE MIGRACIÓN: ARCHIVO Y MATERIALES (Gabriel Fiol - 108 Artículos)
  // =========================================================================
  window.cargarInventarioFiol = async function() {
    if (!confirm('¿Reemplazar el inventario de Archivo y Materiales (Gabriel Fiol) con los 108 artículos oficiales?')) return;

    const materialesFiol = [
      // MATERIAL DE OFICINA
      { descripcion: "Folder Manila Tamaño Carta", categoria: "Material de Oficina", stock: 950, unidad: "Piezas" },
      { descripcion: "Folder Manila Tamaño Oficio", categoria: "Material de Oficina", stock: 250, unidad: "Piezas" },
      { descripcion: "Sobre Manila Tamaño Oficio", categoria: "Material de Oficina", stock: 50, unidad: "Piezas" },
      { descripcion: "Sobre Manila Tamaño Radiografia", categoria: "Material de Oficina", stock: 400, unidad: "Piezas" },
      { descripcion: "Sobre Manila Tamaño Esquela", categoria: "Material de Oficina", stock: 600, unidad: "Piezas" },
      { descripcion: "Sobre BCO Tamaño Carta", categoria: "Material de Oficina", stock: 200, unidad: "Piezas" },
      { descripcion: "Sobre BCO Tamaño Oficio", categoria: "Material de Oficina", stock: 200, unidad: "Piezas" },
      { descripcion: "Tarjeta BCA 3x5 con 100 pzas", categoria: "Material de Oficina", stock: 12, unidad: "Paquete" },
      { descripcion: "Tarjeta BCA 4x6 con 100 pzas", categoria: "Material de Oficina", stock: 5, unidad: "Paquete" },
      { descripcion: "Tarjeta BCA 20x13 con 100 pzas", categoria: "Material de Oficina", stock: 9, unidad: "Paquete" },
      { descripcion: "Papel Fino para Artes Graficas", categoria: "Material de Oficina", stock: 2, unidad: "Paquete" },
      { descripcion: "Block Tamaño Carta a Rayas", categoria: "Material de Oficina", stock: 17, unidad: "Piezas" },
      { descripcion: "Guillotina 35x30", categoria: "Material de Oficina", stock: 1, unidad: "Piezas" },
      { descripcion: "Folders Azul cada Broche de 8cms", categoria: "Material de Oficina", stock: 100, unidad: "Piezas" },
      { descripcion: "Carpeta Azul cada Broche de Presion", categoria: "Material de Oficina", stock: 82, unidad: "Piezas" },
      { descripcion: "Tabla cada Broche para Anotaciones", categoria: "Material de Oficina", stock: 58, unidad: "Piezas" },
      { descripcion: "Hojas tamaño Carta Azul con 100 pzas", categoria: "Material de Oficina", stock: 12, unidad: "Paquete" },
      { descripcion: "Hojas tamaño Carta Rosa con 100 pzas", categoria: "Material de Oficina", stock: 15, unidad: "Paquete" },
      { descripcion: "Hojas tamaño Carta Amarilla con 100 pzas", categoria: "Material de Oficina", stock: 22, unidad: "Paquete" },
      { descripcion: "Papel Opalina Tamaño Carta con 100 pzas", categoria: "Material de Oficina", stock: 31, unidad: "Paquete" },
      { descripcion: "Papel Opalina Doble Carta con 100 pzas", categoria: "Material de Oficina", stock: 3, unidad: "Paquete" },
      { descripcion: "Perforadora de 3 Orificios", categoria: "Material de Oficina", stock: 13, unidad: "Piezas" },
      { descripcion: "Carpeta Blanca 3 Argollas 10 cms", categoria: "Material de Oficina", stock: 22, unidad: "Piezas" },
      { descripcion: "Carpeta Blanca 3 Argollas 12 cms", categoria: "Material de Oficina", stock: 12, unidad: "Piezas" },
      { descripcion: "Carpeta Blanca 3 Argollas 4 cms", categoria: "Material de Oficina", stock: 24, unidad: "Piezas" },
      { descripcion: "Carpeta Blanca 3 Argollas 8 cms", categoria: "Material de Oficina", stock: 22, unidad: "Piezas" },
      { descripcion: "Carpeta Blanca 3 Argollas 3 cms", categoria: "Material de Oficina", stock: 3, unidad: "Piezas" },
      { descripcion: "Carpeta Blanca 3 Argollas 5 cms", categoria: "Material de Oficina", stock: 15, unidad: "Piezas" },
      { descripcion: "Foliador", categoria: "Material de Oficina", stock: 11, unidad: "Piezas" },
      { descripcion: "Hojas Blancas Tamaño Oficio", categoria: "Material de Oficina", stock: 4, unidad: "Paquete" },
      { descripcion: "Quitagrapas", categoria: "Material de Oficina", stock: 29, unidad: "Piezas" },
      { descripcion: "Tijeras", categoria: "Material de Oficina", stock: 5, unidad: "Piezas" },
      { descripcion: "Regla de 30 cms Plastico", categoria: "Material de Oficina", stock: 65, unidad: "Piezas" },
      { descripcion: "Regla de 30 cms Metalica", categoria: "Material de Oficina", stock: 9, unidad: "Piezas" },
      { descripcion: "Cinta Adhesiva Chica Transparente", categoria: "Material de Oficina", stock: 137, unidad: "Rollos" },
      { descripcion: "Perforadora de un Orificio", categoria: "Material de Oficina", stock: 5, unidad: "Piezas" },
      { descripcion: "Tinta para Cojin de Sellos", categoria: "Material de Oficina", stock: 12, unidad: "Tubos" },
      { descripcion: "Engrapadoras", categoria: "Material de Oficina", stock: 22, unidad: "Piezas" },
      { descripcion: "Perforadora de 8 cms", categoria: "Material de Oficina", stock: 2, unidad: "Piezas" },
      { descripcion: "Pluma Bic Color Azul", categoria: "Material de Oficina", stock: 123, unidad: "Piezas" },
      { descripcion: "Pluma Tinta Gel 0.7mm Azul", categoria: "Material de Oficina", stock: 21, unidad: "Piezas" },
      { descripcion: "Pluma Bolex Color Rojo Mediano", categoria: "Material de Oficina", stock: 42, unidad: "Piezas" },
      { descripcion: "Pluma Bolex Color Negra Mediano", categoria: "Material de Oficina", stock: 79, unidad: "Piezas" },
      { descripcion: "Tinta p/Sello Roja", categoria: "Material de Oficina", stock: 62, unidad: "Frascos" },
      { descripcion: "Tinta p/Sello Negro", categoria: "Material de Oficina", stock: 80, unidad: "Frascos" },
      { descripcion: "Tinta p/Sello Azul", categoria: "Material de Oficina", stock: 54, unidad: "Frascos" },
      { descripcion: "Marcador de Billetes", categoria: "Material de Oficina", stock: 4, unidad: "Piezas" },
      { descripcion: "Pluma Pentel Energel Negro", categoria: "Material de Oficina", stock: 36, unidad: "Piezas" },
      { descripcion: "Corrector Liquido", categoria: "Material de Oficina", stock: 29, unidad: "Frascos" },
      { descripcion: "Marcatextos Color Amarillo", categoria: "Material de Oficina", stock: 56, unidad: "Piezas" },
      { descripcion: "Pluma Pentel Energel Azul", categoria: "Material de Oficina", stock: 47, unidad: "Piezas" },
      { descripcion: "Marcador de Cera Sharpie", categoria: "Material de Oficina", stock: 17, unidad: "Piezas" },
      { descripcion: "Marcador Permanente", categoria: "Material de Oficina", stock: 53, unidad: "Piezas" },
      { descripcion: "Marcador Permanente Punta Fina", categoria: "Material de Oficina", stock: 34, unidad: "Piezas" },

      // ADQUISICIÓN RECIENTE (PARTE 1)
      { descripcion: "Sobre Manila Doble Carta", categoria: "Adquisicion Reciente", stock: 70, unidad: "Piezas" },
      { descripcion: "Cinta Canela", categoria: "Adquisicion Reciente", stock: 9, unidad: "Rollos" },
      { descripcion: "Lapiz Plomo", categoria: "Adquisicion Reciente", stock: 140, unidad: "Piezas" },
      { descripcion: "Post IT Repegables", categoria: "Adquisicion Reciente", stock: 28, unidad: "Paquete" },
      { descripcion: "Pluma Bic Color Azul (Paquete)", categoria: "Adquisicion Reciente", stock: 46, unidad: "Paquete" },
      { descripcion: "Sujetador Grande", categoria: "Adquisicion Reciente", stock: 24, unidad: "Paquete" },
      { descripcion: "Sujetador Mediano", categoria: "Adquisicion Reciente", stock: 0, unidad: "Paquete" },

      // MATERIAL DE LIMPIEZA
      { descripcion: "Toalla interdoblada", categoria: "Material de Limpieza", stock: 20, unidad: "Paquete" },
      { descripcion: "Trapeador de hilo", categoria: "Material de Limpieza", stock: 7, unidad: "Piezas" },
      { descripcion: "Limpiavidrios", categoria: "Material de Limpieza", stock: 4, unidad: "Piezas" },
      { descripcion: "Aromatizante en spray", categoria: "Material de Limpieza", stock: 10, unidad: "Piezas" },
      { descripcion: "Difusor p/aroma", categoria: "Material de Limpieza", stock: 1, unidad: "Piezas" },
      { descripcion: "Repuesto aromático p/difusor", categoria: "Material de Limpieza", stock: 2, unidad: "Bote" },
      { descripcion: "Difusor c/2 y 7 repuestos", categoria: "Material de Limpieza", stock: 1, unidad: "Paquete" },
      { descripcion: "Cubeta completa p/trapeador", categoria: "Material de Limpieza", stock: 2, unidad: "Juegos" },
      { descripcion: "Recogedor p/basura", categoria: "Material de Limpieza", stock: 10, unidad: "Piezas" },
      { descripcion: "Cloro c/10 litros", categoria: "Material de Limpieza", stock: 2, unidad: "Galones" },
      { descripcion: "Limpiavidrios c/1 litro", categoria: "Material de Limpieza", stock: 5, unidad: "Frascos" },
      { descripcion: "Limpiavidrios c/5 litros", categoria: "Material de Limpieza", stock: 2, unidad: "Frascos" },
      { descripcion: "Limpiatrastes Axion c/3 litros", categoria: "Material de Limpieza", stock: 2, unidad: "Galones" },
      { descripcion: "Cesto para basura de 46 x 30 cms", categoria: "Material de Limpieza", stock: 15, unidad: "Piezas" },
      { descripcion: "Cesto para basura de 38 x 27 cms", categoria: "Material de Limpieza", stock: 7, unidad: "Piezas" },
      { descripcion: "Cesto para basura de 32 x 21 cms", categoria: "Material de Limpieza", stock: 14, unidad: "Piezas" },
      { descripcion: "Cesto para basura c/tapa", categoria: "Material de Limpieza", stock: 2, unidad: "Juegos" },
      { descripcion: "Papel para baño jumbo", categoria: "Material de Limpieza", stock: 75, unidad: "Rollos" },
      { descripcion: "Bolsa para basura jumbo", categoria: "Material de Limpieza", stock: 34, unidad: "Kgs." },
      { descripcion: "Pino c/20 litros", categoria: "Material de Limpieza", stock: 3, unidad: "Bidón" },
      { descripcion: "Cloro c/20 litros", categoria: "Material de Limpieza", stock: 3, unidad: "Bidón" },
      { descripcion: "Jabón p/manos c/4 litros", categoria: "Material de Limpieza", stock: 2, unidad: "Galones" },
      { descripcion: "Bolsa p/cesto de basura c/30 pzas", categoria: "Material de Limpieza", stock: 2, unidad: "Rollo" },

      // ADQUISICIÓN RECIENTE (PARTE 2)
      { descripcion: "Sujetador chico", categoria: "Adquisicion Reciente", stock: 45, unidad: "Piezas" },
      { descripcion: "Folders tamaño oficio", categoria: "Adquisicion Reciente", stock: 250, unidad: "Piezas" },
      { descripcion: "Folders tamaño carta", categoria: "Adquisicion Reciente", stock: 250, unidad: "Piezas" },
      { descripcion: "Lápiz adhesivo", categoria: "Adquisicion Reciente", stock: 8, unidad: "Piezas" },
      { descripcion: "Marcador permanente (Adquisición Reciente)", categoria: "Adquisicion Reciente", stock: 13, unidad: "Piezas" },
      { descripcion: "Cinta transparente rollo grueso", categoria: "Adquisicion Reciente", stock: 4, unidad: "Rollo" },
      { descripcion: "Grapas", categoria: "Adquisicion Reciente", stock: 6, unidad: "Caja" },
      { descripcion: "Clips", categoria: "Adquisicion Reciente", stock: 11, unidad: "Caja" },
      { descripcion: "Ligas de hule", categoria: "Adquisicion Reciente", stock: 11, unidad: "Bolsa" },
      { descripcion: "Hojas blancas tamaño carta", categoria: "Adquisicion Reciente", stock: 23, unidad: "Paquetes" },
      { descripcion: "Sobre manila tamaño carta", categoria: "Adquisicion Reciente", stock: 95, unidad: "Piezas" },

      // UTENSILIOS PARA ALIMENTOS
      { descripcion: "Vaso de plástico", categoria: "Utensilios para Alimentos", stock: 22, unidad: "Paquetes" },
      { descripcion: "Vaso térmico", categoria: "Utensilios para Alimentos", stock: 14, unidad: "Paquetes" },
      { descripcion: "Plato térmico chico", categoria: "Utensilios para Alimentos", stock: 8, unidad: "Paquetes" },
      { descripcion: "Tenedor de plástico c/100", categoria: "Utensilios para Alimentos", stock: 2, unidad: "Bolsa" },
      { descripcion: "Cuchara plástico c/100", categoria: "Utensilios para Alimentos", stock: 1, unidad: "Bolsa" },
      { descripcion: "Cuchara plástico c/25", categoria: "Utensilios para Alimentos", stock: 5, unidad: "Bolsa" },
      { descripcion: "Toalla absorbente", categoria: "Utensilios para Alimentos", stock: 3, unidad: "Rollo" },

      // MATERIAL DIVERSO
      { descripcion: "Paraguas", categoria: "Material Diverso", stock: 5, unidad: "Piezas" },
      { descripcion: "Bomba de agua de 400 watts", categoria: "Material Diverso", stock: 1, unidad: "Piezas" },
      { descripcion: "Chapa para recámara", categoria: "Material Diverso", stock: 1, unidad: "Piezas" },
      { descripcion: "Impermeable amarillo", categoria: "Material Diverso", stock: 7, unidad: "Piezas" },
      { descripcion: "Batería redonda tipo 'D' 1.5 volts", categoria: "Material Diverso", stock: 7, unidad: "Piezas" },
      { descripcion: "Batería triple 'A'", categoria: "Material Diverso", stock: 8, unidad: "Piezas" }
    ];

    try {
      const res = await fetch('/api/migracion/materiales-fiol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(materialesFiol)
      });
      const json = await res.json();
      if (json.ok) {
        alert(json.message || `Inventario de Archivo y Materiales actualizado exitosamente (${materialesFiol.length} artículos).`);
        location.reload();
        return json;
      } else {
        alert('Error: ' + (json.error || 'Error al migrar materiales'));
      }
    } catch (err) {
      alert('Error de conexión al migrar materiales: ' + err.message);
    }
  };

  // =========================================================================
  // FUNCIÓN DE MIGRACIÓN MASIVA: MOBILIARIO DE JESÚS (Rubro 3)
  // =========================================================================
  window.cargarMobiliarioJesus = async function() {
    if (!confirm('¿Reemplazar el inventario de Mobiliario con los nuevos datos correctos de La Paz?')) return;

    const data = [
        {municipio:"LA PAZ", descripcion:"sillas grises", cantidad:262},
        {municipio:"LA PAZ", descripcion:"mesas grandes", cantidad:70},
        {municipio:"LA PAZ", descripcion:"mesas lisas", cantidad:4},
        {municipio:"LA PAZ", descripcion:"mesas chicas", cantidad:8},
        {municipio:"LA PAZ", descripcion:"abanico grande", cantidad:5},
        {municipio:"LA PAZ", descripcion:"abanico chico", cantidad:1},
        {municipio:"LA PAZ", descripcion:"carpas 5x5", cantidad:6},
        {municipio:"LA PAZ", descripcion:"carpas 3x3", cantidad:2},
        {municipio:"LA PAZ", descripcion:"extenciones", cantidad:11},
        {municipio:"LA PAZ", descripcion:"extension porta foco", cantidad:2},
        {municipio:"LA PAZ", descripcion:"bocina inalambrica", cantidad:2},
        {municipio:"LA PAZ", descripcion:"microfonos", cantidad:4},
        {municipio:"LA PAZ", descripcion:"multicontacto", cantidad:2},
        {municipio:"LA PAZ", descripcion:"estructura", cantidad:1},
        {municipio:"LA PAZ", descripcion:"banner", cantidad:64},
        {municipio:"LA PAZ", descripcion:"casa de campaña", cantidad:6},
        {municipio:"LA PAZ", descripcion:"colchones", cantidad:28},
        {municipio:"LA PAZ", descripcion:"colchones inflables", cantidad:14},
        {municipio:"LA PAZ", descripcion:"inversor", cantidad:1},
        {municipio:"LA PAZ", descripcion:"slipping", cantidad:20},
        {municipio:"LA PAZ", descripcion:"archivero", cantidad:1}
    ];

    const res = await fetch('/api/migracion/mobiliario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });

    const json = await res.json();
    if(json.ok) {
        alert('Inventario de Mobiliario actualizado exitosamente.');
        location.reload();
    } else {
        alert('Error: ' + json.error);
    }
  };

  // =========================================================================
  // FUNCIÓN DE MIGRACIÓN: MOBILIARIO FORÁNEO DE JESÚS (Rubro 3 - Los Cabos, Mulegé, Comondú)
  // =========================================================================
  window.cargarMobiliarioJesusForaneos = async function() {
    if (!confirm('¿Deseas cargar el mobiliario foráneo de Jesús (Los Cabos, Mulegé y Comondú)?\nSe asignará automáticamente a las oficinas "S/A (Sin Asignar)" de cada región sin afectar el inventario existente de La Paz.')) return;

    const mobiliarioForaneo = [
      // LOS CABOS
      { municipio: "LOS CABOS", descripcion: "sillas grises", cantidad: 79 },
      { municipio: "LOS CABOS", descripcion: "sillas blancas", cantidad: 96 },
      { municipio: "LOS CABOS", descripcion: "sillas secretariales", cantidad: 6 },
      { municipio: "LOS CABOS", descripcion: "mesas grandes", cantidad: 5 },
      { municipio: "LOS CABOS", descripcion: "mesas chicas", cantidad: 3 },
      { municipio: "LOS CABOS", descripcion: "carpas 5x5", cantidad: 3 },
      { municipio: "LOS CABOS", descripcion: "extenciones", cantidad: 1 },
      { municipio: "LOS CABOS", descripcion: "bocina inalambrica", cantidad: 1 },
      { municipio: "LOS CABOS", descripcion: "microfonos", cantidad: 2 },
      { municipio: "LOS CABOS", descripcion: "multicontacto", cantidad: 6 },

      // MULEGÉ
      { municipio: "MULEGE", descripcion: "sillas grises", cantidad: 95 },
      { municipio: "MULEGE", descripcion: "sillas secretariales", cantidad: 6 },
      { municipio: "MULEGE", descripcion: "mesas grandes", cantidad: 3 },
      { municipio: "MULEGE", descripcion: "mesas lisas", cantidad: 5 },
      { municipio: "MULEGE", descripcion: "carpas 5x5", cantidad: 2 },

      // COMONDÚ
      { municipio: "COMONDU", descripcion: "sillas grises", cantidad: 102 },
      { municipio: "COMONDU", descripcion: "sillas blancas", cantidad: 34 },
      { municipio: "COMONDU", descripcion: "sillas secretariales", cantidad: 7 },
      { municipio: "COMONDU", descripcion: "mesas grandes", cantidad: 13 },
      { municipio: "COMONDU", descripcion: "mesas chicas", cantidad: 5 },
      { municipio: "COMONDU", descripcion: "carpas 5x5", cantidad: 4 },
      { municipio: "COMONDU", descripcion: "multicontacto", cantidad: 1 },
      { municipio: "COMONDU", descripcion: "inversor", cantidad: 1 },
      { municipio: "COMONDU", descripcion: "slipping", cantidad: 1 },
      { municipio: "COMONDU", descripcion: "archivero", cantidad: 1 }
    ];

    const data = mobiliarioForaneo.filter(it => Number(it.cantidad) > 0);

    try {
      const res = await fetch('/api/migracion/mobiliario-foraneos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      const json = await res.json();
      if (json.ok) {
        alert(json.message || `Carga exitosa: ${json.total_insertados} artículos foráneos registrados.`);
        if (typeof loadInventarioRegional === 'function') loadInventarioRegional();
        if (typeof loadInventarioEstatal === 'function') loadInventarioEstatal();
      } else {
        alert('Error: ' + (json.error || json.message || 'Error al ejecutar migración foránea'));
      }
    } catch (e) {
      alert('Error de conexión o red: ' + e.message);
    }
  };

  // =========================================================================
  // FUNCIÓN DE MIGRACIÓN: REESTRUCTURACIÓN DE MOBILIARIO LA PAZ (JESÚS)
  // =========================================================================
  window.reestructurarMobiliarioLaPaz = async function() {
    if (!confirm('¿Deseas reestructurar el inventario de Mobiliario de La Paz?\n\n1. El inventario actual de La Paz se marcará como Bodega Central Delegación (para seguir disponible en vales de préstamo y sin perder cantidades).\n2. Se darán de alta los 7 artículos oficiales en la Coordinación Regional La Paz (a cargo de Sandra Gpe. Salvatierra Amador) para su resguardo formal.')) return;

    try {
      toast('Ejecutando reestructuración de Mobiliario La Paz...', true);
      const res = await apiJSON('/api/migracion/reestructurar-regional-lapaz-jesus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(res.error || 'Error al reestructurar mobiliario');
      console.log('Resultado reestructuración:', res);
      alert(`✓ ${res.message || 'Reestructuración completada exitosamente.'}`);
      toast('✓ Mobiliario reestructurado exitosamente', true);
      if (typeof loadInventarioRegional === 'function') loadInventarioRegional();
      if (typeof loadInventarioEstatal === 'function') loadInventarioEstatal();
    } catch (e) {
      console.error('Error reestructurando mobiliario:', e);
      alert(`Error al reestructurar: ${e.message}`);
      toast(`Error: ${e.message}`, false);
    }
  };

  // =========================================================================
  // FUNCIÓN DE MIGRACIÓN: PARQUE VEHICULAR RECURSOS MATERIALES (EVELIA - 13 VEHÍCULOS)
  // =========================================================================
  window.cargarVehiculosRMLaPaz = async function() {
    if (!confirm('¿Deseas cargar o actualizar los 13 vehículos oficiales de Recursos Materiales (RM) para La Paz a cargo de Evelia Contreras?')) return;

    const vehiculosRM = [
      { clave_bien: "DAH 9934", marca: "MG", modelo: "MG 5", color: "GRIS OXFORD", serie: "LSJA36E91PZ039853", placas: "DAH 9934", municipio: "La Paz/RM", anio: 2023 },
      { clave_bien: "CF 54458", marca: "MG", modelo: "MG 5", color: "NEGRO BRILLANTE", serie: "LSJA36E95PZ045171", placas: "CF 54458", municipio: "La Paz/RM", anio: 2023 },
      { clave_bien: "DAH 9930", marca: "MG", modelo: "MG 5", color: "NEGRO BRILLANTE", serie: "LSJA36E9XPZ046879", placas: "DAH 9930", municipio: "La Paz/RM", anio: 2023 },
      { clave_bien: "DAH 9940", marca: "MG", modelo: "MG 5", color: "ROJO MANCHESTER", serie: "LSJA36E93PZ045251", placas: "DAH 9940", municipio: "La Paz/RM", anio: 2023 },
      { clave_bien: "CF 54452", marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDTXNG407431", placas: "CF 54452", municipio: "La Paz/RM", anio: 2022 },
      { clave_bien: "CF 54461", marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDTXNG414105", placas: "CF 54461", municipio: "La Paz/RM", anio: 2022 },
      { clave_bien: "CF 54470", marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDT6NG407409", placas: "CF 54470", municipio: "La Paz/RM", anio: 2022 },
      { clave_bien: "CF 54399", marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDT5NG407093", placas: "CF 54399", municipio: "La Paz/RM", anio: 2022 },
      { clave_bien: "CF 61041", marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDT1NG414381", placas: "CF 61041", municipio: "La Paz/RM", anio: 2022 },
      { clave_bien: "CF 54491", marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDT4NG430851", placas: "CF 54491", municipio: "La Paz/RM", anio: 2022 },
      { clave_bien: "CF 54473", marca: "TOYOTA", modelo: "HILUX", color: "BLANCO", serie: "MR0CX3DD2N1332838", placas: "CF 54473", municipio: "La Paz/RM", anio: 2022 },
      { clave_bien: "CF 54486", marca: "RAM", modelo: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT4NG406611", placas: "CF 54486", municipio: "La Paz/RM", anio: 2022 },
      { clave_bien: "DAH 9928", marca: "NISSAN", modelo: "URVAN", color: "BLANCO", serie: "JN1BE6DS6P9081474", placas: "DAH 9928", municipio: "La Paz/RM", anio: 2023 }
    ];

    try {
      toast('Cargando vehículos de Recursos Materiales...', true);
      const res = await apiJSON('/api/migracion/vehiculos-rm-lapaz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vehiculosRM)
      });
      if (!res.ok) throw new Error(res.error || 'Error al cargar vehículos RM');
      console.log('Resultado carga vehículos RM:', res);
      alert(`✓ ${res.message || 'Vehículos cargados exitosamente.'}`);
      toast('✓ 13 Vehículos RM procesados exitosamente', true);
      if (typeof loadInventarioRegional === 'function') loadInventarioRegional();
      if (typeof loadInventarioEstatal === 'function') loadInventarioEstatal();
    } catch (e) {
      console.error('Error cargando vehículos RM:', e);
      alert(`Error al cargar vehículos RM: ${e.message}`);
      toast(`Error: ${e.message}`, false);
    }
  };

  // =========================================================================
  // MÓDULO EXCLUSIVO: INVENTARIO ESTATAL CONSOLIDADO (Gabriel Fiol y Rodrigo Molina)
  // =========================================================================
  let ESTATAL_ROWS = [];

  async function loadInventarioEstatal() {
    const tbody = $('estatal_tbody');
    const msg = $('estatal_msg');
    const meta = $('estatal_meta');
    if (!tbody) return;

    const q = safestr($('estatal_filter_q')?.value);
    const regionId = safestr($('estatal_filter_region')?.value);
    const rubroId = safestr($('estatal_filter_rubro')?.value);

    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (regionId) params.set('region_id', regionId);
    if (rubroId) params.set('rubro_id', rubroId);

    tbody.innerHTML = '<tr><td colspan="10" class="muted">Cargando inventario estatal consolidado...</td></tr>';
    if (msg) msg.textContent = '';

    try {
      // Poblar catálogo de regiones si aún no está lleno
      const regSel = $('estatal_filter_region');
      if (regSel && regSel.options.length <= 1) {
        if (!REGIONAL_CATALOGS.regiones.length) {
          const rRes = await apiJSON('/api/regiones').catch(() => ({}));
          REGIONAL_CATALOGS.regiones = Array.isArray(rRes?.data) ? rRes.data : [];
        }
        regSel.innerHTML = '<option value="">Todas las Regiones</option>' +
          REGIONAL_CATALOGS.regiones.map(r => `<option value="${Number(r.id)}">${escHtml(safestr(r.nombre))}</option>`).join('');
      }

      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await apiJSON(`/api/inventario-estatal/consolidado${qs}`);
      const kpis = res?.kpis || {};
      const rows = Array.isArray(res?.data) ? res.data : [];
      ESTATAL_ROWS = rows;

      // Actualizar tarjetas de KPI Estatales
      if ($('kpi-estatal-total')) $('kpi-estatal-total').textContent = Number(kpis.total_bienes_estatales || 0).toLocaleString();
      if ($('kpi-estatal-vehiculos')) $('kpi-estatal-vehiculos').textContent = Number(kpis.total_vehicular || 0).toLocaleString();
      if ($('kpi-estatal-mobiliario')) $('kpi-estatal-mobiliario').textContent = Number(kpis.total_mobiliario || 0).toLocaleString();
      if ($('kpi-estatal-tablets')) $('kpi-estatal-tablets').textContent = Number(kpis.total_tablets || 0).toLocaleString();
      if ($('kpi-estatal-tablets-sub')) {
        const tr = kpis.tabletas_resumen || {};
        $('kpi-estatal-tablets-sub').textContent = `En Resguardo: ${Number(tr.en_resguardo || 0)} | Devolución: ${Number(tr.devolucion_pendiente || 0)} | Disp.: ${Number(tr.disponibles || 0)}`;
      }
      if ($('kpi-estatal-almacen')) $('kpi-estatal-almacen').textContent = Number(kpis.almacen_general_stock || 0).toLocaleString();
      if ($('kpi-estatal-articulos')) $('kpi-estatal-articulos').textContent = `${Number(kpis.almacen_general_articulos || 0).toLocaleString()} artículos consumibles`;

      if (meta) meta.textContent = `${rows.length} activo${rows.length === 1 ? '' : 's'} registrado${rows.length === 1 ? '' : 's'}`;

      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="10" class="muted">No se encontraron activos para los filtros seleccionados.</td></tr>';
        return;
      }

      tbody.innerHTML = rows.map(r => {
        const estatus = safestr(r.estatus_uso || 'ACTIVO').toUpperCase();
        const inSiniestro = isSiniestroActivo(r);
        let statusClass = 'status-aprobada';
        if (estatus === 'PRESTADO' || estatus === 'EN_REPARACION') statusClass = 'status-pendiente';
        if (estatus === 'BAJA' || inSiniestro) statusClass = 'status-cancelada';

        const ofiTxt = r.oficina_nombre
          ? (r.municipio ? `${safestr(r.oficina_nombre)} (${safestr(r.municipio)})` : safestr(r.oficina_nombre))
          : '-';

        const estatusHtml = inSiniestro
          ? `<span class="badge-siniestro">🚨 NO DISPONIBLE — EN ASEGURADORA / SINIESTRO</span>`
          : `<span class="status-badge ${statusClass}">${escHtml(estatus)}</span>`;

        return `<tr class="${inSiniestro ? 'row-siniestro' : ''}" style="${inSiniestro ? 'background-color:#fff1f2; border-left:4px solid #e11d48; color:#9f1239;' : ''}">
          <td><b>${escHtml(safestr(r.clave_bien || '-'))}</b></td>
          <td><span style="font-size:11.5px; font-weight:600; color:${inSiniestro ? '#9f1239' : 'var(--primary)'};">${escHtml(safestr(r.nombre_rubro || `Rubro ${r.rubro_id}`))}</span></td>
          <td>${escHtml(safestr(r.descripcion || '-'))}</td>
          <td>${escHtml(safestr(r.marca_modelo || '-'))}</td>
          <td>${escHtml(safestr(r.numero_serie_placas || '-'))}</td>
          <td style="text-align:center; font-weight:700;">${Number(r.cantidad_propia ?? 1)}</td>
          <td><b>${escHtml(safestr(r.region_nombre || '-'))}</b></td>
          <td>${escHtml(ofiTxt)}</td>
          <td><span class="status-badge" style="font-size:11px;">${escHtml(safestr(r.estado_fisico || 'BUENO'))}</span></td>
          <td>${estatusHtml}</td>
        </tr>`;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="10" class="muted" style="color:var(--danger);">${escHtml(e.message || 'Error al cargar inventario estatal')}</td></tr>`;
      if (!handleAuthError(e)) toast(e.message || 'Error al cargar inventario estatal', false);
    }
  }

  function exportarInventarioEstatalExcel() {
    if (!ESTATAL_ROWS.length) {
      toast('No hay datos en el inventario consolidado para exportar', false);
      return;
    }
    const headers = ['CLAVE BIEN', 'RUBRO', 'DESCRIPCION', 'MARCA / MODELO', 'SERIE / PLACAS', 'CANTIDAD', 'REGION', 'OFICINA', 'ESTADO FISICO', 'ESTATUS'];
    const rowsHtml = ESTATAL_ROWS.map(r => `
      <tr>
        <td>${escHtml(safestr(r.clave_bien || '-'))}</td>
        <td>${escHtml(safestr(r.nombre_rubro || '-'))}</td>
        <td>${escHtml(safestr(r.descripcion || '-'))}</td>
        <td>${escHtml(safestr(r.marca_modelo || '-'))}</td>
        <td>${escHtml(safestr(r.numero_serie_placas || '-'))}</td>
        <td style="text-align:center;">${Number(r.cantidad_propia ?? 1)}</td>
        <td>${escHtml(safestr(r.region_nombre || '-'))}</td>
        <td>${escHtml(safestr(r.oficina_nombre || '-'))}</td>
        <td>${escHtml(safestr(r.estado_fisico || 'BUENO'))}</td>
        <td>${escHtml(safestr(r.estatus_uso || 'ACTIVO'))}</td>
      </tr>
    `).join('');

    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <h2>Delegación de Programas para el Desarrollo en Baja California Sur</h2>
      <h3>Reporte de Inventario Estatal Consolidado</h3>
      <table border="1">
        <thead>
          <tr style="background:#621132; color:white;">
            ${headers.map(h => `<th>${h}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </body></html>`;

    const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventario_estatal_consolidado_${new Date().toISOString().slice(0, 10)}.xls`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Excel generado correctamente', true);
  }

  function imprimirInventarioEstatal() {
    if (!ESTATAL_ROWS.length) {
      toast('No hay datos para imprimir', false);
      return;
    }
    const w = window.open('', '_blank', 'width=1100,height=850');
    if (!w) {
      toast('Ventana bloqueada por el navegador. Permite ventanas emergentes.', false);
      return;
    }
    const rowsHtml = ESTATAL_ROWS.map((r, i) => {
      const inSiniestro = isSiniestroActivo(r);
      const rowStyle = inSiniestro ? ' style="background:#fff1f2; color:#9f1239;"' : '';
      const estTxt = inSiniestro ? 'NO DISPONIBLE (SINIESTRO / ASEGURADORA)' : safestr(r.estatus_uso || 'ACTIVO');
      return `
      <tr${rowStyle}>
        <td style="text-align:center;">${i + 1}</td>
        <td><b>${escHtml(safestr(r.clave_bien || '-'))}</b></td>
        <td>${escHtml(safestr(r.nombre_rubro || '-'))}</td>
        <td>${escHtml(safestr(r.descripcion || '-'))}</td>
        <td>${escHtml(safestr(r.marca_modelo || '-'))}</td>
        <td>${escHtml(safestr(r.numero_serie_placas || '-'))}</td>
        <td style="text-align:center;">${Number(r.cantidad_propia ?? 1)}</td>
        <td>${escHtml(safestr(r.region_nombre || '-'))}</td>
        <td>${escHtml(safestr(r.oficina_nombre || '-'))}</td>
        <td>${escHtml(safestr(r.estado_fisico || 'BUENO'))}</td>
        <td${inSiniestro ? ' style="color:#9f1239; font-weight:700;"' : ''}>${escHtml(estTxt)}</td>
      </tr>`;
    }).join('');

    w.document.open();
    w.document.write(`<!doctype html><html><head><title>Inventario Estatal Consolidado</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; color: #111; }
        h2, h3 { margin: 4px 0; color: #621132; }
        table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 15px; }
        th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
        th { background: #f3e8eb; color: #621132; }
        @media print { body { padding: 0; } }
      </style>
    </head><body>
      <h2>Secretaría de Bienestar — Delegación Baja California Sur</h2>
      <h3>Control de Inventario Estatal Consolidado</h3>
      <p style="font-size:12px; color:#555;">Fecha de emisión: ${new Date().toLocaleDateString('es-MX')} — Total registros: ${ESTATAL_ROWS.length}</p>
      <table>
        <thead>
          <tr>
            <th>No.</th><th>Clave Bien</th><th>Rubro</th><th>Descripción</th><th>Marca / Modelo</th><th>Serie / Placas</th><th>Cant.</th><th>Región</th><th>Oficina</th><th>Estado</th><th>Estatus</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch {} }, 250);
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
      if (targetView === 'captura') {
        if (SOL_ID || SOL_READY_FOR_PDF || SOL_FLOW_TAB === 'pdf') {
          resetSolicitudFlow({ stayInCaptura: true });
          setSolicitudTab('crear');
        }
      }
      showView(targetView);
    });

    // Botones del Panel General y Auditoria
    $('btn-crear-rapido')?.addEventListener('click', () => {
      resetSolicitudFlow({ stayInCaptura: true });
      setSolicitudTab('crear');
      showView('captura');
    });
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
    SOL_SIG_PAD = createSignaturePadController({
      canvasId: 'sol_firma_canvas',
      clearBtnId: 'btn-clear-firma-sol',
      uploadInputId: 'sol_firma_file',
      statusId: 'sol_firma_status_badge'
    });
    $('sol_user_id')?.addEventListener('change', () => syncDefaultNombreFirmaFromOficialia(true));
    $('sol_region')?.addEventListener('change', () => syncSolicitudFirmaVisibility());

    $('btn-crear-sol')?.addEventListener('click', continuarAPaso2);

    // Alternancia entre Consumibles y Vale Provisional
    $('btn-sol-modo-consumibles')?.addEventListener('click', () => setSolicitudModo('CONSUMIBLES'));
    $('btn-sol-modo-prestamo')?.addEventListener('click', () => setSolicitudModo('PRESTAMO_ACTIVOS'));
    $('tipo_solicitud')?.addEventListener('change', (ev) => setSolicitudModo(ev.target.value));

    $('vp_rubro_id')?.addEventListener('change', () => {
      if (VP_FORM_ITEMS.length) {
        VP_FORM_ITEMS = [];
        renderVpFormItems();
      }
      loadVpCatalogo();
    });
    const selModChange = getTipoValeSelect();
    selModChange?.addEventListener('change', () => {
      syncVpMinDates();
      syncVpQuienRecibeVisibility();
    });
    $('vp_fecha_salida')?.addEventListener('change', () => syncVpMinDates());
    syncVpMinDates();
    syncVpQuienRecibeVisibility();

    // Autocompletado de Firma 3 (RECIBE)
    $('vale-recibe-preset')?.addEventListener('change', (ev) => {
      const opt = ev.target.selectedOptions?.[0];
      if (!opt || !opt.value || opt.value === 'MANUAL') {
        $('vale-recibe-nombre')?.focus();
        return;
      }
      const pNombre = opt.getAttribute('data-nombre') || '';
      const pCargo = opt.getAttribute('data-cargo') || '';
      if ($('vale-recibe-nombre')) $('vale-recibe-nombre').value = pNombre;
      if ($('vale-recibe-cargo')) $('vale-recibe-cargo').value = pCargo;
    });
    $('vp_solicitante_nombre')?.addEventListener('input', (ev) => {
      const mod = getTipoValeSelect();
      const is2Firmas = !mod || mod.value === '2_FIRMAS' || !canUserUseCuatroFirmas();
      if (is2Firmas || !$('vale-recibe-preset')?.value) {
        if ($('vale-recibe-nombre')) $('vale-recibe-nombre').value = ev.target.value;
      }
    });
    $('vp_solicitante_cargo')?.addEventListener('input', (ev) => {
      const mod = getTipoValeSelect();
      const is2Firmas = !mod || mod.value === '2_FIRMAS' || !canUserUseCuatroFirmas();
      if (is2Firmas || !$('vale-recibe-preset')?.value) {
        const val = ev.target.value;
        const deptoNombre = $('vp_departamento_id')?.selectedOptions?.[0]?.textContent?.trim() || '';
        if ($('vale-recibe-cargo')) $('vale-recibe-cargo').value = val || deptoNombre;
      }
    });
    $('vp_departamento_id')?.addEventListener('change', () => {
      const mod = getTipoValeSelect();
      const is2Firmas = !mod || mod.value === '2_FIRMAS' || !canUserUseCuatroFirmas();
      if (is2Firmas) {
        const deptoNombre = $('vp_departamento_id')?.selectedOptions?.[0]?.textContent?.trim() || '';
        if (!$('vp_solicitante_cargo')?.value && $('vale-recibe-cargo')) {
          $('vale-recibe-cargo').value = deptoNombre;
        }
      }
    });

    $('vp_item_select')?.addEventListener('change', (ev) => {
      const idx = ev.target.value;
      if (idx !== '' && VP_CATALOGO[idx]) {
        const it = VP_CATALOGO[idx];
        if ($('vp_item_serie')) $('vp_item_serie').value = it.serie || '';
        if ($('vp_item_estado')) $('vp_item_estado').value = it.estado_salida || 'BUEN ESTADO';
      }
    });
    $('btn-vp-add-item')?.addEventListener('click', addVpItemToForm);
    $('btn-vp-guardar')?.addEventListener('click', submitVpForm);
    $('btn-vp-cancelar-form')?.addEventListener('click', () => setSolicitudModo('CONSUMIBLES'));
    $('btn-sol-tab-crear')?.addEventListener('click', () => {
      if (SOL_ID || SOL_READY_FOR_PDF) {
        resetSolicitudFlow({ stayInCaptura: true });
      }
      setSolicitudTab('crear');
    });
    $('btn-sol-tab-agregar')?.addEventListener('click', ()=> setSolicitudTab('agregar'));
    $('btn-sol-tab-revision')?.addEventListener('click', ()=> setSolicitudTab('revision'));
    $('btn-sol-tab-pdf')?.addEventListener('click', ()=> setSolicitudTab('pdf'));
    $('btn-find-prod')?.addEventListener('click', buscarProductos);
    $('btn-add-det')?.addEventListener('click', agregarDetalle);
    $('btn-limpiar-sol-paso1')?.addEventListener('click', () => {
      resetSolicitudFlow({ stayInCaptura: true });
      setSolicitudTab('crear');
      toast('Formulario reiniciado', true);
    });
    $('btn-cancelar-sol-paso2')?.addEventListener('click', () => {
      if (DET_ROWS.length && !confirm('¿Deseas cancelar y reiniciar la solicitud? Se borrarán los productos agregados.')) return;
      resetSolicitudFlow({ stayInCaptura: true });
      setSolicitudTab('crear');
      toast('Solicitud reiniciada', true);
    });
    $('btn-cancelar-sol-paso3')?.addEventListener('click', () => {
      if (confirm('¿Deseas cancelar la solicitud en proceso?')) {
        resetSolicitudFlow({ stayInCaptura: true });
        setSolicitudTab('crear');
        toast('Solicitud reiniciada', true);
      }
    });
    $('btn-sol-nueva-orden')?.addEventListener('click', () => {
      resetSolicitudFlow({ stayInCaptura: true });
      setSolicitudTab('crear');
    });
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

    // Botones del flujo de 4 estados en la pestaña Consulta (Para Encargado Fiol / Admin)
    $('sol_consulta_detalle')?.addEventListener('click', async (ev) => {
      const btnEnProceso = ev.target.closest('#btn-sol-pasar-en-proceso');
      if (btnEnProceso) {
        btnEnProceso.disabled = true;
        const ok = await cambiarEstadoSolicitudConsulta('EN_PROCESO');
        if (!ok) btnEnProceso.disabled = false;
        return;
      }
      const btnParaFirmas = ev.target.closest('#btn-sol-pasar-para-firmas') || ev.target.closest('#btn-aprobar-surtir-consulta');
      if (btnParaFirmas) {
        btnParaFirmas.disabled = true;
        const ok = await cambiarEstadoSolicitudConsulta('PARA_FIRMAS');
        if (!ok) btnParaFirmas.disabled = false;
        return;
      }
      const btnImprimirVale = ev.target.closest('#btn-sol-imprimir-vale-firmas');
      if (btnImprimirVale) {
        await descargarPDF({ resetAfter: false });
        return;
      }
      const btnCompletada = ev.target.closest('#btn-sol-marcar-completada');
      if (btnCompletada) {
        if (!confirm('¿Confirmas que el material ya fue entregado y deseas marcar la orden como COMPLETADA?')) return;
        btnCompletada.disabled = true;
        const ok = await cambiarEstadoSolicitudConsulta('COMPLETADA');
        if (!ok) btnCompletada.disabled = false;
        return;
      }
    });

    $('btn-sol-subir-respaldo')?.addEventListener('click', subirRespaldoFirmado);
    $('btn-sol-ver-respaldo')?.addEventListener('click', verRespaldoFirmado);

    // Botones de PDF
    $('btn-sol-pdf')?.addEventListener('click', ()=> descargarPDF({ resetAfter: false }));
    $('btn-sol-pdf-flow')?.addEventListener('click', ()=> descargarPDF({ resetAfter: true }));

    // Selección y apertura de renglón en la tabla
    $('listado_box')?.addEventListener('click', (ev)=>{
      const tr = ev.target.closest('tbody tr[data-sol-id]'); if (!tr) return;
      setListadoSelectedId(tr.dataset.solId || tr.getAttribute('data-sol-id'));
    });
    $('listado_box')?.addEventListener('dblclick', (ev)=>{
      const tr = ev.target.closest('tbody tr[data-sol-id]'); if (!tr) return;
      const id = tr.dataset.solId || tr.getAttribute('data-sol-id');
      if (id) consultarSolicitudById(id);
    });

    // Pestaña: Almacén (Inventario)
    $('btn-alm-apply')?.addEventListener('click', loadAlmacen);
    $('alm_q')?.addEventListener('keydown', (e)=>{ if(e.key==='Enter') loadAlmacen(); });
    let almSearchTimer = null;
    $('alm_q')?.addEventListener('input', () => {
      clearTimeout(almSearchTimer);
      almSearchTimer = setTimeout(() => {
        const qVal = ($('alm_q')?.value || '').trim();
        if (!qVal) {
          renderAlmacen(ALM_LAST_ROWS);
        } else {
          const filtered = ALM_LAST_ROWS.filter(r => 
            matchFlexible(qVal, r.CLAVE, r.DESCRIPCION, nombreCategoriaFromRow(r), r.UNIDAD)
          );
          renderAlmacen(filtered);
        }
      }, 150);
    });
    $('alm_order')?.addEventListener('change', loadAlmacen);
    $('alm_dir')?.addEventListener('change', loadAlmacen);
    $('btn-alm-crear')?.addEventListener('click', crearAlmacen);
    $('btn-alm-cancel')?.addEventListener('click', cancelEdit);

    // v44: Botón "+ Nuevo Material"
    $('btn-alm-nuevo-prod')?.addEventListener('click', () => {
      almResetForm();
      const descEl = $('alm_desc');
      if (descEl) {
        descEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => descEl.focus(), 300);
      }
      toast('Formulario listo para nuevo material', true);
    });

    // v44: Checkbox "Seleccionar todos"
    $('alm_check_all')?.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      const rowChecks = document.querySelectorAll('.alm-row-check');
      rowChecks.forEach(chk => {
        chk.checked = isChecked;
        const id = chk.dataset.id;
        if (id) {
          if (isChecked) selectedMaterialIds.add(String(id));
          else selectedMaterialIds.delete(String(id));
        }
      });
      updateAlmSelectionUI();
    });

    // v44: Checkbox individual de fila
    $('alm_tbody')?.addEventListener('change', (ev) => {
      const chk = ev.target.closest('.alm-row-check');
      if (!chk) return;
      const id = chk.dataset.id;
      if (!id) return;
      if (chk.checked) selectedMaterialIds.add(String(id));
      else selectedMaterialIds.delete(String(id));
      updateAlmSelectionUI();
    });

    $('alm_tbody')?.addEventListener('click', (ev)=>{
      const btn = ev.target.closest('button'); if (!btn) return;
      const tr = ev.target.closest('tr'); if (!tr) return;
      const id = tr.dataset.id;
      if (btn.dataset.action === 'hist')      loadProductoHistorial(tr.dataset.clave || '');
      else if (btn.dataset.action === 'edit') startEditFromRow(tr);
      else if (btn.dataset.action === 'del')  eliminarFila(id);
    });

    // v44: Alternar ver solo seleccionados
    $('btn-alm-toggle-sel')?.addEventListener('click', () => {
      filterOnlySelected = !filterOnlySelected;
      renderAlmacen(ALM_LAST_ROWS);
    });

    // v44: Reportes en PDF oficial
    $('btn-alm-pdf-sel')?.addEventListener('click', () => generarReporteAlmacenPdf(true));
    $('btn-alm-pdf-all')?.addEventListener('click', () => generarReporteAlmacenPdf(false));

    // v54: Botón Limpiar Selección y Actualizar
    $('btn-clear-selection')?.addEventListener('click', () => {
      selectedMaterialIds.clear();
      filterOnlySelected = false;
      document.querySelectorAll('.alm-row-check, #alm-check-all').forEach(cb => { cb.checked = false; });
      updateAlmSelectionUI();
      if (typeof loadAlmacen === 'function') loadAlmacen();
    });

    // Pestaña: Inventario Regional (Fase B)
    $('reg_filter_region')?.addEventListener('change', async (ev) => {
      const regId = ev.target?.value || '';
      await loadRegionalOficinas(regId);
      await renderRegionalInventory();
    });
    $('reg_filter_oficina')?.addEventListener('change', () => renderRegionalInventory());
    $('reg_filter_rubro')?.addEventListener('change', async () => {
      const regId = $('reg_filter_region')?.value || '';
      await loadRegionalOficinas(regId);
      await renderRegionalInventory();
    });
    $('btn-reg-filtrar')?.addEventListener('click', () => renderRegionalInventory());
    $('btn-reg-pdf')?.addEventListener('click', () => generarFormatoRegionalPDF());
    $('btn-reg-add')?.addEventListener('click', () => openRegionalAddModal(null));
    $('reg_add_rubro')?.addEventListener('change', async () => {
      toggleVehiculoSectionByRubro();
      const ofiSel = $('reg_add_oficina');
      const rubSel = $('reg_add_rubro');
      if (ofiSel && rubSel) {
        const prevOfi = ofiSel.value || '';
        const rId = Number(rubSel.value || 0);
        try {
          const res = await apiJSON(`/api/oficinas${rId ? `?rubro_id=${rId}` : ''}`);
          const oficinas = filterOficinasForRegionalSelector(Array.isArray(res?.data) ? res.data : [], rId);
          const byRegion = new Map();
          oficinas.forEach(o => {
            const key = safestr(o.region_nombre) || `Región ${o.region_id}`;
            if (!byRegion.has(key)) byRegion.set(key, []);
            byRegion.get(key).push(o);
          });
          ofiSel.innerHTML = '<option value="">- selecciona oficina -</option>' +
            Array.from(byRegion.entries()).map(([regName, list]) => (
              `<optgroup label="${escHtml(regName)}">` +
              list.map(o => {
                const label = formatRegionalOficinaOptionLabel(o);
                return `<option value="${Number(o.id)}">${escHtml(label)}</option>`;
              }).join('') +
              '</optgroup>'
            )).join('');
          if (prevOfi && oficinas.some(o => String(o.id) === String(prevOfi))) ofiSel.value = prevOfi;
        } catch (_) {}
      }
    });
    $('btn-veh-chk-all-si')?.addEventListener('click', () => setAllVehiculoChecklist('Sí'));
    $('btn-veh-chk-all-no')?.addEventListener('click', () => setAllVehiculoChecklist('No'));
    $('btn-veh-chk-all-na')?.addEventListener('click', () => setAllVehiculoChecklist('N/A'));
    $('reg_tbody')?.addEventListener('click', (ev) => {
      const editBtn = ev.target.closest('[data-reg-edit-idx]');
      if (editBtn) {
        const idx = Number(editBtn.getAttribute('data-reg-edit-idx'));
        const row = REGIONAL_LAST_ROWS[idx];
        if (row) openRegionalAddModal(row);
        return;
      }
      const transBtn = ev.target.closest('[data-reg-trans-idx]');
      if (transBtn) {
        const idx = Number(transBtn.getAttribute('data-reg-trans-idx'));
        const row = REGIONAL_LAST_ROWS[idx];
        if (row) openRegionalTransferModal(row);
        return;
      }
      const histBtn = ev.target.closest('[data-reg-hist-idx]');
      if (histBtn) {
        const idx = Number(histBtn.getAttribute('data-reg-hist-idx'));
        const row = REGIONAL_LAST_ROWS[idx];
        if (row) openVehiculoHistorialModal(row);
        return;
      }
      const forceBtn = ev.target.closest('[data-reg-force-return-idx]');
      if (forceBtn) {
        const idx = Number(forceBtn.getAttribute('data-reg-force-return-idx'));
        const row = REGIONAL_LAST_ROWS[idx];
        if (row && row.id) forzarRetornoRegional(row.id, row.clave_bien);
        return;
      }
      const pdfBtn = ev.target.closest('[data-reg-pdf-id]');
      if (pdfBtn) {
        const id = Number(pdfBtn.getAttribute('data-reg-pdf-id'));
        if (id) generarFormatoRegionalPDF(id);
      }
    });
    $('btn-forzar-retorno')?.addEventListener('click', () => {
      const btn = $('btn-forzar-retorno');
      const id = Number(btn?.dataset?.activoId || $('reg_add_id')?.value || 0);
      const clave = safestr(btn?.dataset?.claveBien || $('reg_add_clave')?.value || '');
      if (id) forzarRetornoRegional(id, clave);
    });
    $('btn-eliminar-regional')?.addEventListener('click', () => {
      const btn = $('btn-eliminar-regional');
      const id = Number(btn?.dataset?.activoId || $('reg_add_id')?.value || 0);
      const clave = safestr(btn?.dataset?.claveBien || $('reg_add_clave')?.value || '');
      if (id) eliminarActivoRegional(id, clave);
    });
    $('reg_add_clave')?.addEventListener('input', (e) => {
      if (e.target) e.target.value = e.target.value.toUpperCase();
    });
    $('veh_resg_rfc')?.addEventListener('input', (e) => {
      if (e.target) e.target.value = e.target.value.toUpperCase();
    });
    $('veh_resg_licencia')?.addEventListener('input', (e) => {
      if (e.target) e.target.value = e.target.value.toUpperCase();
    });
    $('veh_resg_preset')?.addEventListener('change', (e) => {
      const sel = e.target;
      const opt = sel?.selectedOptions?.[0];
      if (!opt || !opt.value) return;
      const nom = opt.getAttribute('data-nombre') || '';
      const rawPue = opt.getAttribute('data-puesto') || (opt.value !== 'RM' ? 'Director Regional' : '');
      const pue = normalizeRegionalCargo(rawPue);
      const ads = opt.getAttribute('data-adscripcion') || '';
      if ($('veh_resg_nombre') && nom) $('veh_resg_nombre').value = nom;
      if ($('veh_resg_puesto') && pue) $('veh_resg_puesto').value = pue;
      if ($('veh_resg_adscripcion') && ads) $('veh_resg_adscripcion').value = ads;
    });
    $('btn-reg-save-and-pdf')?.addEventListener('click', (ev) => {
      submitRegionalAddForm(ev, { downloadPdfAfter: true });
    });
    // v53: Botón para Ocultar / Mostrar Menú Principal
    $('btn-toggle-menu')?.addEventListener('click', () => {
      const sidebar = $('sidebar');
      if (!sidebar) return;
      const isCollapsed = sidebar.classList.toggle('sidebar-collapsed');
      const icon = $('btn-toggle-menu-icon');
      const text = $('btn-toggle-menu-text');
      if (isCollapsed) {
        if (icon) icon.textContent = '▶';
        if (text) text.textContent = 'Mostrar Menú';
        $('btn-toggle-menu').title = 'Mostrar Menú Lateral';
      } else {
        if (icon) icon.textContent = '◀';
        if (text) text.textContent = 'Ocultar Menú';
        $('btn-toggle-menu').title = 'Ocultar Menú Lateral';
      }
    });
    $('alm_clave')?.addEventListener('input', (e) => {
      if (e.target) e.target.value = e.target.value.toUpperCase();
    });
    $('form-add-regional')?.addEventListener('submit', submitRegionalAddForm);
    $('modal-add-regional')?.addEventListener('click', (ev) => {
      // Cerrar al hacer clic en el fondo o en botones con data-close-modal
      if (ev.target === ev.currentTarget || ev.target.closest('[data-close-modal]')) closeRegionalAddModal();
    });
    $('form-transferir-regional')?.addEventListener('submit', submitRegionalTransferForm);
    $('modal-transferir-regional')?.addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget || ev.target.closest('[data-close-modal]') || ev.target.closest('[data-close-trans-modal]')) closeRegionalTransferModal();
    });
    $('modal-historial-vehiculo')?.addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget || ev.target.closest('[data-close-modal]')) closeVehiculoHistorialModal();
    });

    // Pestaña: Gestión de Usuarios (Admin - CRUD)
    $('btn-usuarios-refresh')?.addEventListener('click', () => loadUsuariosAdmin());
    $('btn-usuario-nuevo')?.addEventListener('click', () => openNewUsuarioModal());
    $('btn-backup-db')?.addEventListener('click', () => downloadDatabaseBackup());
    $('btn-ver-bitacora')?.addEventListener('click', () => openBitacoraModal());
    $('btn-cerrar-bitacora')?.addEventListener('click', () => closeBitacoraModal());
    $('btn-cerrar-bitacora-footer')?.addEventListener('click', () => closeBitacoraModal());
    $('btn-bitacora-buscar')?.addEventListener('click', () => {
      const q = $('bitacora_q')?.value || '';
      const fecha = $('bitacora_fecha')?.value || '';
      cargarBitacora(q, fecha);
    });
    $('bitacora_q')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = $('bitacora_q')?.value || '';
        const fecha = $('bitacora_fecha')?.value || '';
        cargarBitacora(q, fecha);
      }
    });
    $('btn-bitacora-limpiar')?.addEventListener('click', () => {
      if ($('bitacora_q')) $('bitacora_q').value = '';
      if ($('bitacora_fecha')) $('bitacora_fecha').value = '';
      cargarBitacora('', '');
    });
    $('modal-bitacora')?.addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget) closeBitacoraModal();
    });
    $('online-users-badge')?.addEventListener('click', () => {
      const container = $('online-users-container');
      if (container) {
        container.style.display = (container.style.display === 'none' || !container.style.display) ? 'block' : 'none';
      }
    });

    $('usuarios_tbody')?.addEventListener('click', (ev) => {
      const editBtn = ev.target.closest('[data-usr-edit-idx]');
      if (editBtn) {
        const idx = Number(editBtn.getAttribute('data-usr-edit-idx'));
        const u = ADMIN_USUARIOS_ROWS[idx];
        if (u) openEditUsuarioModal(u);
        return;
      }
      const delBtn = ev.target.closest('[data-usr-del-idx]');
      if (delBtn) {
        const idx = Number(delBtn.getAttribute('data-usr-del-idx'));
        const u = ADMIN_USUARIOS_ROWS[idx];
        if (u) deleteUsuarioAdmin(u);
        return;
      }
    });

    $('form-edit-usuario')?.addEventListener('submit', submitEditUsuarioForm);
    const mUserEl = $('modal-edit-user') || $('modal-edit-usuario');
    mUserEl?.addEventListener('click', (ev) => {
      if (
        ev.target === ev.currentTarget ||
        ev.target.closest('[data-close-modal]') ||
        ev.target.closest('[data-close-usr-modal]') ||
        ev.target.closest('[data-bs-dismiss="modal"]') ||
        ev.target.closest('.modal-close')
      ) {
        closeEditUsuarioModal();
      }
    });
    $('btn-cancelar-edit-usuario')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      closeEditUsuarioModal();
    });
    $('btn-x-edit-usuario')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      closeEditUsuarioModal();
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        if (!$('modal-add-regional')?.classList.contains('hidden')) closeRegionalAddModal();
        if (!$('modal-transferir-regional')?.classList.contains('hidden')) closeRegionalTransferModal();
        if (!$('modal-historial-vehiculo')?.classList.contains('hidden')) closeVehiculoHistorialModal();
        const mu = $('modal-edit-user') || $('modal-edit-usuario');
        if (mu && (!mu.classList.contains('hidden') && mu.style.display !== 'none')) closeEditUsuarioModal();
      }
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
    $('btn-rep-print-detail')?.addEventListener('click', ()=> printReporte(REP_SELECTED_OFICIALIA || $('rep_oficialia')?.value || ''));
    $('btn-rep-export-excel')?.addEventListener('click', exportReporteExcel);
    $('btn-graf-load')?.addEventListener('click', loadGraficas);
    $('graf_oficialia')?.addEventListener('change', loadGraficas);
    $('graf_fecha_inicio')?.addEventListener('change', loadGraficas);
    $('graf_fecha_fin')?.addEventListener('change', loadGraficas);

    // Pestaña: Vales Provisionales
    $('btn-nuevo-vale-desde-lista')?.addEventListener('click', () => {
      showView('captura');
      setSolicitudModo('PRESTAMO_ACTIVOS');
    });
    $('vp_filter_estado')?.addEventListener('change', () => loadValesProvisionales());
    $('vp_filter_firmas')?.addEventListener('change', () => loadValesProvisionales());
    $('vp_filter_rubro')?.addEventListener('change', () => loadValesProvisionales());
    $('vp_filter_depto')?.addEventListener('change', () => loadValesProvisionales());
    $('vp_filter_q')?.addEventListener('input', () => loadValesProvisionales());
    $('btn-vp-filter-refresh')?.addEventListener('click', () => loadValesProvisionales());

    // Pestaña: Inventario Estatal Consolidado (Exclusivo Gabriel Fiol y Rodrigo Molina)
    $('btn-estatal-refrescar')?.addEventListener('click', loadInventarioEstatal);
    $('estatal_filter_q')?.addEventListener('input', () => {
      clearTimeout(window.__estatalDebounce);
      window.__estatalDebounce = setTimeout(loadInventarioEstatal, 300);
    });
    $('estatal_filter_region')?.addEventListener('change', loadInventarioEstatal);
    $('estatal_filter_rubro')?.addEventListener('change', loadInventarioEstatal);
    $('btn-estatal-exportar')?.addEventListener('click', exportarInventarioEstatalExcel);
    $('btn-estatal-imprimir')?.addEventListener('click', imprimirInventarioEstatal);

    // Modal Devolución
    $('btn-confirmar-devolucion-vale')?.addEventListener('click', submitDevolucionVale);
    $('btn-close-modal-devolucion')?.addEventListener('click', () => $('modal-devolucion-vale')?.classList.add('hidden'));
    $('btn-cancelar-devolucion-modal')?.addEventListener('click', () => $('modal-devolucion-vale')?.classList.add('hidden'));
    $('modal-devolucion-vale')?.addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget || ev.target.closest('[data-close-modal]')) {
        $('modal-devolucion-vale')?.classList.add('hidden');
        VP_ACTIVE_DEVOLUCION_ID = null;
      }
    });

    // Manejo opcional de login y cambio obligatorio de contraseña temporal si existe #login-form
    const loginFormEl = $('login-form');
    if (loginFormEl) {
      const showForceChangeInLogin = (userId, username) => {
        loginFormEl.classList.add('hidden');
        const box = loginFormEl.closest('.login-box') || loginFormEl.parentElement;
        const oldFc = $('force-change-form');
        if (oldFc) oldFc.remove();
        const fcForm = document.createElement('form');
        fcForm.id = 'force-change-form';
        fcForm.innerHTML = `
          <div style="background:#fef3c7; border:1px solid #f59e0b; color:#92400e; border-radius:8px; padding:10px 12px; font-size:13px; margin-bottom:14px;">
            Cuenta: <b>${escHtml(username || '')}</b>. Por seguridad debes cambiar la contraseña temporal antes de continuar.
          </div>
          <div class="login-field">
            <div class="login-input-wrap">
              <input id="fc-new-pass" type="password" placeholder="Nueva Contraseña (mín. 6 caracteres)" autocomplete="new-password" required>
            </div>
          </div>
          <div class="login-field">
            <div class="login-input-wrap">
              <input id="fc-confirm-pass" type="password" placeholder="Confirmar Contraseña" autocomplete="new-password" required>
            </div>
          </div>
          <div class="login-actions">
            <button id="btn-force-change" class="btn-submit" type="submit">Guardar Nueva Contraseña</button>
          </div>
          <div id="force-change-msg" style="margin-top:12px; font-size:13px; color:#dc2626;"></div>
        `;
        box.appendChild(fcForm);
        fcForm.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const newPassword = ($('fc-new-pass')?.value || '').trim();
          const confirmPassword = ($('fc-confirm-pass')?.value || '').trim();
          const fcMsg = $('force-change-msg');
          const fcBtn = $('btn-force-change');
          if (newPassword.length < 6) {
            if (fcMsg) fcMsg.textContent = 'La nueva contraseña debe tener al menos 6 caracteres.';
            return;
          }
          if (newPassword === 'secreta123') {
            if (fcMsg) fcMsg.textContent = 'La nueva contraseña debe ser diferente a la temporal.';
            return;
          }
          if (newPassword !== confirmPassword) {
            if (fcMsg) fcMsg.textContent = 'Las contraseñas no coinciden.';
            return;
          }
          if (fcBtn) fcBtn.disabled = true;
          try {
            const res2 = await fetch('/api/login/force-change', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId, newPassword })
            });
            const data2 = await res2.json().catch(() => ({}));
            if (!res2.ok || !data2.ok) {
              throw new Error(data2.error || data2.message || 'No se pudo actualizar la contraseña');
            }
            window.location.replace('dashboard.html');
          } catch (err2) {
            if (fcMsg) fcMsg.textContent = err2.message || 'Error al cambiar contraseña';
            if (fcBtn) fcBtn.disabled = false;
          }
        });
      };

      loginFormEl.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = ($('user')?.value || '').trim();
        const password = $('pass')?.value || '';
        const msgEl = $('login-msg');
        try {
          const res = await fetch('/api/login', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.requirePasswordChange) {
            showForceChangeInLogin(data.userId, data.username || username);
            return;
          }
          if (!res.ok || !data.ok) {
            throw new Error(data.error || data.message || 'Usuario o contraseña inválidos');
          }
          window.location.replace('dashboard.html');
        } catch (err) {
          if (msgEl) msgEl.textContent = err.message || 'No se pudo iniciar sesión';
        }
      });
      return;
    }

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

    // v42: Iniciar monitor de sesiones y comprobación de versión automática (Heartbeat)
    checkSystemHeartbeat();
    setInterval(checkSystemHeartbeat, 60000);
    
  }); // <-- FIN DEL EVENTO DOMContentLoaded 

  // ==========================================================================
  // FUNCIÓN DE CONSOLA: RESET DE VALES PROVISIONALES Y TRASPASO REGIONAL JESÚS
  // ==========================================================================
  window.ejecutarResetYAsignacionRegionalJesus = async function() {
    if (!confirm(
      '¿Ejecutar Reset de Vales Provisionales (reintegrando stock de préstamos activos) y Reestructuración Regional de Mobiliario en La Paz (descontando los 7 artículos del Inventario General de Jesús y asignándolos a Coordinación Regional La Paz)?'
    )) return;

    try {
      const res = await fetch('/api/migracion/reset-vales-y-reestructurar-jesus', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert('Error: ' + (json.error || json.message || 'No se pudo completar la operación'));
        return;
      }

      const detalleLineas = Array.isArray(json.detalle_traspaso)
        ? json.detalle_traspaso.map(d =>
            `  • ${d.clave_bien} (${d.descripcion}): -${d.cantidad_traspasada} pzas (Bodega: ${d.bodega_antes ?? 'N/A'} -> ${d.bodega_despues ?? 'N/A'})`
          ).join('\n')
        : '';

      alert(
        `✅ PROCESO COMPLETADO CON ÉXITO:\n\n` +
        `1. Vales Provisionales eliminados: ${json.vales_eliminados ?? 0}\n` +
        `   • Préstamos activos reintegrados: ${json.vales_activos_reintegrados ?? 0} vales (${json.piezas_reintegradas ?? 0} piezas devueltas a su inventario original)\n` +
        `   • Contadores de folios reiniciados a VP-2026-0001\n\n` +
        `2. Reestructuración Regional La Paz (Jesús - Mobiliario):\n` +
        `   • Registros regionales previos limpiados en La Paz: ${json.regional_eliminados ?? 0}\n` +
        `   • Artículos descontados de Bodega General y asignados a Coordinación Regional La Paz (SANDRA GPE. SALVATIERRA AMADOR): ${json.articulos_traspasados ?? 0}\n` +
        (detalleLineas ? `\nDetalle de traspaso:\n${detalleLineas}` : '')
      );

      try { await loadRegionalOficinas($('reg_filter_region')?.value || ''); } catch (_) {}
      try { await renderRegionalInventory(); } catch (_) {}
      try { await loadInventario(); } catch (_) {}
      try { await loadValesProvisionales(); } catch (_) {}
    } catch (err) {
      console.error('Error en ejecutarResetYAsignacionRegionalJesus:', err);
      alert('Error de red al ejecutar reset y reestructuración: ' + (err.message || err));
    }
  };

  // ==========================================================================
  // FUNCIÓN DE CONSOLA: MIGRACIÓN DE 15 VEHÍCULOS FORÁNEOS DE EVELIA
  // ==========================================================================
  window.cargarVehiculosForaneosEvelia = async function() {
    if (!confirm(
      '¿Eliminar los vehículos (Rubro 2) de las oficinas S/A foráneas (Los Cabos, Comondú y Mulegé) y asignar los 15 vehículos foráneos oficiales a sus oficinas existentes correspondientes?'
    )) return;

    const vehiculosForaneos = [
      // LOS CABOS
      { marca: "MG", modelo: "MG 5", color: "BLANCO YORK", serie: "LSJA36E91PZ039626", placas: "DAH 99-46", municipio: "LOS CABOS", oficina: "CANGREJOS", anio: 2023 },
      { marca: "MG", modelo: "MG 5", color: "ROJO MANCHESTER", serie: "LSJA36E95PZ045493", placas: "DAH 9938", municipio: "LOS CABOS", oficina: "CANGREJOS", anio: 2023 },
      { marca: "RAM", modelo: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT7NG430255", placas: "CF 54488", municipio: "LOS CABOS", oficina: "PEC", anio: 2022 },
      { marca: "RAM", modelo: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT8NG406675", placas: "CF 54492", municipio: "LOS CABOS", oficina: "SADER", anio: 2022 },
      { marca: "RAM", modelo: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT5NG406620", placas: "CF 54485", municipio: "LOS CABOS", oficina: "SADER", anio: 2022 },
      { marca: "NISSAN", modelo: "FRONTIER", color: "BLANCO", serie: "3N6AD33A4PK828180", placas: "CF 61040", municipio: "LOS CABOS", oficina: "GUAYMITAS", anio: 2023 },
      // MULEGÉ
      { marca: "MG", modelo: "MG 5", color: "NEGRO BRILLANTE", serie: "LSJA36E9XPZ040290", placas: "DAH 99-43", municipio: "MULEGÉ", oficina: "SANTA ROSALIA", anio: 2023 },
      { marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDT3NG414236", placas: "CF 54400", municipio: "MULEGE", oficina: "SANTA ROSALÍA", anio: 2022 },
      { marca: "TOYOTA", modelo: "TOYOTA HILUX", color: "BLANCO", serie: "MR0CX3DD0N1333065", placas: "CF 54435", municipio: "MULEGE", oficina: "VILLA ALBERTO ALVARADO", anio: 2022 },
      { marca: "RAM", modelo: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT4NG406740", placas: "CF 54487", municipio: "MULEGE", oficina: "GUERRERO NEGRO", anio: 2022 },
      // COMONDÚ
      { marca: "MG", modelo: "MG 5", color: "ROJO MANCHESTER", serie: "LSJA36E9XPZ044193", placas: "DAH 9941", municipio: "COMONDU", oficina: "CD CONSTITUCIÓN", anio: 2023 },
      { marca: "RAM", modelo: "RAM 4x4", color: "BLANCO", serie: "3C6SRBDTXNG407364", placas: "CF 54460", municipio: "COMONDU", oficina: "LORETO", anio: 2022 },
      { marca: "TOYOTA", modelo: "TOYOTA HILUX", color: "BLANCO", serie: "MR0CX3DD3N1332900", placas: "CF 54479", municipio: "COMONDU", oficina: "CD CONSTITUCIÓN", anio: 2022 },
      { marca: "RAM", modelo: "RAM SENCILLA", color: "BLANCO", serie: "3C6SRADT4NG413641", placas: "CF 54471", municipio: "COMONDU", oficina: "CD CONSTITUCIÓN", anio: 2022 },
      { marca: "NISSAN", modelo: "FRONTIER", color: "BLANCO", serie: "3N6AD33A6PK828150", placas: "CF 61042", municipio: "COMONDU", oficina: "CD CONSTITUCIÓN", anio: 2023 }
    ];

    try {
      const res = await fetch('/api/migracion/vehiculos-foraneos-evelia', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(vehiculosForaneos)
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert('Error: ' + (json.error || json.message || 'No se pudo completar la migración de vehículos foráneos'));
        return;
      }

      const detalle = Array.isArray(json.asignaciones)
        ? json.asignaciones.map(a => `  • [${a.placas}] ${a.descripcion} -> ${a.oficina_asignada} (${a.oficina_solicitada})`).join('\n')
        : '';

      alert(
        `✅ MIGRACIÓN DE VEHÍCULOS FORÁNEOS COMPLETADA:\n\n` +
        `• Vehículos en S/A foráneas eliminados: ${json.vehiculos_sa_eliminados ?? 0}\n` +
        `• Vehículos foráneos procesados: ${json.total_procesados ?? 0} (${json.vehiculos_insertados ?? 0} insertados, ${json.vehiculos_actualizados ?? 0} actualizados)\n` +
        (detalle ? `\nAsignaciones por oficina:\n${detalle}` : '')
      );

      try { await renderRegionalInventory(); } catch (_) {}
      try { await loadInventario(); } catch (_) {}
      try { await loadInventarioEstatal(); } catch (_) {}
    } catch (err) {
      console.error('Error en cargarVehiculosForaneosEvelia:', err);
      alert('Error de red al migrar vehículos foráneos: ' + (err.message || err));
    }
  };

  // ==========================================================================
  // FUNCIÓN DE CONSOLA: CONSOLIDAR Y DEDUPLICAR BODEGA RM DE JESÚS (RUBRO 3)
  // ==========================================================================
  window.consolidarBodegaRMJesus = async function() {
    if (!confirm(
      '¿Consolidar y deduplicar la bodega general de Jesús (Rubro 3 - Mobiliario) en "RM (Recursos Materiales)", asegurando 81 sillas grises en Coordinación Regional La Paz y 181 propias en RM (171 disponibles con vales activos)?'
    )) return;

    try {
      const res = await fetch('/api/migracion/consolidar-bodega-rm-jesus', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        alert('Error: ' + (json.error || json.message || 'No se pudo consolidar la bodega RM de Jesús'));
        return;
      }

      const sillas = json.sillas_grises_rm || {};
      alert(
        `✅ BODEGA RM DE JESÚS CONSOLIDADA EXITOSAMENTE:\n\n` +
        `• Oficina RM (Recursos Materiales) ID: ${json.rm_oficina_id}\n` +
        `• Oficina Coordinación Regional La Paz ID: ${json.coord_lapaz_oficina_id}\n` +
        `• Registros duplicados eliminados: ${json.duplicados_eliminados ?? 0}\n` +
        `• Referencias de vales vinculadas al registro maestro: ${json.referencias_vales_reasignadas ?? 0}\n` +
        `• Sillas grises (MOB-001) en RM: ${sillas.cantidad_propia ?? 181} propias | ${sillas.prestado_activo ?? 0} en préstamo activo | ${sillas.cantidad_disponible ?? 171} disponibles`
      );

      try { await loadRegionalFilters(true); } catch (_) {}
      try { await renderRegionalInventory(); } catch (_) {}
      try { if (typeof loadVpCatalogo === 'function') await loadVpCatalogo(); } catch (_) {}
      try { if (typeof loadValesProvisionales === 'function') await loadValesProvisionales(); } catch (_) {}
    } catch (err) {
      console.error('Error en consolidarBodegaRMJesus:', err);
      alert('Error de red al consolidar bodega RM: ' + (err.message || err));
    }
  };

  // ==========================================================================
  // v56: MÓDULO DE TABLETAS DIGITALES (LUIS EDUARDO MAYORAL GERALDO)
  // ==========================================================================
  let TABLETAS_ACTIVE_TAB = 'EN_RESGUARDO';
  let TABLETAS_ROWS = [];
  let TABLETAS_LISTENERS_BOUND = false;

  function syncTabletasOficinaFilterOptions() {
    const regVal = safestr($('tab_filter_region')?.value).toUpperCase();
    const ofiSel = $('tab_filter_oficina');
    const wrap = $('tab_filter_oficina_wrap');
    if (!ofiSel) return;

    const currentOfi = safestr(ofiSel.value);
    const allOpts = [
      { v: '', label: 'Todas las oficinas/programas' },
      { v: 'Delegación La Paz', label: 'Delegación La Paz', reg: 'LA PAZ' },
      { v: 'Región La Paz', label: 'Región La Paz', reg: 'LA PAZ' },
      { v: 'Jefatura', label: 'Jefatura', reg: 'LA PAZ' },
      { v: 'PCD - Programa de Discapacidad', label: 'PCD - Programa de Discapacidad', reg: 'LA PAZ' },
      { v: 'PAM - Programa Adulto Mayor', label: 'PAM - Programa Adulto Mayor', reg: 'LA PAZ' },
      { v: 'Región Los Cabos', label: 'Región Los Cabos', reg: 'LOS CABOS' },
      { v: 'Región Comondú', label: 'Región Comondú', reg: 'COMONDU' },
      { v: 'Región Mulegé', label: 'Región Mulegé', reg: 'MULEGE' },
    ];

    const filtered = regVal
      ? allOpts.filter(o => o.v === '' || o.reg === regVal)
      : allOpts;

    ofiSel.innerHTML = filtered.map(o => `<option value="${escHtml(o.v)}">${escHtml(o.label)}</option>`).join('');
    if (filtered.some(o => o.v === currentOfi)) {
      ofiSel.value = currentOfi;
    } else {
      ofiSel.value = '';
    }
    if (wrap) wrap.classList.remove('hidden');
  }

  function openTabletaModal(modalId) {
    const m = $(modalId);
    if (m) m.classList.remove('hidden');
  }

  function closeTabletaModal(modalId) {
    const m = $(modalId);
    if (m) m.classList.add('hidden');
    if (modalId === 'modal-tab-asignar') {
      resetAsignarEvidencias();
    }
  }

  // Compresión de imágenes en navegador antes de subir evidencias fotográficas
  function compressImageToJpegBlob(file, maxWidth = 1280, quality = 0.78) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('Archivo de imagen inválido.'));
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const origW = img.naturalWidth || img.width || 1;
          const origH = img.naturalHeight || img.height || 1;
          const scale = origW > maxWidth ? (maxWidth / origW) : 1;
          const targetW = Math.max(1, Math.round(origW * scale));
          const targetH = Math.max(1, Math.round(origH * scale));
          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, targetW, targetH);
          ctx.drawImage(img, 0, 0, targetW, targetH);
          canvas.toBlob(
            (blob) => {
              URL.revokeObjectURL(objectUrl);
              if (!blob) return reject(new Error('No se pudo comprimir la fotografía seleccionada.'));
              resolve(blob);
            },
            'image/jpeg',
            quality
          );
        } catch (err) {
          URL.revokeObjectURL(objectUrl);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('El archivo seleccionado no es una imagen válida o está dañado.'));
      };
      img.src = objectUrl;
    });
  }

  const TAB_EVIDENCIA_SLOTS = [
    {
      key: 'ine_frente',
      field: 'foto_ine_frente',
      inputId: 'tab_foto_ine_frente',
      cardId: 'tab_ev_card_ine_frente',
      badgeId: 'tab_ev_badge_ine_frente',
      prevId: 'tab_ev_prev_ine_frente',
      btnId: 'tab_ev_btn_ine_frente',
      label: 'INE — Frente (Anverso)',
    },
    {
      key: 'ine_reverso',
      field: 'foto_ine_reverso',
      inputId: 'tab_foto_ine_reverso',
      cardId: 'tab_ev_card_ine_reverso',
      badgeId: 'tab_ev_badge_ine_reverso',
      prevId: 'tab_ev_prev_ine_reverso',
      btnId: 'tab_ev_btn_ine_reverso',
      label: 'INE — Reverso (Parte trasera)',
    },
    {
      key: 'entrega',
      field: 'foto_entrega',
      inputId: 'tab_foto_entrega',
      cardId: 'tab_ev_card_entrega',
      badgeId: 'tab_ev_badge_entrega',
      prevId: 'tab_ev_prev_entrega',
      btnId: 'tab_ev_btn_entrega',
      label: 'Foto de Entrega (Persona con tableta)',
    },
  ];
  const TAB_ASIG_FILES = { ine_frente: null, ine_reverso: null, entrega: null };
  const TAB_ASIG_PREVIEW_URLS = { ine_frente: null, ine_reverso: null, entrega: null };

  function resetAsignarEvidencias() {
    TAB_EVIDENCIA_SLOTS.forEach((slot) => {
      if (TAB_ASIG_PREVIEW_URLS[slot.key]) {
        try { URL.revokeObjectURL(TAB_ASIG_PREVIEW_URLS[slot.key]); } catch (_) {}
        TAB_ASIG_PREVIEW_URLS[slot.key] = null;
      }
      TAB_ASIG_FILES[slot.key] = null;
      const inp = $(slot.inputId);
      if (inp) inp.value = '';
      const card = $(slot.cardId);
      if (card) card.classList.remove('is-ready');
      const badge = $(slot.badgeId);
      if (badge) {
        badge.textContent = 'Falta';
        badge.className = 'tab-evidencia-badge pending';
      }
      const prev = $(slot.prevId);
      if (prev) prev.innerHTML = '<span class="tab-evidencia-placeholder">Sin fotografía</span>';
      const btnLbl = $(slot.btnId);
      if (btnLbl) btnLbl.textContent = '📷 Seleccionar foto';
    });
  }

  function handleAsignarEvidenciaChange(slot, file) {
    if (!file) return;
    const mime = String(file.type || '').toLowerCase();
    const extOk = /\.(jpe?g|png|webp)$/i.test(file.name || '');
    const mimeOk = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mime) || (!mime && extOk);
    if (!mimeOk) {
      toast(`Formato no permitido para ${slot.label}. Usa únicamente JPG, PNG o WEBP.`, false);
      const inp = $(slot.inputId);
      if (inp) inp.value = '';
      return;
    }
    if (TAB_ASIG_PREVIEW_URLS[slot.key]) {
      try { URL.revokeObjectURL(TAB_ASIG_PREVIEW_URLS[slot.key]); } catch (_) {}
    }
    const url = URL.createObjectURL(file);
    TAB_ASIG_FILES[slot.key] = file;
    TAB_ASIG_PREVIEW_URLS[slot.key] = url;

    const card = $(slot.cardId);
    if (card) card.classList.add('is-ready');
    const badge = $(slot.badgeId);
    if (badge) {
      badge.textContent = '✓ Lista';
      badge.className = 'tab-evidencia-badge ready';
    }
    const prev = $(slot.prevId);
    if (prev) {
      prev.innerHTML = '';
      const img = document.createElement('img');
      img.src = url;
      img.alt = slot.label;
      prev.appendChild(img);
    }
    const btnLbl = $(slot.btnId);
    if (btnLbl) btnLbl.textContent = '🔄 Cambiar foto';
  }

  function closeTabEvidenciaLightbox() {
    const lb = $('tab-evidencia-lightbox');
    if (lb) lb.classList.add('hidden');
    if ($('tab_lightbox_img')) $('tab_lightbox_img').src = '';
    if ($('tab_lightbox_label')) $('tab_lightbox_label').textContent = '';
  }

  function openTabEvidenciaLightbox(src, label) {
    if (!src) return;
    const lb = $('tab-evidencia-lightbox');
    if (!lb) return;
    if ($('tab_lightbox_img')) $('tab_lightbox_img').src = src;
    if ($('tab_lightbox_label')) $('tab_lightbox_label').textContent = label || 'Evidencia fotográfica';
    lb.classList.remove('hidden');
  }

  let CURRENT_TAB_EVIDENCIAS_CTX = { tabletaId: 0, movId: 0 };

  function openResguardoEvidenciasPdf(tabletaId, movId) {
    if (!canViewTabletas(CURRENT_USER)) {
      toast('No tienes permiso para abrir el expediente con evidencias fotográficas.', false);
      return;
    }
    const tid = Number(tabletaId || 0);
    const mid = Number(movId || 0);
    if (!tid && !mid) {
      toast('No se encontró la referencia del resguardo con evidencias.', false);
      return;
    }
    const qs = new URLSearchParams();
    if (mid > 0) qs.set('movimiento_id', String(mid));
    qs.set('_t', String(Date.now()));
    const url = `/api/tabletas/${tid}/resguardo-evidencias-pdf?${qs.toString()}`;
    window.open(url, '_blank', 'noopener');
  }

  function openModalEvidenciasTableta({ tabletaId = 0, movId, noResguardo, nombreResguardante, folio }) {
    if (!canViewTabletas(CURRENT_USER)) {
      toast('No tienes permiso para consultar evidencias fotográficas.', false);
      return;
    }
    const mid = Number(movId || 0);
    if (!mid) {
      toast('Este resguardo no cuenta con evidencias fotográficas adjuntas.', false);
      return;
    }
    CURRENT_TAB_EVIDENCIAS_CTX = {
      tabletaId: Number(tabletaId || 0),
      movId: mid,
    };
    const btnPdfModal = $('btn-tab-evidencias-pdf');
    if (btnPdfModal) {
      btnPdfModal.classList.toggle('hidden', !canViewTabletas(CURRENT_USER));
    }
    if ($('tab_evidencias_meta')) {
      const parts = [
        noResguardo ? `<b>Tableta No. Resguardo #${Number(noResguardo)}</b>` : '<b>Evidencias de Resguardo</b>',
        nombreResguardante ? `Resguardante: <b>${escHtml(safestr(nombreResguardante))}</b>` : '',
        folio ? `Folio: <b>${escHtml(safestr(folio))}</b>` : '',
      ].filter(Boolean);
      $('tab_evidencias_meta').innerHTML = parts.join(' &nbsp;|&nbsp; ');
    }

    const mapping = [
      { id: 'tab_view_img_ine_frente', tipo: 'ine_frente', label: '1. INE — Frente (Anverso)' },
      { id: 'tab_view_img_ine_reverso', tipo: 'ine_reverso', label: '2. INE — Reverso (Parte trasera)' },
      { id: 'tab_view_img_entrega', tipo: 'entrega', label: '3. Foto de Entrega (Persona con tableta)' },
    ];
    mapping.forEach((item) => {
      const img = $(item.id);
      if (!img) return;
      const box = img.closest('.tab-viewer-img-box');
      if (box) {
        const oldErr = box.querySelector('.tab-viewer-err-msg');
        if (oldErr) oldErr.remove();
      }
      img.style.display = 'block';
      img.dataset.loaded = '0';
      img.onload = () => {
        img.dataset.loaded = '1';
      };
      img.onerror = () => {
        img.dataset.loaded = '0';
        img.style.display = 'none';
        if (box && !box.querySelector('.tab-viewer-err-msg')) {
          const msg = document.createElement('div');
          msg.className = 'tab-viewer-err-msg muted';
          msg.style.cssText = 'font-size:12px; text-align:center; padding:12px;';
          msg.textContent = 'Imagen no disponible en el servidor.';
          box.appendChild(msg);
        }
      };
      img.src = `/api/tabletas/evidencias/${mid}/${item.tipo}`;
    });

    openTabletaModal('modal-tab-evidencias');
  }

  function openModalDevolucionTableta(t) {
    if (!t) return;
    $('tab_dev_id').value = t.id;
    $('tab_dev_equipo_info').innerHTML = `
      <b>Tableta No. Resguardo #${Number(t.no_resguardo)}</b> — ${escHtml(safestr(t.marca || 'Compac'))} ${escHtml(safestr(t.modelo || 'QTab LTE'))}<br>
      <span class="muted">IMEI: <b>${escHtml(safestr(t.imei))}</b> | Serie: <b>${escHtml(safestr(t.numero_serie))}</b> | Caja: <b>${escHtml(safestr(t.no_caja || 'S/N'))}</b><br>
      Origen: <b>${escHtml(safestr(t.region))} — ${escHtml(safestr(t.oficina_programa))}</b></span>
    `;
    const regForanea = normalizeTabletaForaneaRegionFront(t.region);
    const noticeEl = $('tab_dev_remota_notice');
    const submitBtn = $('btn-tab-dev-submit');
    if (regForanea) {
      if (noticeEl) {
        noticeEl.innerHTML = `📡 <b>Firma Digital Remota (${escHtml(regForanea)}):</b> Al enviar esta devolución, se habilitará en el panel del enlace regional de <b>${escHtml(regForanea)}</b> para su firma digital. El PDF oficial y la confirmación física solo se habilitarán una vez firmada por la región.`;
        noticeEl.classList.remove('hidden');
      }
      if (submitBtn) submitBtn.textContent = `📤 Enviar a Firma Digital (${regForanea})`;
    } else {
      if (noticeEl) {
        noticeEl.innerHTML = '';
        noticeEl.classList.add('hidden');
      }
      if (submitBtn) submitBtn.textContent = '📄 Generar Vale de Devolución y Abrir PDF';
    }
    $('tab_dev_nombre').value = safestr(t.nombre_resguardante);
    $('tab_dev_cargo').value = safestr(t.cargo_resguardante) || 'Servidor de la nación';
    $('tab_dev_cargador').checked = Number(t.tiene_cargador ?? 1) === 1;
    $('tab_dev_caja').checked = Number(t.tiene_caja ?? 1) === 1;
    $('tab_dev_estatus').value = safestr(t.estatus_fisico || 'BUENO').toUpperCase();
    $('tab_dev_obs').value = safestr(t.observaciones);
    openTabletaModal('modal-tab-devolucion');
  }

  let TABLETAS_DISPONIBLES_CACHE = [];

  function syncAsignarTabletaInfoFromRow(t) {
    if (!t) {
      if ($('tab_asig_id')) $('tab_asig_id').value = '';
      if ($('tab_asig_equipo_info')) {
        $('tab_asig_equipo_info').innerHTML = '<span class="muted">Selecciona una tableta disponible de la lista superior.</span>';
      }
      return;
    }
    if ($('tab_asig_id')) $('tab_asig_id').value = t.id;
    if ($('tab_asig_select_tableta') && String($('tab_asig_select_tableta').value) !== String(t.id)) {
      $('tab_asig_select_tableta').value = String(t.id);
    }
    if ($('tab_asig_equipo_info')) {
      $('tab_asig_equipo_info').innerHTML = `
        <b>Asignación de Tableta No. Resguardo #${Number(t.no_resguardo)}</b> — ${escHtml(safestr(t.marca || 'Compac'))} ${escHtml(safestr(t.modelo || 'QTab LTE'))}<br>
        <span class="muted">IMEI: <b>${escHtml(safestr(t.imei))}</b> | Serie: <b>${escHtml(safestr(t.numero_serie))}</b> | Caja: <b>${escHtml(safestr(t.no_caja || 'S/N'))}</b></span>
      `;
    }
    if ($('tab_asig_region')) $('tab_asig_region').value = safestr(t.region || 'LA PAZ').toUpperCase();
    if ($('tab_asig_oficina')) $('tab_asig_oficina').value = safestr(t.oficina_programa || 'Delegación La Paz');
    if ($('tab_asig_cargador')) $('tab_asig_cargador').checked = Number(t.tiene_cargador ?? 1) === 1;
    if ($('tab_asig_caja')) $('tab_asig_caja').checked = Number(t.tiene_caja ?? 1) === 1;
    if ($('tab_asig_estatus')) $('tab_asig_estatus').value = safestr(t.estatus_fisico || 'BUENO').toUpperCase();
    if ($('tab_asig_obs')) $('tab_asig_obs').value = safestr(t.observaciones);
  }

  async function openModalAsignarTableta(t = null) {
    if (!canEditTabletas(CURRENT_USER)) {
      toast('Modo solo lectura: no tienes permisos para generar resguardos de tabletas.', false);
      return;
    }
    resetAsignarEvidencias();
    if ($('tab_asig_nombre')) $('tab_asig_nombre').value = '';
    if ($('tab_asig_cargo')) $('tab_asig_cargo').value = 'Servidor de la nación';

    const sel = $('tab_asig_select_tableta');
    if (sel) {
      sel.innerHTML = '<option value="">Cargando tabletas disponibles...</option>';
    }
    openTabletaModal('modal-tab-asignar');

    try {
      const res = await apiJSON('/api/tabletas?estado_asignacion=DISPONIBLE');
      const dispRows = Array.isArray(res?.data) ? res.data : [];
      TABLETAS_DISPONIBLES_CACHE = dispRows;

      if (sel) {
        if (!dispRows.length) {
          sel.innerHTML = '<option value="">No hay tabletas con estatus DISPONIBLE</option>';
        } else {
          sel.innerHTML = dispRows.map(d => {
            const label = `Resguardo #${Number(d.no_resguardo)} — ${safestr(d.marca || 'Compac')} ${safestr(d.modelo || 'QTab LTE')} (Serie: ${safestr(d.numero_serie)} | IMEI: ${safestr(d.imei)})`;
            return `<option value="${Number(d.id)}">${escHtml(label)}</option>`;
          }).join('');
        }
      }

      const target = (t && dispRows.find(d => Number(d.id) === Number(t.id))) || t || dispRows[0] || null;
      syncAsignarTabletaInfoFromRow(target);
    } catch (_) {
      syncAsignarTabletaInfoFromRow(t);
    }
  }

  async function openModalAgregarTableta() {
    if (!canEditTabletas(CURRENT_USER)) {
      toast('Modo solo lectura: no tienes permisos para agregar tabletas.', false);
      return;
    }
    let nextResg = 277;
    try {
      const maxLocal = TABLETAS_ROWS.reduce((acc, r) => Math.max(acc, Number(r.no_resguardo || 0)), 0);
      if (maxLocal > 0) nextResg = maxLocal + 1;
      const res = await apiJSON('/api/tabletas');
      const allRows = Array.isArray(res?.data) ? res.data : [];
      const maxRemote = allRows.reduce((acc, r) => Math.max(acc, Number(r.no_resguardo || 0)), 0);
      if (maxRemote >= nextResg) nextResg = maxRemote + 1;
    } catch (_) {}

    if ($('tab_add_no_resg')) $('tab_add_no_resg').value = nextResg;
    if ($('tab_add_serie')) $('tab_add_serie').value = '';
    if ($('tab_add_imei')) $('tab_add_imei').value = '';
    if ($('tab_add_marca')) $('tab_add_marca').value = 'Compac';
    if ($('tab_add_modelo')) $('tab_add_modelo').value = 'QTab LTE';
    if ($('tab_add_descripcion')) $('tab_add_descripcion').value = 'Tablet Compac';
    if ($('tab_add_region')) $('tab_add_region').value = 'LA PAZ';
    if ($('tab_add_oficina')) $('tab_add_oficina').value = 'Delegación La Paz';
    if ($('tab_add_estado_asig')) $('tab_add_estado_asig').value = 'DISPONIBLE';
    if ($('tab_add_estatus')) $('tab_add_estatus').value = 'BUENO';
    if ($('tab_add_caja_no')) $('tab_add_caja_no').value = '';
    if ($('tab_add_cargador')) $('tab_add_cargador').checked = true;
    if ($('tab_add_caja')) $('tab_add_caja').checked = true;
    if ($('tab_add_obs')) $('tab_add_obs').value = '';

    openTabletaModal('modal-tab-agregar');
  }

  function openModalEditarTableta(t) {
    if (!t) return;
    if (!canEditTabletas(CURRENT_USER)) {
      toast('Modo solo lectura: no tienes permisos para editar tabletas.', false);
      return;
    }
    const isAdm = Boolean(uiPerms().admin);
    $('tab_edit_id').value = t.id;
    $('tab_edit_no_resg').value = Number(t.no_resguardo || '');
    $('tab_edit_caja_no').value = safestr(t.no_caja);
    $('tab_edit_estatus').value = safestr(t.estatus_fisico || 'BUENO').toUpperCase();
    $('tab_edit_imei').value = safestr(t.imei);
    $('tab_edit_serie').value = safestr(t.numero_serie);
    $('tab_edit_marca').value = safestr(t.marca || 'Compac');
    $('tab_edit_modelo').value = safestr(t.modelo || 'QTab LTE');
    $('tab_edit_region').value = safestr(t.region || 'LA PAZ').toUpperCase();
    $('tab_edit_oficina').value = safestr(t.oficina_programa || 'Delegación La Paz');
    $('tab_edit_nombre').value = safestr(t.nombre_resguardante);
    $('tab_edit_cargo').value = safestr(t.cargo_resguardante || 'Servidor de la nación');
    $('tab_edit_cargador').checked = Number(t.tiene_cargador ?? 1) === 1;
    $('tab_edit_caja').checked = Number(t.tiene_caja ?? 1) === 1;
    $('tab_edit_obs').value = safestr(t.observaciones);

    ['tab_edit_no_resg', 'tab_edit_imei', 'tab_edit_serie'].forEach(fid => {
      const inp = $(fid);
      if (inp) {
        inp.disabled = !isAdm;
        inp.readOnly = !isAdm;
      }
    });
    if ($('tab_edit_admin_only_note')) {
      $('tab_edit_admin_only_note').classList.toggle('hidden', isAdm);
    }
    openTabletaModal('modal-tab-editar');
  }

  async function loadBitacoraTabletas() {
    const tbody = $('tab_bit_tbody');
    const meta = $('tab_bit_meta');
    if (!tbody) return;
    const q = safestr($('tab_bit_filter_q')?.value);
    const accion = safestr($('tab_bit_filter_accion')?.value);
    const usuario = safestr($('tab_bit_filter_usuario')?.value);
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (accion) params.set('accion', accion);
    if (usuario) params.set('usuario', usuario);

    tbody.innerHTML = '<tr><td colspan="6" class="muted">Cargando bitácora de tabletas...</td></tr>';
    try {
      const res = await apiJSON(`/api/tabletas/bitacora?${params.toString()}`);
      const rows = Array.isArray(res?.data) ? res.data : [];
      if (meta) meta.textContent = `${rows.length} movimiento${rows.length === 1 ? '' : 's'}`;
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="muted">Sin registros en la bitácora con los filtros actuales.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(r => {
        const fecha = r.created_at ? new Date(r.created_at).toLocaleString('es-MX') : '-';
        const resg = r.no_resguardo ? `#${Number(r.no_resguardo)}` : '-';
        const imeiSerie = (r.imei || r.numero_serie)
          ? `IMEI: ${escHtml(safestr(r.imei || '-'))}<br><span class="muted" style="font-size:11px;">Serie: ${escHtml(safestr(r.numero_serie || '-'))}</span>`
          : '-';
        const evMovId = Number(r.evidencias_mov_id || 0);
        const tabIdBit = Number(r.tableta_id || 0);
        const canViewEvidBit = canViewTabletas(CURRENT_USER) && r.tiene_evidencias && evMovId > 0;
        const evBtn = canViewEvidBit
          ? `<div style="margin-top:5px; display:flex; flex-wrap:wrap; gap:4px;">
               <button type="button" class="mini btn-tab-evidencias" data-id="${tabIdBit}" data-mov="${evMovId}" data-resg="${Number(r.no_resguardo || 0)}" data-nombre="" data-folio="">📷 Ver evidencias</button>
               <button type="button" class="mini btn-tab-evidencias-pdf" data-id="${tabIdBit}" data-mov="${evMovId}" title="Vista previa / imprimir Resguardo con Anexo Fotográfico (2 páginas)">🖨️ Resguardo + Fotos</button>
             </div>`
          : '';
        return `<tr>
          <td style="white-space:nowrap; font-size:12px;">${escHtml(fecha)}</td>
          <td><b>${escHtml(safestr(r.usuario || '-'))}</b></td>
          <td><span class="status-badge" style="font-size:11px;">${escHtml(safestr(r.accion || '-'))}</span></td>
          <td style="text-align:center;"><b>${escHtml(resg)}</b></td>
          <td style="font-size:12px;">${imeiSerie}</td>
          <td style="font-size:12px;">${escHtml(safestr(r.detalles || '-'))}${evBtn}</td>
        </tr>`;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted" style="color:var(--danger);">${escHtml(e.message || 'Error al cargar bitácora')}</td></tr>`;
      if (!handleAuthError(e)) toast(e.message || 'Error al cargar bitácora de tabletas', false);
    }
  }

  function renderTabletasTable(rows) {
    const tbody = $('tab_tbody');
    if (!tbody) return;
    const canEdit = canEditTabletas(CURRENT_USER);
    const canViewTab = canViewTabletas(CURRENT_USER);

    if (!rows || !rows.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="muted" style="text-align:center; padding:18px;">No hay tabletas en esta pestaña con los filtros aplicados.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(t => {
      const id = Number(t.id);
      const estadoAsig = safestr(t.estado_asignacion).toUpperCase();
      const fisico = safestr(t.estatus_fisico || 'BUENO').toUpperCase();
      let fisicoCls = 'bueno';
      if (fisico === 'INCOMPLETO') fisicoCls = 'incompleto';
      if (fisico.includes('DAÑ') || fisico.includes('DAN')) fisicoCls = 'danado';

      const accBadges = `
        <span class="badge-tableta-fisico ${fisicoCls}">${escHtml(fisico)}</span>
        <div style="font-size:11px; margin-top:4px; color:#475569;">
          Cargador: <b>${Number(t.tiene_cargador ?? 1) ? 'Sí' : 'No'}</b> | Caja: <b>${Number(t.tiene_caja ?? 1) ? 'Sí' : 'No'}</b>
        </div>
      `;

      const evMovId = Number(t.evidencias_mov_id || 0);
      const hasEvid = canViewTab && Number(t.tiene_evidencias) === 1 && evMovId > 0;
      const evidBtnHtml = hasEvid
        ? `<button type="button" class="mini btn-tab-evidencias" data-id="${id}" data-mov="${evMovId}" data-resg="${Number(t.no_resguardo)}" data-nombre="${escHtml(safestr(t.nombre_resguardante))}" data-folio="${escHtml(safestr(t.ultimo_asig_folio || ''))}" title="Ver 3 fotografías de evidencia del resguardo">📷 Evidencias</button>
           <button type="button" class="mini btn-tab-evidencias-pdf" data-id="${id}" data-mov="${evMovId}" title="Vista previa / imprimir Resguardo con Anexo Fotográfico (2 páginas)">🖨️ Resguardo + Fotos</button>`
        : '';

      let resgHtml = '';
      if (estadoAsig === 'DISPONIBLE') {
        resgHtml = Number(t.sin_resguardo_previo) === 1
          ? `<span class="badge-tableta-excel-rojo">🔴 Proveniente de Excel sin resguardo (17 en rojo)</span>`
          : `<span class="badge-tableta-devuelta">📦 Disponible en almacén</span>`;
      } else if (estadoAsig === 'DEVOLUCION_PENDIENTE') {
        const devNombre = safestr(t.nombre_resguardante || t.devolucion_nombre_persona || '-');
        const folioTxt = safestr(t.devolucion_folio || '-');
        const estFirma = safestr(t.devolucion_estado_firma || 'NO_APLICA').toUpperCase();
        const regFirma = safestr(t.devolucion_region_firma || t.region || '');
        if (estFirma === 'PENDIENTE_FIRMA') {
          resgHtml = `
            <div><b>${escHtml(devNombre)}</b></div>
            <div style="font-size:11px; color:#64748b;">Folio: <b>${escHtml(folioTxt)}</b></div>
            <div style="margin-top:4px;"><span class="badge-tab-firma-pendiente">⏳ Esperando firma (${escHtml(regFirma)})</span></div>
          `;
        } else if (estFirma === 'RECHAZADO') {
          const mot = safestr(t.devolucion_motivo_rechazo || 'Sin motivo especificado');
          resgHtml = `
            <div><b>${escHtml(devNombre)}</b></div>
            <div style="font-size:11px; color:#64748b;">Folio: <b>${escHtml(folioTxt)}</b></div>
            <div style="margin-top:4px;"><span class="badge-tab-firma-rechazado">⚠️ Rechazada por región</span></div>
            <div style="font-size:11px; color:#991b1b; margin-top:3px; line-height:1.3;"><b>Motivo:</b> ${escHtml(mot)}</div>
          `;
        } else if (estFirma === 'FIRMADO') {
          const fechaFirmaTxt = t.devolucion_fecha_firma ? new Date(t.devolucion_fecha_firma).toLocaleString('es-MX') : '';
          const selloTxt = safestr(t.devolucion_folio_firma || '');
          resgHtml = `
            <div><b>${escHtml(devNombre)}</b></div>
            <div style="font-size:11px; color:#64748b;">Folio: <b>${escHtml(folioTxt)}</b></div>
            <div style="margin-top:4px;"><span class="badge-tab-firma-firmado">✓ Firmado Digitalmente</span></div>
            <div style="font-size:11px; color:#166534; margin-top:3px; line-height:1.3;">
              ${selloTxt ? `Sello: <b>${escHtml(selloTxt)}</b>` : ''}${fechaFirmaTxt ? `<br>${escHtml(fechaFirmaTxt)}` : ''}
            </div>
          `;
        } else {
          resgHtml = `
            <div><b>${escHtml(devNombre)}</b></div>
            <div style="font-size:11px; color:#b45309; font-weight:700;">⏳ Vale Devolución Folio: ${escHtml(folioTxt)}</div>
          `;
        }
      } else if (estadoAsig === 'EN_PRESTAMO_PROVISIONAL') {
        const nom = safestr(t.nombre_resguardante || 'PRÉSTAMO PROVISIONAL');
        resgHtml = `
          <div><b>${escHtml(nom)}</b></div>
          <div style="font-size:11px; color:#1d4ed8; font-weight:700;">🔄 En Préstamo Provisional (Operativo)</div>
        `;
      } else {
        const nom = safestr(t.nombre_resguardante);
        const isMissing = !nom || ['RESGUARDO FISICO', 'NO TIENE TABLETA', 'DELEGACION'].includes(nom.toUpperCase());
        resgHtml = isMissing
          ? `<span style="color:#b45309; font-weight:700;">${escHtml(nom || 'Sin nombre asignado')}</span><div class="muted" style="font-size:11px;">Pendiente de nombre</div>`
          : `<b>${escHtml(nom)}</b><div class="muted" style="font-size:11px;">${escHtml(safestr(t.cargo_resguardante || 'Servidor de la nación'))}</div>`;
      }

      let actionsHtml = '';
      if (estadoAsig === 'EN_RESGUARDO') {
        actionsHtml = `
          <div style="display:flex; flex-wrap:wrap; gap:4px;">
            <button type="button" class="mini btn-tab-pdf-resg" data-id="${id}" title="Descargar Resguardo Personal PDF">📄 Resguardo PDF</button>
            ${evidBtnHtml}
            ${canEdit ? `<button type="button" class="mini btn-tab-dev" data-id="${id}" title="Generar Vale de Devolución">📤 Devolución</button>` : ''}
            ${canEdit ? `<button type="button" class="mini btn-tab-edit" data-id="${id}" title="Editar datos de tableta">✏️</button>` : ''}
          </div>
        `;
      } else if (estadoAsig === 'DEVOLUCION_PENDIENTE') {
        const movId = Number(t.devolucion_mov_id || 0);
        const estFirma = safestr(t.devolucion_estado_firma || 'NO_APLICA').toUpperCase();
        if (estFirma === 'PENDIENTE_FIRMA') {
          actionsHtml = `
            <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center;">
              ${canEdit && movId ? `<button type="button" class="mini btn-tab-cancel-dev" data-mov="${movId}" data-resg="${Number(t.no_resguardo)}" style="color:#b91c1c; border-color:#fca5a5;">❌ Cancelar solicitud</button>` : `<span class="muted" style="font-size:11.5px;">Esperando firma</span>`}
              ${evidBtnHtml}
            </div>
          `;
        } else if (estFirma === 'RECHAZADO') {
          actionsHtml = `
            <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center;">
              ${canEdit && movId ? `<button type="button" class="mini btn-tab-cancel-dev" data-mov="${movId}" data-resg="${Number(t.no_resguardo)}" style="background:#fef2f2; color:#991b1b; border-color:#f87171; font-weight:600;">↩️ Cancelar y Corregir</button>` : `<span class="muted" style="font-size:11.5px;">Rechazada por región</span>`}
              ${evidBtnHtml}
            </div>
          `;
        } else if (estFirma === 'FIRMADO') {
          actionsHtml = `
            <div style="display:flex; flex-wrap:wrap; gap:4px;">
              ${canEdit && movId ? `<button type="button" class="mini btn-tab-pdf-mov" data-mov="${movId}">📄 Descargar PDF Firmado</button>` : ''}
              ${canEdit && movId ? `<button type="button" class="mini btn-primary btn-tab-confirm-dev" data-mov="${movId}" data-resg="${Number(t.no_resguardo)}">✅ Confirmar de Recibido</button>` : ''}
              ${evidBtnHtml}
              ${canEdit ? `<button type="button" class="mini btn-tab-edit" data-id="${id}" title="Editar datos">✏️</button>` : ''}
            </div>
          `;
        } else {
          actionsHtml = `
            <div style="display:flex; flex-wrap:wrap; gap:4px;">
              ${canEdit && movId ? `<button type="button" class="mini btn-tab-pdf-mov" data-mov="${movId}">📄 Reimprimir Vale</button>` : ''}
              ${canEdit && movId ? `<button type="button" class="mini btn-primary btn-tab-confirm-dev" data-mov="${movId}" data-resg="${Number(t.no_resguardo)}">✅ Confirmar Recepción Física</button>` : ''}
              ${evidBtnHtml}
              ${canEdit ? `<button type="button" class="mini btn-tab-edit" data-id="${id}" title="Editar datos">✏️</button>` : ''}
            </div>
          `;
        }
      } else if (estadoAsig === 'EN_PRESTAMO_PROVISIONAL') {
        actionsHtml = `
          <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center;">
            <span class="status-badge status-prestamo" style="font-size:11px;">En Vale Provisional</span>
            ${canEdit ? `<button type="button" class="mini btn-tab-edit" data-id="${id}" title="Editar datos">✏️</button>` : ''}
          </div>
        `;
      } else {
        actionsHtml = canEdit
          ? `
            <div style="display:flex; flex-wrap:wrap; gap:4px;">
              <button type="button" class="mini btn-primary btn-tab-asig" data-id="${id}">➕ Asignar y Generar Resguardo</button>
              <button type="button" class="mini btn-tab-edit" data-id="${id}" title="Editar datos">✏️</button>
            </div>
          `
          : `<span class="muted" style="font-size:11.5px;">Solo lectura</span>`;
      }

      return `<tr>
        <td><b>#${Number(t.no_resguardo)}</b></td>
        <td>${escHtml(safestr(t.no_caja || '-'))}</td>
        <td>
          <b>${escHtml(safestr(t.region))}</b>
          <div class="muted" style="font-size:11.5px;">${escHtml(safestr(t.oficina_programa))}</div>
        </td>
        <td>${resgHtml}</td>
        <td>
          <b>${escHtml(safestr(t.marca || 'Compac'))}</b>
          <div class="muted" style="font-size:11.5px;">${escHtml(safestr(t.modelo || 'QTab LTE'))}</div>
        </td>
        <td style="font-family:monospace; font-size:12px;">${escHtml(safestr(t.imei))}</td>
        <td style="font-family:monospace; font-size:12px;">${escHtml(safestr(t.numero_serie))}</td>
        <td>${accBadges}</td>
        <td style="font-size:12px; max-width:200px;">${escHtml(safestr(t.observaciones || '-'))}</td>
        <td>${actionsHtml}</td>
      </tr>`;
    }).join('');
  }

  async function loadTabletasModule() {
    bindTabletasListeners();
    const tbody = $('tab_tbody');
    const meta = $('tab_meta');
    if (!tbody) return;

    const canViewTab = canViewTabletas(CURRENT_USER);
    const canEditTab = canEditTabletas(CURRENT_USER);
    if ($('btn-tab-agregar')) $('btn-tab-agregar').classList.toggle('hidden', !canEditTab);
    if ($('btn-tab-nuevo-resguardo')) $('btn-tab-nuevo-resguardo').classList.toggle('hidden', !canEditTab);
    if ($('btn-tab-importar-excel')) $('btn-tab-importar-excel').classList.toggle('hidden', !canEditTab);
    if ($('btn-tab-bitacora')) $('btn-tab-bitacora').classList.toggle('hidden', !canViewTab);

    const region = safestr($('tab_filter_region')?.value);
    const oficina = safestr($('tab_filter_oficina')?.value);
    const filtroExtra = safestr($('tab_filter_extra')?.value);
    const q = safestr($('tab_filter_q')?.value);

    const params = new URLSearchParams();
    params.set('estado_asignacion', TABLETAS_ACTIVE_TAB);
    if (region) params.set('region', region);
    if (oficina) params.set('oficina_programa', oficina);
    if (filtroExtra) params.set('filtro_extra', filtroExtra);
    if (q) params.set('q', q);

    tbody.innerHTML = '<tr><td colspan="10" class="muted" style="text-align:center; padding:18px;">Cargando tabletas...</td></tr>';

    try {
      const res = await apiJSON(`/api/tabletas?${params.toString()}`);
      const k = res?.kpis || {};
      TABLETAS_ROWS = Array.isArray(res?.data) ? res.data : [];

      if ($('kpi-tab-total')) $('kpi-tab-total').textContent = Number(k.total || 0);
      if ($('kpi-tab-resguardo')) $('kpi-tab-resguardo').textContent = Number(k.en_resguardo || 0);
      if ($('kpi-tab-devolucion')) $('kpi-tab-devolucion').textContent = Number(k.devolucion_pendiente || 0);
      if ($('kpi-tab-disponibles')) $('kpi-tab-disponibles').textContent = Number(k.disponibles || 0);

      if ($('tab-count-resguardo')) $('tab-count-resguardo').textContent = Number(k.en_resguardo || 0);
      if ($('tab-count-devolucion')) $('tab-count-devolucion').textContent = Number(k.devolucion_pendiente || 0);
      if ($('tab-count-disponible')) $('tab-count-disponible').textContent = Number(k.disponibles || 0);
      if ($('tab-count-provisional')) $('tab-count-provisional').textContent = Number(k.en_prestamo_provisional || 0);

      if (meta) {
        meta.textContent = `Mostrando ${TABLETAS_ROWS.length} tableta${TABLETAS_ROWS.length === 1 ? '' : 's'} en esta vista`;
      }
      renderTabletasTable(TABLETAS_ROWS);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="10" class="muted" style="color:var(--danger); text-align:center; padding:18px;">${escHtml(e.message || 'Error al cargar tabletas')}</td></tr>`;
      if (!handleAuthError(e)) toast(e.message || 'Error al cargar tabletas', false);
    }
  }

  function bindTabletasListeners() {
    if (TABLETAS_LISTENERS_BOUND) return;
    TABLETAS_LISTENERS_BOUND = true;

    document.querySelectorAll('#view-tabletas .tab-pill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#view-tabletas .tab-pill-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        TABLETAS_ACTIVE_TAB = btn.dataset.tab || 'EN_RESGUARDO';
        loadTabletasModule();
      });
    });

    $('tab_filter_region')?.addEventListener('change', () => {
      syncTabletasOficinaFilterOptions();
      loadTabletasModule();
    });
    $('tab_filter_oficina')?.addEventListener('change', () => loadTabletasModule());
    $('tab_filter_extra')?.addEventListener('change', () => loadTabletasModule());
    $('tab_filter_q')?.addEventListener('input', () => loadTabletasModule());
    $('btn-tab-refresh')?.addEventListener('click', () => loadTabletasModule());
    $('btn-tab-agregar')?.addEventListener('click', () => openModalAgregarTableta());
    $('btn-tab-nuevo-resguardo')?.addEventListener('click', () => openModalAsignarTableta(null));

    $('tab_asig_select_tableta')?.addEventListener('change', (ev) => {
      const selId = Number(ev.target.value || 0);
      const found = TABLETAS_DISPONIBLES_CACHE.find(d => Number(d.id) === selId) || TABLETAS_ROWS.find(d => Number(d.id) === selId) || null;
      syncAsignarTabletaInfoFromRow(found);
    });

    // Delegación de eventos en tabla
    $('tab_tbody')?.addEventListener('click', async (ev) => {
      const btnResgPdf = ev.target.closest('.btn-tab-pdf-resg');
      if (btnResgPdf) {
        const id = Number(btnResgPdf.dataset.id);
        window.open(`/api/tabletas/${id}/resguardo-pdf?_t=${Date.now()}`, '_blank', 'noopener');
        return;
      }

      const btnMovPdf = ev.target.closest('.btn-tab-pdf-mov');
      if (btnMovPdf) {
        const movId = Number(btnMovPdf.dataset.mov);
        window.open(`/api/tabletas/movimientos/${movId}/pdf?_t=${Date.now()}`, '_blank', 'noopener');
        return;
      }

      const btnDev = ev.target.closest('.btn-tab-dev');
      if (btnDev) {
        const id = Number(btnDev.dataset.id);
        const row = TABLETAS_ROWS.find(x => Number(x.id) === id);
        openModalDevolucionTableta(row);
        return;
      }

      const btnAsig = ev.target.closest('.btn-tab-asig');
      if (btnAsig) {
        const id = Number(btnAsig.dataset.id);
        const row = TABLETAS_ROWS.find(x => Number(x.id) === id);
        openModalAsignarTableta(row);
        return;
      }

      const btnEdit = ev.target.closest('.btn-tab-edit');
      if (btnEdit) {
        const id = Number(btnEdit.dataset.id);
        const row = TABLETAS_ROWS.find(x => Number(x.id) === id);
        openModalEditarTableta(row);
        return;
      }

      const btnEvid = ev.target.closest('.btn-tab-evidencias');
      if (btnEvid) {
        openModalEvidenciasTableta({
          tabletaId: Number(btnEvid.dataset.id || 0),
          movId: Number(btnEvid.dataset.mov || 0),
          noResguardo: Number(btnEvid.dataset.resg || 0),
          nombreResguardante: btnEvid.dataset.nombre || '',
          folio: btnEvid.dataset.folio || '',
        });
        return;
      }

      const btnEvidPdf = ev.target.closest('.btn-tab-evidencias-pdf');
      if (btnEvidPdf) {
        openResguardoEvidenciasPdf(
          Number(btnEvidPdf.dataset.id || 0),
          Number(btnEvidPdf.dataset.mov || 0)
        );
        return;
      }

      const btnCancelDev = ev.target.closest('.btn-tab-cancel-dev');
      if (btnCancelDev) {
        const movId = Number(btnCancelDev.dataset.mov || 0);
        const noResg = Number(btnCancelDev.dataset.resg || 0);
        if (!movId) return;
        if (!confirm(`¿Cancelar la solicitud de devolución de la Tableta #${noResg}?\n\nLa tableta regresará a En Resguardo conservando su región y resguardante para corregir y reenviar si es necesario.`)) {
          return;
        }
        try {
          const r = await apiJSON(`/api/tabletas/devoluciones/${movId}/cancelar`, { method: 'POST' });
          toast(r.message || 'Solicitud de devolución cancelada', true);
          loadTabletasModule();
          pollTabletasBadge();
        } catch (err) {
          if (!handleAuthError(err)) toast(err.message || 'Error al cancelar solicitud de devolución', false);
        }
        return;
      }

      const btnConfirmDev = ev.target.closest('.btn-tab-confirm-dev');
      if (btnConfirmDev) {
        const movId = Number(btnConfirmDev.dataset.mov);
        const noResg = Number(btnConfirmDev.dataset.resg || 0);
        if (!confirm(`¿Confirmas que recibiste físicamente en almacén la Tableta #${noResg}?\n\nPasará a estatus DISPONIBLE para poder ser asignada a un nuevo resguardante.`)) {
          return;
        }
        try {
          const r = await apiJSON(`/api/tabletas/movimientos/${movId}/confirmar-devolucion`, { method: 'PUT' });
          toast(r.message || 'Recepción confirmada correctamente', true);
          loadTabletasModule();
          pollTabletasBadge();
        } catch (err) {
          if (!handleAuthError(err)) toast(err.message || 'Error al confirmar recepción', false);
        }
      }
    });

    // Delegación para botón de evidencias dentro del Log de Movimientos (Tabletas)
    $('tab_bit_tbody')?.addEventListener('click', (ev) => {
      const btnEvidPdf = ev.target.closest('.btn-tab-evidencias-pdf');
      if (btnEvidPdf) {
        openResguardoEvidenciasPdf(
          Number(btnEvidPdf.dataset.id || 0),
          Number(btnEvidPdf.dataset.mov || 0)
        );
        return;
      }
      const btnEvid = ev.target.closest('.btn-tab-evidencias');
      if (!btnEvid) return;
      openModalEvidenciasTableta({
        tabletaId: Number(btnEvid.dataset.id || 0),
        movId: Number(btnEvid.dataset.mov || 0),
        noResguardo: Number(btnEvid.dataset.resg || 0),
        nombreResguardante: btnEvid.dataset.nombre || '',
        folio: btnEvid.dataset.folio || '',
      });
    });

    // Botón dentro del modal de evidencias para abrir PDF de 2 páginas (Resguardo + Anexo Fotográfico)
    $('btn-tab-evidencias-pdf')?.addEventListener('click', () => {
      openResguardoEvidenciasPdf(
        CURRENT_TAB_EVIDENCIAS_CTX.tabletaId,
        CURRENT_TAB_EVIDENCIAS_CTX.movId
      );
    });

    // Listeners de carga de 3 fotografías obligatorias en Modal Asignar
    TAB_EVIDENCIA_SLOTS.forEach((slot) => {
      $(slot.inputId)?.addEventListener('change', (ev) => {
        const file = ev.target?.files?.[0];
        if (!file) return;
        handleAsignarEvidenciaChange(slot, file);
      });
    });

    // Lightbox del visor de evidencias fotográficas
    $('tab_evidencias_gallery')?.addEventListener('click', (ev) => {
      const box = ev.target.closest('.tab-viewer-img-box');
      if (!box) return;
      const img = box.querySelector('img');
      if (!img || img.dataset.loaded !== '1' || !img.src) return;
      openTabEvidenciaLightbox(img.src, box.dataset.lightboxLabel || img.alt || 'Evidencia');
    });
    $('btn-close-tab-lightbox')?.addEventListener('click', () => closeTabEvidenciaLightbox());
    $('tab-evidencia-lightbox')?.addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget) closeTabEvidenciaLightbox();
    });

    // Botón Log de Movimientos (Tabletas) - Visible para Admin, Luis Eduardo, Jorge y Rodrigo
    $('btn-tab-bitacora')?.addEventListener('click', () => {
      openTabletaModal('modal-tab-bitacora');
      loadBitacoraTabletas();
    });
    $('btn-tab-bitacora-filtrar')?.addEventListener('click', () => loadBitacoraTabletas());
    $('tab_bit_filter_accion')?.addEventListener('change', () => loadBitacoraTabletas());

    // Botón Importar Nombres (Excel)
    $('btn-tab-importar-excel')?.addEventListener('click', () => {
      $('tab_excel_file_input')?.click();
    });

    $('tab_excel_file_input')?.addEventListener('change', async (ev) => {
      const file = ev.target?.files?.[0];
      if (!file) return;
      try {
        const fd = new FormData();
        fd.append('archivo', file);
        toast('Procesando archivo Excel e importando nombres...', true);
        const res = await api('/api/tabletas/importar-nombres', {
          method: 'POST',
          body: fd
        });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          throw new Error(json.error || 'Error al importar nombres');
        }
        toast(json.message || 'Nombres importados correctamente', true);
        loadTabletasModule();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message || 'Error al importar archivo Excel', false);
      } finally {
        ev.target.value = '';
      }
    });

    // Cerrar modales de tabletas
    ['modal-tab-devolucion', 'modal-tab-asignar', 'modal-tab-editar', 'modal-tab-bitacora', 'modal-tab-agregar', 'modal-tab-evidencias'].forEach(mid => {
      $(mid)?.addEventListener('click', (ev) => {
        if (ev.target === ev.currentTarget || ev.target.closest('[data-close-modal]')) {
          closeTabletaModal(mid);
        }
      });
    });

    // Submit Modal Agregar Nueva Tableta / Activo
    $('form-tab-agregar')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const numero_serie = safestr($('tab_add_serie')?.value);
      const imei = safestr($('tab_add_imei')?.value);
      if (!numero_serie || !imei) {
        toast('El Número de Serie y el IMEI son obligatorios', false);
        return;
      }
      const estadoInicial = safestr($('tab_add_estado_asig')?.value || 'DISPONIBLE').toUpperCase();
      try {
        const payload = {
          no_resguardo: Number($('tab_add_no_resg')?.value) || undefined,
          numero_serie,
          imei,
          marca: safestr($('tab_add_marca')?.value) || 'Compac',
          modelo: safestr($('tab_add_modelo')?.value) || 'QTab LTE',
          descripcion: safestr($('tab_add_descripcion')?.value) || 'Tablet Compac',
          region: safestr($('tab_add_region')?.value || 'LA PAZ'),
          oficina_programa: safestr($('tab_add_oficina')?.value || 'Delegación La Paz'),
          estado_asignacion: estadoInicial,
          estatus_fisico: safestr($('tab_add_estatus')?.value || 'BUENO'),
          no_caja: safestr($('tab_add_caja_no')?.value),
          tiene_cargador: $('tab_add_cargador')?.checked ? 1 : 0,
          tiene_caja: $('tab_add_caja')?.checked ? 1 : 0,
          observaciones: safestr($('tab_add_obs')?.value),
        };
        const r = await apiJSON('/api/tabletas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        closeTabletaModal('modal-tab-agregar');
        toast(r.message || 'Nueva tableta agregada exitosamente', true);

        // Si se dio de alta como DISPONIBLE, activar la pestaña DISPONIBLE y refrescar selectores de inmediato
        if (estadoInicial === 'DISPONIBLE') {
          TABLETAS_ACTIVE_TAB = 'DISPONIBLE';
          document.querySelectorAll('#view-tabletas .tab-pill-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === 'DISPONIBLE');
          });
        }
        await loadTabletasModule();
        if (typeof loadVpCatalogo === 'function') {
          try { await loadVpCatalogo(); } catch (_) {}
        }
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message || 'Error al agregar nueva tableta', false);
      }
    });

    // Submit Modal Devolución
    $('form-tab-devolucion')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const id = Number($('tab_dev_id')?.value || 0);
      const nombre_persona = safestr($('tab_dev_nombre')?.value);
      if (!nombre_persona) {
        toast('Indica el nombre de quien entrega/devuelve la tableta', false);
        return;
      }
      const submitBtn = $('btn-tab-dev-submit');
      const prevBtnText = submitBtn ? submitBtn.textContent : '';
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '⏳ Procesando...';
      }
      try {
        const payload = {
          nombre_persona,
          cargo_persona: safestr($('tab_dev_cargo')?.value) || 'Servidor de la nación',
          tiene_cargador: $('tab_dev_cargador')?.checked ? 1 : 0,
          tiene_caja: $('tab_dev_caja')?.checked ? 1 : 0,
          estatus_fisico: safestr($('tab_dev_estatus')?.value || 'BUENO'),
          observaciones: safestr($('tab_dev_obs')?.value),
        };
        const r = await apiJSON(`/api/tabletas/${id}/generar-devolucion`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        closeTabletaModal('modal-tab-devolucion');
        toast(r.message || 'Vale de devolución generado', true);
        if (!r.requiere_firma_remota && r.pdf_url) {
          window.open(r.pdf_url, '_blank');
        }
        loadTabletasModule();
        pollTabletasBadge();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message || 'Error al generar vale de devolución', false);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = prevBtnText || '📄 Generar Vale de Devolución y Abrir PDF';
        }
      }
    });

    // Submit Modal Asignar y Generar Resguardo (con 3 fotografías obligatorias comprimidas)
    $('form-tab-asignar')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const id = Number($('tab_asig_select_tableta')?.value || $('tab_asig_id')?.value || 0);
      if (!id) {
        toast('Selecciona una tableta disponible para asignar el resguardo', false);
        return;
      }
      const nombre_resguardante = safestr($('tab_asig_nombre')?.value);
      if (!nombre_resguardante) {
        toast('El nombre completo del nuevo resguardante es obligatorio', false);
        return;
      }

      const missingSlots = TAB_EVIDENCIA_SLOTS.filter((slot) => !TAB_ASIG_FILES[slot.key]);
      if (missingSlots.length > 0) {
        const faltantesTxt = missingSlots.map((s) => s.label).join(', ');
        toast(`Debes adjuntar las 3 fotografías obligatorias antes de asignar. Faltan: ${faltantesTxt}.`, false);
        return;
      }

      const submitBtn = $('btn-tab-asig-submit');
      const prevBtnText = submitBtn ? submitBtn.textContent : '';
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '⏳ Optimizando y subiendo evidencias...';
      }

      try {
        const [blobFrente, blobReverso, blobEntrega] = await Promise.all([
          compressImageToJpegBlob(TAB_ASIG_FILES.ine_frente, 1280, 0.78),
          compressImageToJpegBlob(TAB_ASIG_FILES.ine_reverso, 1280, 0.78),
          compressImageToJpegBlob(TAB_ASIG_FILES.entrega, 1280, 0.78),
        ]);

        const fd = new FormData();
        fd.append('nombre_resguardante', nombre_resguardante);
        fd.append('cargo_resguardante', safestr($('tab_asig_cargo')?.value) || 'Servidor de la nación');
        fd.append('region', safestr($('tab_asig_region')?.value || 'LA PAZ'));
        fd.append('oficina_programa', safestr($('tab_asig_oficina')?.value || 'Delegación La Paz'));
        fd.append('tiene_cargador', $('tab_asig_cargador')?.checked ? '1' : '0');
        fd.append('tiene_caja', $('tab_asig_caja')?.checked ? '1' : '0');
        fd.append('estatus_fisico', safestr($('tab_asig_estatus')?.value || 'BUENO'));
        fd.append('observaciones', safestr($('tab_asig_obs')?.value));
        fd.append('foto_ine_frente', blobFrente, 'ine_frente.jpg');
        fd.append('foto_ine_reverso', blobReverso, 'ine_reverso.jpg');
        fd.append('foto_entrega', blobEntrega, 'entrega.jpg');

        const r = await apiJSON(`/api/tabletas/${id}/generar-resguardo`, {
          method: 'POST',
          body: fd,
        });
        closeTabletaModal('modal-tab-asignar');
        toast(r.message || 'Resguardo personal y evidencias registrados correctamente', true);
        if (r.pdf_url) window.open(r.pdf_url, '_blank');
        loadTabletasModule();
        if (typeof loadVpCatalogo === 'function') {
          try { await loadVpCatalogo(); } catch (_) {}
        }
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message || 'Error al generar resguardo', false);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = prevBtnText || '📄 Asignar y Generar PDF de Resguardo';
        }
      }
    });

    // Submit Modal Editar Tableta
    $('form-tab-editar')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const id = Number($('tab_edit_id')?.value || 0);
      try {
        const payload = {
          no_resguardo: Number($('tab_edit_no_resg')?.value),
          no_caja: safestr($('tab_edit_caja_no')?.value),
          estatus_fisico: safestr($('tab_edit_estatus')?.value || 'BUENO'),
          imei: safestr($('tab_edit_imei')?.value),
          numero_serie: safestr($('tab_edit_serie')?.value),
          marca: safestr($('tab_edit_marca')?.value) || 'Compac',
          modelo: safestr($('tab_edit_modelo')?.value) || 'QTab LTE',
          region: safestr($('tab_edit_region')?.value || 'LA PAZ'),
          oficina_programa: safestr($('tab_edit_oficina')?.value || 'Delegación La Paz'),
          nombre_resguardante: safestr($('tab_edit_nombre')?.value),
          cargo_resguardante: safestr($('tab_edit_cargo')?.value) || 'Servidor de la nación',
          tiene_cargador: $('tab_edit_cargador')?.checked ? 1 : 0,
          tiene_caja: $('tab_edit_caja')?.checked ? 1 : 0,
          observaciones: safestr($('tab_edit_obs')?.value),
        };
        const r = await apiJSON(`/api/tabletas/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        closeTabletaModal('modal-tab-editar');
        toast(r.message || 'Tableta actualizada correctamente', true);
        loadTabletasModule();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message || 'Error al actualizar tableta', false);
      }
    });
  }

  // ==========================================================================
  // FIRMAS DIGITALES REMOTAS DE DEVOLUCIONES DE TABLETAS (REGIONES FORÁNEAS)
  // ==========================================================================
  let FIRMAS_TABLETAS_ROWS = [];
  let FIRMAS_TABLETAS_CAN_SIGN = false;
  let FIRMAS_TABLETAS_LISTENERS_BOUND = false;
  let TAB_FIRMA_SIG_PAD = null;

  function openModalFirmarDevolucionTab(row, openRejectMode = false) {
    if (!row) return;
    if (!FIRMAS_TABLETAS_CAN_SIGN) {
      toast('Solo los enlaces regionales autorizados (Los Cabos, Mulegé, Comondú) pueden firmar o reportar devoluciones.', false);
      return;
    }
    if (!TAB_FIRMA_SIG_PAD) {
      TAB_FIRMA_SIG_PAD = createSignaturePadController({
        canvasId: 'tab_firma_canvas',
        clearBtnId: 'btn-clear-firma-tab',
        uploadInputId: null,
        statusId: 'tab_firma_status_badge',
      });
    }
    $('tab_firma_mov_id').value = Number(row.movimiento_id || 0);
    const fechaTxt = row.fecha_movimiento ? new Date(row.fecha_movimiento).toLocaleString('es-MX') : '-';
    $('tab_firma_equipo_info').innerHTML = `
      <b>Tableta No. Resguardo #${Number(row.no_resguardo)}</b> &nbsp;|&nbsp; Folio: <b>${escHtml(safestr(row.folio || '-'))}</b><br>
      Resguardante: <b>${escHtml(safestr(row.nombre_resguardante || '-'))}</b> <span class="muted">(${escHtml(safestr(row.cargo_resguardante || 'Servidor de la nación'))})</span><br>
      <span class="muted">
        Región: <b>${escHtml(safestr(row.region_firma_destino || '-'))}</b> (${escHtml(safestr(row.oficina_programa || '-'))}) |
        Caja: <b>${escHtml(safestr(row.no_caja || 'S/N'))}</b> |
        Equipo: <b>${escHtml(safestr(row.marca || 'Compac'))} ${escHtml(safestr(row.modelo || 'QTab LTE'))}</b><br>
        IMEI: <b>${escHtml(safestr(row.imei || '-'))}</b> |
        Serie: <b>${escHtml(safestr(row.numero_serie || '-'))}</b> |
        Estado físico: <b>${escHtml(safestr(row.estatus_fisico || 'BUENO'))}</b> |
        Cargador: <b>${Number(row.tiene_cargador ?? 1) ? 'Sí' : 'No'}</b> |
        Caja: <b>${Number(row.tiene_caja ?? 1) ? 'Sí' : 'No'}</b> |
        Enviado: ${escHtml(fechaTxt)}
      </span>
    `;
    const obsTxt = safestr(row.observaciones);
    $('tab_firma_obs_box').innerHTML = `<b>Observaciones físicas registradas:</b> ${escHtml(obsTxt || 'Sin observaciones adicionales.')}`;

    if (TAB_FIRMA_SIG_PAD) TAB_FIRMA_SIG_PAD.clear();
    if ($('tab_firma_conformidad')) $('tab_firma_conformidad').checked = false;
    if ($('tab_rechazo_motivo')) $('tab_rechazo_motivo').value = '';
    if ($('tab_rechazo_wrap')) $('tab_rechazo_wrap').classList.toggle('hidden', !openRejectMode);

    openTabletaModal('modal-firmar-devolucion-tab');
    if (openRejectMode) {
      setTimeout(() => $('tab_rechazo_motivo')?.focus(), 50);
    }
  }

  function bindFirmasTabletasListeners() {
    if (FIRMAS_TABLETAS_LISTENERS_BOUND) return;
    FIRMAS_TABLETAS_LISTENERS_BOUND = true;

    $('btn-firmas-tab-refresh')?.addEventListener('click', () => loadFirmasTabletasView());

    $('firmas_tab_list_box')?.addEventListener('click', (ev) => {
      const btnFirmar = ev.target.closest('.btn-firma-tab-open');
      if (btnFirmar) {
        const movId = Number(btnFirmar.dataset.mov || 0);
        const row = FIRMAS_TABLETAS_ROWS.find(x => Number(x.movimiento_id) === movId);
        openModalFirmarDevolucionTab(row, false);
        return;
      }
      const btnRech = ev.target.closest('.btn-firma-tab-rechazar');
      if (btnRech) {
        const movId = Number(btnRech.dataset.mov || 0);
        const row = FIRMAS_TABLETAS_ROWS.find(x => Number(x.movimiento_id) === movId);
        openModalFirmarDevolucionTab(row, true);
      }
    });

    $('modal-firmar-devolucion-tab')?.addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget || ev.target.closest('[data-close-modal]')) {
        closeTabletaModal('modal-firmar-devolucion-tab');
      }
    });

    $('btn-tab-abrir-rechazo')?.addEventListener('click', () => {
      $('tab_rechazo_wrap')?.classList.remove('hidden');
      $('tab_rechazo_motivo')?.focus();
    });

    $('btn-tab-rechazo-cancelar')?.addEventListener('click', () => {
      $('tab_rechazo_wrap')?.classList.add('hidden');
      if ($('tab_rechazo_motivo')) $('tab_rechazo_motivo').value = '';
    });

    $('btn-tab-rechazo-enviar')?.addEventListener('click', async () => {
      const movId = Number($('tab_firma_mov_id')?.value || 0);
      const motivo = safestr($('tab_rechazo_motivo')?.value);
      if (!movId) return;
      if (!motivo) {
        toast('Describe el error o motivo por el cual reportas esta devolución.', false);
        $('tab_rechazo_motivo')?.focus();
        return;
      }
      if (motivo.length > 250) {
        toast('El motivo no puede exceder 250 caracteres.', false);
        return;
      }
      const btn = $('btn-tab-rechazo-enviar');
      if (btn) btn.disabled = true;
      try {
        const r = await apiJSON(`/api/tabletas/devoluciones/${movId}/rechazar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ motivo }),
        });
        closeTabletaModal('modal-firmar-devolucion-tab');
        toast(r.message || 'Reporte enviado correctamente.', true);
        await loadFirmasTabletasView();
        pollTabletasBadge();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message || 'Error al enviar reporte', false);
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    $('btn-tab-aceptar-firmar')?.addEventListener('click', async () => {
      const movId = Number($('tab_firma_mov_id')?.value || 0);
      if (!movId) return;
      if (!TAB_FIRMA_SIG_PAD || !TAB_FIRMA_SIG_PAD.hasSignature()) {
        toast('Debes dibujar tu firma digital dentro del recuadro antes de aceptar.', false);
        return;
      }
      if (!$('tab_firma_conformidad')?.checked) {
        toast('Debes marcar la casilla de conformidad para validar los datos del equipo.', false);
        return;
      }
      const firmaData = TAB_FIRMA_SIG_PAD.getDataUrl();
      if (!firmaData || !firmaData.startsWith('data:image/png;base64,')) {
        toast('Firma digital inválida. Intenta dibujarla nuevamente.', false);
        return;
      }
      if (new Blob([firmaData]).size > 153600) {
        toast('La firma digital excede el límite máximo de 150 KB. Límpiala e intenta con un trazo más ligero.', false);
        return;
      }

      const btn = $('btn-tab-aceptar-firmar');
      const prevTxt = btn ? btn.textContent : '';
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Guardando firma...';
      }
      try {
        const r = await apiJSON(`/api/tabletas/devoluciones/${movId}/firmar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ firma_data: firmaData }),
        });
        closeTabletaModal('modal-firmar-devolucion-tab');
        toast(r.message || 'Devolución firmada digitalmente con éxito.', true);
        await loadFirmasTabletasView();
        pollTabletasBadge();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message || 'Error al guardar firma digital', false);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = prevTxt || '✅ Aceptar y Firmar';
        }
      }
    });
  }

  async function loadFirmasTabletasView() {
    bindFirmasTabletasListeners();
    const box = $('firmas_tab_list_box');
    const meta = $('firmas_tab_meta');
    const sub = $('firmas_tab_region_subtitle');
    if (!box) return;

    box.innerHTML = '<div class="muted" style="padding:18px; text-align:center;">Cargando devoluciones pendientes de firma...</div>';
    try {
      const res = await apiJSON('/api/tabletas/devoluciones/pendientes-firma');
      const rows = Array.isArray(res?.data) ? res.data : [];
      FIRMAS_TABLETAS_ROWS = rows;
      FIRMAS_TABLETAS_CAN_SIGN = Boolean(res?.can_sign);

      if (sub) {
        if (FIRMAS_TABLETAS_CAN_SIGN) {
          sub.textContent = `Región asignada: ${res.region_scope || ''}. Verifica el equipo y estampa tu firma digital para autorizar la devolución al almacén estatal.`;
        } else {
          sub.textContent = 'Vista de consulta global (Administración). Únicamente las cuentas regionales (Los Cabos, Mulegé y Comondú) pueden firmar o reportar sus devoluciones.';
        }
      }
      if (meta) {
        meta.textContent = `${rows.length} devolución${rows.length === 1 ? '' : 'es'} pendiente${rows.length === 1 ? '' : 's'} de firma`;
      }

      if (!rows.length) {
        box.innerHTML = '<div class="muted" style="padding:24px; text-align:center;">✅ No tienes devoluciones de tabletas pendientes de firma en este momento.</div>';
        pollTabletasBadge();
        return;
      }

      box.innerHTML = `
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Folio / Fecha</th>
                <th>No. Resg. / Caja</th>
                <th>Región / Oficina</th>
                <th>Resguardante / Cargo</th>
                <th>Equipo</th>
                <th>IMEI / Serie</th>
                <th>Estado Físico</th>
                <th>Observaciones Físicas</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => {
                const movId = Number(r.movimiento_id || 0);
                const fecha = r.fecha_movimiento ? new Date(r.fecha_movimiento).toLocaleString('es-MX') : '-';
                const fisico = safestr(r.estatus_fisico || 'BUENO').toUpperCase();
                let fisicoCls = 'bueno';
                if (fisico === 'INCOMPLETO') fisicoCls = 'incompleto';
                if (fisico.includes('DAÑ') || fisico.includes('DAN')) fisicoCls = 'danado';

                const acciones = FIRMAS_TABLETAS_CAN_SIGN
                  ? `<div style="display:flex; flex-direction:column; gap:5px;">
                       <button type="button" class="mini btn-primary btn-firma-tab-open" data-mov="${movId}">✍️ Firmar Devolución</button>
                       <button type="button" class="mini btn-firma-tab-rechazar" data-mov="${movId}" style="color:#b91c1c; border-color:#fca5a5;">↩️ Reportar Error</button>
                     </div>`
                  : `<span class="badge-tab-firma-pendiente">⏳ Pendiente (${escHtml(safestr(r.region_firma_destino || '-'))})</span>`;

                return `<tr>
                  <td style="white-space:nowrap; font-size:12px;">
                    <b>${escHtml(safestr(r.folio || '-'))}</b>
                    <div class="muted" style="font-size:11px;">${escHtml(fecha)}</div>
                  </td>
                  <td>
                    <b>#${Number(r.no_resguardo)}</b>
                    <div class="muted" style="font-size:11px;">Caja: ${escHtml(safestr(r.no_caja || 'S/N'))}</div>
                  </td>
                  <td>
                    <b>${escHtml(safestr(r.region_firma_destino || '-'))}</b>
                    <div class="muted" style="font-size:11px;">${escHtml(safestr(r.oficina_programa || '-'))}</div>
                  </td>
                  <td>
                    <b>${escHtml(safestr(r.nombre_resguardante || '-'))}</b>
                    <div class="muted" style="font-size:11px;">${escHtml(safestr(r.cargo_resguardante || 'Servidor de la nación'))}</div>
                  </td>
                  <td>
                    <b>${escHtml(safestr(r.marca || 'Compac'))}</b>
                    <div class="muted" style="font-size:11px;">${escHtml(safestr(r.modelo || 'QTab LTE'))}</div>
                  </td>
                  <td style="font-family:monospace; font-size:11.5px;">
                    IMEI: ${escHtml(safestr(r.imei || '-'))}<br>
                    Serie: ${escHtml(safestr(r.numero_serie || '-'))}
                  </td>
                  <td>
                    <span class="badge-tableta-fisico ${fisicoCls}">${escHtml(fisico)}</span>
                    <div style="font-size:11px; margin-top:4px; color:#475569;">
                      Cargador: <b>${Number(r.tiene_cargador ?? 1) ? 'Sí' : 'No'}</b> | Caja: <b>${Number(r.tiene_caja ?? 1) ? 'Sí' : 'No'}</b>
                    </div>
                  </td>
                  <td style="font-size:12px; max-width:220px;">${escHtml(safestr(r.observaciones || '-'))}</td>
                  <td>${acciones}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
      pollTabletasBadge();
    } catch (e) {
      box.innerHTML = `<div class="muted" style="padding:18px; text-align:center; color:var(--danger);">${escHtml(e.message || 'Error al cargar devoluciones pendientes')}</div>`;
      if (!handleAuthError(e)) toast(e.message || 'Error al cargar firmas de tabletas', false);
    }
  }

  // ==========================================================================
  // POLLING ULTRALIGERO DE ALERTAS DE TABLETAS (60s - SOLO USUARIOS RELEVANTES)
  // ==========================================================================
  let TABLETAS_BADGE_TIMER = null;
  let TABLETAS_BADGE_IN_FLIGHT = false;

  function setSidebarBadge(elId, count, titleText = '') {
    const el = $(elId);
    if (!el) return;
    const n = Number(count || 0);
    if (n > 0) {
      el.textContent = String(n);
      el.classList.remove('hidden');
      el.style.display = 'inline-block';
      if (titleText) el.title = titleText;
    } else {
      el.textContent = '0';
      el.classList.add('hidden');
      el.style.display = 'none';
      el.title = '';
    }
  }

  async function pollTabletasBadge() {
    if (!CURRENT_USER) return;
    const isRelevant = canEditTabletas(CURRENT_USER) || Boolean(getRegionalSignatureScopeFront(CURRENT_USER));
    if (!isRelevant) return;
    if (document.hidden || TABLETAS_BADGE_IN_FLIGHT) return;

    TABLETAS_BADGE_IN_FLIGHT = true;
    try {
      const data = await apiJSON('/api/tabletas/devoluciones/badge');
      if (!data || !data.ok) return;
      if (data.scope === 'regional') {
        const pend = Number(data.pendientes || 0);
        setSidebarBadge('nav-firmas-tabletas-badge', pend, `${pend} devolución(es) pendiente(s) de firma`);
        setSidebarBadge('nav-tabletas-badge', 0);
      } else if (data.scope === 'almacen') {
        const firmadas = Number(data.firmadas || 0);
        const rechazadas = Number(data.rechazadas || 0);
        const totalAlertas = Number(data.total || (firmadas + rechazadas));
        setSidebarBadge(
          'nav-tabletas-badge',
          totalAlertas,
          `${firmadas} firmada(s) lista(s) para recibir, ${rechazadas} rechazada(s) por región`
        );
        if (canViewFirmasTabletas(CURRENT_USER)) {
          const pend = Number(data.pendientes || 0);
          setSidebarBadge('nav-firmas-tabletas-badge', pend, `${pend} devolución(es) esperando firma regional`);
        } else {
          setSidebarBadge('nav-firmas-tabletas-badge', 0);
        }
      }
    } catch (_) {
      // Silencioso para no interrumpir al usuario ante errores de red transitorios
    } finally {
      TABLETAS_BADGE_IN_FLIGHT = false;
    }
  }

  function stopTabletasBadgePolling() {
    if (TABLETAS_BADGE_TIMER) {
      clearInterval(TABLETAS_BADGE_TIMER);
      TABLETAS_BADGE_TIMER = null;
    }
  }

  function startTabletasBadgePolling() {
    stopTabletasBadgePolling();
    const isRelevant = Boolean(CURRENT_USER) && (
      canEditTabletas(CURRENT_USER) || Boolean(getRegionalSignatureScopeFront(CURRENT_USER))
    );
    if (!isRelevant) {
      setSidebarBadge('nav-tabletas-badge', 0);
      setSidebarBadge('nav-firmas-tabletas-badge', 0);
      return;
    }
    pollTabletasBadge();
    TABLETAS_BADGE_TIMER = setInterval(pollTabletasBadge, 60000);
  }

  window.addEventListener('beforeunload', stopSolicitudesPolling);
  window.addEventListener('beforeunload', stopTabletasBadgePolling);

})(); // <-- FIN DEL ARCHIVO APP.JS 
