// Componente de Leitura de Código de Barras via câmera do dispositivo.
// Usa a API BarcodeDetector (Chrome/Edge) ou ZXing como fallback.
//
// Uso:
//   <BarcodeScanner
//     onScan={(codigo) => console.log(codigo)}
//     onError={(erro) => console.error(erro)}
//   />
//
// Funciona em:
//   • Chrome/Edge (desktop + Android) — BarcodeDetector nativo
//   • iOS Safari — fallback via biblioteca (sem câmera, input manual)
//   • Todos os navegadores — campo de input manual como fallback

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, X, Loader2, ScanBarcode } from 'lucide-react';

type Props = {
  onScan: (codigo: string) => void;
  onClose?: () => void;
  onError?: (erro: string) => void;
  /** Mostra campo de input manual como fallback (padrão: true) */
  allowManual?: boolean;
  /** Label do campo manual */
  manualLabel?: string;
};

/** Verifica se o navegador suporta BarcodeDetector. */
function hasBarcodeDetector(): boolean {
  return 'BarcodeDetector' in window;
}

export default function BarcodeScanner({ onScan, onClose, onError, allowManual = true, manualLabel = 'Ou digite o código' }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animRef = useRef<number>(0);

  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [cameraReady, setCameraReady] = useState(false);

  // Para a câmera
  const stopCamera = useCallback(() => {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setScanning(false);
    setCameraReady(false);
  }, []);

  // Inicia a câmera e detecção
  const startCamera = useCallback(async () => {
    setError('');
    if (!hasBarcodeDetector()) {
      setError('Seu navegador não suporta leitura por câmera. Use o campo manual abaixo.');
      if (onError) onError('BarcodeDetector não suportado');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setCameraReady(true);
        setScanning(true);
        scanLoop();
      }
    } catch (e: any) {
      const msg = e?.message || 'Não foi possível acessar a câmera';
      setError(msg);
      if (onError) onError(msg);
    }
  }, [onError]);

  // Loop de detecção
  const scanLoop = useCallback(() => {
    if (!videoRef.current || !scanning) return;
    const video = videoRef.current;

    try {
      const detector = new (window as any).BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code', 'upc_a', 'upc_e'] });
      detector.detect(video).then((codes: any[]) => {
        if (codes.length > 0) {
          const codigo = codes[0].rawValue as string;
          onScan(codigo);
          stopCamera();
        } else {
          animRef.current = requestAnimationFrame(scanLoop);
        }
      }).catch(() => {
        animRef.current = requestAnimationFrame(scanLoop);
      });
    } catch {
      animRef.current = requestAnimationFrame(scanLoop);
    }
  }, [scanning, onScan, stopCamera]);

  // Limpa ao desmontar
  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  // Submit manual
  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualCode.trim()) {
      onScan(manualCode.trim());
      setManualCode('');
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-navy-900">
          <ScanBarcode className="h-4 w-4" />
          Leitor de Código de Barras
        </h3>
        {onClose && (
          <button className="btn-icon" onClick={onClose} title="Fechar">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Área da câmera */}
      <div className="relative mb-3 overflow-hidden rounded-lg bg-slate-900" style={{ aspectRatio: '16/9' }}>
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          playsInline
          muted
          style={{ display: cameraReady ? 'block' : 'none' }}
        />
        <canvas ref={canvasRef} className="hidden" />

        {!cameraReady && !error && (
          <div className="flex h-full items-center justify-center">
            <button
              onClick={startCamera}
              className="flex flex-col items-center gap-2 rounded-xl bg-white/10 px-6 py-4 text-white backdrop-blur transition hover:bg-white/20"
            >
              <Camera className="h-8 w-8" />
              <span className="text-sm font-medium">Ativar câmera</span>
            </button>
          </div>
        )}

        {cameraReady && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-32 w-64 rounded-lg border-2 border-white/60 shadow-lg">
              <div className="relative h-full w-full">
                <div className="absolute left-0 right-0 top-1/2 h-0.5 animate-pulse bg-red-500 opacity-80" />
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80 p-4">
            <p className="text-center text-sm text-white">{error}</p>
          </div>
        )}
      </div>

      {/* Status */}
      {scanning && (
        <div className="mb-3 flex items-center gap-2 text-xs text-emerald-600">
          <Loader2 className="h-3 w-3 animate-spin" />
          Aponte a câmera para o código de barras...
        </div>
      )}

      {/* Input manual (fallback) */}
      {allowManual && (
        <form onSubmit={handleManualSubmit} className="flex gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-xs text-slate-500">{manualLabel}</label>
            <input
              type="text"
              className="input"
              placeholder="Ex: 7891234567895"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              autoFocus={!hasBarcodeDetector()}
            />
          </div>
          <button type="submit" className="btn-primary self-end" disabled={!manualCode.trim()}>
            OK
          </button>
        </form>
      )}

      {/* Dica */}
      <p className="mt-3 text-xs text-slate-400">
        {hasBarcodeDetector()
          ? '💡 Suporta EAN-13, EAN-8, Code 128, Code 39, QR Code e UPC.'
          : '💡 Seu navegador não suporta câmera para leitura. Use o campo manual ou um leitor USB.'}
      </p>
    </div>
  );
}
