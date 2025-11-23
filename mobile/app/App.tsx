import { useEffect, useState } from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet, View } from 'react-native';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './lib/supabaseClient';
import { streamingSocket } from './lib/streaming/socketClient';
import { AuthScreen } from './screens/AuthScreen';
import { AvatarSetupScreen } from './screens/AvatarSetupScreen';
import { LobbyScreen } from './screens/LobbyScreen';
import { CustomizationScreen } from './screens/CustomizationScreen';
import { RatingScreen } from './screens/RatingScreen';
import { ScoreboardScreen } from './screens/ScoreboardScreen';
import type { Game, Player } from './lib/types';

type ScreenName = 'auth' | 'avatar-setup' | 'lobby' | 'customize' | 'rating' | 'scoreboard';

export default function App() {
  const [initialized, setInitialized] = useState(false);
  const [screen, setScreen] = useState<ScreenName>('auth');
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [needsAvatar, setNeedsAvatar] = useState(false);

  useEffect(() => {
    const bootstrap = async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session && data.session.user) {
        setSession(data.session);
        setUser(data.session.user);
        setScreen('lobby');
      }
      setInitialized(true);
    };

    const listener = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (nextSession?.user) {
        setSession(nextSession);
        setUser(nextSession.user);
        setScreen('lobby');
      } else {
        setSession(null);
        setUser(null);
        setGame(null);
        setPlayers([]);
        setScreen('auth');
      }
    });

    bootstrap();

    return () => {
      listener.data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!user?.id) {
      setNeedsAvatar(false);
      return;
    }

    let cancelled = false;
    const evaluate = async () => {
      try {
        const { data, error } = await supabase
          .from('users_app')
          .select('avatar_glb_url')
          .eq('user_id', user.id)
          .maybeSingle();
        if (!cancelled) {
          if (error) {
            throw error;
          }
          setNeedsAvatar(!data?.avatar_glb_url);
        }
      } catch (error) {
        console.warn('[App] Unable to determine avatar status', error);
        if (!cancelled) {
          setNeedsAvatar(false);
        }
      }
    };

    evaluate();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const handleAuthenticated = (nextSession: Session, nextUser: User) => {
    setSession(nextSession);
    setUser(nextUser);
    setScreen('lobby');
  };

  useEffect(() => {
    if (!initialized) {
      return;
    }
    if (needsAvatar && user && screen !== 'avatar-setup') {
      setScreen('avatar-setup');
      return;
    }
    if (!needsAvatar && screen === 'avatar-setup') {
      setScreen(user ? 'lobby' : 'auth');
    }
  }, [initialized, needsAvatar, screen, user]);

  const handleEnterCustomization = (nextGame: Game, nextPlayers: Player[]) => {
    setGame(nextGame);
    setPlayers(nextPlayers);
    setScreen('customize');
  };

  const handleReadyForRating = (nextGame: Game, nextPlayers: Player[]) => {
    setGame(nextGame);
    setPlayers(nextPlayers);
    setScreen('rating');
  };

  const handleShowScoreboard = (nextGame: Game, nextPlayers: Player[]) => {
    setGame(nextGame);
    setPlayers(nextPlayers);
    setScreen('scoreboard');
  };

  const handleNextRound = (nextGame: Game, nextPlayers: Player[]) => {
    setGame(nextGame);
    setPlayers(nextPlayers);
    setScreen('customize');
  };

  const handleGameEnded = () => {
    setGame(null);
    setPlayers([]);
    setScreen('lobby');
  };

  const handleAvatarCompleted = () => {
    setNeedsAvatar(false);
    setScreen('lobby');
  };

  useEffect(() => {
    if (!game?.id) {
      return;
    }

    const channel = supabase
      .channel(`app-game-${game.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${game.id}` },
        async (payload) => {
          const nextGame = payload.new as Game;
          setGame(nextGame);
          if (screen !== 'lobby') {
            return;
          }
          if (nextGame.started && nextGame.phase === 'customize') {
            try {
              const { data } = await supabase
                .from('players')
                .select('*')
                .eq('game_id', nextGame.id)
                .order('created_at', { ascending: true });
              handleEnterCustomization(nextGame, (data ?? []) as Player[]);
            } catch (error) {
              console.warn('[App] Failed to sync players from realtime update', error);
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [game?.id, screen]);

  useEffect(() => {
    if (screen !== 'lobby' || !game || !game.started || game.phase !== 'customize') {
      return;
    }

    let cancelled = false;

    const syncPlayersAndEnter = async () => {
      try {
        const { data } = await supabase
          .from('players')
          .select('*')
          .eq('game_id', game.id)
          .order('created_at', { ascending: true });
        if (!cancelled) {
          handleEnterCustomization(game, (data ?? players) as Player[]);
        }
      } catch (error) {
        console.warn('[App] Failed to enter customize automatically', error);
      }
    };

    syncPlayersAndEnter();

    return () => {
      cancelled = true;
    };
  }, [game, players, screen]);

  useEffect(() => {
    if (!game?.id) {
      streamingSocket.leaveGame();
    }
  }, [game?.id]);

  if (!initialized) {
    return (
      <SafeAreaView style={styles.loader}>
        <ActivityIndicator size="large" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        {screen === 'auth' && <AuthScreen onAuthenticated={handleAuthenticated} />}
        {screen === 'avatar-setup' && user && (
          <AvatarSetupScreen user={user} onCompleted={handleAvatarCompleted} />
        )}
        {screen === 'lobby' && user && (
          <LobbyScreen
            user={user}
            onEnterCustomization={handleEnterCustomization}
            onGameUpdated={(updatedGame) => setGame(updatedGame)}
          />
        )}
        {screen === 'customize' && session && user && game && (
          <CustomizationScreen
            user={user}
            game={game}
            players={players}
            onReadyForRating={handleReadyForRating}
          />
        )}
        {screen === 'rating' && user && game && (
          <RatingScreen
            user={user}
            game={game}
            players={players}
            onShowScoreboard={handleShowScoreboard}
          />
        )}
        {screen === 'scoreboard' && user && game && (
          <ScoreboardScreen
            user={user}
            game={game}
            players={players}
            onNextRound={handleNextRound}
            onGameEnded={handleGameEnded}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  content: {
    flex: 1,
  },
  loader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
