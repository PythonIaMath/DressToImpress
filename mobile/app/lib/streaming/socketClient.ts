import { io, Socket } from 'socket.io-client';
import type { User } from '@supabase/supabase-js';

import { resolveApiBaseUrl } from '../api';
import { supabase } from '../supabaseClient';
import type { Game, Player } from '../types';
import { PeerConnectionManager } from './peerConnection';

type SignalingPayload = {
  targetUserId?: string | null;
  data: unknown;
};

type StreamMetadata = Record<string, unknown>;

export type GameRoomState = {
  game: Game;
  players: Player[];
};

type JoinGameAck =
  | {
      status: 'ok';
      state?: GameRoomState;
    }
  | {
      status: 'error';
      reason?: string;
    };

class StreamingSocketClient {
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private currentGameId: string | null = null;
  private peerManager: PeerConnectionManager | null = null;
  private remoteTrackListener?: (stream: MediaStream) => void;
  private userId: string | null = null;
  private activeStreamTrack: MediaStreamTrack | null = null;

  private async ensureConnected(): Promise<Socket> {
    if (this.socket?.connected) {
      return this.socket;
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.bootstrapConnection();
    try {
      const sock = await this.connecting;
      return sock;
    } finally {
      this.connecting = null;
    }
  }

  private async bootstrapConnection(): Promise<Socket> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const baseUrl = resolveApiBaseUrl();
    const socket = io(baseUrl, {
      transports: ['websocket'],
      reconnection: true,
      auth: token ? { token } : undefined,
      extraHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
    });

    socket.on('connect_error', (error) => {
      console.warn('[StreamingSocket] connect_error', error);
    });

    socket.on('error', (error) => {
      console.warn('[StreamingSocket] error', error);
    });

    this.socket = socket;
    return socket;
  }

  async joinGame(gameId: string, user: Pick<User, 'id' | 'email'>): Promise<GameRoomState | null> {
    const socket = await this.ensureConnected();
    this.userId = user.id;
    this.currentGameId = gameId;
    return new Promise((resolve, reject) => {
      socket.emit(
        'join_game',
        {
          gameId,
          userId: user.id,
          displayName: user.email ?? 'Player',
        },
        (response?: JoinGameAck) => {
          if (!response) {
            resolve(null);
            return;
          }
          if (response.status !== 'ok') {
            reject(new Error(response.reason ?? 'Unable to join game room'));
            return;
          }
          resolve(response.state ?? null);
        }
      );
    });
  }

  leaveGame(): void {
    if (!this.socket) {
      return;
    }
    this.socket.emit('leave_game');
    this.currentGameId = null;
    this.userId = null;
  }

  async startStream(streamId?: string, metadata?: StreamMetadata): Promise<void> {
    const socket = await this.ensureConnected();
    socket.emit('stream:start', { streamId, metadata });
  }

  async stopStream(streamId?: string): Promise<void> {
    const socket = await this.ensureConnected();
    socket.emit('stream:stop', { streamId });
  }

  async sendOffer(payload: SignalingPayload): Promise<void> {
    const socket = await this.ensureConnected();
    socket.emit('signaling:offer', payload);
  }

  async sendAnswer(payload: SignalingPayload): Promise<void> {
    const socket = await this.ensureConnected();
    socket.emit('signaling:answer', payload);
  }

  async sendIceCandidate(payload: SignalingPayload): Promise<void> {
    const socket = await this.ensureConnected();
    socket.emit('signaling:ice', payload);
  }

  async sendAnimationCommand(command: string, parameters?: Record<string, unknown>): Promise<void> {
    const socket = await this.ensureConnected();
    socket.emit('animation:command', { command, parameters });
  }

  on<TPayload = unknown>(event: string, handler: (payload: TPayload) => void): void {
    void this.ensureConnected().then(() => {
      this.socket?.on(event, handler as (...args: any[]) => void);
    });
  }

  off(event: string, handler?: (...args: any[]) => void): void {
    this.socket?.off(event, handler);
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.currentGameId = null;
  }
}

export const streamingSocket = new StreamingSocketClient();
