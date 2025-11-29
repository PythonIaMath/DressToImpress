import { useEffect, useMemo, useState } from 'react';
import { Button, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';
import type { Game, Player } from '../lib/types';

type ScoreboardScreenProps = {
  user: User;
  game: Game;
  players: Player[];
  onNextRound: (game: Game, players: Player[]) => void;
  onGameEnded: () => void;
};

export function ScoreboardScreen({ user, game, players, onNextRound, onGameEnded }: ScoreboardScreenProps) {
  const [standings, setStandings] = useState<Player[]>(players);
  const [refreshing, setRefreshing] = useState(false);

  const orderedStandings = useMemo(() => {
    return [...standings].sort((left, right) => right.score - left.score);
  }, [standings]);

  const winner = orderedStandings[0];
  const isHost = user.id === game.host_id;

  useEffect(() => {
    const refresh = async () => {
      const { data } = await supabase
        .from('players')
        .select('*')
        .eq('game_id', game.id)
        .order('score', { ascending: false });

      if (data) {
        setStandings(data as Player[]);
      }
    };

    refresh();
  }, [game.id]);

  const handleNextRound = async () => {
    try {
      setRefreshing(true);
      const nextRound = game.round + 1;
      const customizeEndsAt = new Date(Date.now() + 50_000).toISOString();

      await supabase.from('players').update({ ready: false }).eq('game_id', game.id);

      const { data, error } = await supabase
        .from('games')
        .update({
          round: nextRound,
          phase: 'customize',
          customize_ends_at: customizeEndsAt,
          started: true,
          current_player: null,
        })
        .eq('id', game.id)
        .select('*')
        .single();

      if (error || !data) {
        throw error ?? new Error('Impossible de préparer le round suivant.');
      }

      onNextRound(data as Game, standings);
    } catch (error) {
      console.warn('[Scoreboard] handleNextRound failed', error);
    } finally {
      setRefreshing(false);
    }
  };

  const handleEndGame = () => {
    onGameEnded();
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Scoreboard</Text>
        <Text style={styles.subtitle}>Round {game.round} terminé</Text>
      </View>

      <View style={styles.body}>
        {orderedStandings.map((player, index) => (
          <View
            key={player.id}
            style={[styles.row, index === 0 && styles.firstRow]}
          >
            <Text style={styles.position}>{index + 1}</Text>
            <View style={styles.rowContent}>
              <Text style={styles.email}>{player.user_email}</Text>
              <Text style={styles.score}>{player.score} pts</Text>
            </View>
          </View>
        ))}
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          {winner ? `Vainqueur : ${winner.user_email}` : 'Égalité parfaite !'}
        </Text>
        <Button
          title="Retour au lobby"
          onPress={handleEndGame}
          disabled={refreshing}
        />
        {isHost && (
          <Button
            title={refreshing ? 'Préparation...' : 'Relancer une partie'}
            onPress={handleNextRound}
            disabled={refreshing}
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
  header: {
    padding: 16,
    gap: 4,
    backgroundColor: '#111827',
  },
  title: {
    color: '#f8fafc',
    fontSize: 24,
    fontWeight: '700',
  },
  subtitle: {
    color: '#cbd5f5',
  },
  body: {
    flex: 1,
    padding: 16,
    gap: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1f2937',
    padding: 16,
    borderRadius: 16,
    gap: 16,
  },
  firstRow: {
    borderWidth: 2,
    borderColor: '#facc15',
  },
  position: {
    color: '#facc15',
    fontSize: 24,
    fontWeight: '700',
    width: 32,
    textAlign: 'center',
  },
  rowContent: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  email: {
    color: '#f8fafc',
    fontSize: 16,
  },
  score: {
    color: '#cbd5f5',
    fontSize: 16,
  },
  footer: {
    padding: 16,
    backgroundColor: '#111827',
    gap: 12,
  },
  footerText: {
    color: '#f8fafc',
    textAlign: 'center',
    fontSize: 16,
  },
});
