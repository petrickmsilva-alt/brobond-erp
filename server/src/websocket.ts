// ============================================================
// WebSocket — tempo real para chat, dashboard e notificações.
//
// Integra com Express via http.Server. Canais:
//   • chat:<userId>       — mensagens em tempo real
//   • dashboard:update    — KPIs atualizados (a cada 30s)
//   • notificacoes        — alertas de estoque, OP, vendas
//   • aprovacoes          — novos pedidos pendentes
//
// Autenticação: o client envia o JWT no handshake.
// ============================================================
import { Server as SocketServer, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'brobond-dev-secret';

type AuthPayload = { id: number; name: string; email: string; perfil: string };

let io: SocketServer | null = null;

/** Inicializa o servidor WebSocket (chamado pelo index.ts). */
export function initWebSocket(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) || true,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Middleware de autenticação
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || String(socket.handshake.query?.token || '');
    if (!token) return next(new Error('Token não informado'));
    try {
      const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
      (socket as any).user = payload;
      next();
    } catch {
      next(new Error('Token inválido'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket as any).user as AuthPayload;
    console.log(`🔌 WebSocket: ${user.name} (${user.email}) conectado`);

    // Entra na sala pessoal (para chat e notificações)
    socket.join(`user:${user.id}`);
    socket.join('dashboard'); // todos recebem updates do dashboard
    socket.join(`perfil:${user.perfil}`); // por perfil

    // ----- Chat -----
    socket.on('chat:enviar', (data: { para_id: number; texto: string }) => {
      const payload = { de_id: user.id, de_nome: user.name, texto: data.texto, data: new Date().toISOString() };
      // Envia para o destinatário
      io?.to(`user:${data.para_id}`).emit('chat:mensagem', payload);
      // Confirma para o remetente
      socket.emit('chat:confirmado', payload);
    });

    socket.on('chat:ler', (data: { de_id: number }) => {
      io?.to(`user:${data.de_id}`).emit('chat:lido', { lido_por: user.id });
    });

    // ----- Dashboard -----
    socket.on('dashboard:refresh', () => {
      socket.emit('dashboard:refreshing');
    });

    // ----- Disconnect -----
    socket.on('disconnect', () => {
      console.log(`🔌 WebSocket: ${user.name} desconectado`);
    });
  });

  return io;
}

/** Emite evento para um usuário específico. */
export function emitToUser(userId: number, event: string, data: unknown): void {
  io?.to(`user:${userId}`).emit(event, data);
}

/** Emite evento para todos conectados no dashboard. */
export function emitDashboard(event: string, data: unknown): void {
  io?.to('dashboard').emit(event, data);
}

/** Emite evento para um perfil específico. */
export function emitToPerfil(perfil: string, event: string, data: unknown): void {
  io?.to(`perfil:${perfil}`).emit(event, data);
}

/** Emite notificação global (estoque mínimo, OP concluída, etc.). */
export function emitNotificacao(titulo: string, mensagem: string, tipo: 'info' | 'alerta' | 'sucesso' = 'info'): void {
  io?.emit('notificacao', { titulo, mensagem, tipo, data: new Date().toISOString() });
}

/** Retorna o status do WebSocket. */
export function wsStatus() {
  if (!io) return { ativo: false, conexoes: 0 };
  return {
    ativo: true,
    conexoes: io.sockets.sockets.size,
    salas: Array.from(io.sockets.adapter.rooms.keys()).length,
  };
}

export function getIO(): SocketServer | null {
  return io;
}
