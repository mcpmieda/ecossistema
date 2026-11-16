// Synthetic local test entrypoint only. Never mount this handler in the application.
import wasm from '../../../node_modules/.cache/student-photo-codec-v1/codec.wasm';
import {
  StudentWebpCodecV1,
  WebpCodecErrorV1,
  type WebpPhotoQualityV1,
  type WebpPhotoVariantV1,
} from '../../../server/student-photos/webp-codec-v1';
import { provePhotoEditV1 } from './edit-proof';
const codec = new StudentWebpCodecV1(wasm);
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/edit-proof') return provePhotoEditV1(codec, request);
    try {
      const input = new Uint8Array(await request.arrayBuffer());
      if (url.pathname === '/validate-concurrency') {
        const original = new Uint8Array(input);
        const results = await Promise.all([
          codec.validate(input, 'portrait', request.signal),
          codec.validate(input, 'portrait', request.signal),
          codec.normalize(input, 'portrait', 92, request.signal),
        ]);
        const unchanged = input.every((byte, index) => byte === original[index]);
        results[2].bytes.fill(0);
        input.fill(0);
        original.fill(0);
        return Response.json({
          unchanged,
          dimensions: results.map(({ width, height }) => [width, height]),
        });
      }
      const result = await codec.normalize(
        input,
        url.searchParams.get('variant') as WebpPhotoVariantV1,
        Number(url.searchParams.get('quality')) as WebpPhotoQualityV1,
        request.signal,
      );
      return new Response(new Uint8Array(result.bytes).buffer, {
        headers: {
          'Content-Type': 'image/webp',
          'X-Width': String(result.width),
          'X-Height': String(result.height),
        },
      });
    } catch (error) {
      return new Response(error instanceof WebpCodecErrorV1 ? error.code : 'unavailable', {
        status: 422,
      });
    }
  },
};
