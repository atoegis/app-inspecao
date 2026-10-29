// Orientação da foto: o app fica na vertical (como a câmera do celular), mas a foto sai na horizontal
// quando o celular está deitado. O sensor de gravidade diz para que lado ele está girado.

let giroDispositivo = 0;   // 0 = em pé · 90 = girado para a esquerda (topo à esquerda) · 270 = para a direita
let temSensor = false;
let ouvindo = false;
let aoMudar = null;
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function aoMovimento(ev) {
  const g = ev.accelerationIncludingGravity;
  if (!g || g.x == null || g.y == null) return;
  temSensor = true;
  // No iOS os eixos vêm com o sinal invertido em relação ao Android.
  const x = IOS ? -g.x : g.x;
  const y = IOS ? -g.y : g.y;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  let novo = giroDispositivo;
  // histerese: só troca com o celular claramente em pé ou deitado (deitado sobre a mesa não muda nada)
  if (ax > 4.5 && ax > ay + 2.5) novo = x > 0 ? 90 : 270;
  else if (ay > 4.5 && ay > ax + 2.5) novo = 0;
  if (novo !== giroDispositivo) {
    giroDispositivo = novo;
    if (aoMudar) aoMudar();
  }
}

/** Liga o sensor. No iPhone a permissão precisa ser pedida num toque do usuário. */
export async function ligarSensor(callback) {
  aoMudar = callback;
  if (ouvindo || typeof window.DeviceMotionEvent === 'undefined') return;
  try {
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') return;
    }
  } catch (e) {
    return; // sem gesto do usuário ainda: tenta de novo no próximo toque
  }
  window.addEventListener('devicemotion', aoMovimento);
  ouvindo = true;
}

export function desligarSensor() {
  if (!ouvindo) return;
  window.removeEventListener('devicemotion', aoMovimento);
  ouvindo = false;
}

function anguloTela() {
  const a = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle
    : (typeof window.orientation === 'number' ? window.orientation : 0);
  return ((a % 360) + 360) % 360;
}

/**
 * Quanto girar a imagem da câmera (0, 90 ou 270) conforme o ajuste ('auto', 'horizontal', 'vertical').
 * 90: o celular está girado para a esquerda; a imagem gira 90° no sentido anti-horário.
 */
export function giroDaFoto(ajuste, larguraQuadro, alturaQuadro) {
  const quadroDeitado = larguraQuadro > alturaQuadro;
  if (ajuste === 'vertical') {
    if (!quadroDeitado) return 0;
    return giroDispositivo === 270 ? 270 : 90;
  }
  let giro = ((giroDispositivo - anguloTela()) % 360 + 360) % 360;
  if (giro === 180) giro = 0;
  if (ajuste === 'horizontal') {
    if (quadroDeitado) return 0;
    return giro === 270 ? 270 : 90;
  }
  return giro; // automático
}

/** Estado para mostrar na tela da câmera. */
export function estadoOrientacao(ajuste) {
  if (ajuste === 'horizontal') return { horizontal: true, giro: giroDispositivo === 270 ? 270 : 90 };
  if (ajuste === 'vertical') return { horizontal: false, giro: 0 };
  return { horizontal: giroDispositivo !== 0, giro: giroDispositivo };
}

export const sensorDisponivel = () => temSensor;

/** Copia o quadro da câmera para um canvas, já girado. */
export function capturarQuadro(video, giro) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  if (giro === 90) {
    c.width = h; c.height = w;
    ctx.translate(0, w);
    ctx.rotate(-Math.PI / 2);
  } else if (giro === 270) {
    c.width = h; c.height = w;
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    c.width = w; c.height = h;
  }
  ctx.drawImage(video, 0, 0, w, h);
  return c;
}
