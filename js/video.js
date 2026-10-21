// Gravação de vídeo com legenda dinâmica.
// As partes do vídeo vão sendo guardadas no celular (IndexedDB) durante a gravação, para não
// acumular tudo na memória e não perder o vídeo se o app fechar. A legenda vira um arquivo .srt.
import { db, partesDoVideo, apagarPartesDoVideo } from './db.js';
import { desenharLegenda } from './stamp.js';

export const RESOLUCOES = {
  480: { w: 854, h: 480, bps: 1500000, rotulo: '480p', mbMin: 12 },
  720: { w: 1280, h: 720, bps: 3000000, rotulo: '720p', mbMin: 23 },
  1080: { w: 1920, h: 1080, bps: 6000000, rotulo: '1080p', mbMin: 45 },
};

const FORMATOS = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function gravacaoSuportada() {
  return typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function';
}

export function escolherFormato() {
  if (!gravacaoSuportada()) return null;
  return FORMATOS.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

export const extensaoDe = (mime) => (String(mime).includes('mp4') ? 'mp4' : 'webm');
export const tipoBase = (mime) => String(mime || 'video/webm').split(';')[0];

const pad = (n, t = 2) => String(n).padStart(t, '0');

/** 3723.4 s -> "01:02:03,400" (formato SRT) */
export function tempoSRT(seg) {
  const ms = Math.max(0, Math.round(seg * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

export function fmtDuracao(seg) {
  const s = Math.max(0, Math.round(seg || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function fmtTamanho(bytes) {
  const mb = (bytes || 0) / 1048576;
  if (mb >= 1024) return `${(mb / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`;
  return `${mb.toLocaleString('pt-BR', { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB`;
}

/**
 * Monta o texto .srt: um trecho por segundo, com as linhas que `linhasDe(amostra)` devolver.
 * `cabecalho` (inspetor, relatório, descrição) entra nos primeiros segundos.
 */
export function gerarSRT(amostras, linhasDe, cabecalho = [], duracao = null) {
  const blocos = [];
  const lista = amostras.length ? amostras : [];
  lista.forEach((a, i) => {
    const ini = a.t;
    let fim = i + 1 < lista.length ? lista[i + 1].t : (duracao != null ? Math.max(duracao, a.t + 0.5) : a.t + 1);
    if (fim <= ini) fim = ini + 0.5;
    const linhas = linhasDe(a).filter(Boolean);
    if (ini < 4) linhas.push(...cabecalho.filter(Boolean));
    blocos.push(`${blocos.length + 1}\n${tempoSRT(ini)} --> ${tempoSRT(fim)}\n${linhas.join('\n')}`);
  });
  return `${blocos.join('\n\n')}\n`;
}

/**
 * Grava a câmera. Se `queimar` for verdadeiro, desenha a legenda na imagem (via canvas);
 * senão grava o fluxo da câmera direto (mais leve) e a legenda fica só no .srt.
 */
export class Gravador {
  constructor({ stream, video, resolucao, queimar, linhasAgora, opcoesLegenda, amostraAgora, aoProgresso, registro }) {
    this.stream = stream;
    this.video = video;
    this.res = RESOLUCOES[resolucao] || RESOLUCOES[720];
    this.queimar = !!queimar;
    this.linhasAgora = linhasAgora;
    this.opcoesLegenda = opcoesLegenda;
    this.amostraAgora = amostraAgora;
    this.aoProgresso = aoProgresso || (() => {});
    this.reg = registro;
    this.seq = 0;
    this.tamanho = 0;
    this.pendentes = new Set();
    this.amostras = [];
    this.ativo = false;
  }

  async iniciar() {
    const mime = escolherFormato();
    if (mime === null) throw new Error('Este navegador não grava vídeo.');
    let fonte = this.stream;
    const trilhaVideo = this.stream.getVideoTracks()[0];
    const conf = trilhaVideo && trilhaVideo.getSettings ? trilhaVideo.getSettings() : {};
    this.largura = this.video.videoWidth || conf.width || this.res.w;
    this.altura = this.video.videoHeight || conf.height || this.res.h;

    if (this.queimar) {
      const c = document.createElement('canvas');
      c.width = this.largura;
      c.height = this.altura;
      this.canvas = c;
      this.ctx = c.getContext('2d');
      this.linhasCache = this.linhasAgora();
      this.desenhar();
      const sv = c.captureStream(30);
      fonte = new MediaStream([...sv.getVideoTracks(), ...this.stream.getAudioTracks()]);
      this.fonteCanvas = sv;
    }

    const opcoes = { videoBitsPerSecond: this.res.bps, audioBitsPerSecond: 96000 };
    if (mime) opcoes.mimeType = mime;
    this.rec = new MediaRecorder(fonte, opcoes);
    this.mime = this.rec.mimeType || mime || 'video/webm';
    this.rec.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      const seq = this.seq++;
      this.tamanho += ev.data.size;
      const p = db.put('videoPartes', { videoId: this.reg.id, seq, blob: ev.data })
        .catch((e) => { this.erroGravacao = e; })
        .finally(() => this.pendentes.delete(p));
      this.pendentes.add(p);
      this.aoProgresso(this);
    };

    this.reg.mime = this.mime;
    this.reg.ext = extensaoDe(this.mime);
    this.reg.largura = this.largura;
    this.reg.altura = this.altura;
    this.reg.queimada = this.queimar;
    this.reg.status = 'gravando';
    this.reg.thumb = await this.miniatura();
    await db.put('videos', this.reg);

    this.t0 = performance.now();
    this.ativo = true;
    this.rec.start(1000);
    this.coletar();
    this.timerAmostra = setInterval(() => this.coletar(), 1000);
    this.timerSalvar = setInterval(() => this.salvarParcial(), 5000);
  }

  segundos() {
    return this.ativo || this.t1 == null ? (performance.now() - this.t0) / 1000 : (this.t1 - this.t0) / 1000;
  }

  coletar() {
    const a = this.amostraAgora();
    a.t = Math.round(this.segundos() * 1000) / 1000;
    this.amostras.push(a);
    if (this.queimar) this.linhasCache = this.linhasAgora();
    this.aoProgresso(this);
  }

  quadro() {
    const v = this.video;
    if (v.readyState >= 2) {
      this.ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
      desenharLegenda(this.ctx, this.canvas.width, this.canvas.height, this.linhasCache, this.opcoesLegenda());
      this.ultimoQuadro = performance.now();
    }
  }

  // desenha a cada quadro da câmera; um relógio de reserva cobre navegadores que pausam esse aviso
  desenhar() {
    if (!this.canvas) return;
    this.quadro();
    const v = this.video;
    const proximo = () => {
      if (this.parado) return;
      this.quadro();
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(proximo);
      else requestAnimationFrame(proximo);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(proximo);
    else requestAnimationFrame(proximo);
    this.reserva = setInterval(() => {
      if (this.parado) { clearInterval(this.reserva); return; }
      if (!this.ultimoQuadro || performance.now() - this.ultimoQuadro > 120) this.quadro();
    }, 66);
  }

  async miniatura() {
    try {
      const v = this.video;
      const lado = 320;
      const esc = Math.min(1, lado / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * esc);
      c.height = Math.round(v.videoHeight * esc);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.75));
    } catch (e) {
      return null;
    }
  }

  async salvarParcial() {
    if (!this.ativo) return;
    this.reg.amostras = this.amostras;
    this.reg.tamanho = this.tamanho;
    this.reg.nPartes = this.seq;
    this.reg.duracao = this.segundos();
    try { await db.put('videos', this.reg); } catch (e) { /* tenta de novo no próximo ciclo */ }
  }

  parar() {
    return new Promise((resolve, reject) => {
      if (!this.rec || this.rec.state === 'inactive') { resolve(this.reg); return; }
      clearInterval(this.timerAmostra);
      clearInterval(this.timerSalvar);
      this.rec.onstop = async () => {
        this.parado = true;
        this.ativo = false;
        clearInterval(this.reserva);
        this.t1 = performance.now();
        try {
          await Promise.all([...this.pendentes]);
          if (this.fonteCanvas) this.fonteCanvas.getTracks().forEach((t) => t.stop());
          if (this.erroGravacao) throw this.erroGravacao;
          const fim = this.amostraAgora();
          fim.t = Math.round(this.segundos() * 1000) / 1000;
          if (!this.amostras.length || fim.t - this.amostras[this.amostras.length - 1].t > 0.4) this.amostras.push(fim);
          Object.assign(this.reg, {
            amostras: this.amostras,
            tamanho: this.tamanho,
            nPartes: this.seq,
            duracao: this.segundos(),
            fimTs: Date.now(),
            status: 'gravado',
          });
          await db.put('videos', this.reg);
          resolve(this.reg);
        } catch (e) {
          reject(e);
        }
      };
      this.rec.stop();
    });
  }
}

/** Junta as partes guardadas num único arquivo de vídeo. */
export async function arquivoDoVideo(reg) {
  const partes = await partesDoVideo(reg.id);
  return new Blob(partes.map((p) => p.blob), { type: tipoBase(reg.mime) });
}

export async function apagarVideo(id) {
  await apagarPartesDoVideo(id);
  await db.del('videos', id);
}

/** Corrige vídeos que ficaram "gravando" porque o app fechou no meio. */
export async function recuperarInterrompidos() {
  const vids = await db.all('videos');
  let n = 0;
  for (const v of vids) {
    if (v.status !== 'gravando') continue;
    const partes = await partesDoVideo(v.id);
    if (!partes.length) { await apagarVideo(v.id); continue; }
    v.tamanho = partes.reduce((s, p) => s + p.blob.size, 0);
    v.nPartes = partes.length;
    const ult = (v.amostras || [])[(v.amostras || []).length - 1];
    v.duracao = Math.max(v.duracao || 0, ult ? ult.t : 0, partes.length);
    v.fimTs = v.inicioTs + v.duracao * 1000;
    v.status = 'interrompido';
    await db.put('videos', v);
    n++;
  }
  return n;
}
