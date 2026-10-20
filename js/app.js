import { BaseEstacas, fmtCoord, fmtDist } from './geo.js';
import { db, pedirPersistencia } from './db.js';
import { renderizar, canvasParaBlob, carregarFonteCarimbo } from './stamp.js';
import { configurarApi, chamar, processarFila, aoMudarFila, apiConfigurada, estaEnviando } from './sync.js';

const CFG = window.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);
const AMARELO = '#FFC20E';
const LARANJA = '#FF8A3D';

const LISTAS_PADRAO = {
  tipos: ['Inspeção de rotina', 'Não conformidade', 'Medição / avanço', 'Segurança', 'Outro'],
  categorias: ['Terraplenagem', 'Drenagem', 'OAE', 'PN', 'Bueiro', 'Superestrutura', 'Segurança'],
};
const AJUSTES_PADRAO = {
  opc: { desc: true, seg: false, cid: false, pac: false, infra: false, super: false, oae: false },
  coord: 'dec', pos: 'inf', tam: 'M',
  galeria: false, galCom: true, galSem: false,
};
const OPCIONAIS = [
  ['desc', 'Descrição', 'Texto digitado no registro'],
  ['seg', 'Segmento', 'Ex.: Seg. 1.1'],
  ['cid', 'Cidade', 'Ex.: Mara Rosa'],
  ['pac', 'Pacote', 'Ex.: Pacote 1'],
  ['infra', 'Elementos de infraestrutura', 'Corte/aterro, bueiros, PI, PG'],
  ['super', 'Elementos de superestrutura', 'PN, curva/tangente'],
  ['oae', 'OAE', 'Pontes e travessias, quando houver'],
];
const EXTRAS_REV = [['seg', 'Segmento'], ['cid', 'Cidade'], ['pac', 'Pacote'], ['infra', 'Infraestrutura'], ['super', 'Superestrutura'], ['oae', 'OAE']];

const estado = {
  base: null,
  ajustes: structuredClone(AJUSTES_PADRAO),
  listas: structuredClone(LISTAS_PADRAO),
  limite: CFG.limiteFaixaPadrao || 40,
  codigo: '',
  nome: '',
  modo: 'rel',
  tipo: LISTAS_PADRAO.tipos[0],
  relatorio: null,
  sessaoAtiva: false,
  pos: null,
  estaca: null,
  stream: null,
  lanterna: false,
  captura: null,
  rev: null,
  ultimaDesc: '',
  filtro: 'hoje',
  telaAnterior: 'tela-inicio',
  wakeLock: null,
  gpsWatch: null,
  relogio: null,
};

// ------------------------------------------------------------------ utilidades
const pad = (n, t = 2) => String(n).padStart(t, '0');
function fmtData(d) {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function carimboId(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
const aleatorio = () => Math.random().toString(36).slice(2, 6).toUpperCase();
const eIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const hoje = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function carregando(msg) {
  $('carregando').hidden = !msg;
  if (msg) $('carregando-txt').textContent = msg;
}
function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat()) if (f != null) e.append(f);
  return e;
}

// ------------------------------------------------------------------ telas
const TELAS = ['tela-codigo', 'tela-inicio', 'tela-camera', 'tela-revisar', 'tela-config', 'tela-registros'];
let telaAtual = null;
function mostrar(id) {
  if (telaAtual && telaAtual !== id && ['tela-config', 'tela-registros'].includes(id)) estado.telaAnterior = telaAtual;
  for (const t of TELAS) $(t).hidden = t !== id;
  const saiuCamera = telaAtual === 'tela-camera' && id !== 'tela-camera';
  telaAtual = id;
  if (id === 'tela-camera') entrarCamera();
  else if (saiuCamera) sairCamera();
  if (id === 'tela-registros') renderRegistros();
  if (id === 'tela-config') renderConfig();
}

// ------------------------------------------------------------------ base de estacas
async function carregarBase() {
  let json = await db.kvGet('estacas');
  if (!json) {
    // cópia embutida opcional (data/estacas.json); por padrão a base vem do servidor, protegida pelo código
    try {
      const r = await fetch('data/estacas.json');
      if (r.ok) {
        json = await r.json();
        await db.kvSet('estacas', json);
      }
    } catch (e) { /* sem cópia embutida */ }
  }
  if (json) estado.base = new BaseEstacas(json);
}

async function garantirBase() {
  if (estado.base || !apiConfigurada() || !estado.codigo) return;
  if (!navigator.onLine) {
    toast('Conecte-se à internet uma vez para baixar a base de estacas.', 5000);
    return;
  }
  carregando('Baixando base de estacas (só na primeira vez)…');
  await sincronizarInicio();
  carregando(null);
}

async function sincronizarInicio(forcarBase = false) {
  if (!apiConfigurada() || !navigator.onLine || !estado.codigo) return;
  try {
    const r = await chamar('inicio', {}, 30000);
    if (r.limite) estado.limite = Number(r.limite) || estado.limite;
    if (r.listas) {
      if (r.listas.tipos && r.listas.tipos.length) estado.listas.tipos = r.listas.tipos;
      if (r.listas.categorias && r.listas.categorias.length) estado.listas.categorias = r.listas.categorias;
    }
    await db.kvSet('servidor', { limite: estado.limite, listas: estado.listas });
    if (telaAtual === 'tela-inicio') renderTipos();
    if (forcarBase || (r.versaoEstacas && (!estado.base || estado.base.versao !== r.versaoEstacas))) {
      const e = await chamar('estacas', {}, 120000);
      if (e.estacas && e.estacas.r && e.estacas.r.length) {
        await db.kvSet('estacas', e.estacas);
        estado.base = new BaseEstacas(e.estacas);
        atualizarPosicao();
        if (forcarBase) toast(`Base atualizada: ${estado.base.n.toLocaleString('pt-BR')} estacas`);
      }
    } else if (forcarBase) {
      toast('A base já está atualizada');
    }
  } catch (e) {
    if (e.codigoInvalido) {
      toast('Código da equipe inválido. Informe o código novamente.');
      estado.codigo = '';
      await db.kvSet('codigo', '');
      configurarApi(CFG.apiUrl, '');
      if (!estado.sessaoAtiva) mostrar('tela-codigo');
    } else if (forcarBase) {
      toast('Não foi possível falar com o servidor agora.');
    }
  }
}

// ------------------------------------------------------------------ GPS
function iniciarGPS() {
  if (estado.gpsWatch != null || !('geolocation' in navigator)) {
    if (!('geolocation' in navigator)) $('gps-txt').textContent = 'GPS indisponível';
    return;
  }
  estado.gpsWatch = navigator.geolocation.watchPosition((p) => {
    estado.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ts: p.timestamp };
    atualizarPosicao();
  }, (err) => {
    $('gps-ponto').className = 'ponto ruim';
    $('gps-txt').textContent = err.code === 1 ? 'GPS sem permissão' : 'Buscando GPS…';
    if (err.code === 1) toast('Permita o acesso à localização para identificar a estaca.', 4000);
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}

function atualizarPosicao() {
  const p = estado.pos;
  if (!p) return;
  estado.estaca = estado.base ? estado.base.maisProxima(p.lat, p.lon) : null;
  const acc = Math.round(p.acc);
  $('gps-txt').textContent = `GPS ±${acc} m`;
  $('gps-ponto').className = `ponto ${acc <= 10 ? 'bom' : acc <= 30 ? 'medio' : 'ruim'}`;
  const e = estado.estaca;
  const fora = e && e.distancia > estado.limite;
  $('est-pilula').hidden = !e || fora;
  $('fora-pilula').hidden = !fora;
  $('fora-faixa').hidden = !fora;
  if (e) {
    const eixo = e.eixo !== 'Linha principal' ? ` (${e.eixo})` : '';
    $('est-txt').textContent = `EST ${e.estaca}${eixo}`;
    $('est-dist').textContent = `· a ${fmtDist(e.distancia)} m`;
    $('fora-txt').textContent = `Estaca mais próxima ${e.estaca}${eixo} a ${fmtDist(e.distancia)} m`;
  }
  atualizarPreviaCamera();
}

// ------------------------------------------------------------------ legenda
function linhasLegenda(dados, extras, desc) {
  const L = [];
  L.push({ texto: fmtData(dados.data) });
  if (dados.pos) {
    L.push({ texto: `${fmtCoord(dados.pos.lat, dados.pos.lon, estado.ajustes.coord)}  ±${Math.round(dados.pos.acc)} m` });
  } else {
    L.push({ texto: 'Sem posição de GPS', cor: LARANJA });
  }
  const e = dados.estaca;
  if (e) {
    const eixo = e.eixo !== 'Linha principal' ? ` (${e.eixo})` : '';
    if (e.distancia > estado.limite) {
      L.push({ texto: 'FORA DA FAIXA DE DOMÍNIO', cor: LARANJA, negrito: true });
      L.push({ texto: `Estaca mais próxima ${e.estaca}${eixo} a ${fmtDist(e.distancia)} m`, cor: LARANJA, negrito: true });
    } else {
      L.push({ texto: `EST ${e.estaca}${eixo} · a ${fmtDist(e.distancia)} m`, cor: AMARELO, negrito: true });
    }
    const g = [extras.seg && `Seg. ${e.segmento}`, extras.cid && e.cidade, extras.pac && `Pacote ${e.pacote}`].filter(Boolean).join(' · ');
    if (g) L.push({ texto: g });
    if (extras.infra) L.push({ texto: `Infra: ${e.infra || '—'}` });
    if (extras.super) L.push({ texto: `Super: ${e.super || '—'}` });
    if (extras.oae) L.push({ texto: `OAE: ${e.oae || '—'}` });
  } else if (dados.pos) {
    L.push({ texto: 'Base de estacas não carregada', cor: LARANJA });
  }
  if (estado.ajustes.opc.desc && desc) L.push({ texto: desc });
  return L;
}

function previaDOM(alvo, linhas) {
  alvo.replaceChildren(...linhas.map((l) => el('div', { class: l.cor === AMARELO ? 'am' : l.cor === LARANJA ? 'la' : '' }, l.texto)));
  alvo.classList.toggle('sup', estado.ajustes.pos === 'sup');
}

function atualizarPreviaCamera() {
  if (telaAtual !== 'tela-camera') return;
  previaDOM($('legenda-previa'), linhasLegenda({ data: new Date(), pos: estado.pos, estaca: estado.estaca }, estado.ajustes.opc, ''));
}

// ------------------------------------------------------------------ código da equipe
$('form-codigo').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const cod = $('in-codigo').value.trim();
  if (!cod) return;
  $('codigo-erro').hidden = true;
  configurarApi(CFG.apiUrl, cod);
  if (navigator.onLine) {
    carregando('Verificando código…');
    try {
      await chamar('inicio', {}, 30000);
    } catch (e) {
      carregando(null);
      if (e.codigoInvalido) {
        $('codigo-erro').textContent = 'Código inválido. Confira com o responsável.';
        $('codigo-erro').hidden = false;
        return;
      }
      toast('Sem conexão com o servidor. O código será verificado depois.', 4000);
    }
    carregando(null);
  }
  estado.codigo = cod;
  await db.kvSet('codigo', cod);
  irParaInicio();
  iniciarGPS();
  await garantirBase();
  sincronizarInicio();
});

// ------------------------------------------------------------------ início
function renderTipos() {
  const cont = $('chips-tipo');
  if (!estado.listas.tipos.includes(estado.tipo)) estado.tipo = estado.listas.tipos[0];
  cont.replaceChildren(...estado.listas.tipos.map((t) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(t === estado.tipo),
    onclick: () => { estado.tipo = t; renderTipos(); },
  }, t)));
}

function renderModo() {
  document.querySelectorAll('.cartao-modo').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.modo === estado.modo)));
  $('painel-relatorio').hidden = estado.modo !== 'rel';
  $('btn-iniciar').firstChild.textContent = estado.modo === 'rel' ? 'Iniciar relatório ' : 'Começar a fotografar ';
}
document.querySelectorAll('.cartao-modo').forEach((b) => b.addEventListener('click', () => { estado.modo = b.dataset.modo; renderModo(); }));

function irParaInicio() {
  $('in-nome').value = estado.nome || '';
  renderTipos();
  renderModo();
  mostrar('tela-inicio');
}

$('form-inicio').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const nome = $('in-nome').value.trim();
  if (!nome) { $('in-nome').focus(); return; }
  estado.nome = nome;
  await db.kvSet('nome', nome);
  if (estado.modo === 'rel') {
    const agora = new Date();
    const rel = {
      id: `REL-${carimboId(agora)}`,
      tipo: estado.tipo,
      objeto: $('in-objeto').value.trim(),
      inspetor: nome,
      inicio: fmtData(agora),
      inicioTs: agora.getTime(),
      encerramento: '',
      status: 'Aberto',
      nFotos: 0,
      sincronizado: false,
    };
    await db.put('relatorios', rel);
    await db.kvSet('relatorioAberto', rel.id);
    estado.relatorio = rel;
    processarFila().catch(() => {});
  } else {
    estado.relatorio = null;
  }
  estado.ultimaDesc = '';
  estado.sessaoAtiva = true;
  $('in-objeto').value = '';
  mostrar('tela-camera');
});
$('btn-ver-registros').addEventListener('click', () => mostrar('tela-registros'));

// ------------------------------------------------------------------ relatório em aberto
async function verificarRelatorioAberto() {
  const id = await db.kvGet('relatorioAberto');
  if (!id) return false;
  const rel = await db.get('relatorios', id);
  if (!rel || rel.status !== 'Aberto') { await db.kvSet('relatorioAberto', null); return false; }
  const regs = (await db.all('registros')).filter((r) => r.idRelatorio === rel.id);
  const ult = regs.sort((a, b) => b.criadoEm - a.criadoEm)[0];
  const pend = regs.filter((r) => r.statusEnvio !== 'Enviado').length;
  $('ret-resumo').replaceChildren(...[
    el('strong', {}, `${rel.tipo}${rel.objeto ? ` · ${rel.objeto}` : ''}`),
    el('span', {}, `${rel.inspetor} · iniciado em ${rel.inicio}`),
    el('span', {}, `${regs.length} foto(s)${ult ? ` · última às ${ult.dataHora.slice(11, 16)} em EST ${ult.estaca}` : ''}`),
    pend ? el('span', { class: 'etq pend', style: 'align-self:flex-start;margin-top:4px' }, `${pend} foto(s) aguardando envio`) : null,
  ].filter(Boolean));
  $('dlg-retomar').hidden = false;
  $('btn-continuar-rel').onclick = () => {
    $('dlg-retomar').hidden = true;
    estado.relatorio = rel;
    estado.nome = rel.inspetor;
    estado.modo = 'rel';
    estado.sessaoAtiva = true;
    estado.ultimaDesc = ult ? ult.descricao || '' : '';
    mostrar('tela-camera');
  };
  $('btn-encerrar-novo').onclick = async () => {
    $('dlg-retomar').hidden = true;
    await encerrarRelatorio(rel);
    toast('Relatório anterior encerrado');
  };
  return true;
}

async function encerrarRelatorio(rel) {
  const regs = (await db.all('registros')).filter((r) => r.idRelatorio === rel.id);
  const agora = new Date();
  rel.status = 'Encerrado';
  rel.encerramento = fmtData(agora);
  rel.encerramentoTs = agora.getTime();
  rel.nFotos = regs.length;
  rel.sincronizado = false;
  await db.put('relatorios', rel);
  await db.kvSet('relatorioAberto', null);
  if (estado.relatorio && estado.relatorio.id === rel.id) estado.relatorio = null;
  processarFila().catch(() => {});
}

// ------------------------------------------------------------------ câmera
async function entrarCamera() {
  const rel = estado.relatorio;
  const nRel = rel ? (await db.all('registros')).filter((r) => r.idRelatorio === rel.id).length : 0;
  if (rel) {
    estado.nFoto = nRel + 1;
    $('cam-titulo').textContent = `Foto ${nRel + 1}`;
    $('cam-sub').textContent = ['Relatório', rel.tipo, rel.objeto, rel.inspetor].filter(Boolean).join(' · ');
    $('btn-encerrar-txt').textContent = 'Encerrar';
  } else {
    $('cam-titulo').textContent = 'Individuais';
    $('cam-sub').textContent = estado.nome;
    $('btn-encerrar-txt').textContent = 'Sair';
  }
  atualizarMiniatura();
  iniciarGPS();
  atualizarPosicao();
  atualizarPreviaCamera();
  clearInterval(estado.relogio);
  estado.relogio = setInterval(atualizarPreviaCamera, 1000);
  await iniciarVideo();
  try { if ('wakeLock' in navigator) estado.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* opcional */ }
}

function sairCamera() {
  clearInterval(estado.relogio);
  pararVideo();
  try { if (estado.wakeLock) estado.wakeLock.release(); } catch (e) { /* ok */ }
  estado.wakeLock = null;
}

async function iniciarVideo() {
  const video = $('video');
  if (estado.stream && estado.stream.getVideoTracks().some((t) => t.readyState === 'live')) return;
  $('visor-vazio').hidden = true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    mostrarSemCamera('Este navegador não abre a câmera dentro do app.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
    if (telaAtual !== 'tela-camera') { stream.getTracks().forEach((t) => t.stop()); return; }
    estado.stream = stream;
    video.srcObject = stream;
    await video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    $('btn-flash').hidden = !caps.torch;
    $('espaco-flash').hidden = !!caps.torch;
    estado.lanterna = false;
    $('btn-flash').setAttribute('aria-pressed', 'false');
  } catch (e) {
    console.warn(e);
    mostrarSemCamera(e.name === 'NotAllowedError' ? 'Permita o acesso à câmera ou use a câmera do celular.' : 'Não foi possível abrir a câmera.');
  }
}

function mostrarSemCamera(msg) {
  $('visor-msg').textContent = msg;
  $('visor-vazio').hidden = false;
  $('btn-flash').hidden = true;
  $('espaco-flash').hidden = false;
}

function pararVideo() {
  if (estado.stream) estado.stream.getTracks().forEach((t) => t.stop());
  estado.stream = null;
  $('video').srcObject = null;
}

$('btn-flash').addEventListener('click', async () => {
  const track = estado.stream && estado.stream.getVideoTracks()[0];
  if (!track) return;
  estado.lanterna = !estado.lanterna;
  try {
    await track.applyConstraints({ advanced: [{ torch: estado.lanterna }] });
    $('btn-flash').setAttribute('aria-pressed', String(estado.lanterna));
  } catch (e) { estado.lanterna = false; }
});

function exigirGPS() {
  if (!estado.pos) {
    toast('Aguardando a posição do GPS. Tente de novo em alguns segundos.', 3500);
    return false;
  }
  return true;
}

$('btn-foto').addEventListener('click', () => {
  if (!exigirGPS()) return;
  const video = $('video');
  if (!estado.stream || !video.videoWidth) { $('in-foto').click(); return; }
  const w = video.videoWidth;
  const h = video.videoHeight;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(video, 0, 0, w, h);
  iniciarRevisao(c, w, h);
});
$('btn-camera-nativa').addEventListener('click', () => { if (exigirGPS()) $('in-foto').click(); });
$('in-foto').addEventListener('change', async () => {
  const f = $('in-foto').files[0];
  $('in-foto').value = '';
  if (!f) return;
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    iniciarRevisao(bmp, bmp.width, bmp.height);
  } catch (e) {
    toast('Não foi possível abrir a foto.');
  }
});

$('btn-encerrar').addEventListener('click', async () => {
  if (!estado.relatorio) {
    estado.sessaoAtiva = false;
    irParaInicio();
    return;
  }
  const rel = estado.relatorio;
  const regs = (await db.all('registros')).filter((r) => r.idRelatorio === rel.id);
  const pend = regs.filter((r) => r.statusEnvio !== 'Enviado').length;
  const linha = (dt, dd, cls) => el('div', {}, el('dt', {}, dt), el('dd', {}, dd, cls));
  $('enc-resumo').replaceChildren(
    linha('Tipo', rel.tipo),
    linha('Objeto', rel.objeto || '—'),
    linha('Responsável', rel.inspetor),
    linha('Início', rel.inicio),
    el('div', {}, el('dt', {}, 'Fotos'), el('dd', {}, `${regs.length}`, pend ? el('span', { class: 'pend' }, ` · ${pend} aguardando envio`) : null)),
  );
  $('dlg-encerrar').hidden = false;
});
$('btn-cancelar-encerrar').addEventListener('click', () => { $('dlg-encerrar').hidden = true; });
$('btn-confirmar-encerrar').addEventListener('click', async () => {
  $('dlg-encerrar').hidden = true;
  await encerrarRelatorio(estado.relatorio);
  estado.sessaoAtiva = false;
  toast('Relatório encerrado');
  irParaInicio();
});
$('btn-config').addEventListener('click', () => mostrar('tela-config'));
$('btn-config2').addEventListener('click', () => mostrar('tela-config'));
$('btn-registros').addEventListener('click', () => mostrar('tela-registros'));

async function atualizarMiniatura() {
  const regs = await db.all('registros');
  const doContexto = estado.relatorio
    ? regs.filter((r) => r.idRelatorio === estado.relatorio.id)
    : regs.filter((r) => r.criadoEm >= hoje());
  const ult = doContexto.sort((a, b) => b.criadoEm - a.criadoEm)[0];
  const img = $('mini-img');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  if (ult && ult.thumb) {
    const u = URL.createObjectURL(ult.thumb);
    img.src = u;
    img.dataset.url = u;
    img.hidden = false;
  } else {
    img.hidden = true;
  }
  $('mini-cont').textContent = String(doContexto.length);
  $('mini-cont').hidden = !doContexto.length;
}

// ------------------------------------------------------------------ revisão
function iniciarRevisao(fonte, w, h) {
  const dados = { data: new Date(), pos: { ...estado.pos }, estaca: estado.estaca ? { ...estado.estaca } : null };
  estado.captura = { fonte, w, h, ...dados };
  const ex = estado.ajustes.opc;
  estado.rev = { desc: '', cats: new Set(), extras: { seg: ex.seg, cid: ex.cid, pac: ex.pac, infra: ex.infra, super: ex.super, oae: ex.oae } };
  $('in-desc').value = '';
  const e = dados.estaca;
  const fora = e && e.distancia > estado.limite;
  $('rev-titulo').textContent = estado.relatorio ? `Foto ${estado.nFoto || 1} do relatório` : 'Nova foto';
  $('rev-est').textContent = e
    ? (fora ? `Fora da faixa · EST ${e.estaca} a ${fmtDist(e.distancia)} m` : `EST ${e.estaca} · a ${fmtDist(e.distancia)} m do eixo`)
    : 'Estaca não identificada';
  $('rev-est-info').textContent = e ? [e.eixo !== 'Linha principal' ? e.eixo : '', `Seg. ${e.segmento}`, e.cidade, e.infra, e.super, e.oae].filter(Boolean).join(' · ') : '';
  document.querySelector('.cartao-estaca').classList.toggle('fora', !!fora);
  renderChipsRevisao();
  renderRepetir();
  mostrar('tela-revisar');
  desenharPreviaRevisao();
}

function renderRepetir() {
  const pode = !!estado.ultimaDesc && estado.rev.desc !== estado.ultimaDesc;
  $('btn-repetir').hidden = !pode;
  $('txt-anterior').textContent = estado.ultimaDesc;
}

function renderChipsRevisao() {
  $('chips-cat').replaceChildren(...estado.listas.categorias.map((c) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(estado.rev.cats.has(c)),
    onclick: () => { estado.rev.cats.has(c) ? estado.rev.cats.delete(c) : estado.rev.cats.add(c); renderChipsRevisao(); },
  }, c)));
  $('chips-extra').replaceChildren(...EXTRAS_REV.map(([k, rot]) => el('button', {
    type: 'button', class: 'chip amarelo', 'aria-pressed': String(!!estado.rev.extras[k]),
    onclick: () => { estado.rev.extras[k] = !estado.rev.extras[k]; renderChipsRevisao(); desenharPreviaRevisao(); },
  }, `${estado.rev.extras[k] ? '✓' : '+'} ${rot}`)));
}

let previaUrl = null;
let previaTimer = null;
function desenharPreviaRevisao() {
  clearTimeout(previaTimer);
  previaTimer = setTimeout(async () => {
    const c = estado.captura;
    if (!c) return;
    const canvas = renderizar(c.fonte, c.w, c.h, linhasLegenda(c, estado.rev.extras, estado.rev.desc),
      { posicao: estado.ajustes.pos, tamanho: estado.ajustes.tam, maxLado: 1280 });
    const blob = await canvasParaBlob(canvas, 0.8);
    if (previaUrl) URL.revokeObjectURL(previaUrl);
    previaUrl = URL.createObjectURL(blob);
    $('rev-img').src = previaUrl;
  }, 120);
}

$('in-desc').addEventListener('input', () => {
  estado.rev.desc = $('in-desc').value.trim();
  renderRepetir();
  desenharPreviaRevisao();
});
$('btn-repetir').addEventListener('click', () => {
  $('in-desc').value = estado.ultimaDesc;
  estado.rev.desc = estado.ultimaDesc;
  renderRepetir();
  desenharPreviaRevisao();
});
$('btn-refazer').addEventListener('click', () => { estado.captura = null; mostrar('tela-camera'); });

$('btn-salvar').addEventListener('click', async () => {
  const c = estado.captura;
  if (!c) return;
  $('btn-salvar').disabled = true;
  carregando('Salvando foto…');
  try {
    const opcoes = { posicao: estado.ajustes.pos, tamanho: estado.ajustes.tam, maxLado: 2560 };
    const linhas = linhasLegenda(c, estado.rev.extras, estado.rev.desc);
    const imgCom = await canvasParaBlob(renderizar(c.fonte, c.w, c.h, linhas, opcoes), 0.88);
    const imgSem = await canvasParaBlob(renderizar(c.fonte, c.w, c.h, null, { maxLado: 2560 }), 0.9);
    const thumb = await canvasParaBlob(renderizar(c.fonte, c.w, c.h, null, { maxLado: 240 }), 0.7);
    const e = c.estaca;
    const rel = estado.relatorio;
    const reg = {
      id: `R-${carimboId(c.data)}-${aleatorio()}`,
      criadoEm: c.data.getTime(),
      dataHora: fmtData(c.data),
      inspetor: estado.nome,
      modo: rel ? 'Relatório de inspeção' : 'Fotos individuais',
      idRelatorio: rel ? rel.id : '',
      lat: Number(c.pos.lat.toFixed(7)),
      lon: Number(c.pos.lon.toFixed(7)),
      precisao: Math.round(c.pos.acc),
      eixo: e ? e.eixo : '',
      estaca: e ? e.estaca : '',
      estacaM: e ? e.estacaM : '',
      distancia: e ? Math.round(e.distancia * 10) / 10 : '',
      situacao: e ? (e.distancia > estado.limite ? 'Fora da faixa de domínio' : 'Dentro da faixa') : '',
      pacote: e ? e.pacote : '',
      segmento: e ? e.segmento : '',
      cidade: e ? e.cidade : '',
      infra: e ? e.infra : '',
      super: e ? e.super : '',
      oae: e ? e.oae : '',
      categoria: [...estado.rev.cats].join('; '),
      descricao: estado.rev.desc,
      dispositivo: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
      statusEnvio: 'Pendente',
      imgCom, imgSem, thumb,
    };
    await db.put('registros', reg);
    if (rel) {
      const salvo = (await db.get('relatorios', rel.id)) || rel;
      salvo.nFotos = (salvo.nFotos || 0) + 1;
      await db.put('relatorios', salvo);
      estado.relatorio = salvo;
    }
    if (reg.descricao) estado.ultimaDesc = reg.descricao;
    carregando(null);
    estado.captura = null;
    mostrar('tela-camera');
    toast(navigator.onLine && apiConfigurada() ? 'Foto salva. Enviando ao Drive…' : 'Foto salva no celular. Será enviada quando houver conexão.');
    copiaGaleria(reg).catch((e) => console.warn(e));
    processarFila().catch(() => {});
  } catch (err) {
    console.error(err);
    carregando(null);
    toast('Não foi possível salvar a foto. Tente novamente.');
  } finally {
    $('btn-salvar').disabled = false;
  }
});

// ------------------------------------------------------------------ cópia na galeria
async function copiaGaleria(reg) {
  const a = estado.ajustes;
  if (!a.galeria) return;
  const base = `INSPECAO_${(reg.estaca || 'sem-estaca').replace(/[+,]/g, '-')}_${carimboId(new Date(reg.criadoEm)).replace('-', '_')}`;
  const arquivos = [];
  if (a.galCom) arquivos.push(new File([reg.imgCom], `${base}_com-legenda.jpg`, { type: 'image/jpeg' }));
  if (a.galSem) arquivos.push(new File([reg.imgSem], `${base}_sem-legenda.jpg`, { type: 'image/jpeg' }));
  if (!arquivos.length) return;
  if (eIOS() && navigator.canShare && navigator.canShare({ files: arquivos })) {
    // No iPhone o compartilhamento precisa de um toque novo do usuário.
    await new Promise((resolve) => {
      const t = $('toast');
      t.replaceChildren(el('span', {}, 'Foto salva. '), el('button', {
        type: 'button', class: 'btn-amarelo-peq', style: 'margin-left:8px',
        onclick: async () => { t.hidden = true; try { await navigator.share({ files: arquivos }); } catch (e) { /* cancelado */ } resolve(); },
      }, 'Salvar na galeria'));
      t.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { t.hidden = true; resolve(); }, 8000);
    });
    return;
  }
  for (const f of arquivos) {
    const url = URL.createObjectURL(f);
    const link = el('a', { href: url, download: f.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

// ------------------------------------------------------------------ configurações
async function salvarAjustes() {
  await db.kvSet('ajustes', estado.ajustes);
  renderConfig();
  atualizarPreviaCamera();
}

function renderConfig() {
  const a = estado.ajustes;
  $('lista-opcionais').replaceChildren(...OPCIONAIS.map(([k, rot, dica]) => el('div', { class: 'linha-switch' },
    el('div', {}, el('strong', {}, rot), el('small', {}, dica)),
    el('button', {
      type: 'button', role: 'switch', class: 'switch', 'aria-checked': String(!!a.opc[k]), 'aria-label': rot,
      onclick: () => { a.opc[k] = !a.opc[k]; salvarAjustes(); },
    }, el('span')))));
  const seg = (rotulo, chave, opcoes) => el('div', { class: 'linha-seg' }, el('span', {}, rotulo),
    el('div', { class: 'seg' }, ...opcoes.map(([v, r]) => el('button', {
      type: 'button', 'aria-pressed': String(a[chave] === v),
      onclick: () => { a[chave] = v; salvarAjustes(); },
    }, r))));
  $('linhas-seg').replaceChildren(
    seg('Coordenadas', 'coord', [['dec', 'Graus decimais'], ['utm', 'UTM']]),
    seg('Posição', 'pos', [['inf', 'Inferior'], ['sup', 'Superior']]),
    seg('Tamanho', 'tam', [['P', 'P'], ['M', 'M'], ['G', 'G']]),
  );
  $('sw-galeria').setAttribute('aria-checked', String(a.galeria));
  $('galeria-opcoes').hidden = !a.galeria;
  document.querySelectorAll('[data-gal]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.gal === 'com' ? a.galCom : a.galSem)));
  $('gal-aviso').hidden = a.galCom || a.galSem;

  const exemplo = estado.estaca || (estado.base ? estado.base.info(Math.min(1561, estado.base.n - 1), 3) : null);
  const posEx = estado.pos || (exemplo ? { lat: estado.base.lat[exemplo.idx], lon: estado.base.lon[exemplo.idx], acc: 4 } : null);
  previaDOM($('legenda-cfg'), linhasLegenda({ data: new Date(), pos: posEx, estaca: exemplo }, a.opc, 'Descrição digitada no registro'));

  $('info-base').textContent = estado.base
    ? `Base de estacas: ${estado.base.n.toLocaleString('pt-BR')} estacas (versão ${estado.base.versao}). Limite da faixa de domínio: ${estado.limite} m.`
    : 'Base de estacas não carregada.';
  $('info-servidor').textContent = apiConfigurada()
    ? (navigator.onLine ? 'Servidor configurado. Conectado.' : 'Servidor configurado. Sem conexão no momento.')
    : 'Servidor ainda não configurado: as fotos ficam salvas só neste celular.';
  $('btn-atualizar-base').hidden = !apiConfigurada();
  $('btn-trocar-codigo').hidden = !apiConfigurada();
}
$('sw-galeria').addEventListener('click', () => { estado.ajustes.galeria = !estado.ajustes.galeria; salvarAjustes(); });
document.querySelectorAll('[data-gal]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.gal === 'com' ? 'galCom' : 'galSem';
  estado.ajustes[k] = !estado.ajustes[k];
  salvarAjustes();
}));
$('btn-atualizar-base').addEventListener('click', async () => {
  if (!navigator.onLine) { toast('Sem conexão no momento.'); return; }
  carregando('Atualizando base de estacas…');
  await sincronizarInicio(true);
  carregando(null);
  renderConfig();
});
$('btn-trocar-codigo').addEventListener('click', async () => {
  estado.codigo = '';
  await db.kvSet('codigo', '');
  configurarApi(CFG.apiUrl, '');
  estado.sessaoAtiva = false;
  $('in-codigo').value = '';
  mostrar('tela-codigo');
});
$('btn-config-voltar').addEventListener('click', () => mostrar(estado.telaAnterior || 'tela-inicio'));

// ------------------------------------------------------------------ registros
const urlsLista = [];
async function renderRegistros() {
  urlsLista.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const regs = (await db.all('registros')).sort((a, b) => b.criadoEm - a.criadoEm);
  const pend = regs.filter((r) => r.statusEnvio !== 'Enviado');
  const deHoje = regs.filter((r) => r.criadoEm >= hoje());
  const filtros = [['hoje', `Hoje (${deHoje.length})`], ['pend', `Pendentes (${pend.length})`]];
  if (estado.relatorio) filtros.push(['rel', 'Relatório atual']);
  filtros.push(['todos', `Todos (${regs.length})`]);
  if (!filtros.some(([k]) => k === estado.filtro)) estado.filtro = 'hoje';
  $('chips-filtro').replaceChildren(...filtros.map(([k, r]) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(estado.filtro === k),
    onclick: () => { estado.filtro = k; renderRegistros(); },
  }, r)));
  const lista = estado.filtro === 'pend' ? pend
    : estado.filtro === 'rel' ? regs.filter((r) => estado.relatorio && r.idRelatorio === estado.relatorio.id)
      : estado.filtro === 'todos' ? regs : deHoje;
  const itens = lista.slice(0, 300).map((r) => {
    let img;
    if (r.thumb) { const u = URL.createObjectURL(r.thumb); urlsLista.push(u); img = el('img', { src: u, alt: '' }); } else img = el('span', { class: 'sem-img' });
    const fora = r.situacao === 'Fora da faixa de domínio';
    const conteudo = [img, el('div', { class: 'info' },
      el('div', { class: 'l1' }, el('span', {}, r.estaca ? `EST ${r.estaca}` : 'Sem estaca'), el('span', {}, r.dataHora.slice(0, 16))),
      el('div', { class: 'desc' }, r.descricao || '(sem descrição)'),
      el('div', { class: 'meta' }, [r.segmento && `Seg. ${r.segmento}`, r.cidade, r.infra].filter(Boolean).join(' · ')),
      el('div', { class: 'etiquetas' },
        el('span', { class: `etq ${r.statusEnvio === 'Enviado' ? 'ok' : 'pend'}` }, r.statusEnvio === 'Enviado' ? '✓ Enviado ao Drive' : 'Aguardando envio'),
        fora ? el('span', { class: 'etq fora' }, `Fora da faixa · ${fmtDist(r.distancia)} m`) : null))];
    return r.linkCom
      ? el('a', { class: 'item-reg', href: r.linkCom, target: '_blank', rel: 'noopener', style: 'color:inherit;text-decoration:none' }, ...conteudo)
      : el('div', { class: 'item-reg' }, ...conteudo);
  });
  $('lista-reg').replaceChildren(...(itens.length ? itens : [el('p', { class: 'vazio' }, 'Nenhum registro aqui ainda.')]));

  const aviso = $('aviso-envio');
  if (!apiConfigurada()) {
    aviso.hidden = !regs.length;
    $('aviso-titulo').textContent = 'Servidor não configurado';
    $('aviso-sub').textContent = 'As fotos ficam salvas neste celular.';
    $('btn-enviar').hidden = true;
  } else if (pend.length) {
    aviso.hidden = false;
    $('btn-enviar').hidden = false;
    $('aviso-titulo').textContent = estaEnviando() ? 'Enviando…' : navigator.onLine ? 'Envio pendente' : 'Sem conexão';
    $('aviso-sub').textContent = `${pend.length} foto(s) aguardando envio ao Drive`;
    $('btn-enviar').disabled = estaEnviando() || !navigator.onLine;
  } else {
    aviso.hidden = true;
  }
}
$('btn-enviar').addEventListener('click', async () => {
  try {
    const r = await processarFila();
    toast(r.enviados ? `${r.enviados} foto(s) enviada(s)` : 'Nada para enviar');
  } catch (e) {
    toast(e.codigoInvalido ? 'Código da equipe inválido.' : 'Falha no envio. Tentaremos de novo automaticamente.');
  }
});
$('btn-reg-voltar').addEventListener('click', () => mostrar(estado.telaAnterior || 'tela-inicio'));
$('btn-nova-foto').addEventListener('click', () => (estado.sessaoAtiva ? mostrar('tela-camera') : irParaInicio()));

aoMudarFila(() => {
  if (telaAtual === 'tela-registros') renderRegistros();
  if (telaAtual === 'tela-camera') atualizarMiniatura();
});

// ------------------------------------------------------------------ ciclo de vida
window.addEventListener('online', () => { processarFila().catch(() => {}); sincronizarInicio(); if (telaAtual === 'tela-registros') renderRegistros(); });
window.addEventListener('offline', () => { if (telaAtual === 'tela-registros') renderRegistros(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (telaAtual === 'tela-camera') { iniciarVideo(); try { if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then((w) => { estado.wakeLock = w; }); } catch (e) { /* ok */ } }
    processarFila().catch(() => {});
  }
});
setInterval(() => { processarFila().catch(() => {}); }, 60000);

async function iniciar() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn(e));
  pedirPersistencia();
  carregarFonteCarimbo();
  const [ajustes, codigo, nome, servidor] = await Promise.all([db.kvGet('ajustes'), db.kvGet('codigo'), db.kvGet('nome'), db.kvGet('servidor')]);
  if (ajustes) estado.ajustes = { ...structuredClone(AJUSTES_PADRAO), ...ajustes, opc: { ...AJUSTES_PADRAO.opc, ...(ajustes.opc || {}) } };
  if (servidor) {
    if (servidor.limite) estado.limite = servidor.limite;
    if (servidor.listas) estado.listas = { ...estado.listas, ...servidor.listas };
  }
  estado.codigo = codigo || '';
  estado.nome = nome || '';
  configurarApi(CFG.apiUrl, estado.codigo);
  carregando('Carregando base de estacas…');
  await carregarBase();
  carregando(null);
  if (apiConfigurada() && !estado.codigo) {
    mostrar('tela-codigo');
    return;
  }
  irParaInicio();
  iniciarGPS();
  await garantirBase();
  await verificarRelatorioAberto();
  sincronizarInicio();
  processarFila().catch(() => {});
}

iniciar();
