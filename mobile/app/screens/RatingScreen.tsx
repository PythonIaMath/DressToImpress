import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import type { User } from '@supabase/supabase-js';

import { StarRating } from '../components/StarRating';
import { AvatarStage } from '../components/AvatarStage';
import { AvatarAnimationControls } from '../components/AvatarAnimationControls';
import { computeScores, submitVote } from '../lib/api';
import type { Game, Player } from '../lib/types';
import { supabase } from '../lib/supabaseClient';
import { streamingSocket } from '../lib/streaming/socketClient';

const PRESENTATION_DURATION_SECONDS = 20;

const SUPABASE_PROJECT_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? null;
const SUPABASE_PROJECT_BASE = SUPABASE_PROJECT_URL
  ? SUPABASE_PROJECT_URL.replace(/\/$/, '')
  : null;
const SUPABASE_STORAGE_ROOT = SUPABASE_PROJECT_BASE
  ? `${SUPABASE_PROJECT_BASE}/storage/v1/object`
  : null;
const SUPABASE_PUBLIC_STORAGE_ROOT = SUPABASE_STORAGE_ROOT
  ? `${SUPABASE_STORAGE_ROOT}/public`
  : null;

function deriveSupabaseUrlFromStoragePath(pathValue: string): string | null {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const sanitized = trimmed.replace(/^\/+/, '');
  if (!sanitized) {
    return null;
  }
  const storageMatch = sanitized.match(
    /^(?:storage\/v1\/object\/)?(?:public\/)?(?<bucket>[^/]+)\/(?<rest>.+)$/
  );
  let bucket: string | undefined;
  let objectPath: string | undefined;
  if (storageMatch && storageMatch.groups) {
    bucket = storageMatch.groups.bucket;
    objectPath = storageMatch.groups.rest;
  } else {
    const [first, ...remaining] = sanitized.split('/');
    bucket = first;
    objectPath = remaining.join('/');
  }
  if (!bucket || !objectPath) {
    return null;
  }
  try {
    const { data } = supabase.storage.from(bucket).getPublicUrl(objectPath);
    if (data?.publicUrl) {
      return data.publicUrl;
    }
  } catch {
    // ignore and fall through to manual reconstruction
  }
  if (SUPABASE_PUBLIC_STORAGE_ROOT) {
    return `${SUPABASE_PUBLIC_STORAGE_ROOT}/${bucket}/${objectPath}`;
  }
  if (SUPABASE_STORAGE_ROOT) {
    return `${SUPABASE_STORAGE_ROOT}/${bucket}/${objectPath}`;
  }
  return null;
}

function ensureModelUrl(rawValue: string | null | undefined): string | null {
  if (!rawValue) {
    return null;
  }
  const trimmed = rawValue.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return deriveSupabaseUrlFromStoragePath(trimmed);
}

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
  model_glb_url?: string | null;
};

export function RatingScreen({ user, game, players, onShowScoreboard }: RatingScreenProps) {
  const [currentGame, setCurrentGame] = useState(game);
  const [entriesByPlayer, setEntriesByPlayer] = useState<Record<string, Entry | undefined>>({});
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(game.current_player);
  const [hasVoted, setHasVoted] = useState(false);
  const [selectedStars, setSelectedStars] = useState(0);
  const [voteCountdown, setVoteCountdown] = useState(PRESENTATION_DURATION_SECONDS);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  const [availableAnimations, setAvailableAnimations] = useState<string[]>([]);
  const [localAnimation, setLocalAnimation] = useState<string | null>(null);
  const [remoteAnimation, setRemoteAnimation] = useState<string | null>(null);
  const [currentTargetVoteCount, setCurrentTargetVoteCount] = useState(0);
  const advancingRef = useRef(false);
  const votePollRef = useRef<NodeJS.Timeout | null>(null);
  const finishedRef = useRef(false);
  const isHost = currentGame.host_id === user.id;

  const sortedPlayers = useMemo(() => {
    return [...players].sort((left, right) => {
      const leftCreated = left.created_at ? Date.parse(left.created_at) : 0;
      const rightCreated = right.created_at ? Date.parse(right.created_at) : 0;
      return leftCreated - rightCreated;
    });
  }, [players]);

  const expectedVotes = useMemo(() => Math.max(sortedPlayers.length - 1, 0), [sortedPlayers.length]);

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
        model_glb_url: ensureModelUrl(
          (currentPlayer as any).model_glb_url ??
            (currentPlayer as any).avatar_glb_url ??
            null
        ),
      }
    : undefined;
  const currentModelUrl = ensureModelUrl(
    (currentEntry?.model_glb_url as string | null | undefined) ??
      (currentPlayer as any)?.avatar_glb_url ??
      null
  );
  const isMyTurn =
    Boolean(currentPlayer && myPlayer && currentPlayer.id === myPlayer.id) ||
    (currentPlayer?.user_id ? currentPlayer.user_id === user.id : false);
  const canVote = Boolean(currentPlayer && !isMyTurn && !hasVoted);
  const stageAnimation = isMyTurn ? localAnimation : remoteAnimation;

  // Debug hook to surface why the stage may be blank.
  useEffect(() => {
    console.log('[Rating] stage state', {
      currentPlayerId,
      currentPlayerUser: currentPlayer?.user_id,
      myPlayerId: myPlayer?.id,
      currentEntryModel: currentEntry?.model_glb_url,
      currentPlayerAvatar: (currentPlayer as any)?.avatar_glb_url,
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
            const resolved = ensureModelUrl(
              entry.model_glb_url ??
                (matchingPlayer as any).model_glb_url ??
                (matchingPlayer as any).avatar_glb_url ??
                null
            );
            const normalized: Entry = {
              ...entry,
              model_glb_url: resolved ?? entry.model_glb_url ?? null,
            };
            // If multiple entries, keep the latest
            const existing = acc[matchingPlayer.id];
            const existingCreated = existing ? Date.parse((existing as any).created_at ?? '') : 0;
            const currentCreated = Date.parse((entry as any).created_at ?? '') || Date.now();
            if (!existing || currentCreated >= existingCreated) {
              acc[matchingPlayer.id] = normalized;
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
    if (!currentPlayerId && sortedPlayers.length > 0 && !advancingRef.current) {
      const next = sortedPlayers[0];
      if (next) {
        setCurrentPlayerLocal(next.id);
        const ensure = async () => {
          const { error } = await updateCurrentPlayer(next.id);
          if (error) {
            console.warn('[Rating] failed to init current_player, falling back local', error);
          }
        };
        void ensure();
      }
    }
  }, [currentPlayerId, sortedPlayers]);

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
            finishedRef.current = true;
          }

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
        { event: 'INSERT', schema: 'public', table: 'votes', filter: `game_id=eq.${game.id}` },
        async (payload) => {
          const targetId = (payload.new as { target_id?: string })?.target_id;
          if (!currentPlayerId || !targetId || targetId !== currentPlayerId) {
            return;
          }
          void refreshVoteCountAndMaybeAdvance();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(gameChannel);
      supabase.removeChannel(votesChannel);
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
      }
      if (votePollRef.current) {
        clearInterval(votePollRef.current);
        votePollRef.current = null;
      }
    };
  }, [game.id, currentGame.host_id, currentPlayerId, onShowScoreboard, user.id]);

  useEffect(() => {
    setHasVoted(false);
    setSelectedStars(0);
    setAvailableAnimations([]);
    setLocalAnimation(null);
    setRemoteAnimation(null);
    setCurrentTargetVoteCount(0);
    advancingRef.current = false;
    finishedRef.current = false;
  }, [currentPlayer, isMyTurn]);

  useEffect(() => {
    resetCountdown();
    void refreshVoteCountAndMaybeAdvance();
    if (votePollRef.current) {
      clearInterval(votePollRef.current);
    }
    votePollRef.current = setInterval(() => {
      void refreshVoteCountAndMaybeAdvance();
    }, 1500);
    return () => {
      if (votePollRef.current) {
        clearInterval(votePollRef.current);
        votePollRef.current = null;
      }
    };
  }, [currentPlayerId]);

  // Si aucun vote n'est attendu (joueur solo), avancer immédiatement.
  useEffect(() => {
    if (expectedVotes === 0 && !advancingRef.current) {
      advanceToNextPlayer();
    }
  }, [expectedVotes]);

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

  useEffect(() => {
    const handleScoreboard = (payload: { gameId?: string; round?: number; standings?: Player[] }) => {
      if (!payload?.gameId || payload.gameId !== game.id || finishedRef.current) {
        return;
      }
      stopTimers();
      finishedRef.current = true;
      const standings = payload.standings ?? players;
      onShowScoreboard(currentGame, standings);
    };
    streamingSocket.on('scoreboard', handleScoreboard);
    return () => {
      streamingSocket.off('scoreboard', handleScoreboard);
    };
  }, [currentGame, game.id, onShowScoreboard, players]);

  const resetCountdown = () => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
    }
    setVoteCountdown(PRESENTATION_DURATION_SECONDS);
    countdownRef.current = setInterval(() => {
      setVoteCountdown((previous) => {
        if (previous <= 1) {
          if (countdownRef.current) {
            clearInterval(countdownRef.current);
          }
          if (currentPlayerId && !advancingRef.current && !finishedRef.current) {
            const currentIndex = sortedPlayers.findIndex((player) => player.id === currentPlayerId);
            const isLastPlayer = currentIndex >= 0 && currentIndex === sortedPlayers.length - 1;
            if (isLastPlayer) {
              void handleFinishRound();
            } else {
              advanceToNextPlayer();
            }
          }
          return 0;
        }
        return previous - 1;
      });
    }, 1_000);
  };

  const stopTimers = () => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    if (votePollRef.current) {
      clearInterval(votePollRef.current);
      votePollRef.current = null;
    }
  };

  const updateCurrentPlayer = async (playerId: string | null) => {
    return supabase.from('games').update({ current_player: playerId }).eq('id', game.id);
  };

  const setCurrentPlayerLocal = (playerId: string | null) => {
    setCurrentPlayerId(playerId);
    setCurrentGame((prev) => ({ ...prev, current_player: playerId }));
  };

  const advanceToNextPlayer = async () => {
    if (advancingRef.current) {
      return;
    }
    advancingRef.current = true;
    const currentIndex = sortedPlayers.findIndex((player) => player.id === currentPlayerId);
    const nextIndex = currentIndex >= 0 ? currentIndex + 1 : 0;

    if (nextIndex >= sortedPlayers.length) {
      await handleFinishRound();
      return;
    }

    const nextPlayer = sortedPlayers[nextIndex];
    try {
      setCurrentPlayerLocal(nextPlayer.id);
      resetCountdown();
      void updateCurrentPlayer(nextPlayer.id).then(({ error }) => {
        if (error) {
          console.warn('[Rating] Failed to update current player on backend', error);
        }
      });
    } finally {
      advancingRef.current = false;
    }
  };

  const refreshVoteCountAndMaybeAdvance = async () => {
    if (!currentPlayerId || finishedRef.current) {
      return;
    }
    const { count, error } = await supabase
      .from('votes')
      .select('*', { count: 'exact', head: true })
      .eq('game_id', game.id)
      .eq('round', game.round)
      .eq('target_id', currentPlayerId);
    if (error) {
      console.warn('[Rating] vote count refresh failed', error);
      return;
    }
    const total = count ?? 0;
    setCurrentTargetVoteCount(total);
    if (total >= expectedVotes && !advancingRef.current && !finishedRef.current) {
      const currentIndex = sortedPlayers.findIndex((player) => player.id === currentPlayerId);
      const isLastPlayer = currentIndex >= 0 && currentIndex === sortedPlayers.length - 1;
      if (isLastPlayer) {
        await handleFinishRound();
      } else {
        advanceToNextPlayer();
      }
    }
  };

  const handleFinishRound = async () => {
    if (finishedRef.current) {
      return;
    }
    finishedRef.current = true;
    stopTimers();
    let standings: Player[] | null = null;
    try {
      await computeScores(game.id, game.round);
    } catch (error) {
      console.warn('[Rating] handleFinishRound computeScores error', error);
    }
    try {
      const { data } = await supabase
        .from('players')
        .select('*')
        .eq('game_id', game.id)
        .order('score', { ascending: false });
      standings = (data ?? null) as Player[] | null;
    } catch (error) {
      console.warn('[Rating] handleFinishRound standings fetch error', error);
    }
    try {
      await supabase
        .from('games')
        .update({ phase: 'scoreboard', current_player: null })
        .eq('id', game.id);
    } catch (error) {
      console.warn('[Rating] handleFinishRound phase update error', error);
    }
    advancingRef.current = false;
    const finalStandings = standings ?? players;
    onShowScoreboard(currentGame, finalStandings);
    // broadcast to other clients
    if (isHost && finalStandings) {
      streamingSocket.sendScoreboard({ gameId: game.id, round: game.round, standings: finalStandings });
    }
  };

  const submitCurrentVote = async () => {
    if (!currentPlayer || selectedStars === 0 || finishedRef.current) {
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
      void refreshVoteCountAndMaybeAdvance();
    } catch (error) {
      setHasVoted(false);
      console.warn('[Rating] submit vote failed', error);
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
      <View style={styles.stageArea}>
        <View style={styles.streamContainer}>
          {currentModelUrl ? (
            <AvatarStage
              modelUrl={currentModelUrl}
              animation={stageAnimation ?? undefined}
              onAnimationsResolved={handleAnimationsResolved}
              style={styles.avatarStage}
            />
          ) : (
            <View style={styles.streamPlaceholder}>
              <Text style={styles.placeholderText}>
                {currentPlayer
                  ? 'Flux en cours de connexion...'
                  : "En attente du prochain présentateur"}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.controlsOverlay}>
          <View style={styles.timerPill}>
            <Text style={styles.timerText}>{voteCountdown}s</Text>
          </View>
          {!isMyTurn ? (
            <View style={styles.voteCard}>
              <StarRating value={selectedStars} onChange={setSelectedStars} disabled={hasVoted} />
              <Button
                title={hasVoted ? 'Vote envoyé' : 'Envoyer'}
                onPress={submitCurrentVote}
                disabled={!canVote || selectedStars === 0 || hasVoted}
              />
            </View>
          ) : (
            availableAnimations.length > 0 && (
              <View style={styles.voteCard}>
                <AvatarAnimationControls
                  options={availableAnimations}
                  value={localAnimation ?? availableAnimations[0]}
                  onChange={handleHostAnimationChange}
                />
              </View>
            )
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b1220',
  },
  streamContainer: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#0b1220',
    justifyContent: 'center',
    alignItems: 'center',
  },
  stageArea: {
    flex: 1,
    backgroundColor: '#0b1220',
  },
  avatarStage: {
    width: '100%',
    height: '100%',
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
  controlsOverlay: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    gap: 10,
  },
  timerPill: {
    alignSelf: 'flex-end',
    backgroundColor: 'rgba(17, 29, 48, 0.9)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 4,
  },
  timerText: {
    color: '#f8fafc',
    fontWeight: '700',
    fontSize: 14,
  },
  voteCard: {
    backgroundColor: '#111d30',
    padding: 16,
    borderRadius: 14,
    gap: 10,
  },
});
