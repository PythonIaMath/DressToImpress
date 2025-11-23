import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Button, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { User } from '@supabase/supabase-js';
import { WebView } from 'react-native-webview';

import { fetchMyAvatar, importAvatarFromUrl } from '../lib/api';

type AvatarSetupScreenProps = {
  user: User;
  onCompleted: () => void;
};

type WebViewEvent =
  | { type: 'READY' }
  | { type: 'ERROR'; message?: string }
  | { type: 'AVATAR_EXPORTED'; payload: { url: string; urlType: 'dataURL' | 'httpURL' } };

async function loadStoredAvatar() {
  try {
    const result = await fetchMyAvatar();
    return result?.signed_url ?? null;
  } catch (error) {
    throw error;
  }
}

export function AvatarSetupScreen({ user, onCompleted }: AvatarSetupScreenProps) {
  const webviewRef = useRef<WebView>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadStoredAvatar()
      .then((stored) => {
        if (!cancelled && stored) {
          setAvatarUrl(stored);
        }
      })
      .catch((error) => {
        console.warn('[AvatarSetup] Failed to load stored avatar', error);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const injectedPayload = useMemo(() => {
    const initial = {
      avatarUrl,
      supabaseUserId: user.id,
    };
    return `
      window.initialPayload = ${JSON.stringify(initial)};
      true;
    `;
  }, [avatarUrl, user.id]);

  const showError = useCallback((input: unknown) => {
    console.warn('[AvatarSetup] error surfaced to UI', input);
    let message: string;
    if (typeof input === 'string') {
      message = input;
    } else if (input instanceof Error) {
      message = input.message;
    } else if (input && typeof input === 'object' && 'message' in (input as Record<string, unknown>)) {
      const extracted = (input as Record<string, unknown>).message;
      message = typeof extracted === 'string' ? extracted : JSON.stringify(extracted, null, 2);
    } else if (input && typeof input === 'object') {
      message = JSON.stringify(input, null, 2);
    } else {
      message = 'Une erreur inattendue est survenue.';
    }
    Alert.alert('Avatar', message);
  }, []);

  const handleAvatarExport = useCallback(
    async (payload: { url: string; urlType: 'dataURL' | 'httpURL' }) => {
      if (!payload?.url) {
        showError("Impossible de récupérer l'avatar exporté.");
        return;
      }
      try {
        setSaving(true);
        const result = await importAvatarFromUrl({
          model_url: payload.dataUrl ?? payload.url,
        });
        const storedValue = result.path || payload.dataUrl || payload.url;
        const accessibleUrl = result.signed_url || payload.dataUrl || payload.url;
        if (!accessibleUrl) {
          throw new Error("Impossible d'obtenir une URL exploitable pour ton avatar.");
        }
        setAvatarUrl(accessibleUrl);
        Alert.alert('Avatar enregistré', 'Tu es prêt à rejoindre les lobbys !', [
          { text: 'Continuer', onPress: onCompleted },
        ]);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Impossible de sauvegarder ton avatar. Réessaie.';
        showError(message);
      } finally {
        setSaving(false);
      }
    },
    [onCompleted, showError, user.id]
  );

  const handleWebViewMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      try {
        const data: WebViewEvent = JSON.parse(event.nativeEvent.data);
        switch (data.type) {
          case 'READY':
            setViewerReady(true);
            break;
          case 'ERROR':
            showError(data.message ?? 'Une erreur est survenue dans Avaturn.');
            break;
          case 'AVATAR_EXPORTED':
            void handleAvatarExport(data.payload);
            break;
          default:
            break;
        }
      } catch (error) {
        console.warn('[AvatarSetup] Failed to parse WebView message', error);
      }
    },
    [handleAvatarExport, showError]
  );

  const triggerExport = useCallback(() => {
    if (!viewerReady) {
      showError("Le configurateur n'est pas encore prêt, patiente quelques secondes.");
      return;
    }
    webviewRef.current?.postMessage(JSON.stringify({ type: 'EXPORT' }));
  }, [showError, viewerReady]);

  if (loading) {
    return (
      <SafeAreaView style={styles.loader}>
        <ActivityIndicator size="large" />
        <Text style={styles.loaderText}>Préparation du configurateur Avaturn…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Crée ton avatar</Text>
        <Text style={styles.subtitle}>
          Utilise Avaturn pour personnaliser ton personnage avant de rejoindre une partie.
        </Text>
      </View>

      <View style={styles.viewerContainer}>
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
      </View>

      <View style={styles.footer}>
        <Button
          title="Enregistrer mon avatar"
          onPress={triggerExport}
          disabled={saving || !viewerReady}
        />
        {!viewerReady && !saving && (
          <Text style={styles.waitingText}>Chargement du configurateur Avaturn…</Text>
        )}
        {saving && (
          <View style={styles.saving}>
            <ActivityIndicator size="small" />
            <Text style={styles.savingText}>Sauvegarde en cours…</Text>
          </View>
        )}
        {avatarUrl ? (
          <Text style={styles.hint}>
            Avatar actuel enregistré. Tu peux le mettre à jour quand tu veux.
          </Text>
        ) : (
          <Text style={styles.hint}>
            Enregistre ton avatar pour accéder aux lobbys et commencer à jouer.
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
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 16,
    gap: 8,
    backgroundColor: '#0f172a',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#f8fafc',
  },
  subtitle: {
    fontSize: 16,
    color: '#cbd5f5',
  },
  viewerContainer: {
    flex: 1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: '#1f2937',
  },
  webview: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  footer: {
    padding: 20,
    gap: 12,
    backgroundColor: '#111827',
  },
  saving: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  savingText: {
    color: '#cbd5f5',
  },
  waitingText: {
    color: '#cbd5f5',
    fontSize: 14,
  },
  hint: {
    color: '#93c5fd',
    fontSize: 14,
  },
  loader: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#0f172a',
  },
  loaderText: {
    color: '#cbd5f5',
    fontSize: 16,
  },
});
