import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Image, Modal, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import type { User } from '@supabase/supabase-js';

import { StarRating } from '../components/StarRating';
import { AvatarStage } from '../components/AvatarStage';
import { AvatarAnimationControls } from '../components/AvatarAnimationControls';
import { computeScores, submitVote } from '../lib/api';
import type { Game, Player } from '../lib/types';
import { supabase } from '../lib/supabaseClient';
import { streamingSocket } from '../lib/streaming/socketClient';

type RatingScreenProps = {
  user: User;
  game: Game;
  players: Player[];
  onShowScoreboard: (game: Game, players: Player[]) => void;
};

type Entry = {
  id: string;
  player_id?: string | null;
  user_id?: string | null;
  screenshot_url: string | null;
  model_glb_url?: string | null;
};

export function RatingScreen({ user, game, players, onShowScoreboard }: RatingScreenProps) {
  const [currentGame, setCurrentGame] = useState(game);
  const [entriesByPlayer, setEntriesByPlayer] = useState<Record<string, Entry | undefined>>({});
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(game.current_player);
  const [hasVoted, setHasVoted] = useState(false);
  const [selectedStars, setSelectedStars] = useState(0);
  const [voteCountdown, setVoteCountdown] = useState(30);
  const [voteModalVisible, setVoteModalVisible] = useState(false);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  const [availableAnimations, setAvailableAnimations] = useState<string[]>([]);
  const [localAnimation, setLocalAnimation] = useState<string | null>(null);
  const [remoteAnimation, setRemoteAnimation] = useState<string | null>(null);
  const stageAnimation = isMyTurn ? localAnimation : remoteAnimation;

  const sortedPlayers = useMemo(() => {
    return [...players].sort((left, right) => {
      const leftCreated = left.created_at ? Date.parse(left.created_at) : 0;
      const rightCreated = right.created_at ? Date.parse(right.created_at) : 0;
      return leftCreated - rightCreated;
    });
  }, [players]);

  const expectedVotes = useMemo(() => Math.max(sortedPlayers.length - 1, 1), [sortedPlayers.length]);

  const myPlayer = useMemo(
    () =>
      sortedPlayers.find(
        (player) =>
          player.user_id === user.id || player.user_email?.toLowerCase() === user.email?.toLowerCase()
      ) ?? null,
    [sortedPlayers, user.email, user.id]
  );

  const currentPlayer = currentPlayerId
    ? sortedPlayers.find((player) => player.id === currentPlayerId)
    : null;
  const currentEntry = currentPlayer
    ? entriesByPlayer[currentPlayer.id] ?? {
        id: currentPlayer.id,
        user_id: currentPlayer.user_id,
        player_id: currentPlayer.id,
        screenshot_url: (currentPlayer as any).screenshot_url ?? null,
        model_glb_url: (currentPlayer as any).model_glb_url ?? null,
      }
    : undefined;
  const isMyTurn =
    Boolean(currentPlayer && myPlayer && currentPlayer.id === myPlayer.id) ||
    (currentPlayer?.user_id ? currentPlayer.user_id === user.id : false);
  const canVote = Boolean(currentPlayer && !isMyTurn && !hasVoted);

  // Debug hook to surface why the stage may be blank.
  useEffect(() => {
    console.log('[Rating] stage state', {
      currentPlayerId,
      currentPlayerUser: currentPlayer?.user_id,
      myPlayerId: myPlayer?.id,
      currentEntryModel: currentEntry?.model_glb_url,
      currentEntryScreenshot: currentEntry?.screenshot_url,
      isMyTurn,
      animations: availableAnimations,
      localAnimation,
      remoteAnimation,
    });
  }, [
    availableAnimations,
    currentEntry,
    currentPlayer,
    currentPlayerId,
    isMyTurn,
    myPlayer,
    localAnimation,
    remoteAnimation,
  ]);

  const nextPlayerAfterCurrent = useMemo(() => {
    if (!currentPlayerId) {
      return null;
    }
    const currentIndex = sortedPlayers.findIndex((player) => player.id === currentPlayerId);
    return sortedPlayers[currentIndex + 1] ?? null;
  }, [currentPlayerId, sortedPlayers]);

  useEffect(() => {
    const fetchEntries = async () => {
      const { data } = await supabase.from('entries').select('*').eq('game_id', game.id);
      console.log('[Rating] entries fetched', data);
      if (data) {
        const map = (data as Entry[]).reduce<Record<string, Entry | undefined>>((acc, entry) => {
          const matchingPlayer =
            sortedPlayers.find((player) => player.id === (entry as any).player_id) ??
            sortedPlayers.find((player) => player.user_id === (entry as any).user_id);
          if (matchingPlayer) {
            // If multiple entries, keep the latest
            const existing = acc[matchingPlayer.id];
            if (!existing || Date.parse((entry as any).created_at ?? '') > Date.parse((existing as any).created_at ?? '')) {
              acc[matchingPlayer.id] = entry;
            }
          }
          return acc;
        }, {});
        setEntriesByPlayer(map);
      }
    };

    fetchEntries();
  }, [game.id, game.round, sortedPlayers]);

  useEffect(() => {
    if (!currentPlayerId && sortedPlayers.length > 0 && currentGame.host_id === user.id) {
      const next = sortedPlayers.find((player) => player.user_id !== user.id);
      if (next) {
        updateCurrentPlayer(next.id);
      } else if (sortedPlayers[0]) {
        updateCurrentPlayer(sortedPlayers[0].id);
      }
    }
  }, [currentPlayerId, currentGame.host_id, sortedPlayers, user.id]);

  useEffect(() => {
    const gameChannel = supabase
      .channel(`rating-game-${game.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${game.id}` },
        async (payload) => {
          const nextGame = payload.new as Game;
          setCurrentGame(nextGame);
          setCurrentPlayerId(nextGame.current_player);

          if (nextGame.phase === 'scoreboard') {
            const { data } = await supabase
              .from('players')
              .select('*')
              .eq('game_id', nextGame.id)
              .order('score', { ascending: false });
            onShowScoreboard(nextGame, (data ?? []) as Player[]);
          } else {
            resetCountdown();
          }
        }
      )
      .subscribe();

    const votesChannel = supabase
      .channel(`rating-votes-${game.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'votes', filter: `game_id=eq.${game.id}` },
        async (payload) => {
          if (currentGame.host_id !== user.id || !currentPlayerId) {
            return;
          }
          const targetId = (payload.new as { target_id?: string })?.target_id;
          if (!targetId || targetId !== currentPlayerId) {
            return;
          }
          await checkVotesAndAdvance(currentPlayerId);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(gameChannel);
      supabase.removeChannel(votesChannel);
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
      }
    };
  }, [game.id, currentGame.host_id, currentPlayerId, onShowScoreboard, user.id]);

  useEffect(() => {
    setHasVoted(false);
    setSelectedStars(0);
    setVoteModalVisible(Boolean(currentPlayer && !isMyTurn));
    setAvailableAnimations([]);
    setLocalAnimation(null);
    setRemoteAnimation(null);
  }, [currentPlayer, isMyTurn]);

  useEffect(() => {
    resetCountdown();
  }, [currentPlayerId]);

  useEffect(() => {
    const handleAnimationCommand = (payload: { userId?: string; command?: string }) => {
      if (!payload || payload.userId === user.id) {
        return;
      }
      if (currentPlayer && payload.userId === currentPlayer.user_id) {
        setRemoteAnimation(payload.command ?? null);
      }
    };
    streamingSocket.on('animation:command', handleAnimationCommand);
    return () => {
      streamingSocket.off('animation:command', handleAnimationCommand);
    };
  }, [currentPlayer, user.id]);

  const resetCountdown = () => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
    }
    setVoteCountdown(30);
    countdownRef.current = setInterval(() => {
      setVoteCountdown((previous) => {
        if (previous <= 1) {
          if (countdownRef.current) {
            clearInterval(countdownRef.current);
          }
          if (currentGame.host_id === user.id && currentPlayerId) {
            advanceToNextPlayer();
          }
          return 0;
        }
        return previous - 1;
      });
    }, 1_000);
  };

  const updateCurrentPlayer = async (playerId: string | null) => {
    await supabase.from('games').update({ current_player: playerId }).eq('id', game.id);
  };

  const checkVotesAndAdvance = async (playerId: string) => {
    const { count } = await supabase
      .from('votes')
      .select('*', { count: 'exact', head: true })
      .eq('game_id', game.id)
      .eq('round', game.round)
      .eq('target_id', playerId);

    if ((count ?? 0) >= expectedVotes) {
      await advanceToNextPlayer();
    }
  };

  const advanceToNextPlayer = async () => {
    const currentIndex = sortedPlayers.findIndex((player) => player.id === currentPlayerId);
    const nextIndex = currentIndex + 1;

    if (nextIndex >= sortedPlayers.length) {
      await handleFinishRound();
      return;
    }

    const nextPlayer = sortedPlayers[nextIndex];
    await updateCurrentPlayer(nextPlayer.id);
    resetCountdown();
  };

  const handleFinishRound = async () => {
    try {
      await computeScores(game.id, game.round);
      await supabase
        .from('games')
        .update({ phase: 'scoreboard', current_player: null })
        .eq('id', game.id);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Impossible de calculer les scores. Merci de réessayer.';
      Alert.alert('Erreur', message);
    }
  };

  const submitCurrentVote = async () => {
    if (!currentPlayer || selectedStars === 0) {
      Alert.alert('Note requise', 'Merci de sélectionner une note avant de voter.');
      return;
    }

    try {
      setHasVoted(true);
      await submitVote({
        game_id: game.id,
        round: game.round,
        target_id: currentPlayer.id,
        stars: selectedStars,
      });
      Alert.alert('Vote enregistré', 'Merci pour ta participation !');
      setVoteModalVisible(false);
    } catch (error) {
      setHasVoted(false);
      const message =
        error instanceof Error
          ? error.message
          : "Impossible d'envoyer le vote. Merci de réessayer.";
      Alert.alert('Erreur', message);
    }
  };

  const handleAnimationsResolved = useCallback(
    (names: string[]) => {
      setAvailableAnimations(names);
      if (isMyTurn && names.length > 0) {
        setLocalAnimation((previous) => {
          if (previous) {
            return previous;
          }
          const next = names[0];
          streamingSocket.sendAnimationCommand(next);
          return next;
        });
      } else if (!isMyTurn && names.length > 0) {
        setRemoteAnimation((prev) => prev ?? names[0]);
      }
    },
    [isMyTurn]
  );

  const handleHostAnimationChange = useCallback((next: string) => {
    setLocalAnimation(next);
    streamingSocket.sendAnimationCommand(next);
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.streamContainer}>
        {currentEntry?.model_glb_url ? (
          <AvatarStage
            modelUrl={currentEntry.model_glb_url}
            animation={stageAnimation ?? undefined}
            onAnimationsResolved={handleAnimationsResolved}
            fallbackImageUrl={currentEntry.screenshot_url ?? null}
          />
        ) : currentEntry?.screenshot_url ? (
          <Image source={{ uri: currentEntry.screenshot_url }} style={styles.streamVideo} />
        ) : (
          <View style={styles.streamPlaceholder}>
            <Text style={styles.placeholderText}>
              {currentPlayer
                ? 'Flux en cours de connexion...'
                : "En attente du prochain présentateur"}
            </Text>
          </View>
        )}
        <View style={styles.streamOverlay}>
          <Text style={styles.streamTitle}>
            {currentPlayer
              ? currentPlayer.user_id === user.id
                ? "Ta présentation est en cours"
                : `Présentation de ${currentPlayer.user_email}`
              : "En attente d'une présentation"}
          </Text>
          <Text style={styles.streamSubtitle}>
            Round {game.round} · {voteCountdown}s restants
          </Text>
        </View>
      </View>

      <View style={styles.infoPanel}>
        <Text style={styles.infoLabel}>Prochain·e</Text>
        <Text style={styles.infoValue}>
          {nextPlayerAfterCurrent ? nextPlayerAfterCurrent.user_email : 'Dernier avatar'}
        </Text>

        {!isMyTurn && (
          <View style={styles.voteHint}>
            <Text style={styles.voteHintText}>
              Note ce look pour aider à départager la meilleure tenue.
            </Text>
            <Button
              title={hasVoted ? 'Vote envoyé' : 'Noter ce look'}
              onPress={() => setVoteModalVisible(true)}
              disabled={hasVoted}
            />
          </View>
        )}

        {isMyTurn && (
          <View style={styles.hostStreamActions}>
            <Text style={styles.myTurnText}>
              Ton avatar est diffusé en direct. Laisse les autres joueurs voter !
            </Text>
            {availableAnimations.length > 0 && (
              <AvatarAnimationControls
                options={availableAnimations}
                value={localAnimation ?? availableAnimations[0]}
                onChange={handleHostAnimationChange}
              />
            )}
          </View>
        )}

        {user.id === currentGame.host_id && (
          <View style={styles.hostActions}>
            <Button title="Passer au suivant" onPress={advanceToNextPlayer} />
          </View>
        )}
      </View>

      <Modal animationType="slide" visible={voteModalVisible} transparent>
        <View style={styles.modalBackdrop}>
          <View style={styles.voteModal}>
            <Text style={styles.modalTitle}>Note cette tenue</Text>
            <Text style={styles.modalSubtitle}>
              {currentPlayer?.user_email ?? 'Avatar en cours'}
            </Text>
            <StarRating value={selectedStars} onChange={setSelectedStars} disabled={hasVoted} />
            <View style={styles.modalActions}>
              <Button
                title={hasVoted ? 'Vote envoyé' : 'Envoyer'}
                onPress={submitCurrentVote}
                disabled={!canVote || selectedStars === 0}
              />
              {!hasVoted && (
                <Button title="Plus tard" onPress={() => setVoteModalVisible(false)} />
              )}
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111827',
  },
  streamContainer: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#030712',
    justifyContent: 'center',
    alignItems: 'center',
  },
  streamVideo: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  streamPlaceholder: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  placeholderText: {
    color: '#cbd5f5',
    textAlign: 'center',
  },
  streamOverlay: {
    position: 'absolute',
    bottom: 32,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: 8,
  },
  streamTitle: {
    color: '#f8fafc',
    fontSize: 20,
    fontWeight: '700',
  },
  streamSubtitle: {
    color: '#cbd5f5',
  },
  infoPanel: {
    padding: 20,
    gap: 16,
    backgroundColor: '#0f172a',
  },
  infoLabel: {
    color: '#94a3b8',
    textTransform: 'uppercase',
    fontSize: 12,
    letterSpacing: 1.1,
  },
  infoValue: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '600',
  },
  voteHint: {
    gap: 12,
  },
  voteHintText: {
    color: '#cbd5f5',
  },
  myTurnText: {
    color: '#cbd5f5',
    fontStyle: 'italic',
  },
  hostActions: {
    marginTop: 8,
  },
  hostStreamActions: {
    gap: 12,
  },
  pendingStream: {
    color: '#cbd5f5',
    fontSize: 12,
    fontStyle: 'italic',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
    padding: 16,
  },
  voteModal: {
    width: '100%',
    borderRadius: 16,
    backgroundColor: '#1f2937',
    padding: 20,
    gap: 16,
  },
  modalTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
  },
  modalSubtitle: {
    color: '#cbd5f5',
    fontSize: 14,
  },
  modalActions: {
    gap: 8,
  },
});
