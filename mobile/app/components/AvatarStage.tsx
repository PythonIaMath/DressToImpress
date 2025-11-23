import { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, StyleProp, ViewStyle, Text, Image } from 'react-native';
import { WebView } from 'react-native-webview';

type AvatarStageProps = {
  modelUrl: string;
  animation?: string | null;
  fallbackImageUrl?: string | null;
  style?: StyleProp<ViewStyle>;
  onReady?: () => void;
  onAnimationsResolved?: (names: string[]) => void;
};

export function AvatarStage({
  modelUrl,
  animation,
  fallbackImageUrl,
  style,
  onReady,
  onAnimationsResolved,
}: AvatarStageProps) {
  const webViewRef = useRef<WebView>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [useFallbackImage, setUseFallbackImage] = useState(false);
  const [hasAnimations, setHasAnimations] = useState(false);

  const html = useMemo(() => {
    const escaped = JSON.stringify(modelUrl);
    const initialAnimation = JSON.stringify(animation ?? null);
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8" />
        <style>
          html, body { margin:0; padding:0; width:100%; height:100%; background:#030712; overflow:hidden; }
          model-viewer { width:100%; height:100%; background:#030712; }
        </style>
        <script type="module" src="https://unpkg.com/@google/model-viewer/dist/model-viewer.min.js"></script>
      </head>
      <body>
        <model-viewer id="viewer"
          src=${escaped}
          camera-controls
          autoplay
          auto-rotate
          rotation-per-second="30deg"
          shadow-intensity="1"
          exposure="1.1"
          crossorigin="anonymous"
        ></model-viewer>
        <script>
          const viewer = document.getElementById('viewer');
          const send = (payload) => window.ReactNativeWebView.postMessage(JSON.stringify(payload));
          viewer.addEventListener('load', () => {
            send({ type: 'ready' });
            const list = viewer.availableAnimations ? Array.from(viewer.availableAnimations) : [];
            send({ type: 'animations', list });
            const initial = ${initialAnimation};
            if (list.length > 0) {
              viewer.animationName = initial || list[0];
              viewer.play();
            }
          });
          viewer.addEventListener('error', (event) => {
            send({ type: 'error', detail: event?.message || 'viewer error' });
          });
          window.addEventListener('message', (event) => {
            try {
              const msg = JSON.parse(event.data);
              if (msg.type === 'setAnimation' && msg.name) {
                viewer.animationName = msg.name;
                viewer.play();
              }
            } catch (e) {}
          });
        </script>
      </body>
      </html>
    `;
  }, [animation, modelUrl]);

  useEffect(() => {
    if (animation && webViewRef.current) {
      webViewRef.current.postMessage(JSON.stringify({ type: 'setAnimation', name: animation }));
    }
  }, [animation]);

  return (
    <View style={[styles.container, style]}>
      {useFallbackImage && fallbackImageUrl ? (
        <Image source={{ uri: fallbackImageUrl }} style={styles.glView as any} resizeMode="cover" />
      ) : (
        <WebView
          ref={webViewRef}
          key={modelUrl}
          testID="avatar-stage-webview"
          style={styles.glView}
          originWhitelist={['*']}
          javaScriptEnabled
          allowsInlineMediaPlayback
          onMessage={(event) => {
            try {
              const payload = JSON.parse(event.nativeEvent.data);
              console.log('[AvatarStage] payload', payload);
              if (payload.type === 'ready') {
                setViewerError(null);
                setUseFallbackImage(false);
                setViewerReady(true);
                setHasAnimations(false);
                onReady?.();
              } else if (payload.type === 'animations') {
                const list = payload.list ?? [];
                setHasAnimations(list.length > 0);
                if (list.length === 0 && fallbackImageUrl) {
                  setUseFallbackImage(true);
                }
                onAnimationsResolved?.(list);
              } else if (payload.type === 'error') {
                setViewerError(String(payload.detail ?? 'Erreur de rendu'));
                setViewerReady(false);
                if (fallbackImageUrl) {
                  setUseFallbackImage(true);
                }
              }
            } catch (_) {
              // ignore
            }
          }}
          source={{ html }}
        />
      )}
      {viewerError && !useFallbackImage && (
        <View style={styles.overlay}>
          <Text style={styles.overlayText}>Erreur: {viewerError}</Text>
        </View>
      )}
      {!viewerReady && !viewerError && !useFallbackImage && (
        <View style={styles.overlay}>
          <Text style={styles.overlayText}>Chargement du modèle...</Text>
        </View>
      )}
      {viewerReady && !viewerError && useFallbackImage && (
        <View style={styles.overlay}>
          <Text style={styles.overlayText}>Affichage de la capture (modèle non supporté)</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#030712',
  },
  glView: {
    flex: 1,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(3,7,18,0.7)',
  },
  overlayText: {
    color: '#f8fafc',
  },
});
