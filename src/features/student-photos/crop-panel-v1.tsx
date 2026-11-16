import { Card, Label, Slider } from '@heroui/react';
import {
  photoGeometryV1,
  type CropControlsV1,
  type PhotoKindV1,
} from '../../../shared/student-photos/crop-v1';
import type { PhotoSourceV1 } from './browser-v1';

function CropSliderV1({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  onChange,
}: Readonly<{
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled: boolean;
  onChange(value: number): void;
}>) {
  return (
    <Slider
      aria-label={label}
      value={value}
      minValue={min}
      maxValue={max}
      step={step}
      isDisabled={disabled}
      onChange={(next) => {
        if (typeof next === 'number') onChange(next);
      }}
    >
      <Label>{label}</Label>
      <Slider.Output />
      <Slider.Track>
        <Slider.Fill />
        <Slider.Thumb />
      </Slider.Track>
    </Slider>
  );
}
export function PhotoCropPanelV1({
  source,
  kind,
  controls,
  portraitWidth,
  disabled,
  onChange,
}: Readonly<{
  source: PhotoSourceV1;
  kind: PhotoKindV1;
  controls: CropControlsV1;
  portraitWidth: 600 | 900;
  disabled: boolean;
  onChange(controls: CropControlsV1): void;
}>) {
  const title = kind === 'portrait' ? 'Foto 3×4' : 'Avatar';
  const geometry = photoGeometryV1(source, controls, kind, portraitWidth),
    crop = geometry.crop;
  return (
    <Card className="student-photo-crop" aria-label={'Enquadramento: ' + title}>
      <Card.Header>
        <h3>{title}</h3>
      </Card.Header>
      <Card.Content>
        <div className={'student-photo-frame student-photo-frame--' + kind}>
          <img
            src={source.src}
            alt={'Prévia: ' + title}
            draggable={false}
            style={{
              width: `${(source.width / crop.width) * 100}%`,
              height: `${(source.height / crop.height) * 100}%`,
              left: `${(-crop.x / crop.width) * 100}%`,
              top: `${(-crop.y / crop.height) * 100}%`,
            }}
          />
        </div>
        <p className="student-photo-size">
          {geometry.output.width} × {geometry.output.height} px
        </p>
        <CropSliderV1
          label={title + ': zoom'}
          value={controls.zoom}
          min={1}
          max={4}
          step={0.05}
          disabled={disabled}
          onChange={(zoom) => onChange({ ...controls, zoom })}
        />
        <CropSliderV1
          label={title + ': posição horizontal'}
          value={controls.x * 100}
          disabled={disabled}
          onChange={(x) => onChange({ ...controls, x: x / 100 })}
        />
        <CropSliderV1
          label={title + ': posição vertical'}
          value={controls.y * 100}
          disabled={disabled}
          onChange={(y) => onChange({ ...controls, y: y / 100 })}
        />
      </Card.Content>
    </Card>
  );
}
