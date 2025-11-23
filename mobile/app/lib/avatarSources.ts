const MODEL_SOURCE_KEYS = [
  'glbUrl',
  'glb',
  'blobUrl',
  'modelUrl',
  'model',
  'url',
  'signedUrl',
  'signed_url',
  'href',
  'value',
  'src',
  'source',
  'dataUrl',
  'data_url',
];

const BASE64_MODEL_PATTERN = /^[A-Za-z0-9+/=]+$/;
const MAX_NESTING_DEPTH = 4;

function normalizeModelCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  if (trimmed.startsWith('data:')) {
    if (/^data:image\//i.test(trimmed)) {
      return null;
    }
    return trimmed;
  }
  if (trimmed.length > 100 && BASE64_MODEL_PATTERN.test(trimmed) && !trimmed.includes(' ')) {
    return `data:model/gltf-binary;base64,${trimmed}`;
  }
  return null;
}

export function extractAvatarSource(payload: unknown, depth = 0): string | null {
  if (!payload || depth > MAX_NESTING_DEPTH) {
    return null;
  }
  if (typeof payload === 'string') {
    return normalizeModelCandidate(payload);
  }
  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of MODEL_SOURCE_KEYS) {
      if (!(key in record)) {
        continue;
      }
      const candidate = extractAvatarSource(record[key], depth + 1);
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}
