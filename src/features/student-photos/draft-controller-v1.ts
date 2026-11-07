import { initialPhotoCropV1, PhotoPreparationErrorV1, photoGeometryV1, type CropControlsV1, type PhotoKindV1 } from '../../../shared/student-photos/crop-v1';
import { loadPhotoSourceV1, preparePhotoDraftV1, type PhotoDraftV1, type PhotoExportOptionsV1, type PhotoSourceV1 } from './browser-v1';

interface PhotoEditorStateV1 {
  status: 'empty' | 'loading' | 'editing' | 'preparing';
  source: PhotoSourceV1 | null;
  options: PhotoExportOptionsV1;
  error: PhotoPreparationErrorV1['code'] | null;
}
export interface PhotoEditorMediaV1 { load: typeof loadPhotoSourceV1; prepare: typeof preparePhotoDraftV1 }
const defaults = (): PhotoExportOptionsV1 => ({ portrait: initialPhotoCropV1('portrait'), avatar: initialPhotoCropV1('avatar'), portraitWidth: 900, quality: 0.92 });
const defaultMedia: PhotoEditorMediaV1 = { load: loadPhotoSourceV1, prepare: preparePhotoDraftV1 };
/** Owns decoded pixels for one mounted student editor. Late work can never cross its scope. */
export function createPhotoEditorControllerV1(media: PhotoEditorMediaV1 = defaultMedia) {
  let state: PhotoEditorStateV1 = { status: 'empty', source: null, options: defaults(), error: null };
  let generation = 0, active: AbortController | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: PhotoEditorStateV1) => { state = next; for (const listener of listeners) listener(); };
  const begin = () => { active?.abort(); active = new AbortController(); return { id: ++generation, signal: active.signal }; };
  const current = (id: number) => generation === id;
  const failure = (error: unknown): PhotoPreparationErrorV1['code'] => error instanceof PhotoPreparationErrorV1 ? error.code : 'decode';
  const busy = () => state.status === 'loading' || state.status === 'preparing';
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async select(file: Blob): Promise<void> {
      const operation = begin();
      publish({ ...state, status: 'loading', error: null });
      try {
        const source = await media.load(file, operation.signal);
        if (!current(operation.id)) { source.dispose(); return; }
        try { photoGeometryV1(source, initialPhotoCropV1('portrait'), 'portrait'); }
        catch (error) { source.dispose(); throw error; }
        const previous = state.source;
        publish({ status: 'editing', source, options: defaults(), error: null });
        previous?.dispose();
      } catch (error) {
        if (current(operation.id)) publish({ ...state, status: state.source ? 'editing' : 'empty', error: failure(error) });
      }
    },
    change(kind: PhotoKindV1, controls: CropControlsV1) {
      if (busy() || !state.source) return;
      try { photoGeometryV1(state.source, controls, kind, state.options.portraitWidth); }
      catch (error) { publish({ ...state, error: failure(error) }); return; }
      publish({ ...state, options: { ...state.options, [kind]: { ...controls } }, error: null });
    },
    output(portraitWidth: 600 | 900, quality: number) {
      if (busy() || ![600, 900].includes(portraitWidth) || ![0.92, 0.86, 0.8].includes(quality)) return;
      publish({ ...state, options: { ...state.options, portraitWidth, quality }, error: null });
    },
    async prepare(): Promise<PhotoDraftV1 | undefined> {
      if (busy() || !state.source) return undefined;
      const operation = begin(), source = state.source, options = state.options;
      publish({ ...state, status: 'preparing', error: null });
      try {
        const draft = await media.prepare(source, options, operation.signal);
        if (!current(operation.id)) return undefined;
        publish({ ...state, status: 'editing' });
        return draft;
      } catch (error) {
        if (current(operation.id)) publish({ ...state, status: 'editing', error: failure(error) });
        return undefined;
      }
    },
    reset() {
      generation++; active?.abort(); active = undefined;
      const previous = state.source;
      publish({ status: 'empty', source: null, options: defaults(), error: null });
      previous?.dispose();
    },
  };
}
