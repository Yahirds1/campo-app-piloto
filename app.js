/* =========================================================
   Registro de Campo PILOTO — Tello Produce
   App offline-first: escanea gafete QR del trabajador,
    captura cajas/jarras de jugo/horas extra, guarda localmente
   y sincroniza contra un Webhook de n8n cuando hay señal.
   Incluye PIN de acceso y edición/anulación de registros.
   ========================================================= */

const DB_NAME = 'campoTelloPilotoDB';
const DB_VERSION = 1;
let db;

const CULTIVOS_POR_DEFECTO = [
  { id: 'MOR', nombre: 'Mora' },
  { id: 'FRE', nombre: 'Fresa' }
];

let cameraStream = null;
let scanning = false;
let workerActual = null; // { id, nombre }
let detalleActualId = null; // localId del registro abierto en pantalla-detalle
let sincronizacionEnCurso = false;
let anulacionEnCurso = false;

const LIMITES = Object.freeze({
  cajas: 500,
  jarras: 200,
  horasExtra: 24,
  texto: 120
});

/* ---------------- IndexedDB ---------------- */

function abrirDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      if (!_db.objectStoreNames.contains('trabajadores')) {
        _db.createObjectStore('trabajadores', { keyPath: 'id' });
      }
      if (!_db.objectStoreNames.contains('cultivos')) {
        _db.createObjectStore('cultivos', { keyPath: 'id' });
      }
      if (!_db.objectStoreNames.contains('registros')) {
        _db.createObjectStore('registros', { keyPath: 'localId', autoIncrement: true });
      }
      if (!_db.objectStoreNames.contains('settings')) {
        _db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbClear(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbAnularRegistro(registro, compensacion) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('registros', 'readwrite');
    const store = tx.objectStore('registros');
    store.put(registro);
    store.put(compensacion);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('La anulación fue cancelada.'));
  });
}

/* ---------------- Config ---------------- */

async function getConfig() {
  const webhook = await idbGet('settings', 'webhookUrl');
  const apiKey = await idbGet('settings', 'apiKey');
  const secreto = await idbGet('settings', 'secreto');
  const pinHash = await idbGet('settings', 'pinHash');
  return {
    webhookUrl: webhook ? webhook.value : '',
    apiKey: apiKey ? apiKey.value : '',
    secreto: secreto ? secreto.value : '',
    pinHash: pinHash ? pinHash.value : ''
  };
}

async function guardarConfig(webhookUrl, apiKey, secreto) {
  await idbPut('settings', { key: 'webhookUrl', value: webhookUrl });
  await idbPut('settings', { key: 'apiKey', value: apiKey });
  await idbPut('settings', { key: 'secreto', value: secreto });
}

async function guardarPinHash(hash) {
  await idbPut('settings', { key: 'pinHash', value: hash });
}

async function quitarPin() {
  await idbDelete('settings', 'pinHash');
}

/* ---------------- Utilidades ---------------- */

async function sha256Hex(texto) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function tokenEsperado(id, secreto) {
  const hash = await sha256Hex(`${id}:${secreto}`);
  return hash.slice(0, 8);
}

function fechaHoyISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function generarUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function mostrarToast(mensaje) {
  const t = document.getElementById('toast');
  t.textContent = mensaje;
  t.classList.add('mostrar');
  setTimeout(() => t.classList.remove('mostrar'), 2200);
}

/* ---------------- CSV ---------------- */

function parseCSV(texto) {
  const filas = [];
  let fila = [];
  let campo = '';
  let entreComillas = false;

  for (let i = 0; i < texto.length; i++) {
    const caracter = texto[i];
    if (caracter === '"') {
      if (entreComillas && texto[i + 1] === '"') {
        campo += '"';
        i++;
      } else {
        entreComillas = !entreComillas;
      }
    } else if (caracter === ',' && !entreComillas) {
      fila.push(campo.trim());
      campo = '';
    } else if ((caracter === '\n' || caracter === '\r') && !entreComillas) {
      if (caracter === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo.trim());
      if (fila.some(valor => valor.length > 0)) filas.push(fila);
      fila = [];
      campo = '';
    } else {
      campo += caracter;
    }
  }
  if (entreComillas) throw new Error('El CSV contiene un campo entre comillas sin cerrar.');
  fila.push(campo.trim());
  if (fila.some(valor => valor.length > 0)) filas.push(fila);
  return filas;
}

function textoSeguro(valor, nombreCampo, maximo = LIMITES.texto) {
  const texto = String(valor ?? '').trim();
  if (texto.length > maximo) throw new Error(`${nombreCampo} excede ${maximo} caracteres.`);
  if (/[\u0000-\u001F\u007F]/.test(texto)) throw new Error(`${nombreCampo} contiene caracteres no permitidos.`);
  return texto;
}

function idSeguro(valor, nombreCampo) {
  const id = textoSeguro(valor, nombreCampo, 50);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`${nombreCampo} solo puede contener letras, números, punto, guion y guion bajo.`);
  }
  return id;
}

function validarCantidad(valor, nombreCampo, maximo, incremento = 1) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < 0 || numero > maximo) {
    throw new Error(`${nombreCampo} debe estar entre 0 y ${maximo}.`);
  }
  const pasos = numero / incremento;
  if (Math.abs(pasos - Math.round(pasos)) > 1e-9) {
    throw new Error(`${nombreCampo} debe usar incrementos de ${incremento}.`);
  }
  return numero;
}

function obtenerCantidades(ids) {
  return {
    cajas: validarCantidad(document.getElementById(ids.cajas).value, 'Cajas aprobadas', LIMITES.cajas),
    jarras: validarCantidad(document.getElementById(ids.jarras).value, 'Jarras de jugo', LIMITES.jarras),
    horas: validarCantidad(document.getElementById(ids.horas).value, 'Horas extra', LIMITES.horasExtra, 0.5)
  };
}

function encontrarEncabezado(filas, columnasBuscadas) {
  for (let i = 0; i < filas.length; i++) {
    const fila = filas[i].map(c => c.toLowerCase());
    const encontrados = columnasBuscadas.every(col =>
      fila.some(c => c.replace(/\s+/g, '_') === col.toLowerCase())
    );
    if (encontrados) {
      const indices = {};
      columnasBuscadas.forEach(col => {
        indices[col] = fila.findIndex(c => c.replace(/\s+/g, '_') === col.toLowerCase());
      });
      return { filaIndex: i, indices };
    }
  }
  return null;
}

async function importarTrabajadoresCSV(texto) {
  const filas = parseCSV(texto);
  const encontrado = encontrarEncabezado(filas, ['id_trabajador', 'nombre']);
  if (!encontrado) {
    throw new Error('No se encontraron las columnas "ID_Trabajador" y "Nombre" en el archivo.');
  }
  const trabajadores = [];
  for (let i = encontrado.filaIndex + 1; i < filas.length; i++) {
    const fila = filas[i];
    const id = fila[encontrado.indices['id_trabajador']];
    const nombre = fila[encontrado.indices['nombre']];
    if (id) {
      trabajadores.push({
        id: idSeguro(id, 'ID del trabajador'),
        nombre: textoSeguro(nombre, 'Nombre del trabajador')
      });
    }
  }
  if (trabajadores.length === 0) throw new Error('El CSV no contiene trabajadores válidos.');
  if (new Set(trabajadores.map(item => item.id)).size !== trabajadores.length) {
    throw new Error('El CSV contiene IDs de trabajador duplicados.');
  }
  await idbClear('trabajadores');
  for (const trabajador of trabajadores) await idbPut('trabajadores', trabajador);
  return trabajadores.length;
}

async function importarCultivosCSV(texto) {
  const filas = parseCSV(texto);
  const encontrado = encontrarEncabezado(filas, ['id_cultivo', 'nombre']);
  if (!encontrado) {
    throw new Error('No se encontraron las columnas "ID_Cultivo" y "Nombre" en el archivo.');
  }
  const cultivos = [];
  for (let i = encontrado.filaIndex + 1; i < filas.length; i++) {
    const fila = filas[i];
    const id = fila[encontrado.indices['id_cultivo']];
    const nombre = fila[encontrado.indices['nombre']];
    if (id) {
      cultivos.push({
        id: idSeguro(id, 'ID del cultivo'),
        nombre: textoSeguro(nombre, 'Nombre del cultivo')
      });
    }
  }
  if (cultivos.length === 0) throw new Error('El CSV no contiene cultivos válidos.');
  if (new Set(cultivos.map(item => item.id)).size !== cultivos.length) {
    throw new Error('El CSV contiene IDs de cultivo duplicados.');
  }
  await idbClear('cultivos');
  for (const cultivo of cultivos) await idbPut('cultivos', cultivo);
  return cultivos.length;
}

/* ---------------- Navegación entre pantallas ---------------- */

function irAPantalla(nombre) {
  document.querySelectorAll('.pantalla').forEach(p => p.classList.remove('activa'));
  document.getElementById(`pantalla-${nombre}`).classList.add('activa');
  document.querySelectorAll('nav.tabbar .tab').forEach(t => t.classList.remove('activo'));
  const tab = document.querySelector(`nav.tabbar .tab[data-pantalla="${nombre}"]`);
  if (tab) tab.classList.add('activo');
  if (nombre === 'historial') renderHistorial();
  if (nombre === 'config') cargarPantallaConfig();
  if (nombre !== 'escanear') detenerCamara();
}

document.querySelectorAll('nav.tabbar .tab').forEach(btn => {
  btn.addEventListener('click', () => irAPantalla(btn.dataset.pantalla));
});

/* ---------------- Contadores de inicio ---------------- */

async function actualizarInicio() {
  const registros = await idbGetAll('registros');
  const pendientes = registros.filter(r => !r.synced).length;
  const hoy = fechaHoyISO();
  const deHoy = registros.filter(r => r.Fecha === hoy).length;
  document.getElementById('contPendientes').textContent = pendientes;
  document.getElementById('contHoy').textContent = deHoy;

  const trabajadores = await idbGetAll('trabajadores');
  document.getElementById('avisoRoster').style.display = trabajadores.length === 0 ? 'block' : 'none';
}

/* ---------------- Escaneo QR ---------------- */

document.getElementById('btnEscanear').addEventListener('click', async () => {
  if (typeof jsQR === 'undefined') {
    mostrarToast('Error: no se pudo cargar el lector de códigos QR. Reinstala la app.');
    return;
  }
  document.querySelectorAll('.pantalla').forEach(p => p.classList.remove('activa'));
  document.getElementById('pantalla-escanear').classList.add('activa');
  document.getElementById('errorEscaneo').innerHTML = '';

  if (typeof jsQR !== 'function') {
    document.getElementById('errorEscaneo').innerHTML =
      `<div class="mensaje-error">No se pudo cargar el lector de códigos QR (jsQR.js). Revisa que ese archivo se haya subido junto con el resto de la app, o mira la consola del navegador para más detalle.</div>`;
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = document.getElementById('video');
    video.srcObject = cameraStream;
    await video.play();
    scanning = true;
    requestAnimationFrame(cicloEscaneo);
  } catch (err) {
    document.getElementById('errorEscaneo').innerHTML =
      `<div class="mensaje-error">No se pudo abrir la cámara. Revisa los permisos de la app en el celular.</div>`;
  }
});

document.getElementById('btnCancelarScan').addEventListener('click', () => {
  irAPantalla('inicio');
});

function detenerCamara() {
  scanning = false;
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
}

const canvasOculto = document.createElement('canvas');

function cicloEscaneo() {
  if (!scanning) return;
  const video = document.getElementById('video');
  try {
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvasOculto.width = video.videoWidth;
      canvasOculto.height = video.videoHeight;
      const ctx = canvasOculto.getContext('2d');
      ctx.drawImage(video, 0, 0, canvasOculto.width, canvasOculto.height);
      const imgData = ctx.getImageData(0, 0, canvasOculto.width, canvasOculto.height);
      const codigo = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'dontInvert' });
      if (codigo) {
        procesarCodigo(codigo.data);
        return;
      }
    }
  } catch (err) {
    console.error('Error leyendo el cuadro de la cámara:', err);
  }
  requestAnimationFrame(cicloEscaneo);
}

async function procesarCodigo(texto) {
  let payload;
  try {
    payload = JSON.parse(texto);
  } catch {
    mostrarErrorEscaneo('Este código no es un gafete válido de Tello Produce.');
    return;
  }
  const { i: id, t: token } = payload;
  if (!id || !token) {
    mostrarErrorEscaneo('Este código no es un gafete válido de Tello Produce.');
    return;
  }

  const config = await getConfig();
  if (!config.secreto) {
    mostrarErrorEscaneo('Falta configurar el código secreto del rancho en Ajustes antes de escanear.');
    return;
  }

  const esperado = await tokenEsperado(id, config.secreto);
  if (esperado !== token) {
    mostrarErrorEscaneo('Gafete no reconocido. Verifica que el código secreto en Ajustes sea el correcto.');
    return;
  }

  const trabajador = await idbGet('trabajadores', id);
  if (!trabajador) {
    mostrarErrorEscaneo(`El trabajador "${id}" no está en la lista cargada. Importa el CSV actualizado en Ajustes.`);
    return;
  }

  detenerCamara();
  workerActual = trabajador;
  abrirCaptura(trabajador);
}

function mostrarErrorEscaneo(msg) {
  const contenedor = document.getElementById('errorEscaneo');
  contenedor.replaceChildren();
  const mensaje = document.createElement('div');
  mensaje.className = 'mensaje-error';
  mensaje.textContent = msg;
  contenedor.appendChild(mensaje);
  scanning = false;
  setTimeout(() => {
    if (document.getElementById('pantalla-escanear').classList.contains('activa')) {
      scanning = true;
      requestAnimationFrame(cicloEscaneo);
    }
  }, 2200);
}

/* ---------------- Captura ---------------- */

async function poblarSelectCultivos(selectEl, campoJugoEl) {
  let cultivos = await idbGetAll('cultivos');
  if (cultivos.length === 0) cultivos = CULTIVOS_POR_DEFECTO;
  selectEl.replaceChildren();
  cultivos.forEach(cultivo => {
    const opcion = document.createElement('option');
    opcion.value = cultivo.id;
    opcion.dataset.nombre = cultivo.nombre;
    opcion.textContent = cultivo.nombre;
    selectEl.appendChild(opcion);
  });
}

function actualizarCampoJugo(selectEl, campoJugoEl, jarrasInputEl) {
  const opt = selectEl.options[selectEl.selectedIndex];
  const nombre = (opt?.dataset.nombre || '').toLowerCase();
  const esMora = nombre.includes('mora');
  campoJugoEl.classList.toggle('visible', esMora);
  if (!esMora) jarrasInputEl.value = 0;
}

document.getElementById('selCultivo').addEventListener('change', () => {
  actualizarCampoJugo(document.getElementById('selCultivo'), document.getElementById('campoJugo'), document.getElementById('inpJarrasJugo'));
});

async function abrirCaptura(trabajador) {
  document.getElementById('capturaNombre').textContent = trabajador.nombre;
  document.getElementById('capturaId').textContent = trabajador.id;
  document.getElementById('inpCajasAprobadas').value = 0;
  document.getElementById('inpJarrasJugo').value = 0;
  document.getElementById('inpHorasExtra').value = 0;
  await poblarSelectCultivos(document.getElementById('selCultivo'));
  actualizarCampoJugo(document.getElementById('selCultivo'), document.getElementById('campoJugo'), document.getElementById('inpJarrasJugo'));
  document.querySelectorAll('.pantalla').forEach(p => p.classList.remove('activa'));
  document.getElementById('pantalla-captura').classList.add('activa');
}

document.querySelectorAll('.stepper button').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (input.disabled) return;
    const delta = parseFloat(btn.dataset.delta);
    const nuevo = Math.max(0, (parseFloat(input.value) || 0) + delta);
    input.value = Number.isInteger(delta) ? nuevo : nuevo.toFixed(1);
  });
});

document.getElementById('btnCancelarCaptura').addEventListener('click', () => {
  workerActual = null;
  irAPantalla('inicio');
});

document.getElementById('btnGuardarRegistro').addEventListener('click', async () => {
  const boton = document.getElementById('btnGuardarRegistro');
  if (boton.disabled || !workerActual) return;
  try {
    boton.disabled = true;
    const cantidades = obtenerCantidades({ cajas: 'inpCajasAprobadas', jarras: 'inpJarrasJugo', horas: 'inpHorasExtra' });
    const sel = document.getElementById('selCultivo');
    const opt = sel.options[sel.selectedIndex];
    if (!opt) throw new Error('Selecciona un cultivo válido.');
    const registro = {
    idRegistro: generarUUID(),
    ID_Trabajador: workerActual.id,
    Nombre: workerActual.nombre,
    Fecha: fechaHoyISO(),
    ID_Cultivo: sel.value,
    Cultivo: opt?.dataset.nombre || '',
    Cajas_Aprobadas: cantidades.cajas,
    Jarras_Jugo: cantidades.jarras,
    Horas_Extra: cantidades.horas,
    Observaciones: '',
    synced: false,
    voided: false,
    createdAt: new Date().toISOString()
    };
    const nombreTrabajador = workerActual.nombre;
    await idbPut('registros', registro);
    workerActual = null;
    mostrarToast(`Registro guardado — ${nombreTrabajador}`);
    await actualizarInicio();
    irAPantalla('inicio');
    intentarSincronizar(); // por si ya hay señal, no bloquea al usuario
  } catch (error) {
    mostrarToast(error.message || 'No se pudo guardar el registro.');
  } finally {
    boton.disabled = false;
  }
});

/* ---------------- Historial ---------------- */

async function renderHistorial() {
  const registros = (await idbGetAll('registros')).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const cont = document.getElementById('listaHistorial');
  if (registros.length === 0) {
    cont.innerHTML = `<div class="empty-state"><svg class="icon" viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9z"/></svg><div>Todavía no hay registros guardados.</div></div>`;
    return;
  }
  cont.replaceChildren();
  registros.forEach(registro => {
    const item = document.createElement('div');
    item.className = 'lista-item';
    item.dataset.id = String(registro.localId);
    const textos = document.createElement('div');
    const nombre = document.createElement('div');
    nombre.className = 'nombre';
    nombre.textContent = registro.Nombre;
    const detalle = document.createElement('div');
    detalle.className = 'detalle';
    detalle.textContent = `${registro.Fecha} · ${registro.Cultivo} · ${registro.Cajas_Aprobadas} cajas${registro.Jarras_Jugo ? ` · ${registro.Jarras_Jugo} jarras` : ''}`;
    textos.append(nombre, detalle);
    const badge = document.createElement('span');
    badge.className = `badge ${registro.voided ? 'anulado' : (registro.synced ? 'ok' : 'pendiente')}`;
    badge.textContent = registro.voided ? 'Anulado' : (registro.synced ? 'Sincronizado' : 'Pendiente');
    item.append(textos, badge);
    cont.appendChild(item);
  });

  cont.querySelectorAll('.lista-item').forEach(item => {
    item.addEventListener('click', () => abrirDetalle(Number(item.dataset.id)));
  });
}

async function abrirDetalle(localId) {
  const registro = await idbGet('registros', localId);
  if (!registro) return;
  detalleActualId = localId;

  document.getElementById('detalleNombre').textContent = registro.Nombre;
  document.getElementById('detalleMeta').textContent = `${registro.Fecha} · ${registro.ID_Trabajador}`;

  const esEditable = !registro.synced && !registro.voided;
  const esAnulable = registro.synced && !registro.voided;
  const esAnulado = !!registro.voided;

  document.getElementById('bloqueEditable').style.display = esEditable ? 'block' : 'none';
  document.getElementById('bloqueAnular').style.display = esAnulable ? 'block' : 'none';
  document.getElementById('bloqueAnuladoInfo').style.display = esAnulado ? 'block' : 'none';

  if (esEditable) {
    await poblarSelectCultivos(document.getElementById('detCultivo'));
    document.getElementById('detCultivo').value = registro.ID_Cultivo;
    document.getElementById('detCajasAprobadas').value = registro.Cajas_Aprobadas;
    document.getElementById('detJarrasJugo').value = registro.Jarras_Jugo || 0;
    document.getElementById('detHorasExtra').value = registro.Horas_Extra;
    actualizarCampoJugo(document.getElementById('detCultivo'), document.getElementById('detCampoJugo'), document.getElementById('detJarrasJugo'));
  }

  document.querySelectorAll('.pantalla').forEach(p => p.classList.remove('activa'));
  document.getElementById('pantalla-detalle').classList.add('activa');
}

document.getElementById('detCultivo').addEventListener('change', () => {
  actualizarCampoJugo(document.getElementById('detCultivo'), document.getElementById('detCampoJugo'), document.getElementById('detJarrasJugo'));
});

document.getElementById('btnCerrarDetalle').addEventListener('click', () => {
  detalleActualId = null;
  irAPantalla('historial');
});

document.getElementById('btnGuardarEdicion').addEventListener('click', async () => {
  const registro = await idbGet('registros', detalleActualId);
  if (!registro) return;
  const sel = document.getElementById('detCultivo');
  const opt = sel.options[sel.selectedIndex];
  registro.ID_Cultivo = sel.value;
  registro.Cultivo = opt?.dataset.nombre || '';
  let cantidades;
  try {
    cantidades = obtenerCantidades({ cajas: 'detCajasAprobadas', jarras: 'detJarrasJugo', horas: 'detHorasExtra' });
  } catch (error) {
    mostrarToast(error.message);
    return;
  }
  registro.Cajas_Aprobadas = cantidades.cajas;
  registro.Jarras_Jugo = cantidades.jarras;
  registro.Horas_Extra = cantidades.horas;
  await idbPut('registros', registro);
  mostrarToast('Registro actualizado');
  detalleActualId = null;
  await actualizarInicio();
  irAPantalla('historial');
});

document.getElementById('btnEliminarRegistro').addEventListener('click', async () => {
  if (!confirm('¿Eliminar este registro? Todavía no se ha sincronizado, así que se borra por completo.')) return;
  await idbDelete('registros', detalleActualId);
  mostrarToast('Registro eliminado');
  detalleActualId = null;
  await actualizarInicio();
  irAPantalla('historial');
});

document.getElementById('btnAnularRegistro').addEventListener('click', async () => {
  if (anulacionEnCurso) return;
  const registro = await idbGet('registros', detalleActualId);
  if (!registro) return;
  if (!confirm(`¿Anular este registro de ${registro.Nombre}? Se descontará automáticamente de la nómina.`)) return;

  anulacionEnCurso = true;
  document.getElementById('btnAnularRegistro').disabled = true;
  try {
    registro.voided = true;

  const compensacion = {
    idRegistro: generarUUID(),
    ID_Trabajador: registro.ID_Trabajador,
    Nombre: registro.Nombre,
    Fecha: fechaHoyISO(),
    ID_Cultivo: registro.ID_Cultivo,
    Cultivo: registro.Cultivo,
    Cajas_Aprobadas: -(Number(registro.Cajas_Aprobadas) || 0),
    Jarras_Jugo: -(Number(registro.Jarras_Jugo) || 0),
    Horas_Extra: -(Number(registro.Horas_Extra) || 0),
    Observaciones: `ANULACIÓN de registro del ${registro.Fecha}`,
    synced: false,
    voided: false,
    createdAt: new Date().toISOString()
  };
    await idbAnularRegistro(registro, compensacion);

  mostrarToast('Registro anulado, se descontará al sincronizar');
  detalleActualId = null;
  await actualizarInicio();
  irAPantalla('historial');
    intentarSincronizar();
  } catch (error) {
    mostrarToast('No se pudo completar la anulación.');
  } finally {
    anulacionEnCurso = false;
    document.getElementById('btnAnularRegistro').disabled = false;
  }
});

/* ---------------- Sincronización ---------------- */

async function intentarSincronizar(manual = false) {
  if (sincronizacionEnCurso) {
    if (manual) mostrarToast('Ya hay una sincronización en curso.');
    return;
  }
  const config = await getConfig();
  if (!config.webhookUrl) {
    if (manual) mostrarToast('Configura la URL del Webhook en Ajustes.');
    return;
  }
  if (!config.apiKey) {
    if (manual) mostrarToast('Configura la clave de acceso del Webhook en Ajustes.');
    return;
  }
  if (!navigator.onLine) {
    if (manual) mostrarToast('Sin conexión. Se sincronizará automáticamente al recuperar señal.');
    return;
  }
  const registros = await idbGetAll('registros');
  const pendientes = registros.filter(r => !r.synced);
  if (pendientes.length === 0) {
    if (manual) mostrarToast('No hay registros pendientes.');
    return;
  }
  sincronizacionEnCurso = true;
  const botonSync = document.getElementById('btnSincronizar');
  botonSync.disabled = true;
  if (manual) mostrarToast(`Sincronizando ${pendientes.length} registro(s)...`);

  let exitosos = 0;
  let ultimoError = '';
  try {
    for (const registro of pendientes) {
      let timeoutId;
      try {
        const controlador = new AbortController();
        timeoutId = setTimeout(() => controlador.abort(), 20000);
      const resp = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Campo-Key': config.apiKey
        },
        body: JSON.stringify(registro),
        signal: controlador.signal
      });
      if (resp.ok) {
        registro.synced = true;
        await idbPut('registros', registro);
        exitosos++;
      } else {
        let cuerpo = '';
        try { cuerpo = (await resp.text()).slice(0, 200); } catch {}
        ultimoError = `HTTP ${resp.status} ${resp.statusText} — ${cuerpo}`;
        break;
      }
      } catch (err) {
        ultimoError = err.name === 'AbortError' ? 'Tiempo de espera agotado (20 segundos).' : `Error de red: ${err.message}`;
        break;
      } finally {
        clearTimeout(timeoutId);
      }
    }

  if (ultimoError) {
    await idbPut('settings', { key: 'ultimoErrorSync', value: `${new Date().toLocaleString('es-MX')} — ${ultimoError}` });
  } else if (exitosos > 0) {
    await idbPut('settings', { key: 'ultimoErrorSync', value: '' });
  }

  await actualizarInicio();
  if (document.getElementById('pantalla-historial').classList.contains('activa')) renderHistorial();
  if (document.getElementById('pantalla-config').classList.contains('activa')) cargarPantallaConfig();
    if (manual) mostrarToast(exitosos > 0 ? `${exitosos} registro(s) sincronizado(s)` : 'No se pudo sincronizar — revisa el diagnóstico en Ajustes');
  } finally {
    sincronizacionEnCurso = false;
    botonSync.disabled = false;
  }
}

document.getElementById('btnSincronizar').addEventListener('click', () => intentarSincronizar(true));

window.addEventListener('online', () => { actualizarEstadoConexion(); intentarSincronizar(); });
window.addEventListener('offline', actualizarEstadoConexion);

function actualizarEstadoConexion() {
  const el = document.getElementById('estadoConexion');
  const txt = document.getElementById('estadoTexto');
  if (navigator.onLine) {
    el.classList.remove('offline'); el.classList.add('online'); txt.textContent = 'En línea';
  } else {
    el.classList.remove('online'); el.classList.add('offline'); txt.textContent = 'Sin señal';
  }
}

/* ---------------- Configuración general ---------------- */

async function cargarPantallaConfig() {
  const config = await getConfig();
  document.getElementById('cfgWebhook').value = config.webhookUrl;
  document.getElementById('cfgApiKey').value = config.apiKey;
  document.getElementById('cfgSecreto').value = config.secreto;
  const trabajadores = await idbGetAll('trabajadores');
  const cultivos = await idbGetAll('cultivos');
  document.getElementById('infoTrabajadores').textContent = `${trabajadores.length} trabajadores cargados.`;
  document.getElementById('infoCultivos').textContent = `${cultivos.length || CULTIVOS_POR_DEFECTO.length} cultivos cargados${cultivos.length === 0 ? ' (valores por defecto: Mora, Fresa)' : ''}.`;

  const pinActivo = !!config.pinHash;
  document.getElementById('pinEstadoTexto').textContent = pinActivo ? 'Activado' : 'Desactivado';
  document.getElementById('btnQuitarPin').style.display = pinActivo ? 'flex' : 'none';

  const errorGuardado = await idbGet('settings', 'ultimoErrorSync');
  const cajaDiag = document.getElementById('diagnosticoSync');
  if (errorGuardado && errorGuardado.value) {
    cajaDiag.style.display = 'block';
    cajaDiag.textContent = errorGuardado.value;
  } else {
    cajaDiag.style.display = 'none';
  }
}

document.getElementById('btnGuardarConfig').addEventListener('click', async () => {
  try {
    const webhookUrl = document.getElementById('cfgWebhook').value.trim();
    const apiKey = document.getElementById('cfgApiKey').value.trim();
    const secreto = document.getElementById('cfgSecreto').value.trim();
    if (webhookUrl) {
      const url = new URL(webhookUrl);
      if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
        throw new Error('La URL del Webhook debe usar HTTPS.');
      }
      if (!url.pathname.endsWith('/webhook/registro-campo-piloto')) {
        throw new Error('Usa únicamente la Production URL del webhook registro-campo-piloto.');
      }
    }
    if (apiKey && apiKey.length < 32) throw new Error('La clave PILOTO del Webhook debe tener al menos 32 caracteres.');
    if (secreto && secreto.length < 12) throw new Error('El secreto de gafetes debe tener al menos 12 caracteres.');
    await guardarConfig(webhookUrl, apiKey, secreto);
    mostrarToast('Configuración PILOTO guardada');
    irAPantalla('inicio');
  } catch (error) {
    mostrarToast(error.message || 'La configuración no es válida.');
  }
});

document.getElementById('btnImportarTrabajadores').addEventListener('click', () => {
  document.getElementById('fileTrabajadores').click();
});
document.getElementById('fileTrabajadores').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const texto = await file.text();
    const n = await importarTrabajadoresCSV(texto);
    mostrarToast(`${n} trabajadores importados`);
    cargarPantallaConfig();
    actualizarInicio();
  } catch (err) {
    mostrarToast(err.message);
  }
  e.target.value = '';
});

document.getElementById('btnImportarCultivos').addEventListener('click', () => {
  document.getElementById('fileCultivos').click();
});
document.getElementById('fileCultivos').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const texto = await file.text();
    const n = await importarCultivosCSV(texto);
    mostrarToast(`${n} cultivos importados`);
    cargarPantallaConfig();
  } catch (err) {
    mostrarToast(err.message);
  }
  e.target.value = '';
});

/* ---------------- PIN: teclado numérico reutilizable ---------------- */

function construirTeclado(contenedorEl, onDigito, onBorrar) {
  contenedorEl.innerHTML = '';
  const teclas = ['1','2','3','4','5','6','7','8','9','','0','borrar'];
  teclas.forEach(t => {
    if (t === '') {
      const vacio = document.createElement('div');
      vacio.className = 'tecla vacia';
      contenedorEl.appendChild(vacio);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tecla';
    if (t === 'borrar') {
      btn.innerHTML = '<svg class="icon" style="width:22px;height:22px;" viewBox="0 0 24 24"><path d="M20 5H9l-6 7 6 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/><path d="M13 10l4 4M17 10l-4 4"/></svg>';
      btn.addEventListener('click', onBorrar);
    } else {
      btn.textContent = t;
      btn.addEventListener('click', () => onDigito(t));
    }
    contenedorEl.appendChild(btn);
  });
}

function actualizarPuntos(contenedorEl, cantidad) {
  const puntos = contenedorEl.querySelectorAll('.punto-pin');
  puntos.forEach((p, i) => p.classList.toggle('lleno', i < cantidad));
}

/* --- Pantalla de bloqueo (desbloquear la app) --- */

let pinBuffer = '';

async function mostrarBloqueoSiAplica() {
  const config = await getConfig();
  if (config.pinHash) {
    pinBuffer = '';
    actualizarPuntos(document.getElementById('puntosPin'), 0);
    document.getElementById('errorPinBloqueo').textContent = '';
    document.getElementById('pantalla-bloqueo').classList.add('activa');
  }
}

construirTeclado(
  document.getElementById('tecladoBloqueo'),
  async (digito) => {
    if (pinBuffer.length >= 4) return;
    pinBuffer += digito;
    actualizarPuntos(document.getElementById('puntosPin'), pinBuffer.length);
    if (pinBuffer.length === 4) {
      const config = await getConfig();
      const hashIntento = await sha256Hex(pinBuffer);
      if (hashIntento === config.pinHash) {
        document.getElementById('pantalla-bloqueo').classList.remove('activa');
      } else {
        document.getElementById('errorPinBloqueo').textContent = 'PIN incorrecto, intenta de nuevo';
        setTimeout(() => {
          pinBuffer = '';
          actualizarPuntos(document.getElementById('puntosPin'), 0);
        }, 600);
      }
    }
  },
  () => {
    pinBuffer = pinBuffer.slice(0, -1);
    actualizarPuntos(document.getElementById('puntosPin'), pinBuffer.length);
  }
);

document.getElementById('btnBloquearAhora').addEventListener('click', async () => {
  const config = await getConfig();
  if (!config.pinHash) {
    mostrarToast('No hay PIN configurado. Ve a Ajustes → Configurar PIN.');
    return;
  }
  mostrarBloqueoSiAplica();
});

/* --- Pantalla de configuración de PIN (crear uno nuevo) --- */

let setupBuffer = '';
let setupPrimerPin = null;

function iniciarSetupPin() {
  setupBuffer = '';
  setupPrimerPin = null;
  document.getElementById('setupSub').textContent = 'Escribe un nuevo PIN de 4 dígitos';
  document.getElementById('errorPinSetup').textContent = '';
  actualizarPuntos(document.getElementById('puntosPinSetup'), 0);
  document.getElementById('pantalla-pin-setup').classList.add('activa');
}

construirTeclado(
  document.getElementById('tecladoSetup'),
  async (digito) => {
    if (setupBuffer.length >= 4) return;
    setupBuffer += digito;
    actualizarPuntos(document.getElementById('puntosPinSetup'), setupBuffer.length);
    if (setupBuffer.length === 4) {
      if (setupPrimerPin === null) {
        setupPrimerPin = setupBuffer;
        setupBuffer = '';
        document.getElementById('setupSub').textContent = 'Confirma el PIN otra vez';
        setTimeout(() => actualizarPuntos(document.getElementById('puntosPinSetup'), 0), 150);
      } else {
        if (setupBuffer === setupPrimerPin) {
          const hash = await sha256Hex(setupBuffer);
          await guardarPinHash(hash);
          mostrarToast('PIN configurado');
          document.getElementById('pantalla-pin-setup').classList.remove('activa');
          cargarPantallaConfig();
        } else {
          document.getElementById('errorPinSetup').textContent = 'No coincide, empecemos de nuevo';
          setTimeout(() => {
            setupBuffer = '';
            setupPrimerPin = null;
            document.getElementById('setupSub').textContent = 'Escribe un nuevo PIN de 4 dígitos';
            actualizarPuntos(document.getElementById('puntosPinSetup'), 0);
          }, 800);
        }
      }
    }
  },
  () => {
    setupBuffer = setupBuffer.slice(0, -1);
    actualizarPuntos(document.getElementById('puntosPinSetup'), setupBuffer.length);
  }
);

document.getElementById('btnConfigurarPin').addEventListener('click', iniciarSetupPin);
document.getElementById('btnCancelarSetupPin').addEventListener('click', () => {
  document.getElementById('pantalla-pin-setup').classList.remove('activa');
});

document.getElementById('btnQuitarPin').addEventListener('click', async () => {
  if (!confirm('¿Quitar el PIN? Cualquiera que abra la app va a poder capturar datos.')) return;
  await quitarPin();
  mostrarToast('PIN desactivado');
  cargarPantallaConfig();
});

/* ---------------- Arranque ---------------- */

(async function iniciar() {
  db = await abrirDB();
  actualizarEstadoConexion();
  await actualizarInicio();
  await mostrarBloqueoSiAplica();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  intentarSincronizar();
})();
