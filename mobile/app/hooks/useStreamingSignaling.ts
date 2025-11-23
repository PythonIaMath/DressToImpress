import { useEffect } from 'react';
import type { User } from '@supabase/supabase-js';

import type { Game } from '../lib/types';
import { streamingSocket } from '../lib/streaming/socketClient';

export function useStreamingSignaling(user: User, game: Game | null | undefined) {
  useEffect(() => {
    let mounted = true;
    if (!game) {
      return () => {
        mounted = false;
      };
    }

    streamingSocket.joinGame(game.id, user).catch((error) => {
      console.warn('[StreamingSignaling] failed to join game', error);
    });

    return () => {
      mounted = false;
      streamingSocket.leaveGame();
      if (!mounted) {
        streamingSocket.off('signaling:offer');
        streamingSocket.off('signaling:answer');
        streamingSocket.off('signaling:ice');
      }
    };
  }, [game?.id, user.id]);

  return streamingSocket;
}
