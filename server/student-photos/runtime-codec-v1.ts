// The codec is built from source into this cache by the build; it is not a dependency's API.
import photoModule from '../../node_modules/.cache/student-photo-codec-v1/codec.wasm'; // NOSONAR
import { StudentWebpCodecV1 } from './webp-codec-v1';

/** Static server-only Pages module, restored from the exact validated artifact. */
export const runtimePhotoCodecV1 = new StudentWebpCodecV1(photoModule);
