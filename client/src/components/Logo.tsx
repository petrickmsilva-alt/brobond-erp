import { useState } from 'react';

// Usa /logo.svg (coloque o arquivo em client/public/logo.svg).
// Se o arquivo não existir ainda, cai no "B" estilizado.
export function Logo({ className = '' }: { className?: string }) {
  const [failed, setFailed] = useState(false);

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {failed ? (
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center font-black text-white shadow-sm">
          B
        </div>
      ) : (
        <img
          src="/logo.svg"
          alt="BROBOND"
          className="h-9 w-9 rounded-lg object-contain bg-white shadow-sm"
          onError={() => setFailed(true)}
        />
      )}
      <span className="font-black tracking-widest text-lg text-slate-800">
        BRO<span className="text-brand-600">BOND</span>
      </span>
    </div>
  );
}
