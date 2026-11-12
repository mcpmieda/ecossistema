/*
 * The HeroUI tooltip, which also opens with a tap (owner report of 12/11/2026: the "i" did not
 * open on a phone). React Aria shows tooltips only on hover and keyboard focus, so a touch screen
 * never saw them. Here a tap on the trigger toggles the text and a tap anywhere else closes it;
 * hover and keyboard keep working as before.
 */
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
} from 'react';
import { Tooltip as BaseTooltip } from '@heroui/react/tooltip';

type TapControl = {
  readonly isOpen: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly tapOpened: { current: boolean };
  readonly trigger: { current: HTMLElement | null };
};
const TapContextV1 = createContext<TapControl | null>(null);

const touchLike = (pointerType: string) => pointerType === 'touch' || pointerType === 'pen';

function TapTooltipRoot({
  isOpen: isOpenProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: ComponentProps<typeof BaseTooltip.Root>) {
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const isOpen = isOpenProp ?? ownOpen;
  const tapOpened = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const setOpen = useCallback(
    (open: boolean) => {
      if (!open) tapOpened.current = false;
      setOwnOpen(open);
      onOpenChange?.(open);
    },
    [onOpenChange],
  );
  const control = useMemo(() => ({ isOpen, setOpen, tapOpened, trigger }), [isOpen, setOpen]);
  useEffect(() => {
    if (!isOpen || !tapOpened.current) return;
    const closeOutside = (event: globalThis.PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && (trigger.current?.contains(target) || target.closest('[role="tooltip"]'))) return;
      tapOpened.current = false;
      setOwnOpen(false);
      onOpenChange?.(false);
    };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => document.removeEventListener('pointerdown', closeOutside, true);
  }, [isOpen, onOpenChange]);
  return (
    <TapContextV1 value={control}>
      <BaseTooltip.Root {...props} isOpen={isOpen} onOpenChange={setOpen} />
    </TapContextV1>
  );
}

function TapTooltipTrigger(props: ComponentProps<typeof BaseTooltip.Trigger>) {
  const control = use(TapContextV1);
  const wasOpen = useRef(false);
  const touch = useRef(false);
  const { onPointerDown, onClick, ...rest } = props as ComponentProps<'div'>;
  return (
    <BaseTooltip.Trigger
      {...rest}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        touch.current = touchLike(event.pointerType);
        if (control) control.trigger.current = event.currentTarget;
        // React Aria closes the tooltip on press; remember what the tap should toggle from.
        wasOpen.current = (control?.isOpen ?? false) && (control?.tapOpened.current ?? false);
        onPointerDown?.(event);
      }}
      onClick={(event: React.MouseEvent<HTMLDivElement>) => {
        onClick?.(event);
        if (!control || !touch.current) return;
        touch.current = false;
        // A tooltip around a button only names it: the tap belongs to the button.
        const inner = event.target instanceof Element
          ? event.target.closest('button, a, input, select, textarea, [role="button"]:not([data-slot="tooltip-trigger"])')
          : null;
        if (inner && inner !== event.currentTarget && event.currentTarget.contains(inner)) return;
        const open = !wasOpen.current;
        control.setOpen(open);
        control.tapOpened.current = open;
      }}
    />
  );
}

export const Tooltip = Object.assign(TapTooltipRoot, {
  Root: TapTooltipRoot,
  Trigger: TapTooltipTrigger,
  Content: BaseTooltip.Content,
  Arrow: BaseTooltip.Arrow,
});
