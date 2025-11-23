import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';
import type { Game, Player } from '../lib/types';
import { createGame as apiCreateGame, ensurePlayer as apiEnsurePlayer, startGame as apiStartGame } from '../lib/api';
import { streamingSocket, type GameRoomState } from '../lib/streaming/socketClient';

type LobbyScreenProps = {
  user: User;
  onEnterCustomization: (game: Game, players: Player[]) => void;
  onGameUpdated?: (game: Game) => void;
};

export function LobbyScreen({ user, onEnterCustomization, onGameUpdated }: LobbyScreenProps) {
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [joinCode, setJoinCode] = useState('');
  const [game, setGame] = useState<Game | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(false);
  const hasEnteredRef = useRef(false);

  const isHost = useMemo(() => !!game && game.host_id === user.id, [game, user.id]);

  useEffect(() => {
    hasEnteredRef.current = false;
  }, [game?.id]);

  const enterCustomization = useCallback(
    (nextGame: Game, playerList: Player[]) => {
      if (hasEnteredRef.current) {
        return;
      }
      hasEnteredRef.current = true;
      onEnterCustomization(nextGame, playerList);
    },
    [onEnterCustomization]
  );

  const fetchGameDirectly = useCallback(
    async (gameId: string): Promise<GameRoomState | null> => {
      const { data: gameData, error: gameError } = await supabase
        .from('games')
        .select('*')
        .eq('id', gameId)
        .maybeSingle();
      if (gameError || !gameData) {
        console.warn('[Lobby] Supabase fallback failed to fetch game', gameError);
        return null;
      }
      const { data: playersData, error: playersError } = await supabase
        .from('players')
        .select('*')
        .eq('game_id', gameId)
        .order('created_at', { ascending: true });
      if (playersError) {
        console.warn('[Lobby] Supabase fallback failed to fetch players', playersError);
        return { game: gameData as Game, players: [] as Player[] };
      }
      return {
        game: gameData as Game,
        players: (playersData ?? []) as Player[],
      };
    },
    []
  );

  const applyServerState = useCallback(
    (state: GameRoomState | null) => {
      if (!state) {
        return;
      }
      setGame(state.game);
      setPlayers(state.players);
      onGameUpdated?.(state.game);
      if (!hasEnteredRef.current && state.game.started && state.game.phase === 'customize') {
        enterCustomization(state.game, state.players);
      }
    },
    [enterCustomization, onGameUpdated]
  );

  useEffect(() => {
    if (!game?.id) {
      return;
    }
    let cancelled = false;

    const handleGameSync = (payload: GameRoomState) => {
      if (!payload?.game || payload.game.id !== game.id) {
        return;
      }
      applyServerState(payload);
    };

    streamingSocket.on<GameRoomState>('game:sync', handleGameSync);

    streamingSocket
      .joinGame(game.id, user)
      .then(async (state) => {
        if (cancelled) {
          return;
        }
        if (state && state.game.id === game.id) {
          applyServerState(state);
          return;
        }
        const fallback = await fetchGameDirectly(game.id);
        if (!cancelled) {
          applyServerState(fallback);
        }
      })
      .catch((error) => {
        console.warn('[Lobby] failed to join game room', error);
      });

    return () => {
      cancelled = true;
      streamingSocket.off('game:sync', handleGameSync);
    };
  }, [applyServerState, fetchGameDirectly, game?.id, user.email, user.id]);

  const ensurePlayerRecord = async (targetGame: Game) => {
    try {
      await apiEnsurePlayer(targetGame.id);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("Impossible d'ajouter le joueur à la partie.");
    }
  };

  const handleCreate = async () => {
    try {
      setLoading(true);
      const createdGame = await apiCreateGame();
      setGame(createdGame);
      onGameUpdated?.(createdGame);
      await ensurePlayerRecord(createdGame);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Impossible de créer la partie.";
      Alert.alert('Erreur', message);
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = async () => {
    if (!joinCode) {
      Alert.alert('Code requis', 'Merci de saisir un code de partie.');
      return;
    }

    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('games')
        .select('*')
        .eq('code', joinCode.trim().toUpperCase())
        .eq('started', false)
        .maybeSingle();

      if (error || !data) {
        throw error ?? new Error('Partie introuvable.');
      }

      const targetGame = data as Game;
      await ensurePlayerRecord(targetGame);
      setGame(targetGame);
      onGameUpdated?.(targetGame);
    } catch (error) {
      console.warn('[Lobby] join failed', error);
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'object'
            ? JSON.stringify(error)
            : "Impossible de rejoindre la partie.";
      Alert.alert('Erreur', message);
    } finally {
      setLoading(false);
    }
  };

  const handleStart = async () => {
    if (!game) {
      return;
    }
    if (players.length < 2) {
      Alert.alert('Pas assez de joueurs', 'Au moins 2 joueurs sont nécessaires.');
      return;
    }

    try {
      setLoading(true);
      const updatedGame = await apiStartGame(game.id, 50);
      setGame(updatedGame);
      onGameUpdated?.(updatedGame);
      enterCustomization(updatedGame, players);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Une erreur est survenue lors du démarrage.";
      Alert.alert('Erreur', message);
    } finally {
      setLoading(false);
    }
  };

  const renderPlayer = ({ item }: { item: Player }) => (
    <View style={styles.playerRow}>
      <Text style={styles.playerEmail}>{item.user_email}</Text>
      <Text style={styles.playerBadge}>{item.ready ? 'Prêt' : 'En attente'}</Text>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.select({ ios: 'padding', android: undefined })}
    >
      <View style={styles.inner}>
        <View style={styles.modeToggle}>
          <Button
            title="Créer"
            onPress={() => setMode('create')}
            color={mode === 'create' ? '#2563eb' : undefined}
          />
          <Button
            title="Rejoindre"
            onPress={() => setMode('join')}
            color={mode === 'join' ? '#2563eb' : undefined}
          />
        </View>

        {mode === 'create' ? (
          <View style={styles.card}>
            <Text style={styles.title}>Créer une partie</Text>
            <Button title="Créer" onPress={handleCreate} disabled={loading} />
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.title}>Rejoindre une partie</Text>
            <TextInput
              placeholder="Code de partie"
              autoCapitalize="characters"
              value={joinCode}
              onChangeText={setJoinCode}
              style={styles.input}
            />
            <Button title="Rejoindre" onPress={handleJoin} disabled={loading} />
          </View>
        )}

        {game && (
          <View style={styles.gameInfo}>
            <Text style={styles.gameCodeLabel}>Code à partager</Text>
            <Text style={styles.gameCode}>{game.code}</Text>
            <Text style={styles.sectionTitle}>Joueurs</Text>

            <FlatList
              data={players}
              keyExtractor={(item) => item.id}
              renderItem={renderPlayer}
              ItemSeparatorComponent={() => <View style={styles.separator} />}
              ListEmptyComponent={<Text style={styles.emptyText}>En attente de joueurs...</Text>}
              style={styles.playerList}
            />

            {isHost && (
              <Button
                title="Lancer la partie"
                onPress={handleStart}
                disabled={loading || players.length < 2}
              />
            )}
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111827',
    justifyContent: 'center',
    padding: 16,
  },
  inner: {
    backgroundColor: '#ffffff',
    padding: 20,
    borderRadius: 20,
    gap: 20,
  },
  modeToggle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  card: {
    gap: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    color: '#111827',
  },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    letterSpacing: 4,
    textAlign: 'center',
  },
  gameInfo: {
    gap: 12,
  },
  gameCodeLabel: {
    fontSize: 16,
    color: '#64748b',
    textTransform: 'uppercase',
  },
  gameCode: {
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: 6,
    textAlign: 'center',
    color: '#111827',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1e293b',
  },
  playerList: {
    maxHeight: 220,
  },
  playerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  playerEmail: {
    fontSize: 14,
    color: '#1f2937',
  },
  playerBadge: {
    fontSize: 12,
    color: '#10b981',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e2e8f0',
    marginVertical: 8,
  },
  emptyText: {
    textAlign: 'center',
    color: '#94a3b8',
  },
});
