import { extractAvatarSource } from '../avatarSources';

const SAMPLE_BASE64 =
  "qVGln2xgsznAAGSSewr668EeG18NaFDZyKBdSfvJyMHLntkdQo4/XvX6DxHmawmE5IP3paL9X/XU/j7wY4GlxBn7xGJjejSfPPs3f3Y/N6v+6mU9Q06SS/mmWbbuPTb0/EYNUhpU2Obl/8Avp//AIutO8luf7TnhDgAEkApnjGeu6sIeILbO3zx/wB+j/jXwtD2riuXsun/AAD+rc0/s+FabrK15S3l1vr9o0otMnU4Fy3PqWP82qyukzf8/Un/AH0//wAXWdJr0UEKT+aCHyB+7Pbr396S18VWs7qgmALHA/dHv/wKh0sQ1dL8P+AOljsnjJU5yV+i5u//AG8b8WlzgYF2/PqXP/s9Wl0ibH/H3J/31J/8XXKN41so5WhWUEpwf3TD+tW4/Gtm0bv5wGzGf3Td+neueeExe9vw/wCAetheIcgvyuotP73bf7R0n9lTYx9rf83/APi6b/Y83/P2/wD31J/8XXN/8J1p6kK84BP/AExb/Grj+LLWNYy04/eKGH7luh4/ve1ZPCYtbr8P+Ad0M/yCom4zTtv7y0/8mNn+yZsbftb/APfT/wDxdYuqQG1064iyXKzKMksc5Gf4ie5q5H4gSSD7Qky7CcD90f8A4qlhubHUVeCcmQyuGPBUZAAHc+lFP2sHzVNkXi3gK9P2eFaUpJpNu+jT831P/9kAAAA=";

describe('extractAvatarSource', () => {
  it('returns plain https URLs', () => {
    const source = 'https://cdn.example.com/foo.glb';
    expect(extractAvatarSource(source)).toBe(source);
  });

  it('walks nested keys to find a GLB URL', () => {
    const payload = { source: { glbUrl: 'https://example.com/model.glb' } };
    expect(extractAvatarSource(payload)).toBe('https://example.com/model.glb');
  });

  it('wraps raw base64 blobs into a model data URL', () => {
    const result = extractAvatarSource(SAMPLE_BASE64);
    expect(result?.startsWith('data:model/gltf-binary;base64,')).toBe(true);
    expect(result?.endsWith(SAMPLE_BASE64)).toBe(true);
  });

  it('ignores image thumbnails', () => {
    const imageData = 'data:image/png;base64,abc123';
    expect(extractAvatarSource(imageData)).toBeNull();
  });

  it('stops when nothing usable is found', () => {
    expect(extractAvatarSource({ invalid: 42 })).toBeNull();
  });
});
