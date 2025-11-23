import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Buffer } from 'buffer';
import type { User } from '@supabase/supabase-js';
import type { WebViewMessageEvent } from 'react-native-webview';
import { WebView } from 'react-native-webview';
import { supabase } from '../lib/supabaseClient';
import { AvatarImportResponse, createEntry, fetchMyAvatar, importAvatarFromUrl, patchGamePhase } from '../lib/api';
import type { ApiError } from '../lib/api';
import type { Game, Player } from '../lib/types';
import { useStreamingSignaling } from '../hooks/useStreamingSignaling';
import { extractAvatarSource } from '../lib/avatarSources';
import { streamingSocket, type GameRoomState } from '../lib/streaming/socketClient';

type CustomizationScreenProps = {
  user: User;
  game: Game;
  players: Player[];
  onReadyForRating: (game: Game, players: Player[]) => void;
};

type WebViewEvent =
  | { type: 'READY' }
  | { type: 'ERROR'; message?: string }
  | { type: 'ROUND_EXPORT'; payload?: RoundExportPayload };

type RoundExportPayload = {
  avatar?: unknown;
  thumbnail?: unknown;
};

type ImageSource =
  | { kind: 'dataUrl'; value: string }
  | { kind: 'http'; value: string };

type ImagePayload = {
  bytes: Uint8Array;
  contentType: string;
};

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
  // Handle strings that already look like /storage/v1/object/public/<bucket>/<path>
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

async function ensureModelUrl(rawValue: string | null | undefined): Promise<string | null> {
  if (!rawValue) {
    return null;
  }
  const trimmed = rawValue.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return deriveSupabaseUrlFromStoragePath(trimmed);
}

function formatErrorMessage(input: unknown): string {
  if (!input) {
    return 'Une erreur inconnue est survenue.';
  }
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof Error) {
    const apiError = input as ApiError;
    if (apiError.details && typeof apiError.details === 'object') {
      const serialized = (() => {
        try {
          return JSON.stringify(apiError.details, null, 2);
        } catch {
          return String(apiError.details);
        }
      })();
      return `${apiError.message}\n${serialized.slice(0, 600)}${
        serialized.length > 600 ? '…' : ''
      }`;
    }
    return apiError.message;
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

async function resolveImagePayload(source: ImageSource): Promise<ImagePayload> {
  if (source.kind === 'dataUrl') {
    const [metadata, base64Payload] = source.value.split(',', 2);
    if (!base64Payload) {
      throw new Error("Impossible d'interpréter la miniature Avaturn.");
    }
    const mimeMatch = metadata?.match(/^data:(.*?);/);
    const mimeType = mimeMatch?.[1] ?? 'application/octet-stream';
    const bytes = Buffer.from(base64Payload, 'base64');
    return { bytes, contentType: mimeType };
  }

  const response = await fetch(source.value);
  if (!response.ok) {
    throw new Error("Impossible de télécharger la miniature Avaturn.");
  }
  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  const contentType = response.headers.get('Content-Type') ?? 'image/png';
  return { bytes, contentType };
}

async function loadUserAvatar(): Promise<AvatarImportResponse | null> {
  try {
    const result = await fetchMyAvatar();
    return result;
  } catch (error) {
    console.warn('[Customization] Failed to fetch stored avatar', error);
    return null;
  }
}

export function CustomizationScreen({
  user,
  game,
  players,
  onReadyForRating,
}: CustomizationScreenProps) {
  useStreamingSignaling(user, game);
  const webviewRef = useRef<WebView>(null);
  const [webViewReady, setWebViewReady] = useState(false);
  const [avatarGlbUrl, setAvatarGlbUrl] = useState<string | null>(null);
  const [avatarPath, setAvatarPath] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number>(() => {
    if (!game.customize_ends_at) {
      return 50;
    }
    const diff = new Date(game.customize_ends_at).getTime() - Date.now();
    return Math.max(Math.ceil(diff / 1000), 0);
  });
  const [localPlayers, setLocalPlayers] = useState<Player[]>(players);
  const [uploading, setUploading] = useState(false);
  const [waitingForOthers, setWaitingForOthers] = useState(false);
  const ratingPhaseTriggeredRef = useRef(false);

  const isHost = useMemo(() => game.host_id === user.id, [game.host_id, user.id]);
  const orderedPlayers = useMemo(() => {
    return [...localPlayers].sort((left, right) => {
      const leftCreated = left.created_at ? Date.parse(left.created_at) : 0;
      const rightCreated = right.created_at ? Date.parse(right.created_at) : 0;
      return leftCreated - rightCreated;
    });
  }, [localPlayers]);
  const readyCount = localPlayers.filter((player) => player.ready).length;
  const totalPlayers = localPlayers.length || players.length;
  const everyoneReady = useMemo(
    () => totalPlayers > 0 && readyCount === totalPlayers,
    [readyCount, totalPlayers]
  );

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    interval = setInterval(() => {
      setCountdown((previous) => {
        if (previous <= 0) {
          if (interval) {
            clearInterval(interval);
          }
          return 0;
        }
        return previous - 1;
      });
    }, 1_000);

    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, []);

  useEffect(() => {
    const loadAvatar = async () => {
      const existing = await loadUserAvatar();
      if (existing?.signed_url) {
        setAvatarGlbUrl(existing.signed_url);
      }
      if (existing?.path) {
        setAvatarPath(existing.path);
      }
    };

    loadAvatar();
  }, []);

  useEffect(() => {
    const playersChannel = supabase
      .channel(`customize-players-${game.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'players', filter: `game_id=eq.${game.id}` },
        async () => {
          const { data } = await supabase
            .from('players')
            .select('*')
            .eq('game_id', game.id)
            .order('created_at', { ascending: true });
          if (data) {
            const nextPlayers = data as Player[];
            setLocalPlayers(nextPlayers);
            if (
              isHost &&
              !ratingPhaseTriggeredRef.current &&
              nextPlayers.length > 0 &&
              nextPlayers.every((player) => player.ready)
            ) {
              void requestRatingPhase();
            }
          }
        }
      )
      .subscribe();

    const gameChannel = supabase
      .channel(`customize-game-${game.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${game.id}` },
        async (payload) => {
          const nextGame = payload.new as Game;
          if (nextGame.phase === 'rating') {
            const { data } = await supabase
              .from('players')
              .select('*')
              .eq('game_id', nextGame.id)
              .order('created_at', { ascending: true });
            onReadyForRating(nextGame, (data ?? []) as Player[]);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(playersChannel);
      supabase.removeChannel(gameChannel);
    };
  }, [game.id, game, isHost, onReadyForRating, requestRatingPhase]);

  // Host-side polling safeguard to avoid being blocked if realtime misses a ready event.
  useEffect(() => {
    if (!isHost || ratingPhaseTriggeredRef.current) {
      return;
    }
    let cancelled = false;
    const checkReadyAndMaybeStart = async () => {
      try {
        const { data } = await supabase
          .from('players')
          .select('*')
          .eq('game_id', game.id)
          .order('created_at', { ascending: true });
        if (!data || cancelled) {
          return;
        }
        setLocalPlayers(data as Player[]);
        const allReady = data.length > 0 && data.every((p) => p.ready);
        if (allReady) {
          await requestRatingPhase();
        }
      } catch (error) {
        console.warn('[Customization] poll ready failed', error);
      }
    };
    void checkReadyAndMaybeStart();
    const interval = setInterval(checkReadyAndMaybeStart, 3_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [game.id, isHost, requestRatingPhase]);

  useEffect(() => {
    if (!isHost || ratingPhaseTriggeredRef.current) {
      return;
    }
    if (waitingForOthers && everyoneReady) {
      void requestRatingPhase();
    }
  }, [everyoneReady, isHost, requestRatingPhase, waitingForOthers]);

  const injectedPayload = useMemo(() => {
    const initialPayload = {
      supabaseUserId: user.id,
      avatarGlbUrl,
      round: game.round,
    };
    return `
      window.initialPayload = ${JSON.stringify(initialPayload)};
      true;
    `;
  }, [avatarGlbUrl, game.round, user.id]);

  const extractImageSource = (payload: unknown): ImageSource | null => {
    if (!payload) {
      return null;
    }
    if (typeof payload === 'string') {
      if (payload.startsWith('data:')) {
        return { kind: 'dataUrl', value: payload };
      }
      if (payload.startsWith('http://') || payload.startsWith('https://')) {
        return { kind: 'http', value: payload };
      }
      return null;
    }
    if (typeof payload === 'object') {
      const candidate =
        (payload as Record<string, unknown>).dataUrl ??
        (payload as Record<string, unknown>).data_url ??
        (payload as Record<string, unknown>).url ??
        (payload as Record<string, unknown>).signedUrl ??
        (payload as Record<string, unknown>).href ??
        (payload as Record<string, unknown>).source;
      if (typeof candidate === 'string' && candidate.length > 0) {
        if (candidate.startsWith('data:')) {
          return { kind: 'dataUrl', value: candidate };
        }
        if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
          return { kind: 'http', value: candidate };
        }
      }
      const nested = (payload as Record<string, unknown>).thumbnail;
      if (nested) {
        return extractImageSource(nested);
      }
    }
    return null;
  };

  const handleRoundExport = async (payload?: RoundExportPayload) => {
    if (!payload) {
      Alert.alert('Erreur', "Aucune donnée n'a été renvoyée par Avaturn.");
      setUploading(false);
      return;
    }
    try {
      const avatarSource = extractAvatarSource(payload.avatar);
      console.log('[Customization] handleRoundExport payload', {
        hasAvatarSource: Boolean(avatarSource),
        hasStoredUrl: Boolean(avatarGlbUrl),
        avatarPath,
      });
      let resolvedModelUrl = await ensureModelUrl(avatarGlbUrl);
      let currentPath = avatarPath;
      let importResult: AvatarImportResponse | null = null;
      if (avatarSource) {
        importResult = await importAvatarFromUrl({
          model_url: avatarSource,
        });
        const storedPath = importResult.path || '';
        const accessible = await ensureModelUrl(importResult.signed_url ?? storedPath);
        if (accessible) {
          resolvedModelUrl = accessible;
          setAvatarGlbUrl(accessible);
        }
        if (importResult.path) {
          currentPath = importResult.path;
          setAvatarPath(importResult.path);
        }
      }

      if (!resolvedModelUrl || !currentPath) {
        const refreshed = await loadUserAvatar();
        if (refreshed?.signed_url) {
          resolvedModelUrl = refreshed.signed_url;
          setAvatarGlbUrl(refreshed.signed_url);
        }
        if (refreshed?.path) {
          currentPath = refreshed.path;
          setAvatarPath(refreshed.path);
        }
      }

      if (
        !resolvedModelUrl &&
        avatarSource &&
        typeof avatarSource === 'string' &&
        (avatarSource.startsWith('http://') || avatarSource.startsWith('https://'))
      ) {
        resolvedModelUrl = avatarSource;
      }

      const screenshotSource =
        extractImageSource(payload.thumbnail) ?? extractImageSource(payload.avatar);
      if (!screenshotSource) {
        throw new Error("Impossible de récupérer l'aperçu de ton avatar.");
      }

      let finalModelUrl = resolvedModelUrl;

      if (!finalModelUrl) {
        console.warn('[Customization] Missing final model URL', {
          avatarPath: currentPath,
          avatarSource,
          resolvedModelUrl,
          importResult,
        });
        throw new Error("Impossible de déterminer l'URL de ton avatar. Réessaie l'export.");
      }

      await submitRoundEntry(screenshotSource, finalModelUrl);
      setWaitingForOthers(true);
      Alert.alert('Screenshot envoyé', 'Ton look est prêt pour la phase de vote !');
    } catch (error) {
      console.error('[Customization] handleRoundExport failed', error);
      const message = formatErrorMessage(error);
      Alert.alert('Erreur', message);
    } finally {
      setUploading(false);
    }
  };

  const handleWebViewMessage = async (event: WebViewMessageEvent) => {
    try {
      const data: WebViewEvent = JSON.parse(event.nativeEvent.data);

      switch (data.type) {
        case 'READY':
          setWebViewReady(true);
          break;
        case 'ROUND_EXPORT':
          await handleRoundExport(data.payload);
          break;
        case 'ERROR':
          if (data.message) {
            Alert.alert('Avaturn', data.message);
          }
          setUploading(false);
          break;
        default:
          break;
      }
    } catch (error) {
      console.error('WebView message parse error', error);
      setUploading(false);
    }
  };

  const submitRoundEntry = async (imageSource: ImageSource, modelUrl: string) => {
    const { bytes, contentType } = await resolveImagePayload(imageSource);
    const base64 = Buffer.from(bytes).toString('base64');
    const dataUrl = `data:${contentType};base64,${base64}`;

    await createEntry({
      game_id: game.id,
      round: game.round,
      model_glb_url: modelUrl,
      screenshot_dataUrl: dataUrl,
    });

    const { data: updatedPlayer, error } = await supabase
      .from('players')
      .update({ ready: true })
      .eq('game_id', game.id)
      .eq('user_id', user.id)
      .select('*')
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (updatedPlayer) {
      setLocalPlayers((previous) =>
        previous.map((player) =>
          player.user_id === user.id && player.game_id === game.id
            ? {
                ...player,
                ready: true,
                screenshot_url: updatedPlayer.screenshot_url ?? player.screenshot_url,
              }
            : player
        )
      );
    }

    const { data: refreshedPlayers } = await supabase
      .from('players')
      .select('*')
      .eq('game_id', game.id)
      .order('created_at', { ascending: true });

    if (refreshedPlayers) {
      setLocalPlayers(refreshedPlayers as Player[]);
    }
  };

  const handleFinish = () => {
    if (!webViewReady) {
      Alert.alert('Avaturn', 'Le configurateur est toujours en cours de chargement.');
      return;
    }
    if (uploading || waitingForOthers) {
      return;
    }
    setUploading(true);
    webviewRef.current?.postMessage(JSON.stringify({ type: 'EXPORT_ROUND' }));
  };

  const requestRatingPhase = useCallback(async () => {
    if (ratingPhaseTriggeredRef.current) {
      return;
    }
    ratingPhaseTriggeredRef.current = true;
    try {
      const firstPlayer = orderedPlayers[0];
      await patchGamePhase(game.id, {
        phase: 'rating',
        round: game.round,
        current_player: firstPlayer?.id,
      });
      onReadyForRating(
        {
          ...game,
          phase: 'rating',
          current_player: firstPlayer?.id ?? null,
        },
        orderedPlayers
      );
    } catch (error) {
      ratingPhaseTriggeredRef.current = false;
      console.warn('[Customization] Failed to start rating phase', error);
    }
  }, [game, game.round, game.id, onReadyForRating, orderedPlayers]);

  useEffect(() => {
    if (!isHost || ratingPhaseTriggeredRef.current) {
      return;
    }
    if (countdown === 0 || everyoneReady) {
      void requestRatingPhase();
    }
  }, [countdown, everyoneReady, isHost, requestRatingPhase]);

  useEffect(() => {
    const handleGameSync = (payload: GameRoomState) => {
      if (!payload?.game || payload.game.id !== game.id) {
        return;
      }
      if (payload.players) {
        setLocalPlayers(payload.players);
      }
      if (payload.game.phase === 'rating' && !ratingPhaseTriggeredRef.current) {
        ratingPhaseTriggeredRef.current = true;
        onReadyForRating(payload.game, payload.players);
      }
    };

    streamingSocket.on<GameRoomState>('game:sync', handleGameSync);
    return () => {
      streamingSocket.off('game:sync', handleGameSync);
    };
  }, [game.id, onReadyForRating]);

  useEffect(() => {
    setWaitingForOthers(false);
    ratingPhaseTriggeredRef.current = false;
  }, [game.id, game.round]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.timerLabel}>Temps restant</Text>
        <Text style={styles.timerValue}>{countdown}s</Text>
        <View style={styles.headerSpacer} />
        <Button
          title={waitingForOthers ? 'En attente...' : 'Terminer'}
          onPress={handleFinish}
          disabled={uploading || waitingForOthers}
        />
      </View>

      {waitingForOthers ? (
        <View style={styles.waitingContainer}>
          <ActivityIndicator size="large" />
          <Text style={styles.waitingTitle}>En attente des autres joueurs...</Text>
          <Text style={styles.waitingSubtitle}>
            {readyCount}/{Math.max(totalPlayers, 1)} tenues prêtes
          </Text>
          {localPlayers.length > 0 && (
            <View style={styles.waitingList}>
              {localPlayers.map((player) => (
                <View key={player.id} style={styles.waitingRow}>
                  <Text style={styles.waitingEmail}>{player.user_email}</Text>
                  <Text style={styles.waitingStatus}>{player.ready ? '✅ prêt' : '…'}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      ) : (
        <WebView
          ref={webviewRef}
          source={require('../assets/avaturn/avatar-creator.html')}
          originWhitelist={['*']}
          onMessage={handleWebViewMessage}
          injectedJavaScriptBeforeContentLoaded={injectedPayload}
          allowFileAccess
          allowUniversalAccessFromFileURLs
          style={styles.webview}
        />
      )}

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          Utilise le configurateur Avaturn pour préparer ton look, puis appuie sur “Terminer”.
        </Text>
        {uploading && (
          <View style={styles.uploading}>
            <ActivityIndicator size="small" />
            <Text style={styles.uploadingText}>Synchronisation...</Text>
          </View>
        )}
        {isHost && (
          <Text style={styles.hostHint}>
            Quand tout le monde est prêt, tu passeras automatiquement au vote.
          </Text>
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
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    backgroundColor: '#111827',
  },
  headerSpacer: {
    flex: 1,
  },
  timerLabel: {
    color: '#93c5fd',
    textTransform: 'uppercase',
    fontSize: 12,
    letterSpacing: 1.2,
  },
  timerValue: {
    color: '#f8fafc',
    fontSize: 20,
    fontWeight: '700',
  },
  webview: {
    flex: 1,
    backgroundColor: '#000000',
  },
  waitingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: '#0f172a',
  },
  waitingTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  waitingSubtitle: {
    color: '#cbd5f5',
  },
  waitingList: {
    width: '100%',
    marginTop: 12,
    gap: 8,
  },
  waitingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2937',
    paddingBottom: 4,
  },
  waitingEmail: {
    color: '#f8fafc',
    fontSize: 14,
  },
  waitingStatus: {
    color: '#38bdf8',
    fontWeight: '600',
  },
  footer: {
    padding: 16,
    gap: 8,
    backgroundColor: '#111827',
  },
  footerText: {
    color: '#f8fafc',
    fontSize: 16,
  },
  uploading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  uploadingText: {
    color: '#cbd5f5',
  },
  hostHint: {
    color: '#93c5fd',
    fontSize: 12,
  },
});
