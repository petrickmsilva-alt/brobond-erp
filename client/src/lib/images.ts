// Redimensiona/otimiza imagens no navegador antes do upload.
// Assim uma foto de celular (4–8 MB) vira ~150 KB, poupando banda e banco.

export type PreparedImage = { nome: string; mime: string; dados: string; thumb: string; bytes: number };

const MAX_SIDE = 1600;
const THUMB_SIDE = 240;
const QUALITY = 0.85;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Não foi possível ler a imagem. Use JPG, PNG ou WebP.'));
    };
    img.src = url;
  });
}

function draw(img: HTMLImageElement, maxSide: number, cover = false): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ratio = img.naturalWidth / img.naturalHeight;
  let w: number;
  let h: number;
  if (cover) {
    w = h = maxSide;
  } else {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    w = Math.round(img.naturalWidth * scale);
    h = Math.round(img.naturalHeight * scale);
  }
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  if (cover) {
    // recorte central quadrado (miniatura)
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    ctx.drawImage(img, sx, sy, side, side, 0, 0, w, h);
  } else {
    ctx.drawImage(img, 0, 0, w, h);
  }
  void ratio;
  return canvas;
}

function toDataUrl(canvas: HTMLCanvasElement, mime: string, quality: number): string {
  return canvas.toDataURL(mime, quality);
}

function dataUrlBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
}

/** Prepara um arquivo de imagem: versão otimizada (JPEG, máx. 1600 px) + miniatura quadrada. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) {
    throw new Error('Formato não suportado. Use JPG, PNG ou WebP.');
  }
  if (file.size > 25 * 1024 * 1024) throw new Error('Arquivo muito grande (máx. 25 MB).');
  const img = await loadImage(file);

  // PNG com transparência vira JPEG com fundo branco (mais leve). Mantemos PNG só se for pequeno.
  const keepPng = file.type === 'image/png' && file.size < 400 * 1024 && Math.max(img.naturalWidth, img.naturalHeight) <= MAX_SIDE;
  const mime = keepPng ? 'image/png' : 'image/jpeg';

  let quality = QUALITY;
  let dados = toDataUrl(draw(img, MAX_SIDE), mime, quality);
  // Garante < 1,5 MB reduzindo a qualidade se necessário
  while (dataUrlBytes(dados) > 1_500_000 && quality > 0.5) {
    quality -= 0.1;
    dados = toDataUrl(draw(img, MAX_SIDE), 'image/jpeg', quality);
  }
  const thumb = toDataUrl(draw(img, THUMB_SIDE, true), 'image/jpeg', 0.8);
  const base = file.name.replace(/\.[^.]+$/, '') || 'foto';
  return { nome: `${base}.${mime === 'image/png' ? 'png' : 'jpg'}`, mime, dados, thumb, bytes: dataUrlBytes(dados) };
}
