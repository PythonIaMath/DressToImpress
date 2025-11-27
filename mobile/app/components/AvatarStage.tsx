import { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, StyleProp, ViewStyle, Text } from 'react-native';
import { WebView } from 'react-native-webview';

type AvatarStageProps = {
  modelUrl: string;
  animation?: string | null;
  style?: StyleProp<ViewStyle>;
  onReady?: () => void;
  onAnimationsResolved?: (names: string[]) => void;
};

export function AvatarStage({
  modelUrl,
  animation,
  style,
  onReady,
  onAnimationsResolved,
}: AvatarStageProps) {
  const webViewRef = useRef<WebView>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const scriptSources = useMemo(
    () => ({
      core: [
        'https://cdn.jsdelivr.net/npm/three@0.146.0/build/three.min.js',
        'https://unpkg.com/three@0.146.0/build/three.min.js',
        'http://172.20.10.2:8000/static/threejs/three.min.js',
        'http://10.0.2.2:8000/static/threejs/three.min.js',
        'http://localhost:8000/static/threejs/three.min.js',
      ],
      gltfLoader: [
        'https://cdn.jsdelivr.net/npm/three@0.146.0/examples/js/loaders/GLTFLoader.js',
        'https://unpkg.com/three@0.146.0/examples/js/loaders/GLTFLoader.js',
        'http://172.20.10.2:8000/static/threejs/GLTFLoader.js',
        'http://10.0.2.2:8000/static/threejs/GLTFLoader.js',
        'http://localhost:8000/static/threejs/GLTFLoader.js',
      ],
      orbitControls: [
        'https://cdn.jsdelivr.net/npm/three@0.146.0/examples/js/controls/OrbitControls.js',
        'https://unpkg.com/three@0.146.0/examples/js/controls/OrbitControls.js',
        'http://172.20.10.2:8000/static/threejs/OrbitControls.js',
        'http://10.0.2.2:8000/static/threejs/OrbitControls.js',
        'http://localhost:8000/static/threejs/OrbitControls.js',
      ],
    }),
    []
  );

  const html = useMemo(() => {
    const escaped = JSON.stringify(modelUrl);
    const sourcesJson = JSON.stringify(scriptSources);
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8" />
        <style>
          html, body { margin:0; padding:0; width:100%; height:100%; background:#030712; overflow:hidden; }
          canvas { width:100%; height:100%; display:block; }
        </style>
      </head>
      <body>
        <canvas id="c"></canvas>
        <script>
          const send = (payload) => window.ReactNativeWebView.postMessage(JSON.stringify(payload));
          window.onerror = function(message, source, lineno, colno, error) {
            send({ type: 'error', detail: String(message || error), source, lineno, colno });
          };
          const loadScript = (src) => new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.crossOrigin = 'anonymous';
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('Failed to load ' + src));
            document.head.appendChild(s);
          });
          const loadWithFallback = async (paths) => {
            for (const path of paths) {
              try {
                await loadScript(path);
                return;
              } catch (err) {}
            }
            throw new Error('All script sources failed: ' + paths.join(', '));
          };
          const sources = ${sourcesJson};

          (async () => {
            send({ type: 'boot' });
            try {
              await loadWithFallback(sources.core);
              await loadWithFallback(sources.gltfLoader);
              await loadWithFallback(sources.orbitControls);
              if (!window.THREE) throw new Error('THREE non chargé');
              if (!THREE.GLTFLoader) throw new Error('GLTFLoader non disponible');
              if (!THREE.OrbitControls) throw new Error('OrbitControls non disponible');
            } catch (err) {
              send({ type: 'error', detail: err?.message || String(err) });
              return;
            }

            const canvas = document.getElementById('c');
            // force layout size; avoids zero-sized drawing buffer in some WebView builds
            const setCanvasSize = () => {
              const w = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0, 320);
              const h = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0, 320);
              canvas.style.width = '100%';
              canvas.style.height = '100%';
              canvas.width = w;
              canvas.height = h;
              return { w, h };
            };
            let lastSize = setCanvasSize();
            const gl =
              canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: true, alpha: true }) ||
              canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true, antialias: true, alpha: true });
            if (!gl) {
              send({ type: 'error', detail: 'WebGL non disponible' });
              return;
            }
            send({
              type: 'glInfo',
              drawingBuffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
              canvasSize: { width: canvas.width, height: canvas.height },
              windowSize: { width: window.innerWidth, height: window.innerHeight },
            });
            const renderer = new THREE.WebGLRenderer({ canvas, context: gl, alpha: true, antialias: true });
            renderer.setSize(lastSize.w, lastSize.h, false);
            renderer.setPixelRatio(window.devicePixelRatio || 1);
            renderer.outputEncoding = THREE.sRGBEncoding;
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.toneMappingExposure = 1.05;
            const scene = new THREE.Scene();
            scene.background = new THREE.Color(0x1f2937);
            renderer.setClearColor(0x1f2937, 1);
            const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 1000);
            camera.position.set(0, 1.5, 4);
            const ambient = new THREE.AmbientLight(0xffffff, 0.6);
            scene.add(ambient);
            const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.1);
            hemi.position.set(0, 2, 0);
            scene.add(hemi);
            const dir = new THREE.DirectionalLight(0xffffff, 1.0);
            dir.position.set(2, 4, 2);
            scene.add(dir);
            const controls = new THREE.OrbitControls(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.target.set(0, 1, 0);
            let mixer = null;
            let boxHelper = null;
            let rafId = null;
            let intervalId = null;
            let hasRenderedOnce = false;
            const loader = new THREE.GLTFLoader();
            loader.setCrossOrigin('anonymous');
            const clock = new THREE.Clock();

            send({ type: 'loadStart', url: ${escaped} });
            loader.load(
              ${escaped},
              (gltf) => {
                try {
                  const model = gltf.scene || gltf.scenes?.[0];
                  if (!model) {
                    send({ type: 'modelInfo', hasModel: false, size: null });
                    return;
                  }
                  scene.add(model);
                  const box = new THREE.Box3().setFromObject(model);
                  const size = new THREE.Vector3();
                  box.getSize(size);
                  const center = new THREE.Vector3();
                  box.getCenter(center);
                  model.position.sub(center);
                  const maxDim = Math.max(size.x, size.y, size.z);
                  const fov = camera.fov * (Math.PI / 180);
                  let cameraZ = Math.abs(maxDim / Math.sin(fov / 2));
                  cameraZ = Math.min(Math.max(cameraZ, 2), 50);
                  camera.position.set(0, size.y * 0.6, cameraZ);
                  controls.target.set(0, size.y * 0.5, 0);
                  controls.update();
                  const axes = new THREE.AxesHelper(Math.max(maxDim * 0.6, 0.5));
                  const grid = new THREE.GridHelper(Math.max(maxDim * 4, 4), 10, 0x444444, 0x222222);
                  scene.add(axes);
                  scene.add(grid);
                  boxHelper = new THREE.BoxHelper(model, 0x00ffcc);
                  scene.add(boxHelper);
                  send({ type: 'modelInfo', hasModel: true, hasBox: true, box: { min: box.min, max: box.max }, size: { x: size.x, y: size.y, z: size.z } });
                  send({
                    type: 'camera',
                    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
                    target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
                    maxDim,
                  });
                  const renderFrame = () => {
                    const delta = clock.getDelta();
                    if (mixer) mixer.update(delta);
                    // keep helpers in sync with skinned meshes
                    scene.traverse((child) => {
                      if (child instanceof THREE.SkinnedMesh && child.skeleton) {
                        child.skeleton.calculateInverses();
                      }
                    });
                    if (boxHelper) {
                      boxHelper.update();
                    }
                    controls.update();
                    renderer.render(scene, camera);
                    if (!hasRenderedOnce) {
                      hasRenderedOnce = true;
                      let preview = null;
                      try {
                        preview = renderer.domElement.toDataURL('image/png');
                      } catch (err) {
                        preview = null;
                        send({ type: 'error', detail: 'toDataURL failed: ' + (err?.message || err) });
                      }
                      send({
                        type: 'firstFrame',
                        previewLength: preview?.length ?? 0,
                        previewHead: preview ? preview.slice(0, 80) : null,
                      });
                    }
                  };
                  renderFrame(); // draw at least once even if rAF is throttled
                  const animate = () => {
                    rafId = requestAnimationFrame(animate);
                    renderFrame();
                  };
                  if (typeof requestAnimationFrame === 'function') {
                    animate();
                  } else {
                    intervalId = setInterval(renderFrame, 33);
                  }
                  if (gltf.animations && gltf.animations.length > 0) {
                    mixer = new THREE.AnimationMixer(model);
                    const action = mixer.clipAction(gltf.animations[0]);
                    action.play();
                    send({ type: 'animations', list: gltf.animations.map((a) => a.name || 'anim') });
                  } else {
                    send({ type: 'animations', list: [] });
                  }
                  send({ type: 'modelLoaded' });
                  send({ type: 'ready' });
                } catch (err) {
                  send({ type: 'error', detail: err?.message || String(err) });
                }
              },
              (prog) => {
                const ratio = prog && prog.total ? prog.loaded / prog.total : null;
                send({ type: 'progress', loaded: prog?.loaded ?? null, total: prog?.total ?? null, ratio });
              },
              (error) => {
                send({ type: 'error', detail: error?.message || String(error) });
              }
            );

            window.addEventListener('resize', () => {
              lastSize = setCanvasSize();
              camera.aspect = lastSize.w / lastSize.h;
              camera.updateProjectionMatrix();
              renderer.setSize(lastSize.w, lastSize.h, false);
              send({
                type: 'glInfo',
                drawingBuffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
                canvasSize: { width: canvas.width, height: canvas.height },
                windowSize: { width: window.innerWidth, height: window.innerHeight },
              });
            });
          })();

          window.addEventListener('message', (event) => {
            // placeholder for animation switching
          });
        </script>
      </body>
      </html>
    `;
  }, [animation, modelUrl, scriptSources]);

  useEffect(() => {
    if (animation && webViewRef.current) {
      webViewRef.current.postMessage(JSON.stringify({ type: 'setAnimation', name: animation }));
    }
  }, [animation]);

  useEffect(() => {
    setViewerReady(false);
    setViewerError(null);
  }, [modelUrl]);

  return (
    <View style={[styles.container, style]}>
      <WebView
        ref={webViewRef}
        key={modelUrl}
        testID="avatar-stage-webview"
        style={styles.glView}
        originWhitelist={['*']}
        mixedContentMode="always"
        javaScriptEnabled
        allowsInlineMediaPlayback
        allowFileAccess
        allowUniversalAccessFromFileURLs
        androidHardwareAccelerationDisabled={false}
        setSupportMultipleWindows={false}
        onMessage={(event) => {
            try {
              const payload = JSON.parse(event.nativeEvent.data);
              console.log('[AvatarStage] payload', payload);
              if (payload.type === 'ready') {
                setViewerError(null);
                setViewerReady(true);
                onReady?.();
              } else if (payload.type === 'animations') {
                const list = payload.list ?? [];
                onAnimationsResolved?.(list);
              } else if (payload.type === 'modelInfo') {
                // noop: debug signal that model bounding box was read
              } else if (payload.type === 'error') {
                setViewerError(String(payload.detail ?? 'Erreur de rendu'));
                setViewerReady(false);
              }
            } catch (_) {
            // ignore
          }
        }}
        source={{ html }}
      />
      {viewerError && (
        <View style={styles.overlay}>
          <Text style={styles.overlayText}>Erreur: {viewerError}</Text>
        </View>
      )}
      {!viewerReady && !viewerError && (
        <View style={styles.overlay}>
          <Text style={styles.overlayText}>Chargement du modèle...</Text>
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
    width: '100%',
    height: '100%',
    minHeight: 320,
    minWidth: 320,
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
