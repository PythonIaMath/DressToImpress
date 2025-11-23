import { NativeModules, Platform } from 'react-native';
import Constants from 'expo-constants';

import { supabase } from './supabaseClient';
import type { Game, Player } from './types';

type HttpMethod = 'GET' | 'POST' | 'PATCH';

class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

const API_BASE_URL = resolveApiBaseUrl();

async function request<TResponse>(
  path: string,
  method: HttpMethod,
  body?: Record<string, unknown>
): Promise<TResponse> {
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let errorMessage: string | undefined;
    let parsedPayload: unknown;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        parsedPayload = await response.json();
        if (parsedPayload && typeof parsedPayload === 'object') {
          errorMessage =
            (parsedPayload as Record<string, unknown>).detail ??
            (parsedPayload as Record<string, unknown>).message ??
            (parsedPayload as Record<string, unknown>).error ??
            JSON.stringify(parsedPayload);
        }
      } catch {
        // ignore parse errors, fallback to text below
      }
    }
    if (!errorMessage) {
      errorMessage = await response.text();
    }
    throw new ApiError(errorMessage || response.statusText, response.status, parsedPayload);
  }

  if (response.status === 204) {
    return {} as TResponse;
  }

  return response.json() as Promise<TResponse>;
}

export type EntryPayload = {
  game_id: string;
  round: number;
  model_glb_url: string;
  screenshot_dataUrl: string;
};

export type VotePayload = {
  game_id: string;
  round: number;
  target_id: string;
  stars: number;
};

export type ImportAvatarPayload = {
  model_url: string;
};

export type AvatarImportResponse = {
  path: string;
  signed_url: string;
};

export async function importAvatarFromUrl(payload: ImportAvatarPayload) {
  return request<AvatarImportResponse>('/avatars/import-from-url', 'POST', payload);
}

export async function fetchMyAvatar(): Promise<AvatarImportResponse | null> {
  try {
    return await request<AvatarImportResponse>('/avatars/me', 'GET');
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function createEntry(payload: EntryPayload) {
  return request('/entries', 'POST', payload);
}

export async function submitVote(payload: VotePayload) {
  return request('/votes', 'POST', payload);
}

export async function patchGamePhase(
  gameId: string,
  body: { phase: string; round?: number; current_player?: string }
) {
  return request(`/games/${gameId}/phase`, 'PATCH', body);
}

export async function computeScores(gameId: string, round: number) {
  return request<{ scores: Record<string, number> }>('/score/compute', 'POST', {
    game_id: gameId,
    round,
  });
}

export async function createGame(): Promise<Game> {
  const result = await request<GameResponse>('/games', 'POST');
  return result.game;
}

type GameSyncResponse = { game: Game; players: Player[] };

export async function syncGame(gameId: string): Promise<GameSyncResponse> {
  return request<GameSyncResponse>(`/games/${gameId}/sync`, 'GET');
}

export async function ensurePlayer(gameId: string): Promise<Player> {
  const result = await request<PlayerResponse>(`/games/${gameId}/players`, 'POST');
  return result.player;
}

export async function startGame(gameId: string, durationSeconds = 50): Promise<Game> {
  const result = await request<GameResponse>(`/games/${gameId}/start`, 'POST', {
    duration_seconds: durationSeconds,
  });
  return result.game;
}

type GameResponse = { game: Game };
type PlayerResponse = { player: Player };

export { ApiError };

export function resolveApiBaseUrl(): string {
  const explicitUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (explicitUrl) {
    return explicitUrl.replace(/\/$/, '');
  }

  const expoHost = extractExpoHost();
  if (expoHost) {
    return `http://${expoHost}:8000`;
  }

  const packagerHost = extractPackagerHost();
  if (packagerHost) {
    return `http://${packagerHost}:8000`;
  }

  if (Platform.OS === 'android') {
    // Android emulators cannot reach localhost on the host machine.
    return 'http://10.0.2.2:8000';
  }

  return 'http://localhost:8000';
}

function extractExpoHost(): string | null {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    // @ts-expect-error manifest is still exposed in dev clients
    Constants.manifest?.hostUri ??
    // @ts-expect-error manifest2 exists in expo dev client environments
    Constants.manifest2?.extra?.expoGo?.hostUri ??
    null;

  if (!hostUri) {
    return null;
  }

  const sanitized = hostUri.replace(/^https?:\/\//, '');
  const [host] = sanitized.split(':');
  return host ?? null;
}

function extractPackagerHost(): string | null {
  const scriptUrl: string | undefined = NativeModules?.SourceCode?.scriptURL;
  if (!scriptUrl) {
    return null;
  }
  try {
    const { hostname } = new URL(scriptUrl);
    return hostname ?? null;
  } catch (error) {
    console.warn('[api] Failed to infer packager host from script URL', error);
    return null;
  }
}
