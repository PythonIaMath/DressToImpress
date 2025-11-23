export type GamePhase = 'lobby' | 'customize' | 'rating' | 'scoreboard';

export type Game = {
  id: string;
  code: string;
  host_id: string;
  started: boolean;
  round: number;
  phase: GamePhase;
  customize_ends_at: string | null;
  current_player: string | null;
};

export type Player = {
  id: string;
  game_id: string;
  user_id: string;
  user_email: string;
  score: number;
  ready: boolean;
  created_at?: string;
  screenshot_url?: string | null;
  avatar_glb_url?: string | null;
};
