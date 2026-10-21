import { BaseEstacas, fmtCoord, fmtDist } from './geo.js';
import { db, pedirPersistencia } from './db.js';
import { renderizar, canvasParaBlob, carregarFonteCarimbo } from './stamp.js';
import { configurarApi, chamar, processarFila, aoMudarFila, apiConfigurada, estaEnviando } from './sync.js';
import {
  RESOLUCOES, Gravador, gravacaoSuportada, gerarSRT, arquivoDoVideo, apagarVideo, recuperarInterrompidos,
  fmtDuracao, fmtTamanho, tipoBase,
} from './video.js';

const CFG = window.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);
const AMARELO = '#B8F34A'; // verde-lima (destaque da estaca na legenda)
const LARANJA = '#FF8A3D';

const LISTAS_PADRAO = {
  tipos: ['Inspeção de rotina', 'Não conformidade', 'Medição / avanço', 'Segurança', 'Outro'],
  categorias: ['Terraplenagem', 'Drenagem', 'OAE', 'PN', 'Bueiro', 'Superestrutura', 'Segurança'],
};
const AJUSTES_PADRAO = {
  opc: { desc: true, seg: false, cid: false, pac: false, infra: false, super: false, oae: false },
  coord: 'dec', pos: 'inf', tam: 'M',
  galeria: true, galCom: true, galSem: false,
  vidRes: '720', vidSom: true, vidQueimar: false,
  v: 2,
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
  modoCam: 'foto',
  gravador: null,
  rvCats: new Set(),
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
const TELAS = ['tela-codigo', 'tela-inicio', 'tela-camera', 'tela-revisar', 'tela-config', 'tela-registros', 'tela-relatorios', 'tela-video'];
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
  if (id === 'tela-relatorios') renderRelatorios();
  if (id === 'tela-inicio') { atualizarPendInicio(); renderInstalar(); }
  const corpo = $(id).querySelector('.rolavel');
  if (corpo) corpo.scrollTop = 0;
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
function linhasLegenda(dados, extras, desc, formatoCoord) {
  const L = [];
  L.push({ texto: fmtData(dados.data) });
  if (dados.pos) {
    L.push({ texto: `${fmtCoord(dados.pos.lat, dados.pos.lon, formatoCoord || estado.ajustes.coord)}  ±${Math.round(dados.pos.acc)} m` });
    if (formatoCoord === 'dec' && estado.ajustes.coord === 'utm') L.push({ texto: fmtCoord(dados.pos.lat, dados.pos.lon, 'utm') });
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
  if (estado.atualizacaoPendente) { location.reload(); return; }
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
$('btn-ver-relatorios').addEventListener('click', () => mostrar('tela-relatorios'));

async function atualizarPendInicio() {
  const n = (await db.all('registros')).filter((r) => r.statusEnvio !== 'Enviado').length;
  $('inicio-pend').textContent = String(n);
  $('inicio-pend').hidden = !n;
  $('inicio-pend').setAttribute('aria-label', `${n} foto(s) aguardando envio`);
}

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
  marcarModoCam();
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
  if (estado.gravador && estado.gravador.ativo) estado.gravador.parar().catch(() => {});
  clearInterval(estado.relogio);
  pararVideo();
  try { if (estado.wakeLock) estado.wakeLock.release(); } catch (e) { /* ok */ }
  estado.wakeLock = null;
}

function chaveStream() {
  return estado.modoCam === 'video' ? `video-${estado.ajustes.vidRes}-${estado.ajustes.vidSom ? 'som' : 'mudo'}` : 'foto';
}

async function iniciarVideo() {
  const video = $('video');
  if (estado.stream && estado.streamChave === chaveStream() && estado.stream.getVideoTracks().some((t) => t.readyState === 'live')) return;
  if (estado.stream) pararVideo();
  $('visor-vazio').hidden = true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    mostrarSemCamera('Este navegador não abre a câmera dentro do app.');
    return;
  }
  try {
    const modoVideo = estado.modoCam === 'video';
    const R = RESOLUCOES[estado.ajustes.vidRes] || RESOLUCOES[720];
    const pedido = modoVideo
      ? { video: { facingMode: { ideal: 'environment' }, width: { ideal: R.w }, height: { ideal: R.h }, frameRate: { ideal: 30 } }, audio: !!estado.ajustes.vidSom }
      : { video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(pedido);
    } catch (e) {
      if (!pedido.audio) throw e;
      // sem permissão de microfone: grava sem som
      stream = await navigator.mediaDevices.getUserMedia({ ...pedido, audio: false });
      toast('Microfone sem permissão: o vídeo será gravado sem som.', 4000);
    }
    if (telaAtual !== 'tela-camera') { stream.getTracks().forEach((t) => t.stop()); return; }
    estado.stream = stream;
    estado.streamChave = chaveStream();
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
  estado.streamChave = null;
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
  if (estado.modoCam === 'video') { alternarGravacao(); return; }
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
$('btn-registros').addEventListener('click', () => {
  estado.relSel = null;
  estado.filtro = estado.relatorio ? 'rel' : 'hoje';
  mostrar('tela-registros');
});

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

// ------------------------------------------------------------------ vídeo
function marcarModoCam() {
  const v = estado.modoCam === 'video';
  document.querySelectorAll('[data-modo-cam]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.modoCam === estado.modoCam)));
  const ob = $('btn-foto');
  ob.classList.toggle('video', v);
  ob.setAttribute('aria-label', v ? 'Iniciar gravação' : 'Tirar foto');
  $('btn-camera-nativa').hidden = v;
  $('cam-titulo').textContent = v ? 'Vídeo' : (estado.relatorio ? `Foto ${estado.nFoto || 1}` : 'Individuais');
}

document.querySelectorAll('[data-modo-cam]').forEach((b) => b.addEventListener('click', async () => {
  const modo = b.dataset.modoCam;
  if (modo === estado.modoCam || (estado.gravador && estado.gravador.ativo)) return;
  if (modo === 'video' && !gravacaoSuportada()) {
    toast('Este navegador não grava vídeo. Atualize o Chrome (Android) ou o iOS.', 4500);
    return;
  }
  estado.modoCam = modo;
  marcarModoCam();
  await iniciarVideo();
}));

function amostraAgora() {
  return {
    ts: Date.now(),
    pos: estado.pos ? { lat: estado.pos.lat, lon: estado.pos.lon, acc: estado.pos.acc } : null,
    estaca: estado.estaca ? { ...estado.estaca } : null,
  };
}

let recTimer = null;
function mostrarRec(g) {
  $('rec').hidden = !g;
  $('selo-previa').hidden = !!g;
  if (!g) return;
  $('rec-tempo').textContent = fmtDuracao(g.segundos());
  $('rec-tam').textContent = fmtTamanho(g.tamanho);
}

async function alternarGravacao() {
  const g = estado.gravador;
  if (g && g.ativo) { await pararGravacao(); return; }
  const video = $('video');
  if (!estado.stream || !video.videoWidth) { toast('A câmera ainda não está pronta.'); return; }
  if (!estado.pos) toast('GPS ainda sem sinal: a legenda mostrará "Sem posição" até o sinal chegar.', 4000);
  try {
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    if (est && est.quota && est.quota - est.usage < 300 * 1048576) {
      toast('Pouco espaço livre no celular. Apague vídeos antigos em Relatórios e envios.', 5000);
    }
  } catch (e) { /* opcional */ }
  const agora = new Date();
  const e0 = estado.estaca;
  const rel = estado.relatorio;
  const reg = {
    id: `V-${carimboId(agora)}-${aleatorio()}`,
    base: `VID_${carimboId(agora).replace('-', '_')}_EST-${(e0 ? e0.estaca : 'sem-estaca').replace(/[+,]/g, '-')}`,
    criadoEm: agora.getTime(),
    inicioTs: agora.getTime(),
    inspetor: estado.nome,
    idRelatorio: rel ? rel.id : '',
    relRotulo: rel ? [rel.tipo, rel.objeto].filter(Boolean).join(' · ') : '',
    resolucao: (RESOLUCOES[estado.ajustes.vidRes] || RESOLUCOES[720]).rotulo,
    som: estado.stream.getAudioTracks().length > 0,
    descricao: '',
    categoria: '',
    amostras: [],
  };
  const gr = new Gravador({
    stream: estado.stream,
    video,
    resolucao: estado.ajustes.vidRes,
    queimar: estado.ajustes.vidQueimar,
    registro: reg,
    amostraAgora,
    linhasAgora: () => linhasLegenda({ data: new Date(), pos: estado.pos, estaca: estado.estaca }, estado.ajustes.opc, ''),
    opcoesLegenda: () => ({ posicao: estado.ajustes.pos, tamanho: estado.ajustes.tam }),
    aoProgresso: (x) => mostrarRec(x),
  });
  try {
    await gr.iniciar();
  } catch (err) {
    console.error(err);
    toast(`Não foi possível gravar: ${err.message || err}`, 5000);
    return;
  }
  estado.gravador = gr;
  $('tela-camera').classList.add('gravando');
  $('btn-foto').classList.add('gravando');
  $('btn-foto').setAttribute('aria-label', 'Parar gravação');
  mostrarRec(gr);
  clearInterval(recTimer);
  recTimer = setInterval(() => mostrarRec(gr), 500);
}

async function pararGravacao() {
  const g = estado.gravador;
  if (!g) return;
  carregando('Finalizando o vídeo…');
  clearInterval(recTimer);
  try {
    const reg = await g.parar();
    estado.gravador = null;
    $('tela-camera').classList.remove('gravando');
    $('btn-foto').classList.remove('gravando');
    mostrarRec(null);
    marcarModoCam();
    carregando(null);
    await abrirRevisaoVideo(reg);
  } catch (err) {
    console.error(err);
    estado.gravador = null;
    $('tela-camera').classList.remove('gravando');
    $('btn-foto').classList.remove('gravando');
    mostrarRec(null);
    carregando(null);
    toast('Falha ao finalizar o vídeo. O que foi gravado ficou em Relatórios e envios.', 5000);
  }
}

// trecho percorrido, distância fora da faixa etc. a partir das amostras
function resumoVideo(v) {
  const am = (v.amostras || []).filter((a) => a.estaca);
  const ms = am.map((a) => Number(a.estaca.estacaM));
  let trecho = '';
  if (ms.length) {
    const a0 = am[ms.indexOf(Math.min(...ms))].estaca;
    const a1 = am[ms.indexOf(Math.max(...ms))].estaca;
    trecho = a0.estaca === a1.estaca ? `EST ${a0.estaca}` : `EST ${a0.estaca} a ${a1.estaca}`;
    if (a0.eixo && a0.eixo !== 'Linha principal') trecho += ` (${a0.eixo})`;
  }
  const fora = am.filter((a) => a.estaca.distancia > estado.limite).length;
  return { trecho, fora, semGps: (v.amostras || []).filter((a) => !a.pos).length };
}

function srtDoVideo(v) {
  const extras = estado.ajustes.opc;
  const cab = [
    v.inspetor && `Inspetor: ${v.inspetor}`,
    v.idRelatorio && `Relatório: ${v.idRelatorio}${v.relRotulo ? ` · ${v.relRotulo}` : ''}`,
    v.categoria && `Categoria: ${v.categoria}`,
    v.descricao && `Descrição: ${v.descricao}`,
  ];
  return gerarSRT(v.amostras || [], (a) => linhasLegenda({ data: new Date(a.ts), pos: a.pos, estaca: a.estaca }, extras, '', 'dec').map((l) => l.texto), cab, v.duracao);
}

let videoUrl = null;
let videoRev = null;
async function abrirRevisaoVideo(v) {
  videoRev = v;
  const blob = await arquivoDoVideo(v);
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(blob);
  $('rv-video').src = videoUrl;
  const r = resumoVideo(v);
  $('rv-titulo').textContent = `${fmtDuracao(v.duracao)} · ${fmtTamanho(v.tamanho)} · ${v.resolucao}`;
  $('rv-info').textContent = [r.trecho || 'Sem estaca', r.fora ? `${r.fora} s fora da faixa` : '', v.som ? 'com som' : 'sem som', v.queimada ? 'legenda na imagem' : ''].filter(Boolean).join(' · ');
  $('rv-desc').value = v.descricao || '';
  estado.rvCats = new Set((v.categoria || '').split('; ').filter(Boolean));
  renderRvCats();
  mostrar('tela-video');
}

function renderRvCats() {
  $('rv-cats').replaceChildren(...estado.listas.categorias.map((c) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(estado.rvCats.has(c)),
    onclick: () => { estado.rvCats.has(c) ? estado.rvCats.delete(c) : estado.rvCats.add(c); renderRvCats(); },
  }, c)));
}

function fecharRevisaoVideo() {
  $('rv-video').pause();
  $('rv-video').removeAttribute('src');
  $('rv-video').load();
  if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = null; }
  videoRev = null;
  mostrar('tela-camera');
}

$('btn-video-salvar').addEventListener('click', async () => {
  const v = videoRev;
  if (!v) return;
  v.descricao = $('rv-desc').value.trim();
  v.categoria = [...estado.rvCats].join('; ');
  v.status = 'salvo';
  v.salvoEm = Date.now();
  await db.put('videos', v);
  await salvarArquivosVideo(v);
  fecharRevisaoVideo();
});
$('btn-video-descartar').addEventListener('click', async () => {
  const v = videoRev;
  if (!v) return;
  if (!confirm('Descartar este vídeo? Ele será apagado do celular.')) return;
  await apagarVideo(v.id);
  toast('Vídeo descartado');
  fecharRevisaoVideo();
});

// Salva o vídeo e a legenda nos arquivos do celular (Downloads no Android; Fotos/Arquivos no iPhone).
async function salvarArquivosVideo(v) {
  const video = new File([await arquivoDoVideo(v)], `${v.base}.${v.ext || 'webm'}`, { type: tipoBase(v.mime) });
  const legenda = new File([`﻿${srtDoVideo(v)}`], `${v.base}.srt`, { type: 'application/x-subrip' });
  if (eIOS() && navigator.canShare && navigator.canShare({ files: [video] })) {
    $('dlg-salvar-video').hidden = false;
    $('btn-sv-video').onclick = async () => { try { await navigator.share({ files: [video] }); } catch (e) { /* cancelado */ } };
    $('btn-sv-legenda').onclick = async () => {
      try {
        await navigator.share({ files: [legenda] });
      } catch (e) {
        baixarArquivo(legenda);
      }
    };
    $('btn-sv-fechar').onclick = () => { $('dlg-salvar-video').hidden = true; };
    return;
  }
  baixarArquivo(video);
  setTimeout(() => baixarArquivo(legenda), 700);
  toast('Vídeo e legenda salvos na pasta Downloads do celular.', 4500);
}

function baixarArquivo(f) {
  const url = URL.createObjectURL(f);
  const a = el('a', { href: url, download: f.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// lista de vídeos guardados no celular (tela Relatórios e envios)
const urlsVideos = [];
async function renderVideosCelular() {
  urlsVideos.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const vids = (await db.all('videos')).filter((v) => v.status !== 'gravando').sort((a, b) => b.criadoEm - a.criadoEm);
  $('secao-videos').hidden = !vids.length;
  if (!vids.length) return;
  const total = vids.reduce((s, v) => s + (v.tamanho || 0), 0);
  $('videos-total').textContent = `${vids.length} · ${fmtTamanho(total)}`;
  $('lista-videos').replaceChildren(...vids.map((v) => {
    let img;
    if (v.thumb) { const u = URL.createObjectURL(v.thumb); urlsVideos.push(u); img = el('img', { src: u, alt: '' }); } else img = el('span', { class: 'sem-img' });
    const r = resumoVideo(v);
    const d = new Date(v.criadoEm);
    const estadoTxt = v.status === 'interrompido' ? 'Gravação interrompida (recuperada)' : v.status === 'gravado' ? 'Ainda não salvo nos arquivos' : 'Salvo nos arquivos do celular';
    return el('div', { class: 'item-video' },
      el('div', { class: 'l' }, img, el('div', { class: 'info' },
        el('strong', {}, `${fmtData(d).slice(0, 16)} · ${fmtDuracao(v.duracao)}`),
        el('span', {}, [r.trecho || 'Sem estaca', fmtTamanho(v.tamanho), v.resolucao].join(' · ')),
        el('span', {}, [v.relRotulo || 'Vídeo avulso', v.descricao].filter(Boolean).join(' · ')),
        el('span', { class: `etq ${v.status === 'salvo' ? 'ok' : 'pend'}`, style: 'align-self:flex-start;margin-top:3px' }, estadoTxt))),
      el('div', { class: 'acoes' },
        el('button', { type: 'button', onclick: () => salvarArquivosVideo(v).then(async () => { if (v.status !== 'salvo') { v.status = 'salvo'; v.salvoEm = Date.now(); await db.put('videos', v); renderVideosCelular(); } }) }, v.status === 'salvo' ? 'Salvar de novo' : 'Salvar arquivos'),
        el('button', { type: 'button', class: 'perigo', onclick: async () => {
          if (!confirm(`Apagar este vídeo do app (${fmtTamanho(v.tamanho)})? Os arquivos já salvos no celular não são apagados.`)) return;
          await apagarVideo(v.id);
          renderVideosCelular();
          renderRelatorios();
        } }, 'Apagar do app')));
  }));
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
  $('linhas-video').replaceChildren(seg('Resolução', 'vidRes', [['480', '480p'], ['720', '720p'], ['1080', '1080p']]));
  $('sw-som').setAttribute('aria-checked', String(!!a.vidSom));
  $('sw-queimar').setAttribute('aria-checked', String(!!a.vidQueimar));
  const R = RESOLUCOES[a.vidRes] || RESOLUCOES[720];
  $('video-estimativa').textContent = `Em ${R.rotulo}, cada minuto de vídeo ocupa cerca de ${R.mbMin} MB no celular.`;
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
$('sw-som').addEventListener('click', () => { estado.ajustes.vidSom = !estado.ajustes.vidSom; salvarAjustes(); });
$('sw-queimar').addEventListener('click', () => { estado.ajustes.vidQueimar = !estado.ajustes.vidQueimar; salvarAjustes(); });
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
  const filtros = [];
  if (estado.relSel) filtros.push(['sel', estado.relSel === 'IND' ? 'Fotos individuais' : `Relatório ${estado.relSelNome || ''}`.trim()]);
  filtros.push(['hoje', `Hoje (${deHoje.length})`], ['pend', `Pendentes (${pend.length})`]);
  if (estado.relatorio) filtros.push(['rel', 'Relatório atual']);
  filtros.push(['todos', `Todos (${regs.length})`]);
  if (!filtros.some(([k]) => k === estado.filtro)) estado.filtro = 'hoje';
  $('chips-filtro').replaceChildren(...filtros.map(([k, r]) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(estado.filtro === k),
    onclick: () => { estado.filtro = k; renderRegistros(); },
  }, r)));
  const lista = estado.filtro === 'sel' ? regs.filter((r) => (estado.relSel === 'IND' ? !r.idRelatorio : r.idRelatorio === estado.relSel))
    : estado.filtro === 'pend' ? pend
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
  if (telaAtual === 'tela-relatorios') renderRelatorios();
  if (telaAtual === 'tela-inicio') atualizarPendInicio();
  if (telaAtual === 'tela-camera') atualizarMiniatura();
});

// ------------------------------------------------------------------ relatórios e envios
async function renderRelatorios() {
  const [rels, regs, vids] = await Promise.all([db.all('relatorios'), db.all('registros'), db.all('videos')]);
  renderVideosCelular();
  const pend = regs.filter((r) => r.statusEnvio !== 'Enviado');
  $('res-total').textContent = String(regs.length);
  $('res-enviadas').textContent = String(regs.length - pend.length);
  $('res-pend').textContent = String(pend.length);

  const aviso = $('rels-aviso');
  if (!apiConfigurada()) {
    aviso.hidden = false;
    $('rels-aviso-titulo').textContent = 'Servidor não configurado';
    $('rels-aviso-sub').textContent = 'As fotos ficam salvas só neste celular.';
    $('btn-rels-enviar').hidden = true;
  } else if (pend.length) {
    aviso.hidden = false;
    $('btn-rels-enviar').hidden = false;
    $('rels-aviso-titulo').textContent = estaEnviando() ? 'Enviando…' : navigator.onLine ? 'Envio pendente' : 'Sem conexão';
    $('rels-aviso-sub').textContent = navigator.onLine
      ? `${pend.length} foto(s) aguardando envio ao Drive`
      : `${pend.length} foto(s) serão enviadas quando houver sinal`;
    $('btn-rels-enviar').disabled = estaEnviando() || !navigator.onLine;
  } else {
    aviso.hidden = true;
  }

  const porRel = new Map();
  for (const r of regs) {
    const k = r.idRelatorio || 'IND';
    if (!porRel.has(k)) porRel.set(k, []);
    porRel.get(k).push(r);
  }
  const grupos = rels.map((rel) => ({ rel, fotos: porRel.get(rel.id) || [], ts: rel.inicioTs || 0 }));
  if (porRel.has('IND')) {
    const f = porRel.get('IND');
    grupos.push({ rel: null, fotos: f, ts: Math.max(...f.map((x) => x.criadoEm)) });
  }
  const filtro = estado.filtroRels || 'todos';
  const contAberto = grupos.filter((g) => g.rel && g.rel.status === 'Aberto').length;
  const contPend = grupos.filter((g) => g.fotos.some((x) => x.statusEnvio !== 'Enviado') || (g.rel && !g.rel.sincronizado)).length;
  const fil = [['todos', `Todos (${grupos.length})`], ['pend', `Com pendência (${contPend})`], ['aberto', `Em aberto (${contAberto})`]];
  $('chips-rels').replaceChildren(...fil.map(([k, r]) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(filtro === k),
    onclick: () => { estado.filtroRels = k; renderRelatorios(); },
  }, r)));

  const visiveis = grupos
    .filter((g) => filtro === 'todos'
      || (filtro === 'aberto' && g.rel && g.rel.status === 'Aberto')
      || (filtro === 'pend' && (g.fotos.some((x) => x.statusEnvio !== 'Enviado') || (g.rel && !g.rel.sincronizado))))
    .sort((a, b) => b.ts - a.ts);

  const cartoes = visiveis.map(({ rel, fotos }) => {
    const env = fotos.filter((x) => x.statusEnvio === 'Enviado').length;
    const pe = fotos.length - env;
    const fora = fotos.filter((x) => x.situacao === 'Fora da faixa de domínio').length;
    const ests = fotos.filter((x) => x.estacaM !== '' && x.estacaM != null).map((x) => Number(x.estacaM));
    const trecho = ests.length ? (Math.min(...ests) === Math.max(...ests)
      ? `EST ${fotos.find((x) => Number(x.estacaM) === Math.min(...ests)).estaca}`
      : `EST ${fotos.find((x) => Number(x.estacaM) === Math.min(...ests)).estaca} a ${fotos.find((x) => Number(x.estacaM) === Math.max(...ests)).estaca}`) : '';
    const pct = fotos.length ? Math.round((env / fotos.length) * 100) : 0;
    const titulo = rel ? `${rel.tipo}${rel.objeto ? ` · ${rel.objeto}` : ''}` : 'Fotos individuais';
    const etqStatus = rel
      ? el('span', { class: `etq ${rel.status === 'Aberto' ? 'aberto' : 'encerrado'}` }, rel.status)
      : el('span', { class: 'etq encerrado' }, 'Avulsas');
    const linhaEnvio = !fotos.length
      ? el('span', {}, 'Nenhuma foto ainda')
      : pe
        ? el('span', { class: 'etq pend' }, `${pe} de ${fotos.length} aguardando envio`)
        : el('span', { class: 'etq ok' }, `✓ ${fotos.length} foto(s) no Drive`);
    const syncRel = rel && !rel.sincronizado && apiConfigurada()
      ? el('span', { class: 'etq pend' }, rel.status === 'Encerrado' ? 'Encerramento não enviado' : 'Relatório não enviado')
      : null;
    return el('button', {
      type: 'button', class: `cartao-rel${rel && rel.status === 'Aberto' ? ' aberto' : ''}`,
      onclick: () => {
        estado.relSel = rel ? rel.id : 'IND';
        estado.relSelNome = rel ? (rel.objeto || rel.tipo) : '';
        estado.filtro = 'sel';
        mostrar('tela-registros');
      },
    },
    el('div', { class: 'topo' }, el('span', { class: 'titulo' }, titulo), etqStatus),
    rel ? el('span', {}, `${rel.inspetor} · ${rel.inicio.slice(0, 16)}${rel.encerramento ? ` até ${rel.encerramento.slice(11, 16)}` : ''}`) : null,
    el('span', {}, [`${fotos.length} foto(s)`, (() => { const n = vids.filter((x) => (rel ? x.idRelatorio === rel.id : !x.idRelatorio) && x.status !== 'gravando').length; return n ? `${n} vídeo(s) no celular` : ''; })(), trecho, fora ? `${fora} fora da faixa` : ''].filter(Boolean).join(' · ')),
    fotos.length ? el('div', { class: 'barra-prog', role: 'img', 'aria-label': `${pct}% enviado` }, el('span', { style: `width:${pct}%` })) : null,
    el('div', { class: 'rodape' }, el('div', { class: 'etiquetas' }, linhaEnvio, syncRel), fotos.length ? el('span', { class: 'ver' }, 'Ver fotos') : null));
  });
  $('lista-rels').replaceChildren(...(cartoes.length ? cartoes : [el('p', { class: 'vazio' }, grupos.length ? 'Nada com esse filtro.' : 'Nenhum relatório ou foto registrado neste celular ainda.')]));
}
$('btn-rels-enviar').addEventListener('click', async () => {
  try {
    const r = await processarFila();
    toast(r.enviados ? `${r.enviados} foto(s) enviada(s)` : 'Tudo enviado');
  } catch (e) {
    toast(e.codigoInvalido ? 'Código da equipe inválido.' : 'Falha no envio. Tentaremos de novo automaticamente.');
  }
  renderRelatorios();
});
$('btn-rels-voltar').addEventListener('click', () => (estado.sessaoAtiva ? mostrar('tela-camera') : irParaInicio()));

// ------------------------------------------------------------------ instalar na tela do celular
let pedidoInstalacao = null;
const instalado = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  pedidoInstalacao = ev;
  renderInstalar();
});
window.addEventListener('appinstalled', () => {
  pedidoInstalacao = null;
  renderInstalar();
  toast('App instalado. Procure o ícone “Inspeção” na tela do celular.', 4000);
});
function renderInstalar() {
  $('btn-instalar').hidden = instalado();
}
$('btn-instalar').addEventListener('click', async () => {
  if (pedidoInstalacao) {
    pedidoInstalacao.prompt();
    try { await pedidoInstalacao.userChoice; } catch (e) { /* ok */ }
    pedidoInstalacao = null;
    renderInstalar();
    return;
  }
  const ua = navigator.userAgent;
  const passos = [];
  let nota = '';
  if (eIOS()) {
    if (!/Safari/.test(ua) || /CriOS|FxiOS|EdgiOS/.test(ua)) {
      passos.push('Abra este endereço no <b>Safari</b>.');
    }
    passos.push('Toque no botão <b>Compartilhar</b> (quadrado com seta para cima), na barra do Safari.');
    passos.push('Role a lista e toque em <b>Adicionar à Tela de Início</b>.');
    passos.push('Toque em <b>Adicionar</b>.');
    nota = 'O ícone “Inspeção” aparece na tela do iPhone e abre o app em tela cheia.';
  } else if (/Android/.test(ua)) {
    if (/wv\)|FBAN|FBAV|Instagram|WhatsApp/.test(ua)) passos.push('Abra este endereço no <b>Chrome</b> (o navegador dentro de outros apps não instala).');
    passos.push('Toque no menu <b>⋮</b> no canto superior direito do Chrome.');
    passos.push('Toque em <b>Instalar app</b> ou <b>Adicionar à tela inicial</b>.');
    passos.push('Confirme em <b>Instalar</b>.');
    nota = 'Se a opção não aparecer, o app pode já estar instalado: procure o ícone “Inspeção” na tela do celular.';
  } else {
    passos.push('No computador, clique no ícone de instalar na barra de endereço do Chrome ou Edge.');
    passos.push('No celular, abra este endereço no Chrome (Android) ou no Safari (iPhone) e use “Instalar app” ou “Adicionar à Tela de Início”.');
  }
  $('inst-passos').innerHTML = passos.map((p) => `<li>${p}</li>`).join('');
  $('inst-nota').textContent = nota;
  $('dlg-instalar').hidden = false;
});
$('btn-inst-ok').addEventListener('click', () => { $('dlg-instalar').hidden = true; });

// ------------------------------------------------------------------ ciclo de vida
window.addEventListener('online', () => { processarFila().catch(() => {}); sincronizarInicio(); if (telaAtual === 'tela-registros') renderRegistros(); if (telaAtual === 'tela-relatorios') renderRelatorios(); });
window.addEventListener('offline', () => { if (telaAtual === 'tela-registros') renderRegistros(); if (telaAtual === 'tela-relatorios') renderRelatorios(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (telaAtual === 'tela-camera') { iniciarVideo(); try { if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then((w) => { estado.wakeLock = w; }); } catch (e) { /* ok */ } }
    processarFila().catch(() => {});
  }
});
setInterval(() => { processarFila().catch(() => {}); }, 60000);

async function iniciar() {
  if ('serviceWorker' in navigator) {
    const tinhaControle = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!tinhaControle) return;
      if (telaAtual === 'tela-inicio' || telaAtual === 'tela-codigo') location.reload();
      else estado.atualizacaoPendente = true;
    });
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn(e));
  }
  pedirPersistencia();
  carregarFonteCarimbo();
  const [ajustes, codigo, nome, servidor] = await Promise.all([db.kvGet('ajustes'), db.kvGet('codigo'), db.kvGet('nome'), db.kvGet('servidor')]);
  if (ajustes) {
    estado.ajustes = { ...structuredClone(AJUSTES_PADRAO), ...ajustes, opc: { ...AJUSTES_PADRAO.opc, ...(ajustes.opc || {}) } };
    if ((ajustes.v || 1) < 2) {
      // versão 1.1: cópia na galeria com legenda passa a ser o padrão
      estado.ajustes.galeria = true;
      estado.ajustes.galCom = true;
      estado.ajustes.v = 2;
      await db.kvSet('ajustes', estado.ajustes);
    }
  }
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
  marcarModoCam();
  try {
    const n = await recuperarInterrompidos();
    if (n) toast(`${n} vídeo(s) interrompido(s) foram recuperados. Veja em Relatórios e envios.`, 5000);
  } catch (e) { console.warn(e); }
  await garantirBase();
  await verificarRelatorioAberto();
  sincronizarInicio();
  processarFila().catch(() => {});
}

iniciar();
